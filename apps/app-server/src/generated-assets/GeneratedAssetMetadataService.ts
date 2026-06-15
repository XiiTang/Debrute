import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  normalizeProjectRelativePath,
  readJsonFile,
  resolveExistingProjectPath,
  resolveProjectPathForWrite
} from '@debrute/project-core';
import type {
  GeneratedAssetMetadataDiagnostic,
  GeneratedAssetMetadataLookup,
  GeneratedAssetRecord
} from '@debrute/app-protocol';
import {
  commitProjectDocumentTransaction,
  projectDocumentFileHash,
  projectDocumentTextHash
} from '../project-documents/ProjectDocumentTransaction.js';
import { projectDocumentDescriptorForPath } from '../project-documents/documentDescriptors.js';

export interface GeneratedAssetMetadataIndex {
  schemaVersion: 1;
  records: GeneratedAssetMetadataIndexEntry[];
}

export interface GeneratedAssetMetadataIndexEntry {
  recordId: string;
  createdAt: string;
  fingerprint: {
    algorithm: 'sha256';
    hash: string;
  };
  metadataPath: string;
}

export interface FileFingerprintCache {
  schemaVersion: 1;
  entries: Record<string, FileFingerprintCacheEntry>;
}

export interface FileFingerprintCacheEntry {
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  computedAt: string;
}

export interface RecordGeneratedAssetInput {
  projectRelativePath: string;
  modelRun: {
    request: unknown;
    output: unknown;
  };
}

export interface GeneratedAssetMetadataService {
  recordGeneratedAsset(projectRoot: string, input: RecordGeneratedAssetInput): Promise<GeneratedAssetRecord>;
  lookupGeneratedAssetMetadata(projectRoot: string, input: { projectRelativePath: string }): Promise<GeneratedAssetMetadataLookup>;
  listGeneratedAssets(projectRoot: string): Promise<GeneratedAssetRecord[]>;
  readGeneratedAsset(projectRoot: string, recordId: string): Promise<GeneratedAssetRecord>;
  resolveGeneratedAssetRawPath(projectRoot: string, recordId: string): Promise<string>;
}

export interface GeneratedAssetMetadataServiceOptions {
  now?: () => string;
  createRecordId?: () => string;
  onDiagnostic?: (diagnostic: GeneratedAssetMetadataDiagnostic) => void;
  writeStructuredDocuments?: (input: {
    projectRoot: string;
    owner: string;
    reads: Array<{ absolutePath: string; expectedHash: string | null }>;
    writes: Array<{ absolutePath: string; content: string }>;
  }) => Promise<void>;
}

const GENERATED_ASSET_METADATA_SCHEMA_VERSION = 1;
const FILE_FINGERPRINT_CACHE_SCHEMA_VERSION = 1;
const GENERATED_ASSET_INDEX_PROJECT_PATH = '.debrute/assets/generated-assets-index.json';
const GENERATED_ASSET_RECORDS_PROJECT_DIR = '.debrute/assets/generated';
const FINGERPRINT_CACHE_PROJECT_PATH = '.debrute/cache/file-fingerprints.json';

