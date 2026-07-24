import type { ControlEvent, ControlResponse } from '@debrute/app-protocol';
import type { RuntimeControlClient } from '@debrute/runtime-control-client';
import { describe, expect, it, vi } from 'vitest';

import {
  DesktopWindowControlAdapter,
  type DesktopNativeWindow
} from './desktopWindowControlAdapter.js';

describe('DesktopWindowControlAdapter', () => {
  it('reports a non-final close and exits locally on the final close without a request', async () => {
    const control = new FakeControl();
    const firstWindow = new FakeWindow();
    const secondWindow = new FakeWindow();
    const windows = [firstWindow, secondWindow];
    const createWindow = vi.fn(async () => windows.shift()!);
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
      url: 'http://127.0.0.1:32125/',
      themePreference: 'system'
    });
    control.emit(openEvent('window-2'));
    await adapter.idle();

    firstWindow.close();
    await adapter.idle();
    expect(control.closedWindows).toEqual(['window-1']);
    expect(control.closed).toBe(false);
    expect(quitDesktop).not.toHaveBeenCalled();

    secondWindow.close();
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

  it('fails closed when Runtime rejects a non-final window close', async () => {
    const control = new FakeControl();
    const firstWindow = new FakeWindow();
    const secondWindow = new FakeWindow();
    const windows = [firstWindow, secondWindow];
    const errors: unknown[] = [];
    const quitDesktop = vi.fn();
    const adapter = new DesktopWindowControlAdapter({
      control: control.client,
      createWindow: async () => windows.shift()!,
      quitDesktop,
      onError: (error) => { errors.push(error); }
    });
    control.emit(openEvent('window-1'));
    control.emit(openEvent('window-2'));
    await adapter.idle();
    control.closeWindowResponse = { result: 'rejected', code: 'invalid_desktop_window' };

    firstWindow.close();
    await adapter.idle();

    expect(errors).toEqual([new Error('Runtime rejected Desktop window close: rejected')]);
    expect(secondWindow.destroyed).toBe(true);
    expect(adapter.windowCount).toBe(0);
    expect(control.closed).toBe(true);
    expect(quitDesktop).toHaveBeenCalledOnce();
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
    expect(nativeWindow.themePreference).toBe('system');
    expect(nativeWindow.loaded).toEqual(['http://127.0.0.1:32125/']);
  });

  it('rejects an invalid launch theme instead of choosing a fallback', async () => {
    const control = new FakeControl();
    control.themePreference = 'sepia';
    const nativeWindow = new FakeWindow();
    const errors: unknown[] = [];
    const adapter = new DesktopWindowControlAdapter({
      control: control.client,
      createWindow: async () => nativeWindow,
      quitDesktop: () => undefined,
      onError: (error) => { errors.push(error); }
    });

    control.emit(openEvent('window-1'));
    await adapter.idle();

    expect(errors).toEqual([
      new Error('Runtime returned an invalid Desktop launch theme preference.')
    ]);
    expect(nativeWindow.loaded).toEqual([]);
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

  it('reports an initial open failure and exits Desktop after Runtime topology cleanup', async () => {
    const control = new FakeControl();
    const errors: unknown[] = [];
    const quitDesktop = vi.fn();
    const adapter = new DesktopWindowControlAdapter({
      control: control.client,
      createWindow: async () => { throw new Error('native window failed'); },
      quitDesktop,
      onError: (error) => { errors.push(error); }
    });

    control.emit(openEvent('window-1'));
    await adapter.idle();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(new Error('native window failed'));
    expect(control.closedWindows).toEqual(['window-1']);
    expect(control.closed).toBe(true);
    expect(quitDesktop).toHaveBeenCalledOnce();
  });

  it('keeps an existing window live when an additional window fails cleanly', async () => {
    const control = new FakeControl();
    const firstWindow = new FakeWindow();
    const errors: unknown[] = [];
    const quitDesktop = vi.fn();
    let attempt = 0;
    const adapter = new DesktopWindowControlAdapter({
      control: control.client,
      createWindow: async () => {
        attempt += 1;
        if (attempt === 1) return firstWindow;
        throw new Error('second window failed');
      },
      quitDesktop,
      onError: (error) => { errors.push(error); }
    });
    control.emit(openEvent('window-1'));
    await adapter.idle();

    control.emit(openEvent('window-2'));
    await adapter.idle();

    expect(errors).toEqual([new Error('second window failed')]);
    expect(firstWindow.destroyed).toBe(false);
    expect(adapter.windowCount).toBe(1);
    expect(control.closedWindows).toEqual(['window-2']);
    expect(control.closed).toBe(false);
    expect(quitDesktop).not.toHaveBeenCalled();
  });

  it('reports both failures and exits Desktop when Runtime topology cleanup fails', async () => {
    const control = new FakeControl();
    const firstWindow = new FakeWindow();
    const errors: unknown[] = [];
    const quitDesktop = vi.fn();
    let attempt = 0;
    const adapter = new DesktopWindowControlAdapter({
      control: control.client,
      createWindow: async () => {
        attempt += 1;
        if (attempt === 1) return firstWindow;
        throw new Error('native window failed');
      },
      quitDesktop,
      onError: (error) => { errors.push(error); }
    });
    control.emit(openEvent('window-1'));
    await adapter.idle();
    control.closeWindowResponse = { result: 'rejected', code: 'invalid_desktop_window' };

    control.emit(openEvent('window-2'));
    await adapter.idle();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AggregateError);
    expect((errors[0] as AggregateError).errors).toHaveLength(2);
    expect(control.closedWindows).toEqual(['window-2']);
    expect(firstWindow.destroyed).toBe(true);
    expect(adapter.windowCount).toBe(0);
    expect(control.closed).toBe(true);
    expect(quitDesktop).toHaveBeenCalledOnce();
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
  themePreference: string | undefined;
  loaded: string[] = [];
  private closedListener: (() => void) | undefined;

  isDestroyed(): boolean { return this.destroyed; }
  show(): void { this.shown += 1; }
  focus(): void { this.focused += 1; }
  prepareLaunch(input: { ticket: string; themePreference: 'system' | 'dark' | 'light' }): void {
    this.ticket = input.ticket;
    this.themePreference = input.themePreference;
  }
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
  themePreference = 'system';
  closeWindowResponse: ControlResponse = { result: 'ok' };
  private listener: ((event: ControlEvent) => void) | undefined;

  readonly client = {
    createDesktopLaunchTicket: async (windowKey: string): Promise<ControlResponse> => {
      this.ticketRequests.push(windowKey);
      return {
        result: 'desktop_launch_ticket',
        ticket: `ticket-${windowKey}`,
        url: 'http://127.0.0.1:32125/',
        theme_preference: this.themePreference
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
