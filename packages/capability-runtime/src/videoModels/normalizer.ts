import { extname } from 'node:path';
import { readProjectFileBytes } from '@debrute/project-core';
import { assertPublicHttpUrl, type PublicRemoteHostLookup } from '../remoteFetchPolicy.js';
import type { VideoModelCatalogEntry } from './catalog.js';

export type VideoIntent = 'generate' | 'reference' | 'audio_driven' | 'extend' | 'edit';
export type VideoReferenceMediaType = 'image' | 'video' | 'audio' | 'mask';

export interface VideoReferenceInput {
  source: string;
  media_type?: VideoReferenceMediaType;
  label?: string;
}

export interface VideoReferenceUploadInput {
  projectPath: string;
  projectRelativePath: string;
  contentType: string;
  byteLength: number;
}

export type VideoReferenceUploadService = (input: VideoReferenceUploadInput) => Promise<{ url: string; expiresAt?: string }>;

export type VideoArgumentErrorCode =
  | 'video_argument_invalid'
  | 'video_reference_missing'
  | 'video_reference_type_unsupported'
  | 'video_reference_count_invalid'
  | 'video_reference_upload_unavailable';

export class VideoArgumentError extends Error {
  constructor(readonly code: VideoArgumentErrorCode, message: string) {
    super(message);
    this.name = 'VideoArgumentError';
  }
}

export interface NormalizeSeedanceVideoArgumentsInput {
  projectRoot: string;
  catalogEntry: VideoModelCatalogEntry;
  args: Record<string, unknown>;
  uploadVideoReference?: VideoReferenceUploadService;
  remoteUrlLookup?: PublicRemoteHostLookup;
}

export interface NormalizedSeedanceVideoArguments {
  upstreamArgs: Record<string, unknown>;
  redactedDebruteArgs: Record<string, unknown>;
}

interface NormalizedReference {
  source: string;
  mediaType: VideoReferenceMediaType;
  url: string;
}

interface ReferencePreview {
  source: string;
  mediaType: VideoReferenceMediaType;
}

const OUTPUT_ARGUMENT_KEYS = new Set(['output_path', 'output_directory']);
const PASSTHROUGH_ARGUMENT_KEYS = new Set([
  'callback_url',
  'return_last_frame',
  'execution_expires_after',
  'generate_audio',
  'tools',
  'safety_identifier',
  'resolution',
  'ratio',
  'duration',
  'frames',
  'seed',
  'camera_fixed',
  'watermark',
  'extend_direction',
  'edit_scope'
]);
const PUBLIC_ARGUMENT_KEYS = new Set([
  'prompt',
  'intent',
  'references',
  ...PASSTHROUGH_ARGUMENT_KEYS,
  ...OUTPUT_ARGUMENT_KEYS
]);
export async function normalizeSeedanceVideoArguments(input: NormalizeSeedanceVideoArgumentsInput): Promise<NormalizedSeedanceVideoArguments> {
  assertKnownArgumentKeys(input.args);
  const prompt = stringArg(input.args, 'prompt');
  if (!prompt) {
    throw new VideoArgumentError('video_argument_invalid', 'Video request arguments.prompt must be a non-empty string.');
  }
  const intent = intentArg(input.args);
  const references = referencesArg(input.args);
  validateRuntimeArgs(input.args, input.catalogEntry);
  validateIntentReferences(intent, references.map(referencePreview));
  const normalizedReferences = await Promise.all(references.map((reference) => normalizeReference({
    projectRoot: input.projectRoot,
    reference,
    ...(input.uploadVideoReference ? { uploadVideoReference: input.uploadVideoReference } : {}),
    ...(input.remoteUrlLookup ? { remoteUrlLookup: input.remoteUrlLookup } : {})
  })));

  const upstreamArgs = {
    ...forwardRuntimeArgs(input.args),
    content: buildContent({ prompt, intent, references: normalizedReferences })
  };
  return {
    upstreamArgs,
    redactedDebruteArgs: redactDebruteArgs(input.args)
  };
}

