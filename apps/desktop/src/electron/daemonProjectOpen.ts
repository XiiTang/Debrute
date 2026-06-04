type DesktopProjectOpenFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface OpenProjectResponse {
  projectId: string;
}

export interface AxisDaemonRuntimeLike {
  daemonUrl: string;
  webBaseUrl: string | null;
  token: string;
}

export async function openProjectThroughDaemon(
  runtime: AxisDaemonRuntimeLike,
  projectRoot: string,
  fetchImpl: DesktopProjectOpenFetch = fetch
): Promise<{ projectId: string; url: string }> {
  const response = await fetchImpl(new URL('/api/projects/open', runtime.daemonUrl).toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-axis-daemon-token': runtime.token
    },
    body: JSON.stringify({ projectRoot })
  });
  if (!response.ok) {
    throw new Error(`AXIS daemon project open failed: ${response.status}`);
  }
  const opened = await response.json() as OpenProjectResponse;
  return {
    projectId: opened.projectId,
    url: projectWebShellUrl(runtime, opened.projectId)
  };
}

export function projectWebShellUrl(runtime: AxisDaemonRuntimeLike, projectId?: string): string {
  const url = new URL(runtime.webBaseUrl ?? runtime.daemonUrl);
  if (projectId) {
    url.pathname = `/projects/${encodeURIComponent(projectId)}`;
  }
  url.searchParams.set('axis-token', runtime.token);
  return url.toString();
}
