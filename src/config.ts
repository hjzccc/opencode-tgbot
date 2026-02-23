import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export type EventType = "permission" | "complete" | "subagent_complete" | "error" | "question" | "interrupted"

export interface TelegramConfig {
  enabled: boolean
  botToken: string
  chatId: string
  events: {
    permission: boolean
    complete: boolean
    subagent_complete: boolean
    error: boolean
    question: boolean
    interrupted: boolean
  }
}

export interface MessageContext {
  sessionTitle?: string | null
  projectName?: string | null
}

export interface NotifierConfig {
  showProjectName: boolean
  showSessionTitle: boolean
  telegram: TelegramConfig
  messages: {
    permission: string
    complete: string
    subagent_complete: string
    error: string
    question: string
    interrupted: string
  }
}

const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  enabled: false,
  botToken: "",
  chatId: "",
  events: {
    permission: true,
    complete: true,
    subagent_complete: false,
    error: true,
    question: true,
    interrupted: true,
  },
}

const DEFAULT_CONFIG: NotifierConfig = {
  showProjectName: true,
  showSessionTitle: false,
  telegram: { ...DEFAULT_TELEGRAM_CONFIG },
  messages: {
    permission: "Session needs permission: {sessionTitle}",
    complete: "Session has finished: {sessionTitle}",
    subagent_complete: "Subagent task completed: {sessionTitle}",
    error: "Session encountered an error: {sessionTitle}",
    question: "Session has a question: {sessionTitle}",
    interrupted: "Session was interrupted: {sessionTitle}",
  },
}

export function getConfigPath(): string {
  if (process.env.OPENCODE_NOTIFIER_CONFIG_PATH) {
    return process.env.OPENCODE_NOTIFIER_CONFIG_PATH
  }
  return join(homedir(), ".config", "opencode", "opencode-notifier.json")
}

export function loadConfig(): NotifierConfig {
  const configPath = getConfigPath()

  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG
  }

  try {
    const fileContent = readFileSync(configPath, "utf-8")
    const userConfig = JSON.parse(fileContent)

    const userTelegram = userConfig.telegram ?? {}
    const telegramEvents = userTelegram.events ?? {}

    return {
      showProjectName: userConfig.showProjectName ?? DEFAULT_CONFIG.showProjectName,
      showSessionTitle: userConfig.showSessionTitle ?? DEFAULT_CONFIG.showSessionTitle,
      telegram: {
        enabled: typeof userTelegram.enabled === "boolean" ? userTelegram.enabled : DEFAULT_TELEGRAM_CONFIG.enabled,
        botToken: typeof userTelegram.botToken === "string" ? userTelegram.botToken : DEFAULT_TELEGRAM_CONFIG.botToken,
        chatId: userTelegram.chatId != null ? String(userTelegram.chatId) : DEFAULT_TELEGRAM_CONFIG.chatId,
        events: {
          permission: typeof telegramEvents.permission === "boolean" ? telegramEvents.permission : DEFAULT_TELEGRAM_CONFIG.events.permission,
          complete: typeof telegramEvents.complete === "boolean" ? telegramEvents.complete : DEFAULT_TELEGRAM_CONFIG.events.complete,
          subagent_complete: typeof telegramEvents.subagent_complete === "boolean" ? telegramEvents.subagent_complete : DEFAULT_TELEGRAM_CONFIG.events.subagent_complete,
          error: typeof telegramEvents.error === "boolean" ? telegramEvents.error : DEFAULT_TELEGRAM_CONFIG.events.error,
          question: typeof telegramEvents.question === "boolean" ? telegramEvents.question : DEFAULT_TELEGRAM_CONFIG.events.question,
          interrupted: typeof telegramEvents.interrupted === "boolean" ? telegramEvents.interrupted : DEFAULT_TELEGRAM_CONFIG.events.interrupted,
        },
      },
      messages: {
        permission: userConfig.messages?.permission ?? DEFAULT_CONFIG.messages.permission,
        complete: userConfig.messages?.complete ?? DEFAULT_CONFIG.messages.complete,
        subagent_complete: userConfig.messages?.subagent_complete ?? DEFAULT_CONFIG.messages.subagent_complete,
        error: userConfig.messages?.error ?? DEFAULT_CONFIG.messages.error,
        question: userConfig.messages?.question ?? DEFAULT_CONFIG.messages.question,
        interrupted: userConfig.messages?.interrupted ?? DEFAULT_CONFIG.messages.interrupted,
      },
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

export function isTelegramEventEnabled(config: NotifierConfig, event: EventType): boolean {
  if (!config.telegram.enabled || !config.telegram.botToken || !config.telegram.chatId) {
    return false
  }
  return config.telegram.events[event] ?? false
}

export function getMessage(config: NotifierConfig, event: EventType): string {
  return config.messages[event]
}

export function interpolateMessage(message: string, context: MessageContext): string {
  let result = message

  const sessionTitle = context.sessionTitle || ""
  result = result.replaceAll("{sessionTitle}", sessionTitle)

  const projectName = context.projectName || ""
  result = result.replaceAll("{projectName}", projectName)

  result = result.replace(/\s*[:\-|]\s*$/, "").trim()
  result = result.replace(/\s{2,}/g, " ")

  return result
}
