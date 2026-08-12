# LeadOps — multi-source lead pipeline

n8n orchestration, Postgres for durable state, every external system mocked with
deliberate fault injection. Built for a technical assessment; see `brief.md`.

## Run it

```bash
cp .env.example .env          # placeholders only — no real credentials anywhere
docker compose up -d --build
./scripts/bootstrap.sh        # owner account, credentials, workflow import + activation
```

Then n8n is at `http://localhost:5678`, the mock providers at `http://localhost:8080`.
Bootstrap is idempotent, so re-running it is safe.

```bash
# a lead through the whole pipeline
curl -X POST localhost:5678/webhook/intake/website -H 'content-type: application/json' \
  -d '{"name":"Amara Okafor","email":"amara@northwind-industrial.com","phone":"050 123 4567",
       "company":"Northwind Industrial","service":"implementation","country":"DE",
       "budget":"100k-500k","timeline":"immediate","consent":"yes",
       "message":"Company-wide rollout across four sites, budget approved, urgent"}'

curl -X POST localhost:5678/webhook/ops/tick/pipeline   # dedup, enrich, score, classify, route
curl -X POST localhost:5678/webhook/ops/tick/outbound   # messaging, claim/commit/reconcile
curl -X POST localhost:5678/webhook/ops/tick/odoo       # CRM sync, monotonic stage lattice
```

Each `ops/tick/*` webhook drives a queue consumer on demand. The same consumers also
run on a one-minute schedule; the webhooks exist so tests and demos don't have to wait.

## Tests

```bash
node --test 09_Lib/lib.test.mjs              # pure logic — scoring, dedup, keys, parsing
node 07_Mock_Services/selftest.mjs           # the harness itself, incl. every fault mode
```

## Layout

| Path | What |
|---|---|
| `02_Workflows/` | n8n workflow exports, importable as-is |
| `03_Technical_Design/` | architecture design note |
| `04_Architecture/` | system and idempotency-lifecycle diagrams |
| `07_Mock_Services/` | Odoo, WhatsApp, enrichment, LLM, booking + fault control plane |
| `08_Database/` | schema, views, fixtures |
| `09_Lib/` | pure logic, unit tested, injected into Code nodes by the build script |
| `scripts/` | bootstrap and workflow build |

## How it holds together

The work queue is **at-least-once by design** — leases expire and work is redelivered.
Correctness comes from the idempotency layer beneath it, not from the transport.

An idempotency key names an *effect*, not an *attempt*:
`v1:{domain}:{entity}:{id}:{occurrence}`, derived only from stable inputs. Two tries at
the same effect collide; two different effects never do. Replaying a workflow is safe
as a *consequence* of that, not as a separate feature.

Outbound effects use claim → call → commit. When a provider answers, the effect
definitively did not happen and retrying is safe. When there is only silence, the
outcome is ambiguous, so the provider is asked by key rather than guessed at.

## Status

Intake (website, WhatsApp, CSV), pipeline core (dedup, enrichment, scoring, AI
classification, routing) and both dispatchers are built and verified against the
running stack. Scheduler, booking and approval callbacks are in progress. Full
documentation, test evidence and known limitations land with the final submission.
