import os
import uuid
import secrets
import time
from functools import wraps

from flask import Flask, request, jsonify, render_template, session, make_response
from openai import OpenAI
import libreface

import gcs_storage as store
from translations import TRANSLATIONS, SUPPORTED_LANGS, DEFAULT_LANG

app = Flask(__name__)
# Static files (JS/CSS) never get cached by the browser — this is a small,
# actively-developed app where picking up every redeploy immediately matters
# far more than shaving a few ms off repeat static-file requests. Without
# this, a browser can keep serving a stale, previously-broken core.js after
# a fix has already been deployed, looking exactly like the fix didn't work.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.secret_key = os.environ.get("FLASK_SECRET_KEY") or secrets.token_hex(32)
app.config.update(SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_HTTPONLY=True)

ADMIN_PIN = os.environ.get("ADMIN_PIN")
CONSENT_NOTICE_VERSION = "1.0"

# Default (server-proxied) API keys can be set two ways: through the
# PIN-gated admin UI (stored in GCS, supports multiple saved keys with
# switching), or via these env vars as a bootstrap fallback — same pattern
# as ADMIN_PIN. GCS wins if something's been configured there; otherwise
# the app falls back to whatever's set here. Never both required.
DEFAULT_ENV_KEYS = {
    "openai": {
        "key": os.environ.get("DEFAULT_OPENAI_API_KEY"),
        "model": os.environ.get("DEFAULT_OPENAI_MODEL") or store.DEFAULT_OPENAI_MODEL,
        "base_url": os.environ.get("DEFAULT_OPENAI_BASE_URL") or store.DEFAULT_OPENAI_BASE_URL,
    },
    "deepseek": {
        "key": os.environ.get("DEFAULT_DEEPSEEK_API_KEY"),
        "model": os.environ.get("DEFAULT_DEEPSEEK_MODEL") or store.DEFAULT_DEEPSEEK_MODEL,
        "base_url": os.environ.get("DEFAULT_DEEPSEEK_BASE_URL") or store.DEFAULT_DEEPSEEK_BASE_URL,
    },
}

# ── LibreFace ────────────────────────────────────────────────────────────────
LIBREFACE_TMP_DIR = "/tmp/libreface"
os.makedirs(LIBREFACE_TMP_DIR, exist_ok=True)

if os.environ.get("LIBREFACE_DEVICE"):
    LIBREFACE_DEVICE = os.environ["LIBREFACE_DEVICE"]
else:
    try:
        import torch
        LIBREFACE_DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:
        LIBREFACE_DEVICE = "cpu"

LIBREFACE_EXPRESSION_MAP = {
    "Neutral": "neutral", "Happiness": "happy", "Sadness": "sad", "Surprise": "surprise",
    "Fear": "fear", "Disgust": "disgust", "Anger": "angry", "Contempt": "contempt",
}
ALL_EMOTIONS = ["angry", "contempt", "disgust", "fear", "happy", "neutral", "sad", "surprise"]


# ── Admin auth ───────────────────────────────────────────────────────────────
def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("admin"):
            return jsonify({"error": "Not authorized."}), 403
        return fn(*args, **kwargs)
    return wrapper


@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    if not ADMIN_PIN:
        return jsonify({"error": "Admin PIN not configured on the server."}), 503
    data = request.get_json(force=True) or {}
    if secrets.compare_digest(str(data.get("pin", "")), str(ADMIN_PIN)):
        session["admin"] = True
        session.permanent = False
        return jsonify({"ok": True})
    return jsonify({"error": "Incorrect PIN."}), 401


@app.route("/api/admin/logout", methods=["POST"])
def admin_logout():
    session.pop("admin", None)
    return jsonify({"ok": True})


@app.route("/api/admin/status", methods=["GET"])
def admin_status():
    return jsonify({"admin": bool(session.get("admin"))})


# ── Default keys (admin-only writes; status is public, never exposes the key) ──
@app.route("/api/default-keys/status", methods=["GET"])
def default_keys_status():
    out = {}
    for service in ("openai", "deepseek"):
        active = store.get_active_default(service)
        available = active is not None and bool(active.get("key"))
        model = (active or {}).get("model")
        if not available:
            env_creds = DEFAULT_ENV_KEYS.get(service)
            if env_creds and env_creds.get("key"):
                available = True
                model = env_creds.get("model")
        out[service] = {"available": available, "model": model}
    return jsonify(out)


