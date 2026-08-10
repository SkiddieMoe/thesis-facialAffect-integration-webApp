"""
Persistence layer backed by Google Cloud Storage.

By design, this app keeps NO server-side research logs (chat transcripts,
prompts, responses) — that scope was deliberately removed for data-
minimization / EU AI Act & GDPR reasons. What's stored here is limited to:

    keys/<filename>.txt      - default (admin) key: line1=key, line2=model, line3=base_url
    keys/meta.json            - {"<filename>": "openai" | "deepseek"}
    config/active.json        - {"openai": "<filename>", "deepseek": "<filename>"}
    config/admin_filter.json  - the admin's own persistent emotion filter,
                                 tied to the PIN session rather than a browser,
                                 so it survives Safari's 7-day storage eviction,
                                 incognito mode, or just using a different device.
    config/consent_tally.json - fully anonymous counters, no identifiers:
                                 {"landing": {"1.0": 412}, "listener": {"1.0": 89}}
"""
import json
import os
from google.cloud import storage

BUCKET_NAME = os.environ.get("GCS_BUCKET_NAME")

_client = None
_bucket = None


def _get_bucket():
    """Returns None if GCS isn't configured, rather than raising — GCS is
    now optional infrastructure (default keys come from env vars; GCS-backed
    admin filter-sync is a nice-to-have). A read path hitting this must
    degrade to 'nothing here' since default_keys_status() is a public,
    unauthenticated endpoint every visitor's page load calls."""
    global _client, _bucket
    if _bucket is None:
        if not BUCKET_NAME:
            return None
        _client = storage.Client()
        _bucket = _client.bucket(BUCKET_NAME)
    return _bucket


def read_text(blob_name: str):
    bucket = _get_bucket()
    if bucket is None:
        return None
    blob = bucket.blob(blob_name)
    if not blob.exists():
        return None
    return blob.download_as_text()


def write_text(blob_name: str, content: str):
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError(
            "GCS_BUCKET_NAME environment variable is not set — cannot save. "
            "This only matters for the optional admin filter-sync feature; "
            "default keys work fine via env vars without any GCS bucket."
        )
    bucket.blob(blob_name).upload_from_string(content, content_type="text/plain; charset=utf-8")


def read_json(blob_name: str, default=None):
    raw = read_text(blob_name)
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def write_json(blob_name: str, data):
    write_text(blob_name, json.dumps(data, indent=2))


# ── Default (admin) key helpers ─────────────────────────────────────────────
DEFAULT_OPENAI_MODEL, DEFAULT_DEEPSEEK_MODEL = "whisper-1", "deepseek-v4-flash"
DEFAULT_OPENAI_BASE_URL, DEFAULT_DEEPSEEK_BASE_URL = "", "https://api.deepseek.com"


def list_key_files(service: str):
    meta = read_json("keys/meta.json", default={})
    return sorted(fn for fn, svc in meta.items() if svc == service)


def save_key_file(filename: str, service: str, key_value: str, model: str, base_url: str):
    meta = read_json("keys/meta.json", default={})
    meta[filename] = service
    write_json("keys/meta.json", meta)
    write_text(f"keys/{filename}", f"{key_value.strip()}\n{(model or '').strip()}\n{(base_url or '').strip()}\n")


def get_key_lines(filename: str):
    raw = read_text(f"keys/{filename}")
    if raw is None:
        return None
    lines = raw.splitlines()
    return {
        "key": lines[0].strip() if len(lines) >= 1 else "",
        "model": lines[1].strip() if len(lines) >= 2 else "",
        "base_url": lines[2].strip() if len(lines) >= 3 else "",
    }


def get_active_key_filename(service: str):
    return read_json("config/active.json", default={}).get(service)


def set_active_key_filename(service: str, filename: str):
    active = read_json("config/active.json", default={})
    active[service] = filename
    write_json("config/active.json", active)


def get_active_default(service: str):
    filename = get_active_key_filename(service)
    if not filename:
        return None
    return get_key_lines(filename)


# ── Admin's own persistent filter (survives any browser) ───────────────────
def get_admin_filter():
    return read_json("config/admin_filter.json", default=None)


def set_admin_filter(emotions: list):
    write_json("config/admin_filter.json", emotions)


# ── Anonymous consent tally (no identifiers, no dedup) ──────────────────────
def increment_consent_tally(context: str, version: str):
    data = read_json("config/consent_tally.json", default={})
    ctx = data.setdefault(context, {})
    ctx[version] = ctx.get(version, 0) + 1
    write_json("config/consent_tally.json", data)
    return ctx[version]
