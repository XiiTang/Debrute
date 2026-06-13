type DesktopProjectOpenFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface OpenProjectResponse {
  projectId: string;
}

export interface DebruteDaemonRuntimeLike {
  daemonUrl: string;
  webBaseUrl: string | null;
  platform?: NodeJS.Platform;
  token: string;
}

export async function openProjectThroughDaemon(
  runtime: DebruteDaemonRuntimeLike,
  projectRoot: string,
  fetchImpl: DesktopProjectOpenFetch = fetch
): Promise<{ projectId: string; url: string }> {
  const response = await fetchImpl(new URL('/api/projects/open', runtime.daemonUrl).toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-debrute-daemon-token': runtime.token
    },
    body: JSON.stringify({ projectRoot })
  });
  if (!response.ok) {
    throw new Error(`Debrute daemon project open failed for ${projectRoot}: ${response.status}${await daemonErrorMessage(response)}`);
  }
  const opened = await response.json() as OpenProjectResponse;
  return {
    projectId: opened.projectId,
    url: projectWebShellUrl(runtime, opened.projectId)
  };
}

async function daemonErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) {
    return '';
  }
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } };
    return typeof body.error?.message === 'string' ? ` ${body.error.message}` : ` ${text}`;
  } catch {
    return ` ${text}`;
  }
}

export function projectWebShellUrl(runtime: DebruteDaemonRuntimeLike, projectId?: string): string {
  const url = new URL(runtime.webBaseUrl ?? runtime.daemonUrl);
  if (projectId) {
    url.pathname = `/projects/${encodeURIComponent(projectId)}`;
  }
  url.searchParams.set('debrute-token', runtime.token);
  return url.toString();
}
