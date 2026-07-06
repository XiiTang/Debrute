import { describe, expect, it } from 'vitest';
import { selectModelApiKey } from '../src/modelApiKeySelection';

describe('model API key selection', () => {
  it('selects the only enabled key directly', () => {
    expect(selectModelApiKey({
      kind: 'image',
      modelId: 'selector-single',
      entries: [
        { id: 'disabled', key: 'sk-disabled', label: null, enabled: false },
        { id: 'enabled', key: ' sk-enabled ', label: 'Enabled', enabled: true }
      ]
    })).toEqual({
      id: 'enabled',
      key: 'sk-enabled',
      label: 'Enabled'
    });
  });

  it('rotates enabled keys in round-robin order and skips disabled keys', () => {
    const input = {
      kind: 'video' as const,
      modelId: 'selector-round-robin',
      entries: [
        { id: 'a', key: 'sk-a', label: null, enabled: true },
        { id: 'disabled', key: 'sk-disabled', label: null, enabled: false },
        { id: 'b', key: 'sk-b', label: 'B', enabled: true }
      ]
    };

    expect(selectModelApiKey(input)?.id).toBe('a');
    expect(selectModelApiKey(input)?.id).toBe('b');
    expect(selectModelApiKey(input)?.id).toBe('a');
  });

  it('keeps cursors independent by media kind and model id', () => {
    const entries = [
      { id: 'a', key: 'sk-a', label: null, enabled: true },
      { id: 'b', key: 'sk-b', label: null, enabled: true }
    ];

    expect(selectModelApiKey({ kind: 'image', modelId: 'same-name', entries })?.id).toBe('a');
    expect(selectModelApiKey({ kind: 'audio', modelId: 'same-name', entries })?.id).toBe('a');
    expect(selectModelApiKey({ kind: 'image', modelId: 'same-name', entries })?.id).toBe('b');
    expect(selectModelApiKey({ kind: 'audio', modelId: 'same-name', entries })?.id).toBe('b');
  });

  it('returns undefined when no enabled key exists', () => {
    expect(selectModelApiKey({
      kind: 'audio',
      modelId: 'selector-missing',
      entries: [
        { id: 'disabled', key: 'sk-disabled', label: null, enabled: false }
      ]
    })).toBeUndefined();
  });
});
