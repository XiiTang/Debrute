import { describe, expect, it, vi } from 'vitest';
import {
  productUpdateFailureTransaction,
  readDesktopProductUpdateFailure
} from './desktopProductUpdateFailure.js';

const transactionId = '123e4567-e89b-42d3-a456-426614174000';

describe('Desktop Product-update failure surface', () => {
  it('accepts one exact canonical transaction argument', () => {
    expect(productUpdateFailureTransaction([
      '/Applications/Debrute.app/Contents/MacOS/Debrute',
      '--product-update-failure',
      transactionId
    ])).toBe(transactionId);
    expect(productUpdateFailureTransaction(['Debrute'])).toBeUndefined();
    expect(() => productUpdateFailureTransaction([
      'Debrute', '--product-update-failure', 'latest'
    ])).toThrow(/canonical transaction ID/);
  });

  it('reads only a matching closed failure record from the selected installed Runtime', () => {
    const run = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: JSON.stringify({
        transactionId,
        targetVersion: '1.2.3',
        stage: 'committing',
        message: 'Target Runtime did not become Ready.'
      }),
      stderr: '',
      status: 0,
      signal: null,
      error: undefined
    }));
    expect(readDesktopProductUpdateFailure({
      entrypoint: '/runtime/debrute-runtime',
      productRoot: '/home/.debrute/products'
    }, transactionId, run as never)).toMatchObject({ targetVersion: '1.2.3' });
    expect(run).toHaveBeenCalledWith('/runtime/debrute-runtime', [
      'read-product-update-failure',
      '--product-root', '/home/.debrute/products',
      '--transaction-id', transactionId
    ], expect.objectContaining({ encoding: 'utf8' }));
  });

  it('rejects extra failure fields instead of accepting an open record', () => {
    const run = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: JSON.stringify({
        transactionId,
        targetVersion: '1.2.3',
        stage: 'committing',
        message: 'failed',
        retry: true
      }),
      stderr: '',
      status: 0,
      signal: null,
      error: undefined
    }));
    expect(() => readDesktopProductUpdateFailure({
      entrypoint: '/runtime/debrute-runtime',
      productRoot: '/home/.debrute/products'
    }, transactionId, run as never)).toThrow(/invalid or mismatched record/);
  });
});
