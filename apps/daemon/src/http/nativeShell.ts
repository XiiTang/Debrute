import { execFile as nodeExecFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);

export interface DebruteNativeShell {
  platform: NodeJS.Platform;
  chooseDirectory(): Promise<string | undefined>;
  showItemInFolder(absolutePath: string): Promise<void>;
  openPath(absolutePath: string): Promise<void>;
  trashItem(absolutePath: string): Promise<void>;
}

export type NativeShellExecFile = (
  file: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string } | unknown>;

export function createNodeNativeShell(input: {
  platform?: NodeJS.Platform;
  execFile?: NativeShellExecFile;
} = {}): DebruteNativeShell {
  const platform = input.platform ?? process.platform;
  const execFile = input.execFile ?? execFileAsync;
  return {
    platform,
    chooseDirectory: () => chooseDirectory(platform, execFile),
    showItemInFolder: (absolutePath) => revealPath(platform, execFile, absolutePath),
    openPath: (absolutePath) => openPath(platform, execFile, absolutePath),
    trashItem: (absolutePath) => trashPath(platform, execFile, absolutePath)
  };
}

async function chooseDirectory(
  platform: NodeJS.Platform,
  execFile: NativeShellExecFile
): Promise<string | undefined> {
  try {
    if (platform === 'darwin') {
      return stdoutFirstLine(await execFile('osascript', [
        '-e',
        'POSIX path of (choose folder with prompt "Open Debrute Project")'
      ]));
    }
    if (platform === 'win32') {
      return stdoutFirstLine(await execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          'Add-Type -AssemblyName System.Windows.Forms',
          '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
          '$dialog.Description = "Open Debrute Project"',
          '$dialog.ShowNewFolderButton = $true',
          'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }'
        ].join('; ')
      ]));
    }
    return stdoutFirstLine(await execFile('zenity', [
      '--file-selection',
      '--directory',
      '--title',
      'Open Debrute Project'
    ]));
  } catch (error) {
    if (isNativePickerCancel(error)) {
      return undefined;
    }
    throw error;
  }
}

function stdoutFirstLine(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !('stdout' in result)) {
    return undefined;
  }
  const stdout = (result as { stdout?: unknown }).stdout;
  if (typeof stdout !== 'string') {
    return undefined;
  }
  const value = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  return value && value.length > 0 ? value : undefined;
}

function isNativePickerCancel(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const stderr = String((error as { stderr?: unknown }).stderr ?? '');
  const message = error instanceof Error ? error.message : '';
  const output = `${stderr}\n${message}`.trim();
  return code === 1 && (!output || /cancel/i.test(output));
}

async function revealPath(
  platform: NodeJS.Platform,
  execFile: NativeShellExecFile,
  absolutePath: string
): Promise<void> {
  if (platform === 'darwin') {
    await execFile('open', ['-R', absolutePath]);
    return;
  }
  if (platform === 'win32') {
    await execFile('explorer.exe', [`/select,${absolutePath}`]);
    return;
  }
  await execFile('xdg-open', [dirname(absolutePath)]);
}

async function openPath(
  platform: NodeJS.Platform,
  execFile: NativeShellExecFile,
  absolutePath: string
): Promise<void> {
  if (platform === 'darwin') {
    await execFile('open', [absolutePath]);
    return;
  }
  if (platform === 'win32') {
    await execFile('explorer.exe', [absolutePath]);
    return;
  }
  await execFile('xdg-open', [absolutePath]);
}

async function trashPath(
  platform: NodeJS.Platform,
  execFile: NativeShellExecFile,
  absolutePath: string
): Promise<void> {
  if (platform === 'darwin') {
    await execFile('osascript', [
      '-e',
      `tell application "Finder" to delete POSIX file "${appleScriptString(absolutePath)}"`
    ]);
    return;
  }
  if (platform === 'win32') {
    await execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        'Add-Type -AssemblyName Microsoft.VisualBasic',
        '$path = $args[0]',
        'if ([System.IO.Directory]::Exists($path)) {',
        '  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, "OnlyErrorDialogs", "SendToRecycleBin")',
        '} else {',
        '  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, "OnlyErrorDialogs", "SendToRecycleBin")',
        '}'
      ].join('; '),
      absolutePath
    ]);
    return;
  }
  await execFile('gio', ['trash', absolutePath]);
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
