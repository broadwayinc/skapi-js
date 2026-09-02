import {
	Form,
	FetchOptions,
	ProgressCallback,
	DatabaseResponse,
	RequestHistory,
} from '../Types';
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { request } from '../utils/network';
import { extractFormData, generateRandom } from '../utils/utils';
// The realtime accelerator below rides the SDK's own websocket rather than opening a
// second one: it is the same shared, app-wide connection connectRealtime hands the
// application, which is exactly why this file borrows it instead of owning it.
import { closeRealtime, connectRealtime, joinRealtime, currentSocketRoom } from './realtime';
import Qpass from "qpass";

const hasFormData = typeof FormData !== 'undefined';
const hasHTMLFormElement = typeof HTMLFormElement !== 'undefined';
const hasSubmitEvent = typeof SubmitEvent !== 'undefined';

let queuePromiseList: {
	[polling_name: string]: Qpass
} = {};

let queueJobId: {
	[full_id: string]: string;
} = {};

/**
 * Live polls, keyed by the full request id, so a caller can stop one it already
 * started. Without this the setInterval below is unreachable from outside: it is a
 * closure local and is only ever cleared when the request settles, so a request that
 * never settles polls forever — and because polls run through Qpass with batchSize 1,
 * it also blocks every poll queued behind it on the same queue.
 */
let activePolls: {
	[full_id: string]: {
		stop: (() => void) | null;
		aborted: boolean;
		queue?: string;
	};
} = {};

/**
 * Value a stopped poll resolves with. Deliberately a RESOLVE, not a reject: callers
 * await these promises in many places without a rejection handler, and turning a stop
 * into a rejection would surface as an error state in their UI (and, where a `.catch`
 * already exists for real failures, would run the failure path).
 */
function stoppedResult(id: string) {
	return Object.freeze({ id, status: 'stopped' });
}

/**
 * True if a poll result came from stopPolling rather than the server. Consumers that
 * cannot import from this package can duck-type the same check (`res.status === 'stopped'`).
 */
export function isPollStopped(res: any): boolean {
	return !!res && typeof res === 'object' && (res as any).status === 'stopped';
}

/**
 * One chunk of a STREAMED turn, as csr-poll hands it back. `txt` is raw text
 * relayed from the destination: skapi appends whatever the destination wrote and
 * parses none of it, so the grammar those bytes are in (SSE frames, ndjson, plain
 * prose, anything at all) belongs to the caller and its destination.
 */
type StreamChunk = { seq: number; txt: string };

/**
 * How far through a streamed turn a reader has got. An object rather than a plain
 * number so the delivery helper can advance it in place for the loop that owns it.
 */
type StreamCursor = { seq: number };

/**
 * How many consecutive DEGRADED chunk reads a reader tolerates on a request that has
 * already gone terminal before it settles anyway. `more: true` with nothing new is
 * what the polling lambda answers when the chunk table itself failed; the row will
 * not change again, so the only thing left to wait for is that table recovering.
 * Bounded because it might not recover: the chunks stay readable afterwards through
 * clientSecretRequestStream, so giving up costs the caller a re-read, never the answer.
 */
const STREAM_DEGRADED_RETRIES = 3;

/**
 * Hands every chunk the reader has not seen yet to `onStream`, oldest first, and
 * advances `cursor` past them. Returns whether the cursor actually moved.
 *
 * That return value is what tells the two meanings of a `more: true` response apart.
 * `more` says only "this read was capped, ask again": on a real cap the chunks came
 * back and the cursor moved, so asking again immediately is free progress. But the
 * polling lambda also answers `more: true` with NO chunks and an unchanged `last_seq`
 * when the chunk table failed on it, and re-asking THAT immediately hammers a table
 * that is already in trouble. Same flag, opposite correct reaction, and the cursor is
 * the only thing that separates them.
 */
function deliverStreamChunks(
	result: any,
	cursor: StreamCursor,
	onStream?: (chunk: string, seq: number, via?: 'socket' | 'poll') => void,
): boolean {
	let moved = false;
	let chunks: StreamChunk[] = Array.isArray(result?.chunks) ? result.chunks.slice() : [];

	// The server already returns these in seq order. Sorting an ordered list costs
	// nothing and makes "in order" a promise this SDK keeps itself, rather than one the
	// caller has to trust the transport for.
	chunks.sort((a, b) => (a?.seq || 0) - (b?.seq || 0));

	for (let c of chunks) {
		if (!c || typeof c.seq !== 'number' || c.seq <= cursor.seq) {
			// Already delivered. A window can legitimately be re-read (a retry after a
			// blip, a second reader attaching to the same turn), and firing the callback
			// again would duplicate text in the caller's output.
			continue;
		}
		cursor.seq = c.seq;
		moved = true;
		// A chunk written without text still has to advance the cursor (otherwise the
		// next poll re-requests that gap forever), but there is nothing to hand over,
		// so the callback is not fired for it.
		if (onStream && typeof c.txt === 'string' && c.txt !== '') {
			try {
				onStream(c.txt, c.seq, 'poll');
			} catch (err) {
				// A throwing callback must not strand the poll: the turn is still running
				// and the rest of the answer is still coming.
				console.error(err);
			}
		}
	}

	// last_seq is the value the server wants back as the next "since". It normally
	// equals the last chunk delivered above; taking it when it is HIGHER keeps the
	// cursor in step with the server if a seq is ever skipped, which would otherwise
	// leave the reader asking forever for a gap nothing will fill.
	if (typeof result?.last_seq === 'number' && result.last_seq > cursor.seq) {
		cursor.seq = result.last_seq;
		moved = true;
	}

	return moved;
}

/**
 * Live socket delivery of a streamed turn's chunks, layered ON TOP of the poll.
 *
 * The polling path above is unchanged and stays authoritative: every chunk is written
 * to the chunk table first, and csr-poll is what a reconnect, a second tab, a late
 * reader and every caller that never opened a socket read. This block only lets a
 * reader that IS connected hear a chunk the moment the worker relayed it, instead of
 * on its next poll tick. If every socket message were lost, nothing below would change
 * the outcome of a read: it would run at exactly today's speed. That is a property of
 * the code and not merely of the intention, because the socket never advances anything
 * the poll does not also advance, and never settles a request.
 *
 * Three hazards come with the socket, and ONE rule covers all of them. SNS fan-out is
 * not ordered, so a chunk can arrive before the one in front of it; the same chunk can
 * arrive on both transports; and a reader that joins a room mid-turn missed everything
 * written before it joined. The rule: text is only ever handed to onStream in seq
 * order, starting from the seq after the last one delivered. Anything at or below that
 * has already been rendered and is dropped (which is why dedup is by seq and NEVER by
 * comparing text: identical text is normal in a stream, and a seq is exact). Anything
 * ahead of the next expected seq is HELD until the gap fills, and the poll is what
 * fills it, because a poll answer is complete for the range it covers.
 */

/**
 * How long after its last message a socket is still treated as delivering. Past this
 * the poll returns to full rate, so a socket that dies quietly costs one interval of
 * latency rather than stalling the read.
 *
 * SIZED AGAINST THE RELAY'S CADENCE, not picked round. The worker coalesces its writes
 * to about one a second, so a socket that has been silent for two of those intervals
 * has almost certainly finished rather than paused. That matters at exactly one
 * moment: the LAST chunk of an answer also stamps this timer, so a window longer than
 * the stream's own rhythm throttles the very poll that would notice the row had
 * settled. At 5000 an accelerated request could resolve up to five seconds LATER than
 * the same request with no socket at all, which inverts the point of the feature.
 * Two seconds keeps the throttle across an ordinary gap between chunks and lapses
 * promptly once the text stops.
 */
const REALTIME_SILENCE_MS = 2000;

/**
 * The poll's interval WHILE the socket is delivering. Not zero, deliberately: the
 * poll is the floor, and stopping it entirely would mean a dropped socket, a message
 * lost in fan-out, or a chunk the worker never published stalls the read with no one
 * left to notice. It is also the only reader of the ROW: the socket carries chunks,
 * never status, so with polling stopped a finished request would never settle. Leaving
 * it at full rate would instead spend most of what the socket just bought.
 */
const REALTIME_IDLE_POLL_MS = 5000;

/**
 * Ceiling on chunks held out of order at once. A gap is filled by the very next poll,
 * so this is only ever reached if the socket is racing far ahead of a poll that cannot
 * complete. Refusing to hold more costs nothing: every one of those chunks is in the
 * chunk table and the poll delivers it.
 */
const REALTIME_HOLD_MAX = 2000;

/** Bounded re-attach after the socket drops, so a blip does not permanently demote a
 *  reader to poll speed. Bounded because the poll already carries the read: if the
 *  socket will not come back, giving up is only a return to today's behaviour. */
const REALTIME_REATTACH_TRIES = 5;
const REALTIME_REATTACH_DELAY_MS = 1500;

/**
 * The relay that currently holds the connection's room, or null.
 *
 * A websocket connection is in ONE room at a time (joinRealtime REPLACES the current
 * one), so two concurrently streaming requests cannot both be listening. The first one
 * takes the room; a second silently reads at poll speed rather than kicking the first
 * out of the room mid-answer, which would strand a reader that is mid-render.
 */
let realtimeRoomHolder: any = null;

/**
 * Everything that decides WHAT reaches onStream and WHEN, shared by the two transports
 * so a chunk is delivered exactly once, in seq order, whichever one carried it. The
 * poll owns the same `cursor` object, so "already delivered" means the same thing on
 * both sides.
 */
type StreamSink = {
	/** The highest seq handed to onStream. Also the "since" the poll sends. */
	cursor: StreamCursor;
	/** Called once the history read has been rendered: socket messages held until
	 *  then may now be released. */
	open: () => void;
	/** Deliver one csr-poll answer. Returns whether the cursor moved, with exactly the
	 *  meaning deliverStreamChunks gives it. */
	fromPoll: (result: any) => boolean;
	/** Take one chunk off the socket. */
	fromSocket: (seq: number, txt: any) => void;
	/** True while the socket has delivered something recently. */
	warm: () => boolean;
	/** How many chunks each transport carried FIRST. Reported, not acted on: it is
	 *  the only way to answer "did the socket actually deliver this answer, or did
	 *  the poll carry it?" after the fact. */
	stats: () => { socket: number; poll: number };
	/** Stop delivering and drop anything still held. */
	close: () => void;
};

