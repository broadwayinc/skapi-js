let rtcConnection = null;
let receiver = null;
let RealtimeCallback = async (rt) => {
    // Callback executed when there is data transfer between the users.
    /**
    rt = {
        type: 'message' | 'error' | 'success' | 'close' | 'notice' | 'private' | 'rtc' | 'reconnect';
        message: '...',
        respondRTC: (params: RTCReceiverParams, callback: RTCCallback) => Promise<RTCResolved>; // When remote peer is trying to connect, this callback should be called.
        ...
    }
    */
    console.log(rt);
    let log = rt;
    try {
        log = JSON.stringify(log, null, 2);
    }
    catch (err) {
    }
    el_pre_rtcLog.innerText = rt.type + ':\n' + log + '\n-\n' + el_pre_rtcLog.innerText;

    if (rt.type === 'rtc:incoming') {
        let users = await skapi.getUsers({
            searchFor: 'user_id',
            value: rt.sender
        })

        if (!users?.list?.[0]) {
            throw new Error('User not found');
        }

        let user = users.list[0];
        user = user.name || user.email || user.user_id;

        el_dl_incoming.innerHTML = /*html*/`
            <p>Incoming call from ${user}</p>
            <button onclick="receiveRTC(receiver)">Accept</button>
            <button onclick="receiver.respondRTC(false)">Reject</button>
        `;
    }
    else if (rt.type === 'rtc:hangup') {
        connected(false);
    }
}

function RTCCallback(e) {
    console.log(e);
    switch (e.type) {
        // RTC Events
        case 'track':
            el_pre_rtcLog.innerText = `Incomming Media Stream...\n` + el_pre_rtcLog.innerText;
            document.getElementById('remote').srcObject = e.streams[0];
            break;
        case 'connectionstatechange':
            let state = e.state;
            el_pre_rtcLog.innerText = `RTC Connection:${e.type}:${state}\n` + JSON.stringify(e, null, 2) + '\n-\n' + el_pre_rtcLog.innerText;
            if (state === 'disconnected' || state === 'failed' || state === 'closed') {
                connected(false);
            }
            else if (state === 'connected') {
                connected(true);
            }
            break;

        // Data Channel Events
        case 'close':
            el_pre_rtcLog.innerText = `Data Channel:${e.target.label}:${e.type}\n` + JSON.stringify(e, null, 2) + '\n-\n' + el_pre_rtcLog.innerText;
            break;
        case 'message':
            el_pre_rtcLog.innerText = `Data Channel:${e.target.label}:${e.type}\n` + JSON.stringify(e.data, null, 2) + '\n-\n' + el_pre_rtcLog.innerText;
            break;
        case 'open':
        case 'bufferedamountlow':
        case 'error':
            el_pre_rtcLog.innerText = `Data Channel:${e.target.label}:${e.type}\n` + JSON.stringify(e, null, 2) + '\n-\n' + el_pre_rtcLog.innerText;
            break;
    }
}

function disableForm(form, disable) {
    form.querySelectorAll('input').forEach(i => {
        i.disabled = disable;
    });
}

function connected(connected) {
    el_dl_calling.close();
    if (connected) {
        // Callback executed when the user is connected to the server.
        el_pre_rtcLog.innerText = 'Connected\n' + el_pre_rtcLog.innerText;
        disableForm(el_form_sendRTCMessage, false);
        disableForm(el_form_rtcTargetUser, true);
        document.getElementById('el_bt_disconnect').disable = false;
    }
    else {
        disableForm(el_form_sendRTCMessage, true);
        disableForm(el_form_rtcTargetUser, false);
        document.getElementById('el_bt_disconnect').disable = true;
    }
}

let call = null;
async function callRTC(event) {
    call = await skapi.connectRTC(event, RTCCallback);

    el_dl_calling.innerHTML = /*html*/`
        <p>Calling...</p>
        <button onclick="call.hangup()">Hangup</button>
    `;

    el_dl_calling.showModal();

    rtcConnection = await call.connection;
    if (!rtcConnection) {
        alert('Call rejected.');
    }
}

async function receiveRTC(receiver) {
    let params = {
        mediaStream: {
            audio: document.querySelector('input[name="mediaStream[audio]"]').checked,
            video: document.querySelector('input[name="mediaStream[video]"]').checked
        }
    }

    rtcConnection = await receiver.respondRTC(params, RTCCallback);
    if (!rtcConnection) {
        alert('Call rejected.');
    }
    if (rtcConnection.mediaStream) {
        document.getElementById('local').srcObject = rtcConnection.mediaStream;
    }
}