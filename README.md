# Affect Companion

A public-facing web app with two modes: **Chat** (talk with an AI, your own
expression tagged along the way) and **Listener Mode** (point the camera at
someone else, speak to them, the AI reads their reaction). Built as real
routed pages (`/`, `/chat`, `/listener`) — no simulated desktop/window
manager — for accessibility, discoverability, and trust with first-time
public visitors.

## Privacy & compliance posture (read this before deploying)

- **No server-side research logs.** Chat/Control transcripts and responses
  are never written to disk or GCS anywhere in this app. This was a
  deliberate scope cut for data minimization under GDPR.
- **Camera frames**: LibreFace's API requires a file path (not raw bytes),
  so a frame briefly exists on disk — deleted immediately after each
  classification call (primary mechanism), with a periodic sweep
  (`/api/cleanup-sweep`, client-triggered every 20s) as a crash-only backup,
  not the main cleanup path. No frozen-frame image is ever displayed,
  stored, or transmitted anywhere beyond that one classification call.
- **Two separate consent gates**, because they cover different people:
  - **Site-wide** (`/`, blocks every page until agreed): versioned,
    `localStorage`-persisted, covers Chat Mode (the person consenting *is*
    the person being analyzed).
  - **Listener Mode**: fires **every time**, never persisted — because the
    person being analyzed is a third party, potentially different each
    session, who never saw the site-wide notice. Requires an explicit
    attestation checkbox alongside the mandatory emotion-filter selection.
- **Anonymous consent tally only** (`/api/consent-tally`): increments a
  counter per `{context, notice_version}` — no IP, no session ID, no
  identifier of any kind. This is deliberately *not* proof of any specific
  individual's consent; it's aggregate evidence the notice was shown and
  accepted N times. **Whether this is sufficient for GDPR Art. 7(1)'s
  "demonstrate consent" requirement in your specific deployment is a real
  legal question — get this reviewed by your university's ethics board or
  a legal advisor before relying on it. This is not legal advice.**
- **EU AI Act awareness**: Article 50 (emotion-recognition transparency)
  has been enforceable EU-wide since 2 August 2026 — this app's consent
  notices are built to address it, but verify current requirements
  yourself, this moves fast. Article 5 *prohibits* emotion recognition in
  workplaces/educational institutions outright (in force since Feb 2025) —
  if any testing happens in an educational context, this needs a direct
  conversation with your institution before deployment, not just a UI notice.

## Architecture

**Two AI-call paths, chosen per visitor, every request:**
- No personal key set → server-proxied **default key** (GCS, admin-only,
  PIN-gated behind `?debug=1` + a real server-side session check — the
  greyed-out UI without `?debug=1` is cosmetic, the actual enforcement is
  server-side on every `/api/admin/*` route).
- Personal key set (Settings drawer → "My personal keys") → stored **only
  in that visitor's `localStorage`**, calls go **browser-direct** to the
  provider. Never touches this server. Raw key is visible in that
  visitor's own DevTools — an accepted, visitor-scoped trade-off, not an
  oversight.

**Settings drawer** is one shared component, identically reachable from
every page (`base.html`) — Filter Emotions + Model Selector together.

**Admin's own filter persists server-side** (`config/admin_filter.json`,
GCS), tied to the PIN session rather than any browser — survives Safari's
confirmed 7-day `localStorage` eviction, incognito mode, or switching
devices. Ordinary visitors' filter stays plain `localStorage`; losing it is
low-stakes for a one-off visitor.

**Listener Mode history is volatile** — a plain in-memory JS array, cleared
on page leave. No frozen frame; the tagged/control toggle applies to the
*text* response for each transcript (identical framing sent with vs.
without the emotion tag), not an image.

## Deployment

```bash
gcloud config set project YOUR_PROJECT_ID
gsutil mb -l europe-west1 gs://YOUR_BUCKET_NAME
gcloud services enable run.googleapis.com cloudbuild.googleapis.com storage.googleapis.com

PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
gsutil iam ch serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com:roles/storage.objectAdmin gs://YOUR_BUCKET_NAME

# CPU-only (no GPU cost):
gcloud run deploy affect-companion \
  --source . --region europe-west1 \
  --set-env-vars GCS_BUCKET_NAME=YOUR_BUCKET_NAME,ADMIN_PIN=YOUR_PIN,FLASK_SECRET_KEY=$(openssl rand -hex 32) \
  --memory 2Gi --cpu 2 --allow-unauthenticated

# With GPU (europe-west1 supports both GPU and custom domain mapping):
gcloud run deploy affect-companion \
  --source . --region europe-west1 \
  --gpu 1 --gpu-type nvidia-l4 --no-gpu-zonal-redundancy --cpu 4 --memory 16Gi \
  --set-env-vars GCS_BUCKET_NAME=YOUR_BUCKET_NAME,ADMIN_PIN=YOUR_PIN,FLASK_SECRET_KEY=$(openssl rand -hex 32) \
  --allow-unauthenticated
```

Custom domain: Cloud Run console → **Manage Custom Domains → Add Mapping**,
`europe-west1` supports the domain-mapping preview feature.

First run: visit with `?debug=1`, open Settings, "Unlock admin editing",
enter your PIN, add your default OpenAI + DeepSeek keys. Everyone else can
use the app immediately after that, or add their own personal key via the
same drawer.

## Known simplifications

- Mobile hasn't been tested on an actual device yet — `facingMode:
  "environment"` and the responsive breakpoint are in place but unverified.
- No conversation memory across turns — every AI call is a single isolated
  message (see project discussion history for the fuller reasoning; fixing
  this means sending a running message array instead, left out of scope here).
- The Listener Mode consent gate re-fires once per page load of `/listener`,
  not per individual recording within a continuous session with the same
  listener — worth confirming that interpretation matches your intent.