function createStreamSink(
	cursor: StreamCursor,
	onStream?: (chunk: string, seq: number, via?: 'socket' | 'poll') => void,
	/** Called the FIRST time each transport carries a chunk, and never again for that
	 *  transport. Both transports deliver through the same onStream by design, so this
	 *  is the seam that lets skapi say which one is actually feeding the read without
	 *  putting a line in the console per chunk. */
	onTransport?: (via: 'socket' | 'poll', seq: number) => void,
): StreamSink {
	// seq -> the chunk, with the transport that got it here first. Held, never rendered
	// out of order: text with a hole in it is worse than text that is one poll late.
	let held: Map<number, { txt: string; via: 'socket' | 'poll' }> = new Map();
	let ready = false;
	let closed = false;
	let lastSocketAt = 0;
	// Counted on ARRIVAL, not on render: the question this answers is which transport
	// won the race, and a chunk that arrived on the socket was carried by the socket
	// even if it had to wait behind a gap before it could be handed over.
	let seen = { socket: 0, poll: 0 };

	let render = (seq: number, txt: string, via: 'socket' | 'poll') => {
		cursor.seq = seq;
		// A chunk written without text still has to advance the cursor (otherwise the
		// next poll re-requests that gap forever), but there is nothing to hand over,
		// so the callback is not fired for it. Same rule as deliverStreamChunks.
		if (!onStream || typeof txt !== 'string' || txt === '') return;
		try {
			onStream(txt, seq, via);
		} catch (err) {
			// A throwing callback must not strand the read: the turn is still running
			// and the rest of the answer is still coming.
			console.error(err);
		}
	};

	/** Render every held chunk that is now consecutive with the cursor, and forget
	 *  everything at or below it (delivered, so it can only be a duplicate). */
	let drain = () => {
		for (let k of Array.from(held.keys())) {
			if (k <= cursor.seq) held.delete(k);
		}
		for (; ;) {
			let next = cursor.seq + 1;
			if (!held.has(next)) break;
			let hit = held.get(next);
			held.delete(next);
			render(next, hit.txt, hit.via);
		}
	};

	let fromPoll = (result: any): boolean => {
		if (closed) return false;
		let before = cursor.seq;
		let bound = cursor.seq;
		let chunks: StreamChunk[] = Array.isArray(result?.chunks) ? result.chunks : [];

		for (let c of chunks) {
			if (!c || typeof c.seq !== 'number' || c.seq <= cursor.seq) {
				// Already delivered, on this transport or the other one.
				continue;
			}
			// FIRST arrival wins the attribution. A chunk the socket already delivered
			// into the hold buffer is re-reported by the next poll (the poll page is
			// complete for its range, it cannot know what the socket got), and calling
			// that a poll delivery would erase every socket win from the tally.
			let first = !held.has(c.seq);
			if (first) {
				seen.poll++;
				if (onTransport && seen.poll === 1) onTransport('poll', c.seq);
			}
			held.set(c.seq, {
				txt: typeof c.txt === 'string' ? c.txt : '',
				via: first ? 'poll' : held.get(c.seq).via,
			});
			if (c.seq > bound) bound = c.seq;
		}

		// last_seq is the value the server wants back as the next "since". Taking it
		// when it is HIGHER than any chunk in this page keeps the cursor in step with
		// the server if a seq is ever skipped, which would otherwise leave the reader
		// asking forever for a gap nothing will fill.
		if (typeof result?.last_seq === 'number' && result.last_seq > bound) {
			bound = result.last_seq;
		}

		// A poll answer is COMPLETE for the range it covers: every chunk with a seq in
		// (cursor, bound] that exists is in this page. So everything held up to `bound`
		// is rendered here in seq order even across a gap, because this read has just
		// proved that the gap is empty and nothing will ever fill it. Only chunks ABOVE
		// `bound` keep waiting: those came off the socket ahead of the poll, and the
		// chunk in front of them may still be on its way.
		let waiting = Array.from(held.keys()).sort((a, b) => a - b);
		for (let s of waiting) {
			if (s <= cursor.seq) {
				held.delete(s);
				continue;
			}
			if (s > bound) break;
			let hit = held.get(s);
			held.delete(s);
			render(s, hit.txt, hit.via);
		}

		if (bound > cursor.seq) cursor.seq = bound;
		drain();
		return cursor.seq > before;
	};

	let fromSocket = (seq: number, txt: any) => {
		if (closed) return;
		if (typeof seq !== 'number' || !Number.isFinite(seq)) return;
		// Stamped even for a chunk that turns out to be a duplicate: this is only ever
		// asked "is the socket alive", and a duplicate proves it just as well as new
		// text does.
		lastSocketAt = Date.now();
		if (seq <= cursor.seq) return;
		if (!held.has(seq) && held.size >= REALTIME_HOLD_MAX) return;
		if (!held.has(seq)) {
			seen.socket++;
			if (onTransport && seen.socket === 1) onTransport('socket', seq);
		}
		held.set(seq, {
			txt: typeof txt === 'string' ? txt : '',
			via: held.has(seq) ? held.get(seq).via : 'socket',
		});
		// Steps 2 and 3 of the read contract: while the history fetch is still in
		// flight NOTHING from the socket is rendered, because the text in front of it
		// is still being fetched. The buffer is released by open(), once history has
		// been rendered and the cursor says where it ended.
		if (!ready) return;
		drain();
	};

	return {
		cursor,
		open: () => {
			if (ready || closed) return;
			ready = true;
			drain();
		},
		fromPoll,
		fromSocket,
		warm: () => lastSocketAt !== 0 && Date.now() - lastSocketAt < REALTIME_SILENCE_MS,
		stats: () => ({ socket: seen.socket, poll: seen.poll }),
		close: () => {
			closed = true;
			// Anything still held is a chunk sitting behind a gap that was never filled.
			// It is NOT rendered on the way out: appending text across a hole would put
			// a silently corrupted answer in front of the caller, and every one of those
			// chunks is still in the chunk table, re-readable in full and in order with
			// clientSecretRequestStream.
			held.clear();
		},
	};
}

/**
 * The console side of "which transport is actually feeding this read".
 *
 * Both transports hand their text to the SAME onStream by design - that is the whole
 * point of the sink - so from outside there is nothing to see: a socket-delivered
 * answer and a polled one look identical. This prints the difference.
 *
 * Two lines per read at most, never one per chunk: the first time each transport
 * carries a chunk, and a tally when the read ends. A long answer is thousands of
 * chunks, and a console line each would make the log useless and the render slow.
 *
 * Gated on skapi's existing `network_logs` switch (new Skapi(id, owner, { network_logs:
 * true })), so an application that did not ask to see its network traffic does not get
 * this either.
 */
function streamTransportLogger(this: any, id: string): {
	onTransport: ((via: 'socket' | 'poll', seq: number) => void) | undefined;
	done: (sink: StreamSink | null) => void;
} {
	if (!this || !this.__network_logs) return { onTransport: undefined, done: () => { } };
	let started = Date.now();
	let reported = false;
	return {
		onTransport: (via, seq) => {
			console.log(
				`%cSKAPI: stream chunk arrived over ${via === 'socket' ? 'WEBSOCKET' : 'POLL'}`,
				`color: ${via === 'socket' ? 'green' : 'orange'};`,
				{ id, first_seq: seq, after_ms: Date.now() - started },
			);
		},
		// Called from the teardown, which several exit paths reach, so it reports once.
		done: (sink) => {
			if (reported || !sink) return;
			reported = true;
			let st = sink.stats();
			console.log(
				`%cSKAPI: stream transport`,
				`color: blue;`,
				{ id, over_websocket: st.socket, over_poll: st.poll, took_ms: Date.now() - started },
			);
		},
	};
}

/**
 * Joins this request's realtime room and feeds what arrives into `sink`. Returns a
 * `stop` that puts the connection back the way it was found.
 *
 * Everything here fails SILENTLY. No socket in this environment, no session to open
 * one with, a room already taken by another streaming read, a connection that will not
 * open: all of them mean the poll carries the whole read, which is the behaviour with
 * no socket at all and is not an error to report to the caller.
 *
 * What it does to the shared connection, and why:
 * - It never calls connectRealtime when one is already open. connectRealtime replaces
 *   this.__socket with a NEW socket and the app's callback with the one it is passed,
 *   so calling it on a live connection would silently take the app's realtime traffic
 *   away from the app.
 * - It reads messages with addEventListener on the socket itself, NOT by supplying a
 *   callback, so the app's own realtime callback keeps receiving everything it did
 *   before and never sees these chunks.
 * - It only CLOSES a connection it opened itself, and only while this.__socket is
 *   still that exact socket. An app that opened its own connection keeps it.
 */
