import React, { useMemo, useRef, useState } from 'react';
import type {
  DebruteGlobalFeedbackSettings,
  MutateDebruteGlobalSettingsInput
} from '@debrute/app-protocol';
import { FeedbackIcon } from '../../feedback/FeedbackIcon.js';
import { FeedbackIconPicker } from '../../feedback/FeedbackIconPicker.js';
import { UNRESOLVED_FEEDBACK_ICON_NAME } from '../../feedback/generatedFeedbackIconNames.js';
import { Button, IconButton, Input, Plus, Trash2, X } from '../../ui/index.js';
import { useI18n, type WorkbenchTranslationKey } from '../../i18n/index.js';

export type FeedbackNameError = 'required' | 'too-long' | 'duplicate' | 'forbidden-control';

const feedbackNameErrorKeys: Record<FeedbackNameError, WorkbenchTranslationKey> = {
  required: 'settings.feedback.nameError.required',
  'too-long': 'settings.feedback.nameError.tooLong',
  duplicate: 'settings.feedback.nameError.duplicate',
  'forbidden-control': 'settings.feedback.nameError.forbiddenControl'
};
const DEFAULT_NEW_FEEDBACK_ICON = 'circle';

export function FeedbackSettingsPage({
  settings,
  mutate
}: {
  settings: DebruteGlobalFeedbackSettings;
  mutate(input: MutateDebruteGlobalSettingsInput): Promise<void>;
}): React.ReactElement {
  const i18n = useI18n();
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(DEFAULT_NEW_FEEDBACK_ICON);
  const [pickerTarget, setPickerTarget] = useState<string | 'new'>();
  const [error, setError] = useState<string>();
  const draggedNameRef = useRef<string | undefined>(undefined);
  const configuredNames = useMemo(() => new Set(settings.catalog.map((entry) => entry.name)), [settings.catalog]);
  const compareNames = useMemo(() => new Intl.Collator(i18n.locale).compare, [i18n.locale]);
  const presentedCatalog = useMemo(
    () => [...settings.catalog].sort((left, right) => compareNames(left.name, right.name)),
    [compareNames, settings.catalog]
  );
  const normalizedSearch = search.toLocaleLowerCase(i18n.locale);
  const filteredCatalog = presentedCatalog.filter((entry) => (
    entry.name.toLocaleLowerCase(i18n.locale).includes(normalizedSearch)
      || entry.icon.includes(normalizedSearch)
  ));
  const nameError = feedbackNameError(name, configuredNames);
  const nameErrorMessage = nameError ? i18n.t(feedbackNameErrorKeys[nameError]) : undefined;

  const run = async (mutation: MutateDebruteGlobalSettingsInput): Promise<boolean> => {
    setError(undefined);
    try {
      await mutate(mutation);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };

  const setActionBar = (names: string[]) => run({ operation: 'set-feedback-action-bar', names });
  const appendToActionBar = (currentName: string) => {
    if (settings.actionBar.includes(currentName) || settings.actionBar.length >= 8) return;
    void setActionBar([...settings.actionBar, currentName]);
  };
  const moveInActionBar = (currentName: string, offset: -1 | 1) => {
    const currentIndex = settings.actionBar.indexOf(currentName);
    const targetIndex = currentIndex + offset;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= settings.actionBar.length) return;
    const next = [...settings.actionBar];
    next.splice(currentIndex, 1);
    next.splice(targetIndex, 0, currentName);
    void setActionBar(next);
  };
  const create = async () => {
    if (nameError) return;
    const created = await run({
      operation: 'create-feedback-mark',
      name,
      icon
    });
    if (!created) return;
    setName('');
    setIcon(DEFAULT_NEW_FEEDBACK_ICON);
  };

  const startDragging = (
    currentName: string,
    event?: React.DragEvent<HTMLElement>,
    effectAllowed: 'copy' | 'move' = 'move'
  ) => {
    draggedNameRef.current = currentName;
    event?.dataTransfer?.setData('application/x-debrute-feedback-name', currentName);
    if (event?.dataTransfer) event.dataTransfer.effectAllowed = effectAllowed;
  };
  const stopDragging = () => {
    draggedNameRef.current = undefined;
  };
  const dropAt = (event: React.DragEvent<HTMLElement>, targetName?: string) => {
    const dragged = draggedNameRef.current
      ?? event.dataTransfer?.getData('application/x-debrute-feedback-name');
    if (!dragged || !configuredNames.has(dragged)) return;
    if (dragged === targetName) {
      stopDragging();
      return;
    }
    const alreadyConfigured = settings.actionBar.includes(dragged);
    if (!alreadyConfigured && settings.actionBar.length >= 8) return;
    const next = settings.actionBar.filter((candidate) => candidate !== dragged);
    if (targetName) next.splice(next.indexOf(targetName), 0, dragged);
    else next.push(dragged);
    stopDragging();
    if (next.length === settings.actionBar.length
      && next.every((candidate, index) => candidate === settings.actionBar[index])) return;
    void setActionBar(next);
  };

  return (
    <div className="feedback-settings-page">
      <section className="settings-group">
        <div className="settings-group__header">
          <div>
            <h3>{i18n.t('settings.feedback.actionBar')}</h3>
            <small className="db-form-help">{i18n.t('settings.feedback.actionBarHelp')}</small>
          </div>
          <small>{settings.actionBar.length}/8</small>
        </div>
        <div
          className="feedback-action-bar-preview"
          aria-label={i18n.t('settings.feedback.actionBar')}
          role="list"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            dropAt(event);
          }}
        >
          {settings.actionBar.map((currentName) => {
            const entry = settings.catalog.find((candidate) => candidate.name === currentName);
            return (
              <div
                key={currentName}
                className="feedback-action-bar-preview__item"
                draggable
                role="listitem"
                tabIndex={0}
                aria-label={i18n.t('settings.feedback.reorderActionBar', { name: currentName })}
                onDragStart={(event) => startDragging(currentName, event)}
                onDragEnd={stopDragging}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : undefined;
                  if (!offset) return;
                  event.preventDefault();
                  moveInActionBar(currentName, offset);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  dropAt(event, currentName);
                }}
              >
                <FeedbackIcon icon={entry?.icon} size={18} />
                <bdi dir="auto">{currentName}</bdi>
                <IconButton
                  size="xs"
                  label={i18n.t('settings.feedback.removeFromActionBar', { name: currentName })}
                  icon={<X size={12} />}
                  onClick={() => void setActionBar(settings.actionBar.filter((candidate) => candidate !== currentName))}
                />
              </div>
            );
          })}
          {settings.actionBar.length === 0 ? <small>{i18n.t('settings.feedback.actionBarEmpty')}</small> : null}
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group__header">
          <div>
            <h3>{i18n.t('settings.feedback.catalog')}</h3>
            <small className="db-form-help">{i18n.t('settings.feedback.catalogHelp')}</small>
          </div>
          <Input
            value={search}
            placeholder={i18n.t('settings.feedback.search')}
            aria-label={i18n.t('settings.feedback.search')}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
        <div className="feedback-catalog-create">
          <Input
            value={name}
            placeholder={i18n.t('settings.feedback.name')}
            aria-label={i18n.t('settings.feedback.name')}
            invalid={Boolean(name && nameError)}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Button
            className="feedback-icon-choice"
            aria-label={i18n.t('settings.feedback.chooseIcon')}
            iconStart={<FeedbackIcon icon={icon} size={22} />}
            onClick={() => setPickerTarget('new')}
          >{icon}</Button>
          <Button
            type="button"
            iconStart={<Plus size={14} />}
            disabled={Boolean(nameError)}
            onClick={() => void create()}
          >{i18n.t('settings.feedback.create')}</Button>
        </div>
        {name && nameErrorMessage ? <small className="db-form-error">{nameErrorMessage}</small> : null}
        {error ? <small className="db-form-error">{error}</small> : null}
        <div className="feedback-catalog-list" role="list">
          {filteredCatalog.map((entry) => {
            const isInActionBar = settings.actionBar.includes(entry.name);
            const canAddToActionBar = !isInActionBar && settings.actionBar.length < 8;
            const catalogActionLabel = isInActionBar
              ? i18n.t('settings.feedback.alreadyInActionBar', { name: entry.name })
              : settings.actionBar.length >= 8
                ? i18n.t('settings.feedback.actionBarFull', { name: entry.name })
                : i18n.t('settings.feedback.dragToActionBar', { name: entry.name });
            return (
              <div
                className={`feedback-catalog-row${canAddToActionBar ? ' feedback-catalog-row--draggable' : ''}`}
                key={entry.name}
                draggable={canAddToActionBar}
                title={catalogActionLabel}
                role="listitem"
                onDragStart={(event) => startDragging(entry.name, event, 'copy')}
                onDragEnd={stopDragging}
              >
                <Button
                  className="feedback-icon-choice"
                  aria-label={`${i18n.t('settings.feedback.chooseIcon')}: ${entry.name}`}
                  iconStart={<FeedbackIcon icon={entry.icon} size={22} />}
                  onClick={() => setPickerTarget(entry.name)}
                >{entry.icon}</Button>
                <Button
                  className="feedback-catalog-row__identity"
                  size="sm"
                  aria-disabled={!canAddToActionBar}
                  aria-label={catalogActionLabel}
                  onClick={() => {
                    if (canAddToActionBar) appendToActionBar(entry.name);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    if (canAddToActionBar) appendToActionBar(entry.name);
                  }}
                ><bdi dir="auto"><strong>{entry.name}</strong></bdi></Button>
                <IconButton
                  className="feedback-catalog-row__delete"
                  label={`${i18n.t('settings.feedback.delete')}: ${entry.name}`}
                  icon={<Trash2 size={14} />}
                  variant="danger"
                  size="xs"
                  onClick={() => {
                    if (window.confirm(i18n.t('settings.feedback.deleteConfirm', { name: entry.name }))) {
                      void run({ operation: 'delete-feedback-mark', name: entry.name });
                    }
                  }}
                />
              </div>
            );
          })}
        </div>
      </section>

      {pickerTarget ? (
        <div className="feedback-icon-picker-anchor">
          <FeedbackIconPicker
            value={pickerTarget === 'new'
              ? icon
              : settings.catalog.find((entry) => entry.name === pickerTarget)?.icon
                ?? UNRESOLVED_FEEDBACK_ICON_NAME}
            onChange={(nextIcon) => {
              if (pickerTarget === 'new') setIcon(nextIcon);
              else void run({ operation: 'set-feedback-mark-icon', name: pickerTarget, icon: nextIcon });
            }}
            onClose={() => setPickerTarget(undefined)}
          />
        </div>
      ) : null}
    </div>
  );
}

export function feedbackNameError(
  name: string,
  configuredNames: ReadonlySet<string>
): FeedbackNameError | undefined {
  if (!name) return 'required';
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const length = [...segmenter.segment(name)].length;
  if (length > 32) return 'too-long';
  if (configuredNames.has(name)) return 'duplicate';
  if ([...name].some((character) => isForbiddenNameCodePoint(character.codePointAt(0) ?? 0))) {
    return 'forbidden-control';
  }
  return undefined;
}

function isForbiddenNameCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || codePoint === 0x061c
    || (codePoint >= 0x200e && codePoint <= 0x200f)
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069);
}
