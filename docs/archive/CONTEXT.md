# Jarvis OS – Project Context

## 🧠 Project Status (as of 2026-07-13)

- **Location**: `/mnt/jarvis_home/jarvis-os` (on the 1TB D drive)
- **Docker**: Running with 3 services (postgres, tts, api). Docker root moved to `/mnt/jarvis_home/docker` – no more OS drive space issues.
- **API**: Stable – responds to `/health`, `/api/chat`, `/api/tts`, `/api/transcribe`, etc.
- **LLM**: Model loaded (`/app/models/dolphin-2_6-phi-2.Q4_K_M.gguf`). Sometimes fails to produce tool‑calls, but falls back to template response.
- **Web UI**: Fully functional at `http://localhost:8000` – voice, wake word, streaming, TTS.

---

## ✅ Completed Phases

### Phase 0 – Governance (Complete)
- Constitution, Development Constitution, Operational Policies, Execution Model, Core Abstractions defined.
- Architecture Review process established.

### Phase I – Architectural Consolidation (Complete)
- Goals, Tasks, Capabilities, Events, Memory as first‑class objects.
- Unified Capability Registry (with backward‑compatible `ToolRegistry` alias).
- DigitalTwin stores state snapshots in Memory.
- State machine introduced (ExecutionState, PlatformState).

### Phase II – Core Abstractions (Complete)
- Task ownership enforced (every Task belongs to a Goal).
- Planner introduced (`src/execution/planner.py`) – creates Tasks from Goals.
- ChiefOfStaff updated to enforce Goal ownership and use formal states.
- `priority` field removed from Task (moved to GoalBudget).
- All code aligned with the five core abstractions.

### Phase III – Execution Platform (Complete)
- Planner creates a structured plan (list of Tasks) for each Goal.
- ChiefOfStaff (Scheduler) dispatches Tasks to departments.
- Retry logic integrated (max retries, exponential backoff planned).
- Budget system is defined, but enforcement is still limited (will be expanded in later phases).
- Event vocabulary expanded (PlanCreated, TaskRejected, etc.).

---

## ✅ Working Features
- **`execute:` command** – runs any shell command through `system_control` (tested with `echo`, `git` push).
- **Web UI** – full voice, wake‑word (Porcupine/annyang), TTS, streaming, theme toggle.
- **Memory** – embeddings, semantic search, SQLite/Postgres, consolidation pipeline.
- **User management** – registration, login, API key authentication.
- **TTS proxy** – via Edge TTS container.
- **Transcription** – Whisper (tiny) for voice input.
- **Capability registry** – 15 capabilities registered (research, coding, system, weather, calendar, email, etc.).
- **DigitalTwin** – hardware, capabilities, environment stored as MemoryRecords.
- **Event Bus** – standard vocabulary, audit logging.

---

## 📁 Key Files (Current)
| File | Purpose |
|------|---------|
| `src/api.py` | FastAPI entry point, streaming, auth |
| `src/v2_main.py` | Engine initialisation, registries, departments |
| `src/executive/mind.py` | Goal creation, fast‑path, LLM ReAct, Planner integration |
| `src/execution/planner.py` | Creates Tasks from Goals |
| `src/executive/chief_of_staff.py` | Task scheduling, retries, state management |
| `src/core/tools.py` | Unified Capability Registry |
| `src/core/models.py` | Core data models (Goal, Task, Capability, Event, Memory) |
| `src/bridge/synapse.py` | Secure system command execution |
| `src/core/security.py` | Path/command validation, audit |
| `src/llm_engine.py` | Model loading, inference, simulation |
| `src/templates.py` | System prompt and formatting |
| `src/static/index.html` | Full web UI |
| `governance/core_abstractions.md` | Five core abstractions (Goal, Task, Capability, Event, Memory) |
| `CONSTITUTION.md`, `DEVELOPMENT_CONSTITUTION.md`, `EXECUTION_MODEL.md`, `OPERATIONAL_POLICIES.md`, `ARCHITECTURE.md` | Governance documents |

---

## ⚠️ Known Issues / Limitations
- **LLM tool‑call generation** – the `phi-2` model sometimes fails to output `<tool_call>` tags. The prompt has been improved, but this is a model limitation. Workaround: use `execute:` for system commands.
- **Multi‑step planning** – Planner currently creates only one Task per Goal. This will be enhanced in later phases.
- **`psycopg2` not installed** – falls back to SQLite. Works for now; we can install it later for PostgreSQL performance.
- **Budget enforcement** – defined but not yet fully implemented in the Scheduler. Will be expanded in Phase IV/V.

---

