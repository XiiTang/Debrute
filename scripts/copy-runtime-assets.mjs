import { cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await copyOfficialDocs('imageModels');
await copyOfficialDocs('videoModels');
await copyOfficialDocs('audioModels');

async function copyOfficialDocs(modelKind) {
  const source = resolve(root, `packages/capability-runtime/src/${modelKind}/officialDocs/snapshots`);
  const target = resolve(root, `packages/capability-runtime/dist/${modelKind}/officialDocs/snapshots`);

  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}