function startRealtimeRelay(this: any, group: string, sink: StreamSink): { stop: () => void } {
	let noop = { stop: () => { } };

	// No websocket outside the browser. The poll is the whole read there, which is what
	// it already was before this existed.
	if (typeof window === 'undefined' || (window as any)._runningInNodeJS) return noop;

	// One room per connection, first reader keeps it. See realtimeRoomHolder.
	if (realtimeRoomHolder) return noop;

	let relay = {
		stopped: false,
		/** The socket our listeners are attached to. */
		socket: null as WebSocket,
		/** The socket THIS relay opened, or null when it borrowed the app's. The
		 *  identity check on the way out is against this exact object. */
		opened: null as WebSocket,
		joined: false,
		attempts: 0,
		/** Socket delivery was declined for this read (no session to authorise one).
		 *  Not an error: the poll carries the whole read, so this only records that
		 *  the acceleration was not available and the retry ladder should not keep
		 *  trying to open something that cannot open. */
		unavailable: false,
	};
	realtimeRoomHolder = relay;

	let listener = (ev: any) => {
		if (relay.stopped) return;
		let raw = ev?.data;
		if (typeof raw !== 'string') return;

		let data: any = null;
		try {
			// RAW FIRST, and the order is the whole point. realtime.ts decodes first
			// because its own payloads are small and structured; ours carry arbitrary
			// relayed prose, and decodeURI does not merely fail on such text, it
			// silently REWRITES it: "50%20off" becomes "50 off", "%2F" becomes "/", and
			// the result is still valid JSON, so nothing throws and nothing falls back.
			// The chunk then consumes its seq, so the correct copy sitting in the chunk
			// table is never read and the corruption is permanent. Percent escapes are
			// ordinary in urls and in model output, so this is not a corner case.
			//
			// Parsing raw first is strictly safer: an unencoded frame parses correctly
			// and is never touched, and a genuinely URI-encoded frame fails JSON.parse
			// on its escaped braces and quotes and falls through to the decode below.
			// If neither parses, the chunk simply arrives on the next poll instead.
			data = JSON.parse(raw);
		} catch (e) {
			try {
				data = JSON.parse(decodeURI(raw));
			} catch (e2) {
				return;
			}
		}

		// Room broadcasts land under "#message"; every other key is somebody else's
		// traffic (notices, rtc signalling, errors) and is left for the app's callback.
		let payload = data?.['#message'];
		if (payload === null || payload === undefined) return;
		if (typeof payload === 'string') {
			try {
				payload = JSON.parse(payload);
			} catch (e) {
				return;
			}
		}
		if (typeof payload !== 'object') return;

		// "#srid" is the room the message was broadcast to, when the sender includes it.
		// Only ever used to REJECT: the room is minted per request and cannot be aimed
		// at another one, so a message with no room stamp is still this request's.
		let srid = data?.['#srid'];
		if (typeof srid === 'string' && srid !== group) return;

		// The payload is read leniently on purpose. A field this does not recognise
		// means the chunk arrives on the next poll instead of instantly, which is a
		// slower read and never a wrong one.
		let seq = payload.seq;
		if (typeof seq === 'string' && seq !== '') seq = Number(seq);
		sink.fromSocket(seq, payload.txt);
	};

	let detach = () => {
		if (!relay.socket) return;
		try { relay.socket.removeEventListener('message', listener); } catch (e) { }
		try { relay.socket.removeEventListener('close', onClose); } catch (e) { }
		relay.socket = null;
	};

	/**
	 * Puts the connection back. Idempotent, and safe to call twice from the two places
	 * that race for it (stop(), and an attach that finds itself already stopped after
	 * one of its awaits).
	 */
	let release = async () => {
		let opened = relay.opened;
		let joined = relay.joined;
		relay.opened = null;
		relay.joined = false;
		detach();
		if (!joined && !opened) return;

		try {
			let live: WebSocket = this.__socket ? await this.__socket : null;

			if (opened && live === opened) {
				// We opened this connection for this read and it is still the one the SDK
				// holds, so nothing else can be using it: the callback it was opened with
				// is the no-op below, which means no app code has ever been handed a
				// message on it and no rtc peer could have been negotiated over it.
				// closeRealtime also leaves the room, which is why it is not left first.
				await closeRealtime.bind(this)();
				return;
			}

			// Either the app's connection, or one that was replaced under us (the SDK
			// reconnects by building a NEW socket). Never closed here. Leaving the room
			// is still ours to undo: this request must not leave the caller listening to
			// a room after it settles.
			//
			// ONLY IF THE ROOM IS STILL OURS. joinRealtime REPLACES the current group
			// rather than adding to it, so an app that joined its own room after this
			// request started is now in that room, not ours. Leaving unconditionally
			// would evict the app from a room it joined for its own reasons, and it
			// would never know: the leave succeeds, the app simply stops receiving its
			// own messages. Compare the live room against the one we joined, and if it
			// has moved on, ours was already replaced and there is nothing to undo.
			if (joined && live && currentSocketRoom() === room) {
				await joinRealtime.bind(this)({ group: null });
			}
		} catch (e) {
			// Nothing to undo that has not been undone, and a failure to tidy up must
			// not surface as a failure of the request.
		}
	};

	let onClose = () => {
		if (relay.stopped) return;
		// The socket died under us. Detach from the dead object; the poll goes back to
		// full rate on its own as soon as sink.warm() lapses, so the read continues at
		// today's speed while we try to get the socket back.
		detach();
		// Declined, not failed: no session means no socket can ever open for this
		// caller, so re-trying the ladder spends attempts to reach the same answer.
		if (relay.unavailable) return;
		if (relay.attempts >= REALTIME_REATTACH_TRIES) return;
		relay.attempts += 1;
		setTimeout(() => {
			if (relay.stopped) return;
			attach();
		}, REALTIME_REATTACH_DELAY_MS);
	};

	let attach = async () => {
		try {
			// A connection that is already being opened is awaited rather than raced, and
			// one that never opens (no session to authorise it, for instance) leaves this
			// await pending for good. That is a fallback, not a hang: nothing downstream
			// waits on this function, the poll carries the whole read, and stop() releases
			// the room without waiting for it either.
			let socket: WebSocket = this.__socket ? await this.__socket : null;
			if (relay.stopped) { release(); return; }

			if (!socket) {
				// A SESSION IS REQUIRED, AND OPENING WITHOUT ONE POISONS THE APP'S OWN
				// REALTIME. clientSecretRequest works signed out, so an anonymous caller
				// can reach here. connectRealtime assigns this.__socket a Promise whose
				// executor calls prepareWebsocket, which THROWS "No access" with no
				// session; the throw happens inside a setTimeout callback, so it never
				// rejects that promise. this.__socket is then pending for the life of the
				// page, and every later connectRealtime the APP makes awaits it and hangs.
				// One anonymous streamed request would permanently disable the host app's
				// realtime. Socket delivery is an optimisation, so decline it instead: the
				// poll carries the whole read either way.
				if (!this.session) { relay.unavailable = true; release(); return; }
				// Nothing connected. Open one with a no-op callback: this reader takes
				// its messages off the socket directly, and an app that later opens its
				// own connection passes its own callback then.
				await connectRealtime.bind(this)(() => { }, 0);
				socket = this.__socket ? await this.__socket : null;
				if (relay.stopped) { release(); return; }
				// Recorded only when it is genuinely ours to close later.
				if (socket && !relay.opened) relay.opened = socket;
			}

			// Not open (still connecting, or closing): the poll carries the read.
			// Re-attachment after a drop comes back through onClose.
			if (!socket || socket.readyState !== 1) return;

			socket.addEventListener('message', listener);
			socket.addEventListener('close', onClose);
			relay.socket = socket;

			if (!relay.joined) {
				await joinRealtime.bind(this)({ group });
				relay.joined = true;
				if (relay.stopped) { release(); return; }
			}
			// A re-attach deliberately does NOT re-join: connectRealtime re-sends the
			// join for the room it is already in when a reconnected socket opens, and
			// joining again would be a second write for nothing.
		} catch (err) {
			// Silent by design: socket delivery is an optimisation, and its absence is
			// not a failure of the request.
		}
	};

	attach();

	return {
		stop: () => {
			if (relay.stopped) return;
			relay.stopped = true;
			if (realtimeRoomHolder === relay) realtimeRoomHolder = null;
			// Not awaited: the reader settles now, and leaving the room is tidying that
			// nothing is waiting on.
			release();
		},
	};
}

/**
 * True while the request is still being worked on. Every other status ("resolved",
 * "failed", "cancelled") is terminal: nothing further is written to the row or to
 * that request's chunks.
 */
function isRunningStatus(result: any): boolean {
	return result?.status === 'running' || result?.status === 'pending';
}

/**
 * True when a csr-poll answer is the STATUS ENVELOPE rather than a stored body.
 *
 * csr-poll has two response shapes, and the discontinuity is deliberate on the
 * server: a resolved request that HAS a stored result hands that result back
 * verbatim (the destination's answer for a buffered turn, or exactly the bytes the
 * caller kept with clientSecretRequestFinalize for a streamed one), while every
 * other state hands back { id, status, queue_name, in_queue, ... }. A finalized body
 * is the caller's own content and can therefore itself be an object carrying a
 * "status" key, so this test also demands the envelope's id/in_queue pair, which a
 * body would have to reproduce exactly to be mistaken for one.
 */
function isPollEnvelope(result: any): boolean {
	return (
		!!result &&
		typeof result === 'object' &&
		!Array.isArray(result) &&
		typeof result.status === 'string' &&
		typeof result.id === 'string' &&
		'in_queue' in result
	);
}

/**
 * Composes the id csr-poll and csr-finalize address a single request by:
 * "[METHOD]<url>#<service>:<stamp>:<entropy>".
 *
 * The identity half of the real key is added server side from the request context
 * and never travels, which is what makes an id unforgeable: an id that is not yours
 * composes a key that does not exist, so there is no ownership check to forget.
 *
 * Accepts either the short id a request handed back ("stamp:entropy"), which needs
 * `url` and `method` to compose, or an already-composed full id, used verbatim so a
 * caller that stored the whole string does not have to keep the url and method
 * beside it.
 */
function composeRequestId(
	requestId: string,
	url: string | undefined,
	method: string | undefined,
	service: string,
): string {
	if (!requestId || typeof requestId !== 'string') {
		throw new SkapiError('"requestId" should be type: <string>.', {
			code: 'INVALID_PARAMETER',
		});
	}

	// A full id always carries the "#<service>" separator; a short one never can,
	// because both halves of it are base32 of a timestamp and of random bytes.
	if (requestId.includes('#')) {
		return requestId;
	}

	if (!url || typeof url !== 'string' || !method || typeof method !== 'string') {
		throw new SkapiError(
			'"url" and "method" are required to address a request by its short id.',
			{ code: 'INVALID_PARAMETER' },
		);
	}

	validator.Url(url);

	// Same casing rules as the dispatch path: the row id was built from an uppercased
	// method and a lowercased url, so anything else composes a key that misses.
	return `[${method.toUpperCase()}]${url.toLowerCase()}#${service}:${requestId}`;
}