## 🧪 Test Commands
```bash
# Greeting
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Hello Jarvis"}'

# Research (uses Planner & LLM)
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Research the future of AI"}'

# execute: system command
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "execute: echo Hello from Jarvis"}'
cat > CONTEXT.md << 'EOF'
# Jarvis OS – Project Context (Updated 2026-07-14)

## 🧠 Current Status
- **Phases I‑IV complete**. Phase V (Knowledge Platform) is next.
- **API**: Stable, responds to `/api/chat`, `/health`, etc.
- **LLM**: Model loaded, fallback works.
- **Web UI**: Fully functional at `http://localhost:8000`.

## ✅ Completed Phases
- **Phase 0**: Governance (Constitution, Development Constitution, etc.)
- **Phase I**: Architectural Consolidation (Goals, Tasks, Capabilities, Events, Memory)
- **Phase II**: Core Abstractions (Planner, State Machine, Budgets)
- **Phase III**: Execution Platform (Scheduler, Retry Engine)
- **Phase IV**: Capability Platform (Contract, Context, Providers, Registry, Resolver, Execution, Confidence, Health)

## 🧩 Key Components (Current)
- **Executive Mind**: Creates Goals, manages fast‑path, LLM ReAct.
- **Planner**: Creates Tasks from Goals.
- **ChiefOfStaff**: Schedules Tasks to departments.
- **Capability Registry**: Stores manifests, implementations, health, confidence.
- **Capability Resolver**: Scores and selects the best capability.
- **Capability Execution**: Invokes capabilities with retries, timeouts.
- **Infrastructure Health**: Centralised health monitoring.

## 📁 New Directories
- `src/capabilities/` – Capability Platform (contract, context, manifest, registry, resolver, execution, providers, budgets, policies, events, sdk).
- `src/infrastructure/` – Health monitoring.

## 🚀 Next Phase
**Phase V: Knowledge Platform** – enhance memory consolidation, sleep learning, compression.

## 🧪 Test Commands
```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Hello Jarvis"}'
# Jarvis OS – Project Context (2026-07-14)

## Project Status

- **Phase 0**: Governance (complete)
- **Phase I**: Architectural Consolidation (complete)
- **Phase II**: Core Abstractions (complete)
- **Phase III**: Execution Platform (complete)
- **Phase IV**: Capability Platform (complete)
- **Phase V**: Cognitive Platform (complete – architecture and integration done)

## Working Components

- API is stable and responds to `/api/chat` and `/health`.
- `execute:` commands work.
- **Goals, Tasks, Capabilities, Events, Memory** are fully implemented.
- **Planner** creates Tasks from Goals.
- **ChiefOfStaff** schedules Tasks.
- **Capability Registry** is unified.
- **Cognitive Workspace** tracks current Goal, Task, conversation, and capability results.
- **Experience Recording** stores user input and assistant responses.
- **Recall Engine** and **Cognitive Assistant** are wired in.
- **Sleep Scheduler** runs in the background.
- **Docker** root and containerd data are on the D drive.

## Upcoming Phase

**Phase VI: Executive Intelligence** – improve planning, reasoning, decision quality, and learning. This will build on the Cognitive Platform to make Jarvis smarter.

## Test Commands

```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Hello Jarvis"}'

cat > CONTEXT.md << 'EOF'
# Jarvis OS – Project Context (2026-07-14)

## 🧠 Project Status
- **Phases 0–VI complete**. System is stable and fully integrated.
- **API**: Stable, responds to `/api/chat`, `/health`, etc.
- **LLM**: Model loaded, fallback works.
- **Web UI**: Fully functional at `http://localhost:8000`.

## ✅ Completed Phases
- **Phase 0**: Governance (Constitution, etc.)
- **Phase I**: Architectural Consolidation (Goals, Tasks, Capabilities, Events, Memory)
- **Phase II**: Core Abstractions (Planner, State Machine, Budgets)
- **Phase III**: Execution Platform (Scheduler, Retry Engine)
- **Phase IV**: Capability Platform (Contract, Context, Providers, Registry, Resolver, Execution, Confidence)
- **Phase V**: Cognitive Platform (Experience, Attention, Workspace, Reflection, Learning, Knowledge, Recall, Assistant, Sleep, Health)
- **Phase VI**: Executive Model (Intent, Goals, Strategy, Planning, Decision, Delegation, Review, Adaptation)

