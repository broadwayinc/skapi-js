/**
 * Web Crypto primitives for skapi's client-side record encryption.
 *
 * This is the ONLY file in the SDK that touches WebCrypto directly. Every
 * feature-detection and encoding decision lives here exactly once, so the
 * feature module above it never has to think about runtime differences.
 *
 * Rules this file holds to, all of which are load-bearing for the security
 * claim and are easy to break by accident:
 *
 *  - No `this`, no network, no imports from src/methods/. Pure functions.
 *  - No subtle.wrapKey/unwrapKey ANYWHERE. wrapKey throws InvalidAccessError
 *    unless the key being wrapped is extractable:true, which would make every
 *    DEK and identity key in the process exportable by injected script. We
 *    encrypt raw bytes with plain encrypt/decrypt and re-import the result
 *    non-extractable instead.
 *  - Every key that lives longer than one function call is imported with
 *    extractable:false. Extractable private material exists transiently at
 *    exactly one place (generateIdentity) and is zeroized before return.
 *  - All binary crosses the wire as UNPADDED base64url.
 */

import SkapiError from '../main/error';
import { encodeUtf8, decodeUtf8, toUint8Array, concatBytes } from './utils';

/** Domain-separation prefix. Bump alongside the envelope version. */
export const ENC_V = 'skapi.enc.v1';

/** PBKDF2 iteration floor (OWASP guidance for PBKDF2-HMAC-SHA-256). */
export const PBKDF2_ITERATIONS = 600000;

/** AES-GCM nonce length. 96 bits is the only size the spec optimizes for. */
const IV_LEN = 12;

let _subtleCache: SubtleCrypto | null = null;
let _cryptoCache: Crypto | null = null;

function notSupported(): SkapiError {
    return new SkapiError(
        'Encryption requires Web Crypto, which needs a secure context (https, or localhost) in the browser, or Node 18 or newer. ' +
        'A page served over plain http has crypto.getRandomValues but crypto.subtle is undefined.',
        { code: 'NOT_SUPPORTED' }
    );
}

/**
 * Resolve the platform Crypto object.
 *
 * The ladder matters. In a browser on http:// (not localhost) globalThis.crypto
 * EXISTS but crypto.subtle is undefined, so testing for `crypto` alone is not
 * enough and never has been. On Node 18 globalThis.crypto was still behind a
 * flag in some builds, so we fall back to node:crypto's webcrypto export. The
 * require is lazy and inside the function so bundlers can alias it away for the
 * browser build without the module failing to load.
 */
function resolveCrypto(): Crypto {
    if (_cryptoCache) {
        return _cryptoCache;
    }

    let g: any = typeof globalThis !== 'undefined' ? globalThis : undefined;

    if (g?.crypto?.subtle && typeof g.crypto.getRandomValues === 'function') {
        _cryptoCache = g.crypto;
        return _cryptoCache;
    }

    // Node fallback. `process.getBuiltinModule` first: a bare require() becomes a
    // throwing shim in the ESM output, so this fallback used to evaporate for
    // anyone importing the package as ESM, and on a runtime with no global
    // WebCrypto that meant encryption reporting "not supported" instead of
    // falling back. Neither call is an import, so no browser bundle picks up a
    // dependency on node:crypto; a browser always has the global anyway and
    // never reaches this line.
    try {
        let g: any = typeof globalThis !== 'undefined' ? globalThis : undefined;
        let nodeCrypto: any = null;
        if (g?.process && typeof g.process.getBuiltinModule === 'function') {
            nodeCrypto = g.process.getBuiltinModule('crypto');
        }
        // eslint-disable-next-line
        if (!nodeCrypto && typeof require === 'function') {
            // eslint-disable-next-line
            nodeCrypto = require('node:crypto');
        }
        if (nodeCrypto?.webcrypto?.subtle) {
            _cryptoCache = nodeCrypto.webcrypto as Crypto;
            return _cryptoCache;
        }
    }
    catch (err) {
        // fall through to the throw below
    }

    throw notSupported();
}

