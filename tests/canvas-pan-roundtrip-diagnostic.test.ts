import { describe, expect, it } from 'vitest';
import {
  dispatchCanvasWheelSequence,
  parseCliArgs,
  startCanvasPanRoundTripCapture,
  summarizePanRoundTripResult
} from '../scripts/canvas-pan-roundtrip-diagnostic.mjs';

type PanRoundTripDiagnosticImage = {
  path: string;
  src: string;
  width: number;
  complete: boolean;
  naturalWidth: number;
  display: string;
};

type PanRoundTripDiagnosticResult = {
  targetUrl: string;
  distance: number;
  snapshots: PanRoundTripDiagnosticSnapshot[];
  motionSamples: PanRoundTripDiagnosticSnapshot[];
  networkRequests: Array<{
    phase: string;
    path: string;
    src: string;
    width: number;
    status?: number;
    fromDiskCache?: boolean;
    encodedDataLength?: number;
    failed?: string;
  }>;
  finalCounterTotals: Record<string, number>;
};

type PanRoundTripDiagnosticSnapshot = {
  label: string;
  camera: { x: number; y: number; z: number } | null;
  imageLayers: {
    visible: number;
    next: number;
    previewSources: number;
    rawSources: number;
  };
  visibleImages: PanRoundTripDiagnosticImage[];
  nextImages?: PanRoundTripDiagnosticImage[];
  visibleImageNodePaths: string[];
  blankVisibleImageNodePaths: string[];
  nextOnlyImageNodePaths: string[];
  resourceCount: number;
};

describe('canvas pan round-trip diagnostic summary', () => {
  it('passes when pan back restores the same visible image layer without requests', () => {
    const result = diagnosticResult({
      beforeImages: [image('flow/a.png', '/preview/a.png?w=512')],
      backImages: [image('flow/a.png', '/preview/a.png?w=512')],
      backBlankPaths: [],
      backNextOnlyPaths: [],
      requests: []
    });

    expect(summarizePanRoundTripResult(result)).toMatchObject({
      passed: true,
      sameVisibleImagesAfterBack: true,
      requestsForBeforeVisibleImages: [],
      blankVisibleImageNodesAfterBack: [],
      nextOnlyImageNodesAfterBack: []
    });
  });

  it('flags the exact pan-back blank and reload symptoms', () => {
    const result = diagnosticResult({
      beforeImages: [image('flow/a.png', '/preview/a.png?w=512')],
      backImages: [],
      backBlankPaths: ['flow/a.png'],
      backNextOnlyPaths: ['flow/a.png'],
      samples: [],
      requests: [{
        phase: 'pan-back',
        path: 'flow/a.png',
        src: '/preview/a.png?w=512',
        width: 512,
        status: 200,
        fromDiskCache: false,
        encodedDataLength: 1024
      }]
    });

    expect(summarizePanRoundTripResult(result)).toMatchObject({
      passed: false,
      sameVisibleImagesAfterBack: false,
      requestsForBeforeVisibleImages: [{
        phase: 'pan-back',
        path: 'flow/a.png',
        width: 512,
        status: 200
      }],
      blankVisibleImageNodesAfterBack: ['flow/a.png'],
      nextOnlyImageNodesAfterBack: ['flow/a.png']
    });
  });

  it('flags blank image nodes that appear during sliding even when the final pan-back state is clean', () => {
    const result = diagnosticResult({
      beforeImages: [image('flow/a.png', '/preview/a.png?w=512')],
      backImages: [image('flow/a.png', '/preview/a.png?w=512')],
      backBlankPaths: [],
      backNextOnlyPaths: [],
      samples: [{
        label: 'pan-away-step-2',
        camera: { x: 0, y: -600, z: 1 },
        imageLayers: { visible: 1, next: 1, previewSources: 2, rawSources: 0 },
        visibleImages: [image('flow/a.png', '/preview/a.png?w=512')],
        visibleImageNodePaths: ['flow/a.png', 'flow/b.png'],
        blankVisibleImageNodePaths: ['flow/b.png'],
        nextOnlyImageNodePaths: ['flow/b.png'],
        resourceCount: 1
      }],
      requests: []
    });

    expect(summarizePanRoundTripResult(result)).toMatchObject({
      passed: false,
      blankVisibleImageNodesDuringMotion: [{
        label: 'pan-away-step-2',
        paths: ['flow/b.png']
      }],
      nextOnlyImageNodesDuringMotion: [{
        label: 'pan-away-step-2',
        paths: ['flow/b.png']
      }]
    });
  });

  it('does not treat a complete next-only image as visually blank', () => {
    const result = diagnosticResult({
      beforeImages: [image('flow/a.png', '/preview/a.png?w=512')],
      backImages: [image('flow/a.png', '/preview/a.png?w=512')],
      backBlankPaths: [],
      backNextOnlyPaths: ['flow/b.png'],
      samples: [{
        label: 'pan-away-step-2',
        camera: { x: 0, y: -600, z: 1 },
        imageLayers: { visible: 1, next: 1, previewSources: 2, rawSources: 0 },
        visibleImages: [image('flow/a.png', '/preview/a.png?w=512')],
        nextImages: [image('flow/b.png', '/preview/b.png?w=512')],
        visibleImageNodePaths: ['flow/a.png', 'flow/b.png'],
        blankVisibleImageNodePaths: [],
        nextOnlyImageNodePaths: ['flow/b.png'],
        resourceCount: 1
      }],
      requests: []
    });

    expect(summarizePanRoundTripResult(result)).toMatchObject({
      passed: true,
      blankVisibleImageNodesDuringMotion: [],
      nextOnlyImageNodesDuringMotion: [{
        label: 'pan-away-step-2',
        paths: ['flow/b.png']
      }]
    });
  });
});

