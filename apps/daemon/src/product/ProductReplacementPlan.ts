export interface ProductReplacementPlan {
  currentVersion: string;
  updateVersion: string;
  platform: NodeJS.Platform;
  desktopInstallPath: string;
  downloadedAssetPath: string;
  desktopPid?: number;
  runtimePid: number;
  relaunchDesktop: boolean;
}
