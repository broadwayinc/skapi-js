/**
 * Client-side encryption for private record data.
 *
 * WHAT THIS DOES: when a record is written to `access_group: 'private'` and the
 * feature is enabled, the value of the record's `data` attribute is sealed with
 * AES-256-GCM before it leaves the browser, and opened again on read. Nothing
 * else about the record changes: record_id, unique_id, index name and value,
 * tags, reference, bin files and timestamps are all still plaintext, because
 * every query path in the SDK depends on them.
 *
 * WHAT THIS BUYS, stated exactly and without inflation: a service provider who
 * dumps DynamoDB, the storage bucket and every request log cannot recover a
 * private record's `data` without a successful offline guess against the user's
 * password. That is the whole claim. It is bounded by password entropy, because
 * WebCrypto offers only PBKDF2 (no Argon2id, no memory hardness) and because
 * validator.Password permits six characters. Read the limitations in the
 * documentation before promising a customer anything stronger.
 *
 * WHERE STATE LIVES: in a module-level WeakMap keyed by the Skapi instance,
 * never in an instance field. src/main/skapi.ts does
 * `for (let k in restore) { this[k] = restore[k]; }` over a sessionStorage blob
 * that any same-origin script can write, so anything reachable as `this.<key>`
 * is attacker-assignable. Key material must not be.
 */

import SkapiError from '../main/error';
import { encodeUtf8, decodeUtf8 } from '../utils/utils';
import {
    ENC_V,
    PBKDF2_ITERATIONS,
    RECOVERY_BYTES,
    b64uFromBytes,
    b64uToBytes,
    canonicalAad,
    cryptoAvailable,
    decodeRecoveryCode,
    deriveKek,
    deriveRecoveryKey,
    encodeRecoveryCode,
    fingerprint,
    generateAesGcm,
    generateIdentity,
    getRandom,
    importAesGcm,
    importIdentityPriv,
    openGcm,
    recipientAad,
    sealGcm,
    unwrapEcdhEs,
    wrapEcdhEs,
    zeroize,
    encryptFileBytes,
    decryptFileBytes,
    isEncryptedFile,
    encryptedFileSize
} from '../utils/crypto';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Reserved table holding every user's keyring. Never itself encrypted. */
export const KEYRING_TABLE = 'skapi__keyring';

/** Reserved top-level key marking an encrypted payload. Joins __json__/__data__. */
export const ENC_MARKER = '__skapi_enc__';

/** Envelope format version. */
const ENVELOPE_V = 1;

const IDB_NAME = 'skapi-enc';
const IDB_STORE = 'keys';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type EncryptionConfig = {
    enabled: boolean;
    iterations: number;
    /** 'tofu' pins a peer key on first sight; 'strict' requires a prior pin. */
    trustPolicy: 'tofu' | 'strict';
    /** Persist the master key to IndexedDB so a page reload stays unlocked. */
    persistDevice: boolean;
    /** Refuse to enroll a password shorter than this. 0 disables the check. */
    minPasswordLength: number;
    /**
     * What `record.data` becomes when this session cannot decrypt it.
     * 'null' (default) keeps `if (record.data)` working as a data test.
     * 'sentinel' returns a self-describing frozen marker instead, which is
     * unambiguous but TRUTHY, so those guards stop working.
     */
    withheld: 'null' | 'sentinel';
    /**
     * Issue a one-time recovery code at enrollment. 'code' (default) is the
     * only thing standing between a forgotten password and permanent data loss,
     * because a password RESET proves control of an email address, not
     * knowledge of the old password, so there is nothing to unwrap the master
     * key with. 'none' opts out and accepts that.
     */
    recovery: 'code' | 'none';
    table: string;
};

type Wrap = { t: 'mk'; iv: string; ct: string } | { t: 'ecdh'; epk: string; iv: string; ct: string; fpr: string };

type Envelope = {
    [ENC_MARKER]: number;
    enc: string;
    kw: string;
    anch: 'uid' | 'rid' | 'new';
    uid: string;
    rid: string;
    own: string;
    iv: string;
    ct: string;
    k: Record<string, Wrap>;
};

type DekEntry = {
    bytes: Uint8Array;
    key: CryptoKey;
    recipients: Record<string, Wrap>;
    anch: 'uid' | 'rid' | 'new';
    uid: string;
    rid: string;
    own: string;
    access_group: 'private' | number;
};

type EncState = {
    cfg: EncryptionConfig;
    status: 'disabled' | 'locked' | 'unlocked';
    reason: string;
    user_id: string;
    scope: string;
    mk: CryptoKey | null;
    ikPriv: CryptoKey | null;
    pubRaw: Uint8Array | null;
    fpr: string;
    keyringRecordId: string;
    pins: Record<string, string>;
    /** record_id -> DEK material, so grant/revoke/update need no extra read. */
    dek: Map<string, DekEntry>;
    /** record_ids whose next encrypt MUST mint a fresh data key (revocation). */
    roll: Set<string>;
    /**
     * Resolves when the device-store unlock attempt has finished. Read and
     * write hooks wait on it so an app call issued during page bootstrap does
     * not see a spuriously locked session. NEVER awaited while `unlocking` is
     * true: the unlock itself issues a getRecords, and waiting on itself is
     * how the first version of this deadlocked the whole SDK.
     */
    ready: Promise<void> | null;
    unlocking: boolean;
    /**
     * A recovery code that has just been minted and NOT yet handed to the app.
     * One-shot: takeRecoveryCode() returns it and clears it. Held only in
     * memory, never written anywhere, and never recoverable afterwards -- if it
     * could be fetched again later, this SDK would be holding the key.
     */
    pendingRecoveryCode: string;
    peerPub: Map<string, { pubRaw: Uint8Array; fpr: string }>;
    peerInflight: Map<string, Promise<any>>;
};

export type RecordEncryptionInfo = {
    status: 'encrypted' | 'failed';
    reason?: string;
    recipients?: string[];
};

const ENC = new WeakMap<any, EncState>();

/* ------------------------------------------------------------------ *
 * Config / state
 * ------------------------------------------------------------------ */

export function parseEncryptionOptions(raw: any): EncryptionConfig | null {
    if (!raw) {
        return null;
    }
    if (raw === true) {
        raw = {};
    }
    if (typeof raw !== 'object') {
        throw new SkapiError('"options.encryption" should be a boolean or an object.', { code: 'INVALID_PARAMETER' });
    }

    let iterations = typeof raw.iterations === 'number' ? raw.iterations : PBKDF2_ITERATIONS;
    if (iterations < 100000) {
        throw new SkapiError('"encryption.iterations" must be at least 100000.', { code: 'INVALID_PARAMETER' });
    }

    let trustPolicy = raw.trustPolicy === 'strict' ? 'strict' : 'tofu';

    return {
        enabled: true,
        iterations,
        trustPolicy: trustPolicy as 'tofu' | 'strict',
        persistDevice: raw.persistDevice === false ? false : true,
        minPasswordLength: typeof raw.minPasswordLength === 'number' ? raw.minPasswordLength : 0,
        withheld: raw.withheld === 'sentinel' ? 'sentinel' : 'null',
        recovery: raw.recovery === 'none' ? 'none' : 'code',
        table: typeof raw.table === 'string' && raw.table ? raw.table : KEYRING_TABLE
    };
}

/** First line of every hook. Returns null fast when encryption is off. */
export function encState(this: any): EncState | null {
    return ENC.get(this) || null;
}

export function initEncryption(this: any, cfg: EncryptionConfig | null): void {
    if (!cfg) {
        ENC.delete(this);
        return;
    }
    ENC.set(this, {
        cfg,
        status: 'locked',
        reason: 'NO_SESSION_KEY',
        user_id: '',
        scope: '',
        mk: null,
        ikPriv: null,
        pubRaw: null,
        fpr: '',
        keyringRecordId: '',
        pins: {},
        dek: new Map(),
        roll: new Set(),
        ready: null,
        unlocking: false,
        pendingRecoveryCode: '',
        peerPub: new Map(),
        peerInflight: new Map()
    });
}

/** Wipe every key and cached DEK. Called on logout and on lockEncryption(). */
export function clearEncryptionState(this: any): void {
    let s = encState.call(this);
    if (!s) {
        return;
    }

    // Take the persisted master key with it. Leaving it in IndexedDB meant the
    // next person to use the browser could reach the previous user's keys
    // simply by logging in as them without their password, which is exactly the
    // property logging out is supposed to remove.
    if (s.user_id) {
        deleteDevice.call(this, s).catch(() => { });
    }

    s.ready = null;
    s.unlocking = false;
    s.pendingRecoveryCode = '';
    for (let [, entry] of s.dek) {
        zeroize(entry.bytes);
    }
    s.dek.clear();
    s.roll.clear();
    s.peerPub.clear();
    s.peerInflight.clear();
    s.pins = {};
    s.mk = null;
    s.ikPriv = null;
    s.pubRaw = null;
    s.fpr = '';
    s.keyringRecordId = '';
    s.user_id = '';
    s.status = 'locked';
    s.reason = 'NO_SESSION_KEY';
}

export function getEncryptionStatus(this: any): { status: string; reason?: string; user_id?: string; fingerprint?: string } {
    let s = encState.call(this);
    if (!s) {
        return { status: 'disabled' };
    }
    return {
        status: s.status,
        reason: s.status === 'unlocked' ? undefined : s.reason,
        user_id: s.user_id || undefined,
        fingerprint: s.fpr || undefined
    };
}

function isEncTable(s: EncState, tableName: any): boolean {
    return typeof tableName === 'string' && tableName === s.cfg.table;
}

/**
 * The project this instance's encryption is bound to.
 *
 * Deliberately ignores per-call service/owner overrides. The scope goes into
 * the KEK derivation AND every AAD, so if a write used one project and a read
 * resolved another, the record would be permanently undecryptable. Encryption
 * is therefore scoped to the instance's own project, and a cross-project
 * encrypted write is refused outright rather than silently corrupted.
 */
function scopeOf(this: any): string {
    return `${this.service}/${this.owner}`;
}

/* ------------------------------------------------------------------ *
 * AAD
 * ------------------------------------------------------------------ */

function payloadAad(scope: string, own: string, anch: string, anchor: string): Uint8Array {
    let [service, owner] = scope.split('/');
    return canonicalAad([ENC_V, service, owner, own, anch, anchor]);
}

function wrapInfo(scope: string, anchor: string, own: string, recipient: string, fpr: string): Uint8Array {
    let [service, owner] = scope.split('/');
    return encodeUtf8(`${ENC_V}|dekwrap|${service}|${owner}|${anchor}|${own}|${recipient}|${fpr}`);
}

