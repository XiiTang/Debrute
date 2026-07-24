import type { ControlEvent, ControlResponse } from '@debrute/app-protocol';
import type { RuntimeControlClient } from '@debrute/runtime-control-client';
import { describe, expect, it, vi } from 'vitest';

import {
  DesktopWindowControlAdapter,
  type DesktopNativeWindow
} from './desktopWindowControlAdapter.js';

describe('DesktopWindowControlAdapter', () => {
  it('opens a ticketed window and reports an ordinary close', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    const createWindow = vi.fn(async () => nativeWindow);
    const quitDesktop = vi.fn();
    const adapter = new DesktopWindowControlAdapter({
      control: control.client,
      createWindow,
      quitDesktop,
      onError: (error) => { throw error; }
    });

    control.emit({
      event: 'desktop_window_open_requested',
      window_key: 'window-1',
      route: { kind: 'root' }
    });
    await adapter.idle();

    expect(createWindow).toHaveBeenCalledWith({
      windowKey: 'window-1',
      ticket: 'ticket-window-1',
      url: 'http://127.0.0.1:32125/'
    });
    nativeWindow.close();
    await adapter.idle();
    expect(control.closedWindows).toEqual(['window-1']);
    expect(control.closed).toBe(true);
    expect(quitDesktop).toHaveBeenCalledOnce();
  });

  it('focuses an existing window without an acknowledgement request', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    const adapter = createAdapter(control, nativeWindow);
    control.emit(openEvent('window-1'));
    await adapter.idle();

    control.emit({ event: 'desktop_window_focus_requested', window_key: 'window-1' });
    await adapter.idle();

    expect(nativeWindow.shown).toBe(1);
    expect(nativeWindow.focused).toBe(1);
  });

  it('reloads with a fresh one-use ticket and stable URL', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    const adapter = createAdapter(control, nativeWindow);
    control.emit(openEvent('window-1'));
    await adapter.idle();

    await expect(adapter.reloadWindow('window-1')).resolves.toBe(true);

    expect(control.ticketRequests).toEqual(['window-1', 'window-1']);
    expect(nativeWindow.ticket).toBe('ticket-window-1');
    expect(nativeWindow.loaded).toEqual(['http://127.0.0.1:32125/']);
  });

  it('closes every window immediately for Product exit', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    const quitDesktop = vi.fn();
    const adapter = new DesktopWindowControlAdapter({
      control: control.client,
      createWindow: async () => nativeWindow,
      quitDesktop,
      onError: (error) => { throw error; }
    });
    control.emit(openEvent('window-1'));
    await adapter.idle();

    control.emit({ event: 'product_exiting' });
    await adapter.idle();

    expect(nativeWindow.destroyed).toBe(true);
    expect(control.closedWindows).toEqual([]);
    expect(control.closed).toBe(true);
    expect(quitDesktop).toHaveBeenCalledOnce();
  });

  it('reports both a native open failure and a rejected Runtime topology cleanup', async () => {
    const control = new FakeControl();
    control.closeWindowResponse = { result: 'rejected', code: 'invalid_desktop_window' };
    const errors: unknown[] = [];
    const adapter = new DesktopWindowControlAdapter({
      control: control.client,
      createWindow: async () => { throw new Error('native window failed'); },
      quitDesktop: () => undefined,
      onError: (error) => { errors.push(error); }
    });

    control.emit(openEvent('window-1'));
    await adapter.idle();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AggregateError);
    expect((errors[0] as AggregateError).errors).toHaveLength(2);
    expect(control.closedWindows).toEqual(['window-1']);
  });
});

function createAdapter(control: FakeControl, nativeWindow: FakeWindow) {
  return new DesktopWindowControlAdapter({
    control: control.client,
    createWindow: async () => nativeWindow,
    quitDesktop: () => undefined,
    onError: (error) => { throw error; }
  });
}

function openEvent(windowKey: string): ControlEvent {
  return {
    event: 'desktop_window_open_requested',
    window_key: windowKey,
    route: { kind: 'root' }
  };
}

class FakeWindow implements DesktopNativeWindow {
  destroyed = false;
  shown = 0;
  focused = 0;
  ticket: string | undefined;
  loaded: string[] = [];
  private closedListener: (() => void) | undefined;

  isDestroyed(): boolean { return this.destroyed; }
  show(): void { this.shown += 1; }
  focus(): void { this.focused += 1; }
  setLaunchTicket(ticket: string): void { this.ticket = ticket; }
  async load(url: string): Promise<void> { this.loaded.push(url); }
  destroy(): void { this.destroyed = true; }
  onClosed(listener: () => void): () => void {
    this.closedListener = listener;
    return () => { this.closedListener = undefined; };
  }
  close(): void {
    this.destroyed = true;
    this.closedListener?.();
  }
}

class FakeControl {
  closed = false;
  ticketRequests: string[] = [];
  closedWindows: string[] = [];
  closeWindowResponse: ControlResponse = { result: 'ok' };
  private listener: ((event: ControlEvent) => void) | undefined;

  readonly client = {
    createDesktopLaunchTicket: async (windowKey: string): Promise<ControlResponse> => {
      this.ticketRequests.push(windowKey);
      return {
        result: 'desktop_launch_ticket',
        ticket: `ticket-${windowKey}`,
        url: 'http://127.0.0.1:32125/'
      };
    },
    desktopWindowClosed: async (windowKey: string): Promise<ControlResponse> => {
      this.closedWindows.push(windowKey);
      return this.closeWindowResponse;
    },
    onEvent: (listener: (event: ControlEvent) => void) => {
      this.listener = listener;
      return () => { this.listener = undefined; };
    },
    close: () => { this.closed = true; }
  } as unknown as RuntimeControlClient;

  emit(event: ControlEvent): void {
    this.listener?.(event);
  }
}