## 🧩 Key Components
- **ExecutiveMind**: Orchestrates Intent → Goals → Strategy → Planning → Decision → Delegation → Execution → Review → Adaptation.
- **CognitiveWorkspace**: Current "mind" of Jarvis (Goal, Task, Conversation, Memories, Capability Results).
- **CapabilityRegistry**: Stores manifests, implementations, health, confidence.
- **CapabilityResolver**: Scores and selects the best capability.
- **PlanningEngine**: Creates Tasks from Goals and Strategy.
- **DecisionEngine**: Commits to a course of action.
- **DelegationManager**: Directs work to Capability and Execution Platforms.
- **AdaptationEngine**: Changes direction when conditions change.
- **KnowledgeStore**: Stores Facts, Procedures, Preferences, Relationships, Skills, Projects, Decisions, Principles.
- **RecallEngine**: Active memory API – provides suggestions, warnings, reminders.
- **CognitiveAssistant**: Subconscious of Jarvis – constant monitoring.

## 🧪 Test Commands
```bash
# Greeting
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Hello Jarvis"}'

# Research (uses full pipeline)
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Research the future of AI"}'

# execute: system command
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "execute: echo Hello from Jarvis"}'

# Jarvis OS – Project Context (Updated 2026-07-14)

## 🧠 Current Status
- **Phases 0–VI Complete** – architecture and core systems are in place.
- **API**: Stable, responds to `/api/chat`, `/health`, etc.
- **LLM**: Model loaded from `/app/host_models/dolphin-2_6-phi-2.Q4_K_M.gguf`.
- **Web UI**: Fully functional at `http://localhost:8000`.
- **Research**: ✅ `research_specialist` executes Brave Search and returns results.
- **Execute**: ✅ `execute:` commands run via `system_control` and return output.
- **Fast‑path**: Greetings and simple queries are handled directly.

## ✅ Completed Phases
- **Phase 0**: Governance (Constitution, etc.)
- **Phase I**: Architectural Consolidation (Goals, Tasks, Capabilities, Events, Memory)
- **Phase II**: Core Abstractions (Planner, State Machine, Budgets)
- **Phase III**: Execution Platform (Scheduler, Retry Engine)
- **Phase IV**: Capability Platform (Contract, Context, Providers, Registry, Resolver, Execution, Confidence)
- **Phase V**: Cognitive Platform (Experience, Attention, Workspace, Reflection, Learning, Knowledge, Recall)
- **Phase VI**: Executive Model (Intent, Goals, Strategy, Planning, Decision, Delegation, Review, Adaptation)

## 🧩 Key Components
- **ExecutiveMind**: Orchestrates Intent → Goals → Strategy → Planning → Decision → Delegation → Execution → Review → Adaptation.
- **CognitiveWorkspace**: Current "mind" of Jarvis (Goal, Task, Conversation, Memories, Capability Results).
- **CapabilityRegistry**: Stores manifests, implementations, health, confidence.
- **CapabilityResolver**: Scores and selects the best capability.
- **PlanningEngine**: Creates Tasks from Goals and Strategy.
- **DecisionEngine**: Commits to a course of action.
- **DelegationManager**: Directs work to Capability and Execution Platforms.
- **AdaptationEngine**: Changes direction when conditions change.
- **KnowledgeStore**: Stores Facts, Procedures, Preferences, Relationships, Skills, Projects, Decisions, etc.
- **RecallEngine**: Active memory API – provides suggestions, warnings, reminders.
- **CognitiveAssistant**: Subconscious of Jarvis – constant monitoring.

## 🧪 Working Features
- **`research_specialist`** – uses Brave Search API (key must be in `.env` as `BRAVE_API_KEY`).
- **`execute:`** – runs system commands via `system_control` (safe, with security policies).
- **Web UI** – full voice, wake‑word, TTS, streaming, theme toggle.
- **Memory** – embeddings, semantic search, SQLite/Postgres, consolidation pipeline.
- **User management** – registration, login, API key authentication.
- **TTS proxy** – via Edge TTS container.
- **Transcription** – Whisper (tiny) for voice input.
- **Capability registry** – 15 capabilities registered (research, coding, system, weather, calendar, email, etc.).
- **DigitalTwin** – hardware, capabilities, environment stored as MemoryRecords.
- **Event Bus** – standard vocabulary, audit logging.

## 📁 Key Files (Current)
| File | Purpose |
|------|---------|
| `src/api.py` | FastAPI entry point, streaming, auth |
| `src/v2_main.py` | Engine initialisation, registries, departments |
| `src/executive/mind.py` | Goal creation, fast‑path, LLM ReAct, direct execution for research/execute |
| `src/executive/chief_of_staff.py` | Synchronous capability execution (inline, returns result) |
| `src/core/tools.py` | Unified Capability Registry |
| `src/core/models.py` | Core data models (Goal, Task, Capability, Event, Memory) |
| `src/bridge/synapse.py` | Secure system command execution |
| `src/core/security.py` | Path/command validation, audit |
| `src/llm_engine.py` | Model loading, inference |
| `src/templates.py` | System prompt and formatting |
| `src/static/index.html` | Full web UI |
| `governance/core_abstractions.md` | Five core abstractions (Goal, Task, Capability, Event, Memory) |
| `CONSTITUTION.md`, `DEVELOPMENT_CONSTITUTION.md`, `EXECUTION_MODEL.md`, `OPERATIONAL_POLICIES.md`, `ARCHITECTURE.md` | Governance documents |

