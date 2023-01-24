import {
    CognitoUserPool,
    CognitoUserAttribute,
    CognitoUser,
    AuthenticationDetails,
    CognitoUserSession
} from 'amazon-cognito-identity-js';

import {
    RecordData,
    User,
    Form,
    FormCallbacks,
    UserProfile,
    PostRecordParams,
    FetchOptions,
    SubscriptionGroup,
    FetchResponse,
    GetRecordParams,
    QueryParams,
    Newsletters,
    Connection
} from './Types';
import SkapiError from './skapi_error';
import { formResponse } from './decorators';
import {
    checkParams,
    extractFormMetaData,
    validateUserId,
    validateBirthdate,
    validateEmail,
    validatePassword,
    validatePhoneNumber,
    validateUrl,
    normalize_record_data,
    checkWhiteSpaceAndSpecialChars,
    MD5
} from './utils';

export default class Skapi {
    // privates
    private cognitoUser: CognitoUser | null = null;
    private __disabledAccount: string | null = null;
    private __serviceHash: Record<string, string> = {};
    private __pendingRequest: Record<string, Promise<any>> = {};

    private __cached_requests: {
        /** Cached url requests */
        [url: string]: {
            /** Array of data stored in hashed params key */
            [hashedParams: string]: FetchResponse;
        };
    } = {};

    private __startKey_keys: {
        /** List of startkeys */
        [url: string]: {
            [hashedParams: string]: string[];
        };
    } = {};

    private __request_signup_confirmation: string | null = null;
    private __index_number_range = 4503599627370496; // +/-
    private service: string;
    private service_owner: string;

    // true when session is stored successfully to session storage
    // this property prevents duplicate stores when window closes on some device
    private __class_properties_has_been_cached = false;

    private session: Record<string, any> | null = null;
    origin: string = null;
    // public

    /** Current logged in user object. null if not logged. */
    __user: User | null = null;

    get user() {
        if (this.__user && Object.keys(this.__user).length) {
            return JSON.parse(JSON.stringify(this.__user));
        }
        else {
            return null;
        }
    }

    set user(value) {
        // setting user is bypassed
    }

    connection: Connection | null = null;
    host: string = 'skapi';
    hostDomain: string = 'skapi.com';
    userPool: CognitoUserPool | null = null;
    admin_endpoint: Promise<Record<string, any>>;
    record_endpoint: Promise<Record<string, any>>;

    validate = {
        userId(val: string) {
            try {
                validateUserId(val);
                return true;
            } catch (err) {
                return false;
            }
        },
        url(val: string | string[]) {
            try {
                validateUrl(val);
                return true;
            } catch (err) {
                return false;
            }
        },
        phoneNumber(val: string) {
            try {
                validatePhoneNumber(val);
                return true;
            } catch (err) {
                return false;
            }
        },
        birthdate(val: string) {
            try {
                validateBirthdate(val);
                return true;
            } catch (err) {
                return false;
            }
        },
        email(val: string) {
            try {
                validateEmail(val);
                return true;
            } catch (err) {
                return false;
            }
        }
    };

    __connection: Promise<Connection | null>;

    getConnection(): Promise<Connection | null> {
        return this.__connection;
    }

    // skapi int range -4503599627370545 ~ 4503599627370546

