
import SkapiError from '../main/error';
import validator from '../utils/validator';
import { extractFormData } from '../utils/utils';
import { request } from '../utils/network';
import { DatabaseResponse, FetchOptions, RTCCallback, RTCreceiver, RealtimeCallback } from '../Types';

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

let reconnectAttempts = 0;

let __roomList = {}; // { group: { user_id: [connection_id, ...] } }
let __roomPending = {}; // { group: Promise }
let __keepAliveInterval = null;
let __rtcCandidates = {};
let __rtcSdpOffer = {};
let __socket: any; // WebSocket | Promise<WebSocket>
let __socket_room: string;
let __peerConnection: { [sender: string]: RTCPeerConnection } = {};
let __dataChannel: { [sender: string]: { [key: string]: RTCDataChannel } } = {};

async function sdpanswer(msg, sdpoffer) {
    let peerConnection = __peerConnection[msg.sender];
    let socket: WebSocket = __socket ? await __socket : __socket;
    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }
    if (!peerConnection) {
        throw new SkapiError(`No peer connection.`, { code: 'INVALID_REQUEST' });
    }

    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdpoffer));
    const sdpanswer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(sdpanswer);
    socket.send(JSON.stringify({
        action: 'rtc',
        uid: msg.sender,
        content: JSON.stringify({ sdpanswer }),
        token: this.session.accessToken.jwtToken
    }));
}

async function addIceCandidate(msg, candidate) {
    let peerConnection = __peerConnection[msg.sender];
    if (!peerConnection) {
        throw new SkapiError(`No peer connection.`, { code: 'INVALID_REQUEST' });
    }

    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}

function iceCandidateHandler(peer: RTCPeerConnection, cb: (event: any) => void, skip?: string[]) {
    // ICE Candidate events
    if (!skip?.includes('onicecandidate'))
        peer.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
            if (event.candidate) {
                cb({
                    type: 'icecandidate',
                    timestamp: new Date().toISOString(),
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                    usernameFragment: event.candidate.usernameFragment,
                    protocol: event.candidate.protocol,
                    gatheringState: peer.iceGatheringState,
                    connectionState: peer.iceConnectionState
                });
            } else {
                cb({ type: 'icecandidateend', timestamp: new Date().toISOString() });
            }
        };

    if (!skip?.includes('onicecandidateerror'))
        peer.onicecandidateerror = (event: any) => {
            cb({
                type: 'icecandidateerror',
                timestamp: new Date().toISOString(),
                errorCode: event.errorCode,
                errorText: event.errorText,
                url: event.url,
                hostCandidate: event.hostCandidate,
                gatheringState: peer.iceGatheringState,
                connectionState: peer.iceConnectionState
            });
        };

    // Connection state changes
    if (!skip?.includes('oniceconnectionstatechange'))
        peer.oniceconnectionstatechange = () => {
            cb({
                type: 'iceconnectionstatechange',
                timestamp: new Date().toISOString(),
                state: peer.iceConnectionState,
                gatheringState: peer.iceGatheringState,
                signalingState: peer.signalingState
            });
        };

    if (!skip?.includes('onicegatheringstatechange'))
        peer.onicegatheringstatechange = () => {
            cb({
                type: 'icegatheringstatechange',
                timestamp: new Date().toISOString(),
                state: peer.iceGatheringState,
                connectionState: peer.iceConnectionState,
                signalingState: peer.signalingState
            });
        };

    if (!skip?.includes('onsignalingstatechange'))
        peer.onsignalingstatechange = () => {
            cb({
                type: 'signalingstatechange',
                timestamp: new Date().toISOString(),
                state: peer.signalingState,
                connectionState: peer.iceConnectionState,
                gatheringState: peer.iceGatheringState
            });
        };

    // Negotiation and connection events
    if (!skip?.includes('onnegotiationneeded'))
        peer.onnegotiationneeded = () => {
            cb({
                type: 'negotiationneeded',
                timestamp: new Date().toISOString(),
                signalingState: peer.signalingState,
                connectionState: peer.iceConnectionState,
                gatheringState: peer.iceGatheringState
            });
        };

    if (!skip?.includes('onconnectionstatechange'))
        peer.onconnectionstatechange = () => {
            cb({
                type: 'connectionstatechange',
                timestamp: new Date().toISOString(),
                state: peer.connectionState,
                iceState: peer.iceConnectionState,
                signalingState: peer.signalingState
            });
        };
}

