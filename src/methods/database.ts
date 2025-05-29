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
    DelRecordQuery
} from '../Types';
import SkapiError from '../main/error';
import { extractFormData, fromBase62 } from '../utils/utils';
import validator from '../utils/validator';
import { request, uploadFiles } from '../utils/network';
import { checkAdmin } from './user';
import { authentication } from './user';
import { accessGroup, cannotBeEmptyString, getStruct, indexValue, recordIdOrUniqueId } from './param_restrictions';


export async function normalizeRecord(record: Record<string, any>): Promise<RecordData> {
    this.log('normalizeRecord', record);
    const output: Record<string, any> = {
        user_id: '',
        record_id: '',
        updated: 0,
        uploaded: 0,
        readonly: false,
        table: {
            name: '',
            access_group: 0
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
    function access_group_set(v) {
        let access_group = v == '**' ? 'private' : parseInt(v);
        access_group = access_group == 0 ? 'public' : access_group == 1 ? 'authorized' : access_group == 99 ? 'admin' : access_group;
        return access_group;
    }
    const keys = {
        'ip': (r: string) => {
            let split_ip = r.split('#');
            let ip = split_ip[0];
            if (split_ip.length > 1) {
                output.unique_id = split_ip[1];
            }
            if (ip.slice(-1) === 'R') {
                output.readonly = true;
                ip = ip.slice(0, -1);
            }
            else {
                output.readonly = false;
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
                output.table.name = rSplit[0];
                output.table.access_group = access_group_set(rSplit[2]);
                if (rSplit?.[3]) {
                    if (!output.table?.subscription)
                        output.table.subscription = {};
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
                output.table.name = rSplit[1];
                output.table.access_group = access_group_set(rSplit[3]);
                if (rSplit?.[4]) {
                    if (!output.table?.subscription)
                        output.table.subscription = {};
                    output.table.subscription.is_subscription_record = true;
                }
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
            output.reference = r.split('/')[0];
        },
        'tags': (r: string[]) => {
            output.tags = r;
        },
        'upd': (r: number) => {
            output.updated = r;
        },
        'acpt_mrf': (r: boolean) => {
            // output.reference.allow_multiple_reference = r; // depricated
            output.source.prevent_multiple_referencing = !r;
        },
        'ref_limt': (r: number) => {
            // output.reference.reference_limit = r; // depricated
            output.source.referencing_limit = r;
        },
        "alw_gnt": (r: boolean) => {
            output.source.allow_granted_to_grant_others = r;
        },
        'rfd': (r: number) => {
            // output.reference.referenced_count = r; // depricated
            output.referenced_count = r;
        },
        'bin': async (r: string[]) => {
            let binObj = {};
            let _ref = output?.reference || null;
            if (Array.isArray(r)) {
                for (let url of r) {
                    let path = url.split('/').slice(3).join('/');
                    let splitPath = path.split('/');
                    let filename = decodeURIComponent(splitPath.slice(-1)[0]);
                    let pathKey = decodeURIComponent(splitPath[10]);
                    let size = splitPath[9];
                    let uploaded = splitPath[8];
                    let access_group = access_group_set(splitPath[6]);
                    let url_endpoint = url;
                    if (access_group !== 'public') {
                        url_endpoint = (await getFile.bind(this)(url, { dataType: 'endpoint', _ref }) as string);
                    }
                    // auth/serviceid/ownerid/uploaderid/records/recordid/access_group/bin/timestamp_base62/size_base62/form_keyname/filename.ext

                    let obj = {
                        access_group,
                        filename,
                        url: url_endpoint,
                        path,
                        size: fromBase62(size),
                        uploaded: fromBase62(uploaded),
                        getFile: (dataType: 'base64' | 'download' | 'endpoint' | 'blob' | 'text' | 'info', progress?: ProgressCallback) => {
                            let config = {
                                dataType: dataType || 'download',
                                progress,
                                _ref,
                                _update: obj
                            };
                            return getFile.bind(this)(url_endpoint, config);
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
        'prv_acs': (r: { [key: string]: string }) => {
            for (let k in r) {
                let subscription_config = ['notify_subscribers', 'exclude_from_feed', 'feed_referencing_records', 'notify_referencing_records'];
                if (subscription_config.includes(k)) {
                    if (!output.table.subscription) {
                        output.table.subscription = {};
                    }
                    output.table.subscription[k] = r[k];
                }
                else {
                    output.source[k] = r[k];
                }
            }
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

    if (this.__iPosted[record.rec]) {
        if (this.__iPosted[record.rec].record_id) {
            return this.__iPosted[record.rec];
        }
        else {
            delete this.__iPosted[record.rec];
        }
    }

    for (let k in keys) {
        if (record.hasOwnProperty(k)) {
            let exec = keys[k](record[k]);
            if (exec instanceof Promise) {
                await exec;
            }
        }
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

    let updatedRec = await request.bind(this)('del-files', {
        endpoints,
        storage: 'records'
    }, { auth: true, method: 'post' });

    for (let i in updatedRec) {
        updatedRec[i] = normalizeRecord.bind(this)(updatedRec[i]);
    }

    return await Promise.all(updatedRec);
}

export async function getFile(
    url: string, // cdn endpoint url https://xxxx.cloudfront.net/path/file
    config?: {
        dataType?: 'base64' | 'download' | 'endpoint' | 'blob' | 'text' | 'info'; // default 'download'
        expires?: number; // uses url that expires in given seconds. this option does not use the cdn (slow). can be used for private files. (does not work on public files).
        progress?: ProgressCallback;
        _ref?: string;
        _update?: any;
    }
): Promise<Blob | string | void | FileInfo> {
    if (typeof url !== 'string') {
        throw new SkapiError('"url" should be type: string.', { code: 'INVALID_PARAMETER' });
    }

    url = validator.Url(url.split('?')[0]);
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

    config = validator.Params(config, {
        expires: ['number', () => 0],
        dataType: ['base64', 'blob', 'endpoint', 'text', 'info', () => 'download'],
        progress: 'function',
        _ref: 'string',
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
        let currTime = Math.floor(Date.now() / 1000);

        this.log('getFile:tokens', {
            exp: this.session.idToken.payload.exp,
            currTime,
            expiresIn: this.session.idToken.payload.exp - currTime,
            token: this.session.accessToken.jwtToken,
            refreshToken: this.session.refreshToken.token
        });

        if (this.session.idToken.payload.exp < currTime) {
            this.log('getFile:requesting new token', null);
            try {
                await authentication.bind(this)().getSession({ refreshToken: true });
                this.log('getFile:received new tokens', {
                    exp: this.session.idToken.payload.exp,
                    currTime,
                    expiresIn: this.session.idToken.payload.exp - currTime,
                    token: this.session.accessToken.jwtToken,
                    refreshToken: this.session.refreshToken.token
                });
            }
            catch (err) {
                this.log('getFile:new token error', err);
                throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
            }
        }

        let token = this.session?.idToken?.jwtToken; // idToken

        url += `?t=${token}`;

        let access_group = target_key[6] === '**' ? '**' : parseInt(target_key[6]);

        if (this.user.user_id !== target_key[3] && (access_group === '**' || this.user?.access_group < access_group)) {
            let record_id = target_key[5];
            if (this.__private_access_key[record_id] && typeof this.__private_access_key[record_id] === 'string') {
                url += '&p=' + this.__private_access_key[record_id];
            }
            else if (this.owner !== this.host) {
                try {
                    let p = await this.requestPrivateRecordAccessKey({ record_id, reference_id: config?._ref });
                    url += '&p=' + p;
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

    let blob: Promise<string> = new Promise(async (res, rej) => {
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
            rej(err);
        }
    });

    return blob;
}

async function prepGetParams(query, isDel = false) {
    query = extractFormData(query, { ignoreEmpty: true }).data;

    if (typeof query?.table === 'string') {
        query.table = {
            name: query.table,
            access_group: 0
        };
    }

    let is_reference_fetch = '';

    let rec_or_uniq = recordIdOrUniqueId(query);

    if (rec_or_uniq) {
        query = rec_or_uniq;
        is_reference_fetch = query.record_id || query.unique_id;

        if (typeof is_reference_fetch === 'string') {
            if (typeof this.__private_access_key?.[is_reference_fetch] === 'string') {
                query.private_key = this.__private_access_key?.[is_reference_fetch] || undefined;
            }
            if (this.__my_unique_ids[is_reference_fetch]) {
                if (isDel) {
                    delete this.__my_unique_ids[is_reference_fetch];
                }
                else {
                    query.record_id = this.__my_unique_ids[is_reference_fetch];
                    // delete query.unique_id;
                }
            }
        }
    }
    else {
        let isAdmin = await checkAdmin.bind(this)();
        let ref: any = query.reference;
        let ref_user = '';

        // if (ref?.record_id || ref?.unique_id) {
        if (ref?.record_id) {
            is_reference_fetch = ref.record_id || ref.unique_id;

            if (is_reference_fetch && typeof this.__private_access_key?.[is_reference_fetch] === 'string') {
                query.private_key = this.__private_access_key?.[is_reference_fetch] || undefined;
            }

            // if (this.__my_unique_ids[is_reference_fetch]) {
            //     // ref.record_id = this.__my_unique_ids[is_reference_fetch];
            //     // delete ref.unique_id;
            // }

            query.reference = is_reference_fetch;
        }
        else if (ref?.user_id) {
            ref_user = ref.user_id;
            query.reference = ref_user;
        }
        query = validator.Params(query || {}, getStruct.bind(this)(query), ref_user || isAdmin ? [] : ['table'], { ignoreEmpty: true });
    }
    return {
        query,
        is_reference_fetch
    }
}

export async function getRecords(query: GetRecordQuery & { private_key?: string; }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<RecordData>> {
    await this.__connection;

    let q = await prepGetParams.bind(this)(query);
    let is_reference_fetch = q.is_reference_fetch;

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

    for (let i in result.list) {
        result.list[i] = normalizeRecord.bind(this)(result.list[i]);
    };

    result.list = await Promise.all(result.list);

    return result;
}

export async function postRecord(
    form: Form<Record<string, any>> | null | undefined,
    config: PostRecordConfig & { reference_private_key?: string; },
    files?: { name: string, file: File }[],
): Promise<RecordData> {
    await this.__connection;

    let is_reference_post = "";

    if (!config) {
        throw new SkapiError('"config" argument is required.', { code: 'INVALID_PARAMETER' });
    }

    if (!this.__user) {
        throw new SkapiError('Login is required.', { code: 'INVALID_REQUEST' });
    }

    if (typeof config.table === 'string') {
        config.table = {
            name: config.table
        };

        if (!config.record_id) {
            config.table.access_group = 0;
        }
    }

    let reference_limit_check = (v: number) => {
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
    }


    if (config.table?.subscription) {
        if (config.table?.subscription?.is_subscription_record) {
            Object.assign(config.table.subscription, { group: 1 });
        }

        else if (config.table?.subscription?.is_subscription_record === false || !config.record_id && !config.table.subscription?.is_subscription_record) {
            Object.assign(config.table.subscription, { group: null });
        }

        delete config.table.subscription?.is_subscription_record;
    }

    let _config = validator.Params(config || {}, {
        record_id: ['string', () => {
            if (!config.table || !config.table.name) {
                throw new SkapiError('"table.name" is required.', { code: 'INVALID_PARAMETER' });
            }
        }],
        unique_id: 'string',
        readonly: 'boolean',
        table: {
            name: v => cannotBeEmptyString(v, 'table name', true, true),
            subscription: {
                group: v => {
                    if (v === 1) {
                        return 1
                    }
                    return null;
                },

                exclude_from_feed: 'boolean',
                notify_subscribers: 'boolean',

                feed_referencing_records: 'boolean',
                notify_referencing_records: 'boolean',
            },
            access_group: accessGroup.bind(this),
        },
        source: {
            referencing_limit: reference_limit_check,
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
                    name: [v => cannotBeEmptyString(v, '"name" in "index_restrictions"', true, false)],
                    value: v => indexValue(v),
                    condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne', () => null],
                    range: val => {
                        if (val !== null && typeof v.value !== typeof val) {
                            throw new SkapiError('Index restriction "range" type should match the type of "value".', { code: 'INVALID_PARAMETER' });
                        }
                        if (!v.hasOwnProperty('value')) {
                            throw new SkapiError('Index restriction "value" is required.', { code: 'INVALID_PARAMETER' });
                        }
                        if (v.condition && (v.condition !== 'eq' || v.condition !== '=')) {
                            throw new SkapiError('Index restriction "condition" cannot be used with "range".', { code: 'INVALID_PARAMETER' });
                        }
                        return val;
                    }
                }

                if (!Array.isArray(v)) {
                    v = [v];
                }

                return v.map(vv => validator.Params(vv, p));
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
                if (this.__my_unique_ids[v]) {
                    return this.__my_unique_ids[v];
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
                    return validator.specialChars(v, '"reference.record_id"', false, false);
                },
                reference_limit: reference_limit_check, // depricated. this is here just for backward compatibility.
                allow_multiple_reference: 'boolean', // depricated. this is here just for backward compatibility.
            });
        },
        index: {
            name: v => cannotBeEmptyString(v, 'index.name', true, false),
            value: v => indexValue(v)
        },
        tags: (v: string | string[]) => {
            if (v === null || v === undefined) {
                return v;
            }
            if (typeof v === 'string') {
                v = v.split(',').map(t => t.trim());
            }
            return validator.specialChars(v, 'tag', false, true);
        },
        remove_bin: (v: string[] | BinaryFile[] | null) => {
            if (!v) {
                return null;
            }

            let arr = []
            if (Array.isArray(v)) {
                for (let i of v) {
                    if (typeof i === 'string') {
                        arr.push(decodeURIComponent(i.split('?')[0]));
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
    });

    let progress = config.progress || null;

    // callbacks should be removed after checkparams
    delete _config.progress;

    let options: { [key: string]: any } = { auth: true };
    let postData = null;
    let to_bin = null;
    let extractedForm = extractFormData(form);

    if(files) {
        to_bin = files;
    }
    else if (extractedForm.files.length) {
        to_bin = extractedForm.files;
    }

    postData = Object.assign({ data: extractedForm.data }, _config);

    let fetchOptions: { [key: string]: any } = {};

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

    let record = await normalizeRecord.bind(this)(rec);
    this.__iPosted[record.record_id] = record;
    if (record.unique_id) {
        this.__my_unique_ids[record.unique_id] = record.record_id;
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
): Promise<DatabaseResponse<{
    number_of_records: number; // Number of records in the table
    table: string; // Table name
    size: number; // Table size
}>> {
    let res = await request.bind(this)('get-table', validator.Params(query || {}, {
        table: 'string',
        condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne']
    }), Object.assign({ auth: !!this.__user }, { fetchOptions }));

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
        Object.assign({ auth: !!this.__user }, { fetchOptions })
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
export async function getUniqueId(
    query?: Form<{
        /** Unique ID */
        unique_id?: string;
        /** String query condition for tag name. */
        condition?: Condition;
    }>,
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse<{
    unique_id: string; // Unique ID
    record_id: string; // Record ID
}>> {

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

    let q = await prepGetParams.bind(this)(query, true);
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
    params = validator.Params(params, {
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
        }
    }, ['record_id', 'user_id'], { ignoreEmpty: true });

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

export async function listPrivateRecordAccess(params: {
    record_id: string;
    user_id: string | string[];
}): Promise<DatabaseResponse<{ record_id: string; user_id: string; }>> {
    let list = await recordAccess.bind(this)({
        record_id: params.record_id,
        user_id: params.user_id || null,
        execute: 'list'
    });

    list.list = list.list.map((i: Record<string, any>) => {
        i.record_id = i.rec_usr.split('/')[0];
        i.user_id = i.rec_usr.split('/')[1];
        return i;
    });

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

    if (this.__private_access_key[record_id]) {
        return this.__private_access_key[record_id];
    }

    let res = request.bind(this)(
        'request-private-access-key',
        { record_id, reference_id },
        { auth: true }
    );

    this.__private_access_key[record_id] = res;

    return res;
}

function recordAccess(params: {
    record_id: string;
    user_id: string | string[];
    execute: 'add' | 'remove' | 'list';
}): Promise<any> {
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

