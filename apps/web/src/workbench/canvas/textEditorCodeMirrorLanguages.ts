import type { ProjectTextLanguageId } from '@debrute/app-protocol';
import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';

export type CodeMirrorLanguageKind =
  | 'plain'
  | 'markdown'
  | 'json'
  | 'yaml'
  | 'html'
  | 'css'
  | 'scss'
  | 'less'
  | 'xml'
  | 'javascript'
  | 'javascriptreact'
  | 'typescript'
  | 'typescriptreact'
  | 'python'
  | 'php'
  | 'sql'
  | 'go'
  | 'rust'
  | 'java'
  | 'cpp'
  | 'shell'
  | 'dockerfile'
  | 'diff'
  | 'ruby'
  | 'lua'
  | 'perl'
  | 'r'
  | 'powershell'
  | 'properties'
  | 'toml'
  | 'tex'
  | 'textile'
  | 'protobuf';

const codeMirrorLanguageKinds = {
  plaintext: 'plain',
  markdown: 'markdown',
  json: 'json',
  jsonc: 'json',
  jsonl: 'json',
  yaml: 'yaml',
  shell: 'shell',
  dotenv: 'plain',
  ini: 'plain',
  properties: 'properties',
  log: 'plain',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml',
  javascript: 'javascript',
  javascriptreact: 'javascriptreact',
  typescript: 'typescript',
  typescriptreact: 'typescriptreact',
  python: 'python',
  ruby: 'ruby',
  php: 'php',
  sql: 'sql',
  powershell: 'powershell',
  bat: 'plain',
  go: 'go',
  rust: 'rust',
  java: 'java',
  c: 'cpp',
  cpp: 'cpp',
  lua: 'lua',
  perl: 'perl',
  r: 'r',
  dockerfile: 'dockerfile',
  makefile: 'plain',
  diff: 'diff',
  csv: 'plain',
  tsv: 'plain',
  subtitle: 'plain',
  webvtt: 'plain',
  toml: 'toml',
  tex: 'tex',
  textile: 'textile',
  protobuf: 'protobuf',
  restructuredtext: 'plain',
  asciidoc: 'plain',
  org: 'plain'
} satisfies Record<ProjectTextLanguageId, CodeMirrorLanguageKind>;

export function codeMirrorLanguageKindForProjectTextLanguage(
  language: ProjectTextLanguageId
): CodeMirrorLanguageKind {
  return codeMirrorLanguageKinds[language];
}

export async function loadCodeMirrorLanguageExtensionForProjectTextLanguage(
  language: ProjectTextLanguageId
): Promise<Extension> {
  switch (codeMirrorLanguageKindForProjectTextLanguage(language)) {
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
    case 'json': return (await import('@codemirror/lang-json')).json();
    case 'yaml': return (await import('@codemirror/lang-yaml')).yaml();
    case 'html': return (await import('@codemirror/lang-html')).html();
    case 'css': return (await import('@codemirror/lang-css')).css();
    case 'scss': return (await import('@codemirror/lang-sass')).sass();
    case 'less': return (await import('@codemirror/lang-less')).less();
    case 'xml': return (await import('@codemirror/lang-xml')).xml();
    case 'javascript': return (await import('@codemirror/lang-javascript')).javascript();
    case 'javascriptreact': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'typescript': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'typescriptreact': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    case 'python': return (await import('@codemirror/lang-python')).python();
    case 'php': return (await import('@codemirror/lang-php')).php();
    case 'sql': return (await import('@codemirror/lang-sql')).sql();
    case 'go': return (await import('@codemirror/lang-go')).go();
    case 'rust': return (await import('@codemirror/lang-rust')).rust();
    case 'java': return (await import('@codemirror/lang-java')).java();
    case 'cpp': return (await import('@codemirror/lang-cpp')).cpp();
    case 'shell': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell);
    case 'dockerfile': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile);
    case 'diff': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/diff')).diff);
    case 'ruby': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby);
    case 'lua': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/lua')).lua);
    case 'perl': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/perl')).perl);
    case 'r': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/r')).r);
    case 'powershell': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/powershell')).powerShell);
    case 'properties': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/properties')).properties);
    case 'toml': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml);
    case 'tex': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/stex')).stex);
    case 'textile': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/textile')).textile);
    case 'protobuf': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/protobuf')).protobuf);
    case 'plain':
      return [];
  }
}
