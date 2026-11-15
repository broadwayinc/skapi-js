/**
 * The part of amazon-cognito-identity-js that skapi-js uses, rewritten without dependencies.
 *
 * Same class names, method names, callback shapes, error codes and messages, and the same
 * storage keys (CognitoIdentityServiceProvider.<clientId>.LastAuthUser and
 * .<username>.idToken / accessToken / refreshToken / clockDrift / userData), so a session saved by
 * an older skapi-js build keeps working after an upgrade, and code that reads those keys (the MCP
 * server's scoped storage) is unaffected. Requests go straight to the Cognito user pool JSON API.
 *
 * Left out because Skapi does not use them: device tracking (off on every Skapi user pool),
 * USER_PASSWORD_AUTH and CUSTOM_AUTH (sign-in is SRP only), cookie storage, and advanced security
 * context data (not used; the AWS data collection script is not loaded).
 */

import { SrpHelper, hexToBigInt, cognitoTimestamp } from './srp';
import { hmacSha256, utf8, concatBytes, bytesToBase64, base64ToBytes, bytesToUtf8 } from './crypto';

type Callback<T = any> = (err: any, result?: T, extra?: any) => void;

// ---- HTTP client ---------------------------------------------------------------------------------

export class Client {
    endpoint: string;

    constructor(region: string, endpoint?: string) {
        this.endpoint = endpoint || `https://cognito-idp.${region}.amazonaws.com/`;
    }

    /** One call to the user pool API. Errors carry `code` and `name` (the Cognito error type). */
    request(operation: string, params: any, callback: Callback): void {
        const options: RequestInit = {
            headers: {
                'Content-Type': 'application/x-amz-json-1.1',
                'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
                'Cache-Control': 'no-store'
            },
            method: 'POST',
            mode: 'cors',
            body: JSON.stringify(params)
        };

        let response: Response;
        fetch(this.endpoint, options)
            .then(resp => {
                response = resp;
                return resp;
            }, err => {
                // fetch rejects with a TypeError when no answer came back at all.
                if (err instanceof TypeError) {
                    throw new Error('Network error');
                }
                throw err;
            })
            .then(resp => resp.json().catch(() => ({})))
            .then((data: any) => {
                if (response.ok) {
                    return callback(null, data);
                }
                // Same reading as aws-sdk-js lib/protocol/json.js: "<namespace>#<ErrorType>".
                const code = (data.__type || data.code).split('#').pop();
                const error: any = new Error(data.message || data.Message || null);
                error.name = code;
                error.code = code;
                return callback(error);
            })
            .catch(err => {
                // A body that is not JSON: the error type is still in the response header.
                if (response && response.headers && response.headers.get('x-amzn-errortype')) {
                    try {
                        const code = response.headers.get('x-amzn-errortype').split(':')[0];
                        const error: any = new Error(response.status ? response.status.toString() : null);
                        error.code = code;
                        error.name = code;
                        error.statusCode = response.status;
                        return callback(error);
                    }
                    catch (ex) {
                        return callback(err);
                    }
                }
                else if (err instanceof Error && err.message === 'Network error') {
                    (err as any).code = 'NetworkError';
                }
                return callback(err);
            });
    }

    /**
     * request() with jittered exponential retries on ANY error, as the library did for token
     * refresh: waits of about 0.2, 0.4, 0.8, 1.6 and 3.2 seconds (plus up to 0.1 s), then gives up
     * when the next wait would pass 5 seconds.
     */
    requestWithRetry(operation: string, params: any, callback: Callback): void {
        const MAX_DELAY_MS = 5 * 1000;
        const attemptOnce = (attempt: number) => {
            this.request(operation, params, (err, result) => {
                if (!err) {
                    return callback(null, result);
                }
                const delay = Math.pow(2, attempt) * 100 + 100 * Math.random();
                if (delay > MAX_DELAY_MS) {
                    return callback(err);
                }
                setTimeout(() => attemptOnce(attempt + 1), delay);
            });
        };
        attemptOnce(1);
    }

    promisifyRequest(operation: string, params: any): Promise<any> {
        return new Promise((resolve, reject) => {
            this.request(operation, params, (err, data) => {
                if (err) {
                    const error: any = new Error(err.message);
                    error.code = err.code;
                    error.name = err.name;
                    error.statusCode = err.statusCode;
                    reject(error);
                }
                else {
                    resolve(data);
                }
            });
        });
    }
}

// ---- Tokens and session --------------------------------------------------------------------------

export class CognitoJwtToken {
    jwtToken: string;
    payload: any;

    constructor(token?: string) {
        this.jwtToken = token || '';
        this.payload = this.decodePayload();
    }

