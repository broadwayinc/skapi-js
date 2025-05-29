import { SkapiError } from "../Main";
import { RTCResolved, RTCEvent, RTCConnectorParams, RTCReceiverParams, WebSocketMessage, RTCConnector } from "../Types";
import { extractFormData } from "../utils/utils";
import validator from "../utils/validator";

export const __peerConnection: { [sender: string]: RTCPeerConnection } = {};
export const __dataChannel: { [sender: string]: { [label: string]: RTCDataChannel } } = {};
export const __caller_ringing: { [recipient: string]: (v: any) => void } = {};
export const __receiver_ringing: { [caller: string]: string } = {};
export const __rtcEvents: { [sender: string]: (v: any) => void } = {};

let __rtcCandidatesBuffer: { [sender: string]: any[] } = {};
let __rtcSdpOfferBuffer: { [sender: string]: any[] } = {};

function setBuffer(buffer: { [recipient: string]: any[] }, recipient: string, item: any) {
    if (!buffer[recipient]) {
        buffer[recipient] = [];
    }
    buffer[recipient].push(item);
}

async function processBuffer(buffer: { [recipient: string]: any[] }, recipient: string, fn: (item: any) => any): Promise<any[]> {
    let proceed = [];
    if (buffer[recipient]) {
        for (let v of buffer[recipient]) {
            if (v) {
                let process = fn(v);
                if (process instanceof Promise) {
                    process = await process;
                }
                proceed.push(process);
            }
        };
        delete buffer[recipient];
    }
    return proceed;
}

export async function answerSdpOffer(offer: any, recipient: string) {
    if (!this?.session?.accessToken?.jwtToken) {
        throw new SkapiError('Access token is required.', { code: 'INVALID_PARAMETER' });
    }

    let socket: WebSocket = await this.__socket;
    async function sendAnswer(offer, recipient, socket) {
        this.log('answerSdpOffer from', recipient);
        await __peerConnection[recipient].setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await __peerConnection[recipient].createAnswer();
        await __peerConnection[recipient].setLocalDescription(answer);
        socket.send(JSON.stringify({
            action: 'rtc',
            uid: recipient,
            content: { sdpanswer: answer },
            token: this.session.accessToken.jwtToken
        }));
    }

    if (__peerConnection?.[recipient]) {
        if (!offer) {
            await processBuffer(__rtcSdpOfferBuffer, recipient, (offer) => sendAnswer.bind(this)(offer, recipient, socket)); // process all buffered sdp offers
        }
        else {
            await processBuffer(__rtcSdpOfferBuffer, recipient, (offer) => sendAnswer.bind(this)(offer, recipient, socket)); // process all buffered sdp offers first
            await sendAnswer.bind(this)(offer, recipient, socket);
        }
    }
    else {
        if (offer) {
            setBuffer(__rtcSdpOfferBuffer, recipient, offer);
        }
    }
}

export async function receiveIceCandidate(candidate: any, recipient: string) {
    this.log('receiveIceCandidate', candidate);
    if (__peerConnection?.[recipient] && __peerConnection[recipient]?.remoteDescription && __peerConnection[recipient]?.remoteDescription?.type) {
        if (!candidate) {
            return processBuffer(__rtcCandidatesBuffer, recipient, (candidate) => __peerConnection[recipient].addIceCandidate(candidate)); // process all buffered candidates
        }
        await processBuffer(__rtcCandidatesBuffer, recipient, (candidate) => __peerConnection[recipient].addIceCandidate(candidate)); // process all buffered candidates
        await __peerConnection[recipient].addIceCandidate(candidate);
    }
    else {
        setBuffer(__rtcCandidatesBuffer, recipient, candidate);
    }
}

