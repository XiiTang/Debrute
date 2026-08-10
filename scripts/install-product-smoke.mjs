import { execFile } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function installProductForSmoke(input) {
  if (input.platform === 'darwin') {
    const installer = resolve(input.installer);
    const mount = await mkdtemp(join(tmpdir(), 'debrute-product-smoke-'));
    let attached = false;
    try {
      await exec('/usr/bin/hdiutil', [
        'attach', installer, '-nobrowse', '-readonly', '-mountpoint', mount
      ]);
      attached = true;
      const setup = join(mount, 'Install Debrute.app');
      const desktopSource = join(setup, 'Contents', 'Resources', 'Debrute.app');
      await requireRealDirectory(setup);
      await requireRealDirectory(desktopSource);
      await exec(join(setup, 'Contents', 'MacOS', 'Install Debrute'), [
        '--install-noninteractive'
      ]);
    } finally {
      if (attached) await exec('/usr/bin/hdiutil', ['detach', mount]);
      await rm(mount, { recursive: true, force: true });
    }
    return;
  }
  if (input.platform === 'win32') {
    await exec(resolve(input.installer), ['/S']);
    return;
  }
  throw new Error(`Unsupported Product smoke platform: ${input.platform}`);
}

async function requireRealDirectory(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Product Installer entry is not a real directory: ${path}`);
  }
}

async function exec(command, arguments_) {
  await execFileAsync(command, arguments_, {
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
}

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installProductForSmoke({
    platform: valueAfter('--platform'),
    installer: valueAfter('--installer')
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
