import { describe, expect, it } from 'vitest';
import { redactModelRunMetadata } from '../src/modelRunMetadataRedaction';

describe('model run metadata redaction', () => {
  it('redacts credential fields and URL query secrets while preserving non-secret metadata', () => {
    const input = {
      method: 'POST',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=gemini-secret&size=1024&signature=signed-value',
      headers: {
        authorization: 'Bearer sk-active-secret',
        'x-api-key': 'header-secret',
        'content-type': 'application/json'
      },
      body: {
        api_key: 'body-secret',
        apiKey: 'camel-secret',
        token: 'body-token',
        token_count: 42,
        keyframe: 'keep-keyframe',
        prompt: 'keep prompt',
        nested: {
          private_key: 'private material',
          message: 'provider echoed sk-active-secret'
        }
      }
    };

    const redacted = redactModelRunMetadata(input, { apiKey: 'sk-active-secret' });

    expect(redacted).toEqual({
      method: 'POST',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=%5Bredacted%5D&size=1024&signature=%5Bredacted%5D',
      headers: {
        authorization: '[redacted]',
        'x-api-key': '[redacted]',
        'content-type': 'application/json'
      },
      body: {
        api_key: '[redacted]',
        apiKey: '[redacted]',
        token: '[redacted]',
        token_count: 42,
        keyframe: 'keep-keyframe',
        prompt: 'keep prompt',
        nested: {
          private_key: '[redacted]',
          message: 'provider echoed [redacted]'
        }
      }
    });
    expect(JSON.stringify(redacted)).not.toContain('sk-active-secret');
    expect(input.headers.authorization).toBe('Bearer sk-active-secret');
    expect(input.body.nested.message).toBe('provider echoed sk-active-secret');
  });

  it('redacts nested arrays without broad substring field matches', () => {
    const input = {
      responses: [
        {
          status: 400,
          body: {
            error: {
              message: 'invalid api key sk-runtime-secret',
              access_token: 'access-secret',
              token_count: 9
            }
          }
        }
      ],
      sourceUrl: 'https://cdn.example/video.mp4?token=download-secret&frame=1',
      keyboard: 'keep keyboard',
      keyframe: 'keep keyframe'
    };

    const redacted = redactModelRunMetadata(input, { apiKey: 'sk-runtime-secret' });

    expect(redacted).toEqual({
      responses: [
        {
          status: 400,
          body: {
            error: {
              message: 'invalid api key [redacted]',
              access_token: '[redacted]',
              token_count: 9
            }
          }
        }
      ],
      sourceUrl: 'https://cdn.example/video.mp4?token=%5Bredacted%5D&frame=1',
      keyboard: 'keep keyboard',
      keyframe: 'keep keyframe'
    });
    expect(JSON.stringify(redacted)).not.toContain('sk-runtime-secret');
    expect(JSON.stringify(redacted)).not.toContain('download-secret');
  });

  it('redacts cookie headers and media data URL payloads', () => {
    const input = {
      headers: {
        cookie: 'session=runtime-secret',
        'set-cookie': 'session=response-secret; HttpOnly',
        authorization: 'Bearer sk-runtime-secret'
      },
      body: {
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
            }
          },
          {
            type: 'audio_url',
            audio_url: {
              url: 'data:audio/wav;base64,UklGRgAAAABXQVZF'
            }
          }
        ]
      }
    };

    const redacted = redactModelRunMetadata(input, { apiKey: 'sk-runtime-secret' });

    expect(redacted).toEqual({
      headers: {
        cookie: '[redacted]',
        'set-cookie': '[redacted]',
        authorization: '[redacted]'
      },
      body: {
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,[redacted]'
            }
          },
          {
            type: 'audio_url',
            audio_url: {
              url: 'data:audio/wav;base64,[redacted]'
            }
          }
        ]
      }
    });
    expect(JSON.stringify(redacted)).not.toContain('runtime-secret');
    expect(JSON.stringify(redacted)).not.toContain('response-secret');
    expect(JSON.stringify(redacted)).not.toContain('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
    expect(JSON.stringify(redacted)).not.toContain('UklGRgAAAABXQVZF');
  });
});