function pollClientSecretResponse(
	this: any,
	{
		id,
		auth,
		service,
		owner,
		latency = 1000,
		queue,
		onResponse,
		onError,
		onStream,
		realtimeGroup
	}: {
		id: string;
		auth: boolean;
		service?: any;
		owner?: any;
		latency?: number;
		queue?: string;
		onResponse?: (res: any) => void;
		onError?: (err: any) => void;
		/** Presence of this is what makes the poll read the STREAMED text of the
		 *  request as it arrives. Without it the poll sends no cursor and gets the
		 *  same response it got before streaming existed. */
		onStream?: (chunk: string, seq: number, via?: 'socket' | 'poll') => void;
		/** The realtime room this request's chunks are also published to, exactly as
		 *  the dispatch reply handed it back (`realtime_group`). With it, this poll
		 *  ALSO listens on the websocket and delivers chunks the moment they are
		 *  relayed. Everything it changes is speed: the chunk table is still written
		 *  first, this poll still reads it, and a socket that never opens or never
		 *  delivers costs the reader nothing but the interval it already had. Ignored
		 *  without `onStream`, which is the only thing a chunk could be delivered to. */
		realtimeGroup?: string;
	},
):any | void {
	if (typeof latency !== 'number') {
		throw new SkapiError('"latency" should be a number.', {
			code: 'INVALID_PARAMETER',
		});
	}

	if (latency < 0) {
		throw new SkapiError('"latency" should be a non-negative number.', {
			code: 'INVALID_PARAMETER',
		});
	}

	if (queue && !queuePromiseList?.[queue]) {
		queuePromiseList[queue] = new Qpass({
			breakWhenError: false,
			batchSize: 1
		});
	}

	// One registry entry per poll invocation. `stop` is filled in as soon as there is
	// something to stop; a stop that arrives while the job is still WAITING in the Qpass
	// queue sets `aborted` instead, which the job checks when it eventually starts.
	let entry: { stop: (() => void) | null; aborted: boolean; queue?: string } = {
		stop: null,
		aborted: false,
		queue,
	};
	activePolls[id] = entry;
	// Set by prom() once it is running, so the QUEUED stopper below (which is assigned
	// from outside prom's closure) can still put the websocket back. Without it a stop
	// on a queued poll would leave this reader holding the connection's room, and the
	// next streamed request would find the room taken and quietly read at poll speed.
	let liveTeardown: (() => void) | null = null;
	let release = () => {
		if (activePolls[id] === entry) delete activePolls[id];
	};

	let prom = () => new Promise<any>((resolve, reject) => {
		let settled = false;
		if (entry.aborted) {
			// Stopped before this job ever got a turn.
			release();
			resolve(stoppedResult(id));
			return;
		}
		// Streaming is opt-in per READER, not per request. The row streams because the
		// request asked it to, but a reader only pays for the chunk read when it has
		// somewhere to put the text: without onStream this poll sends no cursor and gets
		// exactly the response it got before streaming existed. That is what lets the
		// SAME request be re-read later by a caller that only wants the outcome.
		let cursor: StreamCursor = { seq: 0 };
		// Socket delivery is opt-in per READER too, and only for a reader that has
		// somewhere to put the text: without onStream there is nothing to deliver
		// faster, and opening a websocket to throw its messages away would cost the
		// application a connection it never asked for. The sink owns the cursor above
		// from here on, so the two transports share one idea of what has been rendered.
		let tlog = streamTransportLogger.call(this, id);
		let sink: StreamSink = onStream && realtimeGroup
			? createStreamSink(cursor, onStream, tlog.onTransport)
			: null;
		let relay: { stop: () => void } = sink ? startRealtimeRelay.call(this, realtimeGroup, sink) : null;
		let endRealtime = () => {
			tlog.done(sink);
			if (relay) relay.stop();
			if (sink) sink.close();
		};
		liveTeardown = endRealtime;
		// When the last poll actually went out, so a warm socket can throttle the poll
		// to a heartbeat without touching the interval that drives it.
		let lastPollAt = 0;
		// setInterval fires on a clock, not on completion, so a tick can start while the
		// previous one is still in flight (a slow poll, or the drain loop below). Two
		// overlapping polls would read from the same cursor and race to advance it, so a
		// tick that finds one already running simply gives up its turn.
		let ticking = false;
		// Consecutive capped reads that handed back nothing new, i.e. the polling
		// lambda's degraded answer when the chunk table failed on it.
		let stalled = 0;

		let tick = async () => {
			if (settled || ticking) return;
			// The socket is delivering, so this tick is skipped unless the last read was
			// long enough ago to be a heartbeat. The poll is never STOPPED (see
			// REALTIME_IDLE_POLL_MS): it is what fills a gap the socket dropped, and it
			// is the only reader of the row's status, so the request could not settle
			// without it.
			if (sink && sink.warm() && Date.now() - lastPollAt < REALTIME_IDLE_POLL_MS) return;
			ticking = true;
			try {
				for (; ;) {
					let payload: any = { id, service, owner };
					if (onStream) {
						// 0 means "from the beginning". Sent on EVERY tick, including the one
						// that discovers a failure: a streamed turn that died at 80% has 80%
						// of an answer waiting, and the server only attaches it to a poll that
						// asked with a cursor.
						payload.since = cursor.seq;
					}

					lastPollAt = Date.now();
					let result = await request.bind(this)('csr-poll', payload, { auth });

					// The poll may have been stopped while this request was in flight.
					if (settled) return;

					let moved = sink
						? sink.fromPoll(result)
						: (onStream ? deliverStreamChunks(result, cursor, onStream) : false);
					// History has been rendered and the cursor says where it ended, so
					// everything the socket buffered while it was in flight can be
					// released now (duplicates dropped, the rest in seq order). Idempotent:
					// only the first read of a turn is its history.
					if (sink) sink.open();
					let running = isRunningStatus(result);

					if (result?.more && moved) {
						// A CAP stopped that read, not the end of the data: the rest is
						// already written and waiting, so go straight back round rather than
						// spending a whole interval per capped page.
						stalled = 0;
						continue;
					}

					if (running) {
						// Still working: wait for the next interval tick.
						//
						// A degraded read is deliberately NOT counted here. `stalled` is the
						// budget for collecting the TAIL once the row can no longer change, and
						// counting it before this point spent that budget on the wrong half of
						// the turn: a chunk table that blipped three times early in a long
						// turn left nothing for the end, so the FIRST degraded read after the
						// row went terminal settled the poll on the spot and the caller kept a
						// half read answer with no sign of it. A running row gets polled again
						// regardless, so there is nothing to bound on this side of terminal.
						// Reset rather than merely skipped, so the budget is always a whole one
						// measured from the moment the row goes terminal, which is what
						// STREAM_DEGRADED_RETRIES already says it is.
						stalled = 0;
						return;
					}

					// Terminal from here down. `more` with nothing new is the chunk table's
					// degraded answer. Backing off to the interval is the entire point of
					// telling the two apart: re-asking now would hammer a table that is
					// already failing.
					stalled = result?.more ? stalled + 1 : 0;

					if (result?.more && stalled < STREAM_DEGRADED_RETRIES) {
						// Terminal, but the last chunk read failed. The row cannot change
						// again, so the only thing left to wait for is the chunk table
						// recovering: give it a few ticks before settling without the tail.
						return;
					}

					settled = true;
					if (onResponse)
						onResponse(result);
					clearInterval(interval);
					endRealtime();
					release();
					resolve(result);
					return;
				}
			} catch (e) {
				if (settled) return;
				settled = true;
				if (onError)
					onError(e);
				clearInterval(interval);
				endRealtime();
				release();
				reject(e);
			} finally {
				ticking = false;
			}
		};

		let interval = setInterval(tick, latency);
		if (sink) {
			// Step 1 of the read contract: the history fetch starts AT THE SAME TIME as
			// the socket is being opened, not one interval later. Without this the first
			// chunk of a socket-accelerated turn would still wait out a full poll
			// interval, since nothing may be rendered before history has been. `ticking`
			// keeps this from overlapping the interval's own first tick.
			tick();
		}
		entry.stop = () => {
			if (settled) return;
			settled = true;
			clearInterval(interval);
			endRealtime();
			release();
			// onResponse/onError are deliberately NOT called: a stop is not a result,
			// and firing them would make callers render a reply that never arrived.
			resolve(stoppedResult(id));
		};
	});

	// Exposed on the returned promise so a caller holding it can stop this exact poll
	// without having to reconstruct the full request id.
	let publicStop = () => {
		let e = activePolls[id];
		if (!e) return; // already settled
		if (e.stop) e.stop();
		else {
			e.aborted = true;
			delete activePolls[id];
		}
	};

	if (queue) {
		let outer = new Promise<any>((resolve, reject) => {
			let outerSettled = false;
			let jobId = queuePromiseList[queue].add([async () => {
				try {
					let result = await prom();
					if (!outerSettled) {
						outerSettled = true;
						resolve(result);
					}
					return result;
				} catch (e) {
					if (!outerSettled) {
						outerSettled = true;
						reject(e);
					}
					throw e;
				}
			}])[0];
			queueJobId[id] = jobId;
			// Stopping a job that has not started yet must ALSO drop it from the queue,
			// or its batchSize-1 slot stays occupied and everything behind it stalls —
			// and must settle this outer promise, or the caller awaits forever.
			entry.stop = () => {
				if (outerSettled) return;
				entry.aborted = true;
				// Puts the websocket back if this job had already started. A job that
				// never started has no relay to stop, and this is a no-op.
				if (liveTeardown) liveTeardown();
				try {
					if (queuePromiseList[queue]) {
						queuePromiseList[queue].remove(queueJobId[id]);
					}
				} catch (e) { /* already started or already removed */ }
				delete queueJobId[id];
				release();
				outerSettled = true;
				resolve(stoppedResult(id));
			};
		});
		return Object.assign(outer, { stop: publicStop });
	}
	else {
		return Object.assign(prom(), { stop: publicStop });
	}
}

/**
 * Stop live polls. Returns how many were stopped.
 *
 * Matched by full request id when `id` is given, otherwise by queue. Note the two poll
 * call sites pass DIFFERENT queue namespaces — the dispatch path passes the caller's
 * queue string, the history path passes the server-side qid — so a queue match only
 * reaches the polls that were started with that same string. Prefer stopping by id.
 */
export function stopClientSecretPolling(
	this: any,
	params: {
		url?: string;
		method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
		id?: string;
		queue?: string;
		service?: string;
		owner?: string;
	},
): number {
	let stopped = 0;
	let ids: string[] = [];

	if (params?.id) {
		if (params.url && params.method) {
			let service = params.service || this.service;
			ids.push(
				`[${params.method.toUpperCase()}]${params.url.toLowerCase()}#${service}:${params.id}`,
			);
		}
		// Also accept an already-full id, so callers holding the registry key work.
		ids.push(params.id);
	} else if (params?.queue) {
		for (let key in activePolls) {
			if (activePolls[key]?.queue === params.queue) ids.push(key);
		}
	} else {
		for (let key in activePolls) ids.push(key);
	}

	for (let key of ids) {
		let entry = activePolls[key];
		if (!entry) continue;
		if (entry.stop) {
			entry.stop();
		} else {
			// Queued but not started, and no stop published yet: mark it so the job
			// short-circuits the moment it gets a turn.
			entry.aborted = true;
			delete activePolls[key];
		}
		stopped += 1;
	}

	return stopped;
}

export function clientSecretRequestQueueCount(
	params: { service?: string; owner?: string; queue: string },
	fetchOptions?: FetchOptions
): Promise<
	{
		queue_name: string;
		in_queue: number; // number of requests in the queue that are waiting to be processed.
	}
> {
	if (!params.queue) {
		throw new SkapiError('"queue" is required.', {
			code: 'INVALID_PARAMETER',
		});
	}

	let p = {
		service: params.service || this.service,
		owner: params.owner || this.owner,
		queue: params.queue + ':',
	}

	return request.bind(this)('csr-poll', p, { auth: true });
};