export async function closeRTC(params: { cid?: string; close_all?: boolean }): Promise<void> {
    validator.Params(params, {
        cid: v => {
            if (typeof v !== 'string') {
                throw new SkapiError(`"cid" should be type: <string>.`, { code: 'INVALID_PARAMETER' });
            }
            if (v && v.slice(0, 4) !== 'cid:') {
                throw new SkapiError(`"cid" should be a valid connection id.`, { code: 'INVALID_PARAMETER' });
            }
            return v;
        },
        close: 'boolean'
    });
    let socket: WebSocket = await this.__socket;
    let { cid, close_all = false } = params || {};

    if (!close_all && !cid) {
        throw new SkapiError(`"cid" is required.`, { code: 'INVALID_PARAMETER' });
    }

    let close = (cid: string) => {
        if (!cid) {
            throw new SkapiError(`"cid" is required.`, { code: 'INVALID_PARAMETER' });
        }

        delete __rtcSdpOfferBuffer[cid];
        delete __rtcCandidatesBuffer[cid];

        // Close all associated data channels
        if (__dataChannel[cid]) {
            Object.values(__dataChannel[cid]).forEach(channel => {
                if (channel.readyState !== 'closed') {
                    channel.close();
                }
            });
        }

        delete __dataChannel[cid];

        if (__peerConnection?.[cid]) {
            if (__peerConnection[cid].connectionState !== 'closed') {
                __peerConnection[cid].close();

                socket.send(JSON.stringify({
                    action: 'rtc',
                    uid: cid,
                    content: { hungup: this.user.user_id },
                    token: this.session.accessToken.jwtToken
                }));
            }

            let msg = {
                type: 'connectionstatechange',
                target: __peerConnection[cid],
                timestamp: new Date().toISOString(),
                state: __peerConnection[cid].connectionState,
                iceState: __peerConnection[cid].iceConnectionState,
                signalingState: __peerConnection[cid].signalingState
            }

            if (__rtcEvents[cid]) {
                __rtcEvents[cid](msg);
            }

            this.log('closeRTC', msg);
        }

        delete __rtcEvents[cid];
        delete __receiver_ringing[cid];
        delete __caller_ringing[cid];
        delete __peerConnection[cid];
    }

    if (close_all) {
        for (let key in __peerConnection) {
            close(key);
        }
    }
    else {
        close(cid);
    }

    this.log('Cleaning up media stream...');
    if (this.__mediaStream) {
        this.__mediaStream.getTracks().forEach((track) => {
            track.stop(); // Stops the track (audio or video)
        });
        this.__mediaStream = null; // Clear the reference to the MediaStream
    }
}

async function createMediaStream(media: MediaStream | MediaStreamConstraints): Promise<MediaStream> {
    if (media instanceof MediaStream) {
        return media;
    }
    
    if (!media.video && !media.audio) {
        // make dummy media stream
        // Create a dummy MediaStream
        const dummyStream = new MediaStream();

        // Create a dummy video track (using a canvas)
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const dummyVideoStream = canvas.captureStream();
        const dummyVideoTrack = dummyVideoStream.getVideoTracks()[0];

        // Add the dummy video track to the MediaStream
        dummyStream.addTrack(dummyVideoTrack);

        // Assign the dummy MediaStream to this.__mediaStream
        return dummyStream;
    }

    return navigator.mediaDevices.getUserMedia(media);
}