    getJwtToken(): string {
        return this.jwtToken;
    }

    getExpiration(): number {
        return this.payload.exp;
    }

    getIssuedAt(): number {
        return this.payload.iat;
    }

    decodePayload(): any {
        const payload = this.jwtToken.split('.')[1];
        try {
            return JSON.parse(bytesToUtf8(base64ToBytes(payload)));
        }
        catch (err) {
            return {};
        }
    }
}

export class CognitoIdToken extends CognitoJwtToken {
    constructor({ IdToken }: { IdToken?: string; } = {}) {
        super(IdToken || '');
    }
}

export class CognitoAccessToken extends CognitoJwtToken {
    constructor({ AccessToken }: { AccessToken?: string; } = {}) {
        super(AccessToken || '');
    }
}

export class CognitoRefreshToken {
    token: string;

    constructor({ RefreshToken }: { RefreshToken?: string; } = {}) {
        this.token = RefreshToken || '';
    }

    getToken(): string {
        return this.token;
    }
}

export class CognitoUserSession {
    idToken: CognitoIdToken;
    refreshToken: CognitoRefreshToken;
    accessToken: CognitoAccessToken;
    clockDrift: number;

    constructor({ IdToken, RefreshToken, AccessToken, ClockDrift }: {
        IdToken?: CognitoIdToken;
        RefreshToken?: CognitoRefreshToken;
        AccessToken?: CognitoAccessToken;
        ClockDrift?: number;
    } = {}) {
        if (AccessToken == null || IdToken == null) {
            throw new Error('Id token and Access Token must be present.');
        }
        this.idToken = IdToken;
        this.refreshToken = RefreshToken;
        this.accessToken = AccessToken;
        this.clockDrift = ClockDrift === undefined ? this.calculateClockDrift() : ClockDrift;
    }

    getIdToken(): CognitoIdToken {
        return this.idToken;
    }

    getRefreshToken(): CognitoRefreshToken {
        return this.refreshToken;
    }

    getAccessToken(): CognitoAccessToken {
        return this.accessToken;
    }

    getClockDrift(): number {
        return this.clockDrift;
    }

    /** Seconds this device's clock is ahead of the token issuer's, measured when the tokens arrive. */
    calculateClockDrift(): number {
        const now = Math.floor(Date.now() / 1000);
        const iat = Math.min(this.accessToken.getIssuedAt(), this.idToken.getIssuedAt());
        return now - iat;
    }

    isValid(): boolean {
        const now = Math.floor(Date.now() / 1000);
        const adjusted = now - this.clockDrift;
        return adjusted < this.accessToken.getExpiration() && adjusted < this.idToken.getExpiration();
    }
}

export class CognitoUserAttribute {
    Name: string;
    Value: string;

    constructor({ Name, Value }: { Name?: string; Value?: string; } = {}) {
        this.Name = Name || '';
        this.Value = Value || '';
    }

    getValue(): string {
        return this.Value;
    }

    setValue(value: string): this {
        this.Value = value;
        return this;
    }

    getName(): string {
        return this.Name;
    }

    setName(name: string): this {
        this.Name = name;
        return this;
    }

    toString(): string {
        return JSON.stringify(this);
    }

    toJSON(): { Name: string; Value: string; } {
        return { Name: this.Name, Value: this.Value };
    }
}

export class AuthenticationDetails {
    validationData: Record<string, string>;
    authParameters: Record<string, string>;
    clientMetadata: Record<string, string>;
    username: string;
    password: string;

    constructor(data: {
        Username: string;
        Password?: string;
        ValidationData?: Record<string, string>;
        AuthParameters?: Record<string, string>;
        ClientMetadata?: Record<string, string>;
    }) {
        const { ValidationData, Username, Password, AuthParameters, ClientMetadata } = data || ({} as any);
        this.validationData = ValidationData || {};
        this.authParameters = AuthParameters || {};
        this.clientMetadata = ClientMetadata || {};
        this.username = Username;
        this.password = Password;
    }

    getUsername(): string {
        return this.username;
    }

    getPassword(): string {
        return this.password;
    }

    getValidationData(): Record<string, string> {
        return this.validationData;
    }

    getAuthParameters(): Record<string, string> {
        return this.authParameters;
    }

    getClientMetadata(): Record<string, string> {
        return this.clientMetadata;
    }
}

// ---- Storage -------------------------------------------------------------------------------------

type StorageLike = {
    getItem(key: string): any;
    setItem(key: string, value: any): any;
    removeItem(key: string): any;
    clear?(): any;
};

let dataMemory: Record<string, any> = {};

