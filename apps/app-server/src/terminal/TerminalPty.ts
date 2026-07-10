export interface TerminalPtyExit {
  exitCode: number;
  signal?: number | string;
}

export interface TerminalPtyDisposable {
  dispose(): void;
}

export interface TerminalPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  terminate(): void;
  forceKill(): void;
  onData(listener: (data: string) => void): TerminalPtyDisposable;
  onExit(listener: (event: TerminalPtyExit) => void): TerminalPtyDisposable;
}

export interface TerminalPtySpawnInput {
  shell: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export type TerminalPtyFactory = (input: TerminalPtySpawnInput) => TerminalPty;
