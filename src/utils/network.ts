
import SkapiError from '../main/error';
import { encState, maybeEncryptFile } from '../methods/encryption';
import { Form, FetchOptions, DatabaseResponse, ProgressCallback, UploadFilesParams, UploadFilesResult, FileUploadError } from '../Types';
import validator from './validator';
import { MD5, generateRandom, extractFormData, isBrowserRuntime } from './utils';
// import { authentication, getJwtToken } from '../methods/user';
import { getJwtToken } from '../methods/user';
import Qpass from "qpass";

let requestQueue = null;
const hasSubmitEvent = typeof SubmitEvent !== 'undefined';
const hasHTMLFormElement = typeof HTMLFormElement !== 'undefined';
const isBrowser = isBrowserRuntime();
// Global counters for round-robin
let request_counter = 0;

function getRetryDelayMs(retryAfter: string | null): number | null {
    if (!retryAfter) {
        return null;
    }

    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
    }

    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - Date.now());
    }

    return null;
}

// Bounded 429 handling. A 429 that carried Retry-After used to be retried for as long as the
// server kept answering 429, with no cap, so a throttled endpoint held the caller for ever.
// A request is now retried at most RATE_LIMIT_MAX_RETRIES times, each wait the server's
// Retry-After plus a little jitter (or a growing default when it says 0, so a burst of
// clients does not come back in step), then it fails with TOO_MANY_REQUESTS naming the
// endpoint. A 429 WITHOUT Retry-After still fails at once, as it always did.
const RATE_LIMIT_MAX_RETRIES = 6;
const RATE_LIMIT_MAX_WAIT_MS = 60000;

function rateLimitWaitMs(retryDelayMs: number, attempt: number): number {
    // `attempt` counts from 0 on the first retry.
    let base = retryDelayMs > 0 ? retryDelayMs : Math.min(RATE_LIMIT_MAX_WAIT_MS, 500 * Math.pow(2, attempt));
    base = Math.min(RATE_LIMIT_MAX_WAIT_MS, base);
    let jitter = Math.floor(Math.random() * Math.min(1000, Math.max(50, base * 0.25)));
    return base + jitter;
}

function rateLimitExhausted(what: string): SkapiError {
    return new SkapiError(`Too many requests: ${what} still answered 429 after ${RATE_LIMIT_MAX_RETRIES} retries.`, { code: 'TOO_MANY_REQUESTS' });
}

function toPercent(loaded: number, total: number): number {
    return total > 0 ? (loaded / total) * 100 : 0;
}

let selectGateway = (params: { auth: boolean, type: string, endpoints: {[key:string]: string}[], stable?: boolean }) => {
    const { auth, type, endpoints, stable } = params;

    const admin = endpoints[0];
    // {
    //     "admin_public": "https://nty2bxrol1.execute-api.eu-west-1.amazonaws.com/api/",
    //     "admin_private": "https://4250a1g3bd.execute-api.eu-west-1.amazonaws.com/api/",
    //     "admin_public_2": "https://of8ur90ix1.execute-api.eu-west-1.amazonaws.com/api/",
    //     "admin_private_2": "https://gge4qiyqv2.execute-api.eu-west-1.amazonaws.com/api/",
    //     "get_users_private": "https://eztrfvyq49.execute-api.eu-west-1.amazonaws.com/api/",
    //     "service_public": "https://pg695jr002.execute-api.eu-west-1.amazonaws.com/api/",
    //     "extra_public": "https://8zpb401kr3.execute-api.eu-west-1.amazonaws.com/api/",
    //     "extra_private": "https://o5vqmktoa4.execute-api.eu-west-1.amazonaws.com/api/",
    //     "extra_public_2": "https://u3c0pt5v7a.execute-api.eu-west-1.amazonaws.com/api/",
    //     "extra_private_2": "https://dr6glk4kz8.execute-api.eu-west-1.amazonaws.com/api/",
    //     "userpool_id": "eu-west-1_vq4rt05un",
    //     "userpool_client": "76uku0vqmkko2os1s8sh8dmpar"
    // }
    const record = endpoints[1];
    // {
    //     "record_public": "https://9zxjxkrczi.execute-api.ap-northeast-1.amazonaws.com/api/",
    //     "record_private": "https://luvgxcgpwd.execute-api.ap-northeast-1.amazonaws.com/api/",
    //     "record_public_2": "https://ekhpyuchg6.execute-api.ap-northeast-1.amazonaws.com/api/",
    //     "record_private_2": "https://nprhgj1xkj.execute-api.ap-northeast-1.amazonaws.com/api/",
    //     "post_public": "https://cbzajunw33.execute-api.ap-northeast-1.amazonaws.com/api/",
    //     "post_private": "https://j51bbrnqb7.execute-api.ap-northeast-1.amazonaws.com/api/",
    //     "get_public": "https://nmnczc41wg.execute-api.ap-northeast-1.amazonaws.com/api/",
    //     "get_private": "https://0zpwltd5yh.execute-api.ap-northeast-1.amazonaws.com/api/",
    //     "del_private": "https://w7grra2h6k.execute-api.ap-northeast-1.amazonaws.com/api/",
    //     "websocket_private": "wss://t47k8wdn19.execute-api.ap-northeast-1.amazonaws.com/api"
    // }

    request_counter++;

    if (type === 'admin') {
        const gateways_admin_round_robin = Object.entries(admin)
            .filter(([k, v]) => k.includes(auth ? '_private' : '_public') && k !== 'get_users_private' && k !== 'service_public' && typeof v === 'string')
            .map(([, v]) => v);

        if (!gateways_admin_round_robin.length) {
            throw new SkapiError('No available admin gateways.', { code: 'INVALID_REQUEST' });
        }

        return gateways_admin_round_robin[request_counter % gateways_admin_round_robin.length];
    }
    if (type === 'record') {
        const gateways_record_round_robin = Object.entries(record)
            .filter(([k, v]) => k.includes(auth ? 'record_private' : 'record_public') && typeof v === 'string')
            .map(([, v]) => v);

        if (!gateways_record_round_robin.length) {
            throw new SkapiError('No available record gateways.', { code: 'INVALID_REQUEST' });
        }

        // A response the BROWSER is meant to cache has to come back from the same
        // host every time: the http cache is keyed by the whole url, so letting
        // the round robin alternate between record_private and record_private_2
        // gives the same file two cache entries holding two different signed
        // urls, and the file is downloaded once for each. Pinning costs this one
        // request its turn in the rotation and nothing else.
        if (stable) {
            return gateways_record_round_robin[0];
        }

        return gateways_record_round_robin[request_counter % gateways_record_round_robin.length];
    }

    throw new SkapiError('Invalid gateway type.', { code: 'INVALID_REQUEST' });
}

