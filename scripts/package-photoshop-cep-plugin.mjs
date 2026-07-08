import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { packageManagerCommand } from './package-manager-command.mjs';
import { validateZipEntries } from './package-validation.mjs';
import { validateReleaseVersionContract } from './validate-release-version-contract.mjs';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function photoshopCepReleaseAssetName(version) {
  return `debrute-photoshop-cep-${version}.zip`;
}

export async function packagePhotoshopCepPlugin({ outDir = join(workspaceRoot, 'release', 'photoshop-cep') } = {}) {
  await validateReleaseVersionContract(workspaceRoot);
  const version = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8')).version;
  const buildCommand = packageManagerCommand(workspaceRoot, ['--filter', '@debrute/photoshop-cep-plugin', 'build']);
  await execFileAsync(buildCommand.command, buildCommand.args, { cwd: workspaceRoot });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const zip = new AdmZip();
  zip.addLocalFolder(
    join(workspaceRoot, 'apps/photoshop-cep-plugin/dist'),
    'com.debrute.photoshop.bridge.cep'
  );
  const assetName = photoshopCepReleaseAssetName(version);
  const assetPath = join(outDir, assetName);
  await new Promise((resolvePackage, rejectPackage) => {
    zip.writeZip(assetPath, (error) => error ? rejectPackage(error) : resolvePackage());
  });
  validateZipEntries(assetPath, [
    'com.debrute.photoshop.bridge.cep/CSXS/manifest.xml',
    'com.debrute.photoshop.bridge.cep/index.html',
    'com.debrute.photoshop.bridge.cep/assets/index.js',
    'com.debrute.photoshop.bridge.cep/assets/index.css',
    'com.debrute.photoshop.bridge.cep/jsx/debruteBridge.jsx'
  ]);
  return { outDir, assetName, assetPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packagePhotoshopCepPlugin()
    .then((result) => {
      console.log(`Packaged Photoshop CEP plugin: ${result.assetPath}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
