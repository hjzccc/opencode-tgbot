import { writeFileSync, readFileSync, unlinkSync, readdirSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir, hostname } from "os"

export type TrackedSessionStatus = "idle" | "busy" | "error"

export interface TrackedTool {
  tool: string
  callID: string
  status: "pending" | "running" | "completed" | "error"
  title?: string
  startedAt: number
}

export interface TrackedSession {
  sessionID: string
  projectName: string | null
  title: string | null
  status: TrackedSessionStatus
  streamingText: string
  lastFullText: string
  activeTool: TrackedTool | null
  todos: Array<{ content: string; status: string; priority: string; id: string }>
  lastActivityAt: number
}

export interface SharedSessionInfo {
  sessionID: string
  projectName: string | null
  title: string | null
  status: TrackedSessionStatus
  activeTool: { tool: string; startedAt: number } | null
  todos?: Array<{ content: string; status: string; priority: string }>
  lastActivityAt: number
  owner?: string
}

export interface InstanceGroup {
  hostname: string
  isLocal: boolean
  sessions: SharedSessionInfo[]
}

const sessions = new Map<string, TrackedSession>()

const MAX_STREAMING_TEXT = 4000
const STALE_SESSION_MS = 10 * 60 * 1000

const SHARED_STATE_DIR = join(homedir(), ".config", "opencode", "notifier")
let sharedStateTimer: ReturnType<typeof setTimeout> | null = null
export const INSTANCE_KEY = `${hostname()}:${process.pid}`
const SESSION_KEY = `sessions:${INSTANCE_KEY}`

export interface RemoteCommand {
  id: string
  type: "prompt" | "stop" | "cancel" | "new" | "question_answer"
  sessionID?: string
  args?: any
  createdAt: number
}

export interface CommandResult {
  id: string
  response: string
  ok: boolean
}

let upstashConfig: { url: string; token: string } | null = null
let upstashSessionsCache: { groups: Map<string, SharedSessionInfo[]>; expiresAt: number } | null = null
let upstashSessionsRefreshPromise: Promise<void> | null = null

export function initUpstash(config: { url: string; token: string }): void {
  upstashConfig = config
}

export async function upstashCommand(
  url: string,
  token: string,
  command: string[]
): Promise<any> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    })
    if (!response.ok) return null
    const data = await response.json().catch(() => null)
    return data?.result
  } catch {
    return null
  }
}

let fullSessionList: SharedSessionInfo[] = []

export function setFullSessionList(sessions: SharedSessionInfo[]): void {
  fullSessionList = sessions
  scheduleSharedStateWrite()
}

function writeSharedStateNow(): void {
  const trackedSessions = Array.from(sessions.values()).map((s) => ({
    sessionID: s.sessionID,
    projectName: s.projectName,
    title: s.title,
    status: s.status,
    activeTool: s.activeTool
      ? { tool: s.activeTool.tool, startedAt: s.activeTool.startedAt }
      : null,
    todos: s.todos.map((todo) => ({
      content: todo.content,
      status: todo.status,
      priority: todo.priority,
    })),
    lastActivityAt: s.lastActivityAt,
    owner: INSTANCE_KEY,
  }))

  const trackedIDs = new Set(trackedSessions.map((s) => s.sessionID))
  const merged = [
    ...trackedSessions,
    ...fullSessionList.filter((s) => !trackedIDs.has(s.sessionID)),
  ]

  const data = {
    pid: process.pid,
    sessions: merged,
    updatedAt: Date.now(),
  }
  try {
    mkdirSync(SHARED_STATE_DIR, { recursive: true })
    writeFileSync(
      join(SHARED_STATE_DIR, `${process.pid}.json`),
      JSON.stringify(data),
      "utf-8"
    )
  } catch {}

  if (upstashConfig) {
    void upstashCommand(
      upstashConfig.url,
      upstashConfig.token,
      ["SET", SESSION_KEY, JSON.stringify(data), "EX", "60"]
    ).catch(() => {})
  }
}

