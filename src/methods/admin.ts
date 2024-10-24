import validator from '../utils/validator';
import { request } from '../utils/network';
import { checkAdmin } from './user';
import { UserAttributes, UserProfilePublicSettings, UserProfile } from '../Types';
import SkapiError from '../main/error';

export async function blockAccount (params: {
    user_id: string;
    owner?: string;
    service?: string;
}): Promise<'SUCCESS: The user has been blocked.'> {
    params = validator.Params(params, {
        user_id: (v: string) => {
            return validator.UserId(v, '"user_id"');
        },
    }, ['user_id']);

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group !== 99) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    return await request.bind(this)('block-account', { owner: params?.owner, service: params?.service, block: params.user_id }, { auth: true });
}

export async function unblockAccount (params: {
    user_id: string;
    owner?: string;
    service?: string;
}): Promise<'SUCCESS: The user has been unblocked.'> {
    params = validator.Params(params, {
        user_id: (v: string) => {
            return validator.UserId(v, '"user_id"');
        },
    }, ['user_id']);

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group !== 99) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    return await request.bind(this)('block-account', { owner: params?.owner, service: params?.service, unblock: params.user_id }, { auth: true });
}

export async function deleteAccount (params: {
    user_id: string;
    owner?: string;
    service?: string;
}): Promise<'SUCCESS: Account has been deleted.'> {
    params = validator.Params(params, {
        user_id: (v: string) => {
            return validator.UserId(v, '"user_id"');
        },
    }, ['user_id']);

    let isAdmin = await checkAdmin.bind(this)();

    if (!isAdmin) {
        if (!this.__user) {
            throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
        }

        if (this.__user.access_group !== 99) {
            throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
        }
    }

    return await request.bind(this)('remove-account', { owner: params?.owner, service: params?.service, delete: params.user_id }, { auth: true });
}

export async function inviteUser () {}
export async function createUser () {}

// export async function adminSignup (params: {
//     form: UserAttributes & UserProfilePublicSettings & 
//         { email: String; password?: String;} & 
//         { access_group?: number; service?: string }
//     option?: {
//         signup_confirmation?: boolean | string;
//         email_subscription?: boolean;
//     }
//     owner?: string;
//     service?: string;
// }): Promise<UserProfile & { email_admin: string }> {
//     let obj: any = params.form;

//     obj.signup_confirmation = params.option?.signup_confirmation || false;
//     obj.email_subscription = params.option?.email_subscription || false;

//     let isAdmin = await checkAdmin.bind(this)();

//     if (!isAdmin) {
//         if (!this.__user) {
//             throw new SkapiError('User needs to login.', { code: 'INVALID_REQUEST' });
//         }

//         if (this.__user.access_group !== 99) {
//             throw new SkapiError('Invalid access.', { code: 'INVALID_REQUEST' });
//         }
//     }

//     return await request.bind(this)('admin-signup', Object.assign({ service: params?.service, owner: params?.owner }, obj), { auth: true });
// }

// async admin_signup(
//     form: UserAttributes &
//         UserProfilePublicSettings & { email: String; password?: String; username?: string } & {
//             access_group?: number;
//             service?: string;
//         },
//     option?: {
//         signup_confirmation?: boolean | string;
//         email_subscription?: boolean;
//     }
// ): Promise<UserProfile & { email_admin: string }> {
//     let params: any = form;
//     params.signup_confirmation = option?.signup_confirmation || false;
//     params.email_subscription = option?.email_subscription || false;

//     // cognito signup process below
//     return await skapi.util.request('admin-signup', Object.assign({ service: this.id, owner: this.owner }, params), { auth: true });
// }