import { SkapiError } from "../Main";
import { RTCResolved, RTCEvent, RTCConnectorParams, RTCReceiverParams, WebSocketMessage, RTCConnector, RTCEncodingOption, RTCChannelOption, RTCShareOptions, RTCMediaSource, RTCFileInfo, RTCSendFileOptions } from "../Types";
import { extractFormData } from "../utils/utils";
import validator from "../utils/validator";
import { requestIceServers, peekIceServers } from "./realtime";

export const __peerConnection: { [sender: string]: RTCPeerConnection } = {};
export const __dataChannel: { [sender: string]: { [label: string]: RTCDataChannel } } = {};
export const __caller_ringing: { [recipient: string]: (v: any) => void } = {};
export const __receiver_ringing: { [caller: string]: string } = {};
export const __rtcEvents: { [sender: string]: (v: any) => void } = {};

/**
 * What the SDK keeps per connection besides the RTCPeerConnection: the local tracks and what
 * each one is, the negotiation flags, the call's meta. One entry per connection id, made with
 * the connection and dropped by closeRTC(), so two calls at once never share a stream and
 * hanging one up never stops the other's tracks.
 */
type PeerState = {
    polite: boolean; // the answering side: when both sides offer at once it drops its own offer and answers the other
    makingOffer: boolean;
    ignoreOffer: boolean;
    armed: boolean; // renegotiation is on (after the first offer or answer went out)
    meta: Record<string, any>;
    media: MediaStream; // every local track on the call; what RTCResolved.media returns
    user: MediaStream | null; // the stream the camera and microphone are sent as
    sources: Map<MediaStreamTrack, string>; // what each local track is: camera, microphone, screen, custom, or a name from share()
    wires: Map<MediaStreamTrack, MediaStream>; // the stream each local track was added to the connection with
    cleanup: Map<MediaStreamTrack, () => void>;
    remoteSources: { [mid: string]: string }; // what the other side says its tracks are, by transceiver mid
    encoding: RTCEncodingOption | null;
    receive: { audio?: boolean; video?: boolean } | null; // the answering side's `receive`, applied once the offer is set: a transceiver made before that would not be matched with the offer's
    callId: string | null; // the call's name in every signal, the same on both sides: a signal from a connection id this side has never seen still finds its call
    peerCid: string; // the other side's connection id as of its last signal, where this side's signals go; the key of this entry until its socket reconnected and the server gave it another
    recovery: Recovery | null; // set while the connection is down and being brought back
    ringTimer: any;
    fileIn: FileIn | null; // the file arriving right now (the other side sends one at a time)
    fileQueue: Promise<any>; // this side's sends, one after another
    fileAcks: Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>; // sends waiting for the other side's receipt
    fileChannelWaiters: Array<{ resolve: (c: RTCDataChannel) => void; reject: (e: any) => void }>;
};

type FileIn = { id: string; name: string; size: number; mime: string; received: number; reported: number; chunks: ArrayBuffer[] };

/**
 * A connection that dropped is not closed: the browser often brings it back by itself within a
 * few seconds, and when it does not, an ICE restart finds a new path (a phone that moved from
 * Wi-Fi to mobile data, a router that changed the port). `restarts` counts the restarts sent;
 * `wait` is the pause before the first one; `deadline` ends the call when nothing helped.
 */
type Recovery = { restarts: number; wait: any; deadline: any };

const RECOVERY_WAIT = 3000; // 'disconnected' is often momentary: this long before the first ICE restart
const RECOVERY_RESTARTS = 2; // ICE restarts before 'failed' ends the call
const RECOVERY_DEADLINE = 15000; // without 'connected' this long after the drop, the call is lost

export const __peerState: { [cid: string]: PeerState } = {};

/**
 * Connection ids that stand for a call keyed under another one. A call is keyed by the other
 * side's connection id when it started. When that side's realtime socket reconnects, the server
 * gives it a new id, and its signals arrive from that id; the call itself goes on (the media and
 * data channels run between the browsers, not through the socket). The new id is aliased to the
 * key, so the app's handle, the events and closeRTC() keep working under the old one.
 */
const __cidAlias: { [cid: string]: string } = {};

export function resolveKey(cid: string): string {
    return __cidAlias[cid] || cid;
}

function callOwner(callId: string): string | null {
    for (const key in __peerState) {
        if (__peerState[key].callId === callId) {
            return key;
        }
    }
    return null;
}

function newCallId(): string {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** The other side now signals from another connection id. Remembered, so this side's signals reach it, and told to the app. */
function rebindPeer(key: string, cid: string) {
    const st = __peerState[key];
    if (!st || st.peerCid === cid) {
        return;
    }
    const previous = st.peerCid;
    if (__cidAlias[previous] === key) {
        delete __cidAlias[previous];
    }
    st.peerCid = cid;
    if (cid !== key) {
        __cidAlias[cid] = key;
    }
    this.log('rtc cidchange', `"${key}" now signals from "${cid}".`);
    const cb = __rtcEvents[key];
    if (cb) {
        cb({ type: 'cidchange', target: __peerConnection[key], timestamp: now(), cid, previous });
    }
}

/**
 * Which call a signal belongs to: the key of its entry here. The sender's connection id, unless
 * the signal names its call and that call is keyed under an earlier id of the sender (its socket
 * reconnected): then the new id is aliased to the key, and this side's signals go to it from now on.
 */
export function signalKey(senderCid: string, content: any): string {
    if (content && typeof content.call === 'string' && content.call) {
        const owner = callOwner(content.call);
        if (owner) {
            if (owner !== senderCid) {
                rebindPeer.call(this, owner, senderCid);
            }
            return owner;
        }
        return senderCid;
    }
    return resolveKey(senderCid);
}

const __signalChain: { [cid: string]: Promise<any> } = {};

/**
 * Runs the signaling steps of one connection one after another, in the order the messages
 * arrived. Applied at once, an answer still being set when the next offer comes in makes that
 * offer look like a collision, and the caller's side drops it; the other side then waits for
 * an answer that never comes.
 */
export function queueSignal(cid: string, step: () => Promise<any>): Promise<any> {
    const run = (__signalChain[cid] || Promise.resolve()).then(step, step);
    __signalChain[cid] = run.catch(() => { });
    return run;
}

let __rtcCandidatesBuffer: { [sender: string]: any[] } = {};
let __rtcSdpOfferBuffer: { [sender: string]: any[] } = {};

function setBuffer(buffer: { [recipient: string]: any[] }, recipient: string, item: any) {
    if (!buffer[recipient]) {
        buffer[recipient] = [];
    }
    buffer[recipient].push(item);
}

async function processBuffer(buffer: { [recipient: string]: any[] }, recipient: string, fn: (item: any) => any): Promise<any[]> {
    let proceed = [];
    if (buffer[recipient]) {
        let items = buffer[recipient];
        delete buffer[recipient];
        for (let v of items) {
            if (v) {
                let process = fn(v);
                if (process instanceof Promise) {
                    process = await process;
                }
                proceed.push(process);
            }
        }
    }
    return proceed;
}

const DEFAULT_ICE = 'stun:stun.skapi.com:3468';
const CONTENT_HINTS = ['text', 'detail', 'motion'];
/**
 * Files go over a channel of their own that the SDK opens when the first file is sent: ordered
 * and reliable, 16 KiB chunks, the sender pausing while the connection's buffer is full. On the
 * wire: a text header, the bytes, a text end mark, and a text receipt back from the other side.
 */
const FILE_CHANNEL = 'skapi-file';
const FILE_CHUNK = 16 * 1024;
const FILE_HIGH_WATER = 1024 * 1024;
const FILE_LOW_WATER = 256 * 1024;
const FILE_PROGRESS_EVERY = 256 * 1024;

const CHANNEL_PRESETS: { [name: string]: RTCDataChannelInit } = {
    'text-chat': { ordered: true, maxRetransmits: 10, protocol: 'text-chat' },
    'file-transfer': { ordered: false, maxPacketLifeTime: 3000, protocol: 'file-transfer' },
    'video-chat': { ordered: true, maxRetransmits: 10, protocol: 'video-chat' },
    'voice-chat': { ordered: true, maxRetransmits: 10, protocol: 'voice-chat' },
    'gaming': { ordered: false, maxPacketLifeTime: 100, protocol: 'gaming' },
    'default': { ordered: true, maxRetransmits: 10, protocol: 'default' },
};

function invalid(message: string): SkapiError {
    return new SkapiError(message, { code: 'INVALID_PARAMETER' });
}

function isPlainObject(v: any): boolean {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasMediaStream(): boolean {
    return typeof MediaStream !== 'undefined';
}

function now(): string {
    return new Date().toISOString();
}

/**
 * The ICE servers for a call that gave no `ice`: Skapi's STUN server plus the TURN relay with a
 * credential for this user, from the realtime server. Without an answer (older backend, no relay
 * configured for the region) it is the STUN server alone, as before the relay existed. A relay
 * is what connects two peers whose networks allow no direct path; STUN cannot.
 */
async function defaultIceServers(): Promise<RTCIceServer[]> {
    let cached = peekIceServers();
    if (!cached) {
        try {
            cached = await requestIceServers.bind(this)();
        } catch (err) {
            cached = null;
        }
    }
    let servers = cached ? cached.servers : [{ urls: DEFAULT_ICE }];
    return servers.some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => /^stuns?:/.test(u))) ? servers : [{ urls: DEFAULT_ICE }, ...servers];
}

