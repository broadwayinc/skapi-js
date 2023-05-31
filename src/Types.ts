export type Condition = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';

export type SubscriptionGroup<T> = {
    user_id: string;
    /** Number range: 0 ~ 99. '*' means all groups. */
    group?: T;
};

export type Database<Tbl, Ref, Idx> = {
    /** @ignore */
    service?: string; // Only for admins.
    record_id?: string;
    table?: Tbl;
    reference?: Ref;
    index?: Idx;
};

export type GetRecordQuery = Database<
    {
        /** Not allowed: Special characters. Allowed: White space. periods.*/
        name: string;
        /** Number range: 0 ~ 99 */
        access_group?: number | 'private' | 'public' | 'authorized';
        subscription?: {
            user_id: string;
            /** Number range: 0 ~ 99 */
            group: number;
        };
    },
    /** Referenced record ID | user ID. */
    string,
    /** Index condition and range cannot be used simultaneously.*/
    {
        /** Not allowed: White space, special characters. Allowed: Periods. */
        name: string | '$updated' | '$uploaded' | '$referenced_count' | '$user_id';
        /** Not allowed: Periods, special characters. Allowed: White space. */
        value: string | number | boolean;
        condition?: Condition;
        range?: string | number | boolean;
    }
> & { tag?: string; };

export type PostRecordConfig = Database<
    {
        /** Not allowed: Special characters. Allowed: White space. periods.*/
        name?: string;
        /** Number range: 0 ~ 99 */
        access_group?: number | 'private' | 'public' | 'authorized';
        subscription_group?: number;
    },
    /** Referenced record ID | user ID. */
    {
        record_id: string;
        /** Default: null (Infinite) */
        reference_limit: number | null;
        /** Default: true */
        allow_multiple_reference: boolean;
    },
    /** null removes index */
    {
        /** Not allowed: White space, special characters. Allowed: Periods. */
        name: string;
        /** Not allowed: Periods, special characters. Allowed: White space. */
        value: string | number | boolean;
    } | null
> & { tags?: string[]; };

export type RecordData = {
    service: string;
    record_id: string;
    /** Uploader's user ID. */
    user_id: string;
    updated: number;
    uploaded: number;
    table: {
        name: string;
        /** Number range: 0 ~ 99 */
        access_group?: number | 'private' | 'public' | 'authorized';
        subscription?: {
            user_id: string;
            /** Number range: 0 ~ 99 */
            group: number;
        };
    },
    reference: {
        record_id?: string;
        reference_limit: number;
        allow_multiple_reference: boolean;
        referenced_count: number;
    },
    index?: {
        name: string;
        value: string | number | boolean;
    },
    data?: Record<string, any>;
    tags?: string[];
    ip: string;
};


export type Connection = {
    /** User's locale */
    locale: string;
    /** Service owner's ID */
    owner: string;
    /** E-Mail address of the service owner */
    email: string;
    /** Service ID */
    service: string;
    /** Service region */
    region: string;
    /** 13 digits timestamp of the service creation */
    timestamp: number;
    /** Connected user's IP address */
    ip: string;
};

export type FormSubmitCallback = {
    response?(response: any): any;
    onerror?(error: Error): any;
    formData?(formData: FormData): Promise<FormData> | FormData;
};

export type Form<T> = HTMLFormElement | FormData | SubmitEvent | T;

export type Newsletters = {
    /** Newsletter id */
    message_id: string;
    /** Time sent out */
    timestamp: number;
    /** Number of complaints */
    complaint: number;
    /** Number of read */
    read: number;
    /** Subject */
    subject: string;
    /**
     * Number of bounced.<br>
     * When e-mail address is bounced, skapi no longer sends e-mail to the bounced address.
     */
    bounced: string;
    /**
     * Url of the message html.
     */
    url: string;
};