async function getEndpoint(dest: string, auth: boolean, stableGateway?: boolean) {
    const endpoints = await Promise.all([
        this.admin_endpoint,
        this.record_endpoint
    ]);

    const admin = endpoints[0];
    const record = endpoints[1];

    let params = dest.split('?');
    let query = params.length > 1 ? '?' + params[1] : '';
    dest = params[0];

    switch (dest) {
        case 'get-users': ////
            return admin.get_users_private + dest + query;
        case 'service': ////
            return admin.service_public + dest + query;
        case 'get-newsletters':
        case 'get-public-newsletters':
        case 'subscribe-newsletter':
        case 'subscribe-public-newsletter':
        case 'signupkey':
        case 'admin-newsletter-request':
        case 'admin-signup':
        case 'confirm-signup':
        case 'openid-logger':
        case 'block-account':
        case 'admin-edit-profile':
        case 'remove-account':
        case 'post-secure':
        case 'recover-account':
        case 'mock':
        case 'grant-access':
        case 'last-verified-email':
        case 'ticket':
        case 'register-ticket':
        case 'get-newsletter-subscription':
        case 'send-inquiry':
        case 'register-newsletter-group':
        case 'delete-newsletter-group':
        case 'newsletter-group-endpoint':
        case 'invitation-list':
        case 'csr':
        case 'csr-poll':
        case 'csr-cancel':
        case 'csr-finalize':
            return selectGateway.bind(this)({ auth, type: 'admin', endpoints }) + dest + query;

        // Records
        case 'post-record': ////
            // Dedicated gateway api for post-record
            return (auth ? record.post_private : record.post_public) + dest + query;

        case 'get-records': ////
            // Dedicated gateway api for get-record
            return (auth ? record.get_private : record.get_public) + dest + query;

        case 'del-files': //
        case 'del-records': //
            // Dedicated gateway api for del-records and del-files
            return record.del_private + dest + query;
        case 'store-subscription':
        case 'get-vapid-public-key':
        case 'push-notification':
        case 'delete-subscription':
        case 'subscription':
        case 'get-subscription':
        case 'get-table':
        case 'get-tag':
        case 'get-uniqueid':
        case 'get-index':
        case 'get-signed-url':
        // Bulk upload permits (record stack, POST /get-signed-urls). See uploadFiles.
        case 'get-signed-urls':
        case 'extract-file-text':
        // The server-side spreadsheet reader (record stack, GridQuery Lambda, POST /grid-query on
        // every record gateway). Missing from this table it was an "invalid url" to the SDK, so
        // the MCP's queryGrid tool, and the worker's server-side row ingest behind it, could not
        // reach a Lambda that was deployed and answering. Found by a live end-to-end run, not by
        // a unit test: nothing below this line is exercised without a network.
        case 'grid-query':
        case 'grant-private-access':
        case 'request-private-access-key':
        case 'get-ws-group':
        case 'check-schema':
        case 'get-feed':
        // From viviplayground
        case 'castspell':
        case 'dopamine':
        case 'getspell':
            return selectGateway.bind(this)({ auth, type: 'record', endpoints, stable: stableGateway }) + dest + query;

        default:
            return validator.Url(dest) + query;
    }
}

const __pendingRequest: Record<string, Promise<any>> = {};

export function terminatePendingRequests() {
    if (requestQueue) {
        requestQueue.terminate();
        requestQueue = null;
    }
}

