\connect leadops

INSERT INTO app_config (key, value) VALUES ('sla_minutes', '30')
  ON CONFLICT (key) DO NOTHING;

-- Reps live here rather than in Odoo so workload routing and edge case 9
-- (rep goes unavailable mid-flight) are demonstrable without a live CRM.
-- Production would read this from the CRM; see the assumptions section.
INSERT INTO sales_rep (rep_id, name, email, service_categories, regions, capacity, open_leads, available, is_manager) VALUES
  ('rep_amara',  'Amara Okafor',   'amara@example.test',  '{consulting,implementation}', '{EMEA,MEA}', 10, 2, true,  false),
  ('rep_yuki',   'Yuki Tanaka',    'yuki@example.test',   '{implementation,support}',    '{APAC}',     10, 9, true,  false),
  ('rep_luis',   'Luis Ferreira',  'luis@example.test',   '{consulting,training}',       '{EMEA,AMER}', 8, 3, true,  false),
  ('rep_hana',   'Hana Farouk',    'hana@example.test',   '{consulting}',                '{MEA}',       6, 6, false, false),
  ('mgr_dana',   'Dana Whitfield', 'dana@example.test',   '{consulting,implementation,training,support}', '{EMEA,MEA,APAC,AMER}', 99, 0, true, true);

-- Deliberate shape of this fixture:
--   rep_yuki  is at 9/10  -> exercises the overload fallback branch
--   rep_hana  is at 6/6 AND unavailable -> exercises reassignment (edge case 9)
--   mgr_dana  is the VIP approver and the escalation target
