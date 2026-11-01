
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { extractFormData } from '../utils/utils';
import { request } from '../utils/network';
import { DatabaseResponse, FetchOptions, RealtimeCallback, WebSocketMessage } from '../Types';
import { answerSdpOffer, receiveIceCandidate, acceptAnswer, discardSignals, queueSignal, __peerConnection, __peerState, __receiver_ringing, closeRTC, respondRTC, __caller_ringing, signalKey, rejectRinging, resumeCalls } from './webrtc';

let __iceWaiters: Array<(v: any) => void> = [];
// The last answer, kept while its credential is valid: a call started later uses it at once.
let __iceCache: { servers: RTCIceServer[]; expires: number | null; at: number } | null = null;

function iceAnswer(v: any): { servers: RTCIceServer[]; expires: number | null } | null {
    return v && Array.isArray(v.servers) && v.servers.length ? { servers: v.servers, expires: typeof v.expires === 'number' ? v.expires : null } : null;
}

/** The cached ICE servers while they are good for at least another minute, else null. */
export function peekIceServers(): { servers: RTCIceServer[]; expires: number | null } | null {
    if (!__iceCache) return null;
    let now = Math.floor(Date.now() / 1000);
    // an answer without an expiry (STUN alone) is kept for an hour
    let until = __iceCache.expires ?? __iceCache.at + 3600;
    return until - 60 > now ? { servers: __iceCache.servers, expires: __iceCache.expires } : null;
}

/**
 * Asks the realtime server for the ICE servers a call should use: Skapi's STUN server and,
 * where the project's region has a relay key configured, the TURN relay with a credential made
 * for this user (valid for hours; `expires` is its unix time). Resolves with null when the
 * server does not answer in time (an older backend, a dropped socket), and the caller falls
 * back to STUN alone, which is what every call used before the relay existed.
 */
export async function requestIceServers(timeoutMs = 2500, sock?: WebSocket): Promise<{ servers: RTCIceServer[]; expires: number | null } | null> {
    let socket: WebSocket = sock || (this.__socket ? await this.__socket : null);
    if (!socket || socket.readyState !== 1 || !this?.session?.accessToken?.jwtToken) {
        return null;
    }
    return new Promise(resolve => {
        let done = false;
        let timer = setTimeout(() => {
            if (done) return;
            done = true;
            __iceWaiters = __iceWaiters.filter(w => w !== settle);
            resolve(null);
        }, timeoutMs);
        let settle = (v: any) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(iceAnswer(v));
        };
        __iceWaiters.push(settle);
        try {
            socket.send(JSON.stringify({ action: 'ice', token: this.session.accessToken.jwtToken }));
        } catch (err) {
            settle(null);
        }
    });
}
import { getJwtToken } from './user';

// let __roomList: {
//     [realTimeGroup: string]: {
//         [sender_id: string]: string[]; // connection id, (single person can have multiple connection id)
//     }
// } = {};

let __current_socket_room: string;

/**
 * The realtime group this connection is currently in, or a falsy value when it is in
 * none.
 *
 * Exported because joinRealtime REPLACES the current group rather than adding to it,
 * so anything that joins a room on the caller's behalf has to be able to check the
 * room is STILL its own before leaving it. Without that check it evicts the app from a
 * room the app joined afterwards, and the app never learns: the leave succeeds and its
 * own messages simply stop arriving.
 */
export function currentSocketRoom(): string {
    return __current_socket_room;
}
let __keepAliveInterval = null;
let closedByIntention = true;
let reconnectAttempts = 0;
let reconnectTimer = null;

const RECONNECT_WAIT = 3000; // before the first attempt after an unexpected close; doubled each time it fails
const RECONNECT_MAX_WAIT = 30000;

// The keep-alive. One ping a minute keeps the socket open (API Gateway closes a socket after 10
// minutes with nothing from the client). A server that answers a ping with {"#pong"} also lets the
// SDK notice a socket that died WITHOUT closing (a phone that changed networks, a laptop that slept),
// which the browser itself may not report for minutes: once a socket has answered one ping, a ping it
// leaves unanswered for PONG_TIMEOUT is a dropped connection. A socket that never answered (a server
// without the answering route) is never timed out, which is how every socket behaved before 2.2.23.
const PING_INTERVAL = 60000;
const PONG_TIMEOUT = 10000;
// Any frame from the server proves the socket alive (see onmessage), so a busy group's socket
// could stay "alive" for ever while its own sends and pings go nowhere (a half-dead connection that
// still receives). This many pings in a row with no pong at all, whatever else arrived, is a drop.
const PONGLESS_PINGS_DEAD = 3;

// API Gateway closes every connection 2 hours after it opened, whatever happens on it. Rather than
// lose the ~3 s between that close and the first reconnect attempt (and whatever was sent in them),
// the SDK opens a fresh socket this long before the cut and switches over: the old one closes on
// its own and nobody notices.
const CONNECTION_LIFETIME = 2 * 60 * 60 * 1000;
const RENEW_BEFORE = 5 * 60 * 1000;
const RENEW_JITTER = 2 * 60 * 1000; // spread, so a fleet that connected together does not renew together

// The reconnect waits (3, 6, 12, 24, 30 s) each get a random addition of up to this share of the
// wait, so every client of a region that went down does not come back in the same second: new
// connections are capped at 500 a second per region.
const RECONNECT_JITTER = 0.5;

// API Gateway's frame size; the message is refused before it is sent, rather than closing the socket.
const MAX_FRAME_BYTES = 32 * 1024;

