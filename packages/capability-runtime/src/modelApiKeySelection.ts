import type { ModelApiKeyEntry } from './config.js';

export type ModelApiKeyKind = 'image' | 'video' | 'audio';

export interface SelectModelApiKeyInput {
  kind: ModelApiKeyKind;
  modelId: string;
  entries: ModelApiKeyEntry[] | undefined;
}

export interface SelectedModelApiKey {
  id: string;
  key: string;
  label: string | null;
}

const cursors = new Map<string, number>();

export function selectModelApiKey(input: SelectModelApiKeyInput): SelectedModelApiKey | undefined {
  const enabled = (input.entries ?? [])
    .map((entry) => ({ ...entry, key: entry.key.trim() }))
    .filter((entry) => entry.enabled && entry.key);
  if (enabled.length === 0) {
    return undefined;
  }
  if (enabled.length === 1) {
    return selectEntry(enabled[0]!);
  }
  const scope = `${input.kind}:${input.modelId}`;
  const cursor = cursors.get(scope) ?? 0;
  const selectedIndex = cursor % enabled.length;
  cursors.set(scope, (selectedIndex + 1) % enabled.length);
  return selectEntry(enabled[selectedIndex]!);
}

function selectEntry(entry: ModelApiKeyEntry): SelectedModelApiKey {
  return {
    id: entry.id,
    key: entry.key.trim(),
    label: entry.label
  };
}
