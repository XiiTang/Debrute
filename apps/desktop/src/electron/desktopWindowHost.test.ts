import type { ControlEvent, ControlResponse } from '@debrute/app-protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  DesktopWindowHost,
  type DesktopHostedWindow,
  type DesktopWindowHostControl
} from './desktopWindowHost.js';

describe('DesktopWindowHost', () => {
  it('makes the one-use launch ticket available to preload while the window loads', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    let host!: DesktopWindowHost<object, FakeWindow>;
    nativeWindow.onLoad = () => {
      expect(nativeWindow.presentations).toEqual(['system']);
      expect(host.takeDesktopLaunchTicket(nativeWindow.identity)).toBe('ticket-window-1-1');
      expect(host.takeDesktopLaunchTicket(nativeWindow.identity)).toBeUndefined();
    };
    host = new DesktopWindowHost({
      control,
      createWindow: () => nativeWindow,
      quitDesktop: () => undefined,
      onError: (error) => { throw error; }
    });

    await control.emit(openEvent('window-1'));

    expect(nativeWindow.loaded).toEqual(['http://127.0.0.1:32125/']);
    expect(nativeWindow.shown).toBe(1);
  });

  it('defers focus requested while a window is opening until its document is live', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    const loadGate = deferred<void>();
    nativeWindow.loadGate = loadGate.promise;
    const host = createHost(control, [nativeWindow]);

    const opened = control.emit(openEvent('window-1'));
    await nativeWindow.loadStarted.promise;
    const focused = control.emit({
      event: 'desktop_window_focus_requested',
      window_key: 'window-1'
    });

    expect(nativeWindow.shown).toBe(0);
    expect(nativeWindow.focused).toBe(0);
    loadGate.resolve();
    await Promise.all([opened, focused]);

    expect(nativeWindow.shown).toBe(1);
    expect(nativeWindow.focused).toBe(1);
    expect(host.takeDesktopLaunchTicket(nativeWindow.identity)).toBe('ticket-window-1-1');
  });

  it('retains focus requested before the opening window has received its ticket', async () => {
    const control = new FakeControl();
    const ticketGate = deferred<void>();
    control.ticketGates.push(ticketGate.promise);
    const nativeWindow = new FakeWindow();
    createHost(control, [nativeWindow]);

    const opened = control.emit(openEvent('window-1'));
    await control.waitForTicketRequests(1);
    await control.emit({
      event: 'desktop_window_focus_requested',
      window_key: 'window-1'
    });
    ticketGate.resolve();
    await opened;

    expect(nativeWindow.shown).toBe(1);
    expect(nativeWindow.focused).toBe(1);
  });

  it('does not retain focus for a key without a pending open request', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    createHost(control, [nativeWindow]);

    await control.emit({
      event: 'desktop_window_focus_requested',
      window_key: 'window-1'
    });
    await control.emit(openEvent('window-1'));

    expect(nativeWindow.shown).toBe(1);
    expect(nativeWindow.focused).toBe(0);
  });

  it('reports a non-final close once and exits locally on the final close', async () => {
    const control = new FakeControl();
    const firstWindow = new FakeWindow();
    const secondWindow = new FakeWindow();
    const quitDesktop = vi.fn();
    createHost(control, [firstWindow, secondWindow], { quitDesktop });
    await control.emit(openEvent('window-1'));
    await control.emit(openEvent('window-2'));

    firstWindow.close();
    await control.windowClosedReported.promise;

    expect(control.closedWindows).toEqual(['window-1']);
    expect(control.closed).toBe(false);
    expect(quitDesktop).not.toHaveBeenCalled();

    secondWindow.close();
    await control.closedSignal.promise;

    expect(control.closedWindows).toEqual(['window-1']);
    expect(control.closed).toBe(true);
    expect(quitDesktop).toHaveBeenCalledOnce();
  });

  it('lets Product exit preempt a window load and ignores its late completion', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    const loadGate = deferred<void>();
    nativeWindow.loadGate = loadGate.promise;
    const errors: unknown[] = [];
    const quitDesktop = vi.fn();
    createHost(control, [nativeWindow], { quitDesktop, errors });

    const opened = control.emit(openEvent('window-1'));
    await nativeWindow.loadStarted.promise;
    await control.emit({ event: 'product_exiting' });

    expect(nativeWindow.destroyed).toBe(true);
    expect(control.closed).toBe(true);
    expect(control.closedWindows).toEqual([]);
    expect(quitDesktop).toHaveBeenCalledOnce();

    loadGate.resolve();
    await opened;
    expect(nativeWindow.shown).toBe(0);
    expect(errors).toEqual([]);
  });

  it('serializes explicit reloads and gives each one a fresh ticket', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    const host = createHost(control, [nativeWindow]);
    await control.emit(openEvent('window-1'));
    const firstTicketGate = deferred<void>();
    control.ticketGates.push(firstTicketGate.promise);

    const firstReload = host.reload(nativeWindow.identity);
    const secondReload = host.reload(nativeWindow.identity);
    await control.waitForTicketRequests(2);

    expect(control.ticketRequests).toEqual(['window-1', 'window-1']);
    firstTicketGate.resolve();
    await control.waitForTicketRequests(3);
    await Promise.all([firstReload, secondReload]);

    expect(control.ticketRequests).toEqual(['window-1', 'window-1', 'window-1']);
    expect(nativeWindow.loaded).toEqual([
      'http://127.0.0.1:32125/',
      'http://127.0.0.1:32125/',
      'http://127.0.0.1:32125/'
    ]);
    expect(host.takeDesktopLaunchTicket(nativeWindow.identity)).toBe('ticket-window-1-3');
  });

  it('keeps a live window after reload failure and allows a later manual reload', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    const host = createHost(control, [nativeWindow]);
    await control.emit(openEvent('window-1'));
    nativeWindow.loadErrors.push(new Error('reload failed'));

    await expect(host.reload(nativeWindow.identity)).rejects.toThrow('reload failed');

    expect(nativeWindow.destroyed).toBe(false);
    expect(host.takeDesktopLaunchTicket(nativeWindow.identity)).toBeUndefined();
    await expect(host.reload(nativeWindow.identity)).resolves.toBeUndefined();
    expect(control.ticketRequests).toEqual(['window-1', 'window-1', 'window-1']);
  });

  it('drops a queued reload when its target closes before that reload begins', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    const host = createHost(control, [nativeWindow]);
    await control.emit(openEvent('window-1'));
    const ticketGate = deferred<void>();
    control.ticketGates.push(ticketGate.promise);

    const activeReload = host.reload(nativeWindow.identity);
    const queuedReload = host.reload(nativeWindow.identity);
    await control.waitForTicketRequests(2);
    nativeWindow.close();
    ticketGate.resolve();

    await expect(Promise.all([activeReload, queuedReload])).resolves.toEqual([undefined, undefined]);
    expect(control.ticketRequests).toEqual(['window-1', 'window-1']);
    expect(control.closedWindows).toEqual([]);
  });

  it('cleans a failed initial open from Runtime and exits only when no live window remains', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    nativeWindow.loadErrors.push(new Error('initial load failed'));
    const errors: unknown[] = [];
    const quitDesktop = vi.fn();
    createHost(control, [nativeWindow], { quitDesktop, errors });

    await control.emit(openEvent('window-1'));

    expect(errors).toEqual([new Error('initial load failed')]);
    expect(nativeWindow.destroyed).toBe(true);
    expect(control.closedWindows).toEqual(['window-1']);
    expect(control.closed).toBe(true);
    expect(quitDesktop).toHaveBeenCalledOnce();
  });

  it('keeps existing windows live when an additional initial load fails cleanly', async () => {
    const control = new FakeControl();
    const firstWindow = new FakeWindow();
    const secondWindow = new FakeWindow();
    secondWindow.loadErrors.push(new Error('second load failed'));
    const errors: unknown[] = [];
    const quitDesktop = vi.fn();
    createHost(control, [firstWindow, secondWindow], { quitDesktop, errors });
    await control.emit(openEvent('window-1'));

    await control.emit(openEvent('window-2'));

    expect(errors).toEqual([new Error('second load failed')]);
    expect(firstWindow.destroyed).toBe(false);
    expect(secondWindow.destroyed).toBe(true);
    expect(control.closedWindows).toEqual(['window-2']);
    expect(control.closed).toBe(false);
    expect(quitDesktop).not.toHaveBeenCalled();
  });

  it('fails closed when Runtime rejects a non-final close report', async () => {
    const control = new FakeControl();
    const firstWindow = new FakeWindow();
    const secondWindow = new FakeWindow();
    const errors: unknown[] = [];
    const quitDesktop = vi.fn();
    createHost(control, [firstWindow, secondWindow], { quitDesktop, errors });
    await control.emit(openEvent('window-1'));
    await control.emit(openEvent('window-2'));
    control.closeWindowResponse = { result: 'rejected', code: 'invalid_desktop_window' };

    firstWindow.close();
    await control.closedSignal.promise;

    expect(errors).toEqual([new Error('Runtime rejected Desktop window close: rejected')]);
    expect(secondWindow.destroyed).toBe(true);
    expect(quitDesktop).toHaveBeenCalledOnce();
  });

  it('rejects invalid launch presentation instead of choosing a fallback', async () => {
    const control = new FakeControl();
    control.themePreference = 'sepia';
    const nativeWindow = new FakeWindow();
    const errors: unknown[] = [];
    createHost(control, [nativeWindow], { errors });

    await control.emit(openEvent('window-1'));

    expect(errors).toEqual([
      new Error('Runtime returned an invalid Desktop launch theme preference.')
    ]);
    expect(nativeWindow.loaded).toEqual([]);
    expect(control.closedWindows).toEqual(['window-1']);
  });

  it('reports both failures and exits when failed-open topology cleanup is rejected', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    nativeWindow.loadErrors.push(new Error('initial load failed'));
    control.closeWindowResponse = { result: 'rejected', code: 'invalid_desktop_window' };
    const errors: unknown[] = [];
    const quitDesktop = vi.fn();
    createHost(control, [nativeWindow], { quitDesktop, errors });

    await control.emit(openEvent('window-1'));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AggregateError);
    expect((errors[0] as AggregateError).errors).toEqual([
      new Error('initial load failed'),
      new Error('Runtime rejected failed Desktop window cleanup: rejected')
    ]);
    expect(control.closed).toBe(true);
    expect(quitDesktop).toHaveBeenCalledOnce();
  });

  it('ignores a late ticket response after Product replacement starts', async () => {
    const control = new FakeControl();
    const ticketGate = deferred<void>();
    control.ticketGates.push(ticketGate.promise);
    const nativeWindow = new FakeWindow();
    const errors: unknown[] = [];
    createHost(control, [nativeWindow], { errors });

    const opened = control.emit(openEvent('window-1'));
    await control.waitForTicketRequests(1);
    await control.emit({ event: 'product_replacing' });
    ticketGate.resolve();
    await opened;

    expect(nativeWindow.loaded).toEqual([]);
    expect(nativeWindow.shown).toBe(0);
    expect(errors).toEqual([]);
  });

  it('suppresses an active reload failure after the target window closes', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    const host = createHost(control, [nativeWindow]);
    await control.emit(openEvent('window-1'));
    const loadGate = deferred<void>();
    const reloadLoadStarted = deferred<void>();
    nativeWindow.loadGate = loadGate.promise;
    nativeWindow.onLoad = () => {
      if (nativeWindow.loaded.length === 2) {
        reloadLoadStarted.resolve();
      }
    };

    const reloaded = host.reload(nativeWindow.identity);
    await reloadLoadStarted.promise;
    nativeWindow.close();
    loadGate.reject(new Error('late reload failure'));

    await expect(reloaded).resolves.toBeUndefined();
  });

  it('suppresses a ticket-request failure after Product exit preempts reload', async () => {
    const control = new FakeControl();
    const nativeWindow = new FakeWindow();
    const host = createHost(control, [nativeWindow]);
    await control.emit(openEvent('window-1'));
    const ticketGate = deferred<void>();
    control.ticketGates.push(ticketGate.promise);

    const reloaded = host.reload(nativeWindow.identity);
    await control.waitForTicketRequests(2);
    await control.emit({ event: 'product_exiting' });
    ticketGate.reject(new Error('Control closed'));

    await expect(reloaded).resolves.toBeUndefined();
  });
});

