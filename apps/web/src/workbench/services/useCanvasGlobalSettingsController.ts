import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CanvasTextAppearance,
  DebruteGlobalSettingsView,
  SaveDebruteGlobalSettingsInput
} from '@debrute/app-protocol';
import type {
  WorkbenchGlobalProjection,
  WorkbenchGlobalProjectionState
} from './WorkbenchGlobalProjection.js';

export type CanvasGlobalSettings = DebruteGlobalSettingsView['canvas'];
export type CanvasGlobalSettingsPatch = NonNullable<SaveDebruteGlobalSettingsInput['canvas']>;

export interface CanvasGlobalSettingsController {
  settings: CanvasGlobalSettings;
  save(patch: CanvasGlobalSettingsPatch): Promise<void>;
}

interface SaveWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface SaveTask {
  patch: CanvasGlobalSettingsPatch;
  waiters: SaveWaiter[];
}

interface InFlightSaveTask extends SaveTask {
  confirmedFields: Set<keyof CanvasGlobalSettings>;
}

interface CanvasSettingsSaveQueue {
  running: boolean;
  inFlight?: InFlightSaveTask;
  queued?: SaveTask;
  awaitingEvent?: CanvasGlobalSettingsPatch;
}

type CanvasGlobalSettingsApi = {
  globalSettingsSave(input: SaveDebruteGlobalSettingsInput): Promise<{ ok: true }>;
};

export function useCanvasGlobalSettingsController(input: {
  api: CanvasGlobalSettingsApi;
  globalProjection: WorkbenchGlobalProjection;
  onSaveError?: ((error: unknown, patch: CanvasGlobalSettingsPatch) => void) | undefined;
}): CanvasGlobalSettingsController {
  const projectionState = useSyncExternalStore(
    input.globalProjection.subscribe,
    input.globalProjection.getState,
    input.globalProjection.getState
  );
  const projection = initializedGlobalProjection(projectionState);
  const confirmed = projection.settings.canvas;
  const confirmedRef = useRef(confirmed);
  confirmedRef.current = confirmed;
  const queueRef = useRef<CanvasSettingsSaveQueue>({ running: false });
  const [localPatch, setLocalPatch] = useState<CanvasGlobalSettingsPatch>({});

  const publishLocalPatch = useCallback(() => {
    const next = localCanvasSettingsPatch(queueRef.current);
    setLocalPatch((current) => sameCanvasSettingsPatch(current, next) ? current : next);
  }, []);

  useEffect(() => {
    const queue = queueRef.current;
    setAwaitingCanvasSettingsPatch(
      queue,
      patchWithoutConfirmedFields(queue.awaitingEvent, confirmed)
    );
    const inFlight = queue.inFlight;
    if (inFlight) {
      for (const field of canvasSettingsPatchFields(inFlight.patch)) {
        if (sameCanvasSettingField(field, inFlight.patch[field], confirmed[field])) {
          inFlight.confirmedFields.add(field);
        }
      }
    }
    publishLocalPatch();
  }, [confirmed, publishLocalPatch]);

  const save = useCallback((candidate: CanvasGlobalSettingsPatch): Promise<void> => {
    const patch = normalizedCanvasSettingsPatch(candidate);
    if (canvasSettingsPatchFields(patch).length === 0) {
      return Promise.reject(new Error('Canvas global settings patch must contain one setting.'));
    }
    const queue = queueRef.current;
    const effective = canvasSettingsWithPatch(
      confirmedRef.current,
      localCanvasSettingsPatch(queue)
    );
    if (canvasSettingsPatchMatches(patch, effective)) {
      return Promise.resolve();
    }
    const retainedAwaiting = patchWithoutFields(
      queue.awaitingEvent ?? {},
      new Set(canvasSettingsPatchFields(patch))
    );
    setAwaitingCanvasSettingsPatch(queue, retainedAwaiting);

    const pending = new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      if (queue.queued) {
        queue.queued.patch = mergeCanvasSettingsPatches(queue.queued.patch, patch);
        queue.queued.waiters.push(waiter);
      } else {
        queue.queued = { patch, waiters: [waiter] };
      }
    });
    publishLocalPatch();
    if (queue.running) {
      return pending;
    }

    queue.running = true;
    void (async () => {
      while (true) {
        const task = takeQueuedCanvasSettingsTask(queue);
        if (!task) {
          break;
        }
        const inFlight: InFlightSaveTask = {
          ...task,
          confirmedFields: new Set()
        };
        queue.inFlight = inFlight;
        publishLocalPatch();
        try {
          await input.api.globalSettingsSave({ canvas: task.patch });
        } catch (error) {
          delete queue.inFlight;
          const queued = takeQueuedCanvasSettingsTask(queue);
          queue.running = false;
          task.waiters.forEach((waiter) => waiter.reject(error));
          queued?.waiters.forEach((waiter) => waiter.reject(error));
          publishLocalPatch();
          input.onSaveError?.(error, mergeCanvasSettingsPatches(task.patch, queued?.patch));
          return;
        }

        task.waiters.forEach((waiter) => waiter.resolve());
        delete queue.inFlight;
        const awaiting = patchWithoutFields(task.patch, inFlight.confirmedFields);
        setAwaitingCanvasSettingsPatch(
          queue,
          mergeCanvasSettingsPatches(queue.awaitingEvent, awaiting)
        );
        publishLocalPatch();
      }
      queue.running = false;
      publishLocalPatch();
    })();
    return pending;
  }, [input.api, input.onSaveError, publishLocalPatch]);

  return useMemo(() => ({
    settings: canvasSettingsWithPatch(confirmed, localPatch),
    save
  }), [confirmed, localPatch, save]);
}