export function createGeneratedAssetMetadataService(options: GeneratedAssetMetadataServiceOptions = {}): GeneratedAssetMetadataService {
  const now = options.now ?? (() => new Date().toISOString());
  const createRecordId = options.createRecordId ?? randomUUID;
  const onDiagnostic = options.onDiagnostic;
  const writeStructuredDocuments = options.writeStructuredDocuments ?? ((input) => commitProjectDocumentTransaction(input));

  return {
    async recordGeneratedAsset(projectRoot, input) {
      const projectRelativePath = normalizeProjectRelativePath(input.projectRelativePath);
      const absolutePath = await resolveExistingProjectPath(projectRoot, projectRelativePath);
      const initialFileStat = await stat(absolutePath);
      if (!initialFileStat.isFile()) {
        throw new Error(`Generated asset path is not a file: ${projectRelativePath}`);
      }
      const assetFileHash = await projectDocumentFileHash(absolutePath);
      if (!assetFileHash) {
        throw new Error(`Generated asset path is missing: ${projectRelativePath}`);
      }
      const fileStat = await stat(absolutePath);
      const hash = sha256FromProjectDocumentHash(assetFileHash);
      const recordId = createRecordId();
      assertGeneratedAssetRecordId(recordId);
      const createdAt = now();
      const record: GeneratedAssetRecord = {
        schemaVersion: GENERATED_ASSET_METADATA_SCHEMA_VERSION,
        recordId,
        projectRelativePath,
        createdAt,
        fingerprint: {
          algorithm: 'sha256',
          hash
        },
        modelRun: input.modelRun
      };

      const index = await readGeneratedAssetMetadataIndexState(projectRoot);
      const recordPath = await resolveProjectPathForWrite(projectRoot, generatedAssetMetadataRecordProjectPath(record.recordId));
      const nextIndex: GeneratedAssetMetadataIndex = {
        schemaVersion: GENERATED_ASSET_METADATA_SCHEMA_VERSION,
        records: [
          ...index.document.records,
          {
            recordId,
            createdAt,
            fingerprint: record.fingerprint,
            metadataPath: generatedAssetMetadataRecordProjectPath(recordId)
          }
        ]
      };
      await writeStructuredDocuments({
        projectRoot,
        owner: 'generated-assets',
        reads: [
          { absolutePath, expectedHash: assetFileHash },
          { absolutePath: index.absolutePath, expectedHash: index.expectedHash },
          { absolutePath: recordPath, expectedHash: null }
        ],
        writes: [
          {
            absolutePath: recordPath,
            content: `${JSON.stringify(record, null, 2)}\n`
          },
          {
            absolutePath: index.absolutePath,
            content: `${JSON.stringify(nextIndex, null, 2)}\n`
          }
        ]
      });
      await updateFingerprintCacheBestEffort(projectRoot, projectRelativePath, {
        sizeBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        sha256: hash,
        computedAt: createdAt
      }, writeStructuredDocuments, onDiagnostic);
      return record;
    },

    async lookupGeneratedAssetMetadata(projectRoot, input) {
      const projectRelativePath = normalizeProjectRelativePath(input.projectRelativePath);
      let absolutePath: string;
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        absolutePath = await resolveExistingProjectPath(projectRoot, projectRelativePath);
      } catch (error) {
        if (isNotFoundError(error)) {
          return unavailableResult(error, projectRelativePath);
        }
        throw error;
      }
      try {
        fileStat = await stat(absolutePath);
      } catch (error) {
        return unavailableResult(error, projectRelativePath);
      }
      if (!fileStat.isFile()) {
        return {
          status: 'unavailable',
          reason: 'unreadable',
          message: `Project path is not a file: ${projectRelativePath}`
        };
      }

      const cache = await readFingerprintCache(projectRoot);
      const cached = cache.entries[projectRelativePath];
      const cacheHit = cached?.sizeBytes === fileStat.size && cached.mtimeMs === fileStat.mtimeMs;
      const hash = cacheHit ? cached.sha256 : await sha256File(absolutePath);
      const cacheDiagnostics: GeneratedAssetMetadataDiagnostic[] = [];
      if (!cacheHit) {
        const cacheDiagnostic = await updateFingerprintCacheBestEffort(projectRoot, projectRelativePath, {
          sizeBytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          sha256: hash,
          computedAt: now()
        }, writeStructuredDocuments, onDiagnostic);
        if (cacheDiagnostic) {
          cacheDiagnostics.push(cacheDiagnostic);
        }
      }

      let index: GeneratedAssetMetadataIndex;
      try {
        index = await readGeneratedAssetMetadataIndex(projectRoot);
      } catch (error) {
        return {
          status: 'unavailable',
          reason: 'metadata_unreadable',
          message: `Unable to read generated asset metadata index: ${errorMessage(error)}`
        };
      }

      const diagnostics: GeneratedAssetMetadataDiagnostic[] = [...cacheDiagnostics];
      const records: GeneratedAssetRecord[] = [];
      const matchingEntries = index.records
        .filter((record) => record.fingerprint.algorithm === 'sha256' && record.fingerprint.hash === hash)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.recordId.localeCompare(left.recordId));

      for (const entry of matchingEntries) {
        try {
          records.push(await readGeneratedAssetRecord(projectRoot, entry));
        } catch (error) {
          diagnostics.push({
            code: 'generated_asset_metadata_record_unreadable',
            message: errorMessage(error),
            recordId: entry.recordId,
            metadataPath: entry.metadataPath
          });
        }
      }

      const diagnosticOutput = diagnostics.length ? { diagnostics } : {};
      return records.length
        ? { status: 'matched', fingerprint: { algorithm: 'sha256', hash }, records, ...diagnosticOutput }
        : { status: 'unmatched', fingerprint: { algorithm: 'sha256', hash }, ...diagnosticOutput };
    },

    async listGeneratedAssets(projectRoot) {
      const index = await readGeneratedAssetMetadataIndex(projectRoot);
      const records = await Promise.all(index.records.map((entry) => readGeneratedAssetRecord(projectRoot, entry)));
      return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.recordId.localeCompare(left.recordId));
    },

    async readGeneratedAsset(projectRoot, recordId) {
      return readGeneratedAssetById(projectRoot, recordId);
    },

    async resolveGeneratedAssetRawPath(projectRoot, recordId) {
      const record = await readGeneratedAssetById(projectRoot, recordId);
      return resolveExistingProjectPath(projectRoot, record.projectRelativePath);
    }
  };
}

