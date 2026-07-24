import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const paths = [
  'apps/web/dist',
  'apps/desktop/dist-electron',
  'apps/desktop/release',
  'packages/app-protocol/dist',
  'packages/canvas-core/dist',
  'packages/photoshop-bridge-plugin-core/dist',
  'packages/runtime-control-client/dist'
];

for (const path of paths) {
  await removePath(path, { recursive: true });
}

const tsBuildInfoFiles = await findFiles(process.cwd(), (file) => file.endsWith('.tsbuildinfo'));

await Promise.all(tsBuildInfoFiles.map((file) => removePath(file)));

console.log(`Removed ${paths.length} build output paths and ${tsBuildInfoFiles.length} TypeScript build info files.`);

async function findFiles(root, predicate) {
  const ignoredDirectories = new Set(['.git', 'node_modules', 'release', 'dist', 'dist-electron']);
  const found = [];
  await walk(root);
  return found;

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(join(directory, entry.name));
        }
        continue;
      }
      const file = join(directory, entry.name);
      if (entry.isFile() && predicate(file)) {
        found.push(file);
      }
    }
  }
}

async function removePath(path, options = {}) {
  try {
    await rm(path, options);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}
