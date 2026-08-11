import React from 'react';
import {
  canvasTextFontFaceDescriptors,
  readVerifiedCanvasTextFontFace,
  type CanvasTextFontResource,
  type CanvasTextRenderProfile
} from '../CanvasTextRenderProfile';
import {
  createCanvasTextPreviewFontSession,
  type CanvasTextPreviewFontSession,
  type CanvasTextPreviewFontSubsetMetrics
} from './CanvasTextPreviewFontSession';
import { removeCanvasTextFontFaces } from './CanvasTextFontFaces';

interface ActiveInteractiveFont {
  readonly resourceIdentity: string;
  readonly profile: CanvasTextRenderProfile;
  readonly faces: readonly FontFace[];
}

export class CanvasTextProjectFontEnvironment {
  readonly #document: Document;
  #resource: CanvasTextFontResource;
  #previewMetricsObserver:
    | ((metrics: CanvasTextPreviewFontSubsetMetrics) => void)
    | undefined;
  #interactiveQueue: Promise<void> = Promise.resolve();
  #activeInteractive: ActiveInteractiveFont | undefined;
  #interactiveTerminalFailure: Error | undefined;
  #interactiveAbortController: AbortController | undefined;
  #resourceVersion = 0;
  #disposed = false;

  constructor(profile: CanvasTextRenderProfile, document: Document) {
    this.#document = document;
    this.#resource = profile.font;
  }

  get activeInteractiveProfile(): CanvasTextRenderProfile | undefined {
    return this.#activeInteractive?.profile;
  }

  updateProfile(profile: CanvasTextRenderProfile): void {
    if (this.#disposed || this.#resource.identity === profile.font.identity) {
      return;
    }
    this.#resourceVersion += 1;
    this.#resource = profile.font;
    this.#interactiveTerminalFailure = undefined;
    this.#interactiveAbortController?.abort();
    this.#interactiveAbortController = undefined;
  }

  prepareInteractive(profile: CanvasTextRenderProfile): Promise<void> {
    const resource = profile.font;
    const resourceVersion = this.#resourceVersion;
    if (this.#disposed) {
      return Promise.reject(new Error('Canvas text project font environment was disposed.'));
    }
    if (resource.identity !== this.#resource.identity) {
      return Promise.reject(new Error('Canvas text render profile does not match the active project font.'));
    }
    if (this.#activeInteractive?.resourceIdentity === resource.identity) {
      this.#activeInteractive = { ...this.#activeInteractive, profile };
      return Promise.resolve();
    }
    if (this.#interactiveTerminalFailure) {
      return Promise.reject(this.#interactiveTerminalFailure);
    }
    return new Promise<void>((resolve, reject) => {
      this.#interactiveQueue = this.#interactiveQueue.then(async () => {
        try {
          if (this.#activeInteractive?.resourceIdentity === resource.identity) {
            this.#activeInteractive = { ...this.#activeInteractive, profile };
            resolve();
            return;
          }
          if (this.#interactiveTerminalFailure) {
            throw this.#interactiveTerminalFailure;
          }
          const candidate = await this.#loadInteractiveCandidate(profile, resourceVersion);
          this.#assertCurrentResource(resource, resourceVersion);
          const previous = this.#activeInteractive;
          for (const face of candidate.faces) {
            this.#document.fonts.add(face);
          }
          this.#activeInteractive = candidate;
          if (previous) {
            removeCanvasTextFontFaces(this.#document, previous.faces);
          }
          resolve();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (resourceVersion === this.#resourceVersion && !this.#disposed) {
            this.#interactiveTerminalFailure = failure;
          }
          reject(failure);
        }
      });
    });
  }

  setPreviewMetricsObserver(
    observer: ((metrics: CanvasTextPreviewFontSubsetMetrics) => void) | undefined
  ): void {
    this.#previewMetricsObserver = observer;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#resourceVersion += 1;
    this.#interactiveAbortController?.abort();
    this.#interactiveAbortController = undefined;
    if (this.#activeInteractive) {
      removeCanvasTextFontFaces(this.#document, this.#activeInteractive.faces);
      this.#activeInteractive = undefined;
    }
    this.#previewMetricsObserver = undefined;
  }

  async #loadInteractiveCandidate(
    profile: CanvasTextRenderProfile,
    resourceVersion: number
  ): Promise<ActiveInteractiveFont> {
    const resource = profile.font;
    this.#assertCurrentResource(resource, resourceVersion);
    const abortController = new AbortController();
    this.#interactiveAbortController = abortController;
    const faces: FontFace[] = [];
    try {
      for (const family of resource.families) {
        for (const sourceFace of family.faces) {
          const bytes = await readVerifiedCanvasTextFontFace(sourceFace, abortController.signal);
          this.#assertCurrentResource(resource, resourceVersion);
          const face = new FontFace(
            family.interactiveAlias,
            bytes,
            canvasTextFontFaceDescriptors(sourceFace)
          );
          await face.load();
          this.#assertCurrentResource(resource, resourceVersion);
          faces.push(face);
        }
      }
      return { resourceIdentity: resource.identity, profile, faces };
    } finally {
      if (this.#interactiveAbortController === abortController) {
        this.#interactiveAbortController = undefined;
      }
    }
  }

