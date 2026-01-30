// Platform-aware global polyfill
if (typeof window !== 'undefined') {
    (window as any).global = window;
    (window as any).global._runningInNodeJS = false;
} else if (typeof globalThis !== 'undefined') {
    (globalThis as any).global = globalThis;
    
    // Polyfill browser APIs for Node.js
    if (typeof (globalThis as any).window === 'undefined') {
        (globalThis as any).window = {
            _runningInNodeJS: true,
            alert: (message: string) => console.error('[Alert]', message),
            sessionStorage: {
                getItem: (key: string) => null,
                setItem: (key: string, value: string) => {},
                removeItem: (key: string) => {},
            },
            location: { 
                href: '', 
                origin: '', 
                hostname: '', 
                protocol: '', 
                replace: (url: string) => {} 
            },
            navigator: { 
                userAgent: `skapi-node/${process.versions?.node || 'unknown'}`,
                mediaDevices: {
                    getUserMedia: async (constraints: any) => {
                        throw new Error('getUserMedia is not supported in Node.js environment.');
                    }
                }
            },
            addEventListener: () => {},
            removeEventListener: () => {}
        };
    }
}