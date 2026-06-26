import { normalizeProjectRelativePath } from './projectPathNormalization.js';

const READABLE_CACHE_KEY_PREFIX_MAX_LENGTH = 96;
const CACHE_KEY_HASH_LENGTH = 16;
const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

export function projectRelativePathCacheKey(projectRelativePath: string): string {
  const normalized = normalizeProjectRelativePath(projectRelativePath);
  const encoded = encodeURIComponent(normalized);
  const readablePrefix = truncateEncodedPrefix(encoded, READABLE_CACHE_KEY_PREFIX_MAX_LENGTH);
  const hash = stablePathHashHex(normalized);
  return assertCachePathSegment(`${readablePrefix}--${hash}`, 'Project relative path cache key');
}

export function projectRevisionCacheKey(revision: string): string {
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new Error('Project revision cache key source must be non-empty.');
  }
  return assertCachePathSegment(encodeURIComponent(revision), 'Project revision cache key');
}

function truncateEncodedPrefix(encoded: string, maxLength: number): string {
  if (encoded.length <= maxLength) {
    return encoded;
  }
  let truncated = encoded.slice(0, maxLength);
  const lastPercent = truncated.lastIndexOf('%');
  if (lastPercent >= 0 && truncated.length - lastPercent < 3) {
    truncated = truncated.slice(0, lastPercent);
  }
  return truncated || 'path';
}

function assertCachePathSegment(segment: string, label: string): string {
  if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
    throw new Error(`${label} must be a filesystem-safe path segment.`);
  }
  return segment;
}

function stablePathHashHex(value: string): string {
  let hash = FNV64_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(CACHE_KEY_HASH_LENGTH, '0');
}
