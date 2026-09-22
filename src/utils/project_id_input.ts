import SkapiError from '../main/error';
import { isBrowserRuntime } from './utils';
import { loadNodeModule } from '../polyfills/global';

/**
 * Asking for the Project ID when the SDK is started with the docs' placeholder.
 *
 * `new Skapi('<Project ID>')` is what a copied example looks like before the
 * Project ID is filled in. Instead of refusing to start, the SDK asks for the id
 * (window.prompt() in a browser, a question on the terminal in Node), keeps the
 * answer in sessionStorage, and uses it for every later `new Skapi('<Project ID>')`
 * in the same session: the browser tab, or the Node process.
 */

// The sessionStorage entry that holds the id entered for the placeholder.
export const PROJECT_ID_STORAGE_KEY = 'skapi:project_id';

/**
 * True for every spelling of the placeholder the docs have ever used.
 *
 * The angle brackets, spacing and separators it is written with are normalized
 * away, which catches '<Project ID>' (current), 'project_id', and the older
 * 'service_id' / 'SERVICE_ID'. Matching only the exact literals meant a docs
 * change to a new placeholder form silently disabled this check, which is what
 * happened when '<Project ID>' was adopted.
 */
export function isProjectIdPlaceholder(value: string): boolean {
    const form = value.trim().toLowerCase().replace(/^<|>$/g, '').replace(/[\s_\-.]+/g, '');
    return form === 'serviceid' || form === 'projectid';
}

export function readSavedProjectId(): string | null {
    try {
        return window.sessionStorage.getItem(PROJECT_ID_STORAGE_KEY) || null;
    } catch (err) {
        // Storage disabled or blocked: there is simply nothing saved.
        return null;
    }
}

export function saveProjectId(id: string): void {
    try {
        window.sessionStorage.setItem(PROJECT_ID_STORAGE_KEY, id);
    } catch (err) {
        // Not saved: the next `new Skapi('<Project ID>')` asks again, nothing worse.
    }
}

// Removes the saved id, but only if it is still `id`: a newer answer is left alone.
export function forgetSavedProjectId(id: string): void {
    try {
        if (window.sessionStorage.getItem(PROJECT_ID_STORAGE_KEY) === id) {
            window.sessionStorage.removeItem(PROJECT_ID_STORAGE_KEY);
        }
    } catch (err) {
        // Nothing to clean up in a storage that cannot be read.
    }
}

/**
 * Whether this runtime can ask anyone.
 *
 * A browser needs window.prompt(). Node needs a person at a terminal: stdin to
 * read the answer from and stderr to show the question on must both be a TTY. A
 * server, a CI job or a piped script has neither, and would otherwise wait for an
 * answer that never comes; there the constructor throws, as it always did.
 */
export function canAskProjectId(): boolean {
    if (isBrowserRuntime()) {
        return typeof window.prompt === 'function';
    }
    const tty = loadNodeModule('tty');
    return !!(tty && loadNodeModule('readline') && tty.isatty(0) && tty.isatty(2));
}

function projectIdRequired(): SkapiError {
    return new SkapiError('Project ID is required.', { code: 'INVALID_PARAMETER' });
}

// Shared by every instance created while the question is open, so two
// `new Skapi('<Project ID>')` in a row ask once, not twice on top of each other.
let pending: Promise<string> | null = null;

/**
 * Asks until `check` accepts an answer, and resolves to that answer.
 *
 * `check` throws for an id the SDK cannot start with; the question is then asked
 * again. Rejects with 'Project ID is required.' when the person cancels: the
 * browser prompt's Cancel, or end of input (Ctrl+D) on the terminal.
 */
export function askProjectId(placeholder: string, check: (id: string) => void): Promise<string> {
    if (!pending) {
        pending = isBrowserRuntime() ? askInBrowser(placeholder, check) : askInTerminal(placeholder, check);
        // then(clear, clear) rather than finally(): finally() returns a promise that
        // rejects along with `pending`, and nothing would ever handle it.
        const clear = () => { pending = null; };
        pending.then(clear, clear);
    }
    return pending;
}

async function askInBrowser(placeholder: string, check: (id: string) => void): Promise<string> {
    // Asked on the next task instead of inside the constructor. prompt() blocks
    // the page, and the code that created the instance should finish first; the
    // calls it makes in the meantime wait for the answer.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const intro = `new Skapi() was given the placeholder "${placeholder}" instead of your Project ID.`;
    const ask = `Enter your Project ID to continue. This browser tab remembers it until the tab is closed. To stop being asked, replace "${placeholder}" in your code with the ID.`;
    let message = `${intro}\n\n${ask}`;
    let last = '';

    for (;;) {
        const answer = window.prompt(message, last);
        if (answer === null) {
            throw projectIdRequired();
        }
        last = answer.trim();
        if (!last) {
            message = `${intro}\n\n${ask}`;
            continue;
        }
        try {
            check(last);
            return last;
        } catch (err) {
            message = `"${last}" is not a valid Project ID.\n\n${ask}`;
        }
    }
}

function askInTerminal(placeholder: string, check: (id: string) => void): Promise<string> {
    const proc = (globalThis as any).process;
    const readline = loadNodeModule('readline');

    return new Promise((resolve, reject) => {
        // terminal: false leaves the tty in its normal line mode, so Ctrl+C still
        // stops the program the way it always does. The question goes to stderr so
        // a program whose stdout is data does not get it mixed in.
        const rl = readline.createInterface({ input: proc.stdin, output: proc.stderr, terminal: false });
        let answered = false;

        // End of input (Ctrl+D) before an accepted answer is a cancel.
        rl.on('close', () => {
            if (!answered) {
                proc.stderr.write('\n');
                reject(projectIdRequired());
            }
        });

        const ask = () => rl.question('Enter your Project ID: ', (answer: string) => {
            const id = answer.trim();
            if (id) {
                try {
                    check(id);
                    answered = true;
                    rl.close();
                    resolve(id);
                    return;
                } catch (err) {
                    proc.stderr.write(`"${id}" is not a valid Project ID.\n`);
                }
            }
            ask();
        });

        proc.stderr.write(
            `new Skapi() was given the placeholder "${placeholder}" instead of your Project ID.\n` +
            `This process remembers the ID until it exits. To stop being asked, replace "${placeholder}" in your code with the ID.\n`
        );
        ask();
    });
}
