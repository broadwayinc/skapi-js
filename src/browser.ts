import { Skapi, SkapiError, Types } from './Main';

const root = typeof globalThis !== 'undefined' ? (globalThis as any) : undefined;

if (root) {
    root.Skapi = Skapi;
    root.SkapiError = SkapiError;
    root.SkapiTypes = Types;
}

export { Skapi, SkapiError, Types };