function receiveRTC(msg, rtc): RTCreceiver {
    return async (
        params: {
            ice: string;
            reject?: boolean;
        },
        cb: RTCCallback): Promise<{[key:string]: RTCDataChannel}> => {
        cb = cb || ((e) => { });
        
        let socket: WebSocket = __socket ? await __socket : __socket;
        if (!socket) {
            throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
        }

        if(params?.reject) {
            socket.send(JSON.stringify({
                action: 'rtc',
                uid: msg.sender,
                content: JSON.stringify({ sdpanswer }),
                token: this.session.accessToken.jwtToken
            }));
        }

        let { ice = 'stun:stun.skapi.com:3468' } = params || {};

        if (!__peerConnection?.[msg.sender]) {
            __peerConnection[msg.sender] = new RTCPeerConnection({
                iceServers: [
                    { urls: ice }
                ]
            });
        }

        let allPromises = [];
        this.log('rtcSdpOffer', __rtcSdpOffer[msg.sender]);
        for (let sdpoffer of __rtcSdpOffer[msg.sender]) {
            allPromises.push(sdpanswer.bind(this)(msg, sdpoffer));
        }
        await Promise.all(allPromises);

        allPromises = [];
        this.log('rtcCandidates', __rtcCandidates[msg.sender]);
        for (let candidate of __rtcCandidates[msg.sender]) {
            allPromises.push(addIceCandidate(msg, candidate));
        }

        await Promise.all(allPromises);
        delete __rtcSdpOffer[msg.sender];
        delete __rtcCandidates[msg.sender];

        iceCandidateHandler(__peerConnection[msg.sender], cb);

        let dataChannels = {};
        let channelList = rtc.dataChannels;

        return new Promise((resolve, reject) => {
            __peerConnection[msg.sender].ondatachannel = (event) => {
                const dataChannel = event.channel;

                dataChannels[dataChannel.label] = dataChannel;

                function checkDataChannel() {
                    let notyet = false;
                    for (let dtc of channelList) {
                        if (dataChannels?.[dtc].readyState === 'open') {
                            continue;
                        }
                        else {
                            notyet = true;
                            break;
                        }
                    }
                    if (!notyet) {
                        __dataChannel[msg.sender] = dataChannels;
                        resolve(dataChannels);
                    }
                }

                dataChannel.onopen = () => {
                    this.log('dataChannel', `Received data channel "${dataChannel.label}" is open and ready to send messages.`);
                    checkDataChannel();
                }
            };
        })
    }
}

