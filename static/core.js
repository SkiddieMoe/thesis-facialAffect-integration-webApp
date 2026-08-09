<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{% block title %}Affect Companion{% endblock %}</title>
<link rel="stylesheet" href="{{ url_for('static', filename='style.css') }}">
</head>
<body>

<header class="site-header">
  <a href="/" class="brand">Affect Companion</a>
  <nav class="nav-links">
    <a href="/chat" class="nav-link {{ 'active' if active_page == 'chat' }}">Chat</a>
    <a href="/listener" class="nav-link {{ 'active' if active_page == 'listener' }}">Listener Mode</a>
    <button class="settings-btn" id="openSettingsBtn">Settings</button>
  </nav>
</header>

<main>
  {% block content %}{% endblock %}
</main>

<!-- Settings drawer: identical, reachable from every page -->
<div class="drawer-backdrop" id="drawerBackdrop"></div>
<div class="drawer" id="settingsDrawer">
  <button class="close-btn" id="closeDrawerBtn">×</button>
  <h3>Filter Emotions</h3>
  <p class="hint">Listener Mode auto-stops a recording when one of these is detected.</p>
  <div class="checkbox-grid" id="drawerFilterGrid"></div>

  <h3>Camera</h3>
  <p class="hint">Applies on every page. Names appear after you've granted camera access once.</p>
  <select id="drawerCameraSelect" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px"></select>

  <h3>My personal keys</h3>
  <p class="hint">Stored only in this browser. Calls go directly from your browser to the provider — never through this server.</p>
  {% for svc in ["openai", "deepseek"] %}
  <fieldset>
    <legend>{{ "Audio Transcription" if svc == "openai" else "Prompt Processing" }}</legend>
    <div class="field"><label>API key</label><input type="password" id="pk-{{ svc }}-key"></div>
    <div class="field"><label>Model</label><input type="text" id="pk-{{ svc }}-model" placeholder="{{ 'whisper-1' if svc == 'openai' else 'deepseek-v4-flash' }}"></div>
    <div class="field"><label>Base URL</label><input type="text" id="pk-{{ svc }}-base" placeholder="{{ 'OpenAI default' if svc == 'openai' else 'https://api.deepseek.com' }}"></div>
    <button class="btn btn-block" data-svc="{{ svc }}" id="pk-{{ svc }}-save">Save</button>
    <p class="hint" id="pk-{{ svc }}-status"></p>
  </fieldset>
  {% endfor %}

  <h3>App defaults</h3>
  <p class="hint" id="defaultStatusLine">Checking…</p>
  <div id="adminSection"></div>
</div>

<script>window.ALL_EMOTIONS = {{ all_emotions | tojson }};
window.CONSENT_VERSION = {{ consent_version | tojson }};
window.ACTIVE_PAGE = {{ (active_page or "") | tojson }};</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.5/purify.min.js"></script>
<script src="{{ url_for('static', filename='core.js') }}"></script>
{% block scripts %}{% endblock %}
</body>
</html>
