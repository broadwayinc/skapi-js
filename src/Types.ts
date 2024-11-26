export type Condition = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';

export type RTCCallback = (e: {
    type: string;
    [key: string]: any;
}) => void

export type RTCReceiverParams = {
    ice?: string;
    media?: {
        video: boolean;
        audio: boolean;
    } | MediaStream;
}

export type RTCConnectorParams = {
    cid: string;
    ice?: string;
    media?: {
        video: boolean;
        audio: boolean;
    } | MediaStream;
    channels?: Array<RTCDataChannelInit | 'text-chat' | 'file-transfer' | 'video-chat' | 'voice-chat' | 'gaming'>;
}

export type RTCConnector = {
    hangup: () => void;
    connection: Promise<RTCResolved>;
}

export type RTCResolved = {
    target: RTCPeerConnection;
    channels: {
        [protocol: string]: RTCDataChannel
    };
    hangup: () => void;
    media: MediaStream;
}

export type WebSocketMessage = {
    type: 'message' | 'error' | 'success' | 'close' | 'notice' | 'private' | 'rtc' | 'reconnect' | 'rtc:incoming' | 'rtc:closed';
    message?: any;
    connectRTC?: (params: RTCReceiverParams, callback: RTCCallback) => Promise<RTCResolved>;
    hangup?: () => void; // Reject incoming RTC connection.
    sender?: string; // user_id of the sender
    sender_cid?: string; // scid of the sender
    sender_rid?: string; // group of the sender
}

export type RealtimeCallback = (rt: WebSocketMessage) => void;

export type GetRecordQuery = {
    unique_id?: string; // When unique_id is given, it will fetch the record with the given unique_id. Unique ID overrides record_id.
    record_id?: string;

    /** Table name not required when "record_id" is given. If string is given, "table.name" will be set with default settings. */
    table?: {
        /** Not allowed: Special characters. Allowed: White space. periods.*/
        name: string;
        /** Number range: 0 ~ 99. Default: 'public' */
        access_group?: number | 'private' | 'public' | 'authorized';
        // subscription?: {
        //     user_id: string;
        //     /** Number range: 0 ~ 99 */
        //     group: number;
        // };
        /** User ID of subscription */
        subscription?: string;
    } | string;

    reference?: string | {
        /** Referenced record ID. If user ID is given, it will fetch records that are uploaded by the user. */
        record_id?: string;
        /** Referenced record unique ID. */
        unique_id?: string;
        /** User id */
        user_id?: string;
    }; // Referenced record ID. If user ID is given, it will fetch records that are uploaded by the user.

    /** Index condition and range cannot be used simultaneously.*/
    index?: {
        /** Not allowed: White space, special characters. Allowed: Periods. */
        name: string | '$updated' | '$uploaded' | '$referenced_count' | '$user_id';
        /** Not allowed: Periods, special characters. Allowed: White space. */
        value: string | number | boolean;
        condition?: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
        range?: string | number | boolean;
    };
    tag?: string;
}

export type DelRecordQuery = {
    unique_id?: string | string[]; // When unique_id is given, it will update the record with the given unique_id. If unique_id is not given, it will create a new record. Unique ID overrides record_id.
    record_id?: string | string[];

    /** Table name not required when "record_id" is given. If string is given, "table.name" will be set with default settings. */
    table?: {
        /** Not allowed: Special characters. Allowed: White space. periods.*/
        name: string;
        /** Number range: 0 ~ 99. Default: 'public' */
        access_group?: number | 'private' | 'public' | 'authorized';
        subscription?: boolean;
    } | string;

    reference?: string; // Referenced record ID. If user ID is given, it will fetch records that are uploaded by the user.

    /** Index condition and range cannot be used simultaneously.*/
    index?: {
        /** Not allowed: White space, special characters. Allowed: Periods. */
        name: string | '$updated' | '$uploaded' | '$referenced_count' | '$user_id';
        /** Not allowed: Periods, special characters. Allowed: White space. */
        value: string | number | boolean;
        condition?: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!=';
        range?: string | number | boolean;
    };
    tag?: string;
}

