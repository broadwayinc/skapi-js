import {
    DatabaseResponse,
    FetchOptions,
    FormSubmitCallback,
    Form,
    Newsletters,
    SubscriptionGroup
} from '../Types';
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { request } from './request';

/** @ignore */
function subscriptionGroupCheck(option: SubscriptionGroup<number | '*'>) {
    option = validator.Params(option, {
        user_id: (v: string) => validator.UserId(v, '"user_id"'),
        group: (v: number | string) => {
            if (v === '*') {
                return v;
            }

            if (typeof v !== 'number') {
                throw new SkapiError('"group" should be type: number.', { code: 'INVALID_PARAMETER' });
            }

            else if (v < 1 && v > 99) {
                throw new SkapiError('"group" should be within range 1 ~ 99.', { code: 'INVALID_PARAMETER' });
            }

            return v;
        }
    }, ['user_id', 'group']);

    if (this.__user && option.user_id === this.__user.user_id) {
        throw new SkapiError(`"user_id" cannot be the user's own ID.`, { code: 'INVALID_PARAMETER' });
    }

    return option;
};

export async function getSubscriptions(
    params: {
        /** Subscribers user id. */
        subscriber?: string;
        /** User ID of the subscription. User id that subscriber has subscribed to. */
        subscription?: string;
        /** subscription group. if omitted, will fetch all groups. */
        group?: number;
        /** Fetch blocked subscription when True */
        blocked?: boolean;
    },
    fetchOptions?: FetchOptions,
    /** @ignore */
    _mapper?: Function
): Promise<DatabaseResponse<{
    subscriber: string; // Subscriber ID
    subscription: string; // Subscription ID
    group: number; // Subscription group number
    timestamp: number; // Subscribed UNIX timestamp
    blocked: boolean; // True when subscriber is blocked by subscription
}>> {
    params = validator.Params(params, {
        subscriber: (v: string) => validator.UserId(v, 'User ID in "subscriber"'),
        group: 'number',
        subscription: (v: string) => validator.UserId(v, 'User ID in "subscription"'),
        blocked: 'boolean'
    });

    if (!params.subscriber && !params.subscription) {
        throw new SkapiError('At least either "subscriber" or "subscription" should have a value.', { code: 'INVALID_PARAMETER' });
    }

    let response = await request.bind(this)('get-subscription', params, Object.assign({ auth: true }, { fetchOptions }));

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
 * Subscribes user's account to another account or updates email_subscription state.<br>
 * User cannot subscribe to email if they did not verify their email.<br>
 * This can be used for user following, content restrictions when building social media services.<br>
 * Refer: <a href='www.google.com'>How to use subscription systems</a><br>
 * 
 * ```
 * // user subscribes as group 1 to another user.
 * await skapi.subscribe({
 *     user_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
 *     group: 1
 * })
 * ```
 */
export async function subscribe(option: SubscriptionGroup<number>): Promise<'SUCCESS: the user has subscribed.'> {
    await this.__connection;
    let { user_id, group } = subscriptionGroupCheck.bind(this)(option);

    if (typeof group !== 'number') {
        throw new SkapiError('"group" should be type: number.', { code: 'INVALID_PARAMETER' });
    }

    return await request.bind(this)('subscription', {
        subscribe: user_id,
        group
    }, { auth: true });
}

/**
 * Unsubscribes user's account from another account.
 * ```
 * // user unsubscribes from group 2 of another user.
 * await skapi.unsubscribe({
 *     user_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
 *     group: 2
 * })
 * ```
 */
export async function unsubscribe(option: SubscriptionGroup<number | '*'>): Promise<'SUCCESS: the user has unsubscribed.'> {
    await this.__connection;
    let { user_id, group } = subscriptionGroupCheck.bind(this)(option);

    return await request.bind(this)('subscription', {
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
 */
export async function blockSubscriber(option: SubscriptionGroup<number | '*'>): Promise<'SUCCESS: blocked user id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".'> {
    await this.__connection;
    let { user_id, group } = subscriptionGroupCheck.bind(this)(option);
    return await request.bind(this)('subscription', { block: user_id, group }, { auth: true });
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
 */
export async function unblockSubscriber(option: SubscriptionGroup<number | '*'>): Promise<'SUCCESS: unblocked user id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".'> {
    await this.__connection;
    let { user_id, group } = subscriptionGroupCheck.bind(this)(option);
    return await request.bind(this)('subscription', { unblock: user_id, group }, { auth: true });
}

/** @ignore */
export async function getSubscribedTo(option: SubscriptionGroup<number | undefined> & { blocked?: boolean; }, fetchOptions: FetchOptions): Promise<DatabaseResponse<any>> {
    await this.__connection;
    option = validator.Params(option, {
        user_id: (v: string) => validator.UserId(v, '"user_id"'),
        group: 'number',
        blocked: 'boolean'
    }) || {};

    return getSubscriptions.bind(this)({
        subscriber: option.user_id || this.__user?.user_id,
        group: option.group,
        blocked: option.blocked
    }, fetchOptions);
};

/** @ignore */
export async function getSubscribers(option: SubscriptionGroup<number | undefined> & { blocked?: boolean; }, fetchOptions: FetchOptions): Promise<DatabaseResponse<any>> {
    await this.__connection;
    option = validator.Params(option, {
        user_id: (v: string) => validator.UserId(v, '"user_id"'),
        group: 'number',
        blocked: 'boolean'
    }) || {};

    let subParams = {
        subscription: option.user_id || this.__user?.user_id,
        group: option.group,
        blocked: option.blocked
    };

    return getSubscriptions.bind(this)(subParams, fetchOptions);
};

export async function getNewsletterSubscription(params: {
    group?: number;
}): Promise<{
    active: boolean;
    timestamp: number;
    group: number;
    subscribed_email: string;
}[]> {
    await this.__connection;
    let isAdmin = await this.checkAdmin();

    params = validator.Params(
        params,
        {
            user_id: v => {
                if (v !== this.__user.user_id && !isAdmin) {
                    throw new SkapiError(`No access.`, { code: 'INVALID_REQUEST' });
                }

                return v;
            },
            group: 'number'
        }
    );

    let list = await request.bind(this)('get-newsletter-subscription', params, { auth: true });
    let result = [];
    for (let sub of list) {
        //normalize
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
        group: number | 'public' | 'authorized';
        redirect?: string;
    }>,
    fetchOptions: FormSubmitCallback
): Promise<string> {
    await this.__connection;

    let params = validator.Params(
        form || {},
        {
            email: (v: string) => validator.Email(v),
            group: ['number', 'public', 'authorized'],
            redirect: (v: string) => validator.Url(v)
        },
        this.__user ? ['group'] : ['email', 'group']
    );

    return request.bind(this)('subscribe-newsletter', params, { fetchOptions, auth: !!this.__user });
}

/**
 * Only signed users can unsubscribe newsletter via api.
 * if form.group is null, unsubscribes from all groups.
 */
export async function unsubscribeNewsletter(
    params: { group: number | 'public' | 'authorized' | null; }
): Promise<string> {
    await this.__connection;

    params = validator.Params(
        params,
        {
            group: ['number', 'public', 'authorized']
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

    params = validator.Params(_params, {
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
        group: (x: number) => {
            if (!this.session) {
                throw new SkapiError('User should be logged in.', { code: 'INVALID_REQUEST' });
            }

            if (!isAdmin && x > parseInt(this.session.idToken.payload.access_group)) {
                throw new SkapiError('User has no access.', { code: 'INVALID_REQUEST' });
            }

            return x;
        }
    }, ['searchFor', 'value', 'group']);

    let mails = await request.bind(this)(
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