/** Used when localStorage is not available: kept for the life of the page or process only. */
export const MemoryStorage: StorageLike = {
    setItem(key: string, value: any) {
        dataMemory[key] = value;
        return dataMemory[key];
    },
    getItem(key: string) {
        return Object.prototype.hasOwnProperty.call(dataMemory, key) ? dataMemory[key] : undefined;
    },
    removeItem(key: string) {
        return delete dataMemory[key];
    },
    clear() {
        dataMemory = {};
        return dataMemory;
    }
};

function defaultStorage(): StorageLike {
    try {
        const storage = window.localStorage;
        storage.setItem('aws.cognito.test-ls', 1 as any);
        storage.removeItem('aws.cognito.test-ls');
        return storage;
    }
    catch (exception) {
        return MemoryStorage;
    }
}

// ---- User pool -----------------------------------------------------------------------------------

const USER_POOL_ID_MAX_LENGTH = 55;

export class CognitoUserPool {
    userPoolId: string;
    clientId: string;
    client: Client;
    storage: StorageLike;

    constructor(data: { UserPoolId: string; ClientId: string; endpoint?: string; Storage?: StorageLike; }) {
        const { UserPoolId, ClientId, endpoint } = data || ({} as any);
        if (!UserPoolId || !ClientId) {
            throw new Error('Both UserPoolId and ClientId are required.');
        }
        if (UserPoolId.length > USER_POOL_ID_MAX_LENGTH || !/^[\w-]+_[0-9a-zA-Z]+$/.test(UserPoolId)) {
            throw new Error('Invalid UserPoolId format.');
        }
        const region = UserPoolId.split('_')[0];
        this.userPoolId = UserPoolId;
        this.clientId = ClientId;
        this.client = new Client(region, endpoint);
        this.storage = data.Storage || defaultStorage();
    }

    getUserPoolId(): string {
        return this.userPoolId;
    }

    getUserPoolName(): string {
        return this.getUserPoolId().split('_')[1];
    }

    getClientId(): string {
        return this.clientId;
    }

    signUp(
        username: string,
        password: string,
        userAttributes: CognitoUserAttribute[],
        validationData: CognitoUserAttribute[] | null,
        callback: Callback,
        clientMetadata?: Record<string, string>
    ): void {
        const jsonReq = {
            ClientId: this.clientId,
            Username: username,
            Password: password,
            UserAttributes: userAttributes,
            ValidationData: validationData,
            ClientMetadata: clientMetadata
        };
        this.client.request('SignUp', jsonReq, (err, data) => {
            if (err) {
                return callback(err, null);
            }
            return callback(null, {
                user: new CognitoUser({ Username: username, Pool: this, Storage: this.storage }),
                userConfirmed: data.UserConfirmed,
                userSub: data.UserSub,
                codeDeliveryDetails: data.CodeDeliveryDetails
            });
        });
    }

    /** The user whose tokens are stored (LastAuthUser), or null. */
    getCurrentUser(): CognitoUser | null {
        const lastAuthUser = this.storage.getItem(`CognitoIdentityServiceProvider.${this.clientId}.LastAuthUser`);
        if (lastAuthUser) {
            return new CognitoUser({ Username: lastAuthUser, Pool: this, Storage: this.storage });
        }
        return null;
    }
}

// ---- User ----------------------------------------------------------------------------------------

type AuthCallbacks = {
    onSuccess: (session: CognitoUserSession, userConfirmationNecessary?: boolean) => void;
    onFailure: (err: any) => void;
    newPasswordRequired?: (userAttributes: any, requiredAttributes: any) => void;
    mfaRequired?: (challengeName: any, challengeParameters: any) => void;
    totpRequired?: (challengeName: any, challengeParameters: any) => void;
    customChallenge?: (challengeParameters: any) => void;
    mfaSetup?: (challengeName: any, challengeParameters: any) => void;
    selectMFAType?: (challengeName: any, challengeParameters: any) => void;
};

const NEW_PASSWORD_ATTRIBUTE_PREFIX = 'userAttributes.';

export class CognitoUser {
    username: string;
    pool: CognitoUserPool;
    Session: string | null;
    client: Client;
    signInUserSession: CognitoUserSession | null;
    authenticationFlowType: string;
    storage: StorageLike;
    keyPrefix: string;
    userDataKey: string;
    challengeName?: string;

    constructor(data: { Username: string; Pool: CognitoUserPool; Storage?: StorageLike; }) {
        if (data == null || data.Username == null || data.Pool == null) {
            throw new Error('Username and Pool information are required.');
        }
        this.username = data.Username || '';
        this.pool = data.Pool;
        this.Session = null;
        this.client = data.Pool.client;
        this.signInUserSession = null;
        this.authenticationFlowType = 'USER_SRP_AUTH';
        this.storage = data.Storage || defaultStorage();
        this.keyPrefix = `CognitoIdentityServiceProvider.${this.pool.getClientId()}`;
        this.userDataKey = `${this.keyPrefix}.${this.username}.userData`;
    }

