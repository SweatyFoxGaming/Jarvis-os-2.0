# Core Abstractions – Jarvis OS

## Goal
- **Purpose**: Represents a user’s intent or desired outcome. Everything begins with a Goal.
- **Ownership**: Created by the Executive Mind, belongs to the user.
- **Lifecycle**: Created → Accepted → Planned → Ready → Running → Completed / Archived.
- **Responsibilities**:
  - Owns planning, execution progress, history, and final result.
  - Determines which Tasks are needed.
  - Defines budgets (time, tokens, priority).
  - Stores outcome (success/failure, summary, error).
- **Relationships**:
  - Produces Tasks.
  - Invokes Capabilities (indirectly via Tasks).
  - Generates Events (GoalCreated, GoalAccepted, GoalCompleted, etc.).
  - Contributes to Memory (episodic and semantic).

## Task
- **Purpose**: The smallest executable unit of work.
- **Ownership**: Belongs to exactly one Goal.
- **Lifecycle**: Follows the universal execution state machine (Created → Accepted → Planned → Ready → Running → Waiting → Retrying → Reviewing → Completed → Archived).
- **Responsibilities**:
  - Performs a specific Capability.
  - Reports progress.
  - Stores input and output data.
  - Records history (timeline of state transitions).
- **Relationships**:
  - Derived from a Goal.
  - Invokes exactly one Capability (or a sequence, depending on design).
  - Emits Events (TaskStarted, TaskCompleted, TaskFailed, etc.).
  - Updates Memory with results.

## Capability
- **Purpose**: Something Jarvis knows how to do.
- **Ownership**: Registered in the Capability Registry; owned by a developer or system.
- **Lifecycle**: Versioned, health‑monitored, permission‑aware.
- **Responsibilities**:
  - Accepts input (structured).
  - Produces output (structured).
  - May depend on other Capabilities.
  - Declares required permissions and resource estimates.
- **Relationships**:
  - Executed by Tasks.
  - Discovered via Capability Registry.
  - May trigger Events (CapabilityInvoked, CapabilityCompleted, CapabilityFailed).
  - May store results in Memory.

## Event
- **Purpose**: A record of something that happened.
- **Ownership**: Emitted by any subsystem; immutable.
- **Lifecycle**: Created → Observed → Archived (replayable).
- **Responsibilities**:
  - Communicates state changes between subsystems.
  - Enables auditing, logging, and debugging.
  - Provides a common language for all components.
- **Relationships**:
  - Used by all subsystems.
  - Significant events are stored in Memory (for later retrieval).
  - May trigger reactions (e.g., scheduling a new Task).

## Memory
- **Purpose**: Retained knowledge with a formal lifecycle.
- **Ownership**: Stored in the Memory Store; governed by the Knowledge Librarian.
- **Lifecycle**: Conversation → Working → Episode → Review → Consolidation → Semantic → Archive.
- **Responsibilities**:
  - Stores facts, conversations, learned patterns, and event histories.
  - Supports semantic search and retrieval.
  - Consolidates knowledge over time.
  - Ensures only verified information becomes permanent.
- **Relationships**:
  - Populated by Events and Task outputs.
  - Referenced by Goals (for context).
  - Used by Capabilities (as input).
