
import SkapiError from '../main/error';
import { extractFormMeta } from './utils';

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
                    cu = baseUrl + cu;
                }
                else if (cu[0] === '.' && baseUrl) {
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
                    if (url.charAt(url.length - 1) === '/')
                        url = url.substring(0, url.length - 1);

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

        if (!allowWhiteSpace && string.includes(' ')) {
            throw new SkapiError(`${p} should not have whitespace.`, { code: 'INVALID_PARAMETER' });
        }

        if (!allowPeriods && string.includes('.')) {
            throw new SkapiError(`${p} should not have periods.`, { code: 'INVALID_PARAMETER' });
        }

        if (/[`!@#$%^&*()_+\-=\[\]{};':"\\|,<>\/?~]/.test(s)) {
            throw new SkapiError(`${p} should not have special characters.`, { code: 'INVALID_PARAMETER' });
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
    required: string[] | null = null,
    bypassCheck: string[] | null = [],
    _parentKey: string | null = null
): any {
    // struct = {
    //     a: 'boolean',
    //     b: ['number', 'boolean', 'string', 'array', 'function', 'custom value', () => 'default value'],
    //     c: (v: any) => { return 'value to assign'; }
    // }

    if (Array.isArray(bypassCheck)) {
        bypassCheck = bypassCheck.concat([
            // list of default key names to bypass
            'service',
            'owner',
            // 'alertError',
            // 'response',
            // 'startKey'
        ]);
    }

    function isObjectWithKeys(obj: any) {
        if (obj instanceof Promise) {
            throw new SkapiError('Parameter should not be a promise', { code: 'INVALID_PARAMETER' });
        }
        return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length;
    }

    function isEmptyObject(obj: any) {
        return obj && typeof obj === 'object' && !Array.isArray(obj) && !Object.keys(obj).length;
    }

    let _params = params; // params to process
    let val: any; // value to return
    let errToThrow: any = null; // error msg to output
    let isInvalid = _parentKey ? ` in "${_parentKey}" is invalid.` : '. Parameter should be type <object>.';

    if (_parentKey === null) {
        // parent level. executes on first run
        if (isObjectWithKeys(_params)) {
            if (_params instanceof HTMLFormElement || _params instanceof FormData || _params instanceof SubmitEvent) {
                // first execution, it's an object or form element
                _params = extractFormMeta(params)?.meta;
            }

            else {
                _params = JSON.parse(JSON.stringify(params));
            }

            for (let k in _params) {
                // check if there is invalid key names
                if (!struct.hasOwnProperty(k) && Array.isArray(bypassCheck) && !bypassCheck.includes(k)) {
                    throw new SkapiError(`Key name "${k}" is invalid in parameter.`, { code: 'INVALID_PARAMETER' });
                }
            }

            if (Array.isArray(required) && required.length) {
                // check if any required key names are missing
                for (let k of required) {
                    if (!Object.keys(_params).includes(k)) {
                        throw new SkapiError(`Key "${k}" is required in parameter.`, { code: 'INVALID_PARAMETER' });
                    }
                }
            }
        }

        else if (isEmptyObject(_params) || typeof _params === 'undefined') {
            // parameter is empty or undefined
            let defaults: Record<string, any> = {};

            // sets default for all keys
            // key: [()=>'default']
            for (let s in struct) {
                // iterate whole structure object
                let structValue = struct[s];
                if (Array.isArray(structValue) && typeof structValue[structValue.length - 1] === 'function')
                    // set all default values
                    defaults[s] = structValue[structValue.length - 1]();
            }

            // return if there is any default value
            return Object.keys(defaults).length ? defaults : _params;
        }

        if (_params === null) {
            // if null ignore defaults
            return null;
        }
    }

    if (isObjectWithKeys(struct) && isObjectWithKeys(_params)) {
        for (let s in struct) {
            // loop through structure keys
            let structValue = struct[s];
            if (_params.hasOwnProperty(s) && _params[s] === null) {
                // null is accepted in object structure
                _params[s] = null;
            }

            else if (_params.hasOwnProperty(s) && typeof _params[s] !== 'undefined') {
                // recurse to check data type
                _params[s] = Params(_params[s], structValue, null, null, s);
            }

            else {
                // if current _params does not have the corresponding key name
                let defaultSetter =
                    Array.isArray(structValue) &&
                        typeof structValue[structValue.length - 1] === 'function' ? structValue[structValue.length - 1] : null;

                if (defaultSetter) {
                    // set default
                    let def = defaultSetter();
                    if (def !== undefined) {
                        _params[s] = def;
                    }
                }
            }
        }

        val = _params;
    }

    // recursive level
    else if (Array.isArray(struct)) {
        // loop through value types
        for (let s of struct) {
            try {
                if (typeof _params !== undefined && typeof s !== 'function') {
                    // dive in, check value types
                    val = Params(_params, s, null, null, _parentKey);
                }
                // if error, loop to next, otherwise break
                break;
            } catch (err) {
                if (typeof err === 'string' && err.substring(0, 6) === 'BREAK:') {
                    // break on BREAK message
                    err = err.substring(6);
                    let errMsg = (err as string).split(':');
                    errToThrow = new SkapiError(errMsg[1], { code: errMsg[0] });
                    break;
                }
                else {
                    errToThrow = err;
                }
            }
        }
    }

    // returned values will be applied to params
    else if (typeof struct === 'function') {
        return struct(_params);
    }

    else if (typeof struct === 'string') {
        // setup value type range
        if (Array.isArray(_params)) {
            // check for array
            if (struct !== 'array') {
                throw new SkapiError(`Invalid type "${typeof _params}"${isInvalid}`, { code: 'INVALID_PARAMETER' });
            }

            // array only accepts number, string, boolean, null.
            // object is not allowed to be nested in array.
            for (let p of _params) {
                if (!['number', 'string', 'boolean'].includes(typeof p) && p !== null) {
                    throw new SkapiError(`Invalid type "${typeof p}" in "${_parentKey}" array value.`, { code: 'INVALID_PARAMETER' });
                }
            }

            val = _params;
        }
        else if (!['number', 'string', 'boolean', 'array', 'function'].includes(struct)) {
            // match custom string values
            if (_params === struct) {
                val = _params;
            }

            else {
                throw new SkapiError(`Value: ${_params}${isInvalid}`, { code: 'INVALID_PARAMETER' });
            }
        }
        else if (typeof _params === struct) {
            if (struct === 'number') {
                // throws error if number range is invalid
                if (Math.abs(_params) > 4503599627370496) {
                    throw `BREAK:INVALID_PARAMETER:"${_parentKey}" integer value should be within -4503599627370496 ~ +4503599627370546.`;
                }
            }

            val = _params;
        }
        else {
            throw new SkapiError(`Value: ${_params}${isInvalid}`, { code: 'INVALID_PARAMETER' });
        }
    }

    else if (struct === null) {
        // bypass value on null
        val = _params;
    }

    if (val === undefined && errToThrow) {
        throw errToThrow;
    }

    return val;
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