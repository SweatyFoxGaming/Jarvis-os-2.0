# Execution Model – Jarvis OS

## Overview
The Execution Model governs how Jarvis transforms a user’s intent into action, results, and memory. It is deterministic where possible, and uses AI reasoning only where judgment is required.

## Lifecycle
1. **User expresses intent** → A `Goal` is created.
2. **Planning** → The Planner queries the Capability Registry and creates a set of `Tasks` for the Goal.
3. **Scheduling** → The Scheduler (currently ChiefOfStaff) orders Tasks by priority, resolves dependencies, and dispatches them.
4. **Execution** → Tasks invoke Capabilities. Each Task transitions through the formal State Machine.
5. **Observation** → Events are emitted at every significant step.
6. **Memory** → Results and context are stored in the Memory pipeline.
7. **Completion** → The Goal is marked Completed and archived.

## State Machine
All execution objects (Goals, Tasks) follow this universal lifecycle:

**Created** → **Accepted** → **Planned** → **Ready** → **Running** → **Waiting** / **Retrying** / **Reviewing** → **Completed** → **Archived**

Failures transition to **Failed**, which may lead to **Retrying** (up to a budget limit) or **Archived**.

## Budgets
Every Goal defines an optional budget:
- Time Budget (seconds)
- Token Budget (LLM tokens)
- Priority
- Deadline
- Max Retries
- Max Parallel Tasks
- Quality Target

These budgets guide the Planner and Scheduler. They are never hardcoded into individual Capabilities.

## Platform States
The entire platform can be in one of these states:
- Booting
- Loading
- Ready
- Working
- Learning
- Sleeping
- Recovering
- Updating
- Shutdown

The UI, scheduler, and diagnostics all reference these states.

## Event Vocabulary
All subsystems communicate using a standard set of events:
- GoalCreated, GoalAccepted, GoalCompleted
- TaskPlanned, TaskStarted, TaskCompleted, TaskFailed
- CapabilityInvoked, CapabilityCompleted
- MemoryCommitted, MemoryConsolidated
- PlatformStateChanged

## Memory Pipeline
Memory is not a single storage unit. It follows this lifecycle:
1. **Conversation** – raw user‑assistant exchange.
2. **Working** – short‑term context.
3. **Episode** – structured narrative.
4. **Review** – validation and deduplication.
5. **Consolidation** – promoted to semantic.
6. **Semantic** – long‑term knowledge.
7. **Archive** – historical storage.
