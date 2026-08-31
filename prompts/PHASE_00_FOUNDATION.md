# Claude Code Bootstrap Prompt — Phase 0 only

You are starting the Miet-Royal 2.0 project.

## Mandatory first action
Before writing code, read in this order:
1. `CLAUDE.md`
2. `docs/MASTER_SPEC.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DATA_MODEL.md`
5. `docs/PERMISSIONS.md`
6. `docs/UX_RULES.md`
7. `docs/INTEGRATIONS.md`
8. `docs/TEST_PLAN.md`
9. `docs/ROADMAP.md`
10. `docs/OPEN_ITEMS.md`
11. `docs/DECISIONS_LEDGER.md`

Then summarize the constraints that affect **Phase 0 only**.

## Scope
Implement **Phase 0 — project foundation only**.

Do NOT implement:
- customer business logic
- offers
- bookings
- calendar
- machines
- inventory
- handover
- returns
- settlement
- Lexware
- WhatsApp
- customer portal
- public website design/content

## Required deliverables

### 1. Monorepo
Create the project structure described in `ARCHITECTURE.md`.

Expected top-level shape:
- `apps/web`
- `apps/staff`
- `apps/api`
- `apps/worker`
- `packages/database`
- `packages/domain`
- `packages/permissions`
- `packages/documents`
- `packages/integrations`
- `packages/ui`
- `packages/validation`
- `packages/config`
- `docs`
- `tests`

Use a modern workspace setup with current stable production-ready versions.
Do not pin stale versions from the specification.

### 2. TypeScript quality baseline
- strict TypeScript
- lint
- formatter
- typecheck script
- no avoidable `any`
- shared tsconfig conventions

### 3. Database foundation
- PostgreSQL
- select one well-maintained TypeScript ORM/migration solution
- document the choice in `docs/TECH_DECISIONS.md`
- create only infrastructure-level initial schema/migration needed for health/versioning if necessary
- do not create the full domain schema yet
- migration commands must be reproducible

### 4. Environment separation
Support:
- development
- staging
- demo
- production

Create safe config loading and validation.
Provide `.env.example` files containing variable names only.
Never commit real secrets.

Demo and production configuration must be structurally capable of using:
- different databases
- different storage
- different integration credentials

### 5. Local development infrastructure
Provide a reproducible local development setup.
Prefer Docker Compose for infrastructure services where practical:
- PostgreSQL
- S3-compatible local object storage if needed for foundation testing

Do not require a production provider account to run locally.

### 6. API foundation
Create:
- API application
- `/health`
- `/ready` if appropriate
- structured error shape
- request validation foundation
- logging foundation
- request correlation ID

Do not expose internal stack traces to clients.

### 7. Worker / jobs foundation
Define a background-job abstraction.
Implement a production-suitable PostgreSQL-backed queue or an equivalently simple robust approach consistent with `ARCHITECTURE.md`.

Prove:
- enqueue
- process
- retry
- idempotency field/strategy

Use a harmless sample/system job, not a business feature.

### 8. File storage abstraction
Create a private storage interface that can later support S3-compatible storage.
No public buckets by default.
Provide a local development implementation/configuration.

Do not implement business-specific image workflows yet.

### 9. App shells
`apps/web`:
- minimal neutral shell
- health/development landing only

`apps/staff`:
- minimal responsive shell
- no business navigation beyond a placeholder showing that the staff app runs

Do not spend time on visual branding yet.

### 10. Test foundation
Set up:
- unit test runner
- API/integration test foundation
- E2E test foundation

Add real smoke tests proving:
- workspace builds/typechecks
- API health endpoint
- DB connectivity where test environment supports it
- demo/prod config cannot silently collapse to the same configured database in a production-like check

### 11. Scripts
Provide simple root commands for:
- install
- dev
- build
- lint
- typecheck
- test
- test:e2e
- database migration
- worker
- infrastructure start/stop

Document them in the README.

### 12. Documentation
Create/update:
- root README with local startup
- `docs/TECH_DECISIONS.md`
- `docs/ENVIRONMENTS.md`
- `docs/DEPLOYMENT_NOTES.md` foundation
- do not rewrite business specs

## Important architecture requirements
- business logic must later live centrally, not in React components
- provider integrations must later be behind interfaces
- demo and live may share code, never data/secrets
- no external provider should become required just to boot local development
- foundation must be maintainable and intentionally boring/stable

## Before coding
If there is a purely technical choice (ORM, API framework, queue library), make a reasoned production-minded choice consistent with the docs and record it in `TECH_DECISIONS.md`.
Do not ask for a business decision.

If a choice would alter a business rule, stop and report it.

## Completion
Run all available Phase-0 checks yourself.

Then return exactly these sections:

### Implemented
### Technical decisions
### Files / structure created
### Migrations
### Tests actually run
### Test results
### Not tested
### Open issues
### Risks
### Ready for Phase 1?