export function generatedAssetMetadataPaths(projectRoot: string): { indexFile: string; recordsDir: string; cacheFile: string } {
  return {
    indexFile: join(projectRoot, GENERATED_ASSET_INDEX_PROJECT_PATH),
    recordsDir: join(projectRoot, GENERATED_ASSET_RECORDS_PROJECT_DIR),
    cacheFile: join(projectRoot, FINGERPRINT_CACHE_PROJECT_PATH)
  };
}

function generatedAssetMetadataRecordProjectPath(recordId: string): string {
  return `${GENERATED_ASSET_RECORDS_PROJECT_DIR}/${recordId}.json`;
}

async function readGeneratedAssetMetadataIndex(projectRoot: string): Promise<GeneratedAssetMetadataIndex> {
  return (await readGeneratedAssetMetadataIndexState(projectRoot)).document;
}

async function readGeneratedAssetMetadataIndexState(
  projectRoot: string
): Promise<{ absolutePath: string; document: GeneratedAssetMetadataIndex; expectedHash: string | null }> {
  const absolutePath = await resolveProjectPathForWrite(projectRoot, GENERATED_ASSET_INDEX_PROJECT_PATH);
  try {
    const content = await readFile(await resolveExistingProjectPath(projectRoot, GENERATED_ASSET_INDEX_PROJECT_PATH), 'utf8');
    return {
      absolutePath,
      document: assertGeneratedAssetMetadataIndex(JSON.parse(content)),
      expectedHash: projectDocumentTextHash(content)
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        absolutePath,
        document: { schemaVersion: GENERATED_ASSET_METADATA_SCHEMA_VERSION, records: [] },
        expectedHash: null
      };
    }
    throw error;
  }
}

function assertGeneratedAssetMetadataIndex(value: unknown): GeneratedAssetMetadataIndex {
  if (!isRecord(value) || value.schemaVersion !== GENERATED_ASSET_METADATA_SCHEMA_VERSION || !Array.isArray(value.records)) {
    throw new Error('Invalid generated asset metadata index.');
  }
  for (const entry of value.records) {
    if (!isRecord(entry)
      || typeof entry.recordId !== 'string'
      || typeof entry.createdAt !== 'string'
      || typeof entry.metadataPath !== 'string'
      || !isRecord(entry.fingerprint)
      || entry.fingerprint.algorithm !== 'sha256'
      || !isSha256Hash(entry.fingerprint.hash)
      || !isGeneratedAssetMetadataRecordProjectPath(entry.metadataPath)) {
      throw new Error('Invalid generated asset metadata index entry.');
    }
  }
  return {
    schemaVersion: GENERATED_ASSET_METADATA_SCHEMA_VERSION,
    records: value.records
  };
}

async function readGeneratedAssetRecord(projectRoot: string, entry: GeneratedAssetMetadataIndexEntry): Promise<GeneratedAssetRecord> {
  const absolutePath = await resolveExistingProjectPath(projectRoot, entry.metadataPath);
  const record = await readJsonFile<unknown>(absolutePath);
  if (!isGeneratedAssetRecord(record)
    || record.recordId !== entry.recordId
    || record.fingerprint.algorithm !== entry.fingerprint.algorithm
    || record.fingerprint.hash !== entry.fingerprint.hash) {
    throw new Error(`Invalid generated asset metadata record: ${entry.metadataPath}`);
  }
  return record;
}

async function readGeneratedAssetById(projectRoot: string, recordId: string): Promise<GeneratedAssetRecord> {
  const index = await readGeneratedAssetMetadataIndex(projectRoot);
  const entry = index.records.find((item) => item.recordId === recordId);
  if (!entry) {
    throw new Error(`Generated asset was not found: ${recordId}`);
  }
  return readGeneratedAssetRecord(projectRoot, entry);
}

function isGeneratedAssetRecord(value: unknown): value is GeneratedAssetRecord {
  return isRecord(value)
    && value.schemaVersion === GENERATED_ASSET_METADATA_SCHEMA_VERSION
    && typeof value.recordId === 'string'
    && typeof value.projectRelativePath === 'string'
    && typeof value.createdAt === 'string'
    && isRecord(value.fingerprint)
    && value.fingerprint.algorithm === 'sha256'
    && isSha256Hash(value.fingerprint.hash)
    && isRecord(value.modelRun)
    && 'request' in value.modelRun
    && 'output' in value.modelRun;
}

async function readFingerprintCache(projectRoot: string): Promise<FileFingerprintCache> {
  return (await readFingerprintCacheState(projectRoot)).document;
}

