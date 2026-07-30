import type { DesktopOpenIntent } from './nativeRecentProjects.js';

interface PendingDesktopOpen<NativeIdentity> {
  intent: DesktopOpenIntent;
  preferredIdentity: NativeIdentity | undefined;
}

export function createDesktopOpenAdmission<NativeIdentity>(
  activate: (
    intent: DesktopOpenIntent,
    preferredIdentity?: NativeIdentity
  ) => Promise<void>
) {
  const pending: Array<PendingDesktopOpen<NativeIdentity>> = [];
  let phase: 'pending' | 'starting' | 'live' = 'pending';

  function activateOpen(request: PendingDesktopOpen<NativeIdentity>): Promise<void> {
    return request.preferredIdentity === undefined
      ? activate(request.intent)
      : activate(request.intent, request.preferredIdentity);
  }

  return {
    dispatch(intent: DesktopOpenIntent, preferredIdentity?: NativeIdentity) {
      const request = { intent, preferredIdentity };
      if (phase !== 'live') {
        pending.push(request);
        return Promise.resolve();
      }
      return activateOpen(request);
    },
    async start(explicitIntent: DesktopOpenIntent | undefined) {
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
        const request = pending.shift();
        if (request) {
          await activateOpen(request);
        }
      }
      phase = 'live';
    }
  };
}
