# Execution Model

## Purpose

This document defines how work flows through Jarvis OS.

It describes the lifecycle of a user request, from input to final response.

## High‑Level Flow


## Components

### 1. Jarvis (ExecutiveMind)

- The only intelligence the user interacts with.
- Receives user input.
- Decides whether to:
  - Respond directly (fast path).
  - Use ReAct loop with tools.
- Synthesizes final response.
- Stores conversation in memory.

### 2. Board (ExecutiveBoard)

- Strategic reasoning council.
- Consulted by Jarvis (optional).
- Provides analysis: strategy, planning, risk, resources, context, memory, ethics, world model.
- Not invoked for every request – only when Jarvis needs strategic input.

### 3. Chief of Staff

- Operational execution planner.
- Transforms vision into coordinated action.
- Schedules tasks to departments.
- Tracks task status and handles retries.

### 4. Departments

- Specialised execution units:
  - Research – deep factual research.
  - Coding – code generation and analysis.
  - System – time, hardware, system info.
- Each department processes tasks assigned by the Chief of Staff.
- Departments may use tools (via `system_control` or other APIs).

### 5. Tool Registry

- List of all tools available to Jarvis.
- Tools can be:
  - Deterministic functions (e.g., `weather` handler).
  - Routed through departments (e.g., `research_specialist`).
- Tools are invoked via `<tool_call>` tags from Jarvis.

## Request Lifecycle

1. **User sends a message** via the web UI or API.
2. **Jarvis (ExecutiveMind) receives the request**.
3. **Fast Path**:
   - If the request is a greeting or simple command (time), respond directly.
4. **ReAct Loop**:
   - Jarvis builds a prompt with tools description.
   - LLM generates a response.
   - If response contains `<tool_call>` tags, tools are executed.
   - Results are added to conversation history.
   - Loop continues until no more tool calls or iteration limit reached.
5. **Final Synthesis**:
   - Jarvis generates the final response to the user.
6. **Memory Storage**:
   - Conversation is stored in episodic memory (with `user_id`).
   - Future consolidation may promote to semantic memory.

## Task Execution Flow (Departments)

1. **ChiefOfStaff** receives a task from Jarvis (or ToolRegistry).
2. **Task is scheduled** – assigned to a department based on capability.
3. **Department Worker** processes the task.
4. **Task completes** – output stored in `task.output_data`.
5. **ChiefOfStaff** tracks completion and may trigger retries on failure.

## Memory Lifecycle

1. **Episodic Memory** – immediate conversation history.
2. **Pending Review** – important episodes (importance > 0.8) wait for verification.
3. **Semantic Memory** – verified knowledge (human‑approved or validated).
4. **Consolidation** – periodic process that moves verified records to semantic memory.

## Failure Handling

- If a tool call fails, the error is returned to Jarvis.
- Jarvis may retry, ask for clarification, or respond with an apology.
- Departments and tools are designed to be stateless and idempotent where possible.

## Scaling & Extensibility

- New departments can be registered via `DepartmentRegistry`.
- New tools can be added to `ToolRegistry` (with or without handlers).
- The execution model is event‑driven – components communicate via `EventBus`.

## Evolution

- This model is stable but may evolve as new capabilities are added.
- Any change must maintain the core principle: Jarvis is the only intelligence the user interacts with.
