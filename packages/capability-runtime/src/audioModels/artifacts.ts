import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { writeProjectFile } from '@debrute/project-core';
import type { AudioModelKind } from './catalog.js';

export type AudioArtifactSource =
  | { kind: 'bytes'; bytes: Uint8Array; mimeType: string; pcm?: PcmAudioParameters }
  | { kind: 'base64'; data: string; mimeType: string; pcm?: PcmAudioParameters }
  | { kind: 'url'; url: string; mimeType?: string };

export interface PcmAudioParameters {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export interface WrittenAudioArtifact {
  artifactId: string;
  title: string;
  projectRelativePath: string;
  mimeType: string;
}

export interface WriteAudioArtifactSourcesInput {
  projectRoot: string;
  invocationId: string;
  kind: AudioModelKind;
  args: Record<string, unknown>;
  sources: AudioArtifactSource[];
  fetchRemote: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  recordGeneratedAsset?: (input: {
    modelRunId: string;
    projectRelativePath: string;
    artifactRole: 'tts-audio' | 'music-audio' | 'sound-effect-audio';
    artifactIndex: number;
    modelRun: {
      request: unknown;
      output: unknown;
    };
  }) => Promise<void>;
  modelRunId: string;
  modelRun: {
    request: unknown;
    output: unknown;
  };
  signal?: AbortSignal;
}

export function audioArtifactRole(kind: AudioModelKind): 'tts-audio' | 'music-audio' | 'sound-effect-audio' {
  if (kind === 'tts') {
    return 'tts-audio';
  }
  return kind === 'music' ? 'music-audio' : 'sound-effect-audio';
}

export async function writeAudioArtifactSources(input: WriteAudioArtifactSourcesInput): Promise<WrittenAudioArtifact[]> {
  const artifacts: WrittenAudioArtifact[] = [];
  for (const [index, source] of input.sources.entries()) {
    const decoded = await decodeAudioArtifactSource(source, input.fetchRemote);
    const artifactId = randomUUID();
    const outputPath = index === 0 ? stringArg(input.args, 'output_path') : undefined;
    const outputDirectory = stringArg(input.args, 'output_directory') ?? `generated/${input.invocationId}`;
    const extension = extensionForAudioMimeType(decoded.mimeType);
    const projectRelativePath = outputPath
      ? outputPath
      : `${outputDirectory.replace(/\/$/, '')}/${artifactId}.${extension}`;
    const normalizedPath = await writeProjectFile(
      input.projectRoot,
      projectRelativePath,
      decoded.bytes,
      input.signal ? { signal: input.signal } : undefined
    );
    await input.recordGeneratedAsset?.({
      modelRunId: input.modelRunId,
      projectRelativePath: normalizedPath,
      artifactRole: audioArtifactRole(input.kind),
      artifactIndex: index,
      modelRun: input.modelRun
    });
    artifacts.push({
      artifactId,
      title: basename(normalizedPath),
      projectRelativePath: normalizedPath,
      mimeType: decoded.mimeType
    });
  }
  return artifacts;
}

export const writeAudioArtifactSourcesForTest = writeAudioArtifactSources;

export function extensionForAudioMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(';')[0]?.trim();
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') {
    return 'mp3';
  }
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') {
    return 'wav';
  }
  if (normalized === 'audio/ogg') {
    return 'ogg';
  }
  if (normalized === 'audio/flac') {
    return 'flac';
  }
  if (normalized === 'audio/aac') {
    return 'aac';
  }
  if (normalized === 'audio/pcm') {
    return 'pcm';
  }
  throw new Error(`Unsupported audio MIME type: ${mimeType}`);
}

export function parseAudioMimeParameters(mimeType: string): Record<string, string> {
  const [, ...parts] = mimeType.split(';');
  const params: Record<string, string> = {};
  for (const part of parts) {
    const [rawKey, rawValue] = part.split('=');
    const key = rawKey?.trim().toLowerCase();
    const value = rawValue?.trim();
    if (key && value) {
      params[key] = value;
    }
  }
  return params;
}

export function pcmFromMimeType(mimeType: string, defaults?: PcmAudioParameters): PcmAudioParameters | undefined {
  const normalized = mimeType.toLowerCase().split(';')[0]?.trim();
  if (normalized !== 'audio/pcm' && normalized !== 'audio/l16') {
    return undefined;
  }
  const params = parseAudioMimeParameters(mimeType);
  const sampleRate = positiveIntegerParam(params.rate) ?? defaults?.sampleRate;
  const channels = positiveIntegerParam(params.channels) ?? defaults?.channels;
  const bitsPerSample = normalized === 'audio/l16' ? 16 : positiveIntegerParam(params.bits) ?? defaults?.bitsPerSample;
  if (sampleRate === undefined || channels === undefined || bitsPerSample === undefined) {
    return undefined;
  }
  return {
    sampleRate,
    channels,
    bitsPerSample
  };
}

async function decodeAudioArtifactSource(
  source: AudioArtifactSource,
  fetchRemote: WriteAudioArtifactSourcesInput['fetchRemote']
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  switch (source.kind) {
    case 'bytes':
      return pcmWrappedIfNeeded(source.bytes, source.mimeType, source.pcm);
    case 'base64': {
      const bytes = Buffer.from(source.data, 'base64');
      return pcmWrappedIfNeeded(bytes, source.mimeType, source.pcm);
    }
    case 'url': {
      const fetched = await fetchRemote(source.url);
      return {
        bytes: fetched.bytes,
        mimeType: source.mimeType ?? fetched.mimeType
      };
    }
  }
}

function pcmWrappedIfNeeded(
  bytes: Uint8Array,
  mimeType: string,
  pcm: PcmAudioParameters | undefined
): { bytes: Uint8Array; mimeType: string } {
  if (!pcm) {
    return { bytes, mimeType };
  }
  return {
    bytes: wrapPcmAsWav(bytes, pcm.sampleRate, pcm.channels, pcm.bitsPerSample),
    mimeType: 'audio/wav'
  };
}

export function wrapPcmAsWav(bytes: Uint8Array, sampleRate: number, channels: number, bitsPerSample: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + bytes.byteLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, bytes.byteLength, true);
  const output = new Uint8Array(44 + bytes.byteLength);
  output.set(new Uint8Array(header), 0);
  output.set(bytes, 44);
  return output;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function positiveIntegerParam(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
