import { useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react';
import type {
  DebruteGlobalSettingsView,
  MutateDebruteGlobalSettingsInput
} from '@debrute/app-protocol';
import type {
  WorkbenchGlobalProjection,
  WorkbenchGlobalProjectionState
} from './WorkbenchGlobalProjection';

export interface WorkbenchGlobalSettingsController {
  settings: DebruteGlobalSettingsView;
  mutate(input: MutateDebruteGlobalSettingsInput): Promise<void>;
}

interface MutationWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface MutationTask {
  input: MutateDebruteGlobalSettingsInput;
  waiters: MutationWaiter[];
}

interface MutationLane {
  running: boolean;
  queued: MutationTask[];
  awaiting: MutateDebruteGlobalSettingsInput[];
  inFlight?: MutationTask;
}

type GlobalSettingsApi = {
  mutateGlobalSettings(input: MutateDebruteGlobalSettingsInput): Promise<{ ok: true }>;
};

export function useWorkbenchGlobalSettingsController(input: {
  api: GlobalSettingsApi;
  globalProjection: WorkbenchGlobalProjection;
  onMutationError?: ((error: unknown, mutation: MutateDebruteGlobalSettingsInput) => void) | undefined;
}): WorkbenchGlobalSettingsController {
  const projectionState = useSyncExternalStore(
    input.globalProjection.subscribe,
    input.globalProjection.getState,
    input.globalProjection.getState
  );
  const confirmed = initializedGlobalProjection(projectionState).settings;
  const confirmedRef = useRef(confirmed);
  confirmedRef.current = confirmed;
  const lanesRef = useRef(new Map<string, MutationLane>());
  const [localVersion, refresh] = useReducer((version: number) => version + 1, 0);

  useEffect(() => {
    let changed = false;
    for (const lane of lanesRef.current.values()) {
      const laterPending = [
        ...lane.awaiting,
        ...(lane.inFlight ? [lane.inFlight.input] : []),
        ...lane.queued.map((task) => task.input)
      ];
      const nextAwaiting = lane.awaiting.filter((mutation, index) => {
        if (mutationSatisfied(mutation, confirmed)) return false;
        const key = mutationSupersessionKey(mutation);
        return !key || !laterPending.slice(index + 1).some((candidate) => (
          mutationSupersessionKey(candidate) === key && mutationSatisfied(candidate, confirmed)
        ));
      });
      if (nextAwaiting.length !== lane.awaiting.length) {
        lane.awaiting = nextAwaiting;
        changed = true;
      }
    }
    if (changed) refresh();
  }, [confirmed]);

  const mutate = useCallback((mutation: MutateDebruteGlobalSettingsInput): Promise<void> => {
    const laneKey = mutationLaneKey(mutation);
    const lanes = lanesRef.current;
    const lane = lanes.get(laneKey) ?? { running: false, queued: [], awaiting: [] };
    lanes.set(laneKey, lane);
    const effective = effectiveSettings(confirmedRef.current, lanes);
    if (mutationSatisfied(mutation, effective)) return Promise.resolve();

    const pending = new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      const supersessionKey = mutationSupersessionKey(mutation);
      const queued = supersessionKey
        ? [...lane.queued].reverse().find((task) => mutationSupersessionKey(task.input) === supersessionKey)
        : undefined;
      if (queued) {
        queued.input = mutation;
        queued.waiters.push(waiter);
      } else {
        lane.queued.push({ input: mutation, waiters: [waiter] });
      }
    });
    refresh();
    if (lane.running) return pending;

    lane.running = true;
    void (async () => {
      while (lane.queued.length > 0) {
        const task = lane.queued.shift();
        if (!task) break;
        lane.inFlight = task;
        refresh();
        try {
          await input.api.mutateGlobalSettings(task.input);
        } catch (error) {
          delete lane.inFlight;
          task.waiters.forEach((waiter) => waiter.reject(error));
          refresh();
          input.onMutationError?.(error, task.input);
          continue;
        }
        task.waiters.forEach((waiter) => waiter.resolve());
        delete lane.inFlight;
        if (isImmediateMutation(task.input)) {
          const supersessionKey = mutationSupersessionKey(task.input);
          if (mutationSatisfied(task.input, confirmedRef.current)) {
            if (supersessionKey) {
              lane.awaiting = lane.awaiting.filter((mutation) => (
                mutationSupersessionKey(mutation) !== supersessionKey
              ));
            }
          } else {
            lane.awaiting.push(task.input);
          }
        }
        refresh();
      }
      lane.running = false;
      refresh();
    })();
    return pending;
  }, [input.api, input.onMutationError]);

  return useMemo(() => ({
    settings: effectiveSettings(confirmed, lanesRef.current),
    mutate
  }), [confirmed, localVersion, mutate]);
}

function effectiveSettings(
  confirmed: DebruteGlobalSettingsView,
  lanes: ReadonlyMap<string, MutationLane>
): DebruteGlobalSettingsView {
  return [...lanes.values()].reduce((settings, lane) => (
    [...lane.awaiting, ...(lane.inFlight ? [lane.inFlight.input] : []), ...lane.queued.map((task) => task.input)]
      .filter(isImmediateMutation)
      .reduce(applyMutation, settings)
  ), confirmed);
}