/**
 * Relays a request to a destination of your choosing from the server, with a stored
 * client secret substituted in where you put "$CLIENT_SECRET", so the secret never
 * reaches the browser.
 *
 * ### Streaming
 *
 * `stream: true` makes the server read the destination's response INCREMENTALLY and
 * append the bytes to storage as they arrive, instead of waiting for the whole body.
 * `onStream` then delivers that text to you as it lands.
 *
 * Three things are worth being blunt about:
 *
 * 1. **Skapi parses nothing.** It relays bytes. The text handed to `onStream` is
 *    exactly what the destination wrote, in the order it wrote it, still in whatever
 *    format the destination chose (server-sent events, ndjson, plain text, anything).
 *    Reading that format is yours to do. Skapi has no notion of what is on the other
 *    end of the url.
 * 2. **There are TWO "stream" flags in a streamed call, and they are not the same
 *    flag.** The one inside your own request body (`data.stream`, or whatever that
 *    api calls it) asks the DESTINATION to answer in pieces. This one, the skapi
 *    parameter, tells SKAPI to read that answer incrementally instead of waiting for
 *    the last byte. Neither implies the other: skapi never sends its flag to the
 *    destination, and the destination's field is just another key skapi passes
 *    through untouched. Set both, or neither. Setting one alone does not raise
 *    anything, it just goes quietly wrong:
 *    - **Body asks to stream, skapi buffers.** The destination answers in event
 *      frames and skapi waits for the end and stores the whole transcript as the
 *      response. What lands in the request is a wall of `data: {...}` lines where the
 *      caller expected the parsed document that api normally returns, so every reader
 *      written against that document quietly gives up on it.
 *    - **Skapi streams, the body never asked.** The destination answers with one
 *      plain document, and skapi honestly relays it in pieces as it arrives, so
 *      `onStream` fires and it all looks like it worked. A caller reading frames finds
 *      none, because there never were any.
 *
 *    Skapi cannot catch this for you, and the reason is the same one that lets it
 *    talk to any destination at all: the body is yours, it is never inspected, and
 *    skapi does not know which field (if any) that particular api streams on.
 * 3. **A streamed turn settles with a status and no body.** The text lives in the
 *    chunks, not on the request, so the history of that request stays empty until you
 *    say what should be kept, with {@link clientSecretRequestFinalize}. A turn you
 *    never finalize keeps its chunks indefinitely, on purpose, and the only way to
 *    read it back later is {@link clientSecretRequestStream}.
 *
 * `stream` requires a queue, and mints one for you when you do not name one: chunks
 * are appended to a polling row, and only a queued request has one.
 *
 * ### Live delivery (`realtime: true`)
 *
 * Streamed text is stored first and READ BY POLLING, so it reaches you in steps of one
 * poll interval however fast the destination is actually producing it. `realtime: true`
 * asks the server to ALSO push each chunk over skapi's websocket as it is relayed, and
 * this SDK then listens on it and hands you the text the moment it lands. It changes
 * only speed:
 *
 * - **The poll is still the floor, and stays authoritative.** Every chunk is written to
 *   storage before it is published, the poll still reads that storage, and it is the
 *   poll that fills anything the socket dropped and that settles the request. A socket
 *   that never opens (no session, no websocket in this environment, another streamed
 *   request already listening) or that dies mid-answer costs you nothing but speed:
 *   the read carries on at today's pace and resolves normally. Nothing about it is
 *   reported as an error, because its absence is not one.
 * - **Ordering and duplicates are handled for you.** Fan-out is not ordered, and the
 *   same chunk can reach you on both transports. `onStream` still fires once per chunk,
 *   in sequence order, whichever transport carried it, and a chunk that arrives ahead of
 *   its predecessor is held until the gap closes. You cannot tell which transport a
 *   chunk came in on, beyond it being faster.
 * - **Requires `stream: true`**, and only makes a difference when you pass `onStream`:
 *   that callback is the only place a chunk could go.
 * - **It is a capability.** The room is derived from the request id, and anyone holding
 *   that id can listen to that one request's relayed text (and nothing else). The id is
 *   unguessable and single-use, which is why this is opt-in per request.
 *
 * The reply carries `realtime_group`. Keep it beside the request id if you may want to
 * re-attach later: {@link clientSecretRequestStream} takes it as `realtimeGroup` and
 * reads the same request live.
 *
 * **If your app also uses realtime for its own purposes, read this.** A connection is
 * in ONE room at a time and joining REPLACES the current one, so for as long as a
 * live-delivered request is running, this SDK holds the connection's room and your own
 * `joinRealtime` group is not the one that is joined. On the way out the room is left
 * (not restored, because the SDK cannot read which room you were in), so re-join your
 * group after the request settles. The socket itself is left as it was found: your
 * callback is never replaced, your connection is never closed, and a connection opened
 * here for the read is closed here. An app that never calls `connectRealtime` has none
 * of this to think about.
 *
 * ```js
 * await skapi.clientSecretRequest({
 *     url: 'https://api.example.com/v1/chat',
 *     clientSecretName: 'my_secret',
 *     method: 'POST',
 *     headers: { 'x-api-key': '$CLIENT_SECRET' },
 *     // Both flags, and they are different flags. This "stream" is the destination's
 *     // own field, asking IT to answer in pieces. Skapi passes it through untouched.
 *     data: { model: 'some-model', stream: true, messages: [...] },
 *     // And this one is skapi's, telling it to relay that answer as it arrives.
 *     // Either flag without the other is the quiet failure described above.
 *     stream: true,
 *     // Push each relayed chunk over the websocket too, instead of waiting for the
 *     // next poll tick. Falls back to the poll on its own if the socket cannot open.
 *     realtime: true,
 *     poll: 1000,
 *     onStream: (chunk) => { output.textContent += chunk; },
 *     // A streamed turn settles with a status and no body: the text was the stream.
 *     onResponse: (res) => console.log(res.status)
 * });
 * ```
 *
 * @param params Request parameters.
 * @returns The destination's response, or a status object when the request is queued.
 */
export async function clientSecretRequest(params: {
	url: string;
	clientSecretName: string;
	method: 'GET' | 'POST' | 'DELETE' | 'PUT';
	headers?: { [key: string]: string };
	data?: { [key: string]: any };
	params?: { [key: string]: string };
	poll?: number; // enable polling with specified latency in ms.
	queue?: string; // optional queue name to distinguish requests with same url and method. Only effective when polling is enabled. Requests with the same url, method and queue will be handled sequentially on the server side.
	expires?: number; // optional history expiration time in seconds after it's resolved.
	/** Relay the destination's response incrementally instead of buffering it. The
	 *  text is appended to storage as it arrives and read back through `onStream`;
	 *  the request itself then settles with a status and NO body, and stays that way
	 *  until clientSecretRequestFinalize says what to keep. Requires a queue (one is
	 *  minted if you do not name it). Skapi parses none of the relayed text, and this
	 *  flag is not sent to the destination: asking the destination for a streamed
	 *  response is a separate field in your own `data`, and the two have to be set
	 *  together (see the method doc: one without the other fails quietly). */
	stream?: boolean;
	/** Also push each relayed chunk over skapi's websocket, so `onStream` fires as the
	 *  text is relayed instead of on the next poll tick. Requires `stream: true`, and
	 *  is only useful alongside `onStream`. Purely an accelerator: the chunk table is
	 *  still written first and still read by the poll, ordering and duplicates are
	 *  handled for you, and a socket that cannot be opened is not an error - the read
	 *  simply runs at its normal speed. See the method doc for what it does to a
	 *  connection your app may also be using. */
	realtime?: boolean;
	/** Called with each piece of relayed text as it arrives, in order, with the
	 *  sequence number it was stored under. Its PRESENCE is what makes polling read
	 *  the text at all, so a caller that only wants the outcome can poll the very same
	 *  request without it and simply get the terminal status. Raw text, never parsed. */
	onStream?: (chunk: string, seq: number, via?: 'socket' | 'poll') => void;
	onResponse?: (res: any) => void; // response callback that works on both polling request and regular.
	onError?: (err: any) => void; // error callback that works on both pollubg request error and regular.
}): Promise<any | void | {
	id: string; // request id: "stamp:entropy"
	status: "pending";
	queue_name: string;
	in_queue: number;
	/** Present when `realtime: true` was accepted: the room this request's chunks are
	 *  published to. The returned `poll()` already listens on it, so this is only
	 *  needed to re-attach later with clientSecretRequestStream. Keep it beside the
	 *  id; it cannot be rebuilt from the id alone. */
	realtime_group?: string;
	poll?: (arg?: { latency?: number; onStream?: (chunk: string, seq: number, via?: 'socket' | 'poll') => void }) => Promise<any>;
}> {
	let hasSecret = false;

	if (typeof params.poll === 'number' && params.poll < 0) {
		throw new SkapiError('"poll" should be a non-negative number.', {
			code: 'INVALID_PARAMETER',
		});
	}
	let onResponse = params?.onResponse;
	let onError = params?.onError;
	// Captured before validator.Params, which keeps only the keys in its schema: the
	// callbacks are this client's, they are not part of the request and must not be
	// sent anywhere.
	let onStream = params?.onStream;
	let latency = typeof params.poll === 'number' ? params.poll : params.poll ? 1000 : 0;
	delete params.poll;

	// A streamed request also needs a queue, for a structural reason rather than a
	// policy one: its text is appended to a POLLING ROW, and only the queued path
	// creates one. The non-queued path calls the destination inline and hands back the
	// buffered body, so the server refuses "stream" there outright. Minting a queue
	// here keeps that from being an error the caller has to learn about.
	if ((latency || params.stream) && !params.queue) {
		// create random queue id
		params.queue = (this.__user?.user_id || "anonymous") + "-" + generateRandom();
	}

	let checkClientSecretPlaceholder = (v: any) => {
		for (let k in v) {
			if (typeof v[k] === 'string' && v[k].includes('$CLIENT_SECRET')) {
				hasSecret = true;
				break;
			}
		}
	};

	params = validator.Params(
		params,
		{
			url: (v: string) => {
				if (!v || typeof v !== 'string') {
					throw new SkapiError('"url" should be type: <string>.', {
						code: 'INVALID_PARAMETER',
					});
				}
				validator.Url(v);
				if (v.includes('$CLIENT_SECRET')) {
					hasSecret = true;
				}
				return v;
			},
			clientSecretName: 'string',
			method: (v: string) => {
				if (v && typeof v !== 'string') {
					throw new SkapiError(
						'"method" should be either "GET" or "POST" or "DELETE" or "PUT".',
						{ code: 'INVALID_PARAMETER' },
					);
				}
				let lo = v.toLowerCase();
				if (
					lo !== 'get' &&
					lo !== 'post' &&
					lo !== 'delete' &&
					lo !== 'put'
				) {
					throw new SkapiError(
						'"method" should be either "GET" or "POST" or "DELETE" or "PUT".',
						{ code: 'INVALID_PARAMETER' },
					);
				}
				return lo;
			},
			stream: (v: any) => {
				if (v !== undefined && v !== null && typeof v !== 'boolean') {
					throw new SkapiError('"stream" should be type: <boolean>.', {
						code: 'INVALID_PARAMETER',
					});
				}
				// Normalised to a real boolean because the server types this key as one:
				// a null passed through would be rejected at the door rather than read as
				// the default it obviously means.
				return !!v;
			},
			realtime: (v: any) => {
				if (v !== undefined && v !== null && typeof v !== 'boolean') {
					throw new SkapiError('"realtime" should be type: <boolean>.', {
						code: 'INVALID_PARAMETER',
					});
				}
				// Same normalisation, and for the same reason, as "stream" above.
				return !!v;
			},
			headers: (v: any) => {
				if (v && typeof v !== 'object') {
					throw new SkapiError(
						'"headers" should be type: <object>.',
						{ code: 'INVALID_PARAMETER' },
					);
				}
				checkClientSecretPlaceholder(v);
				return v;
			},
			data: (v: any) => {
				if (v && typeof v !== 'object') {
					throw new SkapiError('"data" should be type: <object>.', {
						code: 'INVALID_PARAMETER',
					});
				}
				checkClientSecretPlaceholder(v);
				return v;
			},
			params: (v: any) => {
				if (v && typeof v !== 'object') {
					throw new SkapiError('"params" should be type: <object>.', {
						code: 'INVALID_PARAMETER',
					});
				}
				checkClientSecretPlaceholder(v);
				return v;
			},
			expires: 'number',
			queue: 'string',
		},
		['clientSecretName', 'method', 'url'],
	);

	// Refused here as well as on the server, because the failure it prevents is a
	// SILENT one on this side: a caller that asked for live delivery without streaming
	// would be handed a request that buffers, join a room nothing is ever published to,
	// and sit there watching an empty socket while the answer arrives whole at the end.
	if (params.realtime && !params.stream) {
		throw new SkapiError('"realtime" requires "stream": true.', {
			code: 'INVALID_PARAMETER',
		});
	}

	if (!hasSecret) {
		throw new SkapiError(
			`At least one parameter value should include "$CLIENT_SECRET" in ${params.method.toLowerCase() === 'post' ? '"data"' : '"params"'} or "headers".`,
			{ code: 'INVALID_PARAMETER' },
		);
	}

	await this.__connection;
	let auth = !!this.__user;

	let req_prom = () => {
		return request
			.bind(this)('csr', params, {
				auth,
				tokenHeaders: {
					accessToken: !!auth,
				},
			})
			.then((res) => {
				if (res.status === 'running' || res.status === 'pending') {
					let url = `[${params.method.toUpperCase()}]${params.url.toLowerCase()}`;
					let serviceId = params.service || this.service;
					let ownerId = params.owner || this.owner;
					let fullId = `${url}#${serviceId}:${res.id}`;
					Object.assign(res, {
						// NOT async: an async arrow returns a NEW native promise wrapping the
						// result, which discards the `stop` handle pollClientSecretResponse
						// attaches to the promise it returns. The caller would then hold an
						// unstoppable poll. pollClientSecretResponse already returns a
						// promise, so awaiting this is unchanged.
						poll: (arg?: {
							latency?: number;
							onStream?: (chunk: string, seq: number, via?: 'socket' | 'poll') => void;
						}) => pollClientSecretResponse.call(this, {
							id: fullId,
							auth,
							service: serviceId,
							owner: ownerId,
							latency: arg?.latency || 1000,
							queue: params?.queue,
							onResponse,
							onError,
							// Decided per poll, not per request: a reader that wants the text
							// as it arrives passes one, a reader that only wants the outcome
							// does not, and the same request serves both.
							onStream: arg?.onStream || onStream,
							// Handed back by the server when "realtime" was accepted, and
							// copied rather than rebuilt so the SDK and the server can never
							// disagree about the room's name. Absent (no "realtime", or a
							// server that predates it) simply means this poll reads the
							// chunks the way it always has.
							realtimeGroup: res?.realtime_group
						}),
					});
				}
				if (onResponse) return onResponse(res);
				return res;
			})
			.catch(err => {
				if (onError) return onError(err);
				throw err;
			});
	};

	if (params?.queue) {
		let base_queue = 'base:' + params.queue;

		if (!queuePromiseList?.[base_queue]) {
			queuePromiseList[base_queue] = new Qpass({
				breakWhenError: false,
				batchSize: 1
			});
		}

		return new Promise<any>((resolve, reject) => {
			queuePromiseList[base_queue].add([async () => {
				try {
					let result = await req_prom();

					if (latency > 0) {
						let polling = result.poll({latency});
						resolve(polling);
						return polling;
					}

					resolve(result);
					return result;
				} catch (err) {
					reject(err);
					throw err;
				}
			}]);
		});
	}
	else {
		return req_prom();
	}
}

