import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildMacosProductInstaller(input) {
  if (process.platform !== 'darwin') {
    throw new Error(`macOS Product Installer requires macOS, received ${process.platform}.`);
  }
  const desktopApp = resolve(input.desktopApp);
  const outputDirectory = resolve(input.outputDirectory ?? join(desktopRoot, 'release'));
  const identity = input.identity?.trim();
  if (!identity) throw new Error('A macOS signing identity is required.');
  if (input.arch !== 'arm64' && input.arch !== 'x64') {
    throw new Error(`Unsupported macOS Product Installer architecture: ${input.arch}`);
  }

  const temporary = await mkdtemp(join(tmpdir(), 'debrute-product-installer-'));
  try {
    const setupApp = join(temporary, 'dmg-root', 'Install Debrute.app');
    const contents = join(setupApp, 'Contents');
    const executable = join(contents, 'MacOS', 'Install Debrute');
    const resources = join(contents, 'Resources');
    await mkdir(dirname(executable), { recursive: true });
    await mkdir(resources, { recursive: true });

    await run('xcrun', [
      'swiftc',
      '-parse-as-library',
      '-O',
      '-target', macosTarget(input.arch),
      '-framework', 'Cocoa',
      join(desktopRoot, 'product-setup/main.swift'),
      '-o', executable
    ]);
    await chmod(executable, 0o755);
    await run('/usr/bin/ditto', [desktopApp, join(resources, 'Debrute.app')]);
    await copyIconIfPresent(desktopApp, resources);
    await writeFile(join(contents, 'Info.plist'), setupInfoPlist(input.version), 'utf8');

    await codesign(setupApp, identity, true);
    await mkdir(outputDirectory, { recursive: true });
    const artifact = join(
      outputDirectory,
      `debrute-installer-${input.version}-macos-${input.arch}.dmg`
    );
    await rm(artifact, { force: true });
    await run('/usr/bin/hdiutil', [
      'create',
      '-volname', 'Debrute',
      '-srcfolder', join(temporary, 'dmg-root'),
      '-format', 'UDZO',
      '-ov', artifact
    ]);
    await codesign(artifact, identity, false);
    return artifact;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function macosTarget(arch) {
  return `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`;
}

async function codesign(path, identity, hardenedRuntime) {
  const arguments = ['--force'];
  if (hardenedRuntime) arguments.push('--options', 'runtime');
  if (identity !== '-') arguments.push('--timestamp');
  arguments.push('--sign', identity, path);
  await run('/usr/bin/codesign', arguments);
  await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path]);
}

async function copyIconIfPresent(desktopApp, resources) {
  const info = await readFile(join(desktopApp, 'Contents/Info.plist'), 'utf8');
  const icon = info.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!icon) return;
  const source = join(desktopApp, 'Contents/Resources', icon.endsWith('.icns') ? icon : `${icon}.icns`);
  await cp(source, join(resources, 'Debrute.icns'));
}

function setupInfoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Install Debrute</string>
  <key>CFBundleExecutable</key><string>Install Debrute</string>
  <key>CFBundleIconFile</key><string>Debrute.icns</string>
  <key>CFBundleIdentifier</key><string>io.github.xiitang.debrute.installer</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Install Debrute</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
`;
}

async function run(command, args) {
  await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const valueAfter = (flag) => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const desktopApp = valueAfter('--desktop-app');
  const version = valueAfter('--version');
  const arch = valueAfter('--arch');
  const identity = valueAfter('--identity') ?? process.env.CSC_NAME;
  if (!desktopApp || !version || !arch || !identity) {
    console.error('--desktop-app, --version, --arch, and --identity (or CSC_NAME) are required');
    process.exit(1);
  }
  buildMacosProductInstaller({
    desktopApp,
    version,
    arch,
    identity,
    outputDirectory: valueAfter('--output-directory')
  }).then((artifact) => console.log(artifact)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
