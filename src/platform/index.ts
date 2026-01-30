/**
 * Platform abstraction layer for skapi-js
 * Provides unified interfaces for browser and Node.js environments
 */

// Environment detection
export const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
export const isNode = typeof process !== 'undefined' && process.versions?.node !== undefined;

// Re-export platform-specific types
export * from './types';

// Platform utilities - these work in both environments
export function getUserAgent(): string {
    if (isBrowser) {
        return typeof navigator !== 'undefined' ? navigator.userAgent : 'skapi-browser';
    }
    return `skapi-node/${process.versions.node}`;
}

export function getBaseUrl(): string | null {
    if (isBrowser && typeof window !== 'undefined') {
        return window.location.origin;
    }
    return null; // Node.js doesn't have a base URL concept
}

export function isSecureContext(): boolean {
    if (isBrowser) {
        return window.location.protocol === 'https:' || window.location.hostname === 'localhost';
    }
    // Node.js is always considered secure (server-side)
    return true;
}