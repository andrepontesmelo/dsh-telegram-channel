import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm/types'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { isAuthorized } from './auth.js'
import {
  catalogFromLiveAgents,
  createSession,
  loadCatalog,
  truncateButton,
  visibleSessionsForWorkspace,
  workspacesWithVisibleSessions,
  type CatalogSnapshot,
  type SessionRow,
  type WorkspaceRow,
} from './catalog.js'
import {
  TelegramClient,
  type InlineKeyboardMarkup,
  type TelegramClientLike,
  type TelegramUpdate,
} from './client.js'
import { MSG, LAST_CB, parseCommand } from './commands.js'
import { markdownToHtml, splitMessage } from './format.js'
import { splitRichMarkdown } from './rich-format.js'
import { formatLastTurn, loadLastTurn } from './history.js'
import { describeAgent, displayLabel } from './label.js'
import {
  formatModel,
  loadSessionModels,
  selectSessionModel,
  type ModelOption,
} from './models.js'

export interface TelegramBridgeOptions {
  token: string
  allowedUserIds: number[]
  allowAllUsers: boolean
  client?: TelegramClientLike
  sleep?: (ms: number) => Promise<void>
  maxMessageLength?: number
  pollingTimeoutSec?: number
  rendering?: 'rich' | 'html'
}

/** chatId → bound live session id (string form of SessionId) */
interface Binding {
  chatId: number
  sessionId: string
  label: string
}

interface PickerState {
  workspaces: WorkspaceRow[]
  sessions: SessionRow[]
  catalog?: CatalogSnapshot
  models?: ModelOption[]
  pendingModel?: ModelOption
  /** 'new' turns workspace rows into create-and-attach actions (/new flow). */
  mode?: 'attach' | 'new'
}

interface SessionLike {
  id: ReturnType<typeof SessionId>
}

const WS_CB = 'ws:'
const SID_CB = 'sid:'
const BACK_WS_CB = 'wb'
const MODEL_CB = 'mdl:'
/** Use eff: (not me:) — short prefix, no collision with other callbacks. */
const EFFORT_CB = 'eff:'
const BACK_MODEL_CB = 'mb'
const MAX_BUTTONS = 40
/** Telegram typing indicators expire after ~5s; resend just inside that window while a turn is busy. */
const TYPING_KEEPALIVE_MS = 4_000
/** Hard cap so a missed 'turn/end' cannot tick forever. */
const TYPING_KEEPALIVE_CAP_MS = 15 * 60_000
const TYPING_KEEPALIVE_MAX_TICKS = Math.ceil(TYPING_KEEPALIVE_CAP_MS / TYPING_KEEPALIVE_MS)

function lastContextKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: 'View last conversation', callback_data: LAST_CB }]],
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function contentToText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function isRichUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /method not found|unknown method|not found|404|bad request|can't parse|rich message/i.test(message)
}

export class TelegramBridge {
  private readonly ctx: Context
  private readonly token: string
  private readonly allowedUserIds: number[]
  private readonly allowAllUsers: boolean
  private readonly client: TelegramClientLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxMessageLength: number
  private renderingMode: 'rich' | 'html'

  private readonly bindings = new Map<string, Binding>()
  private readonly pickers = new Map<string, PickerState>()
  /** chatId → model awaiting reasoning-effort pick (kept outside picker so list refreshes won't drop it). */
  private readonly pendingModels = new Map<string, ModelOption>()
  /** chatId → live typing-keepalive timer (armed on 'turn/start', disarmed on 'turn/end'). */
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private polling = false
  private offset: number | undefined
  private pollPromise: Promise<void> | undefined
  private pollAbort: AbortController | undefined
  private disposeSessionListener: (() => void) | undefined

  constructor(ctx: Context, options: TelegramBridgeOptions) {
    this.ctx = ctx
    this.token = options.token
    this.allowedUserIds = options.allowedUserIds
    this.allowAllUsers = options.allowAllUsers
    this.client = options.client ?? new TelegramClient(options.token, {
      pollingTimeoutSec: options.pollingTimeoutSec ?? 30,
    })
    this.sleep = options.sleep ?? defaultSleep
    this.maxMessageLength = options.maxMessageLength ?? 4096
    this.renderingMode = options.rendering === 'html' ? 'html' : 'rich'
  }

