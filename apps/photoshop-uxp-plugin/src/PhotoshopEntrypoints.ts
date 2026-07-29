import type { PhotoshopPanelView } from './PhotoshopPanelView.js';
import type { PhotoshopPluginRuntime } from './PhotoshopPluginRuntime.js';

export const PHOTOSHOP_PANEL_ID = 'debrutePhotoshopPanel';

interface PhotoshopEntrypointsPort {
  setup(registration: {
    plugin: {
      create(): void;
      destroy(): void;
    };
    panels: Record<string, {
      show(event?: { node?: { appendChild(child: HTMLElement): unknown } }): void;
      destroy(): void;
    }>;
  }): void;
}

interface PhotoshopRuntimeLifecyclePort {
  start(): void;
  stop(): void;
}

interface PhotoshopPanelLifecyclePort {
  attach(): void;
  detach(): void;
}

export function installPhotoshopEntrypoints(input: {
  entrypoints: PhotoshopEntrypointsPort;
  runtime: PhotoshopRuntimeLifecyclePort;
  view: PhotoshopPanelLifecyclePort;
  root: HTMLElement;
}): void {
  input.entrypoints.setup({
    plugin: {
      create() {
        input.runtime.start();
      },
      destroy() {
        input.view.detach();
        input.runtime.stop();
      }
    },
    panels: {
      [PHOTOSHOP_PANEL_ID]: {
        show(event) {
          event?.node?.appendChild(input.root);
          input.view.attach();
        },
        destroy() {
          input.view.detach();
        }
      }
    }
  });
}

export type PhotoshopEntrypoints = PhotoshopEntrypointsPort;
export type PhotoshopPanelViewLifecycle = Pick<PhotoshopPanelView, 'attach' | 'detach'>;
export type PhotoshopPluginRuntimeLifecycle = Pick<PhotoshopPluginRuntime, 'start' | 'stop'>;