export async function request(
    url: string,
    data: Form<any> = null,
    options?: {
        fetchOptions?: FetchOptions;
        auth?: boolean;
        method?: string;
        bypassAwaitConnection?: boolean;
        responseType?: 'json' | 'blob' | 'text' | 'arrayBuffer' | 'formData' | 'document';
        contentType?: string;
        tokenHeaders?: {
            accessToken?: boolean | string;
            idToken?: boolean | string;
        };
        // Always resolve to the SAME gateway host instead of taking the next one
        // in the round robin. Only for a response the browser is meant to cache:
        // the http cache is keyed by the full url, so an alternating host would
        // silently halve the hit rate and duplicate whatever the response points
        // at. See selectGateway.
        stableGateway?: boolean;
        // Send `Cache-Control: no-cache`, so the browser revalidates this exact
        // url and OVERWRITES its stored response instead of adding a second entry
        // beside it. Pair with stableGateway when replacing a cached response.
        revalidate?: boolean;
    },
    _etc?: {
        ignoreService: boolean;
    }
): Promise<any> {
    this.log('request', { url, data, options, _etc: _etc || {} });

    options = options || {};

    let {
        auth = false,
        method = 'post',
        bypassAwaitConnection = false,
    } = options;

    method = method.toUpperCase();

    let __connection = null;
    let token = null; // idToken
    let endpoint = await getEndpoint.bind(this)(url, !!auth, !!options.stableGateway);
    // Read AFTER getEndpoint, which waits for the endpoints and therefore for the
    // Project ID when the instance was created with the docs' placeholder: before
    // it is entered this.service and this.owner are not set yet.
    let service = data?.service || this.service;
    let owner = data?.owner || this.owner;

    if (!bypassAwaitConnection) {
        __connection = await this.__connection;
        if (!__connection) {
            throw new SkapiError('Invalid connection. The service could have been disabled, or has a restricted CORS.', { code: 'INVALID_REQUEST' });
        }
    }

    const wantsIdTokenHeader = options?.tokenHeaders?.idToken === true;

    if (auth || wantsIdTokenHeader) {
        token = await getJwtToken.bind(this)();
    }

    let fetchOptions = {}; // record fetch options
    let { fetchMore = false, progress } = options?.fetchOptions || {};

    if (options?.fetchOptions && Object.keys(options.fetchOptions).length) {
        for (let k of ['limit', 'startKey', 'ascending']) {
            if (options.fetchOptions.hasOwnProperty(k)) {
                if (k === 'startKey' && options.fetchOptions[k] === null) {
                    continue;
                }
                fetchOptions[k] = options.fetchOptions[k];
            }
        }

        fetchOptions = validator.Params(
            fetchOptions,
            {
                limit: v => {
                    if (typeof v !== 'number') {
                        throw new SkapiError('Fetch limit should be a number.', { code: 'INVALID_REQUEST' });
                    }
                    if (v > 1000) {
                        throw new SkapiError('Fetch limit should be below 1000.', { code: 'INVALID_REQUEST' });
                    }
                    return v;
                },
                startKey: v => v,
                ascending: 'boolean'
            }
        );
    }

    let required = _etc?.ignoreService ? {} : { service, owner };
    Object.assign(required, fetchOptions);

    data = extractFormData(data).data;

    if (!data) {
        // set data to required parameter
        data = required;
    }
    else if (data && typeof data === 'object') {
        // add required to data
        data = Object.assign(required, data);
    }

    let requestFingerprint = `${method}:${auth ? 'auth' : 'public'}:${url}`;

    let hashedParams = (() => {
        if (data && typeof data === 'object' && Object.keys(data).length && !(isBrowser && data instanceof FormData)) {
            // hash request parameters
            function sortObject(obj: Record<string, any>): Record<string, any> {
                if (typeof obj === 'object' && obj !== null) {
                    return Object.keys(obj)
                        .sort()
                        .reduce((res, key) => {
                            if (typeof obj[key] === 'object' && obj[key] !== null) {
                                // If the value is an object, sort it recursively
                                res[key] = sortObject(obj[key]);
                            } else {
                                res[key] = obj[key];
                            }
                            return res;
                        }, {});
                }
                return obj;
            };

            return MD5.hash(requestFingerprint + '/' + JSON.stringify(sortObject(data)));
        }

        return MD5.hash(requestFingerprint + '/' + service);
    })();

    let { requestKey, requestKeyWithStartKey } = load_startKey_keys.bind(this)({
        params: data,
        url,
        fetchMore,
        hashedParams
    }); // returns requrestKey | cached data

    if (!requestKey || requestKey && typeof requestKey === 'object') {
        // cached data can be falsy data or object
        return requestKey;
    }

    this.log('requestKey', requestKeyWithStartKey);

    // prevent duplicate request
    if (typeof requestKeyWithStartKey === 'string' && __pendingRequest[requestKeyWithStartKey] instanceof Promise) {
        this.log('request:returning pending', requestKeyWithStartKey);
        return __pendingRequest[requestKeyWithStartKey as string];
    }

    // new request
    let headers: Record<string, any> = {
        'Accept': '*/*'
    };

    const hasCustomContentType = Object.prototype.hasOwnProperty.call(options, 'contentType') && options.contentType !== undefined;
    if (hasCustomContentType) {
        const configuredContentType = options.contentType === null ? 'application/x-www-form-urlencoded' : options.contentType;
        if (configuredContentType) {
            headers['Content-Type'] = configuredContentType;
        }
    }
    else if (isBrowser && !(data instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    else {
        headers['Content-Type'] = 'application/json';
    }

    if (token) {
        headers.Authorization = token;
    }

    if (options?.tokenHeaders) {
        const resolveTokenValue = (configuredValue: boolean | string | undefined, fallbackValue: string | null) => {
            if (typeof configuredValue === 'string') {
                return configuredValue;
            }

            if (configuredValue === true) {
                return fallbackValue;
            }

            return null;
        };

        const accessToken = resolveTokenValue(options.tokenHeaders.accessToken, this.session?.accessToken?.jwtToken || null);
        const idToken = resolveTokenValue(options.tokenHeaders.idToken, this.bearerToken || this.session?.idToken?.jwtToken || token || null);

        if (accessToken) {
            headers['X-Access-Token'] = accessToken;
        }

        if (idToken) {
            headers['X-Id-Token'] = idToken;
        }
    }

    let meta = {
        public_identifier: this.__public_identifier,
        service,
        owner,
        // This SDK resolves an offloaded record payload ({ __data__: <path> } plus its
        // bin url) itself, in normalizeRecord. The flag tells the record endpoints
        // (get-records, get-feed, post-record, del-files, del-records) to return the
        // marker as stored. A request without it is from an older client that cannot
        // resolve markers, and the server inlines the payload for it instead, which
        // costs the response budget and the Lambda an S3 read per record.
        resolves_offloaded_data: true
    };

    headers['Content-Meta'] = JSON.stringify(meta);

    if (options.revalidate) {
        // Forces the browser to go to the origin for THIS url and to REPLACE what
        // it has stored under it. A cache-busting query parameter cannot do that:
        // it is a different url, so it creates a second entry and leaves the stale
        // one answering every later call until it expires on its own.
        headers['Cache-Control'] = 'no-cache';
        headers['Pragma'] = 'no-cache';
    }

    // if (headers['Content-Type'] !== 'application/json') {
    //     // add service and owner to headers if content type is not json
    //     headers['Content-Meta'] = JSON.stringify(meta);
    // }

    let opt: RequestInit & { responseType?: string | null, headers: Record<string, any>; } = { headers }; // request options
    if (options?.responseType) {
        opt.responseType = options.responseType;
    }

    if (method === 'GET') {
        if (data) {
            let query = [];
            if (isBrowser && data instanceof FormData) {
                query = Array.from(data.entries()).map(([k, value]) => {
                    const stringValue = typeof value === 'string' ? value : value.name;
                    return encodeURIComponent(k) + '=' + encodeURIComponent(stringValue);
                });
            }
            else {
                query = Object.keys(data)
                    .map(k => {
                        let value = data[k];
                        if (typeof value !== 'string') {
                            value = JSON.stringify(value);
                        }
                        return encodeURIComponent(k) + '=' + encodeURIComponent(value);
                    });
            }

            if (query.length) {
                const separator = endpoint.includes('?')
                    ? (endpoint.endsWith('?') || endpoint.endsWith('&') ? '' : '&')
                    : '?';
                endpoint += separator + query.join('&');
            }
        }
        opt.body = null;
    }
    else {
        if (isBrowser && data instanceof FormData) {
            opt.body = data;
        }
        else if (headers['Content-Type'] === 'application/x-www-form-urlencoded' && data && typeof data === 'object') {
            const encoded = new URLSearchParams();
            for (let key of Object.keys(data)) {
                const value = data[key];
                encoded.append(key, typeof value === 'string' ? value : JSON.stringify(value));
            }
            opt.body = encoded.toString();
        }
        else if (typeof data === 'string') {
            opt.body = data;
        }
        else {
            opt.body = data ? JSON.stringify(data) : null;
        }
    }

    opt.method = method;

    if (requestQueue === null) {
        let config = {
            batchSize: this.requestBatchSize,
            breakWhenError: false,
            onProgress: (progress) => {
                // for(let key in __pendingRequest) {
                //     delete __pendingRequest[key];
                // }
                this.onBatchProcess.forEach((cb) => cb(progress));
            }
        };

        requestQueue = new Qpass(config);
    }

    this.log('request-opt', opt);

    return new Promise((res, rej) => {
        requestQueue.add([async () => {
            let promise = _fetch.bind(this)(endpoint, opt, progress);
            __pendingRequest[requestKeyWithStartKey as string] = promise;

            try {
                let result = update_startKey_keys.bind(this)({
                    hashedParam: requestKey,
                    requestKeyWithStartKey,
                    url,
                    fetched: await promise
                });
                delete __pendingRequest[requestKeyWithStartKey];
                this.log('request:end', result);
                res(result);
                return result;
            }
            catch (err) {
                delete __pendingRequest[requestKeyWithStartKey];
                this.log('request:err', err);
                rej(err);
                throw err;
            }
        }]);
    });
}

function load_startKey_keys(option: {
    params: Record<string, any>;
    url: string;
    fetchMore: boolean;
    hashedParams: string;
}): { requestKeyWithStartKey: string, requestKey: string | DatabaseResponse<any> } {
    let { params = {}, url, fetchMore = false, hashedParams } = option || {};

    if (params.startKey) {
        if (
            !(typeof params.startKey === 'object' && Object.keys(params.startKey).length) &&
            params.startKey !== 'start' && params.startKey !== 'end'
        ) {
            throw new SkapiError(`"${params.startKey}" is invalid startKey key.`, { code: 'INVALID_PARAMETER' });
        }

        if (params.startKey === 'start') {
            // deletes referenced object key
            fetchMore = false;
            delete params.startKey;
        }
    }

    if (!fetchMore) {
        // init cache, init startKey

        if (this.__cached_requests?.[url]?.[hashedParams]) {
            // delete cached data start
            delete this.__cached_requests[url][hashedParams];
        }

        if (this.__startKeyHistory?.[url]?.[hashedParams]) {
            if (Array.isArray(this.__startKeyHistory[url][hashedParams]) && this.__startKeyHistory[url][hashedParams].length) {
                // delete cache of all startkeys
                for (let p of this.__startKeyHistory[url][hashedParams]) {
                    let hashedParams_cached = hashedParams + MD5.hash(p);
                    if (this.__cached_requests?.[url] && this.__cached_requests?.[url]?.[hashedParams_cached]) {
                        delete this.__cached_requests[url][hashedParams_cached];
                    }
                }
            }

            // delete start key lists
            delete this.__startKeyHistory[url][hashedParams];
        }

        return { requestKeyWithStartKey: hashedParams, requestKey: hashedParams };
    }

    if (!Array.isArray(this.__startKeyHistory?.[url]?.[hashedParams])) {
        // startkey does not exists
        return { requestKeyWithStartKey: hashedParams, requestKey: hashedParams };
    }

    // hashed params exists
    let list_of_startKeys = this.__startKeyHistory[url][hashedParams]; // ["{<startKey key>}", ...'end']
    let last_startKey_key = list_of_startKeys[list_of_startKeys.length - 1];
    let requestKeyWithStartKey = hashedParams;

    if (last_startKey_key) {
        // use last start key
        // requestKeyWithStartKey += MD5.hash(last_startKey_key);

        if (last_startKey_key === 'end') { // cached startKeys are stringified
            return {
                requestKey: {
                    list: [],
                    startKey: 'end',
                    endOfList: true,
                    startKeyHistory: list_of_startKeys
                },
                requestKeyWithStartKey
            }
        }

        // else {
        requestKeyWithStartKey += MD5.hash(last_startKey_key);
        params.startKey = JSON.parse(last_startKey_key);
        // }
    }

    if (this.__cached_requests?.[url]?.[requestKeyWithStartKey]) {
        // return data if there is cache
        return { requestKey: this.__cached_requests[url][requestKeyWithStartKey], requestKeyWithStartKey };
    }

    // return hashedParams;
    return { requestKeyWithStartKey, requestKey: hashedParams };
}

/**
 * Replace the data of any record that came back through the decryption layer
 * with null, so a form-action response can be persisted without writing
 * plaintext to disk. Identified by the `encrypted` marker normalizeRecord adds,
 * which is present only on records that actually went through it.
 */
function stripDecrypted(response: any): any {
    const scrub = (r: any) => (r && typeof r === 'object' && r.encrypted)
        ? Object.assign({}, r, { data: null })
        : r;

    if (Array.isArray(response)) {
        return response.map(scrub);
    }
    if (response && typeof response === 'object') {
        if (Array.isArray(response.list)) {
            return Object.assign({}, response, { list: response.list.map(scrub) });
        }
        return scrub(response);
    }
    return response;
}

function _fetch(url: string, opt: any, progress?: ProgressCallback, attempt = 0) {
    return new Promise(
        (res, rej) => {
            let xhr = new XMLHttpRequest();

            // 0: UNSENT - The request is not initialized.
            // 1: OPENED - The request has been set up.
            // 2: HEADERS_RECEIVED - The request has sent, and the headers and status are available.
            // 3: LOADING - The response's body is being received.
            // 4: DONE - The data transfer has been completed or an error has occurred during the 

            // xhr.onreadystatechange = function () {
            //     if (xhr.readyState === 4) {   //if complete
            //         if (xhr.status >= 200 || xhr.status <= 299) {  //check if "OK" (200)
            //             //success
            //         } else {
            //             rej(xhr.status); //otherwise, some other code was returned
            //         }
            //     }
            // };

            xhr.open(opt.method || 'GET', url);

            for (var k in opt.headers || {}) {
                xhr.setRequestHeader(k, opt.headers[k]);
            }

            if (opt.responseType) {
                xhr.responseType = opt.responseType;
            }

            xhr.onload = () => {
                if (xhr.status < 400) {
                    // Status codes in the 2xx range mean success
                    if (opt.responseType == 'json' || opt.responseType == 'blob') {
                        res(xhr.response);
                    }
                    else {
                        let result = xhr.responseText;
                        try {
                            result = JSON.parse(result);
                        }
                        catch (err) { }
                        res(result);
                    }
                }

                else if (xhr.status === 429) {
                    // too many requests
                    let retryAfter = xhr.getResponseHeader('Retry-After');
                    let retryDelayMs = getRetryDelayMs(retryAfter);
                    if (retryDelayMs !== null) {
                        if (attempt >= RATE_LIMIT_MAX_RETRIES) {
                            rej(rateLimitExhausted(`"${url.split('?')[0]}"`));
                            return;
                        }
                        setTimeout(() => {
                            _fetch(url, opt, progress, attempt + 1).then(res, rej);
                        }, rateLimitWaitMs(retryDelayMs, attempt));
                    }
                    else {
                        rej('Too many requests');
                    }
                }

                else {
                    // Status codes outside the 2xx range indicate errors
                    let status = xhr.status;
                    let errCode = [
                        'INVALID_CORS',
                        'INVALID_REQUEST',
                        'SERVICE_DISABLED',
                        'INVALID_PARAMETER',
                        'ERROR',
                        'EXISTS',
                        'NOT_EXISTS'
                    ];

                    let result: any = opt.responseType == 'blob' ? xhr.response : xhr.responseText;
                    try {
                        result = JSON.parse(result);
                    }
                    catch (err) { }
                        
                    if (typeof result === 'string') {
                        let errMsg = result.split(':');
                        let code = errMsg.splice(0, 1)[0].trim();
                        let msg = errMsg.join(':').trim();
                        rej(new SkapiError(msg || result, { code: (errCode.includes(code) ? code : 'ERROR') }));
                    }

                    else if (typeof result === 'object' && (result?.message || result?.stage || result?.code)) {
                        let code = (result?.code || (status ? status.toString() : null) || 'ERROR');
                        let message = result.message;
                        let cause = result?.cause;
                        if (cause === undefined && result.stage) {
                            // A ticket consume error is a flat {code, message, stage, action?,
                            // detail?, ticket_id} with no cause of its own. Keep the whole body
                            // so err.cause.stage / action / detail read the same on a 4xx as on
                            // the 200 a return200 ticket answers with (consumeTicket).
                            cause = result;
                        }
                        if (typeof message === 'string') {
                            message = message.trim();
                        }
                        if (!message) {
                            // A body with a stage or a code but no message is still an error
                            // object, not a payload to resolve with: the code stands in.
                            message = String(code);
                        }
                        rej(new SkapiError(message, { cause, code }));
                    }

                    else {
                        rej(result);
                    }
                }
            };

            xhr.onerror = () => rej('Network error');
            xhr.onabort = () => rej('Aborted');
            xhr.ontimeout = () => rej('Timeout');

            if (typeof progress === 'function') {
                xhr.onprogress = (p: ProgressEvent) => {
                    progress(
                        {
                            status: 'download',
                            progress: toPercent(p.loaded, p.total),
                            loaded: p.loaded,
                            total: p.total,
                            abort: () => xhr.abort()
                        }
                    );
                };
                if (xhr.upload) {
                    xhr.upload.onprogress = (p: ProgressEvent) => {
                        progress(
                            {
                                status: 'upload',
                                progress: toPercent(p.loaded, p.total),
                                loaded: p.loaded,
                                total: p.total,
                                abort: () => xhr.abort()
                            }
                        );
                    };
                }
            }

            xhr.send(opt.body);
        }
    );
}

function update_startKey_keys(option: Record<string, any>) {
    let { hashedParam, requestKeyWithStartKey, url, fetched } = option;

    if (!fetched?.startKey) {
        // no startkey no caching
        return fetched;
    }

    // has start key
    // startkey is key for next fetch

    // this.__startKeyHistory[url] = {
    //     [hashedParam]: ['{<startKey key>}', ...'end'],
    //     ...
    // }

    // this.__cached_requests[url][hashsedParams + md5(JSON.stringify(startKey))] = {
    //     data
    //     ...
    // }

    if (!this.__startKeyHistory.hasOwnProperty(url)) {
        // create url key to store startKey key list if it doesnt exists
        this.__startKeyHistory[url] = {};
    }

    if (!this.__startKeyHistory[url].hasOwnProperty(hashedParam)) {
        this.__startKeyHistory[url][hashedParam] = [];
    }

    let startKey_string = fetched.startKey === 'end' ? 'end' : JSON.stringify(fetched.startKey);
    if (!this.__startKeyHistory[url][hashedParam].includes(startKey_string)) {
        this.__startKeyHistory[url][hashedParam].push(startKey_string);
    }

    // let hashedParamWithStartKey = hashedParam + MD5.hash(startKey_string);

    if (!this.__cached_requests?.[url]) {
        this.__cached_requests[url] = {};
    }
    // this.__cached_requests[url][hashedParamWithStartKey] = fetched;
    this.__cached_requests[url][requestKeyWithStartKey] = fetched;

    return Object.assign({ startKeyHistory: this.__startKeyHistory[url][hashedParam] }, fetched);
}

/**
 * Why one file was not stored, as a SkapiError with a `code`.
 *
 * Storage answers a refused POST with an XML body ("<Code>AccessDenied</Code>"),
 * the transport with a bare string ('Network error', 'Aborted'), and a 429 with
 * no Retry-After with 'Too many requests'. Callers used to get only the File
 * back, so a file that "would not upload" could not be told apart from a network
 * blip. The raw rejection stays on `cause`.
 */
function toFileUploadError(err: any): SkapiError {
    if (err instanceof SkapiError) {
        return err;
    }
    if (typeof err === 'string') {
        let text = err.trim();
        if (text === 'Network error') {
            return new SkapiError('Network error', { code: 'NETWORK_ERROR' });
        }
        if (text === 'Aborted') {
            return new SkapiError('Aborted', { code: 'ABORTED' });
        }
        if (text === 'Timeout') {
            return new SkapiError('Timeout', { code: 'TIMEOUT' });
        }
        if (text === 'Too many requests') {
            return new SkapiError('Too many requests', { code: 'TOO_MANY_REQUESTS' });
        }
        let code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]?.trim() || '';
        let message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1]?.trim() || '';
        if (code || message) {
            return new SkapiError(message || code, { code: code || 'UPLOAD_FAILED', cause: text as any });
        }
        return new SkapiError(text.length > 300 ? text.slice(0, 300) : (text || 'Upload failed.'), { code: 'UPLOAD_FAILED', cause: text as any });
    }
    if (err && typeof err === 'object') {
        let code = (err as any).code || (err as any).Code;
        let message = (err as any).message || (err as any).Message;
        if (code || message) {
            return new SkapiError(String(message || code), { code: String(code || 'UPLOAD_FAILED'), cause: err });
        }
    }
    return new SkapiError('Upload failed.', { code: 'UPLOAD_FAILED', cause: err });
}

// Upload permits for many files at once (POST /get-signed-urls). With at least this many
// files, uploadFiles asks for the permits of up to BULK_PERMITS_MAX_FILES files in ONE request
// instead of one request per file; the files themselves still go up one after another.
// A region whose record stack does not serve the route yet answers 404, 501, or the
// gateway's own 403 for a route it does not know; uploadFiles then goes back to one permit
// per file and remembers that for the instance.
const BULK_PERMITS_MIN_FILES = 5;
const BULK_PERMITS_MAX_FILES = 100;

type UploadPermit = { fields: Record<string, string> | null; url: string; cdn: string; };

function isMissingRoute(err: any): boolean {
    let code = String(err?.code ?? '');
    if (code === '404' || code === '501') {
        return true;
    }
    let message = String(err?.message ?? err ?? '');
    return /missing authentication token/i.test(message) || /not implemented/i.test(message) || (code === '403' && /not found/i.test(message));
}

/** One permit or one error per file, in order, from a /get-signed-urls answer. */
function permitsFromBulkAnswer(answer: any, count: number): (UploadPermit | SkapiError)[] {
    let list = Array.isArray(answer?.list) ? answer.list : [];
    let failed = Array.isArray(answer?.failed) ? answer.failed : [];
    let out: (UploadPermit | SkapiError)[] = new Array(count);

    for (let item of failed) {
        if (item && Number.isInteger(item.index) && item.index >= 0 && item.index < count) {
            out[item.index] = new SkapiError(String(item.message || 'Upload permit refused.'), { code: String(item.code || 'ERROR') });
        }
    }

    for (let i = 0; i < count; i++) {
        if (out[i]) {
            continue;
        }
        let permit = list[i];
        if (permit && typeof permit.url === 'string') {
            out[i] = { fields: permit.fields || null, url: permit.url, cdn: permit.cdn };
        }
        else {
            out[i] = new SkapiError('No upload permit was answered for this file.', { code: 'ERROR' });
        }
    }

    return out;
}

export async function uploadFiles(
    fileList: FormData | HTMLFormElement | SubmitEvent,
    params: UploadFilesParams
): Promise<UploadFilesResult> {
    await this.__connection;
    let { record_id, service = this.service, progress, timeout, throwOnFileError = false } = (params as { [key: string]: any })

    if (!record_id) {
        throw new SkapiError('"record_id" is required.', { code: 'INVALID_PARAMETER' });
    }

    // Checked here, before any byte moves, so a typo cannot turn into an upload
    // with no limit, or one that times out at once.
    if (timeout !== undefined && timeout !== null) {
        if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) {
            throw new SkapiError('"timeout" should be a number of milliseconds, 0 or more.', { code: 'INVALID_PARAMETER' });
        }
    }
    else {
        timeout = 0;
    }

    if (hasSubmitEvent && fileList instanceof SubmitEvent) {
        fileList = (fileList.target as HTMLFormElement);
    }

    if (hasHTMLFormElement && fileList instanceof HTMLFormElement) {
        fileList = new FormData(fileList);
    }

    if (!isBrowser || !(fileList instanceof FormData)) {
        throw new SkapiError('"fileList" should be a FormData or HTMLFormElement.', { code: 'INVALID_PARAMETER' });
    }

    let reserved_key = generateRandom();

    let getSignedParams: Record<string, any> = {
        reserved_key,
        service,
        request: 'post'
    };

    if (params?.record_id) {
        getSignedParams.id = params.record_id;
    }

    let xhr;

    let fetchProgress = (
        url: string,
        body: FormData,
        progressCallback: (p: ProgressEvent) => void,
        fileName: string,
        attempt = 0
    ) => {
        return new Promise((res, rej) => {
            xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            // One file's whole budget: XHR counts from send() to the end of the
            // response, and a retried 429 opens a fresh request with a fresh budget.
            if (timeout > 0) {
                xhr.timeout = timeout;
            }
            xhr.onload = () => {
                let result = xhr.responseText;
                try {
                    result = JSON.parse(result);
                }
                catch (err) { }
                if (xhr.status >= 200 && xhr.status < 300) {
                    res(result);
                }
                else if (xhr.status === 429) {
                    // too many requests
                    let retryAfter = xhr.getResponseHeader('Retry-After');
                    let retryDelayMs = getRetryDelayMs(retryAfter);
                    if (retryDelayMs !== null) {
                        if (attempt >= RATE_LIMIT_MAX_RETRIES) {
                            rej(rateLimitExhausted(`the upload of "${fileName}" to "${url}"`));
                            return;
                        }
                        setTimeout(() => {
                            fetchProgress(url, body, progressCallback, fileName, attempt + 1).then(res, rej);
                        }, rateLimitWaitMs(retryDelayMs, attempt));
                    }
                    else {
                        rej('Too many requests');
                    }
                }
                else {
                    rej(result);
                }
            };
            xhr.onerror = () => rej('Network error');
            xhr.onabort = () => rej('Aborted');
            // Only reachable with a timeout set: an XHR with none never times out.
            xhr.ontimeout = () => rej(new SkapiError(`Upload timeout: "${fileName}" was not finished within ${timeout} ms.`, { code: 'TIMEOUT' }));

            // xhr.addEventListener('error', rej);
            if (xhr.upload && typeof progressCallback === 'function') {
                xhr.upload.onprogress = progressCallback;
            }

            xhr.send(body);
        });
    };

    function toBase62(num: number) {
        const base62Chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        if (num === 0) return base62Chars[0];
        let result = '';
        while (num > 0) {
            result = base62Chars[num % 62] + result;
            num = Math.floor(num / 62);
        }
        return result;
    }

    let completed: File[] = [];
    let failed: File[] = [];
    let errors: FileUploadError[] = [];
    let bin_endpoints: string[] = [];

    let entries: [string, File][] = [];
    for (let [key, f] of (fileList as any).entries()) {
        if (f instanceof File) {
            entries.push([key, f]);
        }
    }

    // Many files: their permits come BULK_PERMITS_MAX_FILES to a request. Few files, or a
    // region without the route: one permit per file, exactly the request made before.
    let bulk = entries.length >= BULK_PERMITS_MIN_FILES && !(this as any).__bulkPermitsUnavailable;

    let position = 0;
    while (position < entries.length) {
        let chunk = entries.slice(position, position + (bulk ? BULK_PERMITS_MAX_FILES : 1));
        position += chunk.length;

        // Seal the bytes before they leave, when the record they attach to is
        // encrypted. Returns the file untouched otherwise, so the off path is
        // unchanged. `uploadKey` carries the __skenc__ marker and the PLAINTEXT
        // size; `sizeKey` must declare the CIPHERTEXT size, because that is what
        // the object actually weighs and what the backend bills.
        let prepared: { file: File; uploadFile: File; params: Record<string, any>; }[] = [];
        for (let [key, f] of chunk) {
            let sealed = await maybeEncryptFile.bind(this)(record_id, key, f);
            prepared.push({
                file: f,
                uploadFile: sealed.file,
                params: {
                    key: sealed.key + '/' + sealed.file.name,
                    sizeKey: toBase62(sealed.file.size),
                    contentType: sealed.file.type || null
                }
            });
        }

        let permits: (UploadPermit | SkapiError)[] | null = null;

        if (bulk) {
            try {
                let answer = await request.bind(this)('get-signed-urls', Object.assign({ files: prepared.map(p => p.params) }, getSignedParams), { auth: !!this.__user });
                permits = permitsFromBulkAnswer(answer, prepared.length);
            }
            catch (err) {
                if (!isMissingRoute(err)) {
                    throw err;
                }
                // This region has no bulk route yet: this chunk and the rest of the
                // call go one permit per file, and so does every later call.
                (this as any).__bulkPermitsUnavailable = true;
                bulk = false;
            }
        }

        if (!permits) {
            permits = [];
            for (let p of prepared) {
                let { fields = null, url, cdn } = await request.bind(this)('get-signed-url', Object.assign(p.params, getSignedParams), { auth: !!this.__user });
                permits.push({ fields, url, cdn });
            }
        }

        for (let i = 0; i < prepared.length; i++) {
            let { file: f, uploadFile } = prepared[i];
            let permit = permits[i];

            if (permit instanceof SkapiError) {
                // Refused before it had an endpoint: the slot stays, empty.
                bin_endpoints.push('');
                failed.push(f);
                errors.push({ file: f, name: f.name, error: permit });
                if (throwOnFileError) {
                    throw permit;
                }
                continue;
            }

            bin_endpoints.push(permit.cdn);

            let form = new FormData();
            for (let name in permit.fields || {}) {
                form.append(name, permit.fields[name]);
            }

            form.append('file', uploadFile);

            try {
                await fetchProgress(
                    permit.url,
                    form,
                    typeof progress === 'function' ? (p: ProgressEvent) => progress(
                        {
                            status: 'upload',
                            progress: toPercent(p.loaded, p.total),
                            currentFile: f,
                            completed,
                            failed,
                            loaded: p.loaded,
                            total: p.total,
                            abort: () => xhr.abort()
                        }
                    ) : null,
                    f.name
                );
                completed.push(f);
            } catch (err) {
                failed.push(f);
                let error = toFileUploadError(err);
                errors.push({ file: f, name: f.name, error });
                if (throwOnFileError) {
                    throw error;
                }
            }
        }
    }

    return { completed, failed, errors, bin_endpoints };
}

const pendPromise: Record<string, Promise<any> | null> = {};

export function formHandler(options?: { preventMultipleCalls: boolean; }) {
    let { preventMultipleCalls = false } = options || {};

    // wraps methods that requires form handling
    return function (target: object, propertyKey: string, descriptor: any) {
        const fn = descriptor.value;

        descriptor.value = function (...arg: any[]) {
            let form: Form<any> = arg[0];
            let storeResponseKey = true;
            let formEl = null;
            let actionDestination = '';
            let fileBase64String = {};
            let refreshPage = false;
            if (hasSubmitEvent && form instanceof SubmitEvent) {
                form.preventDefault();

                let currentUrl = window.location.href;
                formEl = form.target as HTMLFormElement;
                let href = new URL(formEl.action);
                actionDestination = href.href;

                // find {placeholder} in actionDestination url string and replace it with form data value
                // can be also used as image previewer
                let placeholders = actionDestination ? actionDestination.match(/(?<=\{).*?(?=\})/g) : '';
                if (placeholders) {
                    for (let p of placeholders) {
                        if (!p) {
                            continue;
                        }

                        let inputElement = formEl.querySelector(`[name="${p}"]`);

                        // check if input element exists
                        if (!inputElement) {
                            continue;
                        }

                        // check if input element is a file input
                        if (inputElement.type === 'file') {
                            for (let i = 0; i <= inputElement.files.length - 1; i++) {
                                if (!inputElement.files[i])
                                    continue;

                                if (!fileBase64String[p]) {
                                    fileBase64String[p] = [];
                                }

                                fileBase64String[p].push(new Promise((res, rej) => {
                                    let reader = new FileReader();
                                    reader.onload = function () {
                                        res(reader.result);
                                    };
                                    reader.readAsDataURL(inputElement.files[i]);
                                    reader.onerror = rej;
                                }));
                            }
                        }
                        else {
                            actionDestination = actionDestination.replace(`{${p}}`, inputElement.value);
                        }
                    }
                }

                if (formEl.getAttribute('action') === null) {
                    storeResponseKey = false;
                }
                else {
                    refreshPage = href.href === currentUrl;
                }
            }

            const handleResponse = async (response: any) => {
                if (actionDestination) {
                    for (let k in fileBase64String) {
                        if (fileBase64String[k].length) {
                            actionDestination = actionDestination.replace(`{${k}}`, (await Promise.all(fileBase64String[k])).join(','));
                        }
                    }
                }

                if (formEl) {
                    if (storeResponseKey) {
                        // Never write a decrypted record to sessionStorage. When
                        // client-side encryption is on, `response` here holds the
                        // PLAINTEXT that maybeDecrypt just produced (or the
                        // plaintext echo postRecord restores), so serializing it
                        // would put the very data that was encrypted for the
                        // database straight onto disk in the clear.
                        let storable = encState.call(this) ? stripDecrypted(response) : response;
                        window.sessionStorage.setItem(`${this.service}:${MD5.hash(actionDestination)}`, JSON.stringify(storable));
                        if (refreshPage) {
                            window.location.replace(actionDestination);
                        }
                        else {
                            window.location.href = actionDestination;
                        }
                    }
                }

                return response;
            };

            let response: any;
            let handleError = (err: any) => {
                if (err instanceof SkapiError) {
                    err.name = propertyKey + '()';
                }

                else {
                    err = err instanceof Error ? err : new SkapiError(err, { name: propertyKey + '()' });
                }

                throw err;
            };

            const executeMethod = async () => {
                try {
                    // An instance created with the docs' placeholder has no service
                    // until the Project ID is entered, so the method waits for it.
                    // Everything above (preventDefault on a form submit) has already
                    // run synchronously, as it must.
                    if (this.__projectIdInput) {
                        await this.__projectIdInput;
                    }

                    // execute
                    response = fn.bind(this)(...arg);

                    if (response instanceof Promise) {
                        // handle promise
                        let resolved = await response;
                        return handleResponse(resolved);
                    }

                    return handleResponse(response);
                }
                catch (err) {
                    throw handleError(err);
                }
            };

            if (preventMultipleCalls) {
                let pendingKey = `${propertyKey}:${this?.__public_identifier || ''}:${this?.service || ''}:${this?.owner || ''}`;

                if (!pendPromise?.[pendingKey]) {
                    pendPromise[pendingKey] = executeMethod().finally(() => {
                        delete pendPromise[pendingKey];
                    });
                }

                return pendPromise[pendingKey];
            }

            return executeMethod();
        }
    }
}

export async function getFormResponse(): Promise<any> {
    await this.__connection;
    let responseKey = `${this.service}:${MD5.hash(window.location.href.split('?')[0])}`;
    let stored = window.sessionStorage.getItem(responseKey);
    window.sessionStorage.removeItem(responseKey);

    if (stored !== null) {
        try {
            stored = JSON.parse(stored);
        } catch (err) { }

        return stored;
    }

    return null;
};