  #assertCurrentResource(resource: CanvasTextFontResource, resourceVersion: number): void {
    if (this.#disposed
      || resourceVersion !== this.#resourceVersion
      || resource.identity !== this.#resource.identity) {
      throw new DOMException('Canvas text project font preparation was invalidated.', 'AbortError');
    }
  }

  reportPreviewMetrics(metrics: CanvasTextPreviewFontSubsetMetrics): void {
    this.#previewMetricsObserver?.(metrics);
  }
}

export interface CanvasTextProjectFontEnvironmentValue {
  readonly previewSession: CanvasTextPreviewFontSession;
  readonly activeInteractiveProfile: CanvasTextRenderProfile | undefined;
  prepareInteractive(profile: CanvasTextRenderProfile): Promise<void>;
  setPreviewMetricsObserver(
    observer: ((metrics: CanvasTextPreviewFontSubsetMetrics) => void) | undefined
  ): void;
}

const CanvasTextProjectFontEnvironmentContext = React.createContext<
  CanvasTextProjectFontEnvironmentValue | undefined
>(undefined);

export function CanvasTextProjectFontEnvironmentProvider({
  profile,
  children
}: {
  readonly profile: CanvasTextRenderProfile;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const environmentRef = React.useRef<CanvasTextProjectFontEnvironment | undefined>(undefined);
  const lifecycleEpochRef = React.useRef(0);
  if (!environmentRef.current) {
    environmentRef.current = new CanvasTextProjectFontEnvironment(profile, document);
  }
  const environment = environmentRef.current;
  const previewSession = React.useMemo(() => createCanvasTextPreviewFontSession({
    resource: profile.font,
    document,
    onSubsetMetrics: (metrics) => environment.reportPreviewMetrics(metrics)
  }), [environment, profile.font.identity]);
  const previewSessionEpochsRef = React.useRef(new WeakMap<CanvasTextPreviewFontSession, number>());
  React.useLayoutEffect(() => {
    environment.updateProfile(profile);
  }, [environment, profile.font.identity]);
  React.useEffect(() => {
    lifecycleEpochRef.current += 1;
    return () => {
      const cleanupEpoch = lifecycleEpochRef.current + 1;
      lifecycleEpochRef.current = cleanupEpoch;
      queueMicrotask(() => {
        if (lifecycleEpochRef.current === cleanupEpoch) {
          environment?.dispose();
        }
      });
    };
  }, []);
  React.useEffect(() => {
    const epochs = previewSessionEpochsRef.current;
    epochs.set(previewSession, (epochs.get(previewSession) ?? 0) + 1);
    return () => {
      const cleanupEpoch = (epochs.get(previewSession) ?? 0) + 1;
      epochs.set(previewSession, cleanupEpoch);
      queueMicrotask(() => {
        if (epochs.get(previewSession) === cleanupEpoch) {
          epochs.delete(previewSession);
          previewSession.dispose();
        }
      });
    };
  }, [previewSession]);
  const value = React.useMemo<CanvasTextProjectFontEnvironmentValue>(() => ({
    previewSession,
    get activeInteractiveProfile() {
      return environment.activeInteractiveProfile;
    },
    prepareInteractive: (requestedProfile) => environment.prepareInteractive(requestedProfile),
    setPreviewMetricsObserver: (observer) => environment.setPreviewMetricsObserver(observer)
  }), [environment, previewSession]);
  return (
    <CanvasTextProjectFontEnvironmentContext.Provider value={value}>
      {children}
    </CanvasTextProjectFontEnvironmentContext.Provider>
  );
}

export function useCanvasTextProjectFontEnvironment(): CanvasTextProjectFontEnvironmentValue {
  const environment = React.useContext(CanvasTextProjectFontEnvironmentContext);
  if (!environment) {
    throw new Error('CanvasTextProjectFontEnvironmentProvider is required.');
  }
  return environment;
}
