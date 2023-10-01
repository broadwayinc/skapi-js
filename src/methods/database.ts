import {
    RecordData,
    Form,
    FormSubmitCallback,
    FetchOptions,
    DatabaseResponse,
    GetRecordQuery,
    Condition,
    PostRecordConfig,
    ProgressCallback,
    Binary
} from '../Types';
import SkapiError from '../main/error';
import { extractFormMeta, generateRandom } from '../utils/utils';
import validator from '../utils/validator';
import { request } from './request';

const __index_number_range = 4503599627370496; // +/-

// function to decode base62 string
function fromBase62(str: string) {
    const base62Chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let result = 0;
    for (let i = 0; i < str.length; i++) {
        result = result * 62 + base62Chars.indexOf(str[i]);
    }
    return result;
}

export function normalizeRecord(record: Record<string, any>): RecordData {
    function base_decode(chars) {
        let charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        return chars.split('').reverse().reduce((prev, curr, i) =>
            prev + (charset.indexOf(curr) * (62 ** i)), 0);
    }

    const output: Record<string, any> = {
        user_id: '',
        record_id: '',
        updated: 0,
        uploaded: 0,
        table: {
            name: '',
            access_group: 0
        },
        reference: {
            reference_limit: null,
            allow_multiple_reference: true,
            referenced_count: 0
        },
        ip: '',
        bin: {}
    };

    const keys = {
        'ip': (r: string) => {
            if (r.slice(-1) === 'R') {
                output.readonly = true;
                r = r.slice(0, -1);
            }
            else {
                output.readonly = false;
            }
            output.ip = r;
        },
        'rec': (r: string) => {
            if (!r) return;
            output.record_id = r;
            let base62timestamp = r.substring(0, r.length - 9); // id: [base62 timestamp][random 5 char][suid 4 char]
            let uploaded = base_decode(base62timestamp);
            output.uploaded = uploaded;
        },
        'usr': (r: string) => {
            output.user_id = r;
        },
        'tbl': (r: string) => {
            if (!r) return;
            let rSplit = r.split('/');
            // table/service/group(** | group)/[subscription(user id)/group(00 - 99)]/[tag]
            output.table.name = rSplit[0];
            output.table.access_group = rSplit[2] == '**' ? 'private' : parseInt(rSplit[2]);
            // if (rSplit?.[3]) {
            //     output.table.subscription = {
            //         user_id: rSplit[3],
            //         group: parseInt(rSplit[4])
            //     };
            // }
            if (rSplit?.[3]) {
                // output.table.subscription_group = parseInt(rSplit[4]);
                output.table.subscription = true;
            }
            else {
                output.table.subscription = false;
            }
        },
        'usr_tbl': (r: string) => {
            // user-id/table/service/group(** | group)[/subscription(user id)/group(00 - 99)][/tag]
            let rSplit = r.split('/');
            output.user_id = rSplit[0];
            output.table.name = rSplit[1];
            output.table.access_group = rSplit[3] == '**' ? 'private' : parseInt(rSplit[3]);
            // if (rSplit?.[4]) {
            //     output.table.subscription = {
            //         user_id: rSplit[4],
            //         group: parseInt(rSplit[5])
            //     };
            // }
            if (rSplit?.[4]) {
                // output.table.subscription_group = parseInt(rSplit[4]);
                output.table.subscription = true;
            }
            else {
                output.table.subscription = false;
            }
        },
        'idx': (r: string) => {
            if (!r) return;
            let rSplit = r.split('!');
            let name = rSplit.splice(0, 1)[0];
            let value = normalizeTypedString('!' + rSplit.join('!'));
            output.index = {
                name,
                value
            };
        },
        'ref': (r: string) => {
            if (!r) return;
            output.reference.record_id = r.split('/')[0];
        },
        'tags': (r: string[]) => {
            output.tags = r;
        },
        'upd': (r: number) => {
            output.updated = r;
        },
        'acpt_mrf': (r: boolean) => {
            output.reference.allow_multiple_reference = r;
        },
        'ref_limt': (r: number) => {
            output.reference.reference_limit = r;
        },
        'rfd': (r: number) => {
            output.reference.referenced_count = r;
        },
        'bin': (r: string[]) => {
            let binObj = {};

            if (Array.isArray(r)) {
                for (let url of r) {
                    let path = url.split('/').slice(3).join('/');
                    // publ/ap21piquKpzLtjAJxckv/4d4a36a5-b318-4093-92ae-7cf11feae989/4d4a36a5-b318-4093-92ae-7cf11feae989/records/TrNFqeRsKGXyxckv/00/bin/TrNFron/IuqU/gogo/Skapi_IR deck_Final_KOR.pptx
                    let splitPath = path.split('/');
                    let filename = decodeURIComponent(splitPath.slice(-1)[0]);
                    let pathKey = decodeURIComponent(splitPath[10]);
                    let size = splitPath[9];
                    let uploaded = splitPath[8];
                    let access_group = splitPath[6] == '**' ? 'private' : parseInt(splitPath[6]);
                    access_group = access_group == 0 ? 'public' : access_group == 1 ? 'authorized' : access_group;
                    let obj = {
                        access_group,
                        filename,
                        url,
                        path,
                        size: fromBase62(size),
                        uploaded: fromBase62(uploaded),
                        getFile: (dataType?: 'base64' | 'endpoint' | 'blob', progress?: ProgressCallback) => {
                            let config = {
                                dataType: dataType || 'download',
                                progress
                            };
                            return getFile.bind(this)(url, config);
                        }
                    };
                    if (binObj[pathKey]) {
                        binObj[pathKey].push(obj);
                        continue;
                    }

                    binObj[pathKey] = [obj];
                }
            }
            output.bin = binObj;
        },
        'data': (r: any) => {
            let data = r;
            if (r === '!D%{}') {
                data = {};
            }
            else if (r === '!L%[]') {
                data = [];
            }
            output.data = data;
        }
    };

    if (record.record_id) {
        // bypass already normalized records
        return record as RecordData;
    }

    for (let k in keys) {
        if (record.hasOwnProperty(k)) {
            keys[k](record[k]);
        }
    }

    if (record.private_key) {
        this.__private_access_key[output.record_id] = record.private_key;
    }

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

    let updatedRec = request.bind(this)('del-files', {
        endpoints,
        storage: 'records'
    }, { auth: true, method: 'post' });

    return updatedRec.map(r => normalizeRecord.bind(this)(r));
}

