import { describe, expect, it } from 'vitest';
import {
  codeMirrorLanguageKindForProjectTextLanguage,
  type CodeMirrorLanguageKind
} from './textEditorCodeMirrorLanguages';

describe('CodeMirror text editor language mapping', () => {
  it.each([
    ['markdown', 'markdown'],
    ['json', 'json'],
    ['jsonc', 'json'],
    ['jsonl', 'json'],
    ['yaml', 'yaml'],
    ['html', 'html'],
    ['css', 'css'],
    ['scss', 'scss'],
    ['less', 'less'],
    ['xml', 'xml'],
    ['javascript', 'javascript'],
    ['javascriptreact', 'javascriptreact'],
    ['typescript', 'typescript'],
    ['typescriptreact', 'typescriptreact'],
    ['python', 'python'],
    ['php', 'php'],
    ['sql', 'sql'],
    ['go', 'go'],
    ['rust', 'rust'],
    ['java', 'java'],
    ['c', 'cpp'],
    ['cpp', 'cpp']
  ] as const)('maps %s to the %s full parser kind', (language, expected) => {
    expect(codeMirrorLanguageKindForProjectTextLanguage(language)).toBe(expected);
  });

  it.each([
    ['shell', 'shell'],
    ['dockerfile', 'dockerfile'],
    ['diff', 'diff'],
    ['ruby', 'ruby'],
    ['lua', 'lua'],
    ['perl', 'perl'],
    ['r', 'r'],
    ['powershell', 'powershell'],
    ['properties', 'properties']
  ] as const)('maps %s to the %s legacy stream mode kind', (language, expected) => {
    expect(codeMirrorLanguageKindForProjectTextLanguage(language)).toBe(expected);
  });

  it.each([
    'plaintext',
    'dotenv',
    'log',
    'csv',
    'tsv',
    'makefile',
    'bat',
    'ini'
  ] as const)('maps %s to plain text', (language) => {
    expect(codeMirrorLanguageKindForProjectTextLanguage(language)).toBe('plain');
  });

  it('uses the declared kind union for mapping expectations', () => {
    const kind: CodeMirrorLanguageKind = codeMirrorLanguageKindForProjectTextLanguage('markdown');
    expect(kind).toBe('markdown');
  });
});
