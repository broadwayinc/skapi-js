import {
    RecordData,
    Form,
    FetchOptions,
    DatabaseResponse,
    GetRecordQuery,
    Condition,
    PostRecordConfig,
    ProgressCallback,
    BinaryFile,
    FileInfo,
    DelRecordQuery,
    Table,
    Index,
    Tag,
    UniqueId
} from '../Types';
import SkapiError from '../main/error';
import { extractFormData, fromBase62, isBrowserRuntime } from '../utils/utils';
import validator from '../utils/validator';
import { request, uploadFiles } from '../utils/network';
import { checkAdmin } from './user';
import { authentication } from './user';
import { accessGroup, decodeReservedDelimiters, indexValue, recordIdOrUniqueId, validateCustomIndexName, validateTableName, validateTag, validateStringByPolicy, indexRange, isNestIndexName, validateNestIndexSegment } from './param_restrictions';

const pendingPrivateAccessKeyRequest: Record<string, Promise<string>> = {};

/**
 * How long a private record file stays available locally: ONE WEEK.
 *
 * A private file cannot be served from the plain CDN url, so every read went out
 * over the network. The `?t=<idToken>` form it used could not help either: that
 * token rotates, so the url changed and the browser cache never matched. Reading
 * the same private image twice therefore downloaded it twice.
 *
 * These two numbers do different jobs:
 *  - EXPIRES is how long the signed URL works. Short, so a leaked url dies fast.
 *  - BROWSER_CACHE is how long the FILE stays usable locally.
 *
 * They used to be a week and twenty minutes, which reads as "short url, long
 * local copy" and is in fact a scheduled outage: get_signed_url stamped the mint
 * response with the week, so from minute 21 the browser answered every later mint
 * from its own store with a credential that was already dead, for the remaining
 * six days. That is what killed chat image previews on phones (which drop image
 * bodies and refetch) while desktops, still holding the bytes, never noticed.
 *
 * The server now refuses to grant a cache a url cannot back
 * (get_signed_url resolve_browser_cache caps at `expires` minus headroom), so the
 * real lever on local availability is EXPIRES, not BROWSER_CACHE. An hour buys
 * 55 minutes of reuse and is still short enough that a leaked url is not a
 * standing grant. Asking for the week is kept deliberately: it says what this
 * client would reuse if the url were stable by construction, and lets the server
 * be the one that decides.
 */
const PRIVATE_FILE_BROWSER_CACHE_SECONDS = 7 * 24 * 60 * 60;
const PRIVATE_FILE_URL_EXPIRES_SECONDS = 60 * 60;

/**
 * Cache generation for the mint url, and the repair's window stamp.
 *
 * Mirrors bunnyquery/engine's previewMintCacheToken, which cannot be imported
 * here (the chat engine depends on this package, not the other way round). BUMP
 * THE GENERATION to abandon every mint response browsers are holding: generation
 * 2 retires the week-long entries written before 2026-08-11, which the server cap
 * cannot reach because they are already on the user's device.
 *
 * A query parameter, not a request header. `Cache-Control: no-cache` is not
 * CORS-safelisted and the record gateway's preflight does not allow it, so a mint
 * carrying it is refused by the browser before it is sent: the repair below never
 * ran at all, in any browser.
 */
const MINT_CACHE_GENERATION = 2;

function mintCacheToken(expiresSeconds: number, refresh?: boolean): string {
    if (!refresh) return String(MINT_CACHE_GENERATION);
    // Same derivation as the chat client: one stamp per window, so a repair is one
    // extra cache entry per window rather than one per file per attempt, and the
    // window always closes before the url it carries can expire.
    let windowMs = Math.max(60, expiresSeconds - 5 * 60) * 1000;
    return MINT_CACHE_GENERATION + '.' + Math.floor(Date.now() / windowMs);
}

/**
 * Whether a signed url for this record file may be browser-cached.
 *
 * Reaching ANOTHER user's restricted file relies on a granted private access key,
 * which getFile appends as `&p=` to the token url. The mint request has no way to
 * carry that key, so those files must keep taking the token path: they stay
 * uncached rather than being handed a presign the caller is not entitled to.
 *
 * `splitPath` is the record file path:
 * auth|publ/service/owner/uploader/records/record/access_group/bin/ts/size/key/name
 */
function canBrowserCacheRecordFile(splitPath: string[]): boolean {
    if (!this.user?.user_id) return false;
    let access_group = splitPath[6] === '**' ? '**' : parseInt(splitPath[6]);
    let user_access_group = this.user?.access_group ?? -1;
    if (this.user.user_id !== splitPath[3] && (access_group === '**' || user_access_group < access_group)) {
        return false;
    }
    return true;
}

// Read a getFile('blob') result to text across browser + node runtimes. Blob.text()
// is used when present; otherwise FileReader (the same polyfilled reader getFile
// uses for its base64 path) reads it.
async function blobToText(blob: any): Promise<string> {
    if (typeof blob === 'string') {
        return blob;
    }
    if (blob && typeof blob.text === 'function') {
        return await blob.text();
    }
    return await new Promise<string>((resolve, reject) => {
        try {
            let fr = new FileReader();
            fr.onload = () => resolve(fr.result as string);
            fr.onerror = () => reject(fr.error || new Error('Failed to read blob'));
            fr.readAsText(blob);
        }
        catch (err) {
            reject(err);
        }
    });
}

