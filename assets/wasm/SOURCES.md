# Canvas text font subset WASM

`canvas-text-font-subset-v1.wasm` is the checked-in, deterministic font-subset façade used by Canvas text previews. The daily install, development, build, and verification paths validate this file and never download or rebuild it.

The façade performs one fixed pipeline:

1. Google WOFF2 decodes a managed WOFF2 face.
2. HarfBuzz Subset keeps the requested Unicode coverage and its required layout closure.
3. Google WOFF2 encodes the subset back to WOFF2, using Brotli.

All source commits, official archive URLs and hashes, compiler identity, flags, ABI, licenses, artifact size, and artifact hash are closed by `canvas-text-font-subset.lock.json`. The HarfBuzz, Google WOFF2, and Brotli license texts are under `LICENSES/`.

Maintainers reproduce the artifact explicitly on Apple Silicon macOS with:

```bash
pnpm build:canvas-text-font-subset
```

The build runs in a temporary directory, verifies every downloaded official archive before extraction, and replaces the checked-in artifact only when the result exactly matches the locked hash. To validate the checked-in supply without network access:

```bash
pnpm validate:canvas-text-font-subset
```
