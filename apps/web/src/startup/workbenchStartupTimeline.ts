export type WorkbenchStartupFeature =
  | 'settings'
  | 'explorer'
  | 'inspector'
  | 'terminal'
  | 'text-editor';

export type WorkbenchStartupMilestone =
  | 'main-evaluated'
  | 'global-snapshot-ready'
  | 'theme-ready'
  | 'workbench-chunk-ready'
  | 'react-committed'
  | 'shell-fonts-ready'
  | 'project-open-surface-committed'
  | 'project-open-requested'
  | 'project-surface-committed'
  | 'canvas-text-ready'
  | `feature-requested:${WorkbenchStartupFeature}`
  | `feature-ready:${WorkbenchStartupFeature}`;

export interface WorkbenchStartupRecord {
  milestone: WorkbenchStartupMilestone;
  elapsedMs: number;
}

export interface WorkbenchStartupTimeline {
  readonly enabled: boolean;
  mark(milestone: WorkbenchStartupMilestone): void;
  markFeatureRequested(feature: WorkbenchStartupFeature): void;
  markFeatureReady(feature: WorkbenchStartupFeature): void;
  snapshot(): readonly WorkbenchStartupRecord[];
}

export function createWorkbenchStartupTimeline(input: {
  enabled: boolean;
  originMs?: number;
  now(): number;
  mark(name: string): void;
  publish(record: WorkbenchStartupRecord): void;
}): WorkbenchStartupTimeline {
  const origin = input.originMs ?? 0;
  const records: WorkbenchStartupRecord[] = [];
  const milestones = new Set<WorkbenchStartupMilestone>();
  const record = (milestone: WorkbenchStartupMilestone): void => {
    if (!input.enabled || milestones.has(milestone)) {
      return;
    }
    milestones.add(milestone);
    const entry = { milestone, elapsedMs: input.now() - origin };
    records.push(entry);
    input.mark(`debrute:startup:${milestone}`);
    input.publish(entry);
  };
  return {
    enabled: input.enabled,
    mark: record,
    markFeatureRequested: (feature) => record(`feature-requested:${feature}`),
    markFeatureReady: (feature) => record(`feature-ready:${feature}`),
    snapshot: () => records
  };
}

export const workbenchStartupTimeline = createWorkbenchStartupTimeline({
  enabled: typeof __DEBRUTE_STARTUP_PERF__ !== 'undefined' && __DEBRUTE_STARTUP_PERF__,
  originMs: 0,
  now: () => performance.now(),
  mark: (name) => performance.mark(name),
  publish: (record) => console.info('[Debrute startup]', record)
});
