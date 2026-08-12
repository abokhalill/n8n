# LeadOps 

This project demonstrates a multi-source lead piepline. It contains n8n orchestration, Postgres for durable state, and it has every external system mocked with deliberate 
fault injection. 

## Run it

```bash
cp .env.example .env          
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