function scheduleSharedStateWrite(): void {
  if (sharedStateTimer) return
  sharedStateTimer = setTimeout(() => {
    sharedStateTimer = null
    writeSharedStateNow()
  }, 2000)
}

export function readAllSharedSessions(): SharedSessionInfo[] {
  const groups = readGroupedSessions()
  const best = new Map<string, SharedSessionInfo>()
  for (const group of groups) {
    for (const session of group.sessions) {
      upsertPreferredSession(best, session)
    }
  }
  return Array.from(best.values())
}

export function readGroupedSessions(): InstanceGroup[] {
  const localHostname = hostname()
  const groups = new Map<string, SharedSessionInfo[]>()

  const localSessions = readLocalSharedSessions()
  if (localSessions.length > 0) {
    groups.set(localHostname, localSessions)
  }

  if (upstashConfig) {
    if (!upstashSessionsCache || Date.now() > upstashSessionsCache.expiresAt) {
      refreshUpstashSessionsCache()
    }
    if (upstashSessionsCache) {
      for (const [host, sessions] of upstashSessionsCache.groups) {
        if (host === localHostname) {
          const existing = groups.get(host) ?? []
          const best = new Map<string, SharedSessionInfo>()
          for (const s of existing) upsertPreferredSession(best, s)
          for (const s of sessions) upsertPreferredSession(best, s)
          groups.set(host, Array.from(best.values()))
        } else {
          groups.set(host, sessions)
        }
      }
    }
  }

  return Array.from(groups.entries()).map(([host, sessions]) => ({
    hostname: host,
    isLocal: host === localHostname,
    sessions,
  }))
}

function readLocalSharedSessions(): SharedSessionInfo[] {
  const best = new Map<string, SharedSessionInfo>()
  try {
    const files = readdirSync(SHARED_STATE_DIR).filter((f) => f.endsWith(".json"))
    for (const file of files) {
      try {
        const content = readFileSync(join(SHARED_STATE_DIR, file), "utf-8")
        const data = JSON.parse(content) as {
          pid: number
          sessions: SharedSessionInfo[]
          updatedAt: number
        }
        try {
          process.kill(data.pid, 0)
        } catch {
          try { unlinkSync(join(SHARED_STATE_DIR, file)) } catch {}
          continue
        }
        if (Date.now() - data.updatedAt > 10 * 60 * 1000) continue
        for (const s of data.sessions) {
          upsertPreferredSession(best, s)
        }
      } catch {}
    }
  } catch {}
  return Array.from(best.values())
}

function refreshUpstashSessionsCache(): void {
  if (!upstashConfig || upstashSessionsRefreshPromise) return
  upstashSessionsRefreshPromise = (async () => {
    const keysResult = await upstashCommand(upstashConfig.url, upstashConfig.token, ["KEYS", "sessions:*"])
    const keys = Array.isArray(keysResult)
      ? keysResult.filter((key): key is string => typeof key === "string" && key.length > 0)
      : []
    if (keys.length === 0) {
      upstashSessionsCache = { groups: new Map(), expiresAt: Date.now() + 3000 }
      return
    }

    const values = await upstashCommand(upstashConfig.url, upstashConfig.token, ["MGET", ...keys])
    if (!Array.isArray(values)) {
      upstashSessionsCache = { groups: upstashSessionsCache?.groups ?? new Map(), expiresAt: Date.now() + 3000 }
      return
    }

    const grouped = new Map<string, Map<string, SharedSessionInfo>>()
    for (let i = 0; i < keys.length; i++) {
      const raw = values[i]
      if (typeof raw !== "string") continue
      const key = keys[i]
      const hostMatch = key.match(/^sessions:(.+?):\d+$/)
      const host = hostMatch?.[1] ?? "unknown"
      try {
        const data = JSON.parse(raw) as {
          sessions?: SharedSessionInfo[]
          updatedAt?: number
        }
        if (!Array.isArray(data.sessions)) continue
        if (Date.now() - (data.updatedAt ?? 0) > STALE_SESSION_MS) continue
        if (!grouped.has(host)) grouped.set(host, new Map())
        const best = grouped.get(host)!
        for (const session of data.sessions) {
          upsertPreferredSession(best, session)
        }
      } catch {}
    }

    const result = new Map<string, SharedSessionInfo[]>()
    for (const [host, best] of grouped) {
      result.set(host, Array.from(best.values()))
    }
    upstashSessionsCache = { groups: result, expiresAt: Date.now() + 3000 }
  })()
    .catch(() => {})
    .finally(() => {
      upstashSessionsRefreshPromise = null
    })
}

