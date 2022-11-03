import SkapiError from "./skapi_error";
import { RecordData, Form } from "./Types";

const sha256: any = function (ascii) {
    // author: https://geraintluff.github.io/sha256/

    function rightRotate(value, amount) {
        return (value >>> amount) | (value << (32 - amount));
    };

    var mathPow = Math.pow;
    var maxWord = mathPow(2, 32);
    var lengthProperty = 'length';
    var i, j; // Used as a counter across the whole file
    var result = '';

    var words = [];
    var asciiBitLength = ascii[lengthProperty] * 8;

    //* caching results is optional - remove/add slash from front of this line to toggle
    // Initial hash value: first 32 bits of the fractional parts of the square roots of the first 8 primes
    // (we actually calculate the first 64, but extra values are just ignored)
    var hash = sha256.h = sha256.h || [];
    // Round constants: first 32 bits of the fractional parts of the cube roots of the first 64 primes
    var k = sha256.k = sha256.k || [];
    var primeCounter = k[lengthProperty];
    /*/
    var hash = [], k = [];
    var primeCounter = 0;
    //*/

    var isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
        if (!isComposite[candidate]) {
            for (i = 0; i < 313; i += candidate) {
                isComposite[i] = candidate;
            }
            hash[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
            k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
        }
    }

    ascii += '\x80'; // Append Ƈ' bit (plus zero padding)
    while (ascii[lengthProperty] % 64 - 56) ascii += '\x00'; // More zero padding
    for (i = 0; i < ascii[lengthProperty]; i++) {
        j = ascii.charCodeAt(i);
        if (j >> 8) return; // ASCII check: only accept characters in range 0-255
        words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
    words[words[lengthProperty]] = (asciiBitLength);

    // process each chunk
    for (j = 0; j < words[lengthProperty];) {
        var w = words.slice(j, j += 16); // The message is expanded into 64 words as part of the iteration
        var oldHash = hash;
        // This is now the undefinedworking hash", often labelled as variables a...g
        // (we have to truncate as well, otherwise extra entries at the end accumulate
        hash = hash.slice(0, 8);

        for (i = 0; i < 64; i++) {
            var i2 = i + j;
            // Expand the message into 64 words
            // Used below if 
            var w15 = w[i - 15], w2 = w[i - 2];

            // Iterate
            var a = hash[0], e = hash[4];
            var temp1 = hash[7]
                + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) // S1
                + ((e & hash[5]) ^ ((~e) & hash[6])) // ch
                + k[i]
                // Expand the message schedule if needed
                + (w[i] = (i < 16) ? w[i] : (
                    w[i - 16]
                    + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) // s0
                    + w[i - 7]
                    + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10)) // s1
                ) | 0
                );
            // This is only used once, so *could* be moved below, but it only saves 4 bytes and makes things unreadble
            var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) // S0
                + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2])); // maj

            hash = [(temp1 + temp2) | 0].concat(hash); // We don't bother trimming off the extra ones, they're harmless as long as we're truncating when we do the slice()
            hash[4] = (hash[4] + temp1) | 0;
        }

        for (i = 0; i < 8; i++) {
            hash[i] = (hash[i] + oldHash[i]) | 0;
        }
    }

    for (i = 0; i < 8; i++) {
        for (j = 3; j + 1; j--) {
            var b = (hash[i] >> (j * 8)) & 255;
            result += ((b < 16) ? 0 : '') + b.toString(16);
        }
    }
    return result;
};

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
            if (_params instanceof HTMLFormElement || _params instanceof FormData) {
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
                    err = err.substring(5);
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
    }

    else if (struct === null) {
        // bypass value on null
        val = _params;
    }

    if (val === undefined) {
        throw errToThrow || new SkapiError(`Type "undefined"${isInvalid}`, { code: 'INVALID_PARAMETER' });
    }

    return val;
}

