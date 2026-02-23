import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const TEST_DIR = join(tmpdir(), `opencode-notifier-test-config-${process.pid}`)
const TEST_CONFIG = join(TEST_DIR, "opencode-notifier.json")

function writeTestConfig(config: unknown): void {
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(TEST_CONFIG, JSON.stringify(config))
}

function clearTestConfig(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
}

describe("config", () => {
  beforeEach(() => {
    process.env.OPENCODE_NOTIFIER_CONFIG_PATH = TEST_CONFIG
    clearTestConfig()
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    delete process.env.OPENCODE_NOTIFIER_CONFIG_PATH
    clearTestConfig()
  })

  describe("loadConfig", () => {
    test("returns defaults when no config file exists", async () => {
      const { loadConfig } = await import("./config")
      const config = loadConfig()

      expect(config.showProjectName).toBe(true)
      expect(config.showSessionTitle).toBe(false)
      expect(config.telegram.enabled).toBe(false)
      expect(config.telegram.botToken).toBe("")
      expect(config.telegram.chatId).toBe("")
      expect(config.telegram.events.complete).toBe(true)
      expect(config.telegram.events.subagent_complete).toBe(false)
      expect(config.telegram.events.error).toBe(true)
      expect(config.telegram.events.permission).toBe(true)
      expect(config.telegram.events.question).toBe(true)
      expect(config.telegram.events.interrupted).toBe(true)
    })

    test("parses telegram config from file", async () => {
      writeTestConfig({
        telegram: {
          enabled: true,
          botToken: "123:ABC",
          chatId: "999",
          events: { complete: false, error: true },
        },
      })
      const { loadConfig } = await import("./config")
      const config = loadConfig()

      expect(config.telegram.enabled).toBe(true)
      expect(config.telegram.botToken).toBe("123:ABC")
      expect(config.telegram.chatId).toBe("999")
      expect(config.telegram.events.complete).toBe(false)
      expect(config.telegram.events.error).toBe(true)
      expect(config.telegram.events.permission).toBe(true)
    })

    test("handles numeric chatId by converting to string", async () => {
      writeTestConfig({
        telegram: { enabled: true, botToken: "tok", chatId: 12345 },
      })
      const { loadConfig } = await import("./config")
      const config = loadConfig()
      expect(config.telegram.chatId).toBe("12345")
    })

    test("handles invalid JSON gracefully", async () => {
      writeFileSync(TEST_CONFIG, "not json{{{")
      const { loadConfig } = await import("./config")
      const config = loadConfig()
      expect(config.telegram.enabled).toBe(false)
      expect(config.showProjectName).toBe(true)
    })

    test("handles partial config with defaults for missing fields", async () => {
      writeTestConfig({ showProjectName: false })
      const { loadConfig } = await import("./config")
      const config = loadConfig()

      expect(config.showProjectName).toBe(false)
      expect(config.showSessionTitle).toBe(false)
      expect(config.telegram.enabled).toBe(false)
      expect(config.messages.complete).toBe("Session has finished: {sessionTitle}")
    })

    test("parses custom messages", async () => {
      writeTestConfig({
        messages: { complete: "Done!", error: "Oops: {sessionTitle}" },
      })
      const { loadConfig } = await import("./config")
      const config = loadConfig()

      expect(config.messages.complete).toBe("Done!")
      expect(config.messages.error).toBe("Oops: {sessionTitle}")
      expect(config.messages.permission).toBe("Session needs permission: {sessionTitle}")
    })
  })

  describe("isTelegramEventEnabled", () => {
    test("returns false when telegram is disabled", async () => {
      const { isTelegramEventEnabled } = await import("./config")
      const config = {
        showProjectName: true,
        showSessionTitle: false,
        telegram: {
          enabled: false,
          botToken: "tok",
          chatId: "123",
          events: { permission: true, complete: true, subagent_complete: false, error: true, question: true, interrupted: true },
        },
        messages: { permission: "", complete: "", subagent_complete: "", error: "", question: "", interrupted: "" },
      }
      expect(isTelegramEventEnabled(config, "complete")).toBe(false)
    })

    test("returns false when botToken is empty", async () => {
      const { isTelegramEventEnabled } = await import("./config")
      const config = {
        showProjectName: true,
        showSessionTitle: false,
        telegram: {
          enabled: true,
          botToken: "",
          chatId: "123",
          events: { permission: true, complete: true, subagent_complete: false, error: true, question: true, interrupted: true },
        },
        messages: { permission: "", complete: "", subagent_complete: "", error: "", question: "", interrupted: "" },
      }
      expect(isTelegramEventEnabled(config, "complete")).toBe(false)
    })

    test("returns false when chatId is empty", async () => {
      const { isTelegramEventEnabled } = await import("./config")
      const config = {
        showProjectName: true,
        showSessionTitle: false,
        telegram: {
          enabled: true,
          botToken: "tok",
          chatId: "",
          events: { permission: true, complete: true, subagent_complete: false, error: true, question: true, interrupted: true },
        },
        messages: { permission: "", complete: "", subagent_complete: "", error: "", question: "", interrupted: "" },
      }
      expect(isTelegramEventEnabled(config, "complete")).toBe(false)
    })

    test("returns true for enabled event with valid config", async () => {
      const { isTelegramEventEnabled } = await import("./config")
      const config = {
        showProjectName: true,
        showSessionTitle: false,
        telegram: {
          enabled: true,
          botToken: "tok",
          chatId: "123",
          events: { permission: true, complete: true, subagent_complete: false, error: true, question: true, interrupted: true },
        },
        messages: { permission: "", complete: "", subagent_complete: "", error: "", question: "", interrupted: "" },
      }
      expect(isTelegramEventEnabled(config, "complete")).toBe(true)
      expect(isTelegramEventEnabled(config, "error")).toBe(true)
    })

    test("returns false for disabled event", async () => {
      const { isTelegramEventEnabled } = await import("./config")
      const config = {
        showProjectName: true,
        showSessionTitle: false,
        telegram: {
          enabled: true,
          botToken: "tok",
          chatId: "123",
          events: { permission: true, complete: true, subagent_complete: false, error: true, question: true, interrupted: true },
        },
        messages: { permission: "", complete: "", subagent_complete: "", error: "", question: "", interrupted: "" },
      }
      expect(isTelegramEventEnabled(config, "subagent_complete")).toBe(false)
    })
  })

  describe("getMessage", () => {
    test("returns correct message for each event type", async () => {
      const { loadConfig, getMessage } = await import("./config")
      const config = loadConfig()

      expect(getMessage(config, "complete")).toContain("finished")
      expect(getMessage(config, "error")).toContain("error")
      expect(getMessage(config, "permission")).toContain("permission")
      expect(getMessage(config, "question")).toContain("question")
    })
  })

  describe("interpolateMessage", () => {
    test("replaces {sessionTitle} placeholder", async () => {
      const { interpolateMessage } = await import("./config")
      const result = interpolateMessage("Done: {sessionTitle}", {
        sessionTitle: "Fix login bug",
      })
      expect(result).toBe("Done: Fix login bug")
    })

    test("replaces {projectName} placeholder", async () => {
      const { interpolateMessage } = await import("./config")
      const result = interpolateMessage("Project {projectName} update", {
        projectName: "my-app",
      })
      expect(result).toBe("Project my-app update")
    })

    test("replaces both placeholders", async () => {
      const { interpolateMessage } = await import("./config")
      const result = interpolateMessage("{projectName}: {sessionTitle}", {
        sessionTitle: "task",
        projectName: "proj",
      })
      expect(result).toBe("proj: task")
    })

    test("cleans trailing separator when sessionTitle is empty", async () => {
      const { interpolateMessage } = await import("./config")
      const result = interpolateMessage("Session finished: {sessionTitle}", {
        sessionTitle: null,
      })
      expect(result).toBe("Session finished")
    })

    test("cleans trailing separator with dash", async () => {
      const { interpolateMessage } = await import("./config")
      const result = interpolateMessage("Done - {sessionTitle}", {
        sessionTitle: "",
      })
      expect(result).toBe("Done")
    })

    test("collapses multiple spaces", async () => {
      const { interpolateMessage } = await import("./config")
      const result = interpolateMessage("A {sessionTitle} B", {
        sessionTitle: "",
      })
      expect(result).toBe("A B")
    })
  })
})
