/**
 * The crypto primitives in src/utils/crypto.ts.
 *
 * These are the tests that matter most and are the hardest to write later: every
 * NEGATIVE case must fail CLOSED. A tampered ciphertext, a flipped IV bit, a
 * modified AAD, a wrap replayed for another user, a wrap moved to another
 * record, a substituted public key -- each must throw, not return a partial or
 * wrong plaintext. An AEAD that silently degrades is worse than no encryption,
 * because the caller believes it worked.
 *
 * crypto.ts is not reachable from the public bundle by design (nothing here is
 * public API), so the file is compiled standalone with esbuild, which is already
 * a dependency via tsup.
 *
 * Run: node ./tests/crypto-primitives.cjs
 */

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const pathmod = require('node:path');
const fsmod = require('node:fs');

const OUT = pathmod.join(os.tmpdir(), `skapi-crypto-test-${process.pid}.cjs`);
execFileSync('npx', ['esbuild', pathmod.join(__dirname, '..', 'src/utils/crypto.ts'),
    '--bundle', '--platform=node', '--format=cjs', '--log-level=error', `--outfile=${OUT}`],
    { cwd: pathmod.join(__dirname, '..'), stdio: 'inherit' });
process.on('exit', () => { try { fsmod.unlinkSync(OUT); } catch (e) { } });
const assert = require('node:assert');
const C = require(OUT);

let pass = 0, total = 0;
async function t(name, fn) {
    total++;
    try { await fn(); pass++; console.log('ok   ' + name); }
    catch (e) { console.log('FAIL ' + name + '\n     ' + (e && e.message)); process.exitCode = 1; }
}
async function mustThrow(name, fn) {
    total++;
    try { await fn(); console.log('FAIL ' + name + ' (did NOT throw)'); process.exitCode = 1; }
    catch (e) { pass++; console.log('ok   ' + name + ' (failed closed)'); }
}

const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);