    setSignInUserSession(signInUserSession: CognitoUserSession): void {
        this.clearCachedUserData();
        this.signInUserSession = signInUserSession;
        this.cacheTokens();
    }

    getSignInUserSession(): CognitoUserSession | null {
        return this.signInUserSession;
    }

    getUsername(): string {
        return this.username;
    }

    getAuthenticationFlowType(): string {
        return this.authenticationFlowType;
    }

    setAuthenticationFlowType(authenticationFlowType: string): void {
        this.authenticationFlowType = authenticationFlowType;
    }

    private hasValidSession(): boolean {
        return this.signInUserSession != null && this.signInUserSession.isValid();
    }

    private accessToken(): string {
        return this.signInUserSession.getAccessToken().getJwtToken();
    }

    // -- sign-in ----------------------------------------------------------------------------------

    /** SRP sign-in: the password never leaves the device. */
    authenticateUser(authDetails: AuthenticationDetails, callback: AuthCallbacks): void {
        if (this.authenticationFlowType !== 'USER_SRP_AUTH') {
            return callback.onFailure(new Error('Authentication flow type is invalid.'));
        }

        let helper: SrpHelper;
        try {
            helper = new SrpHelper(this.pool.getUserPoolName());
        }
        catch (err) {
            return callback.onFailure(err);
        }

        const clientMetadata = Object.keys(authDetails.getValidationData()).length !== 0
            ? authDetails.getValidationData()
            : authDetails.getClientMetadata();

        const jsonReq = {
            AuthFlow: this.authenticationFlowType,
            ClientId: this.pool.getClientId(),
            AuthParameters: {
                USERNAME: this.username,
                SRP_A: helper.largeA.toString(16)
            },
            ClientMetadata: clientMetadata
        };

        this.client.request('InitiateAuth', jsonReq, (err, data) => {
            if (err) {
                return callback.onFailure(err);
            }

            const challengeParameters = data.ChallengeParameters;
            this.username = challengeParameters.USER_ID_FOR_SRP;
            this.userDataKey = `${this.keyPrefix}.${this.username}.userData`;

            let hkdf: Uint8Array;
            try {
                hkdf = helper.getPasswordAuthenticationKey(
                    this.username,
                    authDetails.getPassword(),
                    hexToBigInt(challengeParameters.SRP_B),
                    hexToBigInt(challengeParameters.SALT)
                );
            }
            catch (errOnHkdf) {
                return callback.onFailure(errOnHkdf);
            }

            const dateNow = cognitoTimestamp();
            const message = concatBytes(
                utf8(this.pool.getUserPoolName()),
                utf8(this.username),
                base64ToBytes(challengeParameters.SECRET_BLOCK),
                utf8(dateNow)
            );
            const signatureString = bytesToBase64(hmacSha256(hkdf, message));

            const jsonReqResp = {
                ChallengeName: 'PASSWORD_VERIFIER',
                ClientId: this.pool.getClientId(),
                ChallengeResponses: {
                    USERNAME: this.username,
                    PASSWORD_CLAIM_SECRET_BLOCK: challengeParameters.SECRET_BLOCK,
                    TIMESTAMP: dateNow,
                    PASSWORD_CLAIM_SIGNATURE: signatureString
                },
                Session: data.Session,
                ClientMetadata: clientMetadata
            };

            this.client.request('RespondToAuthChallenge', jsonReqResp, (errAuthenticate, dataAuthenticate) => {
                if (errAuthenticate) {
                    return callback.onFailure(errAuthenticate);
                }
                return this.authenticateUserInternal(dataAuthenticate, callback);
            });
        });
    }