export function getSubtle(): SubtleCrypto {
    if (_subtleCache) {
        return _subtleCache;
    }
    let c = resolveCrypto();
    if (!c.subtle) {
        throw notSupported();
    }
    _subtleCache = c.subtle;
    return _subtleCache;
}

/** True when this runtime can do record encryption at all. Never throws. */
export function cryptoAvailable(): boolean {
    try {
        getSubtle();
        return true;
    }
    catch (err) {
        return false;
    }
}

/**
 * CSPRNG bytes.
 *
 * Deliberately NOT utils.generateRandom(), which is Math.random based and is
 * only ever used for non-secret ids. Nothing in this file may use Math.random.
 */
export function getRandom(n: number): Uint8Array {
    let c = resolveCrypto();
    let out = new Uint8Array(n);

    // getRandomValues throws QuotaExceededError past 65536 bytes per call, in
    // both the browser and Node. Nothing here asks for more than 32 at a time
    // today, but a helper that silently explodes at 64KB is a landmine for the
    // next caller, so fill in chunks.
    const MAX = 65536;
    for (let i = 0; i < n; i += MAX) {
        c.getRandomValues(out.subarray(i, Math.min(i + MAX, n)));
    }

    return out;
}

export function randomUuid(): string {
    let c: any = resolveCrypto();
    if (typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }
    // RFC 4122 v4 from CSPRNG bytes, for targets without randomUUID.
    let b = getRandom(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------------------------------------------ *
 * base64url
 *
 * The one canonical pair for the SDK. Do NOT reuse toBase64Url from
 * src/polyfills/global.ts: despite its name it emits STANDARD base64
 * (it never substitutes -/_ nor strips padding), and its first line is a
 * bare `if (Buffer)` with no typeof guard, which throws ReferenceError in
 * a browser that has no Buffer shim.
 * ------------------------------------------------------------------ */

export function b64uFromBytes(input: Uint8Array | ArrayBuffer): string {
    let u8 = toUint8Array(input);

    let std: string;
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        std = Buffer.from(u8).toString('base64');
    }
    else if (typeof btoa === 'function') {
        // Chunked: String.fromCharCode.apply on a large array blows the stack.
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < u8.length; i += chunk) {
            binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
        }
        std = btoa(binary);
    }
    else {
        throw new SkapiError('No base64 encoder available in this environment.', { code: 'NOT_SUPPORTED' });
    }

    return std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uToBytes(input: string): Uint8Array {
    if (typeof input !== 'string') {
        throw new SkapiError('Expected a base64url string.', { code: 'INVALID_PARAMETER' });
    }

    let std = input.replace(/-/g, '+').replace(/_/g, '/');
    let pad = std.length % 4;
    if (pad === 2) {
        std += '==';
    }
    else if (pad === 3) {
        std += '=';
    }
    else if (pad === 1) {
        throw new SkapiError('Malformed base64url string.', { code: 'INVALID_PARAMETER' });
    }

    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        let buf = Buffer.from(std, 'base64');
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }

    if (typeof atob === 'function') {
        let binary = atob(std);
        let out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            out[i] = binary.charCodeAt(i);
        }
        return out;
    }

    throw new SkapiError('No base64 decoder available in this environment.', { code: 'NOT_SUPPORTED' });
}

/* ------------------------------------------------------------------ *
 * Hash / KDF
 * ------------------------------------------------------------------ */

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
    // `as BufferSource` because TS's lib.dom types for digest do not accept a
    // Uint8Array<ArrayBufferLike> union cleanly across our two tsconfig targets.
    let out = await getSubtle().digest('SHA-256', data as BufferSource);
    return new Uint8Array(out);
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
    let subtle = getSubtle();
    let base = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
    let bits = await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
        base,
        len * 8
    );
    return new Uint8Array(bits);
}

/**
 * Derive the key-encryption key from the user's login password.
 *
 * PBKDF2 first (the only password KDF WebCrypto offers: there is no Argon2id
 * and no scrypt, which is the ceiling on this whole design), then a
 * non-optional HKDF domain-separation step that binds the KEK to
 * (service, owner, user_id). That binding is what stops a keyring blob lifted
 * out of one project from being opened by a KEK derived in another.
 *
 * The password is NFC-normalized first so that a composed and a decomposed
 * form of the same accented character derive the same key. Without this, a
 * user who types "e" + combining acute on macOS and precomposed on Windows
 * gets two different keys from the same visible password.
 */
