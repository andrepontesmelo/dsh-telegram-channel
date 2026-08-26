import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
export interface WorkspaceRow {
    id: string;
    title: string;
    path: string;
    sessionIds: string[];
}
export interface SessionRow {
    sessionId: string;
    title: string;
    cwd?: string;
    blank: boolean;
    running: boolean;
    origin?: string;
    updatedAt: number;
}
export interface CatalogSnapshot {
    workspaces: WorkspaceRow[];
    sessionsById: Map<string, SessionRow>;
    archivedIds: Set<string>;
    /** true when loaded from apiProxy (Web-aligned); false for live-agent fallback. */
    complete: boolean;
}
/** Load workspaces + sessions aligned with Web UI (via apiProxy when available). */
export declare function loadCatalog(ctx: Context): Promise<CatalogSnapshot | undefined>;
/** Create a blank session via apiProxy (Web's session.create contract). */
export declare function createSession(ctx: Context, opts?: Record<string, unknown>): Promise<{
    sessionId?: string;
} | undefined>;
/** Sessions visible under one workspace (Web-like filters). */
export declare function visibleSessionsForWorkspace(catalog: CatalogSnapshot, workspace: WorkspaceRow): SessionRow[];
export declare function workspacesWithVisibleSessions(catalog: CatalogSnapshot): WorkspaceRow[];
export declare function truncateButton(text: string, max?: number): string;
/** Fallback when apiProxy is unavailable: group live agents by cwd. */
export declare function catalogFromLiveAgents(agents: Agent[], ctx?: Context): CatalogSnapshot;