function createHost(
  control: FakeControl,
  windows: FakeWindow[],
  options: { quitDesktop?: () => void; errors?: unknown[] } = {}
): DesktopWindowHost<object, FakeWindow> {
  return new DesktopWindowHost({
    control,
    createWindow: () => {
      const window = windows.shift();
      if (!window) {
        throw new Error('No fake window is available.');
      }
      return window;
    },
    quitDesktop: options.quitDesktop ?? (() => undefined),
    onError: (error) => {
      if (!options.errors) {
        throw error;
      }
      options.errors.push(error);
    }
  });
}

function openEvent(windowKey: string): ControlEvent {
  return {
    event: 'desktop_window_open_requested',
    window_key: windowKey,
    route: { kind: 'root' }
  };
}

class FakeWindow implements DesktopHostedWindow<object> {
  readonly identity = {};
  destroyed = false;
  shown = 0;
  focused = 0;
  loaded: string[] = [];
  presentations: string[] = [];
  onLoad: (() => void) | undefined;
  loadGate: Promise<void> | undefined;
  readonly loadErrors: Error[] = [];
  readonly loadStarted = deferred<void>();
  private closedListener: (() => void) | undefined;

  isDestroyed(): boolean { return this.destroyed; }
  show(): void { this.shown += 1; }
  focus(): void { this.focused += 1; }
  applyLaunchPresentation(themePreference: 'system' | 'dark' | 'light'): void {
    this.presentations.push(themePreference);
  }
  async load(url: string): Promise<void> {
    this.loaded.push(url);
    this.onLoad?.();
    this.loadStarted.resolve();
    await this.loadGate;
    const error = this.loadErrors.shift();
    if (error) {
      throw error;
    }
  }
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

class FakeControl implements DesktopWindowHostControl {
  private listener: ((event: ControlEvent) => void | Promise<void>) | undefined;
  private ticketSequence = 0;
  private readonly ticketRequestWaiters = new Map<number, ReturnType<typeof deferred<void>>>();
  readonly closedSignal = deferred<void>();
  readonly windowClosedReported = deferred<void>();
  closed = false;
  closedWindows: string[] = [];
  ticketRequests: string[] = [];
  ticketGates: Promise<void>[] = [];
  themePreference = 'system';
  closeWindowResponse: ControlResponse = { result: 'ok' };

