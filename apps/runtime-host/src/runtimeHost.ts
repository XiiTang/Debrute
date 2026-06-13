import { readFile } from 'node:fs/promises';
import { createDebruteDaemonHttpServer } from '@debrute/daemon';
import { parseRuntimeHostConfig, type RuntimeHostConfig } from './runtimeHostConfig.js';

export async function runRuntimeHost(config: RuntimeHostConfig = parseRuntimeHostConfig({
  env: process.env
})): Promise<void> {
  const token = (await readFile(config.tokenFile, 'utf8')).trim();
  if (!token) {
    throw new Error('Debrute runtime host token file is empty.');
  }
  const server = createDebruteDaemonHttpServer({
    host: config.host,
    port: config.daemonPort,
    token,
    webBaseUrl: null,
    webDistDir: config.webDistDir
  });
  await server.listen();

  const close = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