(async () => {
    await t('crypto is available in node 22', () => {
        assert.strictEqual(C.cryptoAvailable(), true);
        assert.ok(C.getSubtle());
    });

    // ---- base64url ----
    await t('b64u round trips every byte value', () => {
        const all = new Uint8Array(256);
        for (let i = 0; i < 256; i++) all[i] = i;
        const s = C.b64uFromBytes(all);
        assert.ok(!/[+/=]/.test(s), 'must be url-safe and unpadded, got: ' + s.slice(0, 40));
        assert.deepStrictEqual(Array.from(C.b64uToBytes(s)), Array.from(all));
    });
    await t('b64u handles every length mod 4', () => {
        for (let n = 0; n < 12; n++) {
            const b = C.getRandom(n);
            assert.deepStrictEqual(Array.from(C.b64uToBytes(C.b64uFromBytes(b))), Array.from(b), 'len ' + n);
        }
    });
    await t('b64u agrees with node base64url', () => {
        const b = C.getRandom(97);
        assert.strictEqual(C.b64uFromBytes(b), Buffer.from(b).toString('base64url'));
    });
    await t('b64u chunked path handles a large buffer', () => {
        const b = C.getRandom(300000);
        assert.deepStrictEqual(Array.from(C.b64uToBytes(C.b64uFromBytes(b))), Array.from(b));
    });
    await mustThrow('b64u rejects a malformed length', () => C.b64uToBytes('abcde'));

    // ---- randomness ----
    await t('getRandom is not constant and is the right length', () => {
        const a = C.getRandom(32), b = C.getRandom(32);
        assert.strictEqual(a.length, 32);
        assert.notDeepStrictEqual(Array.from(a), Array.from(b));
        assert.ok(a.some(x => x !== 0));
    });
    await t('randomUuid looks like a v4 uuid', () => {
        const u = C.randomUuid();
        assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.notStrictEqual(u, C.randomUuid());
    });

    // ---- hash / hkdf ----
    await t('sha256 matches node', async () => {
        const b = enc('skapi');
        const mine = await C.sha256(b);
        const theirs = require('node:crypto').createHash('sha256').update(b).digest();
        assert.deepStrictEqual(Array.from(mine), Array.from(theirs));
    });
    await t('hkdf is deterministic and info-separated', async () => {
        const ikm = C.getRandom(32), salt = C.getRandom(16);
        const a = await C.hkdf(ikm, salt, enc('info-a'), 32);
        const a2 = await C.hkdf(ikm, salt, enc('info-a'), 32);
        const b = await C.hkdf(ikm, salt, enc('info-b'), 32);
        assert.deepStrictEqual(Array.from(a), Array.from(a2), 'must be deterministic');
        assert.notDeepStrictEqual(Array.from(a), Array.from(b), 'different info must diverge');
    });

    // ---- KEK derivation ----
    await t('deriveKek is deterministic for the same password', async () => {
        const salt = C.getRandom(16), info = enc('skapi.enc.v1|kek|svc|own|uid');
        const k1 = await C.deriveKek('hunter2', salt, 10000, info);
        const k2 = await C.deriveKek('hunter2', salt, 10000, info);
        const msg = enc('secret');
        const { iv, ct } = await C.sealGcm(k1, msg, enc('aad'));
        assert.strictEqual(dec(await C.openGcm(k2, iv, ct, enc('aad'))), 'secret');
    });
    await t('deriveKek NFC-normalizes the password', async () => {
        const salt = C.getRandom(16), info = enc('i');
        const composed = 'é';            // é precomposed
        const decomposed = 'é';         // e + combining acute
        const k1 = await C.deriveKek(composed, salt, 10000, info);
        const k2 = await C.deriveKek(decomposed, salt, 10000, info);
        const { iv, ct } = await C.sealGcm(k1, enc('x'), enc('a'));
        assert.strictEqual(dec(await C.openGcm(k2, iv, ct, enc('a'))), 'x');
    });
    await t('deriveKek is separated by info (project binding)', async () => {
        const salt = C.getRandom(16);
        const k1 = await C.deriveKek('pw', salt, 10000, enc('proj-A'));
        const k2 = await C.deriveKek('pw', salt, 10000, enc('proj-B'));
        const { iv, ct } = await C.sealGcm(k1, enc('x'), enc('a'));
        await assert.rejects(() => C.openGcm(k2, iv, ct, enc('a')));
    });
    await mustThrow('deriveKek is separated by iterations', async () => {
        const salt = C.getRandom(16), info = enc('i');
        const k1 = await C.deriveKek('pw', salt, 10000, info);
        const k2 = await C.deriveKek('pw', salt, 20000, info);
        const { iv, ct } = await C.sealGcm(k1, enc('x'), enc('a'));
        await C.openGcm(k2, iv, ct, enc('a'));
    });

    // ---- AES-GCM ----
    const { bytes: dekBytes, key: dek } = await C.generateAesGcm();
    const aad = C.canonicalAad(['skapi.enc.v1', 'svc', 'own', 'user-1', 'uid', 'anchor-1']);

    await t('sealGcm/openGcm round trips', async () => {
        const pt = enc(JSON.stringify({ hello: 'world', n: 42, nested: [1, { a: null }] }));
        const { iv, ct } = await C.sealGcm(dek, pt, aad);
        assert.deepStrictEqual(JSON.parse(dec(await C.openGcm(dek, iv, ct, aad))), { hello: 'world', n: 42, nested: [1, { a: null }] });
    });
    await t('iv is fresh on every seal', async () => {
        const pt = enc('same');
        const a = await C.sealGcm(dek, pt, aad);
        const b = await C.sealGcm(dek, pt, aad);
        assert.notDeepStrictEqual(Array.from(a.iv), Array.from(b.iv), 'IV REUSE: catastrophic');
        assert.notDeepStrictEqual(Array.from(a.ct), Array.from(b.ct));
    });
    await t('ciphertext carries the 16 byte gcm tag', async () => {
        const pt = enc('1234567890');
        const { ct } = await C.sealGcm(dek, pt, aad);
        assert.strictEqual(ct.length, pt.length + 16);
    });

    const base = await C.sealGcm(dek, enc('payload'), aad);
    await mustThrow('one bit flipped in ct fails', async () => {
        const bad = Uint8Array.from(base.ct); bad[0] ^= 1;
        await C.openGcm(dek, base.iv, bad, aad);
    });
    await mustThrow('one bit flipped in the gcm tag fails', async () => {
        const bad = Uint8Array.from(base.ct); bad[bad.length - 1] ^= 1;
        await C.openGcm(dek, base.iv, bad, aad);
    });
    await mustThrow('one bit flipped in iv fails', async () => {
        const bad = Uint8Array.from(base.iv); bad[0] ^= 1;
        await C.openGcm(dek, bad, base.ct, aad);
    });
    await mustThrow('one bit flipped in aad fails', async () => {
        const bad = Uint8Array.from(aad); bad[5] ^= 1;
        await C.openGcm(dek, base.iv, base.ct, bad);
    });
    await mustThrow('a different aad (transplanted record) fails', async () => {
        const other = C.canonicalAad(['skapi.enc.v1', 'svc', 'own', 'user-1', 'uid', 'anchor-2']);
        await C.openGcm(dek, base.iv, base.ct, other);
    });
    await mustThrow('a wrong key fails', async () => {
        const { key: other } = await C.generateAesGcm();
        await C.openGcm(other, base.iv, base.ct, aad);
    });

    // ---- ECDH-ES wrap ----
    const alice = await C.generateIdentity();
    const bob = await C.generateIdentity();

    await t('generateIdentity yields a 65 byte uncompressed point', () => {
        assert.strictEqual(alice.pubRaw.length, 65);
        assert.strictEqual(alice.pubRaw[0], 0x04);
        assert.notDeepStrictEqual(Array.from(alice.pubRaw), Array.from(bob.pubRaw));
    });
    await t('the identity private key is NON-extractable', async () => {
        assert.strictEqual(alice.priv.extractable, false);
        await assert.rejects(() => C.getSubtle().exportKey('pkcs8', alice.priv));
    });
    await t('fingerprint is stable and distinct per key', async () => {
        assert.strictEqual(await C.fingerprint(alice.pubRaw), await C.fingerprint(alice.pubRaw));
        assert.notStrictEqual(await C.fingerprint(alice.pubRaw), await C.fingerprint(bob.pubRaw));
    });

    const wrapInfo = enc('skapi.enc.v1|dekwrap|svc|own|anchor-1|alice|fpr');
    const wrapAad = C.recipientAad(aad, 'bob', 'fpr-bob');
    const wrapped = await C.wrapEcdhEs(bob.pubRaw, dekBytes, wrapInfo, wrapAad);

    await t('ecdh-es wrap/unwrap recovers the dek', async () => {
        const got = await C.unwrapEcdhEs(bob.priv, wrapped.epk, wrapped.iv, wrapped.ct, wrapInfo, wrapAad);
        assert.deepStrictEqual(Array.from(got), Array.from(dekBytes));
    });
    await t('epk is ephemeral: two wraps differ', async () => {
        const again = await C.wrapEcdhEs(bob.pubRaw, dekBytes, wrapInfo, wrapAad);
        assert.notDeepStrictEqual(Array.from(again.epk), Array.from(wrapped.epk));
    });
    await mustThrow('the wrong recipient cannot unwrap', async () => {
        await C.unwrapEcdhEs(alice.priv, wrapped.epk, wrapped.iv, wrapped.ct, wrapInfo, wrapAad);
    });
    await mustThrow('a wrap replayed for another user fails (aad binding)', async () => {
        const other = C.recipientAad(aad, 'carol', 'fpr-bob');
        await C.unwrapEcdhEs(bob.priv, wrapped.epk, wrapped.iv, wrapped.ct, wrapInfo, other);
    });
    await mustThrow('a wrap moved to another record fails (info binding)', async () => {
        const other = enc('skapi.enc.v1|dekwrap|svc|own|anchor-2|alice|fpr');
        await C.unwrapEcdhEs(bob.priv, wrapped.epk, wrapped.iv, wrapped.ct, other, wrapAad);
    });
    await mustThrow('a substituted key fingerprint fails (info binding)', async () => {
        const other = C.recipientAad(aad, 'bob', 'fpr-attacker');
        await C.unwrapEcdhEs(bob.priv, wrapped.epk, wrapped.iv, wrapped.ct, wrapInfo, other);
    });
    await mustThrow('a tampered epk fails', async () => {
        const bad = Uint8Array.from(wrapped.epk); bad[40] ^= 1;
        await C.unwrapEcdhEs(bob.priv, bad, wrapped.iv, wrapped.ct, wrapInfo, wrapAad);
    });
    await mustThrow('importPeerPub rejects a non-point', async () => {
        await C.importPeerPub(C.getRandom(65));
    });
    await mustThrow('importPeerPub rejects a wrong length', async () => {
        await C.importPeerPub(C.getRandom(32));
    });

    // ---- misc ----
    await t('canonicalAad is order-fixed and position-sensitive', () => {
        assert.notDeepStrictEqual(
            Array.from(C.canonicalAad(['a', 'b'])),
            Array.from(C.canonicalAad(['b', 'a'])),
            'swapping fields must change the aad'
        );
        assert.notDeepStrictEqual(
            Array.from(C.canonicalAad(['ab', 'c'])),
            Array.from(C.canonicalAad(['a', 'bc'])),
            'field boundaries must not be ambiguous'
        );
    });
    await t('zeroize clears and tolerates null', () => {
        const b = C.getRandom(16);
        C.zeroize(b);
        assert.ok(b.every(x => x === 0));
        C.zeroize(null); C.zeroize(undefined);
    });
    await t('bytesEqual is correct', () => {
        assert.strictEqual(C.bytesEqual(enc('abc'), enc('abc')), true);
        assert.strictEqual(C.bytesEqual(enc('abc'), enc('abd')), false);
        assert.strictEqual(C.bytesEqual(enc('abc'), enc('ab')), false);
    });
    await t('importAesGcm yields a non-extractable key', async () => {
        const k = await C.importAesGcm(C.getRandom(32));
        assert.strictEqual(k.extractable, false);
        await assert.rejects(() => C.getSubtle().exportKey('raw', k));
    });

    // ---- recovery codes ----
    await t('recovery code round trips', () => {
        for (let i = 0; i < 50; i++) {
            const raw = C.getRandom(16);
            const code = C.encodeRecoveryCode(raw);
            assert.deepStrictEqual(Array.from(C.decodeRecoveryCode(code)), Array.from(raw));
        }
    });
    await t('recovery code has 128 bits and a stable shape', () => {
        const code = C.encodeRecoveryCode(C.getRandom(16));
        assert.strictEqual(code.replace(/-/g, '').length, 28, 'got ' + code);
        assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/, 'got ' + code);
        assert.ok(!/[ILOU]/.test(code), 'must avoid the ambiguous letters');
    });
    await t('recovery code parsing is forgiving of transcription', () => {
        const raw = C.getRandom(16);
        const code = C.encodeRecoveryCode(raw);
        for (const variant of [
            code.toLowerCase(),
            code.replace(/-/g, ''),
            code.replace(/-/g, ' '),
            '  ' + code + '  ',
            code.replace(/0/g, 'O').replace(/1/g, 'I')  // the classic confusions
        ]) {
            assert.deepStrictEqual(Array.from(C.decodeRecoveryCode(variant)), Array.from(raw), 'failed for ' + variant);
        }
    });
    await t('single-character typos are caught by the checksum', () => {
        // The check is TWO base32 characters, so 10 bits: a mutated code has
        // roughly a 1 in 1024 chance of colliding and validating anyway. That
        // is fine for its purpose (turn a typo into "that is not a valid code"
        // instead of "wrong code"), but it means asserting on ONE mutation is a
        // coin flip that fails about once every thousand runs. Measure the rate
        // instead, and state the bound the design actually offers.
        const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        let tried = 0, missed = 0;

        for (let n = 0; n < 200; n++) {
            const code = C.encodeRecoveryCode(C.getRandom(16));
            const chars = code.split('');
            // mutate one DATA character, not a hyphen
            // Walk FORWARD to the next data character. Recomputing the same
            // index in a do/while never advances and spins forever.
            let at = (n * 7) % chars.length;
            while (chars[at] === '-') {
                at = (at + 1) % chars.length;
            }
            const orig = chars[at];
            chars[at] = ALPHABET[(ALPHABET.indexOf(orig) + 1) % 32];
            if (chars[at] === orig) continue;

            tried++;
            try { C.decodeRecoveryCode(chars.join('')); missed++; }
            catch (e) { /* caught, as it should be */ }
        }

        assert.ok(tried > 100, 'expected a meaningful sample, got ' + tried);
        assert.ok(missed / tried < 0.05,
            `checksum missed ${missed}/${tried} single-character typos; a 10 bit check should miss about 1 in 1024`);
    });
    await mustThrow('a truncated code is rejected', () => C.decodeRecoveryCode('ABCD-EFGH'));
    await mustThrow('an invalid character is rejected', () => {
        C.decodeRecoveryCode('####-####-####-####-####-####-####');
    });
    await t('recovery codes are unique', () => {
        const seen = new Set();
        for (let i = 0; i < 200; i++) seen.add(C.encodeRecoveryCode(C.getRandom(16)));
        assert.strictEqual(seen.size, 200);
    });
    await t('deriveRecoveryKey is deterministic and salt-separated', async () => {
        const raw = C.getRandom(16), salt = C.getRandom(16), info = enc('i');
        const k1 = await C.deriveRecoveryKey(raw, salt, info);
        const k2 = await C.deriveRecoveryKey(raw, salt, info);
        const { iv, ct } = await C.sealGcm(k1, enc('mk'), enc('a'));
        assert.strictEqual(dec(await C.openGcm(k2, iv, ct, enc('a'))), 'mk');

        const k3 = await C.deriveRecoveryKey(raw, C.getRandom(16), info);
        await assert.rejects(() => C.openGcm(k3, iv, ct, enc('a')), 'a different salt must not open it');
    });
    await t('deriveRecoveryKey is FAST (no password stretching)', async () => {
        const t0 = Date.now();
        await C.deriveRecoveryKey(C.getRandom(16), C.getRandom(16), enc('i'));
        const ms = Date.now() - t0;
        assert.ok(ms < 100, `HKDF should be instant, took ${ms}ms (is it going through PBKDF2?)`);
    });

    // ---- encrypted file container (SKENCF v2) ----
    const DEK = C.getRandom(32);
    const CTX = { service: 'svc', owner: 'own', recordOwner: 'alice', recordId: 'VQrec0001' };
    const META = { n: 'report.pdf', t: 'application/pdf', lm: 1700000000000 };

    await t('file container round trips at several sizes', async () => {
        for (const n of [0, 1, 1000, 4 * 1024 * 1024, 4 * 1024 * 1024 + 7, 9 * 1024 * 1024]) {
            const plain = C.getRandom(n);
            const sealed = await C.encryptFileBytes(DEK, plain, CTX, META);
            assert.ok(C.isEncryptedFile(sealed), 'magic missing at n=' + n);
            const back = await C.decryptFileBytes(DEK, sealed, CTX);
            assert.deepStrictEqual(Array.from(back.bytes), Array.from(plain), 'round trip failed at n=' + n);
            assert.deepStrictEqual(back.meta, META, 'meta must survive');
        }
    });
    await t('the declared size matches the real one exactly', async () => {
        const metaLen = Buffer.byteLength(JSON.stringify(META));
        for (const n of [0, 100, 4 * 1024 * 1024 + 1, 12 * 1024 * 1024]) {
            const sealed = await C.encryptFileBytes(DEK, C.getRandom(n), CTX, META);
            assert.strictEqual(sealed.length, C.encryptedFileSize(n, metaLen),
                'encryptedFileSize must be exact at n=' + n + ' (upload declares it before encrypting)');
        }
    });
    await t('the header is readable without a key', async () => {
        const sealed = await C.encryptFileBytes(DEK, C.getRandom(5000), CTX, META);
        const h = C.readFileHeader(sealed);
        assert.strictEqual(h.version, 2);
        assert.strictEqual(h.plainLen, 5000);
        assert.deepStrictEqual(h.meta, META);
    });
    await t('a plain file is not mistaken for an encrypted one', () => {
        assert.strictEqual(C.isEncryptedFile(enc('%PDF-1.7 ...')), false);
        assert.strictEqual(C.isEncryptedFile(new Uint8Array(0)), false);
        assert.strictEqual(C.isEncryptedFile(new Uint8Array(10)), false);
    });
    await t('a multi-chunk file really is chunked', async () => {
        const sealed = await C.encryptFileBytes(DEK, C.getRandom(10 * 1024 * 1024), CTX, META);
        assert.strictEqual(C.readFileHeader(sealed).count, 3);
    });

    const container = await C.encryptFileBytes(DEK, enc('the confidential contract text'), CTX, META);

    await mustThrow('a flipped ciphertext byte fails', async () => {
        const bad = Uint8Array.from(container); bad[bad.length - 5] ^= 1;
        await C.decryptFileBytes(DEK, bad, CTX);
    });
    await mustThrow('a container moved to another record fails', async () => {
        await C.decryptFileBytes(DEK, container, Object.assign({}, CTX, { recordId: 'VQrec0002' }));
    });
    await mustThrow('a container moved to another project fails', async () => {
        await C.decryptFileBytes(DEK, container, Object.assign({}, CTX, { service: 'other' }));
    });
    await mustThrow('a container claimed by another record owner fails', async () => {
        await C.decryptFileBytes(DEK, container, Object.assign({}, CTX, { recordOwner: 'bob' }));
    });
    await mustThrow('a wrong data key fails', async () => {
        await C.decryptFileBytes(C.getRandom(32), container, CTX);
    });
    await mustThrow('truncating the container fails', async () => {
        await C.decryptFileBytes(DEK, container.subarray(0, container.length - 20), CTX);
    });
    await mustThrow('a tampered chunk count fails', async () => {
        const bad = Uint8Array.from(container); bad[15] = 9;
        await C.decryptFileBytes(DEK, bad, CTX);
    });
    await mustThrow('a tampered fileId fails', async () => {
        const bad = Uint8Array.from(container); bad[16] ^= 0xff;
        await C.decryptFileBytes(DEK, bad, CTX);
    });
    await mustThrow('a tampered plainLen fails', async () => {
        const bad = Uint8Array.from(container); bad[39] ^= 0xff;
        await C.decryptFileBytes(DEK, bad, CTX);
    });
    await mustThrow('TAMPERED META is rejected (the filename is authenticated)', async () => {
        const bad = Uint8Array.from(container);
        const h = C.readFileHeader(container);
        // flip a byte inside the meta JSON
        bad[56 + 8] ^= 0x01;
        await C.decryptFileBytes(DEK, bad, CTX);
    });
    await mustThrow('a bad magic is refused', async () => {
        const bad = Uint8Array.from(container); bad[0] = 0x58;
        await C.decryptFileBytes(DEK, bad, CTX);
    });
    await mustThrow('a future container version is refused', async () => {
        const bad = Uint8Array.from(container); bad[6] = 9;
        await C.decryptFileBytes(DEK, bad, CTX);
    });

    await t('A ROLLED DATA KEY is reported as stale, not as corruption', async () => {
        // dropRecipientsAndRoll mints a fresh DEK on revoke. A file that was not
        // re-keyed in that flow must say so, or an interrupted revoke is
        // indistinguishable from a tampered file.
        try {
            await C.decryptFileBytes(C.getRandom(32), container, CTX);
            assert.fail('should have thrown');
        }
        catch (e) {
            assert.strictEqual(e.code, 'ENCRYPTION_FILE_STALE_KEY', 'got: ' + e.code + ' / ' + e.message);
        }
    });

    await t('CHUNK REORDER is rejected', async () => {
        const small = 16;
        const plain = C.getRandom(small * 3);
        const sealed = await C.encryptFileBytes(DEK, plain, CTX, undefined, small);
        const H = C.readFileHeader(sealed).headerLen;
        const rec = 4 + 12 + small + 16;
        const swapped = Uint8Array.from(sealed);
        swapped.set(sealed.subarray(H + rec, H + 2 * rec), H);
        swapped.set(sealed.subarray(H, H + rec), H + rec);
        await assert.rejects(() => C.decryptFileBytes(DEK, swapped, CTX));
    });

    console.log(`\n${pass}/${total} passed`);
    if (pass !== total) process.exitCode = 1;
})();