export type PostRecordConfig = {
    record_id?: string; // when record_id is given, it will update the record with the given record_id. If record_id is not given, it will create a new record.
    unique_id?: string; // You can set unique_id to the record with the given unique_id.
    readonly?: boolean; // When true, record cannot be updated or deleted.

    /** Table name not required when "record_id" is given. If string is given, "table.name" will be set with default settings. */
    table?: {
        /** Not allowed: Special characters. Allowed: White space. periods.*/
        name?: string;
        /** Number range: 0 ~ 99. Default: 'public' */
        access_group?: number | 'private' | 'public' | 'authorized';
        // subscription_group?: number;
        /** When true, Record will be only accessible for subscribed users. */
        subscription?: boolean;
    };

    /** If record ID string is given, "reference.record_id" will be set with default parameters. */
    reference?: {
        unique_id?: string; // null removes reference. When unique_id is given, it will override record_id.
        record_id?: string; // null removes reference
        reference_limit?: number | null; // Default: null (Infinite)
        allow_multiple_reference?: boolean; // Default: true
        can_remove_reference?: boolean; // Default: false. When true, owner of the record can remove any record that are referencing this record and when deleted, all the record referencing this record will be deleted.
    } | string;

    /** null removes index */
    index?: {
        /** Not allowed: White space, special characters. Allowed: Periods. */
        name: string;
        /** Not allowed: Periods, special characters. Allowed: White space. */
        value: string | number | boolean;
    } | null;

    tags?: string[];

    remove_bin?: BinaryFile[] | string[]; // Removes bin data from the record.
}

export type BinaryFile = {
    access_group: number | 'private' | 'public' | 'authorized';
    filename: string;
    url: string;
    path: string;
    size: number;
    uploaded: number;
    getFile: (dataType?: 'base64' | 'endpoint' | 'blob', progress?: ProgressCallback) => Promise<Blob | string | void>;
}

export type RecordData = {
    service: string;
    unique_id?: string;
    record_id: string;
    /** Uploader's user ID. */
    user_id: string;
    updated: number;
    uploaded: number;
    table: {
        name: string;
        /** Number range: 0 ~ 99 */
        access_group: 'private' | 'public' | 'authorized' | number;
        subscription: boolean;
    },
    reference: {
        record_id?: string;
        reference_limit: number;
        allow_multiple_reference: boolean;
        referenced_count: number;
        can_remove_reference: boolean;
    },
    index?: {
        name: string;
        value: string | number | boolean;
    },
    data?: Record<string, any>;
    tags?: string[];
    bin?: { [key: string]: BinaryFile | BinaryFile[] };
    ip: string;
    readonly: boolean;
};