export async function normalizeRecord(record: Record<string, any>, _called_from?, _skipDataFetch = false): Promise<RecordData> {
    // if (record?.rec) {
    //     if (_called_from !== 'called from postRecord') {
    //         let recPost = window.sessionStorage.getItem(`${this.service}:post:${record.rec}`);
    //         if (recPost) {
    //             try {
    //                 record = JSON.parse(recPost);
    //             }
    //             catch (err) { }
    //             window.sessionStorage.removeItem(`${this.service}:post:${record.rec}`);
    //         }
    //     }
    // }
    const output: Record<string, any> = {
        user_id: '',
        record_id: '',
        updated: 0,
        uploaded: 0,
        readonly: false,
        table: {
            name: '',
            access_group: 0,
            subscription: {
                is_subscription_record: false,
                upload_to_feed: false,
                notify_subscribers: false,
                feed_referencing_records: false,
                notify_referencing_records: false
            }
        },
        referenced_count: 0,
        source: {
            referencing_limit: null,
            prevent_multiple_referencing: false,
            can_remove_referencing_records: false,
            only_granted_can_reference: false,
        },
        ip: '',
        bin: {}
    };
    let is_anonymous = false;
    // Raw CDN urls of any offloaded-"data" file (a __data__/__json__.json entry
    // in the record's bin). Collected while processing "bin" (which runs before
    // "data") and used by the "data" handler to fetch the payload back.
    let dataFileUrls: string[] = [];
    function access_group_set(v) {
        let access_group = v == '**' ? 'private' : parseInt(v);
        access_group = access_group == 0 ? 'public' : access_group == 1 ? 'authorized' : access_group == 99 ? 'admin' : access_group;
        return access_group;
    }
    const keys = {
        'ip': (r: string) => {
            // Stored as "<ip>[R]#<unique_id>". Only the FIRST '#' is the delimiter —
            // the unique_id itself may contain '#' (e.g. a "src::<path>" id built
            // from a file path), so rejoin everything after it instead of taking
            // split[1], which silently truncated at the first '#' in the id.
            let split_ip = r.split('#');
            let ip = split_ip[0];
            if (split_ip.length > 1) {
                output.unique_id = split_ip.slice(1).join('#');
            }
            if (ip.slice(-1) === 'R') {
                output.readonly = true;
                ip = ip.slice(0, -1);
            }
            else {
                output.readonly = false;
            }
            // check if the format of the ip is 0-0-0-0, if it is, convert it to 0.0.0.0

            if (/^\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}$/.test(ip)) {
                ip = ip.split('-').join('.');
                is_anonymous = true;
            }

            output.ip = ip;
        },
        'rec': (r: string) => {
            if (!r) return;
            output.record_id = r;
            let base62timestamp = r.substring(0, r.length - 9); // id: [base62 timestamp][random 5 char][suid 4 char]
            let uploaded = fromBase62(base62timestamp);
            output.uploaded = uploaded;
        },
        'usr': (r: string) => {
            output.user_id = r;
        },
        'tbl': (r: string) => {
            if (!r) return;
            // table/service/group(** | group)/[subscription(user id)/group(00 - 99)]/[tag]
            if (!output.table.name) {
                let rSplit = r.split('/');
                output.table.name = decodeReservedDelimiters(rSplit[0]);
                output.table.access_group = access_group_set(rSplit[2]);
                if (rSplit?.[3]) {
                    output.table.subscription.is_subscription_record = true;
                }
            }
        },
        'usr_tbl': (r: string) => {
            // user-id/table/service/group(** | group)[/subscription(user id)/group(00 - 99)][/tag]
            let rSplit = r.split('/');
            if (!output.user_id) {
                output.user_id = rSplit[0];
            }
            if (!output.table.name) {
                output.table.name = decodeReservedDelimiters(rSplit[1]);
                output.table.access_group = access_group_set(rSplit[3]);
                if (rSplit?.[4]) {
                    output.table.subscription.is_subscription_record = true;
                }
            }
        },
        'idx': (r: string) => {
            if (!r) return;
            let rSplit = r.split('!');
            let name = decodeReservedDelimiters(rSplit.splice(0, 1)[0]);
            // The VALUE is raw both directions and must NOT be decoded. The platform allows / ! * #
            // in an index value (validate_index_string_value passes no forbidden_chars), so the write
            // path sends it untouched; decoding on the way back turned a value written as "a%2Fb"
            // into "a/b". Escaping it instead is not an option: index values are compared
            // lexicographically for gt/lt/range queries, and "%2F" sorts nowhere near "/", so
            // escaping would silently change the result of every range query. Raw end to end is the
            // only lossless choice. A raw '!' inside the value is already safe, because the split
            // above takes only the first segment as the name and rejoins the remainder.
            let value = normalizeTypedString('!' + rSplit.join('!'));
            output.index = {
                name,
                value
            };
        },
        'ref': (r: string) => {
            if (!r) return;
            output.reference = r.split('/')[0];
        },
        'tags': (r: string[]) => {
            output.tags = Array.isArray(r) ? r.map((tag) => decodeReservedDelimiters(tag)) : r;
        },
        'upd': (r: number) => {
            output.updated = r;
        },
        'acpt_mrf': (r: boolean) => {
            output.source.prevent_multiple_referencing = !r;
        },
        'ref_limt': (r: number) => {
            output.source.referencing_limit = r;
        },
        'rfd': (r: number) => {
            output.referenced_count = r;
        },
        'bin': async (r: string[]) => {
            let binObj: Record<string, any[]> = {};
            let _ref = output?.reference || null;
            if (Array.isArray(r)) {
                const parsedBin = await Promise.all(r.map(async (url) => {
                    try {
                        let path = url.split('/').slice(3).join('/');
                        let splitPath = path.split('/');

                        // Expected path format:
                        // auth|publ/serviceid/ownerid/uploaderid/records/recordid/access_group/bin/timestamp/size/form_key/filename
                        if (splitPath.length < 12) {
                            return null;
                        }

                        // NOT decoded. Nothing ever percent-encodes these segments on the way out:
                        // uploadFiles sends the key as `key + '/' + f.name` verbatim
                        // (utils/network.ts), get_signed_url returns that raw string as the cdn url,
                        // and the S3 notification stores unquote_plus of the event key, which is the
                        // raw name again. So decodeURIComponent here had no matching encode and could
                        // only corrupt: a file named "100%off.pdf" threw URIError, which the catch
                        // below swallowed as null, silently dropping the file from record.bin
                        // entirely; "50%20off.pdf" came back renamed to "50 off.pdf" while its own
                        // .path still held the real name. getFile(url, { dataType: 'info' }) already
                        // reads this segment raw, so this also makes the two agree.
                        let filename = splitPath[splitPath.length - 1];
                        let pathKey = splitPath[10];

                        // Offloaded record "data" lives at .../bin/<ts>/<size>/__data__/__json__.json.
                        // It is not a user binary: keep it out of the bin output and
                        // hand its raw url to the "data" handler to fetch back.
                        if (pathKey === '__data__' && filename === '__json__.json') {
                            return { isDataFile: true, rawUrl: url };
                        }

                        let size = splitPath[9];
                        let uploaded = splitPath[8];
                        let access_group = access_group_set(splitPath[6]);
                        let url_endpoint = url;

                        // A private file is read through a SIGNED url whose mint is
                        // browser-cached for a week, so the same url keeps coming
                        // back and the file downloads once instead of on every read.
                        // Null when the file needs a granted private access key,
                        // which the mint cannot carry: those keep the token url.
                        let privateCache = access_group !== 'public' && canBrowserCacheRecordFile.call(this, splitPath)
                            ? {
                                expires: PRIVATE_FILE_URL_EXPIRES_SECONDS,
                                browserCache: PRIVATE_FILE_BROWSER_CACHE_SECONDS,
                            }
                            : null;

                        if (access_group !== 'public') {
                            try {
                                // Deliberately NOT the cached presign, even for a
                                // file that could use one. `url` is the record's
                                // public face: it is fed back into remove_bin and
                                // deleteFiles, which rebuild the endpoint from this
                                // string's host and require a cloudfront one
                                // (post_record raises "Invalid binary endpoint." on
                                // an s3 host, and del_files accepts it and then
                                // deletes nothing). It is also what the MCP server
                                // hands to a model and what a dashboard renders, so
                                // a presign here would leak the bucket and key and
                                // rot wherever it was stored. Caching happens in
                                // getFile below, where the url never escapes.
                                url_endpoint = (await getFile.bind(this)(url, { dataType: 'endpoint', _ref }) as string);
                            }
                            catch (err) {
                                console.error('Error getting signed url for private file:', err);
                                // Keep the original CDN URL when signed endpoint resolution is unavailable.
                                url_endpoint = url;
                            }
                        }

                        let obj = {
                            access_group,
                            filename,
                            url: url_endpoint,
                            path,
                            size: fromBase62(size),
                            uploaded: fromBase62(uploaded),
                            getFile: (dataType: 'base64' | 'download' | 'endpoint' | 'blob' | 'text' | 'info', progress?: ProgressCallback) => {
                                let base = {
                                    dataType: dataType || 'download',
                                    progress,
                                    _ref,
                                };
                                let tokenPath = () => getFile.bind(this)(
                                    url_endpoint,
                                    Object.assign({}, base, { _update: obj }),
                                );

                                if (!privateCache) return tokenPath();

                                // Mint from the RAW cdn url, not url_endpoint: the
                                // latter already carries '?t=<token>', which getFile
                                // would re-append to, and which is not the string
                                // the record stores in its bin list.
                                //
                                // No `_update` here on purpose. _update writes the
                                // resolved url back onto obj.url, and a presign
                                // there is exactly what breaks remove_bin and
                                // deleteFiles (see the resolution above).
                                return getFile.bind(this)(url, Object.assign({}, base, privateCache))
                                    .catch(() => {
                                        // A file that reads fine today must not
                                        // become unreadable because the mint
                                        // refuses it. The mint enforces checks the
                                        // cdn edge does not (record existence, bin
                                        // membership, subscription access), and a
                                        // backend without browser_cache support
                                        // answers differently again. Any of those
                                        // falls back to the url that already works.
                                        return tokenPath();
                                    });
                            }
                        };

                        return { pathKey, obj };
                    }
                    catch {
                        return null;
                    }
                }));

                for (let parsed of parsedBin) {
                    if (!parsed) {
                        continue;
                    }

                    if ((parsed as any).isDataFile) {
                        // Kept out of the user-facing bin; the url was already
                        // collected by the synchronous pre-scan above.
                        continue;
                    }

                    if (binObj[parsed.pathKey]) {
                        binObj[parsed.pathKey].push(parsed.obj);
                        continue;
                    }

                    binObj[parsed.pathKey] = [parsed.obj];
                }
            }
            output.bin = binObj;
        },
        'prv_acs': (r: { [key: string]: string }) => {
            for (let k in r) {
                let subscription_config = ['notify_subscribers', 'upload_to_feed', 'feed_referencing_records', 'notify_referencing_records'];
                if (subscription_config.includes(k)) {
                    output.table.subscription[k] = r[k];
                }
                else if (k === 'referencing_index_restrictions' && Array.isArray(r[k])) {
                    // The index NAME inside a restriction is escaped on write by
                    // validateCustomIndexName, because the backend rejects a raw / ! * # in an index
                    // name. It was the one escaped-on-write field with no decode on read, so a
                    // restriction written for "category/sub" came back as "category%2Fsub" while
                    // record.index.name for that same string came back decoded. Re-saving the record
                    // then escaped it a second time ("category%252Fsub"), and the backend compares
                    // the restriction name against the incoming index name, so referencing that
                    // record started failing with "Index value does not match the reference index
                    // restriction". The sibling value/range stay raw, matching the idx handler:
                    // index VALUES are never escaped.
                    output.source[k] = (r[k] as any[]).map((restriction: any) => {
                        if (restriction && typeof restriction === 'object' && typeof restriction.name === 'string') {
                            return Object.assign({}, restriction, { name: decodeReservedDelimiters(restriction.name) });
                        }
                        return restriction;
                    });
                }
                else {
                    output.source[k] = r[k];
                }
            }
        },
        'data': async (r: any) => {
            if (r === '!D%{}') {
                output.data = {};
                return;
            }
            if (r === '!L%[]') {
                output.data = [];
                return;
            }

            // Data DynamoDB could not hold natively is stored as { __json__: "<text>" }:
            // valid JSON whose shape the item itself cannot express (an empty or oversized
            // key at any depth, nesting past 32 levels). Parse it back. The check mirrors
            // exactly what the server writes (one key, holding a string), and a value that
            // merely looks like the marker but does not parse is an ordinary user value, so
            // it falls through and is returned verbatim.
            if (
                r && typeof r === 'object' && !Array.isArray(r) &&
                typeof r.__json__ === 'string' && Object.keys(r).length === 1
            ) {
                try {
                    output.data = JSON.parse(r.__json__);
                    return;
                }
                catch (err) { }
            }

            // Offloaded data: stored as { __data__: "<ts>/<size>/__data__/__json__.json" },
            // the JSON itself living in the record's bin as that same file. Fetch
            // it back (all records in a getRecords batch resolve concurrently via
            // the Promise.all over normalizeRecord) and replace it in the data key.
            // The value must be exactly one key whose string ends with the
            // reserved suffix AND a matching bin file must exist; otherwise it is
            // an ordinary user value that merely looks like a marker, so fall
            // through and return it verbatim.
            if (
                r && typeof r === 'object' && !Array.isArray(r) &&
                typeof r.__data__ === 'string' && Object.keys(r).length === 1 &&
                r.__data__.endsWith('/__data__/__json__.json')
            ) {
                let markerPath = r.__data__;
                let rawUrl = dataFileUrls.find(u => u.endsWith(markerPath)) || null;
                if (rawUrl) {
                    if (_skipDataFetch) {
                        // postRecord/bulkPostRecords already hold the posted value
                        // and restore it, so skip re-downloading what was just sent.
                        output.data = r;
                        return;
                    }

                    try {
                        // Fetch as a blob, not 'text': getFile('text') routes the
                        // body through request()'s response post-processing, which
                        // both JSON.parses it (a second parse here would corrupt a
                        // JSON-shaped string) and, if the decoded object has a
                        // truthy top-level `startKey`, mangles it as a paginated
                        // response. A blob passes through untouched, so we decode
                        // and JSON.parse the raw body exactly once — the exact
                        // inverse of the server's json.dumps for every value type.
                        let blob = await getFile.bind(this)(rawUrl, { dataType: 'blob', _ref: output.reference || null });
                        let text = await blobToText(blob);
                        // Parsed ONCE, and never run through the __json__ decode above. The
                        // offloaded file always holds the original payload (post_record
                        // offloads decode_record_data(...) precisely so it does), which means
                        // a file whose contents ARE { __json__: "..." } is a caller who really
                        // stored that shape. Decoding again here would unwrap their data.
                        output.data = JSON.parse(text);
                    }
                    catch (err) {
                        console.error('Failed to fetch offloaded record data:', err);
                        output.data = null;
                    }
                    return;
                }
            }

            output.data = r;
        }
    };

    if (record.record_id) {
        // bypass already normalized records
        return record as RecordData;
    }

    // Pre-scan the raw bin synchronously so the async "data" handler can resolve
    // the offloaded-data file url immediately. The handler loop below starts every
    // handler before awaiting any of them (collect-then-Promise.all), so the "data"
    // handler's synchronous lookup cannot rely on the "bin" handler having run yet.
    if (Array.isArray(record.bin)) {
        for (let url of record.bin) {
            try {
                if (typeof url !== 'string') continue;
                let sp = url.split('/').slice(3);
                // Raw, matching the "bin" handler: these segments are never percent-encoded, and
                // decoding threw URIError on any filename holding a bare '%'.
                if (sp.length >= 12 && sp[10] === '__data__' && sp[sp.length - 1] === '__json__.json') {
                    dataFileUrls.push(url);
                }
            }
            catch { }
        }
    }

    let toWait = []
    for (let k in keys) {
        if (record.hasOwnProperty(k)) {
            let exec = keys[k](record[k]);
            if (exec instanceof Promise) {
                toWait.push(exec);
            }
        }
    }

    if (is_anonymous) {
        output.user_id = 'anonymous:' + output.user_id;
    }
    await Promise.all(toWait);
    return output as RecordData;
}

