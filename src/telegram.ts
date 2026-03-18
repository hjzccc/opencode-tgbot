import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir, hostname } from "os"
import { isUpstashConfigured, type NotifierConfig, type TelegramConfig } from "./config"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  getBusySessions,
  isLocalSession,
  getSession,
  readAllSharedSessions,
  readGroupedSessions,
  onCommandResult,
  trackTodos,
  writeSharedPendingQuestion,
  readSharedPendingQuestion,
  clearSharedPendingQuestion,
  writeRemoteCommand,
  cleanupSharedState,
  startSSESubscription,
  stopSSESubscription,
  handleSSEMessage,
  setCommandHandler,
  upstashCommand,
  type CommandResult,
  type RemoteCommand,
  type TrackedSession,
} from "./state"

type CommandHandler = (args: string) => Promise<string>

interface TelegramBot {
  sendMessage(text: string): Promise<void>
  sendCompletionSummary(sessionID: string, eventType: string, projectName: string | null): Promise<void>
  stop(): void
}

let muted = false
let connectedSessionID: string | null = null
let connectedSessionTitle: string | null = null
let sessionListCache: Array<{ id: string; title: string }> = []

let storedBotToken = ""
let storedChatId = ""
let storedClient: PluginInput["client"] | null = null
let streamingLastSentIndex = 0
let streamingTimer: ReturnType<typeof setTimeout> | null = null
let streamingLastSendAt = 0
let lastToolStatusSentAt = 0
let lastToolStatusTool = ""
let lastSentTodoHash = ""
const STREAMING_DEBOUNCE_MS = 5000
const STREAMING_MIN_CHUNK = 200
const TOOL_STATUS_INTERVAL_MS = 10000

interface PendingQuestion {
  requestID: string
  sessionID: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
}
let pendingQuestion: PendingQuestion | null = null

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(-maxLen) + "…"
}