## ⚠️ Known Issues / Limitations
- **Tool parameter mismatches** – some tools (e.g., `file_manager`, `todo`) receive unexpected parameters from the LLM, causing errors. These are non‑blocking and will be addressed in a future update.
- **Multi‑step planning** – Planner currently creates only one Task per Goal. Will be enhanced in later phases.
- **`psycopg2` not installed** – falls back to SQLite. Works for now; can install later for Postgres.
- **Budget enforcement** – defined but not fully implemented in the Scheduler. Will be expanded in future phases.

## 🚀 Next Phase
**Phase VII: Human Interaction Platform**
- Enhance voice, conversation, personality, UI, notifications, clarification, multi‑modal interaction, session continuity.
- Ensure the user always experiences a single intelligence.

## 🧪 Test Commands
```bash
# Greeting
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Hello Jarvis"}'

# Research
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Research the future of AI"}'

# Execute system command
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "execute: echo Hello from Jarvis"}'

# Jarvis OS – Project Context (Updated 2026-07-14, End of Day)

## 🧠 Current Status
- **Phases 0–VI Complete**, **Phase VII‑a (Interaction Platform Foundation) Complete**.
- **API**: Stable – all endpoints functional, including `/api/chat`, `/health`, `/api/transcribe`, `/api/tts`, etc.
- **LLM**: Model loaded from `/app/host_models/dolphin-2_6-phi-2.Q4_K_M.gguf`.
- **Web UI**: Functional at `http://localhost:8000` (basic – to be enhanced in Phase VII‑c).
- **Interaction Platform**: Fully integrated – `InteractionManager`, `SessionManager`, `PersonalityEngine`, `ConversationEngine`, `NotificationManager` are live.
- **Research**: ✅ Works via full Executive Model (`Goal` → `Task` → `ChiefOfStaff` → `research_specialist` handler).
- **Execute**: ✅ Works via full Executive Model (`Goal` → `Task` → `ChiefOfStaff` → `system_control` handler).
- **Fast‑path**: Greetings and time queries still bypass the Executive for speed.
- **ReAct Loop**: Functional; tool parameter mismatches are now handled gracefully.

## ✅ Completed Phases
- **Phase 0**: Governance (Constitution, Development Constitution, Operational Policies, Execution Model).
- **Phase I**: Architectural Consolidation (Goals, Tasks, Capabilities, Events, Memory).
- **Phase II**: Core Abstractions (Planner, State Machine, Budgets).
- **Phase III**: Execution Platform (Scheduler, Retry Engine).
- **Phase IV**: Capability Platform (Contract, Context, Providers, Registry, Resolver, Execution, Confidence).
- **Phase V**: Cognitive Platform (Experience, Attention, Workspace, Reflection, Learning, Knowledge, Recall, Cognitive Assistant, Sleep Scheduler).
- **Phase VI**: Executive Model (Intent, Goals, Strategy, Planning, Decision, Delegation, Review, Adaptation).
- **Phase VII‑a**: Interaction Platform Foundation:
  - `InteractionManager` – single entry point for all user input.
  - `SessionManager` – maps user IDs to UUID sessions; stores conversation history.
  - `PersonalityEngine` – builds system prompts based on tone (professional, casual, etc.).
  - `ConversationEngine` – orchestrates dialogue and delegates to the Executive.
  - `NotificationManager` – in‑memory pub/sub for proactive messages (ready for SSE).

## 🧩 Key Components (Current)
- **InteractionManager**: Entry point for all interactions (web, voice, API, etc.).
- **SessionManager**: Manages user sessions with deterministic UUID mapping.
- **PersonalityEngine**: Generates context‑aware system prompts.
- **ConversationEngine**: Manages dialogue, streaming, and interaction flow.
- **ExecutiveMind**: Orchestrates Intent → Goals → Strategy → Planning → Decision → Delegation → Execution → Review → Adaptation.
- **ChiefOfStaff**: Synchronous capability execution with retries and direct handler support.
- **ToolRegistry**: Unified registry with 15 capabilities, all with flexible `**kwargs` handlers.
- **KnowledgeStore**: Stores facts, procedures, preferences, relationships, and memory records.
- **RecallEngine**: Active memory API for suggestions and warnings.
- **CognitiveAssistant**: Subconscious monitoring and proactive insights.

