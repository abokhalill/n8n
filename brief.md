# Automation Engineer – Technical Assessment Brief

**Advanced Business Automation Case | Candidate Version**

| Field | Detail |
|---|---|
| **Assessment Type** | Practical end-to-end automation challenge |
| **Preferred Stack** | n8n preferred; Make / custom code may be used where justified |
| **Primary Goal** | Evaluate architecture, implementation, reliability, API handling, AI usage, business logic, organization, and delivery discipline |

---

## 1. Business Scenario

A growing B2B services company receives leads from Facebook Lead Ads, Instagram, website forms, WhatsApp, and manual imports. The current process is fragmented: duplicate leads are common, sales follow-up is inconsistent, high-value leads are sometimes missed, and management has no reliable view of funnel performance.

Your task is to design and build an automation system that captures, validates, enriches, qualifies, routes, follows up with, and monitors leads while handling failures, edge cases, and human approvals.

---

## 2. Core Objective

- Create one reliable lead-processing pipeline that can accept leads from multiple sources.
- Reduce duplicate and incomplete records before they enter the CRM.
- Use deterministic rules plus AI-assisted analysis for qualification.
- Route leads based on score, service interest, geography, workload, and urgency.
- Automate follow-ups while preserving human control for sensitive or high-value cases.
- Create auditability: every major decision, error, retry, and status change should be traceable.

---

## 3. Required Automation Flow

> The expected flow is intentionally complex. You may improve the design if you clearly justify your decisions.

### A. Multi-Source Intake

- Accept leads from at least 3 simulated sources: Website webhook, WhatsApp webhook, and CSV/manual import.
- Normalize different source fields into one canonical lead schema.
- Generate a unique internal lead ID and capture source + timestamp.

### B. Validation & Data Quality

- Validate name, mobile number, email format, service interest, and consent/communication availability.
- If critical data is missing, send the lead to a Data Completion path instead of silently failing.
- Apply phone normalization and basic email normalization before comparison.

### C. Duplicate Detection

- Detect exact duplicates by phone and/or email.
- Detect likely duplicates where the same person submits from two sources with slightly different data.
- Do not blindly delete duplicates: merge safely or create a manual-review case depending on confidence.
- Maintain a record of duplicate decisions.

### D. Enrichment & Qualification

- Enrich the lead using at least one simulated external source/API or lookup table (company size, industry, country, etc.).
- Calculate a deterministic lead score using business rules.
- Use AI for a separate qualitative classification based on free-text needs.
- If AI and rule-based outputs conflict materially, route to manual review.

### E. Routing Logic

- Route Qualified, Nurture, Unqualified, and Manual Review leads differently.
- Qualified leads must be assigned to sales based on service category and current workload.
- VIP/high-value leads require manager approval before an automated sales message is sent.
- If the assigned salesperson is unavailable or overloaded, reassign according to fallback rules.
- **Dynamic Sales Funnel Stages in Odoo:** The sales funnel must move dynamically inside Odoo. Opportunities should automatically transition between the appropriate Odoo stages based on workflow events, qualification results, follow-up status, booking/conversion actions, and other defined business conditions.

### F. CRM & Communication

- Create/update the CRM record without creating duplicates.
- Send a personalized WhatsApp or email confirmation.
- Write the current stage, score, owner, source, reason for qualification, and next action to the CRM.
- Prevent duplicate outbound messages when the workflow retries.
- **Odoo Integration:** The full automation must be connected to Odoo as the central CRM/system of record. Lead creation, updates, assignments, qualification results, follow-ups, booking/conversion events, and relevant statuses must be synchronized with Odoo.

### G. Follow-Up Engine

- Create at least 3 follow-up steps using different timing conditions.
- Stop the sequence immediately if the lead replies, books a meeting, opts out, or is manually closed.
- Escalate if a qualified lead receives no sales action within the defined SLA.
- Use different follow-up behavior for Qualified vs Nurture leads.

### H. Booking / Conversion Event