/**
 * The ICE servers the browser is given. `ice` is one url (the default, Skapi's STUN server, when
 * omitted), or a list of RTCIceServer objects: { urls, username?, credential? }. A list is how a
 * TURN relay is added, since a relay needs a login; keep a STUN entry in the list so the browser
 * still connects directly whenever it can, and relays only when it must.
 */
function iceServers(ice: any): RTCIceServer[] {
    if (ice === undefined || ice === null || ice === '') {
        return [{ urls: DEFAULT_ICE }];
    }
    const validUrl = (u: any) => typeof u === 'string' && /^(stun|stuns|turn|turns):/.test(u);
    if (typeof ice === 'string') {
        if (!validUrl(ice)) {
            throw invalid(`"ice" should be a "stun:", "stuns:", "turn:" or "turns:" url, or a list of { urls, username, credential }.`);
        }
        return [{ urls: ice }];
    }
    if (!Array.isArray(ice) || !ice.length) {
        throw invalid(`"ice" should be a url string, or a non-empty list of { urls, username, credential }.`);
    }
    return ice.map((server: any, i: number) => {
        if (!isPlainObject(server)) {
            throw invalid(`"ice[${i}]" should be an object: { urls, username, credential }.`);
        }
        const urls = server.urls;
        const list = Array.isArray(urls) ? urls : [urls];
        if (!list.length || !list.every(validUrl)) {
            throw invalid(`"ice[${i}].urls" should be a "stun:", "stuns:", "turn:" or "turns:" url, or a list of them.`);
        }
        const out: RTCIceServer = { urls };
        for (const key of ['username', 'credential'] as const) {
            if (server[key] !== undefined) {
                if (typeof server[key] !== 'string') {
                    throw invalid(`"ice[${i}].${key}" should be type: <string>.`);
                }
                out[key] = server[key];
            }
        }
        if (list.some((u: string) => /^turns?:/.test(u)) && (!out.username || !out.credential)) {
            throw invalid(`"ice[${i}]" is a TURN server: it needs "username" and "credential".`);
        }
        return out;
    });
}

/** The RTCPeerConnection configuration: the servers above, and 'relay' when every path must go through the relay. */
async function iceConfiguration(ice: any, icePolicy: any): Promise<RTCConfiguration> {
    const configuration: RTCConfiguration = {
        iceServers: ice === undefined || ice === null || ice === '' ? await defaultIceServers.bind(this)() : iceServers(ice)
    };
    if (icePolicy) {
        configuration.iceTransportPolicy = icePolicy;
    }
    return configuration;
}

function checkCid(v: any): string {
    if (typeof v !== 'string') {
        throw invalid(`"cid" should be type: <string>.`);
    }
    if (v && v.slice(0, 4) !== 'cid:') {
        throw invalid(`"cid" should be a valid connection id.`);
    }
    return v;
}

function checkIcePolicy(v: any): 'all' | 'relay' | undefined {
    if (v === undefined || v === null) {
        return undefined;
    }
    if (v !== 'all' && v !== 'relay') {
        throw invalid(`"icePolicy" should be "all" or "relay".`);
    }
    return v;
}

function checkMedia(media: any): any {
    if (media === undefined || media === null || media === false) {
        return undefined;
    }
    if (hasMediaStream() && media instanceof MediaStream) {
        return media;
    }
    if (!isPlainObject(media)) {
        throw invalid(`"media" should be a MediaStream, or an object: { audio, video, screen }.`);
    }
    for (const key of ['audio', 'video']) {
        const v = media[key];
        if (isTrack(v)) {
            // a track of the app's own, sent as the microphone or the camera: no capture, no permission prompt
            if (v.kind !== key) {
                throw invalid(`"media.${key}" is ${v.kind === 'audio' ? 'an audio' : 'a video'} track.`);
            }
            continue;
        }
        if (v === undefined || typeof v === 'boolean' || isPlainObject(v)) {
            continue;
        }
        throw invalid(`"media.${key}" should be a boolean, track constraints, or a MediaStreamTrack.`);
    }
    if (media.screen !== undefined && typeof media.screen !== 'boolean' && !isPlainObject(media.screen)) {
        throw invalid(`"media.screen" should be true, or the options of getDisplayMedia().`);
    }
    if (isPlainObject(media.screen) && media.screen.contentHint !== undefined && !CONTENT_HINTS.includes(media.screen.contentHint)) {
        throw invalid(`"media.screen.contentHint" should be "text", "detail" or "motion".`);
    }
    return media;
}

function isTrack(v: any): v is MediaStreamTrack {
    return typeof MediaStreamTrack !== 'undefined' && v instanceof MediaStreamTrack;
}

/** `audio` or `video` as something to capture: true or constraints. A track given is not captured (it is an object too, so it is ruled out first). */
function wantsUser(v: any): boolean {
    return v === true || (isPlainObject(v) && !isTrack(v));
}

function wantsCapture(media: any): boolean {
    return isPlainObject(media) && !!(wantsUser(media.audio) || wantsUser(media.video) || media.screen);
}

function requireSecureContext() {
    if (window.location.hostname !== 'localhost' && window.location.protocol !== 'https:') {
        throw new SkapiError(`Media stream is only supported on either localhost or https.`, { code: 'INVALID_REQUEST' });
    }
}

function checkReceive(receive: any): { audio?: boolean; video?: boolean } | undefined {
    if (receive === undefined || receive === null) {
        return undefined;
    }
    if (!isPlainObject(receive)) {
        throw invalid(`"receive" should be an object: { audio, video }.`);
    }
    for (const key of ['audio', 'video']) {
        if (receive[key] !== undefined && typeof receive[key] !== 'boolean') {
            throw invalid(`"receive.${key}" should be type: <boolean>.`);
        }
    }
    return receive;
}

function checkEncoding(encoding: any): RTCEncodingOption | null {
    if (encoding === undefined || encoding === null) {
        return null;
    }
    if (!isPlainObject(encoding)) {
        throw invalid(`"encoding" should be an object: { video, audio }.`);
    }
    for (const kind of ['video', 'audio']) {
        const e = encoding[kind];
        if (e === undefined) {
            continue;
        }
        if (!isPlainObject(e)) {
            throw invalid(`"encoding.${kind}" should be an object.`);
        }
        if (e.codecs !== undefined && (!Array.isArray(e.codecs) || !e.codecs.every((c: any) => typeof c === 'string' && c))) {
            throw invalid(`"encoding.${kind}.codecs" should be a list of codec names.`);
        }
        for (const key of ['maxBitrate', 'maxFramerate', 'scaleResolutionDownBy']) {
            if (e[key] !== undefined && !(typeof e[key] === 'number' && e[key] > 0)) {
                throw invalid(`"encoding.${kind}.${key}" should be a positive number.`);
            }
        }
    }
    return encoding;
}

function checkChannels(channels: any, fallback: RTCChannelOption[]): RTCChannelOption[] {
    if (channels === undefined || channels === null) {
        return fallback;
    }
    if (!Array.isArray(channels)) {
        throw invalid(`"channels" should be an array of preset names or RTCDataChannelInit objects.`);
    }
    const types = { ordered: 'boolean', maxPacketLifeTime: 'number', maxRetransmits: 'number', protocol: 'string', negotiated: 'boolean', id: 'number' };
    return channels.map((c: any, i: number) => {
        if (typeof c === 'string') {
            if (!c) {
                throw invalid(`"channels[${i}]" should be a preset name or RTCDataChannelInit.`);
            }
            return c;
        }
        if (!isPlainObject(c)) {
            throw invalid(`"channels[${i}]" should be a preset name or RTCDataChannelInit.`);
        }
        for (const [key, type] of Object.entries(types)) {
            if (c[key] !== undefined && typeof c[key] !== type) {
                throw invalid(`"channels[${i}].${key}" should be type: <${type}>.`);
            }
        }
        if (c.negotiated && typeof c.id !== 'number') {
            throw invalid(`"channels[${i}]" is negotiated: it needs an "id" both sides open it with.`);
        }
        return c;
    });
}

function checkMeta(meta: any): Record<string, any> {
    if (meta === undefined || meta === null) {
        return {};
    }
    if (!isPlainObject(meta)) {
        throw invalid(`"meta" should be an object.`);
    }
    try {
        return JSON.parse(JSON.stringify(meta));
    } catch (err) {
        throw invalid(`"meta" should be a JSON object.`);
    }
}

