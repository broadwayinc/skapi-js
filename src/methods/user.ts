import SkapiError from '../main/error';
import {
    CognitoUserAttribute,
    CognitoUser,
    AuthenticationDetails,
    CognitoUserSession,
    CognitoUserPool
} from 'amazon-cognito-identity-js';
import {
    Form,
    FormSubmitCallback,
    UserProfile,
    FetchOptions,
    DatabaseResponse,
    UserAttributes,
    PublicUser
} from '../Types';
import validator from '../utils/validator';
import { request } from './request';
import { MD5, base_decode } from '../utils/utils';

let cognitoUser: CognitoUser | null = null;

export let userPool: CognitoUserPool | null = null;

export function setUserPool(params: { UserPoolId: string; ClientId: string; }) {
    userPool = new CognitoUserPool(params);
}

function map_ticket_obj(t) {
    let mapper = {
        "tkid": 'ticket_id',
        "cond": 'condition',
        "actn": 'action',
        "cnt": 'count',
        "ttl": 'time_to_live',
        "stmp": 'timestamp',
        'plch': 'placeholder',
        'hash': 'hash',
        'desc': 'description',
    }
    let new_obj = {};
    for (let k in t) {
        if (k === 'tkid') {
            let tkid = t[k].split('#');
            if (tkid.length === 1) {
                new_obj['ticket_id'] = tkid[0];
                continue;
            }
            new_obj['ticket_id'] = tkid[1];
            new_obj['consume_id'] = tkid[2];
            new_obj['user_id'] = tkid[3];

            if (!t.stmp) {
                new_obj['timestamp'] = base_decode(tkid[2].slice(0, -4));
            }
        }
        else if (mapper[k]) {
            new_obj[mapper[k]] = t[k];
        }
        else {
            new_obj[k] = t[k];
        }
    }
    return new_obj;
}

export async function consumeTicket(params: { ticket_id: string; } & { [key: string]: any }): Promise<any> {
    if (!params.ticket_id) {
        throw new SkapiError('Ticket ID is required.', { code: 'INVALID_PARAMETER' });
    }
    let ticket_id = params.ticket_id;
    delete params.ticket_id;
    await this.__connection;
    let resp = await request.bind(this)(`https://${this.service.slice(0, 4)}.skapi.dev/consume/${this.service}/${this.owner}/${ticket_id}`, params, { auth: true });
    return map_ticket_obj(resp);
}

export async function getTickets(params: {
    ticket_id?: string;
}, fetchOptions?: FetchOptions): Promise<DatabaseResponse<any[]>> {
    await this.__connection;
    let tickets = await request.bind(this)('ticket', Object.assign({ exec: 'list' }, params || {}), { auth: true, fetchOptions });
    tickets.list = tickets.list.map(map_ticket_obj);
    return tickets;
}

export async function getConsumedTickets(params: {
    ticket_id?: string;
}, fetchOptions?: FetchOptions): Promise<DatabaseResponse<any[]>> {
    await this.__connection;
    let tickets = await request.bind(this)('ticket', Object.assign({ exec: 'consumed' }, params || {}), { auth: true, fetchOptions });
    tickets.list = tickets.list.map(map_ticket_obj);
    return tickets;
}

export async function registerTicket(
    params: {
        ticket_id: string;
        condition?: {
            headers?: {
                key: string;
                value: string;
                operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
            }[],
            ip?: {
                value: string;
                operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
            },
            user_agent?: {
                value: string;
                operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
            },
            data?: {
                key: string;
                value: any | any[];
                operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
                setValueWhenMatch?: any | any[];
            }[],
            params?: {
                key: string;
                value: string | string[];
                operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
                setValueWhenMatch?: any | any[];
            }[],
            user?: {
                key: string;
                value: string;
                operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
            }[],
            record_access?: string; // record id user should have access to
            request?: {
                url: string;
                method: 'GET' | 'POST';
                headers?: {
                    [key: string]: string;
                };
                data?: Record<string, any>;
                params?: Record<string, any>;
                match: {
                    key: string; // key[to][match]
                    operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
                    value: any;
                    setValueWhenMatch?: any | any[];
                }[];
            }
        };
        action?: {
            access_group: number; // group number to give access to the user
            record_access?: string; // record id to give access to the user
            request?: {
                url: string;
                method: 'GET' | 'POST';
                headers?: {
                    [key: string]: string;
                };
                data?: Record<string, any>;
                params?: Record<string, any>;
            },
            update_service?: { [key: string]: any }; // only admin
        };
        desc: string;
        count?: number;
        time_to_live?: number;
        placeholder?: { [key: string]: string };
    }
): Promise<string> {
    return this.request('register-ticket', Object.assign({ exec: 'reg' }, params), { auth: true });
}