## 🧪 Working Features
- **Research**: `research_specialist` runs Brave Search via the Executive Model.
- **Execute**: `execute:` commands run system commands via `system_control` (safe, with security policies).
- **Web UI**: Basic interface with voice, TTS, streaming, and theme toggle.
- **Memory**: Embeddings, semantic search, SQLite (Postgres optional), consolidation pipeline.
- **User Management**: Registration, login, API key authentication.
- **TTS Proxy**: Edge TTS container integration.
- **Transcription**: Whisper (tiny) for voice input.
- **Capability Registry**: 15 capabilities (research, coding, system, weather, calendar, email, GitHub, notes, todo, file_manager, etc.).
- **DigitalTwin**: Hardware, capabilities, environment stored as MemoryRecords.
- **Event Bus**: Standard vocabulary with audit logging.

## 📁 Key Files (Current)
| File | Purpose |
|------|---------|
| `src/api.py` | FastAPI entry point, now routes through Interaction Platform. |
| `src/v2_main.py` | Engine initialisation, all capability registrations. |
| `src/interaction/` | Interaction Platform modules (manager, session, personality, conversation, notification). |
| `src/executive/mind.py` | ExecutiveMind – fast‑path, ReAct, and Executive Model for research/execute. |
| `src/executive/chief_of_staff.py` | Synchronous capability execution with direct handler support. |
| `src/core/tools.py` | Unified Capability Registry. |
| `src/core/models.py` | Core data models (Goal, Task, Capability, Event, Memory). |
| `src/bridge/synapse.py` | Secure system command execution. |
| `src/llm_engine.py` | Model loading and inference. |
| `src/templates.py` | Fallback system prompt (overridden by PersonalityEngine). |
| `src/static/index.html` | Web UI (minimal – to be redesigned in Phase VII‑c). |
| `governance/` | All governance documents (Constitution, Executive Model, Interaction Model, etc.). |

## ⚠️ Known Issues / Limitations
- **Multi‑step planning**: Planner currently creates only one Task per Goal – to be enhanced later.
- **Budget enforcement**: Defined but not yet fully implemented in the Scheduler – planned for future phases.
- **psycopg2 not installed**: Falls back to SQLite – works for now; can install later.
- **Session persistence**: Sessions are in‑memory only – persistence to KnowledgeStore is pending (Phase VII‑e).
- **Tool errors in ReAct loop**: Some tool parameter mismatches still appear in logs, but handlers now gracefully handle them via `**kwargs` fallbacks.

## 🚀 Next Phase: Phase VII – Interaction Platform (Remaining Sub‑phases)
- **VII‑b**: Notification Manager – add SSE endpoints for real‑time notifications.
- **VII‑c**: Presentation Layer – redesign the Web UI to be minimal, stateful, and reactive.
- **VII‑d**: Voice Engine Abstraction – wrap Whisper and TTS in a pluggable interface.
- **VII‑e**: Session Persistence – store sessions in KnowledgeStore (secure memory).

