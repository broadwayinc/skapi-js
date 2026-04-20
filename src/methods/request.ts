import {
    Form,
    FetchOptions,
    ProgressCallback
} from '../Types';
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { request } from '../utils/network';
import { extractFormData } from '../utils/utils';

const hasFormData = typeof FormData !== 'undefined';
const hasHTMLFormElement = typeof HTMLFormElement !== 'undefined';
const hasSubmitEvent = typeof SubmitEvent !== 'undefined';

export async function clientSecretRequest(params: {
    url: string;
    clientSecretName: string;
    method: 'GET' | 'POST' | 'DELETE' | 'PUT';
    headers?: { [key: string]: string };
    data?: { [key: string]: any };
    params?: { [key: string]: string };
    poll?: boolean | number;
}) {
    let hasSecret = false;

    let latency = typeof params.poll === 'number' ? params.poll : 1000;
    params.poll = !!params.poll;

    let checkClientSecretPlaceholder = (v: any) => {
        for (let k in v) {
            if (typeof v[k] === 'string' && v[k].includes('$CLIENT_SECRET')) {
                hasSecret = true;
                break;
            }
        }
    }

    params = validator.Params(params, {
        url: (v: string) => {
            if (!v || typeof v !== 'string') {
                throw new SkapiError('"url" should be type: <string>.', { code: 'INVALID_PARAMETER' });
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
                throw new SkapiError('"method" should be either "GET" or "POST" or "DELETE" or "PUT".', { code: 'INVALID_PARAMETER' });
            }
            let lo = v.toLowerCase();
            if (lo !== 'get' && lo !== 'post' && lo !== 'delete' && lo !== 'put') {
                throw new SkapiError('"method" should be either "GET" or "POST" or "DELETE" or "PUT".', { code: 'INVALID_PARAMETER' });
            }
            return lo;
        },
        headers: (v: any) => {
            if (v && typeof v !== 'object') {
                throw new SkapiError('"headers" should be type: <object>.', { code: 'INVALID_PARAMETER' });
            }
            checkClientSecretPlaceholder(v);
            return v;
        },
        data: (v: any) => {
            if (v && typeof v !== 'object') {
                throw new SkapiError('"data" should be type: <object>.', { code: 'INVALID_PARAMETER' });
            }
            checkClientSecretPlaceholder(v);
            return v;
        },
        params: (v: any) => {
            if (v && typeof v !== 'object') {
                throw new SkapiError('"params" should be type: <object>.', { code: 'INVALID_PARAMETER' });
            }
            checkClientSecretPlaceholder(v);
            return v;
        },
        poll: 'boolean'
    }, ['clientSecretName', 'method', 'url']);

    if (!hasSecret) {
        throw new SkapiError(`At least one parameter value should include "$CLIENT_SECRET" in ${params.method.toLowerCase() === 'post' ? '"data"' : '"params"'} or "headers".`, { code: 'INVALID_PARAMETER' });
    }

    await this.__connection;
    let auth = !!this.__user;

    return request.bind(this)("csr", params, { auth, tokenHeaders: {
        accessToken: !!auth
    }}).then(res=>{
        if (res.poll_id && res.status === 'pending') {
            return new Promise((resolve, reject) => {
                let interval = setInterval(async () => {
                    try {
                        let result = await request.bind(this)("csr-poll", { id: res.poll_id, service: params.service, owner: params.owner }, { auth });
                        if(result.id === res.poll_id && result.status === 'pending') {
                            return;
                        }
                        else if (result?.[0]) {
                            clearInterval(interval);
                            resolve(result[0]);
                        }
                    } catch (e) {
                        clearInterval(interval);
                        reject(e);
                    }
                }, latency);
            });
        } else {
            return res;
        }
    });
}

export async function clientSecretRequestHistory(params: {
    url: string;
    method: 'GET' | 'POST' | 'DELETE' | 'PUT';
}, fetchOptions?: FetchOptions):Promise<any[]> {
    await this.__connection;

    params = validator.Params(params, {
        url: 'string',
        method: ['GET', 'POST', 'DELETE', 'PUT']
    }, ['url', 'method']);

    let auth = !!this.__user;

    return request.bind(this)("csr-poll", {id: params.url.toLowerCase() + ':' + params.method.toLowerCase() + ':', service: params.service, owner: params.owner }, { auth, fetchOptions});
}

export async function sendInquiry(data: Form<{
    name: string;
    email: string;
    subject: string;
    message: string;
}>): Promise<"SUCCESS: Inquiry has been sent."> {
    await this.__connection;

    let params = {
        name: 'string',
        email: v => {
            validator.Email(v);
            return v;
        },
        subject: 'string',
        message: 'string'
    }

    data = validator.Params(data, params, [
        'name',
        'email',
        'subject',
        'message'
    ]);

    await request.bind(this)('send-inquiry', data);

    return 'SUCCESS: Inquiry has been sent.';
}

export async function secureRequest<RequestParams = {
    /** Request url */
    url: string;
    /** Request data */
    data?: any;
    /** requests are sync when true */
    sync?: boolean;
}, Response = { response: any; statusCode: number; url: string; }>(params: RequestParams[] | Form<RequestParams>, url?: string): Promise<Response | Response[]> {
    await this.__connection;

    if ((hasFormData && params instanceof FormData) || (hasHTMLFormElement && params instanceof HTMLFormElement) || (hasSubmitEvent && params instanceof SubmitEvent)) {
        if (!url) {
            throw new SkapiError('Url string as a second argument is required when form is passed.', { code: 'INVALID_PARAMETER' });
        }

        let formData = extractFormData(params);

        params = {
            url,
            data: formData.data,
            sync: true
        } as Form<RequestParams>
    }

    let paramsStruct = {
        url: (v: string) => {
            return validator.Url(v);
        },
        data: v => v,
        sync: ['boolean', () => true]
    };

    if (Array.isArray(params)) {
        for (let r of params) {
            r = validator.Params(r, paramsStruct);
        }
    }

    else {
        params = validator.Params(params, paramsStruct);
    }

    return request.bind(this)('post-secure', params, { auth: true });
};

export async function mock(
    data: Form<{ [key: string]: any } & { raise?: 'ERR_INVALID_REQUEST' | 'ERR_INVALID_PARAMETER' | 'SOMETHING_WENT_WRONG' | 'ERR_EXISTS' | 'ERR_NOT_EXISTS'; }>,
    options?: {
        auth?: boolean;
        method?: string;
        responseType?: 'blob' | 'json' | 'text' | 'arrayBuffer' | 'formData' | 'document';
        contentType?: string;
        tokenHeaders?: {
            accessToken?: boolean | string;
            idToken?: boolean | string;
        };
        progress?: ProgressCallback;
    }): Promise<{ [key:string]:any; }> {
    await this.__connection;
    let { auth = false, method = 'POST', bypassAwaitConnection = false, responseType, contentType, tokenHeaders, progress } = (options as any) || {};

    options = Object.assign(
        { auth, method, bypassAwaitConnection, responseType, contentType, tokenHeaders },
        {
            fetchOptions: { progress }
        }
    );

    if (typeof data !== 'object' && (contentType === 'application/json' || contentType === undefined)) {
        throw new SkapiError('"data" should be type: <object>.', { code: 'INVALID_PARAMETER' });
    }

    return request.bind(this)('mock', data, options);
};