export async function unregisterTicket(
    params: {
        ticket_id: string;
    }
): Promise<string> {
    let isAdmin = await this.checkAdmin();
    if (!isAdmin) {
        throw new SkapiError('Admin access is required.', { code: 'INVALID_REQUEST' });
    }
    return this.request('register-ticket', Object.assign({ exec: 'unreg' }, params), { auth: true });
}

export function authentication() {
    if (!userPool) throw new SkapiError('User pool is missing', { code: 'INVALID_REQUEST' });

    const normalizeUserAttributes = (attr: any) => {
        let user: any = {};
        if (Array.isArray(attr)) {
            // parse attribute structure: [ { Name, Value }, ... ]
            let normalized_user_attribute_keys = {};
            for (let i of (attr as CognitoUserAttribute[])) {
                normalized_user_attribute_keys[i.Name] = i.Value;

                if (i.Name === 'custom:service' && normalized_user_attribute_keys[i.Name] !== this.service) {
                    throw new SkapiError('The user is not registered to the service.', { code: 'INVALID_REQUEST' });
                }
            }

            attr = normalized_user_attribute_keys;
        }

        for (let k in attr) {
            if (k.includes('custom:')) {
                if (k === 'custom:service' && attr[k] !== this.service) {
                    throw new SkapiError('The user is not registered to the service.', { code: 'INVALID_REQUEST' });
                }
                user[k.replace('custom:', '')] = attr[k];
            }
            else {
                if (k === 'address') {
                    let addr_main = attr[k];
                    if (addr_main && typeof addr_main === 'object' && Object.keys(addr_main).length) {
                        if (addr_main?.formatted) {
                            try {
                                attr[k] = JSON.parse(addr_main.formatted);
                            }
                            catch (err) {
                                attr[k] = addr_main.formatted;
                            }
                        }
                    }
                }
                user[k] = attr[k];
            }
        }

        for (let k of [
            'address_public',
            'birthdate_public',
            'email_public',
            // 'email_subscription',
            'gender_public',
            'phone_number_public',
            'access_group'
        ]) {
            if (k.includes('_public')) {
                if (user.hasOwnProperty(k.split('_')[0])) user[k] = user.hasOwnProperty(k) ? !!Number(user[k]) : false;
                else delete user[k];
            }
            // else if (k === 'email_subscription') user[k] = user.hasOwnProperty(k) ? !!Number(user[k]) : false;
            else user[k] = user.hasOwnProperty(k) ? Number(user[k]) : 0;
        }

        for (let k of [
            'email',
            'phone_number'
        ]) {
            if (user.hasOwnProperty(k)) {
                if (user[k + '_verified'] === true || user[k + '_verified'] === 'true') {
                    user[k + '_verified'] = true;
                }
                else {
                    user[k + '_verified'] = false;
                }
            }
            else {
                delete user[k + '_verified'];
            }
        }

        for (let k of [
            'aud',
            { from: 'auth_time', to: 'log' },
            'cognito:username',
            'event_id',
            'exp',
            'iat',
            'iss',
            'jti',
            'origin_jti',
            'secret_key',
            { from: 'sub', to: 'user_id' },
            'token_use'
        ]) {
            if (typeof k === 'string') {
                delete user[k];
            }
            else {
                user[k.to] = user[k.from];
                delete user[k.from];
            }
        };

        this.__user = user;
    };

    const getUser = (): Promise<UserProfile | null> => {
        // get users updated attribute

        return new Promise((res, rej) => {
            if (!this.session) { res(null); }
            if (cognitoUser === null) { rej(new SkapiError('Invalid session', { code: 'INVALID_REQUEST' })); }
            else {
                cognitoUser.getUserAttributes((attrErr, attributes) => {
                    if (attrErr) rej(attrErr);
                    else {
                        normalizeUserAttributes(attributes);
                        res(this.user);
                    }
                });
            }
        });
    };

    const getSession = async (option?: {
        refreshToken?: boolean;
    }): Promise<CognitoUserSession> => {
        // fetch session, updates user attributes
        let { refreshToken = false } = option || {};

        return new Promise((res, rej) => {
            cognitoUser = userPool?.getCurrentUser() || null;

            if (cognitoUser === null) {
                rej(null);
                return;
            }

            cognitoUser.getSession((err: any, session: CognitoUserSession) => {
                if (err) {
                    rej(err);
                    return;
                }

                if (!session) {
                    rej(new SkapiError('Current session does not exist.', { code: 'INVALID_REQUEST' }));
                    return;
                }

                let respond = (session) => {
                    let idToken = session.getIdToken().payload;

                    if (idToken['custom:service'] !== this.service) {
                        cognitoUser.signOut();
                        this.session = null;
                        rej(new SkapiError('Invalid session.', { code: 'INVALID_REQUEST' }));
                        return;
                    }

                    this.session = session;
                    normalizeUserAttributes(idToken);
                    res(session);
                }
                // try refresh when invalid token
                if (refreshToken || !session.isValid()) {
                    cognitoUser.refreshSession(session.getRefreshToken(), (refreshErr, refreshedSession) => {
                        if (refreshErr) {
                            rej(refreshErr);
                        }
                        else {
                            if (refreshedSession.isValid()) {
                                return respond(refreshedSession);
                                // session = refreshedSession;
                            }
                            else {
                                rej(new SkapiError('Invalid session.', { code: 'INVALID_REQUEST' }));
                                return;
                            }
                        }
                    });
                }
                else {
                    return respond(session);
                }
            });
        });
    };

    const createCognitoUser = async (email: string) => {
        if (!email) throw new SkapiError('E-Mail is required.', { code: 'INVALID_PARAMETER' });
        // let hash = this.__serviceHash[email] || (await this.updateConnection({ request_hash: email })).hash;
        let username = email.includes(this.service + '-') ? email : this.service + '-' + MD5.hash(email);

        return {
            cognitoUser: new CognitoUser({
                Username: username,
                Pool: userPool
            }),
            cognitoUsername: username
        };
    };

    const authenticateUser = (email: string, password: string): Promise<UserProfile> => {
        return new Promise((res, rej) => {
            this.__request_signup_confirmation = null;
            this.__disabledAccount = null;

            createCognitoUser(email).then(initUser => {
                let username = initUser.cognitoUsername;
                let authenticationDetails = new AuthenticationDetails({
                    Username: username,
                    Password: password
                });

                initUser.cognitoUser.authenticateUser(authenticationDetails, {
                    newPasswordRequired: (userAttributes, requiredAttributes) => {
                        this.__request_signup_confirmation = username;
                        if (userAttributes['custom:signup_ticket'] === 'PASS' || userAttributes['custom:signup_ticket'] === 'MEMBER') {
                            // auto confirm
                            initUser.cognitoUser.completeNewPasswordChallenge(password, {}, {
                                onSuccess: _ => {
                                    cognitoUser = initUser.cognitoUser;
                                    getSession().then(session => res(this.user));
                                },
                                onFailure: (err: any) => {
                                    rej(new SkapiError(err.message || 'Failed to authenticate user.', { code: err.code }));
                                }
                            });
                        }
                        else {
                            rej(new SkapiError("User's signup confirmation is required.", { code: 'SIGNUP_CONFIRMATION_NEEDED' }));
                        }
                    },
                    onSuccess: _ => getSession().then(_ => {
                        res(this.user);
                    }),
                    onFailure: (err: any) => {
                        let error: [string, string] = [err.message || 'Failed to authenticate user.', err?.code || 'INVALID_REQUEST'];

                        if (err.code === "NotAuthorizedException") {
                            if (err.message === "User is disabled.") {
                                this.__disabledAccount = username;
                                error = ['This account is disabled.', 'USER_IS_DISABLED'];
                            }

                            else {
                                error = ['Incorrect username or password.', 'INCORRECT_USERNAME_OR_PASSWORD'];
                            }
                        }
                        else if (err.code === "UserNotFoundException") {
                            error = ['Incorrect username or password.', 'INCORRECT_USERNAME_OR_PASSWORD'];
                        }
                        // else if (err.code === "UserNotConfirmedException") {
                        //     this.__request_signup_confirmation = username;
                        //     error = ["User's signup confirmation is required.", 'SIGNUP_CONFIRMATION_NEEDED'];
                        // }
                        else if (err.code === "TooManyRequestsException" || err.code === "LimitExceededException") {
                            error = ['Too many attempts. Please try again later.', 'REQUEST_EXCEED'];
                        }

                        let errCode = error[1];
                        let errMsg = error[0];
                        let customErr = error[0].split('#');

                        // "#INVALID_REQUEST: the account has been blacklisted."
                        // "#NOT_EXISTS: the account does not exist."

                        if (customErr.length > 1) {
                            customErr = customErr[customErr.length - 1].split(':');
                            errCode = customErr[0];
                            errMsg = customErr[1];
                        }

                        rej(new SkapiError(errMsg, { code: errCode, cause: err }));
                    }
                });
            });
        });
    };

    return {
        getSession,
        authenticateUser,
        createCognitoUser,
        getUser,
        // signup
    };
}

