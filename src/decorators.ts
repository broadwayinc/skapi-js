import { Form, FormCallbacks } from './Types';
import SkapiError from './skapi_error';
import { MD5 } from './utils';

function formResponse() {
    // wraps methods that requires form handling
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor) {
        const fn = descriptor.value;

        descriptor.value = function (...arg: any[]) {
            let form: Form | Record<string, any> = arg[0];
            let option: FormCallbacks = arg?.[1] || {};

            const handleResponse = (response: any) => {
                if (option?.response) {
                    if (typeof option.response === 'function') {
                        // return response callback
                        option.response(response);
                        return response;
                    } else {
                        throw new SkapiError('Callback "response" should be type: function.', { code: 'INVALID_PARAMETER' });
                    }
                }

                if (!(form instanceof HTMLFormElement)) {
                    // return if is not form element
                    return response;
                }

                // form element action
                let currentUrl = window.location.href;

                let href = new URL(form.action);
                if (href.href !== currentUrl) {
                    let response_key = MD5.hash(form.action);
                    let timestamp = Date.now().toString();

                    window.sessionStorage.setItem(response_key, JSON.stringify({ [timestamp]: response }));
                    href.searchParams.set(response_key, timestamp);
                    window.location.href = href.href;
                }
                else {
                    return response;
                }
            };

            let response: any;
            function handleError(err: any) {
                let is_err = err instanceof Error ? err : new SkapiError(err);
                if (option?.onerror) {
                    if (typeof option.onerror === 'function') {
                        // onerror callback
                        return option.onerror(is_err);
                    } else {
                        throw new SkapiError('Callback "onerror" should be type: function.', { code: 'INVALID_PARAMETER' });
                    }
                }

                return is_err;
            }

            try {
                // execute
                response = fn.bind(this)(...arg);
            }

            catch (err) {
                let is_err = handleError(err);
                if (is_err instanceof Error) {
                    throw is_err;
                }

                return is_err;
            }

            if (response instanceof Promise) {
                // handle promise
                return new Promise((res, rej) => {
                    response
                        .then((r: any) => {
                            res(handleResponse(r));
                        })
                        .catch((err: any) => {
                            err = handleError(err);
                            if (err instanceof Error) {
                                rej(err);
                            } else {
                                res(err);
                            }
                        });
                });
            }

            else {
                return handleResponse(response);
            }
        };
    };
}

export { formResponse };