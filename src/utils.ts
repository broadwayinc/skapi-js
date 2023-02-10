import SkapiError from "./skapi_error";
import { RecordData, Form } from "./Types";

class MD5 {
    private static readonly alphabet = '0123456789abcdef';

    public static hash(str?: string): string {
        if (typeof str !== 'string') {
            console.warn('coercing non-string value to empty string');
            str = '';
        }

        const x = MD5.sb(str);
        let a = 1732584193;
        let b = -271733879;
        let c = -1732584194;
        let d = 271733878;
        let lastA;
        let lastB;
        let lastC;
        let lastD;
        for (let i = 0; i < x.length; i += 16) {
            lastA = a;
            lastB = b;
            lastC = c;
            lastD = d;

            a = MD5.ff(a, b, c, d, x[i], 7, -680876936);
            d = MD5.ff(d, a, b, c, x[i + 1], 12, -389564586);
            c = MD5.ff(c, d, a, b, x[i + 2], 17, 606105819);
            b = MD5.ff(b, c, d, a, x[i + 3], 22, -1044525330);
            a = MD5.ff(a, b, c, d, x[i + 4], 7, -176418897);
            d = MD5.ff(d, a, b, c, x[i + 5], 12, 1200080426);
            c = MD5.ff(c, d, a, b, x[i + 6], 17, -1473231341);
            b = MD5.ff(b, c, d, a, x[i + 7], 22, -45705983);
            a = MD5.ff(a, b, c, d, x[i + 8], 7, 1770035416);
            d = MD5.ff(d, a, b, c, x[i + 9], 12, -1958414417);
            c = MD5.ff(c, d, a, b, x[i + 10], 17, -42063);
            b = MD5.ff(b, c, d, a, x[i + 11], 22, -1990404162);
            a = MD5.ff(a, b, c, d, x[i + 12], 7, 1804603682);
            d = MD5.ff(d, a, b, c, x[i + 13], 12, -40341101);
            c = MD5.ff(c, d, a, b, x[i + 14], 17, -1502002290);
            b = MD5.ff(b, c, d, a, x[i + 15], 22, 1236535329);
            a = MD5.gg(a, b, c, d, x[i + 1], 5, -165796510);
            d = MD5.gg(d, a, b, c, x[i + 6], 9, -1069501632);
            c = MD5.gg(c, d, a, b, x[i + 11], 14, 643717713);
            b = MD5.gg(b, c, d, a, x[i], 20, -373897302);
            a = MD5.gg(a, b, c, d, x[i + 5], 5, -701558691);
            d = MD5.gg(d, a, b, c, x[i + 10], 9, 38016083);
            c = MD5.gg(c, d, a, b, x[i + 15], 14, -660478335);
            b = MD5.gg(b, c, d, a, x[i + 4], 20, -405537848);
            a = MD5.gg(a, b, c, d, x[i + 9], 5, 568446438);
            d = MD5.gg(d, a, b, c, x[i + 14], 9, -1019803690);
            c = MD5.gg(c, d, a, b, x[i + 3], 14, -187363961);
            b = MD5.gg(b, c, d, a, x[i + 8], 20, 1163531501);
            a = MD5.gg(a, b, c, d, x[i + 13], 5, -1444681467);
            d = MD5.gg(d, a, b, c, x[i + 2], 9, -51403784);
            c = MD5.gg(c, d, a, b, x[i + 7], 14, 1735328473);
            b = MD5.gg(b, c, d, a, x[i + 12], 20, -1926607734);
            a = MD5.hh(a, b, c, d, x[i + 5], 4, -378558);
            d = MD5.hh(d, a, b, c, x[i + 8], 11, -2022574463);
            c = MD5.hh(c, d, a, b, x[i + 11], 16, 1839030562);
            b = MD5.hh(b, c, d, a, x[i + 14], 23, -35309556);
            a = MD5.hh(a, b, c, d, x[i + 1], 4, -1530992060);
            d = MD5.hh(d, a, b, c, x[i + 4], 11, 1272893353);
            c = MD5.hh(c, d, a, b, x[i + 7], 16, -155497632);
            b = MD5.hh(b, c, d, a, x[i + 10], 23, -1094730640);
            a = MD5.hh(a, b, c, d, x[i + 13], 4, 681279174);
            d = MD5.hh(d, a, b, c, x[i], 11, -358537222);
            c = MD5.hh(c, d, a, b, x[i + 3], 16, -722521979);
            b = MD5.hh(b, c, d, a, x[i + 6], 23, 76029189);
            a = MD5.hh(a, b, c, d, x[i + 9], 4, -640364487);
            d = MD5.hh(d, a, b, c, x[i + 12], 11, -421815835);
            c = MD5.hh(c, d, a, b, x[i + 15], 16, 530742520);
            b = MD5.hh(b, c, d, a, x[i + 2], 23, -995338651);
            a = MD5.ii(a, b, c, d, x[i], 6, -198630844);
            d = MD5.ii(d, a, b, c, x[i + 7], 10, 1126891415);
            c = MD5.ii(c, d, a, b, x[i + 14], 15, -1416354905);
            b = MD5.ii(b, c, d, a, x[i + 5], 21, -57434055);
            a = MD5.ii(a, b, c, d, x[i + 12], 6, 1700485571);
            d = MD5.ii(d, a, b, c, x[i + 3], 10, -1894986606);
            c = MD5.ii(c, d, a, b, x[i + 10], 15, -1051523);
            b = MD5.ii(b, c, d, a, x[i + 1], 21, -2054922799);
            a = MD5.ii(a, b, c, d, x[i + 8], 6, 1873313359);
            d = MD5.ii(d, a, b, c, x[i + 15], 10, -30611744);
            c = MD5.ii(c, d, a, b, x[i + 6], 15, -1560198380);
            b = MD5.ii(b, c, d, a, x[i + 13], 21, 1309151649);
            a = MD5.ii(a, b, c, d, x[i + 4], 6, -145523070);
            d = MD5.ii(d, a, b, c, x[i + 11], 10, -1120210379);
            c = MD5.ii(c, d, a, b, x[i + 2], 15, 718787259);
            b = MD5.ii(b, c, d, a, x[i + 9], 21, -343485551);

            a = MD5.ad(a, lastA);
            b = MD5.ad(b, lastB);
            c = MD5.ad(c, lastC);
            d = MD5.ad(d, lastD);
        }

        return MD5.rh(a) + MD5.rh(b) + MD5.rh(c) + MD5.rh(d);
    }

