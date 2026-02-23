import { describe, test, expect } from "bun:test"
import {
  escapeHtml,
  truncate,
  markdownToTelegramHtml,
  formatDuration,
  formatEventMessage,
  parseCommand,
  formatTodos,
  isMuted,
} from "./telegram"

describe("escapeHtml", () => {
  test("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b")
  })

  test("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;"
    )
  })

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("")
  })

  test("passes through safe text unchanged", () => {
    expect(escapeHtml("Hello World 123")).toBe("Hello World 123")
  })

  test("escapes multiple special chars", () => {
    expect(escapeHtml("a<b>c&d")).toBe("a&lt;b&gt;c&amp;d")
  })
})

describe("truncate", () => {
  test("returns text as-is when within limit", () => {
    expect(truncate("short", 10)).toBe("short")
  })

  test("returns text as-is when exactly at limit", () => {
    expect(truncate("12345", 5)).toBe("12345")
  })

  test("truncates long text with ellipsis", () => {
    const result = truncate("Hello World!", 5)
    expect(result).toContain("…")
    expect(result.length).toBeLessThanOrEqual(6)
  })

  test("BUG: truncate takes tail instead of head", () => {
    const result = truncate("ABCDEFGHIJ", 5)
    // Current (buggy) behavior: takes last 5 chars
    expect(result).toBe("FGHIJ…")
    // Correct behavior should be: "ABCDE…"
    // This test documents the known bug
  })
})

describe("markdownToTelegramHtml", () => {
  test("converts **bold**", () => {
    expect(markdownToTelegramHtml("**hello**")).toBe("<b>hello</b>")
  })

  test("converts __bold__", () => {
    expect(markdownToTelegramHtml("__hello__")).toBe("<b>hello</b>")
  })

  test("converts *italic*", () => {
    expect(markdownToTelegramHtml("*hello*")).toBe("<i>hello</i>")
  })

  test("converts inline code", () => {
    const result = markdownToTelegramHtml("use `foo()` here")
    expect(result).toContain("<code>foo()</code>")
  })

  test("converts code blocks with language", () => {
    const result = markdownToTelegramHtml("```typescript\nconst x = 1\n```")
    expect(result).toContain("<b>typescript</b>")
    expect(result).toContain("<pre>")
    expect(result).toContain("const x = 1")
  })

  test("converts code blocks without language", () => {
    const result = markdownToTelegramHtml("```\nfoo\n```")
    expect(result).toContain("<pre>")
    expect(result).toContain("foo")
  })

  test("escapes HTML inside code blocks", () => {
    const result = markdownToTelegramHtml("```\n<div>test</div>\n```")
    expect(result).toContain("&lt;div&gt;")
  })

  test("escapes HTML inside inline code", () => {
    const result = markdownToTelegramHtml("`<b>not bold</b>`")
    expect(result).toContain("&lt;b&gt;")
  })

  test("converts headers to bold", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>")
    expect(markdownToTelegramHtml("## Subtitle")).toBe("<b>Subtitle</b>")
    expect(markdownToTelegramHtml("### Section")).toBe("<b>Section</b>")
  })

  test("converts unordered lists", () => {
    const result = markdownToTelegramHtml("- item one\n- item two")
    expect(result).toContain("• item one")
    expect(result).toContain("• item two")
  })

  test("converts ordered lists", () => {
    const result = markdownToTelegramHtml("1. first\n2. second")
    expect(result).toContain("1. first")
    expect(result).toContain("2. second")
  })

  test("converts links", () => {
    const result = markdownToTelegramHtml("[Google](https://google.com)")
    expect(result).toBe('<a href="https://google.com">Google</a>')
  })

  test("converts blockquotes", () => {
    const result = markdownToTelegramHtml("> some quote")
    expect(result).toContain("┃")
    expect(result).toContain("some quote")
  })

  test("converts horizontal rules", () => {
    const result = markdownToTelegramHtml("---")
    expect(result).toBe("—————")
  })

  test("collapses multiple blank lines", () => {
    const result = markdownToTelegramHtml("a\n\n\n\nb")
    expect(result).not.toContain("\n\n\n")
  })

  test("trims result", () => {
    const result = markdownToTelegramHtml("  hello  ")
    expect(result).toBe("hello")
  })

  test("handles mixed content", () => {
    const md = "# Title\n\n**Bold** and *italic*\n\n- item\n\n`code`"
    const result = markdownToTelegramHtml(md)
    expect(result).toContain("<b>Title</b>")
    expect(result).toContain("<b>Bold</b>")
    expect(result).toContain("<i>italic</i>")
    expect(result).toContain("• item")
    expect(result).toContain("<code>code</code>")
  })
})

describe("formatDuration", () => {
  test("formats seconds", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(30)).toBe("30s")
    expect(formatDuration(59)).toBe("59s")
  })

  test("rounds fractional seconds", () => {
    expect(formatDuration(30.7)).toBe("31s")
  })

  test("formats minutes and seconds", () => {
    expect(formatDuration(60)).toBe("1m")
    expect(formatDuration(90)).toBe("1m 30s")
    expect(formatDuration(125)).toBe("2m 5s")
  })

  test("formats exact minutes without seconds", () => {
    expect(formatDuration(120)).toBe("2m")
    expect(formatDuration(300)).toBe("5m")
  })

  test("formats hours", () => {
    expect(formatDuration(3600)).toBe("1h")
    expect(formatDuration(3660)).toBe("1h 1m")
    expect(formatDuration(7200)).toBe("2h")
    expect(formatDuration(5400)).toBe("1h 30m")
  })
})

