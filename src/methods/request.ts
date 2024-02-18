import {
    Form,
    ProgressCallback
} from '../Types';
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { request } from '../utils/network';

export function clientSecretRequest(params: {
    url: string;
    clientSecretName: string;
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    data?: Record<string, string>;
    params?: Record<string, string>;
}) {
    let hasSecret = false;

    let checkClientSecretPlaceholder = (v: any) => {
        for (let k in v) {
            if (typeof v[k] === 'string' && v[k].includes('$CLIENT_SECRET')) {
                hasSecret = true;
                break;
            }
        }
    }

    validator.Params(params, {
        url: 'string',
        clientSecretName: 'string',
        method: (v: string) => {
            if (v && typeof v !== 'string') {
                throw new SkapiError('"method" should be type: <string>.', { code: 'INVALID_PARAMETER' });
            }
            if (v.toLowerCase() !== 'get' && v.toLowerCase() !== 'post') {
                throw new SkapiError('"method" should be either "GET" or "POST".', { code: 'INVALID_PARAMETER' });
            }
            return v.toLowerCase();
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
        }
    }, ['clientSecretName', 'method', 'url']);

    if (!hasSecret) {
        throw new SkapiError(`At least one parameter value should include "$CLIENT_SECRET" in ${params.method.toLowerCase() === 'post' ? '"data"' : '"params"'} or "headers".`, { code: 'INVALID_PARAMETER' });
    }

    return request.bind(this)("client-secret-request", params);
}

export async function secureRequest<RequestParams = {
    /** Request url */
    url: string;
    /** Request data */
    data?: any;
    /** requests are sync when true */
    sync?: boolean;
}, Response = { response: any; statusCode: number; url: string; }>(params: RequestParams | RequestParams[]): Promise<Response | Response[]> {
    await this.__connection;

    let paramsStruct = {
        url: (v: string) => {
            return validator.Url(v);
        },
        data: null,
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

export async function mock(data: Form<any & {
    raise?: 'ERR_INVALID_REQUEST' | 'ERR_INVALID_PARAMETER' | 'SOMETHING_WENT_WRONG' | 'ERR_EXISTS' | 'ERR_NOT_EXISTS';
}>,
    options?: {
        auth?: boolean;
        method?: string;
        responseType?: string;
        contentType?: string;
        progress?: ProgressCallback;
        bypassAwaitConnection?: boolean;
    }): Promise<{ mockResponse: Record<string, any>; }> {
    await this.__connection;
    let { auth = true, method = 'POST', bypassAwaitConnection = false, responseType, contentType, progress } = options || {};

    options = Object.assign(
        { auth, method, bypassAwaitConnection, responseType, contentType },
        {
            fetchOptions: { progress }
        }
    );

    return request.bind(this)('mock', data, options);
};