export async function getProfile(options?: { refreshToken: boolean; }): Promise<UserProfile | null> {
    await this.__authConnection;
    try {
        await authentication.bind(this)().getSession(options);
        return this.user;
    } catch (err) {
        return null;
    }
}

export async function checkAdmin() {
    await this.__connection;
    if (this.__user?.service === this.service) {
        // logged in
        return this.__user?.owner === this.host;
    } else {
        // not logged
        await logout.bind(this)();
    }

    return false;
}

export async function logout(): Promise<'SUCCESS: The user has been logged out.'> {
    await this.__connection;

    if (cognitoUser) {
        cognitoUser.signOut();
    }

    let to_be_erased = {
        'session': null,
        '__startKeyHistory': {},
        '__cached_requests': {},
        '__user': null
    };

    for (let k in to_be_erased) {
        this[k] = to_be_erased[k];
    }

    return 'SUCCESS: The user has been logged out.';
}

export async function resendSignupConfirmation(
    /** Redirect url on confirmation success. */
    redirect: string
): Promise<'SUCCESS: Signup confirmation E-Mail has been sent.'> {
    if (!this.__request_signup_confirmation) {
        throw new SkapiError('Least one login attempt is required.', { code: 'INVALID_REQUEST' });
    }

    if (redirect) {
        redirect = validator.Url(redirect);
    }
    else {
        redirect = undefined;
    }

    let resend = await request.bind(this)("confirm-signup", {
        username: this.__request_signup_confirmation,
        redirect
    });

    return resend; // 'SUCCESS: Signup confirmation E-Mail has been sent.'
}

