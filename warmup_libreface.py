"""
Run ONCE during the Docker build (not at container startup) to trigger
LibreFace's model weight downloads ahead of time, baking them into the
image layer.

Without this, every fresh Cloud Run instance re-downloads weights on its
first request — and since scale-to-zero means fresh instances happen
often, that's a real recurring cost in both wall-clock time (Cloud Run
bills for the request duration while it's stuck downloading) and, if
weights come from a rate-limited host, occasional flakiness too.

Best-effort and non-fatal: if this fails for any reason (network hiccup
during build, a library change), it prints a warning but does NOT fail the
build. The app just falls back to downloading at runtime instead — exactly
the behavior before this script existed, minus the optimization.
"""
import sys

try:
    from PIL import Image
    import libreface

    # Any image works here — this just needs to trigger model construction
    # and checkpoint loading, not produce a meaningful classification. A
    # blank placeholder avoids needing to bundle a real photo in the repo.
    Image.new("RGB", (224, 224), color=(128, 128, 128)).save("/tmp/warmup.jpg")

    libreface.get_facial_attributes_image(
        image_path="/tmp/warmup.jpg",
        temp_dir="/tmp/libreface_warmup",
        device="cpu",  # the build environment has no GPU regardless of the
                        # deploy target — weight files themselves don't
                        # depend on which device they'll later run on.
    )
    print("[warmup] LibreFace weights pre-cached into the image.")
except Exception as e:
    print(f"[warmup] Could not pre-cache weights (non-fatal, will download at runtime instead): {e}")
    sys.exit(0)