export async function connectRTC(
    params: RTCConnectorParams,
    callback: RTCEvent
): Promise<RTCConnector> {
    if (typeof callback !== 'function') {
        throw new SkapiError(`Callback is required.`, { code: 'INVALID_PARAMETER' });
    }

    if (!this?.session?.accessToken?.jwtToken) {
        throw new SkapiError('Access token is required.', { code: 'INVALID_PARAMETER' });
    }

    params = validator.Params(params, {
        cid: v => {
            if (typeof v !== 'string') {
                throw new SkapiError(`"cid" should be type: <string>.`, { code: 'INVALID_PARAMETER' });
            }
            if (v && v.slice(0, 4) !== 'cid:') {
                throw new SkapiError(`"cid" should be a valid connection id.`, { code: 'INVALID_PARAMETER' });
            }
            return v;
        },
        ice: ['string', () => 'stun:stun.skapi.com:3468'],
        media: v => v,
        channels: ['text-chat', 'file-transfer', 'video-chat', 'voice-chat', 'gaming', {
            // negotiated: 'boolean',
            // id: 'number',
            ordered: 'boolean',
            maxPacketLifeTime: 'number',
            maxRetransmits: 'number',
            protocol: 'string'
        }, () => {
            return [{ ordered: true, maxPacketLifeTime: 10, protocol: 'default' }]
        }]
    }, ['cid']);

    let { cid, ice } = params;

    if (!(params?.media instanceof MediaStream)) {
        if (params?.media?.video || params?.media?.audio) {
            // check if it is localhost or https
            if (location.hostname !== 'localhost' && location.protocol !== 'https:') {
                throw new SkapiError(`Media stream is only supported on either localhost or https.`, { code: 'INVALID_REQUEST' });
            }
        }
    }

    let socket: WebSocket = this.__socket ? await this.__socket : this.__socket;

    if (!socket) {
        throw new SkapiError(`No realtime connection. Execute connectRealtime() before this method.`, { code: 'INVALID_REQUEST' });
    }

    if (socket.readyState !== 1) {
        throw new SkapiError('Realtime connection is not ready.', { code: 'INVALID_REQUEST' });
    }

    // Call STUN server to get IP address
    const configuration = {
        iceServers: [
            { urls: ice }
        ]
    };

    if (!__peerConnection?.[cid]) {
        __peerConnection[cid] = new RTCPeerConnection(configuration);
    }

    // add media stream
    if (params?.media) {
        this.__mediaStream = await createMediaStream(params.media);
        this.__mediaStream.getTracks().forEach(track => {
            __peerConnection[cid].addTrack(track, this.__mediaStream);
        });
    }

    __rtcEvents[cid] = callback;

    if (!__dataChannel[cid]) {
        __dataChannel[cid] = {};
    }

    for (let i = 0; i < params.channels.length; i++) {
        let options = params.channels[i];

        if (typeof options === 'string') {
            switch (options) {
                case 'text-chat':
                    options = { ordered: true, maxRetransmits: 10, protocol: 'text-chat' };
                    break;
                case 'file-transfer':
                    options = { ordered: false, maxPacketLifeTime: 3000, protocol: 'file-transfer' };
                    break;
                case 'video-chat':
                    options = { ordered: true, maxRetransmits: 10, protocol: 'video-chat' };
                    break;
                case 'voice-chat':
                    options = { ordered: true, maxRetransmits: 10, protocol: 'voice-chat' };
                    break;
                case 'gaming':
                    options = { ordered: false, maxPacketLifeTime: 100, protocol: 'gaming' };
                    break;
                default:
                    options = { ordered: true, maxRetransmits: 10, protocol: 'default' };
                    break;
            }
        }

        let protocol = options.protocol || 'default';
        if (Object.keys(__dataChannel[cid]).includes(protocol)) {
            throw new SkapiError(`Data channel with the protocol "${protocol}" already exists.`, { code: 'INVALID_REQUEST' });
        }

        let dataChannel = __peerConnection[cid].createDataChannel(protocol, options);
        __dataChannel[cid][protocol] = dataChannel;
    }

    for (let key in __dataChannel[cid]) {
        let dataChannel = __dataChannel[cid][key];
        handleDataChannel.bind(this)(cid, dataChannel);
    }

    peerConnectionHandler.bind(this)(cid, ['onnegotiationneeded']);
    await sendOffer.bind(this)(cid);

    return {
        hangup: () => __caller_ringing[cid] && __caller_ringing[cid](false),
        connection: new Promise(resolve => {
            __caller_ringing[cid] = ((proceed: boolean) => {
                this.log('receiver picked up the call', cid);
                // proceed
                if (!proceed) {
                    closeRTC.bind(this)({ cid: cid });
                    return null;
                }

                __peerConnection[cid].onnegotiationneeded = () => {
                    this.log('onnegotiationneeded', `sending offer to "${cid}".`);
                    sendOffer.bind(this)(cid);
                    if (__rtcEvents[cid])
                        __rtcEvents[cid]({
                            type: 'negotiationneeded',
                            target: __peerConnection[cid],
                            timestamp: new Date().toISOString(),
                            signalingState: __peerConnection[cid].signalingState,
                            connectionState: __peerConnection[cid].iceConnectionState,
                            gatheringState: __peerConnection[cid].iceGatheringState
                        });
                };

                resolve({
                    target: __peerConnection[cid],
                    channels: __dataChannel[cid],
                    hangup: () => closeRTC.bind(this)({ cid: cid }),
                    media: this.__mediaStream
                });
            }).bind(this);
        })
    }
}

