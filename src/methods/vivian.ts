import { request } from '../utils/network';
import validator from '../utils/validator';
import {
    isBrowserRuntime,
} from '../utils/utils';
import {
    DatabaseResponse,
} from '../Types';
export async function spellcast(params: {
    spell: string,
    name: string,
    magic?: any
}): Promise<string> {
    await this.__connection;
    params = validator.Params(params, {
        'spell': 'string',
        'name': 'string',
        'magic': x=>x
    }, ['spell', 'name'])

    let response = await request.bind(this)('castspell', params);
    return `The spell "${params.spell}" has been cast.`;
}

export async function getspell(params?: {
    search?: 'spell' | 'name',
    value?: string,
}): Promise<DatabaseResponse<{
    spell: string;
    magic?: any;
    name: string;
}>> {
    await this.__connection;
    params = validator.Params(params || {}, {
        'search': ['spell', 'name', () => "spell"],
        'value': 'string'
    });

    let response = await request.bind(this)('getspell', params);
    return response;
}

export async function dopamine(params: {
    message: string,
    name: string
}): Promise<string> {
    await this.__connection;
    params = validator.Params(params, {
        'message': 'string',
        'name': 'string'
    }, ['message', 'name'])

    let response = await request.bind(this)('dopamine', params, { auth: true });

    let message = response?.previous_message?.message;
    let name = response?.previous_message?.name;

    if (isBrowserRuntime()) {
        if (message && name)
            window.alert(`${name} said: ${message}`)

        window.location.href = response.video
    }
    else {
        if(message && name) {
            return `${name} said: ${message}\nWatch the video here: ${response.video}`;
        }
        else {
            return `Your message has been uploaded for future generations to receive.\nWatch the video here: ${response.video}`;
        }
    }
}