// OUTGOING GROUPING. A page that posts to its group faster than one message per SEND_WINDOW ms (a
// game sending on every tick, a drawing board on every mouse move) has its messages gathered and
// sent as one, so a flood of 120 sends a second leaves as 10. Every send is one request against the
// region's shared quota and one server run, so this is where the cost of a fast app is decided.
// A message that comes SEND_WINDOW or more after the one before goes at once: a chat, or a game
// that ticks slower than the window, never waits. Grouped messages reach every member in order.
const SEND_WINDOW = 100;

// Sent with joinRoom: this SDK reads grouped join/leave updates ("#presence" frames, see
// presenceNotices). A connection that does not say so keeps getting one notice frame per event.
const REALTIME_PROTOCOL = 2;

// Pings the current socket at once: the tab is back, or the network is. Set by the open socket.
let __pingNow: (() => void) | null = null;

// MESSAGE ORDER. Each broadcast carries a per-sender number (`#seq`), so a receiver can put two
// messages of one sender back in the order they were sent even when the server's fan-out runs
// delivered them swapped (every broadcast is its own run; a quick pair can overtake). A message out
// of order waits up to SEQ_WAIT for the gap to fill, then is delivered anyway (a lost message must
// not block the ones after it). Messages from senders without a number (older SDKs) go straight
// through, as they always did.
const SEQ_WAIT = 1500;
let __sendSeq = 0;
// per sender connection: the next number expected and the messages waiting for it
const __order: { [cid: string]: { next: number; waiting: { [seq: number]: () => void }; timer: any } } = {};

function deliverInOrder(cid: string, seq: number, deliver: () => void) {
    let o = __order[cid];
    if (!o) {
        // the first numbered message from this connection sets the baseline
        o = __order[cid] = { next: seq, waiting: {}, timer: null };
    }
    if (seq < o.next) {
        deliver(); // a late duplicate or something from before a resync: let the app see it
        return;
    }
    o.waiting[seq] = deliver;
    const drain = () => {
        while (o.waiting[o.next]) {
            const d = o.waiting[o.next];
            delete o.waiting[o.next];
            o.next++;
            d();
        }
        if (o.timer) {
            clearTimeout(o.timer);
            o.timer = null;
        }
        const left = Object.keys(o.waiting);
        if (left.length) {
            // a gap: give the missing one SEQ_WAIT to arrive, then skip to what we have
            o.timer = setTimeout(() => {
                o.timer = null;
                o.next = Math.min(...Object.keys(o.waiting).map(Number));
                drain();
            }, SEQ_WAIT);
        }
    };
    drain();
}

function forgetOrder(cid: string) {
    const o = __order[cid];
    if (!o) return;
    clearTimeout(o.timer);
    for (const k of Object.keys(o.waiting).sort((a, b) => Number(a) - Number(b))) {
        o.waiting[Number(k)]();
    }
    delete __order[cid];
}

// OUTGOING GROUPING state (see SEND_WINDOW): the group messages waiting for the window to end.
let __sendQueue: { group: string; items: any[]; timer: any } | null = null;
// when this page last posted to each group (see SEND_WINDOW)
const __lastSendAt: { [group: string]: number } = {};

// Sends held until the group has heard this connection's own USER_JOINED. The server groups join
// notices and sends broadcasts at once, so without this a member's first messages could reach the
// others before they know the member is there (a game would see a move from a player not yet
// listed). Set by joinRealtime, cleared by the notice; a timer clears it too, so a notice that never
// comes (an older server) costs at most JOIN_WAIT of delay.
const JOIN_WAIT = 3000;
let __awaitJoin: { group: string; sends: (() => void)[]; timer: any } | null = null;

function releaseJoin() {
    if (!__awaitJoin) return;
    const a = __awaitJoin;
    __awaitJoin = null;
    clearTimeout(a.timer);
    for (const s of a.sends) s();
}

type PresenceNotice = [WebSocketMessage['code'], string];

function presenceCodes(c: any): PresenceNotice[] {
    switch (c) {
        case 'j':
            return [['USER_JOINED', 'has joined the message group.']];
        case 'l':
            return [['USER_LEFT', 'has left the message group.']];
        case 'd':
            // a disconnect has always been two notices, and pages listen for either
            return [['USER_DISCONNECTED', 'has been disconnected.'], ['USER_LEFT', 'has left the message group.']];
        default:
            return [];
    }
}

/**
 * A "#presence" frame as the notices the callback has always received, in order.
 *
 * The server groups the joins and leaves of a busy group into one frame:
 * {"#presence": [[code, user_id, cid], ...], "#srid": group}, code "j" (joined), "l" (left) or
 * "d" (disconnected). Each event becomes the notice a frame of its own used to carry: same `code`,
 * `message`, `sender`, `sender_cid` and `sender_rid`, so a page needs no change to read them.
 */
function presenceNotices(data: any): WebSocketMessage[] {
    const group = data?.['#srid'] || null;
    const notices: WebSocketMessage[] = [];
    for (const e of data['#presence']) {
        if (!Array.isArray(e)) continue;
        const [c, user_id, cid] = e;
        for (const [code, text] of presenceCodes(c)) {
            notices.push({
                type: 'notice',
                message: `User "${user_id}" ${text}`,
                sender: user_id || null,
                sender_cid: cid ? 'cid:' + cid : null,
                sender_rid: group,
                code
            });
        }
    }
    return notices;
}

/**
 * Another attempt to reopen a socket that closed on its own, after a growing wait. Attempts go on
 * while the page is open and the user is signed in: a network that is down for a minute comes back,
 * and the socket with it. An attempt that fails (no network for the token or the handshake, a
 * handshake the server refused) schedules the next; closeRealtime() ends them.
 */
