import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { validateProductSeed } from './assemble-product-seed.mjs';
import {
  findLocalMacosApplication,
  replaceInstalledApplication,
  verifyLocalMacosApplication
} from './local-macos-application.mjs';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function installLocalMacos() {
  if (process.platform !== 'darwin') {
    throw new Error(`Local Desktop installation requires macOS, received ${process.platform}.`);
  }
  if (process.arch !== 'arm64' && process.arch !== 'x64') {
    throw new Error(`Unsupported local macOS architecture: ${process.arch}`);
  }

  const packageJson = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8'));
  const expectedVersion = packageJson.version;
  const applicationsDirectory = '/Applications';
  const installedApplication = join(applicationsDirectory, 'Debrute.app');
  const sourceApplication = await findLocalMacosApplication(
    join(workspaceRoot, 'apps/desktop/release/local')
  );
  const sourceSeed = join(sourceApplication, 'Contents/Resources/product-seed');
  const sourceCli = join(sourceSeed, 'runtime/debrute');
  const debruteHome = join(homedir(), '.debrute');
  const productRoot = join(debruteHome, 'products');
  const binDirectory = join(debruteHome, 'bin');
  const stableCli = join(binDirectory, 'debrute');

  await verifyLocalMacosApplication(sourceApplication, expectedVersion);
  const sourceRuntime = join(
    sourceSeed,
    'runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime'
  );
  const preflight = await execFileAsync(
    sourceRuntime,
    localProductPreflightArguments(sourceSeed, productRoot)
  );
  if (!preflight.stdout.includes(`product_version=${expectedVersion}`)) {
    throw new Error('Runtime Product seed preflight returned an unexpected version.');
  }
  const stopCli = await pathExists(stableCli) ? stableCli : sourceCli;
  await stopInstalledProduct(stopCli);
  await waitForInstalledApplicationExit(installedApplication);
  await replaceInstalledApplication({
    sourceApplication,
    applicationsDirectory,
    verifyApplication: (application) => verifyLocalMacosApplication(application, expectedVersion)
  });

  const installedSeed = join(installedApplication, 'Contents/Resources/product-seed');
  const bootstrapRuntime = join(
    installedSeed,
    'runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime'
  );
  const desktopEntrypoint = join(installedApplication, 'Contents/MacOS/debrute');
  await execFileAsync(bootstrapRuntime, [
    'bootstrap',
    '--seed',
    installedSeed,
    '--product-root',
    productRoot,
    '--bin-directory',
    binDirectory,
    '--desktop-entrypoint',
    desktopEntrypoint,
    '--desktop-arguments-json',
    '[]'
  ]);
  await waitForRuntimeState(stableCli, 'ready');
  await execFileAsync(stableCli, ['models', 'image', 'list']);
  await verifyLocalMacosApplication(installedApplication, expectedVersion);
  await validateProductSeed(join(productRoot, 'versions', expectedVersion));
  console.log(`Installed Debrute ${expectedVersion}: ${installedApplication}`);
  console.log(`Active Product: ${join(productRoot, 'current')}`);
  console.log(`CLI: ${stableCli}`);
  return { application: installedApplication, productVersion: expectedVersion, cli: stableCli };
}

export function localProductPreflightArguments(seed, productRoot) {
  return [
    'preflight-desktop-seed',
    '--seed',
    resolve(seed),
    '--product-root',
    resolve(productRoot)
  ];
}

async function stopInstalledProduct(cli) {
  try {
    await execFileAsync(cli, ['runtime', 'stop']);
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    if (!output.includes('code=runtime_not_running')) {
      throw new Error(`Failed to stop the installed Debrute Product.\n${output.trim()}`);
    }
    return;
  }
  await waitForRuntimeState(cli, 'stopped');
}

async function waitForInstalledApplicationExit(application) {
  const contents = `${resolve(application)}/Contents/`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'command=']);
    if (!stdout.split('\n').some((command) => command.includes(contents))) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for the installed Desktop to exit: ${application}`);
}

async function waitForRuntimeState(cli, expectedState) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await execFileAsync(cli, ['runtime', 'status']).catch((error) => ({
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    }));
    if (`${status.stdout}\n${status.stderr}`.includes(`runtime_state=${expectedState}`)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for the installed Debrute Runtime to become ${expectedState}.`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installLocalMacos().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
