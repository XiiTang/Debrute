export function canvasPerfDiagnosticsEnabled(input: {
  development: boolean;
  startupEnabled: boolean;
}): boolean {
  return input.development && input.startupEnabled;
}