export async function recoverAccount(
    /** Redirect url on confirmation success. */
    redirect: boolean | string = false
): Promise<"SUCCESS: Recovery e-mail has been sent."> {

    if (typeof redirect === 'string') {
        redirect = validator.Url(redirect);
    }

    else if (typeof redirect !== 'boolean') {
        throw new SkapiError('Argument should be type: <boolean | string>.', { code: 'INVALID_REQUEST' });
    }

    if (!this.__disabledAccount) {
        throw new SkapiError('Least one signin attempt of disabled account is required.', { code: 'INVALID_REQUEST' });
    }

    await request.bind(this)("recover-account", { username: this.__disabledAccount, redirect });
    this.__disabledAccount = null;
    return 'SUCCESS: Recovery e-mail has been sent.';
}

export async function jwtLogin(params: {
    idToken: string;
    keyUrl: string;
    clientId: string;
    provider: string;
    nonce?: string;
}) {
    validator.Params(params, {
        idToken: 'string',
        clientId: 'string',
        keyUrl: (v: string) => validator.Url(v),
        provider: 'string',
        nonce: 'string'
    }, ['idToken', 'keyUrl', 'clientId']);

    let { hashedPassword, username } = await request.bind(this)("jwt-login", params);
    try {
        return login.bind(this)({ username: username, password: hashedPassword });
    } catch (err: SkapiError | any) {
        if (err?.code === 'INCORRECT_USERNAME_OR_PASSWORD') {
            throw new SkapiError('User has migrated the account. Login with the service username and password.', { code: 'INVALID_REQUEST' });
        }
    }
}

export async function login(
    form: Form<{
        /** if given, username will be used instead of email. */
        username?: string;
        /** E-Mail for signin. 64 character max. */
        email: string;
        /** Password for signin. Should be at least 6 characters. */
        password: string;
    }>): Promise<UserProfile> {
    await this.logout();
    let params = validator.Params(form, {
        username: 'string',
        email: 'string',
        password: 'string'
    }, ['password']);

    if (params.email) {
        // incase user uses email instead of username
        try {
            validator.Email(params.email);
        } catch (err) {
            params.username = params.email;
            delete params.email;
        }
    }

    if (!params.username && !params.email) {
        throw new SkapiError('Least one of "username" or "email" is required.', { code: 'INVALID_PARAMETER' });
    }

    return authentication.bind(this)().authenticateUser(params.username || params.email, params.password);

    // INVALID_REQUEST: the account has been blacklisted.
    // NOT_EXISTS: the account does not exist.
}

