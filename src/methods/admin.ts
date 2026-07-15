import validator from '../utils/validator';
import { request } from '../utils/network';
import { checkAdmin } from './user';
import { Form, UserAttributes, UserProfile, UserPublic, DatabaseResponse, FetchOptions } from '../Types';
import SkapiError from '../main/error';
import { parseUserAttributes, MD5 } from '../utils/utils';

export async function blockAccount(form: Form<{
    user_id: string;
    owner?: string;
    service?: string;
}>): Promise<'SUCCESS: The user has been blocked.'> {
    let params = validator.Params(form, {
        user_id: (v: string) => {
            return validator.UserId(v, '"user_id"');
        },
    }, ['user_id']);

    if (params?.service && params?.owner) {
        params = { service: params?.service, owner: params?.owner, block: params.user_id };
    }
    else {
        params = { block: params.user_id };
    }

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group < 90) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    return await request.bind(this)('block-account', params, { auth: true });
}

export async function unblockAccount(form: Form<{
    user_id: string;
    owner?: string;
    service?: string;
}>): Promise<'SUCCESS: The user has been unblocked.'> {
    let params = validator.Params(form, {
        user_id: (v: string) => {
            return validator.UserId(v, '"user_id"');
        },
    }, ['user_id']);

    if (params?.service && params?.owner) {
        params = { service: params?.service, owner: params?.owner, unblock: params.user_id };
    } else {
        params = { unblock: params.user_id };
    }

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group < 90) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    return await request.bind(this)('block-account', params, { auth: true });
}

export async function deleteAccount(form: Form<{
    user_id: string;
    owner?: string;
    service?: string;
}>): Promise<'SUCCESS: Account has been deleted.'> {
    let params = validator.Params(form, {
        user_id: (v: string) => {
            return validator.UserId(v, '"user_id"');
        },
    }, ['user_id']);

    if (params?.service && params?.owner) {
        params = { service: params?.service, owner: params?.owner, delete: params.user_id };
    } else {
        params = { delete: params.user_id };
    }

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group < 90) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    return await request.bind(this)('remove-account', params, { auth: true });
}

export async function inviteUser(
    form: Form<UserAttributes & { openid_id: string; access_group: number; } & { service?: string; owner?: string; }>,
    options?: {
        confirmation_url?: string;
        email_subscription?: boolean;
        template?: {
            url: string;
            subject: string;
        }
    }
): Promise<'SUCCESS: Invitation has been sent. (User ID: xxx...)'> {
    let paramRestrictions = {
        email: (v: string) => validator.Email(v),
        password: (v: string) => validator.Password(v),

        name: 'string',
        username: 'string',
        gender: 'string',
        address: (v: any) => {
            if (!v) return '';

            if (typeof v === 'string') {
                return v;
            }

            if (typeof v === 'object') {
                return JSON.stringify(v);
            }

            return undefined;
        },
        birthdate: (v: string) => validator.Birthdate(v),
        phone_number: (v: string) => validator.PhoneNumber(v),
        picture: (v: string) => { if (v) return validator.Url(v); else return undefined },
        profile: (v: string) => { if (v) return validator.Url(v); else return undefined },
        website: (v: string) => { if (v) return validator.Url(v); else return undefined },
        nickname: 'string',
        misc: 'string',

        email_public: ['boolean', () => false],
        gender_public: ['boolean', () => false],
        address_public: ['boolean', () => false],
        birthdate_public: ['boolean', () => false],
        phone_number_public: ['boolean', () => false],
        openid_id: 'string',
        access_group: (v: number) => {
            // if string try to convert to number and if it's not a number, throw error
            try {
                if (typeof v === 'string') {
                    v = v === 'admin' ? 99 : parseInt(v);
                }
            }
            catch (e) {
                throw new SkapiError('"access_group" is invalid. Should be type <number>.', { code: 'INVALID_PARAMETER' });
            }
            if (typeof v !== 'number' || v < 1 || v > 100) {
                throw new SkapiError('"access_group" is invalid. Should be type <number> of range 1~99', { code: 'INVALID_PARAMETER' });
            }
            return v;
        }
    };

    let params = validator.Params(form, paramRestrictions, ['email']);

    options = validator.Params(options, {
        confirmation_url: (v: string) => {
            let value = v;

            if (typeof v === 'string') {
                value = validator.Url(v);
            }
            else {
                throw new SkapiError('"options.confirmation_url" should be type: <string>.', { code: 'INVALID_PARAMETER' });
            }

            if (value && !params.email) {
                throw new SkapiError('"email" is required for signup confirmation.', { code: 'INVALID_PARAMETER' });
            }

            return value;
        },
        email_subscription: (v: boolean) => {
            if (typeof v !== 'boolean') {
                throw new SkapiError('"options.email_subscription" should be type: <boolean>.', { code: 'INVALID_PARAMETER' });
            }
            if (!options?.confirmation_url) {
                // requires to be url or true
                throw new SkapiError('"options.confirmation_url" is required for email subscription.', { code: 'INVALID_PARAMETER' });
            }
            return v;
        },
        template: (v: { url: string; subject: string; }) => {
            if (typeof v !== 'object' || !v.url || !v.subject) {
                throw new SkapiError('"options.template" should be type: <object> with "url" and "subject".', { code: 'INVALID_PARAMETER' });
            }
            return {
                url: validator.Url(v.url),
                subject: v.subject,
            };
        },
    });

    params.signup_confirmation = options?.confirmation_url || true;
    params.email_subscription = options?.email_subscription || false;
    params.template = options?.template || {};

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group < 90) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    return await request.bind(this)('admin-signup', params, { auth: true });
}

