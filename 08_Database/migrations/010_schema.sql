\connect leadops

-- Canonical state for the lead pipeline.
--
-- Two constraints in here do the heavy lifting and are worth finding first:
--   lead_source_event.source_event_key UNIQUE  -> inbound event suppression
--   idempotency_claim.key PRIMARY KEY          -> the atomic claim for outbound effects
-- Everything else is bookkeeping around those two.

-- Enum-ish columns use text + CHECK rather than native enums: adding a value to a
-- PG enum needs DDL and can't run in a transaction with other work. Cheap to widen later.

CREATE TABLE sales_rep (
  rep_id             text PRIMARY KEY,
  name               text NOT NULL,
  email              text,
  service_categories text[] NOT NULL DEFAULT '{}',
  regions            text[] NOT NULL DEFAULT '{}',
  capacity           integer NOT NULL DEFAULT 10,
  open_leads         integer NOT NULL DEFAULT 0,
  available          boolean NOT NULL DEFAULT true,
  is_manager         boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lead (
  lead_id             text PRIMARY KEY,
  source              text NOT NULL CHECK (source IN ('website','whatsapp','csv','manual')),
  source_event_key    text NOT NULL,
  received_at         timestamptz,
  ingested_at         timestamptz NOT NULL DEFAULT now(),

  -- raw is kept alongside normalized everywhere: normalization is lossy and a
  -- dedup dispute needs the bytes the customer actually typed
  full_name           text,
  name_normalized     text,
  phone_raw           text,
  phone_e164          text,
  phone_valid         boolean NOT NULL DEFAULT false,
  email_raw           text,
  email_normalized    text,
  email_valid         boolean NOT NULL DEFAULT false,

  company             text,
  service_interest    text,
  free_text_need      text,
  country             text,
  region              text,
  budget_band         text,
  timeline            text,

  consent_status      text NOT NULL DEFAULT 'unknown'
                        CHECK (consent_status IN ('granted','denied','withdrawn','unknown')),
  consent_ts          timestamptz,
  consent_source      text,
  channels_allowed    text[] NOT NULL DEFAULT '{}',

  -- carries its own status so a failed lookup never reads as "company size is null"
  enrichment          jsonb NOT NULL DEFAULT '{"status":"pending"}'::jsonb,

  score               integer CHECK (score BETWEEN 0 AND 100),
  score_breakdown     jsonb NOT NULL DEFAULT '[]'::jsonb,
  score_model_version text,
  score_band          text CHECK (score_band IN ('qualified','nurture','unqualified')),
  ai_classification   jsonb,
  conflict_flag       boolean NOT NULL DEFAULT false,

  disposition         text CHECK (disposition IN
                        ('qualified','nurture','unqualified','manual_review','data_completion','merged')),
  owner_id            text REFERENCES sales_rep(rep_id),
  assignment_reason   text,
  assigned_at         timestamptz,
  last_sales_action_at timestamptz,
  vip_flag            boolean NOT NULL DEFAULT false,
  approval_state      text NOT NULL DEFAULT 'not_required'
                        CHECK (approval_state IN ('not_required','pending','approved','rejected','expired')),

  dedup_status        text NOT NULL DEFAULT 'unique'
                        CHECK (dedup_status IN ('unique','master','merged_into','pending_review')),
  duplicate_of        text REFERENCES lead(lead_id),
  dedup_confidence    numeric(4,3),
  dedup_features      jsonb,

  odoo_lead_id        text,
  odoo_stage          text,
  odoo_stage_rank     integer,
  last_synced_at      timestamptz,

  status              text NOT NULL DEFAULT 'received',
  status_reason       text,
  version             integer NOT NULL DEFAULT 1,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Dedup candidate lookup. Partial so the nulls from incomplete leads don't bloat them.
CREATE INDEX lead_phone_idx ON lead (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX lead_email_idx ON lead (email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX lead_name_idx  ON lead (name_normalized) WHERE name_normalized IS NOT NULL;
CREATE INDEX lead_ingested_idx ON lead (ingested_at DESC);
CREATE INDEX lead_owner_idx ON lead (owner_id) WHERE owner_id IS NOT NULL;

-- Raw payload archive AND the intake idempotency table. Same facts, one place.
-- The unique key is what keeps lead_id stable across webhook redelivery, which is
-- what every downstream idempotency key depends on.
CREATE TABLE lead_source_event (
  event_id         bigserial PRIMARY KEY,
  source_event_key text NOT NULL UNIQUE,
  source           text NOT NULL,
  lead_id          text REFERENCES lead(lead_id),
  raw_payload      jsonb NOT NULL,
  headers          jsonb,
  received_at      timestamptz NOT NULL DEFAULT now(),
  prior_response   jsonb
);

CREATE TABLE idempotency_claim (
  key                 text PRIMARY KEY,
  effect_domain       text NOT NULL,
  entity_type         text NOT NULL,
  entity_id           text NOT NULL,
  occurrence          text NOT NULL,
  state               text NOT NULL CHECK (state IN ('in_flight','succeeded','failed_permanent')),
  attempt             integer NOT NULL DEFAULT 1,
  -- detects a key reused with genuinely different content, which is a bug, not a retry
  request_fingerprint text,
  provider_ref        text,
  response            jsonb,
  last_error          jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- past this, an in_flight claim is ambiguous and must be reconciled, not retried
  stale_after         timestamptz NOT NULL DEFAULT now() + interval '2 minutes',
  settled_at          timestamptz
);

CREATE INDEX idem_entity_idx ON idempotency_claim (entity_type, entity_id);
CREATE INDEX idem_stale_idx  ON idempotency_claim (stale_after) WHERE state = 'in_flight';

CREATE TABLE work_queue (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN
                    ('pipeline','outbound','odoo_sync','followup','sla_check','approval_expiry','reconcile')),
  lead_id         text REFERENCES lead(lead_id),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  run_after       timestamptz NOT NULL DEFAULT now(),
  attempt         integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  state           text NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending','leased','done','dead','cancelled')),
  lease_token     text,
  lease_until     timestamptz,
  last_error      jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Drives the lease query. Partial index keeps it small as done rows accumulate.
CREATE INDEX wq_due_idx    ON work_queue (run_after) WHERE state = 'pending';
CREATE INDEX wq_expiry_idx ON work_queue (lease_until) WHERE state = 'leased';
CREATE INDEX wq_lead_idx   ON work_queue (lead_id, kind) WHERE state = 'pending';

CREATE TABLE dead_letter (
  id              bigserial PRIMARY KEY,
  origin_kind     text NOT NULL,
  lead_id         text,
  idempotency_key text,
  payload         jsonb NOT NULL,
  error           jsonb,
  workflow        text,
  execution_id    text,
  failed_at       timestamptz NOT NULL DEFAULT now(),
  replayed_at     timestamptz,
  replay_of       bigint REFERENCES dead_letter(id),
  resolution      text NOT NULL DEFAULT 'open'
                    CHECK (resolution IN ('open','replayed','abandoned'))
);

CREATE INDEX dlq_open_idx ON dead_letter (failed_at DESC) WHERE resolution = 'open';

-- The dead letter queue is a human work list, so re-submitting the same broken
-- input must not pile up identical entries for someone to wade through.
CREATE UNIQUE INDEX dlq_idem_idx ON dead_letter (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE duplicate_decision (
  id                bigserial PRIMARY KEY,
  lead_id           text NOT NULL REFERENCES lead(lead_id),
  candidate_lead_id text NOT NULL REFERENCES lead(lead_id),
  confidence        numeric(4,3) NOT NULL,
  -- full feature vector retained so thresholds can be fitted from outcomes later
  -- rather than argued about
  features          jsonb NOT NULL,
  tier              text NOT NULL CHECK (tier IN ('auto_merge','review','distinct')),
  action_taken      text NOT NULL,
  demoted_reason    text,
  resolved_by       text,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_request (
  id           bigserial PRIMARY KEY,
  lead_id      text NOT NULL REFERENCES lead(lead_id),
  kind         text NOT NULL DEFAULT 'vip' CHECK (kind IN ('vip','duplicate_merge')),
  state        text NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','approved','rejected','expired')),
  token        text NOT NULL UNIQUE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  decided_at   timestamptz,
  decided_by   text,
  reason       text
);

CREATE INDEX approval_pending_idx ON approval_request (expires_at) WHERE state = 'pending';

-- Append-only. One row per *decision*, with the inputs that produced it — logging
-- "routed to manual review" without its inputs makes the trail unreconstructible.
CREATE TABLE event_log (
  id              bigserial PRIMARY KEY,
  ts              timestamptz NOT NULL DEFAULT now(),
  lead_id         text,
  workflow        text,
  execution_id    text,
  step            text,
  event_type      text NOT NULL,
  decision        text,
  inputs          jsonb,
  outputs         jsonb,
  idempotency_key text,
  severity        text NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('debug','info','warn','error'))
);

CREATE INDEX evt_lead_idx ON event_log (lead_id, ts);
CREATE INDEX evt_type_idx ON event_log (event_type, ts DESC);
CREATE INDEX evt_sev_idx  ON event_log (ts DESC) WHERE severity IN ('warn','error');

-- Enforced, not merely intended. An audit trail that can be edited isn't one.
CREATE FUNCTION event_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'event_log is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_log_no_mutate
  BEFORE UPDATE OR DELETE ON event_log
  FOR EACH ROW EXECUTE FUNCTION event_log_is_append_only();
