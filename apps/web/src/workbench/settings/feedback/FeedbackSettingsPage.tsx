import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  DebruteGlobalFeedbackSettings,
  MutateDebruteGlobalSettingsInput
} from '@debrute/app-protocol';
import {
  FeedbackBarMarkButton,
  FeedbackImageBarPreview
} from '../../feedback/FeedbackBarPresentation';
import { FeedbackIcon } from '../../feedback/FeedbackIcon';
import { FeedbackIconPicker } from '../../feedback/FeedbackIconPicker';
import { UNRESOLVED_FEEDBACK_ICON_NAME } from '../../feedback/generatedFeedbackIconNames';
import { Button, IconButton, Modal, Trash2 } from '../../ui/index';
import { useI18n, type WorkbenchTranslationKey } from '../../i18n/index';

export type FeedbackNamePreflightError = 'required' | 'duplicate';

const feedbackNamePreflightErrorKeys: Record<FeedbackNamePreflightError, WorkbenchTranslationKey> = {
  required: 'settings.feedback.nameError.required',
  duplicate: 'settings.feedback.nameError.duplicate'
};
const MAX_ACTION_BAR_ITEMS = 8;
const DRAG_ACTIVATION_DISTANCE = 4;
const PICKER_WIDTH = 420;

type PickerTarget = { kind: 'new' } | { kind: 'existing'; name: string };
interface PickerState {
  target: PickerTarget;
  anchor: HTMLElement;
  left: number;
  top: number;
}

interface DragSession {
  pointerId: number;
  source: 'bar' | 'catalog';
  name: string;
  element: HTMLElement;
  initialNames: string[];
  startX: number;
  startY: number;
  centerOffsetX: number;
  centerOffsetY: number;
  active: boolean;
  clientX: number;
  clientY: number;
  overBar: boolean;
  rejected: boolean;
  previewNames: string[];
}

type DragPresentation = Pick<
  DragSession,
  'name' | 'clientX' | 'clientY' | 'rejected' | 'previewNames'
>;

