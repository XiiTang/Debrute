import { describe, expect, it } from 'vitest';
import { monacoLanguageForProjectTextLanguage } from './textEditorLanguages';

describe('text editor language mapping', () => {
  it('maps Debrute text languages to Monaco language ids', () => {
    expect(monacoLanguageForProjectTextLanguage('markdown')).toBe('markdown');
    expect(monacoLanguageForProjectTextLanguage('json')).toBe('json');
    expect(monacoLanguageForProjectTextLanguage('jsonc')).toBe('json');
    expect(monacoLanguageForProjectTextLanguage('jsonl')).toBe('json');
    expect(monacoLanguageForProjectTextLanguage('yaml')).toBe('yaml');
    expect(monacoLanguageForProjectTextLanguage('shell')).toBe('shell');
    expect(monacoLanguageForProjectTextLanguage('dockerfile')).toBe('dockerfile');
    expect(monacoLanguageForProjectTextLanguage('makefile')).toBe('makefile');
    expect(monacoLanguageForProjectTextLanguage('diff')).toBe('diff');
    expect(monacoLanguageForProjectTextLanguage('html')).toBe('html');
    expect(monacoLanguageForProjectTextLanguage('css')).toBe('css');
    expect(monacoLanguageForProjectTextLanguage('scss')).toBe('scss');
    expect(monacoLanguageForProjectTextLanguage('less')).toBe('less');
    expect(monacoLanguageForProjectTextLanguage('xml')).toBe('xml');
    expect(monacoLanguageForProjectTextLanguage('javascript')).toBe('javascript');
    expect(monacoLanguageForProjectTextLanguage('javascriptreact')).toBe('javascript');
    expect(monacoLanguageForProjectTextLanguage('typescript')).toBe('typescript');
    expect(monacoLanguageForProjectTextLanguage('typescriptreact')).toBe('typescript');
    expect(monacoLanguageForProjectTextLanguage('python')).toBe('python');
    expect(monacoLanguageForProjectTextLanguage('ruby')).toBe('ruby');
    expect(monacoLanguageForProjectTextLanguage('php')).toBe('php');
    expect(monacoLanguageForProjectTextLanguage('sql')).toBe('sql');
    expect(monacoLanguageForProjectTextLanguage('powershell')).toBe('powershell');
    expect(monacoLanguageForProjectTextLanguage('bat')).toBe('bat');
    expect(monacoLanguageForProjectTextLanguage('plaintext')).toBe('plaintext');
  });

  it('falls back to plaintext for registry languages without a Monaco mode', () => {
    expect(monacoLanguageForProjectTextLanguage('dotenv')).toBe('plaintext');
    expect(monacoLanguageForProjectTextLanguage('log')).toBe('plaintext');
    expect(monacoLanguageForProjectTextLanguage('properties')).toBe('ini');
    expect(monacoLanguageForProjectTextLanguage('unknown-language')).toBe('plaintext');
  });
});