export async function signup(
    form: Form<UserAttributes & { email: String, password: String; }>,
    option?: {
        signup_confirmation?: boolean | string;
        email_subscription?: boolean;
        login?: boolean;
    } & FormSubmitCallback): Promise<UserProfile | "SUCCESS: The account has been created. User's signup confirmation is required." | 'SUCCESS: The account has been created.'> {
    let is_admin = await checkAdmin.bind(this)();

    let params = validator.Params(form || {}, {
        username: 'string',
        email: (v: string) => validator.Email(v),
        password: (v: string) => validator.Password(v),
        name: 'string',
        address: 'string',
        gender: 'string',
        birthdate: (v: string) => validator.Birthdate(v),
        phone_number: (v: string) => validator.PhoneNumber(v),
        email_public: ['boolean', () => false],
        address_public: ['boolean', () => false],
        gender_public: ['boolean', () => false],
        birthdate_public: ['boolean', () => false],
        phone_number_public: ['boolean', () => false],
        access_group: 'number',
        misc: 'string',

        picture: (v: string) => validator.Url(v),
        profile: (v: string) => validator.Url(v),
        family_name: 'string',
        given_name: 'string',
        middle_name: 'string',
        nickname: 'string',
        website: (v: string) => validator.Url(v),
    }, is_admin ? ['email'] : ['email', 'password']);

    let admin_creating_account = is_admin && params.service && this.service !== params.service;
    if (admin_creating_account) {
        // admin creating account
        params.owner = this.__user.user_id;
    }
    else if (!is_admin) {
        if (params.access_group) {
            throw new SkapiError('Only admins can set "access_group" parameter.', { code: 'INVALID_PARAMETER' });
        }

        await this.logout();
    }

    option = validator.Params(option || {}, {
        email_subscription: (v: boolean) => {
            if (typeof v !== 'boolean') {
                throw new SkapiError('"option.email_subscription" should be type: <boolean>.', { code: 'INVALID_PARAMETER' });
            }

            if (!option?.signup_confirmation) {
                // requires to be url or true
                throw new SkapiError('"option.signup_confirmation" is required for email subscription.', { code: 'INVALID_PARAMETER' });
            }

            return v;
        },
        signup_confirmation: (v: string | boolean) => {
            if (typeof v === 'string') {
                return validator.Url(v);
            }
            else if (typeof v === 'boolean') {
                return v;
            }
            else {
                throw new SkapiError('"option.signup_confirmation" should be type: <string | boolean>.', { code: 'INVALID_PARAMETER' });
            }
        },
        login: (v: boolean) => {
            if (typeof v === 'boolean') {
                if (option.signup_confirmation && v) {
                    throw new SkapiError('"login" is not allowed when "option.signup_confirmation" is true.', { code: 'INVALID_PARAMETER' });
                }
                return v;
            }
            throw new SkapiError('"option.login" should be type: boolean.', { code: 'INVALID_PARAMETER' });
        }
    });

    let logUser = option?.login || false;
    let signup_confirmation = option?.signup_confirmation || false;

    if (admin_creating_account && signup_confirmation && params?.password) {
        throw new SkapiError('Admins cannot create an account with "option.signup_confirmation" option.', { code: 'INVALID_PARAMETER' });
    }

    if (params.email_public && !signup_confirmation) {
        throw new SkapiError('"option.signup_confirmation" should be true if "email_public" is set to true.', { code: 'INVALID_PARAMETER' });
    }

    params.signup_confirmation = signup_confirmation;
    params.email_subscription = option?.email_subscription || false;

    if (!admin_creating_account) {
        delete params.service;
        delete params.owner;
    }

    let resp = await request.bind(this)("signup", params, { auth: is_admin });

    if (!is_admin) {
        if (signup_confirmation) {
            let u = await authentication.bind(this)().createCognitoUser(params.username || params.email);
            cognitoUser = u.cognitoUser;
            this.__request_signup_confirmation = u.cognitoUsername;
            return "SUCCESS: The account has been created. User's signup confirmation is required.";
        }

        if (logUser) {
            // log user in
            return login.bind(this)({ email: params.username || params.email, password: params.password });
        }

        return 'SUCCESS: The account has been created.';
    }

    return resp;
}

export async function disableAccount(): Promise<'SUCCESS: account has been disabled.'> {
    await this.__connection;
    let result = await request.bind(this)('remove-account', { disable: this.__user.user_id }, { auth: true });
    await logout.bind(this)();
    return result;
}

