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

globalWithActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => new DOMRect()
});
Object.defineProperty(Range.prototype, 'getClientRects', {
  configurable: true,
  value: () => Object.assign([], { item: () => null }) as unknown as DOMRectList
});

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(() => {
  restoreDescriptor(Range.prototype, 'getBoundingClientRect', rangeGetBoundingClientRectDescriptor);
  restoreDescriptor(Range.prototype, 'getClientRects', rangeGetClientRectsDescriptor);
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
