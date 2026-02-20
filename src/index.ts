import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { type Plugin, tool } from "@opencode-ai/plugin"

interface Memory {
  ts: string
  type: string
  scope: string
  content: string
  issue?: string
  tags?: string[]
}

interface LoggerSettings {
  enabled: boolean
  scopes: string[]
  dir: string
}

interface PluginSettings {
  memoryDir: string
  logger: LoggerSettings
}

interface SettingsFile {
  memoryDir?: string
  logger?: {
    enabled?: boolean
    scopes?: string[]
    dir?: string
  }
}

const DEFAULT_SETTINGS: PluginSettings = {
  memoryDir: ".opencode/memory",
  logger: {
    enabled: false,
    scopes: [],
    dir: ".opencode/logs/memory",
  },
}

const GLOBAL_SETTINGS_FILE = join(homedir(), ".config", "opencode", "memory-log.json")

const parseLine = (line: string): Memory | null => {
  const tsMatch = line.match(/ts=([^\s]+)/)
  const typeMatch = line.match(/type=([^\s]+)/)
  const scopeMatch = line.match(/scope=([^\s]+)/)
  const contentMatch = line.match(/content="([^"]*(?:\\"[^"]*)*)"/)
  const issueMatch = line.match(/issue=([^\s]+)/)
  const tagsMatch = line.match(/tags=([^\s]+)/)

  if (!tsMatch?.[1] || !typeMatch?.[1] || !scopeMatch?.[1]) return null

  return {
    ts: tsMatch[1],
    type: typeMatch[1],
    scope: scopeMatch[1],
    content: contentMatch?.[1]?.replace(/\\"/g, '"') || "",
    issue: issueMatch?.[1],
    tags: tagsMatch?.[1]?.split(","),
  }
}

const formatMemory = (m: Memory): string => {
  const date = m.ts.split("T")[0]
  const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : ""
  const issue = m.issue ? ` (${m.issue})` : ""
  return `[${date}] ${m.type}/${m.scope}: ${m.content}${issue}${tags}`
}

const scoreMatch = (memory: Memory, words: string[]): number => {
  const searchable = `${memory.type} ${memory.scope} ${memory.content} ${memory.tags?.join(" ") || ""}`.toLowerCase()
  let score = 0
  for (const word of words) {
    if (searchable.includes(word)) score++
    if (memory.scope.toLowerCase() === word) score += 2
    if (memory.type.toLowerCase() === word) score += 2
  }
  return score
}

const expandTemplate = (value: string, projectDir: string, dateOverride?: string): string => {
  const now = new Date()
  const date = dateOverride || now.toISOString().split("T")[0] || ""
  const resolved = value
    .replace(/\$\{home\}/gi, homedir())
    .replace(/\$\{project\}/gi, projectDir)
    .replace(/\$\{workspace\}/gi, projectDir)
    .replace(/\$\{date\}/gi, date)
    .replace(/\$\{env:([A-Z0-9_]+)\}/gi, (_match, key) => {
      const envKey = String(key || "")
      return process.env[envKey] || ""
    })

  return isAbsolute(resolved) ? resolved : join(projectDir, resolved)
}

const buildLoggerEvent = (
  eventName: string,
  input: {
    sessionID: string
    parentSessionID: string | null
    taskID?: string | null
    agent?: string
    payload?: Record<string, unknown>
  },
): Record<string, unknown> => {
  const rootSessionID = input.parentSessionID || input.sessionID
  return {
    ts: new Date().toISOString(),
    event: eventName,
    session_id: input.sessionID,
    subagent_session_id: input.sessionID,
    parent_session_id: input.parentSessionID,
    root_session_id: rootSessionID,
    task_id: input.taskID || null,
    agent: input.agent || null,
    ...(input.payload || {}),
  }
}

const mergeSettings = (base: PluginSettings, patch?: SettingsFile): PluginSettings => {
  if (!patch) return base
  return {
    memoryDir: patch.memoryDir ?? base.memoryDir,
    logger: {
      enabled: patch.logger?.enabled ?? base.logger.enabled,
      scopes: patch.logger?.scopes ?? base.logger.scopes,
      dir: patch.logger?.dir ?? base.logger.dir,
    },
  }
}

const readSettingsFile = async (filePath: string): Promise<SettingsFile | undefined> => {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined
  const text = await file.text()
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text) as SettingsFile
  } catch {
    return undefined
  }
}