- When a meeting is booked, update the CRM stage and stop marketing follow-ups.
- Prevent double booking or duplicate booking events from triggering repeated CRM actions.
- Notify the assigned salesperson and log the booking event.

### I. Error Handling & Recovery

- Handle API timeout, rate limit, invalid response, unavailable service, malformed payload, and missing credentials scenarios.
- Use retries with sensible limits and backoff rather than infinite retry loops.
- Route permanent failures to an error queue or dead-letter process.
- Provide a mechanism for safe manual reprocessing without duplicating previous actions.

### J. Monitoring & Audit Trail

- Log key workflow events and failure states.
- Create a simple operational summary showing total processed, qualified, duplicates, failed, manual-review, and SLA-breached leads.
- Your design should make it possible to investigate why a particular lead received a specific result.

---

## 4. Mandatory Edge Cases

1. The same lead arrives from WhatsApp and the website within 2 minutes.
2. A phone number is valid but submitted in two different formats.
3. The enrichment API times out twice, then succeeds.
4. The AI model returns an empty or malformed response.
5. The AI says 'High Potential' but deterministic rules classify the lead as low value.
6. The CRM API returns 429 Rate Limit.
7. The CRM create action succeeds, but the workflow times out before receiving confirmation.
8. The WhatsApp send action is retried after a transient error; the customer must not receive the same message twice.
9. A salesperson is assigned, then becomes unavailable before follow-up.
10. A lead opts out while a delayed follow-up execution is already scheduled.
11. A meeting booking webhook is delivered twice.
12. A manager rejects a VIP lead after the automated qualification step.
13. A corrupted CSV row is included in a batch of otherwise valid records.
14. A workflow execution is manually re-run after partial success.

---

## 5. Business Rules

| Rule | Condition | Expected Action | Priority |
|---|---|---|---|
| Incomplete Lead | Missing critical contact data | Data Completion / Manual Review | High |
| Duplicate | High-confidence duplicate | Merge or update existing record | High |
| Qualified | Score ≥ 70 | Assign sales + immediate confirmation | High |
| VIP | Score ≥ 90 OR strategic account flag | Manager approval before outbound sales action | Critical |
| Nurture | Score 40–69 | Nurture sequence | Medium |
| Unqualified | Score < 40 | Close or low-frequency nurture | Low |
| SLA Breach | Qualified lead has no sales action in 30 minutes | Escalate and optionally reassign | Critical |

---

## 6. Required Deliverables

1. Working automation workflow(s), exported in a format that can be reviewed.
2. Architecture diagram showing systems, major workflow components, queues, and human checkpoints.
3. Short Technical Design / SRS-style document explaining your implementation decisions.
4. Data model / canonical lead schema.
5. List of business rules and scoring logic.
6. Error-handling strategy including retry, idempotency, and manual reprocessing.
7. Test evidence covering the mandatory edge cases.
8. A short README with setup steps, environment variables/credentials placeholders, and how to run the solution.
9. Recorded demo OR live walkthrough-ready demo.

---

## 7. Technical Design Document – Minimum Sections

- Assumptions
- Architecture overview
- Workflow breakdown
- Data schema
- External integrations / APIs
- Authentication and secrets handling
- Idempotency strategy
- Error handling and retry strategy
- Human approval / manual review logic
- Logging and observability
- Testing approach
- Known limitations and next improvements

---

## 8. Submission Rules

- Do not hardcode real credentials or API secrets.
- Mock APIs and sandbox services are acceptable when production access is unavailable.
- You may use AI coding assistants, but you must understand and be able to explain every important part of your solution.
- If you cannot complete every requirement, submit the best working version and clearly document what remains, why, and how you would finish it.
- A smaller stable solution with explicit trade-offs is better than a large unreliable workflow.
- Your folder/file structure and naming should make the submission easy to review.

---

## 9. Suggested Submission Structure

```
CandidateName_AutomationAssessment/
    01_README/
    02_Workflows/
    03_Technical_Design/
    04_Architecture/
    05_Test_Evidence/
    06_Sample_Data/
```