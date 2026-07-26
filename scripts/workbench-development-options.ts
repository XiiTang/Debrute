export interface WorkbenchDevelopmentOptions {
  canvasPerfEnabled: boolean;
  startupPerfEnabled: boolean;
}

export function parseWorkbenchDevelopmentOptions(arguments_: string[]): WorkbenchDevelopmentOptions {
  const options = arguments_.filter((argument) => argument !== '--');
  const unknownArgument = options.find((argument) => (
    argument !== '--canvas-perf' && argument !== '--startup-perf'
  ));
  if (unknownArgument) {
    throw new Error(`Unknown Workbench development argument: ${unknownArgument}`);
  }
  return {
    canvasPerfEnabled: options.includes('--canvas-perf'),
    startupPerfEnabled: options.includes('--startup-perf')
  };
}