function newState(key: string, polite: boolean, meta: Record<string, any>, encoding: RTCEncodingOption | null): PeerState {
    return {
        polite,
        makingOffer: false,
        ignoreOffer: false,
        armed: false,
        meta,
        media: new MediaStream(),
        user: null,
        sources: new Map(),
        wires: new Map(),
        cleanup: new Map(),
        remoteSources: {},
        encoding,
        receive: null,
        callId: null,
        peerCid: key,
        recovery: null,
        ringTimer: null,
        fileIn: null,
        fileQueue: Promise.resolve(),
        fileAcks: new Map(),
        fileChannelWaiters: []
    };
}

/** Every send waiting for a receipt, and every sendFile() waiting for the channel, fails with the call. */
function failFileTransfers(st: PeerState) {
    const err = new SkapiError('The file channel closed.', { code: 'INVALID_REQUEST' });
    for (const ack of st.fileAcks.values()) {
        ack.reject(err);
    }
    st.fileAcks.clear();
    for (const w of st.fileChannelWaiters.splice(0)) {
        w.reject(err);
    }
    st.fileIn = null;
}

/** Closes a connection that never got as far as a signal to the other side (capture refused), without telling anyone. */
function discardPeer(cid: string) {
    const st = __peerState[cid];
    if (st) {
        clearTimeout(st.ringTimer);
        clearRecovery(st);
        failFileTransfers(st);
        for (const off of st.cleanup.values()) {
            off();
        }
        for (const track of st.media.getTracks()) {
            track.stop();
        }
    }
    if (__peerConnection[cid] && __peerConnection[cid].signalingState !== 'closed') {
        __peerConnection[cid].close();
    }
    delete __peerState[cid];
    delete __peerConnection[cid];
    delete __dataChannel[cid];
    delete __rtcEvents[cid];
    delete __signalChain[cid];
}

/* ---- local media ---- */

async function captureScreen(cid: string, option: any): Promise<MediaStreamTrack[]> {
    const st = __peerState[cid];
    const { contentHint, source, ...rest } = isPlainObject(option) ? option : {};
    const stream = await window.navigator.mediaDevices.getDisplayMedia(Object.keys(rest).length ? rest : { video: true });
    const tracks = stream.getTracks();
    for (const track of tracks) {
        st.sources.set(track, 'screen');
        if (track.kind === 'video' && contentHint) {
            try { track.contentHint = contentHint; } catch (err) { }
        }
    }
    return tracks;
}

async function captureUser(cid: string, constraints: MediaStreamConstraints): Promise<MediaStreamTrack[]> {
    const st = __peerState[cid];
    const stream = await window.navigator.mediaDevices.getUserMedia(constraints);
    const tracks = stream.getTracks();
    for (const track of tracks) {
        st.sources.set(track, track.kind === 'audio' ? 'microphone' : 'camera');
    }
    if (!st.user) {
        st.user = stream;
    }
    else {
        for (const track of tracks) {
            st.user.addTrack(track);
        }
    }
    return tracks;
}

/** The `media` option at the start of a call: a stream as it is, or what to capture. */
async function captureInto(cid: string, media: any): Promise<void> {
    const st = __peerState[cid];
    if (!media || !st) {
        return;
    }
    if (hasMediaStream() && media instanceof MediaStream) {
        for (const track of media.getTracks()) {
            st.sources.set(track, 'custom');
        }
        addLocalTracks.call(this, cid, media.getTracks(), media);
        return;
    }
    const { screen, audio, video } = media;
    const given = [audio, video].filter(isTrack) as MediaStreamTrack[];
    if (given.length) {
        // the app's own tracks, sent as the microphone and the camera alongside what is captured
        for (const track of given) {
            st.sources.set(track, track.kind === 'audio' ? 'microphone' : 'camera');
        }
        if (!st.user) {
            st.user = new MediaStream(given);
        }
        else {
            for (const track of given) {
                st.user.addTrack(track);
            }
        }
        addLocalTracks.call(this, cid, given, st.user);
    }
    const constraints: MediaStreamConstraints = {};
    if (wantsUser(audio)) {
        constraints.audio = audio;
    }
    if (wantsUser(video)) {
        constraints.video = video;
    }
    if (constraints.audio || constraints.video) {
        const tracks = await captureUser(cid, constraints);
        addLocalTracks.call(this, cid, tracks, st.user);
    }
    if (screen) {
        const tracks = await captureScreen(cid, screen === true ? {} : screen);
        addLocalTracks.call(this, cid, tracks, new MediaStream(tracks));
    }
}

/** Puts tracks on the connection. Negotiation follows on its own once the call is up. */
function addLocalTracks(cid: string, tracks: MediaStreamTrack[], wire: MediaStream) {
    const pc = __peerConnection[cid];
    const st = __peerState[cid];
    if (!pc || !st) {
        return;
    }
    for (const track of tracks) {
        if (!st.sources.has(track)) {
            st.sources.set(track, 'custom');
        }
        if (!wire.getTracks().includes(track)) {
            wire.addTrack(track);
        }
        st.wires.set(track, wire);
        if (!st.media.getTracks().includes(track)) {
            st.media.addTrack(track);
        }
        if (!pc.getSenders().some(s => s.track === track)) {
            pc.addTrack(track, wire);
        }
        // a track that ends on its own (the browser's "Stop sharing" button, a camera unplugged) comes off the call
        const onended = () => removeLocalTrack.call(this, cid, track, false, true);
        track.addEventListener('ended', onended, { once: true });
        st.cleanup.set(track, () => track.removeEventListener('ended', onended));
    }
    applyCodecPreferences.call(this, cid);
    applyEncodingParameters.call(this, cid);
}

function removeLocalTrack(cid: string, track: MediaStreamTrack, stop: boolean, ended = false) {
    const pc = __peerConnection[cid];
    const st = __peerState[cid];
    if (!st || !st.sources.has(track)) {
        if (stop) {
            track.stop();
        }
        return;
    }
    const source = st.sources.get(track);
    const off = st.cleanup.get(track);
    if (off) {
        off();
    }
    st.cleanup.delete(track);
    if (pc && pc.signalingState !== 'closed') {
        const sender = pc.getSenders().find(s => s.track === track);
        if (sender) {
            try { pc.removeTrack(sender); } catch (err) { this.log('removeTrack', err); }
        }
    }
    const wire = st.wires.get(track);
    if (wire) {
        wire.removeTrack(track);
    }
    st.wires.delete(track);
    st.media.removeTrack(track);
    st.sources.delete(track);
    if (stop) {
        track.stop();
    }
    const cb = __rtcEvents[cid];
    if (cb) {
        cb({ type: 'unshare', target: pc, timestamp: now(), track, source, ended });
    }
}

/** A receive-only transceiver per kind asked for that no local track covers, so the other side's track of that kind arrives in the first negotiation. */
function addReceivers(cid: string, receive: { audio?: boolean; video?: boolean } | undefined) {
    const pc = __peerConnection[cid];
    if (!pc || !receive) {
        return;
    }
    for (const kind of ['audio', 'video'] as const) {
        if (!receive[kind]) {
            continue;
        }
        const covered = pc.getTransceivers().some(t => (t.sender.track && t.sender.track.kind === kind) || (t.receiver.track && t.receiver.track.kind === kind));
        if (!covered) {
            pc.addTransceiver(kind, { direction: 'recvonly' });
        }
    }
}

function codecList(kind: 'audio' | 'video', names: string[]): RTCRtpCodec[] | null {
    const Receiver: any = (typeof RTCRtpReceiver !== 'undefined') ? RTCRtpReceiver : null;
    const caps = Receiver && typeof Receiver.getCapabilities === 'function' ? Receiver.getCapabilities(kind) : null;
    if (!caps || !caps.codecs) {
        return null;
    }
    const wanted = names.map(n => (n.includes('/') ? n : `${kind}/${n}`).toLowerCase());
    const preferred: RTCRtpCodec[] = [];
    for (const w of wanted) {
        for (const c of caps.codecs) {
            if (c.mimeType.toLowerCase() === w && !preferred.includes(c)) {
                preferred.push(c);
            }
        }
    }
    if (!preferred.length) {
        return null;
    }
    return [...preferred, ...caps.codecs.filter(c => !preferred.includes(c))];
}

/** `encoding.<kind>.codecs` on every transceiver of the kind. Before an offer or answer is made, so it shapes the negotiation. */
function applyCodecPreferences(cid: string) {
    const pc = __peerConnection[cid];
    const st = __peerState[cid];
    if (!pc || !st || !st.encoding) {
        return;
    }
    for (const kind of ['audio', 'video'] as const) {
        const names = st.encoding[kind] && st.encoding[kind].codecs;
        if (!names || !names.length) {
            continue;
        }
        const list = codecList(kind, names);
        if (!list) {
            continue;
        }
        for (const t of pc.getTransceivers()) {
            const k = (t.sender.track && t.sender.track.kind) || (t.receiver.track && t.receiver.track.kind);
            if (k === kind && typeof t.setCodecPreferences === 'function') {
                try { t.setCodecPreferences(list); } catch (err) { this.log('setCodecPreferences', err); }
            }
        }
    }
}

