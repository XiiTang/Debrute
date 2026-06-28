#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createDebruteDaemonHttpServer } from './http/createDebruteDaemonHttpServer.js';
import { createSourceDevProductServicesFromEnv } from './product/SourceDevProductServices.js';

const port = numberArg('--port') ?? numberEnv('DEBRUTE_DAEMON_PORT') ?? 0;
const token = await readToken();
const webBaseUrl = stringArg('--web-base-url') ?? process.env.DEBRUTE_WEB_BASE_URL;
const productServices = createSourceDevProductServicesFromEnv(process.env);
await productServices.managedCli.ensureCurrent();

const daemon = createDebruteDaemonHttpServer({
  port,
  ...(token ? { token } : {}),
  ...(webBaseUrl ? { webBaseUrl } : {}),
  productServices
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

async function readToken(): Promise<string | undefined> {
  const directToken = stringArg('--token') ?? process.env.DEBRUTE_DAEMON_TOKEN;
  if (directToken) {
    return directToken;
  }
  const tokenPath = stringArg('--token-file') ?? process.env.DEBRUTE_DAEMON_TOKEN_FILE;
  return tokenPath ? (await readFile(tokenPath, 'utf8')).trim() : undefined;
}
