import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_CATALOG,
  type IntegrationId
} from '../apps/app-server/src/integrations/IntegrationCatalog';

describe('integration catalog', () => {
  it('defines the supported optional integrations', () => {
    expect(INTEGRATION_CATALOG.map((integration) => integration.id)).toEqual([
      'ffmpeg',
      'imagemagick',
      'mediainfo',
      'exiftool',
      'remove-ai-watermarks'
    ]);
  });

  it('defines required binaries and probe arguments', () => {
    const probes = Object.fromEntries(INTEGRATION_CATALOG.map((integration) => [
      integration.id,
      integration.binaries.map((binary) => ({
        id: binary.id,
        names: binary.names,
        args: binary.probe.args
      }))
    ]));

    expect(probes.ffmpeg).toEqual([
      { id: 'ffmpeg', names: ['ffmpeg'], args: ['-version'] },
      { id: 'ffprobe', names: ['ffprobe'], args: ['-version'] }
    ]);
    expect(probes.imagemagick).toEqual([
      { id: 'magick', names: ['magick'], args: ['-version'] }
    ]);
    expect(probes.mediainfo).toEqual([
      { id: 'mediainfo', names: ['mediainfo'], args: ['--Version'] }
    ]);
    expect(probes.exiftool).toEqual([
      { id: 'exiftool', names: ['exiftool'], args: ['-ver'] }
    ]);
    expect(probes['remove-ai-watermarks']).toEqual([
      { id: 'remove-ai-watermarks', names: ['remove-ai-watermarks'], args: ['--version'] }
    ]);
  });

  it('defines backend metadata for media integrations and remove-ai-watermarks', () => {
    const entries = Object.fromEntries(INTEGRATION_CATALOG.map((integration) => [integration.id, integration]));

    expect(entries.ffmpeg?.backend).toBe('system-package-manager');
    expect(entries.ffmpeg && 'packages' in entries.ffmpeg ? entries.ffmpeg.packages : undefined).toEqual({
      brew: { packageName: 'ffmpeg' },
      winget: { packageName: 'Gyan.FFmpeg' }
    });
    expect(entries['remove-ai-watermarks']?.backend).toBe('python-cli-installer');
    expect(entries['remove-ai-watermarks'] && 'pythonCli' in entries['remove-ai-watermarks']
      ? entries['remove-ai-watermarks'].pythonCli
      : undefined).toEqual({
      packageName: 'remove-ai-watermarks',
      repository: 'git+https://github.com/wiltodelta/remove-ai-watermarks.git'
    });
  });

  it('uses stable integration id typing', () => {
    const ids: IntegrationId[] = INTEGRATION_CATALOG.map((integration) => integration.id);

    expect(ids).toEqual([
      'ffmpeg',
      'imagemagick',
      'mediainfo',
      'exiftool',
      'remove-ai-watermarks'
    ]);
  });
});
