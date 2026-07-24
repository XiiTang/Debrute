import type { ControlEvent, ControlResponse, WorkbenchThemePreference } from '@debrute/app-protocol';

export interface DesktopWindowHostControl {
  createDesktopLaunchTicket(windowKey: string): Promise<ControlResponse>;
  desktopWindowClosed(windowKey: string): Promise<ControlResponse>;
  onEvent(listener: (event: ControlEvent) => void): () => void;
  close(): void;
}

export interface DesktopHostedWindow<NativeIdentity> {
  readonly identity: NativeIdentity;
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  applyLaunchPresentation(themePreference: WorkbenchThemePreference): void;
  load(url: string): Promise<void>;
  destroy(): void;
  onClosed(listener: () => void): () => void;
}

export interface DesktopWindowHostServices<
  NativeIdentity,
  Window extends DesktopHostedWindow<NativeIdentity>
> {
  control: DesktopWindowHostControl;
  createWindow(input: { windowKey: string }): Window;
  quitDesktop(): void | Promise<void>;
  onError(error: unknown): void;
}

interface WindowRecord<NativeIdentity, Window extends DesktopHostedWindow<NativeIdentity>> {
  readonly windowKey: string;
  readonly window: Window;
  phase: 'opening' | 'live';
  launchTicket: string | undefined;
  focusRequested: boolean;
  removeClosedListener: () => void;
}

interface PendingOpenRequest {
  focusRequested: boolean;
}

export class DesktopWindowHost<
  NativeIdentity,
  Window extends DesktopHostedWindow<NativeIdentity>
