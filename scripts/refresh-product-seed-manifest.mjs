import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refreshProductSeedManifest } from './assemble-product-seed.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(process.argv[2] ?? join(
  workspaceRoot,
  'apps/desktop/dist-electron/product-seed'
));

await refreshProductSeedManifest(destination);
