export type Connection = {
    /** Connection locale */
    locale: string;
    /** User ID of the service owner */
    owner: string;
    /** E-Mail address of the service owner */
    email: string;
    /** Service id */
    service: string;
    /** Service region */
    region: string;
    /** 13 digits timestamp of the service creation */
    timestamp: number;
    /** Hash string for authentication */
    hash: string;
};

/**
 * Additional option for form requests.
 * You can attach callbacks on response and error.
 * If there is a response callback, form will not trigger redirect.
 * <b>Example:</b>
 * 
 * ```
 * <form onsubmit="skapi.method(this, { response:r=>r, onerror: err=>err } ); return false;">
 *  <input name='NameIsKey' value='Some value'></input>
 * </form>
 * ```
 */
export type FormCallbacks = {
    /** Callback for form response */
    response?(response: any): any;
    /** Callback on error. When boolen true is given, alertbox will show. */
    onerror?: (error: Error) => any;
    /** Middleware callback for extracted FormData from HTMLFormElement. Will not execute if form is not HTMLFormElement.*/
    formData?: (formData: FormData) => Promise<FormData> | FormData;
};

/**
 * You can pass parameters with html forms if the method supports it.
 * 
 * <b>Example:</b>
 * 
 * ```
 * <form onsubmit="skapi.method(this, options); return false;">
 *  <input name='NameIsKey' value='Some value'></input>
 * </form>
 * 
 * // Above is equivalent as skapi.method({NameIsKey: 'Some Value'}, option);
 * // Form is useful when posting binary files.
 * // Javascript FormData is also supported.
 * ```
 */
export type Form = HTMLFormElement | FormData | Record<string, any>;

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

export type UserProfile = {
    /** Service id of the user account. */
    service: string;
    /** User ID of the service owner. */
    service_owner?: string;
    /** Access level of the user's account. */
    access_group?: number;
    /** User's ID. */
    user_id: string;
    /** Country code of where user signed up from. */
    locale: string;
    /**
     * User's E-Mail for signin.<br>
     * 64 character max.<br>
     * When E-Mail is changed, E-Mail verified state will be changed to false.<br>
     * E-Mail is only visible to others when set to public.<br>
     * E-Mail should be verified to set to public.
     * */
    email?: string;
    /** Shows true when user has verified their E-Mail. */
    email_verified?: boolean;
    /**
     * User's phone number. Format: "+0012341234"<br>
     * When phone number is changed, phone number verified state will be changed to false.<br>
     * Phone number is only visible to others when set to public.<br>
     * Phone number should be verified to set to public.
     */
    phone_number?: string;
    /** Shows true when user has verified their phone number. */
    phone_number_verified?: boolean;

    /** User's name */
    name?: string;
    /** User's address */
    address?: string;
    /**
     * User's gender. Can be "female" and "male".<br>
     * Other values may be used when neither of the defined values are applicable.
     */
    gender?: string;
    /** User's birthdate. String format: "1969-07-16" */
    birthdate?: string;
    /** User has subscribed to service e-mail when positive number. E-mail should be verified. */
    email_subscription?: number;
    /** User's E-mail is public when positive number. E-Mail should be verified. */
    email_public?: boolean;
    /** User's phone number is public when positive number. Phone number should be verified. */
    phone_number_public?: boolean;
    /** User's address is public when positive number. */
    address_public?: boolean;
    /** User's gender is public when positive number. */
    gender_public?: boolean;
    /** User's birthdate is public when positive number. */
    birthdate_public?: boolean;
    /** Shows 'PASS' if the user's account signup was successful.  */
    signup_ticket?: string;
};

export interface User extends UserProfile {
    /** Last login time */
    log: number;
    /** User data that has been set to private. The data is only shown to the owner of the account. */
    private_data?: Record<string, any>;
    /** Number of the user's subscribers. */
    subscribers: number;
    /** Timestamp of user signup time. */
    timestamp: number;
    /** User's data. */
    user_data?: Record<string, any>;
    /** Reference of how others would see the data. Appears only on the owner of the account. */
    _what_public_see?: Record<string, any>;
    /** @ignore */
    services?: Record<string, any>[];
}

