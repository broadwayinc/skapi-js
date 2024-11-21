export function setBuffer(buffer: { [recipient: string]: any[] }, recipient: string, item: any) {
    if (!buffer[recipient]) {
        buffer[recipient] = [];
    }
    buffer[recipient].push(item);
}

export function processBuffer(buffer: { [recipient: string]: any[] }, recipient: string, fn: (item: any) => void) {
    if (buffer[recipient]) {
        buffer[recipient].forEach(fn);
        delete buffer[recipient];
    }
}

export async function answerSdpOffer(offer: any, recipient: string, peerConnection: RTCPeerConnection, socket: WebSocket) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.send(JSON.stringify({
        action: 'rtc',
        uid: recipient,
        content: { sdpanswer: answer },
        token: this.session.accessToken.jwtToken
    }));
}

export async function receiveIceCandidate(candidate: any, recipient: string, buffer: { [recipient: string]: any }, peerConnection: RTCPeerConnection) {
    if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
        await peerConnection.addIceCandidate(candidate);
    } else {
        setBuffer(buffer, recipient, candidate);
    }
}