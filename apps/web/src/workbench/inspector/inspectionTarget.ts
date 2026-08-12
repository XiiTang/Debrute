export type InspectionTarget =
  | { kind: 'empty' }
  | { kind: 'multiple'; count: number }
  | { kind: 'single'; projectRelativePath: string };

export interface InspectionTargetSnapshot {
  target: InspectionTarget;
  version: number;
}

export interface InspectionTargetStore {
  getSnapshot(): InspectionTargetSnapshot;
  subscribe(listener: () => void): () => void;
  publishPaths(projectRelativePaths: Iterable<string>): void;
  invalidatePath(projectRelativePath: string): void;
}

const INITIAL_SNAPSHOT: InspectionTargetSnapshot = {
  target: { kind: 'empty' },
  version: 0
};

export function createInspectionTargetStore(): InspectionTargetStore {
  let snapshot = INITIAL_SNAPSHOT;
  const listeners = new Set<() => void>();

  const publish = (target: InspectionTarget) => {
    snapshot = { target, version: snapshot.version + 1 };
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publishPaths: (projectRelativePaths) => {
      const paths = [...new Set(projectRelativePaths)].sort((left, right) => left.localeCompare(right));
      publish(paths.length === 0
        ? { kind: 'empty' }
        : paths.length === 1
          ? { kind: 'single', projectRelativePath: paths[0]! }
          : { kind: 'multiple', count: paths.length });
    },
    invalidatePath: (projectRelativePath) => {
      if (snapshot.target.kind === 'single'
        && snapshot.target.projectRelativePath === projectRelativePath
      ) {
        publish(snapshot.target);
      }
    }
  };
}
