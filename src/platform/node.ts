/**
 * Node.js-specific platform implementations
 * Requires Node.js 18+ for native fetch support
 */

import type {
    HttpRequestOptions,
    HttpResponse,
    PlatformStorage,
    PlatformCapabilities
} from './types';

// ============================================================================
// Environment Info
// ============================================================================

export const platformName = 'node' as const;

export const capabilities: PlatformCapabilities = {
    hasFetch: typeof globalThis.fetch !== 'undefined', // Node 18+
    hasFormData: typeof globalThis.FormData !== 'undefined', // Node 18+
    hasBlob: typeof globalThis.Blob !== 'undefined', // Node 18+
    hasFile: typeof globalThis.File !== 'undefined', // Node 20+
    hasFileReader: false, // Not available in Node.js, use Buffer instead
    hasCrypto: true // Node.js crypto module
};

// ============================================================================
// Fetch / HTTP
// ============================================================================

// Use native fetch (Node.js 18+)
export const nativeFetch = globalThis.fetch;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export const Headers = globalThis.Headers;

export async function httpRequest<T = unknown>(
    url: string,
    options: HttpRequestOptions = {}
): Promise<HttpResponse<T>> {
    const {
        method = 'GET',
        headers = {},
        body,
        timeout,
        onUploadProgress,
        onDownloadProgress,
        signal
    } = options;

    const controller = new AbortController();
    const timeoutId = timeout ? setTimeout(() => controller.abort(), timeout) : null;

    try {
        const fetchOptions: RequestInit = {
            method,
            headers: { ...headers },
            signal: signal || controller.signal
        };

        let requestBody: BodyInit | undefined;

        if (body) {
            if (body instanceof FormData || body instanceof globalThis.FormData) {
                requestBody = body as FormData;
            } else if (typeof body === 'string') {
                requestBody = body;
            } else if (Buffer.isBuffer(body)) {
                requestBody = new Uint8Array(body);
            } else {
                requestBody = JSON.stringify(body);
                if (!headers['Content-Type']) {
                    (fetchOptions.headers as Record<string, string>)['Content-Type'] = 'application/json';
                }
            }
            fetchOptions.body = requestBody;
        }

        // Note: Native fetch doesn't support upload progress
        if (onUploadProgress) {
            console.warn('Upload progress is not supported with native fetch in Node.js.');
        }

        const response = await fetch(url, fetchOptions);
        
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
        });

        let data: T;
        const contentType = response.headers.get('content-type') || '';
        
        if (onDownloadProgress && response.body) {
            // Handle download progress using ReadableStream
            const reader = response.body.getReader();
            const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
            let receivedLength = 0;
            const chunks: Uint8Array[] = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                chunks.push(value);
                receivedLength += value.length;
                
                onDownloadProgress({
                    loaded: receivedLength,
                    total: contentLength,
                    lengthComputable: contentLength > 0
                });
            }

            const allChunks = new Uint8Array(receivedLength);
            let position = 0;
            for (const chunk of chunks) {
                allChunks.set(chunk, position);
                position += chunk.length;
            }

            const text = new TextDecoder().decode(allChunks);
            if (contentType.includes('application/json')) {
                data = JSON.parse(text);
            } else {
                data = text as unknown as T;
            }
        } else {
            if (contentType.includes('application/json')) {
                data = await response.json();
            } else {
                data = await response.text() as unknown as T;
            }
        }

        return {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            data,
            ok: response.ok
        };
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

// ============================================================================
// FormData
// ============================================================================

// Use native FormData (Node.js 18+)
export const NativeFormData = globalThis.FormData;

export function createFormData(): FormData {
    return new globalThis.FormData();
}

export function appendToFormData(
    formData: FormData,
    key: string,
    value: string | Blob | Buffer,
    filename?: string
): void {
    if (Buffer.isBuffer(value)) {
        // Convert Buffer to Blob for FormData
        const blob = new Blob([new Uint8Array(value)]);
        formData.append(key, blob, filename);
    } else if (filename && value instanceof Blob) {
        formData.append(key, value, filename);
    } else {
        formData.append(key, value as string);
    }
}

