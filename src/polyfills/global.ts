// Platform-aware global polyfill
if (typeof window !== 'undefined') {
    (window as any).global = window;
} else if (typeof global !== 'undefined') {
    // Already available in Node.js
    (global as any).global = global;
}