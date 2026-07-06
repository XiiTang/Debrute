import type { ModelApiKeyEntry, SaveModelApiKeyEntryInput } from '@debrute/app-protocol';

export type ModelApiKeyInputErrorFactory = (message: string, field: string) => Error;
export type MediaModelInputLabel = 'Image model' | 'Video model' | 'Audio model';

export function normalizeModelApiKeySaveEntries(
  value: unknown,
  mediaLabel: MediaModelInputLabel,
  inputError: ModelApiKeyInputErrorFactory
): SaveModelApiKeyEntryInput[] {
  if (!Array.isArray(value)) {
    throw inputError(`${mediaLabel} apiKeys must be an array when provided.`, 'apiKeys');
  }
  const seenIds = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw inputError(`${mediaLabel} apiKeys entries must be objects.`, `apiKeys.${index}`);
    }
    const id = requireString(entry.id, `${mediaLabel} apiKeys entry id`, `apiKeys.${index}.id`, inputError).trim();
    if (!id) {
      throw inputError(`${mediaLabel} apiKeys entry id must be a non-empty string.`, `apiKeys.${index}.id`);
    }
    if (seenIds.has(id)) {
      throw inputError(`${mediaLabel} apiKeys entries must not contain duplicate ids.`, 'apiKeys');
    }
    seenIds.add(id);
    const key = entry.key === undefined
      ? undefined
      : requireString(entry.key, `${mediaLabel} apiKeys entry key`, `apiKeys.${index}.key`, inputError).trim();
    if (key !== undefined && !key) {
      throw inputError(`${mediaLabel} apiKeys entry key must be a non-empty string when provided.`, `apiKeys.${index}.key`);
    }
    if (typeof entry.enabled !== 'boolean') {
      throw inputError(`${mediaLabel} apiKeys entry enabled must be a boolean.`, `apiKeys.${index}.enabled`);
    }
    return {
      id,
      ...(key !== undefined ? { key } : {}),
      label: normalizeNullableLabel(entry.label, `${mediaLabel} apiKeys entry label`, `apiKeys.${index}.label`, inputError),
      enabled: entry.enabled
    };
  });
}

export function resolveModelApiKeyEntries(
  entries: SaveModelApiKeyEntryInput[],
  existing: ModelApiKeyEntry[],
  mediaLabel: MediaModelInputLabel,
  inputError: ModelApiKeyInputErrorFactory
): ModelApiKeyEntry[] {
  const existingById = new Map(existing.map((entry) => [entry.id, entry]));
  const seenKeys = new Set<string>();
  return entries.map((entry, index) => {
    const key = entry.key?.trim() || existingById.get(entry.id)?.key.trim() || '';
    if (!key) {
      throw inputError(`${mediaLabel} apiKeys entry key must be provided for new keys.`, `apiKeys.${index}.key`);
    }
    if (seenKeys.has(key)) {
      throw inputError(`${mediaLabel} apiKeys entries must not contain duplicate keys.`, 'apiKeys');
    }
    seenKeys.add(key);
    return {
      id: entry.id,
      key,
      label: entry.label,
      enabled: entry.enabled
    };
  });
}

function normalizeNullableLabel(
  value: unknown,
  label: string,
  field: string,
  inputError: ModelApiKeyInputErrorFactory
): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw inputError(`${label} must be a string or null.`, field);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function requireString(
  value: unknown,
  label: string,
  field: string,
  inputError: ModelApiKeyInputErrorFactory
): string {
  if (typeof value !== 'string') {
    throw inputError(`${label} must be a string.`, field);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