## 🧪 Test Commands
```bash
# Greeting (fast‑path)
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Hello Jarvis"}'

# Research (Executive Model)
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Research the future of AI"}'

# Execute system command (Executive Model)
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "execute: echo Hello from Jarvis"}'

# Jarvis OS – Project Context (Updated 2026-07-15)

## 🧠 Current Status
- **Phases 0–VII Complete** – all foundation and interaction layers are in place.
- **API**: Stable – all endpoints functional, including chat, notifications, voice, and session persistence.
- **LLM**: Model loaded from `/app/host_models/dolphin-2_6-phi-2.Q4_K_M.gguf`.
- **Main UI**: The Living Mind – an experimental graph‑based interface that visualizes Jarvis as a living cognitive system. Accessible at `/`.
- **Classic Chat UI**: Still available at `/chat.html` (if you keep a copy).
- **Interaction Platform**: Fully integrated – `InteractionManager`, `SessionManager`, `PersonalityEngine`, `ConversationEngine`, `NotificationManager` are live.
- **Voice Engine**: Whisper STT and Edge TTS providers are abstracted and interchangeable.
- **Session Persistence**: Sessions are stored in the KnowledgeStore and survive container restarts.

## ✅ Completed Phases
- **Phase 0**: Governance (Constitution, Development Constitution, Operational Policies, Execution Model).
- **Phase I**: Architectural Consolidation (Goals, Tasks, Capabilities, Events, Memory).
- **Phase II**: Core Abstractions (Planner, State Machine, Budgets).
- **Phase III**: Execution Platform (Scheduler, Retry Engine).
- **Phase IV**: Capability Platform (Contract, Context, Providers, Registry, Resolver, Execution, Confidence).
- **Phase V**: Cognitive Platform (Experience, Attention, Workspace, Reflection, Learning, Knowledge, Recall, Cognitive Assistant, Sleep Scheduler).
- **Phase VI**: Executive Model (Intent, Goals, Strategy, Planning, Decision, Delegation, Review, Adaptation).
- **Phase VII**: Interaction Platform
  - VII‑a: Foundation (InteractionManager, SessionManager, PersonalityEngine, ConversationEngine)
  - VII‑b: Notification Manager (SSE, event subscription)
  - VII‑c: Presentation Layer (Living Mind UI + classic chat fallback)
  - VII‑d: Voice Engine Abstraction (Whisper STT, Edge TTS)
  - VII‑e: Session Persistence (KnowledgeStore)

## 🧩 Key Components (Current)
- **InteractionManager**: Entry point for all interactions (web, voice, API, etc.).
- **SessionManager**: Manages user sessions with persistence to KnowledgeStore.
- **PersonalityEngine**: Generates context‑aware system prompts.
- **ConversationEngine**: Manages dialogue, streaming, and interaction flow.
- **ExecutiveMind**: Orchestrates Intent → Goals → Strategy → Planning → Decision → Delegation → Execution → Review → Adaptation.
- **ChiefOfStaff**: Synchronous capability execution with retries and direct handler support.
- **ToolRegistry**: Unified registry with 15 capabilities, all with flexible `**kwargs` handlers.
- **KnowledgeStore**: Stores facts, procedures, preferences, relationships, and memory records.
- **RecallEngine**: Active memory API for suggestions and warnings.
- **CognitiveAssistant**: Subconscious monitoring and proactive insights.
- **Voice Engine**: Pluggable STT (Whisper) and TTS (Edge TTS) providers.

## 🖥️ User Interfaces
- **The Living Mind** (default): Graph‑based visualisation at `/`. Nodes represent architectural components; animations show thinking, memory recall, execution, and reflection.
- **Classic Chat UI** (fallback): Available at `/chat.html` if kept.

## 🧪 Working Features
- **Research**: `research_specialist` runs Brave Search via the Executive Model.
- **Execute**: `execute:` commands run system commands via `system_control`.
- **Memory**: Embeddings, semantic search, SQLite (Postgres optional), consolidation pipeline.
- **User Management**: Registration, login, API key authentication.
- **TTS/STT**: Voice input/output with abstraction layer.
- **Notifications**: SSE streaming for task completions, failures, warnings.
- **Session Persistence**: Sessions survive restarts.

## 📁 Key Files (Current)
| File | Purpose |
|------|---------|
| `src/api.py` | FastAPI entry point, routes through Interaction Platform. |
| `src/v2_main.py` | Engine initialisation, all capability registrations. |
| `src/interaction/` | Interaction Platform modules. |
| `src/voice/` | Voice Engine abstraction. |
| `src/executive/` | ExecutiveMind, ChiefOfStaff, etc. |
| `src/core/` | Core models, tools, registry, event bus. |
| `src/static/index.html` | The Living Mind UI (default). |
| `src/static/chat.html` | Classic chat UI (optional fallback). |
| `governance/` | All governance documents. |

## ⚠️ Known Issues / Limitations
- **Multi‑step planning**: Planner currently creates only one Task per Goal – to be enhanced later.
- **Budget enforcement**: Defined but not fully implemented – planned for future.
- **psycopg2 not installed**: Falls back to SQLite – works for now.
- **Tool errors in ReAct loop**: Some parameter mismatches still appear but handlers now gracefully handle them via `**kwargs`.

## 🚀 Next Phase: Phase VIII – Environment Platform
- **File System** (read/write/list/watch)
- **Calendar & Email** (already have tools, will integrate properly)
- **Browser** (open URLs, scrape, screenshots)
- **External APIs** (weather, news, etc.)
- **Device Management** (sensors, hardware, peripherals)
- **Workspace Awareness** (active windows, files, clipboard)

## 🧪 Test Commands
```bash
# Research
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Research the future of AI"}'

# Execute
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "execute: echo Hello from Jarvis"}'

# SSE Notifications
curl -N -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  http://localhost:8000/api/notifications/stream

# Jarvis OS – Project Context (Updated 2026-07-15)

