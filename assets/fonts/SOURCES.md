# Bundled Fonts

Debrute bundles the following OFL-1.1 font assets for deterministic product UI rendering:

- Smiley Sans 2.0.1: `SmileySans-Oblique.woff2`, retained from the project's official WOFF2 release asset.
- Noto Sans SC 2.004: Regular and Bold converted from the official static OTF release; Semibold is a static 600-weight instance from the official variable font.
- Noto Sans Mono CJK SC 2.004: Regular and Bold converted from the official static OTF release.
- Lilex 2.700: upstream Regular and Bold WOFF2 release assets.
- JetBrains Mono 2.304: upstream Regular and Bold WOFF2 release assets.
- IBM Plex Mono 2.5.0: Regular and Bold WOFF2 assets from the official `@ibm/plex-mono` package.

Upstream sources:

- <https://github.com/atelier-anchor/smiley-sans/releases/tag/v2.0.1>
- <https://github.com/notofonts/noto-cjk/releases/tag/Sans2.004>
- <https://github.com/mishamyrt/Lilex/releases/tag/2.700>
- <https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304>
- <https://www.npmjs.com/package/@ibm/plex-mono/v/2.5.0>

The Noto conversions use the Google WOFF2 encoder without changing outlines or
metrics. Canvas Font selection uses only the bundled normal-style faces; Lilex,
JetBrains Mono, and IBM Plex Mono use the bundled Noto Sans Mono CJK SC faces
for deterministic CJK fallback. License texts are preserved in `LICENSES/`.