function upsertPreferredSession(best: Map<string, SharedSessionInfo>, next: SharedSessionInfo): void {
  const existing = best.get(next.sessionID)
  if (!existing) {
    best.set(next.sessionID, next)
    return
  }
  const prefer =
    (next.projectName && !existing.projectName) ||
    (next.status === "busy" && existing.status !== "busy") ||
    (next.status === existing.status && next.lastActivityAt > existing.lastActivityAt)
  if (prefer) best.set(next.sessionID, next)
}

function mergeSharedSessions(
  localSessions: SharedSessionInfo[],
  remoteSessions: SharedSessionInfo[]
): SharedSessionInfo[] {
  const best = new Map<string, SharedSessionInfo>()
  for (const session of localSessions) {
    upsertPreferredSession(best, session)
  }
  for (const session of remoteSessions) {
    upsertPreferredSession(best, session)
  }
  return Array.from(best.values())
}

export async function cleanupSharedState(): Promise<void> {
  try {
    unlinkSync(join(SHARED_STATE_DIR, `${process.pid}.json`))
  } catch {}
  if (upstashConfig) {
    try {
      await upstashCommand(upstashConfig.url, upstashConfig.token, ["DEL", SESSION_KEY])
    } catch {}
  }
}

function getOrCreateSession(sessionID: string): TrackedSession {
  let session = sessions.get(sessionID)
  if (!session) {
    session = {
      sessionID,
      projectName: null,
      title: null,
      status: "idle",
      streamingText: "",
      lastFullText: "",
      activeTool: null,
      todos: [],
      lastActivityAt: Date.now(),
    }
    sessions.set(sessionID, session)
  }
  return session
}

export function trackSessionStatus(sessionID: string, status: TrackedSessionStatus): void {
  const session = getOrCreateSession(sessionID)
  session.status = status
  session.lastActivityAt = Date.now()

  if (status === "busy") {
    session.streamingText = ""
    session.lastFullText = ""
    session.activeTool = null
  }
  scheduleSharedStateWrite()
}

export function trackSessionProject(sessionID: string, projectName: string): void {
  const session = getOrCreateSession(sessionID)
  session.projectName = projectName
  scheduleSharedStateWrite()
}

export function trackSessionTitle(sessionID: string, title: string): void {
  const session = getOrCreateSession(sessionID)
  session.title = title
  session.lastActivityAt = Date.now()
  scheduleSharedStateWrite()
}

export function trackStreamingDelta(sessionID: string, delta: string): void {
  const session = getOrCreateSession(sessionID)
  session.streamingText += delta
  session.lastActivityAt = Date.now()

  if (session.streamingText.length > MAX_STREAMING_TEXT) {
    session.streamingText = session.streamingText.slice(-MAX_STREAMING_TEXT)
  }
}

export function trackFullText(sessionID: string, text: string): void {
  const session = getOrCreateSession(sessionID)
  session.lastFullText = text
  session.lastActivityAt = Date.now()

  if (session.lastFullText.length > MAX_STREAMING_TEXT) {
    session.lastFullText = session.lastFullText.slice(-MAX_STREAMING_TEXT)
  }
}

