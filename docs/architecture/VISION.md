# Jarvis 50-Year Vision

## Building the World's Most Trusted Intelligence

> Our vision is to create the world's most trusted autonomous intelligence—an
> operating system that evolves from a personal executive into the cognitive
> foundation for individuals, businesses, and society.
>
> Jarvis is being engineered to understand, reason, learn, and collaborate
> with people over a lifetime. It will not simply answer questions or execute
> commands; it will build knowledge, anticipate needs, coordinate complex
> systems, and help people make better decisions while remaining transparent,
> trustworthy, and aligned with human goals.
>
> As technology evolves, Jarvis will seamlessly integrate with new models,
> devices, robots, digital environments, and future computing platforms
> without losing its identity. Regardless of how users interact—through text,
> voice, augmented reality, robotics, or technologies yet to be invented—they
> will always experience a single, consistent intelligence.
>
> Our long-term ambition is to establish Jarvis as the universal cognitive
> operating system: a platform capable of orchestrating millions of
> capabilities, managing vast networks of knowledge, and empowering people and
> organizations to solve problems that are impossible to tackle alone.
>
> Success will not be measured by the number of features Jarvis possesses, but
> by the trust it earns, the decisions it improves, and the positive impact it
> has on the lives of those who rely on it.
>
> Over the next fifty years, our mission is to transform artificial
> intelligence from a reactive tool into a lifelong executive partner—one
> that grows alongside humanity and helps shape a future where intelligence is
> accessible, dependable, and designed to amplify human potential.

