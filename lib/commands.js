export const MSG = {
    DENIED: 'Access denied.',
    WELCOME: [
        'Hi, this is the DeepSeek Harness phone remote.',
        'The local session is the source of truth: open a conversation in Web first, then use /sessions to pick a workspace → session and attach.',
        'Send /help to see available commands.',
    ].join('\n'),
    HELP: [
        '/sessions — list local sessions by workspace (Web-aligned, archived excluded) and attach',
        '/new — create a new blank session (in the bound workspace, or pick one) and attach it',
        '/last — view the bound session\u2019s last Q&A (to continue the context)',
        '/model — switch the model of the currently bound session (takes effect next turn)',
        '/status — show the current binding',
        '/unbind — detach the phone binding (does NOT close the local session)',
        '/help — show this help',
        '',
        'After attaching, just send text and it enters that local session; Web and phone see the same trajectory.',
        'Only allowlisted users can use this. If there are no sessions, open a conversation in dsh web or keep a historical session.',
    ].join('\n'),
    NEED_BIND: 'No local session bound yet. Send /sessions to choose one.',
    NO_SESSIONS: 'There are no attachable local sessions right now (archived and blank sessions excluded). Open or continue a conversation in Web (dsh web) first, then send /sessions.',
    NO_SESSIONS_IN_WS(title) {
        return `Workspace \u201c${title}\u201d has no attachable sessions.`;
    },
    /** @deprecated use NO_SESSIONS */
    NO_LIVE: 'There are no attachable local sessions right now. Open or continue a conversation in Web (dsh web) first, then send /sessions.',
    PICKER_STALE: 'The list is out of date — please send /sessions again.',
    NEW_CREATING(title) {
        return `Creating a new session in “${title}”…`;
    },
    NEW_FAILED(detail) {
        const tip = 'Could not create a new session.';
        if (!detail)
            return tip;
        return `${tip}\nDetail: ${detail}`;
    },
    RESUME_FAILED: 'Could not attach that session (resume failed). Make sure the session exists in Web, or open it on the computer first and try again.',
    BOUND(label) {
        return `Attached to local session: ${label}\nMessages from now on enter that session (same trajectory as Web).\nTo continue the context, tap \u201cView last conversation\u201d or send /last.`;
    },
    UNBOUND: 'Binding detached. The local session is still running.',
    STATUS_NONE: 'No local session is bound right now. Send /sessions to choose one.',
    STATUS_BOUND(label) {
        return `Currently bound: ${label}`;
    },
    STATUS_BOUND_COLD(label) {
        return `Currently bound: ${label}\n(session is not in memory right now; it will resume automatically when you send a message.)`;
    },
    GONE: 'The bound session is no longer available. Please /sessions again.',
    LAST_FAILED: 'Could not read the last conversation. Make sure a session is bound and dsh web / apiProxy is running on this machine.',
    MODEL_UNAVAILABLE(detail) {
        const tip = 'Could not read the model list. Make sure a session is bound and dsh web has host-apiproxy loaded.';
        if (!detail)
            return tip;
        return `${tip}\nDetail: ${detail}`;
    },
    MODEL_UNROUTABLE(current) {
        return `The current model is not routable: ${current}\nConfigure a usable provider in Web or on this machine, then try /model again.`;
    },
    MODEL_EMPTY(current) {
        return `Current: ${current}\nThere are no other models to switch to.`;
    },
    MODEL_SET(selected) {
        return `Switched model to: ${selected}\nTakes effect next turn.`;
    },
    MODEL_FAILED(detail) {
        const tip = 'Failed to switch the model. Try again later or switch in Web.';
        if (!detail)
            return tip;
        return `${tip}\nDetail: ${detail}`;
    },
    unknown(command) {
        return `Unknown command ${command}. Send /help to see available commands.`;
    },
};
export function parseCommand(text) {
    if (!text.startsWith('/'))
        return { type: 'plain', text };
    const raw = text.split(/\s+/)[0] ?? text;
    const command = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
    switch (command) {
        case '/start':
            return { type: 'start', text };
        case '/help':
            return { type: 'help', text };
        case '/sessions':
        case '/list':
            return { type: 'sessions', text };
        case '/new':
        case '/create':
            return { type: 'new', text };
        case '/last':
        case '/context':
            return { type: 'last', text };
        case '/model':
            return { type: 'model', text };
        case '/status':
            return { type: 'status', text };
        case '/unbind':
        case '/disconnect':
            return { type: 'unbind', text };
        default:
            return { type: 'unknown', command, text };
    }
}
/** @deprecated Prefer short index callbacks (ws:/sid:); kept for old messages. */
export const BIND_CB_PREFIX = 'bind:';
/** Inline button: fetch last Q/A for the bound session. */
export const LAST_CB = 'last';
