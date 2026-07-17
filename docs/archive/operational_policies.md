# Operational Policies

## Purpose

This document defines implementation‑specific rules for security, memory, auditing, tool execution, and error handling.

These policies may evolve frequently. They are not part of the Jarvis Constitution.

## Security

### System Control

- The `system_control` tool operates under a fixed, immutable security policy.
- Jarvis may request actions, but the SynapseInterface enforces permissions.
- Jarvis may not modify its own security policy.
- All system commands, file reads, and file writes are validated against whitelists before execution.

### User Data Isolation

- Each user's conversation history, memory, and files are stored with a `user_id`.
- No user may access another user's data.
- APIs authenticate via API keys; admin access uses a separate key.

### Audit Logging

- Every system command, file access, tool call, and security decision is logged.
- Audit logs are stored in secure memory and cannot be modified by Jarvis.
- Audit logs are searchable by admin users.

## Memory

### Storage

- Memory is stored in PostgreSQL (production) with SQLite fallback.
- Each record includes `user_id` for isolation.
- Embeddings are generated and stored for semantic search.

### Consolidation (Sleep‑Learning)

- Episodic memories are not promoted to semantic memory without verification.
- High‑importance records move to "pending review."
- Human approval is required for final consolidation.
- Automated programmatic validation is used when available.

## Tool Execution

### Tool Calling

- Jarvis may call tools via `<tool_call>` tags in its response.
- Tools are registered in the ToolRegistry.
- Tool handlers are either deterministic functions or routed through departments.
- Tool results are returned to Jarvis for final synthesis.

### Multi‑Step Reasoning

- The ReAct loop allows up to `MAX_TOOL_ITERATIONS` tool calls per request.
- Each iteration preserves conversation history and tool results.
- Jarvis may decide to finalize without calling more tools.

## Error Handling

- All errors are logged with full tracebacks.
- User‑facing errors are translated into plain English.
- Jarvis never exposes internal stack traces to the user.
- Emergency mode limits functionality if the system is compromised.

## Rate Limiting

- API endpoints are rate‑limited to `RATE_LIMIT` requests per minute per API key.
- Admin endpoints have separate limits (configurable).

## Versioning

- Governance documents are versioned.
- Breaking changes are announced in release notes.
- Backward compatibility is maintained for at least one major version.