export function markdownToTelegramHtml(md: string): string {
  let result = md

  const codeBlocks: string[] = []
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length
    const label = lang ? `<b>${escapeHtml(lang)}</b>\n` : ""
    codeBlocks.push(`${label}<pre>${escapeHtml(code.trimEnd())}</pre>`)
    return `\x00CODEBLOCK${idx}\x00`
  })

  const inlineCodes: string[] = []
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00INLINE${idx}\x00`
  })

  result = escapeHtml(result)

  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  result = result.replace(/__(.+?)__/g, "<b>$1</b>")

  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>")
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>")

  result = result.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>")

  result = result.replace(/^\s*[-*]\s+/gm, "• ")
  result = result.replace(/^\s*(\d+)\.\s+/gm, "$1. ")

  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  result = result.replace(/^&gt;\s?(.*)$/gm, "┃ <i>$1</i>")

  result = result.replace(/^---+$/gm, "—————")

  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i])
  }
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`\x00INLINE${i}\x00`, inlineCodes[i])
  }

  result = result.replace(/\n{3,}/g, "\n\n")

  return result.trim()
}

function formatSessionStatus(session: TrackedSession): string {
  const statusEmoji =
    session.status === "busy" ? "🔄" : session.status === "error" ? "❌" : "✅"
  const title = session.title ? escapeHtml(session.title) : "Untitled"
  const id = escapeHtml(session.sessionID.slice(0, 8))
  const project = session.projectName ? ` [${escapeHtml(session.projectName)}]` : ""

  let line = `${statusEmoji} <b>${title}</b>${project} <code>${id}</code>`

  if (session.activeTool) {
    const toolName = escapeHtml(session.activeTool.tool)
    const elapsed = Math.round((Date.now() - session.activeTool.startedAt) / 1000)
    line += `\n   🔧 ${toolName} (${elapsed}s)`
  }

  return line
}

function getBestText(session: TrackedSession): string {
  if (session.streamingText.length > 0) return session.streamingText
  if (session.lastFullText.length > 0) return session.lastFullText
  return ""
}

function clearStreamingState(): void {
  if (streamingTimer) {
    clearTimeout(streamingTimer)
    streamingTimer = null
  }
  streamingLastSentIndex = 0
  streamingLastSendAt = 0
  lastToolStatusSentAt = 0
  lastToolStatusTool = ""
  lastSentTodoHash = ""
}

function getTodoHash(sessionID: string): string {
  const session = getSession(sessionID)
  if (!session || session.todos.length === 0) return ""
  return session.todos
    .map((todo) => `${todo.id}:${todo.status}:${todo.priority}:${todo.content}`)
    .join("|")
}

export function formatTodos(todos: Array<{ content: string; status: string }>): string {
  if (todos.length === 0) return ""

  const pending = todos.filter((t) => t.status === "pending")
  const inProgress = todos.filter((t) => t.status === "in_progress")
  const cancelled = todos.filter((t) => t.status === "cancelled")
  const completedCount = todos.filter((t) => t.status === "completed").length

  const lines: string[] = ["📋 <b>Tasks</b>"]

  for (const t of inProgress) {
    lines.push(`🔄 ${escapeHtml(t.content)}`)
  }
  for (const t of pending) {
    lines.push(`⬚ ${escapeHtml(t.content)}`)
  }
  for (const t of cancelled) {
    lines.push(`❌ ${escapeHtml(t.content)}`)
  }

  const visible = inProgress.length + pending.length + cancelled.length
  if (visible === 0) {
    lines.push("✅ All tasks completed")
  }
  lines.push(`(${completedCount}/${todos.length} done)`)

  return lines.join("\n")
}

function formatTodoList(sessionID: string): string {
  const session = getSession(sessionID)
  if (!session || session.todos.length === 0) return ""
  return formatTodos(session.todos)
}

async function fetchAndFormatTodos(
  client: PluginInput["client"],
  sessionID: string
): Promise<string> {
  try {
    const resp = await client.session.todo({ path: { id: sessionID } })
    const todos = resp.data ?? []
    trackTodos(
      sessionID,
      todos.map((t: any) => ({
        content: t.content ?? "",
        status: t.status ?? "pending",
        priority: t.priority ?? "medium",
        id: t.id ?? "",
      }))
    )
    if (todos.length === 0) return ""
    return formatTodos(todos)
  } catch {
    return ""
  }
}

async function doStreamingSend(): Promise<void> {
  if (!connectedSessionID || !storedBotToken || !storedChatId) return

  const session = getSession(connectedSessionID)
  if (!session) return

  let sentText = false
  const rawText = getBestText(session)
  if (rawText.length > streamingLastSentIndex) {
    const newText = rawText.slice(streamingLastSentIndex)
    if (newText.length >= STREAMING_MIN_CHUNK) {
      const chunk = newText.length > 3500 ? newText.slice(0, 3500) + "…" : newText
      let content = markdownToTelegramHtml(chunk)
      if (content.trim().length > 0) {
        const todoHash = getTodoHash(connectedSessionID)
        if (todoHash !== lastSentTodoHash) {
          const todoText = formatTodoList(connectedSessionID)
          if (todoText.length > 0) {
            content = `${content}\n\n${todoText}`
          }
          lastSentTodoHash = todoHash
        }

        try {
          await telegramApiCall(storedBotToken, "sendMessage", {
            chat_id: storedChatId,
            text: content,
            parse_mode: "HTML",
          })
          streamingLastSentIndex = rawText.length
          streamingLastSendAt = Date.now()
          sentText = true
        } catch {}
      }
    }
  }

  if (sentText) return

  if (!session.activeTool) {
    lastToolStatusTool = ""
    return
  }

  const now = Date.now()
  const toolKey = `${session.activeTool.callID}:${session.activeTool.tool}`
  const shouldSend =
    toolKey !== lastToolStatusTool ||
    now - lastToolStatusSentAt >= TOOL_STATUS_INTERVAL_MS

  if (!shouldSend) return

  const elapsed = Math.max(0, Math.round((now - session.activeTool.startedAt) / 1000))
  const toolName = escapeHtml(session.activeTool.tool)

  try {
    await telegramApiCall(storedBotToken, "sendMessage", {
      chat_id: storedChatId,
      text: `🔧 <code>${toolName}</code> — running (${elapsed}s)`,
      parse_mode: "HTML",
    })
    lastToolStatusSentAt = now
    lastToolStatusTool = toolKey
  } catch {}
}

export function pushStreamUpdate(_sessionID: string): void {
}

export function notifyConnectedSessionIdle(sessionID: string): void {
  if (sessionID !== connectedSessionID) return
  clearStreamingState()
}

const LOCK_PATH = join(homedir(), ".config", "opencode", "notifier-poll.lock")
const POLL_LOCK_KEY = "poll:lock"
const POLL_LOCK_TTL_SECONDS = 30
const POLL_LOCK_REFRESH_MS = 25_000
const INSTANCE_IDENTITY = `${hostname()}:${process.pid}`
let upstashLockConfig: { url: string; token: string } | null = null
let pollLockRefreshInterval: ReturnType<typeof setInterval> | null = null

export async function forwardQuestionToTelegram(question: PendingQuestion): Promise<void> {
  if (!storedBotToken || !storedChatId) return

  pendingQuestion = question
  writeSharedPendingQuestion({ ...question, createdAt: Date.now() })

  const lines: string[] = ["❓ <b>Question</b>\n"]

  for (let qi = 0; qi < question.questions.length; qi++) {
    const q = question.questions[qi]
    lines.push(`<b>${escapeHtml(q.header)}</b>`)
    lines.push(escapeHtml(q.question))

    if (q.options.length > 0) {
      lines.push("")
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i]
        const desc = opt.description ? ` — ${escapeHtml(opt.description)}` : ""
        lines.push(`<b>a${i + 1}.</b> ${escapeHtml(opt.label)}${desc}`)
      }
    }

    if (q.custom !== false) {
      lines.push("\n💬 Reply with a1, a2… or <code>a: your answer</code>")
    } else {
      lines.push("\n💬 Reply with a1, a2…")
    }
  }

  try {
    await telegramApiCall(storedBotToken, "sendMessage", {
      chat_id: storedChatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
    })
  } catch {}
}

async function fetchPendingQuestions(sessionID: string): Promise<PendingQuestion | null> {
  return fetchPendingQuestionsInternal(sessionID)
}

async function fetchAnyPendingQuestion(): Promise<PendingQuestion | null> {
  return fetchPendingQuestionsInternal(null)
}

async function fetchPendingQuestionsInternal(sessionID: string | null): Promise<PendingQuestion | null> {
  if (!storedClient) return null
  try {
    const internalClient = (storedClient as any)._client
    const resp = await internalClient.get({ url: "/question" })
    const questions = resp.data as Array<{
      id: string
      sessionID: string
      questions: PendingQuestion["questions"]
    }> | undefined
    if (!questions || questions.length === 0) return null
    const match = sessionID ? questions.find((q) => q.sessionID === sessionID) : questions[0]
    if (!match) return null
    return { requestID: match.id, sessionID: match.sessionID, questions: match.questions }
  } catch {
    return null
  }
}

function createCommandID(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

async function awaitRemoteResult(cmdID: string, timeoutMs: number = 10000): Promise<CommandResult | null> {
  return onCommandResult(cmdID, timeoutMs)
}

export async function handleQuestionReply(text: string, expectedSessionID?: string): Promise<string> {
  if (!storedClient) {
    return "No pending question"
  }

  if (!pendingQuestion || (expectedSessionID && pendingQuestion.sessionID !== expectedSessionID)) {
    pendingQuestion = expectedSessionID
      ? await fetchPendingQuestions(expectedSessionID)
      : await fetchAnyPendingQuestion()
  }

  if (!pendingQuestion && expectedSessionID) {
    const shared = readSharedPendingQuestion()
    if (shared && shared.sessionID === expectedSessionID) {
      pendingQuestion = shared
    }
  }

  if (!pendingQuestion || (expectedSessionID && pendingQuestion.sessionID !== expectedSessionID)) {
    return "No pending question"
  }

  const q = pendingQuestion.questions[0]
  const pq = pendingQuestion
  pendingQuestion = null
  clearSharedPendingQuestion()

  let answer: string[]

  const m = text.trim().match(/^a(\d+)$/i)
  const num = m ? parseInt(m[1], 10) : NaN
  if (!isNaN(num) && num >= 1 && num <= q.options.length) {
    answer = [q.options[num - 1].label]
  } else {
    answer = [text.trim()]
  }

  try {
    const internalClient = (storedClient as any)._client
    const resp = await internalClient.post({
      url: "/question/{requestID}/reply",
      path: { requestID: pq.requestID },
      body: { answers: [answer] },
      headers: { "Content-Type": "application/json" },
    })
    if (resp.error) {
      return `❌ Failed to reply: ${String(resp.error).slice(0, 100)}`
    }
    return `✅ Answered: <b>${escapeHtml(answer[0])}</b>`
  } catch (e: any) {
    return `❌ Failed: ${escapeHtml(String(e?.message || e).slice(0, 200))}`
  }
}

function isOpenCodeProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8")
    return cmdline.includes("opencode")
  } catch {
    return true
  }
}

function startPollLockRefresh(): void {
  if (!upstashLockConfig) return
  if (pollLockRefreshInterval) {
    clearInterval(pollLockRefreshInterval)
    pollLockRefreshInterval = null
  }
  pollLockRefreshInterval = setInterval(() => {
    if (!upstashLockConfig) return
    void upstashCommand(upstashLockConfig.url, upstashLockConfig.token, [
      "SET",
      POLL_LOCK_KEY,
      INSTANCE_IDENTITY,
      "EX",
      String(POLL_LOCK_TTL_SECONDS),
    ]).catch(() => {})
  }, POLL_LOCK_REFRESH_MS)
}

function stopPollLockRefresh(): void {
  if (!pollLockRefreshInterval) return
  clearInterval(pollLockRefreshInterval)
  pollLockRefreshInterval = null
}

async function acquirePollLock(): Promise<boolean> {
  if (upstashLockConfig) {
    const result = await upstashCommand(upstashLockConfig.url, upstashLockConfig.token, [
      "SET",
      POLL_LOCK_KEY,
      INSTANCE_IDENTITY,
      "NX",
      "EX",
      String(POLL_LOCK_TTL_SECONDS),
    ])
    if (result === "OK") {
      startPollLockRefresh()
      return true
    }

    const current = await upstashCommand(upstashLockConfig.url, upstashLockConfig.token, ["GET", POLL_LOCK_KEY])
    if (current === INSTANCE_IDENTITY) {
      await upstashCommand(upstashLockConfig.url, upstashLockConfig.token, [
        "SET", POLL_LOCK_KEY, INSTANCE_IDENTITY, "EX", String(POLL_LOCK_TTL_SECONDS),
      ])
      startPollLockRefresh()
      return true
    }

    const ttl = await upstashCommand(upstashLockConfig.url, upstashLockConfig.token, ["TTL", POLL_LOCK_KEY])
    if (typeof ttl === "number" && ttl <= 5) {
      await new Promise(r => setTimeout(r, (ttl + 1) * 1000))
      const retry = await upstashCommand(upstashLockConfig.url, upstashLockConfig.token, [
        "SET", POLL_LOCK_KEY, INSTANCE_IDENTITY, "NX", "EX", String(POLL_LOCK_TTL_SECONDS),
      ])
      if (retry === "OK") {
        startPollLockRefresh()
        return true
      }
    }

    if (typeof ttl === "number" && ttl < 0) {
      const retry = await upstashCommand(upstashLockConfig.url, upstashLockConfig.token, [
        "SET", POLL_LOCK_KEY, INSTANCE_IDENTITY, "NX", "EX", String(POLL_LOCK_TTL_SECONDS),
      ])
      if (retry === "OK") {
        startPollLockRefresh()
        return true
      }
    }

    return false
  }

  try {
    mkdirSync(join(homedir(), ".config", "opencode"), { recursive: true })
  } catch {}

  if (existsSync(LOCK_PATH)) {
    try {
      const pid = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10)
      if (!isNaN(pid) && isOpenCodeProcess(pid)) {
        return false
      }
    } catch {}
  }

  try {
    writeFileSync(LOCK_PATH, String(process.pid), { flag: "w" })
    return true
  } catch {
    return false
  }
}

async function releasePollLock(): Promise<void> {
  stopPollLockRefresh()

  if (upstashLockConfig) {
    try {
      const current = await upstashCommand(upstashLockConfig.url, upstashLockConfig.token, ["GET", POLL_LOCK_KEY])
      if (current === INSTANCE_IDENTITY) {
        await upstashCommand(upstashLockConfig.url, upstashLockConfig.token, ["DEL", POLL_LOCK_KEY])
      }
    } catch {}
  }

  try {
    if (existsSync(LOCK_PATH)) {
      const pid = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10)
      if (pid === process.pid) {
        unlinkSync(LOCK_PATH)
      }
    }
  } catch {}
}

function buildPromptBody(text: string) {
  return {
    parts: [{ type: "text" as const, text }],
  }
}

async function getSessionOutputPreview(
  client: PluginInput["client"],
  sessionID: string
): Promise<string> {
  const tracked = getSession(sessionID)
  const trackedText = tracked ? getBestText(tracked) : ""

  if (trackedText.length > 0) {
    return markdownToTelegramHtml(truncate(trackedText, 800))
  }

  const output = await fetchSessionOutput(client, sessionID)
  if (output.text.length > 0) {
    return markdownToTelegramHtml(truncate(output.text, 800))
  }

  return ""
}

async function telegramApiCall(
  botToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Telegram API ${method} failed (${response.status}): ${text}`)
  }

  return response.json()
}

