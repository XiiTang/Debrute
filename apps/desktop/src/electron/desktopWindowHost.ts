import type {
  ActivationIntent,
  ControlEvent,
  ControlResponse,
  DesktopLaunchContext,
  WorkbenchThemePreference
} from '@debrute/app-protocol';

export interface DesktopWindowHostControl {
  activate(intent: ActivationIntent, preferredWindowKey?: string): Promise<ControlResponse>;
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
  launchContext: DesktopLaunchContext | undefined;
  focusRequested: boolean;
  creation: PendingWindowCreation<NativeIdentity> | undefined;
  removeClosedListener: () => void;
}

interface PendingOpenRequest<NativeIdentity> {
  focusRequested: boolean;
  initialProjectRoot: string | undefined;
  creation: PendingWindowCreation<NativeIdentity> | undefined;
}

interface PendingWindowCreation<NativeIdentity> {
  initialProjectRoot: string | undefined;
  resolve(identity: NativeIdentity): void;
  reject(error: unknown): void;
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
  private readonly pendingOpenRequests = new Map<string, PendingOpenRequest<NativeIdentity>>();
  private readonly pendingWindowCreations: Array<PendingWindowCreation<NativeIdentity>> = [];
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

  takeDesktopLaunchContext(identity: NativeIdentity): DesktopLaunchContext | undefined {
    const record = this.findRecord(identity);
    const context = record?.launchContext;
    if (record) {
      record.launchContext = undefined;
    }
    return context;
  }

  isLiveWindow(identity: NativeIdentity): boolean {
    const record = this.findRecord(identity);
    return record?.phase === 'live' && !record.window.isDestroyed();
  }

  singleLiveWindow(): NativeIdentity | undefined {
    const live = [...this.records.values()].filter((record) => (
      record.phase === 'live' && !record.window.isDestroyed()
    ));
    return live.length === 1 ? live[0]?.window.identity : undefined;
  }

  identityForWindowKey(windowKey: string): NativeIdentity | undefined {
    const record = this.records.get(windowKey);
    return record?.phase === 'live' && !record.window.isDestroyed()
      ? record.window.identity
      : undefined;
  }

  async openWindow(initialProjectRoot?: string): Promise<NativeIdentity> {
    let resolve!: (identity: NativeIdentity) => void;
    let reject!: (error: unknown) => void;
    const opened = new Promise<NativeIdentity>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const creation: PendingWindowCreation<NativeIdentity> = {
      initialProjectRoot,
      resolve,
      reject
    };
    this.pendingWindowCreations.push(creation);
    try {
      requireResponse(await this.control.activate({ kind: 'open_desktop' }), 'activation');
    } catch (error) {
      const index = this.pendingWindowCreations.indexOf(creation);
      if (index >= 0) {
        this.pendingWindowCreations.splice(index, 1);
        creation.reject(error);
      }
      throw error;
    }
    return opened;
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
        record.launchContext = { desktopLaunchTicket: launch.ticket };
        installedTicket = launch.ticket;
        record.window.applyLaunchPresentation(launch.themePreference);
        await record.window.load(launch.url);
      } catch (error) {
        if (this.shuttingDown || !this.isCurrent(record)) {
          return;
        }
        if (installedTicket && record.launchContext?.desktopLaunchTicket === installedTicket) {
          record.launchContext = undefined;
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
        const creation = this.pendingWindowCreations.shift();
        this.pendingOpenRequests.set(event.window_key, {
          focusRequested: false,
          initialProjectRoot: creation?.initialProjectRoot,
          creation
        });
      }
      return this.enqueue(() => this.openRequestedWindow(event.window_key))
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

  private async openRequestedWindow(windowKey: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    const existing = this.records.get(windowKey);
    if (existing) {
      if (!existing.window.isDestroyed()) {
        this.pendingOpenRequests.delete(windowKey);
        if (existing.phase === 'opening') {
          existing.focusRequested = true;
        } else {
          existing.window.show();
          existing.window.focus();
        }
        return;
      }
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
      const pendingOpen = this.pendingOpenRequests.get(windowKey);
      const focusRequested = pendingOpen?.focusRequested ?? false;
      this.pendingOpenRequests.delete(windowKey);
      record = {
        windowKey,
        window,
        phase: 'opening',
        launchContext: {
          desktopLaunchTicket: launch.ticket,
          ...(pendingOpen?.initialProjectRoot
            ? { initialProjectRoot: pendingOpen.initialProjectRoot }
            : {})
        },
        focusRequested,
        creation: pendingOpen?.creation,
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
      record.creation?.resolve(window.identity);
      record.creation = undefined;
    } catch (error) {
      if (this.shuttingDown || (record && !this.isCurrent(record))) {
        return;
      }
      const creation = record?.creation ?? this.pendingOpenRequests.get(windowKey)?.creation;
      creation?.reject(error);
      if (record) {
        record.creation = undefined;
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
    for (const pending of this.pendingOpenRequests.values()) {
      pending.creation?.reject(new Error('Debrute Desktop ended before its window opened.'));
    }
    this.pendingOpenRequests.clear();
    for (const creation of this.pendingWindowCreations.splice(0)) {
      creation.reject(new Error('Debrute Desktop ended before its window opened.'));
    }
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
    record.launchContext = undefined;
    record.creation?.reject(new Error('Debrute Desktop window closed before it opened.'));
    record.creation = undefined;
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
