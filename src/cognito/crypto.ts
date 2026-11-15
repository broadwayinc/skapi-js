/**
 * Byte helpers for the Cognito client: SHA-256, HMAC-SHA256, secure random bytes, and the
 * hex / base64 / UTF-8 conversions the SRP sign-in needs.
 *
 * Everything here is synchronous and pure JavaScript on purpose. The sign-in must work where
 * crypto.subtle does not exist (a page served over plain http has crypto.getRandomValues but no
 * crypto.subtle), exactly as amazon-cognito-identity-js did with its own SHA-256 implementation.
 */

import { loadNodeModule } from '../polyfills/global';

// ---- SHA-256 (FIPS 180-4) ----------------------------------------------------------------------

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export function sha256(data: Uint8Array): Uint8Array {
    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);

    // Padding: 0x80, zeros, then the message length in bits as a 64-bit big-endian integer.
    const bitLength = data.length * 8;
    const paddedLength = Math.ceil((data.length + 9) / 64) * 64;
    const block = new Uint8Array(paddedLength);
    block.set(data);
    block[data.length] = 0x80;
    const view = new DataView(block.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(paddedLength - 4, bitLength >>> 0);

    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let i = 0; i < 16; i++) {
            w[i] = view.getUint32(offset + i * 4);
        }
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15], b = w[i - 2];
            const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
            const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }

        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0;
            d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) {
        outView.setUint32(i * 4, h[i]);
    }
    return out;
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
    let k = key.length > 64 ? sha256(key) : key;
    const padded = new Uint8Array(64);
    padded.set(k);
    const inner = new Uint8Array(64 + data.length);
    const outer = new Uint8Array(64 + 32);
    for (let i = 0; i < 64; i++) {
        inner[i] = padded[i] ^ 0x36;
        outer[i] = padded[i] ^ 0x5c;
    }
    inner.set(data, 64);
    outer.set(sha256(inner), 64);
    return sha256(outer);
}

// ---- Secure random bytes -------------------------------------------------------------------------

/**
 * CSPRNG bytes from crypto.getRandomValues, which exists in every browser (on http pages too) and
 * in Node 19+; Node 18 falls back to node:crypto. Never Math.random.
 */
export function randomBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    const g: any = typeof globalThis !== 'undefined' ? globalThis : undefined;

    if (g?.crypto && typeof g.crypto.getRandomValues === 'function') {
        g.crypto.getRandomValues(out);
        return out;
    }

    const nodeCrypto = loadNodeModule('crypto');
    if (nodeCrypto?.webcrypto && typeof nodeCrypto.webcrypto.getRandomValues === 'function') {
        nodeCrypto.webcrypto.getRandomValues(out);
        return out;
    }
    if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') {
        out.set(nodeCrypto.randomBytes(n));
        return out;
    }

    throw new Error('Native crypto module could not be used to get secure random number.');
}

// ---- Encodings -----------------------------------------------------------------------------------

export function utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

export function bytesToHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

/** Hex to bytes, read two characters at a time like Buffer.from(hex, 'hex'). */
export function hexToBytes(hex: string): Uint8Array {
    const length = Math.floor(hex.length / 2);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        const byte = parseInt(hex.substr(i * 2, 2), 16);
        if (Number.isNaN(byte)) {
            // Buffer.from stops at the first pair that is not hex.
            return out.subarray(0, i);
        }
        out[i] = byte;
    }
    return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
        const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
        out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
        out += i + 2 < bytes.length ? B64[n & 63] : '=';
    }
    return out;
}

/**
 * Base64 to bytes the way Node's Buffer.from(text, 'base64') reads it: the standard and the URL-safe
 * alphabets both, padding optional, and any other character skipped.
 */
export function base64ToBytes(text: string): Uint8Array {
    const values: number[] = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '=') break;
        let v = B64.indexOf(ch);
        if (v === -1) {
            if (ch === '-') v = 62;
            else if (ch === '_') v = 63;
            else continue;
        }
        values.push(v);
    }
    const out = new Uint8Array(Math.floor(values.length * 6 / 8));
    let buffer = 0, bits = 0, index = 0;
    for (const v of values) {
        buffer = (buffer << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[index++] = (buffer >> bits) & 0xff;
        }
    }
    return out;
}

export function bytesToUtf8(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}
