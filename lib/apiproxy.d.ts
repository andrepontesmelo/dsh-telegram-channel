import type { Context } from '@deepseek-ai/cordis';
/** Loose ApiProxy surface used by catalog + model helpers. */
export type ApiProxySessions = {
    list?: (req: {
        rpcId: string;
        payload: unknown;
    }) => Promise<unknown>;
    create?: (req: {
        rpcId: string;
        payload: unknown;
    }) => Promise<unknown>;
    history?: (req: {
        rpcId: string;
        payload: unknown;
    }) => Promise<unknown>;
    models?: (req: {
        rpcId: string;
        payload: unknown;
    }) => Promise<unknown>;
    selectModel?: (req: {
        rpcId: string;
        payload: unknown;
    }) => Promise<unknown>;
};
export type ApiProxyLike = {
    workspace?: {
        list?: (req: {
            rpcId: string;
            payload: unknown;
        }) => Promise<unknown>;
    };
    sessions?: ApiProxySessions;
    /** Older naming kept for compatibility with `session.create`. */
    session?: ApiProxySessions;
};
/**
 * Resolve host apiProxy without requiring Cordis inject.
 * Direct `ctx.apiProxy` throws "cannot get property without inject" on real fibers.
 */
export declare function resolveApiProxy(ctx: Context): ApiProxyLike | undefined;
