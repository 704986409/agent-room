# P3 Search benchmark

Measured on the local dedicated PostgreSQL 17.11 test database with `pg_trgm` 1.6 installed. The benchmark uses the same exported `MEMORY_SEARCH_SQL` as the repository, creates an isolated schema, inserts the stated number of records, runs `ANALYZE`, performs one warm-up, then records 25 repository-query latency samples and one `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plan per dataset. The temporary schema is dropped when the script exits.

The synthetic profile places metadata matches at approximately 0.2% and body-only matches at approximately 0.1%. All rows are in one authorized Persona scope. It is a repeatable query-path measurement, not a production workload estimate or a performance threshold.

## Results

| Sample rows | Returned rows | Median latency (25 runs) | P95 latency | EXPLAIN execution | Shared buffers hit/read | Main scan |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1,000 | 4 | 4.049 ms | 4.369 ms | 3.337 ms | 29 / 0 | Seq Scan, 1,000 rows |
| 10,000 | 5 | 36.054 ms | 43.120 ms | 34.469 ms | 286 / 0 | Seq Scan, 10,000 rows |
| 100,000 | 5 | 386.943 ms | 440.147 ms | 441.387 ms | 2,933 / 0 | Seq Scan, 100,000 rows |

The plans selected sequential scans at all three sizes; the `pg_trgm` index was not selected for this scoped aggregation query. Metadata rows observed before the final limit were 3, 30, and 300 respectively; body-only rows were 1, 10, and 100. There is no promised latency ceiling. Revisit the query shape and indexes against representative production data before making a capacity claim.

## Reproduction

```sh
MEMORY_TEST_DATABASE_URL='postgresql://…/agent_room_memtest' \
npm run benchmark:search -w packages/memory
```

Set `MEMORY_BENCHMARK_RUNS` to an integer from 5 to 100 to change the latency sample count. The script refuses to run without `MEMORY_TEST_DATABASE_URL` or on a PostgreSQL version other than 17.x. Do not use a production database.
