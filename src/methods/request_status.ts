/**
 * Request status push: the server tells this client when one of its forwarded requests
 * changes status, so polls can run slowly and check at once when something happened.
 *
 * A request dispatched with `notify: true` is stamped server side with the caller's
 * connection address. From then on every status change of it (pending, running, resolved,
 * failed, cancelled) arrives on the SDK's websocket as one private frame:
 *
 *     {"#private": {"v": 1, "ev": [{ id, q, s, p, t, att }, ...]}, "#code": "CSR_STATUS"}
 *
 * The frame is a HINT and never an outcome. A poll that a frame names reads the row at once,
 * and the row is what settles it. So a frame that is lost (the socket was down, the laptop
 * slept), late, duplicated, or forged costs at most one read or one slow interval, never a
 * wrong answer. A frame sent by a user carries "#user_id" (ws/default sets it on every
 * private message), so a frame without one can only have come from the server.
 *
 * What it does to the shared connection follows the realtime relay's rules (request.ts
 * startRealtimeRelay): frames are read with addEventListener on the socket, so the app's own
 * realtime callback is untouched; a socket is opened only when none exists and there is a
 * session; and only a socket this module opened is ever closed by it, and only while no room
 * is joined on it.
 */
import { connectRealtime, closeRealtime, currentSocketRoom } from './realtime';

/** One status change, as onRequestStatus hands it over. */
export type RequestStatusEvent = {
	type: 'status';
	/** The request id the dispatch reply handed back ("stamp:entropy"). */
	id: string;
	/** The queue the request is on. */
	queue?: string;
	status: 'pending' | 'running' | 'resolved' | 'failed' | 'cancelled' | string;
	/** The status before this change. Absent when the request was just created. */
	previous?: string;
	/** When the row changed, in milliseconds. */
	updated?: number;
	/** When the server began executing the request, in milliseconds. */
	executed?: number;
};

/**
 * The connection the frames ride on came up ('connected': first open, a reconnect after a
 * drop, the planned renewal) or went away ('disconnected'). Frames sent while it was away
 * are lost, so on 'connected' a listener should re-read whatever it shows.
 */
export type RequestStatusConnectionEvent = { type: 'connected' | 'disconnected' };

export type RequestStatusCallback = (event: RequestStatusEvent | RequestStatusConnectionEvent) => void;

/**
 * While frames are arriving, a poll of a request dispatched with `notify` reads the row
 * only this often on its own (a heartbeat), and otherwise only when a frame names it.
 */
export const STATUS_PUSH_IDLE_POLL_MS = 60 * 1000;

/** How long the socket this module opened stays open after the last holder let go. */
const STATUS_PUSH_LINGER_MS = 10 * 60 * 1000;

/** How soon to look again for a socket to listen on after the one in use went away. */
const STATUS_PUSH_REATTACH_MS = 3000;

const wakers: Map<string, Set<() => void>> = new Map();
const listeners: Set<RequestStatusCallback> = new Set();

const push = {
	holders: 0,
	/** The server accepted `notify` at least once: frames can exist for this client. */
	acked: false,
	/** The socket the listener is on. */
	socket: null as WebSocket | null,
	/** The socket this module opened, and so may close. */
	opened: null as WebSocket | null,
	/** A frame arrived on the current socket since it was attached. */
	frameSeen: false,
	attaching: false,
	retryTimer: null as any,
	lingerTimer: null as any,
	skapi: null as any,
};

/** "stamp:entropy" from any form of a request id (a composed id ends with it). */
export function shortRequestId(id: string): string {
	if (typeof id !== 'string') return '';
	let parts = id.split(':');
	return parts.length >= 2 ? parts[parts.length - 2] + ':' + parts[parts.length - 1] : id;
}

/** The server acknowledged `notify` on a dispatch. */
export function noteStatusPushAck(): void {
	push.acked = true;
}

/**
 * True while status frames are known to be arriving: the server accepted `notify`, the
 * listener is on an open socket, and at least one frame came in on that socket. Only then
 * may a poll slow down; a missing push path never costs anyone speed.
 */
