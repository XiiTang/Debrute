import { useEffect, type RefObject } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSessionView, WorkbenchApiClient } from '@debrute/app-protocol';
import { createTerminalEventRenderer } from './terminalEventRendering';

export interface UseXtermTerminalInput {
  api: WorkbenchApiClient;
  session: TerminalSessionView | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onSessionUpdate(session: TerminalSessionView): void;
  onSessionClose(terminalId: string): void;
  onError(error: Error): void;
}

export function useXtermTerminal(input: UseXtermTerminalInput): void {
  useEffect(() => {
    const session = input.session;
    const container = input.containerRef.current;
    if (!session || !container) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: {
        background: '#0c0e10',
        foreground: '#e6edf3',
        cursor: '#f6f8fa'
      }
    });
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
      void input.api.writeTerminalInput({ terminalId: session.id, data }).catch(input.onError);
    });
    const renderTerminalEvent = createTerminalEventRenderer({
      write: (data) => terminal.write(data),
      onSessionUpdate: input.onSessionUpdate,
      onSessionClose: input.onSessionClose,
      onError: input.onError
    });
    const subscription = input.api.subscribeTerminalEvents(session.id, renderTerminalEvent, input.onError);

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(resizeToFit);
    resizeObserver?.observe(container);

    return () => {
      resizeObserver?.disconnect();
      subscription.close();
      dataDisposable.dispose();
      terminal.dispose();
    };
  }, [input.api, input.containerRef, input.session?.id, input.onError, input.onSessionUpdate]);
}
