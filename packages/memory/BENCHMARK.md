# Agent Memory search benchmark

Measured on the local dedicated PostgreSQL 17.11 test database with `pg_trgm` 1.6 installed. The benchmark uses the same exported long-keyword SQL shape (`MEMORY_SEARCH_SQL`) as repository searches with terms of at least three characters. It creates an isolated schema, inserts the stated number of records, runs `ANALYZE`, performs one warm-up, then records 25 repository-query latency samples and one `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plan per dataset. The temporary schema is dropped when the script exits.

The synthetic profile places metadata matches at approximately 0.2% and body-only matches at approximately 0.1%. All rows are in one authorized Persona scope. It is a repeatable query-path measurement, not a production workload estimate or a performance threshold.

## Results

| Sample rows | Returned rows | Median latency (25 runs) | P95 latency | EXPLAIN execution | Shared buffers hit/read | Main scan |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1,000 | 4 | 4.049 ms | 4.369 ms | 3.337 ms | 29 / 0 | Seq Scan, 1,000 rows |
| 10,000 | 5 | 36.054 ms | 43.120 ms | 34.469 ms | 286 / 0 | Seq Scan, 10,000 rows |
| 100,000 | 5 | 386.943 ms | 440.147 ms | 441.387 ms | 2,933 / 0 | Seq Scan, 100,000 rows |

The plans selected sequential scans at all three sizes; the `pg_trgm` index was not selected for this scoped aggregation query. Metadata rows observed before the final limit were 3, 30, and 300 respectively; body-only rows were 1, 10, and 100. There is no promised latency ceiling. Revisit the query shape and indexes against representative production data before making a capacity claim.

## P7 indexed-query comparison

P7 separates title substring, search-text substring, and search-text similarity into independent `UNION ALL` branches. This removes the cross-column `OR` that kept the planner from using the corresponding GIN indexes. The 1–2 character substring branch is added to the query only when the input contains a short keyword; longer terms use the indexable paths. Migration 002 also adds an active-row Room/scope B-tree index for filtering candidates by Room and scope.

The initial P7 query and the fixed query were measured on the dedicated PostgreSQL 17.11 database with the same synthetic fixture. Each latency uses 25 query runs after one warm-up; the execution column is from the accompanying `EXPLAIN (ANALYZE, BUFFERS)` plan.

| Sample rows | Returned rows | Before fix: median / P95 / EXPLAIN | After fix: median / P95 / EXPLAIN | Shared buffers hit/read, before → after | `agent_memory_entries` scans, before → after |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1,000 | 4 | 4.632 / 6.212 / 3.050 ms | 4.518 / 6.326 / 3.102 ms | 58/0 → 116/0 | 4 Seq Scans → 4 Seq Scans |
| 10,000 | 5 | 34.463 / 35.925 / 33.316 ms | 31.046 / 33.827 / 28.249 ms | 379/0 → 951/0 | 3 Seq Scans + 1 Bitmap Heap Scan → 3 Seq Scans + 1 Bitmap Heap Scan |
| 100,000 | 5 | 264.174 / 281.829 / 256.203 ms | 10.145 / 13.006 / 8.866 ms | 3,087/0 → 1,967/0 | 3 Seq Scans + 1 Bitmap Heap Scan → 4 Bitmap Heap Scans, 0 Seq Scans |

At 100k rows, the fixed plan used `idx_memory_title_lower_trgm_active`, `idx_memory_search_lower_trgm_active` (for both `LIKE` and `%`), and `idx_memory_content_lower_trgm_active`. It had no `Seq Scan` node over `agent_memory_entries`. The fixture puts all rows in the same Persona scope, so the planner chose the selective trigram indexes and filtered by `room_instance_id`, `scope`, and `persona_id` at the heap scan; it did not choose the scope B-tree for this fixture. At 1k and 10k, PostgreSQL still chose sequential scans for some text branches based on its cost estimates. These results describe this synthetic fixture, not a production latency guarantee.

## Reproduction

```sh
MEMORY_TEST_DATABASE_URL='postgresql://…/agent_room_memtest' \
npm run benchmark:search -w packages/memory
```

Set `MEMORY_BENCHMARK_RUNS` to an integer from 5 to 100 to change the latency sample count. The script refuses to run without `MEMORY_TEST_DATABASE_URL` or on a PostgreSQL version other than 17.x. Do not use a production database.