export async function uploadFiles(
    fileList: Form<FileList | File[]>,
    params: {
        record_id: string; // Record ID of a record to upload files to.
    } & FormSubmitCallback
): Promise<{ completed: File[]; failed: File[]; bin_endpoints: string[] }> {
    // <input type="file" webkitdirectory multiple />
    // let input = document.querySelector('input[type="file"]');
    // let data = new FormData();

    // for (let i = 0; i < input.files.length; i++) {
    //     // You may want to replace '\\' with '/' if you're on Mac or Linux
    //     let path = input.files[i].webkitRelativePath || input.files[i].name;
    //     data.append('files', input.files[i], path);
    // }

    await this.__connection;
    let params_request = (params as any)?.request || 'post';
    let service = (params as any)?.service || this.service;

    if (params_request === 'post') {
        if (!params?.record_id) {
            throw new SkapiError('"record_id" is required.', { code: 'INVALID_PARAMETER' });
        }
    }
    else {
        if (service === this.service) {
            throw new SkapiError('invalid service.', { code: 'INVALID_PARAMETER' });
        }
        if (params_request !== 'host') {
            throw new SkapiError('invalid request.', { code: 'INVALID_PARAMETER' });
        }
    }

    if (fileList instanceof SubmitEvent) {
        fileList = (fileList.target as HTMLFormElement);
    }

    if (fileList instanceof HTMLFormElement) {
        fileList = new FormData(fileList);
    }

    let formDataKeys = [];
    if (fileList instanceof FormData) {
        // extract all fileList
        let fileEntries = [];

        for (let entry of fileList.entries()) {
            let value = entry[1];
            if (value instanceof File) {
                let key = entry[0];
                formDataKeys.push(key);
                fileEntries.push(value);
            }
        }

        fileList = fileEntries;
    }

    if (!(fileList[0] instanceof File)) {
        throw new SkapiError('"fileList" should be a FileList or array of File object.', { code: 'INVALID_PARAMETER' });
    }

    let reserved_key = generateRandom();

    let getSignedParams: Record<string, any> = {
        reserved_key,
        service,
        request: params_request
    };

    if (params?.record_id) {
        getSignedParams.id = params.record_id;
    }

    let xhr;
    let fetchProgress = (
        url: string,
        body: FormData,
        progressCallback
    ) => {
        return new Promise((res, rej) => {
            xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            xhr.onload = (e: any) => {
                let result = xhr.responseText;
                try {
                    result = JSON.parse(result);
                }
                catch (err) { }
                if (xhr.status >= 200 && xhr.status < 300) {
                    let result = xhr.responseText;
                    try {
                        result = JSON.parse(result);
                    }
                    catch (err) { }
                    res(result);
                } else {
                    rej(result);
                }
            };
            xhr.onerror = () => rej('Network error');
            xhr.onabort = () => rej('Aborted');
            xhr.ontimeout = () => rej('Timeout');

            // xhr.addEventListener('error', rej);
            if (xhr.upload && typeof params.progress === 'function') {
                xhr.upload.onprogress = progressCallback;
            }

            xhr.send(body);
        });
    };

    let completed = [];
    let failed = [];

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

    let bin_endpoints = [];

    for (let i = 0; i < fileList.length; i++) {
        let f = fileList[i];
        let key = formDataKeys?.[i] || '';

        let signedParams = Object.assign({
            key: key ? key + '/' + f.name : f.name,
            sizeKey: toBase62(f.size),
            contentType: f.type || null
        }, getSignedParams);

        let { fields = null, url, cdn } = await request.bind(this)('get-signed-url', signedParams, { auth: true });

        bin_endpoints.push(cdn);

        let form = new FormData();

        for (let name in fields) {
            form.append(name, fields[name]);
        }

        form.append('file', f);

        try {
            await fetchProgress(
                url, form,
                (p: ProgressEvent) => {
                    if (typeof params.progress !== 'function') return;

                    params.progress(
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
                    );
                }
            );
            completed.push(f);
        } catch (err) {
            failed.push(f);
        }
    }

    return { completed, failed, bin_endpoints };
}

