import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

export function validateZipEntries(zipPath, requiredEntries) {
  const zip = new AdmZip(zipPath);
  const entries = new Set(zip.getEntries().map((entry) => entry.entryName.replaceAll('\\', '/')));
  for (const requiredEntry of requiredEntries) {
    if (!entries.has(requiredEntry)) {
      throw new Error(`Package archive is missing required entry: ${requiredEntry}`);
    }
  }
}

export async function validateDebruteCliRuntimePayload(outDir, releaseTarget, runtimePayloadEntries = []) {
  await assertPackagePath(outDir, releaseTarget.executableName);
  await assertPackagePath(outDir, 'package.json');
  await assertPackagePath(outDir, 'official-docs/imageModels/snapshots');
  await assertPackagePath(outDir, 'official-docs/videoModels/snapshots');
  await assertPackagePath(outDir, 'official-docs/audioModels/snapshots');
  for (const entry of runtimePayloadEntries) {
    await assertPackagePath(outDir, entry.to);
  }
}

async function assertPackagePath(root, relativePath) {
  try {
    await stat(join(root, relativePath));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Package output is missing required path: ${relativePath}`);
    }
    throw error;
  }
}