    private static rh(n: number): string {
        let s = '';
        for (let j = 0; j <= 3; j++) {
            s += MD5.alphabet.charAt((n >> (j * 8 + 4)) & 0x0F) + MD5.alphabet.charAt((n >> (j * 8)) & 0x0F);
        }

        return s;
    }

    private static ad(x: number, y: number): number {
        const l = (x & 0xFFFF) + (y & 0xFFFF);
        const m = (x >> 16) + (y >> 16) + (l >> 16);

        return (m << 16) | (l & 0xFFFF);
    }

    private static rl(n: number, c: number): number {
        return (n << c) | (n >>> (32 - c));
    }

    private static cm(q: number, a: number, b: number, x: number, s: number, t: number): number {
        return MD5.ad(MD5.rl(MD5.ad(MD5.ad(a, q), MD5.ad(x, t)), s), b);
    }

    private static ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
        return MD5.cm(b & c | ~b & d, a, b, x, s, t);
    }

    private static gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
        return MD5.cm(b & d | c & ~d, a, b, x, s, t);
    }

    private static hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
        return MD5.cm(b ^ c ^ d, a, b, x, s, t);
    }

    private static ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
        return MD5.cm(c ^ (b | ~d), a, b, x, s, t);
    }

    private static sb(x: string): number[] {
        let i;
        const numBlocks = ((x.length + 8) >> 6) + 1;

        const blocks = new Array(numBlocks * 16);
        for (i = 0; i < numBlocks * 16; i++) {
            blocks[i] = 0;
        }

        for (i = 0; i < x.length; i++) {
            blocks[i >> 2] |= x.charCodeAt(i) << ((i % 4) * 8);
        }

        blocks[i >> 2] |= 0x80 << ((i % 4) * 8);
        blocks[numBlocks * 16 - 2] = x.length * 8;

        return blocks;
    }
}

