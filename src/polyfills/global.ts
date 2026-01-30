// Platform-aware global polyfill
if (typeof window !== 'undefined') {
    (window as any).global = window;
} else if (typeof globalThis !== 'undefined') {
    (globalThis as any).global = globalThis;
}