export async function getFile(
    url: string, // cdn endpoint url https://xxxx.cloudfront.net/path/file
    config?: {
        dataType?: 'base64' | 'download' | 'endpoint' | 'blob'; // default 'download'
        expires?: number; // uses url that expires. this option does not use the cdn (slow). can be used for private files. (does not work on public files).
        progress?: ProgressCallback;
    }
): Promise<Blob | string | void> {
    if (typeof url !== 'string') {
        throw new SkapiError('"url" should be type: string.', { code: 'INVALID_PARAMETER' });
    }

    validator.Url(url);
    let isValidEndpoint = false;
    let splitUrl = url.split('/');
    let host = splitUrl[2];
    let splitHost = host.split('.');
    let subdomain = null;

    if (splitHost.length === 3 && splitHost[1] === 'skapi') {
        subdomain = splitHost[0];
        isValidEndpoint = true;
    }

    let target_key = splitUrl.slice(3);

    if (!isValidEndpoint) {
        if (target_key[0] !== 'auth' && target_key[0] !== 'publ') {
            throw new SkapiError('Invalid file url.', { code: 'INVALID_PARAMETER' });
        }
        try {
            validator.UserId(target_key[2]);
            validator.UserId(target_key[3]);
        }
        catch {
            throw new SkapiError('Invalid file url.', { code: 'INVALID_PARAMETER' });
        }
    }

    let service = subdomain ? null : target_key[1];

    validator.Params(config, {
        expires: 'number',
        dataType: ['base64', 'blob', 'endpoint', 'download', () => 'download']
    }, [], ['progress']);

    let needAuth = target_key[0] == 'auth';
    let filename = url.split('/').slice(-1)[0];
    let expires = config?.expires || 0;

    if (expires) {
        if (expires < 0) {
            throw new SkapiError('"config.expires" should be > 0. (seconds)', { code: 'INVALID_PARAMETER' });
        }

        let params: Record<string, any> = {
            request: subdomain ? 'get-host' : 'get',
            id: subdomain || target_key[5],
            key: url,
            expires
        }

        if (service) {
            params.service = service
        }

        url = (await request.bind(this)('get-signed-url', params,
            { auth: true }
        )).url;
    }

    else if (needAuth) {
        // "auth/ap21oijFZdpDm1nxxckv/4d4a36a5-b318-4093-92ae-7cf11feae989/4d4a36a5-b318-4093-92ae-7cf11feae989/records/Tp8mGdutyTuyxckv/01/file/98/03e4bed487738547e062dde90c78d194"
        let token = this.session?.idToken?.jwtToken; // idToken

        let access_group = target_key[6] === '**' ? '**' : parseInt(target_key[6]);

        if (!token) {
            throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
        }
        else {
            let currTime = Date.now() / 1000;
            if (this.session.idToken.payload.exp < currTime) {
                try {
                    await this.authentication().getSession({ refreshToken: true });
                    token = this.session?.idToken?.jwtToken;
                }
                catch (err) {
                    this.logout();
                    throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
                }
            }
        }

        if (access_group === '**') {
            if (this.__user.user_id !== target_key[3]) {
                throw new SkapiError('User has no access.', { code: 'INVALID_REQUEST' });
            }
        }
        else if (this.__user.access_group < access_group) {
            throw new SkapiError('User has no access.', { code: 'INVALID_REQUEST' });
        }

        url += `?t=${token}`;
    }

    if (config?.dataType === 'endpoint') {
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

    let blob: Promise<string> = new Promise(async (res, rej) => {
        try {
            let b = await request.bind(this)(
                url,
                { service: service || this.service },
                { method: 'get', noParams: true, contentType: null, responseType: 'blob', fetchOptions: { progress: config?.progress } }
            );

            if (config?.dataType === 'base64') {
                const reader = new FileReader();
                reader.onloadend = () => res((reader.result as string));
                reader.readAsDataURL(b);
            }
        } catch (err) {
            rej(err);
        }
    });

    return blob;
}

export async function getRecords(query: GetRecordQuery & { private_key?: string; }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<RecordData>> {
    await this.__connection;

    const indexTypes = {
        '$updated': 'number',
        '$uploaded': 'number',
        '$referenced_count': 'number'
    };

    if (typeof query?.table === 'string') {
        query.table = {
            name: query.table,
            access_group: 0
        };
    }

    const struct = {
        table: {
            name: 'string',
            access_group: ['number', 'private', 'public', 'authorized'],
            // subscription: {
            //     user_id: (v: string) => validator.UserId(v, 'User ID in "subscription.user_id"'),
            //     group: (v: number) => {
            //         if (typeof v !== 'number') {
            //             throw new SkapiError('"subscription.group" should be type: number.', { code: 'INVALID_PARAMETER' });
            //         }
            //         if (v > 99 || v < 0) {
            //             throw new SkapiError('"subscription.group" should be within range: 0 ~ 99.', { code: 'INVALID_PARAMETER' });
            //         }
            //         return v;
            //     }
            // }
            subscription: (v: string) => validator.UserId(v, 'User ID in "subscription"')
        },
        reference: 'string',
        index: {
            name: (v: string) => {
                if (typeof v !== 'string') {
                    throw new SkapiError('"index.name" should be type: string.', { code: 'INVALID_PARAMETER' });
                }

                if (indexTypes.hasOwnProperty(v)) {
                    return v;
                }

                if (['$uploaded', '$updated', '$referenced_count', '$user_id'].includes(v)) {
                    return v;
                }

                return validator.specialChars(v, 'index.name', true, false);
            },
            value: (v: number | boolean | string) => {
                if (query.index?.name && indexTypes.hasOwnProperty(query.index.name)) {
                    let tp = indexTypes[query.index.name];

                    if (typeof v === tp) {
                        return v;
                    }

                    else {
                        throw new SkapiError(`"index.value" should be type: ${tp}.`, { code: 'INVALID_PARAMETER' });
                    }
                }

                if (typeof v === 'number') {
                    if (v > __index_number_range || v < -__index_number_range) {
                        throw new SkapiError(`Number value should be within range -${__index_number_range} ~ +${__index_number_range}`, { code: 'INVALID_PARAMETER' });
                    }
                    return v;
                }

                else if (typeof v === 'boolean') {
                    return v;
                }

                else {
                    // is string
                    if ('$user_id' == query.index?.name) {
                        return validator.UserId(v);
                    }

                    return validator.specialChars((v as string), 'index.value', false, true);
                }
            },
            condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne'],
            range: (v: number | boolean | string) => {
                if (!query.index || !('value' in query.index)) {
                    throw new SkapiError('"index.value" is required.', { code: 'INVALID_PARAMETER' });
                }

                if (query.index.name === '$record_id') {
                    throw new SkapiError(`Cannot do "index.range" on ${query.index.name}`, { code: 'INVALID_PARAMETER' });
                }

                if (typeof query.index.value !== typeof v) {
                    throw new SkapiError('"index.range" type should match the type of "index.value".', { code: 'INVALID_PARAMETER' });
                }

                if (typeof v === 'string') {
                    return validator.specialChars(v, 'index.range', false, true);
                }

                return v;
            }
        },
        tag: 'string',
        private_key: 'string'
    };

    if (query?.tag) {
        validator.specialChars(query.tag, 'tag', false, true);
    }

    if (query?.table) {
        if (query.table.access_group === 'public') {
            query.table.access_group = 0;
        }

        else if (query.table.access_group === 'authorized') {
            query.table.access_group = 1;
        }

        if (query.table?.name) {
            validator.specialChars(query.table.name, 'table name', true, true);
        }

        if (typeof query.table.access_group === 'number') {
            if (!this.__user) {
                if (0 < query.table.access_group) {
                    throw new SkapiError("User has no access", { code: 'INVALID_REQUEST' });
                }
            }

            else if (this.user.access_group < query.table.access_group) {
                throw new SkapiError("User has no access", { code: 'INVALID_REQUEST' });
            }
        }
    }

    if (query?.index && !query.index?.name) {
        throw new SkapiError('"index.name" is required when using "index" parameter.', { code: 'INVALID_REQUEST' });
    }

    let is_reference_fetch = '';
    if (query?.record_id) {
        validator.specialChars(query.record_id, 'record_id', false, false);
        let outputObj: Record<string, string> = { record_id: query.record_id };
        if ((query as any)?.service) {
            outputObj.service = (query as any).service;
        }
        query = outputObj;
        if (this.__private_access_key[query.record_id]) {
            query.private_key = this.__private_access_key[query.record_id];
        }
    }

    else {
        let ref_user: string;
        if (!this.session && query.table?.access_group === 'private') {
            throw new SkapiError('Unsigned users have no access to private records.', { code: 'INVALID_REQUEST' });
        }

        if (query.reference) {
            try {
                ref_user = validator.UserId(query.reference);
            } catch (err) {
                // reference is record id
                validator.specialChars(query.reference, 'reference', false, false);
                is_reference_fetch = query.reference;
                if (this.__private_access_key[is_reference_fetch]) {
                    query.private_key = this.__private_access_key[is_reference_fetch];
                }
            }

            // if (query.table?.access_group === 'private') {
            //     if (!ref_user) {
            //         // request private access key
            //         query.private_access_key = await requestPrivateRecordAccessKey.bind(this)(query.reference);
            //     }
            // }
        }

        let isAdmin = await this.checkAdmin();

        let q: any = validator.Params(query || {}, struct, ref_user || isAdmin ? [] : ['table']);
        if (typeof q.table !== 'string') {
            if (q.table?.subscription) {
                if (!this.session) {
                    throw new SkapiError('Unsigned users have no access to subscription records.', { code: 'INVALID_REQUEST' });
                }
                q.table.subscription = {
                    user_id: q.table.subscription,
                    group: 1
                }
            }
        }
        query = q;
    }

    let auth = query.hasOwnProperty('access_group') && typeof query.table !== 'string' && query.table.access_group ? true : !!this.__user;
    let result = await request.bind(this)(
        'get-records',
        query,
        {
            fetchOptions,
            auth,
            method: auth ? 'post' : 'get'
        }
    );

    for (let i in result.list) {
        result.list[i] = normalizeRecord.bind(this)(result.list[i]);
    };

    if (is_reference_fetch && result?.reference_private_key) {
        this.__private_access_key[is_reference_fetch] = result.reference_private_key;
    }
    return result;
}

export async function postRecord(
    form: Form<Record<string, any>> | null | undefined,
    config: PostRecordConfig & FormSubmitCallback & { reference_private_key?: string; }
): Promise<RecordData> {
    let isAdmin = await this.checkAdmin();
    if (!config) {
        throw new SkapiError('"config" argument is required.', { code: 'INVALID_PARAMETER' });
    }

    if (!this.user) {
        throw new SkapiError('Login is required.', { code: 'INVALID_REQUEST' });
    }

    let fetchOptions: Record<string, any> = {};

    if (typeof config?.formData === 'function') {
        fetchOptions.formData = config.formData;
        delete config.formData;
    }

    if (typeof config.table === 'string') {
        config.table = {
            name: config.table
        };

        if (!config.record_id) {
            config.table.access_group = 0;
        }
    }

    if (typeof config.reference === 'string') {
        config.reference = {
            record_id: config.reference
        }
    }

    let progress = config.progress || null;
    let reference_private_key = null;
    let config_chkd = validator.Params(config || {}, {
        record_id: 'string',
        readonly: 'boolean',
        table: {
            name: 'string',
            // subscription_group: ['number', null],
            subscription: 'boolean',
            access_group: ['number', 'private', 'public', 'authorized']
        },
        reference: {
            record_id: (v: string) => {
                validator.specialChars(v, '"reference.record_id"', false, false);
                if (this.__private_access_key[v]) {
                    reference_private_key = this.__private_access_key[v];
                }
                return v;
            },
            reference_limit: (v: number) => {
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
            allow_multiple_reference: 'boolean',
        },
        index: {
            name: 'string',
            value: ['string', 'number', 'boolean']
        },
        tags: (v: string | string[]) => {
            if (v === null) {
                return v;
            }

            if (typeof v === 'string') {
                return [v];
            }

            if (Array.isArray(v)) {
                for (let i of v) {
                    if (typeof i !== 'string') {
                        throw new SkapiError(`"tags" should be type: <string | string[]>`, { code: 'INVALID_PARAMETER' });
                    }

                    validator.specialChars(v, 'tag', false, true);
                }
                return v;
            }

            throw new SkapiError(`"tags" should be type: <string | string[]>`, { code: 'INVALID_PARAMETER' });
        },
        remove_bin: (v: string[] | Binary[]) => {
            if (!v) {
                return null;
            }

            let arr = []
            if (Array.isArray(v)) {
                for (let i of v) {
                    if (typeof i === 'string') {
                        arr.push(i);
                    }
                    else if (i.url && i.size && i.filename && typeof i.getFile === 'function') {
                        arr.push(i.url);
                    }
                    else {
                        throw new SkapiError(`"remove_bin" should be type: <string | Binary[]>`, { code: 'INVALID_PARAMETER' });
                    }
                }
            }

            return arr;
        }
    }, [], ['response', 'onerror', 'progress'], null);

    if (!config_chkd?.table && !config_chkd?.record_id) {
        throw new SkapiError('Either "record_id" or "table" should have a value.', { code: 'INVALID_PARAMETER' });
    }

    if (typeof config_chkd.table !== 'string' && config_chkd.table) {
        if (config_chkd.table.access_group === 'public') {
            config_chkd.table.access_group = 0;
        }

        else if (config_chkd.table.access_group === 'authorized') {
            config_chkd.table.access_group = 1;
        }

        if (typeof config_chkd.table.access_group === 'number') {
            if (!isAdmin && this.user.access_group < config_chkd.table.access_group) {
                throw new SkapiError("User has no access", { code: 'INVALID_REQUEST' });
            }
        }

        if (!config_chkd.table.name) {
            throw new SkapiError('"table.name" cannot be empty string.', { code: 'INVALID_PARAMETER' });
        }

        validator.specialChars(config_chkd.table.name, 'table name', true, true);

        if (isAdmin) {
            if (config_chkd.table.access_group === 'private') {
                throw new SkapiError('Service owner cannot write private records.', { code: 'INVALID_REQUEST' });
            }

            // if (!config_chkd.record_id && config_chkd.table.hasOwnProperty('subscription')) {
            //     throw new SkapiError('Service owner cannot write to subscription table.', { code: 'INVALID_REQUEST' });
            // }
        }

        // if (typeof config.table?.subscription_group === 'number' && config.table.subscription_group < 0 || config.table.subscription_group > 99) {
        //     throw new SkapiError("Subscription group should be within range: 0 ~ 99", { code: 'INVALID_PARAMETER' });
        // }
        if (config_chkd.table?.subscription) {
            config_chkd.table.subscription_group = 1;
            delete config_chkd.table.subscription;
        }
    }

    config = config_chkd;

    // callbacks should be removed after checkparams
    delete config.response;
    delete config.onerror;
    delete config.progress;

    if (reference_private_key) {
        config.reference_private_key = reference_private_key;
    }

    if (config.index) {
        // index name allows periods. white space is invalid.
        if (!config.index.name || typeof config.index.name !== 'string') {
            throw new SkapiError('"index.name" is required. type: string.', { code: 'INVALID_PARAMETER' });
        }

        if (!['$uploaded', '$updated', '$referenced_count', '$user_id'].includes(config.index.name)) {
            validator.specialChars(config.index.name, 'index name', true);
        }

        if (!config.index.hasOwnProperty('value')) {
            throw new SkapiError('"index.value" is required.', { code: 'INVALID_PARAMETER' });
        }

        if (typeof config.index.value === 'string') {
            // index name allows periods. white space is invalid.
            validator.specialChars(config.index.value, 'index value', false, true);
        }

        else if (typeof config.index.value === 'number') {
            if (config.index.value > __index_number_range || config.index.value < -__index_number_range) {
                throw new SkapiError(`Number value should be within range -${__index_number_range} ~ +${__index_number_range}`, { code: 'INVALID_PARAMETER' });
            }
        }
    }

    let options: Record<string, any> = { auth: true };
    let postData = null;
    let to_bin = null;
    if ((form instanceof HTMLFormElement) || (form instanceof FormData) || (form instanceof SubmitEvent)) {
        // let toConvert = (form instanceof SubmitEvent) ? form.target : form;
        // let formData = !(form instanceof FormData) ? new FormData(toConvert as HTMLFormElement) : form;
        let formMeta = extractFormMeta(form);

        let formData = null;
        if (formMeta.files.length) {
            formData = new FormData();
            for (let f of formMeta.files) {
                formData.append(f.name, f.file, f.file.name);
            }
        }

        if (formMeta.to_bin.length) {
            to_bin = formMeta.to_bin;
        }

        // let formToRemove = {};

        // // remove all form data that is not in the formMeta
        // for (let [key, value] of formData.entries()) {
        //     if (formMeta.meta.hasOwnProperty(key) && !(value instanceof Blob)) {
        //         let f = formData.getAll(key);
        //         let f_idx = f.indexOf(value);
        //         if (formToRemove.hasOwnProperty(key)) {
        //             formToRemove[key].push(f_idx);
        //         }
        //         else {
        //             formToRemove[key] = [f_idx];
        //         }
        //     }
        // }

        // if (Object.keys(formToRemove).length) {
        //     for (let key in formToRemove) {
        //         let values = formData.getAll(key);
        //         let val_len = values.length;
        //         while (val_len--) {
        //             if (formToRemove[key].includes(val_len)) {
        //                 values.splice(val_len, 1);
        //             }
        //         }
        //         formData.delete(key);
        //         for (let dat of values) {
        //             formData.append(key, (dat as Blob), dat instanceof File ? dat.name : null);
        //         }
        //     }
        // }

        if (formData) {
            options.meta = config;

            if (Object.keys(formMeta.meta).length) {
                options.meta.data = formMeta.meta;
            }
            postData = formData;
        }
        else {
            postData = Object.assign({ data: form }, config);
        }
    }

    else {
        postData = Object.assign({ data: form }, config);
    }

    if (typeof progress === 'function') {
        fetchOptions.progress = progress;
    }

    if (Object.keys(fetchOptions).length) {
        Object.assign(options, { fetchOptions });
    }

    let rec = await request.bind(this)('post-record', postData, options);
    if (to_bin) {
        let bin_formData = new FormData();
        for (let f of to_bin) {
            bin_formData.append(f.name, f.file, f.file.name);
        }
        let uploadFileParams = {
            record_id: rec.rec,
            progress
        }
        if (config.hasOwnProperty('service')) {
            uploadFileParams['service'] = (config as any).service;
        }
        let { bin_endpoints } = await uploadFiles.bind(this)(bin_formData, uploadFileParams);
        if (!rec.bin) {
            rec.bin = bin_endpoints;
        }
        else {
            rec.bin.push(...bin_endpoints);
        }
    }

    return normalizeRecord.bind(this)(rec);
}

export async function getTables(
    /** If null fetch all list of tables. */
    query: {
        table: string;
        /** Condition operator of table name. */
        condition?: Condition;
    },
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse<{
    number_of_records: number; // Number of records in the table
    table: string; // Table name
    size: number; // Table size
}>> {
    let res = await request.bind(this)('get-table', validator.Params(query || {}, {
        table: 'string',
        condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne']
    }), Object.assign({ auth: true }, { fetchOptions }));

    let convert = {
        'cnt_rec': 'number_of_records',
        'tbl': 'table',
        'srvc': 'service'
    };

    if (Array.isArray(res?.list)) {
        for (let t of res.list) {
            for (let k in convert) {
                if (t.hasOwnProperty(k)) {
                    t[convert[k]] = t[k];
                    delete t[k];
                }
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
): Promise<DatabaseResponse<{
    table: string; // Table name
    index: string; // Index name
    number_of_records: number; // Number of records in the index
    string_count?: number; // Number of string type value
    number_count?: number; // Number of number type value
    boolean_count?: number; // Number of boolean type value
    total_number?: number; // Sum of all numbers
    total_bool?: number; // Number of true(boolean) values
    average_number?: number; // Average of all numbers
    average_bool?: number; // Percentage of true(boolean) values
}>> {
    if (!query?.table) {
        throw new SkapiError('"table" is required.', { code: 'INVALID_PARAMETER' });
    }

    let p = validator.Params(
        query || {},
        {
            table: 'string',
            index: (v: string) => validator.specialChars(v, 'index name', true, false),
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
                value: ['string', 'number', 'boolean'],
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
            { auth: true },
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
                table: iSplit[1],
                index: iSplit[2],
                number_of_records: i.cnt_rec
            };

            for (let k in convert) {
                if (i?.[k]) {
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
): Promise<DatabaseResponse<{
    table: string; // Table name
    tag: string; // Tag
    number_of_records: string; // Number records tagged
}>> {

    let res = await request.bind(this)(
        'get-tag',
        validator.Params(query || {},
            {
                table: 'string',
                tag: 'string',
                condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne']
            }
        ),
        Object.assign({ auth: true }, { fetchOptions })
    );

    if (Array.isArray(res?.list)) {
        for (let i in res.list) {
            let item = res.list[i];
            let tSplit = item.tag.split('/');
            res.list[i] = {
                table: tSplit[1],
                tag: tSplit[0],
                number_of_records: item.cnt_rec
            };
        }
    }

    return res;
}

export async function deleteRecords(params: {
    /** @ignore */
    service?: string;
    /** Record ID(s) to delete. Table parameter is not needed when record_id is given. */
    record_id?: string | string[];
    table?: {
        /** Table name. */
        name: string;
        /** Access group number. */
        access_group?: number | 'private' | 'public' | 'authorized';
        subscription?: boolean;
        // /** @ignore */
        // subscription?: string;
        // subscription_group?: number;
    };
}): Promise<string> {
    let isAdmin = await this.checkAdmin();
    if (isAdmin && !params?.service) {
        throw new SkapiError('Service ID is required.', { code: 'INVALID_PARAMETER' });
    }

    if (params?.record_id) {
        return await request.bind(this)('del-records', {
            service: params.service || this.service,
            record_id: (id => {
                if (typeof id === 'string') {
                    return [id];
                }

                if (!Array.isArray(id)) {
                    throw new SkapiError('"record_id" should be type: <string | string[]>', { code: 'INVALID_PARAMETER' });
                }

                if (id.length > 100) {
                    throw new SkapiError('"record_id" should not exceed 100 items.', { code: 'INVALID_PARAMETER' });
                }

                return validator.specialChars(id, 'record_id', false, false);

            })(params.record_id)
        }, { auth: true });
    }

    else {
        if (!params?.table) {
            if (isAdmin) {
                return null;
            }

            throw new SkapiError('Either "table" or "record_id" is required.', { code: 'INVALID_PARAMETER' });
        }

        let struct = {
            access_group: (v: number | 'private' | 'public' | 'authorized') => {
                if (typeof v === 'string' && ['private', 'public', 'authorized'].includes(v)) {
                    switch (v) {
                        case 'private':
                            return v;

                        case 'public':
                            return 0;

                        case 'authorized':
                            return 1;
                    }
                }

                else if (typeof v === 'number' && v >= 0 && v < 100) {
                    // if (!isAdmin && this.user.access_group < v) {
                    //     throw new SkapiError("User has no access", { code: 'INVALID_REQUEST' });
                    // }

                    return v;
                }

                throw new SkapiError('Invalid "table.access_group". Access group should be type <number (0~99) | "private" | "public" | "authorized">.', { code: 'INVALID_PARAMETER' });
            },
            name: 'string',
            subscription: (v: string | boolean) => {
                if (isAdmin && typeof params?.table?.subscription === 'string') {
                    // admin targets user id
                    return validator.UserId((v as string), 'User ID in "table.subscription"');
                }

                if (typeof v === 'boolean') {
                    if (v) {
                        return this.__user.user_id;
                    }
                    else {
                        return null;
                    }
                }

                throw new SkapiError('"table.subscription" is an invalid parameter key.', { code: 'INVALID_PARAMETER' });
            },
            // subscription_group: (v: number) => {
            //     if (isAdmin && typeof params?.table?.subscription !== 'string') {
            //         throw new SkapiError('"table.subscription" is required.', { code: 'INVALID_PARAMETER' });
            //     }

            //     if (typeof v === 'number') {
            //         if (v >= 0 && v < 99) {
            //             return v;
            //         }
            //     }

            //     throw new SkapiError('Subscription group should be between 0 ~ 99.', { code: 'INVALID_PARAMETER' });
            // }
        };

        let table_p = validator.Params(params.table || {}, struct, isAdmin ? [] : ['name']);

        if (table_p.subscription === null) {
            delete table_p.subscription;
        }
        else {
            table_p.subscription_group = 1;
        }

        params.table = table_p;
    }

    return await request.bind(this)('del-records', params, { auth: true });
}

export function grantPrivateRecordAccess(params: {
    record_id: string;
    user_id: string | string[];
}) {
    if (!params.record_id) {
        throw new SkapiError(`Record ID is required.`, { code: 'INVALID_PARAMETER' });
    }

    if (!params.user_id || Array.isArray(params.user_id) && !params.user_id.length) {
        throw new SkapiError(`User ID is required.`, { code: 'INVALID_PARAMETER' });
    }

    return recordAccess.bind(this)({
        record_id: params.record_id,
        user_id: params.user_id || null,
        execute: 'add'
    });
}

export function removePrivateRecordAccess(params: {
    record_id: string;
    user_id: string | string[];
}) {
    if (!params.record_id) {
        throw new SkapiError(`Record ID is required.`, { code: 'INVALID_PARAMETER' });
    }

    if (!params.user_id || Array.isArray(params.user_id) && !params.user_id.length) {
        throw new SkapiError(`User ID is required.`, { code: 'INVALID_PARAMETER' });
    }

    return recordAccess.bind(this)({
        record_id: params.record_id,
        user_id: params.user_id || null,
        execute: 'remove'
    });
}

export function listPrivateRecordAccess(params: {
    record_id: string;
    user_id: string | string[];
}) {
    let list = recordAccess.bind(this)({
        record_id: params.record_id,
        user_id: params.user_id || null,
        execute: 'list'
    });

    list.list = list.list.map((i: Record<string, any>) => {
        i.record_id = i.rec_usr.split('/')[0];
        i.user_id = i.rec_usr.split('/')[1];
        return i;
    });
}

export function requestPrivateRecordAccessKey(record_id: string) {
    return request.bind(this)(
        'request-private-access-key',
        { record_id },
        { auth: true }
    );
}

function recordAccess(params: {
    record_id: string;
    user_id: string | string[];
    execute: 'add' | 'remove' | 'list';
}) {
    let execute = params.execute;
    let req = validator.Params(params,
        {
            record_id: 'string',
            user_id: (v: string | string[]) => {
                if (!v) {
                    if (execute == 'list') {
                        return null;
                    }

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
            execute: ['add', 'remove', 'list']
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

