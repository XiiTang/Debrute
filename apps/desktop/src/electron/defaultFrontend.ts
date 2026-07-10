import type { DebruteGlobalSettingsView } from '@debrute/app-protocol';

export interface DefaultFrontendRuntimeClient {
  globalSettingsGet(): Promise<DebruteGlobalSettingsView>;
}

export interface DefaultFrontendExecutionFailure {
  source: string;
  message: string;
}

export interface ExecuteDefaultFrontendInput {
  runtimeClient: DefaultFrontendRuntimeClient;
  openElectron(): Promise<void>;
  openBrowser(): Promise<void>;
  source: string;
  recordFailure(failure: DefaultFrontendExecutionFailure): void;
}

export async function executeDefaultFrontend(input: ExecuteDefaultFrontendInput): Promise<void> {
  try {
    const settings = await input.runtimeClient.globalSettingsGet();
    if (settings.workbench.defaultFrontend === 'electron') {
      await input.openElectron();
      return;
    }
    if (settings.workbench.defaultFrontend === 'browser') {
      await input.openBrowser();
    }
  } catch (error) {
    input.recordFailure({
      source: input.source,
      message: messageFromUnknown(error)
    });
  }
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
