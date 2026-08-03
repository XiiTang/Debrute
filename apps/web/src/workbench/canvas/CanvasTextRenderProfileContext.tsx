import React from 'react';
import type { CanvasTextRenderProfile } from './CanvasTextRenderProfile.js';
import { useCanvasTextProjectFontEnvironment } from './font-subset/CanvasTextProjectFontEnvironment.js';

interface CanvasTextRenderProfileContextValue {
  readonly profile: CanvasTextRenderProfile;
  readonly interactiveReady: boolean;
}

const CanvasTextRenderProfileContext = React.createContext<
  CanvasTextRenderProfileContextValue | undefined
>(undefined);

export function CanvasTextRenderProfileProvider({
  profile,
  children
}: {
  profile: CanvasTextRenderProfile;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <CanvasTextRenderProfileContext.Provider value={{ profile, interactiveReady: false }}>
      {children}
    </CanvasTextRenderProfileContext.Provider>
  );
}

export function CanvasTextRenderProfileGate({
  profile,
  pending,
  requireExactProfile = false,
  onReady,
  onError,
  children
}: {
  profile: CanvasTextRenderProfile;
  pending: React.ReactNode;
  requireExactProfile?: boolean | undefined;
  onReady?: (() => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  const fontEnvironment = useCanvasTextProjectFontEnvironment();
  const inherited = React.useContext(CanvasTextRenderProfileContext);
  const inheritedProfile = inherited?.interactiveReady
    ? inherited.profile
    : fontEnvironment.activeInteractiveProfile;
  const requestedProfileRef = React.useRef(profile);
  const onErrorRef = React.useRef(onError);
  requestedProfileRef.current = profile;
  onErrorRef.current = onError;
  const [state, setState] = React.useState<{
    requestedIdentity: string;
    active?: CanvasTextRenderProfile | undefined;
    error?: Error | undefined;
  }>({ requestedIdentity: profile.identity, active: inheritedProfile });

  React.useEffect(() => {
    const requestedProfile = requestedProfileRef.current;
    const matchingActive = inheritedProfile?.identity === requestedProfile.identity
      ? inheritedProfile
      : state.active?.identity === requestedProfile.identity
        ? state.active
        : undefined;
    if (matchingActive) {
      setState((current) => current.requestedIdentity === requestedProfile.identity
        && current.active === matchingActive
        && !current.error
        ? current
        : { requestedIdentity: requestedProfile.identity, active: matchingActive });
      return undefined;
    }
    let cancelled = false;
    setState((current) => current.requestedIdentity === requestedProfile.identity && !current.error
      ? current
      : { requestedIdentity: requestedProfile.identity, active: current.active });
    void fontEnvironment.prepareInteractive(requestedProfile).then(() => {
      if (!cancelled) {
        setState({ requestedIdentity: requestedProfile.identity, active: requestedProfile });
      }
    }, (reason: unknown) => {
      if (!cancelled) {
        setState((current) => ({
          requestedIdentity: requestedProfile.identity,
          active: current.active,
          error: errorFromUnknown(reason)
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fontEnvironment, inheritedProfile, profile.identity, state.active]);

  const currentState = state.requestedIdentity === profile.identity
    ? state
    : { requestedIdentity: profile.identity, active: state.active };
  React.useLayoutEffect(() => {
    if (currentState.active?.identity === profile.identity && !currentState.error) {
      onReady?.();
    }
  }, [currentState.active?.identity, currentState.error, onReady, profile.identity]);
  React.useLayoutEffect(() => {
    if (currentState.error && (requireExactProfile || !currentState.active)) {
      onErrorRef.current?.(currentState.error);
    }
  }, [currentState.active, currentState.error, requireExactProfile]);
  if (currentState.error && !currentState.active) {
    return (
      <main className="boot-screen" role="alert" data-testid="canvas-text-render-profile-error">
        <strong>Canvas text rendering is unavailable.</strong>
        <span>{currentState.error.message}</span>
      </main>
    );
  }
  if (!currentState.active
    || (requireExactProfile && currentState.active.identity !== profile.identity)) {
    return <>{pending}</>;
  }
  return (
    <CanvasTextRenderProfileContext.Provider value={{
      profile: currentState.active,
      interactiveReady: true
    }}>
      {children}
    </CanvasTextRenderProfileContext.Provider>
  );
}

export function useCanvasTextRenderProfile(): CanvasTextRenderProfile {
  const value = React.useContext(CanvasTextRenderProfileContext);
  if (!value) {
    throw new Error('CanvasTextRenderProfileProvider is required.');
  }
  return value.profile;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
