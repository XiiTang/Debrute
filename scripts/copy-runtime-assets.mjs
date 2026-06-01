import { cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'packages/capability-runtime/src/imageModels/officialDocs/snapshots');
const target = resolve(root, 'packages/capability-runtime/dist/imageModels/officialDocs/snapshots');

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
