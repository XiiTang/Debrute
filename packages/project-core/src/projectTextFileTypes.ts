export type ProjectTextLanguageId =
  | 'plaintext'
  | 'markdown'
  | 'json'
  | 'jsonc'
  | 'jsonl'
  | 'yaml'
  | 'shell'
  | 'dotenv'
  | 'ini'
  | 'properties'
  | 'log'
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
  | 'ruby'
  | 'php'
  | 'sql'
  | 'powershell'
  | 'bat'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'lua'
  | 'perl'
  | 'r'
  | 'dockerfile'
  | 'makefile'
  | 'diff'
  | 'csv'
  | 'tsv'
  | 'subtitle'
  | 'webvtt'
  | 'toml'
  | 'tex'
  | 'textile'
  | 'protobuf'
  | 'restructuredtext'
  | 'asciidoc'
  | 'org';

export interface ProjectTextFileType {
  id: ProjectTextLanguageId;
  mimeType: string;
  extensions?: readonly string[];
  filenames?: readonly string[];
  filenamePatterns?: readonly string[];
  firstLine?: RegExp;
}

const projectTextFileTypes: readonly ProjectTextFileType[] = [
  type('markdown', 'text/markdown', {
    extensions: ['.md', '.markdown', '.mkd', '.mkdn', '.mdwn', '.mdown', '.markdn', '.mdtxt', '.mdtext', '.mdc', '.prompt.md', '.instructions.md', '.agent.md', '.chatmode.md'],
    filenames: ['SKILL.md', 'copilot-instructions.md']
  }),
  type('jsonl', 'application/jsonl', { extensions: ['.jsonl', '.ndjson'] }),
  type('jsonc', 'application/jsonc', {
    extensions: ['.jsonc', '.code-workspace', '.code-profile', '.eslintrc', '.eslintrc.json', '.jsfmtrc', '.jshintrc', '.swcrc', '.hintrc', '.babelrc', '.toolset.jsonc'],
    filenames: ['tsconfig.json', 'jsconfig.json', 'settings.json', 'launch.json', 'tasks.json', 'mcp.json', 'keybindings.json', 'extensions.json', 'argv.json', 'profiles.json', 'devcontainer.json', '.devcontainer.json', 'babel.config.json', 'bun.lock', '.babelrc.json', '.ember-cli', 'typedoc.json'],
    filenamePatterns: ['tsconfig.*.json', 'jsconfig.*.json', 'tsconfig-*.json', 'jsconfig-*.json', '**/.github/hooks/*.json']
  }),
  type('json', 'application/json', {
    extensions: ['.json', '.bowerrc', '.jscsrc', '.webmanifest', '.js.map', '.css.map', '.ts.map', '.har', '.jslintrc', '.jsonld', '.geojson', '.ipynb', '.vuerc', '.tsbuildinfo', '.code-snippets'],
    filenames: ['package.json', 'composer.lock', '.watchmanconfig'],
    filenamePatterns: ['**/snippets*.json']
  }),
  type('yaml', 'application/yaml', {
    extensions: ['.yaml', '.yml', '.eyaml', '.eyml', '.cff', '.yaml-tmlanguage', '.yaml-tmpreferences', '.yaml-tmtheme', '.winget'],
    filenamePatterns: ['compose.yml', 'compose.yaml', 'compose.*.yml', 'compose.*.yaml', '*docker*compose*.yml', '*docker*compose*.yaml'],
    firstLine: /^#cloud-config\b/
  }),
  type('shell', 'text/x-shellscript', {
    extensions: ['.sh', '.bash', '.bashrc', '.bash_aliases', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zsh', '.zshrc', '.zprofile', '.zlogin', '.zlogout', '.zshenv', '.zsh-theme', '.fish', '.ksh', '.csh', '.cshrc', '.tcshrc', '.yashrc', '.yash_profile', '.xprofile', '.xsession', '.xsessionrc'],
    filenames: ['APKBUILD', 'PKGBUILD', '.envrc', '.hushlogin', 'zshrc', 'zshenv', 'zlogin', 'zprofile', 'zlogout', 'bashrc_Apple_Terminal', 'zshrc_Apple_Terminal'],
    firstLine: /^#!.*\b(?:bash|fish|zsh|sh|ksh|dtksh|pdksh|mksh|ash|dash|yash|csh|jcsh|tcsh|itcsh)\b/
  }),
  type('dotenv', 'text/plain', { extensions: ['.env'], filenames: ['.env', '.flaskenv', 'user-dirs.dirs'], filenamePatterns: ['.env.*'] }),
  type('ini', 'text/plain', { extensions: ['.ini'] }),
  type('properties', 'text/plain', {
    extensions: ['.conf', '.properties', '.cfg', '.directory', '.gitattributes', '.gitconfig', '.gitmodules', '.editorconfig', '.repo'],
    filenames: ['gitconfig', '.npmrc'],
    filenamePatterns: ['**/.config/git/config', '**/.git/config']
  }),
  type('log', 'text/plain', { extensions: ['.log'], filenamePatterns: ['*.log.?'] }),
  type('html', 'text/html', { extensions: ['.html', '.htm', '.shtml', '.xhtml', '.xht', '.mdoc', '.jsp', '.asp', '.aspx', '.jshtm', '.volt', '.ejs', '.rhtml'] }),
  type('scss', 'text/css', { extensions: ['.scss'] }),
  type('less', 'text/css', { extensions: ['.less'] }),
  type('css', 'text/css', { extensions: ['.css'] }),
  type('xml', 'application/xml', {
    extensions: ['.xml', '.xsd', '.atom', '.axml', '.axaml', '.bpmn', '.csl', '.csproj', '.dita', '.ditamap', '.dtd', '.fxml', '.iml', '.jmx', '.launch', '.mxml', '.nuspec', '.opml', '.proj', '.props', '.pubxml', '.targets', '.tmx', '.wixproj', '.wxi', '.wxl', '.wxs', '.xaml', '.xib', '.xlf', '.xliff', '.xsl', '.xslt'],
    firstLine: /^<\?xml\b/i
  }),
  type('javascriptreact', 'text/javascript', { extensions: ['.jsx'] }),
  type('javascript', 'text/javascript', { extensions: ['.js', '.mjs', '.cjs', '.es6', '.pac'], filenames: ['jakefile'], firstLine: /^#!.*\bnode\b/ }),
  type('typescriptreact', 'text/typescript', { extensions: ['.tsx'] }),
  type('typescript', 'text/typescript', { extensions: ['.ts', '.cts', '.mts'], firstLine: /^#!.*\b(?:deno|bun|ts-node)\b/ }),
  type('python', 'text/x-python', { extensions: ['.py', '.pyw', '.pyi', '.gyp', '.gypi', '.rpy', '.cpy', '.ipy', '.pyt'], filenames: ['SConstruct', 'SConscript'], firstLine: /^#!\s*\/?.*\bpython[0-9.-]*\b/ }),
  type('ruby', 'text/x-ruby', { extensions: ['.rb', '.rbx', '.rjs', '.gemspec', '.rake', '.ru', '.erb', '.podspec', '.rbi'], filenames: ['rakefile', 'gemfile', 'guardfile', 'podfile', 'capfile', 'vagrantfile', 'brewfile', 'fastfile', 'appfile'], firstLine: /^#!\s*\/.*\bruby\b/ }),
  type('php', 'application/x-httpd-php', { extensions: ['.php', '.php4', '.php5', '.phtml', '.ctp'], firstLine: /^#!\s*\/.*\bphp\b/ }),
  type('sql', 'application/sql', { extensions: ['.sql', '.dsql'] }),
  type('powershell', 'text/plain', { extensions: ['.ps1', '.psm1', '.psd1', '.pssc', '.psrc'], firstLine: /^#!\s*\/.*\bpwsh\b/ }),
  type('bat', 'text/plain', { extensions: ['.bat', '.cmd'] }),
  type('go', 'text/x-go', { extensions: ['.go'] }),
  type('rust', 'text/x-rustsrc', { extensions: ['.rs'] }),
  type('java', 'text/x-java-source', { extensions: ['.java', '.jav'] }),
  type('cpp', 'text/x-c++src', { extensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.ipp', '.inl', '.tpp', '.txx'] }),
  type('c', 'text/x-csrc', { extensions: ['.c', '.h', '.i'] }),
  type('lua', 'text/x-lua', { extensions: ['.lua'] }),
  type('perl', 'text/x-perl', { extensions: ['.pl', '.pm', '.pod', '.t'] }),
  type('r', 'text/x-r-source', { extensions: ['.R', '.Rprofile', '.Rhistory', '.rt'] }),
  type('dockerfile', 'text/plain', { extensions: ['.dockerfile', '.containerfile'], filenames: ['Dockerfile', 'Containerfile'], filenamePatterns: ['Dockerfile.*', 'Containerfile.*'] }),
  type('makefile', 'text/plain', { extensions: ['.mk', '.mak'], filenames: ['Makefile', 'makefile', 'GNUmakefile', 'OCamlMakefile'], firstLine: /^#!\s*\/usr\/bin\/make\b/ }),
  type('diff', 'text/plain', { extensions: ['.diff', '.patch', '.rej'] }),
  type('csv', 'text/csv', { extensions: ['.csv'] }),
  type('tsv', 'text/tab-separated-values', { extensions: ['.tsv'] }),
  type('subtitle', 'text/plain', { extensions: ['.srt', '.ass', '.ssa', '.sbv', '.sub'] }),
  type('webvtt', 'text/vtt', { extensions: ['.vtt'] }),
  type('toml', 'application/toml', { extensions: ['.toml'] }),
  type('tex', 'application/x-tex', { extensions: ['.tex', '.latex', '.ltx', '.sty', '.cls'] }),
  type('textile', 'text/x-textile', { extensions: ['.textile'] }),
  type('protobuf', 'text/x-protobuf', { extensions: ['.proto'] }),
  type('restructuredtext', 'text/x-rst', { extensions: ['.rst'] }),
  type('asciidoc', 'text/x-asciidoc', { extensions: ['.adoc', '.asciidoc'] }),
  type('org', 'text/x-org', { extensions: ['.org'] }),
  type('plaintext', 'text/plain', {
    extensions: ['.txt'],
    filenames: ['LICENSE', '.gitignore', 'README', 'CHANGELOG', 'CONTRIBUTING', 'NOTICE', 'AUTHORS', 'COPYING']
  })
] as const;

export function projectTextFileTypeForPath(
  projectRelativePath: string,
  firstLine?: string
): ProjectTextFileType | undefined {
  const normalizedPath = projectRelativePath.replaceAll('\\', '/');
  const basename = normalizedPath.split('/').pop() ?? normalizedPath;
  return exactFilenameMatch(basename)
    ?? filenamePatternMatch(normalizedPath)
    ?? extensionMatch(normalizedPath)
    ?? firstLineMatch(firstLine);
}

export function isKnownProjectTextFilePath(projectRelativePath: string, firstLine?: string): boolean {
  return projectTextFileTypeForPath(projectRelativePath, firstLine) !== undefined;
}

export function projectTextLanguageFromPath(projectRelativePath: string, firstLine?: string): ProjectTextLanguageId {
  return projectTextFileTypeForPath(projectRelativePath, firstLine)?.id ?? 'plaintext';
}

export function projectTextMimeTypeFromPath(projectRelativePath: string, firstLine?: string): string {
  return projectTextFileTypeForPath(projectRelativePath, firstLine)?.mimeType ?? 'text/plain';
}

function type(
  id: ProjectTextLanguageId,
  mimeType: string,
  rest: Omit<ProjectTextFileType, 'id' | 'mimeType'>
): ProjectTextFileType {
  return { id, mimeType, ...rest };
}

function exactFilenameMatch(basename: string): ProjectTextFileType | undefined {
  const lowerBasename = basename.toLowerCase();
  return projectTextFileTypes.find((entry) => (
    entry.filenames?.some((filename) => filename.toLowerCase() === lowerBasename)
  ));
}

function filenamePatternMatch(projectRelativePath: string): ProjectTextFileType | undefined {
  const normalizedPath = projectRelativePath.replaceAll('\\', '/');
  const basename = normalizedPath.split('/').pop() ?? normalizedPath;
  return projectTextFileTypes.find((entry) => (
    entry.filenamePatterns?.some((pattern) => {
      const candidate = pattern.includes('/') ? normalizedPath : basename;
      return patternToRegExp(pattern).test(candidate);
    })
  ));
}

function extensionMatch(projectRelativePath: string): ProjectTextFileType | undefined {
  const lowerPath = projectRelativePath.toLowerCase();
  return projectTextFileTypes.find((entry) => (
    entry.extensions?.some((extension) => lowerPath.endsWith(extension.toLowerCase()))
  ));
}

function firstLineMatch(firstLine: string | undefined): ProjectTextFileType | undefined {
  if (!firstLine) {
    return undefined;
  }
  return projectTextFileTypes.find((entry) => entry.firstLine?.test(firstLine));
}

function patternToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    const nextCharacter = pattern[index + 1];
    const nextNextCharacter = pattern[index + 2];
    if (character === '*' && nextCharacter === '*') {
      if (nextNextCharacter === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}
