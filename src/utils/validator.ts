
import SkapiError from '../main/error';
import { extractFormData } from './utils';

function UserId(id: string, param = 'User ID') {
    // let uuid_regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    // let uuid_regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    let uuid_regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!id) {
        throw new SkapiError(`${param} is empty.`, { code: 'INVALID_PARAMETER' });
    }
    else if (typeof id !== 'string') {
        throw new SkapiError(`${param} should be type: string.`, { code: 'INVALID_PARAMETER' });
    }
    else if (!id.match(uuid_regex)) {
        throw new SkapiError(`${param} is invalid.`, { code: 'INVALID_PARAMETER' });
    }

    return id;
}

function PhoneNumber(value: string) {
    if (value) {
        if (typeof value !== 'string' || value.charAt(0) !== '+' || isNaN(Number(value.substring(1)))) {
            throw new SkapiError('"phone_number" is invalid. The format should be "+00123456789". Type: string.', { code: 'INVALID_PARAMETER' });
        }
    }
    return value || '';
}

function Birthdate(birthdate: string) {
    // yyyy-mm-dd
    if (birthdate) {
        if (typeof birthdate !== 'string') {
            throw new SkapiError('"birthdate" is invalid. The format should be "yyyy-mm-dd". Type: string.', { code: 'INVALID_PARAMETER' });
        }

        else {
            let date_regex = new RegExp(/([12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))/);
            if (birthdate.length !== 10 || birthdate.split('-').length !== 3 || !date_regex.test(birthdate)) {
                throw new SkapiError('"birthdate" is invalid. The format should be "yyyy-mm-dd". Type: string.', { code: 'INVALID_PARAMETER' });
            }
        }
    }
    return birthdate || '';
}

function Password(password: string) {
    if (!password) {
        throw new SkapiError('"password" is required.', { code: 'INVALID_PARAMETER' });
    }
    else if (typeof password !== 'string') {
        throw new SkapiError('"password" should be type: string.', { code: 'INVALID_PARAMETER' });
    }
    else if (password.length < 6) {
        throw new SkapiError('"password" should be at least 6 characters.', { code: 'INVALID_PARAMETER' });
    }
    else if (password.length > 60) {
        throw new SkapiError('"password" can be up to 60 characters max.', { code: 'INVALID_PARAMETER' });
    }

    return password;
}

function Email(email: string, paramName: string = 'email') {
    if (!email) {
        throw new SkapiError(`"${paramName}" is required.`, { code: 'INVALID_PARAMETER' });
    }

    else if (typeof email !== 'string') {
        throw new SkapiError(`"${paramName}"should be type: string.`, { code: 'INVALID_PARAMETER' });
    }

    else if (email.length < 5) {
        throw new SkapiError(`"${paramName}" should be at least 5 characters.`, { code: 'INVALID_PARAMETER' });
    }

    else if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(email)) {
        email = email.trim();
        let splitAt = email.split('@');
        let tld = splitAt[1].split('.');

        if (tld.length >= 2) {
            return email.toLowerCase();
        }
    }

    throw new SkapiError(`"${email}" is an invalid email.`, { code: 'INVALID_PARAMETER' });
}

