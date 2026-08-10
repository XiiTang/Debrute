import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildMacosProductInstaller } from './build-macos-product-installer.mjs';

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));

if (process.platform === 'win32') {
  await execFileAsync('pnpm', ['exec', 'electron-builder', '--win', 'nsis', '--x64', '--publish', 'never'], {
    cwd: desktopRoot,
    maxBuffer: 16 * 1024 * 1024
  });
} else if (process.platform === 'darwin') {
  const arch = process.arch;
  const identity = process.env.CSC_NAME?.trim();
  if (!identity || identity === '-') {
    throw new Error('macOS Product Installer distribution requires a Developer ID CSC_NAME.');
  }
  await execFileAsync('pnpm', ['exec', 'electron-builder', '--mac', 'dir', `--${arch}`, '--publish', 'never'], {
    cwd: desktopRoot,
    maxBuffer: 16 * 1024 * 1024
  });
  const outputName = arch === 'arm64' ? 'mac-arm64' : 'mac';
  await buildMacosProductInstaller({
    desktopApp: join(desktopRoot, 'release', outputName, 'Debrute.app'),
    outputDirectory: join(desktopRoot, 'release'),
    version: packageJson.version,
    arch,
    identity
  });
} else {
  throw new Error(`Unsupported Product Installer platform: ${process.platform}`);
}
