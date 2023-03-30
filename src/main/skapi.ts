import {
    User,
    DatabaseResponse,
    Connection
} from '../Types';
import SkapiError from './error';
import validator from '../utils/validator';
import {
    getRecords,
    postRecord,
    deleteRecords,
    getTable,
    getIndex,
    getTag,
    uploadFiles
} from '../methods/database';
import {
    request,
    secureRequest,
    mock,
    getBlob,
    getFormResponse,
    formHandler
} from '../methods/request';
import {
    subscribe,
    unsubscribe,
    blockSubscriber,
    unblockSubscriber,
    getSubscribers,
    subscribeNewsletter,
    getNewsletters,
    unsubscribeNewsletter
} from '../methods/subscription';
import {
    checkAdmin,
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
    setUserPool,
    userPool,
    lastVerifiedEmail,
    requestUsernameChange
} from '../methods/user';

export default class Skapi {
    // privates
    private __disabledAccount: string | null = null;
    // private __serviceHash: Record<string, string> = {};
    private __cached_requests: {
        /** Cached url requests */
        [url: string]: {
            /** Array of data stored in hashed params key */
            [hashedParams: string]: DatabaseResponse;
        };
    } = {};
    private __startKey_list: {
        /** List of startkeys */
        [url: string]: {
            [hashedParams: string]: string[];
        };
    } = {};
    private __request_signup_confirmation: string | null = null;
    private service: string;
    private owner: string;

    // true when session is stored successfully to session storage
    // this property prevents duplicate stores when window closes on some device
    private __class_properties_has_been_cached = false;
    private session: Record<string, any> | null = null;

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

    __connection: Promise<Connection | null>;

    async getConnection(): Promise<Connection | null> {
        await this.__connection;
        return this.connection;
    }

    constructor(service_id: string, owner: string, options?: { autoLogin: boolean; }) {

        console.log('skapi version: 0.1.15');

        if (typeof service_id !== 'string' || typeof owner !== 'string') {
            throw new SkapiError('"service_id" and "owner" should be type <string>.', { code: 'INVALID_PARAMETER' });
        }

        if (!service_id || !owner) {
            throw new SkapiError('"service_id" and "owner" is required', { code: 'INVALID_PARAMETER' });
        }

        if (owner !== this.host) {
            validator.UserId(owner, '"owner"');
        }

        this.service = service_id;
        this.owner = owner;

        let autoLogin = options?.autoLogin || true;

        // get endpoints

        const target_cdn = 'd1h765tqb4s5ov';
        const cdn_domain = `https://${target_cdn}.cloudfront.net`; // don't change this
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
        this.__connection = (async (): Promise<Connection | null> => {
            if (!window.sessionStorage) {
                throw new Error(`This browser does not support skapi.`);
            }

            const restore = JSON.parse(window.sessionStorage.getItem(`${service_id}#${owner}`) || 'null');

            if (restore?.connection) {
                // apply all data to class properties
                for (let k in restore) {
                    this[k] = restore[k];
                }
            }

            const admin_endpoint = await this.admin_endpoint;

            setUserPool({
                UserPoolId: admin_endpoint.userpool_id,
                ClientId: admin_endpoint.userpool_client
            });

            const process: any[] = [];

            if (!restore?.connection) {
                // await for first connection
                process.push(this.updateConnection());
            }

            if (!restore?.connection && !autoLogin) {
                let currentUser = userPool.getCurrentUser();
                if (currentUser) {
                    currentUser.signOut();
                }
            }

            if (restore?.connection || autoLogin) {
                // session reload or autoLogin
                process.push(authentication.bind(this)().getSession({ refreshToken: !restore?.connection }).catch(err => {
                    this.__user = null;
                }));

                // updates connection passively
                this.updateConnection();
            }

            let awaitProcess;
            if (process.length) {
                awaitProcess = await Promise.all(process);
            }

            const storeClassProperties = () => {
                if (this.__class_properties_has_been_cached) {
                    return;
                }

                let exec = () => {
                    let data: Record<string, any> = {};

                    const to_be_cached = [
                        '__startKey_list', // startKey key : {}
                        '__cached_requests', // cached records : {}
                        '__request_signup_confirmation', // for resend signup confirmation : null
                        'connection', // service info : null
                    ];

                    if (this.connection) {
                        for (let k of to_be_cached) {
                            data[k] = this[k];
                        }

                        window.sessionStorage.setItem(`${service_id}#${owner}`, JSON.stringify(data));
                        this.__class_properties_has_been_cached = true;
                    }
                };

                return (awaitProcess instanceof Promise) ? awaitProcess.then(() => exec()) : exec();
            };

            // attach event to save session on close
            window.addEventListener('beforeunload', storeClassProperties);
            window.addEventListener("visibilitychange", storeClassProperties);

            return this.connection;

        })().catch(err => { throw err; });
    }
    async updateConnection(): Promise<Connection> {
        // async updateConnection(params?: { request_hash: string; }): Promise<Connection> {
        let request_hash = null;
        let connectedService: Record<string, any> = {};

        // if (params?.request_hash) {
        //     // hash request

        //     if (this.__serviceHash[params.request_hash]) {
        //         // has hash
        //         Object.assign(connectedService, { hash: this.__serviceHash[params.request_hash] });
        //     }

        //     else {
        //         // request signin hash
        //         request_hash = {
        //             request_hash: validator.Email(params.request_hash)
        //         };
        //     }
        // }

        if (!this.connection || this.connection.service !== this.service || request_hash) {
            // has hash request or need new connection request

            if (request_hash === null) {
                request_hash = {};
            }

            // assign service id and owner to request
            Object.assign(request_hash, {
                service: this.service,
                owner: this.owner
            });
        }

        // post request if needed
        Object.assign(connectedService, (request_hash ? await request.bind(this)('service', request_hash, { bypassAwaitConnection: true, method: 'get' }) : this.connection));

        // if (params?.request_hash) {
        //     // cache hash if needed
        //     this.__serviceHash[params.request_hash] = connectedService.hash;
        // }

        // deep copy, save connection service info without hash
        let connection = JSON.parse(JSON.stringify(connectedService));
        delete connection.hash;
        this.connection = connection;

        return connectedService as Connection;
    }