async function fetchSessionOutput(
  client: PluginInput["client"],
  sessionID: string
): Promise<{ text: string; toolName: string | null; toolStatus: string | null }> {
  try {
    const response = await client.session.messages({ path: { id: sessionID } })
    const messages = response.data ?? []

    const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
    if (!lastAssistant) return { text: "", toolName: null, toolStatus: null }

    let text = ""
    let toolName: string | null = null
    let toolStatus: string | null = null

    for (const part of lastAssistant.parts) {
      if ((part as any).type === "text" && (part as any).text) {
        text += (part as any).text
      }
      if ((part as any).type === "tool") {
        toolName = (part as any).tool ?? (part as any).name ?? null
        toolStatus = (part as any).state?.status ?? null
      }
    }

    return { text, toolName, toolStatus }
  } catch {
    return { text: "", toolName: null, toolStatus: null }
  }
}

function buildCommandHandlers(
  client: PluginInput["client"]
): Record<string, CommandHandler> {
  return {
    status: async () => {
      const all = readAllSharedSessions()
      const busy = all.filter((s) => s.status === "busy")

      if (busy.length === 0) {
        return "💤 <b>Idle</b> — no active generation"
      }

      const lines: string[] = ["🔄 <b>Active Generation</b>\n"]
      const todoSections: string[] = []

      for (const s of busy) {
        const title = escapeHtml(s.title || "Untitled")
        const id = escapeHtml(s.sessionID.slice(0, 8))
        const projectTag = s.projectName ? ` [${escapeHtml(s.projectName)}]` : ""
        lines.push(`🔄 <b>${title}</b>${projectTag} <code>${id}</code>`)

        if (s.activeTool) {
          const toolName = escapeHtml(s.activeTool.tool)
          const elapsed = Math.round((Date.now() - s.activeTool.startedAt) / 1000)
          lines.push(`   🔧 Running: <code>${toolName}</code> (${elapsed}s)`)
        }

        const tracked = getSession(s.sessionID)
        const text = tracked ? getBestText(tracked) : ""
        if (text.length > 0) {
          lines.push(`\n${markdownToTelegramHtml(truncate(text, 800))}`)
        }

        const todoText = await fetchAndFormatTodos(client, s.sessionID)
        if (todoText.length > 0) {
          todoSections.push(`<b>${title}</b>\n${todoText}`)
        }

        lines.push("")
      }

      if (todoSections.length > 0) {
        lines.push("📋 <b>Task Lists</b>")
        lines.push("")
        lines.push(todoSections.join("\n\n"))
      }

      return lines.join("\n")
    },

    sessions: async () => {
      const groups = readGroupedSessions()
      const totalSessions = groups.reduce((n, g) => n + g.sessions.length, 0)
      if (totalSessions === 0) return "📭 No sessions found"

      const statusOrder = { busy: 0, error: 1, idle: 2 }
      for (const group of groups) {
        group.sessions.sort((a, b) => {
          const sa = statusOrder[a.status] ?? 2
          const sb = statusOrder[b.status] ?? 2
          if (sa !== sb) return sa - sb
          return b.lastActivityAt - a.lastActivityAt
        })
      }
      groups.sort((a, b) => (a.isLocal ? -1 : 0) - (b.isLocal ? -1 : 0))

      sessionListCache = []
      const lines = [`📋 <b>Sessions</b> (${totalSessions})\n`]
      let idx = 0
      for (const group of groups) {
        const tag = group.isLocal ? "local" : "remote"
        lines.push(`🖥 <b>${escapeHtml(group.hostname)}</b> <i>(${tag})</i>`)
        for (const info of group.sessions) {
          idx++
          const title = info.title || "Untitled"
          sessionListCache.push({ id: info.sessionID, title })
          const emoji = info.status === "busy" ? "🔄" : info.status === "error" ? "❌" : "✅"
          const connected = info.sessionID === connectedSessionID ? " 📍" : ""
          const project = info.projectName
            ? ` <i>[${escapeHtml(info.projectName)}]</i>`
            : ""
          lines.push(`  <b>${idx}.</b> ${emoji} ${escapeHtml(title)}${project}${connected}`)
        }
        lines.push("")
      }

      lines.push(`Reply with a number to connect`)
      if (connectedSessionID) {
        lines.push(`📍 Connected: <b>${escapeHtml(connectedSessionTitle || "Untitled")}</b>`)
      }
      return lines.join("\n")
    },

    mute: async () => {
      muted = true
      return "🔕 Notifications muted. Use /unmute to re-enable."
    },

    unmute: async () => {
      muted = false
      return "🔔 Notifications enabled."
    },

    connect: async (args: string) => {
      const input = args.trim()
      if (!input) {
        if (connectedSessionID) {
          const allShared = readAllSharedSessions()
          const info = allShared.find((s) => s.sessionID === connectedSessionID)
          const t = getSession(connectedSessionID)
          const status = info?.status === "busy" ? "🔄 Running" : "✅ Idle"
          const project = info?.projectName ? ` [${escapeHtml(info.projectName)}]` : ""
          const toolLine = (t?.activeTool || info?.activeTool)
            ? `\n🔧 <code>${escapeHtml((t?.activeTool || info?.activeTool)!.tool)}</code>`
            : ""
          const text = t ? getBestText(t) : ""
          const preview = text.length > 0
            ? `\n\n${markdownToTelegramHtml(truncate(text, 2000))}`
            : ""
          const todoText = await fetchAndFormatTodos(client, connectedSessionID)
          const todoSection = todoText.length > 0 ? `\n\n${todoText}` : ""
          let questionSection = ""
          let pq: PendingQuestion | null = await fetchPendingQuestions(connectedSessionID)
          if (!pq) {
            const shared = readSharedPendingQuestion()
            if (shared && shared.sessionID === connectedSessionID) pq = shared
          }
          if (pq) {
            pendingQuestion = pq
            const q = pq.questions[0]
            const opts = q.options.map((opt, i) => {
              const desc = opt.description ? ` — ${escapeHtml(opt.description)}` : ""
              return `<b>a${i + 1}.</b> ${escapeHtml(opt.label)}${desc}`
            }).join("\n")
            questionSection = `\n\n❓ <b>Pending Question</b>\n<b>${escapeHtml(q.header)}</b>\n${escapeHtml(q.question)}${opts ? `\n${opts}` : ""}\n${q.custom !== false ? "💬 Reply with a1, a2… or <code>a: your answer</code>" : "💬 Reply with a1, a2…"}`
          }
          return `📍 <b>${escapeHtml(connectedSessionTitle || "Untitled")}</b>${project}\n${status}${toolLine}${preview}${todoSection}${questionSection}`
        }
        return "Not connected. Use /sessions and reply with a number."
      }

      let targetID: string | null = null
      let targetTitle = "Untitled"

      const num = parseInt(input, 10)
      if (!isNaN(num) && num >= 1 && num <= sessionListCache.length) {
        const s = sessionListCache[num - 1]
        targetID = s.id
        targetTitle = s.title || "Untitled"
      }

      if (!targetID) {
        try {
          const listResp = await client.session.list()
          const sessions = listResp.data ?? []
          const match = sessions.find((s: any) => s.id.startsWith(input))
          if (match) {
            targetID = match.id
            targetTitle = match.title || "Untitled"
          }
        } catch {}
      }

      if (!targetID) {
        return "❌ Session not found. Use /sessions to see available sessions."
      }

      clearStreamingState()
      connectedSessionID = targetID
      connectedSessionTitle = targetTitle

      const lines: string[] = []

      const allShared = readAllSharedSessions()
      const sharedInfo = allShared.find((s) => s.sessionID === targetID)
      const tracked = getSession(targetID)

      const statusLabel = sharedInfo?.status === "busy" ? "🔄 Running" : "✅ Idle"
      const project = sharedInfo?.projectName
        ? ` [${escapeHtml(sharedInfo.projectName)}]`
        : ""
      lines.push(`📍 <b>${escapeHtml(targetTitle)}</b>${project}`)
      lines.push(statusLabel)

      const activeTool = tracked?.activeTool || sharedInfo?.activeTool
      if (activeTool) {
        const elapsed = Math.round((Date.now() - activeTool.startedAt) / 1000)
        lines.push(`🔧 <code>${escapeHtml(activeTool.tool)}</code> (${elapsed}s)`)
      }

      const todoText = await fetchAndFormatTodos(client, targetID)
      if (todoText.length > 0) {
        lines.push(`\n${todoText}`)
        lastSentTodoHash = getTodoHash(targetID)
      }

      const trackedText = tracked ? getBestText(tracked) : ""
      if (trackedText.length > 0) {
        lines.push(`\n${markdownToTelegramHtml(truncate(trackedText, 2000))}`)
      } else {
        const output = await fetchSessionOutput(client, targetID)
        if (output.text.length > 0) {
          lines.push(`\n${markdownToTelegramHtml(truncate(output.text, 2000))}`)
        } else {
          lines.push(`\n<i>No output yet</i>`)
        }
      }

      lines.push(`\n💬 Type to send — /stop to abort`)

      let pq: PendingQuestion | null = await fetchPendingQuestions(targetID)
      if (!pq) {
        const shared = readSharedPendingQuestion()
        if (shared && shared.sessionID === targetID) pq = shared
      }
      if (pq) {
        pendingQuestion = pq
        const q = pq.questions[0]
        lines.push(`\n❓ <b>Pending Question</b>`)
        lines.push(`<b>${escapeHtml(q.header)}</b>`)
        lines.push(escapeHtml(q.question))
        if (q.options.length > 0) {
          for (let i = 0; i < q.options.length; i++) {
            const opt = q.options[i]
            const desc = opt.description ? ` — ${escapeHtml(opt.description)}` : ""
            lines.push(`<b>a${i + 1}.</b> ${escapeHtml(opt.label)}${desc}`)
          }
        }
        lines.push(q.custom !== false ? `\n💬 Reply with a1, a2… or <code>a: your answer</code>` : `\n💬 Reply with a1, a2…`)
      }

      return lines.join("\n")
    },

    disconnect: async () => {
      if (!connectedSessionID) {
        return "Not connected to any session."
      }
      clearStreamingState()
      const title = connectedSessionTitle
      connectedSessionID = null
      connectedSessionTitle = null
      return `Disconnected from <b>${escapeHtml(title || "Untitled")}</b>`
    },

    new: async (args: string) => {
      if (!args.trim()) {
        return "Usage: /new <i>message</i> — start a new session"
      }

      try {
        const createResp = await client.session.create({})
        const newSession = createResp.data
        if (!newSession?.id) {
          return "❌ Failed to create session"
        }

        connectedSessionID = newSession.id
        connectedSessionTitle = "New session"

        void client.session.prompt({
          path: { id: newSession.id },
          body: buildPromptBody(args.trim()),
        }).catch(() => {})

        return `🆕 New session — auto-connected\n\n📨 <i>${escapeHtml(truncate(args.trim(), 200))}</i>\n\nJust type to continue.`
      } catch (e: any) {
        return `❌ Failed: ${escapeHtml(String(e?.message || e).slice(0, 200))}`
      }
    },

    stop: async () => {
      if (!connectedSessionID) {
        return "Not connected. Use /sessions to pick a session first."
      }
      try {
        await client.session.abort({ path: { id: connectedSessionID } })
        clearStreamingState()
        return `⏹ Stopped: <b>${escapeHtml(connectedSessionTitle || "Untitled")}</b>`
      } catch {
        return "❌ Failed to stop session"
      }
    },

    cancel: async () => {
      const busy = getBusySessions()
      if (busy.length === 0) {
        return "💤 Nothing to cancel — no active sessions"
      }

      const results: string[] = []
      for (const session of busy) {
        try {
          await client.session.abort({ path: { id: session.sessionID } })
          const title = session.title ? escapeHtml(session.title) : session.sessionID.slice(0, 8)
          results.push(`⏹ Cancelled: <b>${title}</b>`)
        } catch {
          results.push(`❌ Failed to cancel: ${escapeHtml(session.sessionID.slice(0, 8))}`)
        }
      }

      return results.join("\n")
    },

    todos: async () => {
      if (!connectedSessionID) {
        return "Not connected"
      }
      const todoText = await fetchAndFormatTodos(client, connectedSessionID)
      if (todoText.length === 0) {
        return "📋 <b>Tasks</b>\nNo tasks yet"
      }
      return todoText
    },

    help: async () => {
      const connected = connectedSessionID
        ? `\n📍 Connected: <b>${escapeHtml(connectedSessionTitle || "Untitled")}</b>\n`
        : "\n<i>Not connected — use /sessions to pick one</i>\n"

      return [
        "🤖 <b>OpenCode Remote</b>",
        connected,
        "<b>Chat</b>",
        "1. /sessions — pick a session",
        "2. Reply with a number to connect",
        "3. Just type — messages go to that session",
        "/new <i>msg</i> — Start fresh session",
        "/disconnect — Stop sending\n",
        "<b>Monitor</b>",
        "/status — What's happening now",
        "/todos — Show tracked tasks",
        "/stop — Abort connected session",
        "/cancel — Abort all active sessions\n",
        "<b>Settings</b>",
        "/mute · /unmute — Toggle notifications",
      ].join("\n")
    },
  }
}

