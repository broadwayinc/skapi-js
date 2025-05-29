
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { extractFormData } from '../utils/utils';
import { request } from '../utils/network';
import { DatabaseResponse, FetchOptions, RealtimeCallback, WebSocketMessage } from '../Types';
import { answerSdpOffer, receiveIceCandidate, __peerConnection, __receiver_ringing, closeRTC, respondRTC, __caller_ringing, __rtcEvents } from './webrtc';
import { getJwtToken } from './user';

// let __roomList: {
//     [realTimeGroup: string]: {
//         [sender_id: string]: string[]; // connection id, (single person can have multiple connection id)
//     }
// } = {};

let __current_socket_room: string;
let __keepAliveInterval = null;
let closedByIntention = true;
let reconnectAttempts = 0;

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


let visibilitychange = null;

export async function closeRealtime(): Promise<void> {
    closedByIntention = true;
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;
    closeRTC.bind(this)({ close_all: true });

    if(__current_socket_room) {
        joinRealtime.bind(this)({ group: null });
    }

    // __roomList = {};
    reconnectAttempts = 0;

    if (__keepAliveInterval) {
        __keepAliveInterval.terminate();
        __keepAliveInterval = null;
    }

    try {
        if (socket) {
            socket.close();
        }
    }
    catch (e) { }

    window.removeEventListener('visibilitychange', visibilitychange);
    this.__socket = null;
    return null;
}

