// ── Debug mode (session-only, derived fresh from the URL every load) ──
window.DEBUG_MODE = new URLSearchParams(location.search).get("debug") === "1";

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ── Site-wide consent gate — blocks ALL pages until agreed. Versioned so a
// wording change forces re-consent. This is the Chat-Mode-covering gate;
// Listener Mode has its own SEPARATE, non-persistent gate on top of this. ──
const ConsentGate = {
  KEY: "aibuddy.consent",
  isConsented() {
    try {
      const v = JSON.parse(localStorage.getItem(this.KEY) || "null");
      return v && v.version === window.CONSENT_VERSION;
    } catch { return false; }
  },
  grant() {
    localStorage.setItem(this.KEY, JSON.stringify({ version: window.CONSENT_VERSION, at: Date.now() }));
  },
  ensure() {
    if (this.isConsented()) return;
    const overlay = document.createElement("div");
    overlay.className = "consent-overlay";
    overlay.innerHTML = `
      <div class="consent-card">
        <h2>Before you begin</h2>
        <p>This app uses an AI system to analyze facial expressions during
        conversation (Chat Mode reads your own; Listener Mode reads someone
        else's, with its own separate notice each time).</p>
        <ul>
          <li>No conversation transcripts or responses are stored on our server.</li>
          <li>Camera frames are sent for classification and deleted immediately after.</li>
          <li>You can optionally add your own AI provider key, kept only in this browser.</li>
        </ul>
        <label><input type="checkbox" id="consentCheckbox"> I understand and agree to proceed.</label>
        <button class="btn btn-primary btn-block" id="consentAgreeBtn" disabled>Agree & Continue</button>
      </div>
    `;
    document.body.appendChild(overlay);
    const checkbox = overlay.querySelector("#consentCheckbox");
    const agreeBtn = overlay.querySelector("#consentAgreeBtn");
    checkbox.addEventListener("change", () => { agreeBtn.disabled = !checkbox.checked; });
    agreeBtn.addEventListener("click", () => {
      ConsentGate.grant();
      fetch("/api/consent-tally", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: "landing", notice_version: window.CONSENT_VERSION }),
      }).catch(() => {});
      overlay.remove();
    });
  },
};
ConsentGate.ensure();

// ── Personal key manager (localStorage only — NEVER sent to our server) ──
const KeyManager = {
  _key(service) { return `aibuddy.personalkey.${service}`; },
  get(service) {
    try { return JSON.parse(localStorage.getItem(this._key(service)) || "null"); }
    catch { return null; }
  },
  set(service, { key, model, baseUrl }) {
    localStorage.setItem(this._key(service), JSON.stringify({ key, model, baseUrl }));
  },
  clear(service) { localStorage.removeItem(this._key(service)); },
};

// ── Selected camera device — persists across every page (Chat + Listener) ──
const CameraStore = {
  KEY: "aibuddy.cameraDeviceId",
  get() { return localStorage.getItem(this.KEY) || null; }, // null = system default
  set(deviceId) {
    if (deviceId) localStorage.setItem(this.KEY, deviceId);
    else localStorage.removeItem(this.KEY);
  },
  async listVideoInputs() {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    } catch { return []; }
  },
};

// ── Emotion filter — local for everyone; ALSO synced server-side for the
// admin (PIN-authenticated), so it survives beyond any one browser. ──
const FilterStore = {
  _local() {
    try { return JSON.parse(localStorage.getItem("aibuddy.triggerEmotions") || "null") || ["happy", "sad"]; }
    catch { return ["happy", "sad"]; }
  },
  async get() {
    if (window.DEBUG_MODE) {
      try {
        const status = await fetch("/api/admin/status").then(r => r.json());
        if (status.admin) {
          const res = await fetch("/api/admin/filter");
          const data = await res.json();
          if (data.emotions) return data.emotions;
        }
      } catch { /* fall through to local */ }
    }
    return this._local();
  },
  async set(list) {
    localStorage.setItem("aibuddy.triggerEmotions", JSON.stringify(list));
    if (window.DEBUG_MODE) {
      try {
        const status = await fetch("/api/admin/status").then(r => r.json());
        if (status.admin) {
          await fetch("/api/admin/filter", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ emotions: list }),
          });
        }
      } catch { /* local save already happened */ }
    }
  },
};