async function readFingerprintCacheState(
  projectRoot: string
): Promise<{ absolutePath: string; document: FileFingerprintCache; expectedHash: string | null }> {
  const absolutePath = await resolveProjectPathForWrite(projectRoot, FINGERPRINT_CACHE_PROJECT_PATH);
  try {
    const content = await readFile(await resolveExistingProjectPath(projectRoot, FINGERPRINT_CACHE_PROJECT_PATH), 'utf8');
    return {
      absolutePath,
      document: assertFingerprintCache(JSON.parse(content)),
      expectedHash: projectDocumentTextHash(content)
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        absolutePath,
        document: { schemaVersion: FILE_FINGERPRINT_CACHE_SCHEMA_VERSION, entries: {} },
        expectedHash: null
      };
    }
    throw error;
  }
}

function assertFingerprintCache(value: unknown): FileFingerprintCache {
  if (!isRecord(value) || value.schemaVersion !== FILE_FINGERPRINT_CACHE_SCHEMA_VERSION || !isRecord(value.entries)) {
    throw new Error('Invalid generated asset fingerprint cache.');
  }
  const entries: Record<string, FileFingerprintCacheEntry> = {};
  for (const [projectRelativePath, entry] of Object.entries(value.entries)) {
    if (!isFileFingerprintCacheEntry(entry)) {
      throw new Error(`Invalid generated asset fingerprint cache entry: ${projectRelativePath}`);
    }
    entries[projectRelativePath] = entry;
  }
  return {
    schemaVersion: FILE_FINGERPRINT_CACHE_SCHEMA_VERSION,
    entries
  };
}

async function updateFingerprintCache(
  projectRoot: string,
  projectRelativePath: string,
  entry: FileFingerprintCacheEntry,
  writeStructuredDocuments: NonNullable<GeneratedAssetMetadataServiceOptions['writeStructuredDocuments']>
): Promise<void> {
  const cache = await readFingerprintCacheState(projectRoot);
  await writeStructuredDocuments({
    projectRoot,
    owner: 'generated-assets',
    reads: [{ absolutePath: cache.absolutePath, expectedHash: cache.expectedHash }],
    writes: [
      {
        absolutePath: cache.absolutePath,
        content: `${JSON.stringify({
          schemaVersion: FILE_FINGERPRINT_CACHE_SCHEMA_VERSION,
          entries: {
            ...cache.document.entries,
            [projectRelativePath]: entry
          }
        } satisfies FileFingerprintCache, null, 2)}\n`
      }
    ]
  });
}

async function updateFingerprintCacheBestEffort(
  projectRoot: string,
  projectRelativePath: string,
  entry: FileFingerprintCacheEntry,
  writeStructuredDocuments: NonNullable<GeneratedAssetMetadataServiceOptions['writeStructuredDocuments']>,
  onDiagnostic: GeneratedAssetMetadataServiceOptions['onDiagnostic']
): Promise<GeneratedAssetMetadataDiagnostic | undefined> {
  try {
    await updateFingerprintCache(projectRoot, projectRelativePath, entry, writeStructuredDocuments);
  } catch (error) {
    const diagnostic: GeneratedAssetMetadataDiagnostic = {
      code: 'generated_asset_fingerprint_cache_write_failed',
      message: errorMessage(error),
      metadataPath: FINGERPRINT_CACHE_PROJECT_PATH
    };
    onDiagnostic?.(diagnostic);
    return diagnostic;
  }
  return undefined;
}

function assertGeneratedAssetRecordId(recordId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(recordId) || recordId === '.' || recordId === '..') {
    throw new Error(`Invalid generated asset record id: ${recordId}`);
  }
}

async function sha256File(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);
    let settled = false;
    const settle = (error?: unknown, value?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      stream.removeAllListeners();
      if (error) {
        stream.destroy();
        reject(error);
        return;
      }
      resolve(value ?? '');
    };
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => settle(error));
    stream.on('end', () => settle(undefined, hash.digest('hex')));
  });
}

function sha256FromProjectDocumentHash(hash: string): string {
  return hash.slice('sha256:'.length);
}

function unavailableResult(error: unknown, projectRelativePath: string): Extract<GeneratedAssetMetadataLookup, { status: 'unavailable' }> {
  return {
    status: 'unavailable',
    reason: isNotFoundError(error) ? 'missing' : 'unreadable',
    message: error instanceof Error ? error.message : `Unable to read project file: ${projectRelativePath}`
  };
}

function isGeneratedAssetMetadataRecordProjectPath(metadataPath: string): boolean {
  return projectDocumentDescriptorForPath(metadataPath)?.type === 'generated-asset-record';
}

function isFileFingerprintCacheEntry(value: unknown): value is FileFingerprintCacheEntry {
  return isRecord(value)
    && typeof value.sizeBytes === 'number'
    && Number.isFinite(value.sizeBytes)
    && value.sizeBytes >= 0
    && typeof value.mtimeMs === 'number'
    && Number.isFinite(value.mtimeMs)
    && isSha256Hash(value.sha256)
    && typeof value.computedAt === 'string';
}

function isSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