# NOTE: default keys are now configured only via env vars
# (DEFAULT_OPENAI_API_KEY / DEFAULT_DEEPSEEK_API_KEY, see _default_client
# below) — the admin UI/routes for adding or switching default keys through
# the browser were removed entirely, not just hidden, since a reachable
# PIN-gated endpoint is still real attack surface even when no button links
# to it. gcs_storage.py's key-writing functions are now unused but left in
# place; get_active_default() is still checked (and still wins over the env
# vars) purely as a read path, in case a key was configured there previously.


# ── Admin's own persistent filter (tied to PIN session, not a browser) ─────
@app.route("/api/admin/filter", methods=["GET"])
@require_admin
def admin_get_filter():
    return jsonify({"emotions": store.get_admin_filter()})


@app.route("/api/admin/filter", methods=["POST"])
@require_admin
def admin_set_filter():
    data = request.get_json(force=True) or {}
    emotions = [e for e in (data.get("emotions") or []) if e in ALL_EMOTIONS]
    try:
        store.set_admin_filter(emotions)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
    return jsonify({"emotions": emotions})


# ── AI call helper (default-key / server-proxied path only) ────────────────
def _default_client(service: str):
    creds = store.get_active_default(service)
    if not creds or not creds.get("key"):
        env_creds = DEFAULT_ENV_KEYS.get(service)
        if env_creds and env_creds.get("key"):
            creds = env_creds
        else:
            return None, None
    kwargs = {"api_key": creds["key"]}
    if creds.get("base_url"):
        kwargs["base_url"] = creds["base_url"]
    elif service == "deepseek":
        kwargs["base_url"] = store.DEFAULT_DEEPSEEK_BASE_URL
    return OpenAI(**kwargs), (creds.get("model") or (
        store.DEFAULT_OPENAI_MODEL if service == "openai" else store.DEFAULT_DEEPSEEK_MODEL))


def send_default_deepseek(prompt_text: str) -> str:
    client, model = _default_client("deepseek")
    try:
        if client is None:
            raise RuntimeError("No default AI key configured on the server.")
        resp = client.chat.completions.create(model=model, messages=[{"role": "user", "content": prompt_text}])
        return resp.choices[0].message.content.strip()
    except Exception as e:
        return f"[AI error: {e}]"


# ── Pages (real routes, not simulated windows) ──────────────────────────────
def get_locale():
    """Explicit ?lang= wins (and gets remembered via cookie below); else a
    previously-set cookie; else the browser's own language preference;
    else English."""
    lang = request.args.get("lang")
    if lang in SUPPORTED_LANGS:
        return lang
    lang = request.cookies.get("lang")
    if lang in SUPPORTED_LANGS:
        return lang
    return request.accept_languages.best_match(SUPPORTED_LANGS) or DEFAULT_LANG


def render_page(template, active_page, **extra):
    lang = get_locale()
    t = TRANSLATIONS.get(lang, TRANSLATIONS[DEFAULT_LANG])
    resp = make_response(render_template(
        template, t=t, lang=lang, all_emotions=ALL_EMOTIONS,
        consent_version=CONSENT_NOTICE_VERSION, active_page=active_page, **extra
    ))
    if request.args.get("lang") in SUPPORTED_LANGS:
        resp.set_cookie("lang", lang, max_age=60 * 60 * 24 * 365)
    return resp


@app.route("/")
def landing():
    return render_page("landing.html", "landing")


@app.route("/chat")
def chat_page():
    return render_page("chat.html", "chat")


@app.route("/listener")
def listener_page():
    return render_page("listener.html", "listener")


# ── Emotion analysis — LibreFace requires a file path, so a frame briefly
# exists on disk; deleted immediately after each call (primary mechanism),
# with a periodic sweep as a crash-only backstop, not the main cleanup path.
@app.route("/api/analyze-frame", methods=["POST"])
def analyze_frame():
    frame_file = request.files.get("frame")
    if frame_file is None:
        return jsonify({"error": "No frame uploaded."}), 400

    frame_path = os.path.join(LIBREFACE_TMP_DIR, f"{uuid.uuid4().hex}.jpg")
    frame_file.save(frame_path)
    t0 = time.time()
    try:
        result = libreface.get_facial_attributes_image(
            image_path=frame_path, temp_dir=LIBREFACE_TMP_DIR, device=LIBREFACE_DEVICE,
        )
        label = result.get("facial_expression", "Neutral")
        emotion = LIBREFACE_EXPRESSION_MAP.get(label, "neutral")
    except Exception as e:
        emotion = "neutral"
        print(f"[analyze-frame] LibreFace error: {e}")
    finally:
        elapsed = time.time() - t0
        # Diagnostic: consistently multi-second times here (not just the
        # first call after idling) would point at LibreFace reloading its
        # model from disk on every call, not GPU compute or Cloud Run itself.
        print(f"[analyze-frame] LibreFace call took {elapsed:.2f}s (device={LIBREFACE_DEVICE})")
        try:
            os.remove(frame_path)
        except OSError:
            pass
    return jsonify({"emotion": emotion})