export async function connectRealtime(cb: RealtimeCallback, delay = 50, reconnect?: string): Promise<WebSocket> {
    if (typeof cb !== 'function') {
        throw new SkapiError(`Callback must be a function.`, { code: 'INVALID_REQUEST' });
    }

    if(reconnect === 'reconnect') {
        if(this.__socket instanceof Promise) {
            let socket = await this.__socket;
            if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
                return this.__socket;
            }
        }
    }

    else if (closedByIntention) {
        // if the connection was closed intentionally, and it's not a reconnect attempt
        visibilitychange = () => {
            if (!document.hidden && !closedByIntention) {
                connectRealtime.bind(this)(cb, 0, 'reconnect');
            }
        }

        if (this.__socket instanceof Promise) {
            return this.__socket;
        }
    }

    if (__keepAliveInterval) {
        __keepAliveInterval.terminate();
        __keepAliveInterval = null;
    }

    this.__socket = new Promise(async (resolve) => {
        await getJwtToken.bind(this)();

        setTimeout(async () => {
            let socket: WebSocket = await prepareWebsocket.bind(this)();

            socket.onopen = () => {
                closedByIntention = false;
                reconnectAttempts = 0;

                if (reconnect !== 'reconnect') {
                    window.addEventListener('visibilitychange', visibilitychange);
                }

                this.log('realtime onopen', 'Connected to WebSocket server.');
                cb({ type: 'success', message: 'Connected to WebSocket server.' });

                if (__current_socket_room) {
                    socket.send(JSON.stringify({
                        action: 'joinRoom',
                        rid: __current_socket_room,
                        token: this.session.accessToken.jwtToken
                    }));
                }

                // // keep alive

                // Define worker script as a string
                const workerScript = /*js*/`
                    let interval = 15000; // Set interval time 15 seconds

                    function runInterval() {
                        postMessage({ type: "ping" });
                        setTimeout(runInterval, interval); // Use setTimeout instead of setInterval
                    }

                    runInterval(); // Start interval
                `;

                // Create a Blob URL for the worker
                const blob = new Blob([workerScript], { type: "application/javascript" });
                __keepAliveInterval = new Worker(URL.createObjectURL(blob));

                // Listen for messages from the worker
                __keepAliveInterval.onmessage = (event) => {
                    if (socket.readyState === 1) {
                        socket.send(JSON.stringify({
                            action: 'keepAlive'
                        }));
                    }
                };

                resolve(socket);
            };

            socket.onmessage = async (event) => {
                let data = ''

                try {
                    data = JSON.parse(decodeURI(event.data));
                    this.log('socket onmessage', data);
                }
                catch (e) {
                    return;
                }

                let type;
                switch (true) {
                    case !!data?.['#message']:
                        type = 'message';
                        break;
                    case !!data?.['#private']:
                        type = 'private';
                        break;
                    case !!data?.['#notice']:
                        type = 'notice';
                        break;
                    case !!data?.['#rtc']:
                        type = 'rtc';
                        break;
                    case !!data?.['#error']:
                        type = 'error';
                        break;
                }

                if (!type) {
                    return;
                }

                let msg: WebSocketMessage = {
                    type,
                    message: data?.['#rtc'] || data?.['#message'] || data?.['#private'] || data?.['#notice'] || data?.['#error'] || null,
                    sender: data?.['#user_id'] || null,
                    sender_cid: !!data?.['#scid'] ? "cid:" + data['#scid'] : null,
                    sender_rid: data?.['#srid'] || null,
                    code: data?.['#code'] || null
                };

                if (type === 'notice') {
                    // if (__current_socket_room && (msg.code === 'USER_LEFT' || msg.code === 'USER_DISCONNECTED')) {
                    //     let user_id = msg.sender;
                    //     if (__roomList?.[__current_socket_room]?.[user_id]) {
                    //         __roomList[__current_socket_room][user_id] = __roomList[__current_socket_room][user_id].filter(v => v !== msg.sender_cid);
                    //     }

                    //     if (__roomList?.[__current_socket_room]?.[user_id] && __roomList[__current_socket_room][user_id].length === 0) {
                    //         delete __roomList[__current_socket_room][user_id];
                    //     }

                    //     if (__roomList?.[__current_socket_room]?.[user_id]) {
                    //         // user is still in the group don't call the callback
                    //         return
                    //     }
                    // }
                    // else if (__current_socket_room && msg.code === 'USER_JOINED') {
                    //     let user_id = msg.sender;
                    //     if (!__roomList?.[__current_socket_room]) {
                    //         __roomList[__current_socket_room] = {};
                    //     }
                    //     if (!__roomList[__current_socket_room][user_id]) {
                    //         __roomList[__current_socket_room][user_id] = [msg.sender_cid];
                    //     }
                    //     else {
                    //         if (!__roomList[__current_socket_room][user_id].includes(msg.sender_cid)) {
                    //             __roomList[__current_socket_room][user_id].push(msg.sender_cid);
                    //         }
                    //         return;
                    //     }
                    // }
                    cb(msg);
                }
                else if (type === 'rtc') {
                    // rtc signaling
                    if (msg.sender !== this.user.user_id) {
                        let rtc = msg.message;
                        if (rtc.hungup) {
                            // otherside has hung up the call
                            if (__caller_ringing[msg.sender_cid]) {
                                __caller_ringing[msg.sender_cid](false);
                                delete __caller_ringing[msg.sender_cid];
                            }
                            if (__receiver_ringing[msg.sender_cid]) {
                                delete __receiver_ringing[msg.sender_cid];
                            }
                            if (__peerConnection?.[msg.sender_cid]) {
                                closeRTC.bind(this)({ cid: msg.sender_cid });
                            }
                            msg.type = 'rtc:closed';
                            cb(msg);
                            return;
                        }
                        if (rtc.candidate) {
                            receiveIceCandidate.bind(this)(rtc.candidate, msg.sender_cid);
                        }
                        if (rtc.sdpoffer) {
                            answerSdpOffer.bind(this)(rtc.sdpoffer, msg.sender_cid);
                            if (!__receiver_ringing[msg.sender_cid]) {
                                __receiver_ringing[msg.sender_cid] = msg.sender_cid;
                                delete msg.message;

                                msg.connectRTC = respondRTC.bind(this)(msg);
                                msg.type = 'rtc:incoming';
                                msg.hangup = (() => {
                                    if (__peerConnection[msg.sender_cid]) {
                                        closeRTC.bind(this)({ cid: msg.sender_cid });
                                    }
                                    else if (__receiver_ringing[msg.sender_cid]) {
                                        delete __receiver_ringing[msg.sender_cid];
                                        socket.send(JSON.stringify({
                                            action: 'rtc',
                                            uid: msg.sender_cid,
                                            content: { hungup: this.user.user_id },
                                            token: this.session.accessToken.jwtToken
                                        }));
                                    }
                                }).bind(this);

                                cb(msg);
                            }
                        }
                        if (rtc.pickup) {
                            // receiver has answered the call
                            if (__caller_ringing[msg.sender_cid]) {
                                __caller_ringing[msg.sender_cid](true);
                                delete __caller_ringing[msg.sender_cid];
                            }
                        }
                        if (rtc.sdpanswer) {
                            if (__peerConnection[msg.sender_cid]) {
                                // receive answer from the receiver
                                if (__peerConnection[msg.sender_cid].signalingState === 'have-local-offer') {
                                    await __peerConnection[msg.sender_cid].setRemoteDescription(new RTCSessionDescription(rtc.sdpanswer));
                                }
                                else {
                                    throw new SkapiError(`Invalid signaling state.`, { code: 'INVALID_REQUEST' });
                                }
                            }
                        }
                    }
                }
                else {
                    cb(msg);
                }
            };

            socket.onclose = () => {
                if (closedByIntention) {
                    this.log('realtime onclose', 'WebSocket connection closed.');
                    cb({ type: 'close', message: 'WebSocket connection closed.' });
                }
                else {
                    this.log('realtime onclose', 'WebSocket unexpected close.');
                    cb({ type: 'error', message: 'Skapi: WebSocket unexpected close.' });

                    reconnectAttempts++;
                    if (reconnectAttempts < 3) {
                        this.log('realtime onclose', 'Reconnecting to WebSocket server...' + reconnectAttempts);
                        cb({ type: 'reconnect', message: 'Reconnecting to WebSocket server...' + reconnectAttempts });
                        connectRealtime.bind(this)(cb, 3000, 'reconnect');
                    }
                    else {
                        this.log('realtime onclose', 'Max reconnection attempts reached.');
                        cb({ type: 'error', message: 'Skapi: Max reconnection attempts reached.' });
                    }
                }
            };

            socket.onerror = () => {
                this.log('realtime onerror', 'WebSocket connection error.');
                cb({ type: 'error', message: 'Skapi: WebSocket connection error.' });
            };
        }, delay);
    });
}