function scheduleReconnect(cb: RealtimeCallback) {
    if (closedByIntention || reconnectTimer) {
        return;
    }
    if (!this.session) {
        this.log('realtime reconnect', 'No session: not reconnecting.');
        cb({ type: 'error', message: 'Skapi: Realtime connection closed. User login is required.' });
        return;
    }
    reconnectAttempts++;
    const base = Math.min(RECONNECT_MAX_WAIT, RECONNECT_WAIT * Math.pow(2, reconnectAttempts - 1));
    const wait = Math.round(base * (1 + Math.random() * RECONNECT_JITTER));
    this.log('realtime reconnect', `Reconnecting to WebSocket server in ${wait} ms... attempt ${reconnectAttempts}`);
    cb({ type: 'reconnect', message: 'Reconnecting to WebSocket server...' + reconnectAttempts });
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectRealtime.bind(this)(cb, 0, 'reconnect').catch(err => {
            this.log('realtime reconnect', err);
            scheduleReconnect.bind(this)(cb);
        });
    }, wait);
}

async function prepareWebsocket() {
    if (typeof window === 'undefined' || (window as any)._runningInNodeJS) {
        throw new SkapiError('WebSocket is not supported in Node.js environment.', { code: 'NOT_SUPPORTED' });
    }

    // Connect to the WebSocket server
    await this.getProfile();

    if (!this.session) {
        throw new SkapiError(`No access.`, { code: 'INVALID_REQUEST' });
    }

    let r = await this.record_endpoint;

    return new WebSocket(
        r.websocket_private + '?token=' + this.session.accessToken.jwtToken
    );
}


let visibilitychange = null;
let online = null;

export async function closeRealtime(): Promise<void> {
    if (typeof window === 'undefined' || (window as any)._runningInNodeJS) {
        throw new SkapiError('WebSocket is not supported in Node.js environment.', { code: 'NOT_SUPPORTED' });
    }
    closedByIntention = true;
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;
    closeRTC.bind(this)({ close_all: true });

    if (__current_socket_room) {
        joinRealtime.bind(this)({ group: null });
    }

    // __roomList = {};
    reconnectAttempts = 0;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    if (__keepAliveInterval) {
        __keepAliveInterval.terminate();
        __keepAliveInterval = null;
    }

    try {
        if (socket) {
            socket.close();
        }
    }
    catch (e) { }

    window.removeEventListener('visibilitychange', visibilitychange);
    window.removeEventListener('online', online);
    __pingNow = null;
    if (__sendQueue) {
        clearTimeout(__sendQueue.timer);
        __sendQueue = null;
    }
    releaseJoin();
    for (const cid of Object.keys(__order)) forgetOrder(cid);
    this.__socket = null;
    return null;
}

