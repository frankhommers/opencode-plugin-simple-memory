import { describe, expect, test } from "bun:test"
import { __test } from "./index"

describe("logger event context", () => {
  test("builds consistent session fields for subagent-safe logs", () => {
    const event = __test.buildLoggerEvent("tool_execute_before", {
      sessionID: "ses_123",
      parentSessionID: null,
      taskID: "task_77",
      agent: "codex",
      payload: { tool: "read" },
    })

    expect(event.session_id).toBe("ses_123")
    expect(event.subagent_session_id).toBe("ses_123")
    expect(event.parent_session_id).toBeNull()
    expect(event.root_session_id).toBe("ses_123")
    expect(event.task_id).toBe("task_77")
    expect(event.agent).toBe("codex")
    expect(event.tool).toBe("read")
  })
})

describe("path placeholders", () => {
  test("expands ${project} and ${date}", () => {
    const resolved = __test.expandTemplate("${project}/logs/${date}", "/tmp/repo", "2026-02-20")
    expect(resolved).toBe("/tmp/repo/logs/2026-02-20")
  })
})

describe("config naming", () => {
  test("uses memory-log config filenames", () => {
    const paths = __test.settingsFilePaths("/tmp/repo")
    expect(paths.global).toBe(`${process.env.HOME}/.config/opencode/memory-log.json`)
    expect(paths.project).toBe("/tmp/repo/.opencode/memory-log.json")
  })
})
