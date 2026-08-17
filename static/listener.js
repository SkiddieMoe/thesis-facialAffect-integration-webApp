(function () {
  let stream = null, micStream = null, recorder = null, chunks = [];
  let listening = false, analysisTimer = null;
  let lastEmotion = "neutral", lastChangeTime = 0;
  // POST-registration refractory period: minimum time after a sustained
  // change IS registered before the NEXT one can register. Does NOT
  // control how long an emotion must persist BEFORE registering — that's
  // SUSTAIN_MS below. Two separate, orthogonal concepts (same design as
  // the desktop app).
  const COOLDOWN_MS = 2000;
  // A detected emotion only registers as a genuine "sustained change" once
  // the SAME classification has held continuously for at least this long —
  // a single differing analysis cycle is no longer enough on its own.
  const SUSTAIN_MS = 1000;
  // The in-progress candidate for a sustained change: an emotion currently
  // differing from lastEmotion that's been continuously observed since
  // pendingSince. Reset whenever a new recording starts — see the
  // recordBtn handler — otherwise a candidate from an earlier, unrelated
  // recording could count toward this one.
  let pendingEmotion = null, pendingSince = 0;
  let triggerSet = new Set();
  let historyView = "chat"; // "chat" = tagged, "control" = untagged
  const history = []; // volatile — cleared on page leave, never persisted

  const gate = document.getElementById("listenerGate");
  const stage = document.getElementById("listenerStage");
  const video = document.getElementById("listenerVideo");
  const readout = document.getElementById("listenerReadout");
  const recordBtn = document.getElementById("recordBtn");
  const triggeredArea = document.getElementById("triggeredArea");
  const historyList = document.getElementById("historyList");

  // ── Gate: filter selection + every-session attestation (never persisted) ──
  async function renderGate() {
    triggerSet = new Set(await FilterStore.get());
    const grid = document.getElementById("gateFilterGrid");
    grid.innerHTML = "";
    window.ALL_EMOTIONS.forEach((e) => {
      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox" value="${e}" ${triggerSet.has(e) ? "checked" : ""}> ${emotionLabel(e)}`;
      grid.appendChild(label);
      label.querySelector("input").addEventListener("change", async (ev) => {
        if (ev.target.checked) triggerSet.add(e); else triggerSet.delete(e);
        await FilterStore.set([...triggerSet]);
        updateStartEnabled();
      });
    });
    updateStartEnabled();
  }
  const attestCheckbox = document.getElementById("attestCheckbox");
  attestCheckbox.addEventListener("change", updateStartEnabled);
  function updateStartEnabled() {
    document.getElementById("startListeningBtn").disabled = !(triggerSet.size > 0 && attestCheckbox.checked);
  }
  renderGate();

  document.getElementById("startListeningBtn").addEventListener("click", async () => {
    // Fires every time this gate is passed — no persistence, matches the
    // requirement that this notice can't be assumed already-seen by
    // whichever third party happens to be listening today.
    fetch("/api/consent-tally", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: "listener", notice_version: window.CONSENT_VERSION }),
    }).catch(() => {});
    startListening();
  });

  async function startListening() {
    let devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"); } catch {}

    const explicitDeviceId = CameraStore.get();
    let videoConstraint;
    if (explicitDeviceId) {
      // Explicit choice from Settings takes priority over the automatic
      // rear-camera guess below.
      videoConstraint = { deviceId: { exact: explicitDeviceId } };
    } else {
      const envDevice = devices.find((d) => /back|rear|environment/i.test(d.label));
      videoConstraint = envDevice ? { deviceId: { exact: envDevice.deviceId } } : { facingMode: "environment" };
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint });
    } catch {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true }); }
      catch { alert((window.T || {}).camera_alert || "Camera access is required for Listener Mode."); return; }
    }
    video.srcObject = stream;
    gate.style.display = "none";
    stage.style.display = "flex";
    analysisTimer = setInterval(runAnalysisCycle, 1500);
  }

  async function runAnalysisCycle() {
    const emotion = await EmotionAnalysis.analyzeFrame(video);
    readout.textContent = `${(window.T || {}).detected_prefix || "Detected"}: ${emotionLabel(emotion)}`;
    const now = Date.now();

    if (emotion === lastEmotion) {
      // Matches the currently-registered state — no candidate in progress.
      pendingEmotion = null;
      pendingSince = 0;
    } else if (emotion === pendingEmotion) {
      // Continuing an existing candidate streak.
      if (now - pendingSince >= SUSTAIN_MS) {
        // Held long enough to count as genuinely sustained. Whether it's
        // actually ACTED on yet still depends on the separate post-trigger
        // refractory cooldown below — being sustained doesn't override
        // that, it just makes this emotion eligible.
        if (now - lastChangeTime >= COOLDOWN_MS) {
          lastChangeTime = now;
          lastEmotion = emotion;
          pendingEmotion = null;
          pendingSince = 0;
          if (listening && triggerSet.has(emotion)) stopRecording(emotion);
        }
        // else: sustained long enough, just still inside the refractory
        // window — keep the streak alive rather than resetting it, so it
        // registers the instant the refractory period ends instead of
        // re-accumulating from zero.
      }
      // else: not yet held long enough — keep waiting.
    } else {
      // A genuinely different candidate emotion appeared — start a fresh streak.
      pendingEmotion = emotion;
      pendingSince = now;
    }
  }

  recordBtn.addEventListener("click", async () => {
    if (listening) { stopRecording("manual"); return; }
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return; }
    chunks = [];
    recorder = new MediaRecorder(micStream);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
    listening = true;
    // Fresh window for THIS recording — otherwise a trigger from an
    // earlier, unrelated recording keeps blocking this one until the full
    // cooldown elapses since that old trigger, not since this one began.
    lastChangeTime = 0;
    pendingEmotion = null;
    pendingSince = 0;
    recordBtn.textContent = (window.T || {}).btn_stop_recording || "⏹ Stop Recording";
  });

  function stopRecording(gesture) {
    listening = false;
    recordBtn.textContent = (window.T || {}).btn_start_recording || "🎙 Start Recording";
    if (recorder && recorder.state === "recording") {
      recorder.onstop = () => onRecordingStopped(gesture);
      recorder.stop();
    }
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
  }

  async function onRecordingStopped(gesture) {
    const blob = new Blob(chunks, { type: "audio/webm" });
    triggeredArea.innerHTML = `<div class="triggered-card"><p class="hint">${(window.T || {}).transcribing || "Transcribing…"}</p></div>`;

    const transcript = await AI.transcribe(blob);
    const [chatReply, controlReply] = await Promise.all([
      AI.chatSend(transcript, gesture),
      AI.controlSend(transcript),
    ]);

    const entry = { ts: new Date(), gesture, transcript, chatReply, controlReply };
    renderTriggered(entry);
    history.unshift(entry);
    renderHistory();
  }

  function renderTriggered(entry) {
    const T = window.T || {};
    const replyText = historyView === "chat" ? entry.chatReply : entry.controlReply;
    triggeredArea.innerHTML = `
      <div class="triggered-card">
        <div class="emo-tag">${T.detected_prefix || "Detected"}: ${escapeHtml(emotionLabel(entry.gesture))}</div>
        <p style="font-size:13px;margin:6px 0"><strong>${T.transcript_label || "Transcript:"}</strong> ${escapeHtml(entry.transcript)}</p>
        <div style="font-size:13.5px">${renderMarkdown(replyText)}</div>
        <button class="btn btn-block" id="closeTriggeredBtn">${T.btn_close || "Close"}</button>
      </div>
    `;
    triggeredArea.querySelector("#closeTriggeredBtn").addEventListener("click", () => { triggeredArea.innerHTML = ""; });
  }

  function renderHistory() {
    const T = window.T || {};
    historyList.innerHTML = "";
    if (!history.length) {
      historyList.innerHTML = `<p class="hint">${T.history_empty || "No exchanges yet this session."}</p>`;
      return;
    }
    history.forEach((entry) => {
      const div = document.createElement("div");
      div.className = "history-item";
      const replyText = historyView === "chat" ? entry.chatReply : entry.controlReply;
      div.innerHTML = `
        <div class="ts">${entry.ts.toLocaleTimeString()} · ${escapeHtml(emotionLabel(entry.gesture))}</div>
        <div><strong>${T.transcript_label || "Transcript:"}</strong> ${escapeHtml(entry.transcript)}</div>
        <div>${renderMarkdown(replyText)}</div>
      `;
      historyList.appendChild(div);
    });
  }

  document.querySelectorAll("#historyTogglePill button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#historyTogglePill button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      historyView = btn.dataset.view === "control" ? "control" : "chat";
      renderHistory();
      if (triggeredArea.querySelector(".triggered-card") && history.length) renderTriggered(history[0]);
    });
  });

  document.addEventListener("filterChanged", async () => { triggerSet = new Set(await FilterStore.get()); });

  window.addEventListener("beforeunload", () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    clearInterval(analysisTimer);
  });
})();
