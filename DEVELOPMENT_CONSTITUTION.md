# Development Constitution – Jarvis OS

## Principle 1: Architecture Over Features
Every change must strengthen the architecture. If a feature cannot be built without weakening the architecture, defer it.

## Principle 2: Abstraction Over Implementation
Build abstractions that enable many future features. Do not build for a single use case.

## Principle 3: State Machines Over Implicit Transitions
Every lifecycle (Goals, Tasks, Platform) must be governed by a formal state machine.

## Principle 4: Capabilities Over Departments
Capabilities are first‑class objects. Departments are a communication metaphor. The implementation must revolve around capabilities.

## Principle 5: Goals Over Requests
Every interaction produces a Goal. Tasks belong to Goals. No Task may exist independently.

## Principle 6: Events Over Direct Calls
Use events for cross‑component communication. Direct calls are only for internal component methods.

## Principle 7: Budgets Over Hardcoding
All execution must respect budgets (time, token, priority, etc.). No hardcoded limits.

## Principle 8: Memory Lifecycles Over Ad‑hoc Storage
Memory follows the formal pipeline: Conversation → Working → Episode → Review → Consolidation → Semantic → Archive.

## Principle 9: Review Every Change
Every substantial change must pass an Architecture Review. The review must answer:
- What architectural principle does this support?
- Does it introduce a new abstraction, or strengthen an existing one?
- Will it make future capabilities easier to build?
- Does it reduce or increase conceptual complexity?
- If removed, would the architecture still be stronger because of the work?

## Principle 10: Simplicity Over Complexity
If a change does not reduce future complexity while increasing future capability, reconsider it. Prefer deleting code over adding code.
