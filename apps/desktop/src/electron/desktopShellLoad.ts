export interface DebruteShellLoadServices {
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface DebruteShellLoadOptions {
  timeoutMs: number;
  intervalMs: number;
  probeTimeoutMs?: number;
}

export interface DebruteShellWindow {
  loadURL(url: string): Promise<void>;
}

const DEFAULT_SHELL_LOAD_OPTIONS: DebruteShellLoadOptions = {
  timeoutMs: 30_000,
  intervalMs: 250,
  probeTimeoutMs: 1_000
};

const defaultShellLoadServices: DebruteShellLoadServices = {
  fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now()
};

export async function waitForDebruteShellUrl(
  url: string,
  services: Partial<DebruteShellLoadServices> = {},
  options: Partial<DebruteShellLoadOptions> = {}
): Promise<void> {
  const resolvedServices = { ...defaultShellLoadServices, ...services };
  const resolvedOptions = { ...DEFAULT_SHELL_LOAD_OPTIONS, ...options };
  const startedAt = resolvedServices.now();

  while (resolvedServices.now() - startedAt <= resolvedOptions.timeoutMs) {
    if (await canReachDebruteShellUrl(url, resolvedServices.fetch, resolvedOptions.probeTimeoutMs)) {
      return;
    }
    await resolvedServices.sleep(resolvedOptions.intervalMs);
  }

  throw new Error(`Debrute workbench URL did not become reachable: ${url}`);
}

export async function loadDebruteProjectShellWindow(
  window: DebruteShellWindow,
  url: string,
  bindProjectWindow: () => void,
  services: Partial<DebruteShellLoadServices> = {},
  options: Partial<DebruteShellLoadOptions> = {}
): Promise<void> {
  await waitForDebruteShellUrl(url, services, options);
  await window.loadURL(url);
  bindProjectWindow();
}

async function canReachDebruteShellUrl(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number | undefined
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}
