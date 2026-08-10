import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANVAS_VIDEO_TOOLS_LOCK,
  FFMPEG_SOURCE_ARCHIVE_NAME,
  FFMPEG_VERSION,
  canRunCanvasVideoTools,
  canvasVideoToolExecutableNames,
  canvasVideoToolsIdentity,
  canvasVideoToolsTarget,
  refreshCanvasVideoToolsPayloadManifest,
  stageCanvasVideoToolsPayload,
  validateCanvasVideoToolsPayload,
  validateCanvasVideoToolsSource
} from './canvas-video-tools-payload.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productVersion = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8')).version;

export async function ensureCanvasVideoToolsPayload({
  identity = canvasVideoToolsIdentity(),
  profile
} = {}) {
  const runExecutables = canRunCanvasVideoTools(identity);
  if (profile) {
    const stagedRoot = join(workspaceRoot, 'target', profile, 'canvas-video-tools');
    try {
      return await validateCanvasVideoToolsPayload({
        root: stagedRoot,
        identity,
        runExecutables
      });
    } catch {
      // The build output is absent or invalid; use or rebuild the disposable cache.
    }
  }
  const payloadRoot = join(workspaceRoot, '.scratch/canvas-video-tools-payloads', identity);
  try {
    const payload = await validateCanvasVideoToolsPayload({
      root: payloadRoot,
      identity,
      runExecutables
    });
    if (profile) await stageCanvasVideoToolsPayload({ profile, root: payloadRoot, identity });
    return payload;
  } catch {
    // The prepared payload is disposable and is rebuilt from the pinned official source.
  }

  const sourceArchive = await ensureSourceArchive();
  const buildRoot = join(workspaceRoot, '.scratch/canvas-video-tools-build', identity);
  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await run('tar', ['-xf', sourceArchive, '-C', buildRoot]);
  const sourceRoot = join(buildRoot, `ffmpeg-${FFMPEG_VERSION}`);
  const target = canvasVideoToolsTarget(identity);
  const executableNames = canvasVideoToolExecutableNames(identity);
  const configureArguments = [
    ...CANVAS_VIDEO_TOOLS_LOCK.configureArguments,
    ...targetConfigureArguments(identity)
  ];
  if (process.platform === 'win32') {
    await run('bash', ['./configure', ...configureArguments], { cwd: sourceRoot });
  } else {
    await run('./configure', configureArguments, { cwd: sourceRoot });
  }
  await run('make', [
    '-j',
    String(Math.max(1, Number(process.env.NUMBER_OF_PROCESSORS) || 4)),
    ...executableNames
  ], {
    cwd: sourceRoot
  });

  await rm(payloadRoot, { recursive: true, force: true });
  await mkdir(payloadRoot, { recursive: true });
  for (const executable of executableNames) {
    const sourceName = target.platform === 'windows' ? executable : executable.replace(/\.exe$/, '');
    const destination = join(payloadRoot, executable);
    await cp(join(sourceRoot, sourceName), destination, { dereference: true });
    if (target.platform !== 'windows') await chmod(destination, 0o755);
  }
  await cp(join(sourceRoot, 'COPYING.LGPLv2.1'), join(payloadRoot, 'LICENSE'));
  await writeFile(join(payloadRoot, 'THIRD-PARTY-NOTICES.md'), [
    '# Third-Party Notices',
    '',
    `This payload contains FFmpeg ${FFMPEG_VERSION}, licensed under LGPL-2.1-or-later.`,
    'Debrute invokes the independent ffmpeg and ffprobe executables and does not link their libraries.',
    ''
  ].join('\n'));
  await writeFile(join(payloadRoot, 'SOURCE.md'), [
    '# FFmpeg Source',
    '',
    `- Version: ${FFMPEG_VERSION}`,
    `- Debrute release source: https://github.com/xiitang/debrute/releases/download/v${productVersion}/${FFMPEG_SOURCE_ARCHIVE_NAME}`,
    `- Upstream source: ${CANVAS_VIDEO_TOOLS_LOCK.source.url}`,
    `- SHA-256: ${CANVAS_VIDEO_TOOLS_LOCK.source.sha256}`,
    `- Signature: ${CANVAS_VIDEO_TOOLS_LOCK.source.signatureUrl}`,
    `- Signing key: ${CANVAS_VIDEO_TOOLS_LOCK.source.signingKeyFingerprint}`,
    ''
  ].join('\n'));
  await writeFile(join(payloadRoot, 'BUILD-CONFIG.txt'), [
    `identity=${identity}`,
    `ffmpegVersion=${FFMPEG_VERSION}`,
    `configure=${configureArguments.join(' ')}`,
    ''
  ].join('\n'));
  await writeFile(join(payloadRoot, 'versions.json'), '{}\n');
  const payload = await refreshCanvasVideoToolsPayloadManifest({ root: payloadRoot, identity });
  if (profile) await stageCanvasVideoToolsPayload({ profile, root: payloadRoot, identity });
  console.log(`Canvas video tools payload is ready: ${payloadRoot}`);
  return payload;
}