// validation checks

function validateUserId(id: string, param = 'User ID') {
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

function validatePhoneNumber(value: string) {
    if (typeof value !== 'string' || value.charAt(0) !== '+' || isNaN(Number(value.substring(1)))) {
        throw new SkapiError('"phone_number" is invalid. The format should be "+00123456789". Type: string.', { code: 'INVALID_PARAMETER' });
    }
    return value;
}

function validateBirthdate(birthdate: string) {
    // yyyy-mm-dd
    if (typeof birthdate !== 'string') {
        throw new SkapiError('"birthdate" is invalid. The format should be "yyyy-mm-dd". Type: string.', { code: 'INVALID_PARAMETER' });
    }

    else {
        let date_regex = new RegExp(/([12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))/);
        if (birthdate.length !== 10 || birthdate.split('-').length !== 3 || !date_regex.test(birthdate)) {
            throw new SkapiError('"birthdate" is invalid. The format should be "yyyy-mm-dd". Type: string.', { code: 'INVALID_PARAMETER' });
        }
    }
    return birthdate;
}

function validatePassword(password: string) {
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

function validateEmail(email: string, paramName: string = 'email') {
    if (!email) {
        throw new SkapiError(`"${paramName}" is required.`, { code: 'INVALID_PARAMETER' });
    }

    else if (typeof email !== 'string') {
        throw new SkapiError(`"${paramName}"should be type: string.`, { code: 'INVALID_PARAMETER' });
    }

    else if (email.length < 5 || email.length > 64) {
        throw new SkapiError(`"${paramName}" should be at least 5 characters and max 64 characters.`, { code: 'INVALID_PARAMETER' });
    }

    else if (/^[a-zA-Z0-9.!#$%&'+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z]+[a-zA-Z0-9-]+)$/.test(email)) {
        email = email.trim();
        let splitAt = email.split('@');
        let tld = splitAt[1].split('.');

        if (tld.length >= 2) {
            return email.toLowerCase();
        }
    }

    throw new SkapiError(`"${email}" is an invalid email.`, { code: 'INVALID_PARAMETER' });
}

function validateUrl(url: string | string[]) {
    const baseUrl = (() => {
        let baseUrl = window.location.origin || null;
        if (baseUrl.slice(-1) === '/') {
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
                if (!cu.includes(' ') && !cu.includes(',')) {
                    if (cu.slice(0, 1) === '/' && baseUrl) {
                        cu = baseUrl + cu;
                    }
                    else if (cu.slice(0, 1) === '.' && baseUrl) {
                        cu = window.location.href.split('/').slice(0, -1).join('/') + cu;
                    }

                    let _url = null;

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

function normalize_record_data(record: Record<string, any>): RecordData {
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
            let value = normalize_typed_string('!' + rSplit.join('!'));
            output.index = {
                name,
                value
            };
        },
        'ref': (r: string) => {
            if (!r) return;
            if(!output.hasOwnProperty('reference')) {
                output.reference = {}
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
            if(!output.hasOwnProperty('reference')) {
                output.reference = {}
            }
            output.reference.allow_multiple_reference = r;
        },
        'ref_limt': (r: number) => {
            if(!output.hasOwnProperty('reference')) {
                output.reference = {}
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

function normalize_typed_string(v: string) {
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

function checkWhiteSpaceAndSpecialChars(
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

function checkParams(
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
            'service_owner',
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

    let _params = params; // processed params
    let val: any; // value to return
    let errToThrow: any = null; // error msg to output
    let isInvalid = _parentKey ? ` in "${_parentKey}" is invalid.` : '. Parameter should be type <object>.';

    if (_parentKey === null) {
        // parent level. executes on first run
        if (isObjectWithKeys(_params)) {
            if (_params instanceof HTMLFormElement || _params instanceof FormData || _params instanceof SubmitEvent) {
                // first execution, it's an object or form element
                _params = extractFormMetaData(params)?.meta;
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

            if (_params.hasOwnProperty(s) && typeof _params[s] != 'undefined') {
                // recurse to check data type
                _params[s] = checkParams(_params[s], structValue, null, null, s);
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
                    val = checkParams(_params, s, null, null, _parentKey);
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

function extractFormMetaData(form: Form) {
    // creates meta object to post

    function appendData(meta, key, val) {

        let fchar = key.slice(0, 1);
        let lchar = key.slice(-1);

        if (fchar === '.') {
            key = key.slice(1);
        }

        if (lchar === '.') {
            key = key.slice(0, -1);
        }

        if (key.includes('.')) {
            let nestKey = key.split('.');
            key = nestKey.pop();

            for (let k of nestKey) {
                if (!k) {
                    continue;
                }

                if (!meta.hasOwnProperty(k)) {
                    meta[k] = {};
                }

                meta = meta[k];
            }
        }

        if (meta.hasOwnProperty(key)) {
            if (Array.isArray(meta[key])) {
                meta[key].push(val);
            }
            else {
                meta[key] = [meta[key], val];
            }
        }
        else {
            meta[key] = val;
        }
    }

    if (form instanceof FormData) {
        let meta = {};
        let totalFileSize = 0;
        let files = [];

        for (let pair of form.entries()) {
            let name = pair[0];
            let v: any = pair[1];

            if (v instanceof File) {
                if (!files.includes(name)) {
                    files.push(name);
                }

                totalFileSize += Math.round((v.size / 1024));
            }

            else if (v instanceof FileList) {
                if (!files.includes(name)) {
                    files.push(name);
                }

                if (v && v.length > 0) {
                    for (let idx = 0; idx <= v.length - 1; idx++) {
                        totalFileSize += Math.round((v.item(idx).size / 1024));
                    }
                }
            }

            else {
                appendData(meta, name, v);
            }
        }

        if (totalFileSize > 5120) {
            throw new SkapiError('Files cannot exceed 5MB. Use skapi.uploadFiles(...) instead.', { code: 'INVALID_REQUEST' });
        }

        return { meta, files };
    }

    if (form instanceof SubmitEvent) {
        form = form.target;
    }

    if (form instanceof HTMLFormElement) {
        let meta = {};
        let files = [];
        let totalFileSize = 0;
        let inputs = form.querySelectorAll('input');
        let textarea = form.querySelectorAll('textarea');

        for (let i of textarea) {
            if (i.name) {
                appendData(meta, i.name, i.value);
            }
        }

        for (let i of inputs) {
            if (i.name) {
                if (i.type === 'number') {
                    if (i.value) {
                        appendData(meta, i.name, Number(i.value));
                    }
                }

                else if (i.type === 'checkbox' || i.type === 'radio') {
                    if (i.checked) {
                        if (i.value === 'on' || i.value === 'true') {
                            appendData(meta, i.name, true);
                        }

                        else if (i.value === 'false') {
                            appendData(meta, i.name, false);
                        }

                        else if (i.checked && i.value) {
                            appendData(meta, i.name, i.value);
                        }
                    }
                }

                else if (i.type === 'file') {
                    if (!files.includes(i.name)) {
                        files.push(i.name);
                    }

                    if (i.files && i.files.length > 0) {
                        for (let idx = 0; idx <= i.files.length - 1; idx++) {
                            totalFileSize += Math.round((i.files.item(idx).size / 1024));
                        }
                    }
                }

                else {
                    appendData(meta, i.name, i.value);
                }
            }
        }

        if (totalFileSize > 5120) {
            throw new SkapiError('Files cannot exceed 5MB. Use skapi.uploadFiles(...) instead.', { code: 'INVALID_REQUEST' });
        }

        return { meta, files };
    }

    return null;
}

export {
    checkWhiteSpaceAndSpecialChars,
    normalize_record_data,
    checkParams,
    extractFormMetaData,
    validateUserId,
    validateBirthdate,
    validateEmail,
    validatePassword,
    validatePhoneNumber,
    validateUrl,
    MD5
};