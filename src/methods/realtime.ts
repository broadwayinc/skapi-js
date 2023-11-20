
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { extractFormMeta } from '../utils/utils';
import { request } from './request';
import { DatabaseResponse, FetchOptions } from '../Types';

async function prepareWebsocket() {
    // Connect to the WebSocket server
    await this.getProfile();

    if (!this.session) {
        throw new SkapiError(`No access.`, { code: 'INVALID_REQUEST' });
    }

    let r = await this.record_endpoint;

    return new WebSocket(
        r.websocket_private + '?token=' + this.session.accessToken.jwtToken
    );
}

type RealtimeCallback = (rt: {
    status: 'message' | 'error' | 'success' | 'close' | 'notice';
    message: any;
}) => void;

let reconnectAttempts = 0;

export async function closeRealtime(): Promise<void> {
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (socket) {
        socket.close();
    }

    this.__socket = null;
    this.__socket_group = null;

    return null;
}

export function connectRealtime(cb: RealtimeCallback, delay = 0): Promise<WebSocket> {
    if (typeof cb !== 'function') {
        throw new SkapiError(`Callback must be a function.`, { code: 'INVALID_REQUEST' });
    }

    if (reconnectAttempts || !(this.__socket instanceof Promise)) {
        this.__socket = new Promise(resolve => {
            setTimeout(async () => {
                await this.__connection;
                let socket: WebSocket = await prepareWebsocket.bind(this)();

                socket.onopen = () => {
                    reconnectAttempts = 0;
                    cb({ status: 'success', message: 'Connected to WebSocket server.' });

                    if (this.__socket_group) {
                        socket.send(JSON.stringify({
                            action: 'joinGroup',
                            rid: this.__socket_group,
                            token: this.session.accessToken.jwtToken
                        }));
                    }
                    resolve(socket);
                };

                socket.onmessage = event => {
                    let data = JSON.parse(decodeURI(event.data));
                    if (data?.['#notice']) {
                        cb({ status: 'notice', message: data['#notice'] });
                    }
                    else {
                        cb({ status: 'message', message: data });
                    }
                };

                socket.onclose = event => {
                    if (event.wasClean) {
                        cb({ status: 'close', message: 'WebSocket connection closed.' });
                        this.__socket = null;
                        this.__socket_group = null;
                    }
                    else {
                        // close event was unexpected
                        const maxAttempts = 10;
                        reconnectAttempts++;

                        if (reconnectAttempts < maxAttempts) {
                            let delay = Math.min(1000 * (2 ** reconnectAttempts), 30000); // max delay is 30 seconds
                            cb({ status: 'error', message: `Skapi: WebSocket connection error. Reconnecting in ${delay / 1000} seconds...` });
                            connectRealtime.bind(this)(cb, delay);
                        } else {
                            // Handle max reconnection attempts reached
                            cb({ status: 'error', message: 'Skapi: WebSocket connection error. Max reconnection attempts reached.' });
                            this.__socket = null;
                        }
                    }
                };

                socket.onerror = () => {
                    cb({ status: 'error', message: 'Skapi: WebSocket connection error.' });
                    throw new SkapiError(`Skapi: WebSocket connection error.`, { code: 'ERROR' });
                };
            }, delay);
        });
    }

    return this.__socket;
}

export async function postRealtime(message: any, recipient: string): Promise<{ status: 'success', message: 'Message sent.' } | { status: 'error', message: 'Realtime connection is not open.' }> {
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }


    if (!recipient) {
        throw new SkapiError(`No recipient.`, { code: 'INVALID_REQUEST' });
    }

    if (message instanceof FormData || message instanceof SubmitEvent || message instanceof HTMLFormElement) {
        message = extractFormMeta(message).meta;
    }

    if (socket.readyState === 1) {
        try {
            validator.UserId(recipient);
            socket.send(JSON.stringify({
                action: 'sendMessage',
                uid: recipient,
                content: message,
                token: this.session.accessToken.jwtToken
            }));

        } catch (err) {
            if (this.__socket_group !== recipient) {
                throw new SkapiError(`User has not joined to the recipient group. Run joinRealtime("${recipient}")`, { code: 'INVALID_REQUEST' });
            }

            socket.send(JSON.stringify({
                action: 'broadcast',
                rid: recipient,
                content: message,
                token: this.session.accessToken.jwtToken
            }));
        }

        return { status: 'success', message: 'Message sent.' };
    }

    return { status: 'error', message: 'Realtime connection is not open.' };
}

export async function joinRealtime(params: { group?: string | null }): Promise<{ status: 'success', message: string }> {
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    if (params instanceof FormData || params instanceof SubmitEvent || params instanceof HTMLFormElement) {
        params = extractFormMeta(params).meta;
    }

    let { group = null } = params;

    if (!group && !this.__socket_group) {
        return { status: 'success', message: 'Left realtime message group.' }
    }

    if (group !== null && typeof group !== 'string') {
        throw new SkapiError(`"group" must be a string | null.`, { code: 'INVALID_PARAMETER' });
    }

    socket.send(JSON.stringify({
        action: 'joinGroup',
        rid: group,
        token: this.session.accessToken.jwtToken
    }));

    this.__socket_group = group;

    return { status: 'success', message: group ? `Joined realtime message group: "${group}".` : 'Left realtime message group.' }
}

export async function getRealtimeUsers(params: { group: string, user_id?: string }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<string[]>> {
    await this.__connection;

    params = validator.Params(
        params,
        {
            user_id: (v: string) => validator.UserId(v, 'User ID in "user_id"'),
            group: 'string'
        },
        ['group']
    );

    if (!params.group) {
        throw new SkapiError(`"group" is required.`, { code: 'INVALID_PARAMETER' });
    }

    let res = await request.bind(this)(
        'get-ws-group',
        params,
        {
            fetchOptions,
            auth: true,
            method: 'post'
        }
    )

    for (let i = 0; i < res.list.length; i++) {
        res.list[i] = res.list[i].uid.split('#')[1];
    }

    return res;
}