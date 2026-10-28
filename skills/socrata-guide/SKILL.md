---
name: socrata-guide
description: Investigate civic data with socrata_* tools, check dataset coverage, and choose upstream SoQL or staged DuckDB analysis. Use for government open-data questions involving absence claims, trends, conditional aggregates, or comparisons across datasets.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use Socrata for public government datasets served through SODA 2.1. Discovery also lists maps, files, and stories; find a dataset-type asset for row analysis. The tools do not edit portal data.

## Identifiers

Keep the portal and dataset identity from a discovery result together through analysis. Metadata supplies the typed API field names; a staged query supplies a separate canvas token and table name. Use the returned identifiers rather than deriving a local table name from a dataset ID.

## Gates

- Before concluding that a jurisdiction has no data, search datasets beyond the curated portal list. An empty portal-name search establishes only that no entry in that list matched. Broaden restrictive category and tag filters before treating an empty dataset search as evidence of absence.
- Before filtering a category, inspect its actual values with a grouped count. A neighborhood, status, or agency name in the question need not match the dataset's vocabulary.
- Before reporting a population total, distinguish approximate cached metadata counts, matching source rows, returned groups, and staged rows. A filled page can have more matches; an absent total does not establish completeness. Grouped queries do not report a source-row total.
- Before treating a canvas statistic as a whole-dataset statistic, establish that the staged copy covers the intended population. It starts at the query's offset and stops at 50,000 matching result rows. Prefer upstream SoQL aggregation when the population exceeds the copy or its coverage is unknown.
- Before joining datasets, establish each table's record granularity, shared key meaning, time window, and units from metadata and observed values. Matching column names alone do not establish a valid join.
- Before staging another query into an existing canvas, account for replacement: another spill of the same dataset replaces its existing table, including when the filter or offset changes. The table name also omits the portal, so the same dataset ID from another portal collides. Use separate canvases for those extracts; these tools cannot join across canvases.

## Workflows

### Totals, distributions, and trends

Resolve the dataset's time and category fields before translating the question into a query. Check category values, then aggregate on the portal with SoQL. This computes over the matching source population instead of a limited local extract. A dataset's update timestamp describes its refresh, not proof that every event in the requested period is represented.

For conditional totals, use SoQL's `case(condition, value, true, fallback)` form rather than SQL `CASE WHEN`. See [query syntax](references/query-syntax.md) before translating between engines.

### Local analysis and comparisons

Results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `socrata_dataframe_describe` with it for the staged table and column names before writing SQL, then `socrata_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first; the tables expire with the canvas.

Use that shared canvas for different datasets with distinct IDs after checking the join and coverage gates. Describe it after staging each dataset to confirm both tables remain. A successful inline response without a canvas token supplies no staged table to query.

For multiple filtered extracts of one dataset, stage a common source extract once and express the comparisons in DuckDB SQL, provided that extract covers the required population. Otherwise compute each statistic upstream in SoQL. Repeated spills do not append pages or preserve earlier filtered versions.

### Empty results

A successful zero-row query establishes only that its filters matched no returned rows. Recheck vocabulary, time coverage, and filters before generalizing. A discovery miss or an API/domain failure is not a zero-row observation.

## References

- [SoQL and DuckDB query syntax](references/query-syntax.md): conditional aggregates, query structure, and timestamp handling.
