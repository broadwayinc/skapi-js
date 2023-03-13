import {
    DatabaseResponse,
    FetchOptions,
    FormSubmitCallback,
    Form,
    Newsletters
} from '../Types';
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { request } from './request';

type SubscriptionGroup = {
    user_id: string;
    /** Number range: 0 ~ 99. '*' means all groups. */
    group?: number | '*';
};

function subscriptionGroupCheck(option: SubscriptionGroup) {
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

async function getSub(
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
): Promise<DatabaseResponse> {
    let isNewsletterSub = false;

    params = validator.Params(params, {
        subscriber: (v: string) => {
            try {
                return validator.UserId(v, 'User ID in "subscriber"');
            } catch (err) {
            }

            try {
                let isEmail = validator.Email(v);
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
                return validator.UserId(v, 'User ID in "subscription"');
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
        params.subscription = this.service_id;
    }

    if (!params.subscriber && !params.subscription) {
        throw new SkapiError('At least either "subscriber" or "subscription" should have a value.', { code: 'INVALID_PARAMETER' });
    }

    let response = await request.bind(this)('get-subscription', params, Object.assign({ auth: !isNewsletterSub }, { fetchOptions }));

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
 * // user subscribes to another user with email subscription
 * await skapi.subscribe({
 *     user_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
 *     group: 1
 * })
 * ```
 */
export async function subscribe(option: SubscriptionGroup) {
    await this.__connection;
    let { user_id, group } = subscriptionGroupCheck.bind(this)(option);

    if (group === '*') {
        throw new SkapiError('Cannot subscribe to all groups at once.', { code: 'INVALID_PARAMETER' });
    }

    return await request.bind(this)('subscription', {
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
 */
export async function unsubscribe(option: SubscriptionGroup) {
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
export async function blockSubscriber(option: SubscriptionGroup): Promise<string> {
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
export async function unblockSubscriber(option: SubscriptionGroup): Promise<string> {
    await this.__connection;
    let { user_id, group } = subscriptionGroupCheck.bind(this)(option);
    return await request.bind(this)('subscription', { unblock: user_id, group }, { auth: true });
}

export async function getSubscriptions(option: SubscriptionGroup, fetchOptions: FetchOptions): Promise<DatabaseResponse> {
    await this.__connection;
    option = validator.Params(option, {
        user_id: (v: string) => {
            try {
                return validator.UserId(v, '"user_id"');
            } catch (err) {
            }

            try {
                return validator.Email(v);
            } catch (err) {
            }

            throw new SkapiError('"subscriber" should be either valid user ID or E-Mail.', { code: 'INVALID_PARAMETER' });
        },
        group: 'number'
    }) || {};

    return getSub.bind(this)({
        subscriber: option.user_id || this.__user?.user_id,
        group: option.group
    }, fetchOptions);
};

export async function getSubscribers(option: SubscriptionGroup, fetchOptions: FetchOptions): Promise<DatabaseResponse> {
    await this.__connection;
    option = validator.Params(option, {
        user_id: (v: string) => validator.UserId(v, '"user_id"'),
        group: 'number'
    }) || {};

    let subParams = {
        subscription: option.user_id || this.__user?.user_id,
        group: option.group
    };

    return getSub.bind(this)(subParams, fetchOptions);
};

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
 */
export function subscribeNewsletter(
    form: Form<{
        /** Newsletter subscriber's E-Mail. 64 character max. */
        email: string,
        /**
         * Subscriber will receive a welcome E-Mail if set to false.<br>
         * The welcome E-Mail is the same E-Mail that is sent when the new user successfully creates an account on your web services.<br>
         * To save your operation cost, it is advised to redirect the users to your welcome page once subscription is successful.<br>
         * Refer: <a href="www.google.com">Setting up E-Mail templates</a><br>
         */
        bypassWelcome: boolean;
    }>,
    fetchOptions: FormSubmitCallback
): Promise<string> {
    let params = validator.Params(
        form || {},
        {
            email: (v: string) => validator.Email(v),
            bypassWelcome: ['boolean', () => true]
        },
        ['email']
    );

    return request.bind(this)('subscribe-newsletter', params, { fetchOptions });
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