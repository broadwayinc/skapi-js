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
	[queue_name: string]: Qpass
} = {};

let queueJobId: {
	[full_id: string]: string;
} = {};

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
) {
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

	let prom = () => new Promise<any>((resolve, reject) => {
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

				if (onResponse)
					onResponse(result);
				clearInterval(interval);
				resolve(result);
			} catch (e) {
				if (onError)
					onError(e);
				clearInterval(interval);
				reject(e);
			}
		}, latency);
	});

	if (queue) {
		let jobId = queuePromiseList[queue].add([prom])[0];
		queueJobId[id] = jobId;
	}
	else {
		return prom();
	}
}

export function getClientSecretRequestQueueCount(
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
}): Promise<any | {
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

	if(latency && !params.queue) {
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

				if (latency > 0) {
					let p = pollClientSecretResponse.call(this, {
						id: fullId,
						auth,
						service: serviceId,
						owner: ownerId,
						latency,
						queue: params?.queue,
						onResponse,
						onError
					});

					if (p instanceof Promise) {
						p.catch(() => { });
					}

					return res;
				}
				else {
					Object.assign(res, {
						poll: async (arg?: { latency?: number }) => pollClientSecretResponse.call(this, {
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
					return res;
				}
			}
			else {
				if (onResponse)
					return onResponse(res);
				return res;
			}
		}).catch(err => { if (onError) return onError(err); throw err; });
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