export async function createAccount(
    form: Form<
        UserAttributes & { access_group: number; password: string; } &
        { service?: string; owner?: string; }
    >,
): Promise<UserProfile & { email_admin: string; username: string; }> {
    let paramRestrictions = {
        email: (v: string) => validator.Email(v),
        password: (v: string) => validator.Password(v),
        openid_id: 'string',
        name: 'string',
        username: 'string',
        gender: 'string',
        address: (v: any) => {
            if (!v) return '';

            if (typeof v === 'string') {
                return v;
            }

            if (typeof v === 'object') {
                return JSON.stringify(v);
            }

            return undefined;
        },
        birthdate: (v: string) => validator.Birthdate(v),
        phone_number: (v: string) => validator.PhoneNumber(v),
        picture: (v: string) => { if (v) return validator.Url(v); else return "" },
        profile: (v: string) => { if (v) return validator.Url(v); else return "" },
        website: (v: string) => { if (v) return validator.Url(v); else return "" },
        nickname: 'string',
        misc: 'string',

        email_public: ['boolean', () => false],
        gender_public: ['boolean', () => false],
        address_public: ['boolean', () => false],
        birthdate_public: ['boolean', () => false],
        phone_number_public: ['boolean', () => false],
        access_group: (v: number) => {
            // if string try to convert to number and if it's not a number, throw error
            try {
                if (typeof v === 'string') {
                    v = parseInt(v);
                }
            }
            catch (e) {
                throw new SkapiError('"access_group" is invalid. Should be type <number>.', { code: 'INVALID_PARAMETER' });
            }
            if (typeof v !== 'number' || v < 1 || v > 100) {
                throw new SkapiError('"access_group" is invalid. Should be type <number> of range 1~99', { code: 'INVALID_PARAMETER' });
            }
            return v;
        },
    };

    let required = [
        'email',
        'password'
    ];

    let params = validator.Params(form, paramRestrictions, required);

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group < 90) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    return await request.bind(this)('admin-signup', params, { auth: true });
}

