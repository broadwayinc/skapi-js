import validator from '../utils/validator';
import { SkapiError } from '../Main';

// 256 to match the platform (validate_table_name -> validate_key_segment, max_len=256). This was
// 128, an SDK-only cap half the platform's, so a legal table name was refused before it left the
// client. Like a tag, the name is escaped on the wire and the server measures the escaped form, so
// validateStringByPolicy re-checks the length after escaping.
const MAX_TABLE_NAME_LENGTH = 256;
// The backend allows 256 (validate_tag_value -> validate_key_segment, max_len=256). This was 64,
// an SDK-only cap four times stricter than the platform, so a perfectly legal 100-character tag was
// refused before it ever left the client. The backend measures the ENCODED form, and so do we: the
// length is re-checked after / ! * # are escaped (each grows to 3 characters), which is the only way
// a raw length can be compared against a limit the server applies to the escaped string.
const MAX_TAG_LENGTH = 256;
// 256 to match the platform (validate_index_name -> validate_key_segment, max_len=256). Same
// SDK-only under-cap as the table name, and same escaped-length re-check.
const MAX_INDEX_NAME_LENGTH = 256;
// Already correct at 256 (validate_index_string_value, max_len=256). Note this one is NOT escaped:
// the platform allows / ! * # in an index VALUE, unlike a name or a tag.
const MAX_INDEX_STRING_VALUE_LENGTH = 256;
const SENTINEL_CHAR = '\u{10FFFF}';
const CONTROL_OR_SENTINEL_REGEX = /[\u0000-\u001F\u007F]|\u{10FFFF}/u;

const DELIMITER_ENCODING_MAP: Record<string, string> = {
    '/': '%2F',
    '!': '%21',
    '*': '%2A',
    '#': '%23',
};

const DELIMITER_DECODING_MAP: Record<string, string> = {
    '%2F': '/',
    '%21': '!',
    '%2A': '*',
    '%23': '#',
};

