/**
 * @fileoverview Domain types for the Socrata SODA API and Discovery API.
 * @module services/socrata/types
 */

/** A column from the dataset schema (views API). */
export type DatasetColumn = {
  fieldName: string;
  dataType: string;
  description?: string;
  nonNullCount?: number;
};

/**
 * Provenance of a dataset's row count. `top_level_cached_contents` — reported
 * directly by the views API's top-level `cachedContents`; `column_cached_contents` —
 * derived as the maximum per-column `cachedContents.count` when the top-level
 * value is absent.
 */
export type RowCountSource = 'top_level_cached_contents' | 'column_cached_contents';

/** Full dataset metadata from the views API. */
export type DatasetMetadata = {
  datasetId: string;
  domain: string;
  name: string;
  description?: string;
  category?: string;
  tags: string[];
  rowCount?: number;
  rowCountSource?: RowCountSource;
  dataUpdatedAt?: string;
  license?: string;
  columns: DatasetColumn[];
};

/** A single discovery result from the Discovery API. */
export type DiscoveryResult = {
  datasetId: string;
  domain: string;
  name: string;
  description?: string;
  category?: string;
  tags: string[];
  /** SoQL field names from Discovery `columns_field_name`, `:@computed_region_*` dropped. */
  columnNames: string[];
  license?: string;
  dataUpdatedAt?: string;
  viewCount?: number;
};

/**
 * A known Socrata portal with its live dataset count. `datasetCount` is the
 * Discovery API's count of dataset-type assets — approximate and point-in-time
 * (TTL-cached); `0` means the portal genuinely exposes no dataset assets to the
 * catalog, `null` means the live count is temporarily unavailable.
 */
export type PortalEntry = {
  domain: string;
  organization?: string;
  datasetCount: number | null;
};

/** Options for the Discovery API search. */
export type FindDatasetsOptions = {
  query?: string;
  domain?: string;
  categories?: string[];
  tags?: string[];
  only?: 'datasets' | 'maps' | 'files' | 'calendars' | 'stories';
  order?: 'relevance' | 'page_views_total' | 'created_at' | 'updated_at';
  limit?: number;
  offset?: number;
};

/** Options for SoQL query execution. */
export type QueryDatasetOptions = {
  domain: string;
  datasetId: string;
  search?: string;
  select?: string;
  where?: string;
  group?: string;
  having?: string;
  order?: string;
  limit?: number;
  offset?: number;
};

/** Result of a SoQL query. */
export type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** Portal hostname queried, normalized from the caller's domain. */
  domain: string;
  totalCount?: number;
  assembledQuery: string;
  /**
   * SODA type of each returned field (`number`, `text`, `floating_timestamp`,
   * `boolean`, geo types, …), keyed by field name in header order — from the
   * response's `X-SODA2-Fields` / `X-SODA2-Types` headers, so aliases and
   * aggregates (`count(*) as n` → `number`) are included. Absent when either
   * header is missing or they do not pair up.
   */
  fieldTypes?: ReadonlyMap<string, string>;
};

/**
 * Structured SODA API error shape. The error-code key varies by upstream
 * subsystem: the SoQL compiler emits `code` (e.g. `query.compiler.malformed`),
 * the query coordinator emits `errorCode` (e.g. `query.soql.no-such-column`).
 * Not every error body has this shape — a SODA 404 can carry only
 * `{ error: true, message }`, and Discovery answers `{ error: "<message>" }` —
 * so this type gates only the 400/403 branches; status alone classifies the rest.
 */
export type SodaError = {
  code?: string;
  errorCode?: string;
  message: string;
  data?: Record<string, unknown>;
};

/** Regex pattern for valid Socrata four-by-four dataset IDs. */
export const DATASET_ID_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}$/;
