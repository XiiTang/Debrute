import React, { useEffect, useRef, useState } from 'react';
import type {
  CanvasFontId,
  CanvasTextAppearance,
  DebruteGlobalSettingsView,
  MutateDebruteGlobalSettingsInput,
  WorkbenchThemePreference
} from '@debrute/app-protocol';
import { CANVAS_FONT_CATALOG } from '../../canvas/CanvasFontCatalog';
import { useI18n, type WorkbenchI18n } from '../../i18n/index';
import type { WorkbenchResolvedTheme } from '../../services/workbenchTheme';
import { Field, Input, Select, Switch } from '../../ui/index';

type NumericAppearanceField = 'fontSizePx' | 'lineHeightRatio' | 'fontWeight' | 'letterSpacingPx';

interface AppearanceDraftText {
  fontSizePx: string;
  lineHeightRatio: string;
  fontWeight: string;
  letterSpacingPx: string;
}

export function AppearanceSettingsPage({
  settings,
  resolvedTheme,
  onSettingsChange
}: {
  settings: DebruteGlobalSettingsView;
  resolvedTheme: WorkbenchResolvedTheme;
  onSettingsChange: (settings: MutateDebruteGlobalSettingsInput) => Promise<void>;
}): React.ReactElement {
  const i18n = useI18n();
  const [themeDraft, setThemeDraft] = useState(settings.workbench.themePreference);
  const [themeError, setThemeError] = useState<string>();
  const [appearanceDraft, setAppearanceDraft] = useState(settings.canvas.textAppearance);
  const appearanceDraftRef = useRef(appearanceDraft);
  const [draftText, setDraftText] = useState<AppearanceDraftText>(() => (
    appearanceDraftText(settings.canvas.textAppearance)
  ));
  const [appearanceError, setAppearanceError] = useState<string>();
  const appearanceSaveVersionRef = useRef(0);

  useEffect(() => {
    setThemeDraft(settings.workbench.themePreference);
  }, [settings.workbench.themePreference]);

  useEffect(() => {
    appearanceDraftRef.current = settings.canvas.textAppearance;
    setAppearanceDraft(settings.canvas.textAppearance);
    setDraftText(appearanceDraftText(settings.canvas.textAppearance));
  }, [settings.canvas.textAppearance]);

  const saveTheme = async (themePreference: WorkbenchThemePreference) => {
    try {
      await onSettingsChange({ operation: 'set-theme-preference', themePreference });
      setThemeError(undefined);
    } catch (error) {
      setThemeError(errorMessage(error));
    }
  };

  const saveAppearance = (appearance: CanvasTextAppearance) => {
    appearanceDraftRef.current = appearance;
    setAppearanceDraft(appearance);
    const version = appearanceSaveVersionRef.current + 1;
    appearanceSaveVersionRef.current = version;
    void onSettingsChange({ operation: 'set-canvas-text-appearance', textAppearance: appearance }).then(() => {
      if (appearanceSaveVersionRef.current === version) {
        setAppearanceError(undefined);
      }
    }, (error: unknown) => {
      if (appearanceSaveVersionRef.current === version) {
        setAppearanceError(errorMessage(error));
      }
    });
  };

  const changeAppearance = (patch: Partial<CanvasTextAppearance>) => {
    saveAppearance({ ...appearanceDraftRef.current, ...patch });
  };

  const changeNumber = (
    field: NumericAppearanceField,
    rawValue: string,
    valid: (value: number) => boolean
  ) => {
    setDraftText((current) => ({ ...current, [field]: rawValue }));
    const value = numberFromDraft(rawValue);
    if (value !== undefined && valid(value)) {
      changeAppearance({ [field]: value });
    }
  };

  const stepFontWeight = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }
    event.preventDefault();
    const current = numberFromDraft(draftText.fontWeight);
    if (current === undefined || !validFontWeight(current)) {
      return;
    }
    const step = event.altKey ? 10 : event.shiftKey ? 100 : 50;
    const next = current + (event.key === 'ArrowUp' ? step : -step);
    if (!validFontWeight(next)) {
      return;
    }
    setDraftText((draft) => ({ ...draft, fontWeight: String(next) }));
    changeAppearance({ fontWeight: next });
  };

  return (
    <div className="appearance-settings-page">
      <section className="settings-group">
        <h3>{i18n.t('settings.appearance.workbenchTheme')}</h3>
        <Field
          label={i18n.t('settings.appearance.theme.label')}
          description={themeHelpText(themeDraft, resolvedTheme, i18n)}
          error={themeError
            ? i18n.t('settings.appearance.theme.saveFailed', { message: themeError })
            : undefined}
        >
          <Select
            value={themeDraft}
            onChange={(event) => {
              const themePreference = event.currentTarget.value as WorkbenchThemePreference;
              setThemeDraft(themePreference);
              void saveTheme(themePreference);
            }}
          >
            <option value="system">{i18n.t('settings.appearance.theme.system')}</option>
            <option value="dark">{i18n.t('settings.appearance.theme.dark')}</option>
            <option value="light">{i18n.t('settings.appearance.theme.light')}</option>
          </Select>
        </Field>
      </section>
      <section className="settings-group">
        <h3>{i18n.t('settings.appearance.canvasText')}</h3>
        <div className="db-form-grid db-form-grid--two">
          <Field label={i18n.t('settings.appearance.font.label')}>
            <Select
              value={appearanceDraft.fontId}
              onChange={(event) => changeAppearance({
                fontId: event.currentTarget.value as CanvasFontId
              })}
            >
              {CANVAS_FONT_CATALOG.map((font) => (
                <option key={font.id} value={font.id}>{font.displayName}</option>
              ))}
            </Select>
          </Field>
          <NumericAppearanceFieldControl
            label={i18n.t('settings.appearance.fontSize.label')}
            description={i18n.t('settings.appearance.fontSize.description')}
            value={draftText.fontSizePx}
            minimum={6}
            maximum={100}
            step={0.5}
            valid={validFontSize}
            onChange={(value) => changeNumber('fontSizePx', value, validFontSize)}
          />
          <NumericAppearanceFieldControl
            label={i18n.t('settings.appearance.lineHeight.label')}
            description={i18n.t('settings.appearance.lineHeight.description')}
            value={draftText.lineHeightRatio}
            minimum={1}
            maximum={2}
            step={0.05}
            valid={validLineHeight}
            onChange={(value) => changeNumber('lineHeightRatio', value, validLineHeight)}
          />
          <NumericAppearanceFieldControl
            label={i18n.t('settings.appearance.fontWeight.label')}
            description={i18n.t('settings.appearance.fontWeight.description')}
            value={draftText.fontWeight}
            minimum={100}
            maximum={900}
            step={50}
            valid={validFontWeight}
            onKeyDown={stepFontWeight}
            onChange={(value) => changeNumber('fontWeight', value, validFontWeight)}
          />
          <NumericAppearanceFieldControl
            label={i18n.t('settings.appearance.letterSpacing.label')}
            description={i18n.t('settings.appearance.letterSpacing.description')}
            value={draftText.letterSpacingPx}
            minimum={-5}
            maximum={20}
            step={0.1}
            valid={validLetterSpacing}
            onChange={(value) => changeNumber('letterSpacingPx', value, validLetterSpacing)}
          />
        </div>
        <Switch
          label={i18n.t('settings.appearance.ligatures.label')}
          checked={appearanceDraft.ligatures}
          onChange={(event) => changeAppearance({ ligatures: event.currentTarget.checked })}
        />
        <small className="db-form-help">{i18n.t('settings.appearance.ligatures.description')}</small>
        {appearanceError ? (
          <small className="db-form-error">
            {i18n.t('settings.appearance.canvasText.saveFailed', { message: appearanceError })}
          </small>
        ) : null}
      </section>
    </div>
  );
}

