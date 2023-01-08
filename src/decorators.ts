import { Form, FormCallbacks } from './Types';
import SkapiError from './skapi_error';
import { MD5 } from './utils';

function formResponse() {
    // wraps methods that requires form handling
    return function (target: object, propertyKey: string, descriptor: any) {
        const fn = descriptor.value;

        descriptor.value = function (...arg: any[]) {
            let form: Form | Record<string, any> = arg[0];
            let option: FormCallbacks = arg?.[1] || {};
            let routeWithDataKey = true;
            let formEl = null;
            let actionDestination = '';

            if (form instanceof SubmitEvent) {
                form.preventDefault();

                let currentUrl = window.location.href;
                formEl = form.target as HTMLFormElement;
                let href = new URL(formEl.action);
                actionDestination = href.href;

                if (!formEl.action || href.href === currentUrl) {
                    routeWithDataKey = false;
                }
            }

            const handleResponse = (response: any) => {
                if (option?.response) {
                    if (typeof option.response === 'function')
                        return option.response(response);
                    else
                        throw new SkapiError('Callback "response" should be type: function.', { code: 'INVALID_PARAMETER' });
                }

                if (formEl) {
                    if (routeWithDataKey) {
                        window.sessionStorage.setItem(`${this.service}:${MD5.hash(actionDestination)}`, JSON.stringify(response));
                        window.location.href = actionDestination;
                    }
                }

                // return if is not form element
                return response;
            };

            let response: any;
            function handleError(err: any) {
                let is_err = err instanceof Error ? err : new SkapiError(err);
                if (option?.onerror) {
                    if (typeof option.onerror === 'function')
                        return option.onerror(is_err);
                    else
                        throw new SkapiError('Callback "onerror" should be type: function.', { code: 'INVALID_PARAMETER' });
                }

                throw is_err;
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
                return (async () => {
                    try {
                        let resolved = await response;
                        return handleResponse(resolved);
                    }
                    catch (err) {
                        return handleError(err);
                    }
                })();
            }

            else {
                return handleResponse(response);
            }
        };
    };
}

export { formResponse };