const settingsToJSON = (settings: PluginSettings): string => {
  return JSON.stringify(
    {
      memoryDir: settings.memoryDir,
      logger: {
        enabled: settings.logger.enabled,
        scopes: settings.logger.scopes,
        dir: settings.logger.dir,
      },
    },
    null,
    2,
  )
}

const projectSettingsFile = (projectDir: string) => join(projectDir, ".opencode", "memory-log.json")

const loadSettings = async (projectDir: string, config?: unknown): Promise<PluginSettings> => {
  const fromGlobal = await readSettingsFile(GLOBAL_SETTINGS_FILE)
  const fromProject = await readSettingsFile(projectSettingsFile(projectDir))
  let settings = mergeSettings(DEFAULT_SETTINGS, fromGlobal)
  settings = mergeSettings(settings, fromProject)

  const inlineConfig = (config as { memory_log?: SettingsFile } | undefined)?.memory_log
  settings = mergeSettings(settings, inlineConfig)

  return {
    memoryDir: expandTemplate(settings.memoryDir, projectDir),
    logger: {
      enabled: settings.logger.enabled,
      scopes: settings.logger.scopes,
      dir: expandTemplate(settings.logger.dir, projectDir),
    },
  }
}

const ensureDir = async (path: string) => {
  const dir = Bun.file(path)
  if (!(await dir.exists())) {
    await Bun.$`mkdir -p ${path}`
  }
}

