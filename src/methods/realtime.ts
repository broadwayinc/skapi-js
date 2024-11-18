
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { extractFormData } from '../utils/utils';
import { request } from '../utils/network';
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
    type: 'message' | 'error' | 'success' | 'close' | 'notice' | 'private' | 'sdpOffer' | 'sdpBroadcast';
    message: any;
    sender?: string; // user_id of the sender
    sender_cid?: string; // scid of the sender
}) => void;

let reconnectAttempts = 0;

let __roomList = {}; // { group: { user_id: [connection_id, ...] } }
let __roomPending = {}; // { group: Promise }
let __keepAliveInterval = null;
export function connectRealtime(cb: RealtimeCallback, delay = 0): Promise<WebSocket> {
    if (typeof cb !== 'function') {
        throw new SkapiError(`Callback must be a function.`, { code: 'INVALID_REQUEST' });
    }

    if (reconnectAttempts || !(this.__socket instanceof Promise)) {
        this.__socket = new Promise(async resolve => {
            setTimeout(async () => {
                await this.__connection;

                let user = await this.getProfile();
                if (!user) {
                    throw new SkapiError(`No access.`, { code: 'INVALID_REQUEST' });
                }

                let socket: WebSocket = await prepareWebsocket.bind(this)();

                socket.onopen = () => {
                    reconnectAttempts = 0;
                    cb({ type: 'success', message: 'Connected to WebSocket server.' });

                    if (this.__socket_room) {
                        socket.send(JSON.stringify({
                            action: 'joinRoom',
                            rid: this.__socket_room,
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
                        this.log('onmessage', data);
                    }
                    catch (e) {
                        return;
                    }
                    let type: 'message' | 'error' | 'success' | 'close' | 'notice' | 'private' | 'sdpOffer' | 'sdpBroadcast' = 'message';
                    let sdp = '';
                    if (data?.['#message']) {
                        type = 'message';
                    }

                    else if (data?.['#private']) {
                        type = 'private';
                    }

                    else if (data?.['#notice']) {
                        type = 'notice';
                    }

                    else if (data?.['#sdpOffer']) {
                        type = 'sdpOffer';
                        sdp = data['#sdpOffer'];
                        try {
                            sdp = JSON.parse(sdp);
                        }
                        catch (e) {
                        }
                    }

                    else if (data?.['#sdpBroadcast']) {
                        type = 'sdpBroadcast';
                        sdp = data['#sdpBroadcast'];
                        try {
                            sdp = JSON.parse(sdp);
                        }
                        catch (e) {
                        }
                    }

                    let msg: {
                        type: 'message' | 'error' | 'success' | 'close' | 'notice' | 'private' | 'sdpOffer' | 'sdpBroadcast';
                        message: any;
                        sender?: string;
                        sender_cid?: string;
                    } = { type, message: type === 'sdpOffer' || type === 'sdpBroadcast' ? sdp : (data?.['#message'] || data?.['#private'] || data?.['#notice']) || null };

                    if (data?.['#user_id']) {
                        msg.sender = data['#user_id'];
                    }

                    if (data?.['#scid']) {
                        msg.sender_cid = 'scid:' + data['#scid'];
                    }

                    if (type === 'notice') {
                        if (this.__socket_room && (msg.message.includes('has left the message group.') || msg.message.includes('has been disconnected.'))) {
                            if (__roomPending[this.__socket_room]) {
                                await __roomPending[this.__socket_room];
                            }

                            let user_id = msg.sender;
                            if (__roomList?.[this.__socket_room]?.[user_id]) {
                                __roomList[this.__socket_room][user_id] = __roomList[this.__socket_room][user_id].filter(v => v !== msg.sender_cid);
                            }

                            if (__roomList?.[this.__socket_room]?.[user_id] && __roomList[this.__socket_room][user_id].length === 0) {
                                delete __roomList[this.__socket_room][user_id];
                            }

                            if (__roomList?.[this.__socket_room]?.[user_id]) {
                                return
                            }
                        }
                        else if (this.__socket_room && msg.message.includes('has joined the message group.')) {
                            if (__roomPending[this.__socket_room]) {
                                await __roomPending[this.__socket_room];
                            }

                            let user_id = msg.sender;
                            if (!__roomList?.[this.__socket_room]) {
                                __roomList[this.__socket_room] = {};
                            }
                            if (!__roomList[this.__socket_room][user_id]) {
                                __roomList[this.__socket_room][user_id] = [msg.sender_cid];
                            }
                            else {
                                if (!__roomList[this.__socket_room][user_id].includes(msg.sender_cid)) {
                                    __roomList[this.__socket_room][user_id].push(msg.sender_cid);
                                }
                                return;
                            }
                        }
                    }

                    cb(msg);
                };

                socket.onclose = event => {
                    if (event.wasClean) {
                        // remove keep alive
                        clearInterval(__keepAliveInterval);
                        __keepAliveInterval = null;

                        cb({ type: 'close', message: 'WebSocket connection closed.' });
                        this.__socket = null;
                        this.__socket_room = null;
                    }
                    else {
                        // close event was unexpected
                        const maxAttempts = 10;
                        reconnectAttempts++;

                        if (reconnectAttempts < maxAttempts) {
                            let delay = Math.min(1000 * (2 ** reconnectAttempts), 30000); // max delay is 30 seconds
                            cb({ type: 'error', message: `Skapi: WebSocket connection error. Reconnecting in ${delay / 1000} seconds...` });
                            connectRealtime.bind(this)(cb, delay);
                        } else {
                            // Handle max reconnection attempts reached
                            cb({ type: 'error', message: 'Skapi: WebSocket connection error. Max reconnection attempts reached.' });
                            this.__socket = null;
                        }
                    }
                };

                socket.onerror = () => {
                    cb({ type: 'error', message: 'Skapi: WebSocket connection error.' });
                    throw new SkapiError(`Skapi: WebSocket connection error.`, { code: 'ERROR' });
                };
            }, delay);
        });
    }

    return this.__socket;
}

export async function closeRealtime(): Promise<void> {
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (socket) {
        socket.close();
    }

    this.__socket = null;
    this.__socket_room = null;

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
            if (this.__socket_room !== recipient) {
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

export async function connectRTC(
    params: {
        recipient: string;
        ice?: string;
        callback?: {
            onicecandidate?: (e: any) => void;
            onnegotiationneeded?: (e: any) => void;
            onerror?: (e: any) => void;
        }
    }
): Promise<any> {
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    let { recipient, ice = "stun:stun.skapi.com:3468", callback = {} } = extractFormData(params).data;

    if (!recipient) {
        throw new SkapiError(`No recipient.`, { code: 'INVALID_REQUEST' });
    }

    if (socket.readyState === 1) {
        // Call STUN server to get IP address
        const configuration = {
            iceServers: [
                { urls: ice }
            ]
        };

        if (this.peerConnection) {
            throw new SkapiError(`P2P connection is already in use.`, { code: 'INVALID_REQUEST' });
        }

        this.peerConnection = new RTCPeerConnection(configuration);

        // Collect ICE candidates and send them to the remote peer
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                // Send the candidate to the remote peer through your signaling server
                if (typeof callback?.onicecandidate === 'function') {
                    callback.onicecandidate(event);
                }
                this.log('candidate', event.candidate);
            } else {
                // All ICE candidates have been sent
                this.log('candidate-end', 'All ICE candidates have been sent');
            }
        };

        // Create a data channel
        const dataChannel = this.peerConnection.createDataChannel(Math.random().toString(36).substring(2, 15), {
            ordered: true, // Ensure messages are received in order
            maxRetransmits: 10 // Maximum number of retransmissions
        });

        // Listen for negotiationneeded event
        this.peerConnection.onnegotiationneeded = async () => {
            try {
                const offer = await this.peerConnection.createOffer();
                await this.peerConnection.setLocalDescription(offer);

                this.__sdpoffer = this.peerConnection.localDescription;
                this.log('sdpoffer', this.__sdpoffer);

                try {
                    validator.UserId(recipient);
                    socket.send(JSON.stringify({
                        action: 'sdpOffer',
                        uid: recipient,
                        content: JSON.stringify(this.__sdpoffer),
                        token: this.session.accessToken.jwtToken
                    }));

                } catch (err) {
                    if (this.__socket_room !== recipient) {
                        throw new SkapiError(`User has not joined to the recipient group. Run joinRealtime({ group: "${recipient}" })`, { code: 'INVALID_REQUEST' });
                    }

                    socket.send(JSON.stringify({
                        action: 'sdpBroadcast',
                        rid: recipient,
                        content: JSON.stringify(this.__sdpoffer),
                        token: this.session.accessToken.jwtToken
                    }));
                }

                if (typeof callback?.onnegotiationneeded === 'function') {
                    callback.onnegotiationneeded(this.__sdpoffer);
                }
            } catch (error) {
                this.log('Error during renegotiation:', error);

                if (typeof callback?.onerror === 'function') {
                    callback.onerror(error);
                }
                else {
                    throw error;
                }
            }
        };

        return new Promise(res => {
            dataChannel.onopen = () => {
                this.log('Data channel is open');
                res(dataChannel);
            }
        });
    }
};

export async function joinRealtime(params: { group?: string | null }): Promise<{ type: 'success', message: string }> {
    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    params = extractFormData(params).data;

    let { group = null } = params;

    if (!group && !this.__socket_room) {
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

    this.__socket_room = group;

    return { type: 'success', message: group ? `Joined realtime message group: "${group}".` : 'Left realtime message group.' }
}

export async function getRealtimeUsers(params: { group: string, user_id?: string }, fetchOptions?: FetchOptions): Promise<DatabaseResponse<{ user_id: string; connection_id: string }[]>> {
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

    if (!params.user_id) {
        if (__roomPending[params.group]) {
            return __roomPending[params.group];
        }
    }

    let req = request.bind(this)(
        'get-ws-group',
        params,
        {
            fetchOptions,
            auth: true,
            method: 'post'
        }
    ).then(res => {
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
                connection_id: v.cid
            }
        });

        return res;
    }).finally(() => {
        delete __roomPending[params.group];
    });

    if (!params.user_id) {
        if (!__roomPending[params.group]) {
            __roomPending[params.group] = req;
        }
    }

    return req;
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