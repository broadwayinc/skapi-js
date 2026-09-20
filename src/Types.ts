export type Condition = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | '>' | '>=' | '<' | '<=' | '=';


export type RTCReceiverParams = {
    ice?: string;
    media?: {
        video: boolean;
        audio: boolean;
    } | MediaStream | MediaStreamConstraints;
}

export type RTCConnectorParams = {
    cid: string;
    ice?: string;
    media?: {
        video: boolean;
        audio: boolean;
    } | MediaStream | MediaStreamConstraints;
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

export type RTCEvent = {
    type: 'track' | 'connectionstatechange' | 'close' | 'message' | 'open' | 'bufferedamountlow' | 'error' | 'icecandidate' | 'icecandidateend' | 'icegatheringstatechange' | 'negotiationneeded' | 'signalingstatechange';
    [key: string]: any;
}

export type WebSocketMessage = {
    type: 'message' | 'error' | 'success' | 'close' | 'notice' | 'private' | 'reconnect' | 'rtc:incoming' | 'rtc:closed';
    message?: any;
    connectRTC?: (params: RTCReceiverParams, callback: (e: RTCEvent) => void) => Promise<RTCResolved>;
    hangup?: () => void; // Reject incoming RTC connection.
    sender?: string; // user_id of the sender
    sender_cid?: string; // scid of the sender
    sender_rid?: string; // group of the sender
    code?: 'USER_LEFT' | 'USER_DISCONNECTED' | 'USER_JOINED' | null; // code for notice messeges
}

export type RealtimeCallback = (rt: WebSocketMessage) => void;

export type DelRecordQuery = GetRecordQuery & {
    unique_id?: string;
    record_id?: string;
};

export type GetRecordQuery = {
    unique_id?: string; // When unique_id is given, it will fetch the record with the given unique_id.
    record_id?: string; // When record_id is given, it will fetch the record with the given record_id. This overrides all other parameters.

    /** Table name not required when "record_id" is given. A bare string is shorthand for { name: <string> }. */
    table?: string | {
        /** Max 256 characters, where / ! * # % each count as 3. Blocks control chars and sentinel 􏿿. */
        name: string;
        /** Number range: 0 ~ 99. 'public' = 0, 'authorized' = 1, 'admin' = 99. '*' is shorthand for 'private'. Default: 'public' */
        access_group?: number | 'private' | '*' | 'public' | 'authorized' | 'admin';
        /** User ID of subscription */
        subscription?: string;
    };

    reference?: string | { record_id?: string; unique_id?: string; user_id?: string } // Referenced record ID or unique ID (string), or the object form. If user ID is given, it will fetch records that are uploaded by the user.

    /** Index condition and range cannot be used simultaneously.*/
    index?: {
        /** Custom names: max 256 characters, where / ! * # % each count as 3. Cannot start with "$". Blocks control chars and sentinel 􏿿. Reserved names: $uploaded, $updated, $referenced_count, $user_id. */
        name: string | '$updated' | '$uploaded' | '$referenced_count' | '$user_id';
        /** String value max 256 characters. Any punctuation is allowed and counts as one character, and values compare exactly as written. Blocks control chars and sentinel 􏿿. */
        value: string | number | boolean;
        /** For a string value: '>=' = 'starts with', '<=' = 'ends with'. When the name is a compound name ending in '.', '>=' / '<=' match the child name segment (starts / ends with). '>' / '<' are lexicographic; numbers/booleans compare normally. */
        condition?: Condition;
        range?: string | number | boolean;
    };
    tag?: string;
}

export type PostRecordConfig = {
    record_id?: string; // when record_id is given, it will update the record with the given record_id. If record_id is not given, it will create a new record. If unique ID is given as a record ID, it will update the record with the given unique ID. 
    unique_id?: string | null; // You can set unique_id to the record with the given unique_id. Null will remove unique_id from the record.
    readonly?: boolean; // When true, record cannot be updated or deleted.

    /** Table name not required when "record_id" is given.*/
    table?: {
        /** Max 256 characters, where / ! * # % each count as 3. Blocks control chars and sentinel 􏿿. */
        name?: string;
        /** Number range: 0 ~ 99. 'public' = 0, 'authorized' = 1, 'admin' = 99. '*' is shorthand for 'private'. Default: 'public' */
        access_group?: number | 'private' | '*' | 'public' | 'authorized' | 'admin';

        /** When true, Record will be only accessible for subscribed users. */
        subscription?: {
            is_subscription_record?: boolean; // When true, this record is a subscription record.
            upload_to_feed?: boolean; // When true, record will be uploaded to the feed of the subscribers.
            notify_subscribers?: boolean; // When true, subscribers will receive notification when the record is uploaded.
            feed_referencing_records?: boolean; // When true, records referencing this record will be included to the subscribers feed.
            notify_referencing_records?: boolean; // When true, records referencing this record will be notified to subscribers.
        } | null; // When null, it will remove all subscription settings from the record.
    };

    source?: {
        referencing_limit?: number; // Default: null (Infinite)
        prevent_multiple_referencing?: boolean; // If true, a single user can reference this record only once.
        can_remove_referencing_records?: boolean; // When true, owner of the record can remove any record that are referencing this record. Also when this record is deleted, all the record referencing this record will be deleted.
        only_granted_can_reference?: boolean; // When true, only the user who has granted private access to the record can reference this record.
        /** Index restrictions for referencing records. null removes all restrictions. */
        referencing_index_restrictions?: {
            /** Not allowed: White space, special characters. Allowed: Alphanumeric, Periods. */
            name: string; // Allowed index name
            /** Not allowed: Periods, special characters. Allowed: Alphanumeric, White space. */
            value?: string | number | boolean; // Allowed index value
            range?: string | number | boolean; // Allowed index range
            condition?: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!='; // Allowed index value condition
        }[] | null;
        allow_granted_to_grant_others?: boolean; // When true, the user who has granted private access to the record can grant access to other users.
    };

    /** Can be record ID or unique ID */
    reference?: string | null; // When null, it will remove reference from the record.

    /** null removes index */
    index?: {
        /** Max 256 characters, where / ! * # % each count as 3. Cannot start with "$". Blocks control chars and sentinel 􏿿. */
        name: string;
        /** String value max 256 characters. Any punctuation is allowed and counts as one character, and values compare exactly as written. Blocks control chars and sentinel 􏿿. */
        value: string | number | boolean;
    } | null;

    tags?: string[] | null; // null removes all tags. each tag 1..256 characters, where / ! * # % each count as 3. Blocks control chars and sentinel 􏿿.
    remove_bin?: BinaryFile[] | string[] | null; // Removes bin data from the record. When null, it will remove all bin data.
    progress?: ProgressCallback; // Callback for database request progress. Useful when building progress bar.
    reference_private_key?: string; // When referencing a record that has private access, you can provide the private key of the referenced record to pass the access check. This is only required when the referenced record has private access and the user does not have access to the record through subscription or granted access.
}

export type BinaryFile = {
    access_group: number | 'private' | 'public' | 'authorized' | 'admin';
    filename: string;
    url: string;
    path: string;
    size: number;
    uploaded: number;
    getFile: (dataType?: 'base64' | 'download' | 'endpoint' | 'blob' | 'text' | 'info', progress?: ProgressCallback) => Promise<Blob | string | void | FileInfo>;
}

/**
 * Per-record encryption outcome. Present ONLY when the record's data went
 * through the client-side encryption layer, so its absence means the record was
 * stored in the clear.
 *
 * status 'encrypted' means the data in this object was decrypted successfully.
 * status 'failed' means `data` is null and `reason` says why:
 *   NO_SESSION_KEY      encryption is locked; call unlockEncryption()
 *   NOT_A_RECIPIENT     this user has no key wrap on the record
 *   BAD_KEY             the wrap did not open (wrong or rotated key)
 *   BINDING_MISMATCH    the envelope does not belong to this record
 *   CORRUPT             the payload failed its authentication tag
 *   UNSUPPORTED_VERSION written by a newer SDK
 *   ENCRYPTION_DISABLED the record is encrypted but this instance is not
 */
export type RecordEncryptionInfo = {
    status: 'encrypted' | 'failed';
    reason?: string;
    /** user_ids that hold a key wrap on this record. */
    recipients?: string[];
};

/** Options for `new Skapi(..., { encryption })`. */
export type EncryptionOptions = boolean | {
    /** PBKDF2 iteration count. Default 600000. Minimum 100000. */
    iterations?: number;
    /** 'tofu' pins a peer's key on first sight (default). 'strict' requires a prior pin. */
    trustPolicy?: 'tofu' | 'strict';
    /** Keep the master key in IndexedDB so a page reload stays unlocked. Default true. */
    persistDevice?: boolean;
    /** Refuse to enroll a password shorter than this. Default 0 (no check). */
    minPasswordLength?: number;
    /**
     * Issue a one-time recovery code at enrollment. Default 'code'.
     * 'none' opts out and accepts that a forgotten password means the user's
     * encrypted records are permanently unreadable.
     */
    recovery?: 'code' | 'none';
    /** Reserved keyring table name. Default '__skapi__keyring'. */
    table?: string;
};

export type RecordData = {
    record_id: string;
    unique_id?: string;
    user_id: string;
    updated: number;
    uploaded: number;
    referenced_count: number;
    /** Set only when the record's data passed through the encryption layer. */
    encrypted?: RecordEncryptionInfo;

    table: {
        name: string;
        /** Number range: 0 ~ 99 */
        access_group: number | 'private' | 'public' | 'authorized' | 'admin';
        /** User ID of subscription */
        subscription?: {
            upload_to_feed: boolean; // When true, record will be uploaded to the feed of the subscribers.
            notify_subscribers: boolean; // When true, subscribers will receive notification when the record is uploaded.
            feed_referencing_records: boolean; // When true, records referencing this record will be included to the subscribers feed.
            notify_referencing_records: boolean; // When true, records referencing this record will be notified to subscribers.
        };
    };
    source: {
        referencing_limit: number; // Default: null (Infinite)
        prevent_multiple_referencing: boolean; // If true, a single user can reference this record only once.
        can_remove_referencing_records: boolean; // When true, owner of the record can remove any record that are referencing this record. Also when this record is deleted, all the record referencing this record will be deleted.
        only_granted_can_reference: boolean; // When true, only the user who has granted private access to the record can reference this record.
        referencing_index_restrictions?: {
            name: string; // Allowed index name
            value?: string | number | boolean; // Allowed index value
            range?: string | number | boolean; // Allowed index range
            condition?: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | '>' | '>=' | '<' | '<=' | '=' | '!='; // Allowed index value condition
        }[];
    };
    reference?: string; // record id of the referenced record.
    index?: {
        name: string;
        value: string | number | boolean;
    };
    data?: Record<string, any>;
    tags?: string[];
    bin: { [key: string]: BinaryFile[] };
    ip: string;
    readonly: boolean;
    /**
     * Present ONLY on an element of a postRecords() result that the backend refused.
     * Such an element is an empty record (record_id is ""), and this carries the reason
     * the backend gave, e.g. { code: 'NOT_EXISTS', message: 'Reference "..." does not exists.' }.
     * A saved record never has it, so `record_id` stays the test for "did this save".
     */
    error?: { code?: string; message?: string;[key: string]: any };
}

export type Connection = {
    /** User's locale */
    locale: string;
    user_agent: string;
    /** Connected user's IP address */
    ip: string;
    /** Service group */
    group: number;
    /** Service name */
    service_name: string;
    /** Service description */
    service_description: string;
    /** Service options */
    opt: {
        freeze_database: boolean;
        prevent_inquiry: boolean;
        prevent_signup: boolean;
        prevent_anonymous: boolean;
        /**
         * BunnyQuery: whether the embeddable chat requires an account before a
         * visitor can use it. Unrelated to `prevent_anonymous`, which governs
         * anonymous record WRITES. Defaults to true.
         */
        require_login?: boolean;
    },
    ai_agent?: string; // AI agent info.
}

export type Form<T> = HTMLFormElement | FormData | SubmitEvent | T;

export type Newsletter = {
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
    /** Number users delivered */
    delivered: number;
    /**
     * Newsletter group the message was sent to.<br>
     * A number for the 0 ~ 99 groups, the group name for a named newsletter group.
     */
    group: number | string;
}

export type NewsletterGroup = {
    /** Name of the newsletter group. */
    group: string;
    /**
     * Access group required to subscribe to the group and to read its sent mail.<br>
     * 0 is anyone, 1 is any signed in user, 2 ~ 99 is that access group.
     */
    restriction: number;
    /** Display label of the group. Empty string when none was set. */
    name: string;
    /** Number of subscribers of the group. */
    subscribers: number;
    /**
     * E-Mail address a newsletter for this group is sent to.<br>
     * Empty string when the service has no sender e-mail set.
     */
    endpoint: string;
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
    /**
    Account approval info and timestamp.
    Comes with string with the following format: "{approver}:{approved | suspended}:{approved_timestamp}"
    
    {approver} is who approved the account:
        [by_master] is when account approval is done manually from skapi admin panel,
        [by_admin] is when approval is done by the admin account with api call within your service.
        [by_skapi] is when account approval is automatically done.
        Open ID logger ID will be the value if the user is logged with openIdLogin()
        This timestamp is generated when the user confirms their signup, or recovers their disabled account.
    
    {approved | suspended}
        [approved] is when the account is approved.
        [suspended] is when the account is blocked by the admin or the master.
    
    {approved_timestamp} is the timestamp when the account is approved or suspended.

     */
    approved: string;
    /** Last login timestamp(Seconds). */
    log: number;
    /** Shows true when user has verified their E-Mail. */
    email_verified?: boolean;
    /** Shows true when user has verified their phone number. */
    phone_number_verified?: boolean;
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

export type UserPublic = {
    /** Access level of the user's account. */
    access_group: number;
    /** User's ID. */
    user_id: string;
    /** Country code of where user first signed up from. */
    locale: string;
    /**
    Account approval info and timestamp.
    Comes with string with the following format: "{approver}:{approved | suspended}:{approved_timestamp}"
    
    {approver} is who approved the account:
        [by_master] is when account approval is done manually from skapi admin panel,
        [by_admin] is when approval is done by the admin account with api call within your service.
        [by_skapi] is when account approval is automatically done.
        Open ID logger ID will be the value if the user is logged with openIdLogin()
        This timestamp is generated when the user confirms their signup, or recovers their disabled account.
    
    {approved | suspended}
        [approved] is when the account is approved.
        [suspended] is when the account is blocked by the admin or the master.
    
    {approved_timestamp} is the timestamp when the account is approved or suspended.

     */
    approved: string;
    /** Account created timestamp(13 digit milliseconds). */
    timestamp: number;
    /** Last login timestamp(Seconds). */
    log: number;
    /** Number of the user's subscribers. */
    subscribers: number;
    /** Number of subscription the user has made */
    subscribed: number;
    /** Number of the records the user have created. */
    records: number;

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

    picture?: string;
    profile?: string;
    website?: string;
    nickname?: string;
};

export type ProgressCallback = (e: {
    status: 'upload' | 'download';
    progress: number; // 0 ~ 100, number of percent completed.
    loaded: number; // Number of bytes loaded.
    total: number; // Total number of bytes to be loaded.
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
}
export type RequestHistory = {
    id: string; // request id. Format: {stamp}:{entropy}
    status_code: number; // http status code of the request
    response_body: any;
    error?: any;
    created: number; // timestamp of when the request was created, in milliseconds. Set once and never changes.
    updated: number; // timestamp of the last update of the request status (e.g. when the response arrived), in milliseconds.
    executed?: number; // timestamp of when the worker actually BEGAN executing the request, in milliseconds. Distinct from `created`, which is when it was enqueued: a request can wait in the queue first, so `updated - executed` is the execution time while `updated - created` also includes the wait. Absent on a request that has not started yet, and on rows written before the worker recorded it.
    request_body: any;
    expires?: number; // timestamp of when the request history will be deleted in epoch time (seconds).
    status: 'pending' | 'running' | 'resolved' | 'failed';
    queue_name?: string; // queue name if the request is in queue, empty string if the request is not in queue.
    // Compact-listing stubs. Present ONLY when the history was fetched with `compact: true`,
    // in which case request_body/response_body are omitted (the full bodies never leave the
    // server); re-fetch without `compact`, or poll the item, when a full body is needed.
    request_text?: string; // stub: first text of the request's LAST user message, truncated. Missing when the request body's shape was unrecognisable.
    response_text?: string; // stub: the head of the response text, truncated.
    response_complete_marker?: boolean; // stub: whether the response carried the indexing completion marker.
    compact?: boolean; // true on items returned by a `compact: true` listing, so consumers know bodies were deliberately omitted rather than empty.
    poll?: (arg?: {
        latency?: number;
        onResponse?: (res:any, meta?: { executed?: number })=>void; // meta.executed is when the worker BEGAN executing the request, in milliseconds, when a running poll tick reported it. "res" is the destination's own answer and carries nothing of skapi's, so request-level facts arrive here instead. Absent for a request that began and ended between two ticks; the same value is on the history item as "executed".
        onError?: (err:any)=>void;
        onStream?: (chunk: string, seq: number)=>void;
    }) => Promise<any>; // function to poll the request status until it settles. The promise resolves with the final result of the request: the third-party API response body when it resolves, or the error payload when it fails. It does not resolve with a RequestHistory item, so "created" and "updated" are not on the polled value. A poll stopped by stopForwardRequestPolling() (or its deprecated alias stopClientSecretPolling()) resolves with { id, status: 'stopped' }. Optional argument "latency" can be used to set the latency of the polling in milliseconds. Default latency is 1000ms.
}

export type DatabaseResponse<T> = {
    list: T[];
    startKey: { [key: string]: any; } | 'end';
    endOfList: boolean;
    startKeyHistory: string[];
}

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

export type ConnectionInfo = {
    /** Public project ID (service + owner composed into the two-segment token). Empty when the service has no uuid owner. */
    project_id: string;
    user_ip: string;
    user_agent: string;
    user_location: string;
    service_name: string;
    service_description: string;
    version: string;
    ai_agent: string;
    conf: {
        freeze_database: boolean;
        prevent_signup: boolean;
        prevent_inquiry: boolean;
        prevent_anonymous: boolean;
        /**
         * BunnyQuery: whether the embeddable chat requires an account before a
         * visitor can use it. Unrelated to `prevent_anonymous`, which governs
         * anonymous record WRITES. Defaults to true.
         */
        require_login?: boolean;
    }
};

export type Table = {
    table: string;
    number_of_records: string;
    size: number;
    number_of_records_in_access_group_public?: number;
    number_of_records_in_access_group_private?: number;
    number_of_records_in_access_group_authorized?: number;
    number_of_records_in_access_group_admin?: number;
    [number_of_records_in_access_group_xx: string]: number | string | undefined; // for other access groups
}

export type Index = {
    table: string;
    index: string;
    number_of_records: number;
    string_count: number;
    number_count: number;
    boolean_count: number;
    total_number: number;
    total_bool: number;
    average_number: number;
    average_bool: number;
}

export type Tag = {
    table: string;
    tag: string;
    number_of_records: number;
}

export type UniqueId = {
    unique_id: string;
    record_id: string;
}

export type Subscription = {
    subscriber: string;
    subscription: string;
    timestamp: number;
    blocked: boolean;
    get_feed: boolean;
    get_notified: boolean;
    get_email: boolean;
}

/** Comparison operator of a ticket condition row. The word forms are normalized to the symbols on registration. For a string value, '>=' means "starts with". */
export type TicketConditionOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

/**
 * One row of a ticket condition list (`headers`, `data`, `params`, `user`, `match`).
 * Rows with the same key are alternatives (any one matching satisfies the key), rows with
 * different keys must all match. A comparison between incompatible types is a mismatch.
 */
export type TicketConditionRow = {
    /**
     * `data` and `params` rows: a path into the request, such as "data[object][id]" (the leading
     * "data" there is the request's own key, not the row list). `headers` rows: the header name,
     * matched case-insensitively. `user` rows: the consumer attribute name. Never templated.
     */
    key: string;
    /** Absent, with no `value`, on a capture-only row: it never fails and only fills `placeholder`. */
    operator?: TicketConditionOperator;
    /** A literal, never templated. A list passes when any member matches. */
    value?: any;
    /** `data` and `params` rows only. When the row matches, the value at `key` in the request data is replaced by this before anything else reads it. */
    setValueWhenMatch?: any;
    /** `data` and `params` rows only. Remembers the value at `key` under this name for the actions ("placeholder[NAME]"). Must match ^[A-Za-z_][A-Za-z0-9_]*$. */
    placeholder?: string;
}

/** An HTTP call whose response must match. `url`, `headers`, `data` and `params` are templated like an action's `exe`; `match` rows are not. */
export type TicketRequestCondition = {
    /** http:// or https:// with a hostname. No IP literal, no userinfo, never under the api domain. */
    url: string;
    method?: 'GET' | 'POST';
    headers?: { [name: string]: string };
    /** Sent as JSON when a content-type header says application/json, else form encoded. */
    data?: any;
    params?: { [key: string]: any };
    /** Rows matched against the response body. */
    match?: TicketConditionRow[];
}

/**
 * An HMAC signature over the request, computed with a secret shared with the sender. Verified
 * before anything else runs: the `timestamp` (when set) must be an integer within `tolerance` of
 * now, the bytes described by `signed` are signed with the stored secret (`secret_prefix` removed,
 * then decoded per `secret_encoding`), and the result is compared in constant time against every
 * `${signature}` captured from the header. Any failure is a plain mismatch.
 *
 * Templates (`signed`, `timestamp`) are literal text with these tokens: `${body}` (the raw request
 * body exactly as received), `${method}` (the HTTP method, upper case), `${header:Name}` (a request
 * header, case-insensitive; an absent header fails verification) and any capture from `parts` other
 * than `${signature}`. An unknown token is refused at registration.
 *
 * Public-key signature schemes (RSA, ECDSA, Ed25519) are not supported.
 */
export type TicketSignatureCondition = {
    /** The name of a Secret Key of the project, never the secret itself. Must exist at registration. */
    secret: string;
    /** The request header carrying the signature. Case-insensitive. Up to 256 characters. */
    header: string;
    /** Default 'sha256'. */
    algorithm?: 'sha256' | 'sha1' | 'sha512';
    /** How the signature value in the header is encoded. Default 'hex'. */
    encoding?: 'hex' | 'base64';
    /** Splits the header value into items, each trimmed. 1 to 8 characters. Absent: the whole header value is one item. */
    separator?: string;
    /**
     * Patterns matched against each header item, in order; the first whose literal text fits
     * captures the rest. Each pattern is literal text with at most one `${name}` capture (letters,
     * digits and _; not `body` or `method`). `${signature}` may be captured by several items (any one matching passes) and
     * must appear in at least one pattern; any other name becomes a token for the templates (the
     * first capture wins). Items that match no pattern are ignored. Up to 10 patterns of up to 256
     * characters each. Default ["${signature}"].
     */
    parts?: string[];
    /** Template of the signed bytes. Up to 512 characters. Default "${body}". */
    signed?: string;
    /** Template resolving to unix time, in seconds or in milliseconds (a value above 10^12). Up to 512 characters. Absent: no timestamp check. */
    timestamp?: string;
    /** Seconds the timestamp may be away from now, 1 to 86400. Only used with `timestamp`. Default 300. */
    tolerance?: number;
    /** How the stored secret becomes the HMAC key bytes. Default 'raw'. */
    secret_encoding?: 'raw' | 'base64' | 'hex';
    /** Removed from the start of the stored secret before decoding. Up to 64 characters. */
    secret_prefix?: string;
}

/** What a consumption request must look like before the ticket's actions run. Evaluated in the order the keys are listed here; the first failure is the reported one. */
export type TicketCondition = {
    /** Answer HTTP 200 even when the consumption fails. For webhooks that retry on errors. */
    return200?: boolean;
    /** Absent = both allowed. */
    method?: 'GET' | 'POST';
    /** Verified first, over the raw request body. See TicketSignatureCondition. */
    signature?: TicketSignatureCondition;
    ip?: { operator: TicketConditionOperator; value: string | string[] };
    user_agent?: { operator: TicketConditionOperator; value: string | string[] };
    headers?: TicketConditionRow[];
    /** Rows against the POST body. On a GET the body root is {}. */
    data?: TicketConditionRow[];
    /** Rows against the GET query string. On a POST the query root is {}. */
    params?: TicketConditionRow[];
    /** Rows against the consumer's attributes (user_id, email, access_group, ...). Signed-in consumption only. */
    user?: TicketConditionRow[];
    /** Record ID the consumer must own or have been granted. Signed-in consumption only. */
    record_access?: string;
    request?: TicketRequestCondition;
}

/** The subset of a condition a `req` action can evaluate against its response. A response has no method, query string or status policy. */
export type TicketResponseCondition = Pick<TicketCondition, 'headers' | 'data' | 'user' | 'record_access' | 'request'>;

/**
 * One step of a ticket's action chain. Actions run in order; each one's result is readable by
 * the next as "result[...]". `exe` is templated right before the action runs: a string that is
 * a whole path ("data[object][id]", "placeholder[NAME]") keeps the value's type, "${...}" inside
 * text becomes a string, bare words are literal. When an action fails its `err` chain runs
 * (with "error[code]", "error[message]", ...) and the consumption stops. Nothing is rolled back.
 */
export type TicketAction =
    | {
        /** Update a Skapi service. Internal: registration refuses it unless the caller is a Skapi super master. */
        act: 'srvc';
        exe: { [key: string]: any };
        err?: TicketAction[];
    }
    | {
        /** Set the access group of a user. */
        act: 'acsg';
        exe: {
            /** 1 ~ 99, or "admin". */
            group: number | 'admin';
            /** Blank = the consumer (signed-in consumption only). The project owner cannot be a target. */
            user_id?: string;
        };
        err?: TicketAction[];
    }
    | {
        /** Grant private access to a record. */
        act: 'acsr';
        exe: {
            /** A record ID, not a unique ID. */
            record_id: string;
            /** Blank = the consumer. */
            user_id?: string | string[];
        };
        err?: TicketAction[];
    }
    | {
        /** Post a record. Everything but `user_id` is the payload postRecord() sends, so the same rules apply. A `unique_id` makes a retried webhook update the same record instead of adding one. */
        act: 'pstr';
        exe: {
            table: string | {
                name: string;
                access_group?: number | 'public' | 'authorized' | 'admin' | 'private';
                subscription?: NonNullable<PostRecordConfig['table']>['subscription'];
            };
            data?: any;
            index?: { name: string; value: string | number | boolean };
            tags?: string[];
            unique_id?: string;
            /** Update instead of create. */
            record_id?: string;
            reference?: string;
            readonly?: boolean;
            source?: PostRecordConfig['source'];
            /** Post as this user instead of the project owner. */
            user_id?: string;
        };
        err?: TicketAction[];
    }
    | {
        /** HTTP request with its own response condition and nested chain. Result: the parsed response body. */
        act: 'req';
        exe: {
            /** http:// or https:// with a hostname. No IP literal, no userinfo, never under the api domain. Redirects are not followed. */
            url: string;
            /** Default GET. */
            method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
            headers?: { [name: string]: string };
            /** POST and PUT body. Sent as JSON when a content-type header says application/json, else form encoded. */
            data?: any;
            /** Query string. */
            params?: { [key: string]: any };
            /** Legacy. Rows matched against the response body like `condition.data`. */
            match?: TicketConditionRow[];
            /** Evaluated against the response. Captures land in the shared placeholder pool. */
            condition?: TicketResponseCondition;
            /** Nested chain. Its paths read the response body. */
            actions?: TicketAction[];
        };
        err?: TicketAction[];
    };

/** An issued ticket as getTickets() and registerTicket() return it. */
export type Ticket = {
    ticket_id: string;
    description?: string;
    /** Remaining consumptions. Absent = unlimited. */
    count?: number;
    /** Absolute expiry in ms since epoch. Absent = never. */
    time_to_live?: number;
    /** true = once per user, n = n times. Absent or 0 = unlimited. Only enforced for signed-in consumers. */
    limit_per_user?: boolean | number;
    /** Created at (ms). */
    timestamp: number;
    /** Last registered at (ms). */
    updated?: number;
    condition?: TicketCondition;
    actions?: TicketAction[];
}

export type TicketErrorCode =
    | 'INVALID_SERVICE'
    | 'SERVICE_DISABLED'
    | 'TICKET_NOT_FOUND'
    | 'TICKET_EXPIRED'
    | 'TICKET_EXHAUSTED'
    | 'USER_LIMIT_REACHED'
    | 'ISSUER_CANNOT_CONSUME'
    | 'AUTH_REQUIRED'
    | 'METHOD_NOT_ALLOWED'
    | 'CONDITION_FAILED'
    | 'PATH_NOT_FOUND'
    | 'PLACEHOLDER_MISSING'
    | 'REQUEST_FAILED'
    | 'TIMEOUT'
    | 'ACTION_FAILED'
    | 'ACTION_FORBIDDEN'
    | 'INTERNAL_ERROR';

/**
 * The body a consume endpoint answers with when the consumption fails, and the `cause` of the
 * SkapiError consumeTicket() rejects with. A success body never has `stage`; an error body
 * always does, also when the ticket answers HTTP 200 (`return200`).
 */
export type TicketError = {
    code: TicketErrorCode;
    /** Human readable, one sentence. */
    message: string;
    stage: 'ticket' | 'condition' | 'action';
    /** Only when stage is "action": the action that failed and its place in the chain, such as "actions[1].err[0]". */
    action?: { act: TicketAction['act']; path: string };
    /** Code specific, JSON safe. For example { expired_at } on TICKET_EXPIRED, { field, keys } on CONDITION_FAILED, { status, body } on REQUEST_FAILED. */
    detail?: { [key: string]: any };
    ticket_id: string;
}