export async function connectRealtime(cb: RealtimeCallback, delay = 50, reconnect?: string): Promise<WebSocket> {
    if (typeof window === 'undefined' || (window as any)._runningInNodeJS) {
        throw new SkapiError('WebSocket is not supported in Node.js environment.', { code: 'NOT_SUPPORTED' });
    }
    if (typeof cb !== 'function') {
        throw new SkapiError(`Callback must be a function.`, { code: 'INVALID_REQUEST' });
    }

    if (reconnect === 'reconnect') {
        if (this.__socket instanceof Promise) {
            let socket = await this.__socket;
            if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
                return this.__socket;
            }
        }
    }

    else if (closedByIntention) {
        // if the connection was closed intentionally, and it's not a reconnect attempt
        visibilitychange = () => {
            if (!document.hidden && !closedByIntention) {
                // the tab is back: a socket that looks open may have died meanwhile, ask it now
                if (__pingNow) __pingNow();
                // a closed one: try now rather than at the end of the wait; a failure keeps the schedule
                connectRealtime.bind(this)(cb, 0, 'reconnect').catch(err => this.log('realtime visibilitychange', err));
            }
        }

        online = () => {
            if (!closedByIntention) {
                // the network is back: the same two checks as a tab coming back
                if (__pingNow) __pingNow();
                connectRealtime.bind(this)(cb, 0, 'reconnect').catch(err => this.log('realtime online', err));
            }
        }

        if (this.__socket instanceof Promise) {
            return this.__socket;
        }
    }

    if (__keepAliveInterval) {
        __keepAliveInterval.terminate();
        __keepAliveInterval = null;
    }

    // The executor runs before the assignment below completes, so the handle it needs
    // to compare against travels in a holder rather than a plain local.
    const mineRef: { value: any } = { value: null };
    this.__socket = new Promise(async (resolve, reject) => {
        // FAILURES HAVE TO REJECT, AND THEY HAVE TO CLEAR `__socket`.
        //
        // This executor used to take only `resolve`, and the only resolve() is inside
        // socket.onopen below. So anything that threw on the way to opening the socket
        // (prepareWebsocket raises "No access" when there is no session, and
        // getJwtToken can throw on a refresh failure) left this promise PENDING FOR
        // EVER, with an unhandled rejection as the only trace. connectRealtime returns
        // early whenever `this.__socket` is set, so every later call, from anywhere in
        // the app, awaited that same dead promise: one failed connect permanently
        // disabled realtime for the page, and reloading was the only cure.
        //
        // Rejecting alone is not enough. The handle has to be dropped too, or the
        // retry inherits the rejected promise and fails identically for ever. Cleared
        // only if it is still OURS: a caller that already started a new connection has
        // replaced it, and nulling that one would strand the new socket instead.
        const failed = (err: any) => {
            if (this.__socket === mineRef.value) this.__socket = null;
            reject(err);
        };
        try {
            await getJwtToken.bind(this)();
        } catch (err) {
            failed(err);
            return;
        }

        setTimeout(async () => {
          try {
            let socket: WebSocket = await prepareWebsocket.bind(this)();
            let opened = false; // onclose before onopen: the handshake failed

            // The keep-alive of THIS socket (see PING_INTERVAL).
            let pongSeen = false; // the server answers pings: from now on an unanswered one means a dead socket
            let pongTimer = null;
            let pingSentAt = 0;
            let ponglessPings = 0; // pings since the last "#pong" (see PONGLESS_PINGS_DEAD)
            let worker: Worker = null;
            let renewTimer = null;

            const stopPinging = () => {
                clearTimeout(pongTimer);
                pongTimer = null;
                clearTimeout(renewTimer);
                renewTimer = null;
                if (worker) {
                    worker.terminate();
                    if (__keepAliveInterval === worker) __keepAliveInterval = null;
                    worker = null;
                }
                if (__pingNow === ping) __pingNow = null;
            };

            const ping = () => {
                if (socket.readyState !== 1) return;
                try {
                    socket.send(JSON.stringify({ action: 'keepAlive' }));
                } catch (e) {
                    return;
                }
                if (pongSeen) {
                    ponglessPings++;
                    if (ponglessPings >= PONGLESS_PINGS_DEAD) {
                        // other frames may still arrive, but nothing we send comes back: dead
                        dropSocket('No answer to several keep-alives in a row: the connection is dropped.');
                        return;
                    }
                    if (!pongTimer) {
                        pingSentAt = Date.now();
                        pongTimer = setTimeout(noPong, PONG_TIMEOUT);
                    }
                }
            };

            // The socket died without closing (see noPong and PONGLESS_PINGS_DEAD): let it go quietly
            // (its own close event, whenever the browser gets to it, must not schedule a second
            // reconnect) and take the path of an unexpected close.
            const dropSocket = (why: string) => {
                this.log('realtime keepalive', why);
                stopPinging();
                socket.onopen = null;
                socket.onmessage = null;
                socket.onclose = null;
                socket.onerror = null;
                try {
                    socket.close();
                } catch (e) { }
                cb({ type: 'error', message: 'Skapi: WebSocket unexpected close.' });
                scheduleReconnect.bind(this)(cb);
            };

            const noPong = () => {
                pongTimer = null;
                if (closedByIntention || socket.readyState !== 1) return;
                if (Date.now() - pingSentAt > PONG_TIMEOUT * 3) {
                    // The timer ran far too late: the page was frozen in the background, and the
                    // answer may be waiting in the queue. Ask again rather than give the socket up.
                    ping();
                    return;
                }
                // No answer from a socket that answered before (and nothing else arrived either).
                dropSocket('No answer to the keep-alive: the connection is dropped.');
            };

            // The planned switch to a fresh socket before API Gateway's 2-hour cut (CONNECTION_LIFETIME).
            // A new connection is opened while this one still works; once it is open the room is joined
            // again and this one is closed deliberately, so the app sees no gap. Not announced as a
            // reconnect: nothing was lost.
            const renew = () => {
                renewTimer = null;
                if (closedByIntention || socket.readyState !== 1 || this.__socket !== mineRef.value) return;
                this.log('realtime renew', 'Opening a fresh connection before the 2-hour limit.');
                const old = socket;
                this.__socket = null; // so connectRealtime opens a new one instead of returning this
                connectRealtime.bind(this)(cb, 0, 'renew').then(() => {
                    // the new socket is open and joined: this one may go, quietly
                    old.onclose = null;
                    old.onerror = null;
                    stopPinging();
                    try {
                        old.close();
                    } catch (e) { }
                }).catch(err => {
                    // could not open a new one: keep this socket; its natural close reconnects as usual
                    this.log('realtime renew', err);
                    if (!this.__socket) this.__socket = mineRef.value;
                });
            };

            socket.onopen = () => {
                opened = true;
                closedByIntention = false;
                reconnectAttempts = 0;
                clearTimeout(reconnectTimer);
                reconnectTimer = null;

                if (reconnect !== 'reconnect' && reconnect !== 'renew') {
                    window.addEventListener('visibilitychange', visibilitychange);
                    window.addEventListener('online', online);
                }

                this.log('realtime onopen', 'Connected to WebSocket server.');
                if (reconnect !== 'renew') {
                    cb({ type: 'success', message: 'Connected to WebSocket server.' });
                }

                // a new connection id: the order baselines of the old one do not apply
                for (const cid of Object.keys(__order)) forgetOrder(cid);

                if (__current_socket_room) {
                    socket.send(JSON.stringify({
                        action: 'joinRoom',
                        rid: __current_socket_room,
                        token: this.session.accessToken.jwtToken,
                        ver: REALTIME_PROTOCOL
                    }));
                }

                renewTimer = setTimeout(renew, CONNECTION_LIFETIME - RENEW_BEFORE - Math.random() * RENEW_JITTER);

                // The ICE servers for calls, asked for now so a call started later finds
                // them cached: a relay answer can take a second or two when the server is
                // cold, which a call should not wait for.
                requestIceServers.bind(this)(5000, socket).catch(() => null);

                // Keep alive. The clock runs in a Worker because a background tab slows the page's
                // own timers down; the first tick is at once, so the first answer (and with it
                // whether the server answers at all) arrives right after opening.
                const workerScript = /*js*/`
                    let interval = ${PING_INTERVAL};

                    function runInterval() {
                        postMessage({ type: "ping" });
                        setTimeout(runInterval, interval); // Use setTimeout instead of setInterval
                    }

                    runInterval(); // Start interval
                `;

                // Create a Blob URL for the worker
                const blob = new Blob([workerScript], { type: "application/javascript" });
                worker = new Worker(URL.createObjectURL(blob));
                __keepAliveInterval = worker;
                worker.onmessage = ping;
                __pingNow = ping;

                resolve(socket);

                if (reconnect === 'reconnect') {
                    // the calls that went on while the socket was down: they signal through this socket now
                    resumeCalls.call(this);
                }
            };

            socket.onmessage = (event) => {
                // ANY frame from the server proves the socket alive, not only the "#pong" a ping
                // asked for: an overloaded region may throttle a ping and its answer while messages
                // still flow, and every client of that region taking its socket for dead at the same
                // moment would reconnect into the overload all at once. Only "#pong" arms the
                // deadline (pongSeen), so a server that never answers pings still never times out.
                clearTimeout(pongTimer);
                pongTimer = null;

                let data: any = '';

                try {
                    data = JSON.parse(decodeURI(event.data));
                    this.log('socket onmessage', data);
                }
                catch (e) {
                    return;
                }

                readFrame(data);
            };

            // One frame from the server. A "#batch" frame comes back through here once for each
            // message it carries, so a batched message reaches the callback exactly as if it had
            // come in a frame of its own.
            const readFrame = (data: any) => {
                if (data?.['#pong'] !== undefined) {
                    // the answer to a keep-alive: not a message for the app
                    pongSeen = true;
                    ponglessPings = 0;
                    clearTimeout(pongTimer);
                    pongTimer = null;
                    return;
                }

                if (Array.isArray(data?.['#presence'])) {
                    // grouped joins and leaves: one callback per event, as if each had its own frame
                    for (const notice of presenceNotices(data)) {
                        noticeSeen(notice);
                        try {
                            cb(notice);
                        } catch (err) {
                            // a callback that throws must not cost the notices after it
                            setTimeout(() => { throw err; });
                        }
                    }
                    return;
                }

                if (Array.isArray(data?.['#batch'])) {
                    // A busy group's messages, sent together by the server (one frame per member
                    // per window instead of one per message): each one, in order, as if alone.
                    for (const entry of data['#batch']) {
                        if (!entry || typeof entry !== 'object') continue;
                        try {
                            readFrame(entry);
                        } catch (err) {
                            // a callback that throws must not cost the messages after it
                            setTimeout(() => { throw err; });
                        }
                    }
                    return;
                }

                let type;
                switch (true) {
                    case !!data?.['#message']:
                        type = 'message';
                        break;
                    case !!data?.['#private']:
                        type = 'private';
                        break;
                    case !!data?.['#notice']:
                        type = 'notice';
                        break;
                    case !!data?.['#rtc']:
                        type = 'rtc';
                        break;
                    case !!data?.['#error']:
                        type = 'error';
                        break;
                    case !!data?.['#ice']:
                        type = 'ice';
                        break;
                }

                if (!type) {
                    // API Gateway answers an action the deployed handler does not know (an
                    // older backend asked for "ice") with its own error object: settle the
                    // waiters now with "no relay here" instead of letting them time out.
                    if (data?.requestId && data?.connectionId && __iceWaiters.length) {
                        let waiters = __iceWaiters.splice(0);
                        for (let w of waiters) {
                            w(null);
                        }
                    }
                    return;
                }

                if (type === 'ice') {
                    // the answer to requestIceServers(): not a message for the app
                    let answer = iceAnswer(data['#ice']);
                    if (answer) __iceCache = { ...answer, at: Math.floor(Date.now() / 1000) };
                    let waiters = __iceWaiters.splice(0);
                    for (let w of waiters) {
                        w(data['#ice']);
                    }
                    return;
                }

                let msg: WebSocketMessage = {
                    type,
                    message: data?.['#rtc'] || data?.['#message'] || data?.['#private'] || data?.['#notice'] || data?.['#error'] || null,
                    sender: data?.['#user_id'] || null,
                    sender_cid: !!data?.['#scid'] ? "cid:" + data['#scid'] : null,
                    sender_rid: data?.['#srid'] || null,
                    code: data?.['#code'] || null
                };

                if (type === 'message' && typeof data?.['#seq'] === 'number' && msg.sender_cid) {
                    // a numbered broadcast: delivered in its sender's order (see SEQ_WAIT)
                    deliverInOrder(msg.sender_cid, data['#seq'], () => deliverMessage(msg));
                    return;
                }

                if (type === 'message') {
                    deliverMessage(msg);
                    return;
                }

                if (type === 'notice') {
                    noticeSeen(msg);
                }

                if (type === 'notice') {
                    // if (__current_socket_room && (msg.code === 'USER_LEFT' || msg.code === 'USER_DISCONNECTED')) {
                    //     let user_id = msg.sender;
                    //     if (__roomList?.[__current_socket_room]?.[user_id]) {
                    //         __roomList[__current_socket_room][user_id] = __roomList[__current_socket_room][user_id].filter(v => v !== msg.sender_cid);
                    //     }

                    //     if (__roomList?.[__current_socket_room]?.[user_id] && __roomList[__current_socket_room][user_id].length === 0) {
                    //         delete __roomList[__current_socket_room][user_id];
                    //     }

                    //     if (__roomList?.[__current_socket_room]?.[user_id]) {
                    //         // user is still in the group don't call the callback
                    //         return
                    //     }
                    // }
                    // else if (__current_socket_room && msg.code === 'USER_JOINED') {
                    //     let user_id = msg.sender;
                    //     if (!__roomList?.[__current_socket_room]) {
                    //         __roomList[__current_socket_room] = {};
                    //     }
                    //     if (!__roomList[__current_socket_room][user_id]) {
                    //         __roomList[__current_socket_room][user_id] = [msg.sender_cid];
                    //     }
                    //     else {
                    //         if (!__roomList[__current_socket_room][user_id].includes(msg.sender_cid)) {
                    //             __roomList[__current_socket_room][user_id].push(msg.sender_cid);
                    //         }
                    //         return;
                    //     }
                    // }
                    cb(msg);
                }
                else if (type === 'rtc') {
                    // rtc signaling
                    if (msg.sender !== this.user.user_id) {
                        let rtc = msg.message;
                        // The call the signal is for: keyed by the other side's connection id when the call
                        // started. A signal that names the call (`call`) finds it even from a connection id
                        // this side has never seen (the other side's socket reconnected).
                        const key = signalKey.call(this, msg.sender_cid, rtc);
                        const named = typeof rtc.call === 'string' && !!rtc.call;
                        const ours = (id: string) => !named || id === rtc.call; // a named signal acts on its own call only, never on a later one from the same connection
                        if (rtc.hungup) {
                            // otherside has hung up the call
                            let acted = false;
                            if (__caller_ringing[key] && ours(__peerState[key]?.callId)) {
                                __caller_ringing[key](false);
                                delete __caller_ringing[key];
                                acted = true;
                            }
                            if (__receiver_ringing[key] && ours(__receiver_ringing[key])) {
                                delete __receiver_ringing[key];
                                acted = true;
                            }
                            if (__peerConnection?.[key] && ours(__peerState[key]?.callId)) {
                                closeRTC.bind(this)({ cid: key }, !!rtc.lost);
                                acted = true;
                            }
                            else if (!__peerConnection?.[key]) {
                                // a call that was never answered here: its offer must not be answered with the next call's
                                discardSignals(key, named ? rtc.call : undefined);
                            }
                            if (acted || !named) {
                                msg.type = 'rtc:closed';
                                cb(msg);
                            }
                            return;
                        }
                        if (rtc.candidate) {
                            queueSignal(key, () => receiveIceCandidate.bind(this)(rtc.candidate, key)).catch(err => this.log('rtc candidate', err));
                        }
                        if (rtc.sdpoffer) {
                            if (__peerConnection?.[key]) {
                                // a call in progress: the other side added or removed a track, or a channel, or restarts ICE. Answer it.
                                queueSignal(key, () => answerSdpOffer.bind(this)(rtc, key)).catch(err => this.log('rtc offer', err));
                            }
                            else {
                                queueSignal(key, () => answerSdpOffer.bind(this)(rtc, key)).catch(err => this.log('rtc offer', err)); // kept until the call is answered
                                if (!__receiver_ringing[key]) {
                                    __receiver_ringing[key] = named ? rtc.call : key; // the call's name while it rings, so only its own hang-up ends the ringing
                                    delete msg.message;

                                    // what the caller said about the call, and what it is sending, readable before answering
                                    msg.meta = rtc.meta && typeof rtc.meta === 'object' && !Array.isArray(rtc.meta) ? rtc.meta : {};
                                    msg.sources = rtc.sources && typeof rtc.sources === 'object' ? Array.from(new Set(Object.values(rtc.sources).filter(v => typeof v === 'string'))) as string[] : [];

                                    msg.connectRTC = respondRTC.bind(this)(msg);
                                    msg.type = 'rtc:incoming';
                                    msg.hangup = (() => {
                                        if (__peerConnection[key]) {
                                            closeRTC.bind(this)({ cid: key });
                                        }
                                        else if (__receiver_ringing[key]) {
                                            rejectRinging.call(this, key);
                                        }
                                    }).bind(this);

                                    cb(msg);
                                }
                            }
                        }
                        if (rtc.pickup) {
                            // receiver has answered the call
                            if (__caller_ringing[key] && ours(__peerState[key]?.callId)) {
                                __caller_ringing[key](true);
                                delete __caller_ringing[key];
                            }
                        }
                        if (rtc.sdpanswer) {
                            // the other side's answer to an offer of ours: the first one, a renegotiation, or an ICE restart
                            queueSignal(key, () => acceptAnswer.bind(this)(rtc, key)).catch(err => this.log('rtc answer', err));
                        }
                    }
                }
                else {
                    cb(msg);
                }
            };

            // A group message for the app. A message the sender grouped (SEND_WINDOW) carries several
            // under `__skapi_batch`; each reaches the callback on its own, in order, as a message of
            // its own with the same sender fields.
            const deliverMessage = (msg: WebSocketMessage) => {
                const payload = msg.message;
                if (payload && typeof payload === 'object' && Array.isArray(payload.__skapi_batch)) {
                    for (const one of payload.__skapi_batch) {
                        try {
                            cb({ ...msg, message: one });
                        } catch (err) {
                            setTimeout(() => { throw err; });
                        }
                    }
                    return;
                }
                cb(msg);
            };

            // A join or leave notice. The connection's own USER_JOINED releases the sends held since
            // joinRealtime (see JOIN_WAIT); a member that left is forgotten by the order keeper.
            const noticeSeen = (notice: WebSocketMessage) => {
                if (notice.code === 'USER_JOINED' && __awaitJoin && notice.sender_rid === __awaitJoin.group && notice.sender === this.user?.user_id) {
                    releaseJoin();
                }
                if ((notice.code === 'USER_LEFT' || notice.code === 'USER_DISCONNECTED') && notice.sender_cid) {
                    forgetOrder(notice.sender_cid);
                }
            };

            socket.onclose = () => {
                stopPinging();
                if (closedByIntention && opened) {
                    this.log('realtime onclose', 'WebSocket connection closed.');
                    cb({ type: 'close', message: 'WebSocket connection closed.' });
                }
                else if (closedByIntention) {
                    // closeRealtime() before the first socket ever opened, or the handshake of the first one failed
                    this.log('realtime onclose', 'WebSocket closed before it opened.');
                    failed(new SkapiError('WebSocket closed before it opened.', { code: 'INVALID_REQUEST' }));
                    cb({ type: 'error', message: 'Skapi: WebSocket connection failed.' });
                }
                else {
                    if (!opened) {
                        // a reconnect whose handshake failed: settle this attempt so the next one starts fresh
                        this.log('realtime onclose', 'WebSocket closed before it opened.');
                        failed(new SkapiError('WebSocket closed before it opened.', { code: 'INVALID_REQUEST' }));
                    }
                    else {
                        this.log('realtime onclose', 'WebSocket unexpected close.');
                        cb({ type: 'error', message: 'Skapi: WebSocket unexpected close.' });
                    }
                    scheduleReconnect.bind(this)(cb);
                }
            };

            socket.onerror = () => {
                this.log('realtime onerror', 'WebSocket connection error.');
                cb({ type: 'error', message: 'Skapi: WebSocket connection error.' });
            };
          } catch (err) {
            // Anything thrown on the way to an OPEN socket: no session, a rejected
            // handshake, a blocked url. Reject and drop the handle so the next call
            // opens a fresh one instead of awaiting this corpse for ever.
            failed(err);
          }
        }, delay);
    });
    // Captured AFTER assignment so `failed` can tell "still mine" from "someone else
    // replaced it while I was connecting".
    mineRef.value = this.__socket;
    return this.__socket;
}


