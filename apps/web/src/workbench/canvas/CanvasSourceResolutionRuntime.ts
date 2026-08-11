import type {
  CanvasFeedbackVideoResource,
  CanvasSourceResolutionResponse
} from '@debrute/app-protocol';
import type { CanvasProjection, ProjectedCanvasNode } from './CanvasScene';
import type { CanvasSceneActions } from './CanvasSceneActions';
import { compareCanvasPreviewPaths } from './CanvasPreviewScheduling';
import { createCanvasPathSnapshotStore } from './CanvasPathSnapshotStore';
import type {
  CanvasEditorRuntime,
  CanvasRuntimePointerInteraction
} from './runtime/CanvasEditorRuntime';

type CanvasResolvedSource = CanvasSourceResolutionResponse['sources'][number];
type CanvasSourceCandidate = ProjectedCanvasNode | CanvasFeedbackVideoResource;

type CanvasSourceResult = {
  readonly sourceToken: string;
  readonly source?: CanvasResolvedSource | undefined;
  readonly error?: string | undefined;
};

type CanvasSourceInteractionRuntime = Pick<
  CanvasEditorRuntime,
  'getSnapshot' | 'subscribeCameraState' | 'subscribePointerInteraction'
>;

export interface CanvasSourceResolutionRuntime {
  attach(): () => void;
  acceptProjection(
    projection: CanvasProjection,
    feedbackVideoResources?: readonly CanvasFeedbackVideoResource[]
  ): void;
  getNodeSnapshot(node: ProjectedCanvasNode): ProjectedCanvasNode;
  getNode(projectRelativePath: string): ProjectedCanvasNode | undefined;
  getResolvedSource(projectRelativePath: string): CanvasResolvedSource | undefined;
  getSourceVersion(): number;
  subscribeSources(listener: () => void): () => void;
  subscribeNode(node: ProjectedCanvasNode, listener: () => void): () => void;
}

