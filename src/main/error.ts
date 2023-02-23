export default class SkapiError extends Error {
    code: string | number;
    cause: Error;
    constructor(
        error: any,
        options?: {
            code?: string;
            cause?: Error;
        }) {

        if (Array.isArray(error) && error.length <= 2) {
            super(error[1] || 'Something went wrong.');
            this.name = error[0] || "SKAPI";
            this.code = error[0] || "ERROR";

            if (options) {
                if (options.code) {
                    this.code = options.code;
                }

                if (options.cause) {
                    this.cause = options.cause;
                }
            }
        }
        else if (typeof error === 'string') {
            super(error || 'Something went wrong.');
            this.name = "SKAPI";
            this.code = 'ERROR';

            if (options) {
                if (options.code) {
                    this.code = options.code;
                }

                if (options.cause) {
                    this.cause = options.cause;
                }
            }
        }
        else if (error instanceof Error) {
            super(error.message || 'Something went wrong.');
            this.cause = error;
            this.name = error.name;
            if (error.hasOwnProperty('code')) {
                this.code = (error as any).code;
            }
        }
    }
}