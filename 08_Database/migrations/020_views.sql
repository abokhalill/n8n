\connect leadops

-- The send ledger and the idempotency ledger are the same facts. Making this a view
-- rather than a table means they cannot drift apart.
CREATE VIEW outbound_message AS
SELECT
  key              AS idempotency_key,
  entity_id        AS lead_id,
  occurrence       AS message_slot,
  state,
  attempt,
  provider_ref     AS provider_message_id,
  created_at       AS first_attempted_at,
  settled_at,
  response
FROM idempotency_claim
WHERE effect_domain = 'msg.send';

-- Claims that crashed between the call and the settle. Ambiguous by definition:
-- the effect may or may not have landed, so these get reconciled against the
-- provider, never blindly retried. This is edge case 7's work list.
CREATE VIEW claims_needing_reconciliation AS
SELECT key, effect_domain, entity_type, entity_id, occurrence, attempt, created_at, stale_after
FROM idempotency_claim
WHERE state = 'in_flight' AND stale_after < now();

-- Brief section 3.J. Deliberately a view, not a dashboard.
CREATE VIEW ops_summary AS
SELECT
  (SELECT count(*) FROM lead)                                                    AS total_leads,
  (SELECT count(*) FROM lead_source_event)                                       AS total_source_events,
  (SELECT count(*) FROM lead WHERE disposition = 'qualified')                    AS qualified,
  (SELECT count(*) FROM lead WHERE disposition = 'nurture')                      AS nurture,
  (SELECT count(*) FROM lead WHERE disposition = 'unqualified')                  AS unqualified,
  (SELECT count(*) FROM lead WHERE disposition = 'manual_review')                AS manual_review,
  (SELECT count(*) FROM lead WHERE disposition = 'data_completion')              AS data_completion,
  (SELECT count(*) FROM lead WHERE dedup_status = 'merged_into')                 AS duplicates_merged,
  (SELECT count(*) FROM lead WHERE dedup_status = 'pending_review')              AS duplicates_in_review,
  (SELECT count(*) FROM lead WHERE vip_flag)                                     AS vip_leads,
  (SELECT count(*) FROM approval_request WHERE state = 'pending')                AS approvals_pending,
  (SELECT count(*) FROM dead_letter WHERE resolution = 'open')                   AS dead_lettered_open,
  (SELECT count(*) FROM work_queue WHERE state = 'pending')                      AS queue_pending,
  (SELECT count(*) FROM work_queue WHERE state = 'dead')                         AS queue_dead,
  (SELECT count(*) FROM claims_needing_reconciliation)                           AS claims_ambiguous,
  (SELECT count(*) FROM lead
     WHERE disposition = 'qualified'
       AND last_sales_action_at IS NULL
       AND assigned_at < now() - interval '30 minutes')                          AS sla_breached;

-- "Why did this lead get this result?" answered in one query. Interleaves the
-- decisions (event_log) with the external effects they caused (idempotency_claim),
-- which is the pairing that makes an outcome reconstructible rather than merely logged.
CREATE VIEW lead_timeline AS
SELECT
  lead_id,
  ts,
  'decision'                      AS entry_kind,
  event_type                      AS label,
  decision                        AS detail,
  severity,
  idempotency_key,
  inputs,
  outputs,
  workflow,
  execution_id
FROM event_log
UNION ALL
SELECT
  entity_id                       AS lead_id,
  COALESCE(settled_at, created_at) AS ts,
  'external_effect'               AS entry_kind,
  effect_domain || ':' || occurrence AS label,
  state                           AS detail,
  CASE state WHEN 'failed_permanent' THEN 'error' ELSE 'info' END AS severity,
  key                             AS idempotency_key,
  jsonb_build_object('attempt', attempt, 'fingerprint', request_fingerprint) AS inputs,
  jsonb_build_object('provider_ref', provider_ref, 'response', response)     AS outputs,
  NULL, NULL
FROM idempotency_claim
WHERE entity_type = 'lead';