export async function deriveKek(
    password: string,
    salt: Uint8Array,
    iterations: number,
    info: Uint8Array
): Promise<CryptoKey> {
    let subtle = getSubtle();
    let pwBytes = encodeUtf8(password.normalize('NFC'));

    let base = await subtle.importKey('raw', pwBytes as BufferSource, 'PBKDF2', false, ['deriveBits']);
    let prk = new Uint8Array(await subtle.deriveBits(
        { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
        base,
        256
    ));

    let kekBytes = await hkdf(prk, salt, info, 32);
    zeroize(prk);
    zeroize(pwBytes);

    let key = await importAesGcm(kekBytes);
    zeroize(kekBytes);
    return key;
}

/* ------------------------------------------------------------------ *
 * AES-GCM
 * ------------------------------------------------------------------ */

/** Import raw bytes as a non-extractable AES-GCM key. */
export async function importAesGcm(raw: Uint8Array): Promise<CryptoKey> {
    return getSubtle().importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Fresh 256-bit AES-GCM key material. Returns both the bytes and the key. */
export async function generateAesGcm(): Promise<{ bytes: Uint8Array; key: CryptoKey }> {
    let bytes = getRandom(32);
    let key = await importAesGcm(bytes);
    return { bytes, key };
}

/**
 * Authenticated encrypt. A FRESH random IV every single call, no exceptions:
 * reusing an (key, iv) pair under GCM is a catastrophic break, not a weakening.
 */
export async function sealGcm(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
    let iv = getRandom(IV_LEN);
    let ct = await getSubtle().encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
        key,
        plaintext as BufferSource
    );
    return { iv, ct: new Uint8Array(ct) };
}

/**
 * Authenticated decrypt. Throws on a tag mismatch, which is the ONLY signal
 * that matters: a wrong key, a tampered ciphertext, a tampered AAD and a
 * transplanted envelope all surface here identically and must all be treated
 * as failure. Callers translate this into a flag, never into a partial result.
 */
export async function openGcm(key: CryptoKey, iv: Uint8Array, ct: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    let pt = await getSubtle().decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
        key,
        ct as BufferSource
    );
    return new Uint8Array(pt);
}

/* ------------------------------------------------------------------ *
 * ECDH P-256 identity
 *
 * P-256 and not X25519: X25519 is still missing from Node 18's WebCrypto
 * (Node 18 is in the CI matrix) and from older Safari. The keyring's `alg`
 * field and the envelope's `kw` field exist so a better curve can be adopted
 * later behind feature detection without a format break.
 * ------------------------------------------------------------------ */

const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' };

/**
 * Generate a fresh identity keypair.
 *
 * The private key is generated extractable so it can be exported to pkcs8 and
 * encrypted under MK. That extractable handle is the one moment of exposure in
 * the whole design and it never escapes this function: the caller receives only
 * the pkcs8 bytes (to encrypt immediately) and a re-imported NON-extractable
 * key for use. Zeroize the pkcs8 buffer as soon as it is sealed.
 */
export async function generateIdentity(): Promise<{ pubRaw: Uint8Array; pkcs8: Uint8Array; priv: CryptoKey }> {
    let subtle = getSubtle();
    let pair = await subtle.generateKey(ECDH_P256, true, ['deriveBits']) as CryptoKeyPair;

    let pubRaw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    let pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));

    // Re-import non-extractable. The extractable handle in `pair` goes out of
    // scope here and is never stored.
    let priv = await importIdentityPriv(pkcs8);

    return { pubRaw, pkcs8, priv };
}

/** Import a pkcs8 private key, NON-extractable. */
export async function importIdentityPriv(pkcs8: Uint8Array): Promise<CryptoKey> {
    return getSubtle().importKey('pkcs8', pkcs8 as BufferSource, ECDH_P256, false, ['deriveBits']);
}