    constructor(service_id: string, service_owner: string, options?: { autoLogin: boolean; }) {
        if (typeof service_id !== 'string' || typeof service_owner !== 'string') {
            throw new SkapiError('"service_id" and "service_owner" should be type <string>.', { code: 'INVALID_PARAMETER' });
        }

        if (!service_id || !service_owner) {
            throw new SkapiError('"service_id" and "service_owner" is required', { code: 'INVALID_PARAMETER' });
        }

        if (service_owner !== this.host) {
            validateUserId(service_owner, '"service_owner"');
        }

        this.service = service_id;
        this.service_owner = service_owner;

        let autoLogin = options?.autoLogin || false;

        // get endpoints
        const cdn_domain = 'https://dkls9pxkgz855.cloudfront.net'; // don't change this
        let sreg = service_id.substring(0, 4);

        this.admin_endpoint = fetch(`${cdn_domain}/${sreg}/admin.json`)
            .then(response => response.blob())
            .then(blob => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            }))
            .then(data => typeof data === 'string' ? JSON.parse(window.atob(data.split(',')[1])) : null);

        this.record_endpoint = fetch(`${cdn_domain}/${sreg}/record.json`)
            .then(response => response.blob())
            .then(blob => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            }))
            .then(data => typeof data === 'string' ? JSON.parse(window.atob(data.split(',')[1])) : null);

        // connects to server
        this.__connection = (async (skapi: Skapi): Promise<Connection | null> => {
            if (!window.sessionStorage) {
                throw new Error(`This browser does not support skapi.`);
            }

            const restore = JSON.parse(window.sessionStorage.getItem(`${service_id}#${service_owner}`) || 'null');

            if (restore?.connection) {
                // apply all data to class properties
                for (let k in restore) {
                    skapi[k] = restore[k];
                }
            }

            const admin_endpoint = await skapi.admin_endpoint;

            skapi.userPool = new CognitoUserPool({
                UserPoolId: admin_endpoint.userpool_id,
                ClientId: admin_endpoint.userpool_client
            });

            const process: any[] = [];

            if (!restore?.connection) {
                // await for first connection
                process.push(skapi.updateConnection());
            }

            if (!restore?.connection && !autoLogin) {
                let currentUser = this.userPool?.getCurrentUser() || null;
                if (currentUser) {
                    currentUser.signOut();
                }
            }

            if (restore?.connection || autoLogin) {
                // session reload or autoLogin
                process.push(skapi.authentication().getSession({ refreshToken: !restore?.connection }).catch(err => {
                    skapi.__user = null;
                }));
            }

            let awaitProcess;
            if (process.length) {
                awaitProcess = await Promise.all(process);
            }

            const storeClassProperties = () => {
                if (skapi.__class_properties_has_been_cached) {
                    return;
                }

                let exec = () => {
                    let data: Record<string, any> = {};

                    const to_be_cached = [
                        '__startKey_keys', // startKey key : {}
                        '__cached_requests', // cached records : {}
                        '__request_signup_confirmation', // for resend signup confirmation : null
                        'connection', // service info : null
                    ];

                    if (skapi.connection) {
                        for (let k of to_be_cached) {
                            data[k] = skapi[k];
                        }

                        window.sessionStorage.setItem(`${service_id}#${service_owner}`, JSON.stringify(data));
                        skapi.__class_properties_has_been_cached = true;
                    }
                };

                return (awaitProcess instanceof Promise) ? awaitProcess.then(() => exec()) : exec();
            };

            // attach event to save session on close
            window.addEventListener('beforeunload', storeClassProperties);
            window.addEventListener("visibilitychange", storeClassProperties);

            return skapi.connection;

        })(this).catch(err => { throw err; });
    }

    private authentication() {
        if (!this.userPool) throw new SkapiError('User pool is missing', { code: 'INVALID_REQUEST' });

        const normalizeUserAttributes = (attr: any) => {
            let user: any = {};

            if (Array.isArray(attr)) {
                // parse attribute structure: [ { Name, Value }, ... ]
                let normalized_user_attribute_keys = {};
                for (let i of (attr as CognitoUserAttribute[])) {
                    normalized_user_attribute_keys[i.Name] = i.Value;

                    if (i.Name === 'custom:service' && normalized_user_attribute_keys[i.Name] !== this.service)
                        throw new SkapiError('The user is not registered to the service.', { code: 'INVALID_REQUEST' });
                }

                attr = normalized_user_attribute_keys;
            }

            for (let k in attr) {
                if (k.includes('custom:')) user[k.replace('custom:', '')] = attr[k];
                else user[k] = attr[k];
            }

            for (let k of [
                'address_public',
                'birthdate_public',
                'email_public',
                'email_subscription',
                'gender_public',
                'phone_number_public',
                'access_group'
            ]) {
                if (k.includes('_public')) {
                    if (user.hasOwnProperty(k.split('_')[0])) user[k] = user.hasOwnProperty(k) ? !!Number(user[k]) : false;
                    else delete user[k];
                }
                else if (k === 'email_subscription') user[k] = user.hasOwnProperty(k) ? !!Number(user[k]) : false;
                else user[k] = user.hasOwnProperty(k) ? Number(user[k]) : 0;
            }

            for (let k of [
                'email_verified',
                'phone_number_verified'
            ]) {
                if (user[k.split('_')[0]]) user[k] = user.hasOwnProperty(k) ? user[k] === 'true' : false;
                else if (user.hasOwnProperty(k)) delete user[k];
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

        const getUser = (): Promise<UserProfile> => {
            // get users updated attribute
            if (!this.session) return null;
            return new Promise((res, rej) => {
                let currentUser: CognitoUser | null = this.userPool?.getCurrentUser() || null;
                this.cognitoUser = currentUser;

                if (currentUser === null) rej(null);
                else {
                    currentUser.getUserAttributes((attrErr, attributes) => {
                        if (attrErr) rej(attrErr);
                        else {
                            normalizeUserAttributes(attributes);
                            res(this.user);
                        }
                    });
                }
            });
        };

        const getSession = (option?: {
            refreshToken?: boolean;
        }): Promise<CognitoUserSession> => {
            // fetch session, updates user attributes
            let { refreshToken = false } = option || {};

            return new Promise((res, rej) => {
                let currentUser: CognitoUser | null = this.userPool?.getCurrentUser() || null;
                this.cognitoUser = currentUser;

                if (currentUser === null) rej(null);
                currentUser.getSession((err: any, session: CognitoUserSession) => {
                    if (err) rej(err);

                    if (!session) rej(new SkapiError('Current session does not exist.', { code: 'INVALID_REQUEST' }));
                    // try refresh when invalid token
                    if (refreshToken || !session.isValid()) {
                        currentUser.refreshSession(session.getRefreshToken(), (refreshErr, refreshedSession) => {
                            if (refreshErr) rej(refreshErr);
                            else {
                                if (refreshedSession.isValid()) {
                                    this.session = refreshedSession;
                                    normalizeUserAttributes(refreshedSession.getIdToken().payload);
                                    res(refreshedSession);
                                }
                                else {
                                    rej(new SkapiError('Invalid session.', { code: 'INVALID_REQUEST' }));
                                }
                            }
                        });
                    } else {
                        this.session = session;
                        normalizeUserAttributes(session.getIdToken().payload);
                        res(session);
                    }
                });
            });
        };

        const createCognitoUser = async (email: string) => {
            if (!email) throw new SkapiError('E-Mail is required.', { code: 'INVALID_PARAMETER' });
            let hash = this.__serviceHash[email] || (await this.updateConnection({ request_hash: email })).hash;
            return {
                cognitoUser: new CognitoUser({
                    Username: hash,
                    Pool: this.userPool
                }),
                cognitoUsername: hash
            };
        };

        const authenticateUser = (email: string, password: string): Promise<User> => {
            return new Promise((res, rej) => {
                this.__request_signup_confirmation = null;
                this.__disabledAccount = null;

                createCognitoUser(email).then(initUser => {
                    this.cognitoUser = initUser.cognitoUser;
                    let username = initUser.cognitoUsername;

                    let authenticationDetails = new AuthenticationDetails({
                        Username: username,
                        Password: password
                    });

                    this.cognitoUser.authenticateUser(authenticationDetails, {
                        newPasswordRequired: (userAttributes, requiredAttributes) => {
                            this.__request_signup_confirmation = username;
                            rej(new SkapiError("User's signup confirmation is required.", { code: 'SIGNUP_CONFIRMATION_NEEDED' }));
                        },
                        onSuccess: (logged) => getSession().then(session => res(this.user)),
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

                            rej(new SkapiError(error[0], { code: error[1], cause: err }));
                        }
                    });
                });
            });
        };

        return { getSession, authenticateUser, createCognitoUser, getUser };
    }

    async getAccount() {
        await this.__connection;
        try {
            await this.authentication().getSession();
            return this.user;
        } catch (err) {
            return null;
        }
    }

    async checkAdmin() {
        await this.__connection;
        if (this.__user?.service === this.service) {
            // logged in
            return this.__user?.service_owner === this.host;
        } else {
            // not logged
            await this.logout();
        }

        return false;
    }

    async getBlob(params: { url: string; }, option?: { service: string; }): Promise<Blob> {

        let p = checkParams(params, {
            url: (v: string) => validateUrl(v)
        }, ['url']);

        return await this.request(p.url, option || null, { method: 'get', auth: p.url.includes('/auth/'), contentType: null, responseType: 'blob' });
    }

    async mock(data: any, options?: {
        fetchOptions?: FetchOptions & FormCallbacks;
        auth?: boolean;
        method?: string;
        meta?: Record<string, any>;
        bypassAwaitConnection?: boolean;
        responseType?: string;
        contentType?: string;
    }): Promise<{ mockResponse: Record<string, any>; }> {
        return this.request('mock', data, options);
    }

    /**
     * Sends post request to your custom server using Skapi's secure API layer.</br>
     * You must set your secret API key from the Skapi's admin page.</br>
     * On your server side, you must verify your secret API key.<br>
     * Skapi API layer can process your requests both synchronously and asynchronously.<br>
     * You can request multiple process using arrays.<br>
     * Skapi will process your requests in order.</br>
     * The sync process will be chained in order during process.<br>
     * Refer: <a href='www.google.com'>Setting secret api key</a>
     *
     * <h6>Example</h6>
     * 
     * ```
     * let call = await skapi.secureRequest(
     *     url: 'http://my.website.com/myapi',
     *     data: {
     *         some_data: 'Hello'
     *     }
     * )
     * 
     * console.log(call)
     * // {
     * //     response: <any>
     * //     statusCode: <number>
     * //     url: 'http://my.website.com/myapi'
     * // }
     * ```
     *
     * 
     * <h6>Nodejs Example</h6>
     * 
     * ```
     * const http = require('http');
     * http.createServer(function (request, response) {
     * if (request.url === '/myapi') {
     *     if (request.method === 'POST') {
     *         let body = '';
     * 
     *         request.on('data', function (data) {
     *             body += data;
     *         });
     * 
     *         request.on('end', function () {
     *             body = JSON.parse(body);
     *             console.log(body);
     *             // {
     *             //     user: {
     *             //         user_id: '',
     *             //         address: '',
     *             //         phone_number: '',
     *             //         email: '',
     *             //         name: '',
     *             //         locale: '',
     *             //         request_locale: ''
     *             //     },
     *             //     data: {
     *             //         some_data: 'Hello',
     *             //     },
     *             //     api_key: 'your api secret key'
     *             // }
     * 
     *             if (body.api_key && body.api_key === 'your api secret key') {
     *                 response.writeHead(200, {'Content-Type': 'text/html'});
     *                 // do something
     *                 response.end('success');
     *             } else {
     *                 response.writeHead(401, {'Content-Type': 'text/html'});
     *                 response.end("api key mismatch");
     *             }
     *         });
     *     }
     * }
     * }).listen(3000);
     * ```
     *
     * 
     * <h6>Python Example</h6>
     * 
     * ```
     * from http.server import BaseHTTPRequestHandler, HTTPServer
     * import json
     * 
     * class MyServer(BaseHTTPRequestHandler):
     * def do_request(self):
     *     if self.path == '/myapi':
     *         content_length = int(self.headers['Content-Length'])
     *         body = json.loads(self.rfile.read(content_length).decode('utf-8'))
     *         print(body)
     *         # {
     *         #     'user': {
     *         #         'user_id': '',
     *         #         'address': '',
     *         #         'phone_number': '',
     *         #         'email': '',
     *         #         'name': '',
     *         #         'locale': '',
     *         #         'request_locale': ''
     *         #     },
     *         #     'data': {
     *         #         'some_data': 'Hello',
     *         #     },
     *         #     'api_key': 'your api secret key'
     *         # }
     * 
     *         if 'api_key' in body and body['api_key'] == 'your api secret key':
     *             self.send_response(200)
     *             self.send_header("Content-type", "text/html")
     *             self.end_headers()
     *             self.wfile.write(b'\n success')
     *         else:
     *             self.send_response(401)
     *             self.send_header("Content-type", "text/html")
     *             self.end_headers()
     *             self.wfile.write(b'api key mismatch')
     * 
     * 
     * myServer = HTTPServer(("", 3000), MyServer)
     * 
     * try:
     *      myServer.serve_forever()
     * except KeyboardInterrupt:
     *      myServer.server_close()
     * ```
     * @category Connection
     */
    async secureRequest<RequestParams = {
        /** Request url */
        url: string;
        /** Request data */
        data?: any;
        /** requests are sync when true */
        sync?: boolean;
    }>(request: RequestParams | RequestParams[]): Promise<any> {
        let paramsStruct = {
            url: (v: string) => {
                return validateUrl(v);
            },
            data: null,
            sync: ['boolean', () => true]
        };

        if (Array.isArray(request)) {
            for (let r of request) {
                r = checkParams(r, paramsStruct);
            }
        }

        else {
            request = checkParams(request, paramsStruct);
        }

        return await this.request('post-secure', request, { auth: true });
    }

    getFormResponse = async (): Promise<any> => {
        await this.__connection;
        let responseKey = `${this.service}:${MD5.hash(window.location.href)}`;
        let stored = window.sessionStorage.getItem(responseKey);
        if (stored !== null) {
            try {
                stored = JSON.parse(stored);
            } catch (err) { }

            return stored;
        }

        throw new SkapiError("Form response doesn't exist.", { code: 'NOT_EXISTS' });
    };

    // internals below
    request = async (
        url: string,
        data: Form = null,
        options?: {
            fetchOptions?: FetchOptions & FormCallbacks;
            auth?: boolean;
            method?: string;
            meta?: Record<string, any>;
            bypassAwaitConnection?: boolean;
            responseType?: string;
            contentType?: string;
        }
    ): Promise<any> => {

        options = options || {};

        let {
            auth = false,
            method = 'post',
            meta = null, // content meta
            bypassAwaitConnection = false
        } = options;

        let __connection = bypassAwaitConnection ? null : (await this.__connection);
        let token = auth ? this.session?.idToken?.jwtToken : null; // idToken

        if (auth) {
            if (!token) {
                this.logout();
                throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
            }
            else {
                let currTime = Date.now() / 1000;
                if (this.session.idToken.payload.exp < currTime) {
                    try {
                        await this.authentication().getSession({ refreshToken: true });
                        token = this.session?.idToken?.jwtToken;
                    }
                    catch (err) {
                        this.logout();
                        throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
                    }
                }
            }
        }

        let isExternalUrl = '';
        try {
            isExternalUrl = validateUrl(url);
        } catch (err) {
            // is not an external url
        }

        const getEndpoint = async (dest: string, auth: boolean) => {
            const endpoints = await Promise.all([
                this.admin_endpoint,
                this.record_endpoint
            ]);

            const admin = endpoints[0];
            const record = endpoints[1];
            const get_ep = () => {
                switch (dest) {
                    case 'get-serviceletters':
                    case 'delete-newsletter':
                    case 'block-account':
                    case 'register-service':
                    case 'get-users':
                    case 'post-userdata':
                    case 'remove-account':
                    case 'post-secure':
                    case 'get-newsletters':
                    case 'subscribe-newsletter':
                    case 'signup':
                    case 'confirm-signup':
                    case 'recover-account':
                    case 'mock':
                    case 'get-services':
                    case 'service':
                        return {
                            public: admin.admin_public,
                            private: admin.admin_private
                        };

                    case 'post-record':
                    case 'get-records':
                    case 'subscription':
                    case 'get-subscription':
                    case 'del-records':
                    case 'get-table':
                    case 'get-tag':
                    case 'get-index':
                    case 'storage-info':
                        return {
                            private: record.record_private,
                            public: record.record_public
                        };
                }
            };

            return get_ep()[auth ? 'private' : 'public'] + dest;
        };

        let endpoint = isExternalUrl || (await getEndpoint(url, !!auth));
        let service = this.session?.attributes?.['custom:service'] || __connection?.service || this.service;
        let service_owner = this.session?.attributes?.['custom:service_owner'] || __connection?.owner || this.service_owner;

        if (meta) {
            if (typeof meta === 'object' && !Array.isArray(meta)) {
                meta = JSON.parse(JSON.stringify(meta));
            }
            else {
                throw new SkapiError('Invalid meta data.', { code: 'INVALID_REQUEST' });
            }
        }

        if (Array.isArray(data) || data && typeof data !== 'object') {
            throw new SkapiError('Request data should be a JSON Object | FormData | HTMLFormElement.', { code: 'INVALID_REQUEST' });
        }

        /* compose meta to send */
        let required = { service, service_owner };

        // set fetch options
        let fetchOptions = {};
        let { fetchMore = false } = options?.fetchOptions || {};

        if (options?.fetchOptions && Object.keys(options.fetchOptions).length) {
            // record fetch options
            let fetOpt = checkParams(
                {
                    limit: options.fetchOptions?.limit || 100,
                    startKey: options.fetchOptions?.startKey || null,
                    ascending: typeof options.fetchOptions?.ascending === 'boolean' ? options.fetchOptions.ascending : true
                },
                {
                    limit: ['number', () => 100],
                    startKey: null,
                    ascending: ['boolean', () => true]
                }
            );

            if (fetOpt.hasOwnProperty('limit') && typeof fetOpt.limit === 'number') {
                if (fetOpt.limit > 1000) {
                    throw new SkapiError('Fetch limit should be below 1000.', { code: 'INVALID_REQUEST' });
                }
                Object.assign(fetchOptions, { limit: fetOpt.limit });
            }

            if (fetOpt.hasOwnProperty('startKey') && typeof fetOpt.startKey === 'object' && fetOpt.startKey && Object.keys(fetOpt.startKey)) {
                Object.assign(fetchOptions, { startKey: fetOpt.startKey });
            }

            if (fetOpt.hasOwnProperty('ascending') && typeof fetOpt.ascending === 'boolean') {
                Object.assign(fetchOptions, { ascending: fetOpt.ascending });
            }
        }

        Object.assign(required, fetchOptions);

        let isForm = false;

        if (data instanceof SubmitEvent) {
            data = data?.target;
        }

        if (data instanceof HTMLFormElement) {
            data = new FormData(data);
            isForm = true;
        }

        if (meta) {
            // add required to meta
            meta = Object.assign(required, meta);
        }

        else {
            // add required to data
            if (!data) {
                data = required;
            }
            else if (isForm) {
                for (let k in required) {
                    if (required[k] !== undefined) {
                        data.set(k, new Blob([JSON.stringify(required[k])], {
                            type: 'application/json'
                        }));
                    }
                }
            }
            else {
                data = Object.assign(required, data);
            }
        }

        // formdata callback
        if (isForm && typeof options?.fetchOptions?.formData === 'function') {
            let cb = options.fetchOptions.formData((data as FormData));
            if (cb instanceof Promise) {
                cb = await cb;
            }

            if (cb instanceof FormData) {
                data = cb;
            }

            else {
                throw new SkapiError('Callback for extractFormData() should return FormData', { code: 'INVALID_PARAMETER' });
            }
        }

        let requestKey = this.load_startKey_keys({
            params: data,
            url: isExternalUrl || url,
            fetchMore: isForm ? false : fetchMore // should not use startKey when post is a form
        }); // returns requrestKey | cached data

        if (requestKey && typeof requestKey === 'object') {
            return requestKey;
        }

        if (typeof requestKey === 'string') {
            if (!(this.__pendingRequest[requestKey] instanceof Promise)) {
                // new request

                let headers: Record<string, any> = {
                    'Accept': '*/*'
                };

                if (token) {
                    headers.Authorization = token;
                }

                if (meta) {
                    headers["Content-Meta"] = JSON.stringify(meta);
                }

                if (options.hasOwnProperty('contentType')) {
                    if (options?.contentType) {
                        headers["Content-Type"] = options.contentType;
                    }
                }

                else if (!(data instanceof FormData)) {
                    headers["Content-Type"] = 'application/json';
                }

                let opt: RequestInit & { responseType?: string | null, headers: Record<string, any>; } = { headers };
                if (options?.responseType) {
                    opt.responseType = options.responseType;
                }

                // pending call request
                // this prevents recursive calls
                if (method === 'post') {
                    this.__pendingRequest[requestKey] = this._post(endpoint, data, opt);
                }
                else if (method === 'get') {
                    this.__pendingRequest[requestKey] = this._get(endpoint, data, opt);
                }
            }

            try {
                let response = await this.__pendingRequest[requestKey];

                // should not use startKey when post is a form (is a post)
                if (isForm) {
                    return response;
                }

                else {
                    return await this.update_startKey_keys({
                        hashedParam: requestKey,
                        url,
                        response
                    });
                }

            } catch (err) {
                throw err;
            } finally {
                // remove promise
                if (requestKey && this.__pendingRequest.hasOwnProperty(requestKey)) {
                    delete this.__pendingRequest[requestKey];
                }
            }
        }
    };

    // cache, handle database records
    private load_startKey_keys = (option: {
        params: Record<string, any>;
        url: string;
        fetchMore?: boolean;
    }): string | FetchResponse => {

        let { params = {}, url, fetchMore = false } = option || {};
        if (params.hasOwnProperty('startKey') && params.startKey) {
            if (
                typeof params.startKey !== 'object' && !Object.keys(params.startKey).length &&
                params.startKey !== 'start' && params.startKey !== 'end'
            ) {
                throw new SkapiError(`"${params.startKey}" is invalid startKey key.`, { code: 'INVALID_PARAMETER' });
            }

            switch (params.startKey) {
                case 'end':
                    // end is always end
                    return {
                        list: [],
                        startKey: 'end',
                        endOfList: true
                    };

                case 'start':
                    // deletes referenced object key
                    delete params.startKey;
            }
        }

        let hashedParams = (() => {
            if (params && typeof params === 'object' && Object.keys(params).length) {
                // hash request parameters
                function orderObjectKeys(obj: Record<string, any>) {
                    function sortObject(obj: Record<string, any>): Record<string, any> {
                        if (typeof obj === 'object' && obj) {
                            return Object.keys(obj).sort().reduce((res, key) => ((res as any)[key] = obj[key], res), {});
                        }
                        return obj;
                    };

                    let _obj = sortObject(obj);
                    for (let k in _obj) {
                        if (_obj[k] && typeof _obj[k] === 'object') {
                            _obj[k] = sortObject(obj[k]);
                        }
                    }

                    return _obj;
                }

                return MD5.hash(url + '/' + JSON.stringify(orderObjectKeys(params)));
            }

            return MD5.hash(url + '/' + this.service);

        })();

        if (!fetchMore && this.__startKey_keys?.[url]?.[hashedParams]) {
            // init cache, init startKey

            if (this.__cached_requests?.[url] && this.__cached_requests?.[url]?.[hashedParams]) {
                // delete cached data start
                delete this.__cached_requests[url][hashedParams];
            }

            if (Array.isArray(this.__startKey_keys[url][hashedParams]) && this.__startKey_keys[url][hashedParams].length) {
                // delete cache of all startkeys
                for (let p of this.__startKey_keys[url][hashedParams]) {
                    let hashedParams_cached = hashedParams + '/' + MD5.hash(JSON.stringify(p));
                    if (this.__cached_requests?.[url] && this.__cached_requests?.[url]?.[hashedParams_cached]) {
                        delete this.__cached_requests[url][hashedParams_cached];
                    }
                }
            }

            // delete start key lists
            delete this.__startKey_keys[url][hashedParams];

            return hashedParams;
        }

        if (!Array.isArray(this.__startKey_keys?.[url]?.[hashedParams])) {
            // startkey does not exists
            return hashedParams;
        }

        // hashed params exists
        let list_of_startKeys = this.__startKey_keys[url][hashedParams]; // [{<startKey key>}, ...'end']
        let last_startKey_key = list_of_startKeys[list_of_startKeys.length - 1];
        let cache_hashedParams = hashedParams;
        if (last_startKey_key) {
            // use last start key

            if (last_startKey_key === '"end"') { // cached startKeys are stringified
                return {
                    list: [],
                    startKey: 'end',
                    endOfList: true
                };
            }

            else {
                cache_hashedParams += MD5.hash(last_startKey_key);
                params.startKey = JSON.parse(last_startKey_key);
            }
        }

        if (this.__cached_requests?.[url]?.[cache_hashedParams]) {
            // return data if there is cache
            return this.__cached_requests?.[url]?.[cache_hashedParams];
        }

        return hashedParams;
    };

    private update_startKey_keys = async (option: Record<string, any>) => {
        let { hashedParam, url, response } = option;
        let fetched = null;

        if (response instanceof Promise) {
            fetched = await response;
        }

        else {
            fetched = response;
        }

        if (
            typeof fetched !== 'object' ||
            !fetched.hasOwnProperty('startKey') ||
            !hashedParam ||
            !url
        ) {
            // no startkey no caching
            return fetched;
        }

        // has start key
        // startkey is key for next fetch

        // this.__startKey_keys[url] = {
        //     [hashedParam]: ['{<startKey key>}', ...'end'],
        //     ...
        // }

        // this.__cached_requests[url][hashsedParams + sha256(JSON.stringify(startKey))] = {
        //     data
        //     ...
        // }

        if (!this.__startKey_keys.hasOwnProperty(url)) {
            // create url key to store startKey key list if it doesnt exists
            this.__startKey_keys[url] = {};
        }

        if (!this.__cached_requests?.[url]) {
            this.__cached_requests[url] = {};
        }

        this.__cached_requests[url][hashedParam] = fetched;

        if (!this.__startKey_keys[url].hasOwnProperty(hashedParam)) {
            this.__startKey_keys[url][hashedParam] = [];
        }

        let startKey_string = JSON.stringify(fetched.startKey);
        if (!this.__startKey_keys[url][hashedParam].includes(startKey_string)) {
            this.__startKey_keys[url][hashedParam].push(startKey_string);
        }

        this.__cached_requests[url][hashedParam] = fetched;

        return Object.assign({ startKey_list: this.__startKey_keys[url][hashedParam] }, fetched);
    };

    private _fetch = async (url: string, opt: RequestInit, responseType: string) => {
        let response: Record<string, any> = await fetch(url, opt);

        if (responseType) {
            if (response.status === 200) {
                return await response[responseType]();
            } else {
                throw response;
            }
        }

        let received = await response.text();
        try {
            received = JSON.parse(received);
        } catch (err) {
        }

        if (response.status === 200) {
            if (typeof received === 'object' && opt.method === 'GET' && received.hasOwnProperty('body')) {
                try {
                    received = JSON.parse(received.body);
                } catch (err) { }
            }
            return received;
        }

        else {
            let status = response?.status;
            let errCode = [
                'INVALID_CORS',
                'INVALID_REQUEST',
                'SERVICE_DISABLED',
                'INVALID_PARAMETER',
                'ERROR',
                'EXISTS',
                'NOT_EXISTS'
            ];

            if (typeof received === 'object' && received?.message) {
                let code = ((status ? status.toString() : null) || received?.code || 'ERROR');
                throw new SkapiError(received?.message, { code: code });
            }

            else if (typeof received === 'string') {
                let errMsg = received.split(':');
                let code = errMsg.splice(0, 1)[0].trim();
                throw new SkapiError(errMsg.join('').trim(), { code: (errCode.includes(code) ? code : 'ERROR') });
            }

            throw response;
        }
    };

    private _post(url: string, params: Record<string, any>, option: RequestInit & { responseType?: string | null, headers: Record<string, any>; }) {
        let responseType = null;
        if (option.hasOwnProperty('responseType')) {
            responseType = option.responseType;
            delete option.responseType;
        }

        let opt = Object.assign(
            {
                method: 'POST'
            },
            option,
            {
                body: params instanceof FormData ? params : JSON.stringify(params)
            }
        );

        return this._fetch(url, opt, responseType);
    }

    private _get = async (url: string, params: Record<string, any>, option: RequestInit & { responseType?: string | null, headers: Record<string, any>; }) => {
        if (params && typeof params === 'object' && Object.keys(params).length) {
            if (url.substring(url.length - 1) !== '?') {
                url = url + '?';
            }

            let query = Object.keys(params)
                .map(k => {
                    let value = params[k];
                    if (typeof value !== 'string') {
                        value = JSON.stringify(value);
                    }
                    return encodeURIComponent(k) + '=' + encodeURIComponent(value);
                })
                .join('&');

            url += query;
        }

        let responseType = null;
        if (option.hasOwnProperty('responseType')) {
            responseType = option.responseType;
            delete option.responseType;
        }

        let opt = Object.assign(
            {
                method: 'GET'
            },
            option
        );

        return this._fetch(url, opt, responseType);
    };

    /**
     * Uploads data to your service database.<br>
     * We will call data in database as record.
     * <ul>
     * <li>
     * <b>About tables:</b><br>
     * When uploading new records, table setting is required.<br>
     * Database table are created automatically on upload.<br>
     * You can have infinite numbers of tables.<br>
     * You cannot change table settings once it's uploaded.<br>
     * Database table will be deleted automatically if there is no record in the table.<br>
     * <br>
     * <b>NOTE:</b> Whitespace or special characters are not allowed in table name.<br>
     * </li>
     * <li>
     * <b>About Index:</b><br>
     * Index help you to categorize records paired by "name" and "value".<br>
     * Index caculates total sum of values if the value is number or boolean.<br>
     * <b>NOTE:</b> Whitespace or special characters are not allowed in index name or value.<br>
     * </li>
     * <li>
     * <b>About Tags:</b><br>
     * Tags let's you categorize records by given tags.<br>
     * You can have multiple tags on single record.<br>
     * <b>NOTE:</b> Whitespace or special characters are not allowed in tags.<br>
     * </li>
     * </ul>
     * @category Database
     */
    @formResponse()
    async postRecord(
        /** Any type of data to store. If undefined, does not update the data. */
        form: Form | any,
        option: PostRecordParams & FormCallbacks
    ): Promise<RecordData> {
        let isAdmin = await this.checkAdmin();
        if (!option) {
            throw new SkapiError(['INVALID_PARAMETER', '"option" argument is required.']);
        }

        let { formData } = option;
        let fetchOptions: Record<string, any> = {};

        if (typeof formData === 'function') {
            fetchOptions.formData = formData;
        }

        option = checkParams(option || {}, {
            record_id: 'string',
            access_group: ['number', 'private'],
            table: 'string',
            subscription_group: 'number',
            reference: ['string', null],
            index: {
                name: 'string',
                value: ['string', 'number', 'boolean']
            },
            tags: (v: string | string[]) => {
                if (v === null) {
                    return v;
                }

                if (typeof v === 'string') {
                    return [v];
                }

                if (Array.isArray(v)) {
                    for (let i of v) {
                        if (typeof i !== 'string') {
                            throw new SkapiError(`"tags" should be type: <string | string[]>`, { code: 'INVALID_PARAMETER' });
                        }
                    }
                    return v;
                }

                throw new SkapiError(`"tags" should be type: <string | string[]>`, { code: 'INVALID_PARAMETER' });
            },
            config: {
                reference_limit: (v: number) => {
                    if (v === null) {
                        return null;
                    }

                    else if (typeof v === 'number') {
                        if (0 > v) {
                            throw new SkapiError(`"reference_limit" should be >= 0`, { code: 'INVALID_PARAMETER' });
                        }

                        if (v > 4503599627370546) {
                            throw new SkapiError(`"reference_limit" should be <= 4503599627370546`, { code: 'INVALID_PARAMETER' });
                        }

                        return v;
                    }

                    throw new SkapiError(`"reference_limit" should be type: <number | null>`, { code: 'INVALID_PARAMETER' });
                },
                allow_multiple_reference: 'boolean',
                private_access: (v: string | string[]) => {
                    let param = 'config.private_access';

                    if (v === null) {
                        return null;
                    }

                    if (v && typeof v === 'string') {
                        v = [v];
                    }

                    if (Array.isArray(v)) {
                        for (let u of v) {
                            validateUserId(u, `User ID in "${param}"`);

                            if (this.__user && u === this.__user.user_id) {
                                throw new SkapiError(`"${param}" should not be the uploader's user ID.`, { code: 'INVALID_PARAMETER' });
                            }
                        }
                    }

                    else {
                        throw new SkapiError(`"${param}" should be an array of user ID.`, { code: 'INVALID_PARAMETER' });
                    }

                    return v;
                }
            }
        }, [], ['response', 'formData', 'onerror']);

        // callbacks should be removed after checkparams
        delete option.response;
        delete option.formData;
        delete option.onerror;

        if (option?.table === '') {
            throw new SkapiError('"table" cannot be empty string.', { code: 'INVALID_PARAMETER' });
        }

        if (!option?.table && !option?.record_id) {
            throw new SkapiError('Either "record_id" or "table" should have a value.', { code: 'INVALID_PARAMETER' });
        }

        if (option?.index) {
            // index name allows periods. white space is invalid.
            if (!option.index?.name || typeof option.index?.name !== 'string') {
                throw new SkapiError('"index.name" is required. type: string.', { code: 'INVALID_PARAMETER' });
            }

            checkWhiteSpaceAndSpecialChars(option.index.name, 'index name', true);

            if (!option.index.hasOwnProperty('value')) {
                throw new SkapiError('"index.value" is required.', { code: 'INVALID_PARAMETER' });
            }

            if (typeof option.index.value === 'string') {
                // index name allows periods. white space is invalid.
                checkWhiteSpaceAndSpecialChars(option.index.value, 'index value', false, true);
            }

            else if (typeof option.index.value === 'number') {
                if (option.index.value > this.__index_number_range || option.index.value < -this.__index_number_range) {
                    throw new SkapiError(`Number value should be within range -${this.__index_number_range} ~ +${this.__index_number_range}`, { code: 'INVALID_PARAMETER' });
                }
            }
        }

        if (isAdmin) {
            if (option?.access_group === 'private') {
                throw new SkapiError('Service owner cannot write private records.', { code: 'INVALID_REQUEST' });
            }

            if (option.hasOwnProperty('subscription_group')) {
                throw new SkapiError('Service owner cannot write to subscription table.', { code: 'INVALID_REQUEST' });
            }
        }

        let options = { auth: true };
        let postData = null;

        if (form instanceof HTMLFormElement || form instanceof FormData) {
            Object.assign(options, { meta: option });
        }

        else {
            postData = Object.assign({ data: form }, option);
        }

        if (Object.keys(fetchOptions).length) {
            Object.assign(options, { fetchOptions });
        }

        return normalize_record_data(await this.request('post-record', postData || form, options));
    }

    getRecords = async (params: GetRecordParams, fetchOptions?: FetchOptions): Promise<FetchResponse> => {
        const indexTypes = {
            '$updated': 'number',
            '$uploaded': 'number',
            '$referenced_count': 'number'
        };

        const struct = {
            table: 'string',
            reference: 'string',
            access_group: ['number', 'private'],
            subscription: {
                user_id: (v: string) => validateUserId(v, 'User ID in "subscription.user_id"'),
                group: (v: number) => {
                    if (typeof v !== 'number') {
                        throw new SkapiError('"subscription.group" should be type: number.', { code: 'INVALID_PARAMETER' });
                    }
                    if (v > 99 || v < 0) {
                        throw new SkapiError('"subscription.group" should be within range: 0 ~ 99.', { code: 'INVALID_PARAMETER' });
                    }
                    return v;
                }
            },
            index: {
                name: (v: string) => {
                    if (typeof v !== 'string') {
                        throw new SkapiError('"index.name" should be type: string.', { code: 'INVALID_PARAMETER' });
                    }

                    if (indexTypes.hasOwnProperty(v)) {
                        return v;
                    }

                    return checkWhiteSpaceAndSpecialChars(v, 'index.name', true, false);
                },
                value: (v: number | boolean | string) => {
                    if (params.index?.name && indexTypes.hasOwnProperty(params.index.name)) {
                        let tp = indexTypes[params.index.name];

                        if (typeof v === tp) {
                            return v;
                        }

                        else {
                            throw new SkapiError(`"index.value" should be type: ${tp}.`, { code: 'INVALID_PARAMETER' });
                        }
                    }

                    if (typeof v === 'number') {
                        if (v > this.__index_number_range || v < -this.__index_number_range) {
                            throw new SkapiError(`Number value should be within range -${this.__index_number_range} ~ +${this.__index_number_range}`, { code: 'INVALID_PARAMETER' });
                        }
                        return v;
                    }

                    else if (typeof v === 'boolean') {
                        return v;
                    }

                    else {
                        // is string
                        return checkWhiteSpaceAndSpecialChars((v as string), 'index.value', false, true);
                    }
                },
                condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne'],
                range: (v: number | boolean | string) => {
                    if (!('value' in params.index)) {
                        throw new SkapiError('"index.value" is required.', { code: 'INVALID_PARAMETER' });
                    }

                    if (params.index.name === '$record_id') {
                        throw new SkapiError(`Cannot do "index.range" on ${params.index.name}`, { code: 'INVALID_PARAMETER' });
                    }

                    if (typeof params.index.value !== typeof v) {
                        throw new SkapiError('"index.range" type should match the type of "index.value".', { code: 'INVALID_PARAMETER' });
                    }

                    if (typeof v === 'string') {
                        return checkWhiteSpaceAndSpecialChars(v, 'index.value');
                    }

                    return v;
                }
            },
            tag: 'string'
        };

        if (params?.record_id) {
            checkWhiteSpaceAndSpecialChars(params.record_id, 'record_id', false, false);
            params = { record_id: params.record_id, service: params?.service };
        }

        else {
            let ref_user;
            if (params?.reference) {
                try {
                    ref_user = validateUserId(params?.reference, 'User ID in "subscription.user_id"');
                } catch (err) {
                    // bypass error
                }
            }

            params = checkParams(params || {}, struct, ref_user ? [] : ['table']);
            if (params?.subscription && !this.session) {
                throw new SkapiError('Requires login.', { code: 'INVALID_REQUEST' });
            }
        }

        let auth = params.hasOwnProperty('access_group') && (params.access_group === 'private' || params.access_group > 0) ? true : !!this.__user;
        let result = await this.request(
            'get-records',
            params,
            {
                fetchOptions,
                auth,
                method: auth ? 'post' : 'get'
            }
        );

        for (let i in result.list) { result.list[i] = normalize_record_data(result.list[i]); };

        return result;
    };

    /**
     * Retrieve table info of record database.
     * Get table info of record database.
     * 
     * ```
     * // Get information in 'MyTable'.
     * let getTable = await skapi.getTable({
     *     table: 'MyTable'
     * });
     * 
     * // Get all list of tables in service in lexographical order.
     * let getTablePrivate = await skapi.getTable();
     * 
     * // Get all list of tables in service in lexographical order.
     * let getTablePrivate = await skapi.getTable();
     * ```
     */
    getTable = async (
        params: {
            /** Table name. If omitted fetch all list of tables. */
            table?: string;
            condition?: string;
        },
        fetchOptions?: FetchOptions
    ): Promise<FetchResponse> => {
        let res = await this.request('get-table', checkParams(params || {}, {
            table: 'string',
            condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne']
        }), Object.assign({ auth: true }, { fetchOptions }));

        let convert = {
            'cnt_rec': 'number_of_records',
            'tbl': 'table',
            'srvc': 'service'
        };

        if (Array.isArray(res.list)) {
            for (let t of res.list) {
                for (let k in convert) {
                    if (t.hasOwnProperty(k)) {
                        t[convert[k]] = t[k];
                        delete t[k];
                    }
                }
            }
        }

        return res;
    };

    /**
     * Retrieve index info of record database.
     * Get index info of record database.
     * 
     * ```
     * 
     * // Get info of "Gold" index in "MyTable" table.
     * let getIndex = await skapi.getIndex({
     *     index: 'Gold',
     *     table: 'MyTable'
     * });
     * 
     * // Get all index in average value order in "MyTable" table.
     * let getIndexAll = await skapi.getIndex({
     *     order_by: {
     *          name: 'average_number'
     *     },
     *     table: 'MyTable'
     * });
     * 
     * ```
     * @category Database
     */
    getIndex = async (
        params: {
            /** Table name */
            table: string;
            /** Index name. When period is at the end of name, querys nested index keys. */
            index?: string;
            /** Queries order by */
            order_by: {
                /** Key name to order. */
                name: 'average_number' | 'total_number' | 'number_count' | 'average_bool' | 'total_bool' | 'bool_count' | 'string_count' | 'index_name';
                /** Value to query. */
                value?: number | boolean | string;
                /** "order_by.value" is required for condition. */
                condition?: 'gt' | 'gte' | 'lt' | 'lte' | '>' | '>=' | '<' | '<=' | '=' | 'eq' | '!=' | 'ne';
            };
        },
        fetchOptions?: FetchOptions
    ): Promise<FetchResponse> => {

        let p = checkParams(
            params || {},
            {
                table: 'string',
                index: (v: string) => checkWhiteSpaceAndSpecialChars(v, 'index name', true, false),
                order_by: {
                    name: [
                        'average_number',
                        'total_number',
                        'number_count',
                        'average_bool',
                        'total_bool',
                        'bool_count',
                        'string_count',
                        'index_name'
                    ],
                    value: ['string', 'number', 'boolean'],
                    condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne']
                }
            },
            ['table']
        );

        if (p.hasOwnProperty('order_by')) {
            if (p.order_by === 'index_name') {
                if (!p.hasOwnProperty('index')) {
                    throw new SkapiError('"index" is required for ordered by "index_name".', { code: 'INVALID_PARAMETER' });
                }

                if (p.index.substring(p.index.length - 1) !== '.') {
                    throw new SkapiError('"index" should be parent "index name".', { code: 'INVALID_PARAMETER' });
                }
            }

            if (p.order_by.hasOwnProperty('condition') && !p.order_by.hasOwnProperty('value')) {
                throw new SkapiError('"value" is required for "condition".', { code: 'INVALID_PARAMETER' });
            }
        }

        let res = await this.request(
            'get-index',
            p,
            Object.assign(
                { auth: true },
                { fetchOptions }
            )
        );

        let convert = {
            'cnt_bool': 'boolean_count',
            'cnt_numb': 'number_count',
            'totl_numb': 'total_number',
            'totl_bool': 'total_bool',
            'avrg_numb': 'average_number',
            'avrg_bool': 'average_bool',
            'cnt_str': 'string_count'
        };

        if (Array.isArray(res.list)) {
            res.list = res.list.map((i: Record<string, any>) => {
                let iSplit = i.idx.split('/');
                let resolved: Record<string, any> = {
                    table: iSplit[1],
                    index: iSplit[2],
                    number_of_records: i.cnt_rec
                };

                for (let k in convert) {
                    if (i?.[k]) {
                        resolved[convert[k]] = i[k];
                    }

                    if (resolved?.number_of_number_values) {
                        resolved.average_of_number_values = i.totl_numb / i.cnt_numb;
                    }
                    if (resolved?.number_of_boolean_values) {
                        resolved.average_of_boolean_values = i.totl_bool / i.cnt_bool;
                    }
                }

                return resolved;
            });
        }

        return res;
    };

    /**
     * Retrieve filter info of database table.
     * 
     * ```
     * // Get all tags from "MyTable" in record number orders.
     * let getTagAll = await skapi.getTag({
     *     table: "MyTable"
     * });
     * 
     * // Get info on 'Gold' from "MyTable".
     * let getTagInfo = await skapi.getTag({
     *     table: "MyTable",
     *     tag: 'Gold'
     * });
     * ```
     * @category Database
     */
    getTag = async (
        params: {
            /** Table name */
            table: string;
            /** Tag name */
            tag: string;
            /** String query condition for tag name. */
            condition: 'gt' | 'gte' | 'lt' | 'lte' | '>' | '>=' | '<' | '<=' | '=' | 'eq' | '!=' | 'ne';
        },
        fetchOptions?: FetchOptions
    ): Promise<FetchResponse> => {

        let res = await this.request(
            'get-tag',
            checkParams(params || {},
                {
                    table: 'string',
                    tag: 'string',
                    condition: ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', '=', 'eq', '!=', 'ne']
                }
            ),
            Object.assign({ auth: true }, { fetchOptions })
        );

        if (Array.isArray(res.list)) {
            for (let i in res.list) {
                let item = res.list[i];
                let tSplit = item.tag.split('/');
                res.list[i] = {
                    table: tSplit[1],
                    tag: tSplit[0],
                    number_of_records: item.cnt_rec
                };
            }
        }

        return res;
    };

    /**
    * Deletes specific records or bulk of records under certain table, index, tag.
    * <br>
    * <b>WARNING:</b> Deleted record cannot be restored.
    * 
    * ```
    * // Delete record
    * // users wont be able to delete other users record.
    * await skapi.deleteRecords({
    *     record_id: ['record id 1', 'record id 2']
    * });
    * 
    * // Delete all my record in "MyTable" in access group 1.
    * await skapi.deleteRecords({
    *     access_group: 1,
    *     table: {
    *         name: 'MyTable'
    *     }
    * });
    * 
    * // Delete all record in subscription table of group 1 in "MyTable" in access group 0.
    * await skapi.deleteRecords({
    *     access_group: 0,
    *     table: {
    *         name: 'MyTable',
    *         subscription_group: 1
    *     }
    * });
    * 
    * // (for admin) Delete all record in the service
    * await skapi.deleteRecords({
    *   service: 'xxxxxxxx'
    * });
    * 
    * // (for admin) Delete all record in "MyTable"
    * // admin can delete all records in table regardless access group or subscription tables.
    * await skapi.deleteRecords({
    *   service: 'xxxxxxxx',
    *   table: {
    *       name: 'MyTable'
    *   }
    * });
    * // (for admin) Delete all record in "MyTable"
    * 
    * // admin can delete all records in users subscription table from target access group.
    * await skapi.deleteRecords({
    *   service: 'xxxxxxxx',
    *   access_group: 1,
    *   table: {
    *       name: 'MyTable',
    *       subscription: 'user_id',
    *       subscription_group: 1
    *   }
    * });
    * 
    * ```
    * @category Database
    */
    deleteRecords = async (params: {
        /**
         * (only admin) Service ID.
         */
        service?: string;
        /**
         * Record ID(s) to delete.<br>
         * table parameter is not needed when record_id is given.
         */
        record_id?: string | string[];
        /**
         * Access group number.<br>
         */
        access_group: number | 'private';
        /** 
         * Table to delete.<br>
         */
        table: {
            /** Table name. */
            name: string;
            /** @ignore */
            subscription: string;
            /**
             * Subscription group number.<br>
             * Access group is required.
             */
            subscription_group?: number;
        };
    }): Promise<string> => {
        let isAdmin = await this.checkAdmin();
        if (isAdmin && !params?.service) {
            throw new SkapiError('Service ID is required.', { code: 'INVALID_PARAMETER' });
        }

        if (!isAdmin && !params?.table) {
            throw new SkapiError('"table" is required.', { code: 'INVALID_PARAMETER' });
        }

        if (params?.record_id) {
            return await this.request('del-records', {
                service: params.service,
                record_id: (v => {
                    let id = checkWhiteSpaceAndSpecialChars(v, 'record_id', false);
                    if (typeof id === 'string') {
                        return [id];
                    }

                    return id;
                })(params.record_id)
            }, { auth: true });
        }

        else {
            if (!params?.table) {
                throw new SkapiError('Either "table" or "record_id" is required.', { code: 'INVALID_PARAMETER' });
            }

            let struct = {
                access_group: ['number', 'private'],
                table: {
                    name: 'string',
                    subscription: (v: string) => {
                        if (isAdmin) {
                            // admin targets user id
                            return validateUserId((v as string), 'User ID in "table.subscription"');
                        }

                        throw new SkapiError('"table.subscription" is an invalid parameter key.', { code: 'INVALID_PARAMETER' });
                    },
                    subscription_group: (v: number) => {
                        if (isAdmin && typeof params?.table?.subscription !== 'string') {
                            throw new SkapiError('"table.subscription" is required.', { code: 'INVALID_PARAMETER' });
                        }

                        if (typeof v === 'number') {
                            if (v > 0 && v < 99) {
                                return v;
                            }
                        }

                        throw new SkapiError('Subscription group should be between 0 ~ 99.', { code: 'INVALID_PARAMETER' });
                    }
                }
            };

            params = checkParams(params || {}, struct, isAdmin ? ['service'] : ['table', 'access_group']);
        }

        return await this.request('del-records', params, { auth: true });
    };

    //<_subscriptions>
    /**
     * Anyone who submits their E-Mail address will receive newsletters from you.<br>
     * The newsletters you send out will have unsubscribe link at the bottom.<br>
     * Both Signed and unsigned users can subscribe to your newsletter.<br>
     * Refer: <a href='www.google.com'>Sending out newsletters</a>
     * ```
     * let params = {
     *      email: 'visitors@email.com',
     *      bypassWelcome: false // Send out welcome E-Mails on submit
     * };
     * 
     * skapi.subscribeNewsletter(params);
     * ```
     * @category Subscriptions
     */
    @formResponse()
    subscribeNewsletter(
        form: Form | {
            /** Newsletter subscriber's E-Mail. 64 character max. */
            email: string,
            /**
             * Subscriber will receive a welcome E-Mail if set to false.<br>
             * The welcome E-Mail is the same E-Mail that is sent when the new user successfully creates an account on your web services.<br>
             * To save your operation cost, it is advised to redirect the users to your welcome page once subscription is successful.<br>
             * Refer: <a href="www.google.com">Setting up E-Mail templates</a><br>
             */
            bypassWelcome: boolean;
        },
        option: FormCallbacks
    ): Promise<string> {
        let params = checkParams(
            form || {},
            {
                email: (v: string) => validateEmail(v),
                bypassWelcome: ['boolean', () => true]
            },
            ['email']
        );

        return this.request('subscribe-newsletter', params);
    }

    private subscriptionGroupCheck = async (option: SubscriptionGroup) => {
        await this.__connection;
        option = checkParams(option, {
            user_id: (v: string) => validateUserId(v, '"user_id"'),
            group: (v: number | string) => {
                if (v === '*') {
                    return v;
                }

                if (typeof v !== 'number') {
                    throw new SkapiError('"group" should be type: number.', { code: 'INVALID_PARAMETER' });
                }

                else if (v < 1 && v > 9) {
                    throw new SkapiError('"group" should be within range 1 ~ 9.', { code: 'INVALID_PARAMETER' });
                }

                return v;
            }
        }, ['user_id', 'group']);

        if (this.__user && option.user_id === this.__user.user_id) {
            throw new SkapiError(`"user_id" cannot be the user's own ID.`, { code: 'INVALID_PARAMETER' });
        }

        return option;
    };

    /**
     * Subscribes user's account to another account or updates email_subscription state.<br>
     * User cannot subscribe to email if they did not verify their email.<br>
     * This can be used for user following, content restrictions when building social media services.<br>
     * Refer: <a href='www.google.com'>How to use subscription systems</a><br>
     * 
     * ```
     * // user subscribes to another user with email subscription
     * await skapi.subscribe({
     *     user_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
     *     group: 1
     * })
     * ```
     * @category Subscriptions
     */
    @formResponse()
    async subscribe(
        option: SubscriptionGroup
    ) {
        let { user_id, group } = await this.subscriptionGroupCheck(option);

        if (group === '*') {
            throw new SkapiError('Cannot subscribe to all groups at once.', { code: 'INVALID_PARAMETER' });
        }

        return await this.request('subscription', {
            subscribe: user_id,
            group
        }, { auth: true });
    }

    /**
     * Unsubscribes user's account from another account or service.
     * ```
     * // user unsubscribes from another user
     * await skapi.unsubscribe({
     *     user_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
     *     group: 2
     * })
     * ```
     * @category Subscriptions
     */
    @formResponse()
    async unsubscribe(option: SubscriptionGroup) {
        let { user_id, group } = await this.subscriptionGroupCheck(option);

        return await this.request('subscription', {
            unsubscribe: user_id,
            group
        }, { auth: true });
    }

    /**
     * Account owner can block user from their account subscription.
     * ```
     * // account owner blocks user from group 2
     * await skapi.blockSubscriber({
     *     user_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
     *     group: 2
     * })
     * // account owner blocks user from all group
     * await skapi.blockSubscriber({
     *     user_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
     * })
     * ```
     * @category Subscriptions
     */
    @formResponse()
    async blockSubscriber(option: SubscriptionGroup): Promise<string> {
        let { user_id, group } = await this.subscriptionGroupCheck(option);
        return await this.request('subscription', { block: user_id, group }, { auth: true });
    }

    /**
     * Account owner can unblock user from their account subscription.
     * ```
     * // account owner unblocks user from group 2
     * await skapi.unblockSubscriber({
     *     user_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
     *     group: 2
     * })
     * 
     * // account owner unblocks user from all group
     * await skapi.unblockSubscriber({
     *     user_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
     * })
     * ```
     * @category Subscriptions
     */
    @formResponse()
    async unblockSubscriber(option: SubscriptionGroup): Promise<string> {
        let { user_id, group } = await this.subscriptionGroupCheck(option);
        return await this.request('subscription', { unblock: user_id, group }, { auth: true });
    }

    /**
     * Get user's subscriptions
     * @ignore
     */
    async getUserSubscriptions(option: SubscriptionGroup): Promise<FetchResponse> {
        await this.__connection;
        option = checkParams(option, {
            user_id: (v: string) => {
                try {
                    return validateUserId(v, '"user_id"');
                } catch (err) {
                }

                try {
                    return validateEmail(v);
                } catch (err) {
                }

                throw new SkapiError('"subscriber" should be either valid user ID or E-Mail.', { code: 'INVALID_PARAMETER' });
            },
            group: 'number'
        }) || {};

        return this.getSubscriptions({
            subscriber: option.user_id || this.__user?.user_id,
            group: option.group
        });
    }

    /**
     * Get user's subscribers
     * @ignore
     */
    async getUserSubscribers(option: SubscriptionGroup): Promise<FetchResponse> {
        await this.__connection;
        option = checkParams(option, {
            user_id: (v: string) => validateUserId(v, '"user_id"'),
            group: 'number'
        }) || {};

        let subParams = {
            subscription: option.user_id || this.__user?.user_id,
            group: option.group
        };

        return this.getSubscriptions(subParams);
    }

    /**
     * Get user's subscriptions / subscribers
     *
     * @category Subscriptions
     */
    async getSubscriptions(
        params: {
            /** Subscribers user id | E-Mail for newsletter subscribers. */
            subscriber?: string;
            /** Subscription id. User id that subscriber has subscribed to. */
            subscription?: string;
            /** subscription group. if omitted, will fetch all groups. */
            group?: number | '*';
            /** Fetch blocked subscription when True */
            blocked?: boolean;
        },
        fetchOptions?: FetchOptions,
        /** @ignore */
        _mapper?: Function
    ): Promise<FetchResponse> {
        let isNewsletterSub = false;

        params = checkParams(params, {
            subscriber: (v: string) => {
                try {
                    return validateUserId(v, 'User ID in "subscriber"');
                } catch (err) {
                }

                try {
                    let isEmail = validateEmail(v);
                    isNewsletterSub = true;
                    return isEmail;
                } catch (err) {
                }

                throw new SkapiError('"subscriber" should be either valid user ID or E-Mail.', { code: 'INVALID_PARAMETER' });
            },
            group: 'number',
            subscription: (v: string) => {
                // can be
                try {
                    return validateUserId(v, 'User ID in "subscription"');
                } catch (err) {
                }

                if (typeof v === 'string' && v.length === 14) {
                    return v;
                }

                throw new SkapiError('"subscriber" should be either valid service ID or user ID.', { code: 'INVALID_PARAMETER' });
            },
            blocked: 'boolean'
        });

        if (isNewsletterSub && !params?.subscription) {
            params.subscription = this.service;
        }

        if (!params.subscriber && !params.subscription) {
            throw new SkapiError('At least either "subscriber" or "subscription" should have a value.', { code: 'INVALID_PARAMETER' });
        }

        let response = await this.request('get-subscription', params, Object.assign({ auth: !isNewsletterSub }, { fetchOptions }));

        response.list = response.list.map(_mapper || ((s: Record<string, any>) => {
            let subscription: Record<string, any> = {};
            let subSplit = s.sub.split('#');
            subscription.subscriber = subSplit[2];
            subscription.subscription = subSplit[0];
            subscription.group = parseInt(subSplit[1]);
            subscription.timestamp = s.stmp;
            subscription.blocked = s.grp.substring(0, 1) === 'N';

            return subscription;
        }));

        return response;
    }

    /**
     * Get newsletters and service letters that service owner sent out.
     * You can make use of your sent newsletters as an article for your web services.
     * ```
     * @category Subscriptions
     */
    async getNewsletters(
        params?: {
            /**
             * Search points.<br>
             * 'message_id' and 'subject' value should be string.<br>
             * Others numbers.
             */
            searchFor: 'message_id' | 'timestamp' | 'read' | 'complaint' | 'subject';
            value: string | number;
            range: string | number;
            /**
             * Defaults to '='
             */
            condition?: '>' | '>=' | '=' | '<' | '<=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte';
            /**
             * 'newsletter' for newsletters.<br>
             * Numbers for service letter sent to corresponding access groups.
             */
            group: 'newsletter' | number;
        },
        fetchOptions?: FetchOptions
    ): Promise<Newsletters> {
        let isAdmin = await this.checkAdmin();

        let searchType = {
            'message_id': 'string',
            'timestamp': 'number',
            'read': 'number',
            'complaint': 'number',
            'subject': 'string'
        };

        if (!params) {
            if (!fetchOptions) {
                fetchOptions = {};
            }
            fetchOptions.ascending = false;
        }

        let _params = params || {
            searchFor: 'timestamp',
            value: 0,
            condition: '>'
        };

        params = checkParams(_params, {
            searchFor: ['message_id', 'timestamp', 'read', 'complaint', 'group', 'subject'],
            value: (v: number | string) => {
                if (typeof v !== searchType[_params.searchFor]) {
                    throw new SkapiError(`"value" type does not match the type of "${_params.searchFor}" index.`, { code: 'INVALID_PARAMETER' });
                }
                else if (typeof v === 'string' && !v) {
                    throw new SkapiError('"value" should not be empty string.', { code: 'INVALID_PARAMETER' });
                }

                return v;
            },
            range: (v: number | string) => {
                if (!_params.hasOwnProperty('value') || typeof v !== typeof _params.value) {
                    throw new SkapiError('"range" should match type of "value".', { code: 'INVALID_PARAMETER' });
                }
                return v;
            },
            condition: ['>', '>=', '=', '<', '<=', 'gt', 'gte', 'eq', 'lt', 'lte', () => '='],
            group: (x: string | number) => {
                if (x !== 'newsletter' && !this.session) {
                    throw new SkapiError('User should be logged in.', { code: 'INVALID_REQUEST' });
                }
                if (typeof x === 'string' && x !== 'newsletter') {
                    throw new SkapiError('Group should be either "newsletter" or access group number.', { code: 'INVALID_PARAMETER' });
                }
                if (!isAdmin && x > parseInt(this.session.idToken.payload.access_group)) {
                    throw new SkapiError('User has no access.', { code: 'INVALID_REQUEST' });
                }
                if (x === 'newsletter') {
                    return 0;
                }

                return x;
            }
        }, ['searchFor', 'value', 'group']);

        let mails = await this.request(
            params.group === 0 ? 'get-newsletters' : 'get-serviceletters',
            params,
            Object.assign({ method: 'get', auth: params.group !== 0 }, { fetchOptions })
        );

        let remap = {
            'message_id': 'mid',
            'timestamp': 'stmp',
            'complaint': 'cmpl',
            'read': 'read',
            'subject': 'subj',
            'bounced': 'bnce',
            'url': 'url'
        };
        let defaults = {
            'message_id': '',
            'timestamp': 0,
            'complaint': 0,
            'read': 0,
            'subject': '',
            'bounced': 0,
            'url': ''
        };

        mails.list = mails.list.map(m => {
            let remapped = {};
            for (let k in remap) {
                remapped[k] = m[remap[k]] || defaults[remap[k]];
            }
            return remapped;
        });

        return mails;
    }

    //<_user>
    /**
     * Signup creates new user account to the service.<br>
     * You can let users confirm their signup by sending out signup confirmation E-Mail.<br>
     * Once the E-Mail is confirmed, user will receive your welcome E-Mail and will be able to login.<br>
     * The welcome E-Mail is the same E-Mail that is sent when visitor subscribes to your newsletters.<br>
     * It is advised to let your users to confirm their signup to prevent automated bots.<br>
     * Signup confirmation E-Mails will have a link that verifies the user.<br>
     * If option.confirmation is set to a url string, signup confirmation link will redirect the user to that url.<br>
     * Welcome emails will only be sent after a user logs in if option.confirmation is set to true.
     * Common pratice would be to setup a url to redirect users to your 'thankyou for signing up' page.<br>
     * If the parameter is set to true, user will be redirected to an empty html page that shows success message with your web service link below.<br>

     * 
     * ```
     * let params = {
     *     email: 'login@email.com',
     *     password: 'password',
     *     name: 'Baksa',
     *     phone_number: "+0012341234"
     * };
     *  
     * let option = {
     *     confirmation: "http://baksa.com/thankyouforsigningup"
     * };
     *  
     * await skapi.signup(params, option);
     *  
     * // signup confirmation E-Mail is sent
     * ```
     */
    @formResponse()
    async signup(
        form: Form | UserProfile & { email: String, password: String; },
        option?: {
            /**
             * When true, the service will send out confirmation E-Mail.
             * User will not be able to signin to their account unless they have confirm their email.
             */
            confirmation?: boolean;
            /**
             * Automatically login to account after signup. Will not work if E-Mail confirmation is required.
             */
            login?: boolean;
        } & FormCallbacks): Promise<User | "SUCCESS: The account has been created. User's email confirmation is required." | 'SUCCESS: The account has been created.'> {

        await this.logout();

        let params = checkParams(form || {}, {
            email: (v: string) => validateEmail(v),
            password: (v: string) => validatePassword(v),
            name: 'string',
            address: 'string',
            gender: 'string',
            birthdate: (v: string) => validateBirthdate(v),
            phone_number: (v: string) => validatePhoneNumber(v),
            email_public: ['boolean', () => false],
            address_public: ['boolean', () => false],
            gender_public: ['boolean', () => false],
            birthdate_public: ['boolean', () => false],
            phone_number_public: ['boolean', () => false],
            email_subscription: ['boolean', () => false]
        }, ['email', 'password']);

        option = checkParams(option || {}, {
            confirmation: (v: string | boolean) => {
                if (typeof v === 'string') {
                    return validateUrl(v);
                }
                else if (typeof v === 'boolean') {
                    return v;
                }
                else {
                    throw new SkapiError('"option.confirmation" should be type: <string | boolean>.', { code: 'INVALID_PARAMETER' });
                }
            },
            login: (v: boolean) => {
                if (typeof v === 'boolean') {
                    if (option.confirmation && v) {
                        throw new SkapiError('"login" is not allowed when "option.confirmation" is true.', { code: 'INVALID_PARAMETER' });
                    }
                    return v;
                }
                throw new SkapiError('"option.login" should be type: boolean.', { code: 'INVALID_PARAMETER' });
            }
        });

        let {
            login = false,
            confirmation = false
        } = option || {};

        if (!confirmation && params.email_public) {
            throw new SkapiError('"option.confirmation" should be true if "email_public" is set to true.', { code: 'INVALID_PARAMETER' });
        }

        await this.request("signup", params, { meta: option });

        if (confirmation) {
            return "SUCCESS: The account has been created. User's email confirmation is required.";
        }

        else if (login) {
            return await this.login({ email: params.email, password: params.password });
        }

        else {
            return 'SUCCESS: The account has been created.';
        }
    }

    async logout(): Promise<'SUCCESS: The user has been logged out.'> {
        await this.__connection;

        if (this.cognitoUser) {
            this.cognitoUser.signOut();
        }

        let to_be_erased = {
            'session': null,
            '__startKey_keys': {},
            '__cached_requests': {},
            '__user': null
        };

        for (let k in to_be_erased) {
            this[k] = to_be_erased[k];
        }

        return 'SUCCESS: The user has been logged out.';
    }

    async resendSignupConfirmation(
        /** Redirect url on confirmation success. */
        redirect: string
    ): Promise<'SUCCESS: Signup confirmation E-Mail has been sent.'> {
        if (!this.__request_signup_confirmation) {
            throw new SkapiError('Least one login attempt is required.', { code: 'INVALID_REQUEST' });
        }

        if (redirect) {
            validateUrl(redirect);
        }

        let resend = await this.request("confirm-signup", {
            username: this.__request_signup_confirmation,
            redirect
        });

        this.__request_signup_confirmation = null;
        return resend; // 'SUCCESS: Signup confirmation E-Mail has been sent.'
    }

    async recoverAccount(
        /** Redirect url on confirmation success. */
        redirect: boolean | string = false
    ): Promise<"SUCCESS: Recovery e-mail has been sent."> {

        if (typeof redirect === 'string') {
            validateUrl(redirect);
        }

        else if (typeof redirect !== 'boolean') {
            throw new SkapiError('Argument should be type: <boolean | string>.', { code: 'INVALID_REQUEST' });
        }

        if (!this.__disabledAccount) {
            throw new SkapiError('Least one signin attempt of disabled account is required.', { code: 'INVALID_REQUEST' });
        }

        await this.request("recover-account", { username: this.__disabledAccount, redirect });
        this.__disabledAccount = null;
        return 'SUCCESS: Recovery e-mail has been sent.';
    }

    @formResponse()
    async login(
        form: Form | {
            /** E-Mail for signin. 64 character max. */
            email: string;
            /** Password for signin. Should be at least 6 characters. */
            password: string;
        },
        option?: FormCallbacks): Promise<User> {
        await this.__connection;
        await this.logout();
        let params = checkParams(form, {
            email: (v: string) => validateEmail(v),
            password: (v: string) => validatePassword(v)
        }, ['email', 'password']);

        return this.authentication().authenticateUser(params.email, params.password);
    }

    private verifyAttribute(attribute: string, code?: string): Promise<string> {
        if (!this.cognitoUser) {
            throw new SkapiError('The user has to be logged in.', { code: 'INVALID_REQUEST' });
        }

        return new Promise((res, rej) => {
            let callback = {
                onSuccess: (result: any) => {
                    if (code) {
                        this.authentication().getUser().then(
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
                },
                inputVerificationCode: null
            };

            if (code) {
                this.cognitoUser?.verifyAttribute(attribute, code, callback);
            }
            else {
                this.cognitoUser?.getAttributeVerificationCode(attribute, callback);
            }
        });
    }

    @formResponse()
    verifyEmail(
        form?: Form | {
            /** Verification code. */
            code: string | number;
        },
        option?: FormCallbacks
    ): Promise<string> {

        let code = (form ? checkParams(form, {
            code: ['number', 'string']
        }) : {}).code || '';

        return this.verifyAttribute('email', code.toString());
    }

    @formResponse()
    verifyMobile(
        form?: Form | {
            /** Verification code. */
            code: string | number;
        },
        option?: FormCallbacks): Promise<string> {

        let code = (form ? checkParams(form, {
            code: ['number', 'string']
        }) : {}).code || null;

        return this.verifyAttribute('phone_number', code.toString());
    }

    @formResponse()
    async forgotPassword(
        form: Form | {
            /** Signin E-Mail. */
            email: string;
        },
        option?: FormCallbacks): Promise<"SUCCESS: Verification code has been sent."> {

        await this.__connection;

        let params = checkParams(form, {
            email: (v: string) => validateEmail(v)
        }, ['email']);

        return new Promise(async (res, rej) => {
            let cognitoUser = (await this.authentication().createCognitoUser(params.email)).cognitoUser;
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

    @formResponse()
    async resetPassword(form: Form | {
        /** Signin E-Mail */
        email: string;
        /** The verification code user has received. */
        code: string | number;
        /** New password to set. Verification code is required. */
        new_password: string;
    }, option?: FormCallbacks): Promise<"SUCCESS: New password has been set."> {

        await this.__connection;
        console.log({ form });
        let params = checkParams(form, {
            email: (v: string) => validateEmail(v),
            code: ['number', 'string'],
            new_password: (v: string) => validatePassword(v)
        }, ['email', 'code', 'new_password']);
        console.log({ params });
        let code = params.code, new_password = params.new_password;

        if (typeof code === 'number') {
            code = code.toString();
        }

        return new Promise(async (res, rej) => {
            let cognitoUser = (await this.authentication().createCognitoUser(params.email)).cognitoUser;

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

    async disableAccount() {
        await this.__connection;
        let result = await this.request('remove-account', { disable: true }, { auth: true });
        await this.logout();
        return result;
    }

    @formResponse()
    async updateProfile(form: Form | UserProfile, option?: FormCallbacks) {
        await this.__connection;
        if (!this.session) {
            throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
        }

        let params = checkParams(form || {}, {
            email: (v: string) => validateEmail(v),
            name: 'string',
            address: 'string',
            gender: 'string',
            birthdate: (v: string) => validateBirthdate(v),
            phone_number: (v: string) => validatePhoneNumber(v),
            email_public: 'boolean',
            phone_number_public: 'boolean',
            address_public: 'boolean',
            gender_public: 'boolean',
            birthdate_public: 'boolean',
            email_subscription: 'boolean'
        });

        if (params && typeof params === 'object' && !Object.keys(params).length) {
            return this.user;
        }

        // set alternative signin email
        if (params.email) {
            params['preferred_username'] = (await this.updateConnection({ request_hash: params.email })).hash;
        }

        let collision = [
            ['email_subscription', 'email_verified', "User's E-Mail should be verified to set"],
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
                'email_subscription'
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
                this.cognitoUser?.updateAttributes(
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

            return this.authentication().getUser();
        }

        return this.user;
    }

    @formResponse()
    async changePassword(params: {
        new_password: string;
        current_password: string;
    }) {
        await this.__connection;
        if (!this.session) {
            throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
        }

        let p = checkParams(params, {
            'current_password': 'string',
            'new_password': 'string'
        });

        if (!p?.current_password) {
            throw new SkapiError('"current_password" is required to change password.', { code: 'INVALID_PARAMETER' });
        }

        if (!p?.new_password) {
            throw new SkapiError('"new_password" is required to change password.', { code: 'INVALID_PARAMETER' });
        }

        validatePassword(p.current_password);
        validatePassword(p.new_password);

        if (p.new_password !== p.current_password) {
            return new Promise((res, rej) => {
                this.cognitoUser.changePassword(
                    p.current_password,
                    p.new_password,
                    (err: any, result: any) => {
                        if (err) {
                            if (err?.code === "InvalidParameterException") {
                                rej(new SkapiError('Invalid password parameter.', { code: 'INVALID_PARAMETER' }));
                            }
                            rej(new SkapiError(err?.message || 'Failed to change user password.', { code: err?.code || err?.name }));
                        }

                        res('SUCCESS: Password has been changed.');
                    });
            });
        }
        return 'SUCCESS: Password has been changed.';
    }

    async getUsers(params?: QueryParams | null, fetchOptions?: FetchOptions): Promise<FetchResponse> {
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

        let isAdmin = await this.checkAdmin();

        if (isAdmin && !params.hasOwnProperty('service')) {
            throw new SkapiError('Service ID is required.', { code: 'INVALID_PARAMETER' });
        }

        const searchForTypes = {
            'user_id': (v: string) => validateUserId(v),
            'name': 'string',
            'email': (v: string) => validateEmail(v),
            'phone_number': (v: string) => validatePhoneNumber(v),
            'address': 'string',
            'gender': 'string',
            'birthdate': (v: string) => validateBirthdate(v),
            'locale': (v: string) => {
                if (typeof v !== 'string' || typeof v === 'string' && v.length > 5) {
                    throw new SkapiError('Value of "locale" should be a country code.');
                }
                return v;
            },
            'subscribers': 'number',
            'timestamp': 'number',
            'access_group': 'number',
            'email_subscription': (v: number) => {
                if (!isAdmin) {
                    throw new SkapiError('Only admin is allowed to search "email_subscription".', { code: 'INVALID_REQUEST' });
                }
                return v;
            },
            'suspended': (v: boolean) => {
                if (v) {
                    return 'by_admin:suspended';
                }
                else {
                    return 'by_admin:approved';
                }
            }
        };

        let required = ['searchFor', 'value'];

        params = checkParams(params, {
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
                'email_subscription',
                'suspended'
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

        if (params.searchFor === 'user_id' && params.condition !== '=') {
            throw new SkapiError(`Conditions are not allowed on "user_id"`, { code: 'INVALID_PARAMETER' });
        }

        if (params.searchFor === 'access_group') {
            params.searchFor = 'group';
        }

        if (typeof params?.value === 'string' && !params?.value) {
            throw new SkapiError('Value should not be an empty string.', { code: 'INVALID_PARAMETER' });
        }

        if (typeof params?.searchFor === 'string' && !params?.searchFor) {
            throw new SkapiError('"searchFor" should not be an empty string.', { code: 'INVALID_PARAMETER' });
        }

        return this.request('get-users', params, { auth: true, fetchOptions });
    }

    private async updateConnection(params?: { request_hash: string; }): Promise<Connection> {

        let request = null;
        let connectedService: Record<string, any> = {};

        if (params?.request_hash) {
            // hash request

            if (this.__serviceHash[params.request_hash]) {
                // has hash
                Object.assign(connectedService, { hash: this.__serviceHash[params.request_hash] });
            }

            else {
                // request signin hash
                request = {
                    request_hash: validateEmail(params.request_hash)
                };
            }
        }

        if (!this.connection || this.connection.service !== this.service || request) {
            // has hash request or need new connection request

            if (request === null) {
                request = {};
            }

            // assign service id and owner to request
            Object.assign(request, {
                service: this.service,
                service_owner: this.service_owner
            });
        }

        // post request if needed
        Object.assign(connectedService, (request ? await this.request('service', request, { bypassAwaitConnection: true }) : this.connection));

        if (params?.request_hash) {
            // cache hash if needed
            this.__serviceHash[params.request_hash] = connectedService.hash;
        }

        // deep copy, save connection service info without hash
        let connection = JSON.parse(JSON.stringify(connectedService));
        delete connection.hash;
        this.connection = connection;

        return connectedService as Connection;
    }
}