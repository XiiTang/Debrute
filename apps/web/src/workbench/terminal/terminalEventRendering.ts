import type { TerminalEvent } from '@debrute/app-protocol';

export interface TerminalEventRendererInput {
  write(data: string): void;
  onError(error: Error): void;
}

export function createTerminalEventRenderer(input: TerminalEventRendererInput): (event: TerminalEvent) => void {
  let lastRenderedSequence = 0;

  return (event) => {
    if (event.type === 'replay') {
      for (const chunk of event.chunks) {
        if (chunk.sequence > lastRenderedSequence) {
          input.write(chunk.data);
        }
      }
      lastRenderedSequence = Math.max(lastRenderedSequence, event.lastSequence);
      return;
    }
    if (event.type === 'data') {
      if (event.sequence > lastRenderedSequence) {
        input.write(event.data);
        lastRenderedSequence = event.sequence;
      }
      return;
    }
    if (event.type === 'error') {
      input.onError(new Error(event.message));
    }
  };
}