export async function resetPassword(form: Form<{
    email: string;
    code: string | number;
    new_password: string;
}>): Promise<"SUCCESS: New password has been set."> {

    await this.__connection;

    let params = validator.Params(form, {
        email: (v: string) => validator.Email(v),
        code: ['number', 'string'],
        new_password: (v: string) => validator.Password(v)
    }, ['email', 'code', 'new_password']);

    let code = params.code, new_password = params.new_password;

    if (typeof code === 'number') {
        code = code.toString();
    }

    return new Promise(async (res, rej) => {
        let cognitoUser = (await authentication.bind(this)().createCognitoUser(params.email)).cognitoUser;

        cognitoUser.confirmPassword(code, new_password, {
            onSuccess: result => {
                res("SUCCESS: New password has been set.");
            },
            onFailure: (err: any) => {
                rej(new SkapiError(err?.message || 'Failed to reset password.', { code: err?.code }));
            }
        });
    });
}

async function verifyAttribute(attribute: string, form: Form<{ code: string; }>): Promise<string> {
    await this.__connection;
    let code: string;

    if (!cognitoUser) {
        throw new SkapiError('The user has to be logged in.', { code: 'INVALID_REQUEST' });
    }

    if (attribute === 'email' || attribute === 'phone_number') {
        if (!this.__user.hasOwnProperty(attribute)) {
            throw new SkapiError(`No ${attribute === 'email' ? 'e-mail' : 'phone number'} to verify`, { code: 'INVALID_REQUEST' });
        }

        if (this.__user?.[`${attribute}_verified`]) {
            return `SUCCESS: "${attribute}" is verified.`;
        }

        code = (form ? validator.Params(form, {
            code: ['string']
        }) : {}).code || '';
    }
    else {
        return;
    }

    return new Promise((res, rej) => {
        let callback: any = {
            onSuccess: (result: any) => {
                if (code) {
                    authentication.bind(this)().getSession({ refreshToken: true }).then(
                        () => {
                            if (this.__user) {
                                this.__user[attribute + '_verified'] = true;
                            }
                            res(`SUCCESS: "${attribute}" is verified.`);
                        }
                    ).catch(err => {
                        rej(err);
                    });
                }

                else {
                    res('SUCCESS: Verification code has been sent.');
                }
            },
            onFailure: (err: Record<string, any>) => {
                rej(
                    new SkapiError(
                        err.message || 'Failed to request verification code.',
                        {
                            code: err?.code
                        }
                    )
                );
            }
        };

        if (code) {
            cognitoUser?.verifyAttribute(attribute, code, callback);
        }
        else {
            callback.inputVerificationCode = null;
            cognitoUser?.getAttributeVerificationCode(attribute, callback);
        }
    });
}

export function verifyPhoneNumber(form?: Form<{ code: string; }>): Promise<'SUCCESS: Verification code has been sent.' | 'SUCCESS: "phone_number" is verified.'> {
    return verifyAttribute.bind(this)('phone_number', form);
}

export function verifyEmail(form?: Form<{ code: string; }>): Promise<'SUCCESS: Verification code has been sent.' | 'SUCCESS: "email" is verified.'> {
    return verifyAttribute.bind(this)('email', form);
}

export async function forgotPassword(
    form: Form<{
        /** Signin E-Mail. */
        email: string;
    }>): Promise<"SUCCESS: Verification code has been sent."> {

    await this.__connection;

    let params = validator.Params(form, {
        email: (v: string) => validator.Email(v)
    }, ['email']);

    return new Promise(async (res, rej) => {
        let cognitoUser = (await authentication.bind(this)().createCognitoUser(params.email)).cognitoUser;
        cognitoUser.forgotPassword({
            onSuccess: result => {
                res("SUCCESS: Verification code has been sent.");
            },
            onFailure: (err: any) => {
                rej(new SkapiError(err?.message || 'Failed to send verification code.', { code: err?.code || 'ERROR' }));
            }
        });
    });
}

