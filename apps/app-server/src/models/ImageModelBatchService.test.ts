import { describe, expect, test } from 'vitest';
import {
  imageModelBatchRequestsFromJsonl,
  imageModelBatchRequestsFromManifest
} from './ImageModelBatchService.js';

describe('image model batch request expansion', () => {
  test('expands canonical image manifest requests in order', () => {
    const requests = imageModelBatchRequestsFromManifest({
      requests: [
        {
          model: 'gpt-image-2',
          arguments: { prompt: 'first', output_path: 'generated/first.png' }
        },
        {
          model: 'gpt-image-2',
          arguments: { prompt: 'second', output_path: 'generated/second.png' }
        },
        {
          model: 'gemini-3.1-flash-image-preview',
          arguments: { prompt: 'third', output_path: 'generated/third.png' }
        },
        {
          model: 'custom-image-model',
          arguments: { prompt: 'fourth' }
        }
      ]
    });

    expect(requests).toEqual([
      {
        model: 'gpt-image-2',
        arguments: { prompt: 'first', output_path: 'generated/first.png' },
        outputPath: 'generated/first.png'
      },
      {
        model: 'gpt-image-2',
        arguments: { prompt: 'second', output_path: 'generated/second.png' },
        outputPath: 'generated/second.png'
      },
      {
        model: 'gemini-3.1-flash-image-preview',
        arguments: { prompt: 'third', output_path: 'generated/third.png' },
        outputPath: 'generated/third.png'
      },
      {
        model: 'custom-image-model',
        arguments: { prompt: 'fourth' }
      }
    ]);
  });

  test('expands JSONL request sources and skips blank lines', () => {
    const requests = imageModelBatchRequestsFromJsonl([
      JSON.stringify({
        model: 'gpt-image-2',
        arguments: { prompt: 'one', output_path: 'generated/one.png' },
        timeoutMs: 123
      }),
      '',
      '   ',
      JSON.stringify({ model: 'gemini-3.1-flash-image-preview', arguments: { prompt: 'two' } })
    ].join('\n'));

    expect(requests).toEqual([
      {
        model: 'gpt-image-2',
        arguments: { prompt: 'one', output_path: 'generated/one.png' },
        timeoutMs: 123,
        outputPath: 'generated/one.png'
      },
      {
        model: 'gemini-3.1-flash-image-preview',
        arguments: { prompt: 'two' }
      }
    ]);
  });

  test('throws coded invalid_input errors for invalid request sources', () => {
    expect(() => imageModelBatchRequestsFromManifest({ slides: {} })).toThrow('manifest.requests must be an array.');
    expect(() => imageModelBatchRequestsFromManifest({
      requests: [{ model: 'gpt-image-2' }]
    })).toThrow('request.arguments must be a JSON object.');
    expect(() => imageModelBatchRequestsFromJsonl('{"arguments":{"prompt":"missing model"}}')).toThrow(
      'Image model batch request must include string field "model".'
    );
    expect(() => imageModelBatchRequestsFromJsonl(JSON.stringify({
      model: 'gpt-image-2',
      arguments: { prompt: 'bad timeout' },
      timeoutMs: 0
    }))).toThrow('Image model batch request timeoutMs must be a positive integer.');
  });
});