function anchorOf(env: { anch: string; uid: string; rid: string }): string {
    return env.anch === 'uid' ? env.uid : env.anch === 'rid' ? env.rid : '';
}

/* ------------------------------------------------------------------ *
 * Envelope detection
 * ------------------------------------------------------------------ */

/**
 * Is this value an encryption envelope?
 *
 * Deliberately as conservative as the existing '!D%{}' / __json__ / __data__
 * guards in normalizeRecord: a value that merely looks like a marker but is not
 * shaped like one must fall through and be returned verbatim, because it is
 * somebody's real data.
 */
export function isEnvelope(v: any): v is Envelope {
    return !!v
        && typeof v === 'object'
        && !Array.isArray(v)
        && typeof v[ENC_MARKER] === 'number'
        && typeof v.ct === 'string'
        && typeof v.iv === 'string'
        && typeof v.own === 'string'
        && typeof v.anch === 'string'
        && !!v.k
        && typeof v.k === 'object'
        && !Array.isArray(v.k);
}


/** Marker key on the withheld-data sentinel. Reserved in record data. */
export const NO_ACCESS_MARKER = '__skapi_no_access__';

/**
 * The value `record.data` takes when this session cannot decrypt it, under
 * `withheld: 'sentinel'`.
 *
 * Frozen so nothing can patch it into looking like real data, and
 * self-describing so a value that leaks into a render reads as a marker rather
 * than as plausible content. It carries its own reason, so the common check
 * needs only `record.data` and not a second field.
 *
 * It is TRUTHY, because every JS object is. That is the whole cost of this
 * option: `if (record.data)` stops being a valid "do I have data" test. That is
 * why 'null' remains the default.
 */
function withheldValue(cfg: EncryptionConfig, reason: string, recipients?: string[]): any {
    if (cfg.withheld !== 'sentinel') {
        return null;
    }
    let v: Record<string, any> = { [NO_ACCESS_MARKER]: true, reason };
    if (recipients) {
        v.recipients = recipients;
    }
    return Object.freeze(v);
}

/** True when a value is the withheld-data sentinel. */
export function isWithheld(this: any, value: any): boolean {
    return !!value && typeof value === 'object' && (value as any)[NO_ACCESS_MARKER] === true;
}

/* ------------------------------------------------------------------ *
 * WRITE PATH
 * ------------------------------------------------------------------ */

/**
 * Decide the access group this write lands on.
 *
 * Returns 'private' when the payload must be encrypted, or a number when it
 * must be written in the clear. Encryption is driven entirely by this, so a
 * wrong answer either leaks plaintext or strands ciphertext in a record nobody
 * can read. When the caller omits `table` on an update the group is whatever
 * the record already has, so we resolve it rather than guess: from the DEK
 * cache if this instance has already touched the record, otherwise with one
 * getRecords.
 */
async function resolveWriteGroup(
    this: any,
    s: EncState,
    rawConfig: any,
    resolvedId: string
): Promise<{ group: 'private' | number; table: string; record: any }> {
    let table = rawConfig?.table;
    let tableName = typeof table === 'string' ? table : table?.name;

    if (table && (typeof table === 'string' || table.access_group !== undefined)) {
        let group = typeof table === 'string' ? 0 : normalizeGroup(table.access_group);
        return { group, table: tableName, record: null };
    }

    // Table omitted or partial. On a create that means access_group 0 (the
    // accessGroup validator's default), which is not private, so nothing to do.
    if (!resolvedId) {
        return {
            group: table?.access_group !== undefined ? normalizeGroup(table.access_group) : 0,
            table: tableName,
            record: null
        };
    }

    // Update with no stated group: resolve the record's real one.
    let cached = s.dek.get(resolvedId);
    if (cached) {
        return { group: cached.access_group, table: tableName, record: null };
    }

    let rec = await readOwnRecord.call(this, resolvedId);
    if (!rec) {
        throw new SkapiError(`Record "${resolvedId}" not found.`, { code: 'NOT_EXISTS' });
    }
    return { group: rec.table.access_group, table: rec.table.name, record: rec };
}

/**
 * Read one record by record_id OR unique_id.
 *
 * postRecord accepts a unique_id in the `record_id` slot, but getRecords
 * validates `record_id` as alphanumeric-only, so passing a unique_id such as
 * "src::folder/file.pdf" straight through throws INVALID_PARAMETER. Route by
 * shape instead, so enabling encryption never breaks a call that works today.
 */
async function readOwnRecord(this: any, id: string): Promise<any | null> {
    let query = /^[a-zA-Z0-9]+$/.test(id) ? { record_id: id } : { unique_id: id };
    let res = await this.getRecords(query, { limit: 1 });
    return res?.list?.[0] || null;
}

function normalizeGroup(v: any): 'private' | number {
    if (v === 'private' || v === '**') {
        return 'private';
    }
    if (v === 'public') {
        return 0;
    }
    if (v === 'authorized') {
        return 1;
    }
    if (v === 'admin') {
        return 99;
    }
    return typeof v === 'number' ? v : 0;
}

/**
 * Seal the caller's data if this write is a private one.
 *
 * NEVER mutates its input: the caller keeps the object they handed us, and
 * postRecord restores `plain` onto the returned record so the round trip is
 * transparent.
 */
export async function maybeEncrypt(
    this: any,
    value: any,
    rawConfig: any,
    hasData: boolean
): Promise<{ send: any; plain: any; encrypted: boolean; omit: boolean; dek?: DekEntry }> {
    let s = encState.call(this);
    if (!s) {
        return { send: value, plain: value, encrypted: false, omit: false };
    }

    // `record_id` may actually be a unique_id: postRecord documents that, and
    // setupPostRecordConfig resolves it from a local cache when it can. Resolve
    // it the same way here, because the DEK cache is keyed by the REAL
    // record_id and the envelope anchor must be the real identifier too.
    let rawId: string = rawConfig?.record_id || '';
    let resolvedId = rawId;
    let unique_id: string = rawConfig?.unique_id || '';

    let { group, table, record } = await resolveWriteGroup.call(this, s, rawConfig, resolvedId);

    // Not private: write in the clear. This is the declassification path.
    if (group !== 'private') {
        if (resolvedId) {
            let old = s.dek.get(resolvedId);
            if (old) {
                zeroize(old.bytes);
                s.dek.delete(resolvedId);
            }
        }

        // Declassifying without restating the payload used to be refused,
        // because leaving the ciphertext in a record the read path no longer
        // inspects strands it forever. Refusing was unnecessary: while the
        // record is still private WE CAN STILL READ IT, so decrypt it here and
        // hand the plaintext to the same write that changes the group. One
        // extra read, and if the write fails nothing changed.
        if (!hasData && rawId) {
            let current = record || await readOwnRecord.call(this, rawId);
            if (current && current.encrypted) {
                if (current.encrypted.status === 'failed') {
                    throw new SkapiError(
                        `Cannot make record "${rawId}" non-private: its current contents could not be decrypted ` +
                        `(${current.encrypted.reason}), so they cannot be written back in the clear. ` +
                        `Unlock encryption, or supply the record's data with the access group change.`,
                        { code: 'ENCRYPTION_LOCKED' }
                    );
                }
                return { send: current.data, plain: current.data, encrypted: false, omit: false };
            }
        }

        // No payload and nothing to decrypt: omit the key so the server keeps
        // whatever is stored. `null` is NOT this case; it is a real value.
        return { send: value, plain: value, encrypted: false, omit: !hasData };
    }

    // The keyring itself is never encrypted, and must be checked BEFORE the
    // bootstrap gate below: provisioning writes the keyring, so waiting on the
    // unlock here would wait on ourselves.
    if (isEncTable(s, table)) {
        return { send: value, plain: value, encrypted: false, omit: false };
    }

    // A write issued while the page is still restoring its device key must wait
    // for that, not fail as "locked".
    if (s.ready && !s.unlocking) {
        try {
            await s.ready;
        }
        catch (err) { }
    }

    // No payload supplied. postRecord(null|undefined, config) is a documented
    // metadata-only update: with encryption off the `data` key is dropped from
    // the body and the server keeps the stored value. Encrypting `undefined`
    // here would seal a null over the record and destroy it.
    if (!hasData) {
        return { send: value, plain: value, encrypted: false, omit: true };
    }

    // Refuse to store the withheld-data sentinel. A read-modify-write by a
    // session that could not decrypt would otherwise overwrite the record with
    // the marker, destroying it: the exact failure the sentinel exists to make
    // visible.
    if (isWithheld.call(this, value)) {
        throw new SkapiError(
            'This record\'s data could not be decrypted by this session, so it cannot be written back. ' +
            'Writing it would replace the record with the placeholder.',
            { code: 'ENCRYPTION_CANNOT_REWRITE_WITHHELD' }
        );
    }

    if (s.status !== 'unlocked' || !s.mk) {
        throw new SkapiError(
            'Encryption is enabled but locked, so this private record cannot be written. ' +
            'Call unlockEncryption({ password }) first, or the user must log in with their password.',
            { code: 'ENCRYPTION_LOCKED' }
        );
    }

    if (value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, ENC_MARKER)) {
        throw new SkapiError(`"${ENC_MARKER}" is a reserved key in record data.`, { code: 'INVALID_PARAMETER' });
    }


    if ((rawConfig?.service && rawConfig.service !== this.service) || (rawConfig?.owner && rawConfig.owner !== this.owner)) {
        throw new SkapiError(
            'Encrypted records cannot be written to another project. The encryption key is derived per project, ' +
            'so a record written under one service and read under another could never be decrypted. ' +
            'Construct a separate Skapi instance for that project.',
            { code: 'INVALID_REQUEST' }
        );
    }

    let own = this.user?.user_id;
    if (!own) {
        throw new SkapiError('User login is required to write an encrypted record.', { code: 'INVALID_REQUEST' });
    }

    let scope = scopeOf.call(this);

    // A pending roll wins over everything: the whole point of a revoke is that
    // the next write must NOT reuse the key the revoked user holds.
    let rolling = false;
    if (rawId && s.roll.has(rawId)) {
        rolling = true;
        s.roll.delete(rawId);
        let stale = s.dek.get(rawId);
        s.dek.delete(rawId);
        if (stale) {
            zeroize(stale.bytes);
        }
    }

    // THE RECORD, NOT THE CACHE, IS THE SOURCE OF TRUTH FOR RECIPIENTS.
    //
    // Reading the recipient map out of an in-memory cache meant that any
    // session which had not already read the record (a page reload, a second
    // device, a different tab) wrote an envelope containing only the owner,
    // silently revoking every grantee while the backend ACL still said the
    // record was shared. On an update we therefore load the current envelope
    // unless this session already holds it.
    let entry: DekEntry | null = null;
    if (rawId && !rolling) {
        entry = s.dek.get(rawId) || null;
        if (!entry) {
            let current = record || await readOwnRecord.call(this, rawId);
            if (current) {
                resolvedId = current.record_id || rawId;
                entry = s.dek.get(resolvedId) || null;
                if (!unique_id && current.unique_id) {
                    unique_id = current.unique_id;
                }
                if (!entry && current.encrypted?.status === 'failed') {
                    throw new SkapiError(
                        `Cannot update encrypted record "${rawId}": its current contents could not be decrypted (${current.encrypted.reason}), ` +
                        `so its existing key wraps cannot be preserved. Updating anyway would revoke everyone it is shared with.`,
                        { code: 'ENCRYPTION_LOCKED' }
                    );
                }
            }
        }
    }

    if (resolvedId === rawId && entry && entry.rid) {
        resolvedId = entry.rid;
    }

    // Keep the anchor the record already has. A caller updating by record_id
    // rarely restates the unique_id, and letting the anchor flip from 'uid' to
    // 'rid' would invalidate every grantee wrap (the anchor is inside each
    // wrap's AAD) and force a full re-wrap on an ordinary update.
    if (!unique_id && entry && entry.anch === 'uid' && entry.uid) {
        unique_id = entry.uid;
    }

    let dekBytes: Uint8Array;
    let dekKey: CryptoKey;
    let recipients: Record<string, Wrap>;

    if (entry) {
        dekBytes = entry.bytes;
        dekKey = entry.key;
        recipients = Object.assign({}, entry.recipients);
    }
    else {
        let gen = await generateAesGcm();
        dekBytes = gen.bytes;
        dekKey = gen.key;
        recipients = {};
    }

    // Anchor selection. The anchor is bound into the AAD so an envelope cannot
    // be transplanted onto another record. On a create the server has not
    // minted a record_id yet and we refuse to burn a unique_id on the caller's
    // behalf, so a create uses the 'new' anchor and is re-anchored on its first
    // update.
    let anch: 'uid' | 'rid' | 'new' = unique_id ? 'uid' : resolvedId ? 'rid' : 'new';
    let anchor = anch === 'uid' ? unique_id : anch === 'rid' ? resolvedId : '';
    let aad = payloadAad(scope, own, anch, anchor);

    let ownerAad = recipientAad(aad, own, 'mk');
    let ownerSealed = await sealGcm(s.mk, dekBytes, ownerAad);
    recipients[own] = { t: 'mk', iv: b64uFromBytes(ownerSealed.iv), ct: b64uFromBytes(ownerSealed.ct) };

    // Every grantee wrap binds the anchor, so a changed anchor invalidates them
    // all and they have to be rebuilt.
    if (entry && (entry.anch !== anch || anchorOf(entry) !== anchor)) {
        recipients = await rewrapAll.call(this, s, dekBytes, recipients, scope, own, anch, anchor, aad);
    }

    let plaintext = encodeUtf8(JSON.stringify(value === undefined ? null : value));
    let sealed = await sealGcm(dekKey, plaintext, aad);
    zeroize(plaintext);

    let envelope: Envelope = {
        [ENC_MARKER]: ENVELOPE_V,
        enc: 'A256GCM',
        kw: 'ECDH-ES+A256GCM',
        anch,
        uid: unique_id,
        rid: resolvedId,
        own,
        iv: b64uFromBytes(sealed.iv),
        ct: b64uFromBytes(sealed.ct),
        k: recipients
    };

    let envSize = JSON.stringify(envelope).length;
    if (envSize > 2 * 1024 * 1024) {
        throw new SkapiError(
            `Encrypted record data is too large: once encrypted and base64 encoded it becomes ${envSize} bytes, ` +
            `over the ${2 * 1024 * 1024} byte limit. Encryption costs about 33% plus roughly 230 bytes per additional recipient.`,
            { code: 'ENCRYPTED_DATA_TOO_LARGE' }
        );
    }

    if (resolvedId) {
        s.dek.set(resolvedId, {
            bytes: dekBytes,
            key: dekKey,
            recipients,
            anch,
            uid: unique_id,
            rid: resolvedId,
            own,
            access_group: 'private'
        });
    }

    return {
        send: envelope,
        plain: value,
        encrypted: true,
        omit: false,
        dek: { bytes: dekBytes, key: dekKey, recipients, anch, uid: unique_id, rid: resolvedId, own, access_group: 'private' }
    };
}