export function stripVideoOutputArgs(args: Record<string, unknown>): Record<string, unknown> {
  const next = { ...args };
  for (const key of OUTPUT_ARGUMENT_KEYS) {
    delete next[key];
  }
  return next;
}

function assertKnownArgumentKeys(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (!PUBLIC_ARGUMENT_KEYS.has(key)) {
      throw new VideoArgumentError('video_argument_invalid', `Unsupported video request argument: ${key}.`);
    }
  }
}

async function normalizeReference(input: {
  projectRoot: string;
  reference: VideoReferenceInput;
  uploadVideoReference?: VideoReferenceUploadService;
  remoteUrlLookup?: PublicRemoteHostLookup;
}): Promise<NormalizedReference> {
  const source = input.reference.source.trim();
  const mediaType = input.reference.media_type ?? inferMediaType(source);
  if (!mediaType) {
    throw new VideoArgumentError('video_reference_type_unsupported', `Video reference media type cannot be inferred: ${source}`);
  }
  if (isHttpUrl(source) || source.startsWith('asset://')) {
    if (isHttpUrl(source)) {
      await assertPublicHttpUrl(source, 'Remote video reference URLs', { lookup: input.remoteUrlLookup });
    }
    return { source, mediaType, url: source };
  }
  if (source.startsWith('data:')) {
    return { source, mediaType, url: validateDataUrl(source, mediaType) };
  }

  const bytes = await readLocalReference(input.projectRoot, source);
  if (mediaType === 'image' || mediaType === 'mask') {
    return { source, mediaType, url: `data:${imageMimeType(Buffer.from(bytes), source)};base64,${Buffer.from(bytes).toString('base64')}` };
  }
  if (mediaType === 'audio') {
    return { source, mediaType, url: `data:${audioMimeType(source)};base64,${Buffer.from(bytes).toString('base64')}` };
  }
  if (!input.uploadVideoReference) {
    throw new VideoArgumentError('video_reference_upload_unavailable', `Project-local video reference requires a Seedance-reachable URL or asset reference: ${source}`);
  }
  const upload = await input.uploadVideoReference({
    projectPath: input.projectRoot,
    projectRelativePath: source,
    contentType: videoMimeType(source),
    byteLength: bytes.byteLength
  });
  return { source, mediaType, url: upload.url };
}

