# JARVIS Cognitive Engine V3 Architecture

> **Historical design doc.** This describes an earlier, larger architecture that predates the current Docker/FastAPI/Express implementation and has since been replaced. For what actually exists today, see [README.md](README.md) and [docs/architecture/ROADMAP.md](docs/architecture/ROADMAP.md).

## 1. High-Level Overview
JARVIS V3 is a multi‑layer, event‑driven cognitive platform. It is built around five core abstractions: Goal, Task, Capability, Event, and Memory. The architecture separates strategic reasoning (Executive Mind) from deterministic execution (Planner, Scheduler, ChiefOfStaff) and specialised work (Capabilities / Departments).

## 2. Key Layers

### Executive Intelligence Layer
- **Executive Mind**: Creates Goals, interprets user intent, and manages the high‑level conversation.
- **Executive Board**: Contains reasoning engines (Strategy, Planning, Risk, etc.) that assist the Executive Mind.

### Execution Layer
- **Planner**: Receives a Goal, queries the Capability Registry, and produces a structured Plan (list of Tasks).
- **Scheduler (ChiefOfStaff)**: Orders Tasks by priority, resolves dependencies, enforces budgets, and dispatches Tasks to Departments.
- **State Machine**: Governs the universal lifecycle of all Goals and Tasks (Created → ... → Archived).
- **Retry Engine**: Handles Task failures according to policies (exponential backoff, max retries).

### Capability Layer
- **Capability Registry**: Discovers, versions, and health‑checks all executable abilities.
- **Tool Registry** (Alias): Provides compatibility with legacy tools, but all new functionality is registered as Capabilities.
- **Departments** (Research, Coding, System): Provide the concrete execution of capabilities, but they are a communication metaphor.

### Infrastructure Layer
- **Event Bus**: The nervous system. All communication is structured and event‑driven.
- **Digital Twin**: Maintains a state snapshot (hardware, capabilities, environment) stored in Memory.
- **Memory System**: Follows a formal pipeline (Conversation → Working → Episode → Review → Consolidation → Semantic → Archive).
- **Synapse Interface**: The exclusive, deterministic gateway to the OS. Enforces security policies.
- **SecurityModule**: Validates paths, commands, and permissions.
- **SecureMemoryStore**: Stores embeddings, events, and conversations (PostgreSQL with pgvector or SQLite fallback).

## 3. Data Flow
User → Executive Mind → Goal → Planner → Tasks → ChiefOfStaff → Capabilities → Department → Synapse → OS

Every step emits Events. Results flow back via Events and are stored in Memory.

## 4. Mermaid Diagram (Internal Reference)
```mermaid
graph TD
    User((User)) --> EM[Executive Mind]
    EM --> Goal[Goal]
    Goal --> Planner[Planner]
    Planner --> Tasks[Tasks]
    Tasks --> CoS[Chief of Staff (Scheduler)]
    CoS --> Registry[Capability Registry]
    Registry --> Dept[Departments]
    Dept --> Synapse[Synapse Interface]
    Synapse --> OS[Phoenix OS]

    EM --> EB[Event Bus]
    Planner --> EB
    CoS --> EB
    Dept --> EB
    EB --> Memory[Memory Pipeline]
    Memory --> Twin[Digital Twin]
