import React, { useEffect, useState } from 'react';
import { Plus, Save, Trash2, X } from 'lucide-react';
import type { ApiKeyPreviewRecord, SaveModelApiKeyEntryInput } from '@debrute/app-protocol';
import { Button, IconButton, Input, Switch } from '../ui';
import { useI18n } from '../i18n';

export interface ModelApiKeyListEditorProps {
  previews: ApiKeyPreviewRecord[];
  onSave: (apiKeys: SaveModelApiKeyEntryInput[]) => Promise<void>;
}

interface DraftKey {
  id: string;
  key: string;
  label: string;
  enabled: boolean;
}

export function ModelApiKeyListEditor({ previews, onSave }: ModelApiKeyListEditorProps): React.ReactElement {
  const i18n = useI18n();
  const [draft, setDraft] = useState<DraftKey>();
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setLabelDrafts(Object.fromEntries(previews.map((preview) => [preview.id, preview.label ?? ''])));
  }, [previews]);

  const existingEntries: SaveModelApiKeyEntryInput[] = previews.map((preview) => ({
    id: preview.id,
    label: (labelDrafts[preview.id] ?? preview.label ?? '').trim() || null,
    enabled: preview.enabled
  }));

  const saveList = async (apiKeys: SaveModelApiKeyEntryInput[]) => {
    setSaving(true);
    setError(undefined);
    try {
      await onSave(apiKeys);
      setDraft(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const saveLabel = (preview: ApiKeyPreviewRecord) => {
    const label = (labelDrafts[preview.id] ?? '').trim() || null;
    if (label === preview.label) {
      return;
    }
    void saveList(existingEntries.map((entry) => (
      entry.id === preview.id ? { ...entry, label } : entry
    )));
  };

  return (
    <div className="db-api-key-list">
      <div className="db-api-key-list__rows">
        {previews.map((preview) => (
          <div className="db-api-key-row" key={preview.id}>
            <Input className="db-api-key-row__key" value={preview.preview} readOnly aria-label={i18n.t('settings.models.apiKeyPreview')} />
            <Input
              className="db-api-key-row__label"
              value={labelDrafts[preview.id] ?? preview.label ?? ''}
              disabled={saving}
              aria-label={i18n.t('settings.models.keyLabel')}
              onChange={(event) => setLabelDrafts({ ...labelDrafts, [preview.id]: event.currentTarget.value })}
              onBlur={() => saveLabel(preview)}
            />
            <Switch
              label={i18n.t('settings.models.enabled')}
              checked={preview.enabled}
              disabled={saving}
              onChange={(event) => void saveList(existingEntries.map((entry) => (
                entry.id === preview.id ? { ...entry, enabled: event.currentTarget.checked } : entry
              )))}
            />
            <IconButton
              label={i18n.t('settings.models.deleteApiKey')}
              icon={<Trash2 size={13} />}
              size="xs"
              disabled={saving}
              onClick={() => void saveList(existingEntries.filter((entry) => entry.id !== preview.id))}
            />
          </div>
        ))}
        {draft ? (
          <div className="db-api-key-row">
            <Input
              className="db-api-key-row__key"
              aria-label={i18n.t('settings.models.newApiKey')}
              value={draft.key}
              onChange={(event) => setDraft({ ...draft, key: event.currentTarget.value })}
              spellCheck={false}
            />
            <Input
              className="db-api-key-row__label"
              aria-label={i18n.t('settings.models.keyLabel')}
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.currentTarget.value })}
            />
            <Switch
              label={i18n.t('settings.models.enabled')}
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })}
            />
            <IconButton
              label={i18n.t('settings.models.saveApiKey')}
              icon={<Save size={13} />}
              size="xs"
              disabled={saving || !draft.key.trim()}
              onClick={() => void saveList([...existingEntries, {
                id: draft.id,
                key: draft.key,
                label: draft.label.trim() || null,
                enabled: draft.enabled
              }])}
            />
            <IconButton
              label={i18n.t('settings.models.cancelApiKey')}
              icon={<X size={13} />}
              size="xs"
              disabled={saving}
              onClick={() => setDraft(undefined)}
            />
          </div>
        ) : null}
      </div>
      <Button
        type="button"
        iconStart={<Plus size={14} />}
        disabled={saving || Boolean(draft)}
        onClick={() => setDraft({ id: crypto.randomUUID(), key: '', label: '', enabled: true })}
      >
        {i18n.t('settings.models.addApiKey')}
      </Button>
      {error ? <small className="db-form-error">{error}</small> : null}
    </div>
  );
}
