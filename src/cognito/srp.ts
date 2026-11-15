/**
 * Cognito's SRP-6a password sign-in, ported from amazon-cognito-identity-js
 * (AuthenticationHelper.js) onto native BigInt. Every step, and in particular padHex, must give
 * the same bytes as the library did: a wrong padding only fails a sign-in when a value happens to
 * start with a high bit, which is about 1 in 256 attempts and easy to miss.
 *
 * The password never leaves the device: only A (g^a mod N) and a signature derived from the shared
 * key are sent.
 */

import { sha256, hmacSha256, randomBytes, utf8, concatBytes, bytesToHex, hexToBytes } from './crypto';

const N_HEX =
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' + '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
    'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' + 'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
    'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' + 'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
    '83655D23DCA3AD961C62F356208552BB9ED529077096966D' + '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
    'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' + 'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
    '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64' + 'ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
    'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B' + 'F12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
    'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31' + '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

export const N = BigInt('0x' + N_HEX);
export const g = TWO;

const HEX_MSB_REGEX = /^[89a-f]/i;
const INFO_BITS = concatBytes(utf8('Caldera Derived Key'), new Uint8Array([1]));

/** Hex string to BigInt, as `new BigInteger(hex, 16)` read it (an empty string is 0). */
export function hexToBigInt(hex: string): bigint {
    return hex ? BigInt('0x' + hex) : ZERO;
}

/** x mod m, never negative (BigInt's % keeps the sign of x). */
function mod(x: bigint, m: bigint): bigint {
    const r = x % m;
    return r < ZERO ? r + m : r;
}

export function modPow(base: bigint, exponent: bigint, m: bigint): bigint {
    let result = ONE;
    let b = mod(base, m);
    let e = exponent;
    while (e > ZERO) {
        if (e & ONE) {
            result = (result * b) % m;
        }
        e >>= ONE;
        b = (b * b) % m;
    }
    return result;
}

/**
 * Signed big-endian hex, exactly as the library writes it: even length, a leading "00" when the
 * top bit is set (so the value stays positive), and two's complement for a negative value.
 */
export function padHex(value: bigint): string {
    const isNegative = value < ZERO;
    let hexStr = (isNegative ? -value : value).toString(16);
    hexStr = hexStr.length % 2 !== 0 ? '0' + hexStr : hexStr;
    hexStr = HEX_MSB_REGEX.test(hexStr) ? '00' + hexStr : hexStr;

    if (isNegative) {
        const inverted = hexStr.split('').map(x => '0123456789ABCDEF'.charAt(~parseInt(x, 16) & 0xf)).join('');
        hexStr = (BigInt('0x' + inverted) + ONE).toString(16);
        if (hexStr.toUpperCase().startsWith('FF8')) {
            hexStr = hexStr.substring(2);
        }
    }
    return hexStr;
}

/** SHA-256 as 64 hex characters. */
function hashHex(data: Uint8Array): string {
    return bytesToHex(sha256(data));
}

/** SHA-256 of the bytes a hex string encodes. */
function hexHash(hexStr: string): string {
    return hashHex(hexToBytes(hexStr));
}

export const k = hexToBigInt(hexHash(padHex(N) + padHex(g)));

/** HKDF-SHA256 with Cognito's info string, first 16 bytes. */
export function computeHkdf(ikm: Uint8Array, salt: Uint8Array): Uint8Array {
    const prk = hmacSha256(salt, ikm);
    return hmacSha256(prk, INFO_BITS).slice(0, 16);
}

export class SrpHelper {
    readonly poolName: string;
    readonly smallA: bigint;
    readonly largeA: bigint;

    /**
     * @param poolName The part of the user pool id after the underscore.
     * @param smallA For the equivalence checks only: a fixed secret instead of 128 random bytes.
     */
    constructor(poolName: string, smallA?: bigint) {
        this.poolName = poolName;
        // 128 random bytes read as a positive integer. No reduction needed: N is 3072 bits.
        this.smallA = smallA ?? hexToBigInt(bytesToHex(randomBytes(128)));
        this.largeA = modPow(g, this.smallA, N);
        if (mod(this.largeA, N) === ZERO) {
            throw new Error('Illegal paramater. A mod N cannot be 0.');
        }
    }

    /** The 16 byte key both sides derive; Cognito checks a signature made with it. */
    getPasswordAuthenticationKey(username: string, password: string, serverB: bigint, salt: bigint): Uint8Array {
        if (mod(serverB, N) === ZERO) {
            throw new Error('B cannot be zero.');
        }
        const u = hexToBigInt(hexHash(padHex(this.largeA) + padHex(serverB)));
        if (u === ZERO) {
            throw new Error('U cannot be zero.');
        }
        const usernamePasswordHash = hashHex(utf8(`${this.poolName}${username}:${password}`));
        const x = hexToBigInt(hexHash(padHex(salt) + usernamePasswordHash));
        // S = (B - k * g^x) ^ (a + u * x) mod N. B - k * g^x can be negative; modPow reduces the
        // base into [0, N) first, the same value the library's BigInteger gives.
        const gModPowXN = modPow(g, x, N);
        const S = mod(modPow(serverB - k * gModPowXN, this.smallA + u * x, N), N);
        return computeHkdf(hexToBytes(padHex(S)), hexToBytes(padHex(u)));
    }
}

/** "Sun Nov 15 16:52:00 UTC 2026": the day is not zero padded, the time is. */
export function cognitoTimestamp(now: Date = new Date()): string {
    const weekNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const two = (n: number) => (n < 10 ? '0' + n : '' + n);
    return `${weekNames[now.getUTCDay()]} ${monthNames[now.getUTCMonth()]} ${now.getUTCDate()} ` +
        `${two(now.getUTCHours())}:${two(now.getUTCMinutes())}:${two(now.getUTCSeconds())} UTC ${now.getUTCFullYear()}`;
}