export function trackToolState(
  sessionID: string,
  tool: string,
  callID: string,
  status: "pending" | "running" | "completed" | "error",
  title?: string,
  startedAt?: number
): void {
  const session = getOrCreateSession(sessionID)
  session.lastActivityAt = Date.now()

  if (status === "pending" || status === "running") {
    session.activeTool = {
      tool,
      callID,
      status,
      title,
      startedAt: typeof startedAt === "number" ? startedAt : Date.now(),
    }
  } else if (session.activeTool?.callID === callID) {
    session.activeTool = null
  }
  scheduleSharedStateWrite()
}

export function trackTodos(
  sessionID: string,
  todos: Array<{ content: string; status: string; priority: string; id: string }>
): void {
  const session = getOrCreateSession(sessionID)
  session.todos = todos
  session.lastActivityAt = Date.now()
  scheduleSharedStateWrite()
}

export function getSession(sessionID: string): TrackedSession | undefined {
  return sessions.get(sessionID)
}

export function isLocalSession(sessionID: string): boolean {
  return sessions.has(sessionID)
}

export function getAllSessions(): TrackedSession[] {
  return Array.from(sessions.values())
}

export function getBusySessions(): TrackedSession[] {
  return Array.from(sessions.values()).filter((s) => s.status === "busy")
}

export function cleanupStaleSessions(): void {
  const cutoff = Date.now() - STALE_SESSION_MS
  for (const [id, session] of sessions) {
    if (session.status === "idle" && session.lastActivityAt < cutoff) {
      sessions.delete(id)
    }
  }
}

const PENDING_QUESTION_PATH = join(SHARED_STATE_DIR, "pending-question.json")

export interface SharedPendingQuestion {
  requestID: string
  sessionID: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
  createdAt: number
}

export function writeSharedPendingQuestion(question: SharedPendingQuestion): void {
  try {
    mkdirSync(SHARED_STATE_DIR, { recursive: true })
    writeFileSync(PENDING_QUESTION_PATH, JSON.stringify(question))
  } catch {}
  if (upstashConfig) {
    void upstashCommand(
      upstashConfig.url,
      upstashConfig.token,
      ["SET", "question:pending", JSON.stringify(question), "EX", "300"]
    ).catch(() => {})
  }
}

export function readSharedPendingQuestion(): SharedPendingQuestion | null {
  if (upstashConfig) {
    refreshSharedPendingQuestionCache()
    const cached = sharedPendingQuestionCache
    if (cached !== undefined) {
      return cached
    }
  }

  return readSharedPendingQuestionFromFile()
}

let sharedPendingQuestionCache: SharedPendingQuestion | null | undefined
let sharedPendingQuestionCacheAt = 0
let sharedPendingQuestionRefreshPromise: Promise<void> | null = null

function refreshSharedPendingQuestionCache(): void {
  if (!upstashConfig || sharedPendingQuestionRefreshPromise) return
  if (Date.now() - sharedPendingQuestionCacheAt < 3000) return

  sharedPendingQuestionRefreshPromise = (async () => {
    const raw = await upstashCommand(upstashConfig.url, upstashConfig.token, ["GET", "question:pending"])
    sharedPendingQuestionCacheAt = Date.now()
    if (typeof raw !== "string") {
      sharedPendingQuestionCache = readSharedPendingQuestionFromFile()
      return
    }

    try {
      const parsed = JSON.parse(raw)
      const question = normalizeSharedPendingQuestion(parsed)
      sharedPendingQuestionCache = question ?? readSharedPendingQuestionFromFile()
    } catch {
      sharedPendingQuestionCache = readSharedPendingQuestionFromFile()
    }
  })()
    .catch(() => {})
    .finally(() => {
      sharedPendingQuestionRefreshPromise = null
    })
}