export function parseCommand(text: string): { command: string; args: string } | null {
  const match = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s)
  if (!match) return null
  return { command: match[1], args: match[2].trim() }
}

function startPolling(
  config: TelegramConfig,
  handlers: Record<string, CommandHandler>,
  client: PluginInput["client"]
): { stop: () => void } {
  let running = true
  let offset = 0

  const poll = async () => {
    while (running) {
      try {
        const result = (await telegramApiCall(config.botToken, "getUpdates", {
          offset,
          timeout: 30,
          allowed_updates: ["message"],
        })) as { ok: boolean; result: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }> }

        if (!result.ok || !result.result) continue

        for (const update of result.result) {
          offset = update.update_id + 1

          const msg = update.message
          if (!msg?.text) continue
          if (String(msg.chat.id) !== config.chatId) continue

          const parsed = parseCommand(msg.text)

          if (parsed) {
            if (parsed.command === "stop") {
              if (!connectedSessionID) {
                await telegramApiCall(config.botToken, "sendMessage", {
                  chat_id: config.chatId,
                  text: "Not connected. Use /sessions to pick a session first.",
                }).catch(() => {})
                continue
              }

              if (isLocalSession(connectedSessionID)) {
                try {
                  await client.session.abort({ path: { id: connectedSessionID } })
                  clearStreamingState()
                  await telegramApiCall(config.botToken, "sendMessage", {
                    chat_id: config.chatId,
                    text: `⏹ Stopped: <b>${escapeHtml(connectedSessionTitle || "Untitled")}</b>`,
                    parse_mode: "HTML",
                  })
                } catch {
                  await telegramApiCall(config.botToken, "sendMessage", {
                    chat_id: config.chatId,
                    text: "❌ Failed to stop session",
                  }).catch(() => {})
                }
                continue
              }

              const cmdID = createCommandID()
              const remoteCmd: RemoteCommand = {
                id: cmdID,
                type: "stop",
                sessionID: connectedSessionID,
                createdAt: Date.now(),
              }
              void writeRemoteCommand(remoteCmd)
              const result = await awaitRemoteResult(cmdID)
              const message = result
                ? result.response
                : "⏱ Remote command timed out"
              await telegramApiCall(config.botToken, "sendMessage", {
                chat_id: config.chatId,
                text: message,
                parse_mode: "HTML",
              }).catch(() => {})
              continue
            }

            if (parsed.command === "cancel") {
              const busy = getBusySessions()
              const localResults: string[] = []
              for (const session of busy) {
                try {
                  await client.session.abort({ path: { id: session.sessionID } })
                  const title = session.title ? escapeHtml(session.title) : session.sessionID.slice(0, 8)
                  localResults.push(`⏹ Cancelled: <b>${title}</b>`)
                } catch {
                  localResults.push(`❌ Failed to cancel: ${escapeHtml(session.sessionID.slice(0, 8))}`)
                }
              }

              const cmdID = createCommandID()
              const remoteCmd: RemoteCommand = {
                id: cmdID,
                type: "cancel",
                createdAt: Date.now(),
              }
              void writeRemoteCommand(remoteCmd)

              const lines: string[] = []
              if (localResults.length > 0) {
                lines.push(localResults.join("\n"))
              } else {
                lines.push("💤 Nothing to cancel locally")
              }
              lines.push("📡 Broadcast cancel sent")

              await telegramApiCall(config.botToken, "sendMessage", {
                chat_id: config.chatId,
                text: lines.join("\n\n"),
                parse_mode: "HTML",
              }).catch(() => {})
              continue
            }

            const handler = handlers[parsed.command]
            if (!handler) continue

            try {
              const response = await handler(parsed.args)
              await telegramApiCall(config.botToken, "sendMessage", {
                chat_id: config.chatId,
                text: response,
                parse_mode: "HTML",
              })
            } catch {
              await telegramApiCall(config.botToken, "sendMessage", {
                chat_id: config.chatId,
                text: "❌ Command failed",
              }).catch(() => {})
            }
            continue
          }

          const text = msg.text.trim()

          const answerMatch = text.match(/^a(\d+)$/i)
          const customAnswerMatch = text.match(/^a:\s*(.+)$/is)
          if (answerMatch || customAnswerMatch) {
            if (!pendingQuestion) {
              const shared = readSharedPendingQuestion()
              if (shared) pendingQuestion = shared
            }
            if (pendingQuestion) {
              const answerText = customAnswerMatch ? customAnswerMatch[1].trim() : text
              try {
                if (isLocalSession(pendingQuestion.sessionID)) {
                  const response = await handleQuestionReply(answerText, pendingQuestion.sessionID)
                  await telegramApiCall(config.botToken, "sendMessage", {
                    chat_id: config.chatId,
                    text: response,
                    parse_mode: "HTML",
                  })
                  continue
                }

                const cmdID = createCommandID()
                const remoteCmd: RemoteCommand = {
                  id: cmdID,
                  type: "question_answer",
                  sessionID: pendingQuestion.sessionID,
                  args: { answer: answerText },
                  createdAt: Date.now(),
                }
                void writeRemoteCommand(remoteCmd)
                const result = await awaitRemoteResult(cmdID)
                const response = result
                  ? result.response
                  : "⏱ Remote command timed out"
                await telegramApiCall(config.botToken, "sendMessage", {
                  chat_id: config.chatId,
                  text: response,
                  parse_mode: "HTML",
                })
              } catch {}
              continue
            }
            await telegramApiCall(config.botToken, "sendMessage", {
              chat_id: config.chatId,
              text: "No pending question. Use /connect to check.",
            }).catch(() => {})
            continue
          }

          const asNumber = parseInt(text, 10)
          if (!isNaN(asNumber) && asNumber >= 1 && asNumber <= sessionListCache.length && text === String(asNumber)) {
            try {
              const response = await handlers.connect(text)
              await telegramApiCall(config.botToken, "sendMessage", {
                chat_id: config.chatId,
                text: response,
                parse_mode: "HTML",
              })
            } catch {}
            continue
          }

          if (connectedSessionID && text.length > 0) {
            try {
              if (isLocalSession(connectedSessionID)) {
                void client.session.prompt({
                  path: { id: connectedSessionID },
                  body: buildPromptBody(text),
                }).catch(() => {})
              } else {
                const cmdID = createCommandID()
                const remoteCmd: RemoteCommand = {
                  id: cmdID,
                  type: "prompt",
                  sessionID: connectedSessionID,
                  args: { text },
                  createdAt: Date.now(),
                }
                void writeRemoteCommand(remoteCmd)
                const result = await awaitRemoteResult(cmdID)
                if (!result) {
                  await telegramApiCall(config.botToken, "sendMessage", {
                    chat_id: config.chatId,
                    text: "⏱ Remote command timed out",
                    parse_mode: "HTML",
                  }).catch(() => {})
                  continue
                }
                if (!result.ok) {
                  await telegramApiCall(config.botToken, "sendMessage", {
                    chat_id: config.chatId,
                    text: result.response,
                    parse_mode: "HTML",
                  }).catch(() => {})
                  continue
                }
              }
              await telegramApiCall(config.botToken, "sendMessage", {
                chat_id: config.chatId,
                text: `📨 <i>${escapeHtml(truncate(text, 100))}</i>`,
                parse_mode: "HTML",
              })
            } catch {
              await telegramApiCall(config.botToken, "sendMessage", {
                chat_id: config.chatId,
                text: "❌ Failed to send. Session may have ended.\nUse /sessions to reconnect.",
                parse_mode: "HTML",
              }).catch(() => {})
            }
            continue
          }

          if (!connectedSessionID && text.length > 0) {
            await telegramApiCall(config.botToken, "sendMessage", {
              chat_id: config.chatId,
              text: "Not connected to a session.\nUse /sessions and pick one first.",
              parse_mode: "HTML",
            }).catch(() => {})
          }
        }
      } catch {
        if (running) {
          await new Promise((resolve) => setTimeout(resolve, 5000))
        }
      }
    }
  }

  void poll()

  return {
    stop: () => {
      running = false
    },
  }
}