function normalizeTypedString(v: string) {
    let value = v.substring(3);
    let type = v.substring(0, 3);

    switch (type) {
        case "!S%":
            // !S%string
            return value;
        case "!N%":
            // !N%0
            let splitDec = value.split('.');
            let calcNumb = Number(splitDec[0]) - 4503599627370496;
            if (splitDec.length === 1) {
                return calcNumb;
            }
            return parseFloat(calcNumb.toString() + '.' + splitDec[1]);
        case "!B%":
            // !B%1
            return value === '1';
        case "!L%":
        case "!D%":
            // !L%[0, "hello"] / !D%{}
            try {
                return JSON.parse(value);
            } catch (err) {
                throw new SkapiError('Value parse error.', { code: 'PARSE_ERROR' });
            }
        default:
            return v;
    }
}

export async function deleteFiles(params: {
    endpoints: string | string[], // file endpoints
}): Promise<RecordData[]> {
    let { endpoints } = params;

    if (typeof endpoints === 'string') {
        endpoints = [endpoints];
    }

    if (!Array.isArray(endpoints)) {
        throw new SkapiError('"endpoints" should be type: array | string.', { code: 'INVALID_PARAMETER' });
    }

    let updatedRec = await request.bind(this)('del-files', {
        endpoints,
        storage: 'records'
    }, { auth: true, method: 'post' });

    let to_process = [];
    for (let i in updatedRec) {
        to_process.push(normalizeRecord.bind(this)(updatedRec[i]));
    }

    return Promise.all(to_process);
}