export async function postRealtime(message: any, recipient: string, notification?: { config?: { always: boolean; }; title: string; body: string; }): Promise<{ type: 'success', message: 'Message sent.' }> {
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    if (!recipient) {
        throw new SkapiError(`No recipient.`, { code: 'INVALID_REQUEST' });
    }

    await getJwtToken.bind(this)();

    message = extractFormData(message).data;

    let notificationStr = '';
    if (notification) {
        notification = validator.Params(
            notification,
            {
                config: {
                    always: 'boolean'
                },
                title: 'string',
                body: 'string'
            },
            ['title', 'body']
        );
        // stringify notification and check if size exceeds 3kb
        notificationStr = JSON.stringify({ title: notification.title, body: notification.body });
        let notificationSize = new Blob([notificationStr]).size;
        if (notificationSize > 3072) {
            throw new SkapiError(`Notification size exceeds 3kb.`, { code: 'INVALID_PARAMETER' });
        }
    }

    if (socket.readyState === 1) {
        try {
            validator.UserId(recipient);
            socket.send(JSON.stringify({
                action: 'sendMessage',
                uid: recipient,
                content: message,
                notification: notificationStr,
                notificationConfig: notification?.config || {},
                // token: this.session.accessToken.jwtToken
                token: `IdT:${this.service}:${this.owner}:` + (this.session?.idToken?.jwtToken || 'null')
            }));

        } catch (err) {
            this.log('postRealtime:err', { err });
            if (__current_socket_room !== recipient) {
                throw new SkapiError(`User has not joined to the recipient group. Run joinRealtime({ group: "${recipient}" })`, { code: 'INVALID_REQUEST' });
            }

            socket.send(JSON.stringify({
                action: 'broadcast',
                rid: recipient,
                content: message,
                notification: notificationStr,
                notificationConfig: notification?.config || {},
                // token: this.session.accessToken.jwtToken,
                token: `IdT:${this.service}:${this.owner}:` + (this.session?.idToken?.jwtToken || 'null')
            }));
        }

        return { type: 'success', message: 'Message sent.' };
    }

    throw new SkapiError('Realtime connection is not open. Try reconnecting with connectRealtime().', { code: 'INVALID_REQUEST' });
}

