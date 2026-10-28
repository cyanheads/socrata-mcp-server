# SoQL and DuckDB query syntax

Use SoQL in `socrata_query_dataset` and DuckDB SQL in `socrata_dataframe_query`. The engines operate on different populations: SoQL queries the portal; DuckDB queries only the staged tables on one canvas.

The examples below use illustrative fields `status` and `event_date` and a text value `Closed`. Substitute API fields, types, and observed values from the selected dataset. In DuckDB examples, replace `staged_table` with the table returned by the query and confirmed by describe.

| Task | Portal SoQL | Local DuckDB SQL |
|:-----|:------------|:-----------------|
| Count all matching records | Select expression: `count(*) as n` | `SELECT count(*) AS n FROM staged_table` |
| Count by category | Select expression: `status, count(*) as n`; group expression: `status`; order expression: `n DESC` | `SELECT status, count(*) AS n FROM staged_table GROUP BY status ORDER BY n DESC` |
| Count a condition | Select expression: `sum(case(status = 'Closed', 1, true, 0)) as closed_count` | `SELECT sum(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END) AS closed_count FROM staged_table` |

Supply clause expressions to the portal tool, without `SELECT`, `FROM`, or `GROUP BY` keywords. Supply a complete read-only `SELECT` statement to the dataframe tool. A SoQL expression copied into DuckDB, or SQL `CASE WHEN` copied into SoQL, is not a portable query.

SODA scalar values arrive as strings even when their metadata type is numeric. Portal comparisons still use the column's declared type. On a staged table, inspect the actual DuckDB types: number fields normally become `DOUBLE`, while timestamps remain `VARCHAR`. Compare a staged timestamp using `CAST(event_date AS TIMESTAMP)`; this preserves a floating timestamp's wall-clock value rather than supplying a timezone the source did not provide.

To restrict a local timestamp window, after checking the staged field and its values:

```sql
SELECT count(*) AS n
FROM staged_table
WHERE CAST(event_date AS TIMESTAMP) >= TIMESTAMP '2023-01-01 00:00:00'
  AND CAST(event_date AS TIMESTAMP) < TIMESTAMP '2024-01-01 00:00:00'
```

The half-open interval includes the starting boundary and excludes the next period's boundary. It does not establish that the staged table contains the entire period.
