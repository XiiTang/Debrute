export type ProjectWindowOpenTarget =
  | { kind: 'focus'; windowId: number }
  | { kind: 'reuse'; windowId: number }
  | { kind: 'new-window' };

export function selectProjectWindowOpenTarget(input: {
  projectId: string;
  sourceWindowId?: number;
  forceNewWindow: boolean;
  windowIdByProjectId: ReadonlyMap<string, number>;
  liveWindowIds: ReadonlySet<number>;
}): ProjectWindowOpenTarget {
  const existingWindowId = input.windowIdByProjectId.get(input.projectId);
  if (existingWindowId !== undefined && input.liveWindowIds.has(existingWindowId)) {
    return { kind: 'focus', windowId: existingWindowId };
  }
  if (!input.forceNewWindow && input.sourceWindowId !== undefined && input.liveWindowIds.has(input.sourceWindowId)) {
    return { kind: 'reuse', windowId: input.sourceWindowId };
  }
  return { kind: 'new-window' };
}

export async function runProjectWindowOpenOnce(input: {
  projectId: string;
  pendingProjectOpens: Map<string, Promise<void>>;
  open: () => Promise<void>;
  reusePending: () => void | Promise<void>;
}): Promise<void> {
  const pending = input.pendingProjectOpens.get(input.projectId);
  if (pending) {
    await pending;
    await input.reusePending();
    return;
  }

  let run!: Promise<void>;
  run = Promise.resolve()
    .then(input.open)
    .finally(() => {
      if (input.pendingProjectOpens.get(input.projectId) === run) {
        input.pendingProjectOpens.delete(input.projectId);
      }
    });
  input.pendingProjectOpens.set(input.projectId, run);
  await run;
}
