
Each stage is described below.

---

## Stage 1: Experience

**Purpose:** The raw input to the cognitive system.

**Sources:**
- User conversations
- Capability results (success, failure, output)
- System events (startup, shutdown, errors)
- Sensor data (if applicable)
- Calendar, files, API responses
- Internal events (GoalCreated, TaskCompleted, etc.)

**Form:** An `Experience` object with:
- Timestamp
- Source
- Type (conversation, capability_result, system_event, etc.)
- Raw content
- Metadata (user_id, goal_id, task_id, etc.)

---

## Stage 2: Attention

**Purpose:** Filter experiences that are worth further cognitive processing.

**Criteria for relevance:**
- User explicitly asks to remember something.
- The outcome was unexpected (e.g., a failure or a surprising success).
- Confidence changed significantly.
- The experience is tied to a high‑priority Goal.
- The experience contains new information about a known entity.
- The user expresses strong sentiment (positive or negative).

**Behaviour:** If an experience passes the attention filter, it enters the Workspace. Otherwise, it is stored as raw history but not processed further.

**Optional:** If the system is uncertain, it may ask the user: *"Is this something I should remember?"*

---

## Stage 3: Understanding

**Purpose:** Interpret the experience before it enters the Workspace.

**Understanding extracts:**
- Intent (what does the user want?)
- Entities (people, projects, capabilities, files)
- Sentiment and urgency
- Domain (coding, research, system, personal)
- Context (related to a current Goal? past Task?)
- Relationships (does this connect to other knowledge?)

**Implementation:** This is primarily done by the Executive Mind (LLM) but may be augmented by the Cognitive Workspace.

---

## Stage 4: Cognitive Workspace

**Purpose:** The current "mind" of Jarvis – the short‑term, high‑availability working set.

**Contents:**
- **Goal Context** – current Goal, its budget, and status.
- **Conversation Context** – recent messages and responses.
- **Task Context** – current Task, its progress, and history.
- **Memory Context** – retrieved memories relevant to the current situation.
- **Capability Context** – which capabilities are available and their health.
- **Planning Context** – the current plan (list of Tasks, dependencies).
- **Execution Context** – what is running, what has completed, what failed.
- **Reasoning Context** – notes, hypotheses, and candidate decisions.

**Behaviour:** The Workspace is updated in real‑time. It is the primary input for Reflection. It is also the source of data for the Executive Mind during ReAct loops.

---

## Stage 5: Reflection

**Purpose:** Review experiences and Workspace content to generate insights, hypotheses, and decisions.

**Two types of Reflection:**

### Immediate Reflection
- Triggered after every important Goal or significant event.
- Asks:
  - *What happened?*
  - *Why did it happen?*
  - *What should I remember?*
  - *What should I do differently next time?*
- Outputs: immediate insights and tentative Beliefs.

### Deep Reflection
- Runs during the Sleep Cycle.
- Reviews longer‑term patterns, contradictions, and reinforcement.
- Identifies trends (e.g., "The user frequently reverts generated code – maybe I should generate more concise code").
- Outputs: refined Beliefs and updates to Knowledge.

---

## Stage 6: Beliefs

**Purpose:** Hypotheses about the world, with confidence and evidence.

**A Belief includes:**
- **Claim** – the statement of the belief (e.g., "User prefers concise code").
- **Confidence** – a number between 0 and 1.
- **Evidence** – references to Experiences or Knowledge that support the belief.
- **Reinforcement Count** – how many times it has been supported.
- **Last Reinforced** – timestamp.
- **Source** – from which Experience or Reflection it originated.

**Behaviour:** Beliefs are mutable. They evolve over time as new evidence arrives. When confidence exceeds a threshold (e.g., 0.8), they may become Knowledge.

---

## Stage 7: Learning

**Purpose:** Convert Beliefs into Knowledge, and update existing Knowledge.

**Learning actions:**
- Promote a Belief to Knowledge (if confidence is high and evidence is strong).
- Update a Knowledge item (e.g., increase confidence, add new evidence).
- Merge duplicate Knowledge.
- Deprecate or archive Knowledge that is contradicted.
- Generate new Knowledge from patterns (e.g., "User prefers Python over Bash").

**Output:** Updated Knowledge Store.

---

## Stage 8: Knowledge

**Purpose:** Verified, structured, and explainable intelligence.

