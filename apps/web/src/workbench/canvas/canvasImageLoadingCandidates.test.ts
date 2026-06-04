import { describe, expect, it } from 'vitest';
import {
  isCanvasImageLoadResultCurrent,
  selectCanvasImageLoadingCandidates,
  type CanvasImageLoadingPlanItem
} from './canvasImageLoading';

describe('canvas image loading candidates', () => {
  it('starts only viewport-empty work while the camera is moving', () => {
    const candidates = selectCanvasImageLoadingCandidates({
      plan: new Map([
        ['visible-empty', planItem('visible-empty', 0, 30)],
        ['visible-upgrade', planItem('visible-upgrade', 1, 10)],
        ['overscan-empty', planItem('overscan-empty', 2, 1)]
      ]),
      cameraState: 'moving',
      activeLoadKeys: new Set()
    });

    expect(candidates.map((item) => item.projectRelativePath)).toEqual(['visible-empty']);
  });

  it('sorts idle candidates by priority, distance, and path', () => {
    const candidates = selectCanvasImageLoadingCandidates({
      plan: new Map([
        ['b', planItem('b', 2, 1)],
        ['a', planItem('a', 2, 1)],
        ['upgrade', planItem('upgrade', 1, 500)],
        ['deferred', planItem('deferred', 4, 0)]
      ]),
      cameraState: 'idle',
      activeLoadKeys: new Set()
    });

    expect(candidates.map((item) => item.projectRelativePath)).toEqual(['upgrade', 'a', 'b']);
  });

  it('does not return already active load keys', () => {
    const candidates = selectCanvasImageLoadingCandidates({
      plan: new Map([
        ['a', planItem('a', 0, 1)],
        ['b', planItem('b', 0, 2)]
      ]),
      cameraState: 'idle',
      activeLoadKeys: new Set(['http://image/a:0'])
    });

    expect(candidates.map((item) => item.projectRelativePath)).toEqual(['b']);
  });

  it('rejects stale load results', () => {
    expect(isCanvasImageLoadResultCurrent({
      item: planItem('a', 0, 1, 'http://image/a:1')
    }, new Map([['a', planItem('a', 0, 1, 'http://image/a:1')]]))).toBe(true);

    expect(isCanvasImageLoadResultCurrent({
      item: planItem('a', 0, 1, 'http://image/a:1')
    }, new Map())).toBe(false);

    expect(isCanvasImageLoadResultCurrent({
      item: planItem('a', 0, 1, 'http://image/a:1')
    }, new Map([['a', planItem('a', 0, 1, 'http://image/a:2')]]))).toBe(false);
  });

});

function planItem(
  path: string,
  priority: CanvasImageLoadingPlanItem['priority'],
  distanceToVisibleCenter: number,
  loadKey = `http://image/${path}:0`
): CanvasImageLoadingPlanItem {
  return {
    projectRelativePath: path,
    src: loadKey.split(':').slice(0, -1).join(':'),
    loadKey,
    priority,
    distanceToVisibleCenter,
    eligible: true,
    reason: priority === 0 ? 'viewport-empty' : priority === 1 ? 'viewport-upgrade' : priority === 2 ? 'overscan-empty' : priority === 3 ? 'overscan-upgrade' : 'deferred'
  };
}
