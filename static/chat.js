(function () {
  let currentEmotion = "neutral";
  let webcamOn = true;
  let showingControl = false;
  let stream = null;
  const video = document.createElement("video");
  video.autoplay = true; video.muted = true; video.playsInline = true;

  const chatHistory = [], controlHistory = [];
  const logBox = document.getElementById("chatLog");

  function render() {
    logBox.innerHTML = "";
    const list = showingControl ? controlHistory : chatHistory;
    if (!list.length) {
      logBox.innerHTML = `<div class="log-empty">No messages yet — say hi below.</div>`;
      return;
    }
    list.forEach((l) => {
      const div = document.createElement("div");
      div.className = "log-line";
      div.innerHTML = `<div class="log-who ${l.who === "AI" ? "ai" : "user"}">${escapeHtml(l.who)}</div>${escapeHtml(l.text)}`;
      logBox.appendChild(div);
    });
    logBox.scrollTop = logBox.scrollHeight;
  }
  render();

  document.querySelectorAll("#logTogglePill button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#logTogglePill button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      showingControl = btn.dataset.view === "control";
      render();
    });
  });

  async function startWebcam() {
    const deviceId = CameraStore.get();
    const constraints = deviceId ? { video: { deviceId: { exact: deviceId } } } : { video: true };
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      // Selected device may be unplugged/unavailable — fall back to default
      // rather than failing outright.
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true }); }
      catch {
        webcamOn = false;
        document.getElementById("webcamToggle").checked = false;
        return;
      }
    }
    video.srcObject = stream;
    analysisLoop();
  }
  function stopWebcam() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    clearInterval(analysisTimer);
  }
  let analysisTimer = null;
  function analysisLoop() {
    clearInterval(analysisTimer);
    analysisTimer = setInterval(async () => {
      if (!webcamOn || !stream) return;
      currentEmotion = await EmotionAnalysis.analyzeFrame(video);
    }, 1500);
  }
  document.getElementById("webcamToggle").addEventListener("change", (e) => {
    webcamOn = e.target.checked;
    if (webcamOn) startWebcam(); else { stopWebcam(); currentEmotion = "neutral"; }
  });
  startWebcam();

  // Debug: manual emotion override (session-only, ?debug=1)
  if (window.DEBUG_MODE) {
    const section = document.getElementById("debugSection");
    section.style.display = "block";
    const btnRow = document.getElementById("debugButtons");
    window.ALL_EMOTIONS.forEach((e) => {
      const btn = document.createElement("button");
      btn.className = "btn"; btn.textContent = e[0].toUpperCase() + e.slice(1);
      btn.addEventListener("click", () => { currentEmotion = e; });
      btnRow.appendChild(btn);
    });
  }

  async function send(text) {
    if (!text.trim()) return;
    chatHistory.push({ who: `You (${currentEmotion})`, text });
    controlHistory.push({ who: "You", text });
    render();
    const [chatReply, controlReply] = await Promise.all([
      AI.chatSend(text, currentEmotion),
      AI.controlSend(text),
    ]);
    chatHistory.push({ who: "AI", text: chatReply });
    controlHistory.push({ who: "AI", text: controlReply });
    render();
  }

  document.getElementById("sendBtn").addEventListener("click", () => {
    const input = document.getElementById("chatInput");
    const text = input.value; input.value = "";
    send(text);
  });
  document.getElementById("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("sendBtn").click();
  });

  // Voice input — manual press-to-talk, no auto-stop (that's Listener Mode's job)
  let micStream = null, recorder = null, chunks = [];
  const micBtn = document.getElementById("micBtn");
  micBtn.addEventListener("click", async () => {
    if (recorder && recorder.state === "recording") { recorder.stop(); micBtn.textContent = "🎙"; return; }
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return; }
    chunks = [];
    recorder = new MediaRecorder(micStream);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      micStream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: "audio/webm" });
      const transcript = await AI.transcribe(blob);
      if (transcript) send(transcript);
    };
    recorder.start();
    micBtn.textContent = "⏹";
  });

  document.addEventListener("cameraChanged", () => {
    if (webcamOn) { stopWebcam(); startWebcam(); }
  });

  window.addEventListener("beforeunload", stopWebcam);
})();