export async function postRealtime(message: any, recipient: string, notification?: { config?: { always: boolean; }; title: string; body: string; }): Promise<{ type: 'success', message: 'Message sent.' }> {
    if (typeof window === 'undefined' || (window as any)._runningInNodeJS) {
        throw new SkapiError('WebSocket is not supported in Node.js environment.', { code: 'NOT_SUPPORTED' });
    }
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    if (!recipient) {
        throw new SkapiError(`No recipient.`, { code: 'INVALID_REQUEST' });
    }

    await getJwtToken.bind(this)();

    message = extractFormData(message).data;

    let notificationStr = '';
    if (notification) {
        notification = validator.Params(
            notification,
            {
                config: {
                    always: 'boolean'
                },
                title: 'string',
                body: 'string'
            },
            ['title', 'body']
        );
        // stringify notification and check if size exceeds 3kb
        notificationStr = JSON.stringify({ title: notification.title, body: notification.body });
        let notificationSize = new Blob([notificationStr]).size;
        if (notificationSize > 3072) {
            throw new SkapiError(`Notification size exceeds 3kb.`, { code: 'INVALID_PARAMETER' });
        }
    }

    if (socket.readyState === 1) {
        const token = `IdT:${this.service}:${this.owner}:` + (this.bearerToken || this.session?.idToken?.jwtToken || 'null');
        let isUser = true;
        try {
            validator.UserId(recipient);
        } catch (err) {
            isUser = false;
        }

        if (isUser) {
            const frame = JSON.stringify({
                action: 'sendMessage',
                uid: recipient,
                content: message,
                notification: notificationStr,
                notificationConfig: notification?.config || {},
                token
            });
            checkFrameSize(frame);
            socket.send(frame);
            return { type: 'success', message: 'Message sent.' };
        }

        if (__current_socket_room !== recipient) {
            throw new SkapiError(`User has not joined to the recipient group. Run joinRealtime({ group: "${recipient}" })`, { code: 'INVALID_REQUEST' });
        }

        // The frame as it would go alone: refused now if too big, whatever grouping does with it.
        const alone = JSON.stringify({ action: 'broadcast', rid: recipient, content: message, notification: notificationStr, notificationConfig: notification?.config || {}, token, '#seq': 0 });
        checkFrameSize(alone);

        const send = (content: any) => {
            const frame = JSON.stringify({
                action: 'broadcast',
                rid: recipient,
                content,
                notification: notificationStr,
                notificationConfig: notification?.config || {},
                token,
                seq: __sendSeq++
            });
            if (socket.readyState !== 1) return;
            try {
                socket.send(frame);
            } catch (err) {
                this.log('postRealtime:send', err);
            }
        };

        const queueSend = () => {
            if (notification) {
                // a message with a notification is never grouped: its notification is its own
                send(message);
                return;
            }
            const now = Date.now();
            if (__sendQueue && __sendQueue.group === recipient) {
                // a window is open: this one goes with it
                __sendQueue.items.push(message);
                return;
            }
            if (__sendQueue) {
                flushSendQueue(send); // a different group: what waits for the old one goes now
            }
            const sinceLast = now - (__lastSendAt[recipient] || 0);
            __lastSendAt[recipient] = now;
            if (sinceLast >= SEND_WINDOW) {
                // not a flood: at once, as always
                send(message);
                return;
            }
            // Sends are coming faster than one per window: gather them.
            __sendQueue = {
                group: recipient,
                items: [message],
                timer: setTimeout(() => flushSendQueue(send), SEND_WINDOW)
            };
        };

        if (__awaitJoin && __awaitJoin.group === recipient) {
            // the group has not heard this connection's own join yet (see JOIN_WAIT)
            __awaitJoin.sends.push(queueSend);
        } else {
            queueSend();
        }

        return { type: 'success', message: 'Message sent.' };
    }

    throw new SkapiError('Realtime connection is not open. Try reconnecting with connectRealtime().', { code: 'INVALID_REQUEST' });
}