export function createCanvasSourceResolutionRuntime(input: {
  runtime: CanvasSourceInteractionRuntime;
  resolveCanvasSources: CanvasSceneActions['resolveCanvasSources'];
  distanceSquaredForNode(projectRelativePath: string): number;
}): CanvasSourceResolutionRuntime {
  let nodesByPath = new Map<string, ProjectedCanvasNode>();
  let feedbackVideoResourcesByPath = new Map<string, CanvasFeedbackVideoResource>();
  let resultsByPath = new Map<string, CanvasSourceResult>();
  let attemptedSources = new Set<string>();
  let queue: readonly CanvasSourceCandidate[] = [];
  let queueIndex = 0;
  let requestInFlight = false;
  let active = false;
  let attached = false;
  let unsubscribeCameraState: () => void = () => undefined;
  let unsubscribePointerInteraction: () => void = () => undefined;
  let sourceVersion = 0;
  const sourceListeners = new Set<() => void>();
  const snapshotCache = new WeakMap<ProjectedCanvasNode, {
    result: CanvasSourceResult | undefined;
    snapshot: ProjectedCanvasNode;
  }>();

  const currentCandidate = (projectRelativePath: string): CanvasSourceCandidate | undefined => (
    nodesByPath.get(projectRelativePath) ?? feedbackVideoResourcesByPath.get(projectRelativePath)
  );
  const currentCandidates = (): readonly CanvasSourceCandidate[] => [
    ...nodesByPath.values(),
    ...[...feedbackVideoResourcesByPath].flatMap(([path, resource]) => (
      nodesByPath.has(path) ? [] : [resource]
    ))
  ];
  const resultForCandidate = (node: CanvasSourceCandidate): CanvasSourceResult | undefined => {
    if (node.availability.state !== 'resolving') {
      return undefined;
    }
    const result = resultsByPath.get(node.projectRelativePath);
    return result?.sourceToken === node.availability.sourceToken ? result : undefined;
  };
  const deriveNodeSnapshot = (node: ProjectedCanvasNode): ProjectedCanvasNode => {
    const result = resultForCandidate(node);
    const cached = snapshotCache.get(node);
    if (cached && cached.result === result) {
      return cached.snapshot;
    }
    let snapshot = node;
    if (result?.error) {
      snapshot = {
        ...node,
        availability: { state: 'unreadable', message: result.error }
      };
    } else if (result?.source) {
      snapshot = {
        ...node,
        availability: result.source.availability,
        ...(result.source.videoTextTracks ? { videoTextTracks: result.source.videoTextTracks } : {})
      };
    }
    snapshotCache.set(node, { result, snapshot });
    return snapshot;
  };
  const nodeSnapshotStore = createCanvasPathSnapshotStore({
    deriveSnapshot: deriveNodeSnapshot,
    snapshotsEqual: Object.is
  });

  const publishPaths = (paths: ReadonlySet<string>) => {
    if (paths.size === 0) {
      return;
    }
    nodeSnapshotStore.flush(paths);
  };
  const publishSources = () => {
    sourceVersion += 1;
    for (const listener of sourceListeners) listener();
  };

  const publishFailure = (projectRelativePath: string, sourceToken: string, error: unknown) => {
    const current = currentCandidate(projectRelativePath);
    if (current?.availability.state !== 'resolving'
      || current.availability.sourceToken !== sourceToken) {
      return;
    }
    resultsByPath.set(projectRelativePath, {
      sourceToken,
      error: error instanceof Error ? error.message : String(error)
    });
    publishPaths(new Set([projectRelativePath]));
    publishSources();
  };

  const sourceKey = (node: CanvasSourceCandidate): string | undefined => (
    node.availability.state === 'resolving'
      ? `${node.projectRelativePath}\u001f${node.availability.sourceToken}`
      : undefined
  );

  const rebuildQueue = () => {
    queue = currentCandidates()
      .filter((node) => node.availability.state === 'resolving' && node.mediaKind !== 'unknown')
      .sort((left, right) => (
        input.distanceSquaredForNode(left.projectRelativePath)
          - input.distanceSquaredForNode(right.projectRelativePath)
        || compareCanvasPreviewPaths(left.projectRelativePath, right.projectRelativePath)
      ));
    queueIndex = 0;
  };

  const canDispatch = (): boolean => {
    const snapshot = input.runtime.getSnapshot();
    return active
      && !requestInFlight
      && snapshot.cameraState === 'idle'
      && snapshot.pointerInteraction === undefined;
  };

  const drain = () => {
    if (!canDispatch()) {
      return;
    }
    let candidate: CanvasSourceCandidate | undefined;
    while (queueIndex < queue.length) {
      const queued = queue[queueIndex];
      queueIndex += 1;
      if (!queued || queued.availability.state !== 'resolving') {
        continue;
      }
      const current = currentCandidate(queued.projectRelativePath);
      if (current?.availability.state !== 'resolving'
        || current.availability.sourceToken !== queued.availability.sourceToken) {
        continue;
      }
      const key = sourceKey(queued);
      if (!key || attemptedSources.has(key) || resultForCandidate(queued)) {
        continue;
      }
      candidate = queued;
      break;
    }
    if (!candidate || candidate.availability.state !== 'resolving') {
      return;
    }
    const projectRelativePath = candidate.projectRelativePath;
    const sourceToken = candidate.availability.sourceToken;
    attemptedSources.add(`${projectRelativePath}\u001f${sourceToken}`);
    requestInFlight = true;
    void input.resolveCanvasSources({
      targets: [{ projectRelativePath, sourceToken }]
    }).then((response) => {
      const source = response.sources.find((candidate) => (
        candidate.projectRelativePath === projectRelativePath
        && candidate.sourceToken === sourceToken
      ));
      const current = currentCandidate(projectRelativePath);
      if (!source
        || current?.availability.state !== 'resolving'
        || current.availability.sourceToken !== sourceToken) {
        publishFailure(
          projectRelativePath,
          sourceToken,
          `Runtime did not resolve Canvas source: ${projectRelativePath}`
        );
        return;
      }
      resultsByPath.set(projectRelativePath, { sourceToken, source });
      publishPaths(new Set([projectRelativePath]));
      publishSources();
    }).catch((error: unknown) => {
      publishFailure(projectRelativePath, sourceToken, error);
    }).finally(() => {
      requestInFlight = false;
      drain();
    });
  };

  const schedule = () => {
    rebuildQueue();
    drain();
  };

  const attach = (): (() => void) => {
    if (attached) {
      return () => undefined;
    }
    attached = true;
    active = true;
    unsubscribeCameraState = input.runtime.subscribeCameraState((state) => {
      if (state === 'idle') {
        schedule();
      }
    });
    unsubscribePointerInteraction = input.runtime.subscribePointerInteraction((
      interaction: CanvasRuntimePointerInteraction | undefined
    ) => {
      if (interaction === undefined) {
        schedule();
      }
    });
    schedule();
    return () => {
      if (!attached) {
        return;
      }
      attached = false;
      active = false;
      unsubscribeCameraState();
      unsubscribePointerInteraction();
      unsubscribeCameraState = () => undefined;
      unsubscribePointerInteraction = () => undefined;
    };
  };

  return {
    attach,
    acceptProjection(projection, feedbackVideoResources = []) {
      const previousResults = resultsByPath;
      nodesByPath = new Map(projection.nodes.map((node) => [node.projectRelativePath, node]));
      feedbackVideoResourcesByPath = new Map(feedbackVideoResources.flatMap((resource) => (
        resource.nodeKind === 'file' && resource.mediaKind === 'video'
          ? [[resource.projectRelativePath, resource] as const]
          : []
      )));
      const currentKeys = new Set(currentCandidates().flatMap((node) => {
        const key = sourceKey(node);
        return key ? [key] : [];
      }));
      attemptedSources = new Set([...attemptedSources].filter((key) => currentKeys.has(key)));
      resultsByPath = new Map([...resultsByPath].filter(([path, result]) => {
        const node = currentCandidate(path);
        return node?.availability.state === 'resolving'
          && node.availability.sourceToken === result.sourceToken;
      }));
      publishPaths(new Set([...previousResults.keys()].filter((path) => !resultsByPath.has(path))));
      publishSources();
      schedule();
    },
    getNodeSnapshot: nodeSnapshotStore.getSnapshot,
    getNode(projectRelativePath) {
      const node = nodesByPath.get(projectRelativePath);
      return node ? deriveNodeSnapshot(node) : undefined;
    },
    getResolvedSource(projectRelativePath) {
      const candidate = currentCandidate(projectRelativePath);
      return candidate ? resultForCandidate(candidate)?.source : undefined;
    },
    getSourceVersion: () => sourceVersion,
    subscribeSources(listener) {
      sourceListeners.add(listener);
      return () => sourceListeners.delete(listener);
    },
    subscribeNode: nodeSnapshotStore.subscribe
  };
}