export function isMuted(): boolean {
  return muted
}

export async function createTelegramBot(
  config: NotifierConfig,
  client: PluginInput["client"],
): Promise<TelegramBot | null> {
  const telegramConfig = config.telegram

  if (!telegramConfig.enabled || !telegramConfig.botToken || !telegramConfig.chatId) {
    return null
  }

  upstashLockConfig = isUpstashConfigured(config) && config.upstash ? config.upstash : null

  storedBotToken = telegramConfig.botToken
  storedChatId = telegramConfig.chatId
  storedClient = client

  if (isUpstashConfigured(config)) {
    startSSESubscription(handleSSEMessage)
  }

  const isPoller = await acquirePollLock()
  let poller: { stop: () => void } | null = null

  if (isPoller) {
    const handlers = buildCommandHandlers(client)
    poller = startPolling(telegramConfig, handlers, client)

    const asyncCleanup = async () => { stopSSESubscription(); await Promise.all([releasePollLock(), cleanupSharedState()]) }
    process.on("exit", () => { stopPollLockRefresh(); try { if (existsSync(LOCK_PATH)) { const pid = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10); if (pid === process.pid) unlinkSync(LOCK_PATH) } } catch {}; try { unlinkSync(join(homedir(), ".config", "opencode", "notifier", `${process.pid}.json`)) } catch {} })
    process.on("SIGINT", () => { asyncCleanup().finally(() => process.exit(0)) })
    process.on("SIGTERM", () => { asyncCleanup().finally(() => process.exit(0)) })
  } else {
    const asyncCleanup = async () => { stopSSESubscription(); await cleanupSharedState() }
    process.on("SIGINT", () => { asyncCleanup().finally(() => process.exit(0)) })
    process.on("SIGTERM", () => { asyncCleanup().finally(() => process.exit(0)) })
  }

  return {
    async sendMessage(text: string): Promise<void> {
      if (muted) return

      try {
        await telegramApiCall(telegramConfig.botToken, "sendMessage", {
          chat_id: telegramConfig.chatId,
          text,
          parse_mode: "HTML",
        })
      } catch {
      }
    },

    async sendCompletionSummary(sessionID: string, eventType: string, projectName: string | null): Promise<void> {
      if (muted) return

      try {
        const summary = await buildCompletionSummary(client, sessionID, eventType, projectName)
        await telegramApiCall(telegramConfig.botToken, "sendMessage", {
          chat_id: telegramConfig.chatId,
          text: summary,
          parse_mode: "HTML",
        })
      } catch {
      }
    },

    async stop() {
      clearStreamingState()
      stopSSESubscription()
      if (poller) poller.stop()
      if (isPoller) await releasePollLock()
    },
  }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remainMins = mins % 60
  return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`
}

function summarizeText(text: string, maxLen: number): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  if (cleaned.length <= maxLen) return cleaned

  const lastNewline = cleaned.lastIndexOf("\n", maxLen)
  const cutAt = lastNewline > maxLen * 0.5 ? lastNewline : maxLen
  return cleaned.slice(0, cutAt) + "…"
}

async function buildCompletionSummary(
  client: PluginInput["client"],
  sessionID: string,
  eventType: string,
  projectName: string | null
): Promise<string> {
  const eventEmoji: Record<string, string> = {
    complete: "✅",
    subagent_complete: "🔗",
    error: "❌",
    question: "❓",
    interrupted: "⏹",
    permission: "🔐",
  }
  let emoji = eventEmoji[eventType] ?? "📢"

  let title = "Untitled"
  let duration = ""
  let diffSummary = ""

  try {
    const resp = await client.session.get({ path: { id: sessionID } })
    const session = resp.data
    if (session?.title) title = session.title
    if (session?.time?.created) {
      const elapsed = (Date.now() - session.time.created) / 1000
      duration = ` (${formatDuration(elapsed)})`
    }
    if (session?.summary) {
      const s = session.summary
      const parts: string[] = []
      if (s.files) parts.push(`${s.files} file${s.files > 1 ? "s" : ""}`)
      if (s.additions) parts.push(`+${s.additions}`)
      if (s.deletions) parts.push(`-${s.deletions}`)
      if (parts.length > 0) diffSummary = `\n📁 ${parts.join(" | ")}`
    }
  } catch {}

  if (eventType === "error" && diffSummary.length > 0) {
    emoji = "⚠️"
  }

  const projectTag = projectName ? `[${escapeHtml(projectName)}] ` : ""
  const lines: string[] = [
    `${emoji} ${projectTag}<b>${escapeHtml(title)}</b>${duration}`,
  ]

  if (diffSummary) lines.push(diffSummary)

  try {
    const resp = await client.session.messages({ path: { id: sessionID } })
    const messages = resp.data ?? []

    const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
    if (lastAssistant) {
      let text = ""
      const toolsUsed: string[] = []

      for (const part of lastAssistant.parts) {
        if ((part as any).type === "text" && (part as any).text) {
          text += (part as any).text
        }
        if ((part as any).type === "tool") {
          const name = (part as any).tool ?? (part as any).name
          if (name && !toolsUsed.includes(name)) {
            toolsUsed.push(name)
          }
        }
      }

      if (toolsUsed.length > 0) {
        lines.push(`\n🔧 ${toolsUsed.map((t) => escapeHtml(t)).join(", ")}`)
      }

      if (text.length > 0) {
        lines.push(`\n${markdownToTelegramHtml(truncate(text, 800))}`)
      }
    }
  } catch {}

  const tracked = getSession(sessionID)
  if (tracked && lines.length <= 2) {
    const text = getBestText(tracked)
    if (text.length > 0) {
      lines.push(`\n${markdownToTelegramHtml(truncate(text, 800))}`)
    }
  }

  return lines.join("\n")
}

export function formatEventMessage(
  eventType: string,
  message: string,
  projectName: string | null
): string {
  const eventEmoji: Record<string, string> = {
    permission: "🔐",
    complete: "✅",
    subagent_complete: "🔗",
    error: "❌",
    question: "❓",
    interrupted: "⏹",
  }

  const emoji = eventEmoji[eventType] ?? "📢"
  const project = projectName ? ` <i>${escapeHtml(projectName)}</i>` : ""
  const safeMessage = escapeHtml(message)

  return `${emoji} <b>${escapeHtml(eventType)}</b>${project}\n${safeMessage}`
}
