import { EventEmitter } from 'node:events';
import {
  checkWorkbenchRuntimeHealth,
  deleteWorkbenchRuntimeState,
  ensureRegisteredWorkbenchRuntime,
  isWorkbenchRuntimeOwnedBy,
  readWorkbenchRuntimeState,
  terminateOwnedWorkbenchRuntime,
  type EnsureRegisteredWorkbenchRuntimeResult,
  type WorkbenchRuntimeHealthStatus,
  type WorkbenchRuntimeOwner,
  type WorkbenchRuntimeState
} from '@debrute/workbench-runtime';
import { launchPackagedDesktopRuntime } from './desktopRuntimeLauncher.js';
import type { DesktopProductRuntimeConfig } from './desktopProductRuntimeConfig.js';
import { desktopStatusFromHealth, type DesktopRuntimeSnapshot } from './runtimeStatus.js';

export interface RuntimeSupervisorServices {
  owner: WorkbenchRuntimeOwner;
  productRuntimeConfig?: DesktopProductRuntimeConfig;
  ensureRuntime?: typeof ensureRegisteredWorkbenchRuntime;
  readState?: typeof readWorkbenchRuntimeState;
  deleteState?: typeof deleteWorkbenchRuntimeState;
  terminateOwned?: typeof terminateOwnedWorkbenchRuntime;
  launchRuntime?: Parameters<typeof ensureRegisteredWorkbenchRuntime>[0]['launch'];
  checkHealth?: (state: WorkbenchRuntimeState) => Promise<WorkbenchRuntimeHealthStatus>;
}

export class RuntimeSupervisor extends EventEmitter {
  private readonly owner: WorkbenchRuntimeOwner;
  private readonly ensureRuntime: typeof ensureRegisteredWorkbenchRuntime;
  private readonly readState: typeof readWorkbenchRuntimeState;
  private readonly deleteState: typeof deleteWorkbenchRuntimeState;
  private readonly terminateOwned: typeof terminateOwnedWorkbenchRuntime;
  private readonly launchRuntime: Parameters<typeof ensureRegisteredWorkbenchRuntime>[0]['launch'];
  private readonly checkHealth: (state: WorkbenchRuntimeState) => Promise<WorkbenchRuntimeHealthStatus>;
  private statePath: string | undefined;
  private current: DesktopRuntimeSnapshot = { status: 'stopped', ownsRuntime: false };

  constructor(input: RuntimeSupervisorServices) {
    super();
    this.owner = input.owner;
    this.ensureRuntime = input.ensureRuntime ?? ensureRegisteredWorkbenchRuntime;
    this.readState = input.readState ?? readWorkbenchRuntimeState;
    this.deleteState = input.deleteState ?? deleteWorkbenchRuntimeState;
    this.terminateOwned = input.terminateOwned ?? terminateOwnedWorkbenchRuntime;
    this.launchRuntime = input.launchRuntime ?? ((paths) => {
      if (!input.productRuntimeConfig) {
        throw new Error('Desktop product runtime config is required to launch packaged Debrute runtime.');
      }
      return launchPackagedDesktopRuntime(paths, input.owner, input.productRuntimeConfig);
    });
    this.checkHealth = input.checkHealth ?? ((state) => checkWorkbenchRuntimeHealth(state));
  }

  snapshot(): DesktopRuntimeSnapshot {
    return { ...this.current };
  }

  async start(): Promise<WorkbenchRuntimeState> {
    this.publish({ status: 'starting', ownsRuntime: false });
    try {
      const result = await this.ensureRuntime({
        launch: this.launchRuntime,
        isHealthy: async (state) => {
          const health = await this.checkHealth(state);
          return health === 'healthy' || health === 'web-unavailable';
        },
        shouldTerminateStaleRuntime: (state) => this.owns(state),
        onRuntimeLaunchFailed: (state) => this.terminateOwned(state, this.owner)
      });
      await this.applyRegistryResult(result);
      return result.state;
    } catch (error) {
      this.publish({ status: 'error', ownsRuntime: false, lastError: messageFromUnknown(error) });
      throw error;
    }
  }

  async refresh(): Promise<DesktopRuntimeSnapshot> {
    const state = this.current.state;
    if (!state) {
      return this.snapshot();
    }
    const health = await this.checkHealth(state);
    this.publish({
      ...this.current,
      status: desktopStatusFromHealth(health),
      lastHealth: health
    });
    return this.snapshot();
  }

  async restart(): Promise<WorkbenchRuntimeState> {
    await this.stopOwnedRuntime();
    return this.start();
  }

  async stopOwnedRuntime(): Promise<void> {
    const state = this.current.state;
    if (!state || !this.statePath || !this.owns(state)) {
      return;
    }
    const currentState = await this.readState(this.statePath).catch(() => undefined);
    if (currentState && runtimeIdentityMatches(currentState, state) && this.owns(currentState)) {
      this.terminateOwned(currentState, this.owner);
      await this.deleteState(this.statePath);
      this.publish({ status: 'stopped', ownsRuntime: false });
    }
  }

  private async applyRegistryResult(result: EnsureRegisteredWorkbenchRuntimeResult): Promise<void> {
    const health = await this.checkHealth(result.state);
    this.statePath = result.statePath;
    this.publish({
      status: desktopStatusFromHealth(health),
      state: result.state,
      ownsRuntime: this.owns(result.state),
      lastHealth: health
    });
  }

  private owns(state: WorkbenchRuntimeState): boolean {
    return state.processControl === 'managed' && isWorkbenchRuntimeOwnedBy(state, this.owner);
  }

  private publish(snapshot: DesktopRuntimeSnapshot): void {
    this.current = snapshot;
    this.emit('change', this.snapshot());
  }
}

function runtimeIdentityMatches(a: WorkbenchRuntimeState, b: WorkbenchRuntimeState): boolean {
  return a.daemonUrl === b.daemonUrl && a.webUrl === b.webUrl && a.token === b.token;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
