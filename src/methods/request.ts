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
		onError
	}: {
		id: string;
		auth: boolean;
		service?: any;
		owner?: any;
		latency?: number;
		queue?: string;
		onResponse?: (res: any) => void;
		onError?: (err: any) => void;
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
		let interval = setInterval(async () => {
			try {
				let result = await request.bind(this)(
					'csr-poll',
					{
						id,
						service,
						owner,
					},
					{ auth },
				);

				if (result.status === 'running' || result.status === 'pending') {
					return;
				}

				if (settled) return;
				settled = true;
				if (onResponse)
					onResponse(result);
				clearInterval(interval);
				release();
				resolve(result);
			} catch (e) {
				if (settled) return;
				settled = true;
				if (onError)
					onError(e);
				clearInterval(interval);
				release();
				reject(e);
			}
		}, latency);
		entry.stop = () => {
			if (settled) return;
			settled = true;
			clearInterval(interval);
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
	onResponse?: (res: any) => void; // response callback that works on both polling request and regular.
	onError?: (err: any) => void; // error callback that works on both pollubg request error and regular.
}): Promise<any | void | {
	id: string; // request id: "stamp:entropy"
	status: "pending";
	queue_name: string;
	in_queue: number;
	poll?: (arg?: { latency?: number }) => Promise<any>;
}> {
	let hasSecret = false;

	if (typeof params.poll === 'number' && params.poll < 0) {
		throw new SkapiError('"poll" should be a non-negative number.', {
			code: 'INVALID_PARAMETER',
		});
	}
	let onResponse = params?.onResponse;
	let onError = params?.onError;
	let latency = typeof params.poll === 'number' ? params.poll : params.poll ? 1000 : 0;
	delete params.poll;

	if (latency && !params.queue) {
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
						poll: (arg?: { latency?: number }) => pollClientSecretResponse.call(this, {
							id: fullId,
							auth,
							service: serviceId,
							owner: ownerId,
							latency: arg?.latency || 1000,
							queue: params?.queue,
							onResponse,
							onError
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
			}) => pollClientSecretResponse.call(this, {
				id: id + result.id,
				auth,
				service: service,
				owner: owner,
				latency: arg?.latency || 1000,
				queue: item?.qid,
				onResponse: arg?.onResponse,
				onError: arg?.onError
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

	const metaHeader = JSON.stringify(meta);
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
