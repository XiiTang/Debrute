import { describe, expect, it } from 'vitest';
import {
  isCanvasImageLoadResultCurrent,
  selectCanvasImageLoadingCandidates,
  type CanvasImageLoadingPlanItem
} from './canvasImageLoading';

describe('canvas image loading candidates', () => {
  it('starts display-critical and bounded prefetch-near work while moving', () => {
    const candidates = selectCanvasImageLoadingCandidates({
      plan: new Map([
        ['critical', planItem('critical', 'display-critical', 30)],
        ['prefetch-a', planItem('prefetch-a', 'prefetch-near', 1)],
        ['prefetch-b', planItem('prefetch-b', 'prefetch-near', 2)],
        ['upgrade', planItem('upgrade', 'upgrade-idle', 0)]
      ]),
      cameraState: 'moving',
      activeLoadKeys: new Set(),
      movingPrefetchLimit: 1
    });

    expect(candidates.map((item) => item.projectRelativePath)).toEqual(['critical', 'prefetch-a']);
  });

  it('sorts idle candidates by intent, distance, and path', () => {
    const candidates = selectCanvasImageLoadingCandidates({
      plan: new Map([
        ['b', planItem('b', 'prefetch-near', 1)],
        ['a', planItem('a', 'prefetch-near', 1)],
        ['upgrade', planItem('upgrade', 'upgrade-idle', 0)],
        ['critical', planItem('critical', 'display-critical', 500)],
        ['deferred', planItem('deferred', 'deferred', 0)]
      ]),
      cameraState: 'idle',
      activeLoadKeys: new Set()
    });

    expect(candidates.map((item) => item.projectRelativePath)).toEqual(['critical', 'a', 'b', 'upgrade']);
  });

  it('does not return already active load keys', () => {
    const candidates = selectCanvasImageLoadingCandidates({
      plan: new Map([
        ['a', planItem('a', 'display-critical', 1)],
        ['b', planItem('b', 'display-critical', 2)]
      ]),
      cameraState: 'idle',
      activeLoadKeys: new Set(['http://image/a:0'])
    });

    expect(candidates.map((item) => item.projectRelativePath)).toEqual(['b']);
  });

  it('rejects stale load results', () => {
    expect(isCanvasImageLoadResultCurrent({
      item: planItem('a', 'display-critical', 1, 'http://image/a:1')
    }, new Map([['a', planItem('a', 'display-critical', 1, 'http://image/a:1')]]))).toBe(true);

    expect(isCanvasImageLoadResultCurrent({
      item: planItem('a', 'display-critical', 1, 'http://image/a:1')
    }, new Map())).toBe(false);

    expect(isCanvasImageLoadResultCurrent({
      item: planItem('a', 'display-critical', 1, 'http://image/a:1')
    }, new Map([['a', planItem('a', 'display-critical', 1, 'http://image/a:2')]]))).toBe(false);
  });

});

function planItem(
  path: string,
  intent: CanvasImageLoadingPlanItem['intent'],
  distanceToVisibleCenter: number,
  loadKey = `http://image/${path}:0`,
  previewWidth = 256
): CanvasImageLoadingPlanItem {
  return {
    projectRelativePath: path,
    src: loadKey.split(':').slice(0, -1).join(':'),
    loadKey,
    previewWidth,
    intent,
    distanceToVisibleCenter,
    eligible: true
  };
}