interface FeedbackPointerEvent {
  pointerId: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

export function FeedbackSettingsPage({
  settings,
  mutate
}: {
  settings: DebruteGlobalFeedbackSettings;
  mutate(input: MutateDebruteGlobalSettingsInput): Promise<void>;
}): React.ReactElement {
  const i18n = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  const shouldFocusDraftRef = useRef(false);
  const skipDraftBlurRef = useRef(false);
  const dragSessionRef = useRef<DragSession | undefined>(undefined);
  const dragHandlersRef = useRef<{
    update(event: FeedbackPointerEvent): void;
    finish(event: FeedbackPointerEvent, cancelled: boolean): void;
  } | undefined>(undefined);
  const suppressClickRef = useRef<string | undefined>(undefined);
  const previousBarRectsRef = useRef(new Map<string, DOMRect>());
  const [draftIcon, setDraftIcon] = useState<string>();
  const [draftName, setDraftName] = useState('');
  const [draftError, setDraftError] = useState<string>();
  const [draftPending, setDraftPending] = useState(false);
  const [operationError, setOperationError] = useState<string>();
  const [picker, setPicker] = useState<PickerState>();
  const [drag, setDrag] = useState<DragPresentation>();
  const [deleteTarget, setDeleteTarget] = useState<string>();
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const configuredNames = useMemo(
    () => new Set(settings.catalog.map((entry) => entry.name)),
    [settings.catalog]
  );
  const visibleActionBar = drag?.previewNames ?? settings.actionBar;

  const submitFeedbackMutation = async (
    mutation: MutateDebruteGlobalSettingsInput
  ): Promise<boolean> => {
    setOperationError(undefined);
    try {
      await mutate(mutation);
      return true;
    } catch (cause) {
      setOperationError(errorMessage(cause));
      return false;
    }
  };

  const setActionBar = (names: string[]) => submitFeedbackMutation({
    operation: 'set-feedback-action-bar',
    names
  });

  const resetDraft = () => {
    setDraftIcon(undefined);
    setDraftName('');
    setDraftError(undefined);
  };

  const createDraft = async (): Promise<void> => {
    if (!draftIcon || draftPending) return;
    if (!draftName) {
      resetDraft();
      return;
    }
    const preflightError = feedbackNamePreflightError(draftName, configuredNames);
    if (preflightError) {
      setDraftError(i18n.t(feedbackNamePreflightErrorKeys[preflightError]));
      return;
    }
    const submittedName = draftName;
    const submittedIcon = draftIcon;
    setDraftPending(true);
    resetDraft();
    try {
      await mutate({
        operation: 'create-feedback-mark',
        name: submittedName,
        icon: submittedIcon
      });
    } catch (cause) {
      shouldFocusDraftRef.current = true;
      setDraftIcon(submittedIcon);
      setDraftName(submittedName);
      setDraftError(errorMessage(cause));
    } finally {
      setDraftPending(false);
    }
  };

  useLayoutEffect(() => {
    if (!draftIcon || !shouldFocusDraftRef.current) return;
    shouldFocusDraftRef.current = false;
    draftInputRef.current?.focus();
  }, [draftIcon, picker]);

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>();
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    for (const element of barRef.current?.querySelectorAll<HTMLElement>('[data-feedback-action-name]') ?? []) {
      const name = element.dataset.feedbackActionName;
      if (!name) continue;
      const nextRect = element.getBoundingClientRect();
      nextRects.set(name, nextRect);
      const previousRect = previousBarRectsRef.current.get(name);
      const deltaX = previousRect ? previousRect.left - nextRect.left : 0;
      if (!reduceMotion && deltaX && typeof element.animate === 'function') {
        const tokenStyles = getComputedStyle(document.documentElement);
        const duration = cssDurationMilliseconds(
          tokenStyles.getPropertyValue('--db-duration-feedback-reorder')
        );
        const easing = tokenStyles.getPropertyValue('--db-ease-standard').trim();
        if (!duration || !easing) continue;
        element.animate(
          [{ transform: `translateX(${deltaX}px)` }, { transform: 'translateX(0)' }],
          { duration, easing }
        );
      }
    }
    previousBarRectsRef.current = nextRects;
  }, [visibleActionBar]);

  useEffect(() => {
    if (!picker) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (pickerRef.current?.contains(target) || picker.anchor.contains(target)) return;
      setPicker(undefined);
      if (picker.target.kind === 'new') void createDraft();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  });

  const openPicker = (target: PickerTarget, anchor: HTMLElement) => {
    const rootRect = rootRef.current?.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const availableWidth = rootRef.current?.clientWidth ?? PICKER_WIDTH;
    const left = Math.max(0, Math.min(
      anchorRect.left - (rootRect?.left ?? 0),
      Math.max(0, availableWidth - Math.min(PICKER_WIDTH, availableWidth))
    ));
    setPicker({
      target,
      anchor,
      left,
      top: anchorRect.bottom - (rootRect?.top ?? 0) + 8
    });
  };

  const beginDrag = (
    source: 'bar' | 'catalog',
    name: string,
    event: React.PointerEvent<HTMLElement>
  ) => {
    if (event.button !== 0 || event.target instanceof Element
      && event.target.closest('.feedback-catalog-card__delete')) return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    element.setPointerCapture?.(event.pointerId);
    dragSessionRef.current = {
      pointerId: event.pointerId,
      source,
      name,
      element,
      initialNames: [...settings.actionBar],
      startX: event.clientX,
      startY: event.clientY,
      centerOffsetX: source === 'bar' ? rect.left + rect.width / 2 - event.clientX : 0,
      centerOffsetY: source === 'bar' ? rect.top + rect.height / 2 - event.clientY : 0,
      active: false,
      clientX: event.clientX,
      clientY: event.clientY,
      overBar: false,
      rejected: false,
      previewNames: [...settings.actionBar]
    };
  };

  const updateDrag = (event: FeedbackPointerEvent) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!session.active && Math.hypot(
      event.clientX - session.startX,
      event.clientY - session.startY
    ) < DRAG_ACTIVATION_DISTANCE) return;
    session.active = true;
    event.preventDefault();
    const dropX = event.clientX + (session.source === 'bar' ? session.centerOffsetX : 0);
    const dropY = event.clientY + (session.source === 'bar' ? session.centerOffsetY : 0);
    const barRect = barRef.current?.getBoundingClientRect();
    const overBar = Boolean(barRect
      && dropX >= barRect.left
      && dropX <= barRect.right
      && dropY >= barRect.top
      && dropY <= barRect.bottom);
    const alreadyInBar = session.initialNames.includes(session.name);
    const rejected = overBar
      && !alreadyInBar
      && session.initialNames.length >= MAX_ACTION_BAR_ITEMS;
    let previewNames = [...session.initialNames];
    if (overBar && !rejected) {
      previewNames = session.initialNames.filter((name) => name !== session.name);
      const itemCenters = [...barRef.current?.querySelectorAll<HTMLElement>('[data-feedback-action-name]') ?? []]
        .filter((element) => element.dataset.feedbackActionName !== session.name)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { name: element.dataset.feedbackActionName!, center: rect.left + rect.width / 2 };
        })
        .sort((left, right) => left.center - right.center);
      const insertionIndex = itemCenters.filter((item) => dropX > item.center).length;
      previewNames.splice(insertionIndex, 0, session.name);
    } else if (session.source === 'bar') {
      previewNames = session.initialNames.filter((name) => name !== session.name);
    }
    Object.assign(session, {
      clientX: dropX,
      clientY: dropY,
      overBar,
      rejected,
      previewNames
    });
    setDrag({
      name: session.name,
      clientX: session.clientX,
      clientY: session.clientY,
      rejected,
      previewNames
    });
  };

  const finishDrag = (event: FeedbackPointerEvent, cancelled: boolean) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    dragSessionRef.current = undefined;
    if (session.element.hasPointerCapture?.(session.pointerId)) {
      session.element.releasePointerCapture(session.pointerId);
    }
    setDrag(undefined);
    if (!session.active) return;
    suppressClickRef.current = session.name;
    window.setTimeout(() => {
      if (suppressClickRef.current === session.name) suppressClickRef.current = undefined;
    }, 0);
    if (cancelled || session.rejected) return;
    const shouldCommit = session.source === 'bar' || session.overBar;
    if (!shouldCommit || sameNames(session.initialNames, session.previewNames)) return;
    void setActionBar(session.previewNames);
  };

  const consumeSuppressedClick = (name: string): boolean => {
    if (suppressClickRef.current !== name) return false;
    suppressClickRef.current = undefined;
    return true;
  };

  const selectedPickerIcon = feedbackPickerIcon(picker, draftIcon, settings);
  dragHandlersRef.current = { update: updateDrag, finish: finishDrag };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => dragHandlersRef.current?.update(event);
    const handlePointerUp = (event: PointerEvent) => dragHandlersRef.current?.finish(event, false);
    const handlePointerCancel = (event: PointerEvent) => dragHandlersRef.current?.finish(event, true);
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="feedback-settings-page"
    >
      <section className="settings-group">
        <div className="settings-group__header">
          <h3>{i18n.t('settings.feedback.actionBar')}</h3>
        </div>
        <div className={`feedback-action-bar-scroll${drag?.rejected ? ' is-rejected' : ''}`}>
          <FeedbackImageBarPreview
            barRef={barRef}
            className="feedback-action-bar-preview"
            label={i18n.t('settings.feedback.actionBar')}
          >
            {visibleActionBar.map((currentName) => {
              const entry = settings.catalog.find((candidate) => candidate.name === currentName);
              return (
                <FeedbackBarMarkButton
                  key={currentName}
                  className={`feedback-action-bar-preview__item${drag?.name === currentName ? ' is-drag-source' : ''}`}
                  data-feedback-action-name={currentName}
                  label={currentName}
                  role="listitem"
                  icon={<FeedbackIcon icon={entry?.icon} size={18} />}
                  onPointerDown={(event) => beginDrag('bar', currentName, event)}
                />
              );
            })}
          </FeedbackImageBarPreview>
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group__header">
          <h3>{i18n.t('settings.feedback.catalog')}</h3>
        </div>
        <div className="feedback-catalog-list" role="list">
          {!draftIcon ? (
            <button
              type="button"
              className="feedback-catalog-card feedback-catalog-card--blank"
              aria-label={i18n.t('settings.feedback.createBlank')}
              disabled={draftPending}
              onClick={(event) => openPicker({ kind: 'new' }, event.currentTarget)}
            />
          ) : (
            <div
              className={`feedback-catalog-card feedback-catalog-card--draft${draftError ? ' is-invalid' : ''}`}
              role="listitem"
            >
              <IconButton
                className="feedback-catalog-card__icon"
                label={i18n.t('settings.feedback.chooseIcon')}
                icon={<FeedbackIcon icon={draftIcon} size={22} />}
                disabled={draftPending}
                onPointerDown={() => { skipDraftBlurRef.current = true; }}
                onClick={(event) => openPicker({ kind: 'new' }, event.currentTarget)}
              />
              <input
                ref={draftInputRef}
                type="text"
                className="feedback-catalog-card__name-input"
                value={draftName}
                placeholder={i18n.t('settings.feedback.name')}
                aria-label={i18n.t('settings.feedback.name')}
                aria-invalid={Boolean(draftError) || undefined}
                disabled={draftPending}
                onChange={(event) => {
                  setDraftName(event.currentTarget.value);
                  setDraftError(undefined);
                }}
                onBlur={() => {
                  if (skipDraftBlurRef.current) {
                    skipDraftBlurRef.current = false;
                    return;
                  }
                  void createDraft();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
              />
            </div>
          )}

          {settings.catalog.map((entry) => {
            const isInActionBar = settings.actionBar.includes(entry.name);
            return (
              <div
                className={`feedback-catalog-card${isInActionBar ? ' is-selected' : ''}${drag?.name === entry.name ? ' is-drag-source' : ''}`}
                key={entry.name}
                role="listitem"
                data-feedback-catalog-name={entry.name}
                onPointerDown={(event) => beginDrag('catalog', entry.name, event)}
              >
                <IconButton
                  className="feedback-catalog-card__icon"
                  label={`${i18n.t('settings.feedback.chooseIcon')}: ${entry.name}`}
                  icon={<FeedbackIcon icon={entry.icon} size={22} />}
                  onClick={(event) => {
                    if (consumeSuppressedClick(entry.name)) return;
                    openPicker({ kind: 'existing', name: entry.name }, event.currentTarget);
                  }}
                />
                <bdi className="feedback-catalog-card__name" dir="auto">{entry.name}</bdi>
                <IconButton
                  className="feedback-catalog-card__delete"
                  label={`${i18n.t('settings.feedback.delete')}: ${entry.name}`}
                  icon={<Trash2 size={14} />}
                  variant="danger"
                  size="xs"
                  onClick={() => {
                    setDeleteError(undefined);
                    setDeleteTarget(entry.name);
                  }}
                />
              </div>
            );
          })}
        </div>
        {draftError ? <small className="db-form-error" role="alert">{draftError}</small> : null}
        {operationError ? <small className="db-form-error" role="alert">{operationError}</small> : null}
      </section>

      {picker ? (
        <div
          ref={pickerRef}
          className="feedback-icon-picker-anchor"
          style={{ left: picker.left, top: picker.top }}
        >
          <FeedbackIconPicker
            value={selectedPickerIcon}
            onChange={(nextIcon) => {
              if (picker.target.kind === 'new') {
                shouldFocusDraftRef.current = true;
                setDraftIcon(nextIcon);
                setDraftError(undefined);
              } else {
                void submitFeedbackMutation({
                  operation: 'set-feedback-mark-icon',
                  name: picker.target.name,
                  icon: nextIcon
                });
              }
            }}
            onClose={() => setPicker(undefined)}
          />
        </div>
      ) : null}

      {drag ? (
        <div
          className={`feedback-settings-drag-ghost${drag.rejected ? ' is-rejected' : ''}`}
          style={{ transform: `translate3d(${drag.clientX - 14}px, ${drag.clientY - 14}px, 0)` }}
          aria-hidden="true"
        >
          <FeedbackIcon
            icon={settings.catalog.find((entry) => entry.name === drag.name)?.icon}
            size={18}
          />
        </div>
      ) : null}

      {deleteTarget ? (
        <Modal
          className="feedback-catalog-delete-dialog"
          labelledBy="feedback-catalog-delete-title"
          onCancel={() => {
            if (!deletePending) setDeleteTarget(undefined);
          }}
        >
          <div className="feedback-catalog-delete-dialog__copy">
            <h3 id="feedback-catalog-delete-title">
              {i18n.t('settings.feedback.deleteTitle', { name: deleteTarget })}
            </h3>
            <p>{i18n.t('settings.feedback.deleteConfirm', { name: deleteTarget })}</p>
          </div>
          {deleteError ? <small className="db-form-error" role="alert">{deleteError}</small> : null}
          <div className="feedback-catalog-delete-dialog__actions">
            <Button
              type="button"
              data-modal-initial-focus
              disabled={deletePending}
              onClick={() => setDeleteTarget(undefined)}
            >
              {i18n.t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={deletePending}
              onClick={() => {
                setDeletePending(true);
                setDeleteError(undefined);
                void mutate({ operation: 'delete-feedback-mark', name: deleteTarget })
                  .then(() => setDeleteTarget(undefined))
                  .catch((cause: unknown) => setDeleteError(errorMessage(cause)))
                  .finally(() => setDeletePending(false));
              }}
            >
              {i18n.t('settings.feedback.delete')}
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

export function feedbackNamePreflightError(
  name: string,
  configuredNames: ReadonlySet<string>
): FeedbackNamePreflightError | undefined {
  if (!name) return 'required';
  if (configuredNames.has(name)) return 'duplicate';
  return undefined;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function cssDurationMilliseconds(value: string): number {
  const normalized = value.trim();
  if (normalized.endsWith('ms')) return Number.parseFloat(normalized);
  if (normalized.endsWith('s')) return Number.parseFloat(normalized) * 1_000;
  return 0;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function feedbackPickerIcon(
  picker: PickerState | undefined,
  draftIcon: string | undefined,
  settings: DebruteGlobalFeedbackSettings
): string {
  if (!picker) return UNRESOLVED_FEEDBACK_ICON_NAME;
  if (picker.target.kind === 'new') return draftIcon ?? UNRESOLVED_FEEDBACK_ICON_NAME;
  const name = picker.target.name;
  return settings.catalog.find((entry) => entry.name === name)?.icon
    ?? UNRESOLVED_FEEDBACK_ICON_NAME;
}
