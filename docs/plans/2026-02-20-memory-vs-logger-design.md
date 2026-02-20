# Memory vs Logger Design

## Goal

Keep curated memory and raw logging as separate capabilities while supporting configurable storage paths, global defaults, and project-level overrides.

## Decisions

- `memory_*` remains curated semantic storage (`decision`, `preference`, etc.).
- Logging is separated into `memory_logger_*` tools and JSONL files.
- Config is layered: global defaults + project override.
- Path placeholders are supported to avoid hardcoded `.opencode/memory` only setups.

## Config Model

- Global file: `~/.config/opencode/memory-log.json`
- Project file: `.opencode/memory-log.json`
- Merge order: defaults -> global -> project -> inline config hook (`memory_log`)

Supported placeholders:

- `${home}`
- `${project}` / `${workspace}`
- `${date}`
- `${env:VAR}`

## Logger Model

- Separate JSONL storage directory from memory files.
- Scope-based filtering (`logger.scopes`), with `*` or empty list meaning broad logging.
- Runtime toggling via tool:
  - `memory_logger_set`
  - `memory_logger_status`
- Persistence options in `memory_logger_set`: session, project, global.

## Event Context

JSONL events include at least:

- timestamp
- session id
- tool/call ids when relevant
- agent hint when available

This preserves subagent traceability by session/call context without mixing it into semantic memory.