/** Import a peer's 65-byte uncompressed raw P-256 point. */
export async function importPeerPub(raw: Uint8Array): Promise<CryptoKey> {
    if (raw.length !== 65 || raw[0] !== 0x04) {
        throw new SkapiError('Malformed public key: expected a 65 byte uncompressed P-256 point.', { code: 'INVALID_PARAMETER' });
    }
    return getSubtle().importKey('raw', raw as BufferSource, ECDH_P256, false, []);
}

/** Stable fingerprint of a published public key, for pinning and display. */
export async function fingerprint(pubRaw: Uint8Array): Promise<string> {
    return b64uFromBytes(await sha256(pubRaw));
}

/**
 * ECDH-ES wrap: seal `dek` so only the holder of `peerPubRaw`'s private half
 * can open it.
 *
 * Ephemeral-static, so a fresh Z per wrap and no HKDF salt is needed. `info`
 * carries the record anchor, the owner, the recipient id and the recipient's
 * key fingerprint, and the same facts are repeated in `aad`. A wrap copied to
 * another record, replayed for another user, or re-pointed at a substituted
 * key therefore fails the GCM tag instead of decrypting.
 */
export async function wrapEcdhEs(
    peerPubRaw: Uint8Array,
    dek: Uint8Array,
    info: Uint8Array,
    aad: Uint8Array
): Promise<{ epk: Uint8Array; iv: Uint8Array; ct: Uint8Array }> {
    let subtle = getSubtle();
    let peer = await importPeerPub(peerPubRaw);
    let eph = await subtle.generateKey(ECDH_P256, true, ['deriveBits']) as CryptoKeyPair;

    let z = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer } as any, eph.privateKey, 256));
    let kwBytes = await hkdf(z, new Uint8Array(32), info, 32);
    zeroize(z);

    let kw = await importAesGcm(kwBytes);
    zeroize(kwBytes);

    let { iv, ct } = await sealGcm(kw, dek, aad);
    let epk = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));

    return { epk, iv, ct };
}

/** Inverse of wrapEcdhEs. Throws on any tag failure. */
export async function unwrapEcdhEs(
    myPriv: CryptoKey,
    epkRaw: Uint8Array,
    iv: Uint8Array,
    ct: Uint8Array,
    info: Uint8Array,
    aad: Uint8Array
): Promise<Uint8Array> {
    let subtle = getSubtle();
    let epk = await importPeerPub(epkRaw);

    let z = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: epk } as any, myPriv, 256));
    let kwBytes = await hkdf(z, new Uint8Array(32), info, 32);
    zeroize(z);

    let kw = await importAesGcm(kwBytes);
    zeroize(kwBytes);

    return openGcm(kw, iv, ct, aad);
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

/**
 * Overwrite a buffer.
 *
 * Honest about what this is: JS gives no guarantee the engine has not already
 * copied the bytes elsewhere, and a GC'd copy is beyond reach. It shrinks the
 * window in which raw key material sits readable in a heap snapshot. It is
 * hygiene, not a control.
 */
export function zeroize(buf: Uint8Array | null | undefined): void {
    if (buf && buf.length) {
        buf.fill(0);
    }
}

/** Constant-time-ish comparison for short tags and fingerprints. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff === 0;
}

/**
 * Build the canonical AAD byte string. JSON.stringify over an ARRAY (not an
 * object) so field order is fixed by position and can never be reordered by
 * an engine's key ordering.
 */
export function canonicalAad(parts: (string | number)[]): Uint8Array {
    return encodeUtf8(JSON.stringify(parts));
}

/** Per-recipient AAD: the payload AAD, plus who this wrap is for. */
export function recipientAad(baseAad: Uint8Array, userId: string, bind: string): Uint8Array {
    return concatBytes(baseAad, new Uint8Array([0]), encodeUtf8(userId), new Uint8Array([0]), encodeUtf8(bind));
}