function flushSendQueue(send: (content: any) => void) {
    if (!__sendQueue) return;
    const q = __sendQueue;
    __sendQueue = null;
    clearTimeout(q.timer);
    __lastSendAt[q.group] = Date.now();
    if (q.items.length === 1) {
        send(q.items[0]);
        return;
    }
    // Several messages as one frame. The receiving SDK hands each to the callback on its own
    // (deliverMessage); a frame that would be too big is split.
    let items = q.items;
    while (items.length) {
        let n = items.length;
        while (n > 1 && JSON.stringify({ __skapi_batch: items.slice(0, n) }).length > MAX_FRAME_BYTES - 2048) {
            n = Math.ceil(n / 2);
        }
        send(n === 1 ? items[0] : { __skapi_batch: items.slice(0, n) });
        items = items.slice(n);
    }
}

function checkFrameSize(frame: string) {
    const size = new Blob([frame]).size;
    if (size > MAX_FRAME_BYTES) {
        throw new SkapiError(`Message is ${size} bytes; a realtime message can be at most ${MAX_FRAME_BYTES} bytes including its headers.`, { code: 'INVALID_PARAMETER' });
    }
}

export async function joinRealtime(params: { group?: string | null }): Promise<{ type: 'success', message: string }> {
    if (typeof window === 'undefined' || (window as any)._runningInNodeJS) {
        throw new SkapiError('WebSocket is not supported in Node.js environment.', { code: 'NOT_SUPPORTED' });
    }
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    await getJwtToken.bind(this)();
    params = extractFormData(params, { nullIfEmpty: true }).data;

    let { group = null } = params;
    if (!group && !__current_socket_room) {
        return { type: 'success', message: 'Left realtime message group.' }
    }

    if (group !== null && typeof group !== 'string') {
        throw new SkapiError(`"group" must be a string | null.`, { code: 'INVALID_PARAMETER' });
    }

    // GUARDED, the way postRealtime's send at :437 already is. A socket that has
    // closed under us (a dropped connection, a tab resumed after a sleep, a caller
    // tidying up on the way out) throws "WebSocket is already in CLOSING or CLOSED
    // state" from send, which surfaces as an unhandled error from what is otherwise a
    // successful teardown. There is nothing to say to a closed socket in either
    // direction: a join it cannot receive is not a join, and a LEAVE is already true
    // of a connection that is gone, so the room state below is updated either way and
    // the next connectRealtime re-joins from it.
    if (__sendQueue) {
        flushSendQueue(() => null); // what waited for the old group is dropped: it is left
    }
    releaseJoin();

    if (socket.readyState === 1) {
        socket.send(JSON.stringify({
            action: 'joinRoom',
            rid: group,
            token: this.session.accessToken.jwtToken,
            ver: REALTIME_PROTOCOL
        }));
        if (group) {
            // the first sends wait for the group to hear this connection's join (JOIN_WAIT)
            __awaitJoin = { group, sends: [], timer: setTimeout(releaseJoin, JOIN_WAIT) };
        }
    }

    __current_socket_room = group;

    return { type: 'success', message: group ? `Joined realtime message group: "${group}".` : 'Left realtime message group.' }
}