    /** What Cognito answered to a sign-in step: tokens, or the next challenge. */
    private authenticateUserInternal(dataAuthenticate: any, callback: AuthCallbacks): void {
        const challengeName = dataAuthenticate.ChallengeName;
        const challengeParameters = dataAuthenticate.ChallengeParameters;

        if (challengeName === 'SMS_MFA') {
            this.Session = dataAuthenticate.Session;
            return callback.mfaRequired(challengeName, challengeParameters);
        }
        if (challengeName === 'SELECT_MFA_TYPE') {
            this.Session = dataAuthenticate.Session;
            return callback.selectMFAType(challengeName, challengeParameters);
        }
        if (challengeName === 'MFA_SETUP') {
            this.Session = dataAuthenticate.Session;
            return callback.mfaSetup(challengeName, challengeParameters);
        }
        if (challengeName === 'SOFTWARE_TOKEN_MFA') {
            this.Session = dataAuthenticate.Session;
            return callback.totpRequired(challengeName, challengeParameters);
        }
        if (challengeName === 'CUSTOM_CHALLENGE') {
            this.Session = dataAuthenticate.Session;
            return callback.customChallenge(challengeParameters);
        }
        if (challengeName === 'NEW_PASSWORD_REQUIRED') {
            this.Session = dataAuthenticate.Session;
            let userAttributes = null;
            let rawRequiredAttributes = null;
            const requiredAttributes = [];
            if (challengeParameters) {
                userAttributes = JSON.parse(dataAuthenticate.ChallengeParameters.userAttributes);
                rawRequiredAttributes = JSON.parse(dataAuthenticate.ChallengeParameters.requiredAttributes);
            }
            if (rawRequiredAttributes) {
                for (let i = 0; i < rawRequiredAttributes.length; i++) {
                    requiredAttributes[i] = rawRequiredAttributes[i].substr(NEW_PASSWORD_ATTRIBUTE_PREFIX.length);
                }
            }
            return callback.newPasswordRequired(userAttributes, requiredAttributes);
        }
        if (challengeName === 'DEVICE_SRP_AUTH') {
            // Only for remembered devices; device tracking is off on every Skapi user pool.
            return callback.onFailure(new Error('Device authentication is not supported.'));
        }

        this.signInUserSession = this.getCognitoUserSession(dataAuthenticate.AuthenticationResult);
        this.challengeName = challengeName;
        this.cacheTokens();
        return callback.onSuccess(this.signInUserSession);
    }

    completeNewPasswordChallenge(
        newPassword: string,
        requiredAttributeData: Record<string, string>,
        callback: AuthCallbacks,
        clientMetadata?: Record<string, string>
    ): void {
        if (!newPassword) {
            return callback.onFailure(new Error('New password is required.'));
        }
        const finalUserAttributes: Record<string, string> = {};
        if (requiredAttributeData) {
            Object.keys(requiredAttributeData).forEach(key => {
                finalUserAttributes[NEW_PASSWORD_ATTRIBUTE_PREFIX + key] = requiredAttributeData[key];
            });
        }
        finalUserAttributes.NEW_PASSWORD = newPassword;
        finalUserAttributes.USERNAME = this.username;
        const jsonReq = {
            ChallengeName: 'NEW_PASSWORD_REQUIRED',
            ClientId: this.pool.getClientId(),
            ChallengeResponses: finalUserAttributes,
            Session: this.Session,
            ClientMetadata: clientMetadata
        };
        this.client.request('RespondToAuthChallenge', jsonReq, (errAuthenticate, dataAuthenticate) => {
            if (errAuthenticate) {
                return callback.onFailure(errAuthenticate);
            }
            return this.authenticateUserInternal(dataAuthenticate, callback);
        });
    }

    sendMFACode(confirmationCode: string, callback: AuthCallbacks, mfaType?: string, clientMetadata?: Record<string, string>): void {
        const mfaTypeSelection = mfaType || 'SMS_MFA';
        const challengeResponses: Record<string, string> = {
            USERNAME: this.username,
            SMS_MFA_CODE: confirmationCode
        };
        if (mfaTypeSelection === 'SOFTWARE_TOKEN_MFA') {
            challengeResponses.SOFTWARE_TOKEN_MFA_CODE = confirmationCode;
        }
        const jsonReq = {
            ChallengeName: mfaTypeSelection,
            ChallengeResponses: challengeResponses,
            ClientId: this.pool.getClientId(),
            Session: this.Session,
            ClientMetadata: clientMetadata
        };
        this.client.request('RespondToAuthChallenge', jsonReq, (err, dataAuthenticate) => {
            if (err) {
                return callback.onFailure(err);
            }
            if (dataAuthenticate.ChallengeName === 'DEVICE_SRP_AUTH') {
                return callback.onFailure(new Error('Device authentication is not supported.'));
            }
            this.signInUserSession = this.getCognitoUserSession(dataAuthenticate.AuthenticationResult);
            this.cacheTokens();
            return callback.onSuccess(this.signInUserSession);
        });
    }

    sendMFASelectionAnswer(answerChallenge: string, callback: Partial<AuthCallbacks> & { onFailure: (err: any) => void; }): void {
        const jsonReq = {
            ChallengeName: 'SELECT_MFA_TYPE',
            ChallengeResponses: {
                USERNAME: this.username,
                ANSWER: answerChallenge
            },
            ClientId: this.pool.getClientId(),
            Session: this.Session
        };
        this.client.request('RespondToAuthChallenge', jsonReq, (err, data) => {
            if (err) {
                return callback.onFailure(err);
            }
            this.Session = data.Session;
            if (answerChallenge === 'SMS_MFA') {
                return callback.mfaRequired(data.ChallengeName, data.ChallengeParameters);
            }
            if (answerChallenge === 'SOFTWARE_TOKEN_MFA') {
                return callback.totpRequired(data.ChallengeName, data.ChallengeParameters);
            }
            return undefined;
        });
    }

