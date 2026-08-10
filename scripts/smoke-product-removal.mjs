import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { runManagedCli } from './run-managed-cli.mjs';

const execFileAsync = promisify(execFile);
const WINDOWS_INSTALLER_GUID = '708c37b7-2547-5a47-9bfa-42bb13156a66';
const options = parseArguments(process.argv.slice(2));
const home = homedir();
const debruteHome = join(home, '.debrute');
const skills = join(home, '.agents', 'skills');

await requirePath(options.cli, 'managed CLI');
await requirePath(options.desktop, 'installed Desktop');
await requirePath(join(skills, 'debrute-core', 'SKILL.md'), 'official Skill');
const unrelatedSkill = await mkdtemp(join(skills, 'unrelated-product-removal-smoke-'));

try {
  await writeFile(join(unrelatedSkill, 'SKILL.md'), 'unrelated smoke fixture\n');
  const result = await runManagedCli(resolve(options.cli), ['product', 'uninstall', '--yes'], {
    platform: options.platform,
    timeoutMs: 30_000,
    label: 'Product removal CLI'
  });
  if (result.code !== 0
    || !result.output.includes('accepted=true')
    || !result.output.includes('configPreserved=false')) {
    throw new Error(`Product removal was not accepted with the default retention policy:\n${result.output}`);
  }

  await waitForAbsence([options.desktopRoot, debruteHome], 130_000);
  await waitForNoMatchingEntries(
    home,
    /^\.debrute-removal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    130_000,
    'home-level Product removal transactions'
  );
  await assertOfficialSkillsRemoved();
  await requirePath(join(unrelatedSkill, 'SKILL.md'), 'unrelated Skill after Product removal');
  if (options.platform === 'darwin') {
    await waitForNoMatchingEntries(
      tmpdir(),
      /^debrute-removal-runtime-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      130_000,
      'macOS Runtime removal capsules'
    );
    await assertMacosCommandProjectionRemoved();
  } else {
    await assertWindowsOwnedSurfacesRemoved();
  }
} finally {
  await rm(unrelatedSkill, { recursive: true, force: true });
}

async function assertOfficialSkillsRemoved() {
  const entries = await readdir(skills);
  const residue = entries.filter((name) => (
    name.startsWith('debrute-')
    || /^\.debrute-projection-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)
  ));
  if (residue.length > 0) {
    throw new Error(`Product removal left owned Skill entries: ${residue.join(', ')}`);
  }
}

async function assertMacosCommandProjectionRemoved() {
  const shellFiles = [
    '.zprofile',
    '.zshrc',
    '.bash_profile',
    '.bash_login',
    '.profile',
    '.bashrc',
    '.config/fish/config.fish'
  ];
  for (const relativePath of shellFiles) {
    const path = join(home, relativePath);
    const contents = await readOptional(path);
    if (contents?.includes('Debrute managed PATH')) {
      throw new Error(`Product removal left a managed PATH block in ${path}.`);
    }
  }
  const parents = new Set(shellFiles.map((path) => join(home, path, '..')));
  for (const parent of parents) {
    const entries = await readdirOptional(parent);
    const residue = entries.filter((name) => (
      /^\.debrute-shell-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)
    ));
    if (residue.length > 0) {
      throw new Error(`Product removal left shell transactions in ${parent}: ${residue.join(', ')}`);
    }
  }
  await assertAbsent(join(home, 'Library', 'LaunchAgents', 'com.debrute.runtime.plist'));
}

async function assertWindowsOwnedSurfacesRemoved() {
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  if (!localAppData || !appData) {
    throw new Error('Windows Product removal smoke requires LOCALAPPDATA and APPDATA.');
  }
  await assertAbsent(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Debrute.lnk'));
  await assertAbsent(join(localAppData, '@debrutedesktop-updater'));
  for (const key of [
    `HKCU\\Software\\${WINDOWS_INSTALLER_GUID}`,
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${WINDOWS_INSTALLER_GUID}`
  ]) {
    const result = await execFileResult('reg.exe', ['query', key]);
    if (result.code === 0) {
      throw new Error(`Product removal left Windows registration ${key}.`);
    }
  }
  const loginItem = await execFileResult('reg.exe', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '/v',
    'Debrute Runtime'
  ]);
  if (loginItem.code === 0) {
    throw new Error('Product removal left the Debrute Runtime login item.');
  }
  const userPath = await execFileResult('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path']);
  const managedBin = join(home, '.debrute', 'bin').replaceAll('/', '\\').toLowerCase();
  if (userPath.output.replaceAll('/', '\\').toLowerCase().includes(managedBin)) {
    throw new Error('Product removal left the managed CLI directory in Windows User PATH.');
  }
}

async function waitForAbsence(paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await Promise.all(paths.map(exists))).every((present) => !present)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  const residue = [];
  for (const path of paths) {
    if (await exists(path)) residue.push(path);
  }
  throw new Error(`Product removal timed out with owned paths remaining: ${residue.join(', ')}`);
}

async function waitForNoMatchingEntries(parent, pattern, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const residue = (await readdirOptional(parent)).filter((name) => pattern.test(name));
    if (residue.length === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  const residue = (await readdirOptional(parent)).filter((name) => pattern.test(name));
  throw new Error(`Product removal timed out with ${label} remaining: ${residue.join(', ')}`);
}

async function execFileResult(command, arguments_) {
  try {
    const { stdout, stderr } = await execFileAsync(command, arguments_, {
      timeout: 15_000,
      windowsHide: true
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && Number.isInteger(error.code)) {
      return {
        code: error.code,
        output: `${'stdout' in error ? error.stdout ?? '' : ''}${'stderr' in error ? error.stderr ?? '' : ''}`
      };
    }
    throw error;
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readdirOptional(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function requirePath(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`Product removal smoke is missing ${label}: ${path}`);
  }
}

async function assertAbsent(path) {
  if (await exists(path)) throw new Error(`Product removal left owned path: ${path}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseArguments(arguments_) {
  const valueAfter = (flag) => {
    const index = arguments_.indexOf(flag);
    return index >= 0 ? arguments_[index + 1] : undefined;
  };
  const platform = valueAfter('--platform');
  const cli = valueAfter('--cli');
  const desktop = valueAfter('--desktop');
  const desktopRoot = valueAfter('--desktop-root');
  if (!['darwin', 'win32'].includes(platform) || !cli || !desktop || !desktopRoot) {
    throw new Error('--platform, --cli, --desktop, and --desktop-root are required.');
  }
  return { platform, cli, desktop, desktopRoot };
}