/* ------------------------------------------------------------------ *
 * Recovery codes
 *
 * A recovery code is a HIGH-ENTROPY secret this SDK generates, so it needs no
 * password stretching: PBKDF2's 600k iterations exist because human passwords
 * are guessable, and 128 random bits are not. HKDF is the right tool, and it is
 * instant. This makes the recovery path cryptographically STRONGER than the
 * password path, not weaker.
 *
 * Crockford base32: no I, L, O or U, so a code read off a screen and typed back
 * cannot be mangled by the usual confusions. Two trailing check characters turn
 * a typo into "that is not a valid code" instead of "wrong code".
 * ------------------------------------------------------------------ */

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Bytes of entropy in a recovery code. 128 bits. */
export const RECOVERY_BYTES = 16;

/** Data characters (26) plus two check characters. */
const RECOVERY_DATA_CHARS = 26;
const RECOVERY_TOTAL_CHARS = 28;

/** Cheap synchronous hash, for typo detection only. Not a security control. */
function checkBits(raw: Uint8Array): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) {
        h ^= raw[i];
        h = (h * 0x01000193) >>> 0;
    }
    return h & 0x3ff; // 10 bits -> two base32 characters
}

/**
 * Format raw entropy as a human-transcribable code:
 * "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" (28 chars, 7 groups of 4).
 */
export function encodeRecoveryCode(raw: Uint8Array): string {
    if (raw.length !== RECOVERY_BYTES) {
        throw new SkapiError(`A recovery code needs exactly ${RECOVERY_BYTES} bytes.`, { code: 'INVALID_PARAMETER' });
    }

    let out = '';
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < raw.length; i++) {
        acc = (acc << 8) | raw[i];
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += B32[(acc >> bits) & 31];
        }
    }
    if (bits > 0) {
        out += B32[(acc << (5 - bits)) & 31];
    }

    let chk = checkBits(raw);
    out += B32[(chk >> 5) & 31] + B32[chk & 31];

    return (out.match(/.{1,4}/g) || []).join('-');
}

/**
 * Parse a code the user typed. Tolerant of case, spacing, hyphens and the
 * classic O/0 and I/1/L confusions; strict about everything else.
 */
export function decodeRecoveryCode(code: string): Uint8Array {
    if (typeof code !== 'string') {
        throw new SkapiError('Recovery code should be a string.', { code: 'INVALID_PARAMETER' });
    }

    let cleaned = code
        .toUpperCase()
        .replace(/[\s\-_]/g, '')
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1');

    if (cleaned.length !== RECOVERY_TOTAL_CHARS) {
        throw new SkapiError(
            `That does not look like a recovery code: expected ${RECOVERY_TOTAL_CHARS} characters, got ${cleaned.length}.`,
            { code: 'ENCRYPTION_BAD_RECOVERY_CODE' }
        );
    }

    let data = cleaned.slice(0, RECOVERY_DATA_CHARS);
    let check = cleaned.slice(RECOVERY_DATA_CHARS);

    let acc = 0;
    let bits = 0;
    let bytes: number[] = [];
    for (let i = 0; i < data.length; i++) {
        let v = B32.indexOf(data[i]);
        if (v < 0) {
            throw new SkapiError(
                `That does not look like a recovery code: "${data[i]}" is not a valid character.`,
                { code: 'ENCRYPTION_BAD_RECOVERY_CODE' }
            );
        }
        acc = (acc << 5) | v;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((acc >> bits) & 0xff);
        }
    }

    let raw = new Uint8Array(bytes.slice(0, RECOVERY_BYTES));
    let chk = checkBits(raw);
    if (check !== B32[(chk >> 5) & 31] + B32[chk & 31]) {
        throw new SkapiError(
            'That recovery code has a typo in it: the check characters do not match.',
            { code: 'ENCRYPTION_BAD_RECOVERY_CODE' }
        );
    }

    return raw;
}

/**
 * Derive the wrapping key for a recovery code.
 *
 * HKDF only, deliberately. See the note above: stretching a 128-bit random
 * secret buys nothing and only makes recovery slow.
 */
export async function deriveRecoveryKey(raw: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
    let bytes = await hkdf(raw, salt, info, 32);
    let key = await importAesGcm(bytes);
    zeroize(bytes);
    return key;
}

