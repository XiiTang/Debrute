import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  refreshProductSeedManifest,
  validateProductSeed
} from '../../../scripts/assemble-product-seed.mjs';
import {
  findLocalMacosApplication,
  verifyLocalMacosApplication
} from '../../../scripts/local-macos-application.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seed = join(desktopRoot, 'dist-electron/product-seed');
const output = join(desktopRoot, 'release/local');

export function localElectronBuilderArguments(architecture) {
  if (architecture !== 'arm64' && architecture !== 'x64') {
    throw new Error(`Unsupported local macOS architecture: ${architecture}`);
  }
  return [
    '--dir',
    '--mac',
    `--${architecture}`,
    '--publish',
    'never',
    '--config.directories.output=release/local',
    '--config.mac.identity=-',
    '--config.afterSign=scripts/verify-local-macos-app.cjs'
  ];
}

export async function packageLocalMacos() {
  if (process.platform !== 'darwin') {
    throw new Error(`Local Desktop installation requires macOS, received ${process.platform}.`);
  }
  const manifest = await validateProductSeed(seed);
  if (manifest.platform !== 'macos' || manifest.architecture !== process.arch) {
    throw new Error('Product seed does not match the local macOS host.');
  }

  const runtimeApplication = join(seed, 'runtime/Debrute Runtime.app');
  const productCodePaths = [
    join(runtimeApplication, 'Contents/libvips/libvips.42.dylib'),
    join(runtimeApplication, 'Contents/MacOS/debrute-runtime'),
    join(seed, 'runtime/debrute')
  ];
  for (const path of productCodePaths) {
    await run('/usr/bin/codesign', ['--force', '--sign', '-', path]);
    await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path]);
  }
  await run('/usr/bin/codesign', ['--force', '--sign', '-', runtimeApplication]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', runtimeApplication]);
  await refreshProductSeedManifest(seed);
  await validateProductSeed(seed);

  await rm(output, { recursive: true, force: true });
  await run('pnpm', ['exec', 'electron-builder', ...localElectronBuilderArguments(process.arch)], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false'
    }
  });

  const packagedApplication = await findLocalMacosApplication(output);
  const application = join(dirname(packagedApplication), 'Debrute.app');
  if (packagedApplication !== application) {
    await rename(packagedApplication, application);
  }
  await verifyLocalMacosApplication(application, manifest.productVersion);
  console.log(`Packaged local application: ${application}`);
  return application;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit'
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit ${code}`}.`));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageLocalMacos().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
