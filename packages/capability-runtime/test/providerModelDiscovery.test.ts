import { describe, expect, it, vi } from 'vitest';
import { discoverProviderModels } from '../src/providers/discovery';

describe('provider model discovery', () => {
  it('discovers OpenAI-compatible models at the provider-owned /models endpoint', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      data: [
        { id: 'gpt-debrute-a' },
        { id: 'gpt-debrute-b' },
        { id: 'gpt-debrute-a' }
      ]
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

    const result = await discoverProviderModels({
      providerType: 'openai_compat',
      baseUrl: ' https://api.example.test/v1/// ',
      apiKey: ' sk-provider ',
      fetch
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example.test/v1/models');
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      accept: 'application/json',
      authorization: 'Bearer sk-provider'
    });
    expect(result).toEqual({
      endpoint: 'https://api.example.test/v1/models',
      models: ['gpt-debrute-a', 'gpt-debrute-b'],
      modelsCount: 2,
      supportsDiscovery: true
    });
  });

  it('reports unsupported discovery for Anthropic without making a network request', async () => {
    const fetch = vi.fn(async () => new Response('{}'));

    const result = await discoverProviderModels({
      providerType: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-anthropic',
      fetch
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      endpoint: 'https://api.anthropic.com/v1/<manual-model-entry>',
      models: [],
      modelsCount: 0,
      supportsDiscovery: false
    });
  });
});