export async function getRealtimeUsers(params: { group: string, user_id?: string }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<{ user_id: string; cid: string }[]>> {
    params = validator.Params(
        params,
        {
            user_id: (v: string) => validator.UserId(v, 'User ID in "user_id"'),
            group: ['string', () => {
                if (!__current_socket_room) {
                    throw new SkapiError(`No group has been joined. Otherwise "group" is required.`, { code: 'INVALID_REQUEST' });
                }
                return __current_socket_room;
            }]
        }
    );

    let res = await request.bind(this)(
        'get-ws-group',
        params,
        {
            fetchOptions,
            auth: true,
            method: 'post'
        }
    );

    res.list = res.list.map((v: any) => {
        let user_id = v.uid.split('#')[1];
        // if (!params.user_id) {
        //     if (!__roomList[params.group]) {
        //         __roomList[params.group] = {};
        //     }
        //     if (!__roomList[params.group][user_id]) {
        //         __roomList[params.group][user_id] = [v.cid];
        //     }
        //     else if (!__roomList[params.group][user_id].includes(v.cid)) {
        //         __roomList[params.group][user_id].push(v.cid);
        //     }
        // }

        return {
            user_id,
            cid: "cid:" + v.cid
        }
    });

    return res;
}

export async function getRealtimeGroups(
    params?: {
        /** Index name to search. */
        searchFor: 'group' | 'number_of_users';
        /** Index value to search. */
        value?: string | number;
        /** Search condition. */
        condition?: '>' | '>=' | '=' | '<' | '<=' | '!=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte' | 'ne';
        /** Range of search. */
        range?: string | number;
    } | null,
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse<{ group: string; number_of_users: number; }>> {
    await this.__connection;

    if (!params) {
        params = { searchFor: 'group', value: ' ', condition: '>' };
    }

    params = validator.Params(
        params,
        {
            searchFor: ['group', 'number_of_users', () => 'group'],
            value: ['string', 'number', () => {
                if (params?.searchFor && params?.searchFor === 'number_of_users') {
                    return 0;
                }

                return ' ';
            }],
            condition: ['>', '>=', '=', '<', '<=', '!=', 'gt', 'gte', 'eq', 'lt', 'lte', 'ne'],
            range: ['string', 'number']
        }
    );

    if (!params.condition) {
        if (params.value === ' ' || !params.value) {
            params.condition = '>';
        }
        else {
            params.condition = '=';
        }
    }

    if (params.range && params.condition) {
        delete params.condition;
    }

    if (params.searchFor === 'number_of_users' && typeof params.value !== 'number') {
        throw new SkapiError(`"value" must be a number.`, { code: 'INVALID_PARAMETER' });
    }
    if (params.searchFor === 'group' && typeof params.value !== 'string') {
        throw new SkapiError(`"value" must be a string.`, { code: 'INVALID_PARAMETER' });
    }
    if (params.hasOwnProperty('range') && typeof params.range !== typeof params.value) {
        throw new SkapiError(`"range" must be a ${typeof params.value}.`, { code: 'INVALID_PARAMETER' });
    }

    let res = await request.bind(this)(
        'get-ws-group',
        params,
        {
            fetchOptions,
            auth: true,
            method: 'post'
        }
    )

    res.list = res.list.map((v: any) => {
        return {
            group: v.rid.split('#')[1],
            number_of_users: v.cnt
        }
    });

    return res;
}