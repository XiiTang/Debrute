import React, { useEffect, useMemo, useState } from 'react';
import type {
  CanvasFeedbackDocument,
  FeedbackCatalogEntry,
  ProjectTreeEntry
} from '@debrute/app-protocol';
import { FeedbackIcon } from './FeedbackIcon';
import { IconButton, LocateFixed, Trash2 } from '../ui/index';
import { useI18n } from '../i18n/index';

export function FeedbackPanel({
  feedback,
  catalog,
  projectTree,
  onLocatePath,
  onClearMark,
  onDeleteItem
}: {
  feedback: CanvasFeedbackDocument | undefined;
  catalog: readonly FeedbackCatalogEntry[];
  projectTree: readonly ProjectTreeEntry[];
  onLocatePath(path: string): void;
  onClearMark(path: string, mark: string): Promise<boolean>;
  onDeleteItem(itemId: string): Promise<boolean>;
}): React.ReactElement {
  const i18n = useI18n();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const entries = useMemo(() => orderedFeedbackEntries(feedback, projectTree), [feedback, projectTree]);
  const iconByName = useMemo(() => new Map(catalog.map((entry) => [entry.name, entry.icon])), [catalog]);
  const availableProjectPaths = useMemo(
    () => new Set(projectTree.map((entry) => entry.projectRelativePath)),
    [projectTree]
  );

  useEffect(() => {
    setPending((current) => {
      const acceptedKeys = new Set(Object.values(feedback?.entries ?? {}).flatMap((entry) => [
        ...entry.marks.map((mark) => pendingMarkKey(entry.projectRelativePath, mark)),
        ...entry.items.map((item) => pendingItemKey(entry.projectRelativePath, item.id))
      ]));
      const retained = [...current].filter((key) => acceptedKeys.has(key));
      return retained.length === current.size ? current : new Set(retained);
    });
  }, [feedback]);

  const run = async (key: string, action: () => Promise<boolean>) => {
    setPending((current) => new Set([...current, key]));
    try {
      if (await action()) return;
    } catch {
      // The owning Canvas interaction reports the failure.
    }
    setPending((current) => new Set([...current].filter((candidate) => candidate !== key)));
  };

  if (!feedback || entries.length === 0) {
    return (
      <div className="feedback-panel feedback-panel--empty">
        <span>{i18n.t('feedbackPanel.empty')}</span>
      </div>
    );
  }

  return (
    <div className="feedback-panel">
      {entries.map((entry) => {
        const locationAvailable = !entry.projectRelativePath
          || availableProjectPaths.has(entry.projectRelativePath);
        return (
          <section key={entry.projectRelativePath} className="feedback-panel__path-group">
            <button
              type="button"
              className="feedback-panel__path"
              disabled={!locationAvailable}
              onClick={() => onLocatePath(entry.projectRelativePath)}
            >
              <LocateFixed size={14} />
              <strong>{entry.projectRelativePath || i18n.t('feedbackPanel.project')}</strong>
              {!locationAvailable ? (
                <small>{i18n.t('feedbackPanel.locationUnavailable')}</small>
              ) : null}
            </button>
            {entry.marks.length > 0 ? (
              <div className="feedback-panel__marks">
                {[...entry.marks].sort((left, right) => left.localeCompare(right, i18n.locale)).map((mark) => {
                  const key = pendingMarkKey(entry.projectRelativePath, mark);
                  return (
                    <div key={mark} className="feedback-panel__mark">
                      <FeedbackIcon icon={iconByName.get(mark)} size={18} />
                      <bdi dir="auto">{mark}</bdi>
                      <IconButton
                        disabled={pending.has(key)}
                        label={i18n.t('feedbackPanel.clearMark')}
                        icon={<Trash2 size={13} />}
                        size="xs"
                        onClick={() => void run(key, () => onClearMark(entry.projectRelativePath, mark))}
                      />
                    </div>
                  );
                })}
              </div>
            ) : null}
            {entry.items.length > 0 ? (
              <div className="feedback-panel__items">
                {[...entry.items]
                  .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                  .map((item) => {
                    const key = pendingItemKey(entry.projectRelativePath, item.id);
                    return (
                      <article key={item.id} className="feedback-panel__item">
                        <div>
                          <strong>{item.kind}{'label' in item ? ` ${item.label}` : ''}</strong>
                          <small>{item.createdAt}</small>
                        </div>
                        <p>{item.comment}</p>
                        <IconButton
                          disabled={pending.has(key)}
                          label={i18n.t('feedbackPanel.deleteItem')}
                          icon={<Trash2 size={13} />}
                          size="xs"
                          onClick={() => void run(key, () => onDeleteItem(item.id))}
                        />
                      </article>
                    );
                  })}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function pendingMarkKey(projectRelativePath: string, mark: string): string {
  return JSON.stringify(['mark', projectRelativePath, mark]);
}

function pendingItemKey(projectRelativePath: string, itemId: string): string {
  return JSON.stringify(['item', projectRelativePath, itemId]);
}

export function orderedFeedbackEntries(
  feedback: CanvasFeedbackDocument | undefined,
  projectTree: readonly ProjectTreeEntry[]
): NonNullable<CanvasFeedbackDocument>['entries'][string][] {
  if (!feedback) return [];
  const projectOrder = new Map(projectTree.map((entry, index) => [entry.projectRelativePath, index]));
  return Object.values(feedback.entries).sort((left, right) => {
    if (!left.projectRelativePath) return -1;
    if (!right.projectRelativePath) return 1;
    const leftIndex = projectOrder.get(left.projectRelativePath);
    const rightIndex = projectOrder.get(right.projectRelativePath);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return left.projectRelativePath.localeCompare(right.projectRelativePath);
  });
}
