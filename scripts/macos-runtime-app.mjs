import { chmod, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const MACOS_RUNTIME_APP_NAME = 'Debrute Runtime.app';
export const MACOS_RUNTIME_EXECUTABLE = 'Contents/MacOS/debrute-runtime';

export async function assembleMacosRuntimeApplication(input) {
  const destination = resolve(input.destination);
  const contents = join(destination, 'Contents');
  const executable = join(contents, 'MacOS/debrute-runtime');
  const nativeRasterFiles = await readdir(input.nativeRasterRoot, { withFileTypes: true });
  if (nativeRasterFiles.some((entry) => !entry.isFile())) {
    throw new Error(`macOS Runtime native raster payload must be flat: ${input.nativeRasterRoot}`);
  }
  if (!nativeRasterFiles.some((entry) => entry.name.endsWith('.dylib'))) {
    throw new Error(`macOS Runtime app has no libvips dynamic library: ${input.nativeRasterRoot}`);
  }

  await rm(destination, { recursive: true, force: true });
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(join(contents, 'Resources'), { recursive: true });
  await mkdir(join(contents, 'libvips'), { recursive: true });
  await cp(input.runtimeBinary, executable, { dereference: true });
  await cp(input.icon, join(contents, 'Resources/DebruteRuntime.icns'), { dereference: true });
  for (const entry of nativeRasterFiles) {
    await cp(
      join(input.nativeRasterRoot, entry.name),
      join(contents, 'libvips', entry.name),
      { dereference: true }
    );
  }
  await writeFile(join(contents, 'Info.plist'), macosRuntimeInfoPlist(input.version), 'utf8');
  await chmod(executable, 0o755);
  return { destination, executable };
}

function macosRuntimeInfoPlist(version) {
  const escapedVersion = xmlEscape(version);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Debrute Runtime</string>
  <key>CFBundleExecutable</key>
  <string>debrute-runtime</string>
  <key>CFBundleIconFile</key>
  <string>DebruteRuntime.icns</string>
  <key>CFBundleIdentifier</key>
  <string>io.github.xiitang.debrute.runtime</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Debrute Runtime</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapedVersion}</string>
  <key>CFBundleVersion</key>
  <string>${escapedVersion}</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