  start(): void {
    this.disposeSessionListener?.()
    this.disposeSessionListener = this.ctx.on('session/event', (session, event) => {
      void this.onSessionEvent(session, event).catch((err) => {
        this.ctx.logger.error(this.redact(err))
      })
    })
    void this.client.setMyCommands([
      { command: 'start', description: 'Welcome & usage' },
      { command: 'sessions', description: 'List sessions by workspace and attach' },
      { command: 'new', description: 'Create a new blank session and attach it' },
      { command: 'last', description: 'View last Q&A (continue context)' },
      { command: 'model', description: 'Switch model of the bound session' },
      { command: 'status', description: 'Show current binding' },
      { command: 'unbind', description: 'Detach phone binding (session stays open)' },
      { command: 'help', description: 'Show help' },
    ]).then(() => {
      this.ctx.logger.info('dsh-telegram-channel: bot commands registered')
    }).catch((err) => {
      this.ctx.logger.warn(`dsh-telegram-channel: setMyCommands failed: ${this.redact(err)}`)
    })
    if (!this.polling) {
      this.polling = true
      this.pollAbort = new AbortController()
      this.ctx.logger.info('dsh-telegram-channel: long-polling started')
      this.pollPromise = this.pollLoop()
    }
  }

  async stop(): Promise<void> {
    this.polling = false
    this.pollAbort?.abort()
    this.pollAbort = undefined
    this.disposeSessionListener?.()
    this.disposeSessionListener = undefined
    // Never dispose host agents — only clear remote bindings.
    this.bindings.clear()
    this.pickers.clear()
    this.pendingModels.clear()
    this.stopAllTypingKeepalives()
    if (this.pollPromise) {
      await this.pollPromise.catch(() => {})
      this.pollPromise = undefined
    }
  }

