import { request } from '../utils/network';
export async function spellcast(params){
    await this.__connection;

    let response = await request.bind(this)('castspell', params, {auth: true});
    return response;
}

export async function dopamine(params){
    await this.__connection;

    let response = await request.bind(this)('dopamine', params, {auth: true});
    
    let message = response.previous_message.message
    let name = response.previous_message.name
    alert(`${name} said ${message}`)

    window.location.href = response.video
}