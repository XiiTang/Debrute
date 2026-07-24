import { afterAll, afterEach } from 'vitest';

const globalWithActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
  globalWithActEnvironment,
  'IS_REACT_ACT_ENVIRONMENT'
);
const rangeGetBoundingClientRectDescriptor = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getBoundingClientRect'
);
const rangeGetClientRectsDescriptor = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getClientRects'
);
const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
const matchMediaDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');

globalWithActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => new DOMRect()
});
Object.defineProperty(Range.prototype, 'getClientRects', {
  configurable: true,
  value: () => Object.assign([], { item: () => null }) as unknown as DOMRectList
});
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
});
Object.defineProperty(globalThis, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  })
});

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(() => {
  restoreDescriptor(Range.prototype, 'getBoundingClientRect', rangeGetBoundingClientRectDescriptor);
  restoreDescriptor(Range.prototype, 'getClientRects', rangeGetClientRectsDescriptor);
  restoreDescriptor(globalThis, 'ResizeObserver', resizeObserverDescriptor);
  restoreDescriptor(globalThis, 'matchMedia', matchMediaDescriptor);
  restoreDescriptor(globalWithActEnvironment, 'IS_REACT_ACT_ENVIRONMENT', actEnvironmentDescriptor);
});

function restoreDescriptor(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
  } else {
    Reflect.deleteProperty(target, property);
  }
}