/**
 * Bind a data key to the record_id the server just minted.
 *
 * On a CREATE there is no record_id at encrypt time, so nothing could be
 * cached; the attachments that upload immediately afterwards would then find no
 * key and go up in the clear. postRecord calls this the moment the id is known,
 * BEFORE uploadFiles runs.
 */
export function bindRecordDek(this: any, record_id: string, entry: DekEntry | undefined): void {
    let s = encState.call(this);
    if (!s || !entry || !record_id || s.dek.has(record_id)) {
        return;
    }
    s.dek.set(record_id, Object.assign({}, entry, { rid: record_id }));
}

/** Re-wrap every non-owner recipient after the record's anchor changed. */
async function rewrapAll(
    this: any,
    s: EncState,
    dekBytes: Uint8Array,
    recipients: Record<string, Wrap>,
    scope: string,
    own: string,
    anch: string,
    anchor: string,
    aad: Uint8Array
): Promise<Record<string, Wrap>> {
    let ids = Object.keys(recipients).filter(id => id !== own);
    if (!ids.length) {
        return recipients;
    }

    let peers = await getPeerPublicKeys.call(this, ids);
    let out: Record<string, Wrap> = { [own]: recipients[own] };

    for (let id of ids) {
        let peer = peers[id];
        if (!peer) {
            continue;
        }
        out[id] = await wrapFor.call(this, dekBytes, peer, scope, anchor, own, id, aad);
    }
    return out;
}

async function wrapFor(
    this: any,
    dekBytes: Uint8Array,
    peer: { pubRaw: Uint8Array; fpr: string },
    scope: string,
    anchor: string,
    own: string,
    recipient: string,
    aad: Uint8Array
): Promise<Wrap> {
    let info = wrapInfo(scope, anchor, own, recipient, peer.fpr);
    let rAad = recipientAad(aad, recipient, peer.fpr);
    let w = await wrapEcdhEs(peer.pubRaw, dekBytes, info, rAad);
    return { t: 'ecdh', epk: b64uFromBytes(w.epk), iv: b64uFromBytes(w.iv), ct: b64uFromBytes(w.ct), fpr: peer.fpr };
}

/* ------------------------------------------------------------------ *
 * READ PATH
 * ------------------------------------------------------------------ */

/**
 * Open an envelope, or explain why not.
 *
 * TOTAL: every path returns a value and nothing throws. A page of 50 records
 * where one is undecryptable must still resolve, with that one record carrying
 * a flag, rather than rejecting the whole getRecords.
 */
export async function maybeDecrypt(
    this: any,
    raw: any,
    ctx: { access_group: any; table_name: string; user_id: string; record_id: string; unique_id: string }
): Promise<{ value: any; flag?: RecordEncryptionInfo }> {
    if (!isEnvelope(raw)) {
        return { value: raw };
    }

    // Only ever inspect private records, so a public record whose data happens
    // to contain __skapi_enc__ is never touched.
    if (ctx.access_group !== 'private') {
        return { value: raw };
    }

    let s = encState.call(this);
    if (!s) {
        // Encryption is off but this private record is encrypted. Do NOT hand
        // the envelope to app logic as if it were the record's data. No config
        // exists on this path, so the sentinel is not an option here.
        return { value: null, flag: { status: 'failed', reason: 'ENCRYPTION_DISABLED' } };
    }
    if (isEncTable(s, ctx.table_name)) {
        return { value: raw };
    }

    if (raw[ENC_MARKER] !== ENVELOPE_V) {
        return { value: withheldValue(s.cfg, 'UNSUPPORTED_VERSION'), flag: { status: 'failed', reason: 'UNSUPPORTED_VERSION' } };
    }

    // Wait for the device-store unlock before declaring the session locked.
    // Skipped while the unlock is itself in flight: that path issues its own
    // getRecords, and waiting on it here would be waiting on ourselves.
    if (s.ready && !s.unlocking) {
        try {
            await s.ready;
        }
        catch (err) { }
    }

    // Binding cross-check against the record the server actually returned.
    // This is what catches an envelope moved between records by the backend.
    if (raw.own !== ctx.user_id) {
        return { value: withheldValue(s.cfg, 'BINDING_MISMATCH'), flag: { status: 'failed', reason: 'BINDING_MISMATCH' } };
    }
    if (raw.uid && ctx.unique_id && raw.uid !== ctx.unique_id) {
        return { value: withheldValue(s.cfg, 'BINDING_MISMATCH'), flag: { status: 'failed', reason: 'BINDING_MISMATCH' } };
    }
    if (raw.rid && ctx.record_id && raw.rid !== ctx.record_id) {
        return { value: withheldValue(s.cfg, 'BINDING_MISMATCH'), flag: { status: 'failed', reason: 'BINDING_MISMATCH' } };
    }

    // Recipient membership BEFORE the lock check, deliberately: it is a map
    // lookup that needs no key, and the two answers are not interchangeable.
    // "you are not on the list" is true whether or not this session is
    // unlocked, and it is actionable in a way NO_SESSION_KEY is not: unlocking
    // will never help. A MASTER reading another user's private record lands
    // here, and telling it "unlock your session" would be a lie.
    let me = this.user?.user_id;
    let wrap = me ? raw.k[me] : null;
    if (!wrap) {
        return { value: withheldValue(s.cfg, 'NOT_A_RECIPIENT', Object.keys(raw.k)), flag: { status: 'failed', reason: 'NOT_A_RECIPIENT', recipients: Object.keys(raw.k) } };
    }

    // A recipient, but this session holds no key yet: unlocking WILL help.
    if (s.status !== 'unlocked' || !s.mk) {
        return { value: withheldValue(s.cfg, 'NO_SESSION_KEY'), flag: { status: 'failed', reason: 'NO_SESSION_KEY' } };
    }

    let scope = scopeOf.call(this);
    let anchor = anchorOf(raw);
    let aad = payloadAad(scope, raw.own, raw.anch, anchor);

    let dekBytes: Uint8Array;
    try {
        if (wrap.t === 'mk') {
            dekBytes = await openGcm(s.mk, b64uToBytes(wrap.iv), b64uToBytes(wrap.ct), recipientAad(aad, me, 'mk'));
        }
        else if (wrap.t === 'ecdh') {
            if (!s.ikPriv) {
                return { value: withheldValue(s.cfg, 'NO_SESSION_KEY'), flag: { status: 'failed', reason: 'NO_SESSION_KEY' } };
            }
            dekBytes = await unwrapEcdhEs(
                s.ikPriv,
                b64uToBytes(wrap.epk),
                b64uToBytes(wrap.iv),
                b64uToBytes(wrap.ct),
                wrapInfo(scope, anchor, raw.own, me, wrap.fpr),
                recipientAad(aad, me, wrap.fpr)
            );
        }
        else {
            return { value: withheldValue(s.cfg, 'UNSUPPORTED_VERSION'), flag: { status: 'failed', reason: 'UNSUPPORTED_VERSION' } };
        }
    }
    catch (err) {
        return { value: withheldValue(s.cfg, 'BAD_KEY'), flag: { status: 'failed', reason: 'BAD_KEY' } };
    }

    let plaintext: Uint8Array;
    let dekKey: CryptoKey;
    try {
        dekKey = await importAesGcm(dekBytes);
        plaintext = await openGcm(dekKey, b64uToBytes(raw.iv), b64uToBytes(raw.ct), aad);
    }
    catch (err) {
        zeroize(dekBytes);
        return { value: withheldValue(s.cfg, 'CORRUPT'), flag: { status: 'failed', reason: 'CORRUPT' } };
    }

    let out: any;
    try {
        out = JSON.parse(decodeUtf8(plaintext));
    }
    catch (err) {
        zeroize(plaintext);
        zeroize(dekBytes);
        return { value: withheldValue(s.cfg, 'CORRUPT'), flag: { status: 'failed', reason: 'CORRUPT' } };
    }
    zeroize(plaintext);

    // Cache the DEK so a later update, grant or revoke on this record needs no
    // extra read. Only the owner's DEK is cached: a grantee holds one too, but
    // a grantee cannot write the record anyway.
    // Cached for the OWNER and for every GRANTEE. Only owners were cached
    // originally, on the reasoning that a grantee cannot write the record
    // anyway; that was true until files arrived, and a grantee needs the data
    // key to open them. `own` still records who the owner is, so the write
    // paths can keep refusing non-owners.
    if (ctx.record_id) {
        // Update the EXISTING entry in place rather than replacing it, and
        // never zeroize the buffer it holds. addRecipients and the roll path
        // both keep a reference to an entry across a read, so wiping the old
        // buffer here would blank the data key mid-grant and seal the record
        // under all zeros. Reuse also keeps the entry's identity stable, which
        // is what lets those callers mutate `recipients` and have the write
        // path see it.
        let prev = s.dek.get(ctx.record_id);
        if (prev) {
            // Adopt the key material we just recovered, not only the wraps.
            // Keeping the old bytes while taking the server's newer recipient
            // map produced an entry describing DEK-new with DEK-old's bytes, so
            // the next write sealed the payload under a key none of the stored
            // wraps opened. Mutate in place rather than replacing the object:
            // addRecipients and the roll path hold a reference across a read.
            // The old buffer is deliberately NOT zeroized, because a caller may
            // still be holding it.
            prev.bytes = dekBytes;
            prev.key = dekKey;
            prev.recipients = raw.k;
            prev.anch = raw.anch;
            prev.uid = raw.uid;
            prev.own = raw.own;
            prev.access_group = 'private';
        }
        else {
            s.dek.set(ctx.record_id, {
                bytes: dekBytes,
                key: dekKey,
                recipients: raw.k,
                anch: raw.anch,
                uid: raw.uid,
                rid: ctx.record_id,
                own: raw.own,
                access_group: 'private'
            });
        }
    }
    else {
        zeroize(dekBytes);
    }

    return { value: out, flag: { status: 'encrypted', recipients: Object.keys(raw.k) } };
}