export async function clientSecretRequestHistory(
	params: {
		url: string;
		method: 'GET' | 'POST' | 'DELETE' | 'PUT';
		queue?: string;
		status?: 'pending' | 'running' | 'resolved' | 'failed';
		/** Compact listing: each item carries label/marker STUBS (request_text,
		 *  response_text, response_complete_marker) INSTEAD of the full
		 *  request_body/response_body, which never leave the server. Enough to
		 *  list, label and color rows; re-fetch without `compact` (or poll the
		 *  item) when a full body is actually needed. */
		compact?: boolean;
		/** Only rows belonging to exactly `queue`. Without it the queue lookup
		 *  is a PREFIX range, so queue "u1" also matches "u1-bg". The filter is
		 *  applied server-side after the range read, so a page may come back
		 *  short (or empty) while more matches remain — keep paging by
		 *  startKey/endOfList as usual. */
		queue_exact?: boolean;
		/** Drop one queue's rows from the listing — e.g. fetch a chat surface
		 *  WITHOUT its background queue. Same short-page caveat as
		 *  `queue_exact`. */
		queue_exclude?: string;
	},
	fetchOptions?: FetchOptions,
): Promise<
	DatabaseResponse<RequestHistory[]>
> {
	await this.__connection;

	// Capture before validator strips unknown fields
	let service = (params as any).service || this.service;
	let owner = (params as any).owner || this.owner;

	params = validator.Params(
		params,
		{
			url: 'string',
			method: ['GET', 'POST', 'DELETE', 'PUT'],
			queue: 'string',
			status: ['pending', 'running', 'resolved', 'failed'],
			// Listing modifiers (see the polling lambda): `compact` returns
			// label/marker STUBS instead of full request/response bodies;
			// `queue_exact` post-filters the qid prefix range to the named
			// queue (without it, queue "u1" also matches "u1-bg");
			// `queue_exclude` drops one queue's rows from an id-prefix listing
			// (how a chat fetches its surface WITHOUT the bg-indexing queue).
			compact: 'boolean',
			queue_exact: 'boolean',
			queue_exclude: 'string',
		},
		['url', 'method'],
	);

	let auth = !!this.__user;
	let id = `[${params.method.toUpperCase()}]${params.url.toLowerCase()}#${service}:`;

	let his_req: any = { id, queue: params?.queue, status: params?.status, service, owner };
	if (params?.compact) his_req.compact = true;
	if (params?.queue_exact) his_req.queue_exact = true;
	if (params?.queue_exclude) his_req.queue_exclude = params.queue_exclude;

	Object.keys(his_req).forEach((k) => {
		if (!his_req[k]) {
			delete his_req[k];
		}
	});

	if (his_req.queue) {
		// A QUEUE name carries no provider: the background-indexing queue is
		// "<userId>-bg" for BOTH the Claude chat and the ChatGPT chat of the
		// same project. Dropping the id (which begins
		// "[POST]<provider url>#<service>:") therefore made every queue listing
		// span both platforms — the other platform's indexing passes and
		// attachment-send turns surfaced in a chat they do not belong to, where
		// nothing could ever confirm or cover them. The id cannot stay as `id`
		// (that selects a different query path server-side), so it is sent as a
		// FILTER instead. Requires the updated polling lambda; older backends
		// reject unknown keys, so this ships after that deploy.
		his_req.id_prefix = his_req.id;
		delete his_req.id;
	}

	let res = await request.bind(this)(
		'csr-poll',
		his_req,
		{ auth, fetchOptions },
	);

	res.list = res.list.map((item: any) => {
		let result = {
			id: item.id,
			status_code: item.rslv?.status_code || null,
			response_body: item.rslv?.body || item.rslv?.truncated || null,
			error: item?.err,
			// `stmp` is stamped once when the request is created and never rewritten;
			// `utmp` moves on every status change. So `created` is the request time and
			// `updated` is the time of the latest response/status change.
			created: item?.stmp,
			updated: item?.utmp,
			request_body: item?.reqbdy,
			expires: item?.expt,
			status: item.stts,
			queue_name: item?.qid,
			// Compact-listing stubs (only present when `compact` was requested):
			// the label line of the request, the head of the response, whether
			// the reply carried the indexing completion marker, and the flag
			// itself so consumers know bodies were deliberately omitted.
			request_text: item?.reqtxt,
			response_text: item?.rslvtxt,
			response_complete_marker: item?.rslvmk != null ? !!item.rslvmk : undefined,
			compact: item?.cmpct ? true : undefined,
		};
		for (let k in result) {
			if (result[k] === undefined) {
				delete result[k];
			}
		}
		if (result.status === 'running' || result.status === 'pending') {
			result.poll = (arg?: {
				latency?: number;
				onResponse?: (res: any) => void;
				onError?: (err: any) => void;
				/** Reads a STREAMED row's text as it arrives, same as on the dispatch
				 *  path. A row that already settled has nothing left to poll: read that
				 *  one back with clientSecretRequestStream instead. */
				onStream?: (chunk: string, seq: number, via?: 'socket' | 'poll') => void;
			}) => pollClientSecretResponse.call(this, {
				id: id + result.id,
				auth,
				service: service,
				owner: owner,
				latency: arg?.latency || 1000,
				queue: item?.qid,
				onResponse: arg?.onResponse,
				onError: arg?.onError,
				onStream: arg?.onStream
			})
		}
		return result;
	});

	return res;
}

export async function cancelClientSecretRequest(params: {
	url: string;
	method: 'GET' | 'POST' | 'DELETE' | 'PUT';
	id: string;
	queue?: string;
}): Promise<{ removed: boolean; message: string }> {
	await this.__connection;

	params = validator.Params(
		params,
		{
			url: 'string',
			method: ['GET', 'POST', 'DELETE', 'PUT'],
			id: 'string',
			queue: 'string'
		},
		['url', 'method', 'id'],
	);

	let service = params?.service || this.service;
	let owner = params?.owner || this.owner;
	let auth = !!this.__user;
	let base_id = `[${params.method.toUpperCase()}]${params.url.toLowerCase()}#${service}`;
	let id = params.id
	let fullId = `${base_id}:${id}`;
	let queue = params?.queue;

	if (queue && queuePromiseList?.[queue]) {
		queuePromiseList[queue].remove(queueJobId[fullId]);
		delete queueJobId[fullId];
	}

	return request.bind(this)('csr-cancel', { id: fullId, service, owner }, { auth });
}

