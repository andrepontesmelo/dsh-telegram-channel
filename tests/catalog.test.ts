import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSession,
  visibleSessionsForWorkspace,
  workspacesWithVisibleSessions,
  type CatalogSnapshot,
} from '../src/catalog.ts'

test('visible sessions exclude archived blank and subagent', () => {
  const catalog: CatalogSnapshot = {
    complete: true,
    archivedIds: new Set(['arch']),
    sessionsById: new Map([
      ['ok', { sessionId: 'ok', title: 'OK', blank: false, running: true, updatedAt: 1 }],
      ['arch', { sessionId: 'arch', title: 'Arch', blank: false, running: false, updatedAt: 1 }],
      ['blank', { sessionId: 'blank', title: 'Blank', blank: true, running: false, updatedAt: 1 }],
      ['sub', { sessionId: 'sub', title: 'Sub', blank: false, running: false, origin: 'subagent', updatedAt: 1 }],
    ]),
    workspaces: [{
      id: 'w',
      title: 'W',
      path: '/w',
      sessionIds: ['ok', 'arch', 'blank', 'sub', 'missing'],
    }],
  }
  const rows = visibleSessionsForWorkspace(catalog, catalog.workspaces[0]!)
  assert.deepEqual(rows.map((r) => r.sessionId), ['ok'])
  assert.equal(workspacesWithVisibleSessions(catalog).length, 1)
})

function ctxWith(proxy: unknown) {
  return {
    logger: { info() {}, warn() {}, error() {} },
    ...(proxy ? { apiProxy: proxy } : {}),
  } as any
}

test('createSession via sessions.create unwraps rpcOk', async () => {
  const calls: Array<{ rpcId: string; payload: unknown }> = []
  const ctx = ctxWith({
    sessions: {
      create: async (req: { rpcId: string; payload: unknown }) => {
        calls.push(req)
        return { rpcId: req.rpcId, result: { ok: true, value: { sessionId: 'n1' } } }
      },
    },
  })
  const created = await createSession(ctx, { workspaceId: 'w1' })
  assert.deepEqual(created, { sessionId: 'n1' })
  assert.equal(calls.length, 1)
  assert.ok(calls[0]!.rpcId.length > 0)
  assert.deepEqual(calls[0]!.payload, { workspaceId: 'w1' })
})

test('createSession falls back to session.create and passes default empty payload', async () => {
  const payloads: unknown[] = []
  const ctx = ctxWith({
    session: {
      create: async (req: { rpcId: string; payload: unknown }) => {
        payloads.push(req.payload)
        return { result: { ok: true, value: { sessionId: 'n2' } } }
      },
    },
  })
  const created = await createSession(ctx)
  assert.deepEqual(created, { sessionId: 'n2' })
  assert.deepEqual(payloads, [{}])
})

test('createSession without apiProxy or create fn yields undefined', async () => {
  assert.equal(await createSession(ctxWith(undefined)), undefined)
  assert.equal(await createSession(ctxWith({ sessions: {} })), undefined)
})
