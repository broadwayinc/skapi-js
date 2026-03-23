import {
    DatabaseResponse,
    Connection,
    ProgressCallback,
    GetRecordQuery,
    FetchOptions,
    RecordData,
    Condition,
    UserAttributes,
    UserProfile,
    Newsletter,
    Form,
    PostRecordConfig,
    UserPublic,
    UserProfilePublicSettings,
    FileInfo,
    RTCEvent,
    RealtimeCallback,
    RTCConnectorParams,
    RTCConnector,
    DelRecordQuery,
    ConnectionInfo,
    Table,
    Index,
    Tag,
    UniqueId,
    Subscription,
} from '../Types';
import {
    CognitoUserPool
} from 'amazon-cognito-identity-js';
import SkapiError from './error';
import validator from '../utils/validator';
import {
    getRecords,
    postRecord,
    bulkPostRecords,
    deleteRecords,
    getTables,
    getIndexes,
    getTags,
    getFile,
    grantPrivateRecordAccess,
    removePrivateRecordAccess,
    listPrivateRecordAccess,
    requestPrivateRecordAccessKey,
    deleteFiles,
    getUniqueId
} from '../methods/database';
import {
    connectRealtime,
    joinRealtime,
    postRealtime,
    closeRealtime,
    getRealtimeUsers,
    getRealtimeGroups,
} from '../methods/realtime';
import {
    closeRTC,
    connectRTC
} from '../methods/webrtc';
import {
    secureRequest,
    mock,
    clientSecretRequest,
    sendInquiry
} from '../methods/request';
import {
    request,
    getFormResponse,
    formHandler,
    uploadFiles,
    terminatePendingRequests
} from '../utils/network';
import {
    subscribe,
    unsubscribe,
    blockSubscriber,
    unblockSubscriber,
    getSubscriptions,
    subscribeNewsletter,
    getNewsletters,
    unsubscribeNewsletter,
    getNewsletterSubscription,
    getFeed,
    // adminNewsletterRequest,
    // registerNewsletterGroup,
    // newsletterGroupEndpoint,
} from '../methods/subscription';
import {
    getProfile,
    logout,
    recoverAccount,
    resendSignupConfirmation,
    authentication,
    login,
    signup,
    disableAccount,
    resetPassword,
    verifyEmail,
    verifyPhoneNumber,
    forgotPassword,
    changePassword,
    updateProfile,
    getUsers,
    lastVerifiedEmail,
    requestUsernameChange,
    consumeTicket,
    getConsumedTickets,
    getTickets,
    registerTicket,
    unregisterTicket,
    _out,
    openIdLogin,
    loginWithToken
} from '../methods/user';
import {
    extractFormData,
    fromBase62,
    generateRandom,
    toBase62,
    MD5,
    isBrowserRuntime,
    isNodeRuntime,
    decodeServiceId,
    formatServiceId,
} from '../utils/utils';
import {
    blockAccount,
    unblockAccount,
    deleteAccount,
    inviteUser,
    createAccount,
    grantAccess,
    getInvitations,
    cancelInvitation,
    resendInvitation
} from '../methods/admin';
import {
    subscribeNotification,
    vapidPublicKey,
    pushNotification,
    unsubscribeNotification
} from '../methods/notification';
import {
    spellcast, dopamine, getspell
} from '../methods/vivian';
import packageJson from '../../package.json';

type Options = {
    autoLogin: boolean;
    requestBatchSize?: number; // default 30. number of requests to be handled in a batch
    // bearerToken?: string; // custom bearer token for authentication
    eventListener?: {
        onLogin?: (user: UserProfile | null) => void;
        onUserUpdate?: (user: UserProfile | null) => void;
        onBatchProcess?: (process: {
            batchToProcess: number;
            itemsToProcess: number;
            completed: any[];
        }) => void;
    },
}

export default class Skapi {
    // current version
    private __version = packageJson.version;
    service: string;
    owner: string;
    session: Record<string, any> | null = null;
    connection: Connection | null = null;
    private __my_unique_ids: { [rec_id: string]: string } = {};
    private userPool: CognitoUserPool | null = null;
    private __socket: Promise<WebSocket> | null = null;
    private __mediaStream: MediaStream = null;

    private host = 'skapi';
    private hostDomain = 'skapi.com';
    private target_cdn = 'd3e9syvbtso631';
    private customApiDomain = 'skapi.dev';
    private requestBatchSize = 30;

    // privates
    private __disabledAccount: string | null = null;
    private __cached_requests: {
        /** Cached url requests */
        [url: string]: {
            /** Array of data stored in hashed params key */
            [hashedParams: string]: DatabaseResponse<any>;
        };
    } = {};

    private __startKeyHistory: {
        /** List of startkeys */
        [url: string]: {
            [hashedParams: string]: string[];
        };
    } = {};
    private __request_signup_confirmation: string | null = null;
    private __private_access_key: {
        [record_id: string]: string;
    } = {}

    // true when session is stored successfully to session storage
    // this property prevents duplicate stores when window closes on some device
    private __class_properties_has_been_cached = false;

    /** Current logged in user object. null if not logged. */
    private __user: UserProfile | null = null;

