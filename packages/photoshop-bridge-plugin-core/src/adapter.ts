export interface ExportedSelectionPng {
  suggestedName: string;
  bytes: Uint8Array;
}

export interface PhotoshopSelectionSnapshot {
  documentTitle: string | null;
  documentCount: number;
  selectedItems: Array<{
    layerId: number;
    name: string;
    kind: 'layer' | 'group';
  }>;
}

export interface PhotoshopAdapter {
  hostVersion(): string;
  currentSelectionSnapshot(): PhotoshopSelectionSnapshot;
  exportSelectedTopLevelPngs(): Promise<ExportedSelectionPng[]>;
  placeFileAsSmartObject(input: { fileName: string; bytes: Uint8Array }): Promise<void>;
}
