# MCP Capability Architecture — Design Spec

**Roadmap:** Phase 4 of `docs/architecture/ROADMAP.md` ("From 18 hand-coded
tools toward real capability scale"). The roadmap itself frames this phase
differently from Phases 1-3: *"This phase is a design project, not a
feature; its 'done' is a decision, not a merge."* This document, plus the
implementation plan that follows it, are that decision — no code from this
plan is implemented in this pass.

**Note on the roadmap's own numbers:** the roadmap text says "18" hand-coded
tools "as of this writing." As of Phase 3's completion, the actual count in
`src/execution/tools.ts` is 24 (`github_get_repo_or_file`,
`github_create_issue`, `send_email`, `speak_text`, `decompose_plan`,
`calendar_list_events`, `calendar_create_event`, `get_briefing`,
`list_files`, `read_file`, `write_file`, `query_knowledge_graph`,
`reflect_on_self`, `get_news`, `search_web`, `queue_feature_request`,
`get_security_status`, `propose_command`, `view_screen`, `display_content`,
`set_objective`, `list_objectives`, `update_objective_status`,
`record_command_outcome`). The gap the roadmap describes — one hand-written
`case` per tool in one `switch` statement, each requiring a code change and
a PR — is unchanged and, if anything, more true today than when the
roadmap was written.

## The gap

Every one of those 24 tools is: declared in a static `TOOL_DECLARATIONS`
array, gated via a compile-time `PERMISSION_BY_TOOL` map, and executed via
one hand-written `case` in `executeTool`'s `switch`. Adding a 25th tool
means writing code, opening a PR, and shipping a new container image. The
vision's own language — "orchestrating millions of capabilities" — is
structurally incompatible with this mechanism at any achievable rate of
PRs. Getting to real scale requires capabilities that are independently
deployable and independently reviewable services Jarvis calls out to at
runtime, not compiled into the same binary.

## Scope of this document

Per the decisions made during brainstorming:

1. **Mechanism:** Jarvis becomes a real [MCP](https://modelcontextprotocol.io)
   (Model Context Protocol) client — the protocol the wider industry
   (Anthropic, OpenAI, and others) is converging on for exactly this
   problem — rather than a Jarvis-specific custom registration scheme.
   Adopting the standard means any MCP-compliant server, first-party or
   third-party, can be registered without Jarvis needing to speak a
   private dialect.
2. **This pass produces a design + implementation plan only.** No MCP
   client code, no schema migration, no new dependency is added to the
   codebase in this pass. The plan that follows this spec is real,
   complete, and ready to execute in a future pass — but executing it is
   a separate, explicit decision, matching the roadmap's own framing.
3. **Trust model:** registering a new MCP *server* is its own explicit,
   human-gated action — the same philosophy as every consequential action
   already in this codebase (`propose_command`, `queue_feature_request`).
   There is no scenario in this design where a server becomes trusted
   without an admin's explicit approval, and no scenario where an
   unreachable/misbehaving server is marked approved.

**Out of scope for this document** (deferred to whenever this plan is
actually executed, or later): the actual MCP client implementation, any
real third-party MCP server integration, a UI for browsing available MCP
servers/marketplaces, auto-discovery of MCP servers, and any autonomous
(non-admin-gated) registration path.

## Architecture

Four new pieces, one existing system extended — no existing tool's
behavior changes.

### 1. `mcp_servers` table (new)

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  registered_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  last_connected_at TIMESTAMPTZ,
  last_error TEXT
);
```

`status` lifecycle: `pending` → `approved` (connection test succeeded, tools
cached) or `rejected` (admin declined) or `error` (was approved, but the
most recent reconnect attempt failed — see Error Handling) → `disabled`
(admin explicitly turned it off). This is a brand-new table, so (unlike
Phase 3's `command_proposals` migration) a plain `CREATE TABLE IF NOT
EXISTS` is sufficient — there is no existing live table to migrate.

### 2. `src/execution/mcp-registry.ts` (new)

Owns the full lifecycle of a registered server:

- `proposeMcpServer(name, url, registeredBy): Promise<McpServerRow>` —
  inserts a `pending` row. Mirrors `command-proposals-repo.ts`'s
  `addCommandProposal` exactly.
- `approveMcpServer(id, approvedBy): Promise<McpServerRow | null>` — the
  human-gated step. Before flipping `status` to `approved`, this function
  actually connects to the server (MCP's `initialize` handshake) and calls
  `tools/list`. If the connection or handshake fails, the row is left
  `pending` (or moved to a rejected-equivalent state) and the function
  returns an error describing what failed — **a server is never marked
  approved on the strength of the admin's click alone; the connection has
  to actually work first.** On success, the fetched tool schemas are
  validated (see Security below) and cached in-memory, keyed by server id.
- `listApprovedServers(): Promise<McpServerRow[]>` / `disableMcpServer(id)`
  — administrative listing/disabling, mirroring existing repo patterns.
- `getCachedMcpTools(): McpToolDescriptor[]` — returns the flattened,
  validated tool list across all currently-connected approved servers, for
  merging into `TOOL_DECLARATIONS` each chat turn. Degrades to `[]` (never
  throws) if the cache is empty or a server has gone unreachable since
  connection — Jarvis's built-in 24 tools are never affected by an MCP
  server's problems.
- `callMcpTool(serverId, toolName, args): Promise<McpToolCallResult>` — the
  actual `tools/call` request, with a bounded timeout (proposed: 10s,
  matching the general principle that no single tool call should be able
  to hang a chat turn indefinitely). Returns a clean error result (never
  throws past this boundary) on timeout, connection failure, or a
  malformed response.

### 3. Dynamic capability namespacing

This section covers two *different* kinds of capability, worth
distinguishing precisely so the implementation plan doesn't conflate them:

**The static one:** `system.mcp_manage` (gating `propose_mcp_server` and
server approval/disable) is a normal, compile-time addition to
`ALL_CAPABILITIES` — exactly like every capability added in Phases 2-3
(`objectives.write`, `system.execute`, etc.). It needs the same one-line
addition and gets the same automatic admin backfill every existing
capability already gets, with no further change.

**The dynamic ones:** each MCP tool becomes its own capability string,
`mcp.<serverName>.<toolName>` (e.g. `mcp.github-mcp.search_issues`).
These are deliberately just a naming convention, not a new type —
investigation during brainstorming confirmed `hasGrant`/`grantCapability`/
`revokeCapability` in `src/execution/permissions.ts` already take plain
`string` parameters, not a value constrained to the compile-time
`ALL_CAPABILITIES` union, so **the grant mechanism itself needs zero
changes for these.** What does need to change: `loadGrantsFromDb`'s
admin-backfill step (`permissions.ts`, the loop that grants admin anything
in `ALL_CAPABILITIES` it doesn't already have) currently only scans that
static array. It needs a second pass that also backfills admin for any
`mcp.*` capability from a currently-approved server's currently-cached
tool list that admin doesn't already hold — preserving the exact
"admin gets everything by default, immediately, on every restart" property
every built-in capability already has, without hardcoding MCP capability
names anywhere.

### 4. Dynamic tool merging into the chat loop

`TOOL_DECLARATIONS` (a static array today) is not modified — a new
function, `getAllToolDeclarations()`, returns `TOOL_DECLARATIONS`
concatenated with `mcpRegistry.getCachedMcpTools()` mapped into the same
`FunctionDeclaration` shape, called fresh each time a chat turn builds its
Gemini function-calling request. `executeTool`'s dispatch gains one new
branch: if `name` doesn't match a static `case` and isn't a known MCP tool
either, today's existing `"Unknown tool"` error still fires; if it *is* a
known MCP tool, the permission check runs exactly as it does today
(`hasGrant(username, "mcp.<server>.<tool>")`) before `mcpRegistry
.callMcpTool(...)` is invoked instead of a switch case.

## Data flow

1. An admin (directly, or Jarvis relaying a request the admin made in
   chat — mirroring `propose_command`'s UX) proposes a server by name +
   URL. Row lands `pending`.
2. Admin approves via the same kind of admin-only route
   `command_proposals`' approve endpoint already uses. `approveMcpServer`
   actually connects and fetches `tools/list` as part of approval, not
   after it.
3. On success: tools are cached, namespaced capabilities exist (implicitly
   — nothing needs to "create" them beyond the namespacing convention),
   and the next `loadGrantsFromDb`-style backfill (or an equivalent
   triggered right after approval, not just at boot) grants them to admin.
4. Every subsequent chat turn's tool declarations include the merged set;
   `executeTool` routes an MCP tool call to `callMcpTool` after the same
   grant check every built-in tool already goes through.
5. If a previously-approved server later becomes unreachable,
   `getCachedMcpTools()` still returns its last-known tool list (so a
   transient blip doesn't silently revoke capabilities), but
   `callMcpTool` will surface a clean timeout/connection error on
   the actual call — the tool "exists" from Gemini's perspective but
   fails gracefully when invoked, exactly like any other backend outage
   already handled elsewhere in this codebase (Postgres, Gemini itself).

## Error handling / security & stability

*Standing directive: every update should make Jarvis more secure and
stable, not just add capability.*

- **No trust bypass.** A server is approved only after a live connection
  test succeeds — there is no path from "admin clicked approve" straight
  to "trusted" without Jarvis itself verifying the server responds and
  speaks MCP correctly.
- **Schema validation on ingest.** A malicious or buggy MCP server could
  return an oversized, malformed, or adversarially-crafted tool schema via
  `tools/list`. Before caching, `mcp-registry.ts` validates each tool's
  name (bounded length, safe characters, used verbatim in the
  `mcp.<server>.<tool>` capability string so it must be safe to embed
  there), description (bounded length), and parameter schema shape
  (rejecting anything that isn't a well-formed JSON Schema object) —
  rejecting the individual malformed tool (not the whole server) so one
  bad tool declaration doesn't take down an otherwise-good server's other
  tools.
- **Bounded blast radius per call.** `callMcpTool`'s timeout means a slow
  or hung MCP server can only ever delay the one tool call that invoked
  it — never the rest of that chat turn's processing, and never any other
  tool call, built-in or MCP-sourced.
- **New dependency, disclosed.** This design requires adding
  `@modelcontextprotocol/sdk` (the official TypeScript MCP SDK) as a new
  dependency. This is new supply-chain surface and should be named
  explicitly in the implementation plan's Global Constraints, even though
  it's the same SDK the wider industry already depends on for this exact
  purpose.
- **No change to existing tools' trust or behavior.** All 24 built-in
  tools keep their exact current declaration/gating/execution path
  unchanged — `getAllToolDeclarations()` and the new `executeTool` branch
  are additive, not a rewrite of the existing switch.
- **Audit parity.** Every MCP tool call goes through the same
  `observation.logAuditEvent` call every built-in tool call already goes
  through (via the shared success/failure tail of `executeTool`), with
  the server name available in the capability string itself for
  filtering — no separate, weaker audit path for MCP-sourced tools.

## Testing

Following this codebase's established convention: registry functions that
need a live network connection or Postgres (`proposeMcpServer`,
`approveMcpServer`, `callMcpTool`) degrade safely with no live
DB/network in the test process, exactly like every repo function added in
Phases 1-3. `getCachedMcpTools()` and the tool-schema-validation logic are
pure/synchronous where possible and get direct unit tests with no I/O.

**A real end-to-end round-trip against an actual MCP server is explicitly
out of scope for this pass** — this document and its implementation plan
are the full deliverable; live verification against a real external MCP
server happens only if and when this plan is actually executed, which is
a separate decision from writing it.

## Decisions on the two forks raised during drafting

Self-review of this document flagged two points that were initially left
open; per this project's own ambiguity-check convention, both are resolved
here rather than left for the implementation plan to guess at:

- **`proposeMcpServer` is reachable via a chat tool**, mirroring
  `propose_command` exactly, named `propose_mcp_server`. It is gated by a
  **new** capability, `system.mcp_manage` — deliberately distinct from
  `system.execute`. Registering a new capability *source* is a
  meaningfully different, arguably higher-stakes action than running one
  already-reviewed command (it introduces an entire new class of future
  tool calls, each of which then gets its own `mcp.*` grant), which is the
  same reasoning this codebase already applied when it split
  `security.read` from `security.manage` — a new capability for a
  distinct class of action, not reuse of an adjacent one.
- **Reconnect/health-check cadence**: a new scheduled job (via
  `scheduler.ts`'s existing `registerJob` pattern, alongside
  `email-watch`/`proactive-briefing`/`proactive-self-reflection`), running
  every 30 minutes, that re-attempts `tools/list` for every `approved`
  server. A single failure does not flip the server out of `approved` or
  drop its cached tools (matching the "last-known tool list survives a
  transient blip" behavior already described above) — only after 3
  consecutive failures does the job flip `status` to `'error'` and log it,
  giving the admin a real signal without one bad network blip causing
  capability flapping.
