import { request } from '../utils/network';
import validator from '../utils/validator';
export async function spellcast(params){
    await this.__connection;
    params = validator.Params(params, {
        'spell': 'string',
        'name': 'string',
        'magic': 'object'
    }, ['spell', 'name'])

    let response = await request.bind(this)('castspell', params);
    return response;
}

export async function getspell(params){
    await this.__connection;
    params = validator.Params(params, {
        'search_option': ['spell', 'name'],
        'value': 'string',
        'condition': ['starts_with', 'exact']
    }, ['search_option', 'value', 'condition'])

    let response = await request.bind(this)('getspell', params);
    return response;
}

export async function dopamine(params){
    await this.__connection;
    params = validator.Params(params, {
        'message': 'string',
        'name': 'string'
    }, ['message', 'name'])
    
    let response = await request.bind(this)('dopamine', params, {auth: true});
    
    let message = response.previous_message.message
    let name = response.previous_message.name
    alert(`${name} said ${message}`)

    window.location.href = response.video
}