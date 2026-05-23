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

/** Full dataset metadata from the views API. */
export type DatasetMetadata = {
  datasetId: string;
  domain: string;
  name: string;
  description?: string;
  category?: string;
  tags: string[];
  rowCount?: number;
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
  columnNames: string[];
  license?: string;
  dataUpdatedAt?: string;
  viewCount?: number;
};

/** A portal entry from the Discovery API domains endpoint. */
export type PortalEntry = {
  domain: string;
  organization?: string;
  datasetCount: number;
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
  rows: Record<string, string>[];
  rowCount: number;
  totalCount?: number;
  assembledQuery: string;
};

/** Structured SODA API error shape. */
export type SodaError = {
  code: string;
  message: string;
  data?: Record<string, unknown>;
};

/** Regex pattern for valid Socrata four-by-four dataset IDs. */
export const DATASET_ID_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}$/;
