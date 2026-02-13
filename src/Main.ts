import './polyfills/global';
import Skapi from "./main/skapi";
import SkapiError from "./main/error";
import * as Types from "./Types";

export { Skapi, SkapiError, Types };

// Re-export all types for direct import
export type {
    ConnectionInfo,
    Condition,
    RTCReceiverParams,
    RTCConnectorParams,
    RTCConnector,
    RTCResolved,
    RTCEvent,
    WebSocketMessage,
    RealtimeCallback,
    DelRecordQuery,
    GetRecordQuery,
    PostRecordConfig,
    BinaryFile,
    RecordData,
    Connection,
    Form,
    Newsletters,
    UserProfilePublicSettings,
    UserAttributes,
    UserProfile,
    UserPublic,
    ProgressCallback,
    FetchOptions,
    DatabaseResponse,
    FileInfo
} from "./Types";