export async function getFile(
    url: string, // cdn endpoint url https://xxxx.cloudfront.net/path/file
    config?: {
        dataType?: 'base64' | 'download' | 'endpoint' | 'blob' | 'text' | 'info'; // default 'download'
        expires?: number; // uses url that expires in given seconds. this option does not use the cdn (slow). can be used for private files. (does not work on public files).
        // Seconds the browser may reuse the signed url minted for `expires`.
        //
        // Without it, every call mints a brand new SigV4 url, so the browser
        // cache can never be hit and the file downloads again every time even
        // though nothing changed. With it, the MINT REQUEST is answered from the
        // browser cache and the same url comes back, so the already-downloaded
        // body stays addressable. The url's own lifetime is still `expires`: what
        // keeps the file available past that is the cached body, not the url.
        //
        // Only meaningful together with `expires`, and capped at 1 week
        // server-side. Private record files in `record.bin` set it to a week for
        // you; this is for files you fetch by url yourself.
        browserCache?: number;
        // Bypass the cached mint above and force a fresh signed url. Use it when
        // the file may have changed, or after a load failed because the cached
        // url had expired and the body was no longer in the cache.
        refresh?: boolean;
        progress?: ProgressCallback;
        _ref?: string;
        _update?: any;
    }
): Promise<Blob | string | void | FileInfo> {
    if (typeof url !== 'string') {
        throw new SkapiError('"url" should be type: string.', { code: 'INVALID_PARAMETER' });
    }

    // `url` is reassigned below (query string, then the minted signed url). The
    // retry at the end has to start over from what the caller actually passed.
    const requestedUrl = url;

    let splitQuery = url.split('?');
    let baseUrl = splitQuery.shift() || '';
    let queryString = splitQuery.length ? '?' + splitQuery.join('?') : '';

    let validatedBaseUrl = validator.Url(baseUrl);
    url = validatedBaseUrl + queryString;

    let isValidEndpoint = false;
    let splitUrl = validatedBaseUrl.split('/');
    let host = splitUrl[2];
    let splitHost = host.split('.');
    let subdomain = null;

    if (splitHost.length === 3 && splitHost[1] === 'skapi') {
        subdomain = splitHost[0];
        isValidEndpoint = true;
    }

    let target_key = splitUrl.slice(3);
    let needAuth = false;
    if (!isValidEndpoint) {
        if (target_key[0] === 'auth' || target_key[0] === 'publ') {
            try {
                validator.UserId(target_key[2]);
                validator.UserId(target_key[3]);
                needAuth = target_key[0] == 'auth';
                isValidEndpoint = true;
            }
            catch {
                throw new SkapiError('Invalid file url.', { code: 'INVALID_PARAMETER' });
            }
        }
    }

    let service = subdomain ? null : target_key[1];

    config = validator.Params<NonNullable<typeof config>>(config, {
        expires: ['number', () => 0],
        browserCache: ['number', () => 0],
        refresh: ['boolean', () => false],
        dataType: ['base64', 'blob', 'endpoint', 'text', 'info', () => 'download'],
        progress: ['function', 'undefined', null],
        _ref: [null, 'string'],
        _update: v => v
    });


    if (config?.dataType === 'info') {
        // auth(publ)/service-id/owner-id/user-id/records/rec-id/**/file(bin)/sizetag/filename
        return {
            url,
            filename: target_key[target_key.length - 1],
            fileKey: target_key[target_key.length - 2],
            access_group: target_key[6] === '**' ? 'private' : target_key[6] === '01' ? 'authorized' : target_key[6] === '00' ? 'public' : parseInt(target_key[6]),
            uploader: target_key[3],
            record_id: target_key[4] === 'records' ? target_key[5] : 'N/A',
            filesize: fromBase62(target_key[9]),
            uploaded: fromBase62(target_key[8]),
        }
    }

    let filename = url.split('/').slice(-1)[0];

    // if ((config?.dataType === 'blob' || config?.dataType === 'base64') && needAuth) {
    //     // when downloading blob, use signed url
    //     config.expires = 60;
    // }

    let expires = config.expires;
    if (expires) {
        if (!isValidEndpoint) {
            throw new SkapiError('Expires option can only be used on skapi cdn endpoints.', { code: 'INVALID_PARAMETER' });
        }

        if (expires < 0) {
            throw new SkapiError('"config.expires" should be > 0. (seconds)', { code: 'INVALID_PARAMETER' });
        }

        let params: Record<string, any> = {
            request: subdomain ? 'get-host' : 'get',
            id: subdomain || target_key[5],
            // The RAW url the caller passed, minus any query string, NOT the
            // validator-normalized one. The server authorizes this by testing
            // `key in record.bin`, an exact string compare against urls stored
            // fully decoded (s3_notification unquote_plus). validator.Url runs
            // `new URL().href`, which percent-encodes: a private file called
            // "my photo.jpg" or "한글.jpg" arrived as "my%20photo.jpg" /
            // "%ED%95%9C%EA%B8%80.jpg", matched nothing, and the mint failed with
            // "File does not exists." The query is dropped because a stored bin
            // url never has one, and a '?t=' token would never match either.
            key: requestedUrl.split('?')[0],
            expires
        }

        if (service) {
            params.service = service
        }

        // A cacheable mint has to be a GET: a POST response is not stored by any
        // browser cache, so the same signed url could never come back without a
        // round trip and the file would re-download every time.
        let browserCache = config.browserCache;
        let mintOptions: Record<string, any> = { auth: true };

        if (browserCache) {
            if (browserCache < 0) {
                throw new SkapiError('"config.browserCache" should be > 0. (seconds)', { code: 'INVALID_PARAMETER' });
            }

            mintOptions.method = 'get';
            // One host for every mint of this file. The gateway is otherwise
            // picked round robin, and the browser caches by full url, so
            // alternating hosts would hold two entries with two different signed
            // urls and download the file once for each.
            mintOptions.stableGateway = true;
            params.browser_cache = browserCache;

            // Partitions the browser cache per user. A cache is keyed by url
            // alone and shared by everyone using that browser profile, so
            // without this a second user signing in would be served the first
            // user's signed urls. The backend rejects a uid that is not the
            // caller, so a stale value fails loudly instead of silently.
            let uid = this.session?.idToken?.payload?.sub || this.user?.user_id;
            if (uid) {
                params.uid = uid;
            }

            // Cache generation, plus a window stamp when this is a repair. NOT
            // `revalidate`: that sends Cache-Control: no-cache as a REQUEST
            // header, which the gateway's CORS preflight does not allow, so the
            // browser refused to send the repair at all and the read fell back to
            // the token path every time. The objection to the old `nocache=<ts>`
            // form was that a per-call timestamp made a new cache key on every
            // attempt and left the poisoned entry answering ordinary reads; a
            // generation plus a window fixes both halves of that.
            params.nocache = mintCacheToken(expires, config.refresh);
        }

        url = (await request.bind(this)('get-signed-url', params,
            mintOptions
        )).url;
    }

    else if (needAuth) {
        let currTime = Math.floor(Date.now() / 1000);

        if (!this.bearerToken && (!this.session?.idToken?.payload?.exp || this.session.idToken.payload.exp < currTime)) {
            this.log('getFile:requesting new token', null);
            try {
                await authentication.bind(this)().getSession({ refreshToken: true });
                this.log('getFile:received new tokens', {
                    exp: this.session?.idToken?.payload?.exp,
                    currTime,
                    expiresIn: this.session?.idToken?.payload?.exp - currTime,
                    token: this.session?.accessToken?.jwtToken,
                    refreshToken: this.session?.refreshToken?.token
                });
            }
            catch (err) {
                this.log('getFile:new token error', err);
                throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
            }
        }

        let token = this.bearerToken || this.session?.idToken?.jwtToken; // idToken

        if (!token || !this.user?.user_id) {
            throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
        }

        url += `${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;

        let access_group = target_key[6] === '**' ? '**' : parseInt(target_key[6]);
        let user_access_group = this.user?.access_group ?? -1;

        if (this.user.user_id !== target_key[3] && (access_group === '**' || user_access_group < access_group)) {
            let record_id = target_key[5];
            if (this.__private_access_key[record_id] && typeof this.__private_access_key[record_id] === 'string') {
                url += `&p=${encodeURIComponent(this.__private_access_key[record_id])}`;
            }
            else if (this.owner !== this.host) {
                try {
                    let p = await this.requestPrivateRecordAccessKey({ record_id, reference_id: config?._ref });
                    url += `&p=${encodeURIComponent(p)}`;
                } catch (err) { }
            }
        }
    }

    if (config?.dataType === 'endpoint') {
        if (config._update) {
            // updates the url in the record (when called from the record bin object)
            config._update.url = url;
        }
        return url;
    }

    if (config?.dataType === 'download') {
        let a = document.createElement('a');
        // Set the href attribute to the file URL
        a.href = url;
        document.body.appendChild(a);
        a.setAttribute('download', filename);
        a.target = '_blank';
        a.click();
        document.body.removeChild(a);
        return null;
    }

    let blob: Promise<Blob | string> = new Promise(async (res, rej) => {
        try {
            let b = await request.bind(this)(
                url,
                null,
                { method: 'get', contentType: null, responseType: config?.dataType === 'text' ? 'text' : 'blob', fetchOptions: { progress: config?.progress } },
                { ignoreService: true }
            );
            if (config?.dataType === 'base64') {
                const reader = new FileReader();
                reader.onloadend = () => res((reader.result as string));
                reader.readAsDataURL(b);
            }
            else {
                res(b);
            }
        } catch (err) {
            // The expected failure of a cached mint: the browser answered from
            // its cache with a url whose signature has since expired, and the
            // file it points at is no longer in the cache either, so the fetch
            // 403s on a url the caller never chose. Re-mint once, bypassing the
            // cache. Only when we actually used the cache, and never twice.
            if (config?.browserCache && !config?.refresh) {
                try {
                    res(await getFile.bind(this)(
                        requestedUrl,
                        Object.assign({}, config, { refresh: true }),
                    ) as Blob | string);
                    return;
                }
                catch (retryErr) {
                    rej(retryErr);
                    return;
                }
            }
            rej(err);
        }
    });

    return blob;
}

/**
 * Scope key for the unique_id -> record_id cache.
 *
 * Every database call may target a service OTHER than the instance's own: callers pass
 * `service`/`owner` per call (the MCP server keeps one Skapi instance per user and names
 * a different project on each call), falling back to the instance's own pair. So the
 * cache must be keyed by the service the call is actually for. Keying it by `this.service`
 * is just as wrong as not keying it at all, because `this.service` is frequently not the
 * service being written to.
 */
function cacheScope(service?: string, owner?: string): string {
    return `${service || this.service}/${owner || this.owner}`;
}

function getScopedUniqueId(scope: string, unique_id: string): string | undefined {
    let bucket = this.__my_unique_ids[scope];
    return bucket ? bucket[unique_id] : undefined;
}

function setScopedUniqueId(scope: string, unique_id: string, record_id: string): void {
    if (!this.__my_unique_ids[scope]) {
        this.__my_unique_ids[scope] = {};
    }
    this.__my_unique_ids[scope][unique_id] = record_id;
}

function deleteScopedUniqueId(scope: string, unique_id: string): void {
    if (this.__my_unique_ids[scope]) {
        delete this.__my_unique_ids[scope][unique_id];
    }
}

async function getQuery(query, isDel = false) {
    query = extractFormData(query, { ignoreEmpty: true }).data || {};

    // Captured before any mutation of `query`: the caller may name the target project,
    // and the cache lookup below must be confined to it.
    let scope = cacheScope.bind(this)(query?.service, query?.owner);

    let is_reference_fetch = '';
    let rec_or_uniq = recordIdOrUniqueId(query);

    if (rec_or_uniq) {
        query = rec_or_uniq;
        is_reference_fetch = query.record_id || query.unique_id;

        if (typeof is_reference_fetch === 'string') {
            if (typeof this.__private_access_key?.[is_reference_fetch] === 'string') {
                query.private_key = this.__private_access_key?.[is_reference_fetch] || undefined;
            }
            let cached = getScopedUniqueId.bind(this)(scope, is_reference_fetch);
            if (cached) {
                if (isDel) {
                    deleteScopedUniqueId.bind(this)(scope, is_reference_fetch);
                }
                else {
                    query.record_id = cached;
                    // delete query.unique_id;
                }
            }
        }
    }
    else {
        let isAdmin = await checkAdmin.bind(this)();
        let ref: any = query?.reference;
        let ref_user_is_me = false;

        if (typeof ref === 'object' && Object.keys(ref).length) {
            if (ref?.record_id || ref?.unique_id) {
                // if (ref.unique_id && this.__my_unique_ids[ref.unique_id]) {
                //     ref.record_id = this.__my_unique_ids[ref.unique_id];
                //     delete ref.unique_id;
                // }

                is_reference_fetch = ref.record_id || ref.unique_id;

                if (is_reference_fetch && typeof this.__private_access_key?.[is_reference_fetch] === 'string') {
                    query.private_key = this.__private_access_key?.[is_reference_fetch] || undefined;
                }

                query.reference = is_reference_fetch;
            }
            else if (ref?.user_id) {
                ref_user_is_me = ref.user_id === this.user?.user_id;
                query.reference = ref.user_id;
            }
        }

        if (typeof query?.table === 'string') {
            query.table = {
                name: query.table,
                access_group: 0
            };
        }

        if (query.index) {
            if (query.index.hasOwnProperty('range') && query.index.hasOwnProperty('condition')) {
                delete query.index.range;
            }
        }

        const buildStruct = (query) => {
            return {
                table: {
                    name: v => validateTableName(v, 'table.name'),
                    access_group: accessGroup.bind(this),
                    subscription: (v: any) => validator.UserId(v, 'User ID in "subscription"')
                },
                reference: 'string',
                index: {
                    name: ['$updated', '$uploaded', '$referenced_count', '$user_id', (v: string) => {
                        return validateCustomIndexName(v, 'index.name');
                    }],
                    value: (v: number | boolean | string) => {
                        const indexTypes = {
                            '$updated': 'number',
                            '$uploaded': 'number',
                            '$referenced_count': 'number',
                            '$user_id': validator.UserId
                        };

                        if (indexTypes.hasOwnProperty(query.index.name)) {
                            let tp = indexTypes[query.index.name];

                            if (typeof tp === 'function') {
                                return tp(v);
                            }

                            if (tp !== typeof v) {
                                throw new SkapiError(`"index.value" should be type: ${tp}.`, { code: 'INVALID_PARAMETER' });
                            }

                            return v;
                        }

                        if (typeof v === 'string' && !v) {
                            return "";
                        }

                        // On a nest query (name ending in '.') this is a child index NAME segment,
                        // not a value, and the backend concatenates it onto the parent name. Names
                        // are escaped on write, so a raw "Rock/Pop" here searched a range that the
                        // stored "Rock%2FPop" falls outside of, and the caller could only find their
                        // own record by typing the internal escaped form.
                        if (typeof v === 'string' && isNestIndexName(query.index.name)) {
                            return validateNestIndexSegment(v, 'index.value');
                        }

                        return indexValue(v);
                    },
                    condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq'],
                    range: (v: number | boolean | string) => indexRange(v, query)
                },
                tag: (v: string) => {
                    if (v === null || v === undefined) {
                        return v;
                    }
                    if (typeof v === 'string') {
                        return validateTag(v, 'tag');
                    }
                    else {
                        throw new SkapiError('"tag" should be type: string.', { code: 'INVALID_PARAMETER' });
                    }
                },
                private_key: 'string'
            }
        }

        query = validator.Params(query || {}, buildStruct(query), ref_user_is_me || isAdmin ? [] : ['table'], { ignoreEmpty: true });
    }
    return {
        query,
        is_reference_fetch
    }
}

export async function getRecords(query: GetRecordQuery & { private_key?: string; }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<RecordData>> {
    await this.__connection;

    let q = await getQuery.bind(this)(query);
    let is_reference_fetch = q.is_reference_fetch;

    // TODO: THINK ABOUT HOW TO HANDLE PRIVATE KEY FOR REFERENCE FETCH.
    // if (is_reference_fetch && typeof this.__private_access_key[is_reference_fetch] === 'string') {
    //     q.query.private_key = this.__private_access_key[is_reference_fetch] || undefined;
    // }

    let result = await request.bind(this)(
        'get-records',
        q.query,
        {
            fetchOptions,
            auth: !!this.__user,
            method: !!this.__user ? 'post' : 'get'
        }
    );

    if (is_reference_fetch && result?.reference_private_key && typeof result.reference_private_key === 'string') {
        this.__private_access_key[is_reference_fetch] = result.reference_private_key;
    }

    let to_process = [];
    for (let i in result.list) {
        to_process.push(normalizeRecord.bind(this)(result.list[i]));
    }

    result.list = await Promise.all(to_process);
    return result;
}

function setupPostRecordConfig(config: PostRecordConfig & { data?: any; }) {
    let is_reference_post = "";
    let files = [];
    // The config names the project this record is posted to (`service`/`owner` are
    // stripped further down, after the caller has read them). Both cache lookups below
    // are confined to it, so a unique_id known in one project can never resolve to that
    // project's record_id while posting into another.
    let scope = cacheScope.bind(this)((config as any)?.service, (config as any)?.owner);
    let _config = validator.Params(config || {}, {
        record_id: (v) => {
            // "record_id" may actually be a unique_id. If we already know the
            // unique_id -> record_id mapping locally, resolve it here; otherwise
            // pass the value through and let the backend resolve it. Do NOT force
            // alphanumeric, since unique_ids (e.g. "src::folder/file.pdf") contain
            // characters a real record_id never would.
            let cached = typeof v === 'string' ? getScopedUniqueId.bind(this)(scope, v) : undefined;
            if (cached) {
                return cached;
            }
            return validateStringByPolicy(v, 'record_id', {
                allowEmpty: false,
            });
        },
        unique_id: ['string', null],
        readonly: 'boolean',
        table: {
            name: v => validateTableName(v, 'table.name'),
            subscription: [null, {
                is_subscription_record: 'boolean',
                upload_to_feed: 'boolean',
                notify_subscribers: 'boolean',
                feed_referencing_records: 'boolean',
                notify_referencing_records: 'boolean',
            }],
            access_group: accessGroup.bind(this),
        },
        source: {
            referencing_limit: (v: number) => {
                if (v === null) {
                    return null;
                }

                else if (typeof v === 'number') {
                    if (0 > v) {
                        throw new SkapiError(`"reference_limit" should be >= 0`, { code: 'INVALID_PARAMETER' });
                    }

                    if (v > 4503599627370546) {
                        throw new SkapiError(`"reference_limit" should be <= 4503599627370546`, { code: 'INVALID_PARAMETER' });
                    }

                    return v;
                }

                throw new SkapiError(`"reference_limit" should be type: <number | null>`, { code: 'INVALID_PARAMETER' });
            },
            prevent_multiple_referencing: 'boolean',
            can_remove_referencing_records: 'boolean',
            only_granted_can_reference: 'boolean',
            allow_granted_to_grant_others: 'boolean',
            referencing_index_restrictions: v => {
                if (v === undefined) {
                    return undefined;
                }

                if (!v) {
                    return null;
                }

                if (Array.isArray(v) && !v.length) {
                    return null;
                }

                let p = {
                    name: v => validateCustomIndexName(v, '"name" in "index_restrictions"'),
                    value: v => indexValue(v),
                    condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne', () => null],
                    range: val => {
                        if (val !== null && typeof v.value !== typeof val) {
                            throw new SkapiError('Index restriction "range" type should match the type of "value".', { code: 'INVALID_PARAMETER' });
                        }
                        if (!v.hasOwnProperty('value')) {
                            throw new SkapiError('Index restriction "value" is required.', { code: 'INVALID_PARAMETER' });
                        }
                        return val;
                    }
                }

                if (!Array.isArray(v)) {
                    v = [v];
                }

                let qq = v.map(vv => validator.Params(vv, p, ['name']));
                if (qq.length) {
                    for (let q of qq) {
                        if (q.condition && q.hasOwnProperty('range')) {
                            delete q.range;
                        }
                    }
                }
                return qq;
            },
        },
        reference: v => {
            if (v === null) {
                return { record_id: null };
            }
            if (!v) {
                return undefined;
            }
            if (typeof v === 'string') {
                is_reference_post = v;
                // Scoped: an unscoped hit here is what silently redirected a
                // "src::<file>" reference to a same-named file's record in a
                // different project, which the backend then rejected as missing.
                let cached = getScopedUniqueId.bind(this)(scope, v);
                if (cached) {
                    return cached;
                }
                return v;
            }

            if (typeof v !== 'object') {
                throw new SkapiError('"reference" should be type: <string | object>.', { code: 'INVALID_PARAMETER' });
            }

            return validator.Params(v, {
                unique_id: 'string',
                record_id: v => {
                    if (v === null || v === undefined) {
                        return v;
                    }
                    is_reference_post = v;
                    if (typeof this.__private_access_key?.[v] === 'string') {
                        config.reference_private_key = this.__private_access_key[v] || undefined;
                    }
                    return validateStringByPolicy(v, 'reference.record_id', {
                        allowEmpty: false,
                        onlyAlphanumeric: true,
                    });
                }
            });
        },
        index: [null, {
            name: v => validateCustomIndexName(v, 'index.name'),
            value: v => indexValue(v)
        }],
        tags: (v: string | string[]) => {
            if (v === null || v === undefined) {
                return v;
            }
            if (typeof v === 'string') {
                v = v.split(',').map(t => t.trim());
            }
            if (!Array.isArray(v)) {
                throw new SkapiError('"tag" should be type: <string | string[]>.', { code: 'INVALID_PARAMETER' });
            }
            return v.map(t => validateTag(t, 'tag'));
        },
        remove_bin: (v: string[] | BinaryFile[] | null) => {
            if (!v) {
                return null;
            }

            let arr = []
            if (Array.isArray(v)) {
                for (let i of v) {
                    if (typeof i === 'string') {
                        // Strip the "?t=<token>" getFile appends, but do NOT decode: the stored bin
                        // url holds the filename raw, so decoding produced a url that matches
                        // nothing. The backend's DELETE on a string set ignores a non-matching
                        // element, so removing a file named "a%2Fb.pdf" silently did nothing.
                        arr.push(i.split('?')[0]);
                    }
                    else if (i.url && i.size && i.filename) {
                        let hostUrl = i.url.split('/').slice(0, 3).join('/');
                        let url = hostUrl + '/' + i.path;
                        arr.push(url);
                    }
                    else {
                        throw new SkapiError(`"remove_bin" should be type: <string[] | BinaryFile[] | null>`, { code: 'INVALID_PARAMETER' });
                    }
                }
            }
            else {
                throw new SkapiError(`"remove_bin" should be type: <string[] | BinaryFile[] | null>`, { code: 'INVALID_PARAMETER' });
            }

            return arr;
        },
        progress: 'function',
        data: v => v
    }, [], {
        precall: (pc) => {
            const data = pc?.data || {};

            if (!data?.record_id && !data.table) {
                throw new SkapiError('"table.name" is required.', { code: 'INVALID_PARAMETER' });
            }

            if (typeof data.table === 'string') {
                data.table = {
                    name: data.table,
                    access_group: 0
                };
            }

            if (pc.files) {
                files = pc.files;
            }
        }
    });

    let progress = config.progress || null;

    // callbacks should be removed after cocochex
    delete _config.progress;

    if (!this.__user) {
        const hasEnabledSubscriptionOptions = !!(
            _config.table?.subscription?.is_subscription_record
            || _config.table?.subscription?.upload_to_feed
            || _config.table?.subscription?.notify_subscribers
            || _config.table?.subscription?.feed_referencing_records
            || _config.table?.subscription?.notify_referencing_records
        );

        if (_config.record_id) {
            throw new SkapiError('Public users cannot update existing records.', { code: 'INVALID_REQUEST' });
        }
        if (_config.table.access_group !== 'public' && _config.table.access_group !== 0) {
            throw new SkapiError('Public users can only post records to public tables.', { code: 'INVALID_REQUEST' });
        }
        if (hasEnabledSubscriptionOptions) {
            throw new SkapiError('Public users cannot post subscription records.', { code: 'INVALID_REQUEST' });
        }
        if (_config.remove_bin) {
            throw new SkapiError('Public users cannot remove files from records.', { code: 'INVALID_REQUEST' });
        }
        if (_config.unique_id) {
            throw new SkapiError('Public users cannot set unique_id for records.', { code: 'INVALID_REQUEST' });
        }
    }
    return { config: _config, progress, is_reference_post, files };
}

export async function bulkPostRecords(params) {
    await this.__connection;

    if (!Array.isArray(params) || !params.length) {
        throw new SkapiError('"params" should be a non-empty array.', { code: 'INVALID_PARAMETER' });
    }

    let reference_posts = [];
    let service = undefined;
    let owner = undefined;
    let progress = null;

    let validatedBulk = params.map((config, idx) => {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            throw new SkapiError(`"params[${idx}]" should be type: <object>.`, { code: 'INVALID_PARAMETER' });
        }

        let mangled = setupPostRecordConfig.bind(this)(config) as {config: PostRecordConfig & { service?: string; owner?: string;  }; is_reference_post?: string;};
        let _config = mangled.config;
        if (mangled.is_reference_post) {
            reference_posts.push(mangled.is_reference_post);
        }
        if (typeof _config.progress === 'function' && progress === null) {
            progress = _config.progress;
        }

        if (_config.service !== undefined) {
            if (service === undefined) {
                service = _config.service;
            }
            else if (service !== _config.service) {
                throw new SkapiError('All bulk params should share the same "service" value.', { code: 'INVALID_PARAMETER' });
            }
        }

        if (_config.owner !== undefined) {
            if (owner === undefined) {
                owner = _config.owner;
            }
            else if (owner !== _config.owner) {
                throw new SkapiError('All bulk params should share the same "owner" value.', { code: 'INVALID_PARAMETER' });
            }
        }

        delete _config.progress;
        delete _config.service;
        delete _config.owner;

        return _config;
    });

    let postData = {
        _is_bulk_: validatedBulk,
        service: "",
        owner: ""
    };

    if (service !== undefined) {
        postData.service = service;
    }

    if (owner !== undefined) {
        postData.owner = owner;
    }

    let options = { auth: !!this.__user, method: 'post' };
    let fetchOptions = {};

    // if (typeof progress === 'function') {
    //     fetchOptions.progress = progress;
    // }

    if (Object.keys(fetchOptions).length) {
        Object.assign(options, { fetchOptions });
    }

    let recList = await request.bind(this)('post-record', postData, options);
    let records = await Promise.all(recList.map((rec) => normalizeRecord.bind(this)(rec, 'called from postRecord')));

    // Bulk posts all share one service/owner (enforced above), so one scope covers the
    // whole batch. Falls back to the instance's own pair when the caller named neither.
    let scope = cacheScope.bind(this)(service, owner);

    for (let i = 0; i < recList.length; i++) {
        let rec = recList[i];
        let record = records[i];

        // if (rec?.rec) {
        //     window.sessionStorage.setItem(`${this.service}:post:${rec.rec}`, JSON.stringify(rec));
        // }

        // The backend reports a per-element rejection as an error OBJECT INSIDE the
        // returned array rather than by throwing, e.g. {error:{code:"NOT_EXISTS",
        // message:'Reference "VQs5..." does not exists.'}}. normalizeRecord does not
        // know the `error` key, so it dropped it and handed back a fully-shaped EMPTY
        // record: callers saw an ordinary array of records, counted the rejections as
        // saves, and the one thing that explained the failure was gone. Carry it across
        // so a caller can report WHY a record did not save. An empty record_id remains
        // the reliable "not saved" signal; this only adds the reason.
        if (rec && typeof rec === 'object' && rec.error && record && !record.record_id) {
            record.error = rec.error;
        }

        if (typeof rec?.reference_private_key === 'string') {
            for (let ref of reference_posts) {
                this.__private_access_key[ref] = rec.reference_private_key;
            }
        }

        if (record?.unique_id) {
            setScopedUniqueId.bind(this)(scope, record.unique_id, record.record_id);
        }
    }

    // if (Object.keys(this.__my_unique_ids).length) {
    //     window.sessionStorage.setItem(`${this.service}:uniqueids`, JSON.stringify(this.__my_unique_ids));
    // }

    return records;
}

export async function postRecord(
    form: Form<Record<string, any>> | null | undefined,
    config: PostRecordConfig,
    files?: { name: string, file: File }[],
): Promise<RecordData> {
    await this.__connection;

    if (!config) {
        throw new SkapiError('"config" argument is required.', { code: 'INVALID_PARAMETER' });
    }

    let postConf = setupPostRecordConfig.bind(this)(config);
    let _config = postConf.config;
    let progress = postConf.progress;
    let is_reference_post = postConf.is_reference_post;

    let options: { [key: string]: any } = { auth: !!this.__user, method: 'post' };

    let to_bin: { name: string, file: File }[] = [];
    let extractedForm = extractFormData(form);
    if (files && Array.isArray(files) && files.length) {
        // { name: string, file: File }[]
        to_bin = to_bin.concat(files);
    }
    if (extractedForm.files && Array.isArray(extractedForm.files) && extractedForm.files.length) {
        // { name: string, file: File }[]
        to_bin = to_bin.concat(extractedForm.files);
    }

    let postData = null;
    postData = Object.assign({ data: extractedForm.data }, _config);

    let fetchOptions: { [key: string]: any } = {};

    if (typeof progress === 'function') {
        fetchOptions.progress = progress;
    }

    if (Object.keys(fetchOptions).length) {
        Object.assign(options, { fetchOptions });
    }
    let rec = await request.bind(this)('post-record', postData, options);
    if (isBrowserRuntime() && to_bin.length) {
        let bin_formData = new FormData();
        for (let f of to_bin) {
            bin_formData.append(f.name, f.file, f.file.name);
        }
        let uploadFileParams = {
            record_id: rec.rec,
            progress
        }
        if (_config.hasOwnProperty('service')) {
            uploadFileParams['service'] = _config.service;
        }
        let { bin_endpoints } = await uploadFiles.bind(this)(bin_formData, uploadFileParams);
        if (!rec.bin) {
            rec.bin = bin_endpoints;
        }
        else {
            rec.bin.push(...bin_endpoints);
        }
    }

    if (is_reference_post && typeof rec?.reference_private_key === 'string') {
        this.__private_access_key[is_reference_post] = rec.reference_private_key;
    }

    // window.sessionStorage.setItem(`${this.service}:post:${rec.rec}`, JSON.stringify(rec));

    // If the server offloaded the "data" payload to storage (too large for the
    // record item), the response carries a { __data__: <path> } marker. Skip the
    // re-download and return exactly what was posted.
    let dataOffloaded = !!rec && rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data) && typeof rec.data.__data__ === 'string' && rec.data.__data__.endsWith('/__data__/__json__.json');
    let record = await normalizeRecord.bind(this)(rec, 'called from postRecord', true);
    if (dataOffloaded) {
        record.data = extractedForm.data;
    }
    if (record.unique_id) {
        let scope = cacheScope.bind(this)((_config as any)?.service, (_config as any)?.owner);
        setScopedUniqueId.bind(this)(scope, record.unique_id, record.record_id);
        if (isBrowserRuntime()) {
            // Debounce + guard the persistence. Previously every postRecord
            // re-stringified the entire, ever-growing map synchronously, so a
            // bulk upload (e.g. 10k files, each writing a src:: unique_id) did
            // O(n^2) JSON work and could throw QuotaExceededError mid-batch,
            // failing the upload. Coalesce writes to at most one per idle tick
            // and swallow storage errors so persistence never breaks an upload.
            if (this.__uniqueIdsPersistTimer !== null) {
                clearTimeout(this.__uniqueIdsPersistTimer);
            }
            this.__uniqueIdsPersistTimer = setTimeout(() => {
                this.__uniqueIdsPersistTimer = null;
                try {
                    // Persist ONLY the scope just written, under a key that names both
                    // service and owner. Writing the whole map under a service-only key
                    // is what let one project's entries be restored into another.
                    window.sessionStorage.setItem(`${scope}:uniqueids`, JSON.stringify(this.__my_unique_ids[scope] || {}));
                } catch (e) {
                    // sessionStorage full/unavailable: keep the in-memory map,
                    // just skip persistence for this session.
                }
            }, 500);
        }
    }

    return record;
}

export async function getTables(
    /** If null fetch all list of tables. */
    query: {
        table: string;
        /** Condition operator of table name. */
        condition?: Condition;
    },
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse<Table>> {
    let res = await request.bind(this)('get-table', validator.Params(query || {}, {
        // Escaped, because storage holds the escaped form: a lookup for a table literally named
        // "a/b" has to go out as "a%2Fb" or it matches nothing. The response is decoded below, so
        // leaving the query raw made this one call the only place where the caller had to know
        // about the wire format. Empty is allowed: table '' or ' ' with a condition is the
        // "list everything" idiom.
        table: (v: string) => validateTableName(v, 'table', { allowEmpty: true }),
        condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne']
    }), Object.assign({ auth: !!this.__user }, { fetchOptions }));

    let convert = {
        'cnt_rec': 'number_of_records',
        'tbl': 'table',
        'srvc': 'service',
        'grp_': 'number_of_records_in_access_group_'
    };

    if (Array.isArray(res?.list)) {
        for (let t of res.list) {
            for (let k in convert) {
                if(k === 'grp_') {
                    for (let gk in t) {
                        if (gk.startsWith('grp_')) {
                            let access_group = gk.substring(4);
                            if(access_group === 'pv') {
                                access_group = 'private';
                            }
                            else if(access_group === '00') {
                                access_group = 'public';
                            }
                            else if(access_group === '01') {
                                access_group = 'authorized';
                            }
                            else if(access_group === '99') {
                                access_group = 'admin';
                            }
                            t[`number_of_records_in_access_group_${access_group}`] = t[gk];
                            delete t[gk];
                        }
                    }
                }
                if (t.hasOwnProperty(k)) {
                    t[convert[k]] = t[k];
                    delete t[k];
                }
            }

            if (typeof t.table === 'string') {
                t.table = decodeReservedDelimiters(t.table);
            }
        }
    }

    return res;
}

export async function getIndexes(
    query: {
        /** Table name */
        table: string;
        /** Index name. When period is at the end of name, querys nested index keys. */
        index?: string;
        /** Queries order by */
        order?: {
            /** Key name to order by. */
            by: 'average_number' | 'total_number' | 'number_count' | 'average_bool' | 'total_bool' | 'bool_count' | 'string_count' | 'index_name';
            /** Value to query. */
            value?: number | boolean | string;
            condition?: Condition;
        };
    },
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse<Index>> {
    if (!query?.table) {
        throw new SkapiError('"table" is required.', { code: 'INVALID_PARAMETER' });
    }

    let p:any = validator.Params(
        query || {},
        {
            // Escaped for the same reason as getTables: storage holds the escaped form.
            table: (v: string) => validateTableName(v, 'table', { allowEmpty: true }),
            index: (v: string) => validateCustomIndexName(v, 'index.name'),
            order: {
                by: [
                    'average_number',
                    'total_number',
                    'number_count',
                    'average_bool',
                    'total_bool',
                    'bool_count',
                    'string_count',
                    'index_name',
                    'number_of_records'
                ],
                value: (v: any) => {
                    // When ordering by 'index_name', order.value is NOT a value: the backend
                    // concatenates it onto the index name to build the composite key
                    // (get_index: idx = index + order.value), so it is a name fragment and needs the
                    // same escaping the name itself got. Sent raw, it searched for "svc/t/Band.Mem/bers"
                    // while storage held "svc/t/Band.Mem%2Fbers", returning an empty list with no
                    // error, and the getIndexes response hands back the decoded spelling that fails.
                    // For every other "by" the value is a numeric threshold and must be left alone.
                    if (query?.order?.by === 'index_name' && typeof v === 'string') {
                        return validateStringByPolicy(v, 'order.value', {
                            allowEmpty: true,
                            maxLength: 256,
                            blockKeyDelimiters: true
                        });
                    }
                    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
                        throw new SkapiError('"order.value" should be type: <string | number | boolean>.', { code: 'INVALID_PARAMETER' });
                    }
                    return v;
                },
                condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne']
            }
        },
        ['table']
    );

    if (p.hasOwnProperty('order')) {
        if (!p.order?.by) {
            throw new SkapiError('"order.by" is required.', { code: 'INVALID_PARAMETER' });
        }

        if (p.order.hasOwnProperty('condition') && !p.order.hasOwnProperty('value')) {
            throw new SkapiError('"value" is required for "condition".', { code: 'INVALID_PARAMETER' });
        }

        if (p.hasOwnProperty('index')) {
            if (p.index.substring(p.index.length - 1) !== '.') {
                throw new SkapiError('"index" should be a parent index name of the compound index when using "order.by"', { code: 'INVALID_PARAMETER' });
            }
        }
    }

    let res = await request.bind(this)(
        'get-index',
        p,
        Object.assign(
            { auth: !!this.__user },
            { fetchOptions }
        )
    );

    let convert = {
        'cnt_bool': 'boolean_count',
        'cnt_numb': 'number_count',
        'totl_numb': 'total_number',
        'totl_bool': 'total_bool',
        'avrg_numb': 'average_number',
        'avrg_bool': 'average_bool',
        'cnt_str': 'string_count'
    };

    if (Array.isArray(res?.list)) {
        res.list = res.list.map((i: Record<string, any>) => {
            let iSplit = i.idx.split('/');
            let resolved: Record<string, any> = {
                table: decodeReservedDelimiters(iSplit[1]),
                index: decodeReservedDelimiters(iSplit[2]),
                number_of_records: i.cnt_rec
            };

            for (let k in convert) {
                if (Object.prototype.hasOwnProperty.call(i, k)) {
                    resolved[convert[k]] = i[k];
                }
            }

            return resolved;
        });
    }

    return res;
}

export async function getTags(
    query?: {
        /** Table name */
        table: string;
        /** Tag name */
        tag?: string;
        /** String query condition for tag name. */
        condition?: Condition;
    },
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse<Tag>> {

    let res = await request.bind(this)(
        'get-tag',
        validator.Params(query || {},
            {
                // Both escaped: the stored tag key is "<tag>/<table>", both segments in escaped
                // form, and the response is decoded below.
                table: (v: string) => validateTableName(v, 'table', { allowEmpty: true }),
                tag: (v: string) => validateTag(v, 'tag', { allowEmpty: true }),
                condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne']
            }
        ),
        Object.assign({ auth: !!this.__user }, { fetchOptions })
    );

    if (Array.isArray(res?.list)) {
        res.list = res.list.map(item => {
            let tSplit = item.tag.split('/');
            return {
                table: decodeReservedDelimiters(tSplit[1]),
                tag: decodeReservedDelimiters(tSplit[0]),
                number_of_records: item.cnt_rec
            };
        });
    }

    return res;
}

export async function getUniqueId(
    query?: Form<{
        /** Unique ID */
        unique_id?: string;
        /** String query condition for tag name. */
        condition?: Condition;
    }>,
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse<UniqueId>> {

    let res = await request.bind(this)(
        'get-uniqueid',
        validator.Params(query || {},
            {
                unique_id: 'string',
                condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne']
            }
        ),
        Object.assign({ auth: !!this.__user }, { fetchOptions })
    );

    if (Array.isArray(res?.list)) {
        for (let i in res.list) {
            let item = res.list[i];
            res.list[i] = {
                unique_id: item.unq,
                record_id: item.rec
            };
        }
    }

    return res;
}

export async function deleteRecords(query: DelRecordQuery & { private_key?: string; }, fetchOptions?: FetchOptions): Promise<string | DatabaseResponse<RecordData>> {
    await this.__connection;

    let q = await getQuery.bind(this)(query, true);
    let is_reference_fetch = q.is_reference_fetch;
    let result = await request.bind(this)('del-records', q.query, { auth: true, fetchOptions });
    if (is_reference_fetch && typeof result?.reference_private_key === 'string') {
        this.__private_access_key[is_reference_fetch] = result.reference_private_key;
    }

    return result?.message || result;
}

export function grantPrivateRecordAccess(params: {
    record_id: string;
    user_id: string | string[];
}) {
    return recordAccess.bind(this)({
        record_id: params.record_id,
        user_id: params.user_id,
        execute: 'add'
    });
}

export function removePrivateRecordAccess(params: {
    record_id: string;
    user_id: string | string[];
}) {
    return recordAccess.bind(this)({
        record_id: params.record_id,
        user_id: params.user_id || null,
        execute: 'remove'
    });
}

export async function listPrivateRecordAccess(p: {
    record_id?: string;
    user_id?: string | string[];
}, fetchOptions?: FetchOptions): Promise<DatabaseResponse<{ record_id: string; user_id: string; }>> {
    let params = {
        record_id: p.record_id || undefined,
        user_id: p.user_id || undefined,
        execute: 'list'
    };

    if (!params.record_id && !params.user_id) {
        throw new SkapiError(`Either record_id or user_id must be provided.`, { code: 'INVALID_PARAMETER' });
    }

    if (params.user_id) {
        if (typeof params.user_id === 'string') {
            validator.UserId(params.user_id);
            params.user_id = [params.user_id];
        }
        else if (Array.isArray(params.user_id)) {
            for (let u of params.user_id) {
                validator.UserId(u);
            }
        }
        else {
            throw new SkapiError(`user_id should be type: <string | string[]>`, { code: 'INVALID_PARAMETER' });
        }
    }

    let mapper = (i: Record<string, any>) => {
        if (i.rec_usr) {
            i.record_id = i.rec_usr.split('/')[0];
            i.user_id = i.rec_usr.split('/')[1];
        }
        else if (i.usr_rec) {
            i.user_id = i.usr_rec.split('/')[0];
            i.record_id = i.usr_rec.split('/')[1];
        }
        return i;
    };

    let list = await request.bind(this)(
        'grant-private-access',
        params,
        { auth: true, fetchOptions }
    );

    list.list = list.list.map(mapper);

    return list;
}

export function requestPrivateRecordAccessKey(params: { record_id: string, reference_id?: string }): Promise<string> {
    let record_id: string | string[] = params.record_id;
    let reference_id = params.reference_id || undefined;
    if (!record_id) {
        throw new SkapiError(`Record ID is required.`, { code: 'INVALID_PARAMETER' });
    }

    if (typeof record_id !== 'string') {
        throw new SkapiError(`Record ID should be type: <string | string[]>`, { code: 'INVALID_PARAMETER' });
    }

    if (reference_id && typeof reference_id !== 'string') {
        throw new SkapiError(`Reference ID should be type: <string>`, { code: 'INVALID_PARAMETER' });
    }

    if (typeof this.__private_access_key[record_id] === 'string') {
        return Promise.resolve(this.__private_access_key[record_id]);
    }

    if (pendingPrivateAccessKeyRequest[record_id]) {
        return pendingPrivateAccessKeyRequest[record_id];
    }

    let res = request
        .bind(this)(
            'request-private-access-key',
            { record_id, reference_id },
            { auth: true }
        )
        .then((r: any) => {
            let privateKey = typeof r === 'string' ? r : r?.private_key;
            if (typeof privateKey !== 'string') {
                throw new SkapiError('Invalid private access key response.', { code: 'ERROR' });
            }

            this.__private_access_key[record_id] = privateKey;
            return privateKey;
        })
        .finally(() => {
            delete pendingPrivateAccessKeyRequest[record_id];
        });

    pendingPrivateAccessKeyRequest[record_id] = res;

    return res;
}

function recordAccess(params: {
    record_id: string;
    user_id: string | string[];
    execute: 'add' | 'remove';
}): Promise<any> {
    let execute = params.execute;
    let req = validator.Params(params,
        {
            record_id: 'string',
            user_id: (v: string | string[]) => {
                if (!v) {
                    throw new SkapiError(`User ID is required.`, { code: 'INVALID_PARAMETER' });
                }

                let id = v;
                if (typeof id === 'string') {
                    id = [id];
                }

                if (id.length > 100) {
                    throw new SkapiError(`Cannot process more than 100 users at once.`, { code: 'INVALID_REQUEST' });
                }

                for (let i of id) {
                    validator.UserId(i, 'User ID in "user_id"');
                }

                return id;
            },
            execute: ['add', 'remove']
        },
        [
            'execute',
            'record_id',
            'user_id'
        ]
    );

    if (!req.user_id) {
        req.user_id = null;
    }

    return request.bind(this)(
        'grant-private-access',
        req,
        { auth: true }
    );
}

