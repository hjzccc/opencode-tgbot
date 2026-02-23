import { writeFileSync, readFileSync, unlinkSync, readdirSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

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
}

const sessions = new Map<string, TrackedSession>()

const MAX_STREAMING_TEXT = 4000
const STALE_SESSION_MS = 10 * 60 * 1000

const SHARED_STATE_DIR = join(homedir(), ".config", "opencode", "notifier")
let sharedStateTimer: ReturnType<typeof setTimeout> | null = null

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
}

function scheduleSharedStateWrite(): void {
  if (sharedStateTimer) return
  sharedStateTimer = setTimeout(() => {
    sharedStateTimer = null
    writeSharedStateNow()
  }, 2000)
}

export function readAllSharedSessions(): SharedSessionInfo[] {
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
          const existing = best.get(s.sessionID)
          if (!existing) {
            best.set(s.sessionID, s)
            continue
          }
          const prefer =
            (s.projectName && !existing.projectName) ||
            (s.status === "busy" && existing.status !== "busy") ||
            (s.status === existing.status && s.lastActivityAt > existing.lastActivityAt)
          if (prefer) best.set(s.sessionID, s)
        }
      } catch {}
    }
  } catch {}
  return Array.from(best.values())
}

export function cleanupSharedState(): void {
  try {
    unlinkSync(join(SHARED_STATE_DIR, `${process.pid}.json`))
  } catch {}
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
}

export function readSharedPendingQuestion(): SharedPendingQuestion | null {
  try {
    const raw = readFileSync(PENDING_QUESTION_PATH, "utf-8")
    const parsed = JSON.parse(raw)
    if (!parsed?.requestID || !parsed?.questions) return null
    if (Date.now() - (parsed.createdAt ?? 0) > 5 * 60 * 1000) {
      clearSharedPendingQuestion()
      return null
    }
    return parsed as SharedPendingQuestion
  } catch {
    return null
  }
}

export function clearSharedPendingQuestion(): void {
  try { unlinkSync(PENDING_QUESTION_PATH) } catch {}
}
