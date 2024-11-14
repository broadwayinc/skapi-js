
import SkapiError from '../main/error';
import { extractFormData } from './utils';

function UserId(id: string, param = 'User ID') {
    let uuid_regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const baseUrl = (() => {
        let baseUrl = window.location.origin || null;
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
                    let curr_loc = window.location.href.split('?')[0];
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
        // allowed => [\]^_`:;<=>?@
        if (/[!#$%&*()+\-{};'"|,<>\/~]/.test(s)) {
            throw new SkapiError(`${p} should not have special characters. Allowed special characters are: [ \] ^ _ \` : ; < = > ? @`, { code: 'INVALID_PARAMETER' });
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
    required: string[] = []
): any {
    // struct = {
    //     a: 'type or value',
    //     b: ['number', 'boolean', 'string', 'array', 'function', 'custom value', () => 'default value when none match, or is missing'],
    //     c: (v: any) => { return 'value to assign'; }
    // }

    let p = extractFormData(params).data;

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
    function isObjectWithKeys(obj) {
        return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length;
    }
    function isArrayWithValues(arr) {
        return Array.isArray(arr) && arr.length;
    }
    if (_parentKey === null && !isObjectWithKeys(struct)) {
        throw 'Argument "struct" is required.';
    }
    let invalid_in = _parentKey !== null ? ` in key "${_parentKey}" is invalid.` : '. Parameter should be type <object>.';

    if (isArrayWithValues(struct)) {
        let should_be = ''
        struct.forEach(s => {
            if (['string', 'number', 'boolean', 'object', 'array'].includes(s)) {
                should_be += `Type<${s}>, `
            }
            else if (typeof s !== 'function') {
                should_be += JSON.stringify(s, null, 2) + ', '
            }
        });

        should_be = should_be ? ' Should be: ' + should_be.slice(0, -2) : '';

        let pass = false;
        let val;
        let err_msg = ''
        for (let s of struct) {
            try {
                val = checkParams(params, s, required, _parentKey);
                pass = true;
                break;
            }
            catch (err: any) {
                if (typeof s === 'function') {
                    err_msg = err?.message || err;
                }
                else {
                    err_msg = '';
                }
                pass = false;
            }
        }
        if (!pass) {
            throw err_msg || `Invalid type "${typeof params}"${invalid_in}${should_be}.`
        }
        return val;
    }
    if (isObjectWithKeys(params)) {
        if (isObjectWithKeys(struct)) {
            for (let k in struct) {
                // scan defaults
                let key = (_parentKey === null ? '' : _parentKey) + (_parentKey !== null ? '[' + k + ']' : k);

                if (!params.hasOwnProperty(k)) {
                    if (required.includes(key)) {
                        throw `Key "${key}" is required.`;
                    }

                    if (isArrayWithValues(struct[k]) && typeof struct[k][struct[k].length - 1] === 'function') {
                        params[k] = struct[k][struct[k].length - 1]();
                    }
                }
            }
        }

        if ('object' === struct) {
            return params;
        }

        else if (typeof struct === 'function') {
            return struct(params);
        }

        for (let k in params) {
            let parentKey = (_parentKey === null ? '' : _parentKey) + (_parentKey !== null ? '[' + k + ']' : k);
            if (!isArrayWithValues(struct) && !struct.hasOwnProperty(k)) {
                // throw `Key name "${parentKey}" is invalid in parameter.`;
                continue;
            }
            if (isArrayWithValues(params[k])) {
                if (struct[k] === 'array') {
                    continue;
                }
                if (typeof struct[k] === 'function') {
                    params[k] = struct[k](params[k]);
                    continue;
                }
                for (let i = 0; i < params[k].length; i++) {
                    params[k][i] = checkParams(params[k][i], struct[k], required, parentKey + `[${i}]`);
                }
            }
            else {
                params[k] = checkParams(params[k], struct[k], required, parentKey);
            }
        }
        return params;
    }
    if (typeof struct === 'function') {
        return struct(params);
    }
    if (struct === 'array' && Array.isArray(params) || struct === typeof params || params === struct) {
        return params;
    }
    function isEmptyObject(obj) {
        return obj && typeof obj === 'object' && !Array.isArray(obj) && !Object.keys(obj).length;
    }
    if (params === null || params === undefined || isEmptyObject(params)) {
        return params;
    }
    throw `Invalid type "${typeof params}"${invalid_in} Should be: ${(['string', 'number', 'boolean', 'object', 'array'].includes(struct) ? `Type<${struct}>` : JSON.stringify(struct, null, 2))}`;
}

export default {
    UserId,
    PhoneNumber,
    Birthdate,
    Password,
    Email,
    Url,
    specialChars,
    Params
};