export async function connectRTC(
    params: {
        recipient: string;
        ice?: string;
        dataChannelOptions?: {
            ordered?: boolean;
            maxPacketLifeTime?: number;
            maxRetransmits?: number;
            protocol: string;
            // negotiated?: boolean;
            // id?: number;
        }[]
    },
    callback?: RTCCallback
): Promise<{ [key: string]: RTCDataChannel }> {
    callback = callback || ((e) => { });
    let socket: WebSocket = __socket ? await __socket : __socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    params = validator.Params(params, {
        recipient: 'string',
        ice: ['string', () => 'stun:stun.skapi.com:3468'],
        dataChannelOptions: [{
            ordered: 'boolean',
            maxPacketLifeTime: 'number',
            maxRetransmits: 'number',
            protocol: 'string'
        }, () => {
            return [{ ordered: true, maxRetransmits: 10, protocol: 'default' }]
        }]
    }, ['recipient']);

    let { recipient, ice } = params;

    if (socket.readyState === 1) {
        // Call STUN server to get IP address
        const configuration = {
            iceServers: [
                { urls: ice }
            ]
        };

        if (!__peerConnection?.[recipient]) {
            __peerConnection[recipient] = new RTCPeerConnection(configuration);
        }

        let dataChannels = {};

        for (let i = 0; i < params.dataChannelOptions.length; i++) {
            let options = params.dataChannelOptions[i];
            let dataChannel = __peerConnection[recipient].createDataChannel(options.protocol, options);
            dataChannels[options.protocol] = dataChannel;
        }

        if (!__dataChannel[recipient]) {
            __dataChannel[recipient] = {};
        }
        __dataChannel[recipient] = dataChannels;

        // ordered?: boolean;          // Messages arrive in order (default: true)
        // maxPacketLifeTime?: number; // Max time (ms) to retransmit (can't be used with maxRetransmits)
        // maxRetransmits?: number;    // Max number of retries (can't be used with maxPacketLifeTime)

        // // Protocol Options
        // protocol?: string;         // Sub-protocol string
        // negotiated?: boolean;      // If channel is negotiated out-of-band (default: false)
        // id?: number;              // Channel ID (only used if negotiated is true)

        // Reliable messaging: { ordered: true }
        // Real-time gaming: { ordered: false, maxRetransmits: 0 }
        // File transfer: { ordered: true, maxRetransmits: 30 }

        // maxPacketLifeTime: 1000, // Discard after 1 second
        // Gaming: Low values (50-100ms)
        // Voice chat: Medium values (250-500ms)
        // Status updates: Higher values (1000-2000ms)

        // Listen for negotiationneeded event
        __peerConnection[recipient].onnegotiationneeded = async () => {
            const offer = await __peerConnection[recipient].createOffer();
            await __peerConnection[recipient].setLocalDescription(offer);

            let sdpoffer = __peerConnection[recipient].localDescription;

            try {
                validator.UserId(recipient);
                socket.send(JSON.stringify({
                    action: 'rtc',
                    uid: recipient,
                    content: JSON.stringify({ sdpoffer, dataChannels: Object.keys(__dataChannel[recipient]) }),
                    token: this.session.accessToken.jwtToken
                }));

            } catch (err) {
                if (__socket_room !== recipient) {
                    throw new SkapiError(`User has not joined to the recipient group. Run joinRealtime({ group: "${recipient}" })`, { code: 'INVALID_REQUEST' });
                }

                socket.send(JSON.stringify({
                    action: 'rtcBroadcast',
                    rid: recipient,
                    content: JSON.stringify({ sdpoffer, dataChannels: Object.keys(__dataChannel[recipient]) }),
                    token: this.session.accessToken.jwtToken
                }));
            }
        };

        __peerConnection[recipient].onicecandidate = (event) => {
            if (!event.candidate) {
                this.log('candidate-end', 'All ICE candidates have been sent');
                return;
            }

            // Collect ICE candidates and send them to the remote peer
            let candidate = event.candidate;
            this.log('ICE gathering state set to:', __peerConnection[recipient].iceGatheringState);
            callback({
                type: 'icecandidate',
                timestamp: new Date().toISOString(),
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
                usernameFragment: event.candidate.usernameFragment,
                protocol: event.candidate.protocol,
                gatheringState: __peerConnection[recipient].iceGatheringState,
                connectionState: __peerConnection[recipient].iceConnectionState
            });
            try {
                validator.UserId(recipient);
                socket.send(JSON.stringify({
                    action: 'rtc',
                    uid: recipient,
                    content: JSON.stringify({ candidate }),
                    token: this.session.accessToken.jwtToken
                }));

            } catch (err) {
                if (__socket_room !== recipient) {
                    throw new SkapiError(`User has not joined to the recipient group. Run joinRealtime({ group: "${recipient}" })`, { code: 'INVALID_REQUEST' });
                }

                socket.send(JSON.stringify({
                    action: 'rtcBroadcast',
                    rid: recipient,
                    content: JSON.stringify({ candidate }),
                    token: this.session.accessToken.jwtToken
                }));
            }
        }

        iceCandidateHandler(__peerConnection[recipient], callback, ['onicecandidate', 'onnegotiationneeded']);

        let registerOpen = (dt) => new Promise((resolve) => {
            dt.onopen = () => {
                this.log('dataChannel', `Data channel: "${dt.label}" is open and ready to send messages.`);
                resolve(dt);
            };
        });

        let allDataChannelPromises = [];
        for (let dt in dataChannels) {
            allDataChannelPromises.push(registerOpen(dataChannels[dt]));
        }

        await Promise.all(allDataChannelPromises);
        return __dataChannel[recipient];
    }
}

