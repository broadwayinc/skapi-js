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
		},
		['url', 'method'],
	);

	let auth = !!this.__user;
	let id = `[${params.method.toUpperCase()}]${params.url.toLowerCase()}#${service}:`;

	let his_req = { id, queue: params?.queue, status: params?.status, service, owner };

	Object.keys(his_req).forEach((k) => {
		if (!his_req[k]) {
			delete his_req[k];
		}
	});

	if (his_req.queue) {
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
			updated: item?.utmp,
			request_body: item?.reqbdy,
			expires: item?.expt,
			status: item.stts,
			queue_name: item?.qid,
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
