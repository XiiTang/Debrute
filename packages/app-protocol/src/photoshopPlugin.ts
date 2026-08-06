export const PHOTOSHOP_WEBSOCKET_SUBPROTOCOL = 'debrute.photoshop.v1';
export const PHOTOSHOP_PORTS = [32124, 32125, 32126, 32127, 32128, 32129, 32130, 32131] as const;
export const PHOTOSHOP_MAX_FILE_BYTES = 268_435_456;
export const PHOTOSHOP_MAX_BATCH_BYTES = 1_073_741_824;
export const PHOTOSHOP_MAX_BATCH_ITEMS = 50;

export const photoshopErrorCodes = [
  'photoshop_unavailable',
  'photoshop_session_invalid',
  'photoshop_busy',
  'photoshop_document_closed',
  'project_offline',
  'project_revision_changed',
  'target_directory_missing',
  'target_directory_not_visible',
  'unsupported_file_type',
  'file_too_large',
  'invalid_transfer_payload',
  'photoshop_place_failed',
  'photoshop_export_failed',
  'photoshop_protocol_invalid'
] as const;

export type PhotoshopErrorCode = typeof photoshopErrorCodes[number];

interface PhotoshopHttpErrorEnvelope {
  error: {
    code: PhotoshopErrorCode;
    message: string;
  };
}

export function isPhotoshopErrorCode(value: unknown): value is PhotoshopErrorCode {
  return typeof value === 'string'
    && (photoshopErrorCodes as readonly string[]).includes(value);
}

export function decodePhotoshopHttpErrorEnvelope(
  value: unknown
): PhotoshopHttpErrorEnvelope | undefined {
  if (!isRecord(value)
    || !exactKeys(value, ['error'])
    || !isRecord(value.error)
    || !exactKeys(value.error, ['code', 'message'])
    || !isPhotoshopErrorCode(value.error.code)
    || typeof value.error.message !== 'string'
    || value.error.message.trim().length === 0) {
    return undefined;
  }
  return value as unknown as PhotoshopHttpErrorEnvelope;
}

export const photoshopMimeTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/vnd.adobe.photoshop',
  'image/avif'
] as const;

export type PhotoshopMimeType = typeof photoshopMimeTypes[number];

export type PhotoshopPlacementRequirement = 'photoshop_26_8_for_avif';

export interface PhotoshopPlacementFormat {
  mimeType: PhotoshopMimeType;
  requirement?: PhotoshopPlacementRequirement;
}

const PHOTOSHOP_PLACEMENT_FORMATS_BY_EXTENSION: Readonly<Record<string, PhotoshopPlacementFormat>> = {
  png: { mimeType: 'image/png' },
  jpg: { mimeType: 'image/jpeg' },
  jpeg: { mimeType: 'image/jpeg' },
  webp: { mimeType: 'image/webp' },
  psd: { mimeType: 'image/vnd.adobe.photoshop' },
  avif: {
    mimeType: 'image/avif',
    requirement: 'photoshop_26_8_for_avif'
  }
};

export const PHOTOSHOP_BASELINE_PLACEMENT_MIME_TYPES: readonly PhotoshopMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/vnd.adobe.photoshop'
];

export function photoshopPlacementFormatForPath(path: string): PhotoshopPlacementFormat | undefined {
  const extension = path.split('.').pop()?.toLowerCase();
  return extension === undefined ? undefined : PHOTOSHOP_PLACEMENT_FORMATS_BY_EXTENSION[extension];
}

export interface PhotoshopDocumentSnapshot {
  documentId: number;
  title: string;
}

export interface PhotoshopProjectSnapshot {
  canonicalRoot: string;
  name: string;
  revision: number;
}

export type PluginMessage =
  | {
      type: 'photoshop.session.start';
      hostVersion: string;
      placementMimeTypes: PhotoshopMimeType[];
      documents: PhotoshopDocumentSnapshot[];
    }
  | {
      type: 'photoshop.documents.snapshot';
      documents: PhotoshopDocumentSnapshot[];
    }
  | {
      type: 'photoshop.projectDirectories.request';
      requestId: string;
      canonicalRoot: string;
      revision: number;
    }
  | {
      type: 'photoshop.export.start';
      commandId: string;
      canonicalRoot: string;
      projectRevision: number;
      directory: string;
      items: Array<{ itemId: string; sourceName: string }>;
    }
  | {
      type: 'photoshop.export.finish';
      commandId: string;
      items: Array<{
        itemId: string;
        ok: boolean;
        fileName?: string;
        errorCode?: string;
        message?: string;
      }>;
    }
  | {
      type: 'photoshop.place.result';
      commandId: string;
      ok: boolean;
      errorCode?: string;
      message?: string;
    };