    getProfile = getProfile.bind(this);
    checkAdmin = checkAdmin.bind(this);
    getBlob = getBlob.bind(this);
    request = request.bind(this);
    secureRequest = secureRequest.bind(this);
    getFormResponse = getFormResponse.bind(this);
    @formHandler()
    postRecord(...args) { return postRecord.bind(this)(...args); };
    @formHandler()
    mock(...args) { return mock.bind(this)(...args); };
    getRecords = getRecords.bind(this);
    getTable = getTable.bind(this);
    getIndex = getIndex.bind(this);
    getTag = getTag.bind(this);
    deleteRecords = deleteRecords.bind(this);
    logout = logout.bind(this);
    resendSignupConfirmation = resendSignupConfirmation.bind(this);
    recoverAccount = recoverAccount.bind(this);
    getUsers = getUsers.bind(this);
    @formHandler()
    login(...args) { return login.bind(this)(...args); }
    @formHandler()
    signup(...args) { return signup.bind(this)(...args); }
    @formHandler()
    resetPassword(...args) { return resetPassword.bind(this)(...args); }
    disableAccount = disableAccount.bind(this);
    @formHandler()
    verifyEmail(...args) {
        return verifyEmail.bind(this)(...args);
    }
    @formHandler()
    verifyPhoneNumber(...args) {
        return verifyPhoneNumber.bind(this)(...args);
    }
    lastVerifiedEmail(...args) {
        return lastVerifiedEmail.bind(this)(...args);
    }
    @formHandler()
    forgotPassword(...args) { return forgotPassword.bind(this)(...args); }
    @formHandler()
    changePassword(...args) { return changePassword.bind(this)(...args); }
    @formHandler()
    updateProfile(...args) { return updateProfile.bind(this)(...args); }
    @formHandler()
    subscribe(...args) { return subscribe.bind(this)(...args); }
    @formHandler()
    unsubscribe(...args) { return unsubscribe.bind(this)(...args); }
    @formHandler()
    blockSubscriber(...args) { return blockSubscriber.bind(this)(...args); }
    @formHandler()
    unblockSubscriber(...args) { return unblockSubscriber.bind(this)(...args); }
    getSubscriptions = getSubscribers.bind(this);
    getSubscribers = getSubscribers.bind(this);
    @formHandler()
    subscribeNewsletter(...args) { return subscribeNewsletter.bind(this)(...args); }
    unsubscribeNewsletter(...args) { return unsubscribeNewsletter.bind(this)(...args); }
    getNewsletters = getNewsletters.bind(this);
    requestUsernameChange(...args) { return requestUsernameChange.bind(this)(...args); }
    uploadFiles(...args) { return uploadFiles.bind(this)(...args); }
}