# Live assets

Drop raw, uncompressed images, audio or video here. They are **not** packed into the project —
the x70 Bridge serves them from this folder over the local bridge, and the extension's
"Live assets" blocks load them straight into the renderer / Web Audio at runtime, bypassing
Scratch's asset-compression limits.

Examples:
- `set my costume to asset [player.png]`   – PNG/JPG/WebP/AVIF/SVG, `name@2x.png` for high-DPI
- `play asset sound [music.flac]`          – WAV/MP3/OGG/FLAC/M4A/Opus, lossless welcome
- `all assets`                             – lists everything in this folder

Subfolders are fine: use `characters/hero.png`. Files here are only reachable through the bridge
token on the loopback interface (or your own forwarded Codespaces port).