## 🧠 Current Status
- **Phases 0–VII Complete**, **Phase VIII-a (Environment Platform Foundation) Started**.
- **API**: Stable – all endpoints functional.
- **LLM**: Model loaded from `/app/host_models/dolphin-2_6-phi-2.Q4_K_M.gguf`.
- **Main UI**: The Living Mind – graph‑based visualization at `/`.
- **Classic Chat**: Available at `/chat.html`.
- **Environment Platform**: Foundation implemented – `EnvironmentManager`, `LocalFilesystemProvider` registered.
- **`file_manager` capability**: Migrated to use the Environment Platform.
- **Other capabilities**: Still using legacy direct methods; will be migrated in Phase VIII‑c/d/e/f.

## ✅ Completed Phases
- **Phase 0–VI**: Complete (Governance, Core Abstractions, Execution, Capability, Cognitive, Executive).
- **Phase VII**: Interaction Platform (Foundation, Notifications, UI, Voice, Session Persistence).
- **Phase VIII‑a**: Environment Platform Foundation
  - `src/environment/` package structure.
  - `EnvironmentManager`, `EnvironmentProvider`, domain interfaces.
  - `LocalFilesystemProvider` implementation.
  - `file_manager` capability migrated.

## 🚀 Next Steps (Phase VIII)
- **VIII‑b**: Continue migrating capabilities (Calendar, Email, GitHub, Weather, News) to use Environment Platform.
- **VIII‑c**: Implement Workspace, Projects, Browser domains.
- **VIII‑d**: Hardware and Network domains.

---

**Last updated**: 2026-07-15  
**Status**: Phase VIII‑a complete; ready for VIII‑b.


# Jarvis OS – Project Context (Updated 2026-07-15)

## 🧠 Current Status
- **Phases 0–VIII-c Complete** (up to Workspace Domain).
- **API**: Stable – all endpoints functional.
- **LLM**: Model loaded from `/app/host_models/dolphin-2_6-phi-2.Q4_K_M.gguf`.
- **Main UI**: The Living Mind – graph‑based visualization at `/`.
- **Classic Chat**: Available at `/chat.html`.
- **Environment Platform**: Fully implemented with:
  - Filesystem Domain (`file_manager`)
  - Calendar Domain (`calendar`)
  - Services Domain (`weather`, `news`)
  - Email Domain (`email`, `email_reader`)
  - GitHub provider (`github`)
  - Workspace Domain (`workspace`)
- **All capabilities** are thin wrappers over the Environment Platform.

## ✅ Completed Phases
- **Phase 0–VI**: Complete (Governance, Core Abstractions, Execution, Capability, Cognitive, Executive).
- **Phase VII**: Interaction Platform (Foundation, Notifications, UI, Voice, Session Persistence).
- **Phase VIII-a**: Environment Platform Foundation.
- **Phase VIII-b**: Migration of all candidate capabilities (filesystem, calendar, services, email, github).
- **Phase VIII-c**: Workspace Domain (active window, clipboard, processes, current directory).

## 🚀 Next Phase: VIII-d (Hardware & Network)
- Device discovery, sensors, battery, network status, terminal integration.

## 🧪 Test Commands
```bash
# Research
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "Research the future of AI"}'

# Workspace status
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "capability: workspace action=status"}'

# Execute system command
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "execute: echo Hello from Jarvis"}'


# Jarvis OS – Project Context (Updated 2026-07-15)

## 🧠 Current Status
- **Phases 0–VIII-d Complete** (up to Hardware & Network Domain).
- **API**: Stable – all endpoints functional.
- **LLM**: Model loaded from `/app/host_models/dolphin-2_6-phi-2.Q4_K_M.gguf`.
- **Main UI**: The Living Mind – graph‑based visualization at `/`.
- **Classic Chat**: Available at `/chat.html`.
- **Environment Platform**: Fully implemented with:
  - Filesystem Domain (`file_manager`)
  - Calendar Domain (`calendar`)
  - Services Domain (`weather`, `news`)
  - Email Domain (`email`, `email_reader`)
  - GitHub provider (`github`)
  - Workspace Domain (`workspace`)
  - Hardware & Network Domain (`hardware`)
- **All capabilities** are thin wrappers over the Environment Platform.

## ✅ Completed Phases
- **Phase 0–VI**: Complete (Governance, Core Abstractions, Execution, Capability, Cognitive, Executive).
- **Phase VII**: Interaction Platform (Foundation, Notifications, UI, Voice, Session Persistence).
- **Phase VIII-a**: Environment Platform Foundation.
- **Phase VIII-b**: Migration of all candidate capabilities.
- **Phase VIII-c**: Workspace Domain.
- **Phase VIII-d**: Hardware & Network Domain.

## 🚀 Next Phase: IX – Evolution Platform
Jarvis will be able to analyze its own architecture, suggest improvements, and guide self‑evolution with human approval.

## 🧪 Test Commands
```bash
# Hardware status
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "capability: hardware action=status"}'

