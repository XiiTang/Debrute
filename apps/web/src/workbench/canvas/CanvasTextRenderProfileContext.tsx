import React from 'react';
import type { CanvasTextRenderProfile } from './CanvasTextRenderProfile.js';

const CanvasTextRenderProfileContext = React.createContext<CanvasTextRenderProfile | undefined>(undefined);

export function CanvasTextRenderProfileGate({
  profile,
  pending,
  children
}: {
  profile: CanvasTextRenderProfile;
  pending: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const inheritedProfile = React.useContext(CanvasTextRenderProfileContext);
  const requestedProfileRef = React.useRef(profile);
  requestedProfileRef.current = profile;
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
    void requestedProfile.prepare(document).then(() => {
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
  }, [inheritedProfile, profile.identity, state.active]);

  const currentState = state.requestedIdentity === profile.identity
    ? state
    : { requestedIdentity: profile.identity, active: state.active };
  if (currentState?.error) {
    return (
      <main className="boot-screen" role="alert" data-testid="canvas-text-render-profile-error">
        <strong>Canvas text rendering is unavailable.</strong>
        <span>{currentState.error.message}</span>
      </main>
    );
  }
  if (!currentState?.active) {
    return <>{pending}</>;
  }
  return (
    <CanvasTextRenderProfileContext.Provider value={currentState.active}>
      {children}
    </CanvasTextRenderProfileContext.Provider>
  );
}

export function useCanvasTextRenderProfile(): CanvasTextRenderProfile {
  const profile = React.useContext(CanvasTextRenderProfileContext);
  if (!profile) {
    throw new Error('CanvasTextRenderProfileGate is required.');
  }
  return profile;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
