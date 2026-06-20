import type { PhotoshopSelectionSnapshot } from './adapter';

export interface SelectionCard {
  id: string;
  label: string;
  count: number;
  draggable: boolean;
}

export const selectionDragPayloadMimeType = 'application/x-debrute-photoshop-selection';

interface SelectionDragPayload {
  kind: 'photoshop-selection-card';
  id: string;
}

export function selectionCardsFromSnapshot(snapshot: PhotoshopSelectionSnapshot): SelectionCard[] {
  if (!snapshot.documentTitle || snapshot.selectedItems.length === 0) {
    return [];
  }
  if (snapshot.selectedItems.length === 1) {
    const item = snapshot.selectedItems[0]!;
    return [{ id: `layer:${item.layerId}`, label: item.name, count: 1, draggable: true }];
  }
  return [{
    id: 'batch',
    label: `${snapshot.selectedItems.length} selected items`,
    count: snapshot.selectedItems.length,
    draggable: true
  }];
}

export function selectionDragPayloadFromCard(card: SelectionCard): string {
  const payload: SelectionDragPayload = { kind: 'photoshop-selection-card', id: card.id };
  return JSON.stringify(payload);
}

export function selectionCardIdFromDragPayload(raw: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const payload = JSON.parse(raw) as Partial<SelectionDragPayload>;
    return payload.kind === 'photoshop-selection-card' && typeof payload.id === 'string' && payload.id.length > 0
      ? payload.id
      : undefined;
  } catch {
    return undefined;
  }
}