**Knowledge Types:**
- **Facts** – declarative truths (e.g., "Jarvis OS is located on /mnt/jarvis_home").
- **Procedures** – "how to" knowledge (e.g., "To push to GitHub, use execute: cd /app && git add ...").
- **Preferences** – user‑specific preferences (e.g., "User prefers concise code").
- **Relationships** – connections between entities (e.g., "User owns Jarvis OS").
- **Skills** – capabilities Jarvis has learned (e.g., "Jarvis is good at summarising").
- **Projects** – project‑specific knowledge (e.g., "The current project is Jarvis OS").
- **Decisions** – past decisions and their outcomes (e.g., "We chose PostgreSQL over SQLite for production").
- **Principles** – higher‑level heuristics (e.g., "Never overwrite files without confirmation").

**Each Knowledge item includes:**
- **Confidence** (0–1)
- **Evidence** (references to Experiences, Reflections, or other Knowledge)
- **Reinforcement Count**
- **Last Used**
- **Last Updated**
- **Verification Status** (unverified, verified, human‑verified)

---

## Stage 9: Recall

**Purpose:** Active participation in decision‑making.

**Recall is not a search. It is a proactive component that, given a Goal or Task, provides:**
- Relevant Facts
- Applicable Procedures
- User Preferences
- Past Decisions and their outcomes
- Contradictions or warnings
- Confidence estimates for the current plan

**Behaviour:** Recall injects knowledge into the Workspace and the Executive Mind before and during execution. It is the bridge between Knowledge and Decision‑making.

---

## Stage 10: Cognitive Assistant

**Purpose:** The "subconscious" of Jarvis – constantly monitoring and offering suggestions.

**Responsibilities:**
- **Suggestions** – "You might want to use the `research_specialist` capability for this."
- **Warnings** – "You are about to overwrite a file. Are you sure?"
- **Reminders** – "Don't forget to commit your changes."
- **Assumptions** – "I assume you want to use Python for this Task."
- **Contradictions** – "This capability has low confidence. Consider an alternative."
- **Confidence Estimates** – "I am 87% confident that this plan will succeed."

**Behaviour:** The Cognitive Assistant runs as a low‑priority thread, observing the Workspace and the current Plan, and offers insights without being asked.

---

## Sleep Cycle

**Purpose:** Background processing that runs during idle periods.

**Tasks:**
- Deep Reflection (as described above).
- Learning (promote Beliefs to Knowledge, update existing Knowledge).
- Health checks (metrics, duplication, degradation).
- Archiving old, unused Knowledge.
- Consolidation and compression.

**Trigger:** Either a fixed schedule (e.g., every 12 hours) or when the system is idle (low CPU/Load).

---

## Health Monitoring

**Purpose:** Ensure the Cognitive Platform is performing optimally.

**Metrics tracked:**
- Total number of Knowledge items.
- Distribution by type.
- Average Confidence.
- Duplication rate.
- Number of Contradictions.
- Average age of Knowledge.
- Usage frequency.

**Actions:** If metrics degrade, an alert is logged. The system may automatically trigger a deep consolidation or request user intervention.

---

## Explainability

**Purpose:** Every decision must be explainable.

**Traceability:** For every significant decision, Jarvis can reconstruct:
- Which Experiences contributed.
- How Attention filtered them.
- What Understanding was derived.
- What Reflection generated.
- What Beliefs were formed.
- What Knowledge was used.
- Which Cognitive Assistant suggestions were considered.
- Why a particular Capability was chosen.

This trace is stored as a **Cognition Trace** and can be reviewed by the user on request.

---

## Success Criteria

- A new developer can understand Jarvis' cognition by reading this document.
- Every subsystem in the Cognitive Platform maps to one of the defined stages.
- Jarvis can explain its decisions in plain English.
- Jarvis improves its performance over time (fewer repeated mistakes, better planning).
- Users report that Jarvis feels "intelligent" and "thoughtful".

---

## Relationship to Other Governance Documents

- **Constitution** – identity and principles.
- **Execution Model** – how work is done.
- **Core Abstractions** – Goal, Task, Capability, Event, Memory.
- **Cognitive Model** – how Jarvis learns, reasons, and improves.

These four documents together define Jarvis OS: who it is, how it acts, how it thinks, and how it is built.
