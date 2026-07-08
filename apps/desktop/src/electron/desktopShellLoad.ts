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

export interface DebruteShellNavigation {
  readyUrl: string;
  loadUrl: string;
}

export interface PreparedDebruteProjectWindowBinding {
  commit(): void | Promise<void>;
  rollback(): void | Promise<void>;
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
  navigation: DebruteShellNavigation,
  prepareProjectWindowBinding: () => PreparedDebruteProjectWindowBinding | Promise<PreparedDebruteProjectWindowBinding>,
  services: Partial<DebruteShellLoadServices> = {},
  options: Partial<DebruteShellLoadOptions> = {}
): Promise<void> {
  const binding = await prepareProjectWindowBinding();
  try {
    await waitForDebruteShellUrl(navigation.readyUrl, services, options);
    await window.loadURL(navigation.loadUrl);
    await binding.commit();
  } catch (error) {
    await binding.rollback();
    throw error;
  }
}

async function canReachDebruteShellUrl(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number | undefined
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) })
    });
    return response.ok;
  } catch {
    return false;
  }
}