export function statusPushWarm(): boolean {
	return push.acked && !!push.socket && push.socket.readyState === 1 && push.frameSeen;
}

/** Run `wake` whenever a frame names this request. Returns the unregister. */
export function addStatusWaker(id: string, wake: () => void): () => void {
	let key = shortRequestId(id);
	let set = wakers.get(key);
	if (!set) {
		set = new Set();
		wakers.set(key, set);
	}
	set.add(wake);
	return () => {
		let s = wakers.get(key);
		if (!s) return;
		s.delete(wake);
		if (!s.size) wakers.delete(key);
	};
}

/**
 * The relay is done with a socket IT opened. When status push is in use the socket is
 * handed over instead of closed, so the frames keep coming; this module closes it later,
 * once nobody holds it. Returns true when it took the socket.
 */
export function adoptStatusPushSocket(socket: WebSocket): boolean {
	if (push.holders === 0 || !socket || push.socket !== socket) return false;
	push.opened = socket;
	return true;
}

function emit(event: RequestStatusEvent | RequestStatusConnectionEvent) {
	listeners.forEach((cb) => {
		try {
			cb(event);
		} catch (err) {
			// a listener that throws must not cost the others their event
			setTimeout(() => { throw err; });
		}
	});
}

function parseFrame(raw: any): any {
	if (typeof raw !== 'string') return null;
	try {
		return JSON.parse(raw);
	} catch (e) {
		try {
			return JSON.parse(decodeURI(raw));
		} catch (e2) {
			return null;
		}
	}
}

/** True for a frame that is a server status push (and so not the app's business). */
export function isStatusPushFrame(data: any): boolean {
	return !!data && data['#code'] === 'CSR_STATUS' && !!data['#private'] && !data['#user_id'];
}

function onMessage(ev: any) {
	let data = parseFrame(ev?.data);
	if (!isStatusPushFrame(data)) return;
	let body = data['#private'];
	if (typeof body === 'string') {
		try {
			body = JSON.parse(body);
		} catch (e) {
			return;
		}
	}
	let list = Array.isArray(body?.ev) ? body.ev : [];
	if (ev?.target && ev.target === push.socket) push.frameSeen = true;
	for (let e of list) {
		if (!e || typeof e.id !== 'string' || typeof e.s !== 'string') continue;
		let event: RequestStatusEvent = { type: 'status', id: e.id, status: e.s };
		if (typeof e.q === 'string') event.queue = e.q;
		if (typeof e.p === 'string') event.previous = e.p;
		if (typeof e.t === 'number') event.updated = e.t;
		if (typeof e.att === 'number') event.executed = e.att;
		let set = wakers.get(e.id);
		if (set) {
			Array.from(set).forEach((wake) => {
				try {
					wake();
				} catch (err) {
					setTimeout(() => { throw err; });
				}
			});
		}
		emit(event);
	}
}

function onClose(ev: any) {
	if (ev?.target && ev.target !== push.socket) return;
	detach();
	emit({ type: 'disconnected' });
	scheduleAttach();
}

function detach() {
	let s = push.socket;
	push.socket = null;
	push.frameSeen = false;
	if (!s) return;
	try { s.removeEventListener('message', onMessage); } catch (e) { }
	try { s.removeEventListener('close', onClose); } catch (e) { }
}

function scheduleAttach() {
	if (push.holders === 0 || push.retryTimer) return;
	push.retryTimer = setTimeout(() => {
		push.retryTimer = null;
		attach();
	}, STATUS_PUSH_REATTACH_MS);
}

async function liveSocket(skapi: any): Promise<WebSocket | null> {
	if (!skapi?.__socket) return null;
	try {
		return await skapi.__socket;
	} catch (e) {
		return null;
	}
}

