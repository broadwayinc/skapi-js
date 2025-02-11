import { request } from '../utils/network';

export async function subscribeNotification(){
    await this.__connection;

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/\-/g, '+')
            .replace(/_/g, '/');
    
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
    
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    const registration = await navigator.serviceWorker.ready;

    // ask if user wants to receive notifications
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        console.error('Permission not granted for notifications');
        return;
    }

    // fetch service public vapid
    let vapid = await request.bind(this)('get-vapid', null, {auth: true});

    // Subscribe to push notifications
    const subscription = (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid)
    })).toJSON();

    let response = await request.bind(this)('subscribe-notification', subscription, {auth: true});
    
    return response;
}