/**
 * Attaches to a STREAMED request this call did not start, and reads its text.
 *
 * {@link clientSecretRequest} streams into the callback of the caller that started
 * the request. This is how any other reader gets at the same text: the page was
 * reloaded, a second tab is watching, or an old turn is being opened again. Give it
 * the request id and it either follows a request that is still running or replays one
 * that already finished.
 *
 * - **Still running**: polls and delivers text through `onStream` until the request
 *   settles, then resolves with its terminal status.
 * - **Already finished, not finalized**: fetches the whole stored text at once (paging
 *   internally until there is none left), delivers it through `onStream` in order, and
 *   resolves. This is what makes an unfinalized turn re-readable: its text is kept
 *   indefinitely, deliberately, until {@link clientSecretRequestFinalize} says what to
 *   keep, at which point the pieces are released.
 * - **Already finalized**: resolves with the stored body itself, exactly the value that
 *   was kept. Nothing streams, because there is nothing left to stream: the pieces it
 *   was assembled from were released when the kept version was stored.
 *
 * Skapi parses none of this. `onStream` receives raw relayed text in order, and
 * whatever format it is in is between you and your destination.
 *
 * Resolving with a body rather than a status object is the one place the two shapes
 * differ: a response with no `status` field is a finalized body.
 *
 * ### Live delivery (`realtimeGroup`)
 *
 * Pass the `realtime_group` the dispatching {@link clientSecretRequest} handed back and
 * this reader ALSO listens on skapi's websocket, so a request that is still running
 * delivers its text as it is relayed instead of on each poll tick. Everything the
 * dispatch path says about it holds here: the poll stays the floor and stays
 * authoritative, ordering and duplicates are handled for you, a socket that cannot be
 * opened is not an error, and the room is left (not restored) when the read settles.
 * The group cannot be rebuilt from a request id, so keep it beside the id you keep; a
 * read without it works exactly as it always has, just at poll speed.
 *
 * ```js
 * // Re-attach after a reload, from an id kept in storage.
 * const res = await skapi.clientSecretRequestStream(savedRequestId, {
 *     url: 'https://api.example.com/v1/chat',
 *     method: 'POST',
 *     onStream: (chunk) => { output.textContent += chunk; }
 * });
 * ```
 *
 * @param requestId The request id ("stamp:entropy"), or an already-composed full id.
 * @param options Where the request was sent, plus the callbacks to read it with.
 * @returns The request's terminal status, or the stored body when it was finalized.
 *          Carries a `stop()` that ends the read without touching the request itself.
 */
export function clientSecretRequestStream(
	this: any,
	requestId: string,
	options: {
		/** The url the request was sent to. Required unless `requestId` is a full id. */
		url?: string;
		/** The method it was sent with. Required unless `requestId` is a full id. */
		method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
		/** Called with each piece of relayed text, in order, with its sequence number.
		 *  Raw text: skapi does not parse it. */
		onStream?: (chunk: string, seq: number, via?: 'socket' | 'poll') => void;
		/** Start after this sequence number instead of from the beginning, so a reader
		 *  that already holds part of a turn does not receive it twice. */
		since?: number;
		/** The `realtime_group` the dispatching call handed back, to ALSO read this
		 *  request's chunks live off skapi's websocket while it is still running.
		 *  Accelerator only, and only meaningful with `onStream`: without it (or when
		 *  the socket cannot be opened) this reads exactly as it always has, one poll
		 *  interval at a time. See the method doc for what it does to a connection your
		 *  app may also be using. */
		realtimeGroup?: string;
		/** Polling interval in ms while the request is still running. Default 1000. */
		poll?: number;
		/** Called once with whatever this resolves with. */
		onResponse?: (res: any) => void;
		/** Called if the read itself fails. */
		onError?: (err: any) => void;
		service?: string;
		owner?: string;
	},
): Promise<any> & { stop: () => void } {
	let latency = typeof options?.poll === 'number' ? options.poll : 1000;

	// Finite, not merely "a number": NaN passes a typeof check and every comparison
	// against it, then setTimeout treats it as 0, which turns the wait between polls
	// into a request flood.
	if (!Number.isFinite(latency) || latency < 0) {
		throw new SkapiError('"poll" should be a non-negative number.', {
			code: 'INVALID_PARAMETER',
		});
	}

	if (!requestId || typeof requestId !== 'string') {
		throw new SkapiError('"requestId" should be type: <string>.', {
			code: 'INVALID_PARAMETER',
		});
	}

	if (options?.since !== undefined && typeof options.since !== 'number') {
		throw new SkapiError('"since" should be a number.', {
			code: 'INVALID_PARAMETER',
		});
	}

	if (
		options?.realtimeGroup !== undefined &&
		options.realtimeGroup !== null &&
		typeof options.realtimeGroup !== 'string'
	) {
		throw new SkapiError('"realtimeGroup" should be type: <string>.', {
			code: 'INVALID_PARAMETER',
		});
	}

	// A negative cursor still reads as "from the beginning" server side, but it would
	// come back as the next cursor on a request with no text yet and be sent forever.
	let since = typeof options?.since === 'number' && options.since > 0 ? options.since : 0;
	let onStream = options?.onStream;
	let onResponse = options?.onResponse;
	let onError = options?.onError;

	// The registry key is the full id, which cannot be composed until the connection
	// resolves (this.service is not populated before it). So the key and the resolve
	// handle live on a control object that the loop fills in and the stopper reads,
	// which is also what lets a stop arriving BEFORE that point still be honoured.
	let ctrl: { stopped: boolean; fullId: string; resolve: ((v: any) => void) | null } = {
		stopped: false,
		fullId: requestId,
		resolve: null,
	};

	// Set once the loop below has a websocket relay to put back. Lives out here because
	// the stopper is published before the loop runs, and a stop must leave the room
	// whether it arrives before, during or after the socket was joined.
	let liveTeardown: (() => void) | null = null;

	let entry: { stop: (() => void) | null; aborted: boolean; queue?: string } = {
		stop: null,
		aborted: false,
	};

	let release = () => {
		if (activePolls[ctrl.fullId] === entry) delete activePolls[ctrl.fullId];
	};

	let stop = () => {
		if (ctrl.stopped) return;
		ctrl.stopped = true;
		if (liveTeardown) liveTeardown();
		release();
		// A stop RESOLVES, matching every other poll in this file: callers await these
		// without a rejection handler, and turning a stop into a rejection would render
		// as a failure that never happened. onResponse is deliberately not called.
		if (ctrl.resolve) ctrl.resolve(stoppedResult(ctrl.fullId));
	};
	entry.stop = stop;

	let prom = new Promise<any>(async (resolve, reject) => {
		ctrl.resolve = resolve;

		try {
			await this.__connection;

			let auth = !!this.__user;
			let service = options?.service || this.service;
			let owner = options?.owner || this.owner;

			ctrl.fullId = composeRequestId(requestId, options?.url, options?.method, service);

			if (ctrl.stopped) {
				resolve(stoppedResult(ctrl.fullId));
				return;
			}

			// Registered under the same key the dispatch path uses, so
			// stopClientSecretPolling reaches this reader exactly as it reaches a poll.
			activePolls[ctrl.fullId] = entry;

			let cursor: StreamCursor = { seq: since };
			let stalled = 0;

			// Same opt-in as the dispatch path: a room to listen to, and a callback with
			// somewhere to put what arrives. The loop below is already the "history
			// fetch" of the read contract - it starts its first read immediately, while
			// the socket is still being opened - so nothing here has to be sequenced.
			let tlog = streamTransportLogger.call(this, ctrl.fullId);
			let sink: StreamSink = onStream && options?.realtimeGroup
				? createStreamSink(cursor, onStream, tlog.onTransport)
				: null;
			let relay: { stop: () => void } = sink
				? startRealtimeRelay.call(this, options.realtimeGroup, sink)
				: null;
			let endRealtime = () => {
				tlog.done(sink);
				if (relay) relay.stop();
				if (sink) sink.close();
			};
			liveTeardown = endRealtime;

			for (; ;) {
				let result = await request.bind(this)(
					'csr-poll',
					{ id: ctrl.fullId, service, owner, since: cursor.seq },
					{ auth },
				);

				if (ctrl.stopped) return;

				if (!isPollEnvelope(result)) {
					// A stored body rather than a status: the request was finalized, or it
					// was never streamed in the first place. Either way its answer is right
					// here and there is nothing left in the chunk store to read. Anything
					// the socket may have buffered in the meantime is dropped with it,
					// which is why nothing is rendered before this branch is ruled out.
					endRealtime();
					release();
					if (onResponse) onResponse(result);
					resolve(result);
					return;
				}

				let moved = sink ? sink.fromPoll(result) : deliverStreamChunks(result, cursor, onStream);
				// History rendered: release whatever the socket buffered while this read
				// was in flight. Idempotent, so only the first pass of the loop counts.
				if (sink) sink.open();
				let running = isRunningStatus(result);

				if (result.more && moved) {
					// A CAP stopped that read, not the end of the text. Page straight on:
					// this is how a finished turn is replayed in one pass instead of one
					// page per interval.
					stalled = 0;
					continue;
				}

				// `more` with nothing new means the read failed, not that it was capped.
				// Waiting out the interval is the correct reaction to that one.
				stalled = result.more ? stalled + 1 : 0;

				if (!running && (!result.more || stalled >= STREAM_DEGRADED_RETRIES)) {
					// Terminal and drained (or drained as far as a failing read allows).
					endRealtime();
					release();
					if (onResponse) onResponse(result);
					resolve(result);
					return;
				}

				// Throttled, never stopped, while the socket is delivering: the poll is
				// what fills a gap the socket dropped and the only thing that sees the
				// request settle. See REALTIME_IDLE_POLL_MS.
				await new Promise((r) => setTimeout(
					r,
					sink && sink.warm() ? Math.max(latency, REALTIME_IDLE_POLL_MS) : latency,
				));
				if (ctrl.stopped) return;
			}
		} catch (err) {
			if (ctrl.stopped) return;
			if (liveTeardown) liveTeardown();
			release();
			if (onError) onError(err);
			reject(err);
		}
	});

	// Exposed on the promise so a caller holding it can end the read without having to
	// reconstruct the id, same as a poll started by clientSecretRequest.
	return Object.assign(prom, { stop });
}

/**
 * Stores the version of a streamed request that you want kept, and releases the
 * pieces it was streamed in.
 *
 * A streamed request settles with a status and no body: the text lives in chunks, and
 * skapi never decides what those chunks add up to, because it never read them. This is
 * where you say. Whatever you send becomes that request's stored result, which is what
 * {@link clientSecretRequestHistory} lists and what a later poll of the same request
 * hands back.
 *
 * The content is entirely yours. Skapi does not validate it, parse it, or interpret it:
 * text you assembled from the chunks, a rebuilt response object, a summary, a single
 * word, anything. It is stored as given and returned as given.
 *
 * Storing a result is also what RELEASES the chunks, which are deleted once the result
 * lands. So finalize when you know what to keep, and not before: a request left
 * unfinalized keeps its chunks indefinitely, deliberately, and stays re-readable with
 * {@link clientSecretRequestStream} until you do. Finalizing twice simply replaces the
 * kept version, so a call lost to the network can be repeated.
 *
 * Only a streamed request can be finalized. A buffered one already stored the
 * destination's own answer, and that answer is not yours to overwrite.
 *
 * ```js
 * let text = '';
 * const res = await skapi.clientSecretRequest({
 *     url, clientSecretName, method: 'POST', headers, data,
 *     stream: true,
 *     poll: 1000,
 *     onStream: (chunk) => { text += chunk; }
 * });
 *
 * // Your parsing, your decision about what the turn amounted to.
 * await skapi.clientSecretRequestFinalize(res.id, extractAnswer(text), { url, method: 'POST' });
 * ```
 *
 * @param requestId The request id ("stamp:entropy"), or an already-composed full id.
 * @param data The version to keep. Sent verbatim; sending nothing keeps nothing.
 * @param options Where the request was sent. Required unless `requestId` is a full id.
 * @returns `{ finalized, message }`. `finalized: false` with a message when the request
 *          is unknown, has not finished yet, or was never streamed.
 */