/* ------------------------------------------------------------------ *
 * Encrypted file container (SKENCF v2)
 *
 * WebCrypto's AES-GCM is one-shot: subtle.encrypt wants the whole plaintext as
 * one buffer. Applied naively to an upload that means a 500MB file needs the
 * original, the ciphertext and the Blob all resident, and one GCM operation
 * over half a gigabyte. So the container is CHUNKED, each chunk sealed with its
 * own IV, with its position bound into its AAD.
 *
 * Layout, integers big-endian:
 *
 *   0   6  magic "SKENCF"
 *   6   1  version 0x02
 *   7   1  flags (bit0 = meta present)
 *   8   4  chunkSize, PLAINTEXT bytes per chunk
 *   12  4  chunkCount (always >= 1)
 *   16 16  fileId, fresh CSPRNG per encryption
 *   32  8  plainLen
 *   40  8  dekId, so "sealed under a retired data key" is distinguishable
 *          from "corrupt" after a revoke rolls the record's key
 *   48  4  metaLen
 *   52  4  reserved
 *   56  metaLen   meta: UTF-8 JSON {n:filename, t:contentType, lm:lastModified}
 *   ---------------------------------------------- header
 *   per chunk: len(4) | iv(12) | ciphertext||tag
 *
 * Two decisions worth keeping:
 *
 * - The FILENAME is authenticated inside `meta` but is NOT in the chunk AAD.
 *   S3 stores the exact upload byte-form, macOS submits NFD, and the server
 *   unquote_plus's the key, so a name can legitimately come back in a different
 *   Unicode form. Binding it into the AAD would turn that drift into permanent
 *   undecryptability; authenticating it in the header lets a mismatch be
 *   reported instead of fatal.
 * - The per-file key is DERIVED from the record's data key rather than being it.
 *   The derivation binds project, owner and record, so a container moved to
 *   another record simply yields a wrong key, and the record DEK is never used
 *   as a bulk key.
 * ------------------------------------------------------------------ */

const FILE_MAGIC = [0x53, 0x4b, 0x45, 0x4e, 0x43, 0x46]; // "SKENCF"
const FILE_VERSION = 2;
const FILE_HEADER_FIXED = 56;
const FILE_ID_BYTES = 16;

/** Plaintext bytes per chunk. 4 MiB keeps any single GCM operation modest. */
export const FILE_CHUNK_BYTES = 4 * 1024 * 1024;

/** Per-chunk overhead: the length prefix, the IV and the GCM tag. */
export const FILE_CHUNK_OVERHEAD = 4 + IV_LEN + 16;

export type FileMeta = { n?: string; t?: string; lm?: number };

/** Cheap check for the container magic. Never throws. */
export function isEncryptedFile(bytes: Uint8Array): boolean {
    if (!bytes || bytes.length < FILE_HEADER_FIXED) {
        return false;
    }
    for (let i = 0; i < FILE_MAGIC.length; i++) {
        if (bytes[i] !== FILE_MAGIC[i]) {
            return false;
        }
    }
    return true;
}

function writeU32(t: Uint8Array, at: number, v: number): void {
    t[at] = (v >>> 24) & 0xff; t[at + 1] = (v >>> 16) & 0xff; t[at + 2] = (v >>> 8) & 0xff; t[at + 3] = v & 0xff;
}
function readU32(s: Uint8Array, at: number): number {
    return ((s[at] << 24) >>> 0) + (s[at + 1] << 16) + (s[at + 2] << 8) + s[at + 3];
}
function writeU64(t: Uint8Array, at: number, v: number): void {
    // JS numbers are exact to 2^53, far beyond any uploadable file.
    let hi = Math.floor(v / 0x100000000);
    writeU32(t, at, hi);
    writeU32(t, at + 4, v >>> 0);
}
function readU64(s: Uint8Array, at: number): number {
    return readU32(s, at) * 0x100000000 + readU32(s, at + 4);
}

/**
 * Derive the per-file key from a record's data key.
 *
 * Binding service, owner, record owner and record_id here means a container
 * lifted onto another record yields a wrong key rather than needing those
 * facts repeated in every chunk's AAD.
 */
