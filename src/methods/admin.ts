import validator from '../utils/validator';
import { request } from '../utils/network';
import { checkAdmin } from './user';
import { Form, UserAttributes, UserProfile, UserPublic, DatabaseResponse, FetchOptions } from '../Types';
import SkapiError from '../main/error';
import { parseUserAttributes } from '../utils/utils';

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
    form: Form<UserAttributes & {
        /**
         * Required. The invitation is sent here. Refused with EXISTS when it is
         * already another account's login ID, or while it has a pending invitation.
         */
        email: string;
        /**
         * Optional. Becomes the invited account's PERMANENT login username.
         * The e-mail also logs them in once they accept the invitation (best
         * effort), not while it is pending. Refused with EXISTS when the username
         * or the e-mail is already another account's login ID.
         */
        username?: string;
        /** ID of an OpenID logger registered in the project, to link the invited account to it. */
        openid_id: string;
        /** 1~99. The backend defaults it to 1 when omitted. 99 is admin level. */
        access_group: number;
    } & { service?: string; owner?: string; }>,
    options?: {
        /** URL the user is taken to after accepting. Must not contain "#". */
        confirmation_url?: string;
        /** Subscribe the user to Service Email (group 1) on accept. Requires confirmation_url. */
        email_subscription?: boolean;
        /** Custom HTML template for this invitation e-mail. Both fields are required. */
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
        UserAttributes & { email: string; access_group: number; password: string; } &
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

/**
 * Updates another user's profile attributes (admin-edit-profile).
 *
 * Never the caller's own account, masters included: its own user_id is refused with
 * INVALID_REQUEST and 'Cannot modify attributes of the current user.' before any request
 * is sent (the backend refuses it the same way). Users change their own profile with
 * updateProfile() without user_id.
 *
 * An admin in access groups 90 ~ 98 cannot update an account whose access group is at or
 * above their own, a disabled account included (it counts at the group it had): refused with
 * INVALID_REQUEST and 'No access to modify admin.', and nothing is written. Access group 99
 * admins and the project owner are not limited.
 *
 * A changed e-mail is written unverified: this method never marks an e-mail verified, for an
 * admin in access groups 90 ~ 98 or anyone else. The new e-mail does not log the account in
 * until the user verifies it with verifyEmail(). The previous e-mail stops logging in when the
 * change is written, unless it is the e-mail an account without a username was created with,
 * which stays its login ID. A username always logs in. The change is refused with EXISTS and
 * 'E-mail "user@email.com" is already a login ID in this service.' when the e-mail is a login
 * ID another account of the project was granted: the address that account was created or
 * invited with, or one it has verified. An e-mail login another account holds without having
 * verified the address blocks nothing; it is removed.
 */
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

    // admin-edit-profile acts on another account with admin rights, and the rank rule never
    // limits a master, so the caller's own account would be the one it rewrote with no check on
    // who asked. The backend refuses it for everyone; refused here as well, with the same code
    // and text, so the request is never sent. A user id is the account's Cognito sub, unique in
    // the pool, so an explicit service/owner cannot make the same id another account.
    // __connection first: the signed-in user is restored there.
    await this.__connection;
    if (this.__user?.user_id && params.user_id === this.__user.user_id) {
        throw new SkapiError('Cannot modify attributes of the current user.', { code: 'INVALID_REQUEST' });
    }

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

    // No preferred_username is sent with a new e-mail. The e-mail is written unverified, and a
    // login alias for an address nobody has verified would let the account log in with an
    // e-mail it may not own. The backend removes the old alias on the change and gives the new
    // e-mail its login once the user verifies it.

    let reqData: { attributes: any; service?: string; owner?: string; } = { attributes: params };
    if (service && owner) {
        reqData.service = service;
        reqData.owner = owner;
    }

    return await request.bind(this)('admin-edit-profile', reqData, { auth: true });
}