import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_DAEMON_PORT,
  DEFAULT_WORKBENCH_WEB_PORT,
  chooseLoopbackPort,
  isLoopbackHttpUrl
} from '../../../packages/workbench-runtime/src/ports.js';

describe('@debrute/workbench-runtime ports', { tags: ['runtime'] }, () => {
  it('keeps preferred ports as preferences only', async () => {
    const server = await listenOnLoopback(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('test server did not bind to TCP');
      }
      expect(DEFAULT_WORKBENCH_DAEMON_PORT).toBe(17321);
      expect(DEFAULT_WORKBENCH_WEB_PORT).toBe(17322);
      expect(isLoopbackHttpUrl('http://127.0.0.1:17321')).toBe(true);
      await expect(chooseLoopbackPort(address.port)).resolves.not.toBe(address.port);
    } finally {
      await closeServer(server);
    }
  });
});

async function listenOnLoopback(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