export async function changePassword(params: {
    new_password: string;
    current_password: string;
}): Promise<'SUCCESS: Password has been changed.'> {
    await this.__connection;
    if (!this.session) {
        throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
    }

    let p = validator.Params(params, {
        'current_password': 'string',
        'new_password': 'string'
    });

    if (!p?.current_password) {
        throw new SkapiError('"current_password" is required to change password.', { code: 'INVALID_PARAMETER' });
    }

    if (!p?.new_password) {
        throw new SkapiError('"new_password" is required to change password.', { code: 'INVALID_PARAMETER' });
    }

    validator.Password(p.current_password);
    validator.Password(p.new_password);

    return new Promise((res, rej) => {
        cognitoUser.changePassword(
            p.current_password,
            p.new_password,
            (err: any, result: any) => {
                if (err) {
                    if (err?.code === "InvalidParameterException") {
                        rej(new SkapiError('Invalid password parameter.', { code: 'INVALID_PARAMETER' }));
                    }
                    else if (err?.code === "NotAuthorizedException") {
                        rej(new SkapiError('Incorrect password.', { code: 'INVALID_REQUEST' }));
                    }
                    else if (err?.code === "TooManyRequestsException" || err?.code === "LimitExceededException") {
                        rej(new SkapiError('Too many attempts. Please try again later.', { code: 'REQUEST_EXCEED' }));
                    }
                    else {
                        rej(new SkapiError(err?.message || 'Failed to change user password.', { code: err?.code || err?.name }));
                    }
                }

                res('SUCCESS: Password has been changed.');
            });
    });
}

export async function updateProfile(form: Form<UserAttributes>): Promise<UserProfile> {
    await this.__connection;
    if (!this.session) {
        throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
    }

    let params = validator.Params(form || {}, {
        email: (v: string) => validator.Email(v),
        address: (v: any) => {
            if (!v) return '';

            if (typeof v === 'string') {
                return v;
            }

            if (typeof v === 'object') {
                return JSON.stringify(v);
            }

            return '';
        },
        name: 'string',
        gender: 'string',
        birthdate: (v: string) => validator.Birthdate(v),
        phone_number: (v: string) => validator.PhoneNumber(v),
        email_public: 'boolean',
        phone_number_public: 'boolean',
        address_public: 'boolean',
        gender_public: 'boolean',
        birthdate_public: 'boolean',
        misc: 'string',

        picture: (v: string) => validator.Url(v),
        profile: (v: string) => validator.Url(v),
        family_name: 'string',
        given_name: 'string',
        middle_name: 'string',
        nickname: 'string',
        website: (v: string) => validator.Url(v),
    });

    if (params && typeof params === 'object' && !Object.keys(params).length) {
        return this.user;
    }

    // set alternative signin email
    if (params.email) {
        params['preferred_username'] = this.service + '-' + MD5.hash(params.email);
    }

    let collision = [
        ['email_public', 'email_verified', "User's E-Mail should be verified to set"],
        ['phone_number_public', 'phone_number_verified', "User's phone number should be verified to set"]
    ];

    if (this.__user) {
        for (let c of collision) {
            if (params[c[0]] && !this.__user[c[1]]) {
                throw new SkapiError(`${c[2]} "${c[0]}" to true.`, { code: 'INVALID_REQUEST' });
            }
        }
    }

    // delete unchanged values, convert key names to cognito attributes
    let toRemove = [];
    for (let k in params) {
        if (params[k] === this.user[k]) {
            toRemove.push(k);
            continue;
        }

        let customAttr = [
            'email_public',
            'phone_number_public',
            'address_public',
            'gender_public',
            'birthdate_public',
            'misc'
        ];

        if (customAttr.includes(k)) {
            let parseValue = params[k];

            if (typeof parseValue === 'boolean') {
                parseValue = parseValue ? '1' : '0';
            }

            params['custom:' + k] = parseValue;
            toRemove.push(k);
        }
    }

    for (let k of toRemove) {
        delete params[k];
    }

    if (params && typeof params === 'object' && Object.keys(params).length) {
        // format params to cognito attribute
        let toSet: Array<CognitoUserAttribute> = [];
        for (let key in params) {
            toSet.push(new CognitoUserAttribute({
                Name: key,
                Value: params[key]
            }));
        }

        await new Promise((res, rej) => {
            cognitoUser?.updateAttributes(
                toSet,
                (err: any, result: any) => {
                    if (err) {
                        rej(
                            [
                                err?.code || err?.name,
                                err?.message || `Failed to update user settings.`
                            ]
                        );
                    }
                    res(result);
                });
        });

        await authentication.bind(this)().getSession({ refreshToken: true });
        return this.user;
    }

    return this.user;
}