function localCanvasSettingsPatch(queue: CanvasSettingsSaveQueue): CanvasGlobalSettingsPatch {
  return mergeCanvasSettingsPatches(
    queue.awaitingEvent,
    queue.inFlight?.patch,
    queue.queued?.patch
  );
}

function takeQueuedCanvasSettingsTask(
  queue: CanvasSettingsSaveQueue
): SaveTask | undefined {
  const task = queue.queued;
  delete queue.queued;
  return task;
}

function setAwaitingCanvasSettingsPatch(
  queue: CanvasSettingsSaveQueue,
  patch: CanvasGlobalSettingsPatch | undefined
): void {
  if (patch && canvasSettingsPatchFields(patch).length > 0) {
    queue.awaitingEvent = patch;
  } else {
    delete queue.awaitingEvent;
  }
}

function normalizedCanvasSettingsPatch(patch: CanvasGlobalSettingsPatch): CanvasGlobalSettingsPatch {
  return {
    ...(patch.textAppearance === undefined ? {} : { textAppearance: patch.textAppearance }),
    ...(patch.hierarchyEdgesVisible === undefined
      ? {}
      : { hierarchyEdgesVisible: patch.hierarchyEdgesVisible })
  };
}

function mergeCanvasSettingsPatches(
  ...patches: Array<CanvasGlobalSettingsPatch | undefined>
): CanvasGlobalSettingsPatch {
  return patches.reduce<CanvasGlobalSettingsPatch>(
    (merged, patch) => patch ? { ...merged, ...patch } : merged,
    {}
  );
}

function canvasSettingsWithPatch(
  settings: CanvasGlobalSettings,
  patch: CanvasGlobalSettingsPatch
): CanvasGlobalSettings {
  return { ...settings, ...patch };
}

function canvasSettingsPatchFields(
  patch: CanvasGlobalSettingsPatch
): Array<keyof CanvasGlobalSettings> {
  return [
    ...(patch.textAppearance === undefined ? [] : ['textAppearance' as const]),
    ...(patch.hierarchyEdgesVisible === undefined ? [] : ['hierarchyEdgesVisible' as const])
  ];
}

function canvasSettingsPatchMatches(
  patch: CanvasGlobalSettingsPatch,
  settings: CanvasGlobalSettings
): boolean {
  return canvasSettingsPatchFields(patch).every((field) => (
    sameCanvasSettingField(field, patch[field], settings[field])
  ));
}

function patchWithoutConfirmedFields(
  patch: CanvasGlobalSettingsPatch | undefined,
  confirmed: CanvasGlobalSettings
): CanvasGlobalSettingsPatch | undefined {
  if (!patch) {
    return undefined;
  }
  const remaining = patchWithoutFields(
    patch,
    new Set(canvasSettingsPatchFields(patch).filter((field) => (
      sameCanvasSettingField(field, patch[field], confirmed[field])
    )))
  );
  return canvasSettingsPatchFields(remaining).length === 0 ? undefined : remaining;
}

function patchWithoutFields(
  patch: CanvasGlobalSettingsPatch,
  fields: ReadonlySet<keyof CanvasGlobalSettings>
): CanvasGlobalSettingsPatch {
  return {
    ...(patch.textAppearance === undefined || fields.has('textAppearance')
      ? {}
      : { textAppearance: patch.textAppearance }),
    ...(patch.hierarchyEdgesVisible === undefined || fields.has('hierarchyEdgesVisible')
      ? {}
      : { hierarchyEdgesVisible: patch.hierarchyEdgesVisible })
  };
}

function sameCanvasSettingsPatch(
  left: CanvasGlobalSettingsPatch,
  right: CanvasGlobalSettingsPatch
): boolean {
  const leftFields = canvasSettingsPatchFields(left);
  const rightFields = canvasSettingsPatchFields(right);
  return leftFields.length === rightFields.length
    && leftFields.every((field) => (
      rightFields.includes(field) && sameCanvasSettingField(field, left[field], right[field])
    ));
}

function sameCanvasSettingField<Field extends keyof CanvasGlobalSettings>(
  field: Field,
  left: CanvasGlobalSettings[Field] | undefined,
  right: CanvasGlobalSettings[Field] | undefined
): boolean {
  if (field === 'hierarchyEdgesVisible') {
    return left === right;
  }
  return sameCanvasTextAppearance(
    left as CanvasTextAppearance | undefined,
    right as CanvasTextAppearance | undefined
  );
}

function sameCanvasTextAppearance(
  left: CanvasTextAppearance | undefined,
  right: CanvasTextAppearance | undefined
): boolean {
  return Boolean(
    left
    && right
    && left.fontId === right.fontId
    && left.fontSizePx === right.fontSizePx
    && left.lineHeightRatio === right.lineHeightRatio
    && left.fontWeight === right.fontWeight
    && left.letterSpacingPx === right.letterSpacingPx
    && left.ligatures === right.ligatures
  );
}

type InitializedWorkbenchGlobalProjection = Exclude<
  WorkbenchGlobalProjectionState,
  { status: 'uninitialized' }
>;

function initializedGlobalProjection(
  state: WorkbenchGlobalProjectionState
): InitializedWorkbenchGlobalProjection {
  if (state.status === 'uninitialized') {
    throw new Error('Canvas global settings require the initial Global snapshot.');
  }
  return state;
}