function applyMutation(
  settings: DebruteGlobalSettingsView,
  mutation: MutateDebruteGlobalSettingsInput
): DebruteGlobalSettingsView {
  switch (mutation.operation) {
    case 'set-locale':
      return { ...settings, workbench: { ...settings.workbench, locale: mutation.locale } };
    case 'set-theme-preference':
      return {
        ...settings,
        workbench: { ...settings.workbench, themePreference: mutation.themePreference }
      };
    case 'set-canvas-text-appearance':
      return { ...settings, canvas: { ...settings.canvas, textAppearance: mutation.textAppearance } };
    case 'set-hierarchy-edges-visible':
      return {
        ...settings,
        canvas: { ...settings.canvas, hierarchyEdgesVisible: mutation.hierarchyEdgesVisible }
      };
    case 'create-feedback-mark': {
      if (settings.feedback.catalog.some((entry) => entry.name === mutation.name)) return settings;
      return {
        ...settings,
        feedback: {
          catalog: [...settings.feedback.catalog, { name: mutation.name, icon: mutation.icon }],
          actionBar: settings.feedback.actionBar
        }
      };
    }
    case 'set-feedback-mark-icon':
      return {
        ...settings,
        feedback: {
          ...settings.feedback,
          catalog: settings.feedback.catalog.map((entry) => entry.name === mutation.name
            ? { ...entry, icon: mutation.icon }
            : entry)
        }
      };
    case 'delete-feedback-mark':
      return {
        ...settings,
        feedback: {
          catalog: settings.feedback.catalog.filter((entry) => entry.name !== mutation.name),
          actionBar: settings.feedback.actionBar.filter((name) => name !== mutation.name)
        }
      };
    case 'set-feedback-action-bar':
      return { ...settings, feedback: { ...settings.feedback, actionBar: mutation.names } };
    case 'set-photoshop-plugin-enabled':
    case 'save-model-setting':
      return settings;
  }
}

function mutationSatisfied(
  mutation: MutateDebruteGlobalSettingsInput,
  settings: DebruteGlobalSettingsView
): boolean {
  switch (mutation.operation) {
    case 'set-locale': return settings.workbench.locale === mutation.locale;
    case 'set-theme-preference': return settings.workbench.themePreference === mutation.themePreference;
    case 'set-canvas-text-appearance': return sameValue(settings.canvas.textAppearance, mutation.textAppearance);
    case 'set-hierarchy-edges-visible': return settings.canvas.hierarchyEdgesVisible === mutation.hierarchyEdgesVisible;
    case 'create-feedback-mark': {
      const entry = settings.feedback.catalog.find((candidate) => candidate.name === mutation.name);
      return entry?.icon === mutation.icon;
    }
    case 'set-feedback-mark-icon':
      return settings.feedback.catalog.find((entry) => entry.name === mutation.name)?.icon === mutation.icon;
    case 'delete-feedback-mark':
      return !settings.feedback.catalog.some((entry) => entry.name === mutation.name)
        && !settings.feedback.actionBar.includes(mutation.name);
    case 'set-feedback-action-bar': return sameValue(settings.feedback.actionBar, mutation.names);
    case 'set-photoshop-plugin-enabled': return settings.plugins.photoshop.enabled === mutation.enabled;
    case 'save-model-setting': return false;
  }
}

function mutationLaneKey(mutation: MutateDebruteGlobalSettingsInput): string {
  if (mutation.operation.startsWith('set-feedback-') || mutation.operation === 'create-feedback-mark'
    || mutation.operation === 'delete-feedback-mark') return 'feedback';
  if (mutation.operation === 'save-model-setting') return `model:${mutation.modelId}`;
  return mutation.operation;
}

function mutationSupersessionKey(mutation: MutateDebruteGlobalSettingsInput): string | undefined {
  switch (mutation.operation) {
    case 'set-locale':
    case 'set-theme-preference':
    case 'set-canvas-text-appearance':
    case 'set-hierarchy-edges-visible':
    case 'set-feedback-action-bar':
    case 'set-photoshop-plugin-enabled':
      return mutation.operation;
    case 'set-feedback-mark-icon': return `${mutation.operation}:${mutation.name}`;
    case 'save-model-setting': return `${mutation.operation}:${mutation.modelId}`;
    case 'create-feedback-mark':
    case 'delete-feedback-mark':
      return undefined;
  }
}

function isImmediateMutation(mutation: MutateDebruteGlobalSettingsInput): boolean {
  return mutation.operation !== 'set-photoshop-plugin-enabled'
    && mutation.operation !== 'save-model-setting';
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type InitializedProjection = Exclude<WorkbenchGlobalProjectionState, { status: 'uninitialized' }>;

function initializedGlobalProjection(state: WorkbenchGlobalProjectionState): InitializedProjection {
  if (state.status === 'uninitialized') {
    throw new Error('Global settings require the initial Global snapshot.');
  }
  return state;
}
