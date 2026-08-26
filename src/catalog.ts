import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveApiProxy } from './apiproxy.js'
import { describeAgent, workspaceName } from './label.js'

export interface WorkspaceRow {
  id: string
  title: string
  path: string
  sessionIds: string[]
}

export interface SessionRow {
  sessionId: string
  title: string
  cwd?: string
  blank: boolean
  running: boolean
  origin?: string
  updatedAt: number
}

export interface CatalogSnapshot {
  workspaces: WorkspaceRow[]
  sessionsById: Map<string, SessionRow>
  archivedIds: Set<string>
  /** true when loaded from apiProxy (Web-aligned); false for live-agent fallback. */
  complete: boolean
}

type RpcOk<T> = { result: { ok: true; value: T } }
type ApiFn = (req: { rpcId: string; payload: unknown }) => Promise<unknown>

function rpcCall(fn: ApiFn | undefined, payload: unknown): Promise<unknown> | undefined {
  if (typeof fn !== 'function') return undefined
  return fn({ rpcId: randomUUID(), payload })
}

function unwrap<T>(res: unknown): T | undefined {
  const r = res as RpcOk<T> | undefined
  if (r?.result && (r.result as { ok?: boolean }).ok === true) {
    return (r.result as { value: T }).value
  }
  // Some wrappers may return value directly
  if (res && typeof res === 'object' && 'items' in (res as object)) return res as T
  return undefined
}

function titleOf(summary: {
  sessionId: string
  cwd?: string
  projections?: { values?: { title?: string | null } }
}): string {
  const t = summary.projections?.values?.title
  if (typeof t === 'string' && t.trim()) return t.trim()
  const ws = workspaceName(summary.cwd)
  if (ws) return ws
  const id = String(summary.sessionId)
  return id.length > 12 ? `…${id.slice(-12)}` : id
}

/** Load workspaces + sessions aligned with Web UI (via apiProxy when available). */
export async function loadCatalog(ctx: Context): Promise<CatalogSnapshot | undefined> {
  const api = resolveApiProxy(ctx)

  const wsPromise = rpcCall(api?.workspace?.list, {})
  const sessPromise = rpcCall(api?.sessions?.list, {})
  if (!wsPromise || !sessPromise) return undefined

  const [wsRaw, sessRaw] = await Promise.all([wsPromise, sessPromise])
  const wsVal = unwrap<{
    items: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }>
    archivedSessionIds: string[]
  }>(wsRaw)
  const sessVal = unwrap<{
    items: Array<{
      sessionId: string
      updatedAt: number
      running: boolean
      blank: boolean
      origin?: string
      cwd?: string
      projections?: { values?: { title?: string | null } }
    }>
  }>(sessRaw)

  if (!wsVal || !sessVal) return undefined

  const archivedIds = new Set((wsVal.archivedSessionIds ?? []).map(String))
  const sessionsById = new Map<string, SessionRow>()
  for (const item of sessVal.items ?? []) {
    const sessionId = String(item.sessionId)
    sessionsById.set(sessionId, {
      sessionId,
      title: titleOf({ ...item, sessionId }),
      cwd: item.cwd,
      blank: Boolean(item.blank),
      running: Boolean(item.running),
      origin: item.origin,
      updatedAt: Number(item.updatedAt) || 0,
    })
  }

  const workspaces: WorkspaceRow[] = (wsVal.items ?? []).map((w) => ({
    id: String(w.workspaceId),
    title: w.title || workspaceName(w.path) || String(w.workspaceId),
    path: w.path,
    sessionIds: (w.sessionIds ?? []).map(String),
  }))

  return { workspaces, sessionsById, archivedIds, complete: true }
}

/** Create a blank session via apiProxy (Web's session.create contract). */
export async function createSession(
  ctx: Context,
  opts: Record<string, unknown> = {},
): Promise<{ sessionId?: string } | undefined> {
  const api = resolveApiProxy(ctx)
  const fn = api?.sessions?.create ?? api?.session?.create
  if (typeof fn !== 'function') return undefined
  const res = await fn({ rpcId: randomUUID(), payload: opts })
  return unwrap<{ sessionId?: string }>(res)
}

/** Sessions visible under one workspace (Web-like filters). */
export function visibleSessionsForWorkspace(
  catalog: CatalogSnapshot,
  workspace: WorkspaceRow,
): SessionRow[] {
  const rows: SessionRow[] = []
  for (const id of workspace.sessionIds) {
    if (catalog.archivedIds.has(id)) continue
    const row = catalog.sessionsById.get(id)
    if (!row) continue
    if (row.origin === 'subagent') continue
    if (row.blank) continue
    rows.push(row)
  }
  return rows
}

export function workspacesWithVisibleSessions(catalog: CatalogSnapshot): WorkspaceRow[] {
  return catalog.workspaces.filter((w) => visibleSessionsForWorkspace(catalog, w).length > 0)
}

export function truncateButton(text: string, max = 64): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}…`
}

/** Fallback when apiProxy is unavailable: group live agents by cwd. */
export function catalogFromLiveAgents(agents: Agent[], ctx?: Context): CatalogSnapshot {
  const sessionsById = new Map<string, SessionRow>()
  const byPath = new Map<string, { title: string; path: string; sessionIds: string[] }>()

  agents.forEach((agent, index) => {
    const parts = describeAgent(agent, index, ctx)
    const sessionId = parts.sessionId
    const cwd = parts.cwd ?? '(unknown)'
    sessionsById.set(sessionId, {
      sessionId,
      title: parts.title || parts.workspace || sessionId,
      cwd: parts.cwd,
      blank: false,
      running: true,
      updatedAt: Date.now() - index,
    })
    const bucket = byPath.get(cwd) ?? {
      title: parts.workspace || cwd,
      path: cwd,
      sessionIds: [],
    }
    bucket.sessionIds.push(sessionId)
    byPath.set(cwd, bucket)
  })

  const workspaces: WorkspaceRow[] = [...byPath.entries()].map(([path, bucket], i) => ({
    id: `live:${i}`,
    title: bucket.title,
    path,
    sessionIds: bucket.sessionIds,
  }))

  return { workspaces, sessionsById, archivedIds: new Set(), complete: false }
}
