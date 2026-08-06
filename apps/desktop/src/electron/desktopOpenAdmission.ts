import type { DesktopOpenIntent } from './nativeRecentProjects.js';

interface PendingDesktopOpen<NativeIdentity> {
  intent: DesktopOpenIntent;
  preferredIdentity: NativeIdentity | undefined;
}

export function createDesktopOpenAdmission<NativeIdentity, Result>(
  activate: (
    intent: DesktopOpenIntent,
    preferredIdentity?: NativeIdentity
  ) => Promise<Result>
) {
  const pending: Array<PendingDesktopOpen<NativeIdentity>> = [];
  let phase: 'pending' | 'starting' | 'live' = 'pending';

  function activateOpen(request: PendingDesktopOpen<NativeIdentity>): Promise<Result> {
    return request.preferredIdentity === undefined
      ? activate(request.intent)
      : activate(request.intent, request.preferredIdentity);
  }

  return {
    dispatch(
      intent: DesktopOpenIntent,
      preferredIdentity?: NativeIdentity
    ): Promise<Result | undefined> {
      const request = { intent, preferredIdentity };
      if (phase !== 'live') {
        pending.push(request);
        return Promise.resolve(undefined);
      }
      return activateOpen(request);
    },
    async start(explicitIntent: DesktopOpenIntent | undefined): Promise<void> {
      if (phase !== 'pending') {
        throw new Error('Desktop open admission has already started.');
      }
      phase = 'starting';
      await activateOpen(explicitIntent
        ? { intent: explicitIntent, preferredIdentity: undefined }
        : pending.shift() ?? {
            intent: { kind: 'new-window' },
            preferredIdentity: undefined
        });
      while (pending.length > 0) {
        await activateOpen(pending.shift()!);
      }
      phase = 'live';
    }
  };
}
