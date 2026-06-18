import { describe, expect, it, vi } from 'vitest';
import { runLlmRuntimeRequest, type ChatProvider, type ProviderRequest, type ProviderResponse } from '@debrute/capability-runtime';

describe('runtime LLM request', () => {
  it('uses the default model and returns raw text', async () => {
    const provider = fakeChatProvider('fake-main', [
      { type: 'message', modelKey: 'fake-main:model-a', text: 'chapter summary' }
    ]);

    const result = await runLlmRuntimeRequest({ prompt: 'Summarize chapter 1.' }, {
      providers: fakeProviderRegistry([provider]),
      defaultModelKey: 'fake-main:model-a'
    });

    expect(result).toMatchObject({
      status: 'ok',
      outputs: {
        content: 'chapter summary',
        text: 'chapter summary',
        modelKey: 'fake-main:model-a'
      }
    });
  });

  it('treats modelKey default as the configured default model', async () => {
    const provider = fakeChatProvider('fake-main', [
      { type: 'message', modelKey: 'fake-main:model-a', text: 'default alias result' }
    ]);

    const result = await runLlmRuntimeRequest({
      modelKey: 'default',
      prompt: 'Use default model.'
    }, {
      providers: fakeProviderRegistry([provider]),
      defaultModelKey: 'fake-main:model-a'
    });

    expect(result).toMatchObject({
      status: 'ok',
      outputs: {
        content: 'default alias result',
        modelKey: 'fake-main:model-a'
      }
    });
  });

  it('uses an explicit model override', async () => {
    const provider = fakeChatProvider('fake-main', [
      { type: 'message', modelKey: 'fake-main:model-b', text: 'model b result' }
    ]);

    const result = await runLlmRuntimeRequest({
      modelKey: 'fake-main:model-b',
      prompt: 'Use model b.'
    }, {
      providers: fakeProviderRegistry([provider]),
      defaultModelKey: 'fake-main:model-a'
    });

    expect(result).toMatchObject({
      status: 'ok',
      outputs: {
        content: 'model b result',
        modelKey: 'fake-main:model-b'
      }
    });
  });

  it('rejects project output fields because runtime requests do not write files', async () => {
    const provider = fakeChatProvider('fake-main', [
      { type: 'message', modelKey: 'fake-main:model-a', text: 'unused' }
    ]);

    const result = await runLlmRuntimeRequest({
      prompt: 'Create an outline.',
      output_path: 'generated/comic-outline.md'
    }, {
      providers: fakeProviderRegistry([provider]),
      defaultModelKey: 'fake-main:model-a'
    });

    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'invalid_input',
        message: 'Unknown llm.request input field: output_path'
      }
    });
  });

  it('returns a retryable timeout error when an LLM request exceeds timeoutMs', async () => {
    const provider: ChatProvider = {
      id: 'fake-main',
      providerType: 'openai_compat',
      modelKeys: ['fake-main:model-a'],
      async send(request: ProviderRequest) {
        await waitForAbortOrDelay(request.signal, 20);
        return { type: 'message', modelKey: 'fake-main:model-a', text: 'late result' };
      }
    };
    const result = await runLlmRuntimeRequest({
      prompt: 'Slow request.',
      timeoutMs: 1
    }, {
      providers: fakeProviderRegistry([provider]),
      defaultModelKey: 'fake-main:model-a'
    });

    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'llm_request_timeout',
        details: { retryable: true }
      },
      outputs: {
        modelKey: 'fake-main:model-a'
      }
    });
  });

  it('keeps the LLM default timeout at 120000ms', async () => {
    vi.useFakeTimers();
    try {
      const provider: ChatProvider = {
        id: 'fake-main',
        providerType: 'openai_compat',
        modelKeys: ['fake-main:model-a'],
        async send(request: ProviderRequest) {
          await new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          });
          return { type: 'message', modelKey: 'fake-main:model-a', text: 'late result' };
        }
      };
      let settled = false;
      const promise = runLlmRuntimeRequest({ prompt: 'Slow default request.' }, {
        providers: fakeProviderRegistry([provider]),
        defaultModelKey: 'fake-main:model-a'
      }).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(120_000);
      const settledAtDefault = settled;
      if (!settledAtDefault) {
        await vi.advanceTimersByTimeAsync(480_000);
      }
      const result = await promise;

      expect(settledAtDefault).toBe(true);
      expect(result).toMatchObject({
        status: 'error',
        error: {
          code: 'llm_request_timeout',
          message: 'LLM request timed out after 120000ms.'
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses JSON when a result schema is requested', async () => {
    const provider = fakeChatProvider('fake-main', [
      { type: 'message', modelKey: 'fake-main:model-a', text: '```json\n{"pages":[{"id":"p1"}]}\n```' }
    ]);

    const result = await runLlmRuntimeRequest({
      prompt: 'Return pages.',
      resultSchema: {
        type: 'object',
        properties: {
          pages: { type: 'array' }
        }
      }
    }, {
      providers: fakeProviderRegistry([provider]),
      defaultModelKey: 'fake-main:model-a'
    });

    expect(result).toMatchObject({
      status: 'ok',
      outputs: {
        result: { pages: [{ id: 'p1' }] }
      }
    });
  });

  it('returns llm_invalid_json when structured output is not JSON', async () => {
    const provider = fakeChatProvider('fake-main', [
      { type: 'message', modelKey: 'fake-main:model-a', text: 'not json' }
    ]);

    const result = await runLlmRuntimeRequest({
      prompt: 'Return JSON.',
      outputFormat: 'json'
    }, {
      providers: fakeProviderRegistry([provider]),
      defaultModelKey: 'fake-main:model-a'
    });

    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'llm_invalid_json' },
      outputs: { content: 'not json' }
    });
  });

  it('returns no_llm_model_configured when no default model exists', async () => {
    const result = await runLlmRuntimeRequest({ prompt: 'Hello.' }, {
      providers: fakeProviderRegistry([]),
      defaultModelKey: null
    });

    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'no_llm_model_configured' }
    });
  });

  it('redacts active provider keys from LLM success outputs', async () => {
    const provider = fakeChatProvider('fake-main', [
      { type: 'message', modelKey: 'fake-main:model-a', text: 'provider echoed sk-llm-secret' }
    ]);

    const result = await runLlmRuntimeRequest({ prompt: 'Echo.' }, {
      providers: fakeProviderRegistry([provider], { 'fake-main': 'sk-llm-secret' }),
      defaultModelKey: 'fake-main:model-a'
    });

    expect(result).toMatchObject({
      status: 'ok',
      outputs: {
        content: 'provider echoed [redacted]',
        text: 'provider echoed [redacted]',
        modelKey: 'fake-main:model-a'
      }
    });
    expect(JSON.stringify(result)).not.toContain('sk-llm-secret');
  });

  it('redacts active provider keys from LLM provider errors and thrown errors', async () => {
    const errorResponseProvider = fakeChatProvider('fake-main', [
      { type: 'error', modelKey: 'fake-main:model-a', message: 'bad key sk-llm-secret', retryable: false }
    ]);
    const errorResponse = await runLlmRuntimeRequest({ prompt: 'Fail.' }, {
      providers: fakeProviderRegistry([errorResponseProvider], { 'fake-main': 'sk-llm-secret' }),
      defaultModelKey: 'fake-main:model-a'
    });

    expect(errorResponse).toMatchObject({
      status: 'error',
      error: { message: 'bad key [redacted]' },
      outputs: { content: 'bad key [redacted]' }
    });
    expect(JSON.stringify(errorResponse)).not.toContain('sk-llm-secret');

    const throwingProvider: ChatProvider = {
      id: 'fake-main',
      providerType: 'openai_compat',
      modelKeys: ['fake-main:model-a'],
      async send() {
        throw new Error('transport included sk-llm-secret');
      }
    };
    const thrown = await runLlmRuntimeRequest({ prompt: 'Throw.' }, {
      providers: fakeProviderRegistry([throwingProvider], { 'fake-main': 'sk-llm-secret' }),
      defaultModelKey: 'fake-main:model-a'
    });

    expect(thrown).toMatchObject({
      status: 'error',
      error: { message: 'transport included [redacted]' },
      outputs: {
        content: 'transport included [redacted]',
        text: 'transport included [redacted]'
      }
    });
    expect(JSON.stringify(thrown)).not.toContain('sk-llm-secret');
  });
});

