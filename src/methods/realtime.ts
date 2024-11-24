
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { extractFormData } from '../utils/utils';
import { request } from '../utils/network';
import { DatabaseResponse, FetchOptions, RealtimeCallback, WebSocketMessage } from '../Types';
import { answerSdpOffer, receiveIceCandidate, __peerConnection, __receiver_ringing, closeRTC, respondRTC, __caller_ringing, __rtcCallbacks } from './webrtc';

let __roomList: {
    [realTimeGroup: string]: {
        [sender_id: string]: string[]; // connection id, (single person can have multiple connection id)
    }
} = {};

let __current_socket_room: string;
let __keepAliveInterval = null;
let __cid: {[user_id:string]:string} = {};

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

export function connectRealtime(cb: RealtimeCallback, delay = 10): Promise<WebSocket> {
    if (typeof cb !== 'function') {
        throw new SkapiError(`Callback must be a function.`, { code: 'INVALID_REQUEST' });
    }

    if (this.__socket instanceof Promise) {
        return this.__socket;
    }

    this.__socket = new Promise(resolve => {
        setTimeout(async () => {
            let socket: WebSocket = await prepareWebsocket.bind(this)();

            socket.onopen = () => {
                this.log('realtime onopen', 'Connected to WebSocket server.');
                cb({ type: 'success', message: 'Connected to WebSocket server.' });

                if (__current_socket_room) {
                    socket.send(JSON.stringify({
                        action: 'joinRoom',
                        rid: __current_socket_room,
                        token: this.session.accessToken.jwtToken
                    }));
                }

                // keep alive
                __keepAliveInterval = setInterval(() => {
                    if (socket.readyState === 1) {
                        socket.send(JSON.stringify({
                            action: 'keepAlive',
                            token: this.session.accessToken.jwtToken
                        }));
                    }
                }, 30000);

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

                let msg: WebSocketMessage = {
                    type,
                    message: data?.['#rtc'] || data?.['#message'] || data?.['#private'] || data?.['#notice'] || data?.['#error'] || null,
                    sender: !!data['#user_id'] ? data['#user_id'] : null,
                    sender_cid: !!data?.['#scid'] ? "cid:" + data['#scid'] : null,
                    sender_rid: !!data?.['#srid'] ? data['#srid'] : null
                };

                if (type === 'notice') {
                    if (__current_socket_room && (msg.message.includes('has left the message group.') || msg.message.includes('has been disconnected.'))) {
                        let user_id = msg.sender;
                        if (__roomList?.[__current_socket_room]?.[user_id]) {
                            __roomList[__current_socket_room][user_id] = __roomList[__current_socket_room][user_id].filter(v => v !== msg.sender_cid);
                        }

                        if (__roomList?.[__current_socket_room]?.[user_id] && __roomList[__current_socket_room][user_id].length === 0) {
                            delete __roomList[__current_socket_room][user_id];
                        }

                        if (__roomList?.[__current_socket_room]?.[user_id]) {
                            return
                        }
                    }
                    else if (__current_socket_room && msg.message.includes('has joined the message group.')) {
                        let user_id = msg.sender;
                        if (!__roomList?.[__current_socket_room]) {
                            __roomList[__current_socket_room] = {};
                        }
                        if (!__roomList[__current_socket_room][user_id]) {
                            __roomList[__current_socket_room][user_id] = [msg.sender_cid];
                        }
                        else {
                            if (!__roomList[__current_socket_room][user_id].includes(msg.sender_cid)) {
                                __roomList[__current_socket_room][user_id].push(msg.sender_cid);
                            }
                            return;
                        }
                    }
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

            socket.onclose = event => {
                if (event.wasClean) {
                    this.log('realtime onclose', 'WebSocket connection closed.');
                    cb({ type: 'close', message: 'WebSocket connection closed.' });
                    closeRealtime.bind(this)();
                }
                else {
                    // Handle max reconnection attempts reached
                    this.log('realtime onclose', 'WebSocket connection error. Max reconnection attempts reached.');
                    cb({ type: 'error', message: 'Skapi: WebSocket unexpected close.' });
                    closeRealtime.bind(this)();
                }
            };

            socket.onerror = () => {
                this.log('realtime onerror', 'WebSocket connection error.');
                cb({ type: 'error', message: 'Skapi: WebSocket connection error.' });
            };
        }, delay);
    });
}

export async function closeRealtime(): Promise<void> {
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;
    closeRTC.bind(this)({ close_all: true });
    if (__keepAliveInterval) {
        clearInterval(__keepAliveInterval);
        __keepAliveInterval = null;
    }

    try {
        if (socket) {
            socket.close();
        }
    }
    catch (e) { }

    this.__socket = null;
    __current_socket_room = null;

    return null;
}

export async function postRealtime(message: any, recipient: string): Promise<{ type: 'success', message: 'Message sent.' }> {
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    if (!recipient) {
        throw new SkapiError(`No recipient.`, { code: 'INVALID_REQUEST' });
    }

    message = extractFormData(message).data;

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
            if (__current_socket_room !== recipient) {
                throw new SkapiError(`User has not joined to the recipient group. Run joinRealtime({ group: "${recipient}" })`, { code: 'INVALID_REQUEST' });
            }

            socket.send(JSON.stringify({
                action: 'broadcast',
                rid: recipient,
                content: message,
                token: this.session.accessToken.jwtToken
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

    params = extractFormData(params).data;

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
        if (!params.user_id) {
            if (!__roomList[params.group]) {
                __roomList[params.group] = {};
            }
            if (!__roomList[params.group][user_id]) {
                __roomList[params.group][user_id] = [v.cid];
            }
            else if (!__roomList[params.group][user_id].includes(v.cid)) {
                __roomList[params.group][user_id].push(v.cid);
            }
        }

        return {
            user_id,
            cid: v.cid
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
        params = { searchFor: 'group' };
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