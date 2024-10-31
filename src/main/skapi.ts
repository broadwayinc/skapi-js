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
    Newsletters,
    Form,
    PostRecordConfig,
    PublicUser,
    UserProfilePublicSettings
} from '../Types';
import {
    CognitoUserPool
} from 'amazon-cognito-identity-js';
import SkapiError from './error';
import validator from '../utils/validator';
import {
    getRecords,
    postRecord,
    deleteRecords,
    getTables,
    getIndexes,
    getTags,
    getFile,
    grantPrivateRecordAccess,
    removePrivateRecordAccess,
    listPrivateRecordAccess,
    requestPrivateRecordAccessKey,
    deleteFiles
} from '../methods/database';
import {
    connectRealtime,
    joinRealtime,
    postRealtime,
    closeRealtime,
    getRealtimeUsers,
    getRealtimeGroups
} from '../methods/realtime';
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
    uploadFiles
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
    getNewsletterSubscription
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
    jwtLogin,
} from '../methods/user';
import {
    extractFormData,
    fromBase62,
    generateRandom,
    toBase62,
    MD5
} from '../utils/utils';
import {
    blockAccount,
    unblockAccount,
    deleteAccount,
    inviteUser,
    createAccount,
    grantAccess
} from '../methods/admin';
export default class Skapi {
    // current version
    private __version = '1.0.157';
    service: string;
    owner: string;
    session: Record<string, any> | null = null;
    connection: Connection | null = null;
    userPool: CognitoUserPool | null = null;

    private host = 'skapi';

    private hostDomain = 'skapi.com';
    private target_cdn = 'd3e9syvbtso631';

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

    loginHandle: Function = (user: UserProfile): void => { };

