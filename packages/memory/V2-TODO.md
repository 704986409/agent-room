# Agent Memory V2 follow-ups

These are known follow-ups, not V1 guarantees.

- Re-run the benchmark in `BENCHMARK.md` on the dedicated PostgreSQL 17 database after migration 002. Record actual `EXPLAIN (ANALYZE, BUFFERS)` plans, index names, row counts, and latency for 1k/10k/100k before making a scale claim. Tune the query and indexes from those plans; the planner may still prefer a sequential scan for small or low-selectivity datasets.
- Decide and document the deployment's Persona enrollment policy. MCP `room_join` can establish a Persona ID for a new seat; a valid seat key freezes that binding on resume. A deployment that needs a separate account-to-Persona ownership proof must provide that check at join time.
- Replace the recent-activity reviewer availability heuristic with an explicit reviewer roster/lease if deployments need durable or auditable reviewer assignment. Preserve the configured reviewer then verified Room owner fallback and the no-self-review rule.
- Define retention, export, and deletion procedures for memory entries, proposals, request receipts, and Briefs. Room TTL cleanup does not imply Memory data cleanup.
- Consider group or project scopes only with explicit membership, authorization, and reviewer rules. V1 supports only the Room and current Persona scopes.
- Evaluate richer ranking, stemming, aliases, and language-specific tokenization against real usage. V1 uses OR keyword recall and hit-count weighting, with metadata before body-only matches.
- Add operational metrics for migration version, storage errors, review queue age, search latency, and session-store failures without logging seat keys, host keys, or content.
- Improve the minimal host review UI and notification delivery after the API and service behavior have production feedback. The current notification adapter does not post messages into the Room transcript.
- Define a tested, operator-approved archival strategy for old schema versions. Normal application rollback intentionally preserves tables and data; there is no destructive down migration.
