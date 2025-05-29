import SkapiError from '../main/error';
import {
    CognitoUserAttribute,
    CognitoUser,
    AuthenticationDetails,
    CognitoUserSession
} from 'amazon-cognito-identity-js';
import {
    Form,
    UserProfile,
    FetchOptions,
    DatabaseResponse,
    UserAttributes,
    PublicUser
} from '../Types';
import validator from '../utils/validator';
import { request } from '../utils/network';
import { MD5, extractFormData, fromBase62, parseUserAttributes } from '../utils/utils';

let cognitoUser: CognitoUser | null = null;

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
                new_obj['timestamp'] = fromBase62(tkid[2].slice(0, -4));
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

    await this.__connection;
    let resp = await request.bind(this)(`https://${this.service.slice(0, 4)}.${this.customApiDomain}/auth/consume/${this.service}/${this.owner}/${ticket_id}`, params, { auth: true });
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
        description: string;
        count?: number;
        time_to_live?: number;
        placeholder?: { [key: string]: string };
        condition?: {
            return200?: boolean; // When true, returns 200 when regardless condition mismatch
            method?: 'GET' | 'POST'; // Defaults to 'GET' method when not given
            headers?: {
                key: string;
                value: string | string[];
                operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
            }[],
            ip?: {
                value: string | string[];
                operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
            },
            user_agent?: {
                value: string | string[];
                operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
            },
            data?: {
                key?: string;
                value: any | any[];
                operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
                setValueWhenMatch?: any | any[];
            }[],
            params?: {
                key?: string;
                value: string | string[];
                operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
                setValueWhenMatch?: any | any[];
            }[],
            user?: {
                key: string;
                value: string | string[];
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
                    value: any | any[];
                }[];
            }
        };
        action?: {
            access_group: number; // group number to give access to the user
            record_access?: string; // record id to give access to the user
            request?: {
                url: string;
                method: 'GET' | 'POST'; // Defaults to 'GET' method when not given
                headers?: {
                    [key: string]: string;
                };
                data?: Record<string, any>;
                params?: Record<string, any>;
            }
        };
    }
): Promise<string> {
    return request.bind(this)('register-ticket', Object.assign({ exec: 'reg' }, params), { auth: true });
}

export async function unregisterTicket(
    params: {
        ticket_id: string;
    }
): Promise<string> {
    return request.bind(this)('register-ticket', Object.assign({ exec: 'unreg' }, params), { auth: true });
}

export async function getJwtToken() {
    await this.__connection;
    if (this.session) {
        const currentTime = Math.floor(Date.now() / 1000);
        const idToken = this.session.getIdToken();
        const idTokenExp = idToken.getExpiration();
        this.log('request:tokens', {
            exp: this.session.idToken.payload.exp,
            currentTime,
            expiresIn: idTokenExp - currentTime,
            token: this.session.accessToken.jwtToken,
            refreshToken: this.session.refreshToken.token
        });

        if (idTokenExp < currentTime) {
            this.log('request:requesting new token', null);
            try {
                await authentication.bind(this)().getSession({ refreshToken: true });
                this.log('request:received new tokens', {
                    exp: this.session.idToken.payload.exp,
                    currentTime,
                    expiresIn: idTokenExp - currentTime,
                    token: this.session.accessToken.jwtToken,
                    refreshToken: this.session.refreshToken.token
                });
            }
            catch (err) {
                this.log('request:new token error', err);
                throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
            }
        }

        return this.session?.idToken?.jwtToken;
    }
    else {
        this.log('request:no session', null);
        _out.bind(this)();
        throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
    }
}


let isRefreshing = null;
function refreshSession(session, cognitoUser) {
    if (isRefreshing instanceof Promise) {
        return isRefreshing;
    }

    return new Promise((res, rej) => {
        cognitoUser.refreshSession(session.getRefreshToken(), (refreshErr, refreshedSession) => {
            this.log('getSession:refreshSessionCallback', { refreshErr, refreshedSession });

            if (refreshErr) {
                _out.bind(this)();
                rej(refreshErr);
            }
            else if (refreshedSession.isValid()) {
                res(refreshedSession);
            }
            else {
                _out.bind(this)();
                rej(new SkapiError('Invalid session.', { code: 'INVALID_REQUEST' }));
            }
        });
    });
}