    admin_endpoint: Promise<Record<string, any>>;
    record_endpoint: Promise<Record<string, any>>;

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
        }
    };

    util = {
        MD5,
        generateRandom,
        toBase62,
        fromBase62,
        extractFormData,
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
    private __socket: WebSocket;
    private __socket_room: string;
    private __network_logs = false;

    constructor(service: string, owner: string, options?: { autoLogin: boolean; }, __etc?: any) {
        if (typeof service !== 'string' || typeof owner !== 'string') {
            throw new SkapiError('"service" and "owner" should be type <string>.', { code: 'INVALID_PARAMETER' });
        }

        if (!service || !owner) {
            throw new SkapiError('"service" and "owner" is required', { code: 'INVALID_PARAMETER' });
        }

        if (owner !== this.host) {
            validator.UserId(owner, '"owner"');
        }

        this.service = service;
        this.owner = owner;

        let autoLogin = true;

        if (options) {
            if (typeof options.autoLogin === 'boolean') {
                autoLogin = options.autoLogin;
            }
        }

        // get endpoints

        this.target_cdn = __etc?.target_cdn || this.target_cdn;
        this.hostDomain = __etc?.hostDomain || this.hostDomain;
        this.__network_logs = !!__etc?.network_logs;

        const cdn_domain = `https://${this.target_cdn}.cloudfront.net`; // don't change this
        let sreg = service.substring(0, 4);

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

        if (!window.sessionStorage) {
            throw new Error(`This browser does not support skapi.`);
        }

        const restore = JSON.parse(window.sessionStorage.getItem(`${service}#${owner}`) || 'null');

        this.log('constructor:restore', restore);

        if (restore?.connection) {
            // apply all data to class properties
            for (let k in restore) {
                this[k] = restore[k];
            }
        }

        this.__authConnection = (async () => {
            const admin_endpoint = await this.admin_endpoint;
            this.userPool = new CognitoUserPool({
                UserPoolId: admin_endpoint.userpool_id,
                ClientId: admin_endpoint.userpool_client
            });

            if (restore?.connection || autoLogin) {
                try {
                    await authentication.bind(this)().getSession({ refreshToken: !restore?.connection });
                }
                catch (err) {
                    await logout.bind(this)();
                }
            }
        })()

        // connects to server
        this.__connection = (async (): Promise<Connection> => {
            let connection: Promise<Connection> = null;

            if (!restore?.connection) {
                // await for first connection
                connection = this.updateConnection();
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
                        'connection', // service info : null
                    ];

                    if (this.connection) {
                        for (let k of to_be_cached) {
                            data[k] = this[k];
                        }

                        window.sessionStorage.setItem(`${service}#${owner}`, JSON.stringify(data));
                        this.__class_properties_has_been_cached = true;
                    }
                };

                return (connection instanceof Promise) ? connection.then(() => exec()) : exec();
            };

            // attach event to save session on close
            window.addEventListener('beforeunload', () => {
                this.closeRealtime();
                storeClassProperties();
            });
            // for mobile
            window.addEventListener("visibilitychange", () => {
                storeClassProperties();
            });

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

    async updateConnection(): Promise<Connection> {
        try {
            this.connection = await request.bind(this)('service', {
                service: this.service,
                owner: this.owner
            }, { bypassAwaitConnection: true, method: 'get' });
        }
        catch (err: any) {
            if (window) {
                window.alert('Service is not available: ' + (err.message || err.toString()));
            }

            this.connection = null;
            throw err;
        }
        return this.connection;
    }

    private registerTicket = registerTicket.bind(this);
    private unregisterTicket = unregisterTicket.bind(this);

    async version(): Promise<string> {
        await this.__connection;

        let skapi = `%c\r\n          $$\\                          $$\\ \r\n          $$ |                         \\__|\r\n $$$$$$$\\ $$ |  $$\\ $$$$$$\\   $$$$$$\\  $$\\ \r\n$$  _____|$$ | $$  |\\____$$\\ $$  __$$\\ $$ |\r\n\\$$$$$$\\  $$$$$$  \/ $$$$$$$ |$$ \/  $$ |$$ |\r\n \\____$$\\ $$  _$$< $$  __$$ |$$ |  $$ |$$ |\r\n$$$$$$$  |$$ | \\$$\\\\$$$$$$$ |$$$$$$$  |$$ |\r\n\\_______\/ \\__|  \\__|\\_______|$$  ____\/ \\__|\r\n                             $$ |          \r\n                             $$ |          \r\n                             \\__|          \r\n`;
        console.log(`Built with:\n${skapi}Version: ${this.__version}\n\nDocumentation: https://docs.skapi.com`, `font-family: monospace; color:blue;`);
        if (this.connection.group === 1) {
            console.log(`%cSKAPI: THE SERVICE IS IN TRIAL MODE. ALL THE USERS AND DATA WILL BE INITIALIZED EVERY 30 DAYS.`, `font-family: monospace; color:red;`);
        }
        return this.__version;
    }

    log(n: string, v: any) {
        if (this.__network_logs) {
            try {
                console.log(n, JSON.parse(JSON.stringify(v)));
            } catch (err) {
                console.log(n, v);
            }
        }
    }

    connectRealtime(cb: (rt: {
        type: 'message' | 'error' | 'success' | 'close' | 'notice' | 'private';
        message: any;
        sender?: string; // user_id of the sender
        sender_cid?: string; // connection id of the sender
    }) => Promise<WebSocket>) {
        return connectRealtime.bind(this)(cb);
    }

    jwtLogin(params: {
        idToken: string;
        keyUrl: string;
        clientId: string;
        provider: string;
        nonce?: string;
    }): Promise<UserProfile> {
        return jwtLogin.bind(this)(params);
    }

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

    @formHandler()
    consumeTicket(params: { ticket_id: string; } & { [key: string]: any }): Promise<any> {
        return consumeTicket.bind(this)(params);
    }

    @formHandler()
    getConsumedTickets(params: { ticket_id?: string; }, fetchOptions: FetchOptions): Promise<DatabaseResponse<any[]>> {
        return getConsumedTickets.bind(this)(params, fetchOptions);
    }

    @formHandler()
    getTickets(params: { ticket_id?: string; }, fetchOptions: FetchOptions): Promise<DatabaseResponse<any[]>> {
        return getTickets.bind(this)(params, fetchOptions);
    }

    closeRealtime(): Promise<void> {
        return closeRealtime.bind(this)();
    }

    @formHandler()
    getRealtimeUsers(params: { group: string, user_id?: string }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<{ user_id: string; connection_id: string }[]>> {
        return getRealtimeUsers.bind(this)(params, fetchOptions);
    }

    @formHandler()
    sendInquiry(data: Form<{
        name: string;
        email: string;
        subject: string;
        message: string;
    }>): Promise<"SUCCESS: Inquiry has been sent."> {
        return sendInquiry.bind(this)(data);
    }

    @formHandler()
    blockAccount(form: { user_id: string }): Promise<"SUCCESS: The user has been blocked."> {
        return blockAccount.bind(this)(form);
    }

    @formHandler()
    unblockAccount(form: { user_id: string }): Promise<"SUCCESS: The user has been unblocked."> {
        return unblockAccount.bind(this)(form);
    }

    @formHandler()
    deleteAccount(form: { user_id: string }): Promise<"SUCCESS: Account has been deleted."> {
        return deleteAccount.bind(this)(form);
    }

    @formHandler()
    inviteUser(
        form: UserAttributes & UserProfilePublicSettings & { email: string; },
        options?: {
            confirmation_url?: string;
            email_subscription?: boolean;
        }
    ): Promise<'SUCCESS: Invitation has been sent.'> {
        return inviteUser.bind(this)(form, options);
    }

    @formHandler()
    createAccount(
        form: UserAttributes & UserProfilePublicSettings & { email: string; password: string; },
        options: {
            email_subscription?: boolean;
        }
    ): Promise<UserProfile & PublicUser & { email_admin: string; approved: string; log: number; username: string; }> {
        return createAccount.bind(this)(form, options);
    }

    @formHandler()
    grantAccess(params: {
        user_id: string;
        access_group: number;
    }): Promise<'SUCCESS: Access has been granted to the user.'> {
        return grantAccess.bind(this)(params);
    }

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

    @formHandler()
    postRealtime(message: any, recipient: string): Promise<{ type: 'success', message: 'Message sent.' }> {
        return postRealtime.bind(this)(message, recipient);
    }

    @formHandler()
    joinRealtime(params: { group: string | null }): Promise<{ type: 'success', message: string }> {
        return joinRealtime.bind(this)(params);
    }

    getConnection(): Promise<Connection> {
        return this.__connection;
    }

    @formHandler()
    getProfile(options?: { refreshToken: boolean; }): Promise<UserProfile | null> {
        return getProfile.bind(this)(options);
    }
    @formHandler()
    getFile(
        url: string, // cdn endpoint url https://xxxx.cloudfront.net/path/file
        config?: {
            dataType?: 'base64' | 'download' | 'endpoint' | 'blob' | 'text'; // default 'download'
            expires?: number; // uses url that expires. this option does not use the cdn (slow). can be used for private files. (does not work on public files).
            progress?: ProgressCallback;
        }
    ): Promise<Blob | string | void> {
        return getFile.bind(this)(url, config);
    }
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
    @formHandler()
    getFormResponse(): Promise<any> {
        return getFormResponse.bind(this)();
    }
    @formHandler()
    getRecords(query: GetRecordQuery, fetchOptions?: FetchOptions): Promise<DatabaseResponse<RecordData>> {
        return getRecords.bind(this)(query, fetchOptions);
    }
    @formHandler()
    getTables(
        /** If null fetch all list of tables. */
        query: {
            table: string;
            /** Condition operator of table name. */
            condition?: Condition;
        },
        fetchOptions?: FetchOptions
    ): Promise<DatabaseResponse<{
        number_of_records: number; // Number of records in the table
        table: string; // Table name
        size: number; // Table size
    }>> {
        return getTables.bind(this)(query, fetchOptions);
    }
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
    ): Promise<DatabaseResponse<{
        table: string; // Table name
        index: string; // Index name
        number_of_records: number; // Number of records in the index
        string_count?: number; // Number of string type value
        number_count?: number; // Number of number type value
        boolean_count?: number; // Number of boolean type value
        total_number?: number; // Sum of all numbers
        total_bool?: number; // Number of true(boolean) values
        average_number?: number; // Average of all numbers
        average_bool?: number; // Percentage of true(boolean) values
    }>> { return getIndexes.bind(this)(query, fetchOptions); }
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
    ): Promise<DatabaseResponse<{
        table: string; // Table name
        tag: string; // Tag
        number_of_records: string; // Number records tagged
    }>> { return getTags.bind(this)(query, fetchOptions); }
    @formHandler()
    deleteRecords(params: {
        /** Record ID(s) to delete. Table parameter is not needed when record_id is given. */
        record_id?: string | string[];
        table?: {/**
            /** Table name. */
            name: string;
            /** Access group number. */
            access_group?: number | 'private' | 'public' | 'authorized';
            // subscription_group?: number;
            subscription: boolean;
        };
    }): Promise<string> { return deleteRecords.bind(this)(params); }
    @formHandler()
    resendSignupConfirmation(
        /** Redirect url on confirmation success. */
        redirect: string
    ): Promise<'SUCCESS: Signup confirmation E-Mail has been sent.'> {
        return resendSignupConfirmation.bind(this)(redirect);
    }
    @formHandler()
    recoverAccount(
        /** Redirect url on confirmation success. */
        redirect: boolean | string = false
    ): Promise<"SUCCESS: Recovery e-mail has been sent."> {
        return recoverAccount.bind(this)(redirect);
    }
    @formHandler()
    getUsers(
        params?: {
            /** Index name to search. */
            searchFor: 'user_id' | 'email' | 'phone_number' | 'locale' | 'name' | 'address' | 'gender' | 'birthdate' | 'subscribers' | 'timestamp';
            /** Index value to search. */
            value: string | number | boolean;
            /** Search condition. */
            condition?: '>' | '>=' | '=' | '<' | '<=' | '!=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte' | 'ne';
            /** Range of search. */
            range?: string | number | boolean;
        },
        fetchOptions?: FetchOptions): Promise<DatabaseResponse<PublicUser>> {
        return getUsers.bind(this)(params, fetchOptions);
    }
    @formHandler()
    disableAccount(): Promise<'SUCCESS: account has been disabled.'> {
        return disableAccount.bind(this)();
    }
    @formHandler()
    lastVerifiedEmail(params?: {
        revert: boolean; // Reverts to last verified e-mail when true.
    }): Promise<string | UserProfile> {
        return lastVerifiedEmail.bind(this)(params);
    }
    @formHandler()
    unsubscribeNewsletter(
        params: { group: number | 'public' | 'authorized' | null; }
    ): Promise<string> {
        return unsubscribeNewsletter.bind(this)(params);
    }
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
    ): Promise<DatabaseResponse<Newsletters>> {
        return getNewsletters.bind(this)(params, fetchOptions);
    }
    @formHandler()
    getNewsletterSubscription(params: {
        group?: number | 'public' | 'authorized';
    }): Promise<{
        active: boolean;
        timestamp: number;
        group: number;
        subscribed_email: string;
    }[]> {
        return getNewsletterSubscription.bind(this)(params);
    }
    @formHandler()
    requestUsernameChange(params: {
        /** Redirect URL when user clicks on the link. */
        redirect?: string;
        /** username(e-mail) user wish to change to. */
        username: string;
    }): Promise<'SUCCESS: confirmation e-mail has been sent.'> { return requestUsernameChange.bind(this)(params); }
    @formHandler()
    grantPrivateRecordAccess(params: {
        record_id: string;
        user_id: string | string[];
    }): Promise<string> { return grantPrivateRecordAccess.bind(this)(params); }
    @formHandler()
    removePrivateRecordAccess(params: {
        record_id: string;
        user_id: string | string[];
    }): Promise<string> {
        return removePrivateRecordAccess.bind(this)(params);
    }
    @formHandler()
    listPrivateRecordAccess(params: {
        record_id: string;
        user_id: string | string[];
    }): Promise<DatabaseResponse<{ record_id: string; user_id: string; }>> { return listPrivateRecordAccess.bind(this)(params); }
    @formHandler()
    requestPrivateRecordAccessKey(record_id: string): Promise<string> {
        return requestPrivateRecordAccessKey.bind(this)(record_id);
    }
    @formHandler()
    deleteFiles(params: {
        endpoints: string | string[], // bin file endpoints
    }): Promise<RecordData[]> {
        return deleteFiles.bind(this)(params);
    }
    @formHandler()
    uploadFiles(
        fileList: FormData | HTMLFormElement | SubmitEvent,
        params: {
            record_id: string; // Record ID of a record to upload files to.
            progress?: ProgressCallback;
        }
    ): Promise<{ completed: File[], failed: File[], bin_endpoints: string[] }> { return uploadFiles.bind(this)(fileList, params); }
    @formHandler()
    mock(
        data: Form<any | { raise: 'ERR_INVALID_REQUEST' | 'ERR_INVALID_PARAMETER' | 'SOMETHING_WENT_WRONG' | 'ERR_EXISTS' | 'ERR_NOT_EXISTS'; }>,
        options?: {
            auth?: boolean;
            method?: string;
            bypassAwaitConnection?: boolean;
            responseType?: 'blob' | 'json' | 'text' | 'arrayBuffer' | 'formData' | 'document';
            contentType?: string;
            progress?: ProgressCallback;
        }): Promise<{ mockResponse: Record<string, any>; }> { return mock.bind(this)(data, options); }
    @formHandler({ preventMultipleCalls: true })
    login(
        form: Form<{
            /** if given, username will be used instead of email. */
            username?: string;
            /** E-Mail for signin. 64 character max. */
            email: string;
            /** Password for signin. Should be at least 6 characters. */
            password: string;
        }>): Promise<UserProfile> { return login.bind(this)(form); }
    @formHandler()
    logout(): Promise<'SUCCESS: The user has been logged out.'> { return logout.bind(this)(); }

    @formHandler({ preventMultipleCalls: true })
    signup(
        form: Form<UserAttributes & { email: String, password: String; username?: string; }>,
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
        } & { progress?: ProgressCallback }): Promise<UserProfile | "SUCCESS: The account has been created. User's signup confirmation is required." | 'SUCCESS: The account has been created.'> {
        return signup.bind(this)(form, option);
    }

    @formHandler({ preventMultipleCalls: true })
    resetPassword(form: Form<{
        /** Signin E-Mail */
        email: string;
        /** The verification code user has received. */
        code: string | number;
        /** New password to set. Verification code is required. */
        new_password: string;
    }>): Promise<"SUCCESS: New password has been set."> { return resetPassword.bind(this)(form); }
    @formHandler({ preventMultipleCalls: true })
    verifyEmail(form?: Form<{ code: string; }>): Promise<string> {
        // 'SUCCESS: Verification code has been sent.' | 'SUCCESS: "email" is verified.'
        return verifyEmail.bind(this)(form);
    }
    @formHandler({ preventMultipleCalls: true })
    verifyPhoneNumber(form?: Form<{ code: string; }>): Promise<string> {
        // 'SUCCESS: Verification code has been sent.' | 'SUCCESS: "phone_number" is verified.'
        return verifyPhoneNumber.bind(this)(form);
    }
    @formHandler({ preventMultipleCalls: true })
    forgotPassword(
        form: Form<{
            /** Signin E-Mail. */
            email: string;
        }>): Promise<"SUCCESS: Verification code has been sent."> {
        return forgotPassword.bind(this)(form);
    }
    @formHandler({ preventMultipleCalls: true })
    changePassword(params: {
        new_password: string;
        current_password: string;
    }): Promise<'SUCCESS: Password has been changed.'> { return changePassword.bind(this)(params); }
    @formHandler({ preventMultipleCalls: true })
    updateProfile(form: Form<UserAttributes>): Promise<UserProfile> { return updateProfile.bind(this)(form); }
    @formHandler()
    postRecord(
        form: Form<Record<string, any>> | null | undefined,
        config: PostRecordConfig & { progress?: ProgressCallback }
    ): Promise<RecordData> { return postRecord.bind(this)(form, config); }
    @formHandler()
    getSubscriptions(
        params: {
            /** Subscribers user id. */
            subscriber?: string;
            /** User ID of the subscription. User id that subscriber has subscribed to. */
            subscription?: string;
            // /** subscription group. if omitted, will fetch all groups. */
            // group?: number;
            /** Fetch blocked subscription when True */
            blocked?: boolean;
        },
        fetchOptions?: FetchOptions
    ): Promise<DatabaseResponse<{
        subscriber: string; // Subscriber ID
        subscription: string; // Subscription ID
        group: number; // Subscription group number
        timestamp: number; // Subscribed UNIX timestamp
        blocked: boolean; // True when subscriber is blocked by subscription
    }>> {
        return getSubscriptions.bind(this)(params, fetchOptions);
    }
    @formHandler()
    subscribe(params: { user_id: string }): Promise<'SUCCESS: the user has subscribed.'> {
        return subscribe.bind(this)(params);
    }
    @formHandler()
    unsubscribe(params: { user_id: string }): Promise<'SUCCESS: the user has unsubscribed.'> {
        return unsubscribe.bind(this)(params);
    }
    @formHandler()
    blockSubscriber(params: { user_id: string }): Promise<'SUCCESS: blocked user id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".'> {
        return blockSubscriber.bind(this)(params);
    }
    @formHandler()
    unblockSubscriber(params: { user_id: string }): Promise<'SUCCESS: unblocked user id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".'> {
        return unblockSubscriber.bind(this)(params);
    }
    @formHandler()
    subscribeNewsletter(
        params: Form<{
            email?: string;
            group: number | 'public' | 'authorized';
            redirect?: string;
        }>
    ): Promise<string> {
        return subscribeNewsletter.bind(this)(params);
    }
}