function Url(url: string | string[]) {
    const hasWindow = typeof window !== 'undefined';
    const baseUrl = (() => {
        let baseUrl = hasWindow ? window.location.origin || null : null;
        if (baseUrl && baseUrl.slice(-1) === '/') {
            baseUrl = baseUrl.slice(0, -1);
        }

        return baseUrl;
    })();
    let check = (c: string) => {
        if (typeof c === 'string') {
            if (c === '*') {
                return '*';
            }
            else {
                let cu = c.trim();
                if (cu[0] === '/' && baseUrl) {
                    if (baseUrl.slice(0, 5) === 'file:') {
                        throw new SkapiError(`"${c}" is an invalid url. Relative URL does not work on local file system. Use full URL string.`, { code: 'INVALID_PARAMETER' });
                    }
                    cu = baseUrl + cu;
                }
                else if (cu[0] === '.' && baseUrl) {
                    if (baseUrl.slice(0, 5) === 'file:') {
                        throw new SkapiError(`"${c}" is an invalid url. Relative URL does not work on local file system. Use full URL string.`, { code: 'INVALID_PARAMETER' });
                    }
                    let curr_loc = hasWindow ? window.location.href.split('?')[0] : '';
                    if (curr_loc.slice(-1) !== '/') {
                        curr_loc += '/';
                    }

                    cu = curr_loc + cu.slice(1);
                }

                let _url;

                try {
                    _url = new URL(cu);
                }
                catch (err) {
                    throw new SkapiError(`"${c}" is an invalid url.`, { code: 'INVALID_PARAMETER' });
                }

                if (_url.protocol) {
                    let url = _url.href;
                    return url;
                }
            }
        }

        throw new SkapiError(`"${c}" is an invalid url.`, { code: 'INVALID_PARAMETER' });
    };

    if (Array.isArray(url)) {
        return url.map(u => check(u));
    }
    else {
        return check(url);
    }
}