export async function joinRealtime(params: { group?: string | null }): Promise<{ type: 'success', message: string }> {
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    await getJwtToken.bind(this)();
    params = extractFormData(params, { nullIfEmpty: true }).data;

    let { group = null } = params;
    if (!group && !__current_socket_room) {
        return { type: 'success', message: 'Left realtime message group.' }
    }

    if (group !== null && typeof group !== 'string') {
        throw new SkapiError(`"group" must be a string | null.`, { code: 'INVALID_PARAMETER' });
    }

    socket.send(JSON.stringify({
        action: 'joinRoom',
        rid: group,
        token: this.session.accessToken.jwtToken
    }));

    __current_socket_room = group;

    return { type: 'success', message: group ? `Joined realtime message group: "${group}".` : 'Left realtime message group.' }
}

export async function getRealtimeUsers(params: { group: string, user_id?: string }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<{ user_id: string; cid: string }[]>> {
    params = validator.Params(
        params,
        {
            user_id: (v: string) => validator.UserId(v, 'User ID in "user_id"'),
            group: ['string', () => {
                if (!__current_socket_room) {
                    throw new SkapiError(`No group has been joined. Otherwise "group" is required.`, { code: 'INVALID_REQUEST' });
                }
                return __current_socket_room;
            }]
        }
    );

    let res = await request.bind(this)(
        'get-ws-group',
        params,
        {
            fetchOptions,
            auth: true,
            method: 'post'
        }
    );

    res.list = res.list.map((v: any) => {
        let user_id = v.uid.split('#')[1];
        // if (!params.user_id) {
        //     if (!__roomList[params.group]) {
        //         __roomList[params.group] = {};
        //     }
        //     if (!__roomList[params.group][user_id]) {
        //         __roomList[params.group][user_id] = [v.cid];
        //     }
        //     else if (!__roomList[params.group][user_id].includes(v.cid)) {
        //         __roomList[params.group][user_id].push(v.cid);
        //     }
        // }

        return {
            user_id,
            cid: "cid:" + v.cid
        }
    });

    return res;
}

export async function getRealtimeGroups(
    params?: {
        /** Index name to search. */
        searchFor: 'group' | 'number_of_users';
        /** Index value to search. */
        value?: string | number;
        /** Search condition. */
        condition?: '>' | '>=' | '=' | '<' | '<=' | '!=' | 'gt' | 'gte' | 'eq' | 'lt' | 'lte' | 'ne';
        /** Range of search. */
        range?: string | number;
    } | null,
    fetchOptions?: FetchOptions
): Promise<DatabaseResponse<{ group: string; number_of_users: number; }>> {
    await this.__connection;

    if (!params) {
        params = { searchFor: 'group', value: ' ', condition: '>' };
    }

    params = validator.Params(
        params,
        {
            searchFor: ['group', 'number_of_users', () => 'group'],
            value: ['string', 'number', () => {
                if (params?.searchFor && params?.searchFor === 'number_of_users') {
                    return 0;
                }

                return ' ';
            }],
            condition: ['>', '>=', '=', '<', '<=', '!=', 'gt', 'gte', 'eq', 'lt', 'lte', 'ne'],
            range: ['string', 'number']
        }
    );

    if (!params.condition) {
        if (params.value === ' ' || !params.value) {
            params.condition = '>';
        }
        else {
            params.condition = '=';
        }
    }

    if (params.range && params.condition) {
        delete params.condition;
    }

    if (params.searchFor === 'number_of_users' && typeof params.value !== 'number') {
        throw new SkapiError(`"value" must be a number.`, { code: 'INVALID_PARAMETER' });
    }
    if (params.searchFor === 'group' && typeof params.value !== 'string') {
        throw new SkapiError(`"value" must be a string.`, { code: 'INVALID_PARAMETER' });
    }
    if (params.hasOwnProperty('range') && typeof params.range !== typeof params.value) {
        throw new SkapiError(`"range" must be a ${typeof params.value}.`, { code: 'INVALID_PARAMETER' });
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

    res.list = res.list.map((v: any) => {
        return {
            group: v.rid.split('#')[1],
            number_of_users: v.cnt
        }
    });

    return res;
}