/* ------------------------------------------------------------------ *
 * KEYRING
 * ------------------------------------------------------------------ */

function kekInfo(scope: string, user_id: string): Uint8Array {
    let [service, owner] = scope.split('/');
    return encodeUtf8(`${ENC_V}|kek|${service}|${owner}|${user_id}`);
}

function mkAad(scope: string, user_id: string, iterations: number, salt: string): Uint8Array {
    let [service, owner] = scope.split('/');
    // Iterations and salt are inside the AAD so a provider cannot downgrade the
    // stored iteration count to make an offline attack cheaper: a tampered
    // count fails the GCM tag instead of silently weakening the derivation.
    return encodeUtf8(`${ENC_V}|mk|${service}|${owner}|${user_id}|PBKDF2-SHA256|${iterations}|${salt}`);
}

function recoveryInfo(scope: string, user_id: string): Uint8Array {
    let [service, owner] = scope.split('/');
    return encodeUtf8(`${ENC_V}|recovery|${service}|${owner}|${user_id}`);
}

function recoveryAad(scope: string, user_id: string, salt: string): Uint8Array {
    let [service, owner] = scope.split('/');
    return encodeUtf8(`${ENC_V}|rk|${service}|${owner}|${user_id}|HKDF-SHA256|${salt}`);
}

function selfAad(scope: string, user_id: string): Uint8Array {
    let [service, owner] = scope.split('/');
    return encodeUtf8(`${ENC_V}|self|${service}|${owner}|${user_id}`);
}

function ikAad(scope: string, user_id: string): Uint8Array {
    let [service, owner] = scope.split('/');
    return encodeUtf8(`${ENC_V}|ik|${service}|${owner}|${user_id}`);
}

/** Read this user's own keyring record, or null when they have none yet. */
async function readKeyring(this: any, s: EncState): Promise<any | null> {
    let res = await this.getRecords({
        table: { name: s.cfg.table, access_group: 'private' },
        index: { name: '$user_id', value: this.user.user_id, condition: '=' }
    }, { limit: 2 });

    let list = (res?.list || []).filter((r: any) => r.user_id === this.user.user_id);
    if (!list.length) {
        return null;
    }
    // Two keyrings is an anomaly worth surfacing rather than silently picking
    // one: take the oldest, which is the one records were encrypted against.
    list.sort((a: any, b: any) => a.uploaded - b.uploaded);
    return list[0];
}

/**
 * Create this user's keyring. Runs once per user per project, at the first
 * login after the feature is enabled.
 */

/**
 * Mint a recovery code and the wrap that lets it open the master key.
 *
 * The code is generated HERE, in the browser, from crypto.getRandomValues, and
 * is returned to the caller for display. It is never transmitted: only the
 * wrap goes to the server, and that wrap is exactly as safe to store as the
 * password wrap beside it. If the server ever generated or received this code,
 * the provider would hold the key and the whole guarantee would be void.
 */
async function mintRecoveryWrap(scope: string, user_id: string, mkBytes: Uint8Array): Promise<{ code: string; wrap: any }> {
    let raw = getRandom(RECOVERY_BYTES);
    let code = encodeRecoveryCode(raw);

    let salt = getRandom(16);
    let saltB64 = b64uFromBytes(salt);
    // HKDF, not PBKDF2: see the note in utils/crypto.ts. 128 random bits need
    // no stretching, and stretching would only make recovery slow.
    let rkek = await deriveRecoveryKey(raw, salt, recoveryInfo(scope, user_id));
    let sealed = await sealGcm(rkek, mkBytes, recoveryAad(scope, user_id, saltB64));
    zeroize(raw);

    return {
        code,
        wrap: {
            id: b64uFromBytes(getRandom(6)),
            p: 'recovery',
            kdf: { a: 'HKDF-SHA256', s: saltB64 },
            iv: b64uFromBytes(sealed.iv),
            ct: b64uFromBytes(sealed.ct),
            created: Date.now()
        }
    };
}

/** Open the master key with a recovery code. Returns null if none match. */
async function openWithRecoveryCode(scope: string, user_id: string, wraps: any[], code: string): Promise<Uint8Array | null> {
    let raw = decodeRecoveryCode(code); // throws on a typo, before any crypto
    let candidates = (wraps || []).filter((w: any) => w.p === 'recovery');
    candidates.sort((a: any, b: any) => (b.created || 0) - (a.created || 0));

    for (let w of candidates) {
        try {
            let rkek = await deriveRecoveryKey(raw, b64uToBytes(w.kdf.s), recoveryInfo(scope, user_id));
            let mkBytes = await openGcm(rkek, b64uToBytes(w.iv), b64uToBytes(w.ct), recoveryAad(scope, user_id, w.kdf.s));
            zeroize(raw);
            return mkBytes;
        }
        catch (err) {
            // Wrong code for this wrap; try any older one.
        }
    }

    zeroize(raw);
    return null;
}

/** Build a fresh password wrap for the given master key bytes. */
async function mintPasswordWrap(s: EncState, scope: string, user_id: string, password: string, mkBytes: Uint8Array): Promise<any> {
    let salt = getRandom(16);
    let saltB64 = b64uFromBytes(salt);
    let kek = await deriveKek(password, salt, s.cfg.iterations, kekInfo(scope, user_id));
    let sealed = await sealGcm(kek, mkBytes, mkAad(scope, user_id, s.cfg.iterations, saltB64));
    return {
        id: b64uFromBytes(getRandom(6)),
        p: 'password',
        kdf: { a: 'PBKDF2-SHA256', it: s.cfg.iterations, s: saltB64 },
        iv: b64uFromBytes(sealed.iv),
        ct: b64uFromBytes(sealed.ct),
        created: Date.now()
    };
}

