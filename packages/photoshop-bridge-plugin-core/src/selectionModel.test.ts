import { describe, expect, it } from 'vitest';
import {
  selectionCardIdFromDragPayload,
  selectionCardsFromSnapshot,
  selectionDragPayloadFromCard,
  selectionDragPayloadMimeType
} from './selectionModel.js';

describe('selectionCardsFromSnapshot', () => {
  it('creates one draggable card for a single top-level layer and a batch card for multiple selections', () => {
    expect(selectionCardsFromSnapshot({
      documentTitle: 'poster.psd',
      documentCount: 1,
      selectedItems: [{ layerId: 7, name: 'Hero', kind: 'layer' }]
    })).toEqual([{ id: 'layer:7', label: 'Hero', count: 1, draggable: true }]);

    expect(selectionCardsFromSnapshot({
      documentTitle: 'poster.psd',
      documentCount: 1,
      selectedItems: [
        { layerId: 7, name: 'Hero', kind: 'layer' },
        { layerId: 9, name: 'Logo', kind: 'group' }
      ]
    })).toEqual([{ id: 'batch', label: '2 selected items', count: 2, draggable: true }]);
  });

  it('creates and validates selection-card drag payloads', () => {
    const [card] = selectionCardsFromSnapshot({
      documentTitle: 'poster.psd',
      documentCount: 1,
      selectedItems: [{ layerId: 7, name: 'Hero', kind: 'layer' }]
    });

    expect(selectionDragPayloadMimeType).toBe('application/x-debrute-photoshop-selection');
    expect(selectionDragPayloadFromCard(card!)).toBe('{"kind":"photoshop-selection-card","id":"layer:7"}');
    expect(selectionCardIdFromDragPayload('{"kind":"photoshop-selection-card","id":"layer:7"}')).toBe('layer:7');
    expect(selectionCardIdFromDragPayload('{"kind":"other","id":"layer:7"}')).toBeUndefined();
    expect(selectionCardIdFromDragPayload('')).toBeUndefined();
  });
});