const makeMemoryTools = (runtime: {
  settings: PluginSettings
  sessionAgents: Map<string, string>
  projectDir: string
}) => {
  const getMemoryFile = () => {
    const date = new Date().toISOString().split("T")[0]
    return Bun.file(`${runtime.settings.memoryDir}/${date}.logfmt`)
  }

  const getAllMemories = async (): Promise<Memory[]> => {
    const dir = Bun.file(runtime.settings.memoryDir)
    if (!(await dir.exists())) return []

    const glob = new Bun.Glob("*.logfmt")
    const files = await Array.fromAsync(glob.scan(runtime.settings.memoryDir))

    if (!files.length) return []

    const lines: string[] = []
    for (const filename of files) {
      if (filename === "deletions.logfmt") continue
      const file = Bun.file(`${runtime.settings.memoryDir}/${filename}`)
      const text = await file.text()
      lines.push(...text.trim().split("\n").filter(Boolean))
    }

    return lines.map(parseLine).filter((m): m is Memory => m !== null)
  }

  const logDeletion = async (memory: Memory, reason: string) => {
    await ensureDir(runtime.settings.memoryDir)
    const ts = new Date().toISOString()
    const content = memory.content.replace(/"/g, '\\"')
    const originalTs = memory.ts
    const issue = memory.issue ? ` issue=${memory.issue}` : ""
    const tags = memory.tags?.length ? ` tags=${memory.tags.join(",")}` : ""
    const escapedReason = reason.replace(/"/g, '\\"')
    const line = `ts=${ts} action=deleted original_ts=${originalTs} type=${memory.type} scope=${memory.scope} content="${content}" reason="${escapedReason}"${issue}${tags}\n`

    const file = Bun.file(`${runtime.settings.memoryDir}/deletions.logfmt`)
    const existing = (await file.exists()) ? await file.text() : ""
    await Bun.write(file, existing + line)
  }

  const shouldLogScope = (scope: string): boolean => {
    const logger = runtime.settings.logger
    if (!logger.enabled) return false
    if (!logger.scopes.length) return true
    return logger.scopes.includes("*") || logger.scopes.includes(scope)
  }

  const appendJsonLog = async (scope: string, payload: Record<string, unknown>) => {
    if (!shouldLogScope(scope)) return
    await ensureDir(runtime.settings.logger.dir)

    const date = new Date().toISOString().split("T")[0]
    const file = Bun.file(`${runtime.settings.logger.dir}/${date}.jsonl`)
    const existing = (await file.exists()) ? await file.text() : ""
    await Bun.write(file, `${existing}${JSON.stringify(payload)}\n`)
  }

  const remember = tool({
    description: "Store a memory (decision, learning, preference, blocker, context, pattern)",
    args: {
      type: tool.schema
        .enum(["decision", "learning", "preference", "blocker", "context", "pattern"])
        .describe("Type of memory"),
      scope: tool.schema.string().describe("Scope/area (e.g., auth, api, mobile)"),
      content: tool.schema.string().describe("The memory content"),
      issue: tool.schema.string().optional().describe("Related GitHub issue (e.g., #51)"),
      tags: tool.schema.array(tool.schema.string()).optional().describe("Additional tags"),
    },
    async execute(args) {
      await ensureDir(runtime.settings.memoryDir)

      const ts = new Date().toISOString()
      const issue = args.issue ? ` issue=${args.issue}` : ""
      const tags = args.tags?.length ? ` tags=${args.tags.join(",")}` : ""
      const content = args.content.replace(/"/g, '\\"')
      const line = `ts=${ts} type=${args.type} scope=${args.scope} content="${content}"${issue}${tags}\n`

      const file = getMemoryFile()
      const existing = (await file.exists()) ? await file.text() : ""
      await Bun.write(file, existing + line)

      await appendJsonLog(args.scope, {
        ts,
        event: "memory_remember",
        scope: args.scope,
        memory_type: args.type,
        content: args.content,
      })

      return `Remembered: ${args.type} in ${args.scope}`
    },
  })

  const recall = tool({
    description: "Retrieve memories by scope, type, or search query",
    args: {
      scope: tool.schema.string().optional().describe("Filter by scope"),
      type: tool.schema
        .enum(["decision", "learning", "preference", "blocker", "context", "pattern"])
        .optional()
        .describe("Filter by type"),
      query: tool.schema.string().optional().describe("Search term (space-separated words, matches any)"),
      limit: tool.schema.number().optional().describe("Max results (default 20)"),
    },
    async execute(args) {
      let results = await getAllMemories()

      if (!results.length) return "No memories found"

      const totalCount = results.length

      if (args.scope) {
        results = results.filter((m) => m.scope === args.scope || m.scope.includes(args.scope!))
      }
      if (args.type) {
        results = results.filter((m) => m.type === args.type)
      }

      if (args.query) {
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean)
        const scored = results
          .map((m) => ({ memory: m, score: scoreMatch(m, words) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
        results = scored.map((x) => x.memory)
      }

      const filteredCount = results.length
      const limit = args.limit || 20
      const limited = results.slice(-limit)

      if (!limited.length) return "No matching memories"

      const header = filteredCount > limit
        ? `Found ${filteredCount} memories (showing last ${limit} of ${totalCount} total)\n\n`
        : filteredCount !== totalCount
          ? `Found ${filteredCount} memories (${totalCount} total)\n\n`
          : `Found ${filteredCount} memories\n\n`

      return header + limited.map(formatMemory).join("\n")
    },
  })

  const update = tool({
    description: "Update an existing memory by scope and type (finds matching memory and updates its content)",
    args: {
      scope: tool.schema.string().describe("Scope of memory to update"),
      type: tool.schema
        .enum(["decision", "learning", "preference", "blocker", "context", "pattern"])
        .describe("Type of memory"),
      content: tool.schema.string().describe("The new content for the memory"),
      query: tool.schema.string().optional().describe("Search term to find specific memory if multiple exist"),
      issue: tool.schema.string().optional().describe("Update related GitHub issue (e.g., #51)"),
      tags: tool.schema.array(tool.schema.string()).optional().describe("Update tags"),
    },
    async execute(args) {
      const dir = Bun.file(runtime.settings.memoryDir)
      if (!(await dir.exists())) return "No memory files found"

      const glob = new Bun.Glob("*.logfmt")
      const files = await Array.fromAsync(glob.scan(runtime.settings.memoryDir))

      if (!files.length) return "No memory files found"

      const matches: { memory: Memory; filepath: string; lineIndex: number }[] = []

      for (const filename of files) {
        if (filename === "deletions.logfmt") continue
        const filepath = `${runtime.settings.memoryDir}/${filename}`
        const file = Bun.file(filepath)
        const text = await file.text()
        const lines = text.split("\n")

        lines.forEach((line, lineIndex) => {
          const memory = parseLine(line)
          if (!memory) return
          if (memory.scope === args.scope && memory.type === args.type) {
            matches.push({ memory, filepath, lineIndex })
          }
        })
      }

      if (matches.length === 0) {
        return `No memories found for ${args.type} in ${args.scope}`
      }

      let target: typeof matches[number] | undefined = matches[0]
      if (matches.length > 1) {
        if (args.query) {
          const words = args.query.toLowerCase().split(/\s+/).filter(Boolean)
          const scored = matches
            .map((m) => ({ ...m, score: scoreMatch(m.memory, words) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)

          if (scored.length === 0) {
            return `Found ${matches.length} memories for ${args.type}/${args.scope}, but none matched query "${args.query}". Use recall to see all matches.`
          }
          target = scored[0]
        } else {
          return `Found ${matches.length} memories for ${args.type}/${args.scope}. Provide a query to select which one to update, or use recall to see all matches.`
        }
      }

      if (!target) {
        return `No memories found for ${args.type} in ${args.scope}`
      }

      await logDeletion(target.memory, `Updated to: ${args.content}`)

      const file = Bun.file(target.filepath)
      const text = await file.text()
      const lines = text.split("\n")

      const ts = new Date().toISOString()
      const issue = args.issue !== undefined ? args.issue : target.memory.issue
      const tags = args.tags !== undefined ? args.tags : target.memory.tags
      const issueStr = issue ? ` issue=${issue}` : ""
      const tagsStr = tags?.length ? ` tags=${tags.join(",")}` : ""
      const content = args.content.replace(/"/g, '\\"')
      const newLine = `ts=${ts} type=${args.type} scope=${args.scope} content="${content}"${issueStr}${tagsStr}`

      lines[target.lineIndex] = newLine
      await Bun.write(target.filepath, lines.join("\n"))

      await appendJsonLog(args.scope, {
        ts,
        event: "memory_update",
        scope: args.scope,
        memory_type: args.type,
        content: args.content,
      })

      return `Updated ${args.type} in ${args.scope}: "${args.content}"`
    },
  })

  const listMemories = tool({
    description: "List all unique scopes and types in memory for discovery",
    args: {},
    async execute() {
      const memories = await getAllMemories()

      if (!memories.length) return "No memories found"

      const scopes = new Map<string, number>()
      const types = new Map<string, number>()
      const scopeTypes = new Map<string, Set<string>>()

      for (const m of memories) {
        scopes.set(m.scope, (scopes.get(m.scope) || 0) + 1)
        types.set(m.type, (types.get(m.type) || 0) + 1)
        if (!scopeTypes.has(m.scope)) scopeTypes.set(m.scope, new Set())
        scopeTypes.get(m.scope)!.add(m.type)
      }

      const lines: string[] = []
      lines.push(`Total memories: ${memories.length}`)
      lines.push("")
      lines.push("Scopes:")
      for (const [scope, count] of [...scopes.entries()].sort((a, b) => b[1] - a[1])) {
        const typeList = [...scopeTypes.get(scope)!].join(", ")
        lines.push(`  ${scope}: ${count} (${typeList})`)
      }
      lines.push("")
      lines.push("Types:")
      for (const [type, count] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${type}: ${count}`)
      }

      return lines.join("\n")
    },
  })

  const forget = tool({
    description: "Delete a memory by scope and type (removes matching lines from all memory files, logs deletion for audit)",
    args: {
      scope: tool.schema.string().describe("Scope of memory to delete"),
      type: tool.schema
        .enum(["decision", "learning", "preference", "blocker", "context", "pattern"])
        .describe("Type of memory"),
      reason: tool.schema.string().describe("Why this is being deleted (for audit purposes)"),
    },
    async execute(args) {
      const dir = Bun.file(runtime.settings.memoryDir)
      if (!(await dir.exists())) return "No memory files found"

      const glob = new Bun.Glob("*.logfmt")
      const files = await Array.fromAsync(glob.scan(runtime.settings.memoryDir))

      if (!files.length) return "No memory files found"

      let deleted = 0
      const deletedMemories: Memory[] = []

      for (const filename of files) {
        if (filename === "deletions.logfmt") continue
        const filepath = `${runtime.settings.memoryDir}/${filename}`
        const file = Bun.file(filepath)
        const text = await file.text()
        const lines = text.split("\n")
        const filtered = lines.filter((line) => {
          const memory = parseLine(line)
          if (!memory) return true
          if (memory.scope === args.scope && memory.type === args.type) {
            deleted++
            deletedMemories.push(memory)
            return false
          }
          return true
        })
        if (filtered.length !== lines.length) {
          await Bun.write(filepath, filtered.join("\n"))
        }
      }

      for (const memory of deletedMemories) {
        await logDeletion(memory, args.reason)
      }

      await appendJsonLog(args.scope, {
        ts: new Date().toISOString(),
        event: "memory_forget",
        scope: args.scope,
        memory_type: args.type,
        reason: args.reason,
      })

      if (deleted === 0) return `No memories found for ${args.type} in ${args.scope}`
      return `Deleted ${deleted} ${args.type} memory(s) from ${args.scope}. Reason: ${args.reason}\nDeletions logged to ${runtime.settings.memoryDir}/deletions.logfmt`
    },
  })

  const setLogger = tool({
    description: "Configure JSONL logger mode independently from memory tools",
    args: {
      enabled: tool.schema.boolean().optional().describe("Enable or disable logger mode"),
      scopes: tool.schema.array(tool.schema.string()).optional().describe("Scopes to log (empty means all)"),
      persist: tool.schema.enum(["session", "project", "global"]).optional().describe("Persist mode settings"),
    },
    async execute(args) {
      runtime.settings.logger.enabled = args.enabled ?? runtime.settings.logger.enabled
      runtime.settings.logger.scopes = args.scopes ?? runtime.settings.logger.scopes

      const persist = args.persist || "session"
      if (persist !== "session") {
        const target = persist === "project" ? projectSettingsFile(runtime.projectDir) : GLOBAL_SETTINGS_FILE
        await ensureDir(dirname(target))
        const existing = (await readSettingsFile(target)) || {}
        const merged: SettingsFile = {
          ...existing,
          logger: {
            ...existing.logger,
            enabled: runtime.settings.logger.enabled,
            scopes: runtime.settings.logger.scopes,
            dir: runtime.settings.logger.dir,
          },
          memoryDir: existing.memoryDir || runtime.settings.memoryDir,
        }
        await Bun.write(target, `${JSON.stringify(merged, null, 2)}\n`)
      }

      return `Logger ${runtime.settings.logger.enabled ? "enabled" : "disabled"} (scopes: ${runtime.settings.logger.scopes.length ? runtime.settings.logger.scopes.join(", ") : "all"}, persist: ${persist})`
    },
  })

  const loggerStatus = tool({
    description: "Show logger and memory storage configuration",
    args: {},
    async execute() {
      return settingsToJSON(runtime.settings)
    },
  })

  return {
    memory_remember: remember,
    memory_recall: recall,
    memory_update: update,
    memory_forget: forget,
    memory_list: listMemories,
    memory_logger_set: setLogger,
    memory_logger_status: loggerStatus,
    appendJsonLog,
  }
}

export const MemoryPlugin: Plugin = async (ctx) => {
  const runtime = {
    projectDir: ctx.directory,
    settings: await loadSettings(ctx.directory),
    sessionAgents: new Map<string, string>(),
  }

  const tools = makeMemoryTools(runtime)

  return {
    config: async (input) => {
      runtime.settings = await loadSettings(ctx.directory, input)
    },
    "chat.message": async (input, output) => {
      if (input.agent) runtime.sessionAgents.set(input.sessionID, input.agent)
      await tools.appendJsonLog(
        "chat",
        buildLoggerEvent("chat_message", {
          sessionID: input.sessionID,
          parentSessionID: null,
          agent: input.agent,
          payload: {
            message_id: input.messageID,
            model: input.model,
            parts: output.parts,
          },
        }),
      )
    },
    "tool.execute.before": async (input, output) => {
      const scope = typeof output.args?.scope === "string" ? output.args.scope : "tool"
      await tools.appendJsonLog(
        scope,
        buildLoggerEvent("tool_execute_before", {
          sessionID: input.sessionID,
          parentSessionID: null,
          agent: runtime.sessionAgents.get(input.sessionID),
          payload: {
            call_id: input.callID,
            tool: input.tool,
            args: output.args,
          },
        }),
      )
    },
    "tool.execute.after": async (input, output) => {
      const scope = typeof output.metadata?.scope === "string" ? output.metadata.scope : "tool"
      await tools.appendJsonLog(
        scope,
        buildLoggerEvent("tool_execute_after", {
          sessionID: input.sessionID,
          parentSessionID: null,
          agent: runtime.sessionAgents.get(input.sessionID),
          payload: {
            call_id: input.callID,
            tool: input.tool,
            title: output.title,
            output: output.output,
          },
        }),
      )
    },
    tool: {
      memory_remember: tools.memory_remember,
      memory_recall: tools.memory_recall,
      memory_update: tools.memory_update,
      memory_forget: tools.memory_forget,
      memory_list: tools.memory_list,
      memory_logger_set: tools.memory_logger_set,
      memory_logger_status: tools.memory_logger_status,
    },
  }
}

export default MemoryPlugin

export const __test = {
  expandTemplate,
  buildLoggerEvent,
  settingsFilePaths: (projectDir: string) => ({
    global: GLOBAL_SETTINGS_FILE,
    project: projectSettingsFile(projectDir),
  }),
}