async function readLocalReference(projectRoot: string, source: string): Promise<Uint8Array> {
  try {
    return await readProjectFileBytes(projectRoot, source);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    throw new VideoArgumentError('video_reference_missing', `Video reference not found in project: ${source}`);
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

function validateRuntimeArgs(args: Record<string, unknown>, entry: VideoModelCatalogEntry): void {
  stringOptionalArg(args, 'callback_url');
  stringOptionalArg(args, 'safety_identifier');
  stringOptionalArg(args, 'edit_scope');
  stringOptionalArg(args, 'output_path');
  stringOptionalArg(args, 'output_directory');
  booleanOptionalArg(args, 'return_last_frame');
  booleanOptionalArg(args, 'generate_audio');
  booleanOptionalArg(args, 'camera_fixed');
  booleanOptionalArg(args, 'watermark');
  integerOptionalArg(args, 'execution_expires_after');
  integerOptionalArg(args, 'frames');
  enumOptionalArg(args, 'resolution', enumValues(entry, 'resolution'));
  enumOptionalArg(args, 'ratio', enumValues(entry, 'ratio'));
  enumOptionalArg(args, 'extend_direction', enumValues(entry, 'extend_direction'));
  durationOptionalArg(args, entry);
  seedOptionalArg(args);
  toolsOptionalArg(args);
}

function validateIntentReferences(intent: VideoIntent, references: ReferencePreview[]): void {
  if (intent === 'generate') {
    if (references.length > 2) {
      throw new VideoArgumentError('video_reference_count_invalid', 'Generate intent accepts zero, one, or two image references.');
    }
    if (references.some((reference) => reference.mediaType !== 'image')) {
      throw new VideoArgumentError('video_reference_type_unsupported', 'Generate intent accepts image references only.');
    }
    return;
  }
  if (intent === 'reference') {
    if (references.length === 0) {
      throw new VideoArgumentError('video_reference_count_invalid', 'Reference intent requires at least one image, video, or audio reference.');
    }
    if (references.some((reference) => reference.mediaType !== 'image' && reference.mediaType !== 'video' && reference.mediaType !== 'audio')) {
      throw new VideoArgumentError('video_reference_type_unsupported', 'Reference intent accepts image, video, and audio references only.');
    }
    return;
  }
  if (intent === 'audio_driven') {
    const audio = references.filter((reference) => reference.mediaType === 'audio');
    const visual = references.filter((reference) => reference.mediaType === 'image' || reference.mediaType === 'video');
    if (audio.length !== 1 || visual.length > 1 || audio.length + visual.length !== references.length) {
      throw new VideoArgumentError('video_reference_count_invalid', 'Audio-driven intent requires exactly one audio reference and at most one image or video reference.');
    }
    return;
  }
  if (intent === 'extend') {
    if (references.length === 0 || references.some((reference) => reference.mediaType !== 'video')) {
      throw new VideoArgumentError('video_reference_type_unsupported', 'Extend intent requires video references.');
    }
    return;
  }
  if (references.length === 0) {
    throw new VideoArgumentError('video_reference_count_invalid', 'Edit intent requires at least one reference.');
  }
}

function referencePreview(reference: VideoReferenceInput): ReferencePreview {
  const source = reference.source.trim();
  const mediaType = reference.media_type ?? inferMediaType(source);
  if (!mediaType) {
    throw new VideoArgumentError('video_reference_type_unsupported', `Video reference media type cannot be inferred: ${source}`);
  }
  return { source, mediaType };
}

function buildContent(input: { prompt: string; intent: VideoIntent; references: NormalizedReference[] }): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];
  if (input.intent === 'generate') {
    appendGenerateReferences(content, input.references);
  } else if (input.intent === 'reference') {
    appendReferenceReferences(content, input.references);
  } else if (input.intent === 'audio_driven') {
    appendAudioDrivenReferences(content, input.references);
  } else if (input.intent === 'extend') {
    appendExtendReferences(content, input.references);
  } else {
    appendEditReferences(content, input.references);
  }
  return content;
}

function appendGenerateReferences(content: Array<Record<string, unknown>>, references: NormalizedReference[]): void {
  if (references[0]) {
    content.push(seedanceReference(references[0], 'first_frame'));
  }
  if (references[1]) {
    content.push(seedanceReference(references[1], 'last_frame'));
  }
}

function appendReferenceReferences(content: Array<Record<string, unknown>>, references: NormalizedReference[]): void {
  for (const reference of references) {
    if (reference.mediaType === 'image') {
      content.push(seedanceReference(reference, 'reference_image'));
    } else if (reference.mediaType === 'video') {
      content.push(seedanceReference(reference, 'reference_video'));
    } else if (reference.mediaType === 'audio') {
      content.push(seedanceReference(reference, 'reference_audio'));
    }
  }
}

function appendAudioDrivenReferences(content: Array<Record<string, unknown>>, references: NormalizedReference[]): void {
  for (const reference of references) {
    content.push(seedanceReference(reference, reference.mediaType === 'audio' ? 'driver_audio' : reference.mediaType === 'image' ? 'reference_image' : 'reference_video'));
  }
}

function appendExtendReferences(content: Array<Record<string, unknown>>, references: NormalizedReference[]): void {
  for (const reference of references) {
    content.push(seedanceReference(reference, 'segment'));
  }
}