/** `encoding.<kind>` limits on every sender of the kind. Sender parameters exist once a local description is set, so this runs after each one and is a no-op before. */
function applyEncodingParameters(cid: string) {
    const pc = __peerConnection[cid];
    const st = __peerState[cid];
    if (!pc || !st || !st.encoding) {
        return;
    }
    for (const sender of pc.getSenders()) {
        const track = sender.track;
        if (!track) {
            continue;
        }
        const e: any = st.encoding[track.kind as 'audio' | 'video'];
        if (!e) {
            continue;
        }
        const wanted: any = {};
        for (const key of ['maxBitrate', 'maxFramerate', 'scaleResolutionDownBy']) {
            if (e[key] !== undefined) {
                wanted[key] = e[key];
            }
        }
        if (!Object.keys(wanted).length) {
            continue;
        }
        let params: RTCRtpSendParameters;
        try { params = sender.getParameters(); } catch (err) { continue; }
        if (!params.encodings || !params.encodings.length) {
            continue;
        }
        let changed = false;
        for (const key in wanted) {
            if (params.encodings[0][key] !== wanted[key]) {
                params.encodings[0][key] = wanted[key];
                changed = true;
            }
        }
        if (changed) {
            sender.setParameters(params).catch(err => this.log('setParameters', err));
        }
    }
}

/* ---- data channels ---- */

function openChannel(cid: string, option: RTCChannelOption): RTCDataChannel {
    const pc = __peerConnection[cid];
    if (!pc || pc.signalingState === 'closed') {
        throw new SkapiError('The call is closed.', { code: 'INVALID_REQUEST' });
    }
    // a string that is not a preset opens a channel of that name with the default options
    const init: RTCDataChannelInit = typeof option === 'string' ? (CHANNEL_PRESETS[option] || { ...CHANNEL_PRESETS.default, protocol: option }) : { ...option };
    const label = init.protocol || 'default';
    if (!__dataChannel[cid]) {
        __dataChannel[cid] = {};
    }
    if (__dataChannel[cid][label]) {
        throw new SkapiError(`Data channel with the protocol "${label}" already exists.`, { code: 'INVALID_REQUEST' });
    }
    const channel = pc.createDataChannel(label, init);
    __dataChannel[cid][label] = channel;
    if (label === FILE_CHANNEL) {
        handleFileChannel.call(this, cid, channel, label);
    }
    else {
        handleDataChannel.call(this, cid, channel, label);
    }
    return channel;
}

/** Channels the other side opens. One with a label this side already uses is kept as "label#id". */
function watchChannels(cid: string) {
    const pc = __peerConnection[cid];
    pc.ondatachannel = (event) => {
        const channel = event.channel;
        if (!__dataChannel[cid]) {
            __dataChannel[cid] = {};
        }
        let key = channel.label;
        if (__dataChannel[cid][key] && __dataChannel[cid][key] !== channel) {
            key = `${channel.label}#${channel.id}`;
        }
        this.log('ondatachannel', `received data channel "${key}".`);
        __dataChannel[cid][key] = channel;
        if (channel.label === FILE_CHANNEL) {
            handleFileChannel.call(this, cid, channel, key);
        }
        else {
            handleDataChannel.call(this, cid, channel, key);
        }
    };
}

/** The SDK's file channel, open or opening. Opened here when no side has sent a file yet. */
function ensureFileChannel(cid: string): Promise<RTCDataChannel> {
    const st = __peerState[cid];
    const existing = __dataChannel[cid] && __dataChannel[cid][FILE_CHANNEL];
    if (existing && existing.readyState === 'open') {
        return Promise.resolve(existing);
    }
    if (!existing) {
        openChannel.call(this, cid, { protocol: FILE_CHANNEL, ordered: true });
    }
    return new Promise((resolve, reject) => st.fileChannelWaiters.push({ resolve, reject }));
}

/**
 * The file channel's traffic is the SDK's, not the app's: the app sees 'fileprogress' events while
 * a file arrives and a 'file' event with the File when it is whole, and gets its sendFile() promise
 * resolved when the other side's receipt comes back.
 */
function handleFileChannel(cid: string, channel: RTCDataChannel, stored: string) {
    const emit = (e: any) => {
        const fn = __rtcEvents[cid];
        if (fn) {
            fn(e);
        }
    };
    const progress = (f: FileIn) => emit({ type: 'fileprogress', target: channel, timestamp: now(), label: channel.label, id: f.id, name: f.name, size: f.size, mime: f.mime, received: f.received });
    channel.binaryType = 'arraybuffer';
    channel.onopen = (event) => {
        const st = __peerState[cid];
        if (st) {
            for (const w of st.fileChannelWaiters.splice(0)) {
                w.resolve(channel);
            }
        }
        this.log('dataChannel', `file channel "${channel.label}" is open.`);
        emit({ type: 'open', target: channel, timeStamp: event.timeStamp, readyState: channel.readyState, label: channel.label, id: channel.id, ordered: channel.ordered, protocol: channel.protocol });
    };
    channel.onmessage = (event) => {
        const st = __peerState[cid];
        if (!st) {
            return;
        }
        if (typeof event.data === 'string') {
            let m: any;
            try { m = JSON.parse(event.data); } catch (err) { return; }
            if (m && m.k === 'file') {
                st.fileIn = { id: String(m.id), name: typeof m.name === 'string' && m.name ? m.name : 'file', size: Number(m.size) || 0, mime: typeof m.type === 'string' ? m.type : '', received: 0, reported: 0, chunks: [] };
                progress(st.fileIn);
            }
            else if (m && m.k === 'end' && st.fileIn && st.fileIn.id === m.id) {
                const f = st.fileIn;
                st.fileIn = null;
                const file = new File(f.chunks, f.name, { type: f.mime });
                if (f.reported !== f.received) {
                    progress(f);
                }
                emit({ type: 'file', target: channel, timestamp: now(), label: channel.label, id: f.id, name: f.name, size: f.received, mime: f.mime, file });
                try { channel.send(JSON.stringify({ k: 'done', id: f.id })); } catch (err) { this.log('file receipt', err); }
            }
            else if (m && m.k === 'done') {
                const ack = st.fileAcks.get(m.id);
                if (ack) {
                    st.fileAcks.delete(m.id);
                    ack.resolve(null);
                }
            }
            return;
        }
        if (st.fileIn && event.data instanceof ArrayBuffer) {
            st.fileIn.chunks.push(event.data);
            st.fileIn.received += event.data.byteLength;
            if (st.fileIn.received - st.fileIn.reported >= FILE_PROGRESS_EVERY) {
                st.fileIn.reported = st.fileIn.received;
                progress(st.fileIn);
            }
        }
    };
    channel.onerror = (event: any) => {
        emit({ type: 'error', target: channel, timeStamp: event.timeStamp, error: event.error?.message, errorCode: event.error?.errorDetail, readyState: channel.readyState, label: channel.label });
    };
    channel.onclose = (event) => {
        const st = __peerState[cid];
        if (st) {
            failFileTransfers(st);
        }
        this.log(`${channel.label}: closed`, null);
        emit({ type: 'close', target: channel, timeStamp: event.timeStamp, readyState: channel.readyState, label: channel.label, id: channel.id });
        if (__dataChannel[cid] && __dataChannel[cid][stored] === channel) {
            delete __dataChannel[cid][stored];
            if (Object.keys(__dataChannel[cid]).length === 0) {
                closeRTC.call(this, { cid });
            }
        }
    };
}

/* ---- signaling ---- */

async function sendSignal(cid: string, content: any) {
    if (!this?.session?.accessToken?.jwtToken) {
        throw new SkapiError('Access token is required.', { code: 'INVALID_PARAMETER' });
    }
    const socket: WebSocket = await this.__socket;
    if (!socket || socket.readyState !== 1) {
        throw new SkapiError('Realtime connection is not ready.', { code: 'INVALID_REQUEST' });
    }
    socket.send(JSON.stringify(signalEnvelope.call(this, cid, content)));
}

/**
 * A signal of a call, addressed to the other side's current connection id (the relay delivers to
 * one connection only) and naming the call (`call`), so the other side finds the call even when
 * this side's own connection id has changed since the call started.
 */
function signalEnvelope(key: string, content: any) {
    const st = __peerState[key];
    const body = { ...content };
    if (st && st.callId) {
        body.call = st.callId;
    }
    return {
        action: 'rtc',
        uid: st ? st.peerCid : key,
        content: body,
        token: this.session.accessToken.jwtToken
    };
}

/** A signal sent without awaiting the socket: from a socket handler, or where a failure is logged rather than thrown. */
function postSignal(key: string, content: any) {
    if (!this.__socket) {
        return;
    }
    Promise.resolve(this.__socket).then((s: WebSocket) => {
        if (s && s.readyState === 1 && this?.session?.accessToken?.jwtToken) {
            s.send(JSON.stringify(signalEnvelope.call(this, key, content)));
        }
    }, () => null);
}

/** What each local track is, by the mid of its transceiver, for the other side's 'track' events. */
function localSources(cid: string): { [mid: string]: string } {
    const pc = __peerConnection[cid];
    const st = __peerState[cid];
    const out: { [mid: string]: string } = {};
    if (!pc || !st) {
        return out;
    }
    for (const t of pc.getTransceivers()) {
        if (t.mid && t.sender.track && st.sources.has(t.sender.track)) {
            out[t.mid] = st.sources.get(t.sender.track);
        }
    }
    return out;
}