describe('canvas pan round-trip diagnostic CLI args', () => {
  it('parses target, CDP endpoint, distance, and settle time', () => {
    expect(parseCliArgs([
      '--target-url', 'http://127.0.0.1:17322/projects/project-id',
      '--cdp-url', 'http://127.0.0.1:9333',
      '--distance', '900',
      '--settle-ms', '1200',
      '--initial-settle-ms', '2400',
      '--steps', '6',
      '--step-settle-ms', '48',
      '--input-mode', 'dom'
    ])).toEqual({
      targetUrl: 'http://127.0.0.1:17322/projects/project-id',
      cdpUrl: 'http://127.0.0.1:9333',
      distance: 900,
      settleMs: 1200,
      initialSettleMs: 2400,
      steps: 6,
      stepSettleMs: 48,
      inputMode: 'dom'
    });
  });

  it('rejects invalid numeric options before connecting to Chrome', () => {
    expect(() => parseCliArgs(['--distance', '0'])).toThrow('--distance must be a positive number.');
    expect(() => parseCliArgs(['--initial-settle-ms', '0'])).toThrow('--initial-settle-ms must be a positive number.');
    expect(() => parseCliArgs(['--steps', '0'])).toThrow('--steps must be a positive integer.');
    expect(() => parseCliArgs(['--input-mode', 'native'])).toThrow('--input-mode must be one of: cdp, dom.');
  });

  it('ignores the pnpm argument separator', () => {
    expect(parseCliArgs(['--', '--help'])).toMatchObject({ help: true });
  });

  it('parses summary-only output mode', () => {
    expect(parseCliArgs(['--summary-only'])).toMatchObject({ summaryOnly: true });
  });
});

describe('canvas pan round-trip diagnostic capture setup', () => {
  it('propagates stopCapture failures before starting a fresh capture', async () => {
    const client = {
      evaluate: async (expression: string) => {
        const window = {
          __debruteCanvasPerf: {
            stopCapture: () => {
              throw new Error('stop failed');
            },
            startCapture: () => {
              throw new Error('startCapture should not run');
            }
          }
        };
        const performance = {
          clearResourceTimings: () => undefined
        };
        return Function('window', 'performance', `return ${expression};`)(window, performance);
      }
    };

    await expect(startCanvasPanRoundTripCapture(client)).rejects.toThrow('stop failed');
  });
});

