import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { basename } from "path"
import {
  loadConfig,
  isUpstashConfigured,
  isTelegramEventEnabled,
  getMessage,
  interpolateMessage,
} from "./config"
import type { EventType, NotifierConfig } from "./config"
import {
  createTelegramBot,
  formatEventMessage,
  isMuted,
  pushStreamUpdate,
  notifyConnectedSessionIdle,
  forwardQuestionToTelegram,
  handleQuestionReply,
} from "./telegram"
import {
  claimCommand,
  deleteCommand,
  getBusySessions,
  isLocalSession,
  trackSessionStatus,
  trackSessionProject,
  trackSessionTitle,
  trackStreamingDelta,
  trackFullText,
  trackToolState,
  trackTodos,
  cleanupStaleSessions,
  setFullSessionList,
  initUpstash,
  readPendingCommands,
  writeCommandResult,
  type SharedSessionInfo,
} from "./state"

const IDLE_COMPLETE_DELAY_MS = 350

const pendingIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()
const sessionIdleSequence = new Map<string, number>()
const sessionErrorSuppressionAt = new Map<string, number>()
const sessionLastBusyAt = new Map<string, number>()
const forwardedQuestionIDs = new Set<string>()

setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000

  for (const [sessionID] of sessionIdleSequence) {
    if (!pendingIdleTimers.has(sessionID)) {
      sessionIdleSequence.delete(sessionID)
    }
  }

  for (const [sessionID, timestamp] of sessionErrorSuppressionAt) {
    if (timestamp < cutoff) {
      sessionErrorSuppressionAt.delete(sessionID)
    }
  }

  for (const [sessionID, timestamp] of sessionLastBusyAt) {
    if (timestamp < cutoff) {
      sessionLastBusyAt.delete(sessionID)
    }
  }
}, 5 * 60 * 1000)

let telegramBot: Awaited<ReturnType<typeof createTelegramBot>> = null

const SUMMARY_EVENTS = new Set<EventType>(["complete", "subagent_complete", "error"])

async function handleEvent(
  config: NotifierConfig,
  eventType: EventType,
  projectName: string | null,
  sessionTitle?: string | null,
  sessionID?: string | null
): Promise<void> {
  if (!isTelegramEventEnabled(config, eventType) || !telegramBot || isMuted()) return

  const rawMessage = getMessage(config, eventType)
  const message = interpolateMessage(rawMessage, {
    sessionTitle: config.showSessionTitle ? sessionTitle : null,
    projectName,
  })

  if (sessionID && SUMMARY_EVENTS.has(eventType)) {
    await telegramBot.sendCompletionSummary(sessionID, eventType, projectName)
  } else {
    const telegramMessage = formatEventMessage(eventType, message, projectName)
    await telegramBot.sendMessage(telegramMessage)
  }
}

function getSessionIDFromEvent(event: unknown): string | null {
  const sessionID = (event as any)?.properties?.sessionID
  if (typeof sessionID === "string" && sessionID.length > 0) {
    return sessionID
  }
  return null
}

function clearPendingIdleTimer(sessionID: string): void {
  const timer = pendingIdleTimers.get(sessionID)
  if (!timer) return

  clearTimeout(timer)
  pendingIdleTimers.delete(sessionID)
}

function bumpSessionIdleSequence(sessionID: string): number {
  const nextSequence = (sessionIdleSequence.get(sessionID) ?? 0) + 1
  sessionIdleSequence.set(sessionID, nextSequence)
  return nextSequence
}

function hasCurrentSessionIdleSequence(sessionID: string, sequence: number): boolean {
  return sessionIdleSequence.get(sessionID) === sequence
}

function markSessionError(sessionID: string | null): void {
  if (!sessionID) return
  sessionErrorSuppressionAt.set(sessionID, Date.now())
  bumpSessionIdleSequence(sessionID)
  clearPendingIdleTimer(sessionID)
}

function markSessionBusy(sessionID: string): void {
  sessionLastBusyAt.set(sessionID, Date.now())
  sessionErrorSuppressionAt.delete(sessionID)
  bumpSessionIdleSequence(sessionID)
  clearPendingIdleTimer(sessionID)
}

