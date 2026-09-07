import {
    DatabaseResponse,
    FetchOptions,
    Form,
    Newsletter,
    NewsletterGroup,
    Subscription,
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
): Promise<DatabaseResponse<Subscription>> {
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

export async function subscribe(params: { user_id: string; get_feed?: boolean; get_notified?: boolean; get_email?: boolean; }): Promise<Subscription> {
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

/**
 * Fetches the user's newsletter subscriptions.<br>
 * Accepts a numeric group, "public", "authorized" or a named newsletter group.<br>
 * When "group" is omitted or null, every group the user is subscribed to is returned.
 * ```
 * let subscriptions = await skapi.getNewsletterSubscription({ group: 'bunnyquery' });
 * ```
 */
export async function getNewsletterSubscription(params?: {group?: number | 'public' | 'authorized' | (string & {}) | null;},
fetchOptions?: FetchOptions): Promise<{
    active: boolean;
    timestamp: number;
    group: number | string;
    subscribed_email: string;
}[]> {
    await this.__connection;
    let isAdmin = await checkAdmin.bind(this)();

    params = validator.Params(
        params || {},
        {
            user_id: v => {
                if (v !== this.__user.user_id && !isAdmin) {
                    throw new SkapiError(`No access.`, { code: 'INVALID_REQUEST' });
                }

                return v;
            },
            group: v => validator.newsletterGroup(v, { allowNull: true })
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

        // A named group's token IS the group name (NAMED_NEWSLETTERS.md section 3), so
        // parseInt turned every named subscription into NaN. Only a "00".."99" token is
        // handed back as a number, which is what callers have always compared against.
        let group: number | string = /^\d+$/.test(subt[0]) ? parseInt(subt[0]) : subt[0];

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
 * redirect is for newsletter subscribe confirmation link which it will only be sent to group 0 subscribers.<br>
 * "group" can also be the name of a named newsletter group registered with registerNewsletterGroup().<br>
 * An anonymous subscriber may only reach a group whose restriction is 0.
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
        group: number | 'public' | 'authorized' | (string & {});
        redirect?: string;
    }>
): Promise<string> {
    await this.__connection;

    let params = validator.Params(
        form || {},
        {
            email: (v: string) => {
                if(Array.isArray(v) && v.length > 0) {
                    if(v.length === 1) {
                        return validator.Email(v[0]);
                    }
                    else {
                        return v.map(e => validator.Email(e));
                    }
                }
                return validator.Email(v);
            },
            group: (v: any) => validator.newsletterGroup(v),
            redirect: (v: string) => validator.Url(v)
        },
        this.__user ? ['group'] : ['email', 'group']
    );

    return request.bind(this)(`subscribe-${this.__user ? '' : 'public-'}newsletter`, params, { auth: !!this.__user });
}

// /* depricate from the user api */
// export async function adminNewsletterRequest(params) {
//     await this.__connection;
//     let response = await request.bind(this)('admin-newsletter-request', params, { auth: true });

//     return response
// }

/**
 * Registers a named newsletter group. Only the service owner can call this.<br>
 * The group name is the token subscribers are stored under, and it is also the "-" delimited
 * middle of the group's sending address, so it has to be 2 to 20 lowercase alphanumeric
 * characters, contain at least one letter, and not be one of the reserved names
 * ("tp", "admin", "public", "authorized", "newsletter", "forward", "all").<br>
 * "restriction" is the access group required to subscribe and to read the group's sent mail:
 * 0 lets anyone subscribe with an e-mail confirmation, 1 requires a signed in user, 2 to 99
 * requires that access group.<br>
 * A service can hold up to 20 named groups.
 * ```
 * skapi.registerNewsletterGroup({
 *      group: 'bunnyquery',
 *      restriction: 0,
 *      name: 'BunnyQuery news'
 * });
 * ```
 */
export async function registerNewsletterGroup(
    form: Form<{
        /** Name of the newsletter group. */
        group: string;
        /** Access group required to subscribe. 0 ~ 99. Defaults to 0. */
        restriction?: number;
        /** Display label of the group. 60 characters max. */
        name?: string;
    }>
): Promise<'SUCCESS: Group registered successfully.'> {
    await this.__connection;

    let params = validator.Params(
        form || {},
        {
            // A group is registered by NAME, so the numeric vocabulary is refused here:
            // 0 ~ 99 already exist and are not registrable.
            group: (v: any) => validator.newsletterGroup(v, { nameOnly: true }),
            restriction: (v: any) => {
                if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 99) {
                    throw new SkapiError('"restriction" should be a number between 0 and 99.', { code: 'INVALID_PARAMETER' });
                }

                return v;
            },
            name: (v: any) => {
                if (typeof v !== 'string' || v.length > 60) {
                    throw new SkapiError('"name" should be a string of 60 characters or less.', { code: 'INVALID_PARAMETER' });
                }

                return v;
            }
        },
        ['group']
    );

    return request.bind(this)('register-newsletter-group', params, { auth: true });
}

/**
 * Deletes a named newsletter group. Only the service owner can call this.<br>
 * Every subscription of the group is removed along with the group itself, so the subscribers
 * are gone for good.<br>
 * A group with a very large number of subscribers may need more than one call: the response
 * says how many subscriptions were removed, and the group is only gone once the call succeeds.
 * ```
 * skapi.deleteNewsletterGroup({ group: 'bunnyquery' });
 * ```
 * @returns 'SUCCESS: Group has been deleted along with N subscription(s).'
 */
export async function deleteNewsletterGroup(
    form: Form<{
        /** Name of the newsletter group to delete. */
        group: string;
    }>
): Promise<string> {
    await this.__connection;

    let params = validator.Params(
        form || {},
        {
            group: (v: any) => validator.newsletterGroup(v, { nameOnly: true })
        },
        ['group']
    );

    return request.bind(this)('delete-newsletter-group', params, { auth: true });
}

/**
 * Lists every named newsletter group of the service. Only the service owner can call this.<br>
 * Each group comes back with its restriction, its display label, its subscriber count and the
 * e-mail address a newsletter is sent to.<br>
 * "endpoint" is an empty string when the service has no sender e-mail set, since there is then
 * no address to mint.
 * ```
 * let { groups } = await skapi.newsletterGroupEndpoint();
 * ```
 */
export async function newsletterGroupEndpoint(): Promise<{ groups: NewsletterGroup[]; }> {
    await this.__connection;

    return request.bind(this)('newsletter-group-endpoint', null, { auth: true });
}

/**
 * Only signed users can unsubscribe newsletter via api.<br>
 * "group" takes a numeric group, "public", "authorized" or the name of a named newsletter group.<br>
 * if form.group is null, unsubscribes from all groups.
 * ```
 * skapi.unsubscribeNewsletter({ group: 'bunnyquery' });
 * ```
 */
export async function unsubscribeNewsletter(
    params: { group: number | 'public' | 'authorized' | (string & {}) | null; }
): Promise<string> {
    await this.__connection;

    params = validator.Params(
        params,
        {
            // A named group has to be removable by the same token it was subscribed
            // with, and null still means every group, which is what the unsubscribe
            // action has always answered to a missing group.
            group: (v: any) => validator.newsletterGroup(v, { allowNull: true })
        },
        ['group']
    );

    let param_send = Object.assign({
        action: 'unsubscribe'
    }, params);

    return request.bind(this)('subscribe-newsletter', param_send, { auth: true });
}

/**
 * Fetches the newsletters the service has sent out.<br>
 * "group" takes a numeric group, "public", "authorized" or the name of a named newsletter group.<br>
 * A named group is readable by anyone its restriction allows, signed in or not.
 * ```
 * let newsletters = await skapi.getNewsletters({
 *      searchFor: 'timestamp',
 *      value: Date.now(),
 *      condition: '<',
 *      group: 'bunnyquery'
 * });
 * ```
 */
export async function getNewsletters(
    params?: {
        /**
         * Search points.<br>
         * 'message_id' and 'subject' value should be string.<br>
         * Others numbers.
         */
        searchFor: 'message_id' | 'timestamp' | 'read' | 'complaint' | 'subject';
        value: string | number;
        group: 'public' | 'authorized' | number | (string & {});
        range?: string | number;
        /**
         * Defaults to '='
         */
        condition?: '>' | '>=' | '=' | '<' | '<=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte';
    },
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse<Newsletter>> {
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
            let group = validator.newsletterGroup(x);

            if (group === 0) {
                return 0;
            }

            // A named group carries its own restriction on the registry row, and
            // NAMED_NEWSLETTERS.md section 5 has the server apply it. A restriction of 0
            // is readable signed out, so refusing it here would hide a public list.
            if (typeof group === 'string') {
                return group;
            }

            if (!this.session) {
                throw new SkapiError('User should be logged in.', { code: 'INVALID_REQUEST' });
            }

            if (x === 'authorized') {
                return 1;
            }

            if (!isAdmin && group > parseInt(this.user?.access_group || this.session?.idToken?.payload?.access_group)) {
                throw new SkapiError('User has no access.', { code: 'INVALID_REQUEST' });
            }

            return group;
        }
    }, ['searchFor', 'value', 'group']);

    // NAMED_NEWSLETTERS.md section 10. Group 0 keeps the public route. A numeric group
    // above 0 was already refused to a signed out caller, so the only reader that can
    // reach the public route with a name is one who has no session to authorize with.
    let endpointTarget = params.group === 0 || (typeof params.group === 'string' && !this.__user)
        ? 'get-public-newsletters'
        : 'get-newsletters';
    let mails = await request.bind(this)(
        endpointTarget,
        params,
        Object.assign({ method: 'get', auth: endpointTarget === 'get-public-newsletters' ? !!this.__user : true }, { fetchOptions })
    );

    // The loop below copies only the keys it finds in BOTH tables, so a field listed in
    // one and missing from the other is silently dropped.
    let remap = {
        'message_id': 'mid',
        'timestamp': 'stmp',
        'complaint': 'cmpl',
        'read': 'read',
        'subject': 'subj',
        'bounced': 'bnce',
        'url': 'url',
        'delivered': 'delv',
        'group': 'grp'
    };
    let defaults = {
        'message_id': '',
        'timestamp': 0,
        'complaint': 0,
        'read': 0,
        'subject': '',
        'bounced': '',
        'url': '',
        'delivered': 0,
        // The sent-mail row is keyed by the group and does not carry it as its own
        // attribute, so the group the caller asked for is what comes back. A backend
        // that starts projecting "grp" takes over without another change here.
        'group': params.group
    };

    mails.list = mails.list.map(m => {
        let remapped = {};
        for (let k in remap) {
            remapped[k] = m[remap[k]] || defaults[k];
        }
        remapped['bounced'] = String(remapped['bounced']);
        return remapped;
    });

    return mails;
}