import SkapiError from '../main/error';
import { ensureKeyring, clearEncryptionState, encState, rewrapForPasswordChange, pruneKeyringWraps } from './encryption';
import {
    CognitoUserAttribute,
    CognitoUser,
    AuthenticationDetails,
    CognitoUserSession,
    CognitoIdToken,
    CognitoAccessToken,
    CognitoRefreshToken
} from 'amazon-cognito-identity-js';
import {
    Form,
    UserProfile,
    FetchOptions,
    DatabaseResponse,
    UserAttributes,
    UserPublic,
    Ticket,
    TicketCondition,
    TicketAction,
    TicketConditionRow
} from '../Types';
import validator from '../utils/validator';
import { request } from '../utils/network';
import { MD5, extractFormData, fromBase62, parseUserAttributes } from '../utils/utils';

let cognitoUser: CognitoUser | null = null;

function map_ticket_obj(t): {
    ticket_id?: string;
    consume_id?: string;
    user_id?: string;
    is_test?: boolean;
    timestamp?: number;
    updated?: number;
    condition?: any;
    actions?: any;
    action?: any;
    count?: number;
    time_to_live?: number;
    description?: string;
    limit_per_user?: number | boolean;
    hash?: string;
    failed?: boolean;
} {
    let mapper = {
        "tkid": 'ticket_id',
        "cond": 'condition',
        "stmp": 'timestamp',
        "upd": 'updated',
        "acts": 'actions',
        "actn": 'action',
        "cnt": 'count',
        "ttl": 'time_to_live',
        'plch': 'placeholder',
        'hash': 'hash',
        'desc': 'description',
        'pmc': 'limit_per_user',
        'fail': 'failed'
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
            // "#<ticket_id>#<consume_id>#<user>": only the first three "#" delimit
            new_obj['user_id'] = tkid.slice(3).join('#');

            // last 4 characters are random chars
            let rand = tkid[2].slice(-4);
            new_obj["is_test"] = rand === ":CHK";

            if (!t.stmp) {
                let timestampStr = tkid[2].slice(0, -4);

                // check if timestampStr is a number string
                if (/^[0-9]+$/.test(timestampStr)) {
                    new_obj['timestamp'] = parseInt(timestampStr, 10);
                }
                else {
                    new_obj['timestamp'] = fromBase62(tkid[2].slice(0, -4));
                }
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

export async function consumeTicket(params: {
    ticket_id: string;
    method: string; // GET | POST
    auth?: boolean;
    data?: {
        [key: string]: any;
    }
}): Promise<{
    ticket_id: string;
    consume_id: string;
    user_id: string;
    is_test: boolean;
    timestamp: number;
    hash: string;
}> {
    if (!params?.ticket_id) {
        throw new SkapiError('Ticket ID is required.', { code: 'INVALID_PARAMETER' });
    }
    // The id becomes a path segment: "#", "!", "/" and "?" are reserved and would change the route.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(params.ticket_id)) {
        throw new SkapiError('Invalid "ticket_id". Use letters, digits, "_" and "-" (up to 64 chars, starting with a letter or digit).', { code: 'INVALID_PARAMETER' });
    }
    if (!params.method) {
        throw new SkapiError('Method is required. Should be either "GET" or "POST"', { code: 'INVALID_PARAMETER' });
    }

    let method = String(params.method).toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
        throw new SkapiError('Method should be either "GET" or "POST".', { code: 'INVALID_PARAMETER' });
    }

    let auth = !!params.auth;
    if (auth && method === 'GET') {
        throw new SkapiError('Signed-in consumption is POST only.', { code: 'INVALID_PARAMETER' });
    }

    await this.__connection;

    // The short routes carry only the service: the owner is looked up server side.
    // /tpa/ sends the user's token, /tp/ and /tg/ are open.
    let route = auth ? 'tpa' : method === 'GET' ? 'tg' : 'tp';
    let url = `https://${this.service.slice(0, 4)}.${this.customApiDomain}/${route}/${this.service}/${params.ticket_id}`;

    // ignoreService: the body (or query string) is the ticket's data root, so the
    // service/owner keys request() would otherwise merge in must not land in it.
    let body = await request.bind(this)(url, params.data || {}, { method, auth }, { ignoreService: true });

    // A return200 ticket answers a failed consumption with HTTP 200, so the status
    // says nothing: an error body always has "stage", a success body never does.
    if (body && typeof body === 'object' && body.stage) {
        throw new SkapiError(body.message, { code: body.code, cause: body });
    }

    // Only an object is a consumption row to map; the check route answers a JSON string.
    if (!body || typeof body !== 'object') {
        return body;
    }

    return map_ticket_obj(body) as any;
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

// Project owner (or a Skapi super master) only. A registration is a full replace of the
// ticket; only its creation time survives. Used by the dashboard and the internal tool.
export async function registerTicket(
    params: {
        /** ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ */
        ticket_id: string;
        /** Up to 500 characters. */
        description?: string;
        /** Key absent = keep the stored count (a first registration is then unlimited). null = unlimited. An int >= 0 = the remaining count. */
        count?: number | null;
        /** true or 1 = once per user, n = n times, false or 0 = unlimited. */
        limit_per_user?: boolean | number;
        /** Absolute expiry in ms since epoch, must be in the future. null = never. */
        time_to_live?: number | null;
        condition?: TicketCondition;
        /** At most 50 actions in the whole tree, nested at most 8 deep. [] is stored as none. */
        actions?: TicketAction[];
        /** Legacy. Converted to `actions` on write, one action per key in this order: request, update_service, access_group, record_access. */
        action?: {
            access_group?: number;
            record_access?: string;
            request?: {
                url: string;
                method?: 'GET' | 'POST';
                headers?: {
                    [key: string]: string;
                };
                data?: Record<string, any>;
                params?: Record<string, any>;
                match?: TicketConditionRow[];
            };
            update_service?: { [key: string]: any };
        };
        /** Legacy `{ NAME: "<path>" }`. Converted to capture-only condition rows on write. */
        placeholder?: { [key: string]: string };
    }
): Promise<{ message: string; ticket: Ticket }> {
    let resp = await request.bind(this)('register-ticket', Object.assign({ exec: 'reg' }, params), { auth: true });
    // The ticket comes back as the raw issue row, the shape getTickets() maps.
    if (resp && typeof resp === 'object' && resp.ticket) {
        resp.ticket = map_ticket_obj(resp.ticket);
    }
    return resp;
}

export async function unregisterTicket(
    params: {
        ticket_id: string;
    }
): Promise<string> {
    return request.bind(this)('register-ticket', Object.assign({ exec: 'unreg' }, params), { auth: true });
}

// Refresh a token that is merely ABOUT to expire, not only one that already has.
//
// Without a margin, a token with seconds left is handed out as valid — and a token
// is not always used at the moment it is fetched. A queued request carries it to a
// server that runs it minutes later, and a background job (indexing a large file)
// replays that same stored token for the whole run. Those are the calls that die of
// old age, holding a credential this client could trivially have refreshed first.
//
// An hour, because that is the scale of the work a token gets handed to, and it
// costs at most one extra refresh per token: the replacement is good for a day.
const TOKEN_REFRESH_SKEW_SECONDS = 60 * 60;

export async function getJwtToken() {
    await this.__connection;
    // if (this.bearerToken) {
    //     return this.bearerToken;
    // }
    if (this.session) {
        const currentTime = Math.floor(Date.now() / 1000);
        const idToken = this.session.getIdToken();
        const idTokenExp = idToken.getExpiration();

        if (idTokenExp < currentTime + TOKEN_REFRESH_SKEW_SECONDS) {
            this.log('request:requesting new token', null);
            try {
                await authentication.bind(this)().getSession({ refreshToken: true });
                this.log('request:received new tokens', {
                    exp: this.session?.idToken?.payload?.exp,
                    currentTime,
                    expiresIn: idTokenExp - currentTime,
                    token: this.session?.accessToken?.jwtToken,
                    refreshToken: this.session?.refreshToken?.token
                });
            }
            catch (err) {
                this.log('request:new token error', err);
                throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
            }
        }
        else {
            this.log('request:tokens', {
                exp: this.session.idToken.payload.exp,
                currentTime,
                expiresIn: idTokenExp - currentTime,
                token: this.session.accessToken.jwtToken,
                refreshToken: this.session.refreshToken.token
            });
        }
        // this.bearerToken = this.session?.idToken?.jwtToken;
        return this.session?.idToken?.jwtToken;
    }
    else {
        this.log('request:no session', null);
        _out.bind(this)();
        throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
    }
}

function refreshSession(session, cognitoUser) {
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

    const getSession = async (option?: { skipUserUpdateEventTrigger?: boolean; refreshToken?: boolean; }): Promise<CognitoUserSession> =>
        new Promise((res, rej) => {
            // fetch session, updates user attributes
            this.log('getSession:option', option);
            let { refreshToken = false, skipUserUpdateEventTrigger = false } = option || {};
            if (refreshToken && skipUserUpdateEventTrigger) {
                skipUserUpdateEventTrigger = false;
            }

            // if (!this.bearerToken) {
            cognitoUser = this.userPool.getCurrentUser();
            // }
            if (!cognitoUser) {
                this.log('getSession:cognitoUser', cognitoUser);
                // no user session. wasn't logged in.
                _out.bind(this)();
                rej(null);
                return;
            }

            let respond = (s: any) => {
                let sessionAttribute = s.getIdToken().payload;
                this.log('getSession:respond:sessionAttribute', sessionAttribute);

                if (sessionAttribute['custom:service'] !== this.service) {
                    this.log('getSession:respond', 'invalid service, signing out');
                    _out.bind(this)();
                    throw new SkapiError('Invalid session.', { code: 'INVALID_REQUEST' });
                }

                this.session = s;
                getUserProfile();
                if (!skipUserUpdateEventTrigger) {
                    this._runOnUserUpdateListeners(this.user);
                }
                return this.session;
            }

            cognitoUser.getSession((err: any, session: CognitoUserSession) => {
                this.log('getSession:getSessionCallback', { err, session });
                if (!session) {
                    _out.bind(this)();
                    rej(new SkapiError('Current session does not exist.', { code: 'INVALID_REQUEST' }));
                    return;
                }

                if (err) {
                    refreshSession.bind(this)(session, cognitoUser).then(r => res(respond(r))).catch(rej);
                    return;
                }

                const currentTime = Math.floor(Date.now() / 1000);
                const idToken = session.getIdToken();
                const idTokenExp = idToken.getExpiration();
                const isExpired = idTokenExp < currentTime;
                this.log('getSession:currentTime', currentTime);
                this.log('getSession:idTokenExp', idTokenExp);
                this.log('getSession:isExpired', isExpired);
                // if(this.bearerToken) {
                this.log('getSession:existingBearerToken', this.bearerToken);
                this.bearerToken = idToken.getJwtToken();
                // }
                // try refresh when invalid token
                // when on updateProfile, it will always refreshToken
                if (isExpired || refreshToken || !session.isValid()) {
                    refreshSession.bind(this)(session, cognitoUser).then(r => res(respond(r))).catch(rej);
                }
                else {
                    try {
                        res(respond(session));
                    }
                    catch (err) {
                        rej(err);
                    }
                }
            });
        });

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

    const authenticateUser = (email: string, password: string, raw: boolean = false, is_openid: boolean = false): Promise<UserProfile> => {
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
                    if (userAttributes['custom:signup_ticket'] === 'PASS' || userAttributes['custom:signup_ticket'] === 'MEMBER' || userAttributes['custom:signup_ticket'] === 'OIDPASS') {
                        // auto confirm - (setting password from admin created account)
                        initUser.cognitoUser.completeNewPasswordChallenge(password, {}, {
                            onSuccess: _ => {
                                cognitoUser = initUser.cognitoUser;
                                getSession().then(async session => {
                                    if (encState.call(this)) {
                                        try {
                                            await ensureKeyring.bind(this)(password);
                                        } catch (err) {
                                            this.log('encryption:ensureKeyring:failed', err);
                                        }
                                    }
                                    res(this.user);
                                });
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
                onSuccess: _ => getSession({ skipUserUpdateEventTrigger: true }).then(async _ => {
                    this.__disabledAccount = null;
                    // Login is the one moment the plaintext password exists on
                    // the client, so it is the only place a password-derived key
                    // can be built. Must never reject the login: a failure here
                    // leaves the session locked and unlockEncryption() can retry.
                    if (encState.call(this)) {
                        try {
                            await ensureKeyring.bind(this)(password);
                        } catch (err) {
                            this.log('encryption:ensureKeyring:failed', err);
                        }
                    }
                    this._runOnLoginListeners(this.user);
                    this._runOnUserUpdateListeners(this.user);
                    res(this.user);
                }),
                onFailure: (err: any) => {
                    let error = [];
                    let { parsed, code } = cognitoErrorParser(err);
                    let cognitoMessage = typeof err?.message === 'string' ? err.message : '';

                    if (code === "NotAuthorizedException") {
                        if (cognitoMessage.includes("User is disabled.")) {
                            this.__disabledAccount = username;
                            error = ['This account is disabled.', 'USER_IS_DISABLED'];
                        }

                        else {
                            if (is_openid) {
                                error = ['The account already exists.', 'ACCOUNT_EXISTS'];
                            }
                            else {
                                error = ['Incorrect username or password.', 'INCORRECT_USERNAME_OR_PASSWORD'];
                            }
                        }
                    }
                    else if (code === "UserNotFoundException") {
                        error = ['Incorrect username or password.', 'INCORRECT_USERNAME_OR_PASSWORD'];
                    }
                    else if (code === "UserNotConfirmedException") {
                        this.__request_signup_confirmation = username;
                        error = ["User's signup confirmation is required.", 'SIGNUP_CONFIRMATION_NEEDED'];
                    }
                    else if (code === "TooManyRequestsException" || code === "LimitExceededException") {
                        error = ['Too many attempts. Please try again later.', 'REQUEST_EXCEED'];
                    }

                    if (parsed.code === 'SIGNUP_CONFIRMATION_NEEDED') {
                        this.__request_signup_confirmation = username;
                    }

                    if (error.length) {
                        let errCode = error[1];
                        let errMsg = error[0];

                        // "#INVALID_REQUEST: The account has been blacklisted."
                        // "#NOT_EXISTS: The account does not exist."
                        // "#SIGNUP_CONFIRMATION_NEEDED": The account signup needs to be confirmed."
                        // "#ACCOUNT_EXISTS": The account already exists."

                        rej(new SkapiError(errMsg, { code: errCode, cause: err }));
                    }
                    else {
                        rej(parsed);
                    }

                    return;
                }
            });
        });
    };

    const signup = (username: string, password: string, attributes: CognitoUserAttribute[]) => {
        return new Promise((res, rej) => {
            this.userPool.signUp(username, password, attributes, null, (err, result) => {
                if (err) {
                    let { parsed, code } = cognitoErrorParser(err);
                    let error = [];
                    if (code === 'UsernameExistsException') {
                        error = ['The account already exists.', 'EXISTS'];
                    }
                    else if (code === 'InvalidPasswordException') {
                        error = ['Invalid password. Password must be at least 6 characters.', 'INVALID_PARAMETER'];
                    }
                    else if (code === 'InvalidParameterException') {
                        error = [parsed.message || 'Invalid parameter.', 'INVALID_PARAMETER'];
                    }
                    else if (code === 'TooManyRequestsException' || code === 'LimitExceededException') {
                        error = ['Too many attempts. Please try again later.', 'REQUEST_EXCEED'];
                    }
                    else if (code === 'CodeDeliveryFailureException') {
                        error = ['Failed to deliver verification code.', 'CODE_DELIVERY_FAILURE'];
                    }
                    else if (code === 'UserLambdaValidationException') {
                        // The pre_signup trigger refuses a login ID that already signs in
                        // another account (an e-mail held as a username account's e-mail
                        // alias) with "#EXISTS: ...". That is the same condition Cognito
                        // itself reports as UsernameExistsException, so it keeps code EXISTS
                        // instead of turning into INVALID_REQUEST. Every other trigger
                        // refusal is still INVALID_REQUEST.
                        error = [parsed.message || 'Signup validation failed.', parsed.code === 'EXISTS' ? 'EXISTS' : 'INVALID_REQUEST'];
                    }

                    if (error.length) {
                        rej(new SkapiError(error[0], { code: error[1], cause: err }));
                    } else {
                        rej(parsed);
                    }

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
function cognitoErrorParser(err) {
    let original_code = typeof err?.code === 'string' && err.code.trim() ? err.code.trim() : 'ERROR';

    let raw_message =
        typeof err?.message === 'string'
            ? err.message
            : (typeof err === 'string' ? err : 'An error occurred.');

    let err_msg = (raw_message || 'An error occurred.').trim();
    if (!err_msg) {
        err_msg = 'An error occurred.';
    }

    // format: random text, #ERROR_CODE: Error message.
    let custom = err_msg.match(/#([A-Za-z0-9_]+)\s*:\s*([\s\S]+)/);
    let err_code = custom?.[1]?.trim() || original_code;
    let err_msg_custom = custom?.[2]?.trim() || err_msg;

    return {
        parsed: new SkapiError(err_msg_custom, { code: err_code, cause: err }),
        code: original_code,
    }
}
export async function getProfile(options?: { refreshToken: boolean; }): Promise<UserProfile | null> {
    await this.__authConnection;
    let refreshToken = options?.refreshToken || false;
    if (!refreshToken) {
        return this.user;
    }
    try {
        // Always trigger live session refresh if refreshToken is true
        await authentication.bind(this)().getSession(Object.assign({ skipUserUpdateEventTrigger: !refreshToken, refreshToken }, options));
        return this.user;
    } catch (err) {
        return null;
    }
}

export async function openIdLogin(params: {
    token: string;
    id: string;
    /**
     * Merges this OpenID identity into the existing account whose ORIGINAL login
     * ID (its username, or the e-mail it was created with when it has none) is
     * this OpenID account's login ID. `true` merges; an array of OpenID attribute
     * names also copies those attributes to the account. Merging replaces the
     * account's password.
     *
     * Never merges through an e-mail login alias: when this OpenID account's login
     * ID reaches an account only through its e-mail login (an account created with
     * a username, or one whose e-mail was changed to it), openIdLogin() fails with
     * EXISTS, with or without merge.
     */
    merge?: boolean | string[];
    template?: {
        /** message_id of the template to use for the welcome e-mail (sent the first time this OpenID user account is created). */
        welcome?: string;
    };
}): Promise<{ userProfile: UserProfile; openid: { [attribute: string]: string } }> {
    await this.__connection;

    params = validator.Params(params, {
        token: 'string',
        id: 'string',
        merge: v => {
            if (v === undefined) return false;
            if (typeof v === 'string') {
                return [v]
            }
            if (Array.isArray(v)) {
                for (let item of v) {
                    if (typeof item !== 'string') {
                        throw new SkapiError('"merge" array items should be type: <string>.', { code: 'INVALID_PARAMETER' });
                    }
                }
            }
            if (typeof v !== 'boolean' && !Array.isArray(v)) {
                throw new SkapiError('"merge" should be type: <boolean | string[]>.', { code: 'INVALID_PARAMETER' });
            }
            return v;
        },
        template: (v: { welcome?: string }) => {
            if (typeof v !== 'object' || v === null) {
                throw new SkapiError('"template" should be type: <object>.', { code: 'INVALID_PARAMETER' });
            }
            if (v.welcome !== undefined) {
                if (typeof v.welcome !== 'string' || !v.welcome) {
                    throw new SkapiError('"template.welcome" should be a non-empty <string> (template message_id).', { code: 'INVALID_PARAMETER' });
                }
            }
            return v;
        }
    });

    let payload: any = { token: params.token, id: params.id, merge: params.merge };
    if ((params as any).template?.welcome) {
        payload.template_welcome = (params as any).template.welcome;
    }

    let oplog = await request.bind(this)("openid-logger", payload);
    let logger = oplog.logger.split('#');
    let username = this.service + '-' + logger[0];
    let password = logger[1];

    return { userProfile: await authentication.bind(this)().authenticateUser(username, password, true, true), openid: oplog.openid };
}

// Get user info from base64 encoded token
function decodeBase64Utf8(base64: string): string {
    const root = typeof globalThis !== 'undefined' ? (globalThis as any) : undefined;

    if (root?.Buffer) {
        return root.Buffer.from(base64, 'base64').toString('utf8');
    }

    if (typeof atob === 'function') {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder().decode(bytes);
        }

        return binary;
    }

    throw new Error('No base64 decoder available in this environment');
}

function getUserFromToken(accessToken) {
    // JWT has 3 parts: header.payload.signature
    const parts = accessToken.split('.');
    if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
    }

    // Decode the payload (second part) - use base64url decoding
    const payload = parts[1];
    // Replace base64url chars with standard base64 chars
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = decodeBase64Utf8(base64);
    const userData = JSON.parse(decoded);
    return userData;
}

export async function loginWithToken(params: {
    idToken: string;
    accessToken?: string;
    refreshToken?: string;
}): Promise<UserProfile> {
    await this.__authConnection;
    this.log('loginWithToken:params', params);
    params = validator.Params(params, {
        idToken: 'string',
        accessToken: 'string',
        refreshToken: 'string'
    }, ['idToken']);

    // Store the bearer token for authenticated requests
    const idTokenPayload = getUserFromToken(params.idToken);
    this.log('loginWithToken:idTokenPayload', idTokenPayload);
    // Validate the token belongs to this service
    if (idTokenPayload['custom:service'] !== this.service) {
        throw new SkapiError('Token does not belong to this service.', { code: 'INVALID_REQUEST' });
    }

    // Check if token is expired
    const currentTime = Math.floor(Date.now() / 1000);
    if (idTokenPayload.exp && idTokenPayload.exp < currentTime) {
        throw new SkapiError('Token has expired.', { code: 'INVALID_REQUEST' });
    }

    // this.bearerToken = params.idToken;
    // Parse user attributes from the token payload
    this.__user = parseUserAttributes(idTokenPayload);

    this.session = null;

    if (params.accessToken && params.refreshToken) {
        try {
            this.session = new CognitoUserSession({
                IdToken: new CognitoIdToken({ IdToken: params.idToken }),
                AccessToken: new CognitoAccessToken({ AccessToken: params.accessToken }),
                RefreshToken: new CognitoRefreshToken({ RefreshToken: params.refreshToken })
            });

            this.log('loginWithToken:session', this.session);
            this.log('loginWithToken:CognitoUser', CognitoUser);
            this.log('loginWithToken:userPool', this.userPool);
            // Restore cognitoUser in memory for Node.js/server context
            if (CognitoUser && this.userPool) {
                this.log('loginWithToken:cognito:username', idTokenPayload['cognito:username']);
                let up = {
                    Username: idTokenPayload['cognito:username'],
                    Pool: this.userPool
                }
                this.log('loginWithToken:cognitoUserParams', up);
                cognitoUser = new CognitoUser(up);
                cognitoUser.setSignInUserSession(this.session);
                this.log('loginWithToken:cognitoUserRestored', {
                    cognitoUserType: typeof cognitoUser,
                    cognitoUserKeys: Object.keys(cognitoUser || {}),
                    cognitoUser
                });
            }
        }
        catch (err: any) {
            // Enhanced error logging: log all property names, symbols, and descriptors
            this.log('loginWithToken:err', err);
            try {
                this.log('loginWithToken:err:stringified', JSON.stringify(err));
            } catch (e) {
                this.log('loginWithToken:err:stringifyFail', String(err));
            }
            try {
                const keys = Object.keys(err || {});
                const symbols = Object.getOwnPropertySymbols ? Object.getOwnPropertySymbols(err || {}) : [];
                const descriptors = Object.getOwnPropertyDescriptors ? Object.getOwnPropertyDescriptors(err || {}) : {};
                this.log('loginWithToken:createSessionError:allKeys', { keys, symbols, descriptors });
            } catch (e) {
                this.log('loginWithToken:createSessionError:allKeysFail', String(e));
            }
        }
    }

    this._runOnLoginListeners(this.user);
    this._runOnUserUpdateListeners(this.user);

    return this.user;
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
        if (global) {
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

    clearEncryptionState.bind(this)();

    let to_be_erased = {
        'session': null,
        '__startKeyHistory': {},
        '__cached_requests': {},
        '__user': null
    };

    if (toReturn) {
        toReturn = await toReturn;
    }

    for (let k in to_be_erased) {
        this[k] = to_be_erased[k];
    }

    this._runOnUserUpdateListeners(null);
    this._runOnLoginListeners(null);

    return toReturn;
}

export async function logout(params?: Form<{ global: boolean; }>): Promise<'SUCCESS: The user has been logged out.'> {
    await this.__connection;

    let { data } = extractFormData(params);

    await _out.bind(this)(data?.global);
    return 'SUCCESS: The user has been logged out.';
}

export async function resendSignupConfirmation(): Promise<'SUCCESS: Signup confirmation e-mail has been sent.'> {
    if (!this.__request_signup_confirmation) {
        throw new SkapiError('Least one login attempt is required.', { code: 'INVALID_REQUEST' });
    }

    let resend = await request.bind(this)("confirm-signup", {
        username: this.__request_signup_confirmation,
    });

    return resend; // 'SUCCESS: Signup confirmation e-mail has been sent.'
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
        /**
         * The account's permanent login username, when it was created with one.
         * Either this or the e-mail resolves the account.
         */
        username?: string;
        /**
         * The account's current login e-mail. 64 character max.
         * Required unless 'username' is given.
         */
        email: string;
        /** Password for signin. Should be at least 6 characters. */
        password: string;
    }>): Promise<UserProfile> {
        
    let params:any = validator.Params(form, {
        username: 'string',
        email: 'string',
        password: 'string'
    }, ['password']);

    await this.__authConnection;

    // The normalized (lowercased) form, kept aside rather than substituted. See
    // the fallback below for why it is not simply assigned over params.email.
    let normalizedEmail = null;

    if (params.email) {
        // incase user uses email instead of username
        try {
            normalizedEmail = validator.Email(params.email);
        } catch (err) {
            params.username = params.email;
            delete params.email;
        }
    }

    if (!params.username && !params.email) {
        throw new SkapiError('Least one of "username" or "email" is required.', { code: 'INVALID_PARAMETER' });
    }

    const typed = params.username || params.email;

    try {
        return await authentication.bind(this)().authenticateUser(typed, params.password);
    }
    catch (err: any) {
        // The e-mail alias is always md5(LOWERCASED e-mail), but an account whose
        // USERNAME happens to be an e-mail-shaped mixed-case string is resolved by
        // the raw string (signup does not lowercase 'username'). So the raw form is
        // tried first, and the normalized form only as a fallback: capitalising an
        // e-mail on a phone keyboard still signs in, and no existing account loses
        // the handle it already had.
        // Only retried for "no such user / bad credentials". A signup-confirmation
        // or disabled-account error means the account WAS found, so it stands.
        let retryable = err?.code === 'UserNotFoundException' || err?.code === 'NotAuthorizedException';

        if (retryable && normalizedEmail && normalizedEmail !== typed) {
            return await authentication.bind(this)().authenticateUser(normalizedEmail, params.password);
        }

        throw err;
    }
    // INVALID_REQUEST: the account has been blacklisted.
    // NOT_EXISTS: the account does not exist.
}

export async function signup(
    form: Form<UserAttributes & {
        /** Required. Always. */
        email: string;
        password: String;
        /**
         * Optional. When given it becomes the account's PERMANENT login username,
         * which always logs the account in and can never be changed. The e-mail also
         * logs the account in, but only once it is verified: opening the signup
         * confirmation link verifies it, and without signup confirmation the user
         * verifies it with verifyEmail() after logging in with the username. After an
         * e-mail change the new e-mail logs in once it is verified the same way.
         * E-mail login is not enabled while that e-mail is already another account's
         * login ID; the username still works.
         * Leave it out and the e-mail alone is the login ID.
         */
        username?: string;
    }>,
    option?: {
        signup_confirmation?: boolean | string;
        email_subscription?: boolean;
        login?: boolean;
        /**
         * Per-call e-mail template overrides.
         * Each value is the `message_id` of a template that the service owner
         * has previously uploaded via the Mail dashboard.
         */
        template?: {
            /** message_id of the template to use for the signup confirmation e-mail. */
            signup_confirmation?: string;
            /** message_id of the template to use for the welcome e-mail (sent on the user's first confirmed login). */
            welcome?: string;
        };
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
        },
        template: (v: { signup_confirmation?: string; welcome?: string }) => {
            if (typeof v !== 'object' || v === null) {
                throw new SkapiError('"option.template" should be type: <object>.', { code: 'INVALID_PARAMETER' });
            }
            if (v.signup_confirmation !== undefined) {
                if (typeof v.signup_confirmation !== 'string' || !v.signup_confirmation) {
                    throw new SkapiError('"option.template.signup_confirmation" should be a non-empty <string> (template message_id).', { code: 'INVALID_PARAMETER' });
                }
                if (!option?.signup_confirmation) {
                    throw new SkapiError('"option.signup_confirmation" is required when "option.template.signup_confirmation" is set.', { code: 'INVALID_PARAMETER' });
                }
            }
            if (v.welcome !== undefined) {
                if (typeof v.welcome !== 'string' || !v.welcome) {
                    throw new SkapiError('"option.template.welcome" should be a non-empty <string> (template message_id).', { code: 'INVALID_PARAMETER' });
                }
            }
            return v;
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
        template_confirmation: option?.template?.signup_confirmation || '',
        template_welcome: option?.template?.welcome || '',
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

    // An account created with a username also signs in with its e-mail, through the
    // pool's preferred_username alias. That alias is NOT sent here: Cognito does not
    // accept preferred_username during registration when it is an alias attribute, and
    // an alias is legitimate only for a verified e-mail, so the backend adds it once the
    // e-mail is verified (the signup confirmation link, or verifyEmail()). Until then only
    // the username signs in, and the alias is never added when the e-mail already signs
    // in another account (the backend checks before writing it).

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
                rej(new SkapiError(err?.message || 'Failed to reset password.', { code: err?.code || 'ERROR', cause: err }));
            }
        });
    });
}

async function verifyAttribute(attribute: string, form: Form<{ code: string; }>, options?: { template?: { verification?: string } }): Promise<string> {
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
            code: 'string'
        }) : {}).code || '';
    }
    else {
        return;
    }

    // Optional per-call template override for the verification e-mail.
    let clientMetadata: { [k: string]: string } | undefined;
    const verificationMid = options?.template?.verification;
    if (verificationMid !== undefined) {
        if (typeof verificationMid !== 'string' || !verificationMid) {
            throw new SkapiError('"template.verification" should be a non-empty <string> (template message_id).', { code: 'INVALID_PARAMETER' });
        }
        clientMetadata = { template_verification: verificationMid };
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
            cognitoUser?.getAttributeVerificationCode(attribute, callback, clientMetadata);
        }
    });
}

