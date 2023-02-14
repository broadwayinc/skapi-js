import {
    RecordData,
    Form,
    FormSubmitCallback,
    FetchOptions,
    DatabaseResponse,
    GetRecordQuery,
    Condition,
    PostRecordConfig
} from '../Types';
import SkapiError from '../main/error';
import { extractFormMeta } from '../utils/utils';
import validator from '../utils/validator';
import { request } from './request';

const __index_number_range = 4503599627370496; // +/-

function normalizeRecord(record: Record<string, any>): RecordData {
    function base_decode(chars) {
        let charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        return chars.split('').reverse().reduce((prev, curr, i) =>
            prev + (charset.indexOf(curr) * (62 ** i)), 0);
    }

    const output: Record<string, any> = {
        config: {
            reference_limit: null
        }
    };

    const keys = {
        'ip': (r: string) => {
            output.ip = r;
        },
        'rec': (r: string) => {
            if (!r) return;
            output.record_id = r;
            let base62timestamp = r.substring(0, r.length - 9); // id: [base62 timestamp][random 5 char][suid]
            let uploaded = base_decode(base62timestamp);
            output.uploaded = uploaded;
        },
        'usr': (r: string) => {
            output.user_id = r;
        },
        'tbl': (r: string) => {
            if (!r) return;
            let rSplit = r.split('/');
            output.table = rSplit[0];
            output.access_group = rSplit[2] == '**' ? 'private' : parseInt(rSplit[2]);
            if (rSplit?.[3]) {
                output.subscription = {
                    user_id: rSplit[3],
                    group: parseInt(rSplit[4])
                };
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
            if (!output.hasOwnProperty('reference')) {
                output.reference = {};
            }
            output.reference.record_id = r.split('/')[0];
        },
        'tags': (r: string[]) => {
            output.tags = r;
        },
        'upd': (r: number) => {
            output.updated = r;
        },
        'acpt_mrf': (r: boolean) => {
            if (!output.hasOwnProperty('reference')) {
                output.reference = {};
            }
            output.reference.allow_multiple_reference = r;
        },
        'ref_limt': (r: number) => {
            if (!output.hasOwnProperty('reference')) {
                output.reference = {};
            }
            output.reference.reference_limit = r;
        },
        'rfd': (r: number) => {
            output.referenced_count = r;
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
        keys[k](record[k]);
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
            return Number(value) - 4503599627370496;
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

export async function getRecords(query: GetRecordQuery, fetchOptions?: FetchOptions): Promise<DatabaseResponse> {
    const indexTypes = {
        '$updated': 'number',
        '$uploaded': 'number',
        '$referenced_count': 'number'
    };

    const struct = {
        table: 'string',
        reference: 'string',
        access_group: ['number', 'private'],
        subscription: {
            user_id: (v: string) => validator.UserId(v, 'User ID in "subscription.user_id"'),
            group: (v: number) => {
                if (typeof v !== 'number') {
                    throw new SkapiError('"subscription.group" should be type: number.', { code: 'INVALID_PARAMETER' });
                }
                if (v > 99 || v < 0) {
                    throw new SkapiError('"subscription.group" should be within range: 0 ~ 99.', { code: 'INVALID_PARAMETER' });
                }
                return v;
            }
        },
        index: {
            name: (v: string) => {
                if (typeof v !== 'string') {
                    throw new SkapiError('"index.name" should be type: string.', { code: 'INVALID_PARAMETER' });
                }

                if (indexTypes.hasOwnProperty(v)) {
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
                    return validator.specialChars(v, 'index.value');
                }

                return v;
            }
        },
        tag: 'string'
    };

    if (query?.record_id) {
        validator.specialChars(query.record_id, 'record_id', false, false);
        query = { record_id: query.record_id, service: query?.service };
    }

    else {
        let ref_user;
        if (query?.reference) {
            try {
                ref_user = validator.UserId(query?.reference, 'User ID in "subscription.user_id"');
            } catch (err) {
                // bypass error
            }
        }

        query = validator.Params(query || {}, struct, ref_user ? [] : ['table']);
        if (query?.subscription && !this.session) {
            throw new SkapiError('Requires login.', { code: 'INVALID_REQUEST' });
        }
    }

    let auth = query.hasOwnProperty('access_group') && query.access_group ? true : !!this.__user;
    let result = await request.bind(this)(
        'get-records',
        query,
        {
            fetchOptions,
            auth,
            method: auth ? 'post' : 'get'
        }
    );

    for (let i in result.list) { result.list[i] = normalizeRecord(result.list[i]); };

    return result;
};

export async function postRecord(
    form: Form | null | undefined,
    config: PostRecordConfig & FormSubmitCallback
): Promise<RecordData> {
    let isAdmin = await this.checkAdmin();
    if (!config) {
        throw new SkapiError(['INVALID_PARAMETER', '"config" argument is required.']);
    }

    let { formData } = config;
    let fetchOptions: Record<string, any> = {};

    if (typeof formData === 'function') {
        fetchOptions.formData = formData;
    }

    config = validator.Params(config || {}, {
        record_id: 'string',
        access_group: ['number', 'private'],
        table: 'string',
        subscription_group: ['number', null],
        reference: {
            record_id: ['string', null],
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
                }
                return v;
            }

            throw new SkapiError(`"tags" should be type: <string | string[]>`, { code: 'INVALID_PARAMETER' });
        },
        private_access: (v: string | string[]) => {
            let param = 'config.private_access';

            if (v === null) {
                return null;
            }

            if (v && typeof v === 'string') {
                v = [v];
            }

            if (Array.isArray(v)) {
                for (let u of v) {
                    validator.UserId(u, `User ID in "${param}"`);

                    if (this.__user && u === this.__user.user_id) {
                        throw new SkapiError(`"${param}" should not be the uploader's user ID.`, { code: 'INVALID_PARAMETER' });
                    }
                }
            }

            else {
                throw new SkapiError(`"${param}" should be an array of user ID.`, { code: 'INVALID_PARAMETER' });
            }

            return v;
        }
    }, [], ['response', 'formData', 'onerror']);

    if (typeof config?.access_group === 'number' && this.user.access_group < config.access_group) {
        throw new SkapiError("User has no access", { code: 'INVALID_REQUEST' });
    }

    if (typeof config?.subscription_group === 'number' && config.subscription_group < 0 || config.subscription_group > 99) {
        throw new SkapiError("Subscription group should be within range: 0 ~ 99", { code: 'INVALID_PARAMETER' });
    }

    // callbacks should be removed after checkparams
    delete config.response;
    delete config.formData;
    delete config.onerror;

    if (config?.table === '') {
        throw new SkapiError('"table" cannot be empty string.', { code: 'INVALID_PARAMETER' });
    }

    if (!config?.table && !config?.record_id) {
        throw new SkapiError('Either "record_id" or "table" should have a value.', { code: 'INVALID_PARAMETER' });
    }

    if (config?.index) {
        // index name allows periods. white space is invalid.
        if (!config.index?.name || typeof config.index?.name !== 'string') {
            throw new SkapiError('"index.name" is required. type: string.', { code: 'INVALID_PARAMETER' });
        }

        validator.specialChars(config.index.name, 'index name', true);

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

    if (isAdmin) {
        if (config?.access_group === 'private') {
            throw new SkapiError('Service owner cannot write private records.', { code: 'INVALID_REQUEST' });
        }

        if (config.hasOwnProperty('subscription_group')) {
            throw new SkapiError('Service owner cannot write to subscription table.', { code: 'INVALID_REQUEST' });
        }
    }

    let options: Record<string, any> = { auth: true };
    let postData = null;

    if ((form instanceof HTMLFormElement) || (form instanceof FormData) || (form instanceof SubmitEvent)) {
        let toConvert = (form instanceof SubmitEvent) ? form.target : form;
        let formData = !(form instanceof FormData) ? new FormData(toConvert as HTMLFormElement) : form;
        let formMeta = extractFormMeta(form);
        options.meta = config;

        if (Object.keys(formMeta.meta).length) {
            options.meta.data = formMeta.meta;
        }

        let formToRemove = [];
        for (const pair of formData.entries()) {
            if (!formMeta.files.includes(pair[0])) {
                formToRemove.push(pair[0]);
            }
        }

        if (formToRemove.length) {
            for (let f of formToRemove) {
                formData.delete(f);
            }
        }

        postData = formData;
    }

    else {
        postData = Object.assign({ data: form }, config);
    }

    if (Object.keys(fetchOptions).length) {
        Object.assign(options, { fetchOptions });
    }

    return normalizeRecord(await request.bind(this)('post-record', postData, options));
}

export async function getTable(
    query: {
        /** Table name. If omitted fetch all list of tables. */
        table?: string;
        /** Condition operator of table name. */
        condition?: Condition;
    } | null,
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse> {
    let res = await request.bind(this)('get-table', validator.Params(query || {}, {
        table: 'string',
        condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne']
    }), Object.assign({ auth: true }, { fetchOptions }));

    let convert = {
        'cnt_rec': 'number_of_records',
        'tbl': 'table',
        'srvc': 'service'
    };

    if (Array.isArray(res.list)) {
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
};

export async function getIndex(
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
    } | null,
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse> {
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
        if (p.hasOwnProperty('index')) {
            if (p.index.substring(p.index.length - 1) !== '.') {
                throw new SkapiError('"index" should be parent "index name".', { code: 'INVALID_PARAMETER' });
            }

            if (!p.order?.by) {
                throw new SkapiError('"order.by" is required.', { code: 'INVALID_PARAMETER' });
            }

            if (p.order.hasOwnProperty('condition') && !p.order.hasOwnProperty('value')) {
                throw new SkapiError('"value" is required for "condition".', { code: 'INVALID_PARAMETER' });
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

    if (Array.isArray(res.list)) {
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
};

export async function getTag(
    query: {
        /** Table name */
        table: string;
        /** Tag name */
        tag?: string;
        /** String query condition for tag name. */
        condition?: Condition;
    },
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse> {

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

    if (Array.isArray(res.list)) {
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
};

/**
* Deletes specific records or bulk of records under certain table, access group.
* <br>
* <b>WARNING:</b> Deleted record cannot be restored.
* 
* ```
* // Delete record
* // users wont be able to delete other users record.
* await skapi.deleteRecords({
*     record_id: ['record id 1', 'record id 2']
* });
* 
* // Delete all my record in "MyTable" in access group 1.
* await skapi.deleteRecords({
*     access_group: 1,
*     table: {
*         name: 'MyTable'
*     }
* });
* 
* // Delete all record in subscription table of group 1 in "MyTable" in access group 0.
* await skapi.deleteRecords({
*     access_group: 0,
*     table: {
*         name: 'MyTable',
*         subscription_group: 1
*     }
* });
* 
* // (for admin) Delete all record in the service
* await skapi.deleteRecords({
*   service: 'xxxxxxxx'
* });
* 
* // (for admin) Delete all record in "MyTable"
* // admin can delete all records in table regardless access group or subscription tables.
* await skapi.deleteRecords({
*   service: 'xxxxxxxx',
*   table: {
*       name: 'MyTable'
*   }
* });
* 
* // admin can delete all records in users subscription table from target access group.
* await skapi.deleteRecords({
*   service: 'xxxxxxxx',
*   access_group: 1,
*   table: {
*       name: 'MyTable',
*       subscription: 'user_id',
*       subscription_group: 1
*   }
* });
* 
* ```
*/
export async function deleteRecords(params: {
    /** @ignore */
    service?: string;
    /** Record ID(s) to delete. Table parameter is not needed when record_id is given. */
    record_id?: string | string[];
    /** Access group number. */
    access_group?: number | 'private';
    table?: {
        /** Table name. */
        name: string;
        /** @ignore */
        subscription?: string;
        /** @ignore */
        subscription_group?: number;
    };
}): Promise<string> {
    let isAdmin = await this.checkAdmin();
    if (isAdmin && !params?.service) {
        throw new SkapiError('Service ID is required.', { code: 'INVALID_PARAMETER' });
    }

    if (!isAdmin && !params?.table) {
        throw new SkapiError('"table" is required.', { code: 'INVALID_PARAMETER' });
    }

    if (params?.record_id) {
        return await request.bind(this)('del-records', {
            service: params.service,
            record_id: (v => {
                let id = validator.specialChars(v, 'record_id', false);
                if (typeof id === 'string') {
                    return [id];
                }

                return id;
            })(params.record_id)
        }, { auth: true });
    }

    else {
        if (!params?.table) {
            throw new SkapiError('Either "table" or "record_id" is required.', { code: 'INVALID_PARAMETER' });
        }

        let struct = {
            access_group: ['number', 'private'],
            table: {
                name: 'string',
                subscription: (v: string) => {
                    if (isAdmin) {
                        // admin targets user id
                        return validator.UserId((v as string), 'User ID in "table.subscription"');
                    }

                    throw new SkapiError('"table.subscription" is an invalid parameter key.', { code: 'INVALID_PARAMETER' });
                },
                subscription_group: (v: number) => {
                    if (isAdmin && typeof params?.table?.subscription !== 'string') {
                        throw new SkapiError('"table.subscription" is required.', { code: 'INVALID_PARAMETER' });
                    }

                    if (typeof v === 'number') {
                        if (v > 0 && v < 99) {
                            return v;
                        }
                    }

                    throw new SkapiError('Subscription group should be between 0 ~ 99.', { code: 'INVALID_PARAMETER' });
                }
            }
        };

        params = validator.Params(params || {}, struct, isAdmin ? ['service'] : ['table', 'access_group']);
    }

    return await request.bind(this)('del-records', params, { auth: true });
};
