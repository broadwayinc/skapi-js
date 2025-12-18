import {
    DatabaseResponse,
    FetchOptions,
    Form,
    Newsletters,
    RecordData
} from '../Types';
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { request } from '../utils/network';
import { checkAdmin } from './user';
import { normalizeRecord } from './database';
import { extractFormData } from '../utils/utils';

export async function getFeed(params?: { access_group?: number; }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<RecordData>> {
    await this.__connection;

    params = validator.Params(
        params || {},
        {
            access_group: v => {
                if(v === 'authorized') {
                    v = 1;
                }
                if(v === 'public') {
                    v = 0;
                }
                if (typeof v !== 'number') {
                    throw new SkapiError('"access_group" should be type number.', { code: 'INVALID_PARAMETER' });
                }
                if (v < 0) {
                    throw new SkapiError('"access_group" should be zero or a positive number.', { code: 'INVALID_PARAMETER' });
                }
                if(v > this.__user.access_group) {
                    throw new SkapiError('User has no access.', { code: 'INVALID_REQUEST' });
                }
                return v;
            }
        }
    );
    let recs = await request.bind(this)('get-feed', params, { auth: true, fetchOptions });
    for (let i in recs.list) {
        recs.list[i] = await normalizeRecord.bind(this)(recs.list[i]);
    }
    return recs;
}

function cannotBeSelfId(v) {
    if (v === this.__user.user_id) {
        throw new SkapiError(`"user_id" cannot be the user's own ID.`, { code: 'INVALID_PARAMETER' });
    }
    return validator.UserId(v, '"user_id"');
}

export async function getSubscriptions(
    params: {
        /** Subscribers user id. */
        subscriber?: string;
        /** User ID of the subscription. User id that subscriber has subscribed to. */
        subscription?: string;
        /** Fetch blocked subscription when True */
        blocked?: boolean;
    },
    fetchOptions?: FetchOptions,
): Promise<DatabaseResponse<{
    subscriber: string; // Subscriber ID
    subscription: string; // Subscription ID
    timestamp: number; // Subscribed UNIX timestamp
    blocked: boolean; // True when subscriber is blocked by subscription
    get_feed: boolean; // True when subscriber gets feed
    get_notified: boolean; // True when subscriber gets notified
    get_email: boolean; // True when subscriber gets email
}>> {
    params = extractFormData(params, { ignoreEmpty: true }).data as any;
    params = validator.Params(params, {
        subscriber: (v: string) => validator.UserId(v, 'User ID in "subscriber"'),
        subscription: cannotBeSelfId.bind(this),
        blocked: 'boolean'
    });

    if (!params.subscriber && !params.subscription) {
        throw new SkapiError('At least either "subscriber" or "subscription" should have a value.', { code: 'INVALID_PARAMETER' });
    }

    let response = await request.bind(this)('get-subscription', params, Object.assign({ auth: true }, { fetchOptions }));

    response.list = response.list.map(((s: Record<string, any>) => {
        let subscription: Record<string, any> = {};
        if(s.sub) {
            let subSplit = s.sub.split('#');
            subscription.subscriber = subSplit[2];
            subscription.subscription = subSplit[0];
        }
        else {
            subscription.subscriber = s.subscriber;
            subscription.subscription = s.subscription;
        }
        subscription.timestamp = s?.timestamp || s.stmp;
        subscription.blocked = s?.blocked || s.grp.substring(0, 1) === 'N';
        Object.assign(subscription, s.opt);
        return subscription;
    }));

    return response;
}

export async function subscribe(params: { user_id: string; get_feed?: boolean; get_notified?: boolean; get_email?: boolean; }): Promise<{
    subscriber: string; // Subscriber ID
    subscription: string; // Subscription ID
    timestamp: number; // Subscribed UNIX timestamp
    blocked: boolean; // True when subscriber is blocked by subscription
    get_feed: boolean; // True when subscriber gets feed
    get_notified: boolean; // True when subscriber gets notified
    get_email: boolean; // True when subscriber gets email
}> {
    await this.__connection;
    params = validator.Params(params, {
        user_id: cannotBeSelfId.bind(this),
        get_feed: ['boolean', ()=>false],
        get_notified: ['boolean', ()=>false],
        get_email: v => {
            if (v && !this.__user.email || !this.__user.email_verified) {
                throw new SkapiError('User has no verified email address.', { code: 'INVALID_REQUEST' });
            }
            return !!v;
        }
    }, ['user_id']);

    let s = await request.bind(this)('subscription', {
        subscribe: params.user_id,
        option: {
            get_feed: params.get_feed,
            get_notified: params.get_notified,
            get_email: params.get_email || false
        }
    }, { auth: true });

    let subscription:any = {};
    if(s.sub) {
        let subSplit = s.sub.split('#');
        subscription.subscriber = subSplit[2];
        subscription.subscription = subSplit[0];
    }
    else {
        subscription.subscriber = s.subscriber;
        subscription.subscription = s.subscription;
    }
    subscription.timestamp = s?.timestamp || s.stmp;
    subscription.blocked = s?.blocked || s.grp.substring(0, 1) === 'N';
    Object.assign(subscription, s.opt);
    return subscription;
}

export async function adminNewsletterRequest(params) {
    await this.__connection;
    let response = await request.bind(this)('admin-newsletter-request', params, { auth: true });

    return response
}

export async function unsubscribe(params: { user_id: string; }): Promise<'SUCCESS: The user has unsubscribed.'> {
    await this.__connection;
    let { user_id } = validator.Params(params, {
        user_id: cannotBeSelfId.bind(this),
    }, ['user_id']);

    return await request.bind(this)('subscription', {
        unsubscribe: user_id,
    }, { auth: true });
}

export async function blockSubscriber(params: { user_id: string; }): Promise<'SUCCESS: Blocked user ID "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".'> {
    await this.__connection;
    let { user_id } = validator.Params(params, {
        user_id: cannotBeSelfId.bind(this),
    }, ['user_id']);
    return await request.bind(this)('subscription', { block: user_id }, { auth: true });
}

export async function unblockSubscriber(params: { user_id: string; }): Promise<'SUCCESS: Unblocked user ID "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".'> {
    await this.__connection;
    let { user_id } = validator.Params(params, {
        user_id: cannotBeSelfId.bind(this),
    }, ['user_id']);
    return await request.bind(this)('subscription', { unblock: user_id }, { auth: true });
}

// requires auth
export async function getNewsletterSubscription(params: {group?: number | 'public' | 'authorized';},
fetchOptions?: FetchOptions): Promise<{
    active: boolean;
    timestamp: number;
    group: number;
    subscribed_email: string;
}[]> {
    await this.__connection;
    let isAdmin = await checkAdmin.bind(this)();

    params = validator.Params(
        params,
        {
            user_id: v => {
                if (v !== this.__user.user_id && !isAdmin) {
                    throw new SkapiError(`No access.`, { code: 'INVALID_REQUEST' });
                }

                return v;
            },
            group: v => {
                if (v === 'public') {
                    v = 0
                }
                if (v === 'authorized') {
                    v = 1;
                }
                if (typeof v !== 'number') {
                    throw new SkapiError('"group" should be type number | "public" | "authorized".', { code: 'INVALID_PARAMETER' })
                }
                return v;
            }
        }
    );

    let data = await request.bind(this)('get-newsletter-subscription', params, { auth: true, fetchOptions: fetchOptions || null });
    let list = data?.list || data;
    
    let result = [];
    if(!Array.isArray(list)) {
        list = [];
    }
    for (let sub of list) {
        let subt = sub['subt'].split('#');
        let active = true;

        if (subt[0].charAt(0) === '@') {
            active = false;
            subt[0] = subt[0].substring(1);
        }

        let group = parseInt(subt[0]);

        result.push({
            timestamp: sub['stmp'],
            group,
            subscribed_email: subt[1],
            active
        });
    }

    if(data?.list) {
        data.list = result;
        return data;
    }

    return result;
}

/**
 * Anyone who submits their E-Mail address will receive newsletters from you.<br>
 * The newsletters you send out will have unsubscribe link at the bottom.<br>
 * Both Signed and unsigned users can subscribe to your newsletter.<br>
 * Signed users can also subscribe to groups other than 0.
 * redirect is for newsletter subscribe confirmation link which it will only be sent to group 0 subscribers.
 * ```
 * let params = {
 *      email: 'visitors@email.com'
 * };
 * 
 * skapi.subscribeNewsletter(params);
 * ```
 */
export async function subscribeNewsletter(
    form: Form<{
        email?: string;
        group: number | 'public' | 'authorized' | 'admin' | string; 
        redirect?: string;
    }>
): Promise<string> {
    await this.__connection;

    let params = validator.Params(
        form || {},
        {
            email: (v: string) => {
                if(Array.isArray(v)) {
                    return v.map(e => validator.Email(e));
                }
                return validator.Email(v);
            },
            group: ['number', 'public', 'authorized', 'admin', (v: string) => {
                if (typeof v !== 'string' || v.length > 20 || !/^[a-zA-Z0-9]+$/.test(v)) {
                    throw new SkapiError('"group" should be an alphanumeric string without spaces and less than 20 characters.', { code: 'INVALID_PARAMETER' });
                }
                return v;
            }], 
            redirect: (v: string) => validator.Url(v)
        },
        this.__user ? ['group'] : ['email', 'group']
    );

    return request.bind(this)(`subscribe-${this.__user ? '' : 'public-'}newsletter`, params, { auth: !!this.__user });
}

export async function registerNewsletterGroup(
    form: Form<{
        group: string;
        restriction: number;
    }>
): Promise<string> {
    await this.__connection;

    let params = validator.Params(
        form || {},
        {
            group: (v: string) => {
                if (typeof v !== 'string' || v.length > 20 || !/^[a-zA-Z0-9]+$/.test(v)) {
                    throw new SkapiError('"group" should be an alphanumeric string without spaces and less than 20 characters.', { code: 'INVALID_PARAMETER' });
                }
                return v;
            },
            restriction: (v: number) => {
                if (typeof v !== 'number' || v < 0 || v > 99) {
                    throw new SkapiError('"restriction" should be a number between 0 and 99.', { code: 'INVALID_PARAMETER' });
                }
                return v;
            }
        },
        ['group', 'restriction']
    );

    return request.bind(this)('register-newsletter-group', params, { auth: true });
}

export async function newsletterGroupEndpoint(params) {
    await this.__connection;
    let response = await request.bind(this)('newsletter-group-endpoint', params, { auth: true });

    return response
}

/**
 * Only signed users can unsubscribe newsletter via api.
 * if form.group is null, unsubscribes from all groups.
 */
export async function unsubscribeNewsletter(
    params: { group: number | 'public' | 'authorized' | 'admin' | null; }
): Promise<string> {
    await this.__connection;

    params = validator.Params(
        params,
        {
            group: ['number', 'public', 'authorized', 'admin']
        },
        ['group']
    );

    let param_send = Object.assign({
        action: 'unsubscribe'
    }, params);

    return request.bind(this)('subscribe-newsletter', param_send, { auth: true });
}

export async function getNewsletters(
    params?: {
        /**
         * Search points.<br>
         * 'message_id' and 'subject' value should be string.<br>
         * Others numbers.
         */
        searchFor: 'message_id' | 'timestamp' | 'read' | 'complaint' | 'subject';
        value: string | number;
        group: 'public' | 'authorized' | number;
        range?: string | number;
        /**
         * Defaults to '='
         */
        condition?: '>' | '>=' | '=' | '<' | '<=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte';
    },
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse<Newsletters>> {
    let isAdmin = await checkAdmin.bind(this)();

    let searchType = {
        'message_id': 'string',
        'timestamp': 'number',
        'read': 'number',
        'complaint': 'number',
        'subject': 'string',
        'bounced': 'number'
    };

    if (!params) {
        fetchOptions = Object.assign({ ascending: false }, (fetchOptions || {}));
    }

    params = extractFormData(params).data as any;

    params = params || {
        searchFor: 'timestamp',
        value: Date.now(),
        condition: '<',
        group: 'public'
    };

    params = validator.Params(params, {
        searchFor: [
            "message_id",
            "timestamp",
            "subject",
            "complaint",
            "read",
            "bounced",
        ],
        value: (v: number | string) => {
            if (typeof v !== searchType[params.searchFor]) {
                throw new SkapiError(`"value" type does not match the type of "${params.searchFor}" index.`, { code: 'INVALID_PARAMETER' });
            }
            else if (typeof v === 'string' && !v) {
                throw new SkapiError('"value" should not be empty string.', { code: 'INVALID_PARAMETER' });
            }

            return v;
        },
        range: (v: number | string) => {
            if (!params.hasOwnProperty('value') || typeof v !== typeof params.value) {
                throw new SkapiError('"range" should match type of "value".', { code: 'INVALID_PARAMETER' });
            }
            return v;
        },
        condition: ['>', '>=', '=', '<', '<=', 'gt', 'gte', 'eq', 'lt', 'lte', () => '='],
        group: (x: number | string) => {
            if (x === 'public') {
                return 0;
            }

            if (!this.session) {
                throw new SkapiError('User should be logged in.', { code: 'INVALID_REQUEST' });
            }

            if (x === 'authorized') {
                return 1;
            }

            if (typeof x === 'number') {
                if (!isAdmin && x > parseInt(this.session.idToken.payload.access_group)) {
                    throw new SkapiError('User has no access.', { code: 'INVALID_REQUEST' });
                }

                return x;
            }

            throw new SkapiError('"group" should be type: number | "public" | "authorized".', { code: 'INVALID_PARAMETER' });
        }
    }, ['searchFor', 'value', 'group']);

    let endpointTarget = params.group === 0 ? 'get-public-newsletters' : 'get-newsletters';
    let mails = await request.bind(this)(
        endpointTarget,
        params,
        Object.assign({ method: 'get', auth: endpointTarget === 'get-public-newsletters' ? !!this.__user : true }, { fetchOptions })
    );

    let remap = {
        'message_id': 'mid',
        'timestamp': 'stmp',
        'complaint': 'cmpl',
        'read': 'read',
        'subject': 'subj',
        'bounced': 'bnce',
        'url': 'url',
        'delivered': 'delv'
    };
    let defaults = {
        'message_id': '',
        'timestamp': 0,
        'complaint': 0,
        'read': 0,
        'subject': '',
        'bounced': 0,
        'url': '',
        'delivered': 0
    };

    mails.list = mails.list.map(m => {
        let remapped = {};
        for (let k in remap) {
            remapped[k] = m[remap[k]] || defaults[k];
        }
        return remapped;
    });

    return mails;
}