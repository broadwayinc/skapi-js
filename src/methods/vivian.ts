import { request } from '../utils/network';
export async function spellcast(params){
    await this.__connection;

    let response = await request.bind(this)('castspell', params, {auth: true});
    return response;
}

export async function dopamine(params){
    await this.__connection;

    let response = await request.bind(this)('dopamine', params, {auth: true});
    return response;
}