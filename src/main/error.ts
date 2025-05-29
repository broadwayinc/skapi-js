export default class SkapiError extends Error {
    code: string | number;
    cause: Error;

    constructor(
        error: any,
        options?: {
            name?: string;
            code?: string;
            cause?: Error;
        }) {

        if (Array.isArray(error) && error.length <= 2) {
            // "code: msg".split(':') => ["code", "msg"]

            let msg = error[1];
            if (error.length > 2) {
                for (let i = 2; i < error.length; i++) {
                    if (typeof error[i] === 'string') {
                        msg += error[i];
                    }
                    else {
                        break;
                    }
                }
            }

            super((msg || 'Something went wrong.').trim());
            this.name = options?.name || "SKAPI";
            this.code = options?.code || error[0] || "ERROR";
            if (options?.cause) {
                this.cause = options.cause;
            }
        }
        else {
            super((error?.message || ((typeof error === 'string') ? error : 'Something went wrong.')).trim());

            if (typeof error === 'string') {
                this.name = options?.name || "SKAPI";
                this.code = options?.code || 'ERROR';
                if (options?.cause) {
                    this.cause = options.cause;
                }
            }

            else if (error instanceof Error) {
                this.cause = error;
                this.name = error.name;
                if (error.hasOwnProperty('code')) {
                    this.code = (error as any).code;
                }
            }

            else if (typeof error === 'object' && error?.code && error?.message) {
                this.name = options?.name || "SKAPI";
                this.code = options?.code || 'ERROR';
                this.cause = error?.cause;
            }
        }
    }
}