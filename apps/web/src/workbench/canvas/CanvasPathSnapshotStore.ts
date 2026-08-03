export interface CanvasPathSnapshotNode {
  readonly projectRelativePath: string;
}

export interface CanvasPathSnapshotStore<Node extends CanvasPathSnapshotNode, Snapshot> {
  getSnapshot(node: Node): Snapshot;
  subscribe(node: Node, listener: () => void): () => void;
  flush(changedPaths: ReadonlySet<string>): void;
}

export function createCanvasPathSnapshotStore<
  Node extends CanvasPathSnapshotNode,
  Snapshot
>(input: {
  deriveSnapshot(node: Node): Snapshot;
  snapshotsEqual(left: Snapshot, right: Snapshot): boolean;
}): CanvasPathSnapshotStore<Node, Snapshot> {
  const listenersByPath = new Map<string, Map<() => void, Node>>();
  const cachedByNode = new WeakMap<Node, Snapshot>();

  const getSnapshot = (node: Node): Snapshot => {
    const next = input.deriveSnapshot(node);
    const hasCached = cachedByNode.has(node);
    const cached = cachedByNode.get(node);
    if (hasCached && input.snapshotsEqual(cached as Snapshot, next)) {
      return cached as Snapshot;
    }
    cachedByNode.set(node, next);
    return next;
  };

  return {
    getSnapshot,
    subscribe(node, listener) {
      const path = node.projectRelativePath;
      const listeners = listenersByPath.get(path);
      if (listeners) {
        listeners.set(listener, node);
      } else {
        listenersByPath.set(path, new Map([[listener, node]]));
      }
      return () => {
        const current = listenersByPath.get(path);
        current?.delete(listener);
        if (current?.size === 0) {
          listenersByPath.delete(path);
        }
      };
    },
    flush(changedPaths) {
      for (const path of changedPaths) {
        const listeners = listenersByPath.get(path);
        if (!listeners) {
          continue;
        }
        const changedNodes = new Set<Node>();
        for (const node of new Set(listeners.values())) {
          const hasPrevious = cachedByNode.has(node);
          const previous = cachedByNode.get(node);
          if (hasPrevious && getSnapshot(node) !== previous) {
            changedNodes.add(node);
          }
        }
        for (const [listener, node] of listeners) {
          if (changedNodes.has(node)) {
            listener();
          }
        }
      }
    }
  };
}

export function canvasChangedRecordPaths<Value>(
  previous: Readonly<Record<string, Value>>,
  next: Readonly<Record<string, Value>>
): string[] {
  const paths = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...paths].filter((path) => previous[path] !== next[path]);
}

export function canvasRecordValuesEqual<Value>(
  left: Readonly<Record<string, Value>>,
  right: Readonly<Record<string, Value>>,
  equals: (leftValue: Value, rightValue: Value) => boolean = Object.is
): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length
    && leftEntries.every(([key, value]) => key in right && equals(value, right[key]!));
}

export function canvasRecordsMatchingTargetKeys<Value extends { readonly targetKey: string }>(
  current: Readonly<Record<string, Value>>,
  currentTargetKeys: ReadonlyMap<string, string>
): Record<string, Value> {
  return Object.fromEntries(Object.entries(current).filter(([path, value]) => (
    currentTargetKeys.get(path) === value.targetKey
  )));
}
