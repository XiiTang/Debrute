import { readFile } from 'node:fs/promises';
import { createDebruteDaemonHttpServer } from '@debrute/daemon';

export interface InternalWorkbenchRuntimeChildArgs {
  port: number;
  tokenFile: string;
  webDistDir: string;
}

export function parseInternalWorkbenchRuntimeChildArgs(env: NodeJS.ProcessEnv = process.env): InternalWorkbenchRuntimeChildArgs {
  const port = env.DEBRUTE_WORKBENCH_RUNTIME_PORT ? Number(env.DEBRUTE_WORKBENCH_RUNTIME_PORT) : undefined;
  const tokenFile = env.DEBRUTE_WORKBENCH_RUNTIME_TOKEN_FILE;
  const webDistDir = env.DEBRUTE_WORKBENCH_RUNTIME_WEB_DIST_DIR;
  if (!port) {
    throw new Error('port is required for Debrute workbench runtime child.');
  }
  if (!tokenFile) {
    throw new Error('token file is required for Debrute workbench runtime child.');
  }
  if (!webDistDir) {
    throw new Error('webDistDir is required for Debrute workbench runtime child.');
  }
  return { port, tokenFile, webDistDir };
}

export async function runInternalWorkbenchRuntimeChild(): Promise<void> {
  const args = parseInternalWorkbenchRuntimeChildArgs();
  const token = (await readFile(args.tokenFile, 'utf8')).trim();
  const daemon = createDebruteDaemonHttpServer({
    host: '127.0.0.1',
    port: args.port,
    token,
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
