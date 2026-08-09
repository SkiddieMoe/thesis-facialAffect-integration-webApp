(function () {
  let stream = null, micStream = null, recorder = null, chunks = [];
  let listening = false, analysisTimer = null;
  let lastEmotion = "neutral", lastChangeTime = 0;
  const COOLDOWN_MS = 2000;
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
      label.innerHTML = `<input type="checkbox" value="${e}" ${triggerSet.has(e) ? "checked" : ""}> ${e}`;
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
      catch { alert("Camera access is required for Listener Mode."); return; }
    }
    video.srcObject = stream;
    gate.style.display = "none";
    stage.style.display = "flex";
    analysisTimer = setInterval(runAnalysisCycle, 1500);
  }

  async function runAnalysisCycle() {
    const emotion = await EmotionAnalysis.analyzeFrame(video);
    readout.textContent = `Detected: ${emotion}`;
    const now = Date.now();
    if (emotion !== lastEmotion && now - lastChangeTime >= COOLDOWN_MS) {
      lastChangeTime = now; lastEmotion = emotion;
      if (listening && triggerSet.has(emotion)) stopRecording(emotion);
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
    recordBtn.textContent = "⏹ Stop Recording";
  });

  function stopRecording(gesture) {
    listening = false;
    recordBtn.textContent = "🎙 Start Recording";
    if (recorder && recorder.state === "recording") {
      recorder.onstop = () => onRecordingStopped(gesture);
      recorder.stop();
    }
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
  }

  async function onRecordingStopped(gesture) {
    const blob = new Blob(chunks, { type: "audio/webm" });
    triggeredArea.innerHTML = `<div class="triggered-card"><p class="hint">Transcribing…</p></div>`;

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
    triggeredArea.innerHTML = `
      <div class="triggered-card">
        <div class="emo-tag">Detected: ${escapeHtml(entry.gesture)}</div>
        <p style="font-size:13px;margin:6px 0"><strong>Transcript:</strong> ${escapeHtml(entry.transcript)}</p>
        <p style="font-size:13.5px">${escapeHtml(historyView === "chat" ? entry.chatReply : entry.controlReply)}</p>
        <button class="btn btn-block" id="closeTriggeredBtn">Close</button>
      </div>
    `;
    triggeredArea.querySelector("#closeTriggeredBtn").addEventListener("click", () => { triggeredArea.innerHTML = ""; });
  }

  function renderHistory() {
    historyList.innerHTML = "";
    if (!history.length) {
      historyList.innerHTML = `<p class="hint">No exchanges yet this session.</p>`;
      return;
    }
    history.forEach((entry) => {
      const div = document.createElement("div");
      div.className = "history-item";
      div.innerHTML = `
        <div class="ts">${entry.ts.toLocaleTimeString()} · ${escapeHtml(entry.gesture)}</div>
        <div><strong>Transcript:</strong> ${escapeHtml(entry.transcript)}</div>
        <div>${escapeHtml(historyView === "chat" ? entry.chatReply : entry.controlReply)}</div>
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