// ============================================================================
// File / Blob
// ============================================================================

// Use native Blob (Node.js 18+)
export const NativeBlob = globalThis.Blob;
// File is available in Node.js 20+, provide fallback
export const NativeFile = globalThis.File || class NodeFile extends Blob {
    name: string;
    lastModified: number;
    webkitRelativePath: string = '';
    
    constructor(fileBits: BlobPart[], fileName: string, options?: FilePropertyBag) {
        super(fileBits, options);
        this.name = fileName;
        this.lastModified = options?.lastModified ?? Date.now();
    }
};

export function createBlob(data: BlobPart[], options?: BlobPropertyBag): Blob {
    return new Blob(data, options);
}

export function createFile(data: BlobPart[], name: string, options?: FilePropertyBag): File {
    return new NativeFile(data, name, options);
}

export function getByteLength(data: string | Blob | Buffer | ArrayBuffer): number {
    if (typeof data === 'string') {
        return Buffer.byteLength(data, 'utf8');
    }
    if (Buffer.isBuffer(data)) {
        return data.length;
    }
    if (data instanceof Blob) {
        return data.size;
    }
    if (data instanceof ArrayBuffer) {
        return data.byteLength;
    }
    return 0;
}

export async function blobToBase64(blob: Blob): Promise<string> {
    const arrayBuffer = await blob.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
}

export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    return blob.arrayBuffer();
}

export async function blobToText(blob: Blob): Promise<string> {
    return blob.text();
}

// Node.js specific: Buffer utilities
export function bufferToBase64(buffer: Buffer): string {
    return buffer.toString('base64');
}

export function base64ToBuffer(base64: string): Buffer {
    return Buffer.from(base64, 'base64');
}

// ============================================================================
// Base64
// ============================================================================

export function base64Encode(str: string): string {
    return Buffer.from(str, 'utf8').toString('base64');
}

export function base64Decode(str: string): string {
    return Buffer.from(str, 'base64').toString('utf8');
}

export function base64EncodeBuffer(buffer: ArrayBuffer | Uint8Array | Buffer): string {
    if (Buffer.isBuffer(buffer)) {
        return buffer.toString('base64');
    }
    if (buffer instanceof ArrayBuffer) {
        return Buffer.from(new Uint8Array(buffer)).toString('base64');
    }
    return Buffer.from(buffer).toString('base64');
}

export function base64DecodeToBuffer(base64: string): Buffer {
    return Buffer.from(base64, 'base64');
}

// ============================================================================
// Storage (In-memory implementation for Node.js)
// ============================================================================

class MemoryStorage implements PlatformStorage {
    private store = new Map<string, string>();

    getItem(key: string): string | null {
        return this.store.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.store.set(key, value);
    }

    removeItem(key: string): void {
        this.store.delete(key);
    }

    clear(): void {
        this.store.clear();
    }

    keys(): string[] {
        return Array.from(this.store.keys());
    }
}

const sessionStorage = new MemoryStorage();
const localStorage = new MemoryStorage();

export function getSessionStorage(): PlatformStorage {
    return sessionStorage;
}

export function getLocalStorage(): PlatformStorage {
    return localStorage;
}

// ============================================================================
// Crypto
// ============================================================================

import * as nodeCrypto from 'crypto';

export function getRandomValues(array: Uint8Array): Uint8Array {
    return nodeCrypto.getRandomValues(array);
}

export function randomUUID(): string {
    return nodeCrypto.randomUUID();
}

// ============================================================================
// File System Utilities (Node.js specific)
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';

export function saveToFile(data: Buffer | string, filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, data);
}

export function readFromFile(filePath: string): Buffer {
    return fs.readFileSync(filePath);
}

export function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
}

// Alternative to browser's downloadBlob - returns buffer instead
export async function downloadBlob(blob: Blob, filename: string): Promise<{ buffer: Buffer; filename: string }> {
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return { buffer, filename };
}