    // -- authenticator app MFA --------------------------------------------------------------------

    associateSoftwareToken(callback: { associateSecretCode: (secretCode: string) => void; onFailure: (err: any) => void; }): void {
        if (!this.hasValidSession()) {
            this.client.request('AssociateSoftwareToken', { Session: this.Session }, (err, data) => {
                if (err) {
                    return callback.onFailure(err);
                }
                this.Session = data.Session;
                return callback.associateSecretCode(data.SecretCode);
            });
        }
        else {
            this.client.request('AssociateSoftwareToken', { AccessToken: this.accessToken() }, (err, data) => {
                if (err) {
                    return callback.onFailure(err);
                }
                return callback.associateSecretCode(data.SecretCode);
            });
        }
    }

    verifySoftwareToken(totpCode: string, friendlyDeviceName: string | undefined, callback: { onSuccess: (data: any) => void; onFailure: (err: any) => void; }): void {
        if (!this.hasValidSession()) {
            this.client.request('VerifySoftwareToken', {
                Session: this.Session,
                UserCode: totpCode,
                FriendlyDeviceName: friendlyDeviceName
            }, (err, data) => {
                if (err) {
                    return callback.onFailure(err);
                }
                this.Session = data.Session;
                const jsonReq = {
                    ChallengeName: 'MFA_SETUP',
                    ClientId: this.pool.getClientId(),
                    ChallengeResponses: { USERNAME: this.username },
                    Session: this.Session
                };
                this.client.request('RespondToAuthChallenge', jsonReq, (errRespond, dataRespond) => {
                    if (errRespond) {
                        return callback.onFailure(errRespond);
                    }
                    this.signInUserSession = this.getCognitoUserSession(dataRespond.AuthenticationResult);
                    this.cacheTokens();
                    return callback.onSuccess(this.signInUserSession);
                });
            });
        }
        else {
            this.client.request('VerifySoftwareToken', {
                AccessToken: this.accessToken(),
                UserCode: totpCode,
                FriendlyDeviceName: friendlyDeviceName
            }, (err, data) => {
                if (err) {
                    return callback.onFailure(err);
                }
                return callback.onSuccess(data);
            });
        }
    }

    setUserMfaPreference(smsMfaSettings: any, softwareTokenMfaSettings: any, callback: Callback): void {
        if (!this.hasValidSession()) {
            return callback(new Error('User is not authenticated'), null);
        }
        this.client.request('SetUserMFAPreference', {
            SMSMfaSettings: smsMfaSettings,
            SoftwareTokenMfaSettings: softwareTokenMfaSettings,
            AccessToken: this.accessToken()
        }, err => {
            if (err) {
                return callback(err, null);
            }
            return callback(null, 'SUCCESS');
        });
    }

    // -- account ----------------------------------------------------------------------------------

    changePassword(oldUserPassword: string, newUserPassword: string, callback: Callback, clientMetadata?: Record<string, string>): void {
        if (!this.hasValidSession()) {
            return callback(new Error('User is not authenticated'), null);
        }
        this.client.request('ChangePassword', {
            PreviousPassword: oldUserPassword,
            ProposedPassword: newUserPassword,
            AccessToken: this.accessToken(),
            ClientMetadata: clientMetadata
        }, err => {
            if (err) {
                return callback(err, null);
            }
            return callback(null, 'SUCCESS');
        });
    }

    updateAttributes(attributes: CognitoUserAttribute[], callback: Callback, clientMetadata?: Record<string, string>): void {
        if (!this.hasValidSession()) {
            return callback(new Error('User is not authenticated'), null);
        }
        this.client.request('UpdateUserAttributes', {
            AccessToken: this.accessToken(),
            UserAttributes: attributes,
            ClientMetadata: clientMetadata
        }, (err, result) => {
            if (err) {
                return callback(err, null);
            }
            // As the library: re-read the user (and, when it was cached before, refresh the
            // tokens) before answering; that step's own errors are ignored.
            return this.getUserData(() => callback(null, 'SUCCESS', result), { bypassCache: true });
        });
    }

