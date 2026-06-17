import { describe, expect, it } from 'vitest';
import {
  assertPublicHttpUrl,
  publicHttpRedirectUrl,
  type PublicRemoteHostLookup
} from '@debrute/capability-runtime';

const publicLookup: PublicRemoteHostLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup: PublicRemoteHostLookup = async () => [{ address: '169.254.169.254', family: 4 }];

describe('PublicRemoteFetchPolicy', () => {
  it('rejects bracketed IPv6 loopback and IPv4-mapped private addresses', async () => {
    await expect(assertPublicHttpUrl('http://[::1]/private.png', 'Remote image URLs', { lookup: publicLookup }))
      .rejects.toThrow('Remote image URLs must not target local or private network hosts');
    await expect(assertPublicHttpUrl('http://[::ffff:127.0.0.1]/private.png', 'Remote image URLs', { lookup: publicLookup }))
      .rejects.toThrow('Remote image URLs must not target local or private network hosts');
    await expect(assertPublicHttpUrl('http://[::ffff:10.0.0.1]/private.png', 'Remote image URLs', { lookup: publicLookup }))
      .rejects.toThrow('Remote image URLs must not target local or private network hosts');
  });

  it('rejects domains when any DNS result is local or private', async () => {
    await expect(assertPublicHttpUrl('https://media.example/private.png', 'Remote image URLs', { lookup: privateLookup }))
      .rejects.toThrow('Remote image URLs must not target local or private network hosts');
  });

  it('fails closed when DNS resolution fails', async () => {
    const failingLookup: PublicRemoteHostLookup = async () => {
      const error = new Error('not found') as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      throw error;
    };

    await expect(assertPublicHttpUrl('https://missing.example/private.png', 'Remote image URLs', { lookup: failingLookup }))
      .rejects.toThrow('Remote image URLs host could not be resolved');
  });

  it('accepts public HTTP(S) URLs only after every resolved address is public', async () => {
    await expect(assertPublicHttpUrl('https://media.example/image.png', 'Remote image URLs', { lookup: publicLookup }))
      .resolves.toBe('https://media.example/image.png');
  });

  it('revalidates redirect targets against the same policy', async () => {
    await expect(publicHttpRedirectUrl(
      'https://media.example/start',
      'http://[::1]/private.png',
      'Remote image URLs',
      { lookup: publicLookup }
    )).rejects.toThrow('Remote image URLs must not target local or private network hosts');

    await expect(publicHttpRedirectUrl(
      'https://media.example/start',
      '/next.png',
      'Remote image URLs',
      { lookup: publicLookup }
    )).resolves.toBe('https://media.example/next.png');
  });
});
