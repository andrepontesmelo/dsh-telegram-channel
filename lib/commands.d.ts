export declare const MSG: {
    readonly DENIED: "Access denied.";
    readonly WELCOME: string;
    readonly HELP: string;
    readonly NEED_BIND: "No local session bound yet. Send /sessions to choose one.";
    readonly NO_SESSIONS: "There are no attachable local sessions right now (archived and blank sessions excluded). Open or continue a conversation in Web (dsh web) first, then send /sessions.";
    readonly NO_SESSIONS_IN_WS: (title: string) => string;
    /** @deprecated use NO_SESSIONS */
    readonly NO_LIVE: "There are no attachable local sessions right now. Open or continue a conversation in Web (dsh web) first, then send /sessions.";
    readonly PICKER_STALE: "The list is out of date — please send /sessions again.";
    readonly NEW_CREATING: (title: string) => string;
    readonly NEW_FAILED: (detail?: string) => string;
    readonly RESUME_FAILED: "Could not attach that session (resume failed). Make sure the session exists in Web, or open it on the computer first and try again.";
    readonly BOUND: (label: string) => string;
    readonly UNBOUND: "Binding detached. The local session is still running.";
    readonly STATUS_NONE: "No local session is bound right now. Send /sessions to choose one.";
    readonly STATUS_BOUND: (label: string) => string;
    readonly STATUS_BOUND_COLD: (label: string) => string;
    readonly GONE: "The bound session is no longer available. Please /sessions again.";
    readonly LAST_FAILED: "Could not read the last conversation. Make sure a session is bound and dsh web / apiProxy is running on this machine.";
    readonly MODEL_UNAVAILABLE: (detail?: string) => string;
    readonly MODEL_UNROUTABLE: (current: string) => string;
    readonly MODEL_EMPTY: (current: string) => string;
    readonly MODEL_SET: (selected: string) => string;
    readonly MODEL_FAILED: (detail?: string) => string;
};
export type ParsedCommand = {
    type: 'start';
    text: string;
} | {
    type: 'help';
    text: string;
} | {
    type: 'sessions';
    text: string;
} | {
    type: 'new';
    text: string;
} | {
    type: 'last';
    text: string;
} | {
    type: 'model';
    text: string;
} | {
    type: 'status';
    text: string;
} | {
    type: 'unbind';
    text: string;
} | {
    type: 'unknown';
    command: string;
    text: string;
} | {
    type: 'plain';
    text: string;
};
export declare function parseCommand(text: string): ParsedCommand;
/** @deprecated Prefer short index callbacks (ws:/sid:); kept for old messages. */
export declare const BIND_CB_PREFIX = "bind:";
/** Inline button: fetch last Q/A for the bound session. */
export declare const LAST_CB = "last";