function rememberRemoteSources(cid: string, sources: any) {
    const st = __peerState[cid];
    if (st && isPlainObject(sources)) {
        for (const mid in sources) {
            if (typeof sources[mid] === 'string') {
                st.remoteSources[mid] = sources[mid];
            }
        }
    }
}

/**
 * An offer: the first one of a call, and every renegotiation after a track or channel changed.
 * When an offer from the other side arrives while this one is being made, the call's polite side
 * (the one that answered the call) drops its own and answers; the other side ignores the
 * incoming one. The browser raises negotiationneeded again if something is still left to agree.
 */
async function sendOffer(cid: string, extra: any = {}, options?: RTCOfferOptions) {
    const pc = __peerConnection[cid];
    const st = __peerState[cid];
    if (!pc || !st || pc.signalingState === 'closed') {
        return;
    }
    try {
        st.makingOffer = true;
        const offer = await pc.createOffer(options);
        // An ICE restart may replace an offer of this side's own that is still waiting for its
        // answer (one sent while the socket was down never arrived); any other offer waits for stable.
        const replacing = !!(options && options.iceRestart) && pc.signalingState === 'have-local-offer';
        if (pc.signalingState !== 'stable' && !replacing) {
            this.log('sendOffer', `offer to "${cid}" dropped: an offer from the other side came first.`);
            return;
        }
        await pc.setLocalDescription(offer);
        applyEncodingParameters.call(this, cid);
        this.log('rtcSdpOffer to', cid);
        await sendSignal.call(this, cid, { sdpoffer: pc.localDescription, sources: localSources(cid), ...extra });
    }
    finally {
        st.makingOffer = false;
    }
}

function armNegotiation(cid: string) {
    const pc = __peerConnection[cid];
    const st = __peerState[cid];
    if (!pc || !st || st.armed) {
        return;
    }
    st.armed = true;
    pc.onnegotiationneeded = () => {
        this.log('onnegotiationneeded', `sending offer to "${cid}".`);
        sendOffer.call(this, cid).catch(err => this.log('onnegotiationneeded', err));
        const cb = __rtcEvents[cid];
        if (cb) {
            cb({
                type: 'negotiationneeded',
                target: pc,
                timestamp: now(),
                signalingState: pc.signalingState,
                connectionState: pc.iceConnectionState,
                gatheringState: pc.iceGatheringState
            });
        }
    };
}

async function answerOffer(content: any, cid: string) {
    const pc = __peerConnection[cid];
    const st = __peerState[cid];
    if (!pc || !st || pc.signalingState === 'closed' || !content?.sdpoffer) {
        return;
    }
    const collision = st.makingOffer || pc.signalingState !== 'stable';
    st.ignoreOffer = !st.polite && collision;
    if (st.ignoreOffer) {
        this.log('answerSdpOffer', `offer from "${cid}" ignored: this side is offering.`);
        return;
    }
    rememberRemoteSources(cid, content.sources);
    if (!st.callId && typeof content.call === 'string' && content.call) {
        st.callId = content.call; // the caller named the call in its first offer
    }
    this.log('answerSdpOffer from', cid);
    await pc.setRemoteDescription(new RTCSessionDescription(content.sdpoffer)); // the polite side's own pending offer is rolled back by this
    if (st.receive) {
        // a kind the offer does not carry: asked for with an offer of this side's own, right after this answer
        addReceivers(cid, st.receive);
        st.receive = null;
    }
    applyCodecPreferences.call(this, cid);
    const answer = await pc.createAnswer();
    armNegotiation.call(this, cid); // from here on, a track this side adds is offered to the other side
    await pc.setLocalDescription(answer);
    applyEncodingParameters.call(this, cid);
    await sendSignal.call(this, cid, { sdpanswer: pc.localDescription, sources: localSources(cid) });
    await receiveIceCandidate.call(this, null, cid);
}

/** An offer from the other side. Answered at once during a call; kept until the call is answered when it is the first one. */
export async function answerSdpOffer(content: any, recipient: string) {
    if (!this?.session?.accessToken?.jwtToken) {
        throw new SkapiError('Access token is required.', { code: 'INVALID_PARAMETER' });
    }
    if (__peerConnection?.[recipient] && __peerState[recipient]) {
        await processBuffer(__rtcSdpOfferBuffer, recipient, (c) => answerOffer.call(this, c, recipient));
        if (content) {
            await answerOffer.call(this, content, recipient);
        }
    }
    else if (content) {
        setBuffer(__rtcSdpOfferBuffer, recipient, content);
    }
}

/** The other side's answer to an offer of ours. */
export async function acceptAnswer(content: any, cid: string) {
    const pc = __peerConnection[cid];
    const st = __peerState[cid];
    if (!pc || !st || !content?.sdpanswer) {
        return;
    }
    if (pc.signalingState !== 'have-local-offer') {
        this.log('sdpanswer', `answer from "${cid}" ignored in signaling state "${pc.signalingState}".`);
        return;
    }
    rememberRemoteSources(cid, content.sources);
    armNegotiation.call(this, cid);
    await pc.setRemoteDescription(new RTCSessionDescription(content.sdpanswer));
    applyEncodingParameters.call(this, cid);
    // The relay delivers each message from its own invocation, so the other side's ICE
    // candidates can arrive before its answer. Until the answer is set they are buffered;
    // add them now. Waiting for a later candidate to flush them is not enough: when every
    // candidate overtook the answer there is none, and across two NATs the call never connects.
    await receiveIceCandidate.call(this, null, cid);
}

/**
 * Drops what was kept for a call that never opened on this side: its offer and candidates, once
 * the other side hung up. With `callId`, only that call's: a hang-up of an earlier call from the
 * same connection must not take the offer of the next one with it.
 */
export function discardSignals(cid: string, callId?: string) {
    if (!callId) {
        delete __rtcSdpOfferBuffer[cid];
        delete __rtcCandidatesBuffer[cid];
        return;
    }
    for (const buffer of [__rtcSdpOfferBuffer, __rtcCandidatesBuffer]) {
        if (buffer[cid]) {
            buffer[cid] = buffer[cid].filter((item: any) => !(item && item.call === callId));
            if (!buffer[cid].length) {
                delete buffer[cid];
            }
        }
    }
}

/** The answering side's refusal of a call that rings: the caller's `connection` never resolves. Also used after the caller hung up meanwhile. */
export function rejectRinging(cid: string) {
    const callId = __receiver_ringing[cid];
    delete __receiver_ringing[cid];
    discardSignals(cid, callId !== cid ? callId : undefined);
    postSignal.call(this, cid, callId && callId !== cid ? { hungup: this.user.user_id, call: callId } : { hungup: this.user.user_id });
}

export async function receiveIceCandidate(candidate: any, recipient: string) {
    this.log('receiveIceCandidate', candidate);
    const pc = __peerConnection?.[recipient];
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        const add = async (c: any) => {
            try {
                await pc.addIceCandidate(c);
            }
            catch (err) {
                // a candidate of an offer this side ignored is expected to fail
                if (!__peerState[recipient]?.ignoreOffer) {
                    this.log('addIceCandidate', err);
                }
            }
        };
        await processBuffer(__rtcCandidatesBuffer, recipient, add);
        if (candidate) {
            await add(candidate);
        }
    }
    else {
        setBuffer(__rtcCandidatesBuffer, recipient, candidate);
    }
}