export type GetRecordParams = {
    /** @ignore */
    service?: string;
    /** Table name */
    table: string;
    /**
     * Query for records that are accessable in certain user groups.
     * User cannot request access that are higher than the accounts user group.
     * Queries private records if 'private' is given.
     * User can only query their own private records or can have access to other private record if access is given.
     */
    access_group?: number | 'private';
    subscription?: {
        /**
         * You can fetch records in certain users subscription records.<br>
         * User will not be able to access the subscription record if the user is not subscribed to the user.
         */
        user_id: string;
        /**
         * Target subscription group number.<br>
         * User will not be able to access subscription group if the user is not subscribed to the group.<br>
         */
        group: number;
    },
    index: {
        /** 
         * Index name. Queries list of nested index key if index name ends with period.<br>
         * As example below, you can query all movies under the index name director.spielberg...<br>
         * ex) director.spielberg.<br>
         * Reserved index names are: '$record_id' | '$updated' | '$uploaded' | '$referenced_count'
         * */
        name: string | '$record_id' | '$updated' | '$uploaded' | '$referenced_count';
        /**
         * Index value to search based on the index name.<br>
         * If the index name is a index key name search value type must be string.<br>
         * For reserved index names '$record_id' is an record id string, otherwise is type number.
         */
        value: string | number | boolean;
        /** Search condition. Defaults to '='.*/
        condition?: '>' | '>=' | '=' | '<' | '<=' | '!=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte' | 'ne';
        /** 
         * Range of search. <br>
         * Range does not work with conditions.
         */
        range?: string | number | boolean;
    };
    /** 
     * Tags can be queried up to 10 tags at once.
     */
    tags?: string | string[];
    /**
     * Queries records that are referencing other record ids.<br>
     * If user id is given, you can get all records uploaded by certain user.
     */
    reference?: string;
};

export type PostRecordParams = {
    /** Record id to be updated. If omited, New record is uploaded. */
    record_id?: string;
    /** Table name */
    table: string;
    /** 
     * Access group.<br>
     * When number is given, user of corresponding service group has access to the record.<br>
     * User cannot set access_group number higher then the accounts service group.<br>
     * When 'private' is given, record is private.
     */
    access_group: number | 'private';
    /** 
     * Subscription group to allow access.<br>
     * When value is given, the record is only accessable to user who is subscribed the corresponding group.
     */
    subscription_group: number;
    /**
     * Record id to reference.<br>
     * If the reference record is private or subscription record, user must have access.<br>
     * When the subscription or private record is referenced,
     * the record does not get uploaded to the source subscription table since subscription record is only uploaded to the uploaders subscription table.<br>
     * In other words, if you upload a record with reference, with given subscription group number,
     * users wont be able to query all referenced record from the source since some of the referenced records will be in each individual subscription table.<br>
     * If record is referencing a private record and uploaded as private,
     * Any user who has access to the referenced record will also have access to all private referencing records.
     */
    reference?: string;
    index: {
        /** Index name. When ending with period, searches for nested key names ex) director. */
        name: string;
        /** Index value */
        value: string | number | boolean;
    };
    /** Tags */
    tags?: string | string[];
    config?: {
        /** Limits possible number of references. If 0 is given, record cannot be referenced. */
        reference_limit?: number;
        /** When true, allows users to upload multiple record that references the current record. */
        allow_multiple_reference?: boolean;
        /** List of user id to allow private access. */
        private_access?: string | string[];
    };
};

export type RecordData = {
    /** Record id */
    record_id: string;
    /** Table name of the record */
    table: string;
    /** Record access group */
    access_group: number | 'private';
    subscription: {
        /** Subscription id */
        user_id: string;
        /** Subscription group */
        group: number;
    };
    /** Uploaded timestamp */
    uploaded: number;
    /** User id of the record owner */
    user_id: string;
    /** Updated timestamp */
    updated: number;
    /** Number of record referencing this record. */
    referenced_count: number;
    config: {
        /** Allows multiple reference if true. */
        allow_multi_reference: boolean;
        /** Allows referencing if true. */
        reference_limit?: number;
        /** List of user id that has private access */
        private_access?: string[];
    };
    /** Record id that the record is referencing. */
    reference?: string;
    /** Data of the record */
    data?: any;
    index?: {
        /** Name of the index */
        name: string;
        /** Value of the index */
        value: string | number | boolean;
    };
    /** List of tags of the record. */
    tags?: string[];
};

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
    /** Number of records to fetch per call */
    limit?: number;
    /** Refresh the startKey. Only works on paginated queries. */
    refresh?: boolean;
    /** Result in ascending order if true, decending when false. */
    ascending?: boolean;
    /** StartKey key object can be used to query from the certain page of fetch. If refresh is true, will overwrite startKey to start. Only works on paginated queries.*/
    startKey?: Record<string, any>;
};

export type FetchResponse = {
    list: any[];
    startKey: Record<string, any> | 'end';
    endOfList: boolean;
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
    /** Number of user in the service. */
    users: number;
};

export type SubscriptionGroup = {
    /** User id. */
    user_id: string;
    /** Target group number (1 ~ 9). '*' is given, will apply to all groups. */
    group: number | '*';
};