export function respondRTC(msg: WebSocketMessage): (params: RTCReceiverParams, callback: RTCEvent) => Promise<RTCResolved> {
    return async (params: RTCReceiverParams, callback: RTCEvent): Promise<RTCResolved> => {
        params = params || {};
        params = extractFormData(params).data;

        let sender = msg.sender_cid;
        let socket: WebSocket = await this.__socket;

        if (!__receiver_ringing[sender]) {
            return null;
        }

        if (typeof callback !== 'function') {
            throw new SkapiError(`Callback is required.`, { code: 'INVALID_PARAMETER' });
        }

        if (!(params?.media instanceof MediaStream)) {
            if (params?.media?.video || params?.media?.audio) {
                // check if it is localhost or https
                if (location.hostname !== 'localhost' && location.protocol !== 'https:') {
                    throw new SkapiError(`Media stream is only supported on either localhost or https.`, { code: 'INVALID_REQUEST' });
                }
            }
        }

        let { ice = 'stun:stun.skapi.com:3468' } = params;

        if (!__peerConnection?.[sender]) {
            __peerConnection[sender] = new RTCPeerConnection({
                iceServers: [
                    { urls: ice }
                ]
            });
        }

        if (params?.media) {
            this.__mediaStream = await createMediaStream(params.media);
            this.__mediaStream.getTracks().forEach(track => {
                __peerConnection[sender].addTrack(track, this.__mediaStream);
            });
        }

        delete __receiver_ringing[sender];

        __rtcEvents[sender] = callback;

        if (!__dataChannel[sender]) {
            __dataChannel[sender] = {};
        }

        __peerConnection[sender].ondatachannel = (event) => {
            this.log('ondatachannel', `received data channel "${event.channel.label}".`);
            const dataChannel = event.channel;
            __dataChannel[sender][dataChannel.label] = dataChannel;
            handleDataChannel.bind(this)(sender, dataChannel);
        }

        peerConnectionHandler.bind(this)(sender, ['onnegotiationneeded']);
        await answerSdpOffer.bind(this)(null, sender);
        await receiveIceCandidate.bind(this)(null, sender);

        socket.send(JSON.stringify({
            action: 'rtc',
            uid: sender,
            content: { pickup: this.user.user_id },
            token: this.session.accessToken.jwtToken
        }));

        return {
            target: __peerConnection[sender],
            channels: __dataChannel[sender],
            hangup: () => closeRTC.bind(this)({ cid: sender }),
            media: this.__mediaStream
        }
    }
}

async function sendOffer(recipient) {
    if (!this?.session?.accessToken?.jwtToken) {
        throw new SkapiError('Access token is required.', { code: 'INVALID_PARAMETER' });
    }
    this.log('sendOffer', recipient);
    let socket: WebSocket = await this.__socket;

    const offer = await __peerConnection[recipient].createOffer();
    await __peerConnection[recipient].setLocalDescription(offer);

    let sdpoffer = __peerConnection[recipient].localDescription;
    this.log('rtcSdpOffer to', sdpoffer);

    socket.send(JSON.stringify({
        action: 'rtc',
        uid: recipient,
        content: { sdpoffer },
        token: this.session.accessToken.jwtToken
    }));
}

async function sendIceCandidate(event, recipient) {
    if (!this?.session?.accessToken?.jwtToken) {
        throw new SkapiError('Access token is required.', { code: 'INVALID_PARAMETER' });
    }
    this.log('sendIceCandidate to', recipient);

    let socket: WebSocket = await this.__socket;

    if (!event.candidate) {
        this.log('candidate-end', 'all ice candidates have been sent');
        return;
    }

    let callback = __rtcEvents[recipient] || (() => { });

    // Collect ICE candidates and send them to the remote peer
    let candidate = event.candidate;
    this.log('ice gathering state set to', __peerConnection[recipient].iceGatheringState);

    callback({
        type: 'icecandidate',
        target: __peerConnection[recipient],
        timestamp: new Date().toISOString(),
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment,
        protocol: event.candidate.protocol,
        gatheringState: __peerConnection[recipient].iceGatheringState,
        connectionState: __peerConnection[recipient].iceConnectionState
    });

    socket.send(JSON.stringify({
        action: 'rtc',
        uid: recipient,
        content: { candidate },
        token: this.session.accessToken.jwtToken
    }));
}