  async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update)
      return
    }
    const message = update.message
    if (!message?.text) return

    const chatId = message.chat.id
    const userId = message.from?.id

    if (!isAuthorized({ allowAllUsers: this.allowAllUsers, allowedUserIds: this.allowedUserIds, userId })) {
      await this.client.sendMessage(chatId, MSG.DENIED)
      return
    }

    const parsed = parseCommand(message.text)
    switch (parsed.type) {
      case 'start':
        await this.client.sendMessage(chatId, MSG.WELCOME)
        return
      case 'help':
        await this.client.sendMessage(chatId, MSG.HELP)
        return
      case 'sessions':
        await this.sendWorkspacePicker(chatId)
        return
      case 'new':
        await this.handleNew(chatId)
        return
      case 'last':
        await this.sendLastTurn(chatId)
        return
      case 'model':
        await this.sendModelPicker(chatId)
        return
      case 'status':
        await this.sendStatus(chatId)
        return
      case 'unbind':
        this.bindings.delete(String(chatId))
        this.pickers.delete(String(chatId))
        this.stopTypingKeepalive(chatId)
        await this.client.sendMessage(chatId, MSG.UNBOUND)
        return
      case 'unknown':
        // Not a reserved bot command: forward the gesture into the bound
        // session as a user message so the harness injects the skill.
        await this.followupBound(chatId, parsed.text)
        return
      case 'plain':
        await this.followupBound(chatId, parsed.text)
        return
    }
  }

  private async handleCallback(update: TelegramUpdate): Promise<void> {
    const cq = update.callback_query!
    const userId = cq.from.id
    const chatId = cq.message?.chat.id
    if (chatId === undefined) {
      await this.client.answerCallbackQuery(cq.id)
      return
    }
    if (!isAuthorized({ allowAllUsers: this.allowAllUsers, allowedUserIds: this.allowedUserIds, userId })) {
      await this.client.answerCallbackQuery(cq.id, MSG.DENIED)
      await this.client.sendMessage(chatId, MSG.DENIED)
      return
    }
    const data = cq.data ?? ''
    const picker = this.pickers.get(String(chatId))

    if (data === LAST_CB) {
      await this.client.answerCallbackQuery(cq.id)
      await this.sendLastTurn(chatId)
      return
    }
    if (data === BACK_WS_CB) {
      await this.client.answerCallbackQuery(cq.id)
      await this.sendWorkspacePicker(chatId, picker?.catalog)
      return
    }
    if (data === BACK_MODEL_CB) {
      await this.client.answerCallbackQuery(cq.id)
      await this.sendModelPicker(chatId)
      return
    }
    if (data.startsWith(WS_CB)) {
      const index = Number(data.slice(WS_CB.length))
      await this.client.answerCallbackQuery(cq.id)
      if (picker?.mode === 'new')
        await this.createNewBound(chatId, cq.id, picker.workspaces[index])
      else
        await this.sendSessionPicker(chatId, index)
      return
    }
    if (data.startsWith(SID_CB)) {
      const index = Number(data.slice(SID_CB.length))
      const row = picker?.sessions[index]
      if (!row) {
        await this.client.answerCallbackQuery(cq.id, 'Session expired')
        await this.client.sendMessage(chatId, MSG.PICKER_STALE)
        return
      }
      await this.bindSession(chatId, cq.id, row)
      return
    }
    if (data.startsWith(MODEL_CB)) {
      const index = Number(data.slice(MODEL_CB.length))
      const option = picker?.models?.[index]
      if (!option) {
        await this.client.answerCallbackQuery(cq.id, 'List expired')
        await this.client.sendMessage(chatId, MSG.PICKER_STALE)
        return
      }
      const efforts = (option.efforts ?? []).filter((e) => e.id)
      if (efforts.length === 1) {
        // Single effort (often only "off") — apply immediately, no second tap.
        await this.applyModel(chatId, cq.id, { ...option, efforts }, efforts[0]!.id)
        return
      }
      if (efforts.length > 1) {
        const pending = { ...option, efforts }
        this.pendingModels.set(String(chatId), pending)
        if (picker) picker.pendingModel = pending
        await this.client.answerCallbackQuery(cq.id)
        await this.sendEffortPicker(chatId, pending)
        return
      }
      await this.applyModel(chatId, cq.id, option)
      return
    }
    if (data.startsWith(EFFORT_CB) || data.startsWith('me:')) {
      // Accept legacy "me:" callbacks from older bot messages.
      const rawIndex = data.startsWith(EFFORT_CB)
        ? data.slice(EFFORT_CB.length)
        : data.slice('me:'.length)
      const index = Number(rawIndex)
      const pending = this.pendingModels.get(String(chatId)) ?? picker?.pendingModel
      const effort = pending?.efforts?.[index]
      if (!pending || !effort?.id) {
        await this.client.answerCallbackQuery(cq.id, 'List expired')
        await this.client.sendMessage(chatId, MSG.PICKER_STALE)
        return
      }
      await this.applyModel(chatId, cq.id, pending, effort.id)
      return
    }

    // Legacy bind:<sessionId> callbacks (older messages / tests)
    if (data.startsWith('bind:')) {
      const sessionId = data.slice('bind:'.length)
      await this.bindSession(chatId, cq.id, {
        sessionId,
        title: sessionId,
        blank: false,
        running: true,
        updatedAt: 0,
      })
      return
    }

    await this.client.answerCallbackQuery(cq.id)
  }

  private async resolveCatalog(): Promise<CatalogSnapshot> {
    try {
      const fromApi = await loadCatalog(this.ctx)
      if (fromApi) return fromApi
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: catalog via apiProxy failed: ${this.redact(err)}`)
    }
    return catalogFromLiveAgents(this.liveAgents(), this.ctx)
  }

  private async sendWorkspacePicker(
    chatId: number,
    existing?: CatalogSnapshot,
    mode: 'attach' | 'new' = 'attach',
  ): Promise<void> {
    const catalog = existing ?? await this.resolveCatalog()
    const workspaces = workspacesWithVisibleSessions(catalog)
    if (workspaces.length === 0) {
      this.pickers.delete(String(chatId))
      await this.client.sendMessage(chatId, MSG.NO_SESSIONS)
      return
    }
    const shown = workspaces.slice(0, MAX_BUTTONS)
    this.pickers.set(String(chatId), { workspaces: shown, sessions: [], catalog, mode })
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: shown.map((ws, i) => ([{
        text: truncateButton(`${i + 1}. ${ws.title}`),
        callback_data: `${WS_CB}${i}`,
      }])),
    }
    const body = [
      mode === 'new'
        ? `Create a new session — choose a workspace (${workspaces.length} total):`
        : catalog.complete
          ? `Choose a workspace (${workspaces.length} total, Web-aligned, archived excluded):`
          : `Choose a workspace (${workspaces.length} total) ⚠️ only running sessions (apiProxy not ready; full list needs plugin ≥0.3.2 and a dsh web restart):`,
      '',
      ...shown.map((ws, i) => {
        const n = visibleSessionsForWorkspace(catalog, ws).length
        return `${i + 1}. ${ws.title}\n   ${ws.path}\n   Sessions: ${n}`
      }),
      workspaces.length > MAX_BUTTONS ? `\nOnly the first ${MAX_BUTTONS} workspaces are shown.` : '',
      '',
      mode === 'new'
        ? 'Tap a workspace below to create a new blank session there and attach it.'
        : 'Tap a button below to open that workspace\u2019s session list.',
    ].filter(Boolean).join('\n')
    await this.client.sendMessage(chatId, body, undefined, keyboard)
  }

  private async sendSessionPicker(chatId: number, workspaceIndex: number): Promise<void> {
    const picker = this.pickers.get(String(chatId))
    const catalog = picker?.catalog ?? await this.resolveCatalog()
    const workspaces = picker?.workspaces?.length
      ? picker.workspaces
      : workspacesWithVisibleSessions(catalog)
    const workspace = workspaces[workspaceIndex]
    if (!workspace) {
      await this.client.sendMessage(chatId, MSG.PICKER_STALE)
      return
    }
    const sessions = visibleSessionsForWorkspace(catalog, workspace)
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
    if (sessions.length === 0) {
      await this.client.sendMessage(chatId, MSG.NO_SESSIONS_IN_WS(workspace.title))
      return
    }
    const shown = sessions.slice(0, MAX_BUTTONS)
    this.pickers.set(String(chatId), { workspaces, sessions: shown, catalog })
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        ...shown.map((row, i) => ([{
          text: truncateButton(`${i + 1}. ${row.title}${row.running ? '' : ' · cold'}`),
          callback_data: `${SID_CB}${i}`,
        }])),
        [{ text: '← Back to workspaces', callback_data: BACK_WS_CB }],
      ],
    }
    const body = [
      `Workspace: ${workspace.title}`,
      workspace.path,
      '',
      `Choose a session (${sessions.length} total):`,
      '',
      ...shown.map((row, i) => {
        const mark = row.running ? 'running' : 'not attached'
        return `${i + 1}. ${row.title}\n   ${mark} · …${row.sessionId.slice(-12)}`
      }),
      sessions.length > MAX_BUTTONS ? `\nOnly the first ${MAX_BUTTONS} sessions are shown.` : '',
      '',
      'Tap a button below to attach; cold sessions resume automatically (Web stays open).',
    ].filter(Boolean).join('\n')
    await this.client.sendMessage(chatId, body, undefined, keyboard)
  }

  private async bindSession(chatId: number, callbackId: string, row: SessionRow): Promise<void> {
    const agent = await this.ensureLiveAgent(row.sessionId)
    if (!agent) {
      await this.client.answerCallbackQuery(callbackId, 'Cannot attach')
      await this.client.sendMessage(chatId, MSG.RESUME_FAILED)
      return
    }
    const parts = describeAgent(agent, 0, this.ctx)
    const label = row.title && row.title !== row.sessionId
      ? displayLabel({ ...parts, title: row.title })
      : displayLabel(parts)
    this.stopTypingKeepalive(chatId) // binding replaced: the old session must not keep typing for this chat
    this.bindings.set(String(chatId), { chatId, sessionId: String(agent.id), label })
    await this.client.answerCallbackQuery(callbackId, 'Attached')
    await this.client.sendMessage(chatId, MSG.BOUND(label), undefined, lastContextKeyboard())
  }

  private async handleNew(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    let target: WorkspaceRow | undefined
    if (binding) {
      const catalog = await this.resolveCatalog()
      target = catalog.workspaces.find((ws) => ws.sessionIds?.includes(binding.sessionId))
    }
    if (!target) {
      await this.sendWorkspacePicker(chatId, undefined, 'new')
      return
    }
    await this.createNewBound(chatId, undefined, target)
  }

  private async createNewBound(
    chatId: number,
    callbackId: string | undefined,
    workspace: WorkspaceRow | undefined,
  ): Promise<void> {
    await this.client.sendMessage(chatId, MSG.NEW_CREATING(workspace?.title ?? 'the default workspace'))
    const created = await createSession(this.ctx, workspace?.id ? { workspaceId: workspace.id } : {})
    if (!created?.sessionId) {
      if (callbackId !== undefined)
        await this.client.answerCallbackQuery(callbackId, 'Create failed')
      await this.client.sendMessage(chatId, MSG.NEW_FAILED())
      return
    }
    const agent = await this.ensureLiveAgent(created.sessionId)
    if (!agent) {
      if (callbackId !== undefined)
        await this.client.answerCallbackQuery(callbackId, 'Cannot attach')
      await this.client.sendMessage(chatId, MSG.RESUME_FAILED)
      return
    }
    const label = displayLabel(describeAgent(agent, 0, this.ctx))
    this.bindings.set(String(chatId), { chatId, sessionId: String(agent.id), label })
    if (callbackId !== undefined)
      await this.client.answerCallbackQuery(callbackId, 'Attached')
    await this.client.sendMessage(chatId, MSG.BOUND(label), undefined, lastContextKeyboard())
  }

  private async sendLastTurn(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    const agent = await this.ensureLiveAgent(binding.sessionId)
    try {
      const turn = await loadLastTurn(this.ctx, binding.sessionId, agent)
      const text = formatLastTurn(turn)
      await this.deliver(chatId, text)
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: /last failed: ${this.redact(err)}`)
      await this.client.sendMessage(chatId, MSG.LAST_FAILED)
    }
  }

  private async sendModelPicker(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    const agent = await this.ensureLiveAgent(binding.sessionId)
    if (!agent) {
      this.bindings.delete(String(chatId))
      this.stopTypingKeepalive(chatId)
      await this.client.sendMessage(chatId, MSG.GONE)
      return
    }
    try {
      const snap = await loadSessionModels(this.ctx, binding.sessionId)
      if (!snap.routable) {
        await this.client.sendMessage(chatId, MSG.MODEL_UNROUTABLE(formatModel(snap.current)))
        return
      }
      if (snap.options.length === 0) {
        await this.client.sendMessage(chatId, MSG.MODEL_EMPTY(formatModel(snap.current)))
        return
      }
      const shown = snap.options.slice(0, MAX_BUTTONS)
      const prev = this.pickers.get(String(chatId))
      this.pickers.set(String(chatId), {
        workspaces: prev?.workspaces ?? [],
        sessions: prev?.sessions ?? [],
        catalog: prev?.catalog,
        models: shown,
      })
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: shown.map((opt, i) => ([{
          text: truncateButton(
            `${opt.label}${opt.provider === snap.current.provider && opt.model === snap.current.model ? ' ✓' : ''}`,
          ),
          callback_data: `${MODEL_CB}${i}`,
        }])),
      }
      const body = [
        `Current model: ${formatModel(snap.current)}`,
        `Session: ${binding.label}`,
        '',
        'Choose a new model (takes effect next turn):',
      ].join('\n')
      await this.client.sendMessage(chatId, body, undefined, keyboard)
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: /model failed: ${this.redact(err)}`)
      const detail = err instanceof Error ? err.message : String(err)
      await this.client.sendMessage(chatId, MSG.MODEL_UNAVAILABLE(detail))
    }
  }

  private async sendEffortPicker(chatId: number, option: ModelOption): Promise<void> {
    const efforts = option.efforts ?? []
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        ...efforts.map((e, i) => ([{
          text: truncateButton(e.name || e.id),
          callback_data: `${EFFORT_CB}${i}`,
        }])),
        [{ text: '← Back to model list', callback_data: BACK_MODEL_CB }],
      ],
    }
    await this.client.sendMessage(
      chatId,
      `Selected ${option.label}\nChoose a reasoning effort:`,
      undefined,
      keyboard,
    )
  }

  private async applyModel(
    chatId: number,
    callbackId: string,
    option: ModelOption,
    reasoningEffort?: string,
  ): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.answerCallbackQuery(callbackId, 'Not bound')
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    // Ensure session is live before selectModel (same as followup path).
    await this.ensureLiveAgent(binding.sessionId)
    try {
      const selected = await selectSessionModel(this.ctx, binding.sessionId, {
        provider: option.provider,
        model: option.model,
        reasoningEffort,
      })
      this.pendingModels.delete(String(chatId))
      const picker = this.pickers.get(String(chatId))
      if (picker) picker.pendingModel = undefined
      await this.client.answerCallbackQuery(callbackId, 'Switched')
      await this.client.sendMessage(chatId, MSG.MODEL_SET(formatModel(selected)))
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: selectModel failed: ${this.redact(err)}`)
      const detail = err instanceof Error ? err.message : String(err)
      await this.client.answerCallbackQuery(callbackId, 'Switch failed')
      await this.client.sendMessage(chatId, MSG.MODEL_FAILED(detail))
    }
  }

  private liveAgents(): Agent[] {
    const agents = this.ctx.agents
    if (typeof agents.roots === 'function') {
      const roots = agents.roots()
      if (roots.length > 0) return roots
    }
    if (typeof agents.list === 'function') return agents.list()
    return []
  }

  private findLiveAgent(sessionId: string): Agent | undefined {
    const agents = this.ctx.agents
    if (typeof agents.get === 'function') {
      try {
        const found = agents.get(SessionId(sessionId))
        if (found) return found
      } catch {
        // fall through to list scan
      }
    }
    return this.liveAgents().find((a) => String(a.id) === sessionId)
  }

  /** Resume cold sessions when needed; never dispose the returned handle. */
  private async ensureLiveAgent(sessionId: string): Promise<Agent | undefined> {
    const live = this.findLiveAgent(sessionId)
    if (live) return live
    const agents = this.ctx.agents as { resume?: (opts: { resumeSessionId: ReturnType<typeof SessionId> }) => Promise<{ agent: Agent }> }
    if (typeof agents.resume !== 'function') return undefined
    try {
      const handle = await agents.resume({ resumeSessionId: SessionId(sessionId) })
      return handle.agent
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: resume failed for ${sessionId}: ${this.redact(err)}`)
      return undefined
    }
  }

  private async sendStatus(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.STATUS_NONE)
      return
    }
    const stillLive = this.findLiveAgent(binding.sessionId)
    if (!stillLive) {
      await this.client.sendMessage(chatId, MSG.STATUS_BOUND_COLD(binding.label))
      return
    }
    await this.client.sendMessage(chatId, MSG.STATUS_BOUND(binding.label))
  }

  private async followupBound(chatId: number, text: string): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    const agent = await this.ensureLiveAgent(binding.sessionId)
    if (!agent) {
      this.bindings.delete(String(chatId))
      this.stopTypingKeepalive(chatId)
      await this.client.sendMessage(chatId, MSG.GONE)
      return
    }
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    agent.followup(message)
  }

  private async pollLoop(): Promise<void> {
    const signal = this.pollAbort?.signal
    let errorCount = 0
    while (this.polling) {
      try {
        const updates = await this.client.getUpdates(this.offset)
        if (!this.polling) break
        errorCount = 0
        if (updates.length === 0) {
          await this.interruptibleDelay(50, signal)
          continue
        }
        for (const update of updates) {
          if (!this.polling) break
          await this.processUpdate(update)
          this.offset = update.update_id + 1
        }
      } catch (err) {
        if (!this.polling) break
        errorCount += 1
        this.ctx.logger.error(this.redact(err))
        await this.interruptibleSleep(Math.min(1000 * errorCount, 10_000), signal)
      }
    }
  }

  private interruptibleDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || !this.polling) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  private async interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || !this.polling) return
    await Promise.race([
      this.sleep(ms),
      new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve()
          return
        }
        signal?.addEventListener('abort', () => resolve(), { once: true })
      }),
    ])
  }

  /** Re-send 'typing' every TYPING_KEEPALIVE_MS until turn/end, unbind, rebind, or hard cap. */
  private startTypingKeepalive(chatId: number): void {
    this.stopTypingKeepalive(chatId)
    const key = String(chatId)
    let ticks = 0
    const tick = (): void => {
      if (!this.typingTimers.has(key)) return // disarmed between schedule and fire
      if (ticks >= TYPING_KEEPALIVE_MAX_TICKS) {
        // Hard cap: a missed 'turn/end' must not tick forever.
        this.stopTypingKeepalive(chatId)
        this.ctx.logger.warn(`dsh-telegram-channel: typing keepalive hit ${TYPING_KEEPALIVE_CAP_MS}ms cap for chat ${key}`)
        return
      }
      ticks += 1
      const timer = setTimeout(tick, TYPING_KEEPALIVE_MS)
      this.typingTimers.set(key, timer)
      void Promise.resolve(this.client.sendChatAction(chatId, 'typing')).catch((err) => {
        this.ctx.logger.warn(`dsh-telegram-channel: typing keepalive failed for chat ${key}: ${this.redact(err)}`)
      })
    }
    const first = setTimeout(tick, TYPING_KEEPALIVE_MS)
    this.typingTimers.set(key, first)
  }

  private stopTypingKeepalive(chatId: number): void {
    const key = String(chatId)
    const timer = this.typingTimers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.typingTimers.delete(key)
    }
  }

  private stopAllTypingKeepalives(): void {
    for (const timer of this.typingTimers.values()) clearTimeout(timer)
    this.typingTimers.clear()
  }

  private async onSessionEvent(session: SessionLike, event: SessionEvent): Promise<void> {
    const id = String(session.id)
    const targets = [...this.bindings.values()].filter((b) => b.sessionId === id)
    if (targets.length === 0) return

    if (event.type === 'turn/start') {
      await Promise.all(targets.map((b) => this.client.sendChatAction(b.chatId, 'typing')))
      for (const b of targets) this.startTypingKeepalive(b.chatId)
      return
    }

    // 'turn/end' is the only terminal transition in SessionEventMap — it closes
    // the turn regardless of TurnEndReason, so the indicator stops here.
    if (event.type === 'turn/end') {
      for (const b of targets) this.stopTypingKeepalive(b.chatId)
      return
    }

    if (event.type === 'assistant/message') {
      const text = contentToText(event.data.message.content)
      if (!text) return
      await Promise.all(targets.map((b) => this.deliver(b.chatId, text)))
    }
  }

  private async deliver(chatId: number, markdown: string): Promise<void> {
    if (this.renderingMode === 'html') {
      await this.deliverHtml(chatId, markdown)
      return
    }

    let sentAny = false
    try {
      const chunks = splitRichMarkdown(markdown)
      for (const chunk of chunks) {
        await this.client.sendRichMessage(chatId, chunk)
        sentAny = true
      }
    } catch (err) {
      if (!sentAny && isRichUnsupportedError(err)) {
        this.ctx.logger.warn(
          'dsh-telegram-channel: Rich Message API unavailable, falling back to HTML rendering',
        )
        this.renderingMode = 'html'
        await this.deliverHtml(chatId, markdown)
        return
      }
      this.ctx.logger.error(this.redact(err))
    }
  }

  private async deliverHtml(chatId: number, markdown: string): Promise<void> {
    const chunks = splitMessage(markdown, this.maxMessageLength)
    for (const chunk of chunks) {
      const html = markdownToHtml(chunk)
      try {
        await this.client.sendMessage(chatId, html, 'HTML')
      } catch {
        try {
          await this.client.sendMessage(chatId, chunk)
        } catch (err) {
          this.ctx.logger.error(this.redact(err))
        }
      }
    }
  }

  private redact(value: unknown): string {
    const message = value instanceof Error ? value.message : String(value)
    return message.split(this.token).join('***')
  }
}
