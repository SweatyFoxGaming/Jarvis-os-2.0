# Architecture Review – Required for Every Substantial Change

Before implementing any feature or significant refactor, answer these questions.

---

## 1. What architectural principle does this change support?
- [ ] Separation of metaphor from architecture
- [ ] Goals as primary domain object
- [ ] Formal execution state machine
- [ ] Capabilities as first-class objects
- [ ] Architectural budgets
- [ ] Memory lifecycle
- [ ] Event vocabulary expansion
- [ ] Platform lifecycle
- [ ] Governance clarity
- [ ] Other (specify):

---

## 2. Does this introduce a new abstraction, or can an existing one be strengthened instead?
- [ ] New abstraction required
- [ ] Existing abstraction strengthened
- If new, explain why no existing abstraction can be extended:

---

## 3. Will this make future capabilities easier to build?
- [ ] Yes
- [ ] No
- Explain:

---

## 4. Does this reduce or increase conceptual complexity?
- [ ] Reduces complexity
- [ ] Increases complexity
- Explain:

---

## 5. If this feature were removed tomorrow, would the architecture still be stronger because of the work done?
- [ ] Yes
- [ ] No
- Explain:

---

## 6. Which architectural layers are affected?

- [ ] Executive Intelligence
- [ ] Planning
- [ ] Execution
- [ ] Capabilities
- [ ] Infrastructure
- [ ] Memory
- [ ] Events
- [ ] Governance
- [ ] Other:

---

## 7. Does this change preserve the separation between metaphor and architecture?

- [ ] Yes
- [ ] No

---

## 8. Does this change introduce or rely on any of the following prohibited concepts during Phase I?

- [ ] Voice
- [ ] Vision
- [ ] Facial Recognition
- [ ] Enterprise Security
- [ ] Distributed Infrastructure
- [ ] Additional autonomous agents
- [ ] Complex orchestration systems

*If any are checked, this change must be deferred to a later phase.*

---

## 9. Are all new capabilities registered in the Capability Registry?

- [ ] Yes
- [ ] N/A
- [ ] No – (explain why)

---

## 10. Are execution transitions using the formal State Machine?

- [ ] Yes
- [ ] N/A
- [ ] No – (explain why)

---

## 11. Is every Goal assigned a budget (time, token, priority)?

- [ ] Yes
- [ ] N/A
- [ ] No – (explain why)

---

## 12. Is the memory lifecycle respected (Conversation → Working → Episode → Review → Consolidation → Semantic → Archive)?

- [ ] Yes
- [ ] N/A
- [ ] No – (explain why)

---

## 13. Are new events using the standard vocabulary?

- [ ] Yes
- [ ] N/A
- [ ] No – (explain why)

---

## 14. Does this change align with the current platform state lifecycle?

- [ ] Yes
- [ ] N/A
- [ ] No – (explain why)

---

## 15. Governance Review

- [ ] Constitution – unaffected
- [ ] Development Constitution – updated if needed
- [ ] Execution Model – updated if needed
- [ ] Operational Policies – updated if needed

---

## Approval

- Architecture Review: [ Approved / Needs Revision ]
- Date:
- Reviewer:
