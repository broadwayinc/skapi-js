
import SkapiError from '../main/error';
import { Form, FetchOptions, DatabaseResponse, ProgressCallback } from '../Types';
import validator from './validator';
import { MD5, generateRandom, extractFormData } from './utils';
// import { authentication, getJwtToken } from '../methods/user';
import { getJwtToken } from '../methods/user';
import Queuecumber from "queuecumber";

let queue = null;
// Global counters for round-robin
let privateCounter_admin = 0;
let publicCounter_admin = 0;
let privateCounter_record = 0;
let publicCounter_record = 0;

async function getEndpoint(dest: string, auth: boolean) {
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
        case 'get-newsletters': //
        case 'get-public-newsletters': //
        // case 'post-userdata': //
        case 'subscribe-newsletter': //
        case 'subscribe-public-newsletter': //
        case 'signupkey': //
        case 'admin-newsletter-request':
            return (auth ? admin.extra_private : admin.extra_public) + dest + query;
        case 'admin-signup': //
        case 'confirm-signup': //
        case 'client-secret-request': //
        case 'client-secret-request-public': //
        case 'openid-logger': //
            return (auth ? admin.extra_private_2 : admin.extra_public_2) + dest + query;
        case 'block-account':
        case 'admin-edit-profile':
            return admin.admin_private + dest + query;
        case 'remove-account':
        case 'post-secure':
        case 'recover-account':
        case 'mock':
        case 'grant-access':
        case 'last-verified-email':
        case 'ticket':
        case 'register-ticket':
        case 'get-newsletter-subscription':
        case 'request-username-change':
        // case 'jwt-login':
        case 'send-inquiry':
        case 'register-newsletter-group':
        case 'newsletter-group-endpoint':
        case 'invitation-list':
            // case 'register-sender-email':
            const gateways_admin = auth
                ? [admin.admin_private, admin.admin_private_2]
                : [admin.admin_public, admin.admin_public_2];

            const counter_admin = auth ? privateCounter_admin : publicCounter_admin;
            const selectedGateway_admin = gateways_admin[counter_admin % gateways_admin.length];

            if (auth) {
                privateCounter_admin++;
            } else {
                publicCounter_admin++;
            }

            return selectedGateway_admin + dest + query

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
        case 'grant-private-access':
        case 'request-private-access-key':
        case 'get-ws-group':
        case 'check-schema':
        case 'get-feed':
        // From viviplayground
        case 'castspell':
        case 'dopamine':
        case 'getspell':
            // Round-robin
            const gateways_record = auth
                ? [record.record_private, record.record_private_2]
                : [record.record_public, record.record_public_2];

            const counter_record = auth ? privateCounter_record : publicCounter_record;
            const selectedGateway_record = gateways_record[counter_record % gateways_record.length];

            if (auth) {
                privateCounter_record++;
            } else {
                publicCounter_record++;
            }

            return selectedGateway_record + dest + query

        default:
            return validator.Url(dest) + query;
    }
}

const __pendingRequest: Record<string, Promise<any>> = {};

