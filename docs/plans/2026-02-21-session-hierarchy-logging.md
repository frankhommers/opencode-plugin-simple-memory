# Session Hierarchy Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Log events per sessie in aparte bestanden, met subagent logs genest onder hun parent sessie.

**Architecture:** Bij elke event de sessie-info ophalen (title, parentID), een directory-boom opbouwen per sessie, en subagent logs als aparte bestanden in dezelfde sessie-map schrijven. Curated memories (`memories.logfmt`) blijven ongewijzigd.

**Tech Stack:** Bun APIs, OpenCode plugin SDK (`ctx.client.session.get()`)

---

## Gewenste structuur

```
.opencode/memory/
├── 2026-02-21.logfmt                          # curated memories (ongewijzigd)
├── deletions.logfmt                           # audit log (ongewijzigd)
└── sessions/
    └── 2026-02-21-fix-auth-bug/               # sessie-map (datum + title slug)
        ├── main.jsonl                          # events van de hoofdsessie
        ├── explore-ses_abc123.jsonl            # subagent explore
        └── codex-ses_def456.jsonl              # subagent codex
```

---

### Task 1: Session info cache toevoegen aan runtime

**Files:**
- Modify: `src/index.ts` — runtime object en types

**Step 1: Voeg SessionInfo type en cache toe**

Voeg toe aan de types boven in het bestand:

```typescript
interface SessionInfo {
  id: string
  title: string
  parentID?: string
  slug: string // slugified title voor directory naam
}
```

Voeg toe aan het runtime object (in `MemoryPlugin`):

```typescript
const runtime = {
  projectDir: ctx.directory,
  settings: await loadSettings(ctx.directory),
  sessionAgents: new Map<string, string>(),
  sessionInfo: new Map<string, SessionInfo>(),  // NIEUW
  client: ctx.client,                            // NIEUW - bewaar client ref
}
```

**Step 2: Schrijf helper om sessie-info op te halen en te cachen**

```typescript
const slugify = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)

const getSessionInfo = async (sessionID: string): Promise<SessionInfo> => {
  const cached = runtime.sessionInfo.get(sessionID)
  if (cached) return cached

  try {
    const result = await runtime.client.session.get({ sessionID })
    const session = result.data
    const date = new Date(session.time.created * 1000).toISOString().split("T")[0]
    const info: SessionInfo = {
      id: session.id,
      title: session.title,
      parentID: session.parentID,
      slug: `${date}-${slugify(session.title)}`,
    }
    runtime.sessionInfo.set(sessionID, info)
    return info
  } catch {
    // Fallback als API niet bereikbaar is
    const info: SessionInfo = {
      id: sessionID,
      title: sessionID,
      parentID: undefined,
      slug: sessionID,
    }
    runtime.sessionInfo.set(sessionID, info)
    return info
  }
}
```

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add session info cache with client API lookup"
```

---

### Task 2: Session-aware log schrijven

**Files:**
- Modify: `src/index.ts` — `appendJsonLog` en `makeMemoryTools`

**Step 1: Voeg `appendSessionLog` toe naast bestaande `appendJsonLog`**

`appendJsonLog` blijft bestaan voor de bestaande flat logs (backward compat). Nieuwe functie:

```typescript
const appendSessionLog = async (
  sessionID: string,
  payload: Record<string, unknown>,
) => {
  if (!runtime.settings.logger.enabled) return

  const info = await getSessionInfo(sessionID)

  // Bepaal sessie-map: gebruik parent als dit een subagent is
  let sessionSlug: string
  let filename: string

  if (info.parentID) {
    // Subagent: log in parent's map met agent prefix
    const parentInfo = await getSessionInfo(info.parentID)
    sessionSlug = parentInfo.slug
    const agent = runtime.sessionAgents.get(sessionID) || "subagent"
    filename = `${agent}-${info.id}.jsonl`
  } else {
    // Hoofdsessie
    sessionSlug = info.slug
    filename = "main.jsonl"
  }

  const sessionsDir = `${runtime.settings.memoryDir}/sessions/${sessionSlug}`
  await ensureDir(sessionsDir)

  const file = Bun.file(`${sessionsDir}/${filename}`)
  const existing = (await file.exists()) ? await file.text() : ""
  await Bun.write(file, `${existing}${JSON.stringify(payload)}\n`)
}
```

**Step 2: Gebruik `appendSessionLog` in de event hooks**

In `chat.message`, `tool.execute.before`, `tool.execute.after`: roep `appendSessionLog` aan in plaats van (of naast) `appendJsonLog`:

```typescript
"chat.message": async (input, output) => {
  if (input.agent) runtime.sessionAgents.set(input.sessionID, input.agent)
  const event = buildLoggerEvent("chat_message", {
    sessionID: input.sessionID,
    parentSessionID: null, // wordt door appendSessionLog bepaald
    agent: input.agent,
    payload: { message_id: input.messageID, model: input.model, parts: output.parts },
  })
  await appendSessionLog(input.sessionID, event)
},
```

Idem voor `tool.execute.before` en `tool.execute.after`.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: write session logs to per-session directories with subagent files"
```

---

### Task 3: `parentSessionID` correct invullen

**Files:**
- Modify: `src/index.ts` — `buildLoggerEvent` en hooks

**Step 1: Gebruik `getSessionInfo` om parentID te resolven**

Update de event hooks om `parentSessionID` correct in te vullen:

```typescript
"chat.message": async (input, output) => {
  if (input.agent) runtime.sessionAgents.set(input.sessionID, input.agent)
  const info = await getSessionInfo(input.sessionID)
  const event = buildLoggerEvent("chat_message", {
    sessionID: input.sessionID,
    parentSessionID: info.parentID || null,
    agent: input.agent,
    payload: { message_id: input.messageID, model: input.model, parts: output.parts },
  })
  await appendSessionLog(input.sessionID, event)
},
```

**Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: resolve parentSessionID from session API"
```

---

### Task 4: Oude flat jsonl logging verwijderen

**Files:**
- Modify: `src/index.ts`

**Step 1: Verwijder `appendJsonLog` aanroepen uit de memory tools**

De `remember`, `update`, `forget` tools roepen nu `appendJsonLog` aan. Vervang door `appendSessionLog` — maar daarvoor moet `sessionID` beschikbaar zijn in de tools.

De tools gebruiken nu `ToolContext` niet (tweede arg van `execute`). Voeg die toe:

```typescript
async execute(args, context) {
  // context.sessionID is beschikbaar
  await appendSessionLog(context.sessionID, { ... })
}
```

**Step 2: Verwijder de oude `appendJsonLog` functie en `shouldLogScope`**

De scope-filtering is niet meer nodig - alles gaat per sessie.

**Step 3: Verwijder `logger.dir` uit settings**

Logs gaan nu naar `{memoryDir}/sessions/`, niet naar een aparte dir.

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor: replace flat jsonl logging with session-based logging"
```

---

### Task 5: Verifieer en test

**Step 1: Type check**

```bash
bunx tsc --noEmit
```

Verwacht: geen nieuwe errors (bestaande Bun type errors zijn OK).

**Step 2: Handmatige test**

Start OpenCode, enable logger, maak een memory aan, spawn een subagent. Check:
- `.opencode/memory/sessions/{slug}/main.jsonl` bestaat
- Subagent log bestand bestaat met juiste prefix
- Curated memories in `.opencode/memory/*.logfmt` ongewijzigd

**Step 3: Commit**

```bash
git add -A
git commit -m "test: verify session hierarchy logging"
```