export async function closeRTC(params: { cid?: string; close_all?: boolean }, lost?: boolean): Promise<void> {
    if (typeof window === 'undefined' || (window as any)._runningInNodeJS) {
        throw new SkapiError('WebRTC is not supported in Node.js environment.', { code: 'NOT_SUPPORTED' });
    }
    validator.Params(params, {
        cid: checkCid,
        close_all: 'boolean'
    });
    let socket: WebSocket = this.__socket ? await this.__socket.catch(() => null) : null;
    let { cid, close_all = false } = params || {};

    if (!close_all && !cid) {
        throw new SkapiError(`"cid" is required.`, { code: 'INVALID_PARAMETER' });
    }

    let close = (cid: string) => {
        if (!cid) {
            throw new SkapiError(`"cid" is required.`, { code: 'INVALID_PARAMETER' });
        }
        cid = resolveKey(cid); // the app may hold the other side's current connection id; the call is keyed by its first
        for (const alias in __cidAlias) {
            if (__cidAlias[alias] === cid) {
                delete __cidAlias[alias];
            }
        }

        delete __rtcSdpOfferBuffer[cid];
        delete __rtcCandidatesBuffer[cid];

        const st = __peerState[cid];
        if (st) {
            clearTimeout(st.ringTimer);
            clearRecovery(st);
            failFileTransfers(st);
            for (const off of st.cleanup.values()) {
                off();
            }
        }

        // Close all associated data channels
        if (__dataChannel[cid]) {
            Object.values(__dataChannel[cid]).forEach(channel => {
                if (channel.readyState !== 'closed') {
                    channel.close();
                }
            });
        }

        delete __dataChannel[cid];

        if (__peerConnection?.[cid]) {
            if (lost && __rtcEvents[cid]) {
                // the connection could not be brought back, on this side or the other: the call ends as lost, not as a hang-up
                __rtcEvents[cid]({ type: 'lost', target: __peerConnection[cid], timestamp: now() });
            }
            if (__peerConnection[cid].connectionState !== 'closed') {
                __peerConnection[cid].close();

                if (socket && socket.readyState === 1 && this?.session?.accessToken?.jwtToken) {
                    // `lost` travels with the hang-up, so the other side ends the call the same way
                    socket.send(JSON.stringify(signalEnvelope.call(this, cid, lost ? { hungup: this.user.user_id, lost: true } : { hungup: this.user.user_id })));
                }
            }

            let msg = {
                type: 'connectionstatechange',
                target: __peerConnection[cid],
                timestamp: now(),
                state: __peerConnection[cid].connectionState,
                iceState: __peerConnection[cid].iceConnectionState,
                signalingState: __peerConnection[cid].signalingState
            }

            if (__rtcEvents[cid]) {
                __rtcEvents[cid](msg);
            }

            this.log('closeRTC', msg);
        }

        // the local tracks of this call, and only this call's
        if (st) {
            this.log('Cleaning up media stream...', cid);
            for (const track of st.media.getTracks()) {
                track.stop();
            }
        }

        delete __peerState[cid];
        delete __rtcEvents[cid];
        delete __receiver_ringing[cid];
        delete __caller_ringing[cid];
        delete __peerConnection[cid];
        delete __signalChain[cid];
    }

    if (close_all) {
        for (let key in __peerConnection) {
            close(key);
        }
    }
    else {
        close(cid);
    }
}

/** The connection object both sides get: the peer connection, the channels, the local media, and the controls of a running call. */
function resolved(cid: string): RTCResolved {
    const self = this;
    const pc = __peerConnection[cid];
    const st = __peerState[cid];

    const alive = () => {
        if (!__peerState[cid] || !__peerConnection[cid] || __peerConnection[cid].signalingState === 'closed') {
            throw new SkapiError('The call is closed.', { code: 'INVALID_REQUEST' });
        }
    };
    const findTracks = (what: any): MediaStreamTrack[] => {
        if (typeof MediaStreamTrack !== 'undefined' && what instanceof MediaStreamTrack) {
            return st.sources.has(what) ? [what] : [];
        }
        if (typeof what !== 'string') {
            throw invalid('Name a source ("camera", "microphone", "screen", or a name given to share()), or pass a MediaStreamTrack.');
        }
        const out: MediaStreamTrack[] = [];
        for (const [track, source] of st.sources) {
            if (source === what) {
                out.push(track);
            }
        }
        return out;
    };
    const watchEnd = (track: MediaStreamTrack) => {
        const onended = () => removeLocalTrack.call(self, cid, track, false, true);
        track.addEventListener('ended', onended, { once: true });
        st.cleanup.set(track, () => track.removeEventListener('ended', onended));
    };

    return {
        cid,
        target: pc,
        channels: __dataChannel[cid],
        media: st.media,
        meta: st.meta,
        hangup: () => closeRTC.call(self, { cid }),
        tracks: (source?: RTCMediaSource) => source === undefined ? Array.from(st.sources.keys()) : findTracks(source),
        share: async (what: any, options?: RTCShareOptions) => {
            alive();
            const opt: any = isPlainObject(options) ? options : {};
            if (opt.contentHint !== undefined && !CONTENT_HINTS.includes(opt.contentHint)) {
                throw invalid(`"contentHint" should be "text", "detail" or "motion".`);
            }
            let tracks: MediaStreamTrack[];
            let wire: MediaStream;
            if (what === 'screen') {
                requireSecureContext();
                tracks = await captureScreen(cid, opt);
                wire = new MediaStream(tracks);
            }
            else if (what === 'camera' || what === 'microphone') {
                requireSecureContext();
                const { contentHint, source, ...constraints } = opt;
                const c = Object.keys(constraints).length ? constraints : true;
                tracks = await captureUser(cid, what === 'camera' ? { video: c } : { audio: c });
                wire = st.user;
            }
            else if (hasMediaStream() && what instanceof MediaStream) {
                tracks = what.getTracks();
                wire = what;
                for (const track of tracks) {
                    st.sources.set(track, typeof opt.source === 'string' && opt.source ? opt.source : 'custom');
                }
            }
            else if (typeof MediaStreamTrack !== 'undefined' && what instanceof MediaStreamTrack) {
                tracks = [what];
                wire = new MediaStream([what]);
                st.sources.set(what, typeof opt.source === 'string' && opt.source ? opt.source : 'custom');
            }
            else {
                throw invalid('share() takes "screen", "camera", "microphone", a MediaStream or a MediaStreamTrack.');
            }
            if (opt.contentHint) {
                for (const track of tracks) {
                    if (track.kind === 'video') {
                        try { track.contentHint = opt.contentHint; } catch (err) { }
                    }
                }
            }
            alive();
            addLocalTracks.call(self, cid, tracks, wire);
            return tracks;
        },
        unshare: (what: any) => {
            for (const track of findTracks(what)) {
                removeLocalTrack.call(self, cid, track, true);
            }
        },
        replace: async (what: any, track: MediaStreamTrack) => {
            alive();
            if (typeof MediaStreamTrack === 'undefined' || !(track instanceof MediaStreamTrack)) {
                throw invalid('replace() needs the MediaStreamTrack to send instead.');
            }
            const old = findTracks(what).find(t => t.kind === track.kind);
            if (!old) {
                throw new SkapiError(`No ${track.kind} track of "${typeof what === 'string' ? what : 'that track'}" is on the call.`, { code: 'INVALID_REQUEST' });
            }
            const sender = pc.getSenders().find(s => s.track === old);
            if (!sender) {
                throw new SkapiError('The track is not being sent.', { code: 'INVALID_REQUEST' });
            }
            await sender.replaceTrack(track);
            const source = st.sources.get(old);
            const wire = st.wires.get(old);
            const off = st.cleanup.get(old);
            if (off) {
                off();
            }
            st.cleanup.delete(old);
            if (wire) {
                wire.removeTrack(old);
                wire.addTrack(track);
                st.wires.set(track, wire);
            }
            st.media.removeTrack(old);
            st.media.addTrack(track);
            st.sources.delete(old);
            st.wires.delete(old);
            old.stop();
            st.sources.set(track, source);
            watchEnd(track);
            applyEncodingParameters.call(self, cid);
        },
        mute: (what: { audio?: boolean; video?: boolean; screen?: boolean }) => {
            if (!isPlainObject(what)) {
                throw invalid('mute() takes { audio, video, screen }.');
            }
            for (const [track, source] of st.sources) {
                if (source === 'screen') {
                    if (typeof what.screen === 'boolean') {
                        track.enabled = !what.screen;
                    }
                }
                else if (track.kind === 'audio') {
                    if (typeof what.audio === 'boolean') {
                        track.enabled = !what.audio;
                    }
                }
                else if (typeof what.video === 'boolean') {
                    track.enabled = !what.video;
                }
            }
        },
        addChannel: (protocol: string, init?: RTCDataChannelInit) => {
            alive();
            if (typeof protocol !== 'string' || !protocol) {
                throw invalid('addChannel() needs the name of the channel.');
            }
            if (init !== undefined && !isPlainObject(init)) {
                throw invalid('addChannel() takes RTCDataChannelInit as its second argument.');
            }
            return openChannel.call(self, cid, init ? { ...init, protocol } : protocol);
        },
        sendFile: (file: Blob, options?: RTCSendFileOptions) => {
            alive();
            if (typeof Blob === 'undefined' || !(file instanceof Blob)) {
                throw invalid('sendFile() needs a File or Blob.');
            }
            const opt: any = isPlainObject(options) ? options : {};
            if (opt.name !== undefined && (typeof opt.name !== 'string' || !opt.name)) {
                throw invalid('"name" should be a non-empty string.');
            }
            if (opt.onProgress !== undefined && typeof opt.onProgress !== 'function') {
                throw invalid('"onProgress" should be a function.');
            }
            const name: string = opt.name || (file as File).name || 'file';
            const mime = file.type || 'application/octet-stream';
            const size = file.size;
            const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
            const run = async (): Promise<RTCFileInfo> => {
                alive();
                const channel = await ensureFileChannel.call(self, cid);
                channel.bufferedAmountLowThreshold = FILE_LOW_WATER;
                const receipt = new Promise<void>((resolve, reject) => st.fileAcks.set(id, { resolve, reject }));
                receipt.catch(() => { });
                channel.send(JSON.stringify({ k: 'file', id, name, size, type: mime }));
                let offset = 0;
                while (offset < size) {
                    if (channel.readyState !== 'open') {
                        throw new SkapiError('The file channel closed.', { code: 'INVALID_REQUEST' });
                    }
                    if (channel.bufferedAmount > FILE_HIGH_WATER) {
                        // the connection's buffer is full: wait for it to drain instead of piling the whole file into memory
                        await new Promise<void>(resolve => {
                            const go = () => {
                                channel.removeEventListener('bufferedamountlow', go);
                                channel.removeEventListener('close', go);
                                resolve();
                            };
                            channel.addEventListener('bufferedamountlow', go);
                            channel.addEventListener('close', go);
                        });
                        continue;
                    }
                    const chunk = await file.slice(offset, offset + FILE_CHUNK).arrayBuffer();
                    channel.send(chunk);
                    offset += chunk.byteLength;
                    if (opt.onProgress) {
                        try { opt.onProgress(offset, size); } catch (err) { self.log('onProgress', err); }
                    }
                }
                channel.send(JSON.stringify({ k: 'end', id }));
                await receipt;
                return { id, name, size, mime };
            };
            const p = st.fileQueue.then(run, run);
            st.fileQueue = p.catch(() => { });
            return p;
        }
    };
}

