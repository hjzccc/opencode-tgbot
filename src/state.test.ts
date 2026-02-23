import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir, homedir } from "os"
import {
  trackSessionStatus,
  trackSessionProject,
  trackSessionTitle,
  trackStreamingDelta,
  trackFullText,
  trackToolState,
  trackTodos,
  getSession,
  getAllSessions,
  getBusySessions,
  cleanupStaleSessions,
  writeSharedPendingQuestion,
  readSharedPendingQuestion,
  clearSharedPendingQuestion,
  type SharedPendingQuestion,
} from "./state"

const SHARED_STATE_DIR = join(homedir(), ".config", "opencode", "notifier")
const PENDING_QUESTION_PATH = join(SHARED_STATE_DIR, "pending-question.json")

describe("state", () => {
  describe("session tracking", () => {
    const sid = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`

    test("creates session on first track and sets status", () => {
      trackSessionStatus(sid, "busy")
      const session = getSession(sid)
      expect(session).toBeDefined()
      expect(session!.status).toBe("busy")
      expect(session!.sessionID).toBe(sid)
    })

    test("resets streaming text when status changes to busy", () => {
      const s = `reset-stream-${Date.now()}`
      trackSessionStatus(s, "idle")
      trackStreamingDelta(s, "some text")
      trackFullText(s, "full text")

      trackSessionStatus(s, "busy")
      const session = getSession(s)
      expect(session!.streamingText).toBe("")
      expect(session!.lastFullText).toBe("")
      expect(session!.activeTool).toBeNull()
    })

    test("tracks project name", () => {
      const s = `proj-${Date.now()}`
      trackSessionProject(s, "my-project")
      const session = getSession(s)
      expect(session!.projectName).toBe("my-project")
    })

    test("tracks title", () => {
      const s = `title-${Date.now()}`
      trackSessionTitle(s, "Fix the login bug")
      const session = getSession(s)
      expect(session!.title).toBe("Fix the login bug")
    })

    test("appends streaming delta", () => {
      const s = `stream-${Date.now()}`
      trackStreamingDelta(s, "Hello ")
      trackStreamingDelta(s, "World")
      const session = getSession(s)
      expect(session!.streamingText).toBe("Hello World")
    })

    test("truncates streaming text at 4000 chars", () => {
      const s = `stream-trunc-${Date.now()}`
      const bigChunk = "x".repeat(5000)
      trackStreamingDelta(s, bigChunk)
      const session = getSession(s)
      expect(session!.streamingText.length).toBe(4000)
    })

    test("sets full text", () => {
      const s = `full-${Date.now()}`
      trackFullText(s, "Complete output text")
      const session = getSession(s)
      expect(session!.lastFullText).toBe("Complete output text")
    })

    test("truncates full text at 4000 chars", () => {
      const s = `full-trunc-${Date.now()}`
      trackFullText(s, "y".repeat(5000))
      const session = getSession(s)
      expect(session!.lastFullText.length).toBe(4000)
    })

    test("sets active tool on pending/running status", () => {
      const s = `tool-${Date.now()}`
      trackToolState(s, "bash", "call-1", "running", "Running command", Date.now())
      const session = getSession(s)
      expect(session!.activeTool).not.toBeNull()
      expect(session!.activeTool!.tool).toBe("bash")
      expect(session!.activeTool!.callID).toBe("call-1")
      expect(session!.activeTool!.status).toBe("running")
    })

    test("clears active tool on completed", () => {
      const s = `tool-clear-${Date.now()}`
      trackToolState(s, "bash", "call-2", "running", undefined, Date.now())
      expect(getSession(s)!.activeTool).not.toBeNull()

      trackToolState(s, "bash", "call-2", "completed")
      expect(getSession(s)!.activeTool).toBeNull()
    })

    test("does not clear active tool if callID differs", () => {
      const s = `tool-diff-${Date.now()}`
      trackToolState(s, "bash", "call-a", "running", undefined, Date.now())
      trackToolState(s, "edit", "call-b", "completed")
      expect(getSession(s)!.activeTool).not.toBeNull()
      expect(getSession(s)!.activeTool!.callID).toBe("call-a")
    })

    test("tracks todos", () => {
      const s = `todo-${Date.now()}`
      const todos = [
        { content: "Task 1", status: "completed", priority: "high", id: "t1" },
        { content: "Task 2", status: "in_progress", priority: "medium", id: "t2" },
      ]
      trackTodos(s, todos)
      const session = getSession(s)
      expect(session!.todos).toHaveLength(2)
      expect(session!.todos[0].content).toBe("Task 1")
      expect(session!.todos[1].status).toBe("in_progress")
    })
  })

  describe("session queries", () => {
    test("getSession returns undefined for unknown session", () => {
      expect(getSession("nonexistent-session-xyz-123")).toBeUndefined()
    })

    test("getAllSessions returns all tracked sessions", () => {
      const s = `all-${Date.now()}`
      trackSessionStatus(s, "idle")
      const all = getAllSessions()
      expect(all.length).toBeGreaterThan(0)
      expect(all.some((sess) => sess.sessionID === s)).toBe(true)
    })

    test("getBusySessions filters only busy sessions", () => {
      const busyId = `busy-q-${Date.now()}`
      const idleId = `idle-q-${Date.now()}`
      trackSessionStatus(busyId, "busy")
      trackSessionStatus(idleId, "idle")

      const busy = getBusySessions()
      expect(busy.some((s) => s.sessionID === busyId)).toBe(true)
      expect(busy.some((s) => s.sessionID === idleId)).toBe(false)
    })
  })

  describe("cleanupStaleSessions", () => {
    test("removes stale idle sessions", () => {
      const staleId = `stale-${Date.now()}`
      trackSessionStatus(staleId, "idle")

      const session = getSession(staleId)!
      ;(session as any).lastActivityAt = Date.now() - 15 * 60 * 1000

      cleanupStaleSessions()
      expect(getSession(staleId)).toBeUndefined()
    })

    test("keeps recent idle sessions", () => {
      const recentId = `recent-${Date.now()}`
      trackSessionStatus(recentId, "idle")
      cleanupStaleSessions()
      expect(getSession(recentId)).toBeDefined()
    })

    test("keeps busy sessions regardless of age", () => {
      const busyOldId = `busy-old-${Date.now()}`
      trackSessionStatus(busyOldId, "busy")

      const session = getSession(busyOldId)!
      ;(session as any).lastActivityAt = Date.now() - 15 * 60 * 1000

      cleanupStaleSessions()
      expect(getSession(busyOldId)).toBeDefined()
    })
  })

  describe("shared pending question", () => {
    afterEach(() => {
      clearSharedPendingQuestion()
    })

    test("write and read question", () => {
      const q: SharedPendingQuestion = {
        requestID: "req-1",
        sessionID: "sess-1",
        questions: [{
          question: "Which option?",
          header: "Choose",
          options: [
            { label: "Option A", description: "First" },
            { label: "Option B", description: "Second" },
          ],
        }],
        createdAt: Date.now(),
      }
      writeSharedPendingQuestion(q)
      const read = readSharedPendingQuestion()
      expect(read).not.toBeNull()
      expect(read!.requestID).toBe("req-1")
      expect(read!.questions[0].options).toHaveLength(2)
    })

    test("clear removes the question", () => {
      writeSharedPendingQuestion({
        requestID: "req-2",
        sessionID: "sess-2",
        questions: [{ question: "q", header: "h", options: [] }],
        createdAt: Date.now(),
      })
      clearSharedPendingQuestion()
      expect(readSharedPendingQuestion()).toBeNull()
    })

    test("expired question returns null", () => {
      writeSharedPendingQuestion({
        requestID: "req-3",
        sessionID: "sess-3",
        questions: [{ question: "q", header: "h", options: [] }],
        createdAt: Date.now() - 10 * 60 * 1000,
      })
      expect(readSharedPendingQuestion()).toBeNull()
    })

    test("returns null when no file exists", () => {
      clearSharedPendingQuestion()
      expect(readSharedPendingQuestion()).toBeNull()
    })

    test("returns null for malformed JSON", () => {
      mkdirSync(SHARED_STATE_DIR, { recursive: true })
      writeFileSync(PENDING_QUESTION_PATH, "not json")
      expect(readSharedPendingQuestion()).toBeNull()
    })

    test("returns null when requestID missing", () => {
      mkdirSync(SHARED_STATE_DIR, { recursive: true })
      writeFileSync(PENDING_QUESTION_PATH, JSON.stringify({ questions: [] }))
      expect(readSharedPendingQuestion()).toBeNull()
    })
  })
})
