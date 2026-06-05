import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DebruteCliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DebruteCliExecutionInput {
  debrutePath: string;
  args: string[];
  platform?: NodeJS.Platform;
  comSpec?: string;
}

export interface DebruteCliExecutionCommand {
  executablePath: string;
  args: string[];
}

export async function runDebruteCli(debrutePath: string, args: string[], timeoutMs = 30_000): Promise<DebruteCliRunResult> {
  const execution = debruteCliExecutionCommand({ debrutePath, args });
  try {
    const result = await execFileAsync(execution.executablePath, execution.args, { timeout: timeoutMs });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? failed.message,
      exitCode: typeof failed.code === 'number' ? failed.code : 1
    };
  }
}

export function debruteCliExecutionCommand(input: DebruteCliExecutionInput): DebruteCliExecutionCommand {
  const platform = input.platform ?? process.platform;
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(input.debrutePath)) {
    return {
      executablePath: input.comSpec ?? process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/c', windowsCmdInvocation(input.debrutePath, input.args)]
    };
  }
  return {
    executablePath: input.debrutePath,
    args: input.args
  };
}

function windowsCmdInvocation(debrutePath: string, args: string[]): string {
  return ['call', quoteWindowsCmdArgument(debrutePath), ...args.map(quoteWindowsCmdArgument)].join(' ');
}

function quoteWindowsCmdArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
