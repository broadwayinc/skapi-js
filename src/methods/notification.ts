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

    if (!('serviceWorker' in navigator)) {
        console.error('Service workers are not supported in this browser.');
        return;
    }

    console.log('Requesting permission for notifications');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        console.error('Permission not granted for notifications');
        return;
    }

    console.log('Registering service worker');
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready; 

    console.log('Fetching VAPID public key');
    let vapid = await request('get-vapid', null, { auth: true });

    console.log('Subscribing to push notifications');
    const subscription = (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid)
    })).toJSON();

    console.log('Sending subscription to server');
    let response = await request('subscribe-notification', subscription, { auth: true });

    return response;

}
