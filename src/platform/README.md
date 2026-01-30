# Platform Abstraction Layer

This directory contains the platform abstraction layer for skapi-js, enabling the library to run in both browser and Node.js environments.

## Structure

```
platform/
├── index.ts           # Main entry point with environment detection
├── types.ts           # Shared type definitions
├── browser.ts         # Browser-specific implementations
├── node.ts            # Node.js-specific implementations
└── runtime.ts         # Runtime platform (aliased by webpack)
```

## Usage

### Environment Detection

```typescript
import { isBrowser, isNode, getUserAgent } from './platform';

if (isBrowser) {
    console.log('Running in browser');
} else if (isNode) {
    console.log('Running in Node.js');
}
```

### Platform-Specific Imports

```typescript
// Import the runtime platform (webpack handles aliasing)
import * as platform from './platform/runtime';

// Use unified APIs
const response = await platform.httpRequest('https://api.example.com', {
    method: 'POST',
    body: { key: 'value' }
});
```

## API Reference

### HTTP Requests

```typescript
httpRequest<T>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>>
```

Options:
- `method`: GET, POST, PUT, DELETE, PATCH
- `headers`: Record<string, string>
- `body`: string | FormData | Buffer | object
- `timeout`: number (milliseconds)
- `onUploadProgress`: (progress: ProgressEvent) => void
- `onDownloadProgress`: (progress: ProgressEvent) => void
- `signal`: AbortSignal

### File/Blob Operations

| Function | Description |
|----------|-------------|
| `createBlob(data, options)` | Create a Blob |
| `createFile(data, name, options)` | Create a File |
| `getByteLength(data)` | Get byte size of string/Blob/Buffer |
| `blobToBase64(blob)` | Convert Blob to base64 |
| `blobToArrayBuffer(blob)` | Convert Blob to ArrayBuffer |
| `blobToText(blob)` | Convert Blob to text |

### Base64

| Function | Description |
|----------|-------------|
| `base64Encode(str)` | Encode string to base64 |
| `base64Decode(str)` | Decode base64 to string |
| `base64EncodeBuffer(buffer)` | Encode binary to base64 |
| `base64DecodeToBuffer(base64)` | Decode base64 to binary |

### Storage

```typescript
const session = getSessionStorage();
const local = getLocalStorage();

session.setItem('key', 'value');
session.getItem('key');
session.removeItem('key');
session.clear();
```

**Note:** In Node.js, storage is in-memory and not persistent across restarts.

### Crypto

```typescript
getRandomValues(array: Uint8Array): Uint8Array
randomUUID(): string
```

### Node.js Specific

```typescript
// File system operations (Node.js only)
saveToFile(data: Buffer | string, filePath: string): void
readFromFile(filePath: string): Buffer
fileExists(filePath: string): boolean

// Buffer utilities
bufferToBase64(buffer: Buffer): string
base64ToBuffer(base64: string): Buffer

// Download returns buffer instead of triggering browser download
const result = await downloadBlob(blob, 'file.txt');
// result.buffer: Buffer
// result.filename: string
```

## Node.js Version Requirements

- Minimum: Node.js 18 (for native fetch and FormData)
- Recommended: Node.js 20+ (for native File API)
