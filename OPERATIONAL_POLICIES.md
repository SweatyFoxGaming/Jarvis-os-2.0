# Operational Policies – Jarvis OS

> **Historical design doc.** This describes an earlier, larger architecture that predates the current Docker/FastAPI/Express implementation and has since been replaced. For what actually exists today, see [README.md](README.md) and [docs/architecture/ROADMAP.md](docs/architecture/ROADMAP.md).

## Security
- All system commands must pass through SynapseInterface.
- Command whitelist is enforced by SecurityModule.
- All actions are audited in secure memory.
- Secrets (tokens, passwords) must be stored in `.env`, never in code or `docker-compose.yml`.

## Logging
- INFO for normal operations.
- WARNING for recoverable issues.
- ERROR for failures requiring attention.
- DEBUG for development only (never enabled in production).

## Environment Variables
- All secrets must be in `.env`.
- `docker-compose.yml` must reference variables using `${VAR}`.
- Default values (e.g., `:-`) may be used for non‑critical variables.

## Docker & Storage
- Docker’s root directory must reside on a persistent, large volume (e.g., `/mnt/jarvis_home/docker`).
- All persistent application data (models, logs, database) must be mounted from `/mnt/jarvis_home/`.
- The main OS drive must not be used for Docker build cache or layers.

## Error Handling
- Never expose internal stack traces to the user.
- Return user‑friendly error messages.
- Log full traces for debugging.

## Planner & Scheduler
- The Planner must never crash; if planning fails, the Goal must be marked as Failed.
- The Scheduler (ChiefOfStaff) must respect the Goal’s budget (priority, retries, etc.).
- Tasks are only created inside the Planner. No other subsystem may create a Task directly.

## Versioning
- Follow Semantic Versioning (MAJOR.MINOR.PATCH).
- Breaking changes require a MAJOR version bump.
- New features require a MINOR version bump.
- Bug fixes require a PATCH version bump.

## Architecture Review
- Every substantial change must complete an Architecture Review before implementation.
- The review template is located at `.github/architecture_review.md`.