    getUserData(callback: Callback, params?: { bypassCache?: boolean; clientMetadata?: Record<string, string>; }): void {
        if (!this.hasValidSession()) {
            this.clearCachedUserData();
            return callback(new Error('User is not authenticated'), null);
        }
        const userData = this.storage.getItem(this.userDataKey);
        if (!userData) {
            this.fetchUserData().then(data => {
                callback(null, data);
            }).catch(callback);
            return;
        }
        if (params?.bypassCache) {
            this.fetchUserData()
                .then(data => this.refreshSessionIfPossible(params).then(() => data))
                .then(data => callback(null, data))
                .catch(callback);
            return;
        }
        try {
            callback(null, JSON.parse(userData));
        }
        catch (err) {
            this.clearCachedUserData();
            callback(err, null);
        }
    }

    private fetchUserData(): Promise<any> {
        return this.client.promisifyRequest('GetUser', { AccessToken: this.accessToken() }).then(data => {
            this.storage.setItem(this.userDataKey, JSON.stringify(data));
            return data;
        });
    }

    private refreshSessionIfPossible(options: { clientMetadata?: Record<string, string>; } = {}): Promise<void> {
        return new Promise(resolve => {
            const refresh = this.signInUserSession.getRefreshToken();
            if (refresh && refresh.getToken()) {
                this.refreshSession(refresh, () => resolve(), options.clientMetadata);
            }
            else {
                resolve();
            }
        });
    }

    forgotPassword(callback: { onSuccess: (data: any) => void; onFailure: (err: any) => void; inputVerificationCode?: (data: any) => void; }, clientMetadata?: Record<string, string>): void {
        this.client.request('ForgotPassword', {
            ClientId: this.pool.getClientId(),
            Username: this.username,
            ClientMetadata: clientMetadata
        }, (err, data) => {
            if (err) {
                return callback.onFailure(err);
            }
            if (typeof callback.inputVerificationCode === 'function') {
                return callback.inputVerificationCode(data);
            }
            return callback.onSuccess(data);
        });
    }

    confirmPassword(confirmationCode: string, newPassword: string, callback: { onSuccess: (data: any) => void; onFailure: (err: any) => void; }, clientMetadata?: Record<string, string>): void {
        this.client.request('ConfirmForgotPassword', {
            ClientId: this.pool.getClientId(),
            Username: this.username,
            ConfirmationCode: confirmationCode,
            Password: newPassword,
            ClientMetadata: clientMetadata
        }, err => {
            if (err) {
                return callback.onFailure(err);
            }
            return callback.onSuccess('SUCCESS');
        });
    }

    getAttributeVerificationCode(attributeName: string, callback: { onSuccess: (data: any) => void; onFailure: (err: any) => void; inputVerificationCode?: ((data: any) => void) | null; }, clientMetadata?: Record<string, string>): void {
        if (!this.hasValidSession()) {
            return callback.onFailure(new Error('User is not authenticated'));
        }
        this.client.request('GetUserAttributeVerificationCode', {
            AttributeName: attributeName,
            AccessToken: this.accessToken(),
            ClientMetadata: clientMetadata
        }, (err, data) => {
            if (err) {
                return callback.onFailure(err);
            }
            if (typeof callback.inputVerificationCode === 'function') {
                return callback.inputVerificationCode(data);
            }
            return callback.onSuccess('SUCCESS');
        });
    }

    verifyAttribute(attributeName: string, confirmationCode: string, callback: { onSuccess: (data: any) => void; onFailure: (err: any) => void; }): void {
        if (!this.hasValidSession()) {
            return callback.onFailure(new Error('User is not authenticated'));
        }
        this.client.request('VerifyUserAttribute', {
            AttributeName: attributeName,
            Code: confirmationCode,
            AccessToken: this.accessToken()
        }, err => {
            if (err) {
                return callback.onFailure(err);
            }
            return callback.onSuccess('SUCCESS');
        });
    }

    // -- session ----------------------------------------------------------------------------------

    /** The current session: in memory, else from storage, refreshed when it has expired. */
    getSession(callback: Callback<CognitoUserSession>, options: { clientMetadata?: Record<string, string>; } = {}): void {
        if (this.username == null) {
            return callback(new Error('Username is null. Cannot retrieve a new session'), null);
        }
        if (this.hasValidSession()) {
            return callback(null, this.signInUserSession);
        }

        const keyPrefix = `CognitoIdentityServiceProvider.${this.pool.getClientId()}.${this.username}`;
        const idTokenKey = `${keyPrefix}.idToken`;
        if (this.storage.getItem(idTokenKey)) {
            const idToken = new CognitoIdToken({ IdToken: this.storage.getItem(idTokenKey) });
            const accessToken = new CognitoAccessToken({ AccessToken: this.storage.getItem(`${keyPrefix}.accessToken`) });
            const refreshToken = new CognitoRefreshToken({ RefreshToken: this.storage.getItem(`${keyPrefix}.refreshToken`) });
            const clockDrift = parseInt(this.storage.getItem(`${keyPrefix}.clockDrift`), 0) || 0;
            const cachedSession = new CognitoUserSession({
                IdToken: idToken,
                AccessToken: accessToken,
                RefreshToken: refreshToken,
                ClockDrift: clockDrift
            });
            if (cachedSession.isValid()) {
                this.signInUserSession = cachedSession;
                return callback(null, this.signInUserSession);
            }
            if (!refreshToken.getToken()) {
                return callback(new Error('Cannot retrieve a new session. Please authenticate.'), null);
            }
            this.refreshSession(refreshToken, callback, options.clientMetadata);
        }
        else {
            callback(new Error('Local storage is missing an ID Token, Please authenticate'), null);
        }
    }