function encodeReservedDelimiters(value: string) {
    // Escape '%' first so literal sequences like "%2F" remain distinguishable
    // from a real '/' after normalization.
    const escapedPercent = value.replace(/%/g, '%25');
    return escapedPercent.replace(/[\/!*#]/g, (char) => DELIMITER_ENCODING_MAP[char] || char);
}

export function decodeReservedDelimiters(value: string) {
    if (typeof value !== 'string') {
        return value as any;
    }

    // Reverse delimiter encoding first, then unescape '%25' so '%252F'
    // round-trips back to literal '%2F' instead of '/'.
    const delimitersDecoded = value.replace(/%(2F|21|2A|23)/gi, (match) => {
        const key = match.toUpperCase();
        return DELIMITER_DECODING_MAP[key] || match;
    });

    return delimitersDecoded.replace(/%25/gi, '%');
}

export function validateStringByPolicy(
    value: any,
    fieldName: string,
    options: {
        onlyAlphanumeric?: boolean;
        allowEmpty?: boolean;
        maxLength?: number;
        blockKeyDelimiters?: boolean;
        disallowLeadingDollar?: boolean;
    } = {}
) {
    const {
        allowEmpty = false,
        maxLength,
        blockKeyDelimiters = false,
        disallowLeadingDollar = false,
        onlyAlphanumeric = false
    } = options;

    if (typeof value !== 'string') {
        throw new SkapiError(`"${fieldName}" should be type: <string>.`, { code: 'INVALID_PARAMETER' });
    }

    if (onlyAlphanumeric && /[^a-zA-Z0-9]/.test(value)) {
        throw new SkapiError(`"${fieldName}" should only contain alphanumeric characters.`, { code: 'INVALID_PARAMETER' });
    }

    if (!allowEmpty && value.length === 0) {
        throw new SkapiError(`"${fieldName}" is required.`, { code: 'INVALID_PARAMETER' });
    }

    if (maxLength && value.length > maxLength) {
        throw new SkapiError(`"${fieldName}" should be <= ${maxLength} characters.`, { code: 'INVALID_PARAMETER' });
    }

    if (CONTROL_OR_SENTINEL_REGEX.test(value) || value.includes(SENTINEL_CHAR)) {
        throw new SkapiError(`"${fieldName}" cannot include control characters or unsupported sentinel characters.`, { code: 'INVALID_PARAMETER' });
    }

    if (blockKeyDelimiters) {
        // Escape UNCONDITIONALLY. This used to run only when the value already contained a raw
        // delimiter, which made the round trip lossy: decodeReservedDelimiters has no such gate, so a
        // value carrying a percent-sequence but no raw delimiter went out untouched and came back
        // decoded. A tag written as "a%2Fb" read back as "a/b", and "100%25off" read back as
        // "100%off". A decoder cannot tell an escape it produced from one the caller typed, so the
        // only way to keep the two distinguishable is for the encoder to always run and always
        // escape '%' first. That is what the '%' -> '%25' pass in encodeReservedDelimiters is for;
        // under the old gate it was unreachable unless a delimiter happened to share the string.
        value = encodeReservedDelimiters(value);

        // Escaping expands the string (each of / ! * # becomes 3 characters, and a literal % becomes
        // %25), and the server measures what it receives. Re-check, so a value that only overflows
        // once escaped is refused here with a clear message instead of as an opaque server error.
        if (maxLength && value.length > maxLength) {
            throw new SkapiError(
                `"${fieldName}" should be <= ${maxLength} characters. "/", "!", "*", "#" and "%" count as 3 characters each.`,
                { code: 'INVALID_PARAMETER' }
            );
        }
    }

    if (disallowLeadingDollar && value.startsWith('$')) {
        throw new SkapiError(`"${fieldName}" cannot start with "$".`, { code: 'INVALID_PARAMETER' });
    }

    return value;
}

// "allowEmpty" exists for the QUERY side. A write must name a real table/tag/index, but a query uses
// these same fields as filters, where an empty string paired with a condition is the established
// "scan everything" idiom (skapi-mcp builds exactly that: table ' ' with condition '>').
type KeySegmentOptions = { allowEmpty?: boolean };

export function validateTableName(value: any, fieldName = 'table.name', options: KeySegmentOptions = {}) {
    return validateStringByPolicy(value, fieldName, {
        allowEmpty: options.allowEmpty === true,
        maxLength: MAX_TABLE_NAME_LENGTH,
        blockKeyDelimiters: true,
    });
}

export function validateTag(value: any, fieldName = 'tag', options: KeySegmentOptions = {}) {
    return validateStringByPolicy(value, fieldName, {
        allowEmpty: options.allowEmpty === true,
        maxLength: MAX_TAG_LENGTH,
        blockKeyDelimiters: true,
    });
}

export function validateCustomIndexName(value: any, fieldName = 'index.name', options: KeySegmentOptions = {}) {
    return validateStringByPolicy(value, fieldName, {
        allowEmpty: options.allowEmpty === true,
        maxLength: MAX_INDEX_NAME_LENGTH,
        blockKeyDelimiters: true,
        disallowLeadingDollar: true,
    });
}

export function validateIndexStringValue(value: any, fieldName = 'index.value') {
    return validateStringByPolicy(value, fieldName, {
        allowEmpty: true,
        maxLength: MAX_INDEX_STRING_VALUE_LENGTH,
    });
}

// A "nest" query is one whose index.name ends in '.', addressing the children of a compound index.
// There, index.value is NOT a value: the backend concatenates it onto the parent name to rebuild a
// child index NAME segment. Names are escaped on write, so this has to be escaped too. Left raw, a
// compound index like "Band.Rock/Pop.year" (stored as "Band.Rock%2FPop.year") could never be found
// by the nest query meant to find it, because '%' sorts below '/' so the key falls outside the
// range, and the reverse index used by the '<=' ends-with form mirrors the ESCAPED name.
export function isNestIndexName(name: any) {
    return typeof name === 'string' && name.slice(-1) === '.';
}

export function validateNestIndexSegment(value: any, fieldName: string) {
    return validateStringByPolicy(value, fieldName, {
        allowEmpty: true,
        maxLength: MAX_INDEX_STRING_VALUE_LENGTH,
        blockKeyDelimiters: true,
    });
}

export function recordIdOrUniqueId(query) {
    if (!query.record_id && !query.unique_id) {
        return null;
    }

    let outputObj: any = {};
    if (query?.service) {
        outputObj.service = query.service;
    }
    if (query?.owner) {
        outputObj.owner = query.owner;
    }
    if (query?.record_id) {
        outputObj.record_id = validateStringByPolicy(query.record_id, 'record_id', {
            allowEmpty: false,
            onlyAlphanumeric: true,
        });
    }
    else if (query?.unique_id) {
        outputObj.unique_id = query.unique_id;
    }

    return outputObj;
}

export function accessGroup(v) {
    if (v === undefined) {
        return 0;
    }

    if (typeof v === 'number') {
        if (v > 99 || v < 0) {
            throw new SkapiError('"table.access_group" value should be within a range of 0 ~ 99.', { code: 'INVALID_REQUEST' });
        }
    }

    else if (typeof v === 'string') {
        v = {
            private: 'private',
            public: 0,
            authorized: 1,
            admin: 99
        }[v]

        if (v === undefined) {
            throw new SkapiError('"table.access_group" is invalid.', { code: 'INVALID_PARAMETER' });
        }
    }

    else {
        throw new SkapiError('"table.access_group" should be type: <number | string>.', { code: 'INVALID_PARAMETER' });
    }

    if (!this.__user && v) {
        throw new SkapiError('Unsigned users have no access to records with access group.', { code: 'INVALID_REQUEST' });
    }

    return v;
}

const __index_number_range = 4503599627370496; // +/-
export function indexValue(v) {
    if (typeof v === 'number') {
        if (v > __index_number_range || v < -__index_number_range) {
            throw new SkapiError(`Number value should be within range -${__index_number_range} ~ +${__index_number_range}`, { code: 'INVALID_PARAMETER' });
        }
        return v;
    }

    if (typeof v === 'boolean') {
        return v;
    }

    if (typeof v === 'string') {
        return validateIndexStringValue(v, 'index.value');
    }

    throw new SkapiError(`"index.value" should be type: <number | boolean | string>.`, { code: 'INVALID_PARAMETER' });
}

export function indexRange(v, query) {
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
        // Same treatment as index.value: on a nest query the range bound is a child NAME segment.
        if (isNestIndexName(query.index.name)) {
            return validateNestIndexSegment(v, 'index.range');
        }
        return validateIndexStringValue(v, 'index.range');
    }

    return v;
}