function shouldSuppressSessionIdle(sessionID: string, consume: boolean = true): boolean {
  const errorAt = sessionErrorSuppressionAt.get(sessionID)
  if (errorAt === undefined) return false

  const busyAt = sessionLastBusyAt.get(sessionID)
  if (typeof busyAt === "number" && busyAt > errorAt) {
    sessionErrorSuppressionAt.delete(sessionID)
    return false
  }

  if (consume) {
    sessionErrorSuppressionAt.delete(sessionID)
  }
  return true
}

interface SessionInfo {
  isChild: boolean
  title: string | null
}

async function getSessionInfo(
  client: PluginInput["client"],
  sessionID: string
): Promise<SessionInfo> {
  try {
    const response = await client.session.get({ path: { id: sessionID } })
    return {
      isChild: !!response.data?.parentID,
      title: response.data?.title ?? null,
    }
  } catch {
    return { isChild: false, title: null }
  }
}

async function processSessionIdle(
  client: PluginInput["client"],
  config: NotifierConfig,
  projectName: string | null,
  sessionID: string,
  sequence: number
): Promise<void> {
  if (!hasCurrentSessionIdleSequence(sessionID, sequence)) return
  if (shouldSuppressSessionIdle(sessionID)) return

  const sessionInfo = await getSessionInfo(client, sessionID)

  if (!hasCurrentSessionIdleSequence(sessionID, sequence)) return
  if (shouldSuppressSessionIdle(sessionID)) return

  const eventType: EventType = sessionInfo.isChild ? "subagent_complete" : "complete"
  await handleEvent(config, eventType, projectName, sessionInfo.title, sessionID)
}

function scheduleSessionIdle(
  client: PluginInput["client"],
  config: NotifierConfig,
  projectName: string | null,
  sessionID: string
): void {
  clearPendingIdleTimer(sessionID)
  const sequence = bumpSessionIdleSequence(sessionID)

  const timer = setTimeout(() => {
    pendingIdleTimers.delete(sessionID)
    void processSessionIdle(client, config, projectName, sessionID, sequence).catch(() => undefined)
  }, IDLE_COMPLETE_DELAY_MS)

  pendingIdleTimers.set(sessionID, timer)
}

async function seedSessionList(
  client: PluginInput["client"],
  projectName: string | null
): Promise<void> {
  try {
    const resp = await client.session.list()
    const allSessions = resp.data ?? []
    const seeds: SharedSessionInfo[] = allSessions
      .filter((s: any) => !s.parentID)
      .map((s: any) => ({
        sessionID: s.id,
        projectName: null,
        title: s.title || null,
        status: "idle" as const,
        activeTool: null,
        lastActivityAt: 0,
      }))
    setFullSessionList(seeds)
  } catch {}
}