async function ensureSourceArchive() {
  const directory = join(workspaceRoot, '.scratch/canvas-video-tools-downloads');
  const archive = join(directory, FFMPEG_SOURCE_ARCHIVE_NAME);
  await mkdir(directory, { recursive: true });
  await ensureDownloadedFile(
    archive,
    CANVAS_VIDEO_TOOLS_LOCK.source.url,
    CANVAS_VIDEO_TOOLS_LOCK.source.sha256,
    validateCanvasVideoToolsSource
  );
  const signature = join(directory, `ffmpeg-${FFMPEG_VERSION}.tar.xz.asc`);
  await ensureDownloadedFile(
    signature,
    CANVAS_VIDEO_TOOLS_LOCK.source.signatureUrl,
    CANVAS_VIDEO_TOOLS_LOCK.source.signatureSha256
  );
  const signingKey = join(directory, 'ffmpeg-devel.asc');
  await ensureDownloadedFile(
    signingKey,
    CANVAS_VIDEO_TOOLS_LOCK.source.signingKeyUrl,
    CANVAS_VIDEO_TOOLS_LOCK.source.signingKeySha256
  );
  await verifySourceSignature({ archive, signature, signingKey });
  return archive;
}

async function ensureDownloadedFile(path, url, expectedSha256, validate) {
  let bytes = await readFile(path).catch(() => undefined);
  if (!bytes || sha256(bytes) !== expectedSha256) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`FFmpeg source input download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== expectedSha256) {
      throw new Error(`FFmpeg source input checksum does not match the lock: ${url}`);
    }
    await writeFile(path, bytes);
  }
  validate?.(bytes);
}

async function verifySourceSignature({ archive, signature, signingKey }) {
  const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const home = await mkdtemp(join(temporaryRoot, 'debrute-canvas-video-gpg-'));
  await chmod(home, 0o700);
  try {
    await runCaptured('gpg', [
      '--batch',
      '--no-autostart',
      '--homedir',
      home,
      '--import',
      signingKey
    ]);
    const verified = await runCaptured('gpg', [
      '--batch',
      '--no-autostart',
      '--homedir',
      home,
      '--status-fd=1',
      '--verify',
      signature,
      archive
    ]);
    const expected = `[GNUPG:] VALIDSIG ${CANVAS_VIDEO_TOOLS_LOCK.source.signingKeyFingerprint} `;
    if (!verified.stdout.includes(expected)) {
      throw new Error('FFmpeg source signature does not match the pinned signing key.');
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function targetConfigureArguments(identity) {
  if (identity === 'macos-arm64') return ['--arch=arm64', '--cc=clang'];
  if (identity === 'macos-x64') return ['--arch=x86_64', '--cc=clang'];
  if (identity === 'windows-x64') {
    if (process.platform === 'win32') {
      return ['--target-os=mingw32', '--arch=x86_64', '--disable-x86asm'];
    }
    return [
      '--target-os=mingw32',
      '--arch=x86_64',
      '--cross-prefix=x86_64-w64-mingw32-',
      '--disable-x86asm'
    ];
  }
  throw new Error(`Canvas video tools target is unsupported: ${identity}`);
}

async function run(command, arguments_, { cwd = workspaceRoot } = {}) {
  const child = spawn(command, arguments_, { cwd, stdio: 'inherit' });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`${command} failed with code ${exitCode ?? 'unknown'}.`);
  }
}

async function runCaptured(command, arguments_, { cwd = workspaceRoot } = {}) {
  const child = spawn(command, arguments_, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  const result = {
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8')
  };
  if (exitCode !== 0) {
    throw new Error(
      `${command} failed with code ${exitCode ?? 'unknown'}: ${result.stderr.trim()}`
    );
  }
  return result;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  await ensureCanvasVideoToolsPayload({
    identity: argumentValue('--identity') ?? canvasVideoToolsIdentity(),
    profile: argumentValue('--profile')
  });
}
