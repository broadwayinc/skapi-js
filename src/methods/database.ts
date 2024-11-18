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

const __index_number_range = 4503599627370496; // +/-

export async function normalizeRecord(record: Record<string, any>): Promise<RecordData> {
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
            referenced_count: 0,
            can_remove_reference: false
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
                let access_group = rSplit[2] == '**' ? 'private' : parseInt(rSplit[2]);
                access_group = access_group == 0 ? 'public' : access_group == 1 ? 'authorized' : access_group;
                output.table.access_group = access_group;
                // if (rSplit?.[3]) {
                //     output.table.subscription = {
                //         user_id: rSplit[3],
                //         group: parseInt(rSplit[4])
                //     };
                // }
                if (rSplit?.[3]) {
                    output.table.subscription = true;
                }
                else {
                    output.table.subscription = false;
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
                let access_group = rSplit[3] == '**' ? 'private' : parseInt(rSplit[3]);
                access_group = access_group == 0 ? 'public' : access_group == 1 ? 'authorized' : access_group;
                output.table.access_group = access_group;
                // if (rSplit?.[4]) {
                //     output.table.subscription = {
                //         user_id: rSplit[4],
                //         group: parseInt(rSplit[5])
                //     };
                // }
                if (rSplit?.[4]) {
                    output.table.subscription = true;
                }
                else {
                    output.table.subscription = false;
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
        'bin': async (r: string[]) => {
            let binObj = {};
            if (Array.isArray(r)) {
                for (let url of r) {
                    let path = url.split('/').slice(3).join('/');
                    let splitPath = path.split('/');
                    let filename = decodeURIComponent(splitPath.slice(-1)[0]);
                    let pathKey = decodeURIComponent(splitPath[10]);
                    let size = splitPath[9];
                    let uploaded = splitPath[8];
                    let access_group = splitPath[6] == '**' ? 'private' : parseInt(splitPath[6]);
                    access_group = access_group == 0 ? 'public' : access_group == 1 ? 'authorized' : access_group;

                    let url_endpoint = url;
                    if (access_group !== 'public') {
                        url_endpoint = (await getFile.bind(this)(url, { dataType: 'endpoint' }) as string);
                    }

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
        'prv_acs': (r: {[key: string]: string}) => {
            if(r?.can_remove_reference) {
                output.reference.can_remove_reference = r.can_remove_reference;
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

    for (let k in keys) {
        if (record.hasOwnProperty(k)) {
            let exec = keys[k](record[k]);
            if (exec instanceof Promise) {
                await exec;
            }
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
        expires?: number; // uses url that expires. this option does not use the cdn (slow). can be used for private files. (does not work on public files).
        progress?: ProgressCallback;
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
        progress: 'function'
    });


    if(config?.dataType === 'info') {
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
    let expires = config.expires;

    if (expires) {
        if(!isValidEndpoint) {
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

        this.log('request:tokens:', {
            exp: this.session.idToken.payload.exp,
            currTime,
            expiresIn: this.session.idToken.payload.exp - currTime,
            token: this.session.accessToken.jwtToken,
            refreshToken: this.session.refreshToken.token
        });

        if (this.session.idToken.payload.exp < currTime) {
            this.log('request:New token', null);
            try {
                await authentication.bind(this)().getSession({ refreshToken: true });
            }
            catch (err) {
                this.log('request:New token error', err);
                throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
            }
        }

        let token = this.session?.idToken?.jwtToken; // idToken

        url += `?t=${token}`;

        let access_group = target_key[6] === '**' ? '**' : parseInt(target_key[6]);

        if(this.user.user_id !== target_key[3] && (access_group === '**' || this.user?.access_group < access_group)) {
            let record_id = target_key[5];
            if (this.__private_access_key[record_id]) {
                url += '&p=' + this.__private_access_key[record_id];
            }
        }
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

export async function getRecords(query: GetRecordQuery & { private_key?: string; }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<RecordData>> {
    await this.__connection;

    if (typeof query?.table === 'string') {
        query.table = {
            name: query.table,
            access_group: 0
        };
    }

    let is_reference_fetch = '';
    let ref_user = '';

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
        const struct = {
            table: {
                name: [v => {
                    if (!v) {
                        throw new SkapiError('"table.name" cannot be empty string.', { code: 'INVALID_PARAMETER' });
                    }
                    return validator.specialChars(v, 'table name', true, true)
                }],
                access_group: [v => {
                    if (v === undefined) {
                        // access_group defaults to 1 if subscription value is present, else 0
                        if (!this.__user && query.table.hasOwnProperty('subscription')) {
                            return 1;
                        }
                        else {
                            return 0;
                        }
                    }

                    if (typeof v === 'number') {
                        if (v > 99 || v < 0) {
                            throw new SkapiError('"table.access_group" value should be within a range of 0 ~ 99.', { code: 'INVALID_REQUEST' });
                        }
                        return v;
                    }
                    else if (typeof v === 'string') {
                        v = {
                            private: 'private',
                            public: 0,
                            authorized: 1
                        }[v]

                        if (v === 'private' && !this.__user) {
                            throw new SkapiError('Unsigned users have no access to private records.', { code: 'INVALID_REQUEST' });
                        }

                        if (v === undefined) {
                            throw new SkapiError('"table.access_group" is invalid.', { code: 'INVALID_PARAMETER' });
                        }
                    }
                    else {
                        throw new SkapiError('"table.access_group" should be type: <number | string>.', { code: 'INVALID_PARAMETER' });
                    }

                    return v;
                }],
                subscription: (v: string) => {
                    if (v === null || v === undefined) {
                        return v;
                    }
                    validator.UserId(v, 'User ID in "subscription"')
                    if (!this.__user) {
                        throw new SkapiError('Unsigned users have no access to subscription records.', { code: 'INVALID_REQUEST' });
                    }
                    return {
                        user_id: v,
                        group: 1
                    }
                }
            },
            reference: v => {
                if (v === null || v === undefined) {
                    return v;
                }
                if (typeof v === 'string') {
                    try {
                        ref_user = validator.UserId(v);
                    }
                    catch (err) {
                        // reference is record id
                        validator.specialChars(v, 'reference', false, false);
                        is_reference_fetch = v;
                        if (this.__private_access_key[is_reference_fetch]) {
                            query.private_key = this.__private_access_key[is_reference_fetch];
                        }
                    }

                    is_reference_fetch = v;
                    return v;
                }
                else {
                    throw new SkapiError('"reference" should be type: string.', { code: 'INVALID_PARAMETER' });
                }
            },
            index: {
                name: ['$updated', '$uploaded', '$referenced_count', '$user_id', (v: string) => {
                    if (v === undefined) {
                        throw new SkapiError('"index.name" is required.', { code: 'INVALID_PARAMETER' });
                    }
                    if (typeof v !== 'string') {
                        throw new SkapiError('"index.name" should be type: string.', { code: 'INVALID_PARAMETER' });
                    }

                    return validator.specialChars(v, 'index.name', true, false);
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

                    else if (typeof v === 'number') {
                        if (v > __index_number_range || v < -__index_number_range) {
                            throw new SkapiError(`Number value should be within range -${__index_number_range} ~ +${__index_number_range}`, { code: 'INVALID_PARAMETER' });
                        }
                        return v;
                    }

                    else if (typeof v === 'boolean') {
                        return v;
                    }

                    else if (typeof v === 'string') {
                        return v;
                    }

                    else {
                        throw new SkapiError(`"index.value" should be type: <number | boolean | string>.`, { code: 'INVALID_PARAMETER' });
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
            tag: (v: string) => {
                if (v === null || v === undefined) {
                    return v;
                }
                if (typeof v === 'string') {
                    return validator.specialChars(v, 'tag', false, true)
                }
                else {
                    throw new SkapiError('"tag" should be type: string.', { code: 'INVALID_PARAMETER' });
                }
            },
            private_key: 'string'
        };

        let isAdmin = await checkAdmin.bind(this)();
        query = validator.Params(query || {}, struct, ref_user || isAdmin ? [] : ['table']);
    }

    let result = await request.bind(this)(
        'get-records',
        query,
        {
            fetchOptions,
            auth: !!this.__user,
            method: !!this.__user ? 'post' : 'get'
        }
    );

    for (let i in result.list) {
        result.list[i] = normalizeRecord.bind(this)(result.list[i]);
    };

    result.list = await Promise.all(result.list);

    if (is_reference_fetch && result?.reference_private_key) {
        this.__private_access_key[is_reference_fetch] = result.reference_private_key;
    }
    return result;
}

async function checkSchema(params) {
    return request.bind(this)('check-schema', params);
}

export async function postRecord(
    form: Form<Record<string, any>> | null | undefined,
    config: PostRecordConfig & { progress?: ProgressCallback; reference_private_key?: string; }
): Promise<RecordData> {
    let isAdmin = await checkAdmin.bind(this)();
    if (!config) {
        throw new SkapiError('"config" argument is required.', { code: 'INVALID_PARAMETER' });
    }

    if (!this.user) {
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

    if (typeof config.reference === 'string') {
        config.reference = {
            record_id: config.reference
        }
    }
    let _config = validator.Params(config || {}, {
        record_id: ['string', () => {
            if (!config.table || !config.table.name) {
                throw new SkapiError('"table.name" is required.', { code: 'INVALID_PARAMETER' });
            }
        }],
        readonly: 'boolean',
        table: {
            name: v => {
                if (!v) {
                    throw new SkapiError('"table.name" cannot be empty string.', { code: 'INVALID_PARAMETER' });
                }
                return validator.specialChars(v, 'table name', true, true)
            },
            // subscription_group: ['number', null],
            subscription: v => {
                if (v) {
                    if (!config.record_id && !config.table.access_group || config.table.access_group === 0 || config.table.access_group === 'public') {
                        throw new SkapiError('Public records cannot require subscription.', { code: 'INVALID_REQUEST' });
                    }
                }

                return v;
            },
            access_group: v => {
                if (typeof v === 'string') {
                    v = {
                        private: 'private',
                        public: 0,
                        authorized: 1
                    }[v]
                }

                if (typeof v === 'number') {
                    if (!isAdmin && this.user.access_group < v) {
                        throw new SkapiError("User has no access", { code: 'INVALID_REQUEST' });
                    }
                }

                if (v === undefined) {
                    throw new SkapiError('"table.access_group" is invalid.', { code: 'INVALID_PARAMETER' });
                }

                return v;
            }
        },
        reference: {
            record_id: v => {
                validator.specialChars(v, '"reference.record_id"', false, false);
                if (this.__private_access_key[v]) {
                    config.reference_private_key = this.__private_access_key[v];
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
            can_remove_reference: 'boolean'
        },
        index: {
            name: ['$uploaded', '$updated', '$referenced_count', '$user_id', v => {
                if (!v) {
                    throw new SkapiError('"index.name" is required.', { code: 'INVALID_PARAMETER' });
                }
                if (typeof v === 'string') {
                    validator.specialChars(v, 'index name', true);
                    return v;
                }
                throw new SkapiError('"index.name" should be type: string.', { code: 'INVALID_PARAMETER' });
            }],
            value: [v => {
                if (!v && typeof v !== 'boolean' && v !== 0) {
                    throw new SkapiError('"index.value" is required.', { code: 'INVALID_PARAMETER' });
                }

                let availTypes = ['boolean', 'string', 'number'];
                if (!availTypes.includes(typeof v)) {
                    throw new SkapiError('"index.value" should be type: <boolean | string | number>.', { code: 'INVALID_PARAMETER' });
                }

                if (typeof v === 'string') {
                    validator.specialChars(v, 'index value', false, true);
                }

                else if (typeof v === 'number') {
                    if (v > __index_number_range || v < -__index_number_range) {
                        throw new SkapiError(`Number value should be within range -${__index_number_range} ~ +${__index_number_range}`, { code: 'INVALID_PARAMETER' });
                    }
                }

                return v;
            }]
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
                        arr.push(i.split('?')[0]);
                    }
                    else if (i.url && i.size && i.filename) {
                        arr.push(i.url.split('?')[0]);
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
    if (config.table && config.table.hasOwnProperty('subscription')) {
        _config.table.subscription_group = config.table.subscription ? 1 : null;
        delete _config.table.subscription;
    }
    // callbacks should be removed after checkparams
    delete _config.progress;

    let options: { [key: string]: any } = { auth: true };
    let postData = null;
    let to_bin = null;
    let extractedForm = extractFormData(form);

    if (extractedForm.files.length) {
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

    // postData.schema_pass = await checkSchema.bind(this)(_config);

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

export async function deleteRecords(query: DelRecordQuery & { private_key?: string; }): Promise<string> {
    let isAdmin = await checkAdmin.bind(this)();
    let service = (query as any)?.service || this.service;
    let ref_user = '';
    let is_reference_fetch = '';

    if (query?.record_id) {
        return await request.bind(this)('del-records', {
            service: service,
            record_id: (id => {
                if (typeof id === 'string') {
                    return [id];
                }

                if (!Array.isArray(id)) {
                    throw new SkapiError('"record_id" should be type: <string | string[]>', { code: 'INVALID_PARAMETER' });
                }

                if ((id as string[]).length > 100) {
                    throw new SkapiError('"record_id" should not exceed 100 items.', { code: 'INVALID_PARAMETER' });
                }

                return validator.specialChars(id, 'record_id', false, false);

            })(query.record_id)
        }, { auth: true });
    }

    else {
        const struct = {
            table: {
                name: [v => {
                    if (!v) {
                        throw new SkapiError('"table.name" cannot be empty string.', { code: 'INVALID_PARAMETER' });
                    }
                    return validator.specialChars(v, 'table name', true, true)
                }],
                access_group: [v => {
                    if (v === undefined) {
                        // access_group defaults to 1 if subscription value is present, else 0
                        if (!this.__user && query.table.hasOwnProperty('subscription')) {
                            return 1;
                        }
                        else {
                            return 0;
                        }
                    }

                    if (typeof v === 'number') {
                        if (v > 99 || v < 0) {
                            throw new SkapiError('"table.access_group" value should be within a range of 0 ~ 99.', { code: 'INVALID_REQUEST' });
                        }
                        return v;
                    }
                    else if (typeof v === 'string') {
                        v = {
                            private: 'private',
                            public: 0,
                            authorized: 1
                        }[v]

                        if (v === 'private' && !this.__user) {
                            throw new SkapiError('Unsigned users have no access to private records.', { code: 'INVALID_REQUEST' });
                        }

                        if (v === undefined) {
                            throw new SkapiError('"table.access_group" is invalid.', { code: 'INVALID_PARAMETER' });
                        }
                    }
                    else {
                        throw new SkapiError('"table.access_group" should be type: <number | string>.', { code: 'INVALID_PARAMETER' });
                    }

                    return v;
                }],
                subscription: (v: string) => {
                    if (v === null || v === undefined) {
                        return v;
                    }
                    if (!this.__user) {
                        throw new SkapiError('Unsigned users have no access to subscription records.', { code: 'INVALID_REQUEST' });
                    }
                    if(typeof v === 'boolean') {
                        v = this.__user.user_id;
                    }
                    else {
                        validator.UserId(v, 'User ID in "subscription"')
                    }
                    
                    return {
                        user_id: v,
                        group: 1
                    }
                }
            },
            reference: v => {
                if (v === null || v === undefined) {
                    return v;
                }
                if (typeof v === 'string') {
                    try {
                        ref_user = validator.UserId(v);
                    }
                    catch (err) {
                        // reference is record id
                        validator.specialChars(v, 'reference', false, false);
                        is_reference_fetch = v;
                        if (this.__private_access_key[is_reference_fetch]) {
                            query.private_key = this.__private_access_key[is_reference_fetch];
                        }
                    }

                    is_reference_fetch = v;
                    return v;
                }
                else {
                    throw new SkapiError('"reference" should be type: string.', { code: 'INVALID_PARAMETER' });
                }
            },
            index: {
                name: ['$updated', '$uploaded', '$referenced_count', '$user_id', (v: string) => {
                    if (v === undefined) {
                        throw new SkapiError('"index.name" is required.', { code: 'INVALID_PARAMETER' });
                    }
                    if (typeof v !== 'string') {
                        throw new SkapiError('"index.name" should be type: string.', { code: 'INVALID_PARAMETER' });
                    }

                    return validator.specialChars(v, 'index.name', true, false);
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

                    else if (typeof v === 'number') {
                        if (v > __index_number_range || v < -__index_number_range) {
                            throw new SkapiError(`Number value should be within range -${__index_number_range} ~ +${__index_number_range}`, { code: 'INVALID_PARAMETER' });
                        }
                        return v;
                    }

                    else if (typeof v === 'boolean') {
                        return v;
                    }

                    else if (typeof v === 'string') {
                        return v;
                    }

                    else {
                        throw new SkapiError(`"index.value" should be type: <number | boolean | string>.`, { code: 'INVALID_PARAMETER' });
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
            tag: (v: string) => {
                if (v === null || v === undefined) {
                    return v;
                }
                if (typeof v === 'string') {
                    return validator.specialChars(v, 'tag', false, true)
                }
                else {
                    throw new SkapiError('"tag" should be type: string.', { code: 'INVALID_PARAMETER' });
                }
            },
            private_key: 'string'
        };

        query = validator.Params(query || {}, struct, ref_user || isAdmin ? [] : ['table']);
        
        let result = await request.bind(this)('del-records', query, { auth: true });
        if (is_reference_fetch && result?.reference_private_key) {
            this.__private_access_key[is_reference_fetch] = result.reference_private_key;
        }

        return result?.message || result;
    }
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

export function requestPrivateRecordAccessKey(params: {record_id: string | string[]}): Promise<{[record_id:string]:string}> {
    let record_id:string | string[] = params.record_id;
    if (!record_id) {
        throw new SkapiError(`Record ID is required.`, { code: 'INVALID_PARAMETER' });
    }
    
    if(typeof record_id === 'string') {
        record_id = [record_id];
    }

    if(typeof record_id !== 'string') {
        if(Array.isArray(record_id)) {
            record_id.forEach((id) => {
                if(typeof id !== 'string') {
                    throw new SkapiError(`Record ID should be type: <string | string[]>`, { code: 'INVALID_PARAMETER' });
                }
            });
        }
        else {
            throw new SkapiError(`Record ID should be type: <string | string[]>`, { code: 'INVALID_PARAMETER' });
        }
    }

    let res = request.bind(this)(
        'request-private-access-key',
        { record_id },
        { auth: true }
    );

    for(let i in res) {
        this.__private_access_key[i] = res[i];
    }

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

