import validator from '../utils/validator';
import { SkapiError } from '../Main';

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
        outputObj.record_id = validator.specialChars(query.record_id, 'record_id', false, false);
    }
    else if (query?.unique_id) {
        outputObj.unique_id = query.unique_id;
    }

    return outputObj;
}

export function cannotBeEmptyString(v, paramName = 'parameter', allowPeriods = false, allowWhiteSpace = false) {
    if (!v) {
        throw new SkapiError(`"${paramName}" is required.`, { code: 'INVALID_PARAMETER' });
    }
    return validator.specialChars(v, paramName, allowPeriods, allowWhiteSpace);
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
        return cannotBeEmptyString(v, 'index.value', false, true)
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
        return validator.specialChars(v, 'index.range', false, true);
    }

    return v;
}

export function getStruct(query) {
    return {
        table: {
            name: [v => cannotBeEmptyString(v, 'table.name', true, true)],
            access_group: [accessGroup.bind(this)],
            subscription: (v: any) => {
                if (typeof v === 'string') {
                    validator.UserId(v, 'User ID in "subscription"');
                    return v
                }

                return undefined;
            }
        },
        reference: 'string',
        index: {
            name: ['$updated', '$uploaded', '$referenced_count', '$user_id', (v: string) => {
                return cannotBeEmptyString(v, 'index.name', true, false)
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

                if (typeof v === 'string' && !v) {
                    return " ";
                }

                return indexValue(v);
            },
            condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq'],
            range: (v: number | boolean | string) => indexRange(v, query)
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
    }
}