import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (!globalThis.CSS) {
  globalThis.CSS = {} as typeof CSS;
}

if (!globalThis.CSS.supports) {
  globalThis.CSS.supports = () => false;
}
