import type { ControlEvent, ControlResponse } from '@debrute/app-protocol';
import type { RuntimeControlClient } from '@debrute/runtime-control-client';

export interface DesktopNativeWindow {
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  setLaunchTicket(ticket: string): void;
  load(url: string): Promise<void>;
  destroy(): void;
  onClosed(listener: () => void): () => void;
}

export interface DesktopWindowControlAdapterServices<Window extends DesktopNativeWindow> {
  control: RuntimeControlClient;
  createWindow(input: { windowKey: string; ticket: string; url: string }): Promise<Window>;
  quitDesktop(): void | Promise<void>;
  onError(error: unknown): void;
}

export class DesktopWindowControlAdapter<Window extends DesktopNativeWindow> {
  private readonly control: RuntimeControlClient;
  private readonly createNativeWindow: DesktopWindowControlAdapterServices<Window>['createWindow'];
  private readonly quitDesktop: DesktopWindowControlAdapterServices<Window>['quitDesktop'];
  private readonly onError: DesktopWindowControlAdapterServices<Window>['onError'];
  private readonly windows = new Map<string, Window>();
  private readonly removeClosedListenerByWindowKey = new Map<string, () => void>();
  private readonly unsubscribeEvents: () => void;
  private eventChain = Promise.resolve();
  private shuttingDown = false;

  constructor(services: DesktopWindowControlAdapterServices<Window>) {
    this.control = services.control;
    this.createNativeWindow = services.createWindow;
    this.quitDesktop = services.quitDesktop;
    this.onError = services.onError;
    this.unsubscribeEvents = this.control.onEvent((event) => this.enqueueEvent(event));
  }

  get windowCount(): number {
    return this.windows.size;
  }

  async reloadWindow(windowKey: string): Promise<boolean> {
    if (this.shuttingDown) {
      return false;
    }
    const window = this.windows.get(windowKey);
    if (!window || window.isDestroyed()) {
      return false;
    }
    const launch = requireResponse(
      await this.control.createDesktopLaunchTicket(windowKey),
      'desktop_launch_ticket'
    );
    window.setLaunchTicket(launch.ticket);
    await window.load(launch.url);
    return true;
  }

  async idle(): Promise<void> {
    await this.eventChain;
  }

  dispose(): void {
    this.unsubscribeEvents();
    for (const removeListener of this.removeClosedListenerByWindowKey.values()) {
      removeListener();
    }
    this.removeClosedListenerByWindowKey.clear();
  }

  private enqueueEvent(event: ControlEvent): void {
    this.eventChain = this.eventChain
      .then(() => this.handleEvent(event))
      .catch((error: unknown) => this.onError(error));
  }

  private async handleEvent(event: ControlEvent): Promise<void> {
    if (event.event === 'desktop_window_open_requested') {
      await this.openWindow(event.window_key);
    } else if (event.event === 'desktop_window_focus_requested') {
      const window = this.windows.get(event.window_key);
      if (window && !window.isDestroyed()) {
        window.show();
        window.focus();
      }
    } else if (event.event === 'product_exiting' || event.event === 'product_replacing') {
      await this.shutdown();
    }
  }

  private async openWindow(windowKey: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    const existing = this.windows.get(windowKey);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    this.forgetWindow(windowKey);
    try {
      const launch = requireResponse(
        await this.control.createDesktopLaunchTicket(windowKey),
        'desktop_launch_ticket'
      );
      const window = await this.createNativeWindow({
        windowKey,
        ticket: launch.ticket,
        url: launch.url
      });
      if (this.shuttingDown || window.isDestroyed()) {
        window.destroy();
        return;
      }
      this.windows.set(windowKey, window);
      this.removeClosedListenerByWindowKey.set(
        windowKey,
        window.onClosed(() => this.enqueueWindowClosed(windowKey, window))
      );
    } catch (error) {
      try {
        const response = await this.control.desktopWindowClosed(windowKey);
        if (response.result !== 'ok') {
          throw new Error(`Runtime rejected failed Desktop window cleanup: ${response.result}`);
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Desktop window ${windowKey} could not open or be removed from Runtime topology.`
        );
      }
      throw error;
    }
  }

  private enqueueWindowClosed(windowKey: string, window: Window): void {
    this.eventChain = this.eventChain
      .then(async () => {
        if (this.windows.get(windowKey) !== window) {
          return;
        }
        this.forgetWindow(windowKey);
        if (!this.shuttingDown) {
          const response = await this.control.desktopWindowClosed(windowKey);
          if (response.result !== 'ok') {
            throw new Error(`Runtime rejected Desktop window close: ${response.result}`);
          }
        }
        if (this.windows.size === 0) {
          await this.exitDesktopOnly();
        }
      })
      .catch((error: unknown) => this.onError(error));
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    for (const [windowKey, window] of this.windows) {
      this.removeClosedListenerByWindowKey.get(windowKey)?.();
      if (!window.isDestroyed()) {
        window.destroy();
      }
    }
    this.windows.clear();
    this.removeClosedListenerByWindowKey.clear();
    await this.exitDesktopOnly();
  }

  private async exitDesktopOnly(): Promise<void> {
    this.shuttingDown = true;
    this.control.close();
    await this.quitDesktop();
  }

  private forgetWindow(windowKey: string): void {
    this.windows.delete(windowKey);
    this.removeClosedListenerByWindowKey.get(windowKey)?.();
    this.removeClosedListenerByWindowKey.delete(windowKey);
  }
}

function requireResponse<Result extends ControlResponse['result']>(
  response: ControlResponse,
  expected: Result
): Extract<ControlResponse, { result: Result }> {
  if (response.result !== expected) {
    throw new Error(`Runtime rejected Desktop action: ${response.result}`);
  }
  return response as Extract<ControlResponse, { result: Result }>;
}
