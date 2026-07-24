import type {
  ExportedSelectionPng,
  PhotoshopAdapter,
  PhotoshopSelectionSnapshot
} from '@debrute/photoshop-bridge-plugin-core';
import { createBrowserCepHost, type CepHost } from './cepHost';

interface CepExportedPng {
  suggestedName: string;
  path: string;
}

export type CepPhotoshopAdapter = PhotoshopAdapter;

export function createCepPhotoshopAdapter(input: {
  host?: CepHost;
} = {}): CepPhotoshopAdapter {
  const host = input.host ?? createBrowserCepHost();
  let hostVersionValue = 'CEP';

  return {
    hostVersion() {
      return hostVersionValue;
    },
    async selectionSnapshot() {
      hostVersionValue = await host.evalJson<string>('debruteBridge.hostVersion()');
      return host.evalJson<PhotoshopSelectionSnapshot>('debruteBridge.currentSelectionSnapshot()');
    },
    async exportSelectedTopLevelPngs(): Promise<ExportedSelectionPng[]> {
      const exports = await host.evalJson<CepExportedPng[]>('debruteBridge.exportSelectedTopLevelPngs()');
      return exports.map((entry) => ({
        suggestedName: entry.suggestedName,
        bytes: host.readFileBytes(entry.path)
      }));
    },
    async placeFileAsSmartObject(input) {
      const path = await host.evalJson<string>(`debruteBridge.temporaryImportPath(${JSON.stringify(input.fileName)})`);
      host.writeFileBytes(path, input.bytes);
      await host.evalJson<boolean>(`debruteBridge.placeFileAsSmartObject(${JSON.stringify(path)})`);
      host.deleteFile(path);
    }
  };
}