// ── AI dispatch: personal key (browser-direct) if present, else default
// (server-proxied). No logging anywhere — that scope is out of this app. ──
const AI = {
  async defaultStatus() {
    return fetch("/api/default-keys/status").then(r => r.json());
  },
  async chatSend(message, emotion) {
    const personal = KeyManager.get("deepseek");
    if (personal && personal.key) {
      return this._directChat(personal, `[Detected emotion: ${emotion}] ${message}`);
    }
    const res = await fetch("/api/default/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, emotion }),
    });
    const data = await res.json();
    return data.reply || data.error || "[No response]";
  },
  async controlSend(message) {
    const personal = KeyManager.get("deepseek");
    if (personal && personal.key) return this._directChat(personal, message);
    const res = await fetch("/api/default/control-chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    return data.reply || data.error || "[No response]";
  },
  async metaSend(promptText) {
    const personal = KeyManager.get("deepseek");
    if (personal && personal.key) return this._directChat(personal, promptText);
    const res = await fetch("/api/default/meta", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: promptText }),
    });
    const data = await res.json();
    return data.reply || data.error || "[No response]";
  },
  async transcribe(audioBlob) {
    const personal = KeyManager.get("openai");
    if (personal && personal.key) return this._directTranscribe(personal, audioBlob);
    const form = new FormData();
    form.append("audio", audioBlob, "recording.webm");
    const res = await fetch("/api/default/transcribe", { method: "POST", body: form });
    const data = await res.json();
    return data.transcript || data.error || "";
  },
  async _directChat(personal, promptText) {
    try {
      const base = personal.baseUrl || "https://api.deepseek.com";
      const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${personal.key}` },
        body: JSON.stringify({ model: personal.model || "deepseek-v4-flash", messages: [{ role: "user", content: promptText }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || res.statusText);
      return data.choices[0].message.content.trim();
    } catch (err) { return `[AI error: ${err.message}]`; }
  },
  async _directTranscribe(personal, audioBlob) {
    try {
      const base = personal.baseUrl || "https://api.openai.com/v1";
      const form = new FormData();
      form.append("file", audioBlob, "recording.webm");
      form.append("model", personal.model || "whisper-1");
      const res = await fetch(`${base.replace(/\/$/, "")}/audio/transcriptions`, {
        method: "POST", headers: { "Authorization": `Bearer ${personal.key}` }, body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || res.statusText);
      return data.text.trim();
    } catch (err) { return `[Transcription error: ${err.message}]`; }
  },
};

// ── Emotion analysis ─────────────────────────────────────────────────────
const EmotionAnalysis = {
  MAX_DIM: 320, // downscaled before upload — faster transfer/encode, model resizes internally regardless

  async analyzeFrame(videoEl) {
    const vw = videoEl.videoWidth || this.MAX_DIM;
    const vh = videoEl.videoHeight || this.MAX_DIM;
    const scale = Math.min(1, this.MAX_DIM / Math.max(vw, vh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    canvas.getContext("2d").drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) return "neutral";
    const form = new FormData();
    form.append("frame", blob, "frame.jpg");
    try {
      const res = await fetch("/api/analyze-frame", { method: "POST", body: form });
      const data = await res.json();
      return data.emotion || "neutral";
    } catch { return "neutral"; }
  },
};
setInterval(() => { fetch("/api/cleanup-sweep", { method: "POST" }).catch(() => {}); }, 20000);

// ── Toast (debug-mode notice — restyled to this design system, not XP) ──
function showToast(text) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}
if (window.DEBUG_MODE) {
  window.addEventListener("load", () => setTimeout(() => showToast("Debug tools unlocked — see Chat's debug section and Settings."), 700));
}

// ── Settings drawer (shared, identical on every page) ───────────────────
function initSettingsDrawer() {
  const drawer = document.getElementById("settingsDrawer");
  const backdrop = document.getElementById("drawerBackdrop");
  if (!drawer) return;

  document.getElementById("openSettingsBtn").addEventListener("click", async () => {
    drawer.classList.add("open"); backdrop.classList.add("open");
    await populateDrawer();
  });
  const close = () => { drawer.classList.remove("open"); backdrop.classList.remove("open"); };
  document.getElementById("closeDrawerBtn").addEventListener("click", close);
  backdrop.addEventListener("click", close);

  ["openai", "deepseek"].forEach((svc) => {
    const existing = KeyManager.get(svc);
    if (existing) {
      document.getElementById(`pk-${svc}-key`).value = existing.key || "";
      document.getElementById(`pk-${svc}-model`).value = existing.model || "";
      document.getElementById(`pk-${svc}-base`).value = existing.baseUrl || "";
    }
    document.getElementById(`pk-${svc}-save`).addEventListener("click", () => {
      KeyManager.set(svc, {
        key: document.getElementById(`pk-${svc}-key`).value.trim(),
        model: document.getElementById(`pk-${svc}-model`).value.trim(),
        baseUrl: document.getElementById(`pk-${svc}-base`).value.trim(),
      });
      document.getElementById(`pk-${svc}-status`).textContent = "Saved to this browser.";
    });
  });
}

async function populateCameraSelect(selectEl) {
  const devices = await CameraStore.listVideoInputs();
  const current = CameraStore.get();
  selectEl.innerHTML = `<option value="">System default</option>`;
  const hasLabels = devices.some((d) => d.label);
  devices.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i + 1}`;
    if (d.deviceId === current) opt.selected = true;
    selectEl.appendChild(opt);
  });
  if (!hasLabels && devices.length) {
    const hint = selectEl.parentElement?.querySelector(".hint");
    if (hint) hint.textContent = "Camera names will appear after you grant camera access once — open Chat or Listener Mode first, then come back here.";
  }
  selectEl.addEventListener("change", () => {
    CameraStore.set(selectEl.value || null);
    document.dispatchEvent(new CustomEvent("cameraChanged"));
  });
}