async function provisionKeyring(this: any, s: EncState, password: string): Promise<void> {
    let user_id = this.user.user_id;
    let scope = s.scope;

    let salt = getRandom(16);
    let saltB64 = b64uFromBytes(salt);
    let kek = await deriveKek(password, salt, s.cfg.iterations, kekInfo(scope, user_id));

    let mkBytes = getRandom(32);
    let mkSealed = await sealGcm(kek, mkBytes, mkAad(scope, user_id, s.cfg.iterations, saltB64));
    let mk = await importAesGcm(mkBytes);

    let ident = await generateIdentity();
    let ikSealed = await sealGcm(mk, ident.pkcs8, ikAad(scope, user_id));
    zeroize(ident.pkcs8);

    // The recovery wrap, minted while the master key bytes are still in hand.
    // After this function they are gone: MK lives on only as a non-extractable
    // CryptoKey, whose bytes cannot be read back out.
    let recovery: { code: string; wrap: any } | null = null;
    if (s.cfg.recovery === 'code') {
        recovery = await mintRecoveryWrap(scope, user_id, mkBytes);
    }

    // The master key sealed under itself, so a session holding only the
    // non-extractable CryptoKey can still recover the raw bytes when it needs
    // to mint a new wrap (rotating a recovery code, adding a recipient key).
    // Opening it requires already holding MK, so it grants nothing new.
    let selfSealed = await sealGcm(mk, mkBytes, selfAad(scope, user_id));

    zeroize(mkBytes);

    let fpr = await fingerprint(ident.pubRaw);
    let now = Date.now();

    let wraps: any[] = [{
        id: b64uFromBytes(getRandom(6)),
        p: 'password',
        kdf: { a: 'PBKDF2-SHA256', it: s.cfg.iterations, s: saltB64 },
        iv: b64uFromBytes(mkSealed.iv),
        ct: b64uFromBytes(mkSealed.ct),
        created: now
    }];
    if (recovery) {
        wraps.push(recovery.wrap);
    }

    let keyring = {
        v: 1,
        alg: 'ECDH-P-256',
        user_id,
        wraps,
        ik: { iv: b64uFromBytes(ikSealed.iv), ct: b64uFromBytes(ikSealed.ct) },
        self: { iv: b64uFromBytes(selfSealed.iv), ct: b64uFromBytes(selfSealed.ct) },
        pub: b64uFromBytes(ident.pubRaw),
        fpr,
        pins: null,
        created: now,
        updated: now
    };

    // The public directory entry goes FIRST. If the order were reversed and the
    // second post failed, the private keyring would exist, every later login
    // would find it and skip provisioning, and the user would permanently have
    // no published key: nobody could ever share a record with them. Written
    // this way round, a failure leaves no private keyring, so the next login
    // simply provisions again.
    await this.postRecord({
        v: 1,
        alg: 'ECDH-P-256',
        user_id,
        pub: b64uFromBytes(ident.pubRaw),
        fpr,
        created: now
    }, {
        table: { name: s.cfg.table, access_group: 'authorized' },
        index: { name: 'pubkey', value: user_id }
    });

    let rec = await this.postRecord(keyring, {
        table: { name: s.cfg.table, access_group: 'private' }
    });

    // Two devices logging in for the first time simultaneously can both see no
    // keyring and both create one. readKeyring resolves that by always taking
    // the OLDEST, so re-read here and adopt the winner: encrypting under a
    // keyring that later loses the tie-break would make those records
    // permanently unreadable.
    let settled = await readKeyring.call(this, s);
    if (settled && settled.record_id !== rec.record_id) {
        await unlockKeyring.call(this, s, settled, password);
        return;
    }

    s.mk = mk;
    s.ikPriv = ident.priv;
    s.pubRaw = ident.pubRaw;
    s.fpr = fpr;
    s.keyringRecordId = rec.record_id;
    // Parked for the app to collect ONCE. Set only after the keyring write
    // succeeded, so a code is never shown for a wrap that was never stored.
    if (recovery) {
        s.pendingRecoveryCode = recovery.code;
    }
    s.user_id = user_id;
    s.pins = {};
    s.status = 'unlocked';
    s.reason = '';
}

/** Open an existing keyring with the user's password. */
async function unlockKeyring(this: any, s: EncState, keyring: any, password: string): Promise<void> {
    let user_id = this.user.user_id;
    let scope = s.scope;
    let data = keyring.data;

    // Never derive keys from a keyring that is not ours. The $user_id index is
    // server-derived so this should be unreachable, but the whole identity of
    // the session hangs off this record and a cheap check costs nothing.
    if (keyring.user_id !== user_id || (data && data.user_id && data.user_id !== user_id)) {
        throw new SkapiError('The encryption keyring does not belong to this user.', { code: 'ENCRYPTION_KEYRING_CORRUPT' });
    }

    let wraps = Array.isArray(data?.wraps) ? data.wraps : [];
    let pwWraps = wraps.filter((w: any) => w.p === 'password');
    if (!pwWraps.length) {
        throw new SkapiError('The keyring has no password wrap.', { code: 'ENCRYPTION_KEYRING_CORRUPT' });
    }
    // Newest first: every failed attempt costs a full PBKDF2 run.
    pwWraps.sort((a: any, b: any) => (b.created || 0) - (a.created || 0));

    let mkBytes: Uint8Array | null = null;
    for (let w of pwWraps) {
        try {
            let salt = b64uToBytes(w.kdf.s);
            let kek = await deriveKek(password, salt, w.kdf.it, kekInfo(scope, user_id));
            mkBytes = await openGcm(kek, b64uToBytes(w.iv), b64uToBytes(w.ct), mkAad(scope, user_id, w.kdf.it, w.kdf.s));
            break;
        }
        catch (err) {
            // Wrong password for this wrap. Try the next (there is more than
            // one only mid-password-change, which is what makes that flow
            // crash-safe).
        }
    }

    if (!mkBytes) {
        throw new SkapiError('Incorrect password: the encryption keyring could not be opened.', { code: 'ENCRYPTION_BAD_PASSWORD' });
    }

    let mk = await importAesGcm(mkBytes);
    zeroize(mkBytes);

    await adoptKeyring.call(this, s, keyring, mk);
}

/** Load the identity key and pins out of a keyring record given an open MK. */
async function adoptKeyring(this: any, s: EncState, keyring: any, mk: CryptoKey): Promise<void> {
    let user_id = this.user.user_id;
    let data = keyring.data;

    let pkcs8 = await openGcm(mk, b64uToBytes(data.ik.iv), b64uToBytes(data.ik.ct), ikAad(s.scope, user_id));
    let ikPriv = await importIdentityPriv(pkcs8);
    zeroize(pkcs8);

    let pins: Record<string, string> = {};
    if (data.pins && typeof data.pins === 'object' && data.pins.ct) {
        try {
            let pinBytes = await openGcm(mk, b64uToBytes(data.pins.iv), b64uToBytes(data.pins.ct), encodeUtf8(`${ENC_V}|pins|${s.scope}|${user_id}`));
            pins = JSON.parse(decodeUtf8(pinBytes));
            zeroize(pinBytes);
        }
        catch (err) {
            // A destroyed pin map is loud (every peer becomes unseen again),
            // but it must not block the unlock.
            pins = {};
        }
    }

    s.mk = mk;
    s.ikPriv = ikPriv;
    s.pubRaw = b64uToBytes(data.pub);
    s.fpr = data.fpr;
    s.keyringRecordId = keyring.record_id;
    s.user_id = user_id;
    s.pins = pins;
    s.status = 'unlocked';
    s.reason = '';
}

/**
 * Provision or unlock, called from the login funnel with the password in hand.
 * Must never reject a login: a failure here leaves the session locked, and the
 * app can retry with unlockEncryption().
 */
export async function ensureKeyring(this: any, password: string): Promise<void> {
    let s = encState.call(this);
    if (!s || !this.user?.user_id) {
        return;
    }

    if (!cryptoAvailable()) {
        s.status = 'locked';
        s.reason = 'NO_WEB_CRYPTO';
        return;
    }

    // An OpenID session's "password" is minted by the skapi backend
    // (openIdLogin reads it out of an openid-logger response), so deriving a
    // key from it gives zero confidentiality against the provider. Refuse
    // rather than pretend.
    if (this.user?.is_openid) {
        s.status = 'locked';
        s.reason = 'OPENID_UNSUPPORTED';
        return;
    }

    if (s.cfg.minPasswordLength && password.length < s.cfg.minPasswordLength) {
        s.status = 'locked';
        s.reason = 'WEAK_PASSWORD';
        return;
    }

    s.scope = scopeOf.call(this);

    let keyring = await readKeyring.call(this, s);
    if (keyring) {
        await unlockKeyring.call(this, s, keyring, password);
    }
    else {
        await provisionKeyring.call(this, s, password);
    }

    if (s.cfg.persistDevice) {
        await saveDevice.call(this, s).catch(() => { });
    }
}

/** Explicit unlock, for a token-restored session with no device entry. */
export async function unlockEncryption(this: any, params: { password: string }): Promise<{ status: string }> {
    await this.__connection;
    let s = encState.call(this);
    if (!s) {
        throw new SkapiError('Encryption is not enabled for this instance.', { code: 'INVALID_REQUEST' });
    }
    if (!this.user?.user_id) {
        throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
    }
    if (!params?.password || typeof params.password !== 'string') {
        throw new SkapiError('"password" is required.', { code: 'INVALID_PARAMETER' });
    }

    await ensureKeyring.call(this, params.password);
    if (s.status !== 'unlocked') {
        throw new SkapiError(`Encryption could not be unlocked: ${s.reason}`, { code: 'ENCRYPTION_LOCKED' });
    }
    return { status: s.status };
}

/** Drop keys from memory (and optionally the device) without logging out. */
export async function lockEncryption(this: any, params?: { forgetDevice?: boolean }): Promise<{ status: string }> {
    let s = encState.call(this);
    if (!s) {
        return { status: 'disabled' };
    }
    if (params?.forgetDevice) {
        await deleteDevice.call(this, s).catch(() => { });
    }
    clearEncryptionState.call(this);
    // Cached responses can hold already-decrypted plaintext.
    this.__cached_requests = {};
    return { status: s.status };
}

/**
 * Re-wrap the master key for a new password.
 *
 * Three steps, in this order, so a crash between any two leaves the account
 * openable: append the new wrap, change the Cognito password, prune the old
 * wrap. Reversing it would strand the keyring on a password that no longer
 * exists.
 */