export type UserAttributes = {
    /** User's name */
    name?: string;
    /**
     * User's E-Mail for signin.<br>
     * 64 character max.<br>
     * When E-Mail is changed, E-Mail verified state will be changed to false.<br>
     * E-Mail is only visible to others when set to public.<br>
     * E-Mail should be verified to set to public.
     * */
    email?: string;
    /**
     * User's phone number. Format: "+0012341234"<br>
     * When phone number is changed, phone number verified state will be changed to false.<br>
     * Phone number is only visible to others when set to public.<br>
     * Phone number should be verified to set to public.
     */
    phone_number?: string;
    /** User's address */
    address?: string | {
        // Full mailing address, formatted for display or use on a mailing label. This field MAY contain multiple lines, separated by newlines. Newlines can be represented either as a carriage return/line feed pair ("\r\n") or as a single line feed character ("\n").
        // street_address
        // Full street address component, which MAY include house number, street name, Post Office Box, and multi-line extended street address information. This field MAY contain multiple lines, separated by newlines. Newlines can be represented either as a carriage return/line feed pair ("\r\n") or as a single line feed character ("\n").
        formatted: string;
        // City or locality component.
        locality: string;
        // State, province, prefecture, or region component.
        region: string;
        // Zip code or postal code component.
        postal_code: string;
        // Country name component.
        country: string;
    };
    /**
     * User's gender. Can be "female" and "male".<br>
     * Other values may be used when neither of the defined values are applicable.
     */
    gender?: string;
    /** User's birthdate. String format: "1969-07-16" */
    birthdate?: string;
    /** User's E-mail is public when true. E-Mail should be verified. */
    email_public?: boolean;
    /** User's phone number is public when true. Phone number should be verified. */
    phone_number_public?: boolean;
    /** User's address is public when true. */
    address_public?: boolean;
    /** User's gender is public when true. */
    gender_public?: boolean;
    /** User's birthdate is public when true. */
    birthdate_public?: boolean;
    // /** User has subscribed to service e-mail when positive number. Number value is the access group of the user account. E-mail should be verified. */
    // email_subscription?: number;
    /** Additional string value that can be used freely. */
    misc?: string;
};

export type UserProfile = {
    /** Service id of the user account. */
    service: string;
    /** User ID of the service owner. */
    owner?: string;
    /** Access level of the user's account. */
    access_group?: number;
    /** User's ID. */
    user_id: string;
    /** Country code of where user first signed up from. */
    locale: string;
    /** Shows true when user has verified their E-Mail. */
    email_verified?: boolean;
    /** Shows true when user has verified their phone number. */
    phone_number_verified?: boolean;
    /** Shows 'PASS' if the user's account signup was successful. 'MEMBER' if signup confirmation was successful. */
    signup_ticket?: string;
} & UserAttributes;

export interface User extends UserProfile {
    /** Number of the user's subscribers. */
    subscribers: number;
    /** Timestamp of user signup time. */
    timestamp: number;
}

export type QueryParams = {
    /** Index name to search. */
    searchFor: string;
    /** Index value to search. */
    value: string | number | boolean;
    /** Search condition. */
    condition?: '>' | '>=' | '=' | '<' | '<=' | '!=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte' | 'ne';
    /** Range of search. */
    range?: string | number | boolean;
};

export type FetchOptions = {
    /** Maximum number of records to fetch per call */
    limit?: number;
    /** Fetch next batch of data. Will return empty list if there is nothing more to fetch. */
    fetchMore?: boolean;
    /** Result in ascending order if true, decending when false. */
    ascending?: boolean;
    /** Start key to be used to query from the certain batch of fetch. */
    startKey?: string;
};

export type DatabaseResponse<T> = {
    list: T[];
    startKey: string;
    endOfList: boolean;
    startKeyHistory: string[];
};

export type Service = {
    /** Shows active state. 1 = active, 0 = disabled */
    active: number;
    /** Custom api key to use for service owners custom api. */
    api_key: string;
    /** Service cors for connection. */
    cors: string[];
    /** Service owners E-Mail. */
    email: string;
    /** Number of users subscribed to service E-Mail. */
    email_subscribers: number;
    /** Service group. 1 = free try out. 1 > paid users. */
    group: number;
    /** Service region */
    region: string;
    /** Service name. */
    name: string;
    /** Number of newsletter subscribers. */
    newsletter_subscribers: number;
    /** Service id. */
    service: string;
    /** E-Mail template for signup confirmation. This can be changed by trigger E-Mail. */
    template_activation: {
        html: string;
        subject: string;
    };
    /** E-Mail template for verification code E-Mail. This can be changed by trigger E-Mail. */
    template_verification: {
        html: string;
        sms: string;
        subject: string;
    };
    /** E-Mail template for welcome E-Mail that user receives after signup process. This can be changed by trigger E-Mail. */
    template_welcome: {
        html: string;
        subject: string;
    };
    /** 13 digit timestamp  */
    timestamp: number;
    /** Service owner can send email to the triggers to send newsletters, or change automated E-Mail templates. */
    triggers: {
        /** Sends service E-Mail to E-Mail subscribed service users. */
        newsletter_signed: string;
        /** Sends newsletters. */
        newsletter_subscribers: string;
        /** Sets template of signup confirmation and account enable E-Mail. */
        template_activation: string;
        /** Sets template of verification E-Mail. */
        template_verification: string;
        /** Sets template of welcome E-Mail. */
        template_welcome: string;
    };
    /** Number of users in the service. */
    users: number;
};