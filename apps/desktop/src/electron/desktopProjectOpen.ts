export async function dispatchDesktopProjectOpen<Window>(input: {
  projectRoot: string;
  preferredWindow?: Window | undefined;
  isLiveWindow(window: Window): boolean;
  singleLiveWindow(): Window | undefined;
  openWindow(initialProjectRoot: string): Promise<unknown>;
  send(window: Window, projectRoot: string): void;
}): Promise<void> {
  if (input.preferredWindow !== undefined) {
    if (input.isLiveWindow(input.preferredWindow)) {
      input.send(input.preferredWindow, input.projectRoot);
    }
    return;
  }
  const target = input.singleLiveWindow();
  if (target !== undefined) {
    input.send(target, input.projectRoot);
    return;
  }
  await input.openWindow(input.projectRoot);
}
