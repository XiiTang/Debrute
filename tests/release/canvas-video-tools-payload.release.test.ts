import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANVAS_VIDEO_TOOLS_LOCK,
  FFMPEG_SOURCE_ARCHIVE_NAME,
  refreshCanvasVideoToolsPayloadManifest,
  validateCanvasVideoToolsLock,
  validateCanvasVideoToolsPayload,
  validateCanvasVideoToolsSource
} from '../../scripts/canvas-video-tools-payload.mjs';

describe('Canvas video tools payload', () => {
  it('pins one official LGPL-only FFmpeg source contract for every Product target', () => {
    expect(validateCanvasVideoToolsLock()).toEqual(CANVAS_VIDEO_TOOLS_LOCK);
    expect(Object.keys(CANVAS_VIDEO_TOOLS_LOCK.targets).sort()).toEqual([
      'macos-arm64',
      'macos-x64',
      'windows-x64'
    ]);
    expect(CANVAS_VIDEO_TOOLS_LOCK.configureArguments).toContain('--disable-autodetect');
    expect(CANVAS_VIDEO_TOOLS_LOCK.configureArguments).toContain('--disable-network');
    expect(CANVAS_VIDEO_TOOLS_LOCK.configureArguments).not.toContain('--enable-gpl');
    expect(CANVAS_VIDEO_TOOLS_LOCK.configureArguments).not.toContain('--enable-nonfree');
    expect(CANVAS_VIDEO_TOOLS_LOCK.configureArguments).toEqual(expect.arrayContaining([
      '--disable-encoders',
      '--enable-encoder=mjpeg',
      '--disable-muxers',
      '--enable-muxer=image2',
      '--disable-filters',
      '--enable-filter=scale',
      '--disable-protocols',
      '--enable-protocol=file'
    ]));
    expect(FFMPEG_SOURCE_ARCHIVE_NAME).toBe(
      `ffmpeg-${CANVAS_VIDEO_TOOLS_LOCK.ffmpegVersion}.tar.xz`
    );
  });

  it('rejects source bytes outside the pinned checksum', () => {
    expect(() => validateCanvasVideoToolsSource(Buffer.from('wrong source')))
      .toThrow('FFmpeg source checksum does not match');
  });

  it('defines the native Windows source-build prerequisites and Bash configure path', () => {
    const prepareSource = readFileSync(
      join(process.cwd(), 'scripts/prepare-canvas-video-tools.mjs'),
      'utf8'
    );
    const doctorSource = readFileSync(join(process.cwd(), 'scripts/doctor.mjs'), 'utf8');

    expect(prepareSource).toContain("process.platform === 'win32'");
    expect(prepareSource).toContain("await run('bash', ['./configure', ...configureArguments]");
    expect(doctorSource).toContain("for (const command of ['bash', 'awk', 'sed'])");
    expect(doctorSource).toContain("output === 'x86_64-w64-mingw32'");
  });

  it('validates a closed target payload and rejects undeclared baggage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-canvas-video-tools-'));
    try {
      writePayloadFixture(root);
      await expect(validateCanvasVideoToolsPayload({
        root,
        identity: 'macos-arm64',
        runExecutables: false
      })).resolves.toMatchObject({ root });

      const manifestPath = join(root, 'versions.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.unexpected = true;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(validateCanvasVideoToolsPayload({
        root,
        identity: 'macos-arm64',
        runExecutables: false
      })).rejects.toThrow('payload identity is invalid');
      delete manifest.unexpected;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      writeFileSync(join(root, 'ffmpeg'), 'signed-ffmpeg');
      await expect(validateCanvasVideoToolsPayload({
        root,
        identity: 'macos-arm64',
        runExecutables: false
      })).rejects.toThrow(/payload file (size|checksum) is invalid/);
      await refreshCanvasVideoToolsPayloadManifest({
        root,
        identity: 'macos-arm64',
        runExecutables: false
      });
      await expect(validateCanvasVideoToolsPayload({
        root,
        identity: 'macos-arm64',
        runExecutables: false
      })).resolves.toMatchObject({ root });

      writeFileSync(join(root, 'unexpected'), 'baggage');
      await expect(validateCanvasVideoToolsPayload({
        root,
        identity: 'macos-arm64',
        runExecutables: false
      })).rejects.toThrow('contains undeclared files');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writePayloadFixture(root: string): void {
  mkdirSync(root, { recursive: true });
  const contents = new Map([
    ['ffmpeg', 'ffmpeg'],
    ['ffprobe', 'ffprobe'],
    ['LICENSE', 'license'],
    ['THIRD-PARTY-NOTICES.md', 'notices'],
    ['SOURCE.md', 'source'],
    ['BUILD-CONFIG.txt', 'config']
  ]);
  for (const [name, content] of contents) writeFileSync(join(root, name), content);
  const files = [...contents.keys()].sort().map((path) => {
    const bytes = readFileSync(join(root, path));
    return {
      path,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    };
  });
  writeFileSync(join(root, 'versions.json'), `${JSON.stringify({
    schemaVersion: 1,
    payloadRevision: CANVAS_VIDEO_TOOLS_LOCK.payloadRevision,
    ffmpegVersion: CANVAS_VIDEO_TOOLS_LOCK.ffmpegVersion,
    platform: 'macos',
    architecture: 'arm64',
    sourceSha256: CANVAS_VIDEO_TOOLS_LOCK.source.sha256,
    configureArguments: CANVAS_VIDEO_TOOLS_LOCK.configureArguments,
    files
  }, null, 2)}\n`);
}