async function populateDrawer() {
  // Filter checkboxes
  try {
    const grid = document.getElementById("drawerFilterGrid");
    const current = new Set(await FilterStore.get());
    grid.innerHTML = "";
    window.ALL_EMOTIONS.forEach((e) => {
      const label = document.createElement("label");
      label.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12.5px;text-transform:capitalize";
      label.innerHTML = `<input type="checkbox" value="${e}" ${current.has(e) ? "checked" : ""}> ${e}`;
      grid.appendChild(label);
      label.querySelector("input").addEventListener("change", async (ev) => {
        if (ev.target.checked) current.add(e); else current.delete(e);
        await FilterStore.set([...current]);
        document.dispatchEvent(new CustomEvent("filterChanged"));
      });
    });
  } catch (err) {
    console.error("Filter section failed:", err);
  }

  // Camera selector — persists across every page via CameraStore
  try {
    await populateCameraSelect(document.getElementById("drawerCameraSelect"));
  } catch (err) {
    console.error("Camera section failed:", err);
  }

  // Default status
  try {
    const status = await AI.defaultStatus();
    document.getElementById("defaultStatusLine").textContent =
      `Audio Transcription: ${status.openai.available ? status.openai.model : "not configured"} · ` +
      `Prompt Processing: ${status.deepseek.available ? status.deepseek.model : "not configured"}`;
  } catch (err) {
    document.getElementById("defaultStatusLine").textContent =
      "Could not reach the server to check default key status. Check the browser console and server logs.";
    console.error("Default status check failed:", err);
  }

  // Admin section
  try {
    await renderAdminSection(document.getElementById("adminSection"));
  } catch (err) {
    document.getElementById("adminSection").innerHTML =
      `<p class="hint" style="color:var(--live)">Could not load admin controls — see browser console.</p>`;
    console.error("Admin section failed:", err);
  }
}

async function renderAdminSection(container) {
  if (!window.DEBUG_MODE) {
    container.innerHTML = `<div class="field disabled"><label>Edit default keys</label><input disabled placeholder="Locked"></div>`;
    return;
  }
  const isAdmin = (await fetch("/api/admin/status").then(r => r.json())).admin;
  if (!isAdmin) {
    container.innerHTML = `<button class="btn btn-block" id="unlockAdminBtn">🔒 Unlock admin editing</button>`;
    container.querySelector("#unlockAdminBtn").addEventListener("click", () => openPinPrompt(() => renderAdminSection(container)));
    return;
  }
  container.innerHTML = `
    <fieldset>
      <legend>Admin</legend>
      <p class="hint" style="color:var(--ai)">Admin unlocked. Your filter now syncs to the server.</p>
      <select id="adminSvc" style="width:100%;padding:6px;margin-bottom:6px">
        <option value="openai">Audio Transcription (OpenAI-compatible)</option>
        <option value="deepseek">Prompt Processing (DeepSeek-compatible)</option>
      </select>
      <div class="field"><label>File name</label><input id="adminFilename"></div>
      <div class="field"><label>API key</label><input type="password" id="adminKey"></div>
      <div class="field"><label>Model</label><input id="adminModel"></div>
      <div class="field"><label>Base URL</label><input id="adminBaseUrl"></div>
      <button class="btn btn-block" id="adminSaveBtn">Save & activate as default</button>
      <p class="hint" id="adminStatus"></p>
    </fieldset>
  `;
  container.querySelector("#adminSaveBtn").addEventListener("click", async () => {
    const res = await fetch("/api/admin/default-keys", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: container.querySelector("#adminSvc").value,
        filename: container.querySelector("#adminFilename").value,
        key: container.querySelector("#adminKey").value,
        model: container.querySelector("#adminModel").value,
        base_url: container.querySelector("#adminBaseUrl").value,
      }),
    });
    const data = await res.json();
    container.querySelector("#adminStatus").textContent = res.ok ? `Saved '${data.saved}'.` : (data.error || "Failed.");
  });
}

function openPinPrompt(onSuccess) {
  const pin = prompt("Enter admin PIN:");
  if (pin === null) return;
  fetch("/api/admin/login", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  }).then(async (res) => {
    if (res.ok) onSuccess();
    else alert((await res.json()).error || "Incorrect PIN.");
  });
}

document.addEventListener("DOMContentLoaded", initSettingsDrawer);
