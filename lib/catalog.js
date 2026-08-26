import { randomUUID } from 'node:crypto';
import { resolveApiProxy } from './apiproxy.js';
import { describeAgent, workspaceName } from './label.js';
function rpcCall(fn, payload) {
    if (typeof fn !== 'function')
        return undefined;
    return fn({ rpcId: randomUUID(), payload });
}
function unwrap(res) {
    const r = res;
    if (r?.result && r.result.ok === true) {
        return r.result.value;
    }
    // Some wrappers may return value directly
    if (res && typeof res === 'object' && 'items' in res)
        return res;
    return undefined;
}
function titleOf(summary) {
    const t = summary.projections?.values?.title;
    if (typeof t === 'string' && t.trim())
        return t.trim();
    const ws = workspaceName(summary.cwd);
    if (ws)
        return ws;
    const id = String(summary.sessionId);
    return id.length > 12 ? `…${id.slice(-12)}` : id;
}
/** Load workspaces + sessions aligned with Web UI (via apiProxy when available). */
export async function loadCatalog(ctx) {
    const api = resolveApiProxy(ctx);
    const wsPromise = rpcCall(api?.workspace?.list, {});
    const sessPromise = rpcCall(api?.sessions?.list, {});
    if (!wsPromise || !sessPromise)
        return undefined;
    const [wsRaw, sessRaw] = await Promise.all([wsPromise, sessPromise]);
    const wsVal = unwrap(wsRaw);
    const sessVal = unwrap(sessRaw);
    if (!wsVal || !sessVal)
        return undefined;
    const archivedIds = new Set((wsVal.archivedSessionIds ?? []).map(String));
    const sessionsById = new Map();
    for (const item of sessVal.items ?? []) {
        const sessionId = String(item.sessionId);
        sessionsById.set(sessionId, {
            sessionId,
            title: titleOf({ ...item, sessionId }),
            cwd: item.cwd,
            blank: Boolean(item.blank),
            running: Boolean(item.running),
            origin: item.origin,
            updatedAt: Number(item.updatedAt) || 0,
        });
    }
    const workspaces = (wsVal.items ?? []).map((w) => ({
        id: String(w.workspaceId),
        title: w.title || workspaceName(w.path) || String(w.workspaceId),
        path: w.path,
        sessionIds: (w.sessionIds ?? []).map(String),
    }));
    return { workspaces, sessionsById, archivedIds, complete: true };
}
/** Create a blank session via apiProxy (Web's session.create contract). */
export async function createSession(ctx, opts = {}) {
    const api = resolveApiProxy(ctx);
    const fn = api?.sessions?.create ?? api?.session?.create;
    if (typeof fn !== 'function')
        return undefined;
    const res = await fn({ rpcId: randomUUID(), payload: opts });
    return unwrap(res);
}
/** Sessions visible under one workspace (Web-like filters). */
export function visibleSessionsForWorkspace(catalog, workspace) {
    const rows = [];
    for (const id of workspace.sessionIds) {
        if (catalog.archivedIds.has(id))
            continue;
        const row = catalog.sessionsById.get(id);
        if (!row)
            continue;
        if (row.origin === 'subagent')
            continue;
        if (row.blank)
            continue;
        rows.push(row);
    }
    return rows;
}
export function workspacesWithVisibleSessions(catalog) {
    return catalog.workspaces.filter((w) => visibleSessionsForWorkspace(catalog, w).length > 0);
}
export function truncateButton(text, max = 64) {
    const chars = [...text];
    if (chars.length <= max)
        return text;
    return `${chars.slice(0, max - 1).join('')}…`;
}
/** Fallback when apiProxy is unavailable: group live agents by cwd. */
export function catalogFromLiveAgents(agents, ctx) {
    const sessionsById = new Map();
    const byPath = new Map();
    agents.forEach((agent, index) => {
        const parts = describeAgent(agent, index, ctx);
        const sessionId = parts.sessionId;
        const cwd = parts.cwd ?? '(unknown)';
        sessionsById.set(sessionId, {
            sessionId,
            title: parts.title || parts.workspace || sessionId,
            cwd: parts.cwd,
            blank: false,
            running: true,
            updatedAt: Date.now() - index,
        });
        const bucket = byPath.get(cwd) ?? {
            title: parts.workspace || cwd,
            path: cwd,
            sessionIds: [],
        };
        bucket.sessionIds.push(sessionId);
        byPath.set(cwd, bucket);
    });
    const workspaces = [...byPath.entries()].map(([path, bucket], i) => ({
        id: `live:${i}`,
        title: bucket.title,
        path,
        sessionIds: bucket.sessionIds,
    }));
    return { workspaces, sessionsById, archivedIds: new Set(), complete: false };
}