export async function deriveFileKey(
    dek: Uint8Array,
    fileId: Uint8Array,
    service: string,
    owner: string,
    recordOwner: string,
    recordId: string
): Promise<CryptoKey> {
    let info = encodeUtf8(`${ENC_V}|binfile|${service}|${owner}|${recordOwner}|${recordId}`);
    let bytes = await hkdf(dek, fileId, info, 32);
    let key = await importAesGcm(bytes);
    zeroize(bytes);
    return key;
}

/** Short, non-secret identifier for a data key, so a stale key is diagnosable. */
export async function dekIdOf(dek: Uint8Array): Promise<Uint8Array> {
    let h = await sha256(concatBytes(encodeUtf8(`${ENC_V}|dekid`), dek));
    return h.subarray(0, 8);
}

/** Exact stored size before encrypting a byte, so an upload can declare it. */
export function encryptedFileSize(plainLen: number, metaLen: number, chunkBytes: number = FILE_CHUNK_BYTES): number {
    let count = plainLen === 0 ? 1 : Math.ceil(plainLen / chunkBytes);
    return FILE_HEADER_FIXED + metaLen + count * FILE_CHUNK_OVERHEAD + plainLen;
}

/**
 * Chunk AAD. Binds the WHOLE header by hash, so chunkSize, chunkCount,
 * plainLen, dekId and the meta block are all authenticated, plus this chunk's
 * position, which is what rejects a reordered, duplicated or truncated stream.
 */
function chunkAad(headerHash: Uint8Array, index: number, count: number): Uint8Array {
    return canonicalAad([`${ENC_V}|binchunk`, b64uFromBytes(headerHash), index, count]);
}

function buildHeader(
    chunkBytes: number, count: number, fileId: Uint8Array,
    plainLen: number, dekId: Uint8Array, metaBytes: Uint8Array
): Uint8Array {
    let h = new Uint8Array(FILE_HEADER_FIXED + metaBytes.length);
    h.set(FILE_MAGIC, 0);
    h[6] = FILE_VERSION;
    h[7] = metaBytes.length ? 1 : 0;
    writeU32(h, 8, chunkBytes);
    writeU32(h, 12, count);
    h.set(fileId, 16);
    writeU64(h, 32, plainLen);
    h.set(dekId, 40);
    writeU32(h, 48, metaBytes.length);
    writeU32(h, 52, 0);
    if (metaBytes.length) {
        h.set(metaBytes, FILE_HEADER_FIXED);
    }
    return h;
}

/** Seal a file's bytes under a key derived from the record's data key. */
export async function encryptFileBytes(
    dek: Uint8Array,
    plain: Uint8Array,
    ctx: { service: string; owner: string; recordOwner: string; recordId: string },
    meta?: FileMeta,
    chunkBytes: number = FILE_CHUNK_BYTES
): Promise<Uint8Array> {
    let fileId = getRandom(FILE_ID_BYTES);
    let key = await deriveFileKey(dek, fileId, ctx.service, ctx.owner, ctx.recordOwner, ctx.recordId);
    let dekId = await dekIdOf(dek);

    let metaBytes = meta ? encodeUtf8(JSON.stringify(meta)) : new Uint8Array(0);
    if (metaBytes.length > 4096) {
        throw new SkapiError('Encrypted file metadata is too large.', { code: 'INVALID_PARAMETER' });
    }

    // An empty file is ONE empty chunk, not zero, so its emptiness is signed.
    let count = plain.length === 0 ? 1 : Math.ceil(plain.length / chunkBytes);
    let header = buildHeader(chunkBytes, count, fileId, plain.length, dekId, metaBytes);
    let headerHash = await sha256(header);

    let sealed: { iv: Uint8Array; ct: Uint8Array }[] = [];
    let total = header.length;
    for (let i = 0; i < count; i++) {
        let slice = plain.subarray(i * chunkBytes, Math.min((i + 1) * chunkBytes, plain.length));
        let s = await sealGcm(key, slice, chunkAad(headerHash, i, count));
        sealed.push(s);
        total += 4 + s.iv.length + s.ct.length;
    }

    let out = new Uint8Array(total);
    out.set(header, 0);
    let at = header.length;
    for (let s of sealed) {
        writeU32(out, at, s.iv.length + s.ct.length);
        at += 4;
        out.set(s.iv, at); at += s.iv.length;
        out.set(s.ct, at); at += s.ct.length;
    }
    return out;
}