export function verifyPhoneNumber(form?: Form<{ code: string; }>, options?: { template?: { verification?: string } }): Promise<string> {
    // 'SUCCESS: Verification code has been sent.' | 'SUCCESS: "phone_number" is verified.'
    return verifyAttribute.bind(this)('phone_number', form, options);
}

export function verifyEmail(form?: Form<{ code: string; }>, options?: { template?: { verification?: string } }): Promise<string> {
    // 'SUCCESS: Verification code has been sent.' | 'SUCCESS: "email" is verified.'
    return verifyAttribute.bind(this)('email', form, options);
}

export async function forgotPassword(
    form: Form<{
        /** Signin E-Mail. */
        email: string;
    }>,
    options?: {
        template?: {
            /** message_id of the template to use for the password-reset verification e-mail. */
            verification?: string;
        };
    }): Promise<"SUCCESS: Verification code has been sent."> {

    await this.__connection;

    let params = validator.Params(form, {
        email: (v: string) => validator.Email(v)
    }, ['email']);

    let clientMetadata: { [k: string]: string } | undefined;
    const verificationMid = options?.template?.verification;
    if (verificationMid !== undefined) {
        if (typeof verificationMid !== 'string' || !verificationMid) {
            throw new SkapiError('"template.verification" should be a non-empty <string> (template message_id).', { code: 'INVALID_PARAMETER' });
        }
        clientMetadata = { template_verification: verificationMid };
    }

    return new Promise(async (res, rej) => {
        let cognitoUser = authentication.bind(this)().createCognitoUser(params.email).cognitoUser;
        cognitoUser.forgotPassword({
            onSuccess: result => {
                res("SUCCESS: Verification code has been sent.");
            },
            onFailure: (err: any) => {
                // create SkapiError from err
                /*
                UserNotFoundException	User does not exist in the user pool
                InvalidParameterException	Invalid parameter (e.g., missing required attribute)
                NotAuthorizedException	User is not authorized (e.g., user is disabled)
                LimitExceededException	Attempt limit exceeded, try again later
                TooManyRequestsException	Too many requests made to the API
                CodeDeliveryFailureException	Failed to deliver the verification code (email/SMS issue)
                UnexpectedLambdaException	Unexpected exception with Lambda trigger
                UserLambdaValidationException	User validation exception from Lambda trigger
                InvalidLambdaResponseException	Invalid response from Lambda trigger
                InvalidSmsRoleAccessPolicyException	Invalid SMS role access policy
                InvalidSmsRoleTrustRelationshipException	Invalid SMS role trust relationship
                InvalidEmailRoleAccessPolicyException	Invalid email role access policy
                ResourceNotFoundException	Resource not found (user pool doesn't exist)
                InternalErrorException	Internal server error
                ForbiddenException	WAF blocked the request
                */

                let { parsed, code } = cognitoErrorParser(err);

                let mappedCode = {
                    UserNotFoundException: 'NOT_EXISTS',
                    InvalidParameterException: 'INVALID_PARAMETER',
                    NotAuthorizedException: 'INVALID_REQUEST',
                    LimitExceededException: 'REQUEST_EXCEED',
                    TooManyRequestsException: 'REQUEST_EXCEED',
                    CodeDeliveryFailureException: 'CODE_DELIVERY_FAILURE'
                }[code] || parsed.code || code || 'ERROR';

                rej(new SkapiError(parsed.message, { code: mappedCode, cause: err }));
            }
        }, clientMetadata);
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

    // Re-wrap the encryption master key for the new password BEFORE Cognito
    // changes it. Order is load-bearing: the keyring must never be left holding
    // only a wrap under a password that no longer exists. Both wraps are valid
    // in between, and unlock tries each in turn, so a crash here is survivable.
    if (encState.call(this)) {
        await rewrapForPasswordChange.bind(this)(p.current_password, p.new_password);
    }

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
                        let { parsed, code } = cognitoErrorParser(err);
                        rej(parsed);
                    }
                    return;
                }

                // Now that the old password is gone, drop its wrap. Best
                // effort: a failure leaves a stale wrap that can still be
                // opened only by someone who already knows the old password.
                if (encState.call(this)) {
                    pruneKeyringWraps.bind(this)().catch(e => this.log('encryption:prune:failed', e));
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

    // No preferred_username is sent with a new e-mail. It is the pool's e-mail login alias,
    // and writing it here pointed login at an address the user had not verified, in the same
    // call as the e-mail and before any code was confirmed, so anyone could take the login
    // handle of an e-mail they do not own. Cognito writes the new e-mail unverified; the
    // backend gives the account that e-mail's login once verifyEmail() confirms it (the
    // session refresh that follows runs the server claim), and removes an alias the account's
    // own verified e-mail does not prove. A username, or the e-mail an account without one
    // was created with, always logs in.

    let collision = [
        ['email_public', 'email_verified', "User's e-mail should be verified to set"],
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
        if (user_id === this.user.user_id) {
            delete params.user_id;
        }
        else {
            return request.bind(this)('admin-edit-profile', { attributes: params }, { auth: true });
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
    fetchOptions?: FetchOptions): Promise<DatabaseResponse<UserPublic>> {

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
