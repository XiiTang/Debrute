import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createImageModelCatalog,
  describeImageModelOfficialDoc,
  listImageModelOfficialDocs
} from '@axis/capability-runtime';

const root = process.cwd();

describe('image model official documentation', () => {
  it('covers every current image catalog model with official docs and snapshots', async () => {
    const catalogModelIds = createImageModelCatalog().listAll().map((model) => model.axisModelId).sort();
    const docRefs = listImageModelOfficialDocs();

    expect(docRefs.map((doc) => doc.modelId).sort()).toEqual(catalogModelIds);

    for (const doc of docRefs) {
      expect(doc.provider).toEqual(expect.any(String));
      expect(doc.sourceUrls.length).toBeGreaterThan(0);
      for (const url of doc.sourceUrls) {
        expect(url).toMatch(/^https:\/\/.+/);
      }
      expect(doc.snapshotPath).toMatch(/^packages\/capability-runtime\/src\/imageModels\/officialDocs\/snapshots\/.+\.md$/);
      expect(doc.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(doc.appliesToModels).toContain(doc.modelId);

      const snapshot = await readFile(join(root, doc.snapshotPath), 'utf8');
      expect(snapshot).toMatch(/^---\n/);
      expect(snapshot).toContain(`provider: ${doc.provider}`);
      expect(snapshot).toContain(`  - ${doc.modelId}`);
      expect(snapshot).toContain('source_urls:');
      expect(snapshot).toContain(`captured_at: ${doc.capturedAt}`);
      expect(snapshot).toContain('cleanup:');
      expect(snapshot).not.toMatch(/cookie banner|advertisement|site navigation|login prompt/i);
    }
  });

  it('returns model-level markdown with source metadata and AXIS command examples', async () => {
    const catalogModels = createImageModelCatalog().listAll();
    const docs = await Promise.all(catalogModels.map((model) => describeImageModelOfficialDoc(model.axisModelId)));

    for (let index = 0; index < docs.length; index += 1) {
      const maybeDoc = docs[index];
      const catalogModel = catalogModels[index]!;
      expect(maybeDoc).toBeDefined();
      if (!maybeDoc) {
        throw new Error('Expected official image model documentation to be defined.');
      }
      expect(maybeDoc.descriptionMarkdown).toContain(`# ${maybeDoc.modelId}`);
      expect(maybeDoc.descriptionMarkdown).toContain('Official documentation:');
      expect(maybeDoc.descriptionMarkdown).toContain('Repository snapshot:');
      expect(maybeDoc.descriptionMarkdown).toContain(maybeDoc.snapshotPath);
      expect(maybeDoc.descriptionMarkdown).toContain('axis generate image <project> --input-json');
      expect(maybeDoc.descriptionMarkdown).toContain(`"model":"${maybeDoc.modelId}"`);
      expect(axisCommandInput(maybeDoc.descriptionMarkdown)).toEqual(catalogModel.requestExample.input);
      expect(maybeDoc.descriptionMarkdown).not.toMatch(/curl\s+https:\/\/api\./i);
      expect(maybeDoc.descriptionMarkdown).not.toMatch(/npm install|pip install|import OpenAI|from openai import/i);
    }
  });

  it('includes official gpt-image-2 mask requirements in the model description', async () => {
    const doc = await describeImageModelOfficialDoc('gpt-image-2');

    expect(doc?.descriptionMarkdown).toContain('Mask requirements');
    expect(doc?.descriptionMarkdown).toContain('same format and size');
    expect(doc?.descriptionMarkdown).toContain('less than 50MB');
    expect(doc?.descriptionMarkdown).toContain('alpha channel');
  });

  it('does not expose old hand-authored usage notes in image model details', () => {
    const catalog = createImageModelCatalog();
    const details = catalog.details(catalog.listAll().map((model) => model.axisModelId)).details;

    for (const detail of details) {
      expect('usageNotes' in detail).toBe(false);
    }
  });
});

function axisCommandInput(markdown: string): unknown {
  const match = markdown.match(/axis generate image <project> --input-json '([^']+)'/);
  if (!match) {
    throw new Error('Expected model description to contain an AXIS command input JSON payload.');
  }
  return JSON.parse(match[1]!);
}