    get user(): UserProfile | null {
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

    private _userProfileListeners: Function[] = [];
    private _onLoginListeners: Function[] = [];

    get onLogin(): Function[] {
        return this._onLoginListeners;
    }

    set onLogin(listener: (user: UserProfile | null) => void) {
        if (typeof listener === 'function') {
            this._onLoginListeners.push(listener);
        }
    }

    get onUserUpdate(): Function[] {
        return this._userProfileListeners;
    }

    set onUserUpdate(listener: (user: UserProfile | null) => void) {
        if (typeof listener === 'function') {
            this._userProfileListeners.push(listener);
        }
    }

    private _runOnUserUpdateListeners(user: UserProfile | null) {
        for (let listener of this._userProfileListeners) {
            if (typeof listener === 'function') {
                listener(user);
            }
        }
    }

    private _runOnLoginListeners(user: UserProfile | null) {
        for (let listener of this._onLoginListeners) {
            if (typeof listener === 'function') {
                listener(user);
            }
        }
    }

    private admin_endpoint: Promise<Record<string, any>>;
    private record_endpoint: Promise<Record<string, any>>;

    private _onBatchProcessListeners: ((process: {
        batchToProcess: number;
        itemsToProcess: number;
        completed: any[];
    }) => void)[] = [];

    get onBatchProcess(): ((process: {
        batchToProcess: number;
        itemsToProcess: number;
        completed: any[];
    }) => void)[] {
        return this._onBatchProcessListeners;
    }

    set onBatchProcess(listener: (process: {
        batchToProcess: number;
        itemsToProcess: number;
        completed: any[];
    }) => void) {
        if (typeof listener === 'function') {
            this._onBatchProcessListeners.push(listener);
        }
    }

    validate = {
        userId(val: string) {
            try {
                validator.UserId(val);
                return true;
            } catch (err) {
                return false;
            }
        },
        url(val: string | string[]) {
            try {
                validator.Url(val);
                return true;
            } catch (err) {
                return false;
            }
        },
        phoneNumber(val: string) {
            try {
                validator.PhoneNumber(val);
                return true;
            } catch (err) {
                return false;
            }
        },
        birthdate(val: string) {
            try {
                validator.Birthdate(val);
                return true;
            } catch (err) {
                return false;
            }
        },
        email(val: string) {
            try {
                validator.Email(val);
                return true;
            } catch (err) {
                return false;
            }
        },
        params(val: any, schema: Record<string, any>, required?: string[]) {
            return validator.Params(val, schema, required);
        }
    };

    util = {
        MD5,
        generateRandom,
        toBase62,
        fromBase62,
        decodeServiceId,
        formatServiceId,
        extractFormData,
        terminatePendingRequests,
        request: (
            url: string,
            data?: Form<any>,
            options?: {
                fetchOptions?: FetchOptions;
                auth?: boolean;
                method?: string;
                bypassAwaitConnection?: boolean;
                responseType?: 'json' | 'blob' | 'text' | 'arrayBuffer' | 'formData' | 'document';
                contentType?: string;
            }
        ) => request.bind(this)(url, data, options, { ignoreService: true })
    }

    private __connection: Promise<Connection>;
    private __authConnection: Promise<void>;
    private __network_logs = false;
    private __endpoint_version = 'v1';
    private __public_identifier = '';
    private bearerToken: string = '';

    private _alert(message: string) {
        if (isBrowserRuntime() && typeof window.alert === 'function') {
            window.alert(message);
        }
    }

    constructor(service: string, owner?: string | Options, options?: Options | any, __etc?: any) {
        if (!service || typeof service !== 'string') {
            this._alert("Service ID is required.");
            throw new SkapiError('Service ID is required.', { code: 'INVALID_PARAMETER' });
        }
        if (service.startsWith('s1_') || service.split("-").length === 7) {
            try {
                let decoded = decodeServiceId(service);
                if (options && typeof options === 'object') {
                    __etc = options;
                }

                if (owner && typeof owner === 'object') {
                    options = owner;
                }

                owner = decoded.owner;
                service = decoded.service;
            }
            catch (err) {
                this._alert("Service ID is invalid.");
                throw new SkapiError('Service ID is invalid.', { code: 'INVALID_PARAMETER' });
            }
        }

        // if (!window.sessionStorage) {
        //     throw new SkapiError('Web browser API is not available.', { code: 'NOT_SUPPORTED' });
        // }
        // window.sessionStorage.setItem('__skapi_kiss', 'kiss');
        // if (window.sessionStorage.getItem('__skapi_kiss') !== 'kiss') {
        //     window.alert('Session storage is disabled. Please enable session storage.');
        //     throw new SkapiError('Session storage is disabled. Please enable session storage.', { code: 'SESSION_STORAGE_DISABLED' });
        // }

        // window.sessionStorage.removeItem('__skapi_kiss');

        if (!owner || typeof owner !== 'string') {
            this._alert("Owner ID is invalid.");
            throw new SkapiError('Owner ID is invalid.', { code: 'INVALID_PARAMETER' });
        }

        if (service.toLowerCase() === 'service_id') {
            this._alert('Replace "service_id" with your actual Service ID.');
            throw new SkapiError('Service ID is required.', { code: 'INVALID_PARAMETER' });
        }

        if (owner !== this.host) {
            try {
                validator.UserId(owner, '"owner"');
            } catch (err: any) {
                this._alert("Owner ID is invalid.");
                throw new SkapiError('Owner ID is invalid.', { code: 'INVALID_PARAMETER' });
            }
        }

        this.service = service;
        this.owner = owner;

        let autoLogin = true;

        if (options) {
            if (typeof options.autoLogin === 'boolean') {
                autoLogin = options.autoLogin;
            }
            if (typeof options.requestBatchSize === 'number') {
                if (options.requestBatchSize < 1) {
                    throw new SkapiError('"requestBatchSize" must be greater than 0.', { code: 'INVALID_PARAMETER' });
                }
                this.requestBatchSize = options.requestBatchSize;
            }
        }

        if (options?.eventListener && typeof options.eventListener === 'object') {
            if (options.eventListener?.onLogin && typeof options.eventListener.onLogin === 'function') {
                this.onLogin = options.eventListener.onLogin;
            }

            if (options.eventListener?.onUserUpdate && typeof options.eventListener.onUserUpdate === 'function') {
                this.onUserUpdate = options.eventListener.onUserUpdate;
            }

            if (options.eventListener?.onBatchProcess && typeof options.eventListener.onBatchProcess === 'function') {
                this.onBatchProcess = options.eventListener.onBatchProcess;
            }
        }

        // get endpoints

        this.target_cdn = __etc?.target_cdn || this.target_cdn;
        this.hostDomain = __etc?.hostDomain || this.hostDomain;
        this.customApiDomain = __etc?.customApiDomain || this.customApiDomain;

        this.__network_logs = !!__etc?.network_logs;

        const cdn_domain = `https://${this.target_cdn}.cloudfront.net`; // don't change this
        let sreg = service.substring(0, 4);

        this.admin_endpoint = fetch(`${cdn_domain}/${sreg}/admin-${this.__endpoint_version}.json`)
            .then(response => response.blob())
            .then(blob => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            }))
            .then(data => {
                try {
                    return typeof data === 'string' ? JSON.parse(atob(data.split(',')[1])) : null
                }
                catch (err) {
                    throw new SkapiError('Service does not exist. Create your service from skapi.com', { code: 'NOT_EXISTS' });
                }
            });

