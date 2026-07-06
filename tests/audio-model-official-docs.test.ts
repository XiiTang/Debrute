import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAudioModelCatalog,
  describeAudioModelOfficialDoc,
  listAudioModelOfficialDocs
} from '@debrute/capability-runtime';

const root = process.cwd();
const requiredSnapshotSections = [
  'Endpoint',
  'Authentication',
  'Request fields',
  'Response fields',
  'Audio encoding',
  'MIME type',
  'Task lifecycle'
] as const;
const vagueSnapshotPhrases = [
  /\bmay contain\b/i,
  /\bcommonly\b/i,
  /\btypically\b/i,
  /\bdepending on\b/i,
  /\bbest effort\b/i,
  /\bfallback\b/i,
  /\blegacy\b/i,
  /\bmigration\b/i,
  /\bcompat(?:ibility|ible)?\b/i
];

describe('audio model official documentation', () => {
  it('covers every current audio catalog model with official docs and snapshots', async () => {
    const catalogModels = createAudioModelCatalog().listAll();
    const docRefs = listAudioModelOfficialDocs();

    expect(docRefs.map((doc) => doc.modelId).sort()).toEqual(catalogModels.map((model) => model.debruteModelId).sort());
    for (const doc of docRefs) {
      expect(doc.sourceUrls.length).toBeGreaterThan(0);
      for (const url of doc.sourceUrls) {
        expect(url).toMatch(/^https:\/\/.+/);
      }
      expect(doc.snapshotPath).toMatch(/^packages\/capability-runtime\/src\/audioModels\/officialDocs\/snapshots\/.+\.md$/);
      expect(doc.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(doc.appliesToModels).toContain(doc.modelId);

      const snapshot = await readFile(join(root, doc.snapshotPath), 'utf8');
      expect(snapshot).toMatch(/^---\n/);
      expect(snapshot).toContain(`  - ${doc.modelId}`);
      expect(snapshot).toContain('source_urls:');
      expect(snapshot).toContain(`captured_at: ${doc.capturedAt}`);
      expect(snapshot).toContain('cleanup:');
      expect(snapshot).not.toMatch(/cookie banner|advertisement|site navigation|login prompt/i);
    }
  });

  it('requires exact official contract sections for each audio model snapshot', async () => {
    const docs = listAudioModelOfficialDocs();

    for (const doc of docs) {
      const snapshot = await readFile(join(root, doc.snapshotPath), 'utf8');
      for (const section of requiredSnapshotSections) {
        expect(snapshot, `${doc.modelId} ${section}`).toContain(`## ${section}`);
      }
    }
  });

  it('keeps official audio snapshots free of vague response contracts', async () => {
    const docs = listAudioModelOfficialDocs();

    for (const doc of docs) {
      const snapshot = await readFile(join(root, doc.snapshotPath), 'utf8');
      for (const phrase of vagueSnapshotPhrases) {
        expect(snapshot, `${doc.modelId} ${phrase}`).not.toMatch(phrase);
      }
    }
  });

  it('returns model-level markdown with command examples for each audio CLI surface', async () => {
    const catalogModels = createAudioModelCatalog().listAll();
    const docs = await Promise.all(catalogModels.map((model) => describeAudioModelOfficialDoc(model.debruteModelId)));

    for (let index = 0; index < docs.length; index += 1) {
      const maybeDoc = docs[index];
      const catalogModel = catalogModels[index]!;
      expect(maybeDoc).toBeDefined();
      if (!maybeDoc) {
        throw new Error('Expected official audio model documentation to be defined.');
      }
      expect(maybeDoc.descriptionMarkdown).toContain(`# ${maybeDoc.modelId}`);
      expect(maybeDoc.descriptionMarkdown).toContain('Official documentation:');
      expect(maybeDoc.descriptionMarkdown).toContain('Repository snapshot:');
      expect(maybeDoc.descriptionMarkdown).toContain(maybeDoc.snapshotPath);
      expect(maybeDoc.descriptionMarkdown).toContain(`debrute generate ${commandSegment(maybeDoc.kind)} <project> --input-json`);
      expect(maybeDoc.descriptionMarkdown).toContain(`"model":"${maybeDoc.modelId}"`);
      expect(debruteCommandInput(maybeDoc.descriptionMarkdown, maybeDoc.kind)).toEqual(catalogModel.requestExample.input);
      expect(maybeDoc.descriptionMarkdown).not.toMatch(/curl\s+https:\/\/api\./i);
      expect(maybeDoc.descriptionMarkdown).not.toMatch(/npm install|pip install|import OpenAI|from openai import/i);
    }
  });
});

function commandSegment(kind: 'tts' | 'music' | 'sound-effect'): 'tts' | 'music' | 'sfx' {
  if (kind === 'tts') {
    return 'tts';
  }
  return kind === 'music' ? 'music' : 'sfx';
}

function debruteCommandInput(markdown: string, kind: 'tts' | 'music' | 'sound-effect'): unknown {
  const match = markdown.match(new RegExp(`debrute generate ${commandSegment(kind)} <project> --input-json '([^']+)'`));
  if (!match) {
    throw new Error('Expected model description to contain a Debrute command input JSON payload.');
  }
  return JSON.parse(match[1]!);
}
