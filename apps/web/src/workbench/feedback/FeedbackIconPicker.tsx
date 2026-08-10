import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Input } from '../ui/index.js';
import { useI18n } from '../i18n/index.js';
import { FEEDBACK_ICON_MANIFEST } from './generatedFeedbackIconManifest.js';
import { FeedbackIcon } from './FeedbackIcon.js';

const CELL_SIZE = 48;
const OVERSCAN_ROWS = 2;

export function FeedbackIconPicker({
  value,
  onChange,
  onClose
}: {
  value: string;
  onChange(value: string): void;
  onClose(): void;
}): React.ReactElement {
  const i18n = useI18n();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [viewport, setViewport] = useState({ width: 336, height: 288, scrollTop: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const icons = useMemo(() => FEEDBACK_ICON_MANIFEST.filter((icon) => {
    if (!deferredQuery) return true;
    const haystack = `${icon.name} ${icon.categories.join(' ')} ${icon.tags.join(' ')}`.toLocaleLowerCase();
    return haystack.includes(deferredQuery);
  }), [deferredQuery]);
  const columnCount = Math.max(1, Math.floor(viewport.width / CELL_SIZE));
  const rowCount = Math.ceil(icons.length / columnCount);
  const startRow = Math.max(0, Math.floor(viewport.scrollTop / CELL_SIZE) - OVERSCAN_ROWS);
  const endRow = Math.min(
    rowCount,
    Math.ceil((viewport.scrollTop + viewport.height) / CELL_SIZE) + OVERSCAN_ROWS
  );
  const visible = icons.slice(startRow * columnCount, endRow * columnCount);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setViewport((current) => ({
        ...current,
        width: entry.contentRect.width,
        height: entry.contentRect.height
      }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="feedback-icon-picker"
      role="dialog"
      aria-label={i18n.t('settings.feedback.iconPicker.title')}
    >
      <div className="feedback-icon-picker__header">
        <Input
          autoFocus
          value={query}
          placeholder={i18n.t('settings.feedback.iconPicker.search')}
          aria-label={i18n.t('settings.feedback.iconPicker.search')}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <Button size="xs" onClick={onClose}>{i18n.t('common.close')}</Button>
      </div>
      <div
        ref={viewportRef}
        className="feedback-icon-picker__viewport"
        onScroll={(event) => setViewport((current) => ({
          ...current,
          scrollTop: event.currentTarget.scrollTop
        }))}
      >
        <div className="feedback-icon-picker__space" style={{ height: rowCount * CELL_SIZE }}>
          <div
            className="feedback-icon-picker__grid"
            style={{
              gridTemplateColumns: `repeat(${columnCount}, ${CELL_SIZE}px)`,
              transform: `translateY(${startRow * CELL_SIZE}px)`
            }}
          >
            {visible.map((icon) => (
              <div key={icon.name} className="feedback-icon-picker__cell">
                <IconButton
                  label={icon.name}
                  icon={<FeedbackIcon icon={icon.name} size={22} />}
                  pressed={icon.name === value}
                  onClick={() => {
                    onChange(icon.name);
                    onClose();
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      <small>{i18n.t('settings.feedback.iconPicker.count', {
        count: icons.length.toLocaleString(i18n.locale)
      })}</small>
    </div>
  );
}