function NumericAppearanceFieldControl({
  label,
  description,
  value,
  minimum,
  maximum,
  step,
  valid,
  onChange,
  onKeyDown
}: {
  label: string;
  description: string;
  value: string;
  minimum: number;
  maximum: number;
  step: number;
  valid(value: number): boolean;
  onChange(value: string): void;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
}): React.ReactElement {
  const parsed = numberFromDraft(value);
  const invalid = parsed === undefined || !valid(parsed);
  return (
    <Field label={label} description={description} error={invalid ? description : undefined}>
      <Input
        type="number"
        value={value}
        min={minimum}
        max={maximum}
        step={step}
        onKeyDown={onKeyDown}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

function appearanceDraftText(appearance: CanvasTextAppearance): AppearanceDraftText {
  return {
    fontSizePx: String(appearance.fontSizePx),
    lineHeightRatio: String(appearance.lineHeightRatio),
    fontWeight: String(appearance.fontWeight),
    letterSpacingPx: String(appearance.letterSpacingPx)
  };
}

function numberFromDraft(value: string): number | undefined {
  if (value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validFontSize(value: number): boolean {
  return value >= 6 && value <= 100 && hasPrecision(value, 2);
}

function validLineHeight(value: number): boolean {
  return value >= 1 && value <= 2 && hasPrecision(value, 100);
}

function validFontWeight(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 900;
}

function validLetterSpacing(value: number): boolean {
  return value >= -5 && value <= 20 && hasPrecision(value, 10);
}

function hasPrecision(value: number, scale: number): boolean {
  const scaled = value * scale;
  return Math.abs(scaled - Math.round(scaled)) <= Number.EPSILON * scale * 8;
}

function themeHelpText(
  preference: WorkbenchThemePreference,
  resolvedTheme: WorkbenchResolvedTheme,
  i18n: WorkbenchI18n
): string {
  if (preference === 'system') {
    return i18n.t('settings.appearance.theme.usingSystem', {
      theme: resolvedTheme === 'dark'
        ? i18n.t('settings.appearance.theme.resolvedDark')
        : i18n.t('settings.appearance.theme.resolvedLight')
    });
  }
  return i18n.t('settings.appearance.theme.appliedGlobal');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