export async function grantAccess(params: Form<{
    user_id: string;
    access_group: number;
    service?: string;
    owner?: string;
}>): Promise<'SUCCESS: Access has been granted to the user.'> {
    params = validator.Params(params, {
        user_id: (v: string) => {
            return validator.UserId(v, '"user_id"');
        },
        access_group: (v: number) => {
            // if string try to convert to number and if it's not a number, throw error
            try {
                if (typeof v === 'string') {
                    v = parseInt(v);
                }
            }
            catch (e) {
                throw new SkapiError('"access_group" is invalid. Should be type <number>.', { code: 'INVALID_PARAMETER' });
            }
            if (typeof v === 'number' && v > 0 && v < 100) {
                return v;
            } else {
                throw new SkapiError('"access_group" is invalid. Should be type <number> of range 1~99', { code: 'INVALID_PARAMETER' });
            }
        }
    }, ['user_id', 'access_group']);

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group < 90) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    return await request.bind(this)('grant-access', params, { auth: true })
}

export async function getInvitations(params?: Form<{
    service?: string;
    owner?: string;
    email?: string;
}>, fetchOptions?: FetchOptions): Promise<DatabaseResponse<UserProfile>> {
    params = validator.Params(params, {
        email: 'string',
    });

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group < 90) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    let resp = await request.bind(this)('invitation-list', Object.assign({ mode: 'search' }, params), { fetchOptions, auth: true });
    resp.list = resp.list.map((v: any) => parseUserAttributes(v.user));
    return resp;
}

export async function cancelInvitation(params: Form<{
    service?: string;
    owner?: string;
    email: string;
}>): Promise<"SUCCESS: Invitation has been canceled."> {
    params = validator.Params(params, {
        email: v => validator.Email(v),
    }, ['email']);

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group < 90) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    return await request.bind(this)('invitation-list', Object.assign({ mode: 'cancel' }, params), { auth: true });
}

export async function resendInvitation(params: Form<{
    service?: string;
    owner?: string;
    email: string;
}>): Promise<"SUCCESS: Invitation has been re-sent. (User ID: xxx...)"> {
    params = validator.Params(params, {
        email: v => validator.Email(v),
    }, ['email']);

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group < 90) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    return await request.bind(this)('invitation-list', Object.assign({ mode: 'resend' }, params), { auth: true });
}

export async function updateUserAttributes(
    form: Form<UserAttributes & { user_id: string; }>,
): Promise<'SUCCESS: User attributes updated.'> {
    let params: any = validator.Params(form, {
        user_id: (v: string) => validator.UserId(v, '"user_id"'),
        email: (v: string) => validator.Email(v),
        address: (v: any) => {
            if (!v) return '';

            if (typeof v === 'string') {
                return v;
            }

            if (typeof v === 'object') {
                return JSON.stringify(v);
            }

            return undefined;
        },
        name: 'string',
        gender: 'string',
        birthdate: (v: string) => v ? validator.Birthdate(v) : "",
        phone_number: (v: string) => v ? validator.PhoneNumber(v) : "",
        email_public: 'boolean',
        phone_number_public: 'boolean',
        address_public: 'boolean',
        gender_public: 'boolean',
        birthdate_public: 'boolean',
        misc: 'string',
        picture: (v: string) => v ? validator.Url(v) : "",
        profile: (v: string) => v ? validator.Url(v) : "",
        nickname: 'string',
        website: (v: string) => v ? validator.Url(v) : "",
    }, ['user_id']);

    // "service" and "owner" are auto-allowed by validator.Params. They target another
    // service and must be lifted to the top level of the request (like the sibling admin
    // methods), otherwise they route against the wrong service and get sent to Cognito as
    // invalid attribute names. this.service / this.owner are used when they are omitted.
    let service = params.service;
    let owner = params.owner;
    delete params.service;
    delete params.owner;

    // user_id is the only required field, but at least one attribute to update must be provided.
    if (Object.keys(params).filter(k => k !== 'user_id' && params[k] !== undefined).length === 0) {
        throw new SkapiError('At least one attribute to update is required.', { code: 'INVALID_PARAMETER' });
    }

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group < 90) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    // when the e-mail is changed, update the alternative sign-in lookup key as well
    if (params.email) {
        params.preferred_username = (service || this.service) + '-' + MD5.hash(params.email);
    }

    let reqData: { attributes: any; service?: string; owner?: string; } = { attributes: params };
    if (service && owner) {
        reqData.service = service;
        reqData.owner = owner;
    }

    return await request.bind(this)('admin-edit-profile', reqData, { auth: true });
}