export type RuntimeMessage =
  | {
      type: 'photoshop.session.ready';
      runtimeInstanceId: string;
      pluginSessionId: string;
      bearer: string;
    }
  | {
      type: 'photoshop.projects.snapshot';
      projects: PhotoshopProjectSnapshot[];
    }
  | {
      type: 'photoshop.projectDirectories.snapshot';
      requestId: string;
      canonicalRoot: string;
      revision: number;
      directories: string[];
    }
  | {
      type: 'photoshop.export.ready';
      commandId: string;
    }
  | {
      type: 'photoshop.place.request';
      commandId: string;
      documentId: number;
      fileName: string;
      mimeType: PhotoshopMimeType;
      byteLength: number;
    }
  | {
      type: 'runtime.replacing';
      runtimeInstanceId: string;
    };

export function parseRuntimeMessage(text: string): RuntimeMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidMessage();
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw invalidMessage();
  }
  if (value.type === 'photoshop.session.ready'
    && exactKeys(value, ['type', 'runtimeInstanceId', 'pluginSessionId', 'bearer'])
    && nonEmptyString(value.runtimeInstanceId)
    && nonEmptyString(value.pluginSessionId)
    && nonEmptyString(value.bearer)) {
    return value as unknown as RuntimeMessage;
  }
  if (value.type === 'photoshop.projects.snapshot'
    && exactKeys(value, ['type', 'projects'])
    && Array.isArray(value.projects)
    && value.projects.every(isProjectSnapshot)) {
    return value as unknown as RuntimeMessage;
  }
  if (value.type === 'photoshop.projectDirectories.snapshot'
    && exactKeys(value, ['type', 'requestId', 'canonicalRoot', 'revision', 'directories'])
    && nonEmptyString(value.requestId)
    && nonEmptyString(value.canonicalRoot)
    && nonNegativeInteger(value.revision)
    && Array.isArray(value.directories)
    && value.directories.every((directory) => typeof directory === 'string')) {
    return value as unknown as RuntimeMessage;
  }
  if (value.type === 'photoshop.export.ready'
    && exactKeys(value, ['type', 'commandId'])
    && nonEmptyString(value.commandId)) {
    return value as unknown as RuntimeMessage;
  }
  if (value.type === 'photoshop.place.request'
    && exactKeys(value, ['type', 'commandId', 'documentId', 'fileName', 'mimeType', 'byteLength'])
    && nonEmptyString(value.commandId)
    && nonNegativeInteger(value.documentId)
    && nonEmptyString(value.fileName)
    && isPhotoshopMimeType(value.mimeType)
    && nonNegativeInteger(value.byteLength)
    && value.byteLength <= PHOTOSHOP_MAX_FILE_BYTES) {
    return value as unknown as RuntimeMessage;
  }
  if (value.type === 'runtime.replacing'
    && exactKeys(value, ['type', 'runtimeInstanceId'])
    && nonEmptyString(value.runtimeInstanceId)) {
    return value as unknown as RuntimeMessage;
  }
  throw invalidMessage();
}

export function serializePluginMessage(message: PluginMessage): string {
  return JSON.stringify(message);
}

function isProjectSnapshot(value: unknown): boolean {
  return isRecord(value)
    && exactKeys(value, ['canonicalRoot', 'name', 'revision'])
    && nonEmptyString(value.canonicalRoot)
    && typeof value.name === 'string'
    && nonNegativeInteger(value.revision);
}

export function isPhotoshopMimeType(value: unknown): value is PhotoshopMimeType {
  return typeof value === 'string'
    && (photoshopMimeTypes as readonly string[]).includes(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function invalidMessage(): Error {
  return new Error('Invalid Photoshop v1 Runtime message.');
}
