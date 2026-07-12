import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createVideoModelCatalog,
  describeVideoModelOfficialDoc,
  listVideoModelOfficialDocs
} from '@debrute/capability-runtime';

const root = process.cwd();

describe('video model official docs', () => {
  it('covers every current video catalog model with official docs and snapshots', async () => {
    const catalogModels = createVideoModelCatalog().listAll();
    const docRefs = listVideoModelOfficialDocs();

    expect(docRefs.map((doc) => doc.modelId).sort()).toEqual(catalogModels.map((model) => model.debruteModelId).sort());
    for (const doc of docRefs) {
      expect(doc.sourceUrls.length).toBeGreaterThan(0);
      expect(doc.snapshotPath).toMatch(/^packages\/capability-runtime\/src\/videoModels\/officialDocs\/snapshots\/.+\.md$/);
      const snapshot = await readFile(join(root, doc.snapshotPath), 'utf8');
      expect(snapshot).toMatch(/^---\n/);
      expect(snapshot).toContain(`  - ${doc.modelId}`);
      expect(snapshot).toContain('source_urls:');
      expect(snapshot).toContain(`captured_at: ${doc.capturedAt}`);
      expect(snapshot).toContain('cleanup:');
      expect(snapshot).not.toMatch(/cookie banner|advertisement|site navigation|login prompt/i);
    }
  });

  it('returns model-scoped Seedance markdown with Debrute command examples', async () => {
    const doc = await describeVideoModelOfficialDoc('doubao-seedance-2-0-260128');

    expect(doc).toBeDefined();
    expect(doc?.sourceUrls).toContain('https://www.volcengine.com/docs/82379/2291680');
    expect(doc?.snapshotPath).toBe('packages/capability-runtime/src/videoModels/officialDocs/snapshots/volcengine-ark/seedance-2.md');
    expect(doc?.descriptionMarkdown).toContain('# doubao-seedance-2-0-260128');
    expect(doc?.descriptionMarkdown).toContain('Official documentation:');
    expect(doc?.descriptionMarkdown).toContain('Repository snapshot:');
    expect(doc?.descriptionMarkdown).toContain('debrute generate video <project> --input-json');
    expect(doc?.descriptionMarkdown).toContain('"prompt"');
    expect(doc?.descriptionMarkdown).not.toContain('"content":[{');
  });
});
