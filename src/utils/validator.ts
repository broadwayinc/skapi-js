
import SkapiError from '../main/error';
import { extractFormData } from './utils';
import cocochex from "cocochex";

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

/**
 * NAMED_NEWSLETTERS.md section 1, and the ONLY newsletter group check in the SDK.
 *
 * The four group taking methods each grew their own inline check, and two of them
 * (unsubscribeNewsletter, getNewsletterSubscription) rejected every string, so a
 * named group could be subscribed to and never removed or read back. The grammar
 * below is byte for byte the one register_newsletter_group, delete_newsletter_group,
 * subscribe_newsletter, get_newsletters and get_newsletter_subscription enforce:
 * lower case only because an e-mail local part is case insensitive while a DynamoDB
 * key is not, no "-" because the sending address is "-" delimited and filter_mail
 * splits on it, no "#" because "#" delimits every composite key in this system, and
 * at least one letter so a name can never collide with the "00".."99" vocabulary.
 *
 * Two exclusions the grammar alone would admit. The backend JSON parses GET parameters,
 * so an exponent literal ("1e5") reaches the handler as the number 100000 and the JSON
 * literals "true", "false" and "null" reach it as non strings; none of them can ever be
 * a group name.
 */
const NEWSLETTER_GROUP_NAME = /^[a-z0-9]{2,20}$/;
const NEWSLETTER_GROUP_NAME_LETTER = /[a-z]/;
const NEWSLETTER_GROUP_NAME_EXPONENT = /^[0-9]+e[0-9]+$/;
const RESERVED_NEWSLETTER_GROUP_NAMES = ['tp', 'admin', 'public', 'authorized', 'newsletter', 'forward', 'all', 'true', 'false', 'null'];

function newsletterGroup(
    group: any,
    options?: {
        /** Let null through as "every group". The unsubscribe and the subscription listing both mean that. */
        allowNull?: boolean;
        /** Refuse the numeric vocabulary. Registering or deleting a group is only ever about a NAME. */
        nameOnly?: boolean;
    }
): number | string | null {
    if (group === null || group === undefined) {
        if (options?.allowNull) {
            return null;
        }

        throw new SkapiError('"group" is required.', { code: 'INVALID_PARAMETER' });
    }

    if (!options?.nameOnly) {
        // The two aliases the numeric ladder has always answered to. They are on the
        // reserved list as NAMES, which is why they are resolved before the name check.
        if (group === 'public') {
            return 0;
        }

        if (group === 'authorized') {
            return 1;
        }

        if (typeof group === 'number') {
            if (!Number.isInteger(group) || group < 0 || group > 99) {
                throw new SkapiError('"group" should be an integer between 0 and 99.', { code: 'INVALID_PARAMETER' });
            }

            return group;
        }
    }

    if (
        typeof group !== 'string'
        || !NEWSLETTER_GROUP_NAME.test(group)
        || !NEWSLETTER_GROUP_NAME_LETTER.test(group)
        || NEWSLETTER_GROUP_NAME_EXPONENT.test(group)
        || RESERVED_NEWSLETTER_GROUP_NAMES.includes(group)
    ) {
        throw new SkapiError(
            'Newsletter group name must be 2-20 lowercase alphanumeric characters, contain a letter, and not be a reserved name.',
            { code: 'INVALID_PARAMETER' }
        );
    }

    return group;
}

function Params<T = any>(
    params: T,
    struct: Record<string, any>,
    required: string[] = [],
    options?: {
        ignoreEmpty?: boolean;
        nullIfEmpty?: boolean;
        precall?: (pre: { data: any, files: any }) => void
    }
): T {
    // struct = {
    //     a: 'type or value',
    //     b: ['number', 'boolean', 'string', 'array', 'function', 'custom value', () => 'default value when none match, or is missing'],
    //     c: (v: any) => { return 'value to assign'; }
    // }
    let ext = extractFormData(params, options);
    let p = ext.data;
    struct.service = 'string';
    struct.owner = 'string';

    let toCheck = {};

    // Extra user input fields not in schema are ignored.
    // If a field value is already a function, it copies it directly (JSON clone would break functions).
    // For each allowed field, it tries to deep-copy via JSON stringify/parse so later validation/mutation does not mutate the original input object.
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

    if (options?.precall) {
        options.precall({ data: toCheck, files: ext?.files || [] });
    }

    try {
        return cocochex(toCheck, struct, required) as T;
    }
    catch (err: any) {
        throw new SkapiError(err.message, { code: 'INVALID_PARAMETER' });
    }
}

export default {
    UserId,
    PhoneNumber,
    Birthdate,
    Password,
    Email,
    Url,
    newsletterGroup,
    Params
};