export async function rewrapForPasswordChange(this: any, currentPassword: string, newPassword: string): Promise<void> {
    let s = encState.call(this);
    if (!s) {
        return;
    }
    if (s.status !== 'unlocked' || !s.mk) {
        // Silently skipping here was the worst bug in this file: the Cognito
        // password would change while the keyring still held only a wrap under
        // the OLD password, so the user could log in and never open their own
        // data again. Fail before the password changes instead.
        throw new SkapiError(
            'Encryption must be unlocked before changing the password, or the encryption keyring would be left ' +
            'wrapped under a password that no longer exists. Call unlockEncryption({ password }) first.',
            { code: 'ENCRYPTION_LOCKED' }
        );
    }

    let res = await this.getRecords({ record_id: s.keyringRecordId }, { limit: 1 });
    let keyring = res?.list?.[0];
    if (!keyring) {
        throw new SkapiError(
            'The encryption keyring could not be read, so the password change was stopped before it could strand it.',
            { code: 'ENCRYPTION_KEYRING_CORRUPT' }
        );
    }

    let user_id = this.user.user_id;
    let data = keyring.data;

    // Re-derive MK bytes by opening the current password wrap: MK itself is a
    // non-extractable CryptoKey, so its bytes cannot be read back out of it.
    let wraps = (data.wraps || []).filter((w: any) => w.p === 'password');
    wraps.sort((a: any, b: any) => (b.created || 0) - (a.created || 0));

    let mkBytes: Uint8Array | null = null;
    for (let w of wraps) {
        try {
            let kek = await deriveKek(currentPassword, b64uToBytes(w.kdf.s), w.kdf.it, kekInfo(s.scope, user_id));
            mkBytes = await openGcm(kek, b64uToBytes(w.iv), b64uToBytes(w.ct), mkAad(s.scope, user_id, w.kdf.it, w.kdf.s));
            break;
        }
        catch (err) { }
    }
    if (!mkBytes) {
        throw new SkapiError('Incorrect current password: the encryption keyring was not re-wrapped.', { code: 'ENCRYPTION_BAD_PASSWORD' });
    }

    let salt = getRandom(16);
    let saltB64 = b64uFromBytes(salt);
    let kek = await deriveKek(newPassword, salt, s.cfg.iterations, kekInfo(s.scope, user_id));
    let sealed = await sealGcm(kek, mkBytes, mkAad(s.scope, user_id, s.cfg.iterations, saltB64));
    zeroize(mkBytes);

    let now = Date.now();
    let nextWraps = (data.wraps || []).concat([{
        id: b64uFromBytes(getRandom(6)),
        p: 'password',
        kdf: { a: 'PBKDF2-SHA256', it: s.cfg.iterations, s: saltB64 },
        iv: b64uFromBytes(sealed.iv),
        ct: b64uFromBytes(sealed.ct),
        created: now
    }]);

    await this.postRecord(
        Object.assign({}, data, { wraps: nextWraps, updated: now }),
        { record_id: s.keyringRecordId }
    );
}

/** Drop every wrap but the newest password wrap. Run after the password changed. */
export async function pruneKeyringWraps(this: any): Promise<void> {
    let s = encState.call(this);
    if (!s || s.status !== 'unlocked' || !s.keyringRecordId) {
        return;
    }
    let res = await this.getRecords({ record_id: s.keyringRecordId }, { limit: 1 });
    let keyring = res?.list?.[0];
    if (!keyring) {
        return;
    }
    let data = keyring.data;
    let pw = (data.wraps || []).filter((w: any) => w.p === 'password').sort((a: any, b: any) => (b.created || 0) - (a.created || 0));
    let other = (data.wraps || []).filter((w: any) => w.p !== 'password');
    if (pw.length <= 1) {
        return;
    }
    await this.postRecord(
        Object.assign({}, data, { wraps: [pw[0]].concat(other), updated: Date.now() }),
        { record_id: s.keyringRecordId }
    );
}

/* ------------------------------------------------------------------ *
 * DEVICE STORE
 *
 * IndexedDB rather than localStorage/sessionStorage specifically because it
 * structured-clones CryptoKey objects and PRESERVES extractable:false. The
 * master key's bytes therefore never touch JavaScript and never touch disk in
 * the clear. Injected script on the origin can USE the stored key; it cannot
 * read or exfiltrate it. That is a reduction, not immunity, and it is the
 * honest price of keeping a page reload from prompting for a password.
 * ------------------------------------------------------------------ */

function idbAvailable(): boolean {
    // Gated on IndexedDB itself, not on isBrowserRuntime(). Any runtime that
    // genuinely provides IndexedDB can persist the key; any runtime that does
    // not simply stays locked after a token restore and calls
    // unlockEncryption(). Deliberately NOT falling back to the Node
    // localStorage polyfill, which writes plain files under ./states/.
    return typeof indexedDB !== 'undefined' && !!indexedDB;
}

