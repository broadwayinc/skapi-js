// Platform-aware global polyfill
const root = typeof globalThis !== 'undefined' ? (globalThis as any) : undefined;
const win = root?.window;

if (win) {
    win.global = win;
    win.global._runningInNodeJS = false;
} else if (root) {
    root.global = root;
    
    // Polyfill browser APIs for Node.js
    if (typeof root.window === 'undefined') {
        // FileReader polyfill for Node.js
        class NodeFileReader {
            result: string | ArrayBuffer | null = null;
            error: Error | null = null;
            onload: ((this: NodeFileReader, ev: any) => any) | null = null;
            onloadend: ((this: NodeFileReader, ev: any) => any) | null = null;
            onerror: ((this: NodeFileReader, ev: any) => any) | null = null;

            readAsDataURL(blob: Blob) {
                blob.arrayBuffer().then(buffer => {
                    const base64 = Buffer.from(buffer).toString('base64');
                    const mimeType = (blob as any).type || 'application/octet-stream';
                    this.result = `data:${mimeType};base64,${base64}`;
                    if (this.onload) this.onload({ target: this });
                    if (this.onloadend) this.onloadend({ target: this });
                }).catch(err => {
                    this.error = err;
                    if (this.onerror) this.onerror({ target: this });
                });
            }

            readAsArrayBuffer(blob: Blob) {
                blob.arrayBuffer().then(buffer => {
                    this.result = buffer;
                    if (this.onload) this.onload({ target: this });
                    if (this.onloadend) this.onloadend({ target: this });
                }).catch(err => {
                    this.error = err;
                    if (this.onerror) this.onerror({ target: this });
                });
            }

            readAsText(blob: Blob, encoding = 'utf-8') {
                blob.text().then(text => {
                    this.result = text;
                    if (this.onload) this.onload({ target: this });
                    if (this.onloadend) this.onloadend({ target: this });
                }).catch(err => {
                    this.error = err;
                    if (this.onerror) this.onerror({ target: this });
                });
            }
        }

        root.FileReader = NodeFileReader;

        // XMLHttpRequest polyfill for Node.js using node-fetch
        class NodeXMLHttpRequest {
            status: number = 0;
            statusText: string = '';
            readyState: number = 0;
            responseText: string = '';
            response: any = null;
            responseType: string = '';
            responseURL: string = '';
            timeout: number = 0;
            withCredentials: boolean = false;
            
            onload: ((this: NodeXMLHttpRequest, ev: any) => any) | null = null;
            onerror: ((this: NodeXMLHttpRequest, ev: any) => any) | null = null;
            onabort: ((this: NodeXMLHttpRequest, ev: any) => any) | null = null;
            ontimeout: ((this: NodeXMLHttpRequest, ev: any) => any) | null = null;
            onprogress: ((this: NodeXMLHttpRequest, ev: any) => any) | null = null;
            onreadystatechange: ((this: NodeXMLHttpRequest, ev: any) => any) | null = null;
            
            upload: { onprogress: ((this: NodeXMLHttpRequest, ev: any) => any) | null } = { onprogress: null };

            private _method: string = 'GET';
            private _url: string = '';
            private _headers: Record<string, string> = {};
            private _aborted: boolean = false;

            open(method: string, url: string) {
                this._method = method;
                this._url = url;
                this.readyState = 1;
            }

            setRequestHeader(name: string, value: string) {
                this._headers[name] = value;
            }

            getResponseHeader(name: string): string | null {
                return null; // Simplified implementation
            }

            abort() {
                this._aborted = true;
                if (this.onabort) this.onabort({});
            }

            send(body?: any) {
                if (this._aborted) return;
                
                const fetchOptions: RequestInit = {
                    method: this._method,
                    headers: this._headers,
                };
                
                if (body && this._method !== 'GET' && this._method !== 'HEAD') {
                    fetchOptions.body = body;
                }

                fetch(this._url, fetchOptions)
                    .then(async response => {
                        if (this._aborted) return;
                        
                        this.status = response.status;
                        this.statusText = response.statusText;
                        this.responseURL = response.url;
                        this.readyState = 4;

                        if (this.responseType === 'blob') {
                            this.response = await response.blob();
                        } else if (this.responseType === 'json') {
                            try {
                                this.response = await response.json();
                            } catch {
                                this.response = null;
                            }
                        } else if (this.responseType === 'arraybuffer') {
                            this.response = await response.arrayBuffer();
                        } else {
                            this.responseText = await response.text();
                            this.response = this.responseText;
                        }

                        if (this.onload) this.onload({});
                    })
                    .catch(error => {
                        if (this._aborted) return;
                        if (this.onerror) this.onerror(error);
                    });
            }
        }

        root.XMLHttpRequest = NodeXMLHttpRequest;

        root.window = {
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