describe('canvas pan round-trip diagnostic input dispatch', () => {
  it('sends wheel input through CDP instead of waiting inside the page main thread', async () => {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = {
      send: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        return method === 'Runtime.evaluate'
          ? { result: { value: { x: 100, y: 200 } } }
          : {};
      },
      evaluate: async () => {
        throw new Error('dispatch should not evaluate in the page context');
      }
    };

    await dispatchCanvasWheelSequence({
      client,
      labelPrefix: 'pan-away',
      distance: 120,
      steps: 2,
      stepSettleMs: 1,
      setPhase: () => undefined,
      captureSnapshot: async (label: string) => ({
        label,
        camera: null,
        imageLayers: { visible: 0, next: 0, previewSources: 0, rawSources: 0 },
        visibleImages: [],
        visibleImageNodePaths: [],
        blankVisibleImageNodePaths: [],
        nextOnlyImageNodePaths: [],
        resourceCount: 0
      })
    });

    expect(sent.map((item) => item.method)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Input.dispatchMouseEvent'
    ]);
    expect(sent[1]?.params).toMatchObject({
      type: 'mouseWheel',
      deltaY: 60
    });
  });

  it('can dispatch wheel input through a DOM event when CDP input is unreliable', async () => {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = {
      send: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        return {};
      },
      evaluate: async (expression: string) => {
        sent.push({ method: 'Runtime.evaluate-wrapper', params: { expression } });
        return {};
      }
    };

    await dispatchCanvasWheelSequence({
      client,
      labelPrefix: 'pan-away',
      distance: 120,
      steps: 1,
      stepSettleMs: 1,
      inputMode: 'dom',
      setPhase: () => undefined,
      captureSnapshot: async (label: string) => ({
        label,
        camera: null,
        imageLayers: { visible: 0, next: 0, previewSources: 0, rawSources: 0 },
        visibleImages: [],
        visibleImageNodePaths: [],
        blankVisibleImageNodePaths: [],
        nextOnlyImageNodePaths: [],
        resourceCount: 0
      })
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('Runtime.evaluate-wrapper');
    expect(String(sent[0]?.params.expression)).toContain('new WheelEvent');
  });
});

function diagnosticResult(input: {
  beforeImages: PanRoundTripDiagnosticResult['snapshots'][number]['visibleImages'];
  backImages: PanRoundTripDiagnosticResult['snapshots'][number]['visibleImages'];
  backBlankPaths: string[];
  backNextOnlyPaths: string[];
  samples?: PanRoundTripDiagnosticResult['motionSamples'];
  requests: PanRoundTripDiagnosticResult['networkRequests'];
}): PanRoundTripDiagnosticResult {
  return {
    targetUrl: 'http://127.0.0.1:17322/projects/project-id',
    distance: 1500,
    snapshots: [{
      label: 'before-pan',
      camera: { x: 0, y: 0, z: 1 },
      imageLayers: { visible: input.beforeImages.length, next: 0, previewSources: input.beforeImages.length, rawSources: 0 },
      visibleImages: input.beforeImages,
      visibleImageNodePaths: input.beforeImages.map((item) => item.path),
      blankVisibleImageNodePaths: [],
      nextOnlyImageNodePaths: [],
      resourceCount: 0
    }, {
      label: 'after-pan-away',
      camera: { x: 0, y: -1500, z: 1 },
      imageLayers: { visible: 0, next: 0, previewSources: 0, rawSources: 0 },
      visibleImages: [],
      visibleImageNodePaths: [],
      blankVisibleImageNodePaths: [],
      nextOnlyImageNodePaths: [],
      resourceCount: 0
    }, {
      label: 'after-pan-back',
      camera: { x: 0, y: 0, z: 1 },
      imageLayers: { visible: input.backImages.length, next: input.backNextOnlyPaths.length, previewSources: input.backImages.length + input.backNextOnlyPaths.length, rawSources: 0 },
      visibleImages: input.backImages,
      visibleImageNodePaths: [...new Set([...input.backImages.map((item) => item.path), ...input.backBlankPaths])],
      blankVisibleImageNodePaths: input.backBlankPaths,
      nextOnlyImageNodePaths: input.backNextOnlyPaths,
      resourceCount: input.requests.length
    }],
    motionSamples: input.samples ?? [],
    networkRequests: input.requests,
    finalCounterTotals: {}
  };
}

function image(path: string, src: string): PanRoundTripDiagnosticResult['snapshots'][number]['visibleImages'][number] {
  return {
    path,
    src,
    width: Number(new URL(src, 'http://127.0.0.1').searchParams.get('w')),
    complete: true,
    naturalWidth: Number(new URL(src, 'http://127.0.0.1').searchParams.get('w')),
    display: 'block'
  };
}