# Ping
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" \
  -d '{"message": "capability: hardware action=ping host=google.com"}'


# Jarvis OS – Project Context (Updated 2026-07-15)

## 🧠 Current Status
- **Phases 0–IX-a Complete** (up to Evolution Platform Foundation).
- **API**: Stable – all endpoints functional.
- **LLM**: Model loaded from `/app/host_models/dolphin-2_6-phi-2.Q4_K_M.gguf`.
- **Main UI**: The Living Mind – graph‑based visualization at `/`.
- **Classic Chat**: Available at `/chat.html`.
- **Environment Platform**: Fully implemented with all domains (Filesystem, Calendar, Services, Email, GitHub, Workspace, Hardware & Network).
- **Evolution Platform**: Foundation in place with:
  - Architecture Analyzer (layer dependency checks)
  - Code Quality Analyzer (complexity, documentation, large files)
  - Recommendation Engine (generates actionable suggestions)
  - Approval workflow (propose, approve, reject)
  - REST API endpoints for analysis, recommendation generation, and approval.
- **All capabilities** are thin wrappers over the Environment Platform.

## ✅ Completed Phases
- **Phase 0–VI**: Complete (Governance, Core Abstractions, Execution, Capability, Cognitive, Executive).
- **Phase VII**: Interaction Platform (Foundation, Notifications, UI, Voice, Session Persistence).
- **Phase VIII**: Environment Platform (all domains + providers).
- **Phase IX-a**: Evolution Platform Foundation:
  - `EvolutionManager`
  - `ArchitectureAnalyzer` (layer violations)
  - `CodeQualityAnalyzer` (metrics, documentation, complexity)
  - `RecommendationEngine`
  - `ApprovalEngine`
  - Full REST API for analysis and approval workflow.

## 🚀 Next Phase: IX-b (Architecture Analysis Enhancement)
- More detailed dependency analysis.
- Circular dependency detection.
- Governance compliance reporting.
- Integration with KnowledgeStore for persistent analysis history.

## 🧪 Test Commands
```bash
# Run architecture analysis
curl -X POST http://localhost:8000/api/evolution/analyze/architecture \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918"

# Run quality analysis
curl -X POST http://localhost:8000/api/evolution/analyze/quality \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918"

# Generate recommendations
curl -X POST "http://localhost:8000/api/evolution/recommendations/generate" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918"

# List recommendations
curl -X GET "http://localhost:8000/api/evolution/recommendations" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918"

# Propose a recommendation (replace ID)
curl -X POST "http://localhost:8000/api/evolution/recommendations/779c5c22-56bd-4877-a5d0-dfb8c444c377/propose" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918"

# Approve a recommendation (replace ID)
curl -X POST "http://localhost:8000/api/evolution/recommendations/779c5c22-56bd-4877-a5d0-dfb8c444c377/approve" \
  -H "X-API-Key: c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918"

# Jarvis OS – Project Context (Updated 2026-07-15)

## 🧠 Current Status
- **Phases 0–X-a Complete** (up to Ecosystem Platform Foundation).
- **API**: Stable – all endpoints functional.
- **LLM**: Model loaded from `/app/host_models/dolphin-2_6-phi-2.Q4_K_M.gguf`.
- **Main UI**: The Living Mind – graph‑based visualization at `/`.
- **Classic Chat**: Available at `/chat.html`.
- **Environment Platform**: Fully implemented.
- **Evolution Platform**: Complete (all sub‑phases).
- **Ecosystem Platform**: Foundation in place – plugin discovery, lifecycle, registry, API.

## ✅ Completed Phases
- **Phase 0–IX**: Complete (Governance, Core Abstractions, Execution, Capability, Cognitive, Executive, Interaction, Environment, Evolution).
- **Phase X-a**: Ecosystem Platform Foundation:
  - Plugin Registry
  - Discovery Engine
  - Lifecycle Manager
  - Health monitoring
  - API endpoints for install, activate, deactivate, remove, list, health

## 🚀 Next Phase: X-b (SDK)
Developer toolkit, interfaces, templates, testing framework.

## 🧪 Test Commands
```bash
# Discover plugins
curl -X POST http://localhost:8000/api/ecosystem/discover \
  -H "X-API-Key: ..."

# Install a plugin
curl -X POST "http://localhost:8000/api/ecosystem/install?name=my_plugin&version=1.0.0" \
  -H "X-API-Key: ..."

# List plugins
curl -X GET "http://localhost:8000/api/ecosystem/plugins" \
  -H "X-API-Key: ..."

# Activate plugin
curl -X POST "http://localhost:8000/api/ecosystem/plugins/123/activate" \
  -H "X-API-Key: ..."