function peerConnectionHandler(key: string, skipKey: string[]) {
    let skip = new Set(skipKey);
    let cb = __rtcEvents[key] || ((v: any) => { });
    let peer = __peerConnection[key];

    const handlers = {
        ontrack: (event: any) => {
            cb({
                type: 'track',
                target: peer,
                timeStamp: event.timeStamp,
                streams: event.streams,
                track: event.track,
            });
        },
        onicecandidate: (event: RTCPeerConnectionIceEvent) => {
            sendIceCandidate.bind(this)(event, key);
            if (event.candidate) {
                cb({
                    type: 'icecandidate',
                    target: peer,
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
                cb({ type: 'icecandidateend', target: peer, timestamp: new Date().toISOString() });
            }
        },
        onicecandidateerror: (event: any) => {
            cb({
                type: 'icecandidateerror',
                target: peer,
                timestamp: new Date().toISOString(),
                errorCode: event.errorCode,
                errorText: event.errorText,
                url: event.url,
                hostCandidate: event.hostCandidate,
                gatheringState: peer.iceGatheringState,
                connectionState: peer.iceConnectionState
            });
        },
        oniceconnectionstatechange: () => {
            cb({
                type: 'iceconnectionstatechange',
                target: peer,
                timestamp: new Date().toISOString(),
                state: peer.iceConnectionState,
                gatheringState: peer.iceGatheringState,
                signalingState: peer.signalingState
            });
        },
        onicegatheringstatechange: () => {
            cb({
                type: 'icegatheringstatechange',
                target: peer,
                timestamp: new Date().toISOString(),
                state: peer.iceGatheringState,
                connectionState: peer.iceConnectionState,
                signalingState: peer.signalingState
            });
        },
        onsignalingstatechange: () => {
            cb({
                type: 'signalingstatechange',
                target: peer,
                timestamp: new Date().toISOString(),
                state: peer.signalingState,
                connectionState: peer.iceConnectionState,
                gatheringState: peer.iceGatheringState
            });
        },
        onnegotiationneeded: () => {
            sendOffer.bind(this)(key);
            cb({
                type: 'negotiationneeded',
                target: peer,
                timestamp: new Date().toISOString(),
                signalingState: peer.signalingState,
                connectionState: peer.iceConnectionState,
                gatheringState: peer.iceGatheringState
            });
        },
        onconnectionstatechange: () => {
            cb({
                type: 'connectionstatechange',
                target: peer,
                timestamp: new Date().toISOString(),
                state: peer.connectionState,
                iceState: peer.iceConnectionState,
                signalingState: peer.signalingState
            });

            let state = peer.connectionState;
            // Clean up on disconnection
            if (state === 'disconnected' || state === 'failed' || state === 'closed') {
                // Close all associated data channels
                closeRTC.bind(this)({ cid: key });
            }
        }
    };

    for (const [event, handler] of Object.entries(handlers)) {
        if (!skip.has(event)) {
            peer[event] = handler;
        }
    }
}

function handleDataChannel(key: string, dataChannel: RTCDataChannel, skipKey?: string[]) {
    let skip = new Set(skipKey);
    let cb = __rtcEvents[key] || ((v: any) => { });

    const events = {
        onmessage: (event) => {
            let msg = {
                type: event.type,
                target: dataChannel,
                timeStamp: event.timeStamp,
                data: event.data,
                lastEventId: event.lastEventId,
                origin: event.origin,
                readyState: dataChannel.readyState,
                bufferedAmount: dataChannel.bufferedAmount
            };
            this.log(`${dataChannel.label}: message`, event.data);
            cb(msg);
        },
        onerror: (event) => {
            let err = {
                type: event.type,
                target: dataChannel,
                timeStamp: event.timeStamp,
                error: event.error.message,
                errorCode: event.error.errorDetail,
                readyState: dataChannel.readyState,
                label: dataChannel.label
            };
            this.log(`${dataChannel.label}: error`, event.error.message);
            cb(err);
        },
        onclose: (event) => {
            let closed = {
                type: event.type,
                target: dataChannel,
                timeStamp: event.timeStamp,
                readyState: dataChannel.readyState,
                label: dataChannel.label,
                id: dataChannel.id
            };
            this.log(`${dataChannel.label}: closed`, null);
            cb(closed);

            if (__dataChannel[key]) {
                delete __dataChannel[key][dataChannel.label];
                if (Object.keys(__dataChannel[key]).length === 0) {
                    closeRTC.bind(this)({ cid: key });
                }
            }
        },
        onbufferedamountlow: (event) => {
            let buffer = {
                target: dataChannel,
                bufferedAmount: dataChannel.bufferedAmount,
                bufferedAmountLowThreshold: dataChannel.bufferedAmountLowThreshold,
                type: event.type,
                timeStamp: event.timeStamp
            };
            this.log(`${dataChannel.label}: bufferedamountlow`, dataChannel.bufferedAmount);
            cb(buffer);
        },
        onopen: (event) => {
            this.log('dataChannel', `data channel: "${dataChannel.label}" is open and ready to send messages.`);
            let msg = {
                type: event.type,
                target: dataChannel,
                timeStamp: event.timeStamp,
                readyState: dataChannel.readyState,
                label: dataChannel.label,
                id: dataChannel.id,
                ordered: dataChannel.ordered,
                maxRetransmits: dataChannel.maxRetransmits,
                protocol: dataChannel.protocol
            };
            cb(msg);
        }
    };

    for (const [event, handler] of Object.entries(events)) {
        if (!skip.has(event)) {
            dataChannel[event] = handler;
        }
    }
}