function appendEditReferences(content: Array<Record<string, unknown>>, references: NormalizedReference[]): void {
  for (const reference of references) {
    const role = reference.mediaType === 'mask'
      ? 'mask'
      : reference.mediaType === 'video'
        ? 'source_video'
        : reference.mediaType === 'audio'
          ? 'reference_audio'
          : 'reference_image';
    content.push(seedanceReference(reference, role));
  }
}

function seedanceReference(reference: NormalizedReference, role: string): Record<string, unknown> {
  if (reference.mediaType === 'image' || reference.mediaType === 'mask') {
    return { type: 'image_url', image_url: { url: reference.url }, role };
  }
  if (reference.mediaType === 'audio') {
    return { type: 'audio_url', audio_url: { url: reference.url }, role };
  }
  return { type: 'video_url', video_url: { url: reference.url }, role };
}

function referencesArg(args: Record<string, unknown>): VideoReferenceInput[] {
  const value = args.references;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new VideoArgumentError('video_argument_invalid', 'Video request arguments.references must be an array.');
  }
  return value.map((item, index): VideoReferenceInput => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new VideoArgumentError('video_argument_invalid', `Video request references[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'source' && key !== 'media_type' && key !== 'label') {
        throw new VideoArgumentError('video_argument_invalid', `Unsupported video reference argument: references[${index}].${key}.`);
      }
    }
    if (typeof record.source !== 'string' || !record.source.trim()) {
      throw new VideoArgumentError('video_argument_invalid', `Video request references[${index}].source must be a non-empty string.`);
    }
    const mediaType = record.media_type;
    if (mediaType !== undefined && !isMediaType(mediaType)) {
      throw new VideoArgumentError('video_argument_invalid', `Video request references[${index}].media_type must be image, video, audio, or mask.`);
    }
    return {
      source: record.source,
      ...(mediaType ? { media_type: mediaType } : {}),
      ...(typeof record.label === 'string' ? { label: record.label } : {})
    };
  });
}

function intentArg(args: Record<string, unknown>): VideoIntent {
  const value = args.intent;
  if (value === undefined) {
    return 'generate';
  }
  if (value === 'generate' || value === 'reference' || value === 'audio_driven' || value === 'extend' || value === 'edit') {
    return value;
  }
  throw new VideoArgumentError('video_argument_invalid', 'Video request arguments.intent must be generate, reference, audio_driven, extend, or edit.');
}

function stringOptionalArg(args: Record<string, unknown>, key: string): void {
  const value = args[key];
  if (value !== undefined && typeof value !== 'string') {
    throw new VideoArgumentError('video_argument_invalid', `Video request arguments.${key} must be a string.`);
  }
}

function booleanOptionalArg(args: Record<string, unknown>, key: string): void {
  const value = args[key];
  if (value !== undefined && typeof value !== 'boolean') {
    throw new VideoArgumentError('video_argument_invalid', `Video request arguments.${key} must be a boolean.`);
  }
}

function integerOptionalArg(args: Record<string, unknown>, key: string): void {
  const value = args[key];
  if (value !== undefined && (!Number.isInteger(value) || typeof value !== 'number')) {
    throw new VideoArgumentError('video_argument_invalid', `Video request arguments.${key} must be an integer.`);
  }
}

function durationOptionalArg(args: Record<string, unknown>, entry: VideoModelCatalogEntry): void {
  integerOptionalArg(args, 'duration');
  const value = args.duration;
  if (typeof value !== 'number') {
    return;
  }
  const duration = objectAt(entry.capabilities.duration);
  const minimum = numberAt(duration, 'minimum');
  const maximum = numberAt(duration, 'maximum');
  const modelSelected = numberAt(duration, 'model_selected');
  if (value === modelSelected) {
    return;
  }
  if ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
    const selected = modelSelected === undefined ? '' : `${modelSelected} or `;
    throw new VideoArgumentError('video_argument_invalid', `Video request arguments.duration must be ${selected}between ${minimum} and ${maximum}.`);
  }
}

function enumOptionalArg(args: Record<string, unknown>, key: string, values: string[]): void {
  const value = args[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new VideoArgumentError('video_argument_invalid', `Video request arguments.${key} must be one of: ${values.join(', ')}.`);
  }
}

function seedOptionalArg(args: Record<string, unknown>): void {
  const value = args.seed;
  if (value !== undefined && value !== null && typeof value !== 'string' && (!Number.isInteger(value) || typeof value !== 'number')) {
    throw new VideoArgumentError('video_argument_invalid', 'Video request arguments.seed must be an integer, string, or null.');
  }
}

function toolsOptionalArg(args: Record<string, unknown>): void {
  const value = args.tools;
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new VideoArgumentError('video_argument_invalid', 'Video request arguments.tools must be an array of objects.');
  }
}

function enumValues(entry: VideoModelCatalogEntry, key: string): string[] {
  const schema = propertySchema(entry, key);
  return Array.isArray(schema?.enum) ? schema.enum.filter((value): value is string => typeof value === 'string') : [];
}

function propertySchema(entry: VideoModelCatalogEntry, key: string): Record<string, unknown> | undefined {
  const properties = objectAt(entry.argumentsSchema.properties);
  return objectAt(properties?.[key]);
}

function numberAt(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const item = value?.[key];
  return typeof item === 'number' ? item : undefined;
}

function forwardRuntimeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const forwarded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (PASSTHROUGH_ARGUMENT_KEYS.has(key) || OUTPUT_ARGUMENT_KEYS.has(key)) {
      forwarded[key] = value;
    }
  }
  return forwarded;
}

function redactDebruteArgs(args: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(args, (_key, value: unknown) => (
    typeof value === 'string' && /^data:(image|audio|video)\//.test(value)
      ? '[redacted data url]'
      : value
  ))) as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function inferMediaType(source: string): VideoReferenceMediaType | undefined {
  if (source.startsWith('data:image/')) {
    return 'image';
  }
  if (source.startsWith('data:audio/')) {
    return 'audio';
  }
  if (source.startsWith('data:video/')) {
    return 'video';
  }
  const ext = extname(pathForExtension(source)).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    return 'image';
  }
  if (['.mp4', '.mov', '.webm'].includes(ext)) {
    return 'video';
  }
  if (['.mp3', '.wav', '.m4a', '.aac'].includes(ext)) {
    return 'audio';
  }
  return undefined;
}

function pathForExtension(source: string): string {
  if (!isHttpUrl(source)) {
    return source;
  }
  try {
    return new URL(source).pathname;
  } catch {
    return source;
  }
}

function isMediaType(value: unknown): value is VideoReferenceMediaType {
  return value === 'image' || value === 'video' || value === 'audio' || value === 'mask';
}

function objectAt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validateDataUrl(source: string, mediaType: VideoReferenceMediaType): string {
  if ((mediaType === 'image' || mediaType === 'mask') && source.startsWith('data:image/')) {
    return source;
  }
  if (mediaType === 'audio' && source.startsWith('data:audio/')) {
    return source;
  }
  throw new VideoArgumentError('video_reference_type_unsupported', `Data URL MIME type is not supported for reference media type: ${mediaType}`);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function imageMimeType(bytes: Buffer, path: string): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (/\.webp$/i.test(path)) {
    return 'image/webp';
  }
  return 'image/png';
}

function audioMimeType(path: string): string {
  if (/\.mp3$/i.test(path)) {
    return 'audio/mpeg';
  }
  if (/\.m4a$/i.test(path)) {
    return 'audio/mp4';
  }
  if (/\.aac$/i.test(path)) {
    return 'audio/aac';
  }
  return 'audio/wav';
}

function videoMimeType(path: string): string {
  if (/\.mov$/i.test(path)) {
    return 'video/quicktime';
  }
  if (/\.webm$/i.test(path)) {
    return 'video/webm';
  }
  return 'video/mp4';
}