async function attach() {
	let skapi = push.skapi;
	if (!skapi || push.holders === 0 || push.attaching) return;
	if (push.socket && push.socket.readyState === 1) return;
	push.attaching = true;
	try {
		let socket = await liveSocket(skapi);
		if (push.holders === 0) return;

		if (!socket) {
			if (skapi.__socket) {
				// One is being opened, or a reconnect is under way: look again shortly.
				scheduleAttach();
				return;
			}
			// Nobody has a socket. Opening one needs a session (see startRealtimeRelay:
			// without one connectRealtime leaves a promise pending for the page's life).
			if (!skapi.session) return;
			await connectRealtime.bind(skapi)(() => { }, 0);
			socket = await liveSocket(skapi);
			if (socket && push.holders > 0) push.opened = socket;
		}

		if (!socket || push.holders === 0) return;
		if (socket.readyState === 0) {
			socket.addEventListener('open', () => attach(), { once: true });
			return;
		}
		if (socket.readyState !== 1) {
			// Closed: the SDK's own reconnect builds a new one, which the next look finds.
			scheduleAttach();
			return;
		}
		if (push.socket === socket) return;

		detach();
		socket.addEventListener('message', onMessage);
		socket.addEventListener('close', onClose);
		push.socket = socket;
		emit({ type: 'connected' });
	} catch (err) {
		// Silent: the push is an accelerator, and polls run at their own speed without it.
		scheduleAttach();
	} finally {
		push.attaching = false;
	}
}

async function release() {
	let skapi = push.skapi;
	let opened = push.opened;
	clearTimeout(push.retryTimer);
	push.retryTimer = null;
	detach();
	push.opened = null;
	if (!opened || !skapi) return;
	try {
		let live = await liveSocket(skapi);
		// Ours, still the SDK's socket, and no room joined on it (a streaming relay or the
		// app would be in one): nothing else can be using it.
		if (live === opened && !currentSocketRoom()) await closeRealtime.bind(skapi)();
	} catch (e) { }
}

/**
 * Keep the status listener attached. Returns the matching release. The socket this module
 * opened is closed STATUS_PUSH_LINGER_MS after the last holder lets go, so a burst of
 * short-lived polls does not open and close a connection each.
 */
export function holdStatusPush(skapi: any): () => void {
	if (typeof window === 'undefined' || (window as any)._runningInNodeJS) return () => { };
	push.skapi = skapi;
	push.holders += 1;
	clearTimeout(push.lingerTimer);
	push.lingerTimer = null;
	attach();
	let done = false;
	return () => {
		if (done) return;
		done = true;
		push.holders = Math.max(0, push.holders - 1);
		if (push.holders > 0) return;
		clearTimeout(push.lingerTimer);
		push.lingerTimer = setTimeout(() => {
			push.lingerTimer = null;
			if (push.holders === 0) release();
		}, STATUS_PUSH_LINGER_MS);
	};
}

/**
 * Listen to status changes of this user's requests dispatched with `notify: true`,
 * including ones this client never dispatched itself (a pass the server queued as the
 * continuation of one it did, or a request from another tab of the same user). Keeps the
 * websocket open while registered (opening one when the app has none and a user is signed
 * in). Returns the unsubscribe.
 *
 * The callback also gets `{ type: 'connected' }` every time the listener lands on an open
 * socket, and `{ type: 'disconnected' }` when it loses it. Frames are not stored for a
 * connection that is down, so 'connected' is the moment to re-read what you show.
 *
 * Every status event is a hint: read the request (its poll, or forwardRequestHistory) for
 * the outcome.
 */
export function onRequestStatus(this: any, callback: RequestStatusCallback): () => void {
	if (typeof callback !== 'function') return () => { };
	listeners.add(callback);
	let unhold = holdStatusPush(this);
	if (push.socket && push.socket.readyState === 1) {
		// Already listening: this subscriber starts from a live connection too.
		setTimeout(() => {
			if (listeners.has(callback)) {
				try { callback({ type: 'connected' }); } catch (err) { setTimeout(() => { throw err; }); }
			}
		}, 0);
	}
	return () => {
		if (!listeners.delete(callback)) return;
		unhold();
	};
}

/** True while status frames are arriving (see statusPushWarm). */
export function isRequestStatusLive(): boolean {
	return statusPushWarm();
}