async function waitForAbortOrDelay(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function fakeProviderRegistry(
  providers: ChatProvider[],
  secretsByProviderId: Record<string, string> = {}
): { providerForModel(modelKey: string): ChatProvider | undefined; apiKeysForModel(modelKey: string): string[] } {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    providerForModel(modelKey: string): ChatProvider | undefined {
      const providerId = modelKey.includes(':') ? modelKey.slice(0, modelKey.indexOf(':')) : modelKey;
      return byId.get(providerId);
    },
    apiKeysForModel(modelKey: string): string[] {
      const providerId = modelKey.includes(':') ? modelKey.slice(0, modelKey.indexOf(':')) : modelKey;
      const apiKey = secretsByProviderId[providerId]?.trim();
      return apiKey ? [apiKey] : [];
    }
  };
}

function fakeChatProvider(id: string, responses: ProviderResponse[]): ChatProvider {
  const queue = [...responses];
  return {
    id,
    providerType: 'openai_compat',
    modelKeys: [...new Set(responses.map((response) => response.modelKey))],
    async send(request: ProviderRequest): Promise<ProviderResponse> {
      const response = queue.shift();
      if (!response) {
        return { type: 'error', modelKey: request.modelKey, message: 'No fake provider response queued.', retryable: false };
      }
      return response;
    }
  };
}