> {
  private readonly control: DesktopWindowHostControl;
  private readonly createWindow: DesktopWindowHostServices<NativeIdentity, Window>['createWindow'];
  private readonly quitDesktop: DesktopWindowHostServices<NativeIdentity, Window>['quitDesktop'];
  private readonly onError: DesktopWindowHostServices<NativeIdentity, Window>['onError'];
  private readonly records = new Map<string, WindowRecord<NativeIdentity, Window>>();
  private readonly pendingOpenRequests = new Map<string, PendingOpenRequest>();
  private readonly unsubscribeEvents: () => void;
  private operationChain = Promise.resolve();
  private shuttingDown = false;
  private quitPromise: Promise<void> | undefined;

  constructor(services: DesktopWindowHostServices<NativeIdentity, Window>) {
    this.control = services.control;
    this.createWindow = services.createWindow;
    this.quitDesktop = services.quitDesktop;
    this.onError = services.onError;
    this.unsubscribeEvents = this.control.onEvent((event) => this.receiveEvent(event));
  }

  takeDesktopLaunchTicket(identity: NativeIdentity): string | undefined {
    const record = this.findRecord(identity);
    const ticket = record?.launchTicket;
    if (record) {
      record.launchTicket = undefined;
    }
    return ticket;
  }

  async reload(identity: NativeIdentity): Promise<void> {
    const record = this.findRecord(identity);
    if (this.shuttingDown || !record || record.window.isDestroyed()) {
      throw new Error('Debrute native window is not available for reload.');
    }
    await this.enqueue(async () => {
      if (this.shuttingDown || !this.isCurrent(record) || record.window.isDestroyed()) {
        return;
      }
      let installedTicket: string | undefined;
      try {
        const launch = requireDesktopLaunch(
          await this.control.createDesktopLaunchTicket(record.windowKey)
        );
        if (this.shuttingDown || !this.isCurrent(record) || record.window.isDestroyed()) {
          return;
        }
        record.launchTicket = launch.ticket;
        installedTicket = launch.ticket;
        record.window.applyLaunchPresentation(launch.themePreference);
        await record.window.load(launch.url);
      } catch (error) {
        if (this.shuttingDown || !this.isCurrent(record)) {
          return;
        }
        if (installedTicket && record.launchTicket === installedTicket) {
          record.launchTicket = undefined;
        }
        throw error;
      }
    });
  }

  private receiveEvent(event: ControlEvent): Promise<void> | void {
    if (event.event === 'product_exiting' || event.event === 'product_replacing') {
      return this.shutdown().catch((error: unknown) => this.onError(error));
    }
    if (event.event === 'desktop_window_open_requested') {
      if (!this.shuttingDown
        && !this.records.has(event.window_key)
        && !this.pendingOpenRequests.has(event.window_key)) {
        this.pendingOpenRequests.set(event.window_key, { focusRequested: false });
      }
      return this.enqueue(() => this.openWindow(event.window_key))
        .catch((error: unknown) => this.onError(error));
    }
    if (event.event === 'desktop_window_focus_requested') {
      this.focusWindow(event.window_key);
    }
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const result = this.operationChain.then(operation);
    this.operationChain = result.catch(() => undefined);
    return result;
  }

  private async openWindow(windowKey: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    const existing = this.records.get(windowKey);
    if (existing && !existing.window.isDestroyed()) {
      this.pendingOpenRequests.delete(windowKey);
      if (existing.phase === 'opening') {
        existing.focusRequested = true;
      } else {
        existing.window.show();
        existing.window.focus();
      }
      return;
    }
    if (existing) {
      this.forgetRecord(existing, false);
    }
    let record: WindowRecord<NativeIdentity, Window> | undefined;
    try {
      const launch = requireDesktopLaunch(
        await this.control.createDesktopLaunchTicket(windowKey)
      );
      if (this.shuttingDown) {
        return;
      }
      const window = this.createWindow({ windowKey });
      const focusRequested = this.pendingOpenRequests.get(windowKey)?.focusRequested ?? false;
      this.pendingOpenRequests.delete(windowKey);
      record = {
        windowKey,
        window,
        phase: 'opening',
        launchTicket: launch.ticket,
        focusRequested,
        removeClosedListener: () => undefined
      };
      this.records.set(windowKey, record);
      const currentRecord = record;
      record.removeClosedListener = window.onClosed(() => this.handleWindowClosed(currentRecord));
      window.applyLaunchPresentation(launch.themePreference);
      await window.load(launch.url);
      if (!this.isCurrent(record) || this.shuttingDown) {
        return;
      }
      if (window.isDestroyed()) {
        throw new Error(`Desktop window ${windowKey} was destroyed while opening.`);
      }
      record.phase = 'live';
      window.show();
      if (record.focusRequested) {
        window.focus();
      }
    } catch (error) {
      if (this.shuttingDown || (record && !this.isCurrent(record))) {
        return;
      }
      await this.handleOpenFailure(windowKey, record, error);
    }
  }

  private focusWindow(windowKey: string): void {
    if (this.shuttingDown) {
      return;
    }
    const record = this.records.get(windowKey);
    if (!record) {
      const pendingOpen = this.pendingOpenRequests.get(windowKey);
      if (pendingOpen) {
        pendingOpen.focusRequested = true;
      }
      return;
    }
    if (record.window.isDestroyed()) {
      return;
    }
    if (record.phase === 'opening') {
      record.focusRequested = true;
      return;
    }
    record.window.show();
    record.window.focus();
  }

  private async handleOpenFailure(
    windowKey: string,
    record: WindowRecord<NativeIdentity, Window> | undefined,
    error: unknown
  ): Promise<never | void> {
    this.pendingOpenRequests.delete(windowKey);
    if (record) {
      this.forgetRecord(record, true);
    }
    try {
      const response = await this.control.desktopWindowClosed(windowKey);
      if (this.shuttingDown) {
        return;
      }
      if (response.result !== 'ok') {
        throw new Error(`Runtime rejected failed Desktop window cleanup: ${response.result}`);
      }
    } catch (cleanupError) {
      if (this.shuttingDown) {
        return;
      }
      const aggregate = new AggregateError(
        [error, cleanupError],
        `Desktop window ${windowKey} could not open or be removed from Runtime topology.`
      );
      await this.shutdown();
      throw aggregate;
    }
    if (this.records.size === 0) {
      await this.exitDesktopOnly();
    }
    throw error;
  }

  private handleWindowClosed(record: WindowRecord<NativeIdentity, Window>): void {
    if (!this.isCurrent(record)) {
      return;
    }
    this.forgetRecord(record, false);
    if (this.shuttingDown) {
      return;
    }
    if (this.records.size === 0) {
      void this.exitDesktopOnly().catch((error: unknown) => this.onError(error));
      return;
    }
    void this.reportWindowClosed(record.windowKey);
  }

  private async reportWindowClosed(windowKey: string): Promise<void> {
    try {
      const response = await this.control.desktopWindowClosed(windowKey);
      if (this.shuttingDown) {
        return;
      }
      if (response.result !== 'ok') {
        throw new Error(`Runtime rejected Desktop window close: ${response.result}`);
      }
    } catch (error) {
      if (this.shuttingDown) {
        return;
      }
      this.onError(error);
      await this.shutdown();
    }
  }

  private shutdown(): Promise<void> {
    return this.exitDesktopOnly(true);
  }

  private exitDesktopOnly(destroyWindows = false): Promise<void> {
    if (this.quitPromise) {
      return this.quitPromise;
    }
    this.shuttingDown = true;
    this.unsubscribeEvents();
    if (destroyWindows) {
      for (const record of [...this.records.values()]) {
        this.forgetRecord(record, true);
      }
    }
    this.pendingOpenRequests.clear();
    this.control.close();
    try {
      this.quitPromise = Promise.resolve(this.quitDesktop());
    } catch (error) {
      this.quitPromise = Promise.reject(error);
    }
    return this.quitPromise;
  }

  private forgetRecord(
    record: WindowRecord<NativeIdentity, Window>,
    destroy: boolean
  ): void {
    if (!this.isCurrent(record)) {
      return;
    }
    this.records.delete(record.windowKey);
    this.pendingOpenRequests.delete(record.windowKey);
    record.launchTicket = undefined;
    record.removeClosedListener();
    if (destroy && !record.window.isDestroyed()) {
      record.window.destroy();
    }
  }

  private findRecord(
    identity: NativeIdentity
  ): WindowRecord<NativeIdentity, Window> | undefined {
    return [...this.records.values()].find((record) => record.window.identity === identity);
  }

  private isCurrent(record: WindowRecord<NativeIdentity, Window>): boolean {
    return this.records.get(record.windowKey) === record;
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

function requireDesktopLaunch(response: ControlResponse): {
  ticket: string;
  url: string;
  themePreference: WorkbenchThemePreference;
} {
  const launch = requireResponse(response, 'desktop_launch_ticket');
  if (!isWorkbenchThemePreference(launch.theme_preference)) {
    throw new Error('Runtime returned an invalid Desktop launch theme preference.');
  }
  return {
    ticket: launch.ticket,
    url: launch.url,
    themePreference: launch.theme_preference
  };
}

function isWorkbenchThemePreference(value: unknown): value is WorkbenchThemePreference {
  return value === 'system' || value === 'dark' || value === 'light';
}