@app.route("/api/warmup", methods=["POST"])
def warmup():
    """Fire-and-forget, called from every page's load (not just Chat/
    Listener). Triggers LibreFace's model construction/weight loading
    against a throwaway blank image — nothing about a real visitor is
    analyzed here, it's purely to get the model warm on THIS running
    container instance before the user's actual session needs it. /tmp
    resets on every fresh Cloud Run instance, so this warms up per-instance
    at runtime rather than relying on anything baked in at build time.
    Safe to call repeatedly — near-instant once already warm."""
    try:
        from PIL import Image
        warmup_path = os.path.join(LIBREFACE_TMP_DIR, "warmup.jpg")
        Image.new("RGB", (224, 224), color=(128, 128, 128)).save(warmup_path)
        libreface.get_facial_attributes_image(
            image_path=warmup_path, temp_dir=LIBREFACE_TMP_DIR, device=LIBREFACE_DEVICE,
        )
        os.remove(warmup_path)
        return jsonify({"warmed": True})
    except Exception as e:
        print(f"[warmup] Failed (non-fatal): {e}")
        return jsonify({"warmed": False})


@app.route("/api/cleanup-sweep", methods=["POST"])
def cleanup_sweep():
    import time
    removed = 0
    cutoff = time.time() - 10
    for fn in os.listdir(LIBREFACE_TMP_DIR):
        path = os.path.join(LIBREFACE_TMP_DIR, fn)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.remove(path)
                removed += 1
        except OSError:
            pass
    return jsonify({"removed": removed})


# ── Default-key path: transcription + chat, proxied through the server.
# No logging happens anywhere in this file — that scope was removed entirely.
@app.route("/api/default/transcribe", methods=["POST"])
def default_transcribe():
    audio_file = request.files.get("audio")
    if audio_file is None:
        return jsonify({"error": "No audio uploaded."}), 400
    client, model = _default_client("openai")
    if client is None:
        return jsonify({"error": "No default transcription key configured on the server."}), 503

    audio_path = os.path.join(LIBREFACE_TMP_DIR, f"{uuid.uuid4().hex}.webm")
    audio_file.save(audio_path)
    try:
        with open(audio_path, "rb") as af:
            transcript_obj = client.audio.transcriptions.create(model=model, file=af)
        transcript = transcript_obj.text.strip()
    except Exception as e:
        transcript = f"[Transcription error: {e}]"
    finally:
        try:
            os.remove(audio_path)
        except OSError:
            pass
    return jsonify({"transcript": transcript})


@app.route("/api/default/chat", methods=["POST"])
def default_chat():
    data = request.get_json(force=True) or {}
    message, emotion = (data.get("message") or "").strip(), data.get("emotion", "neutral")
    if not message:
        return jsonify({"error": "Message is empty."}), 400
    reply = send_default_deepseek(f"[Detected emotion: {emotion}] {message}")
    return jsonify({"reply": reply})


@app.route("/api/default/control-chat", methods=["POST"])
def default_control_chat():
    data = request.get_json(force=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "Message is empty."}), 400
    return jsonify({"reply": send_default_deepseek(message)})


@app.route("/api/default/meta", methods=["POST"])
def default_meta():
    data = request.get_json(force=True) or {}
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "Prompt is empty."}), 400
    return jsonify({"reply": send_default_deepseek(prompt)})


# ── Anonymous consent tally — no identifiers, no dedup, just a counter ─────
@app.route("/api/consent-tally", methods=["POST"])
def consent_tally():
    data = request.get_json(force=True) or {}
    context = data.get("context")
    version = str(data.get("notice_version", CONSENT_NOTICE_VERSION))
    if context not in ("landing", "listener"):
        return jsonify({"error": "Invalid context."}), 400
    try:
        count = store.increment_consent_tally(context, version)
        return jsonify({"context": context, "version": version, "count": count})
    except RuntimeError:
        # No GCS bucket configured — the tally is a nice-to-have aggregate
        # count, not a requirement for consent handling itself (the actual
        # gate is enforced client-side regardless). Don't error out a page
        # load over an optional counter having nowhere to write.
        return jsonify({"context": context, "version": version, "count": None})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