export type Connection = {
    /** User's locale */
    locale: string;
    /** Service owner's ID */
    // owner: string;
    /** E-Mail address of the service owner */
    // email: string;
    /** Service ID */
    // service: string;
    /** Service region */
    // region: string;
    /** 13 digits timestamp of the service creation */
    // timestamp: number;
    /** User agent info */
    user_agent: string;
    /** Connected user's IP address */
    ip: string;
    /** Service level */
    group: number;
    /** Service name */
    service_name: string;
    /** Service options */
    opt: {
        freeze_database: boolean;
        prevent_inquiry: boolean;
        prevent_signup: boolean;
    }
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

export type UserProfilePublicSettings = {
    /** User's E-Mail is public when true. E-Mail should be verified. */
    email_public?: boolean;
    /** User's phone number is public when true. Phone number should be verified. */
    phone_number_public?: boolean;
    /** User's address is public when true. */
    address_public?: boolean;
    /** User's gender is public when true. */
    gender_public?: boolean;
    /** User's birthdate is public when true. */
    birthdate_public?: boolean;
}

export type UserAttributes = {
    /** User's name */
    name?: string;
    /**
     * User's E-Mail for signin.<br>
     * 64 character max.<br>
     * When E-Mail is changed, E-Mail verified state will be changed to false.
     * E-Mail is only visible to others when set to public.
     * E-Mail should be verified to set to public.
     * */
    email?: string;
    /**
     * User's phone number. Format: "+0012341234"<br>
     * When phone number is changed, phone number verified state will be changed to false.
     * Phone number is only visible to others when set to public.
     * Phone number should be verified to set to public.
     */
    phone_number?: string;
    /** User's address, only visible to others when set to public. */
    address?: string | {
        /**
         * Full mailing address, formatted for display or use on a mailing label. This field MAY contain multiple lines, separated by newlines. Newlines can be represented either as a carriage return/line feed pair ("\r\n") or as a single line feed character ("\n").
         * street_address
         * Full street address component, which MAY include house number, street name, Post Office Box, and multi-line extended street address information. This field MAY contain multiple lines, separated by newlines. Newlines can be represented either as a carriage return/line feed pair ("\r\n") or as a single line feed character ("\n").
        */
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
     * User's gender. Can be "female" and "male".
     * Other values may be used when neither of the defined values are applicable.
     * Only visible to others when set to public.
     */
    gender?: string;
    /** User's birthdate. String format: "1969-07-16", only visible to others when set to public.*/
    birthdate?: string;

    /** Additional string value that can be used freely. This is only accessible to the owner of the account and the admins. */
    misc?: string;
    picture?: string;
    profile?: string;
    website?: string;
    nickname?: string;
};

export type UserProfile = {
    /** Service id of the user account. */
    service: string;
    /** User ID of the service owner. */
    owner: string;
    /** Access level of the user's account. */
    access_group: number;
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
} & UserAttributes & UserProfilePublicSettings;

export type PublicUser = {
    /** Service id of the user account. */
    service: string;
    /** User ID of the service owner. */
    owner: string;
    /** Access level of the user's account. */
    access_group: number;
    /** User's ID. */
    user_id: string;
    /** Country code of where user first signed up from. */
    locale: string;
    /** Number of the user's subscribers. */
    subscribers?: number;
    /** Number of the records the user have created. */
    records?: number;
    /** Timestamp of user last signup time. */
    timestamp: number;
} & UserAttributes;

export type ProgressCallback = (e: {
    status: 'upload' | 'download';
    progress: number;
    loaded: number;
    total: number;
    currentFile?: File, // Only for uploadFiles()
    completed?: File[]; // Only for uploadFiles()
    failed?: File[]; // Only for uploadFiles()
    abort: () => void; // Aborts current data transfer. When abort is triggered during the FileList is on trasmit, it will continue to next file.
}) => void;

export type FetchOptions = {
    /** Maximum number of records to fetch per call */
    limit?: number;
    /** Fetch next batch of data. Will return empty list if there is nothing more to fetch. */
    fetchMore?: boolean;
    /** Result in ascending order if true, decending when false. */
    ascending?: boolean;
    /** Start key to be used to query from the certain batch of fetch. */
    startKey?: { [key: string]: any; };
    /** Callback for database request progress. Useful when building progress bar. */
    progress?: ProgressCallback;
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
        url: string;
        subject: string;
    };
    /** E-Mail template for verification code E-Mail. This can be changed by trigger E-Mail. */
    template_verification: {
        url: string;
        sms: string;
        subject: string;
    };
    /** E-Mail template for welcome E-Mail that user receives after signup process. This can be changed by trigger E-Mail. */
    template_welcome: {
        url: string;
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

export type FileInfo = {
    url: string;
    filename: string;
    access_group: number | 'private' | 'public' | 'authorized';
    filesize: number;
    record_id: string;
    uploader: string;
    uploaded: number;
    fileKey: string;
}