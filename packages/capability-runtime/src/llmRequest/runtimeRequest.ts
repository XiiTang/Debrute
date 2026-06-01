import { capabilityError, capabilityOk, type AxisCapabilityResult } from '@axis/capability-core';
import type { ChatProvider, ProviderRequest } from '../providers.js';
import { DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS, createProviderRequestTimeoutSignal, isProviderRequestTimeoutError, parseProviderRequestTimeoutMs } from '../providerRequestTimeout.js';

export interface LlmProviderResolver {
  providerForModel(modelKey: string): ChatProvider | undefined;
}

export interface LlmRuntimeRequestOptions {
  providers: LlmProviderResolver;
  defaultModelKey?: string | null;
  systemPrompt?: string;
  defaultTimeoutMs?: number;
  signal?: AbortSignal;
}

type ParsedInput =
  | {
      ok: true;
      value: {
        modelKey: string;
        systemPrompt: string;
        messages: ProviderRequest['messages'];
        requireJson: boolean;
        timeoutMs: number;
      };
    }
  | { ok: false; result: AxisCapabilityResult };

const LLM_REQUEST_INPUT_FIELDS = new Set([
  'modelKey',
  'systemPrompt',
  'prompt',
  'messages',
  'resultSchema',
  'outputFormat',
  'timeoutMs'
]);

export async function runLlmRuntimeRequest(input: Record<string, unknown>, options: LlmRuntimeRequestOptions): Promise<AxisCapabilityResult> {
  const parsed = parseInput(input, options);
  if (!parsed.ok) {
    return parsed.result;
  }

  const provider = options.providers.providerForModel(parsed.value.modelKey);
  if (!provider) {
    return capabilityError('llm_model_unavailable', `LLM model is unavailable: ${parsed.value.modelKey}`, {
      modelKey: parsed.value.modelKey
    });
  }

  const timeout = createProviderRequestTimeoutSignal(options.signal, parsed.value.timeoutMs);
  let response: Awaited<ReturnType<typeof provider.send>>;
  try {
    response = await provider.send({
      modelKey: parsed.value.modelKey,
      systemPrompt: parsed.value.systemPrompt,
      messages: parsed.value.messages,
      signal: timeout.signal
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    if (timeout.timedOut() || isProviderRequestTimeoutError(error)) {
      const message = `LLM request timed out after ${parsed.value.timeoutMs}ms.`;
      return capabilityError('llm_request_timeout', message, {
        modelKey: parsed.value.modelKey,
        retryable: true,
        timeoutMs: parsed.value.timeoutMs
      }, {
        outputs: {
          content: message,
          text: message,
          modelKey: parsed.value.modelKey
        }
      });
    }
    return capabilityError('llm_request_failed', errorMessage(error), {
      modelKey: parsed.value.modelKey,
      retryable: true
    }, {
      outputs: {
        content: errorMessage(error),
        text: errorMessage(error),
        modelKey: parsed.value.modelKey
      }
    });
  } finally {
    timeout.dispose();
  }

  if (response.type === 'error') {
    return capabilityError('llm_request_failed', response.message, {
      modelKey: parsed.value.modelKey,
      retryable: response.retryable
    }, {
      outputs: {
        content: response.message,
        modelKey: parsed.value.modelKey
      }
    });
  }

  const outputs: Record<string, unknown> = {
    content: response.text,
    text: response.text,
    modelKey: response.modelKey
  };

  if (parsed.value.requireJson) {
    const json = parseJson(response.text);
    if (!json.ok) {
      return capabilityError('llm_invalid_json', json.message, {
        modelKey: response.modelKey
      }, {
        outputs
      });
    }
    outputs.result = json.value;
  }

  return capabilityOk(outputs);
}

function parseInput(input: Record<string, unknown>, options: LlmRuntimeRequestOptions): ParsedInput {
  const unknownField = Object.keys(input).find((key) => !LLM_REQUEST_INPUT_FIELDS.has(key));
  if (unknownField) {
    return { ok: false, result: capabilityError('invalid_input', `Unknown llm.request input field: ${unknownField}`) };
  }

  const requestedModelKey = stringValue(input.modelKey);
  const modelKey = requestedModelKey === undefined || requestedModelKey === 'default'
    ? stringValue(options.defaultModelKey)
    : requestedModelKey;
  if (!modelKey) {
    return { ok: false, result: capabilityError('no_llm_model_configured', 'No LLM model is configured.') };
  }

  const messages = messagesFromInput(input);
  if (!messages.ok) {
    return messages;
  }
  const timeoutMs = parseProviderRequestTimeoutMs(input.timeoutMs, options.defaultTimeoutMs ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
  if (!timeoutMs.ok) {
    return { ok: false, result: capabilityError('invalid_input', timeoutMs.message) };
  }
  const requireJson = input.outputFormat === 'json' || input.resultSchema !== undefined;
  return {
    ok: true,
    value: {
      modelKey,
      systemPrompt: stringValue(input.systemPrompt) ?? options.systemPrompt ?? 'You are AXIS LLM Request. Return exactly what the caller requested.',
      messages: requireJson ? appendJsonInstruction(messages.value, input.resultSchema) : messages.value,
      requireJson,
      timeoutMs: timeoutMs.value
    }
  };
}

function messagesFromInput(input: Record<string, unknown>): { ok: true; value: ProviderRequest['messages'] } | { ok: false; result: AxisCapabilityResult } {
  if (Array.isArray(input.messages)) {
    const messages: ProviderRequest['messages'] = [];
    for (const [index, raw] of input.messages.entries()) {
      if (!isRecord(raw) || (raw.role !== 'user' && raw.role !== 'assistant' && raw.role !== 'system') || typeof raw.content !== 'string') {
        return { ok: false, result: capabilityError('invalid_input', `messages[${index}] must include role and content.`) };
      }
      messages.push({ role: raw.role, content: raw.content });
    }
    if (messages.length === 0) {
      return { ok: false, result: capabilityError('invalid_input', 'messages must contain at least one message.') };
    }
    return { ok: true, value: messages };
  }

  const prompt = stringValue(input.prompt);
  if (!prompt) {
    return { ok: false, result: capabilityError('invalid_input', 'llm.request requires prompt or messages.') };
  }
  return { ok: true, value: [{ role: 'user', content: prompt }] };
}

function appendJsonInstruction(messages: ProviderRequest['messages'], schema: unknown): ProviderRequest['messages'] {
  const instruction = schema === undefined
    ? 'Return only valid JSON.'
    : `Return only valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
  const next = messages.slice();
  const last = next[next.length - 1];
  if (last?.role === 'user') {
    next[next.length - 1] = { ...last, content: `${last.content}\n\n${instruction}` };
    return next;
  }
  next.push({ role: 'user', content: instruction });
  return next;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(stripJsonFence(text.trim())) };
  } catch {
    return { ok: false, message: 'LLM response did not contain valid JSON.' };
  }
}

function stripJsonFence(value: string): string {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() || value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