export async function connectRTC(
    params: RTCConnectorParams,
    callback: (e: RTCEvent) => void
): Promise<RTCConnector> {
    if (typeof window === 'undefined' || (window as any)._runningInNodeJS) {
        throw new SkapiError('WebRTC is not supported in Node.js environment.', { code: 'NOT_SUPPORTED' });
    }
    if (typeof callback !== 'function') {
        throw new SkapiError(`Callback is required.`, { code: 'INVALID_PARAMETER' });
    }

    if (!this?.session?.accessToken?.jwtToken) {
        throw new SkapiError('Access token is required.', { code: 'INVALID_PARAMETER' });
    }

    // `media` stays out of the validator: it clones values through JSON, which turns a MediaStream into an empty object.
    const given = extractFormData(params || {}).data || {};
    const { media: rawMedia, ...rest } = given;

    const checked = validator.Params(rest, {
        cid: checkCid,
        ice: v => v, // a url, or a list of RTCIceServer; checked by iceServers() below
        icePolicy: v => v,
        receive: v => v,
        encoding: v => v,
        channels: v => v,
        meta: v => v,
        ringTimeout: 'number'
    }, ['cid']);

    const cid: string = checked.cid;
    const media = checkMedia(rawMedia);
    const icePolicy = checkIcePolicy(checked.icePolicy);
    const receive = checkReceive(checked.receive);
    const encoding = checkEncoding(checked.encoding);
    const channels = checkChannels(checked.channels, ['default']);
    const meta = checkMeta(checked.meta);
    if (checked.ringTimeout !== undefined && !(checked.ringTimeout > 0)) {
        throw invalid(`"ringTimeout" should be a positive number of milliseconds.`);
    }
    if (wantsCapture(media)) {
        requireSecureContext();
    }

    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    if (socket.readyState !== 1) {
        throw new SkapiError('Realtime connection is not ready.', { code: 'INVALID_REQUEST' });
    }

    // the ICE servers: the caller's own list, or Skapi's STUN server and TURN relay
    const configuration = await iceConfiguration.call(this, checked.ice, icePolicy);

    const fresh = !__peerConnection?.[cid];
    if (fresh) {
        __peerConnection[cid] = new RTCPeerConnection(configuration);
        __peerState[cid] = newState(cid, false, meta, encoding);
        __peerState[cid].callId = newCallId();
    }
    const pc = __peerConnection[cid];
    const st = __peerState[cid];
    if (!fresh) {
        st.meta = meta;
        st.encoding = encoding;
    }

    __rtcEvents[cid] = callback;

    if (!__dataChannel[cid]) {
        __dataChannel[cid] = {};
    }
    watchChannels.call(this, cid);

    try {
        await captureInto.call(this, cid, media);
    }
    catch (err) {
        if (fresh) {
            discardPeer(cid);
        }
        throw err;
    }
    addReceivers(cid, receive);

    for (const option of channels) {
        openChannel.call(this, cid, option);
    }

    peerConnectionHandler.call(this, cid);
    await sendOffer.call(this, cid, { meta });

    if (checked.ringTimeout) {
        st.ringTimer = setTimeout(() => {
            if (!__caller_ringing[cid]) {
                return;
            }
            this.log('ringTimeout', `no answer from "${cid}" within ${checked.ringTimeout} ms.`);
            const cb = __rtcEvents[cid];
            if (cb) {
                cb({ type: 'ringtimeout', target: pc, timestamp: now(), cid });
            }
            __caller_ringing[cid](false);
        }, checked.ringTimeout);
    }

    return {
        hangup: () => __caller_ringing[cid] ? __caller_ringing[cid](false) : closeRTC.call(this, { cid }),
        connection: new Promise(resolve => {
            __caller_ringing[cid] = ((proceed: boolean) => {
                clearTimeout(st.ringTimer);
                delete __caller_ringing[cid];
                this.log('receiver picked up the call', cid, proceed);
                if (!proceed) {
                    closeRTC.call(this, { cid });
                    return null;
                }
                resolve(resolved.call(this, cid));
            }).bind(this);
        })
    }
}

export function respondRTC(msg: WebSocketMessage): (params: RTCReceiverParams, callback: (e: RTCEvent) => void) => Promise<RTCResolved> {
    return async (params: RTCReceiverParams, callback: (e: RTCEvent) => void): Promise<RTCResolved> => {
        const given = extractFormData(params || {}).data || {};
        const { media: rawMedia, ...rest } = given;

        const checked = validator.Params(rest, {
            ice: v => v,
            icePolicy: v => v,
            receive: v => v,
            encoding: v => v,
            channels: v => v
        });

        let sender = msg.sender_cid;
        let socket: WebSocket = await this.__socket;

        if (!__receiver_ringing[sender]) {
            return null;
        }

        if (typeof callback !== 'function') {
            throw new SkapiError(`Callback is required.`, { code: 'INVALID_PARAMETER' });
        }

        const media = checkMedia(rawMedia);
        const icePolicy = checkIcePolicy(checked.icePolicy);
        const receive = checkReceive(checked.receive);
        const encoding = checkEncoding(checked.encoding);
        const channels = checkChannels(checked.channels, []);
        if (wantsCapture(media)) {
            requireSecureContext();
        }

        // the same option as connectRTC(): both ends need the relay for a relayed call to connect
        const configuration = await iceConfiguration.call(this, checked.ice, icePolicy);

        const fresh = !__peerConnection?.[sender];
        if (fresh) {
            __peerConnection[sender] = new RTCPeerConnection(configuration);
            __peerState[sender] = newState(sender, true, isPlainObject(msg.meta) ? msg.meta : {}, encoding);
        }
        const st = __peerState[sender];

        __rtcEvents[sender] = callback;

        if (!__dataChannel[sender]) {
            __dataChannel[sender] = {};
        }
        watchChannels.call(this, sender);

        try {
            await captureInto.call(this, sender, media);
        }
        catch (err) {
            // the call keeps ringing: the user can try again, or reject it
            if (fresh) {
                discardPeer(sender);
            }
            throw err;
        }
        if (!__receiver_ringing[sender]) {
            // hung up on the other side while the permission prompt was open
            discardPeer(sender);
            return null;
        }
        delete __receiver_ringing[sender];

        st.receive = receive || null;

        for (const option of channels) {
            openChannel.call(this, sender, option);
        }

        peerConnectionHandler.call(this, sender);
        await queueSignal(sender, () => answerSdpOffer.call(this, null, sender));

        socket.send(JSON.stringify(signalEnvelope.call(this, sender, { pickup: this.user.user_id })));

        return resolved.call(this, sender);
    }
}

async function sendIceCandidate(event, recipient) {
    if (!this?.session?.accessToken?.jwtToken) {
        throw new SkapiError('Access token is required.', { code: 'INVALID_PARAMETER' });
    }
    this.log('sendIceCandidate to', recipient);

    let socket: WebSocket = await this.__socket;

    if (!event.candidate) {
        this.log('candidate-end', 'all ice candidates have been sent');
        return;
    }

    // Collect ICE candidates and send them to the remote peer
    let candidate = event.candidate;
    this.log('ice gathering state set to', __peerConnection[recipient]?.iceGatheringState);

    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify(signalEnvelope.call(this, recipient, { candidate })));
    }
}

/* ---- a dropped connection ---- */

function clearRecovery(st: PeerState) {
    if (st.recovery) {
        clearTimeout(st.recovery.wait);
        clearTimeout(st.recovery.deadline);
        st.recovery = null;
    }
}

/** An ICE restart: a new offer with new credentials, so the browsers look for a path again. `counted` is false for the one sent because the socket came back. */
function restartIce(key: string, counted = true) {
    const pc = __peerConnection[key];
    const st = __peerState[key];
    if (!pc || !st || !st.recovery || pc.signalingState === 'closed') {
        return;
    }
    if (counted) {
        st.recovery.restarts++;
    }
    this.log('rtc restart', `ICE restart ${st.recovery.restarts} to "${key}".`);
    sendOffer.call(this, key, {}, { iceRestart: true }).catch(err => this.log('rtc restart', err));
}