export function authentication() {
    if (!this.userPool) throw new SkapiError('User pool is missing', { code: 'INVALID_REQUEST' });

    const getUserProfile = (): UserProfile => {
        // get users updated attribute
        let attr = cognitoUser.getSignInUserSession().getIdToken().payload || null;

        // parse attribute structure: [ { Name, Value }, ... ]
        let user = parseUserAttributes(attr);
        this.log('normalized user attribute', user);
        this.__user = user;
        return user;
    };

    const getSession = (option?: { skipEventTrigger?: boolean; refreshToken?: boolean; _holdLogin?: boolean }): Promise<CognitoUserSession | Function> => {
        // fetch session, updates user attributes
        this.log('getSession:option', option);
        let { refreshToken = false, skipEventTrigger = false } = option || {};

        return new Promise((res, rej) => {
            cognitoUser = this.userPool.getCurrentUser();

            if (!cognitoUser) {
                this.log('getSession:cognitoUser', cognitoUser);
                // no user session. wasn't logged in.
                _out.bind(this)();
                rej(null);
                return;
            }

            cognitoUser.getSession((err: any, session: CognitoUserSession) => {
                this.log('getSession:getSessionCallback', { err, session });

                let respond = async (s: CognitoUserSession) => {
                    let sessionAttribute = s.getIdToken().payload;
                    this.log('getSession:respond:sessionAttribute', sessionAttribute);

                    if (sessionAttribute['custom:service'] !== this.service) {
                        this.log('getSession:respond', 'invalid service, signing out');
                        _out.bind(this)();
                        rej(new SkapiError('Invalid session.', { code: 'INVALID_REQUEST' }));
                        return;
                    }

                    if (option?._holdLogin) {
                        // hold login
                        res(() => {
                            this.session = s;
                            getUserProfile();
                            if (!skipEventTrigger) {
                                this._runOnLoginListeners(this.user);
                            }
                            return this.session;
                        });
                        return;
                    }
                    this.session = s;
                    getUserProfile();
                    if (!skipEventTrigger) {
                        this._runOnLoginListeners(this.user);
                    }
                    res(this.session);
                }

                if (!session) {
                    _out.bind(this)();
                    rej(new SkapiError('Current session does not exist.', { code: 'INVALID_REQUEST' }));
                    return;
                }

                if (err) {
                    refreshSession.bind(this)(session, cognitoUser).then(refreshedSession => respond(refreshedSession)).catch(err => {
                        _out.bind(this)();
                        rej(err);
                    }).finally(() => {
                        isRefreshing = null;
                    });

                    return;
                }

                const currentTime = Math.floor(Date.now() / 1000);
                const idToken = session.getIdToken();
                const idTokenExp = idToken.getExpiration();
                const isExpired = idTokenExp < currentTime;
                this.log('getSession:currentTime', currentTime);
                this.log('getSession:idTokenExp', idTokenExp);
                this.log('getSession:isExpired', isExpired);
                // try refresh when invalid token
                if (isExpired || refreshToken || !session.isValid()) {
                    refreshSession.bind(this)(session, cognitoUser).then(refreshedSession => respond(refreshedSession)).catch(err => {
                        _out.bind(this)();
                        rej(err);
                    }).finally(() => {
                        isRefreshing = null;
                    });
                }
                else {
                    respond(session).catch(err => rej(err));
                }
            });
        });
    };

    const createCognitoUser = (un: string, raw?: boolean) => {
        let username = raw ? un : un.includes(this.service + '-') ? un : this.service + '-' + MD5.hash(un);

        return {
            cognitoUser: new CognitoUser({
                Username: username,
                Pool: this.userPool
            }),
            cognitoUsername: username
        };
    };

    const authenticateUser = (email: string, password: string, raw: boolean = false): Promise<UserProfile> => {
        return new Promise((res, rej) => {
            this.__request_signup_confirmation = null;
            this.__disabledAccount = null;

            let initUser = createCognitoUser(email, raw);
            let username = initUser.cognitoUsername;
            let authenticationDetails = new AuthenticationDetails({
                Username: username,
                Password: password
            });

            initUser.cognitoUser.authenticateUser(authenticationDetails, {
                newPasswordRequired: (userAttributes, requiredAttributes) => {
                    this.__disabledAccount = null;
                    this.__request_signup_confirmation = username;
                    if (userAttributes['custom:signup_ticket'] === 'PASS' || userAttributes['custom:signup_ticket'] === 'MEMBER') {
                        // auto confirm - (setting password from admin created account)
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
                        // legacy method... will be deprecated
                        rej(new SkapiError("User's signup confirmation is required.", { code: 'SIGNUP_CONFIRMATION_NEEDED' }));
                    }
                },
                onSuccess: _ => getSession().then(_ => {
                    this.__disabledAccount = null;
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
                    else if (err.code === "UserNotConfirmedException") {
                        this.__request_signup_confirmation = username;
                        error = ["User's signup confirmation is required.", 'SIGNUP_CONFIRMATION_NEEDED'];
                    }
                    else if (err.code === "TooManyRequestsException" || err.code === "LimitExceededException") {
                        error = ['Too many attempts. Please try again later.', 'REQUEST_EXCEED'];
                    }

                    let errCode = error[1];
                    let errMsg = error[0];
                    let customErr = error[0].split('#');

                    // "#INVALID_REQUEST: the account has been blacklisted"
                    // "#NOT_EXISTS: the account does not exist"
                    // "#CONFIRM_REQUIRED": The account signup needs to be confirmed"

                    if (customErr.length > 1) {
                        customErr = customErr[customErr.length - 1].split(':');
                        errCode = customErr[0];
                        errMsg = customErr[1];
                        if (errCode === 'CONFIRM_REQUIRED') {
                            this.__request_signup_confirmation = username;
                            rej(new SkapiError("User's signup confirmation is required.", { code: 'SIGNUP_CONFIRMATION_NEEDED' }));
                            return;
                        }
                    }

                    rej(new SkapiError(errMsg, { code: errCode, cause: err }));
                }
            });
        });
    };

    const signup = (username: string, password: string, attributes: CognitoUserAttribute[]) => {
        return new Promise((res, rej) => {
            this.userPool.signUp(username, password, attributes, null, (err, result) => {
                if (err) {
                    rej(err);
                    return;
                }
                res(result);
                return;
            });
        })
    }

    return {
        getSession,
        authenticateUser,
        createCognitoUser,
        signup
    };
}

export async function getProfile(options?: { refreshToken: boolean; }): Promise<UserProfile | null> {
    await this.__authConnection;
    try {
        await authentication.bind(this)().getSession(Object.assign({ skipEventTrigger: true }, options));
        return this.user;
    } catch (err) {
        return null;
    }
}

export async function openIdLogin(params: { token: string; id: string; }): Promise<{ userProfile: UserProfile; openid: { [attribute: string]: string } }> {
    await this.__connection;
    params = validator.Params(params, {
        token: 'string',
        id: 'string'
    });

    let oplog = await request.bind(this)("openid-logger", params);
    let logger = oplog.logger.split('#');
    let username = this.service + '-' + logger[0];
    let password = logger[1];

    return { userProfile: await authentication.bind(this)().authenticateUser(username, password, true), openid: oplog.openid };
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

export async function _out(global: boolean = false) {
    let toReturn = null;
    if (cognitoUser) {
        if(global) {
            toReturn = new Promise((res, rej) => {
                cognitoUser.globalSignOut({
                    onSuccess: (result: any) => {
                        this.log('globalSignOut:success', result);
                        res(result);
                    },
                    onFailure: (err: any) => {
                        this.log('globalSignOut:error', err);
                        rej(err);
                    }
                });
            });
        }
        else {
            cognitoUser.signOut();
        }
    }

    let to_be_erased = {
        'session': null,
        '__startKeyHistory': {},
        '__cached_requests': {},
        '__user': null
    };

    if(toReturn) {
        toReturn = await toReturn;
    }

    for (let k in to_be_erased) {
        this[k] = to_be_erased[k];
    }

    this._runOnLoginListeners(null);
    return toReturn;
}

export async function logout(params?: Form<{ global:boolean; }>): Promise<'SUCCESS: The user has been logged out.'> {
    await this.__connection;

    let { data } = extractFormData(params);

    await _out.bind(this)(data?.global);
    return 'SUCCESS: The user has been logged out.';
}

export async function resendSignupConfirmation(): Promise<'SUCCESS: Signup confirmation E-Mail has been sent.'> {
    if (!this.__request_signup_confirmation) {
        throw new SkapiError('Least one login attempt is required.', { code: 'INVALID_REQUEST' });
    }

    let resend = await request.bind(this)("confirm-signup", {
        username: this.__request_signup_confirmation,
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
    return 'SUCCESS: Recovery e-mail has been sent.';
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
    let params = validator.Params(form, {
        username: 'string',
        email: 'string',
        password: 'string'
    }, ['password']);

    await this.__authConnection;

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

    return await authentication.bind(this)().authenticateUser(params.username || params.email, params.password);

    // INVALID_REQUEST: the account has been blacklisted.
    // NOT_EXISTS: the account does not exist.
}

export async function signup(
    form: Form<UserAttributes & { email: String; password: String; username?: string; }>,
    option?: {
        signup_confirmation?: boolean | string;
        email_subscription?: boolean;
        login?: boolean;
    }): Promise<UserProfile | "SUCCESS: The account has been created. User's signup confirmation is required." | 'SUCCESS: The account has been created.'> {

    await this.__authConnection;

    let paramRestrictions = {
        username: 'string',
        password: (v: string) => validator.Password(v),

        email: (v: string) => validator.Email(v),
        name: 'string',
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
        gender: 'string',
        birthdate: (v: string) => v ? validator.Birthdate(v) : "",
        phone_number: (v: string) => v ? validator.PhoneNumber(v) : "",

        email_public: ['boolean', () => false],
        address_public: ['boolean', () => false],
        gender_public: ['boolean', () => false],
        birthdate_public: ['boolean', () => false],
        phone_number_public: ['boolean', () => false],
        access_group: 'number', // v=>{if(v > 0 && v < 100) return v else throw SkapiError(...)}
        misc: 'string',

        picture: (v: string) => { if (v) return validator.Url(v); else return "" },
        profile: (v: string) => { if (v) return validator.Url(v); else return "" },
        family_name: 'string',
        given_name: 'string',
        middle_name: 'string',
        nickname: 'string',
        website: (v: string) => { if (v) return validator.Url(v); else return "" },
    };

    let params = validator.Params(form || {}, paramRestrictions, ['email', 'password']);

    // always logout before creating an account (for users)
    await logout.bind(this)();

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
            let value = v;
            if (typeof v === 'string') {
                value = validator.Url(v);
            }
            else if (typeof v === 'boolean') {
                value = v;
            }
            else {
                throw new SkapiError('"option.signup_confirmation" should be type: <string | boolean>.', { code: 'INVALID_PARAMETER' });
            }

            if (value && !params.email) {
                throw new SkapiError('"email" is required for signup confirmation.', { code: 'INVALID_PARAMETER' });
            }

            return value;
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

    params.signup_confirmation = option?.signup_confirmation || false;;
    params.email_subscription = option?.email_subscription || false;

    if (params.email_public && !params.signup_confirmation) {
        throw new SkapiError('"option.signup_confirmation" should be true if "email_public" is set to true.', { code: 'INVALID_PARAMETER' });
    }

    // cognito signup process below

    params.service = this.service;
    params.owner = this.owner;

    // user creating account
    let newUser = authentication.bind(this)().createCognitoUser(params.username || params.email);

    for (let k of ['email_public',
        'address_public',
        'gender_public',
        'birthdate_public',
        'phone_number_public']) {
        params[k] = params[k] ? '1' : '0';
    }

    if (params.access_group) {
        params.access_group = params.access_group.toString();
    }

    let signup_key = (await request.bind(this)('signupkey', {
        username: newUser.cognitoUsername,
        signup_confirmation: typeof params.signup_confirmation === 'boolean' ? JSON.stringify(params.signup_confirmation) : params.signup_confirmation,
        email_subscription: params.email_subscription,
    })).split(':');

    let signup_ticket = signup_key.slice(1).join(':');

    let attributeList = [
        new CognitoUserAttribute({
            Name: 'custom:signup',
            Value: signup_key[0]
        }),
        new CognitoUserAttribute({
            Name: 'locale',
            Value: signup_ticket.split('#')[1]
        }),
        new CognitoUserAttribute({
            Name: 'custom:signup_ticket',
            Value: signup_ticket
        })
    ];

    for (let k in paramRestrictions) {
        let customParams = [
            'email_public',
            'address_public',
            'gender_public',
            'birthdate_public',
            'phone_number_public',
            'misc',
            'service',
            'owner'
        ];
        if (params[k] === "") {
            continue;
        }

        if (k === 'username' || k === 'password' || k === 'access_group') {
            continue;
        }

        if (customParams.includes(k)) {
            attributeList.push(new CognitoUserAttribute({
                Name: 'custom:' + k,
                Value: params[k]
            }));
        }
        else {
            attributeList.push(new CognitoUserAttribute({
                Name: k,
                Value: params[k]
            }));
        }
    }

    await authentication.bind(this)().signup(newUser.cognitoUsername, params.password, attributeList);

    if (params.signup_confirmation) {
        cognitoUser = newUser.cognitoUser;
        this.__request_signup_confirmation = newUser.cognitoUsername;
        return "SUCCESS: The account has been created. User's signup confirmation is required.";
    }
    else if (logUser) {
        // log user in
        return login.bind(this)({ email: params.username || params.email, password: params.password });
    }

    return 'SUCCESS: The account has been created.';
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
        let cognitoUser = authentication.bind(this)().createCognitoUser(params.email).cognitoUser;

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

export function verifyPhoneNumber(form?: Form<{ code: string; }>): Promise<string> {
    // 'SUCCESS: Verification code has been sent.' | 'SUCCESS: "phone_number" is verified.'
    return verifyAttribute.bind(this)('phone_number', form);
}

export function verifyEmail(form?: Form<{ code: string; }>): Promise<string> {
    // 'SUCCESS: Verification code has been sent.' | 'SUCCESS: "email" is verified.'
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
        let cognitoUser = authentication.bind(this)().createCognitoUser(params.email).cognitoUser;
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
        user_id: (v: string) => validator.UserId(v),
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
        family_name: 'string',
        given_name: 'string',
        middle_name: 'string',
        nickname: 'string',
        website: (v: string) => v ? validator.Url(v) : "",
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

    if (params.user_id) {
        let user_id = params.user_id;
        if(user_id === this.user.user_id) {
            delete params.user_id;
        }
        else {
            return request.bind(this)('admin-edit-profile', {attributes: params}, { auth: true });
        }
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
        value: string | number | boolean | string[];
        condition?: '>' | '>=' | '=' | '<' | '<=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte';
        range?: string | number | boolean;
    },
    fetchOptions?: FetchOptions): Promise<DatabaseResponse<PublicUser>> {

    params = extractFormData(params).data as any;

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

    await this.__connection;

    const searchForTypes = {
        'user_id': (v: string) => {
            if (Array.isArray(v)) {
                return v.map(id => validator.UserId(id));
            }
            return validator.UserId(v)
        },
        'email': 'string',
        'phone_number': 'string',
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
        'approved': 'string'
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
                return checker(v);
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

    if (params.searchFor === 'user_id' && (params.condition !== '=' || params.range)) {
        throw new SkapiError(`Conditions are not allowed on "${params.searchFor}"`, { code: 'INVALID_PARAMETER' });
    }

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

// export async function registerSenderEmail(params: Form<{
//     email_alias: string;
// }>): Promise<"SUCCESS: Sender e-mail has been registered." | "ERROR: Email contains special characters." | "ERROR: Email is required."> {
//     await this.__connection;

//     if (!this.session) {
//         throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
//     }
//     let emailAlias: string;

//     let user_params = extractFormData(params)

//     params = user_params.data;

//     // if (params instanceof FormData) {
//     //     emailAlias = params.get('email_alias') as string;
//     // } else
    
//     if (params && 'email_alias' in params) {
//         emailAlias = params.email_alias;
//     } else {
//         emailAlias = '';
//     }

//     if (!emailAlias) {
//         throw new SkapiError('Email is required.', { code: 'INVALID_PARAMETER' });
//     }

//     const specialCharPattern = /[!#$%^&*(),?":{}|<>]/g;
//     if (specialCharPattern.test(emailAlias)) {
//         throw new SkapiError('Email contains special characters.', { code: 'INVALID_PARAMETER' });
//     }

//     let response = await request.bind(this)('register-sender-email', { email_alias: emailAlias});
//     return response;
// }