/** Read a container's header without needing a key. */
export function readFileHeader(container: Uint8Array): {
    version: number; chunkBytes: number; count: number; fileId: Uint8Array;
    plainLen: number; dekId: Uint8Array; meta: FileMeta | null; headerLen: number;
} {
    if (!isEncryptedFile(container)) {
        throw new SkapiError('This file is not an encrypted skapi file.', { code: 'INVALID_PARAMETER' });
    }
    let metaLen = readU32(container, 48);
    let headerLen = FILE_HEADER_FIXED + metaLen;
    if (container.length < headerLen) {
        throw new SkapiError('Encrypted file header is truncated.', { code: 'INVALID_REQUEST' });
    }
    let meta: FileMeta | null = null;
    if (metaLen) {
        // Deliberately NOT swallowed. Meta is authenticated by the chunk AAD, so
        // if it is present it must be parseable; returning null on a parse
        // failure once hid a missing import and made every file look
        // meta-less.
        meta = JSON.parse(decodeUtf8(container.subarray(FILE_HEADER_FIXED, headerLen)));
    }
    return {
        version: container[6],
        chunkBytes: readU32(container, 8),
        count: readU32(container, 12),
        fileId: container.subarray(16, 16 + FILE_ID_BYTES),
        plainLen: readU64(container, 32),
        dekId: container.subarray(40, 48),
        meta,
        headerLen
    };
}

/** Open a sealed file. Throws on tampering, truncation, reordering or a stale key. */
export async function decryptFileBytes(
    dek: Uint8Array,
    container: Uint8Array,
    ctx: { service: string; owner: string; recordOwner: string; recordId: string }
): Promise<{ bytes: Uint8Array; meta: FileMeta | null }> {
    let h = readFileHeader(container);

    if (h.version !== FILE_VERSION) {
        throw new SkapiError(
            `This file was encrypted by a different version of the SDK (container v${h.version}).`,
            { code: 'NOT_SUPPORTED' }
        );
    }
    if (!h.count || !h.chunkBytes) {
        throw new SkapiError('Encrypted file header is malformed.', { code: 'INVALID_PARAMETER' });
    }

    // Distinguish "sealed under a data key that has since been rolled" from
    // "corrupt". A revoke mints a fresh DEK, and a file that was not re-keyed
    // in that flow lands here.
    let expect = await dekIdOf(dek);
    if (!bytesEqual(expect, h.dekId)) {
        throw new SkapiError(
            'This file was encrypted under a previous data key for this record, so it can no longer be opened. ' +
            'It was most likely left behind by an interrupted access change.',
            { code: 'ENCRYPTION_FILE_STALE_KEY' }
        );
    }

    let key = await deriveFileKey(dek, h.fileId, ctx.service, ctx.owner, ctx.recordOwner, ctx.recordId);
    let headerHash = await sha256(container.subarray(0, h.headerLen));

    let parts: Uint8Array[] = [];
    let at = h.headerLen;
    let plainLen = 0;

    for (let i = 0; i < h.count; i++) {
        if (at + 4 > container.length) {
            throw new SkapiError('Encrypted file is truncated.', { code: 'INVALID_REQUEST' });
        }
        let len = readU32(container, at);
        at += 4;
        if (len < IV_LEN + 16 || at + len > container.length) {
            throw new SkapiError('Encrypted file is truncated.', { code: 'INVALID_REQUEST' });
        }
        let chunk = await openGcm(key, container.subarray(at, at + IV_LEN), container.subarray(at + IV_LEN, at + len), chunkAad(headerHash, i, h.count));
        at += len;
        parts.push(chunk);
        plainLen += chunk.length;
    }

    let out = new Uint8Array(plainLen);
    let w = 0;
    for (let c of parts) {
        out.set(c, w);
        w += c.length;
    }
    return { bytes: out, meta: h.meta };
}