export function connectRealtime(cb: RealtimeCallback, delay = 0): Promise<WebSocket> {
    if (typeof cb !== 'function') {
        throw new SkapiError(`Callback must be a function.`, { code: 'INVALID_REQUEST' });
    }

    if (reconnectAttempts || !(__socket instanceof Promise)) {
        __socket = new Promise(async resolve => {
            setTimeout(async () => {
                await this.__connection;

                let user = await this.getProfile();
                if (!user) {
                    throw new SkapiError(`No access.`, { code: 'INVALID_REQUEST' });
                }

                let socket: WebSocket = await prepareWebsocket.bind(this)();

                socket.onopen = () => {
                    reconnectAttempts = 0;
                    this.log('realtime onopen', 'Connected to WebSocket server.');
                    cb({ type: 'success', message: 'Connected to WebSocket server.' });

                    if (__socket_room) {
                        socket.send(JSON.stringify({
                            action: 'joinRoom',
                            rid: __socket_room,
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
                        this.log('realtime onmessage', data);
                    }
                    catch (e) {
                        return;
                    }
                    let type: 'message' | 'error' | 'success' | 'close' | 'notice' | 'private' | 'rtc' = 'message';
                    let rtc = null;
                    if (data?.['#message']) {
                        type = 'message';
                    }

                    else if (data?.['#private']) {
                        type = 'private';
                    }

                    else if (data?.['#notice']) {
                        type = 'notice';
                    }

                    else if (data?.['#rtc']) {
                        type = 'rtc';
                        rtc = data['#rtc'];
                        try {
                            rtc = JSON.parse(rtc);
                        }
                        catch (e) {
                            return;
                        }
                    }

                    let msg: {
                        type: 'message' | 'error' | 'success' | 'close' | 'notice' | 'private' | 'rtc';
                        message: any;
                        sender?: string;
                        sender_cid?: string;
                        receiveRTC?: RTCreceiver; // pick up the call
                        sender_rid?: string;
                    } = { type, message: type === 'rtc' ? rtc : (data?.['#message'] || data?.['#private'] || data?.['#notice']) || null };

                    if (data?.['#user_id']) {
                        msg.sender = data['#user_id'];
                    }

                    if (data?.['#scid']) {
                        msg.sender_cid = 'scid:' + data['#scid'];
                    }

                    if (data?.['#srid']) {
                        msg.sender_rid = data['#srid'];
                    }

                    if (type === 'notice') {
                        if (__socket_room && (msg.message.includes('has left the message group.') || msg.message.includes('has been disconnected.'))) {
                            if (__roomPending[__socket_room]) {
                                await __roomPending[__socket_room];
                            }

                            let user_id = msg.sender;
                            if (__roomList?.[__socket_room]?.[user_id]) {
                                __roomList[__socket_room][user_id] = __roomList[__socket_room][user_id].filter(v => v !== msg.sender_cid);
                            }

                            if (__roomList?.[__socket_room]?.[user_id] && __roomList[__socket_room][user_id].length === 0) {
                                delete __roomList[__socket_room][user_id];
                            }

                            if (__roomList?.[__socket_room]?.[user_id]) {
                                return
                            }
                        }
                        else if (__socket_room && msg.message.includes('has joined the message group.')) {
                            if (__roomPending[__socket_room]) {
                                await __roomPending[__socket_room];
                            }

                            let user_id = msg.sender;
                            if (!__roomList?.[__socket_room]) {
                                __roomList[__socket_room] = {};
                            }
                            if (!__roomList[__socket_room][user_id]) {
                                __roomList[__socket_room][user_id] = [msg.sender_cid];
                            }
                            else {
                                if (!__roomList[__socket_room][user_id].includes(msg.sender_cid)) {
                                    __roomList[__socket_room][user_id].push(msg.sender_cid);
                                }
                                return;
                            }
                        }
                    }

                    if (rtc) {
                        if (msg.sender !== user.user_id) {
                            if (rtc.candidate) {
                                if (__peerConnection?.[msg.sender]) {
                                    addIceCandidate(msg, rtc.candidate);
                                }
                                else {
                                    if (!__rtcCandidates[msg.sender]) {
                                        __rtcCandidates[msg.sender] = [];
                                    }

                                    __rtcCandidates[msg.sender].push(rtc.candidate);
                                }
                            }

                            if (rtc.sdpoffer) {
                                if (__peerConnection?.[msg.sender]) {
                                    sdpanswer.bind(this)(msg, rtc.sdpoffer);
                                }
                                else {
                                    if (!__rtcSdpOffer[msg.sender]) {
                                        __rtcSdpOffer[msg.sender] = [];
                                    }

                                    __rtcSdpOffer[msg.sender].push(rtc.sdpoffer);
                                    msg.receiveRTC = receiveRTC.bind(this)(msg, rtc);
                                }
                            }

                            if (rtc.sdpanswer) {
                                await __peerConnection[msg.sender].setRemoteDescription(new RTCSessionDescription(rtc.sdpanswer));
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
                        this.log('realtime onclose', 'WebSocket connection closed.');
                        cb({ type: 'close', message: 'WebSocket connection closed.' });
                        __socket = null;
                        __socket_room = null;
                    }
                    else {
                        // close event was unexpected
                        const maxAttempts = 10;
                        reconnectAttempts++;

                        if (reconnectAttempts < maxAttempts) {
                            let delay = Math.min(1000 * (2 ** reconnectAttempts), 30000); // max delay is 30 seconds
                            this.log('realtime onclose', `WebSocket connection closed. Reconnecting in ${delay / 1000} seconds...`);
                            cb({ type: 'reconnect', message: `Skapi: WebSocket connection error. Reconnecting in ${delay / 1000} seconds...` });
                            connectRealtime.bind(this)(cb, delay);
                        } else {
                            // Handle max reconnection attempts reached
                            this.log('realtime onclose', 'WebSocket connection error. Max reconnection attempts reached.');
                            cb({ type: 'error', message: 'Skapi: WebSocket connection error. Max reconnection attempts reached.' });
                            __socket = null;
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

    return __socket;
}

export async function closeRealtime(): Promise<void> {
    let socket: WebSocket = __socket ? await __socket : __socket;

    if (socket) {
        socket.close();
    }

    __socket = null;
    __socket_room = null;

    return null;
}

export async function postRealtime(message: any, recipient: string): Promise<{ type: 'success', message: 'Message sent.' }> {
    let socket: WebSocket = __socket ? await __socket : __socket;

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
            if (__socket_room !== recipient) {
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
    let socket: WebSocket = __socket ? await __socket : __socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    params = extractFormData(params).data;

    let { group = null } = params;

    if (!group && !__socket_room) {
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

    __socket_room = group;

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