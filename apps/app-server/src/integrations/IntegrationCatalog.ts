import type {
  IntegrationBackendId,
  IntegrationBinaryId,
  IntegrationId,
  SystemPackageManagerId
} from '@debrute/app-protocol';

export type {
  IntegrationBackendId,
  IntegrationBackendStatus,
  IntegrationBinaryId,
  IntegrationBinaryStatus,
  IntegrationBinaryStatusKind,
  IntegrationId,
  IntegrationInstallBackendKind,
  IntegrationOperationDiagnostic,
  IntegrationOperationStatus,
  IntegrationProbeErrorKind,
  IntegrationSettingsView,
  IntegrationStatus,
  IntegrationStatusKind,
  PythonCliInstallerId,
  SystemPackageManagerId
} from '@debrute/app-protocol';

const INTEGRATION_PROBE_TIMEOUT_MS = 10_000;

export interface SystemPackageDefinition {
  packageName: string;
}

export interface IntegrationCommand {
  backend: IntegrationBackendId;
  file: string;
  args: string[];
  preview: string;
}

export interface IntegrationCatalogBinary {
  id: IntegrationBinaryId;
  displayName: string;
  names: string[];
  probe: {
    args: string[];
    timeoutMs: number;
  };
  versionParser: 'ffmpeg' | 'imagemagick' | 'mediainfo' | 'exiftool' | 'remove-ai-watermarks';
}

interface IntegrationCatalogBase {
  id: IntegrationId;
  displayName: string;
  description: string;
  category: 'media' | 'image-cleanup';
  binaries: IntegrationCatalogBinary[];
}

export interface SystemPackageIntegrationCatalogItem extends IntegrationCatalogBase {
  backend: 'system-package-manager';
  packages: Record<SystemPackageManagerId, SystemPackageDefinition>;
}

export interface PythonCliIntegrationCatalogItem extends IntegrationCatalogBase {
  backend: 'python-cli-installer';
  pythonCli: {
    packageName: string;
    repository: string;
  };
}

export type IntegrationCatalogItem = SystemPackageIntegrationCatalogItem | PythonCliIntegrationCatalogItem;

export const INTEGRATION_CATALOG: IntegrationCatalogItem[] = [
  {
    id: 'ffmpeg',
    displayName: 'FFmpeg',
    description: 'Video and audio processing toolkit.',
    category: 'media',
    backend: 'system-package-manager',
    binaries: [
      {
        id: 'ffmpeg',
        displayName: 'ffmpeg',
        names: ['ffmpeg'],
        probe: { args: ['-version'], timeoutMs: INTEGRATION_PROBE_TIMEOUT_MS },
        versionParser: 'ffmpeg'
      },
      {
        id: 'ffprobe',
        displayName: 'ffprobe',
        names: ['ffprobe'],
        probe: { args: ['-version'], timeoutMs: INTEGRATION_PROBE_TIMEOUT_MS },
        versionParser: 'ffmpeg'
      }
    ],
    packages: {
      brew: { packageName: 'ffmpeg' },
      winget: { packageName: 'Gyan.FFmpeg' },
      apt: { packageName: 'ffmpeg' }
    }
  },
  {
    id: 'imagemagick',
    displayName: 'ImageMagick',
    description: 'Image conversion, composition, and filtering toolkit.',
    category: 'media',
    backend: 'system-package-manager',
    binaries: [
      {
        id: 'magick',
        displayName: 'magick',
        names: ['magick'],
        probe: { args: ['-version'], timeoutMs: INTEGRATION_PROBE_TIMEOUT_MS },
        versionParser: 'imagemagick'
      }
    ],
    packages: {
      brew: { packageName: 'imagemagick' },
      winget: { packageName: 'ImageMagick.ImageMagick' },
      apt: { packageName: 'imagemagick' }
    }
  },
  {
    id: 'mediainfo',
    displayName: 'MediaInfo',
    description: 'Media container and stream information reader.',
    category: 'media',
    backend: 'system-package-manager',
    binaries: [
      {
        id: 'mediainfo',
        displayName: 'mediainfo',
        names: ['mediainfo'],
        probe: { args: ['--Version'], timeoutMs: INTEGRATION_PROBE_TIMEOUT_MS },
        versionParser: 'mediainfo'
      }
    ],
    packages: {
      brew: { packageName: 'media-info' },
      winget: { packageName: 'MediaArea.MediaInfo' },
      apt: { packageName: 'mediainfo' }
    }
  },
  {
    id: 'exiftool',
    displayName: 'ExifTool',
    description: 'Image, audio, and video metadata reader and writer.',
    category: 'media',
    backend: 'system-package-manager',
    binaries: [
      {
        id: 'exiftool',
        displayName: 'exiftool',
        names: ['exiftool'],
        probe: { args: ['-ver'], timeoutMs: INTEGRATION_PROBE_TIMEOUT_MS },
        versionParser: 'exiftool'
      }
    ],
    packages: {
      brew: { packageName: 'exiftool' },
      winget: { packageName: 'OliverBetz.ExifTool' },
      apt: { packageName: 'libimage-exiftool-perl' }
    }
  },
  {
    id: 'remove-ai-watermarks',
    displayName: 'Remove AI Watermarks',
    description: 'Visible AI watermark removal and AI metadata cleanup CLI.',
    category: 'image-cleanup',
    backend: 'python-cli-installer',
    binaries: [
      {
        id: 'remove-ai-watermarks',
        displayName: 'remove-ai-watermarks',
        names: ['remove-ai-watermarks'],
        probe: { args: ['--version'], timeoutMs: INTEGRATION_PROBE_TIMEOUT_MS },
        versionParser: 'remove-ai-watermarks'
      }
    ],
    pythonCli: {
      packageName: 'remove-ai-watermarks',
      repository: 'git+https://github.com/wiltodelta/remove-ai-watermarks.git'
    }
  }
];