function openIdb(): Promise<any> {
    return new Promise((res, rej) => {
        let req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
            let db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
}

function deviceKey(this: any, s: EncState): string {
    return `${s.scope}#${this.user?.user_id}`;
}

async function saveDevice(this: any, s: EncState): Promise<void> {
    if (!idbAvailable() || !s.mk) {
        return;
    }
    let db = await openIdb();
    await new Promise<void>((res, rej) => {
        let tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({ mk: s.mk, keyringRecordId: s.keyringRecordId, saved: Date.now() }, deviceKey.call(this, s));
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
    });
    db.close();
}

async function loadDevice(this: any, s: EncState): Promise<{ mk: CryptoKey; keyringRecordId: string } | null> {
    if (!idbAvailable()) {
        return null;
    }
    let db = await openIdb();
    let out = await new Promise<any>((res, rej) => {
        let tx = db.transaction(IDB_STORE, 'readonly');
        let req = tx.objectStore(IDB_STORE).get(deviceKey.call(this, s));
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => rej(req.error);
    });
    db.close();
    return out && out.mk ? out : null;
}

async function deleteDevice(this: any, s: EncState): Promise<void> {
    if (!idbAvailable()) {
        return;
    }
    let db = await openIdb();
    await new Promise<void>((res, rej) => {
        let tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(deviceKey.call(this, s));
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
    });
    db.close();
}

/**
 * Try to unlock from the device store. This is what makes a page reload
 * transparent: autoLogin restores the Cognito session but never the password,
 * so without this every refresh would prompt.
 */
export function startDeviceUnlock(this: any): void {
    let s = encState.call(this);
    if (!s || s.ready) {
        return;
    }
    s.unlocking = true;
    s.ready = unlockFromDevice.bind(this)()
        .catch(() => false)
        .then(() => { s.unlocking = false; });
}

async function unlockFromDevice(this: any): Promise<boolean> {
    let s = encState.call(this);
    if (!s || !this.user?.user_id || !s.cfg.persistDevice || !cryptoAvailable()) {
        return false;
    }

    s.scope = scopeOf.call(this);

    try {
        let stored = await loadDevice.call(this, s);
        if (!stored) {
            return false;
        }
        let keyring = await readKeyring.call(this, s);
        if (!keyring) {
            await deleteDevice.call(this, s).catch(() => { });
            return false;
        }
        await adoptKeyring.call(this, s, keyring, stored.mk);
        return true;
    }
    catch (err) {
        // A stale device entry (password changed elsewhere, keyring rotated)
        // must degrade to "locked", never throw into the connection promise.
        s.status = 'locked';
        s.reason = 'NO_SESSION_KEY';
        return false;
    }
}

/* ------------------------------------------------------------------ *
 * PEER PUBLIC KEYS
 * ------------------------------------------------------------------ */

/**
 * Fetch other users' public keys from the directory partition.
 *
 * Addressed by the reserved $user_id index rather than by unique_id: unique_id
 * is service-wide, first-come-first-served, and enumerable by any authenticated
 * user via getUniqueId, so a squatter could permanently block a victim's
 * enrollment. $user_id is derived server-side from the record's real owner and
 * cannot be forged.
 */
export async function getPeerPublicKeys(this: any, userIds: string[]): Promise<Record<string, { pubRaw: Uint8Array; fpr: string } | null>> {
    let s = encState.call(this);
    if (!s) {
        throw new SkapiError('Encryption is not enabled for this instance.', { code: 'INVALID_REQUEST' });
    }

    let out: Record<string, { pubRaw: Uint8Array; fpr: string } | null> = {};
    let need: string[] = [];
    let newPins = false;

    for (let id of userIds) {
        let hit = s.peerPub.get(id);
        if (hit) {
            out[id] = hit;
        }
        else {
            need.push(id);
        }
    }

    await Promise.all(need.map(async id => {
        let inflight = s.peerInflight.get(id);
        if (!inflight) {
            inflight = (async () => {
                let res = await this.getRecords({
                    table: { name: s.cfg.table, access_group: 'authorized' },
                    index: { name: '$user_id', value: id, condition: '=' }
                }, { limit: 10 });

                let list = (res?.list || []).filter((r: any) => r.user_id === id && r.data?.pub);
                if (!list.length) {
                    return null;
                }
                list.sort((a: any, b: any) => b.uploaded - a.uploaded);
                let pubRaw = b64uToBytes(list[0].data.pub);
                let fpr = await fingerprint(pubRaw);

                // The provider serves this directory, so it can hand us a key
                // whose private half it holds. Nothing in the protocol can stop
                // that on first contact. What we can do is refuse to accept a
                // CHANGED key silently.
                let pinned = s.pins[id];
                if (pinned && pinned !== fpr) {
                    throw new SkapiError(
                        `The public key for user "${id}" has changed since it was first seen. ` +
                        `This is expected if they reset their account, and is what a key substitution attack also looks like. ` +
                        `Verify the new fingerprint out of band, then call pinPeerKey({ user_id, fingerprint }).`,
                        { code: 'ENCRYPTION_PEER_KEY_CHANGED' }
                    );
                }
                if (!pinned) {
                    if (s.cfg.trustPolicy === 'strict') {
                        throw new SkapiError(
                            `No pinned key for user "${id}" and trustPolicy is "strict". Pin it first with pinPeerKey().`,
                            { code: 'ENCRYPTION_PEER_NOT_PINNED' }
                        );
                    }
                    // Persist immediately. A pin held only in memory resets on
                    // every reload, which means the "refuse a CHANGED key"
                    // check below could never fire across sessions and the TOFU
                    // guarantee was decorative.
                    s.pins[id] = fpr;
                    newPins = true;
                }

                return { pubRaw, fpr };
            })().finally(() => s.peerInflight.delete(id));

            s.peerInflight.set(id, inflight);
        }

        let got = await inflight;
        if (got) {
            s.peerPub.set(id, got);
        }
        out[id] = got;
    }));

    if (newPins) {
        // Best effort: a failure to persist must not fail the grant, but it
        // does mean the pin is only good for this session.
        await persistPins.call(this, s).catch(() => { });
    }

    return out;
}

/* ------------------------------------------------------------------ *
 * GRANT / REVOKE
 * ------------------------------------------------------------------ */

/** Load a record's envelope and its DEK, from cache when possible. */
async function loadForRewrap(this: any, s: EncState, record_id: string): Promise<{ entry: DekEntry; scope: string } | null> {
    let scope = scopeOf.call(this);
    let cached = s.dek.get(record_id);
    if (cached) {
        return { entry: cached, scope };
    }

    let rec = await readOwnRecord.call(this, record_id);
    if (!rec) {
        throw new SkapiError(`Record "${record_id}" not found.`, { code: 'NOT_EXISTS' });
    }

    // Absence of evidence is not evidence of absence. A record whose payload
    // could not be READ (an offloaded data file that 404s or fails to fetch)
    // carries no envelope in hand, and treating that as "plaintext record"
    // meant a grant created an ACL row with no key wrap, and a revoke skipped
    // the key roll entirely while reporting success. Refuse loudly instead:
    // better a failed revoke than one that silently did not revoke.
    if (rec.encrypted?.status === 'failed' && rec.encrypted.reason === 'DATA_UNAVAILABLE') {
        throw new SkapiError(
            `Cannot change sharing on record "${record_id}": its data could not be read, ` +
            `so whether it is encrypted is unknown. Retry once the record reads normally.`,
            { code: 'ENCRYPTION_DATA_UNAVAILABLE' }
        );
    }

    // Not an encrypted record at all: nothing to wrap, and the caller's grant
    // should proceed untouched.
    if (!rec.encrypted) {
        return null;
    }

    // Encrypted, but this caller is not the owner, so no DEK was cached. Say so
    // explicitly instead of returning null, which the caller would read as
    // "plaintext record" and let a wrap-less grant through.
    if (rec.user_id !== this.user?.user_id) {
        throw new SkapiError(
            'Only the record owner can share or revoke an encrypted record, because adding or removing a key wrap means writing the record.',
            { code: 'ENCRYPTION_GRANT_REQUIRES_OWNER' }
        );
    }

    let after = s.dek.get(rec.record_id) || s.dek.get(record_id);
    if (!after) {
        throw new SkapiError(
            `Cannot change sharing on record "${record_id}": its data could not be decrypted` +
            (rec.encrypted.reason ? ` (${rec.encrypted.reason})` : '') + '.',
            { code: 'ENCRYPTION_LOCKED' }
        );
    }
    return { entry: after, scope };
}

/**
 * Add decrypt access for other users, by wrapping this record's DEK to each of
 * their public keys. Called from grantPrivateRecordAccess BEFORE the backend
 * grant, so a crypto failure means nothing was granted at all.
 */
export async function addRecipients(this: any, record_id: string, userIds: string[]): Promise<void> {
    let s = encState.call(this);
    if (!s) {
        return;
    }

    // Deliberately NOT gated on the lock up front. A record that was never
    // encrypted (written before the flag was enabled, or in a non-private
    // group) must still be grantable exactly as before, and loadForRewrap is
    // what tells the two apart.
    let loaded = await loadForRewrap.call(this, s, record_id);
    if (!loaded) {
        return; // plaintext record, nothing to wrap
    }
    let { entry, scope } = loaded;

    let me = this.user.user_id;
    if (entry.own !== me) {
        throw new SkapiError(
            'Only the record owner can share an encrypted record, because adding a key wrap means writing the record.',
            { code: 'ENCRYPTION_GRANT_REQUIRES_OWNER' }
        );
    }

    let peers = await getPeerPublicKeys.call(this, userIds);
    let missing = userIds.filter(id => !peers[id]);
    if (missing.length) {
        throw new SkapiError(
            `These users have no encryption key yet, so they cannot be given access: ${missing.join(', ')}. ` +
            `A user's key is created the first time they log in with encryption enabled.`,
            { code: 'ENCRYPTION_RECIPIENT_HAS_NO_KEY' }
        );
    }

    let anchor = anchorOf(entry);
    let aad = payloadAad(scope, entry.own, entry.anch, anchor);
    let recipients = Object.assign({}, entry.recipients);

    for (let id of userIds) {
        if (id === me) {
            continue;
        }
        recipients[id] = await wrapFor.call(this, entry.bytes, peers[id]!, scope, anchor, entry.own, id, aad);
    }

    await writeRecipients.call(this, s, record_id, entry, recipients);
}

/**
 * Remove recipients and ROLL the DEK.
 *
 * Rolling is what makes a revoke mean anything: dropping a wrap alone leaves
 * the revoked user able to read the ciphertext they already hold. Even so this
 * is FORWARD-ONLY. It cannot un-read what they read, and if the provider kept
 * the pre-roll ciphertext and their pre-roll wrap (it saw both), then that user
 * and that provider can jointly recover the old content forever.
 */
export async function dropRecipientsAndRoll(this: any, record_id: string, userIds: string[] | null): Promise<void> {
    let s = encState.call(this);
    if (!s) {
        return;
    }

    let loaded = await loadForRewrap.call(this, s, record_id);
    if (!loaded) {
        return;
    }
    let { entry } = loaded;

    let me = this.user.user_id;
    if (entry.own !== me) {
        throw new SkapiError(
            'Only the record owner can revoke access to an encrypted record.',
            { code: 'ENCRYPTION_GRANT_REQUIRES_OWNER' }
        );
    }

    let keep = Object.keys(entry.recipients).filter(id => {
        if (id === me) {
            return true;
        }
        return userIds ? !userIds.includes(id) : false;
    }).filter(id => id !== me);

    // Read the plaintext FIRST, while the current key is still usable.
    let rec = await readOwnRecord.call(this, record_id);
    if (!rec) {
        throw new SkapiError(`Record "${record_id}" not found.`, { code: 'NOT_EXISTS' });
    }
    // NOT `rec.data === null`: null is a legitimate stored value now, so the
    // flag is the only sound test for "could not be read".
    assertReadable(rec, record_id);

    // Resolve the keepers' public keys BEFORE the roll lands. Rolling first and
    // re-wrapping afterwards meant that one bad peer key (changed fingerprint,
    // a deleted account, a network blip) left every user who was NOT revoked
    // holding an ACL grant and no key wrap, permanently. Failing here instead
    // leaves the record exactly as it was.
    let peers: Record<string, { pubRaw: Uint8Array; fpr: string } | null> = {};
    if (keep.length) {
        peers = await getPeerPublicKeys.call(this, keep);
        let missing = keep.filter(id => !peers[id]);
        if (missing.length) {
            throw new SkapiError(
                `Cannot revoke on record "${record_id}": these users keep access but their encryption keys could not be read, ` +
                `so re-sharing after the key roll would fail and lock them out: ${missing.join(', ')}.`,
                { code: 'ENCRYPTION_RECIPIENT_HAS_NO_KEY' }
            );
        }
    }

    s.roll.add(rec.record_id || record_id);

    // State the table explicitly so the write path does not read the record
    // back just to learn its access group.
    await this.postRecord(rec.data, {
        record_id: rec.record_id || record_id,
        table: { name: rec.table.name, access_group: 'private' }
    });

    if (keep.length) {
        await addRecipients.call(this, rec.record_id || record_id, keep);
    }
}

/**
 * Refuse to write back a record whose current payload could not be read.
 *
 * Both the grant and the revoke path re-post the record's own data to carry a
 * changed recipient map or a rolled key. If the read that produced that data
 * failed (an offloaded spill that 404s), `rec.data` is null, and re-posting it
 * would write a null OVER the record: a sharing change that destroys the
 * payload. The DEK cache makes this reachable even when loadForRewrap never
 * touched the network, which is exactly how it slipped through the first time.
 */
function assertReadable(rec: any, record_id: string): void {
    if (rec?.encrypted?.status === 'failed') {
        throw new SkapiError(
            `Cannot change sharing on record "${record_id}": its current data could not be read ` +
            `(${rec.encrypted.reason}), so re-writing the record would destroy it.`,
            { code: 'ENCRYPTION_DATA_UNAVAILABLE' }
        );
    }
}

/** Write a changed recipient map back, reusing the record's own ciphertext. */
async function writeRecipients(this: any, s: EncState, record_id: string, entry: DekEntry, recipients: Record<string, Wrap>): Promise<void> {
    let res = await this.getRecords({ record_id }, { limit: 1 });
    let rec = res?.list?.[0];
    if (!rec) {
        throw new SkapiError(`Record "${record_id}" not found.`, { code: 'NOT_EXISTS' });
    }
    assertReadable(rec, record_id);

    entry.recipients = recipients;
    s.dek.set(record_id, entry);

    // Re-post the plaintext: maybeEncrypt reuses the cached DEK and the updated
    // recipient map, and re-seals with a fresh IV. The whole ciphertext is
    // re-uploaded, which is the cost of `data` being a single attribute.
    await this.postRecord(rec.data, { record_id });
}

/** Pin a peer's key fingerprint after verifying it out of band. */
export async function pinPeerKey(this: any, params: { user_id: string; fingerprint: string }): Promise<void> {
    let s = encState.call(this);
    if (!s || s.status !== 'unlocked') {
        throw new SkapiError('Encryption is locked.', { code: 'ENCRYPTION_LOCKED' });
    }
    s.pins[params.user_id] = params.fingerprint;
    s.peerPub.delete(params.user_id);
    await persistPins.call(this, s);
}

async function persistPins(this: any, s: EncState): Promise<void> {
    if (!s.mk || !s.keyringRecordId) {
        return;
    }
    let res = await this.getRecords({ record_id: s.keyringRecordId }, { limit: 1 });
    let keyring = res?.list?.[0];
    if (!keyring) {
        return;
    }
    let sealed = await sealGcm(s.mk, encodeUtf8(JSON.stringify(s.pins)), encodeUtf8(`${ENC_V}|pins|${s.scope}|${s.user_id}`));
    await this.postRecord(
        Object.assign({}, keyring.data, {
            pins: { iv: b64uFromBytes(sealed.iv), ct: b64uFromBytes(sealed.ct) },
            updated: Date.now()
        }),
        { record_id: s.keyringRecordId }
    );
}

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

/**
 * Collect a freshly minted recovery code, ONCE.
 *
 * Call this immediately after a login or signup that may have enrolled the
 * user. It returns the code and forgets it. There is deliberately no way to
 * fetch it again later: if this SDK could hand it back on demand, it would be
 * holding the key, and the provider could too. Show it, make the user confirm
 * they saved it, and move on.
 */
export function takeRecoveryCode(this: any): string | null {
    let s = encState.call(this);
    if (!s || !s.pendingRecoveryCode) {
        return null;
    }
    let code = s.pendingRecoveryCode;
    s.pendingRecoveryCode = '';
    return code;
}

/**
 * Unlock with a recovery code, and repair the keyring for the current password.
 *
 * This is the answer to a forgotten password. The sequencing matters and is not
 * obvious: forgotPassword/resetPassword are UNAUTHENTICATED (they build a
 * throwaway cognitoUser), so there is no session during a reset and the keyring
 * cannot be touched then. Recovery therefore happens AFTER the reset, on the
 * next login:
 *
 *   reset password  ->  log in with the new password  ->  status is 'locked'
 *   ->  unlockWithRecoveryCode({ code, password: theNewPassword })
 *
 * Passing `password` is what makes it self-healing: the master key is re-wrapped
 * under the new password so every later login works normally. Omit it and the
 * session unlocks for now but the next login is locked again.
 *
 * A used code is retired and a replacement is returned, because a code that has
 * been typed into a device has been in a clipboard and possibly a screenshot.
 */
export async function unlockWithRecoveryCode(
    this: any,
    params: { code: string; password?: string }
): Promise<{ status: string; repaired: boolean; recoveryCode: string | null }> {
    await this.__connection;

    let s = encState.call(this);
    if (!s) {
        throw new SkapiError('Encryption is not enabled for this instance.', { code: 'INVALID_REQUEST' });
    }
    if (!this.user?.user_id) {
        throw new SkapiError('User login is required. Reset the password and log in first, then use the recovery code.', { code: 'INVALID_REQUEST' });
    }
    if (!params?.code || typeof params.code !== 'string') {
        throw new SkapiError('"code" is required.', { code: 'INVALID_PARAMETER' });
    }

    s.scope = scopeOf.call(this);
    let user_id = this.user.user_id;

    let keyring = await readKeyring.call(this, s);
    if (!keyring) {
        throw new SkapiError('This account has no encryption keyring, so there is nothing to recover.', { code: 'NOT_EXISTS' });
    }

    let mkBytes = await openWithRecoveryCode(s.scope, user_id, keyring.data?.wraps || [], params.code);
    if (!mkBytes) {
        throw new SkapiError(
            'That recovery code did not open the keyring. Check it against the copy you saved when encryption was set up.',
            { code: 'ENCRYPTION_BAD_RECOVERY_CODE' }
        );
    }

    let mk = await importAesGcm(mkBytes);
    await adoptKeyring.call(this, s, keyring, mk);

    // Rewrite the wraps: a new password wrap if we were given the password
    // (replacing the stale ones outright, since nobody can open them any more),
    // and a fresh recovery wrap replacing the one just used.
    let repaired = false;
    let nextCode: string | null = null;
    let wraps: any[] = (keyring.data?.wraps || []).slice();

    if (params.password) {
        wraps = wraps.filter((w: any) => w.p !== 'password');
        wraps.push(await mintPasswordWrap(s, s.scope, user_id, params.password, mkBytes));
        repaired = true;
    }

    if (s.cfg.recovery === 'code') {
        let minted = await mintRecoveryWrap(s.scope, user_id, mkBytes);
        wraps = wraps.filter((w: any) => w.p !== 'recovery');
        wraps.push(minted.wrap);
        nextCode = minted.code;
    }

    zeroize(mkBytes);

    await this.postRecord(
        Object.assign({}, keyring.data, { wraps, updated: Date.now() }),
        { record_id: keyring.record_id }
    );

    if (s.cfg.persistDevice) {
        await saveDevice.call(this, s).catch(() => { });
    }

    return { status: s.status, repaired, recoveryCode: nextCode };
}

/**
 * Retire the current recovery code and issue a new one.
 *
 * Requires an UNLOCKED session, which is the whole access-control story: the
 * only way to mint a code is to already be able to decrypt. There is therefore
 * no path here that helps someone who is locked out, and no path that lets the
 * provider mint one.
 */
export async function regenerateRecoveryCode(this: any): Promise<{ recoveryCode: string }> {
    await this.__connection;

    let s = encState.call(this);
    if (!s) {
        throw new SkapiError('Encryption is not enabled for this instance.', { code: 'INVALID_REQUEST' });
    }
    if (s.status !== 'unlocked' || !s.mk) {
        throw new SkapiError(
            'Encryption must be unlocked to issue a recovery code. Only someone who can already decrypt can create one.',
            { code: 'ENCRYPTION_LOCKED' }
        );
    }
    if (s.cfg.recovery !== 'code') {
        throw new SkapiError('Recovery codes are disabled for this instance ("recovery" is "none").', { code: 'INVALID_REQUEST' });
    }

    let res = await this.getRecords({ record_id: s.keyringRecordId }, { limit: 1 });
    let keyring = res?.list?.[0];
    if (!keyring) {
        throw new SkapiError('The encryption keyring could not be read.', { code: 'ENCRYPTION_KEYRING_CORRUPT' });
    }

    // MK is held as a NON-EXTRACTABLE CryptoKey, so its raw bytes cannot be read
    // back out of it, and minting a new wrap needs those bytes. They are kept
    // for exactly this purpose in `self`: the master key sealed under itself.
    // That is security-neutral (opening it already requires holding MK) and it
    // means the bytes only ever materialize for the moment they are needed,
    // rather than sitting in memory for the whole session.
    let self = keyring.data?.self;
    if (!self || !self.ct) {
        throw new SkapiError(
            'This keyring predates recovery-code rotation and cannot issue a new code. ' +
            'Use unlockWithRecoveryCode() with the existing code, which issues a replacement.',
            { code: 'ENCRYPTION_KEYRING_CORRUPT' }
        );
    }

    let mkBytes = await openGcm(s.mk, b64uToBytes(self.iv), b64uToBytes(self.ct), selfAad(s.scope, s.user_id));
    let minted = await mintRecoveryWrap(s.scope, s.user_id, mkBytes);
    zeroize(mkBytes);

    let wraps = (keyring.data.wraps || []).filter((w: any) => w.p !== 'recovery').concat([minted.wrap]);
    await this.postRecord(
        Object.assign({}, keyring.data, { wraps, updated: Date.now() }),
        { record_id: s.keyringRecordId }
    );

    return { recoveryCode: minted.code };
}

/* ------------------------------------------------------------------ *
 * BINARY FILES
 *
 * A private record's attachments are sealed under a key derived from that
 * record's data key, so anyone who can read the record can open its files and
 * nobody else can, with no extra key distribution.
 *
 * Encrypted-ness is recorded IN THE S3 KEY, in the form-key segment:
 *
 *   .../bin/<ts>/<size>/<formKey>__skenc__<plainSizeB62>/<filename>
 *
 * not only inside the file. Three things depend on that. A reader must know
 * before it fetches; `record.bin[].size` must report the PLAINTEXT length
 * without a round trip; and both dashboards `delete f.getFile` before cloning a
 * record into their pager, so anything carried only on the closure is invisible
 * to them. The key survives move_folder_s3 byte-for-byte, so it also survives
 * an access-group change.
 * ------------------------------------------------------------------ */

const FILE_MARKER = '__skenc__';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function toB62(n: number): string {
    if (n === 0) {
        return '0';
    }
    let out = '';
    while (n > 0) {
        out = B62[n % 62] + out;
        n = Math.floor(n / 62);
    }
    return out;
}
function fromB62(s: string): number {
    let n = 0;
    for (let c of s) {
        let v = B62.indexOf(c);
        if (v < 0) {
            return NaN;
        }
        n = n * 62 + v;
    }
    return n;
}

/** Split a form-key segment into its real key and the plaintext size, if marked. */
export function parseFileMarker(formKey: string): { key: string; plainSize: number } | null {
    if (typeof formKey !== 'string') {
        return null;
    }
    let at = formKey.lastIndexOf(FILE_MARKER);
    if (at < 0) {
        return null;
    }
    let size = fromB62(formKey.slice(at + FILE_MARKER.length));
    if (!Number.isFinite(size)) {
        return null;
    }
    return { key: formKey.slice(0, at), plainSize: size };
}

/**
 * Identify an encrypted attachment from its url alone.
 *
 * Path shape (after the host):
 *   auth|publ / service / owner / uploader / records / recordId / group / bin / ts / size / formKey / filename
 */
export function encryptedFileFromUrl(url: string): { recordId: string; recordOwner: string; filename: string; plainSize: number } | null {
    try {
        let seg = String(url).split('?')[0].split('/').slice(3);
        if (seg.length < 12 || seg[4] !== 'records' || seg[7] !== 'bin') {
            return null;
        }
        let marked = parseFileMarker(seg[10]);
        if (!marked) {
            return null;
        }
        return {
            recordId: seg[5],
            recordOwner: seg[3],
            filename: seg[seg.length - 1],
            plainSize: marked.plainSize
        };
    }
    catch (err) {
        return null;
    }
}

function fileCtx(this: any, recordId: string, recordOwner: string) {
    return { service: this.service, owner: this.owner, recordOwner, recordId };
}

/**
 * Seal one attachment before upload. Returns the original untouched whenever
 * the record is not encrypted, so the off path is unchanged.
 */
export async function maybeEncryptFile(
    this: any,
    recordId: string,
    formKey: string,
    file: File
): Promise<{ key: string; file: File; encrypted: boolean }> {
    let s = encState.call(this);
    if (!s || !recordId) {
        return { key: formKey, file, encrypted: false };
    }

    let entry = s.dek.get(recordId);
    if (!entry) {
        // The record is not encrypted (or this session cannot read it, in which
        // case maybeEncrypt already refused the write that got us here).
        return { key: formKey, file, encrypted: false };
    }

    if (parseFileMarker(formKey)) {
        throw new SkapiError(`"${FILE_MARKER}" is reserved in an upload form key.`, { code: 'INVALID_PARAMETER' });
    }

    let plain = new Uint8Array(await file.arrayBuffer());
    let meta = { n: file.name, t: file.type || '', lm: file.lastModified || 0 };
    let sealed = await encryptFileBytes(entry.bytes, plain, fileCtx.call(this, recordId, entry.own), meta);
    zeroize(plain);

    return {
        key: `${formKey}${FILE_MARKER}${toB62(file.size)}`,
        // Deliberately octet-stream: the real content type is authenticated
        // inside the container. Leaving "application/pdf" on ciphertext invites
        // a browser or a CDN to try to interpret it.
        file: new File([sealed], file.name, { type: 'application/octet-stream' }),
        encrypted: true
    };
}

/** Open a downloaded attachment. */
export async function decryptFileBlob(this: any, url: string, blob: Blob): Promise<Blob> {
    let s = encState.call(this);
    let info = encryptedFileFromUrl(url);
    if (!s || !info) {
        return blob;
    }

    let entry = s.dek.get(info.recordId);
    if (!entry) {
        throw new SkapiError(
            `Cannot open this file: the data key for record "${info.recordId}" is not available. ` +
            `Read the record first, and make sure encryption is unlocked.`,
            { code: 'ENCRYPTION_LOCKED' }
        );
    }

    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (!isEncryptedFile(bytes)) {
        // Marked in the key but not actually a container. Do NOT hand the raw
        // bytes back as if they were the file: that is how ciphertext ends up
        // saved to disk under a plaintext name.
        throw new SkapiError(
            'This file is marked as encrypted but its contents are not an encrypted container.',
            { code: 'ENCRYPTION_FILE_CORRUPT' }
        );
    }

    let opened = await decryptFileBytes(entry.bytes, bytes, fileCtx.call(this, info.recordId, info.recordOwner));
    let type = (opened.meta && opened.meta.t) || 'application/octet-stream';
    return new Blob([opened.bytes], { type });
}

/** Stored size of an attachment once sealed, for declaring it before upload. */
export function sealedFileSize(plainLen: number, meta: { n?: string; t?: string; lm?: number }): number {
    return encryptedFileSize(plainLen, encodeUtf8(JSON.stringify(meta)).length);
}
