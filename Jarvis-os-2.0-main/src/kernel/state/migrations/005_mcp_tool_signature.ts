import type { Migration } from "./runner.js";

// Closes a real TOCTOU-style gap in MCP server trust: approveMcpServer()
// only ever vets a server's tool definitions (name/description/schema) at
// the moment an admin approves it — but the health-check job
// (scheduler.ts's "mcp-health-check", every 30 min) re-lists an already-
// approved server's tools and silently overwrites the in-memory cache with
// whatever it gets back, with no comparison against what was actually
// vetted. A malicious or later-compromised server could declare a narrow,
// benign tool set to get approved, then change its tool definitions any
// time afterward (add a new tool, widen a schema, rewrite a description)
// and have Jarvis start offering the new, never-reviewed definitions to
// the LLM within 30 minutes — no human ever looks at the change.
//
// This column is the persisted baseline mcp-registry.ts's
// refreshServerConnection now compares against on every health-check tick:
// a mismatch evicts the server from the tool cache and flips it to
// 'error' (which — see markMcpServerApproved's own WHERE clause — requires
// a real admin re-approval before it's trusted again), instead of quietly
// accepting the new definitions. Persisted rather than kept only in the
// in-memory toolCache so the comparison survives a process restart too.
const migration: Migration = {
  id: "005_mcp_tool_signature",
  description:
    "Add mcp_servers.approved_tools_signature — the persisted baseline of an approved server's vetted tool definitions, so the health-check job can detect a post-approval mutation instead of silently trusting it.",
  up: async (client) => {
    await client.query(`ALTER TABLE mcp_servers ADD COLUMN approved_tools_signature TEXT;`);
  },
};

export default migration;
