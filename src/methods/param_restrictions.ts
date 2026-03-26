import validator from '../utils/validator';
import { SkapiError } from '../Main';

const MAX_TABLE_NAME_LENGTH = 128;
const MAX_TAG_LENGTH = 64;
const MAX_INDEX_NAME_LENGTH = 128;
const MAX_INDEX_STRING_VALUE_LENGTH = 256;
const SENTINEL_CHAR = '\u{10FFFF}';
const CONTROL_OR_SENTINEL_REGEX = /[\u0000-\u001F\u007F]|\u{10FFFF}/u;
const BLOCKED_KEY_SEGMENT_DELIMITER_REGEX = /[\/!*#]/;

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

    if (blockKeyDelimiters && BLOCKED_KEY_SEGMENT_DELIMITER_REGEX.test(value)) {
        throw new SkapiError(`"${fieldName}" cannot include reserved delimiters: / ! * #`, { code: 'INVALID_PARAMETER' });
    }

    if (disallowLeadingDollar && value.startsWith('$')) {
        throw new SkapiError(`"${fieldName}" cannot start with "$".`, { code: 'INVALID_PARAMETER' });
    }

    return value;
}

export function validateTableName(value: any, fieldName = 'table.name') {
    return validateStringByPolicy(value, fieldName, {
        allowEmpty: false,
        maxLength: MAX_TABLE_NAME_LENGTH,
        blockKeyDelimiters: true,
    });
}

export function validateTag(value: any, fieldName = 'tag') {
    return validateStringByPolicy(value, fieldName, {
        allowEmpty: false,
        maxLength: MAX_TAG_LENGTH,
        blockKeyDelimiters: true,
    });
}

export function validateCustomIndexName(value: any, fieldName = 'index.name') {
    return validateStringByPolicy(value, fieldName, {
        allowEmpty: false,
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
        return validateIndexStringValue(v, 'index.range');
    }

    return v;
}