function specialChars(
    string: string | string[],
    p = 'parameter',
    allowPeriods = false,
    allowWhiteSpace = false
) {
    let checkStr = (s: string) => {
        if (typeof s !== 'string') {
            throw new SkapiError(`${p} should be type: <string | string[]>.`, { code: 'INVALID_PARAMETER' });
        }

        if (!allowWhiteSpace && s.includes(' ')) {
            throw new SkapiError(`${p} should not have whitespace.`, { code: 'INVALID_PARAMETER' });
        }

        if (!allowPeriods && s.includes('.')) {
            throw new SkapiError(`${p} should not have periods.`, { code: 'INVALID_PARAMETER' });
        }
        // allowed => [\]^_`:;<=>?@()+,-
        if (/[!#$%&*{};'"|<>\/~]/.test(s)) {
            throw new SkapiError(`${p} should not have special characters. Allowed special characters are: [ \\ ] ^ _ \` : ; < = > ? @ ( ) + , -`, { code: 'INVALID_PARAMETER' });
        }
    };

    if (Array.isArray(string)) {
        for (let s of string) {
            checkStr(s);
        }
    }

    else {
        checkStr(string);
    }

    return string;
}

function Params(
    params: any,
    struct: Record<string, any>,
    required: string[] = [],
    options?: {
        ignoreEmpty?: boolean;
        nullIfEmpty?: boolean;
    }
): any {
    // struct = {
    //     a: 'type or value',
    //     b: ['number', 'boolean', 'string', 'array', 'function', 'custom value', () => 'default value when none match, or is missing'],
    //     c: (v: any) => { return 'value to assign'; }
    // }

    let p = extractFormData(params, options).data;
    struct.service = 'string';
    struct.owner = 'string';

    let toCheck = {};

    for (let s in struct) {
        if (p && typeof p === 'object' && !Array.isArray(p) && p.hasOwnProperty(s)) {
            if (typeof p[s] === 'function') {
                toCheck[s] = p[s];
            }
            else {
                try {
                    toCheck[s] = JSON.parse(JSON.stringify(p[s]));
                }
                catch (err) {
                    toCheck[s] = p[s];
                }
            }
        }
    }

    try {
        return checkParams(toCheck, struct, required);
    }
    catch (err) {
        throw new SkapiError(err, { code: 'INVALID_PARAMETER' });
    }
}

function checkParams(params: any, struct: any, required: string[] = [], _parentKey = null) {
    const typeTokens = ['string', 'number', 'boolean', 'object', 'array'];

    function isPlainObject(value: any) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function isSchemaObject(value: any) {
        return isPlainObject(value);
    }

    function isSchemaList(value: any) {
        return Array.isArray(value);
    }

    function isTypeToken(value: any) {
        return typeof value === 'string' && typeTokens.includes(value);
    }

    function getValueType(value: any) {
        if (Array.isArray(value)) {
            return 'array';
        }

        if (value === null) {
            return 'null';
        }

        return typeof value;
    }

    function stringifyValue(value: any) {
        try {
            return JSON.stringify(value);
        }
        catch (err) {
            return String(value);
        }
    }

    function describeSchema(schema: any): string {
        if (isTypeToken(schema)) {
            return `Type<${schema}>`;
        }

        if (typeof schema === 'function') {
            return 'custom validator';
        }

        try {
            return JSON.stringify(schema, (_key, value) => {
                if (typeof value === 'function') {
                    return 'custom validator';
                }
                return value;
            });
        }
        catch (err) {
            return String(schema);
        }
    }

    function matchesType(value: any, schema: string) {
        if (schema === 'array') {
            return Array.isArray(value);
        }

        if (schema === 'object') {
            return isPlainObject(value);
        }

        return typeof value === schema;
    }

    function getKeyPath(key: string) {
        return _parentKey === null ? key : `${_parentKey}[${key}]`;
    }

    if (typeof struct === 'undefined') {
        throw 'Argument "struct" is required.';
    }

    if (typeof struct === 'function') {
        return struct(params);
    }

    if (isSchemaObject(struct)) {
        if (!isPlainObject(params)) {
            throw 'Data schema does not match.';
        }

        for (let key of Object.keys(struct)) {
            const keyPath = getKeyPath(key);

            if (Object.prototype.hasOwnProperty.call(params, key)) {
                params[key] = checkParams(params[key], struct[key], required, keyPath);
            }
            else {
                if (required.includes(keyPath)) {
                    throw `Key "${keyPath}" is required.`;
                }

                const schema = struct[key];
                if (isSchemaList(schema) && schema.length && typeof schema[schema.length - 1] === 'function') {
                    params[key] = schema[schema.length - 1]();
                }
            }
        }

        return params;
    }

    if (isSchemaList(struct)) {
        let passed = false;

        if (struct.length === 1 && !isSchemaList(struct[0]) && !isSchemaObject(struct[0])) {
            const itemSchema = struct[0];

            if (!Array.isArray(params)) {
                throw `Type <${getValueType(params)}> is invalid in "${_parentKey}". Expected a list.`;
            }

            for (let index = 0; index < params.length; index++) {
                const item = params[index];

                if (isTypeToken(itemSchema)) {
                    if (!matchesType(item, itemSchema)) {
                        throw `Type <${getValueType(item)}> is invalid in "${_parentKey}". Expected a list of Type <${itemSchema}>.`;
                    }
                }
                else if (typeof itemSchema === 'function') {
                    params[index] = itemSchema(item);
                }
                else if (item !== itemSchema) {
                    throw `Value ${stringifyValue(item)} is invalid in "${_parentKey}". Expected a list of ${stringifyValue(itemSchema)}.`;
                }
            }

            passed = true;
        }
        else {
            let lastFunctionError = '';

            for (let schema of struct) {
                try {
                    params = checkParams(params, schema, required, _parentKey);
                    passed = true;
                    break;
                }
                catch (err: any) {
                    if (typeof schema === 'function') {
                        lastFunctionError = err?.message || String(err);
                    }
                }
            }

            if (!passed && lastFunctionError) {
                throw lastFunctionError;
            }
        }

        if (!passed) {
            const allowed = struct.map(describeSchema).join(', ');
            throw `${stringifyValue(params)} is invalid in "${_parentKey}". allowed types or values are: ${allowed}.`;
        }

        return params;
    }

    if ((isTypeToken(struct) && matchesType(params, struct)) || params === struct) {
        return params;
    }

    throw `${stringifyValue(params)} is invalid in "${_parentKey}". allowed type or value is: ${describeSchema(struct)}.`;
}

export default {
    UserId,
    PhoneNumber,
    Birthdate,
    Password,
    Email,
    Url,
    specialChars,
    Params,
    checkParams
};