The vision statement above is the project owner's own, unedited, updated
2026-07-19. Everything below tracks progress against it as a checklist,
rewritten 2026-08-17 from this document's previous prose-audit form so
status is scannable rather than read paragraph by paragraph. Checked items
were live-verified against the running code as of the rewrite date, not
assumed from an earlier pass — where a claim needed re-checking, it was
re-checked directly (grepping the actual source, not trusting the last
audit's memory of it). Update this file by flipping checkboxes and adding a
one-line status note as work lands, not by rewriting prose paragraphs.

## Foundation (single-person, single-machine core) — largely done

- [x] One entry point (`/api/chat`) decides which capability a request needs — the user never has to know which "surface" an ask belongs to
- [x] Local-first LLM fallback guarantee — chat never silently falls through to a fake/simulated reply
- [x] Real step decomposition/planning reachable from chat (`decompose_plan` tool + `/api/executive/run`)
- [x] Real, revocable, Postgres-persisted capability grants — survive a restart, backfill correctly when a new capability is added
- [x] Automatic learning write path — style/mistake reflection judged and written after every real turn, no manual endpoint required
- [x] Automatic learning read path (chat) — memory hits + learned style pulled into the system prompt on the next turn
- [x] Conversation history survives an `api` container restart (Postgres-backed, rehydrates on first touch)
- [x] Local/offline speech-to-text + local TTS (whisper-cpp + the voice daemon's Faster-Whisper/Kokoro), matching chat's local-first pattern
- [x] Trust hazard fixed — the local model no longer fabricates fake tool results when it has no tool access; it routes to a real backend first or admits the limitation
- [ ] **Outcome/trust measurement** — nothing tracks whether an approved action, a piece of advice, or a proposed plan actually turned out well. The per-turn "confidence score" reflects backend health and tool-call success, not decision quality. The vision explicitly says success should be measured by "the decisions it improves" — this loop does not exist yet. Not started.

## One consistent identity across every interface — partially done

- [x] Text chat builds its system prompt from memory + identity + style context every turn
- [x] Voice (`src/interaction/voice-session.ts` — the entire pipeline was rebuilt since the last audit; the old `live-voice.ts` this gap was originally filed against no longer exists) now pulls semantic memory recall (`memoryStore.recall`) into its own system prompt, verified directly in the current source
- [ ] Voice does **not** yet call `identity.buildIdentityContext()` (learned style/self-reflection preferences) the way chat does at `src/server.ts:597` — voice and text are memory-unified but not identity-unified. This is the smallest concrete gap left: `voice-session.ts` already imports `identity.extractSelfReflection` for the write side (learning from the exchange); only the read-side call into the system prompt is missing.
- [ ] No AR/robotics/future-interface surface exists yet — nothing to unify there until one exists

## Extensible capabilities ("millions of capabilities") — architecture now exists, scale doesn't

- [x] Real MCP client architecture built since the last audit (`src/capabilities/mcp-registry.ts`): propose → human-approve → connect → list tools → cache → call, against genuine third-party MCP servers. This is the exact "architectural fork" the prior audit said didn't exist and would need its own dedicated design pass — it's since been built.
- [x] Hand-coded capability count grew from 18 to 34 (`src/capabilities/tools.ts`)
- [ ] No discovery/marketplace layer — a user has to already know a specific MCP server's name and URL to propose it; nothing surfaces "here's what's available to add"
- [ ] `JARVIS_MARKETPLACE_URL` in `.env.example` is still vestigial — zero lines of code read it
- [ ] Nowhere near "millions" — dozens of capabilities today, one third-party server registered at a time, each requiring explicit human approval

## Individuals, businesses, and society (multi-tenancy) — individuals real, businesses/society not started

- [x] Real multi-user accounts — username/password login, not one shared `INTERNAL_API_KEY` for every person
- [x] Per-user OAuth (Google/Gmail) connections, isolated per account
- [x] Per-user proactive notifications — the personal Gmail watcher (`personal-gmail.ts`) notifies only the connected account's own username. This coexists with a separate, pre-existing shared IMAP watcher that notifies "admin" about admin's own configured mailbox — the two are independent, not a leak between them.
- [x] Per-user capability grants
- [x] Conversational memory recall (`memoryStore.recall`, used by both chat and voice) is username-scoped at the query level (`WHERE username = $1`) — verified directly in `src/cognition/memory-store.ts`
- [ ] The separate global knowledge-vault/RAG store (`memory_records` table, `searchHybridMemory`/`searchMemory` in `src/kernel/state/hybridRetrieval.ts`/`src/cognition/memory-store.ts`) has no username column and is not scoped per-user — intentional by design (it backs the shared vault/knowledge-graph capabilities, not personal conversation memory) rather than a leak, but worth naming explicitly so it isn't mistaken for private-by-default.
- [ ] Biometric login (WebAuthn/passkeys) — design spec approved and merged (`docs/superpowers/specs/2026-08-17-biometric-login-design.md`), **implementation not started**
- [ ] No org/tenant concept anywhere in the schema — one shared Postgres instance, no business-level permission boundary
- [ ] No shared-vs-private memory model for teams/orgs
- [ ] "Society" scale — not started, not designed. The prior audit explicitly recommended deferring this longest; multi-user work happened anyway but stopped at real individual accounts, not organizations.

## Explicitly out of scope (deliberate decisions, not gaps to close)

These were evaluated and rejected on purpose — listed here so they don't get re-proposed as "missing":

- **Resurrecting the old `ChiefOfStaff`/department-hierarchy architecture** (`docs/archive/`) — the current single-Express-app-plus-focused-modules design is easier to reason about and extend; no reason found to reverse this.
- **Free-text executive planner writing files or running commands from a plan string** — a plan step like "Implement operational components" doesn't carry the structured arguments (which file, which repo, which recipient) real delegation needs. Guessing them from keywords would be less honest than the current narrated-plan behavior. Real execution stays scoped to tools with structured, model-extractable arguments.
- **Multi-instance/horizontally-scaled session state** — solving a scaling problem this single-Docker-host project doesn't have yet, at real complexity cost today. Revisit only if a second `api` instance actually becomes necessary.

## If picking the next concrete item

Smallest, most scoped, and the most direct current contradiction of the vision's own language: finish identity unification — wire `identity.buildIdentityContext()` into `voice-session.ts`'s system prompt construction the same way `memoryStore.recall` was already wired in (see the checklist item above). Everything else outstanding here — outcome tracking, marketplace discovery, multi-tenancy/org support — is a real design project deserving its own brainstorming pass, not a quick fix bolted on.