/**
 * The connection is down. The first time, the app hears `reconnecting` and the deadline starts.
 * 'disconnected' gets a pause first, since the browser often recovers by itself; 'failed' gets
 * an ICE restart at once, and after the restarts allowed, the call is given up.
 */
function dropped(key: string, state: string) {
    const pc = __peerConnection[key];
    const st = __peerState[key];
    if (!pc || !st || pc.signalingState === 'closed') {
        return;
    }
    if (!st.recovery) {
        st.recovery = { restarts: 0, wait: null, deadline: setTimeout(() => giveUp.call(this, key), RECOVERY_DEADLINE) };
        this.log('rtc reconnecting', `"${key}" is ${state}.`);
        const cb = __rtcEvents[key];
        if (cb) {
            cb({ type: 'reconnecting', target: pc, timestamp: now(), state, iceState: pc.iceConnectionState });
        }
    }
    const r = st.recovery;
    if (state === 'failed') {
        clearTimeout(r.wait);
        r.wait = null;
        if (r.restarts < RECOVERY_RESTARTS) {
            restartIce.call(this, key);
        }
        else {
            giveUp.call(this, key);
        }
    }
    else if (!r.wait && r.restarts === 0) {
        r.wait = setTimeout(() => {
            r.wait = null;
            if (__peerState[key] === st && st.recovery === r && pc.connectionState !== 'connected') {
                restartIce.call(this, key);
            }
        }, RECOVERY_WAIT);
    }
}

/** 'connected' again after a drop. */
function recovered(key: string) {
    const st = __peerState[key];
    if (!st || !st.recovery) {
        return;
    }
    clearRecovery(st);
    this.log('rtc reconnected', key);
    const cb = __rtcEvents[key];
    if (cb) {
        cb({ type: 'reconnected', target: __peerConnection[key], timestamp: now() });
    }
}

/** Nothing brought the connection back: the call ends as lost, on both sides. */
function giveUp(key: string) {
    const st = __peerState[key];
    if (!st || !st.recovery) {
        return;
    }
    clearRecovery(st);
    this.log('rtc lost', key);
    closeRTC.call(this, { cid: key }, true).catch(err => this.log('rtc lost', err)); // raises 'lost', then closes
}

/**
 * The realtime socket is open again, with a new connection id from the server. Every call tells
 * the other side so with an empty signal: it arrives from the new id, naming the call, and the
 * other side's signals come to the new id from then on. A call that is being brought back gets
 * another ICE restart with it, since one sent while the socket was down never arrived. (When both
 * sides' sockets reopen at the same moment, each writes to the other's old id, and the call is
 * lost at the deadline; a new one follows.)
 */
export function resumeCalls() {
    for (const key in __peerState) {
        const st = __peerState[key];
        const pc = __peerConnection[key];
        if (!pc || pc.signalingState === 'closed' || !st.armed) {
            continue;
        }
        if (st.recovery) {
            restartIce.call(this, key, false);
        }
        else {
            postSignal.call(this, key, {});
        }
    }
}

function peerConnectionHandler(key: string) {
    let cb = __rtcEvents[key] || ((v: any) => { });
    let peer = __peerConnection[key];
    const remoteSource = (mid: string | null) => {
        const st = __peerState[key];
        return st && mid !== null && mid !== undefined ? st.remoteSources[mid] : undefined;
    };

    const handlers = {
        ontrack: (event: RTCTrackEvent) => {
            const mid = event.transceiver ? event.transceiver.mid : null;
            cb({
                type: 'track',
                target: peer,
                timeStamp: event.timeStamp,
                streams: event.streams,
                track: event.track,
                source: remoteSource(mid),
                mid
            });
            // what happens to the track later: paused or taken off the call on the other side (mute), back (unmute), gone for good (ended)
            for (const name of ['mute', 'unmute', 'ended']) {
                event.track.addEventListener(name, () => {
                    const fn = __rtcEvents[key];
                    if (fn) {
                        fn({ type: 'track' + name, target: peer, timestamp: now(), track: event.track, streams: event.streams, source: remoteSource(mid), mid });
                    }
                });
            }
        },
        onicecandidate: (event: RTCPeerConnectionIceEvent) => {
            sendIceCandidate.bind(this)(event, key);
            if (event.candidate) {
                cb({
                    type: 'icecandidate',
                    target: peer,
                    timestamp: now(),
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                    usernameFragment: event.candidate.usernameFragment,
                    protocol: event.candidate.protocol,
                    gatheringState: peer.iceGatheringState,
                    connectionState: peer.iceConnectionState
                });
            } else {
                cb({ type: 'icecandidateend', target: peer, timestamp: now() });
            }
        },
        onicecandidateerror: (event: any) => {
            cb({
                type: 'icecandidateerror',
                target: peer,
                timestamp: now(),
                errorCode: event.errorCode,
                errorText: event.errorText,
                url: event.url,
                hostCandidate: event.hostCandidate,
                gatheringState: peer.iceGatheringState,
                connectionState: peer.iceConnectionState
            });
        },
        oniceconnectionstatechange: () => {
            cb({
                type: 'iceconnectionstatechange',
                target: peer,
                timestamp: now(),
                state: peer.iceConnectionState,
                gatheringState: peer.iceGatheringState,
                signalingState: peer.signalingState
            });
        },
        onicegatheringstatechange: () => {
            cb({
                type: 'icegatheringstatechange',
                target: peer,
                timestamp: now(),
                state: peer.iceGatheringState,
                connectionState: peer.iceConnectionState,
                signalingState: peer.signalingState
            });
        },
        onsignalingstatechange: () => {
            cb({
                type: 'signalingstatechange',
                target: peer,
                timestamp: now(),
                state: peer.signalingState,
                connectionState: peer.iceConnectionState,
                gatheringState: peer.iceGatheringState
            });
        },
        onconnectionstatechange: () => {
            cb({
                type: 'connectionstatechange',
                target: peer,
                timestamp: now(),
                state: peer.connectionState,
                iceState: peer.iceConnectionState,
                signalingState: peer.signalingState
            });

            let state = peer.connectionState;
            if (state === 'connected') {
                recovered.call(this, key);
            }
            else if (state === 'disconnected' || state === 'failed') {
                // not the end of the call: the browser, or an ICE restart, brings the connection back more often than not
                dropped.call(this, key, state);
            }
            else if (state === 'closed') {
                closeRTC.bind(this)({ cid: key });
            }
        }
    };

    for (const [event, handler] of Object.entries(handlers)) {
        peer[event] = handler;
    }
}

function handleDataChannel(key: string, dataChannel: RTCDataChannel, storedAs?: string) {
    let cb = __rtcEvents[key] || ((v: any) => { });
    const stored = storedAs || dataChannel.label;

    const events = {
        onmessage: (event) => {
            let msg = {
                type: event.type,
                target: dataChannel,
                timeStamp: event.timeStamp,
                data: event.data,
                lastEventId: event.lastEventId,
                origin: event.origin,
                readyState: dataChannel.readyState,
                bufferedAmount: dataChannel.bufferedAmount,
                label: dataChannel.label
            };
            this.log(`${dataChannel.label}: message`, event.data);
            cb(msg);
        },
        onerror: (event) => {
            let err = {
                type: event.type,
                target: dataChannel,
                timeStamp: event.timeStamp,
                error: event.error?.message,
                errorCode: event.error?.errorDetail,
                readyState: dataChannel.readyState,
                label: dataChannel.label
            };
            this.log(`${dataChannel.label}: error`, event.error?.message);
            cb(err);
        },
        onclose: (event) => {
            let closed = {
                type: event.type,
                target: dataChannel,
                timeStamp: event.timeStamp,
                readyState: dataChannel.readyState,
                label: dataChannel.label,
                id: dataChannel.id
            };
            this.log(`${dataChannel.label}: closed`, null);
            cb(closed);

            if (__dataChannel[key] && __dataChannel[key][stored] === dataChannel) {
                delete __dataChannel[key][stored];
                if (Object.keys(__dataChannel[key]).length === 0) {
                    closeRTC.bind(this)({ cid: key });
                }
            }
        },
        onbufferedamountlow: (event) => {
            let buffer = {
                target: dataChannel,
                bufferedAmount: dataChannel.bufferedAmount,
                bufferedAmountLowThreshold: dataChannel.bufferedAmountLowThreshold,
                type: event.type,
                timeStamp: event.timeStamp,
                label: dataChannel.label
            };
            this.log(`${dataChannel.label}: bufferedamountlow`, dataChannel.bufferedAmount);
            cb(buffer);
        },
        onopen: (event) => {
            this.log('dataChannel', `data channel: "${dataChannel.label}" is open and ready to send messages.`);
            let msg = {
                type: event.type,
                target: dataChannel,
                timeStamp: event.timeStamp,
                readyState: dataChannel.readyState,
                label: dataChannel.label,
                id: dataChannel.id,
                ordered: dataChannel.ordered,
                maxRetransmits: dataChannel.maxRetransmits,
                protocol: dataChannel.protocol
            };
            cb(msg);
        }
    };

    for (const [event, handler] of Object.entries(events)) {
        dataChannel[event] = handler;
    }
}