function extractFormMetaData(form: Form) {
    // creates meta object to post

    function appendData(meta, key, val, append = true) {
        if (meta[key] && append) {
            if (Array.isArray(meta)) {
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

    else if (form instanceof HTMLFormElement) {
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
                if (i.type === 'number' && i.value) {
                    appendData(meta, i.name, Number(i.value));
                }

                else if (i.type === 'checkbox' || i.type === 'radio') {
                    if (i.value === 'on' || i.value === 'true') {
                        appendData(meta, i.name, i.checked, false);
                    }

                    else if (i.value === 'false') {
                        appendData(meta, i.name, !i.checked, false);
                    }

                    else if (i.checked) {
                        appendData(meta, i.name, i.value, false);
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
        throw new SkapiError('"password" is empty.', { code: 'PASSWORD_REQUIRED' });
    }
    else if (typeof password !== 'string') {
        throw new SkapiError('"password" should be type: string.', { code: 'INVALID_PASSWORD' });
    }
    else if (password.length < 6) {
        throw new SkapiError('"password" should be at least 6 characters.', { code: 'INVALID_PASSWORD' });
    }
    else if (password.length > 60) {
        throw new SkapiError('"password" can be up to 60 characters max.', { code: 'INVALID_PASSWORD' });
    }

    return password;
}

function validateEmail(email: string, paramName: string = 'email') {
    if (!email) {
        throw new SkapiError(`"${paramName}" is empty.`, { code: 'EMAIL_REQUIRED' });
    }

    else if (typeof email !== 'string') {
        throw new SkapiError(`"${paramName}"should be type: string.`, { code: 'INVALID_EMAIL' });
    }

    else if (email.length < 5 || email.length > 64) {
        throw new SkapiError(`"${paramName}" should be at least 5 characters and max 64 characters.`, { code: 'INVALID_EMAIL' });
    }

    else if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(email)) {
        email = email.trim();
        let splitAt = email.split('@');
        let tld = splitAt[1].split('.');

        if (tld.length >= 2) {
            return email.toLowerCase();
        }
    }

    throw new SkapiError(`"${email}" is an invalid email.`, { code: 'INVALID_EMAIL' });
}

function validateUrl(url: string | string[]) {
    const baseUrl = (() => {
        let baseUrl = window?.location?.origin || null;

        if (baseUrl === 'file://') {
            baseUrl += window.location.pathname;
            let _baseUrl = baseUrl.split('/');
            _baseUrl.pop();
            baseUrl = _baseUrl.join('/');
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
                    if (cu.substring(0, 1) === '/' && baseUrl) {
                        cu = baseUrl + cu;
                    }
                    let _url = null;

                    try {
                        _url = new URL(cu);
                    } catch (err) {
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

function normalize_record_data<T extends RecordData>(record: T): RecordData {
    const output: Record<any, any> = {};

    const keys = {
        'rec': (r) => {
            if (!r) return;
            output.record_id = r;
            let base36timestamp = r.substring(0, 8);
            output.uploaded = parseInt(base36timestamp, 36);
        },
        'usr': (r) => {
            if (!r) return;
            output.user_id = r;
        },
        'tbl': (r) => {
            if (!r) return;
            let rSplit = r.split('/');
            output.table = rSplit[0];
            output.access_group = rSplit[2] == '@@' ? 'private' : parseInt(rSplit[2]);
            if (rSplit?.[3]) {
                output.subscription = {
                    user_id: rSplit[3],
                    group: parseInt(rSplit[4])
                };
            }
        },
        'idx': (r) => {
            if (!r) return;
            let rSplit = r.split('!');
            let name = rSplit.splice(0, 1)[0];
            let value = normalize_typed_string(rSplit.join('!'));
            output.index = {
                name,
                value
            };
        },
        'ref': (r) => {
            if (!r) return;
            output.reference = r.split('/')[0];
        },
        'tags': (r) => {
            if (!r) return;
            output.tags = r;
        },
        'upd': (r) => {
            if (!r) return;
            output.updated = r;
        },
        'acpt_mrf': (r) => {
            if (!r) return;
            if (!output?.config)
                output.config = {};

            output.config.allow_multiple_reference = r;
        },
        'ref_limt': (r) => {
            if (!r) return;
            if (!output?.config)
                output.config = {};

            output.config.reference_limit = r;
        },
        'rfd': (r) => {
            output.referenced_count = r;
        },
        'prv_acs': (r) => {
            if (!r) return;
            if (!output?.config)
                output.config = {};

            output.config.private_access = r;
        },
        'data': (r) => {
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
        return record;
    }

    for (let k in keys) {
        keys[k](record[k]);
    }

    return output as RecordData;
}

function normalize_typed_string(v: string) {
    let value = v.substring(2);
    let type = v.substring(0, 2);

    switch (type) {
        case "S%":
            // S%string
            return value;
        case "N%":
            // N%0
            return Number(value) - 4503599627370496;
        case "B%":
            // B%1
            return value === '1';
        case "L%":
            // L%[0, "hello"]
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
    let checkStr = (s: string, array = false) => {
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
            checkStr(s, true);
        }
    }

    else {
        checkStr(string, false);
    }

    return string;
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
    sha256
};