function normalizeSharedPendingQuestion(parsed: any): SharedPendingQuestion | null {
  if (!parsed?.requestID || !parsed?.questions) return null
  if (Date.now() - (parsed.createdAt ?? 0) > 5 * 60 * 1000) return null
  return parsed as SharedPendingQuestion
}

function readSharedPendingQuestionFromFile(): SharedPendingQuestion | null {
  try {
    const raw = readFileSync(PENDING_QUESTION_PATH, "utf-8")
    const parsed = JSON.parse(raw)
    const question = normalizeSharedPendingQuestion(parsed)
    if (!question) {
      clearSharedPendingQuestion()
      return null
    }
    return question
  } catch {
    return null
  }
}

export function clearSharedPendingQuestion(): void {
  try { unlinkSync(PENDING_QUESTION_PATH) } catch {}
  sharedPendingQuestionCache = null
  sharedPendingQuestionCacheAt = Date.now()
  if (upstashConfig) {
    void upstashCommand(upstashConfig.url, upstashConfig.token, ["DEL", "question:pending"]).catch(() => {})
  }
}

export async function writeRemoteCommand(cmd: RemoteCommand): Promise<void> {
  if (!upstashConfig) return
  try {
    await upstashCommand(upstashConfig.url, upstashConfig.token, [
      "SET",
      `cmd:${cmd.id}`,
      JSON.stringify(cmd),
      "EX",
      "30",
    ])
  } catch {}
}

export async function readPendingCommands(): Promise<RemoteCommand[]> {
  if (!upstashConfig) return []
  try {
    const keysResult = await upstashCommand(upstashConfig.url, upstashConfig.token, ["KEYS", "cmd:*"])
    const keys = Array.isArray(keysResult)
      ? keysResult.filter(
          (key): key is string =>
            typeof key === "string" && key.length > 0 && !key.endsWith(":claimed")
        )
      : []
    if (keys.length === 0) return []

    const values = await upstashCommand(upstashConfig.url, upstashConfig.token, ["MGET", ...keys])
    if (!Array.isArray(values)) return []

    const commands: RemoteCommand[] = []
    for (const raw of values) {
      if (typeof raw !== "string") continue
      try {
        const parsed = JSON.parse(raw) as RemoteCommand
        if (typeof parsed?.id === "string" && typeof parsed?.type === "string") {
          commands.push(parsed)
        }
      } catch {}
    }
    return commands
  } catch {
    return []
  }
}

export async function claimCommand(cmdID: string): Promise<boolean> {
  if (!upstashConfig) return false
  try {
    const result = await upstashCommand(upstashConfig.url, upstashConfig.token, [
      "SET",
      `cmd:${cmdID}:claimed`,
      INSTANCE_KEY,
      "NX",
      "EX",
      "30",
    ])
    return result === "OK"
  } catch {
    return false
  }
}

export async function writeCommandResult(result: CommandResult): Promise<void> {
  if (!upstashConfig) return
  try {
    await upstashCommand(upstashConfig.url, upstashConfig.token, [
      "SET",
      `result:${result.id}`,
      JSON.stringify(result),
      "EX",
      "60",
    ])
  } catch {}
}

export async function readCommandResult(cmdID: string): Promise<CommandResult | null> {
  if (!upstashConfig) return null
  try {
    const raw = await upstashCommand(upstashConfig.url, upstashConfig.token, ["GET", `result:${cmdID}`])
    if (typeof raw !== "string") return null
    const parsed = JSON.parse(raw) as CommandResult
    if (
      typeof parsed?.id !== "string" ||
      typeof parsed?.response !== "string" ||
      typeof parsed?.ok !== "boolean"
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function deleteCommand(cmdID: string): Promise<void> {
  if (!upstashConfig) return
  try {
    await upstashCommand(upstashConfig.url, upstashConfig.token, ["DEL", `cmd:${cmdID}`])
  } catch {}
}