export async function clientSecretRequestFinalize(
	this: any,
	requestId: string,
	data?: any,
	options?: {
		/** The url the request was sent to. Required unless `requestId` is a full id. */
		url?: string;
		/** The method it was sent with. Required unless `requestId` is a full id. */
		method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
		service?: string;
		owner?: string;
	},
): Promise<{ finalized: boolean; message: string }> {
	await this.__connection;

	let service = options?.service || this.service;
	let owner = options?.owner || this.owner;
	let auth = !!this.__user;
	let fullId = composeRequestId(requestId, options?.url, options?.method, service);

	// `data` goes up untouched and deliberately unvalidated: there is no schema for it
	// on either side, because neither side reads it. It is only ever stored and handed
	// back. The one thing worth knowing is that omitting it keeps null, which reads
	// back as a request whose answer is empty.
	return request.bind(this)(
		'csr-finalize',
		{ id: fullId, data, service, owner },
		{ auth },
	);
}

export async function sendInquiry(
	data: Form<{
		name: string;
		email: string;
		subject: string;
		message: string;
	}>,
): Promise<'SUCCESS: Inquiry has been sent.'> {
	await this.__connection;

	let params = {
		name: 'string',
		email: (v) => {
			validator.Email(v);
			return v;
		},
		subject: 'string',
		message: 'string',
	};

	data = validator.Params(data, params, [
		'name',
		'email',
		'subject',
		'message',
	]);

	await request.bind(this)('send-inquiry', data);

	return 'SUCCESS: Inquiry has been sent.';
}

export async function secureRequest<
	RequestParams = {
		/** Request url */
		url: string;
		/** Request data */
		data?: any;
		/** requests are sync when true */
		sync?: boolean;
	},
	Response = { response: any; statusCode: number; url: string },
>(
	params: RequestParams[] | Form<RequestParams>,
	url?: string,
): Promise<Response | Response[]> {
	await this.__connection;

	if (
		(hasFormData && params instanceof FormData) ||
		(hasHTMLFormElement && params instanceof HTMLFormElement) ||
		(hasSubmitEvent && params instanceof SubmitEvent)
	) {
		if (!url) {
			throw new SkapiError(
				'Url string as a second argument is required when form is passed.',
				{ code: 'INVALID_PARAMETER' },
			);
		}

		let formData = extractFormData(params);

		params = {
			url,
			data: formData.data,
			sync: true,
		} as Form<RequestParams>;
	}

	let paramsStruct = {
		url: (v: string) => {
			return validator.Url(v);
		},
		data: (v) => v,
		sync: ['boolean', () => true],
	};

	if (Array.isArray(params)) {
		for (let r of params) {
			r = validator.Params(r, paramsStruct);
		}
	} else {
		params = validator.Params(params, paramsStruct);
	}

	return request.bind(this)('post-secure', params, { auth: true });
}

export async function mock(
	data: Form<
		{ [key: string]: any } & {
			raise?:
			| 'ERR_INVALID_REQUEST'
			| 'ERR_INVALID_PARAMETER'
			| 'SOMETHING_WENT_WRONG'
			| 'ERR_EXISTS'
			| 'ERR_NOT_EXISTS';
		}
	>,
	options?: {
		auth?: boolean;
		method?: string;
		responseType?:
		| 'blob'
		| 'json'
		| 'text'
		| 'arrayBuffer'
		| 'formData'
		| 'document';
		contentType?: string;
		tokenHeaders?: {
			accessToken?: boolean | string;
			idToken?: boolean | string;
		};
		progress?: ProgressCallback;
	},
): Promise<{ [key: string]: any }> {
	await this.__connection;
	let {
		auth = false,
		method = 'POST',
		bypassAwaitConnection = false,
		responseType,
		contentType,
		tokenHeaders,
		progress,
	} = (options as any) || {};

	options = Object.assign(
		{
			auth,
			method,
			bypassAwaitConnection,
			responseType,
			contentType,
			tokenHeaders,
		},
		{
			fetchOptions: { progress },
		},
	);

	if (
		typeof data !== 'object' &&
		(contentType === 'application/json' || contentType === undefined)
	) {
		throw new SkapiError('"data" should be type: <object>.', {
			code: 'INVALID_PARAMETER',
		});
	}

	return request.bind(this)('mock', data, options);
}

/**
 * Relays a request to a destination of your choosing, from the server rather
 * than the browser, and streams the destination's response back as it arrives.
 *
 * Unlike {@link secureRequest}, the body is relayed VERBATIM: an html form
 * reaches the destination as multipart/form-data, files included. The form's own
 * enctype and method attributes are not used; the method comes from
 * options.method. The destination url and the headers
 * to send with it travel in the Content-Meta header, so nothing has to be mixed
 * into the body. Your service api key is added server side, where the browser
 * cannot read it; when the project has no key set the header is still sent, with
 * the value "none", so a backend can treat a missing header as "not from skapi".
 *
 * The destination's status code and response headers come back to the caller,
 * apart from hop-by-hop headers, set-cookie, and access-control-* (skapi writes
 * those from the project's cors setting, and a duplicate would make the browser
 * reject the response). Headers in `options.headers` go OUTBOUND only and have
 * no bearing on what the browser is allowed to read.
 *
 * ```js
 * // buffered
 * const res = await skapi.forwardRequest(formElement, {
 *     url: 'https://api.example.com/v1/report',
 *     headers: { Accept: 'application/json' }
 * });
 *
 * // streaming: onStream fires per chunk, the promise resolves with the whole body
 * await skapi.forwardRequest(formElement, {
 *     url: 'https://api.example.com/v1/chat',
 *     onStream: (chunk) => { output.textContent += chunk; }
 * });
 * ```
 *
 * This method deliberately bypasses the shared request pipeline: that pipeline
 * flattens forms into JSON, forces its own Content-Type, and reads responses
 * through XMLHttpRequest, which cannot surface bytes before the response is
 * complete.
 */
export async function forwardRequest(
	form: any,
	options: {
		/** Destination url. Must be http(s) and resolve to a public address. */
		url: string;
		/** Destination method. Defaults to POST. */
		method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
		/** Headers to send TO the destination. */
		headers?: { [key: string]: string };
		/** Header name to carry the service api key. Defaults to "x-api-key". */
		apiKeyHeader?: string;
		/** Scheme prefix for the api key, e.g. "Bearer". */
		apiKeyScheme?: string;
		/** Called with each chunk of text as it arrives. Presence of this enables streaming. */
		onStream?: (chunk: string) => void;
		/** Stops the client receiving the response. The request already sent to
		 * the destination is NOT cancelled and runs to completion. */
		signal?: AbortSignal;
		/** How to resolve the promise. Defaults to 'json' when the destination says json, else 'text'. */
		responseType?: 'json' | 'text' | 'response';
	},
): Promise<any> {
	await this.__connection;

	if (!options?.url || typeof options.url !== 'string') {
		throw new SkapiError('"url" is required in the second argument.', {
			code: 'INVALID_PARAMETER',
		});
	}
	validator.Url(options.url);

	const admin = await this.admin_endpoint;
	const endpoint = admin?.forward_request;
	if (!endpoint) {
		// An older cached endpoint json simply has no entry for this: say so,
		// rather than failing later with an opaque network error.
		throw new SkapiError('forwardRequest is not available on this service region yet.', {
			code: 'NOT_EXISTS',
		});
	}

	// The body is relayed as-is. A form element or submit event becomes native
	// FormData (multipart, boundary chosen by the browser, files preserved);
	// anything else is sent as json.
	let body: any = null;
	let contentType: string | null = null;
	const el =
		hasSubmitEvent && form instanceof SubmitEvent
			? (form.target as HTMLFormElement)
			: hasHTMLFormElement && form instanceof HTMLFormElement
				? form
				: null;

	if (el) {
		body = new FormData(el);
	} else if (hasFormData && form instanceof FormData) {
		body = form;
	} else if (form !== null && form !== undefined) {
		body = JSON.stringify(form);
		contentType = 'application/json';
	}

	const meta = {
		public_identifier: this.__public_identifier,
		service: this.service,
		owner: this.owner,
		forward: {
			url: options.url,
			method: options.method || 'POST',
			headers: options.headers || {},
			apiKeyHeader: options.apiKeyHeader,
			apiKeyScheme: options.apiKeyScheme,
		},
	};

	// A header value is a byte string: fetch() refuses any character above U+00FF,
	// so a destination url or a header value carrying non-ascii text (a Korean
	// query string, an accented note) would throw a bare TypeError from fetch and
	// never leave the browser. Escaping those to \uXXXX keeps this pure ascii and
	// still valid JSON, so the forwarder's JSON.parse sees the original text.
	const metaHeader = JSON.stringify(meta).replace(
		/[\u007f-\uffff]/g,
		(c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
	);
	// Measured on the ESCAPED string, since that is what goes on the wire.
	if (metaHeader.length > 4096) {
		// Header budget is shared with the tokens below; a destination that needs
		// more than this wants the payload in the body instead.
		throw new SkapiError('Destination url and headers are too large for Content-Meta.', {
			code: 'INVALID_PARAMETER',
		});
	}

	const idToken = this.bearerToken || this.session?.idToken?.jwtToken || null;
	if (!idToken) {
		throw new SkapiError('User login is required.', { code: 'INVALID_REQUEST' });
	}

	const headers: { [key: string]: string } = {
		'Content-Meta': metaHeader,
		Authorization: idToken,
	};
	if (contentType) headers['Content-Type'] = contentType;
	// FormData intentionally has no Content-Type set here: the browser must add
	// its own, including the multipart boundary.

	const res = await fetch(endpoint, {
		method: 'POST',
		headers,
		body,
		signal: options.signal,
	});

	if (options.responseType === 'response') return res;

	// An error response throws whether or not onStream was supplied. Gating this
	// on `!options.onStream` meant a streaming caller had the forwarder's own
	// error body ({"message":"Destination host is not routable.","code":...})
	// delivered to their callback as if it were backend output, and the promise
	// then RESOLVED with it. A failure must not look like content.
	if (!res.ok) {
		let payload: any = await res.text();
		try {
			payload = JSON.parse(payload);
		} catch { }
		throw new SkapiError(
			payload?.message || (typeof payload === 'string' ? payload : JSON.stringify(payload)),
			{ code: payload?.code || 'ERROR' },
		);
	}

	if (options.onStream && res.body) {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let whole = '';
		for (; ;) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			whole += chunk;
			try {
				options.onStream(chunk);
			} catch (err) {
				// A throwing callback should not strand the reader.
				console.error(err);
			}
		}
		return whole;
	}

	const text = await res.text();
	if (options.responseType === 'text') return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