export function terminatePendingRequests() {
    if(queue) {
        queue.terminate();
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
    let service = data?.service || this.service;
    let owner = data?.owner || this.owner;
    let token = null; // idToken
    let endpoint = await getEndpoint.bind(this)(url, !!auth);

    if (!bypassAwaitConnection) {
        __connection = await this.__connection;
        if (!__connection) {
            throw new SkapiError('Invalid connection. The service could have been disabled, or has a restricted CORS.', { code: 'INVALID_REQUEST' });
        }
    }

    if (auth) {
        token = await getJwtToken.bind(this)();
    }

    let fetchOptions = {}; // record fetch options
    let { fetchMore = false, progress } = options?.fetchOptions || {};

    if (options?.fetchOptions && Object.keys(options.fetchOptions).length) {
        for (let k of ['limit', 'startKey', 'ascending']) {
            if (options.fetchOptions.hasOwnProperty(k)) {
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

    let hashedParams = (() => {
        if (data && typeof data === 'object' && Object.keys(data).length && !(data instanceof FormData)) {
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

            return MD5.hash(url + '/' + JSON.stringify(sortObject(data)));
        }

        return MD5.hash(url + '/' + this.service);
    })();

    let requestKey = load_startKey_keys.bind(this)({
        params: data,
        url,
        fetchMore,
        hashedParams
    }); // returns requrestKey | cached data

    this.log('requestKey', requestKey);

    if (!requestKey || requestKey && typeof requestKey === 'object') {
        // cahced data can be falsy data or object
        return requestKey;
    }

    // prevent duplicate request
    if (typeof requestKey === 'string' && __pendingRequest[requestKey] instanceof Promise) {
        this.log('request:returning pending', requestKey);
        return __pendingRequest[requestKey as string];
    }

    // new request
    let headers: Record<string, any> = {
        'Accept': '*/*',
        "Content-Type": options.hasOwnProperty('contentType') ? options.contentType === null ? 'application/x-www-form-urlencoded' : options.contentType || 'application/json' : 'application/json'
    };
    if (token) {
        headers.Authorization = token;
    }

    let meta = {
        public_identifier: this.__public_identifier,
        service,
        owner
    };

    headers['Content-Meta'] = JSON.stringify(meta);

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
            if (data instanceof FormData) {
                for (let [name, value] of data.entries()) {
                    if (typeof value === 'string') {
                        value = encodeURIComponent(value);
                        query.push(`&${name}=${value}`);
                    }
                }
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
                if (endpoint.substring(endpoint.length - 1) !== '?') {
                    endpoint = endpoint + '?';
                }
                endpoint += query.join('&');
            }
        }
        opt.body = null;
    }
    else {
        opt.body = data ? JSON.stringify(data) : null;
    }

    opt.method = method;

    if (queue === null) {
        let config = {
            batchSize: this.requestBatchSize,
            breakWhenError: false,
            onProgress: (progress) => {
                for(let key in __pendingRequest) {
                    delete __pendingRequest[key];
                }
                this.onBatchProcess.forEach((cb) => cb(progress));
            }
        };

        queue = new Queuecumber(config);
    }

    return new Promise((res, rej) => {
        queue.add([async () => {
            let promise = _fetch.bind(this)(endpoint, opt, progress);
            __pendingRequest[requestKey as string] = promise;

            try {
                let result = update_startKey_keys.bind(this)({
                    hashedParam: requestKey,
                    url,
                    fetched: await promise
                });

                this.log('request:end', result);
                res(result);
                return result;
            }
            catch (err) {
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
}): string | DatabaseResponse<any> {
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

        return hashedParams;
    }

    if (!Array.isArray(this.__startKeyHistory?.[url]?.[hashedParams])) {
        // startkey does not exists
        return hashedParams;
    }

    // hashed params exists
    let list_of_startKeys = this.__startKeyHistory[url][hashedParams]; // [{<startKey key>}, ...'end']
    let last_startKey_key = list_of_startKeys[list_of_startKeys.length - 1];
    let cache_hashedParams = hashedParams;
    if (last_startKey_key) {
        // use last start key

        if (last_startKey_key === 'end') { // cached startKeys are stringified
            return {
                list: [],
                startKey: 'end',
                endOfList: true,
                startKeyHistory: list_of_startKeys
            };
        }

        else {
            cache_hashedParams += MD5.hash(last_startKey_key);
            params.startKey = JSON.parse(last_startKey_key);
        }
    }

    if (this.__cached_requests?.[url]?.[cache_hashedParams]) {
        // return data if there is cache
        return this.__cached_requests[url][cache_hashedParams];
    }

    return hashedParams;
}

function _fetch(url: string, opt: any, progress?: ProgressCallback) {
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
                    if (retryAfter) {
                        setTimeout(() => {
                            _fetch(url, opt, progress).then(res, rej);
                        }, parseInt(retryAfter) * 1000);
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
                        let errMsg = xhr.response.split(':');
                        let code = errMsg.splice(0, 1)[0].trim();
                        rej(new SkapiError(errMsg.join(':').trim(), { code: (errCode.includes(code) ? code : 'ERROR') }));
                    }

                    else if (typeof result === 'object' && result?.message) {
                        let code = (result?.code || (status ? status.toString() : null) || 'ERROR');
                        let message = result.message;
                        let cause = result?.cause;
                        if (typeof message === 'string') {
                            message = message.trim();
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
                            progress: p.loaded / p.total * 100,
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
                                progress: p.loaded / p.total * 100,
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
    let { hashedParam, url, fetched } = option;

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

    if (!this.__cached_requests?.[url]) {
        this.__cached_requests[url] = {};
    }

    this.__cached_requests[url][hashedParam] = fetched;

    if (!this.__startKeyHistory[url].hasOwnProperty(hashedParam)) {
        this.__startKeyHistory[url][hashedParam] = [];
    }

    let startKey_string = fetched.startKey === 'end' ? 'end' : JSON.stringify(fetched.startKey);
    if (!this.__startKeyHistory[url][hashedParam].includes(startKey_string)) {
        this.__startKeyHistory[url][hashedParam].push(startKey_string);
    }

    return Object.assign({ startKeyHistory: this.__startKeyHistory[url][hashedParam] }, fetched);
}

export async function uploadFiles(
    fileList: FormData | HTMLFormElement | SubmitEvent,
    params: {
        record_id: string; // Record ID of a record to upload files to.
        progress?: ProgressCallback;
    }
): Promise<{ completed: File[]; failed: File[]; bin_endpoints: string[] }> {
    await this.__connection;
    let { record_id, service = this.service, progress } = (params as { [key: string]: any })

    if (!record_id) {
        throw new SkapiError('"record_id" is required.', { code: 'INVALID_PARAMETER' });
    }

    if (fileList instanceof SubmitEvent) {
        fileList = (fileList.target as HTMLFormElement);
    }

    if (fileList instanceof HTMLFormElement) {
        fileList = new FormData(fileList);
    }

    if (!(fileList instanceof FormData)) {
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
        progressCallback: (p: ProgressEvent) => void
    ) => {
        return new Promise((res, rej) => {
            xhr = new XMLHttpRequest();
            xhr.open('POST', url);
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
                    if (retryAfter) {
                        setTimeout(() => {
                            fetchProgress(url, body, progressCallback).then(res, rej);
                        }, parseInt(retryAfter) * 1000);
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
            xhr.ontimeout = () => rej('Timeout');

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

    if (queue === null) {
        queue = new Queuecumber({
            batchSize: this.requestBatchSize,
            breakWhenError: false
        });
    }

    return new Promise((res, rej) => {
        queue.add([async () => {
            let completed = [];
            let failed = [];
            let bin_endpoints = [];

            for (let [key, f] of (fileList as any).entries()) {
                if (!(f instanceof File)) {
                    continue;
                }

                let signedParams = Object.assign({
                    key: key + '/' + f.name,
                    sizeKey: toBase62(f.size),
                    contentType: f.type || null
                }, getSignedParams);

                let { fields = null, url, cdn } = await request.bind(this)('get-signed-url', signedParams, { auth: !!this.__user });

                bin_endpoints.push(cdn);

                let form = new FormData();

                for (let name in fields) {
                    form.append(name, fields[name]);
                }

                form.append('file', f);

                try {
                    await fetchProgress(
                        url,
                        form,
                        typeof progress === 'function' ? (p: ProgressEvent) => progress(
                            {
                                status: 'upload',
                                progress: p.loaded / p.total * 100,
                                currentFile: f,
                                completed,
                                failed,
                                loaded: p.loaded,
                                total: p.total,
                                abort: () => xhr.abort()
                            }
                        ) : null
                    );
                    completed.push(f);
                } catch (err) {
                    failed.push(f);
                }
            }

            res({ completed, failed, bin_endpoints });
            return { completed, failed, bin_endpoints };
        }]);
    });
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
            if (form instanceof SubmitEvent) {
                form.preventDefault();

                let currentUrl = location.href;
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
                        sessionStorage.setItem(`${this.service}:${MD5.hash(actionDestination)}`, JSON.stringify(response));
                        if (refreshPage) {
                            location.replace(actionDestination);
                        }
                        else {
                            location.href = actionDestination;
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
                    // execute
                    response = fn.bind(this)(...arg);

                    if (response instanceof Promise) {
                        // handle promise
                        let resolved = await response;
                        await handleResponse(resolved);
                        return response;
                    }
                }
                catch (err) {
                    throw handleError(err);
                }
            };

            if (preventMultipleCalls) {
                if (!pendPromise?.[propertyKey]) {
                    pendPromise[propertyKey] = executeMethod().finally(() => {
                        delete pendPromise[propertyKey];
                    });
                }

                return pendPromise[propertyKey];
            }

            return executeMethod();
        }
    }
}

export async function getFormResponse(): Promise<any> {
    await this.__connection;
    let responseKey = `${this.service}:${MD5.hash(location.href.split('?')[0])}`;
    let stored = sessionStorage.getItem(responseKey);
    sessionStorage.removeItem(responseKey);

    if (stored !== null) {
        try {
            stored = JSON.parse(stored);
        } catch (err) { }

        return stored;
    }

    return null;
};