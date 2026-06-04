import { createAxisDaemonHttpServer } from '@axis/daemon';

export interface InternalWorkbenchRuntimeChildArgs {
  port: number;
  token: string;
  webDistDir: string;
}

export function parseInternalWorkbenchRuntimeChildArgs(env: NodeJS.ProcessEnv = process.env): InternalWorkbenchRuntimeChildArgs {
  const port = env.AXIS_WORKBENCH_RUNTIME_PORT ? Number(env.AXIS_WORKBENCH_RUNTIME_PORT) : undefined;
  const token = env.AXIS_WORKBENCH_RUNTIME_TOKEN;
  const webDistDir = env.AXIS_WORKBENCH_RUNTIME_WEB_DIST_DIR;
  if (!port) {
    throw new Error('port is required for AXIS workbench runtime child.');
  }
  if (!token) {
    throw new Error('token is required for AXIS workbench runtime child.');
  }
  if (!webDistDir) {
    throw new Error('webDistDir is required for AXIS workbench runtime child.');
  }
  return { port, token, webDistDir };
}

export async function runInternalWorkbenchRuntimeChild(): Promise<void> {
  const args = parseInternalWorkbenchRuntimeChildArgs();
  const daemon = createAxisDaemonHttpServer({
    host: '127.0.0.1',
    port: args.port,
    token: args.token,
    webBaseUrl: null,
    webDistDir: args.webDistDir
  });
  await daemon.listen();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void daemon.close().finally(() => process.exit(0));
    });
  }
}
