#!/usr/bin/env node
import { createAxisDaemonHttpServer } from './http/createAxisDaemonHttpServer.js';

const port = numberArg('--port') ?? numberEnv('AXIS_DAEMON_PORT') ?? 0;
const token = stringArg('--token') ?? process.env.AXIS_DAEMON_TOKEN;
const webBaseUrl = stringArg('--web-base-url') ?? process.env.AXIS_WEB_BASE_URL;

const daemon = createAxisDaemonHttpServer({
  port,
  ...(token ? { token } : {}),
  ...(webBaseUrl ? { webBaseUrl } : {})
});
const runtime = await daemon.listen();
process.stdout.write(`${JSON.stringify(runtime)}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void daemon.close().finally(() => process.exit(0));
  });
}

function stringArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberArg(name: string): number | undefined {
  const value = stringArg(name);
  return value ? Number(value) : undefined;
}

function numberEnv(name: string): number | undefined {
  const value = process.env[name];
  return value ? Number(value) : undefined;
}