describe("formatEventMessage", () => {
  test("formats with correct emoji for each event type", () => {
    expect(formatEventMessage("complete", "Done", null)).toContain("✅")
    expect(formatEventMessage("error", "Failed", null)).toContain("❌")
    expect(formatEventMessage("permission", "Needs perm", null)).toContain("🔐")
    expect(formatEventMessage("question", "Question", null)).toContain("❓")
    expect(formatEventMessage("subagent_complete", "Sub done", null)).toContain("🔗")
    expect(formatEventMessage("interrupted", "Stopped", null)).toContain("⏹")
  })

  test("uses fallback emoji for unknown event", () => {
    expect(formatEventMessage("unknown", "msg", null)).toContain("📢")
  })

  test("includes project name when provided", () => {
    const result = formatEventMessage("complete", "Done", "my-project")
    expect(result).toContain("my-project")
    expect(result).toContain("<i>")
  })

  test("omits project when null", () => {
    const result = formatEventMessage("complete", "Done", null)
    expect(result).not.toContain("<i>")
  })

  test("escapes HTML in event type and message", () => {
    const result = formatEventMessage("complete", "a<b>c", null)
    expect(result).toContain("a&lt;b&gt;c")
  })

  test("escapes HTML in project name", () => {
    const result = formatEventMessage("complete", "Done", "a<b>c")
    expect(result).toContain("a&lt;b&gt;c")
  })

  test("format structure: emoji eventType project\\nmessage", () => {
    const result = formatEventMessage("complete", "Session done", "proj")
    expect(result).toMatch(/^✅ <b>complete<\/b> <i>proj<\/i>\nSession done$/)
  })
})

describe("parseCommand", () => {
  test("parses simple command", () => {
    const result = parseCommand("/help")
    expect(result).toEqual({ command: "help", args: "" })
  })

  test("parses command with args", () => {
    const result = parseCommand("/new start a session")
    expect(result).toEqual({ command: "new", args: "start a session" })
  })

  test("parses command with bot mention", () => {
    const result = parseCommand("/help@mybot")
    expect(result).toEqual({ command: "help", args: "" })
  })

  test("parses command with bot mention and args", () => {
    const result = parseCommand("/connect@mybot 3")
    expect(result).toEqual({ command: "connect", args: "3" })
  })

  test("returns null for non-command text", () => {
    expect(parseCommand("hello")).toBeNull()
    expect(parseCommand("not a command")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(parseCommand("")).toBeNull()
  })

  test("handles multiline args", () => {
    const result = parseCommand("/new line1\nline2\nline3")
    expect(result).toEqual({ command: "new", args: "line1\nline2\nline3" })
  })
})

describe("formatTodos", () => {
  test("returns empty string for empty list", () => {
    expect(formatTodos([])).toBe("")
  })

  test("shows in-progress tasks first", () => {
    const result = formatTodos([
      { content: "Pending task", status: "pending" },
      { content: "Active task", status: "in_progress" },
    ])
    const lines = result.split("\n")
    const activeIdx = lines.findIndex((l) => l.includes("Active task"))
    const pendingIdx = lines.findIndex((l) => l.includes("Pending task"))
    expect(activeIdx).toBeLessThan(pendingIdx)
  })

  test("shows correct status icons", () => {
    const result = formatTodos([
      { content: "In progress", status: "in_progress" },
      { content: "Pending", status: "pending" },
      { content: "Cancelled", status: "cancelled" },
    ])
    expect(result).toContain("🔄 In progress")
    expect(result).toContain("⬚ Pending")
    expect(result).toContain("❌ Cancelled")
  })

  test("shows completed count", () => {
    const result = formatTodos([
      { content: "Done 1", status: "completed" },
      { content: "Done 2", status: "completed" },
      { content: "Pending", status: "pending" },
    ])
    expect(result).toContain("(2/3 done)")
  })

  test("shows all tasks completed when no visible tasks", () => {
    const result = formatTodos([
      { content: "Done 1", status: "completed" },
      { content: "Done 2", status: "completed" },
    ])
    expect(result).toContain("✅ All tasks completed")
    expect(result).toContain("(2/2 done)")
  })

  test("does not show completed tasks in list", () => {
    const result = formatTodos([
      { content: "Done task", status: "completed" },
      { content: "Active task", status: "in_progress" },
    ])
    expect(result).not.toContain("Done task")
    expect(result).toContain("Active task")
  })

  test("has Tasks header", () => {
    const result = formatTodos([{ content: "Something", status: "pending" }])
    expect(result).toContain("📋 <b>Tasks</b>")
  })

  test("escapes HTML in task content", () => {
    const result = formatTodos([{ content: "Fix <div> issue", status: "pending" }])
    expect(result).toContain("&lt;div&gt;")
  })
})

describe("isMuted", () => {
  test("returns false by default", () => {
    expect(isMuted()).toBe(false)
  })
})