  async createDesktopLaunchTicket(windowKey: string): Promise<ControlResponse> {
    this.ticketRequests.push(windowKey);
    this.ticketRequestWaiters.get(this.ticketRequests.length)?.resolve();
    await this.ticketGates.shift();
    this.ticketSequence += 1;
    return {
      result: 'desktop_launch_ticket',
      ticket: `ticket-${windowKey}-${this.ticketSequence}`,
      url: 'http://127.0.0.1:32125/',
      theme_preference: this.themePreference
    };
  }

  async desktopWindowClosed(windowKey: string): Promise<ControlResponse> {
    this.closedWindows.push(windowKey);
    this.windowClosedReported.resolve();
    return this.closeWindowResponse;
  }

  onEvent(listener: (event: ControlEvent) => void | Promise<void>): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }

  close(): void {
    this.closed = true;
    this.closedSignal.resolve();
  }

  async emit(event: ControlEvent): Promise<void> {
    await this.listener?.(event);
  }

  async waitForTicketRequests(count: number): Promise<void> {
    if (this.ticketRequests.length >= count) {
      return;
    }
    const waiter = deferred<void>();
    this.ticketRequestWaiters.set(count, waiter);
    await waiter.promise;
    this.ticketRequestWaiters.delete(count);
  }
}

function deferred<Value>() {
  let resolve!: (value?: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value as Value | PromiseLike<Value>);
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
