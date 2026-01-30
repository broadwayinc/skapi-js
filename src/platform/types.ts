/**
 * Platform-agnostic type definitions
 */

// File-like interface that works across platforms
export interface PlatformFile {
    name: string;
    size: number;
    type: string;
    lastModified?: number;
    // For browser: the actual File object
    // For Node.js: Buffer or readable stream
    data: File | Buffer | NodeJS.ReadableStream;
}

// Blob-like interface
export interface PlatformBlob {
    size: number;
    type: string;
    data: Blob | Buffer;
}

// FormData entry value type
export type FormDataEntryValue = string | PlatformFile;

// HTTP request options
export interface HttpRequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;
    body?: string | FormData | Buffer | Record<string, unknown>;
    timeout?: number;
    onUploadProgress?: (progress: ProgressEvent) => void;
    onDownloadProgress?: (progress: ProgressEvent) => void;
    signal?: AbortSignal;
}

// Progress event interface
export interface ProgressEvent {
    loaded: number;
    total: number;
    lengthComputable: boolean;
}

// HTTP response interface
export interface HttpResponse<T = unknown> {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    data: T;
    ok: boolean;
}

// Storage interface (for sessionStorage/localStorage abstraction)
export interface PlatformStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    clear(): void;
    keys(): string[];
}

// Platform capabilities
export interface PlatformCapabilities {
    hasFetch: boolean;
    hasFormData: boolean;
    hasBlob: boolean;
    hasFile: boolean;
    hasFileReader: boolean;
    hasCrypto: boolean;
}
