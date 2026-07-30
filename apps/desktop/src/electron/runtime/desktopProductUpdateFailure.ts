import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

const FAILURE_ARGUMENT = '--product-update-failure';
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface DesktopProductUpdateFailure {
  transactionId: string;
  targetVersion: string;
  stage: 'committing' | 'runtime_ready';
  message: string;
}

export function productUpdateFailureTransaction(argv: readonly string[]): string | undefined {
  const indexes = argv
    .map((argument, index) => argument === FAILURE_ARGUMENT ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length === 0) {
    return undefined;
  }
  if (indexes.length !== 1) {
    throw new Error('Desktop Product-update failure launch contains duplicate failure arguments.');
  }
  const index = indexes[0];
  if (index === undefined) {
    throw new Error('Desktop Product-update failure launch is missing its failure argument.');
  }
  const transactionId = argv[index + 1];
  if (!transactionId || !CANONICAL_UUID.test(transactionId)) {
    throw new Error('Desktop Product-update failure launch requires a canonical transaction ID.');
  }
  return transactionId;
}

export function readDesktopProductUpdateFailure(
  probe: { entrypoint: string; productRoot: string },
  transactionId: string,
  run: typeof spawnSync = spawnSync
): DesktopProductUpdateFailure {
  const result = run(probe.entrypoint, [
    'read-product-update-failure',
    '--product-root', probe.productRoot,
    '--transaction-id', transactionId
  ], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true
  }) as SpawnSyncReturns<string>;
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Product-update failure probe exited with status ${String(result.status)}.`);
  }
  const value: unknown = JSON.parse(result.stdout);
  if (!isFailure(value) || value.transactionId !== transactionId) {
    throw new Error('Product-update failure probe returned an invalid or mismatched record.');
  }
  return value;
}

function isFailure(value: unknown): value is DesktopProductUpdateFailure {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 4
    && keys[0] === 'message'
    && keys[1] === 'stage'
    && keys[2] === 'targetVersion'
    && keys[3] === 'transactionId'
    && typeof record.transactionId === 'string'
    && typeof record.targetVersion === 'string'
    && (record.stage === 'committing' || record.stage === 'runtime_ready')
    && typeof record.message === 'string'
    && record.message.trim().length > 0;
}