        this.record_endpoint = fetch(`${cdn_domain}/${sreg}/record-${this.__endpoint_version}.json`)
            .then(response => response.blob())
            .then(blob => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            }))
            .then(data => {
                try {
                    return typeof data === 'string' ? JSON.parse(atob(data.split(',')[1])) : null
                }
                catch (err) {
                    throw new SkapiError('Service does not exist. Create your service from skapi.com', { code: 'NOT_EXISTS' });
                }
            });

        const hasWindow = isBrowserRuntime();

        if (hasWindow && !window.sessionStorage) {
            this._alert('This browser is not supported.');
            throw new Error(`This browser is not supported.`);
        }

        const restore = hasWindow ? JSON.parse(window.sessionStorage.getItem(`${service}#${owner}`) || 'null') : null;

        this.log('constructor:restore', restore);

        if (restore?.connection) {
            // apply all data to class properties
            for (let k in restore) {
                this[k] = restore[k];
            }

            if (!restore.__public_identifier) {
                this.__public_identifier = `${this.service}:${this.owner}:${generateRandom(16)}`;
            }
        }

        this.__authConnection = (async (): Promise<void> => {
            const admin_endpoint = await this.admin_endpoint;
            const poolSetting = {
                UserPoolId: admin_endpoint.userpool_id,
                ClientId: admin_endpoint.userpool_client
            } as any;
            if (isNodeRuntime()) {
                poolSetting.Storage = window.localStorage;
            }
            this.userPool = new CognitoUserPool(poolSetting);

            try {
                if (!this.user) {
                    // if (autoLogin && typeof autoLogin === 'object') {
                    //     let { idToken = '', accessToken = '', refreshToken = '' } = autoLogin || {};
                    //     if (idToken) {
                    //         await this.loginWithToken({ idToken, accessToken, refreshToken });
                    //     }
                    // }
                    await authentication.bind(this)().getSession({
                        skipUserUpdateEventTrigger: true
                    });
                }
                if (this.user) {
                    if (!restore?.connection && !autoLogin) {
                        _out.bind(this)();
                    }
                    else {
                        // only run login listeners if user is logged in (auto login successful)
                        this._runOnLoginListeners(this.user);
                        this._runOnUserUpdateListeners(this.user);
                    }
                }
            }
            catch (err) {
            }
        })()

        let uniqueids = hasWindow ? window.sessionStorage.getItem(`${this.service}:uniqueids`) : null;
        if (uniqueids) {
            try {
                this.__my_unique_ids = JSON.parse(uniqueids);
            } catch (err) {
                this.__my_unique_ids = {};
            }
        }

        // connects to server
        this.__connection = (async (): Promise<Connection> => {
            let connection: Promise<Connection> = null;
            await this.record_endpoint;

            if (!restore?.connection) {
                // await for first connection
                connection = this._updateConnection();
            }

            const storeClassProperties = () => {
                if (this.__class_properties_has_been_cached) {
                    return;
                }

                let exec = () => {
                    let data: Record<string, any> = {};

                    const to_be_cached = [
                        '__startKeyHistory', // startKey key : {}
                        '__disabledAccount', // disabled account : null
                        '__cached_requests', // cached records : {}
                        '__request_signup_confirmation', // for resend signup confirmation : null
                        '__public_identifier', // public identifier : ''
                        'connection', // service info : null
                    ];

                    if (this.connection) {
                        for (let k of to_be_cached) {
                            data[k] = this[k];
                        }

                        if (hasWindow) {
                            window.sessionStorage.setItem(`${service}#${owner}`, JSON.stringify(data));
                        }
                        this.__class_properties_has_been_cached = true;
                    }
                };

                return (connection instanceof Promise) ? connection.then(() => exec()) : exec();
            };

            // attach event to save session on close
            if (hasWindow) {
                window.addEventListener('beforeunload', () => {
                    this.closeRealtime();
                    storeClassProperties();
                });
                // for mobile
                window.addEventListener("visibilitychange", () => {
                    storeClassProperties();
                });
            }

            await connection;
            await this.__authConnection;
            return this.connection;
        })();

        this.__connection.then(conn => {
            if ((conn?.group || 0) < 3 || this.__network_logs) {
                this.version();
            }
        });
    }

    /**
     * Returns current connection metadata such as service name, client IP, user agent, locale, and SDK version.
     * @returns A promise that resolves to Promise<ConnectionInfo>.
     */
    async getConnectionInfo(): Promise<ConnectionInfo> {
        let conn = await this.__connection;
        // get browser user-agent info
        let ua = conn?.user_agent || (isBrowserRuntime() && typeof window.navigator?.userAgent === 'string'
            ? window.navigator.userAgent
            : `skapi-node/${(globalThis as any)?.process?.versions?.node || 'unknown'}`);
        return {
            user_ip: conn.ip,
            user_agent: ua,
            user_location: conn.locale,
            service_name: conn.service_name,
            version: this.__version
        };
    }

    private async _updateConnection(): Promise<Connection> {
        try {
            this.connection = await request.bind(this)('service', {
                service: this.service,
                owner: this.owner
            }, { bypassAwaitConnection: true, method: 'get' });
        }
        catch (err: any) {
            this.log('connection fail', err);
            this._alert('Service is not available: ' + (err.message || err.toString()));

            this.connection = null;
            throw err;
        }
        return this.connection;
    }

    private registerTicket = registerTicket.bind(this);
    private unregisterTicket = unregisterTicket.bind(this);

    /**
     * Returns the current SDK version and prints runtime version details in browser environments.
     * @returns A promise that resolves to Promise<string>.
     */
    async version(): Promise<string> {
        await this.__connection;

        if (isBrowserRuntime()) {
            let skapi = `%c\r\n          $$\\                          $$\\ \r\n          $$ |                         \\__|\r\n $$$$$$$\\ $$ |  $$\\ $$$$$$\\   $$$$$$\\  $$\\ \r\n$$  _____|$$ | $$  |\\____$$\\ $$  __$$\\ $$ |\r\n\\$$$$$$\\  $$$$$$  \/ $$$$$$$ |$$ \/  $$ |$$ |\r\n \\____$$\\ $$  _$$< $$  __$$ |$$ |  $$ |$$ |\r\n$$$$$$$  |$$ | \\$$\\\\$$$$$$$ |$$$$$$$  |$$ |\r\n\\_______\/ \\__|  \\__|\\_______|$$  ____\/ \\__|\r\n                             $$ |          \r\n                             $$ |          \r\n                             \\__|          \r\n`;
            let message = `Built with:\n${skapi}Version: ${this.__version}\n\nFull Documentation: https://docs.skapi.com/skapi.md`;
            console.log(message, `font-family: monospace; color:blue;`);
            if (this.connection.group === 1) {
                console.log(`%cSKAPI: THE SERVICE IS IN TRIAL MODE.`, `font-family: monospace; color:red;`);
            }
        }
        return this.__version;
    }

    private log(n: string, v: any) {
        if (this.__network_logs) {
            if (typeof v === 'object') {
                try {
                    v = JSON.parse(JSON.stringify(v));
                }
                catch (err) {
                    v = String(v);
                }
            }

            else if (typeof v === 'string' && v.length > 100) {
                v = v.substring(0, 100) + '...';
            }

            console.log(`%c${n}:`, 'color: blue;', v);
        }
    }

    /**
     * Fetches feed records visible to the current user with optional access-group filtering and pagination.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<RecordData>>.
     */
    @formHandler()
    getFeed(params?: { access_group?: number; }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<RecordData>> {
        return getFeed.bind(this)(params, fetchOptions);
    }

    /**
     * Closes an active WebRTC connection by cid or closes all active RTC connections.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<void>.
     */
    @formHandler()
    closeRTC(params: { cid?: string; close_all?: boolean; }): Promise<void> {
        return closeRTC.bind(this)(params);
    }

    /**
     * Creates or joins a WebRTC session and returns an RTC connector for streaming events and controls.
     * @param params Request parameters.
     * @param callback Callback invoked for events or updates.
     * @returns A promise that resolves to Promise<RTCConnector>.
     */
    @formHandler()
    connectRTC(
        params: RTCConnectorParams,
        callback?: (e: RTCEvent) => void
    ): Promise<RTCConnector> {
        return connectRTC.bind(this)(params, callback);
    }

    /**
     * Opens a realtime WebSocket connection and registers a callback for incoming realtime messages.
     * @param callback Callback invoked for events or updates.
     * @returns A promise that resolves to Promise<WebSocket>.
     */
    connectRealtime(callback: RealtimeCallback): Promise<WebSocket> {
        return connectRealtime.bind(this)(callback);
    }

    /**
     * Runs a spellcast operation and stores or returns generated spell data.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<string>.
     */
    @formHandler()
    spellcast(params: {
        spell: string,
        name: string,
        magic?: any
    }): Promise<string> {
        return spellcast.bind(this)(params)
    }

    /**
     * Searches previously stored spell records by spell text or name. Defaults to 'spell' search if no search type is specified.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<DatabaseResponse<{ spell: string; magic?: any; name: string; }>>.
     */
    @formHandler()
    getspell(params?: {
        search?: 'spell' | 'name',
        value?: string,
    }): Promise<DatabaseResponse<{
        spell: string;
        name: string;
        magic?: any;
    }>> {
        return getspell.bind(this)(params)
    }

    /**
     * Sends a dopamine message payload and returns the previous message.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<string>.
     */
    @formHandler()
    dopamine(params: {
        message: string,
        name: string
    }): Promise<string> {
        return dopamine.bind(this)(params)
    }
    /**
     * Queries unique ID records by unique_id or condition filters.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<UniqueId>>.
     */
    @formHandler()
    getUniqueId(params: Form<{
        /** Unique ID */
        unique_id?: string;
        /** String query condition for tag name. */
        condition?: Condition;
    }>, fetchOptions?: FetchOptions): Promise<DatabaseResponse<UniqueId>> {
        return getUniqueId.bind(this)(params, fetchOptions);
    }

    /**
     * Resends an existing user invitation email to the target address.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<"SUCCESS: Invitation has been re-sent. (User ID: xxx...)">.
     */
    @formHandler()
    resendInvitation(params: Form<{
        email: string;
        confirmation_url?: string;
    }>): Promise<"SUCCESS: Invitation has been re-sent. (User ID: xxx...)"> {
        return resendInvitation.bind(this)(params);
    }

    /**
     * Cancels a pending invitation for the target email address.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<"SUCCESS: Invitation has been canceled.">.
     */
    @formHandler()
    cancelInvitation(params: Form<{
        email: string;
    }>): Promise<"SUCCESS: Invitation has been canceled."> {
        return cancelInvitation.bind(this)(params);
    }

    /**
     * Lists invitation records with optional email filtering and pagination.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<UserProfile>>.
     */
    @formHandler()
    getInvitations(params: Form<{
        email?: string;
    }>, fetchOptions: FetchOptions): Promise<DatabaseResponse<UserProfile>> {
        return getInvitations.bind(this)(params, fetchOptions);
    }

    /**
     * Completes OpenID login and optionally merges the OpenID identity with an existing account.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<{ userProfile: UserProfile; openid: { [attribute: string]: string } }>.
     */
    @formHandler()
    openIdLogin(params: { token: string; id: string; merge?: boolean | string[]; }): Promise<{ userProfile: UserProfile; openid: { [attribute: string]: string } }> {
        return openIdLogin.bind(this)(params);
    }

    /**
     * Logs in a user with externally issued id/access/refresh tokens.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<UserProfile>.
     */
    @formHandler()
    loginWithToken(params: { idToken: string; accessToken?: string; refreshToken?: string; }): Promise<UserProfile> {
        return loginWithToken.bind(this)(params);
    }

    // /**
    //  * Creates or updates a newsletter group with its delivery restriction settings.
    //  * @param params Request parameters.
    //  * @returns A promise that resolves to Promise<"SUCCESS: Your newsletter group has been registered.">.
    //  */
    // @formHandler()
    // registerNewsletterGroup(params: Form<{
    //     group: string;
    //     restriction: number;
    // }>): Promise<"SUCCESS: Your newsletter group has been registered."> {
    //     return registerNewsletterGroup.bind(this)(params) as Promise<"SUCCESS: Your newsletter group has been registered.">;
    // }
    /**
     * Sends a secure outbound request using a Skapi client secret key.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<any>.
     */
    @formHandler()
    clientSecretRequest(params: {
        url: string;
        clientSecretName: string;
        method: 'GET' | 'POST' | 'DELETE' | 'PUT';
        headers?: { [key: string]: string };
        data?: { [key: string]: any };
        params?: { [key: string]: string };
    }): Promise<any> {
        return clientSecretRequest.bind(this)(params);
    }

    /**
     * Consumes a one-time ticket and executes the ticketed request payload.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<any>.
     */
    @formHandler()
    consumeTicket(params: {
        ticket_id: string;
        method: string; // GET | POST
        auth?: boolean;
        data?: {
            [key: string]: any;
        }
    }): Promise<any> {
        return consumeTicket.bind(this)(params);
    }

    /**
     * Lists consumed tickets with optional filters and pagination.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<any[]>>.
     */
    @formHandler()
    getConsumedTickets(params: { ticket_id?: string; }, fetchOptions: FetchOptions): Promise<DatabaseResponse<any[]>> {
        return getConsumedTickets.bind(this)(params, fetchOptions);
    }

    /**
     * Lists issued tickets with optional filters and pagination.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<any[]>>.
     */
    @formHandler()
    getTickets(params: { ticket_id?: string; }, fetchOptions: FetchOptions): Promise<DatabaseResponse<any[]>> {
        return getTickets.bind(this)(params, fetchOptions);
    }

    /**
     * Closes the active realtime WebSocket connection.
     * @returns A promise that resolves to Promise<void>.
     */
    closeRealtime(): Promise<void> {
        return closeRealtime.bind(this)();
    }

    /**
     * Fetches currently connected users in a realtime group.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<{ user_id: string; cid: string }[]>>.
     */
    @formHandler()
    getRealtimeUsers(params: { group: string, user_id?: string }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<{ user_id: string; cid: string }[]>> {
        return getRealtimeUsers.bind(this)(params, fetchOptions);
    }

    /**
     * Sends an inquiry email payload to the service contact channel.
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<"SUCCESS: Inquiry has been sent.">.
     */
    @formHandler()
    sendInquiry(params: Form<{
        name: string;
        email: string;
        subject: string;
        message: string;
    }>): Promise<"SUCCESS: Inquiry has been sent."> {
        return sendInquiry.bind(this)(params);
    }

    /**
     * Blocks a user account by user_id.
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<"SUCCESS: The user has been blocked.">.
     */
    @formHandler()
    blockAccount(params: { user_id: string }): Promise<"SUCCESS: The user has been blocked."> {
        return blockAccount.bind(this)(params);
    }

    /**
     * Unblocks a previously blocked user account by user_id.
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<"SUCCESS: The user has been unblocked.">.
     */
    @formHandler()
    unblockAccount(params: { user_id: string }): Promise<"SUCCESS: The user has been unblocked."> {
        return unblockAccount.bind(this)(params);
    }

    /**
     * Deletes a user account by user_id.
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<"SUCCESS: Account has been deleted.">.
     */
    @formHandler()
    deleteAccount(params: { user_id: string }): Promise<"SUCCESS: Account has been deleted."> {
        return deleteAccount.bind(this)(params);
    }


    /**
     * Invites a user by email with optional attributes and invitation email options.
     * @param params Payload for the request.
     * @param options Optional behavior configuration.
     * @returns A promise that resolves to Promise<'SUCCESS: Invitation has been sent.'>.
     */
    @formHandler()
    inviteUser(
        params: { email: string; } & UserAttributes & UserProfilePublicSettings,
        options?: {
            confirmation_url?: string;
            email_subscription?: boolean;
            template?: {
                url: string;
                subject: string;
            }
        }
    ): Promise<'SUCCESS: Invitation has been sent.'> {
        return inviteUser.bind(this)(params, options);
    }

    /**
     * Creates a user account directly from admin context.
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<UserProfile & { email_admin: string; username: string; }>.
     */
    @formHandler()
    createAccount(
        params: { email: string; password: string; } & UserAttributes & UserProfilePublicSettings
    ): Promise<UserProfile & { email_admin: string; username: string; }> {
        return createAccount.bind(this)(params);
    }

    /**
     * Updates a user's access_group level.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<'SUCCESS: Access has been granted to the user.'>.
     */
    @formHandler()
    grantAccess(params: {
        user_id: string;
        access_group: number;
    }): Promise<'SUCCESS: Access has been granted to the user.'> {
        return grantAccess.bind(this)(params);
    }

    /**
     * Lists realtime groups with optional search conditions and pagination.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<{ group: string; number_of_users: number; }>>.
     */
    @formHandler()
    getRealtimeGroups(
        params?: {
            /** Index name to search. */
            searchFor: 'group' | 'number_of_users';
            /** Index value to search. */
            value: string | number;
            /** Search condition. */
            condition?: '>' | '>=' | '=' | '<' | '<=' | '!=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte' | 'ne';
            /** Range of search. */
            range?: string | number;
        } | null,
        fetchOptions?: FetchOptions
    ): Promise<DatabaseResponse<{ group: string; number_of_users: number; }>> {
        return getRealtimeGroups.bind(this)(params, fetchOptions);
    }
    // /**
    //  * Calls the newsletter group endpoint for administrative group operations.
    //  * @param params Request parameters.
    //  */
    // @formHandler()
    // newsletterGroupEndpoint(params) {
    //     return newsletterGroupEndpoint.bind(this)(params);
    // }
    /**
     * Sends realtime data to a user or group with optional push notification metadata.
     * @param message Message payload to send.
     * @param recipient Recipient user or group target.
     * @param notification Optional notification payload.
     * @returns A promise that resolves to Promise<{ type: 'success', message: 'Message sent.' }>.
     */
    @formHandler()
    postRealtime(message: any, recipient: string, notification?: { config?: { always: boolean; }; title: string; body: string; }): Promise<{ type: 'success', message: 'Message sent.' }> {
        return postRealtime.bind(this)(message, recipient, notification);
    }

    /**
     * Joins the current connection to a realtime group or leaves group membership when null.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<{ type: 'success', message: string }>.
     */
    @formHandler()
    joinRealtime(params: { group: string | null }): Promise<{ type: 'success', message: string }> {
        return joinRealtime.bind(this)(params);
    }

    // /**
    //  * Returns the active service connection object after initialization.
    //  * @returns A promise that resolves to Promise<Connection>.
    //  */
    // private _getConnection(): Promise<Connection> {
    //     return this.__connection;
    // }

    /**
     * Retrieves the currently authenticated user profile, optionally refreshing token/session state.
     * @param options Optional behavior configuration.
     * @returns A promise that resolves to Promise<UserProfile | null>.
     */
    @formHandler()
    getProfile(options?: { refreshToken: boolean; }): Promise<UserProfile | null> {
        return getProfile.bind(this)(options);
    }
    /**
     * Retrieves a file by URL with optional conversion mode, expiration, and progress handling.
     * @param url Target URL.
     * @param config Additional configuration options.
     * @returns A promise that resolves to Promise<Blob | string | void | FileInfo>.
     */
    @formHandler()
    getFile(
        url: string, // cdn endpoint url https://xxxx.cloudfront.net/path/file
        config?: {
            dataType?: 'base64' | 'download' | 'endpoint' | 'blob' | 'text' | 'info'; // default 'download'
            expires?: number; // uses url that expires. this option does not use the cdn (slow). can be used for private files. (does not work on public files).
            progress?: ProgressCallback;
        }
    ): Promise<Blob | string | void | FileInfo> {
        return getFile.bind(this)(url, config);
    }
    /**
     * Executes authenticated secure API requests in single or batch mode.
     * @param params Request parameters.
     * @param url Target URL.
     * @returns A promise that resolves to Promise<Response | Response[]>.
     */
    @formHandler()
    secureRequest<Params = {
        /** Request url */
        url: string;
        /** Request data */
        data?: any;
        /** requests are sync when true */
        sync?: boolean;
    }, Response = { response: any; statusCode: number; url: string; }>(params: Params[] | Form<Params>, url?: string): Promise<Response | Response[]> {
        return secureRequest.bind(this)(params, url);
    }
    /**
     * Returns a normalized response object for form-based handler flows.
     * @returns A promise that resolves to Promise<any>.
     */
    @formHandler()
    getFormResponse(): Promise<any> {
        return getFormResponse.bind(this)();
    }
    /**
     * Queries database records with filtering, sorting, and pagination options.
     * @param query Query object used to filter results.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<RecordData>>.
     */
    @formHandler()
    getRecords(query: GetRecordQuery, fetchOptions?: FetchOptions): Promise<DatabaseResponse<RecordData>> {
        return getRecords.bind(this)(query, fetchOptions);
    }
    /**
     * Lists table metadata with optional table-name filters.
     * @param query Query object used to filter results.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<Table>>.
     */
    @formHandler()
    getTables(
        /** If null fetch all list of tables. */
        query: {
            table: string;
            /** Condition operator of table name. */
            condition?: Condition;
        },
        fetchOptions?: FetchOptions
    ): Promise<DatabaseResponse<Table>> {
        return getTables.bind(this)(query, fetchOptions);
    }
    /**
     * Lists index metadata and aggregated index statistics for a table.
     * @param query Query object used to filter results.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<Index>>.
     */
    @formHandler()
    getIndexes(
        query: {
            /** Table name */
            table: string;
            /** Index name. When period is at the end of name, querys nested index keys. */
            index?: string;
            /** Queries order by */
            order?: {
                /** Key name to order by. */
                by: 'average_number' | 'total_number' | 'number_count' | 'average_bool' | 'total_bool' | 'bool_count' | 'string_count' | 'index_name';
                /** Value to query. */
                value?: number | boolean | string;
                condition?: Condition;
            };
        },
        fetchOptions?: FetchOptions
    ): Promise<DatabaseResponse<Index>> { return getIndexes.bind(this)(query, fetchOptions); }
    /**
     * Lists tags used in a table with optional tag-name filtering.
     * @param query Query object used to filter results.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<Tag>>.
     */
    @formHandler()
    getTags(
        query: {
            /** Table name */
            table: string;
            /** Tag name */
            tag?: string;
            /** String query condition for tag name. */
            condition?: Condition;
        },
        fetchOptions?: FetchOptions
    ): Promise<DatabaseResponse<Tag>> { return getTags.bind(this)(query, fetchOptions); }
    /**
     * Deletes records by query or record_id and returns deletion results.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<string | DatabaseResponse<RecordData>>.
     */
    @formHandler()
    deleteRecords(params: DelRecordQuery, fetchOptions?: FetchOptions): Promise<string | DatabaseResponse<RecordData>> { return deleteRecords.bind(this)(params, fetchOptions); }
    /**
     * Resends the signup confirmation email for the current pending account.
     * @returns A promise that resolves to Promise<'SUCCESS: Signup confirmation e-mail has been sent.'>.
     */
    @formHandler()
    resendSignupConfirmation(): Promise<'SUCCESS: Signup confirmation e-mail has been sent.'> {
        return resendSignupConfirmation.bind(this)();
    }
    /**
     * Sends an account recovery email and optionally sets a recovery redirect URL.
     * @param redirect Redirect URL or false to disable redirect.
     * @returns A promise that resolves to Promise<"SUCCESS: Recovery e-mail has been sent.">.
     */
    @formHandler()
    recoverAccount(
        /** Redirect url on confirmation success. */
        redirect: boolean | string = false
    ): Promise<"SUCCESS: Recovery e-mail has been sent."> {
        return recoverAccount.bind(this)(redirect);
    }
    /**
     * Queries users by supported profile/search fields with pagination.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<UserPublic>>.
     */
    @formHandler()
    getUsers(
        params?: {
            /** Index name to search. */
            searchFor: 'user_id' | 'email' | 'phone_number' | 'locale' | 'name' | 'address' | 'gender' | 'birthdate' | 'subscribers' | 'timestamp' | 'approved';
            /** Index value to search. */
            value: string | number | boolean | string[];
            /** Search condition. */
            condition?: '>' | '>=' | '=' | '<' | '<=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte';
            /** Range of search. */
            range?: string | number | boolean;
        },
        fetchOptions?: FetchOptions): Promise<DatabaseResponse<UserPublic>> {
        return getUsers.bind(this)(params, fetchOptions);
    }
    /**
     * Disables the currently logged-in user account.
     * @returns A promise that resolves to Promise<'SUCCESS: account has been disabled.'>.
     */
    @formHandler()
    disableAccount(): Promise<'SUCCESS: account has been disabled.'> {
        return disableAccount.bind(this)();
    }
    /**
     * Returns the last verified email or reverts to it when revert is requested.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<string | UserProfile>.
     */
    @formHandler()
    lastVerifiedEmail(params?: {
        revert: boolean; // Reverts to last verified e-mail when true.
    }): Promise<string | UserProfile> {
        return lastVerifiedEmail.bind(this)(params);
    }
    /**
     * Unsubscribes the user from a newsletter group.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<string>.
     */
    @formHandler()
    unsubscribeNewsletter(
        params: { group: number | 'public' | 'authorized' | null; }
    ): Promise<string> {
        return unsubscribeNewsletter.bind(this)(params);
    }
    // /**
    //  * Sends an administrative newsletter request payload.
    //  * @param params Request parameters.
    //  */
    // @formHandler()
    // adminNewsletterRequest(params) {
    //     return adminNewsletterRequest.bind(this)(params);
    // }
    /**
     * Registers a web push subscription endpoint for notifications.
     * @param endpoint Push subscription endpoint URL.
     * @param keys Web Push key pair values.
     * @returns A promise that resolves to Promise<'SUCCESS: Subscribed to receive notifications.'>.
     */
    @formHandler()
    subscribeNotification(
        endpoint: string,
        keys: {
            p256dh: string;
            auth: string;
        }
    ): Promise<'SUCCESS: Subscribed to receive notifications.'> {
        return subscribeNotification.bind(this)({ endpoint, keys });
    }
    /**
     * Removes a registered web push subscription endpoint.
     * @param endpoint Push subscription endpoint URL.
     * @param keys Web Push key pair values.
     * @returns A promise that resolves to Promise<'SUCCESS: Unsubscribed from notifications.'>.
     */
    @formHandler()
    unsubscribeNotification(
        endpoint: string,
        keys: {
            p256dh: string;
            auth: string;
        }
    ): Promise<'SUCCESS: Unsubscribed from notifications.'> {
        return unsubscribeNotification.bind(this)({ endpoint, keys });
    }
    /**
     * Returns the VAPID public key required for browser push subscription setup.
     * @returns A promise that resolves to Promise<{ VAPIDPublicKey: string }>.
     */
    @formHandler()
    vapidPublicKey(): Promise<{ VAPIDPublicKey: string }> {
        return vapidPublicKey.bind(this)();
    }
    /**
     * Sends push notifications to one or more users.
     * @param params Payload for the request.
     * @param user_ids Parameter for this operation.
     * @returns A promise that resolves to Promise<"SUCCESS: Notification sent.">.
     */
    @formHandler()
    pushNotification(
        params: {
            title: string,
            body: string
        },
        user_ids?: string | string[]
    ): Promise<"SUCCESS: Notification sent."> {
        return pushNotification.bind(this)(params, user_ids);
    }

    /**
     * Fetches newsletter delivery records with filters and pagination.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<Newsletter>>.
     */
    @formHandler()
    getNewsletters(
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
             * Defaults to '=',
             * Condition does not work with range.
             */
            condition?: '>' | '>=' | '=' | '<' | '<=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte';
            group: 'public' | 'authorized' | number;
        },
        fetchOptions?: FetchOptions
    ): Promise<DatabaseResponse<Newsletter>> {
        return getNewsletters.bind(this)(params, fetchOptions);
    }
    /**
     * Gets newsletter subscription status for the requested groups.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<{ active: boolean; timestamp: number; group: number; subscribed_email: string; }[]>.
     */
    @formHandler()
    getNewsletterSubscription(params: { group?: number | 'public' | 'authorized'; },
        fetchOptions?: FetchOptions): Promise<{
            active: boolean;
            timestamp: number;
            group: number;
            subscribed_email: string;
        }[]> {
        return getNewsletterSubscription.bind(this)(params, fetchOptions);
    }
    /**
     * Requests a username change confirmation flow for the current user.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<'SUCCESS: confirmation e-mail has been sent.'>.
     */
    @formHandler()
    requestUsernameChange(params: {
        /** Redirect URL when user clicks on the link. */
        redirect?: string;
        /** username(e-mail) user wish to change to. */
        username: string;
    }): Promise<'SUCCESS: confirmation e-mail has been sent.'> { return requestUsernameChange.bind(this)(params); }
    /**
     * Grants users access to a private record.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<string>.
     */
    @formHandler()
    grantPrivateRecordAccess(params: {
        record_id: string;
        user_id: string | string[];
    }): Promise<string> { return grantPrivateRecordAccess.bind(this)(params); }
    /**
     * Removes previously granted private record access.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<string>.
     */
    @formHandler()
    removePrivateRecordAccess(params: {
        record_id: string;
        user_id: string | string[];
    }): Promise<string> {
        return removePrivateRecordAccess.bind(this)(params);
    }
    /**
     * Lists current private record access grants.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<DatabaseResponse<{ record_id: string; user_id: string; }>>.
     */
    @formHandler()
    listPrivateRecordAccess(params: {
        record_id?: string;
        user_id?: string | string[];
    }): Promise<DatabaseResponse<{ record_id: string; user_id: string; }>> { return listPrivateRecordAccess.bind(this)(params); }
    /**
     * Requests a temporary access key for reading a private record.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<string>.
     */
    @formHandler()
    requestPrivateRecordAccessKey(params: { record_id: string; reference_id?: string; }): Promise<string> {
        return requestPrivateRecordAccessKey.bind(this)(params);
    }
    /**
     * Deletes uploaded files by endpoint list.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<RecordData[]>.
     */
    @formHandler()
    deleteFiles(params: {
        endpoints: string | string[], // bin file endpoints
    }): Promise<RecordData[]> {
        return deleteFiles.bind(this)(params);
    }
    /**
     * Uploads files to an existing record and returns completed and failed results.
     * @param fileList Files or form event containing files.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<{ completed: File[], failed: File[], bin_endpoints: string[] }>.
     */
    @formHandler()
    uploadFiles(
        fileList: FormData | HTMLFormElement | SubmitEvent,
        params: {
            record_id: string; // Record ID of a record to upload files to.
            progress?: ProgressCallback;
        }
    ): Promise<{ completed: File[], failed: File[], bin_endpoints: string[] }> { return uploadFiles.bind(this)(fileList, params); }
    /**
     * Calls the mock endpoint for testing request and error handling flows.
     * @param data Data payload for the request.
     * @param options Optional behavior configuration.
     * @returns A promise that resolves to Promise<{ [key: string]: any }>.
     */
    @formHandler()
    mock(
        data: Form<any | { raise: 'ERR_INVALID_REQUEST' | 'ERR_INVALID_PARAMETER' | 'SOMETHING_WENT_WRONG' | 'ERR_EXISTS' | 'ERR_NOT_EXISTS'; }>,
        options?: {
            auth?: boolean;
            method?: string;
            responseType?: 'blob' | 'json' | 'text' | 'arrayBuffer' | 'formData' | 'document';
            contentType?: string;
            progress?: ProgressCallback;
        }): Promise<{ [key: string]: any }> { return mock.bind(this)(data, options); }
    /**
     * Authenticates a user with email/username and password.
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<UserProfile>.
     */
    @formHandler({ preventMultipleCalls: true })
    login(
        params: Form<{
            /** if given, username will be used instead of email. */
            username?: string;
            /** E-Mail for signin. 64 character max. */
            email: string;
            /** Password for signin. Should be at least 6 characters. */
            password: string;
        }>): Promise<UserProfile> { return login.bind(this)(params); }
    /**
     * Logs out the current user session (optionally globally).
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<'SUCCESS: The user has been logged out.'>.
     */
    @formHandler()
    logout(params?: Form<{ global: boolean; }>): Promise<'SUCCESS: The user has been logged out.'> { return logout.bind(this)(params); }

    /**
     * Creates a new user account with optional signup and login behavior settings.
     * @param params Payload for the request.
     * @param option Optional behavior configuration.
     * @returns A promise that resolves to Promise<UserProfile | "SUCCESS: The account has been created. User's signup confirmation is required." | 'SUCCESS: The account has been created.'>.
     */
    @formHandler({ preventMultipleCalls: true })
    signup(
        params: Form<{ email: String, password: String; username?: string; } & UserAttributes>,
        option?: {
            /**
             * When true, the service will send out confirmation E-Mail.
             * User will not be able to signin to their account unless they have confirm their email.
             * Parameter also accepts URL string for user to be taken to when clicked on confirmation link.
             * Default is false.
             */
            signup_confirmation?: boolean | string;
            /**
             * When true, user will be subscribed to the service newsletter (group 1) once they are signed up.
             * User's signup confirmation is required for this parameter.
             * Default is false.
             */
            email_subscription?: boolean;
            /**
             * Automatically login to account after signup. Will not work if signup confirmation is required.
             */
            login?: boolean;
        }): Promise<UserProfile | "SUCCESS: The account has been created. User's signup confirmation is required." | 'SUCCESS: The account has been created.'> {
        return signup.bind(this)(params, option);
    }

    /**
     * Resets a password using email, verification code, and new password.
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<"SUCCESS: New password has been set.">.
     */
    @formHandler({ preventMultipleCalls: true })
    resetPassword(params: Form<{
        /** Signin E-Mail */
        email: string;
        /** The verification code user has received. */
        code: string | number;
        /** New password to set. Verification code is required. */
        new_password: string;
    }>): Promise<"SUCCESS: New password has been set."> { return resetPassword.bind(this)(params); }
    /**
     * Verifies the user email address with a confirmation code.
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<string>.
     */
    @formHandler({ preventMultipleCalls: true })
    verifyEmail(params?: Form<{ code: string; }>): Promise<string> {
        // 'SUCCESS: Verification code has been sent.' | 'SUCCESS: "email" is verified.'
        return verifyEmail.bind(this)(params);
    }
    /**
     * Verifies the user phone number with a confirmation code.
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<string>.
     */
    @formHandler({ preventMultipleCalls: true })
    verifyPhoneNumber(params?: Form<{ code: string; }>): Promise<string> {
        // 'SUCCESS: Verification code has been sent.' | 'SUCCESS: "phone_number" is verified.'
        return verifyPhoneNumber.bind(this)(params);
    }
    /**
     * Sends a password reset verification code to the user email.
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<"SUCCESS: Verification code has been sent.">.
     */
    @formHandler({ preventMultipleCalls: true })
    forgotPassword(
        params: Form<{
            /** Signin E-Mail. */
            email: string;
        }>): Promise<"SUCCESS: Verification code has been sent."> {
        return forgotPassword.bind(this)(params);
    }
    /**
     * Changes password for the authenticated user.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<'SUCCESS: Password has been changed.'>.
     */
    @formHandler({ preventMultipleCalls: true })
    changePassword(params: {
        new_password: string;
        current_password: string;
    }): Promise<'SUCCESS: Password has been changed.'> { return changePassword.bind(this)(params); }
    /**
     * Updates profile attributes for the authenticated user.
     * @param params Payload for the request.
     * @returns A promise that resolves to Promise<UserProfile>.
     */
    @formHandler({ preventMultipleCalls: true })
    updateProfile(params: Form<UserAttributes>): Promise<UserProfile> { return updateProfile.bind(this)(params); }
    /**
     * Creates or updates a database record with optional file uploads.
     * @param params Payload for the request.
     * @param config Additional configuration options.
     * @param files File list to process.
     * @returns A promise that resolves to Promise<RecordData>.
     */
    @formHandler()
    postRecord(
        params: Form<Record<string, any>> | null | undefined,
        config: PostRecordConfig,
        files?: { name: string, file: File }[]
    ): Promise<RecordData> { return postRecord.bind(this)(params, config, files); }

    /**
     * Creates or updates a database record in bulk.
     * @param params Payload for the request and configuration options.
     * @returns A promise that resolves to Promise<RecordData[] | { code: string; message: string; }>.
     */
    @formHandler()
    async bulkPostRecords(
        params: Array<PostRecordConfig & { reference_private_key?: string; } & { data?: Record<string, any> }>,
    ): Promise<RecordData[] | { code: string; message: string; }> { return bulkPostRecords.bind(this)(params); }
    /**
     * Fetches subscriber/subscription relationships with filters and pagination.
     * @param params Request parameters.
     * @param fetchOptions Pagination and fetch behavior options.
     * @returns A promise that resolves to Promise<DatabaseResponse<Subscription>>.
     */
    @formHandler()
    getSubscriptions(
        params: {
            /** Subscribers user id. */
            subscriber?: string;
            /** User ID of the subscription. User id that subscriber has subscribed to. */
            subscription?: string;
            /** Fetch blocked subscription when True */
            blocked?: boolean;
        },
        fetchOptions?: FetchOptions
    ): Promise<DatabaseResponse<Subscription>> {
        return getSubscriptions.bind(this)(params, fetchOptions);
    }
    /**
     * Subscribes to another user with optional feed/notification/email preferences.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<Subscription>.
     */
    @formHandler()
    subscribe(params: { user_id: string; get_feed?: boolean; get_notified?: boolean; get_email?: boolean; }): Promise<Subscription> {
        return subscribe.bind(this)(params);
    }
    /**
     * Unsubscribes from another user.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<'SUCCESS: The user has unsubscribed.'>.
     */
    @formHandler()
    unsubscribe(params: { user_id: string; }): Promise<'SUCCESS: The user has unsubscribed.'> {
        return unsubscribe.bind(this)(params);
    }
    /**
     * Blocks a subscriber user_id.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<'SUCCESS: Blocked user ID "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".'>.
     */
    @formHandler()
    blockSubscriber(params: { user_id: string; }): Promise<'SUCCESS: Blocked user ID "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".'> {
        return blockSubscriber.bind(this)(params);
    }
    /**
     * Unblocks a previously blocked subscriber user_id.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<'SUCCESS: Unblocked user ID "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".'>.
     */
    @formHandler()
    unblockSubscriber(params: { user_id: string; }): Promise<'SUCCESS: Unblocked user ID "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".'> {
        return unblockSubscriber.bind(this)(params);
    }
    /**
     * Subscribes an email/user to a newsletter group with optional redirect flow.
     * @param params Request parameters.
     * @returns A promise that resolves to Promise<string>.
     */
    @formHandler()
    subscribeNewsletter(
        params: Form<{
            email?: string;
            group: number | 'public' | 'authorized' | 'admin';
            redirect?: string;
        }>
    ): Promise<string> {
        return subscribeNewsletter.bind(this)(params);
    }
}