export const NotifierPlugin: Plugin = async ({ client, directory }) => {
  const getConfig = () => loadConfig()
  const projectName = directory ? basename(directory) : null

  const initialConfig = getConfig()
  const upstash = initialConfig.upstash
  if (isUpstashConfigured(initialConfig) && upstash) {
    initUpstash(upstash)
  }
  telegramBot = await createTelegramBot(initialConfig, client)

  let remoteCommandInFlight = false
  let remoteCommandInterval: ReturnType<typeof setInterval> | null = null
  const processedCancelCommands = new Set<string>()
  if (isUpstashConfigured(initialConfig) && upstash) {
    remoteCommandInterval = setInterval(() => {
      if (remoteCommandInFlight) return
      remoteCommandInFlight = true
      void (async () => {
        const commands = await readPendingCommands()
        for (const cmd of commands) {
          const isCancel = cmd.type === "cancel"
          const isNew = cmd.type === "new"
          if (isCancel) {
            if (processedCancelCommands.has(cmd.id)) continue
            processedCancelCommands.add(cmd.id)
            if (processedCancelCommands.size > 1000) {
              processedCancelCommands.clear()
            }

            const busy = getBusySessions()
            const results: string[] = []
            for (const session of busy) {
              try {
                await client.session.abort({ path: { id: session.sessionID } })
                const title = session.title ? session.title : session.sessionID.slice(0, 8)
                results.push(`⏹ Cancelled: <b>${title}</b>`)
              } catch {
                results.push(`❌ Failed to cancel: ${session.sessionID.slice(0, 8)}`)
              }
            }

            const claimed = await claimCommand(cmd.id)
            if (claimed) {
              const response =
                results.length > 0 ? results.join("\n") : "💤 Nothing to cancel — no active sessions"
              await writeCommandResult({ id: cmd.id, response, ok: true })
            }
            continue
          }

          if (!isCancel && !isNew) {
            if (!cmd.sessionID || !isLocalSession(cmd.sessionID)) continue
          }

          const claimed = await claimCommand(cmd.id)
          if (!claimed) continue

          let response = ""
          let ok = true

          try {
            if (cmd.type === "prompt") {
              if (!cmd.sessionID) {
                throw new Error("missing session")
              }
              const text = String(cmd.args?.text ?? "").trim()
              if (!text) {
                throw new Error("empty prompt")
              }
              await client.session.promptAsync({
                path: { id: cmd.sessionID },
                body: { parts: [{ type: "text", text }] },
              })
              response = `📨 <i>${text.slice(0, 100)}</i>`
            } else if (cmd.type === "stop") {
              if (!cmd.sessionID) {
                throw new Error("missing session")
              }
              await client.session.abort({ path: { id: cmd.sessionID } })
              response = "⏹ Stopped"
            } else if (cmd.type === "new") {
              const text = String(cmd.args?.text ?? "").trim()
              if (!text) {
                throw new Error("empty prompt")
              }
              const createResp = await client.session.create({})
              const newSession = createResp.data
              if (!newSession?.id) {
                throw new Error("failed to create session")
              }
              await client.session.promptAsync({
                path: { id: newSession.id },
                body: { parts: [{ type: "text", text }] },
              })
              response = `🆕 New session started\n\n📨 <i>${text.slice(0, 200)}</i>`
            } else if (cmd.type === "question_answer") {
              const answer = String(cmd.args?.answer ?? "").trim()
              if (!answer) {
                throw new Error("empty answer")
              }
              response = await handleQuestionReply(answer, cmd.sessionID)
            } else {
              throw new Error("unsupported command")
            }
          } catch (error: any) {
            ok = false
            response = `❌ ${String(error?.message ?? error).slice(0, 200)}`
          }

          await writeCommandResult({ id: cmd.id, response, ok })
          await deleteCommand(cmd.id)
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          remoteCommandInFlight = false
        })
    }, 2500)

    const stopRemoteListener = () => {
      if (!remoteCommandInterval) return
      clearInterval(remoteCommandInterval)
      remoteCommandInterval = null
    }
    process.on("exit", stopRemoteListener)
    process.on("SIGINT", stopRemoteListener)
    process.on("SIGTERM", stopRemoteListener)
  }

  void seedSessionList(client, projectName)
  setInterval(() => {
    void seedSessionList(client, projectName)
  }, 30 * 1000)

  setInterval(() => {
    cleanupStaleSessions()
  }, 5 * 60 * 1000)

  return {
    event: async ({ event }) => {
      const config = getConfig()

      if (event.type === "session.status") {
        const { sessionID, status } = event.properties
        trackSessionProject(sessionID, projectName ?? "unknown")
        if (status.type === "busy") {
          markSessionBusy(sessionID)
          trackSessionStatus(sessionID, "busy")
        } else if (status.type === "idle") {
          trackSessionStatus(sessionID, "idle")
        }
      }

      if (event.type === "session.idle") {
        const sessionID = getSessionIDFromEvent(event)
        if (sessionID) {
          trackSessionStatus(sessionID, "idle")
          notifyConnectedSessionIdle(sessionID)
          scheduleSessionIdle(client, config, projectName, sessionID)
        } else {
          await handleEvent(config, "complete", projectName)
        }
      }

      if ((event as any).type === "message.part.updated") {
        const props = (event as any).properties
        const part = props?.part
        const delta = props?.delta

        if (part?.sessionID) {
          trackSessionProject(part.sessionID, projectName ?? "unknown")
        }

        if (part?.sessionID && part?.type === "text") {
          if (typeof delta === "string" && delta.length > 0) {
            trackStreamingDelta(part.sessionID, delta)
          }
          if (typeof part.text === "string" && part.text.length > 0) {
            trackFullText(part.sessionID, part.text)
          }
          pushStreamUpdate(part.sessionID)
        }
        if (part?.sessionID && part?.type === "tool") {
          const startedAt =
            typeof part.state?.time?.start === "number"
              ? part.state.time.start
              : undefined
          trackToolState(
            part.sessionID,
            part.tool ?? part.name ?? "unknown",
            part.callID ?? part.id ?? "",
            part.state?.status ?? "pending",
            part.state?.title,
            startedAt
          )
          pushStreamUpdate(part.sessionID)
        }
      }

      if ((event as any).type === "message.part.delta") {
        const props = (event as any).properties
        if (props?.sessionID && typeof props?.delta === "string") {
          trackStreamingDelta(props.sessionID, props.delta)
          trackSessionProject(props.sessionID, projectName ?? "unknown")
          pushStreamUpdate(props.sessionID)
        }
      }

      if ((event as any).type === "session.updated") {
        const info = (event as any).properties?.info
        if (info?.id && info?.title) {
          trackSessionTitle(info.id, info.title)
        }
      }

      if (
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        (event as { type?: unknown }).type === "todo.updated"
      ) {
        const props = (event as { properties?: unknown }).properties
        if (typeof props === "object" && props !== null) {
          const sessionID = (props as { sessionID?: unknown }).sessionID
          const todos = (props as { todos?: unknown }).todos
          if (typeof sessionID === "string" && Array.isArray(todos)) {
            trackTodos(
              sessionID,
              todos.filter(
                (todo): todo is { content: string; status: string; priority: string; id: string } =>
                  typeof todo === "object" &&
                  todo !== null &&
                  typeof (todo as { content?: unknown }).content === "string" &&
                  typeof (todo as { status?: unknown }).status === "string" &&
                  typeof (todo as { priority?: unknown }).priority === "string" &&
                  typeof (todo as { id?: unknown }).id === "string"
              )
            )
            pushStreamUpdate(sessionID)
          }
        }
      }

      if ((event as any).type === "question.asked") {
        const props = (event as any).properties
        if (props?.id && props?.questions && !forwardedQuestionIDs.has(props.id)) {
          forwardedQuestionIDs.add(props.id)
          void forwardQuestionToTelegram({
            requestID: props.id,
            sessionID: props.sessionID,
            questions: props.questions,
          })
        }
      }

      if (event.type === "permission.updated") {
        const sessionID = getSessionIDFromEvent(event)
        let sessionTitle: string | null = null
        if (sessionID && config.showSessionTitle) {
          const info = await getSessionInfo(client, sessionID)
          sessionTitle = info.title
        }
        await handleEvent(config, "permission", projectName, sessionTitle, sessionID)
      }

      if ((event as any).type === "permission.asked") {
        await handleEvent(config, "permission", projectName)
      }

      if (event.type === "session.error") {
        const sessionID = getSessionIDFromEvent(event)
        markSessionError(sessionID)
        if (sessionID) {
          trackSessionStatus(sessionID, "error")
        }
        let sessionTitle: string | null = null
        if (sessionID && config.showSessionTitle) {
          const info = await getSessionInfo(client, sessionID)
          sessionTitle = info.title
        }
        await handleEvent(config, "error", projectName, sessionTitle, sessionID)
      }
    },
    "permission.ask": async () => {
      const config = getConfig()
      await handleEvent(config, "permission", projectName)
    },
    dispose: async () => {
      if (remoteCommandInterval) {
        clearInterval(remoteCommandInterval)
        remoteCommandInterval = null
      }
      for (const [sessionID, timer] of pendingIdleTimers) {
        clearTimeout(timer)
        pendingIdleTimers.delete(sessionID)
      }
    },
  }
}

export default NotifierPlugin