    refreshSession(refreshToken: CognitoRefreshToken, callback: Callback<CognitoUserSession>, clientMetadata?: Record<string, string>): void {
        const authParameters: Record<string, any> = {
            REFRESH_TOKEN: refreshToken.getToken()
        };
        const lastUserKey = `${this.keyPrefix}.LastAuthUser`;
        if (this.storage.getItem(lastUserKey)) {
            this.username = this.storage.getItem(lastUserKey);
            // Sent as the library sent it: null, since no device is ever remembered.
            authParameters.DEVICE_KEY = this.storage.getItem(`${this.keyPrefix}.${this.username}.deviceKey`);
        }
        const jsonReq = {
            ClientId: this.pool.getClientId(),
            AuthFlow: 'REFRESH_TOKEN_AUTH',
            AuthParameters: authParameters,
            ClientMetadata: clientMetadata
        };
        this.client.requestWithRetry('InitiateAuth', jsonReq, (err, authResult) => {
            if (err) {
                if (err.code === 'NotAuthorizedException') {
                    this.clearCachedUser();
                }
                return callback(err, null);
            }
            if (authResult) {
                const authenticationResult = authResult.AuthenticationResult;
                if (!Object.prototype.hasOwnProperty.call(authenticationResult, 'RefreshToken')) {
                    authenticationResult.RefreshToken = refreshToken.getToken();
                }
                this.signInUserSession = this.getCognitoUserSession(authenticationResult);
                this.cacheTokens();
                return callback(null, this.signInUserSession);
            }
            return undefined;
        });
    }

    /** Signs out on this device only: forgets the session and its stored tokens. */
    signOut(): void {
        this.signInUserSession = null;
        this.clearCachedUser();
    }

    /** Ends every session of the account on every device, then forgets this one. */
    globalSignOut(callback: { onSuccess: (msg: string) => void; onFailure: (err: any) => void; }): void {
        if (!this.hasValidSession()) {
            return callback.onFailure(new Error('User is not authenticated'));
        }
        this.client.request('GlobalSignOut', { AccessToken: this.accessToken() }, err => {
            if (err) {
                return callback.onFailure(err);
            }
            this.clearCachedUser();
            return callback.onSuccess('SUCCESS');
        });
    }

    // -- storage ----------------------------------------------------------------------------------

    cacheTokens(): void {
        const prefix = `${this.keyPrefix}.${this.username}`;
        this.storage.setItem(`${prefix}.idToken`, this.signInUserSession.getIdToken().getJwtToken());
        this.storage.setItem(`${prefix}.accessToken`, this.signInUserSession.getAccessToken().getJwtToken());
        this.storage.setItem(`${prefix}.refreshToken`, this.signInUserSession.getRefreshToken().getToken());
        this.storage.setItem(`${prefix}.clockDrift`, `${this.signInUserSession.getClockDrift()}`);
        this.storage.setItem(`${this.keyPrefix}.LastAuthUser`, this.username);
    }

    clearCachedUserData(): void {
        this.storage.removeItem(this.userDataKey);
    }

    clearCachedUser(): void {
        this.clearCachedTokens();
        this.clearCachedUserData();
    }

    clearCachedTokens(): void {
        const prefix = `${this.keyPrefix}.${this.username}`;
        this.storage.removeItem(`${prefix}.idToken`);
        this.storage.removeItem(`${prefix}.accessToken`);
        this.storage.removeItem(`${prefix}.refreshToken`);
        this.storage.removeItem(`${this.keyPrefix}.LastAuthUser`);
        this.storage.removeItem(`${prefix}.clockDrift`);
    }

    getCognitoUserSession(authResult: any): CognitoUserSession {
        return new CognitoUserSession({
            IdToken: new CognitoIdToken(authResult),
            AccessToken: new CognitoAccessToken(authResult),
            RefreshToken: new CognitoRefreshToken(authResult)
        });
    }
}
