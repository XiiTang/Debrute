import { useEffect, useRef, type RefObject } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSessionView, WorkbenchApiClient } from '@debrute/app-protocol';
import type { WorkbenchResolvedTheme } from '../services/workbenchTheme';
import { createTerminalEventRenderer } from './terminalEventRendering';
import { terminalThemeForWorkbenchTheme } from './terminalTheme';

export interface UseXtermTerminalInput {
  api: WorkbenchApiClient;
  resolvedTheme: WorkbenchResolvedTheme;
  session: TerminalSessionView | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onSessionUpdate(session: TerminalSessionView): void;
  onSessionClose(terminalId: string): void;
  onError(error: Error): void;
}

export function useXtermTerminal(input: UseXtermTerminalInput): void {
  const terminalRef = useRef<Terminal | null>(null);
  const sessionStatusRef = useRef<TerminalSessionView['status'] | null>(null);
  sessionStatusRef.current = input.session?.status ?? null;

  useEffect(() => {
    const session = input.session;
    const container = input.containerRef.current;
    if (!session || !container) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Noto Sans Mono CJK SC", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: terminalThemeForWorkbenchTheme(input.resolvedTheme)
    });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    let lastCols = session.cols;
    let lastRows = session.rows;

    const resizeToFit = () => {
      fitAddon.fit();
      const dimensions = fitAddon.proposeDimensions();
      if (dimensions && (dimensions.cols !== lastCols || dimensions.rows !== lastRows)) {
        lastCols = dimensions.cols;
        lastRows = dimensions.rows;
        void input.api.resizeTerminal({
          terminalId: session.id,
          cols: dimensions.cols,
          rows: dimensions.rows
        }).then((result) => input.onSessionUpdate(result.session)).catch(input.onError);
      }
    };
    resizeToFit();

    const dataDisposable = terminal.onData((data) => {
      if (sessionStatusRef.current !== 'running') {
        return;
      }
      void input.api.writeTerminalInput({ terminalId: session.id, data }).catch(input.onError);
    });
    const renderTerminalEvent = createTerminalEventRenderer({
      write: (data) => terminal.write(data),
      onSessionUpdate: input.onSessionUpdate,
      onSessionClose: input.onSessionClose,
      onError: input.onError
    });
    const subscription = input.api.subscribeTerminalEvents(session.id, renderTerminalEvent, input.onError);

    const resizeObserver = new ResizeObserver(resizeToFit);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      subscription.close();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [input.api, input.containerRef, input.session?.id, input.onError, input.onSessionClose, input.onSessionUpdate]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminal.options.theme = terminalThemeForWorkbenchTheme(input.resolvedTheme);
  }, [input.resolvedTheme]);
}
