# Platform Ownership & Boundaries – Jarvis OS

This document establishes the precise operational boundaries and responsibilities for all core subsystems within the Jarvis OS architecture as part of Pass 3 (Ownership) of Phase XI.

---

## 1. Executive Platform

**Responsibility:** Decides high-level actions, schedules goals, and orchestrates intent processing.

*   **Owns:**
    *   Goal Context & prioritization metrics.
    *   Executive Decision state machine.
    *   System Strategy templates.
*   **Knows:**
    *   Active system budgets and constraints.
    *   Pending user and system objectives.
*   **Uses:**
    *   Cognitive Platform (for learning, memory retrieval, and workspace state).
    *   Capability Platform (to delegate tasks to tools).
*   **Never Does:**
    *   Directly reads or writes local files.
    *   Executes native shell commands.
    *   Manages database connections.

---

## 2. Capability Platform

**Responsibility:** Executes specific, atomic operations (tools) on behalf of the Executive.

*   **Owns:**
    *   Capability Registry & tool manifests.
    *   Capability execution contracts and input validation.
*   **Knows:**
    *   Available tools and their current status (active/deprecated/unsupported).
*   **Uses:**
    *   Environment Platform (to access system APIs, shell, and hardware).
*   **Never Does:**
    *   Schedules goals or overrides executive priorities.
    *   Decides user intent.

---

## 3. Environment Platform

**Responsibility:** Interacts with the real physical or digital world.

*   **Owns:**
    *   Local calendar, email, and files access layers.
    *   Hardware and system telemetry APIs.
*   **Knows:**
    *   OS environment details, ports, file systems, and paths.
*   **Uses:**
    *   System native APIs and third-party platform libraries.
*   **Never Does:**
    *   Invokes LLM models directly.
    *   Maintains cognitive workspaces or long-term history.

---

## 4. Cognition Platform

**Responsibility:** Holds current state contexts and manages long-term learning loops.

*   **Owns:**
    *   Cognitive Workspace (Goal, Conversation, Execution, Knowledge, Capability, Environment, and Reasoning Contexts).
    *   In-memory and persistent Knowledge Stores.
*   **Knows:**
    *   Long-term memory vectors, user preferences, and semantic associations.
*   **Uses:**
    *   Observation Platform (to log reflection traces).
*   **Never Does:**
    *   Performs network operations directly without a designated Capability.

---

## 5. Interaction Platform

**Responsibility:** Handles front-facing client communications and visual sessions.

*   **Owns:**
    *   Active UI session and conversation lists.
    *   Personality & style profiles for system responses.
*   **Knows:**
    *   Connected websockets and active HTTP streams.
*   **Uses:**
    *   Executive Platform (to process chat prompts and request decisions).
*   **Never Does:**
    *   Executes goals or capabilities independently.

---

## 6. Observation Platform

**Responsibility:** Monitors system metrics, logs traces, tracks performance, and exposes diagnostics.

*   **Owns:**
    *   System Telemetry & Metrics.
    *   Detailed Decision Traces.
    *   Audit and Health logs.
*   **Knows:**
    *   Response latencies, memory capacities, and startup profiles.
*   **Uses:**
    *   In-memory logging buffers.
*   **Never Does:**
    *   Intercepts or alters system decisions (read-only observer).