export async function getUsers(
    params?: {
        searchFor: string;
        value: string | number | boolean;
        condition?: '>' | '>=' | '=' | '<' | '<=' | '!=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte' | 'ne';
        range?: string | number | boolean;
    },
    fetchOptions?: FetchOptions): Promise<DatabaseResponse<PublicUser>> {
    if (!params) {
        // set default value
        params = {
            searchFor: 'timestamp',
            condition: '>',
            value: 0
        };

        if (!fetchOptions) {
            fetchOptions = {};
        }

        fetchOptions.ascending = false;
    }

    let isAdmin = await checkAdmin.bind(this)();

    if (isAdmin && !params.hasOwnProperty('service')) {
        throw new SkapiError('Service ID is required.', { code: 'INVALID_PARAMETER' });
    }

    const searchForTypes = {
        'user_id': (v: string) => validator.UserId(v),
        'email': (v: string) => validator.Email(v),
        'phone_number': (v: string) => validator.PhoneNumber(v),
        'locale': (v: string) => {
            if (typeof v !== 'string' || typeof v === 'string' && v.length > 5) {
                throw new SkapiError('Value of "locale" should be a country code.', { code: 'INVALID_PARAMETER' });
            }
            return v;
        },
        'name': 'string',
        'address': 'string',
        'gender': 'string',
        'birthdate': (v: string) => validator.Birthdate(v),
        'subscribers': 'number',
        'timestamp': 'number',
        'access_group': 'number',
        'approved': (v: boolean) => {
            if (v) {
                return 'by_admin:approved';
            }
            else {
                return 'by_admin:suspended';
            }
        }
    };

    let required = ['searchFor', 'value'];

    params = validator.Params(params, {
        searchFor: [
            'user_id',
            'name',
            'email',
            'phone_number',
            'address',
            'gender',
            'birthdate',
            'locale',
            'subscribers',
            'timestamp',
            'access_group',
            'approved'
        ],
        condition: ['>', '>=', '=', '<', '<=', 'gt', 'gte', 'eq', 'lt', 'lte', () => '='],
        value: (v: any) => {
            let checker = searchForTypes[params.searchFor];
            if (typeof checker === 'function') {
                if (!params?.condition || params?.condition === '=' || params?.range) {
                    return checker(v);
                }
            }

            else if (typeof v !== checker) {
                throw new SkapiError(`Value does not match the type of "${params.searchFor}" index.`, { code: 'INVALID_PARAMETER' });
            }

            return v;
        },
        range: (v: any) => {
            let checker = searchForTypes[params.searchFor];
            if (typeof checker === 'function') {
                return checker(v);
            }

            else if (typeof v !== checker) {
                throw new SkapiError(`Range does not match the type of "${params.searchFor}" index.`, { code: 'INVALID_PARAMETER' });
            }

            return v;
        }
    }, required);

    if (params?.condition && params?.condition !== '=' && params.hasOwnProperty('range')) {
        throw new SkapiError('Conditions does not apply on range search.', { code: 'INVALID_PARAMETER' });
    }

    if (params.searchFor === 'user_id' && params.condition !== '=') {
        throw new SkapiError(`Conditions are not allowed on "user_id"`, { code: 'INVALID_PARAMETER' });
    }

    // if (params.searchFor === 'access_group') {
    //     params.searchFor = 'group';
    // }

    if (typeof params?.value === 'string' && !params?.value) {
        throw new SkapiError('Value should not be an empty string.', { code: 'INVALID_PARAMETER' });
    }

    if (typeof params?.searchFor === 'string' && !params?.searchFor) {
        throw new SkapiError('"searchFor" should not be an empty string.', { code: 'INVALID_PARAMETER' });
    }

    return request.bind(this)('get-users', params, { auth: true, fetchOptions });
}

/**
 * Not official. Bleeding edge.<br>
 * Retrieves, reverts e-mail to last verified email.<br>
 * @returns Last verified e-mail address, or updated userProfile when params.revert is true.
 */
export async function lastVerifiedEmail(params?: {
    /** Reverts to last verified e-mail when true. */
    revert: boolean;
}): Promise<string | UserProfile> {
    await this.__connection;
    let res = await request.bind(this)('last-verified-email', params, { auth: true });
    if (res.includes('SUCCESS')) {
        await authentication.bind(this)().getSession({ refreshToken: true });
        return this.user;
    }
    return res;
}

/**
 * Not official. Bleeding edge.<br>
 * Requests username(e-mail) change.<br>
 * skapi server will send username change confirmation e-mail to user.<br>
 * Username will not be changed when the user did not confirm.<br>
 * Confirmation e-mail is valid within 24 hours.
 */
export async function requestUsernameChange(params: {
    /** Redirect URL when user clicks on the link. */
    redirect?: string;
    /** username(e-mail) user wish to change to. */
    username: string;
}): Promise<'SUCCESS: confirmation e-mail has been sent.'> {
    await this.__connection;

    params = validator.Params(params, {
        username: validator.Email,
        redirect: validator.Url
    }, ['username']);

    return await request.bind(this)('request-username-change', params, { auth: true });
}