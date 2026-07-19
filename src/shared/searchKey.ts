/**
 * Key composition for the reshaped search index (SearchTableV2):
 *   PK `pk` = `${key}#${value}`   — one partition per (tag key, value).
 *   SK `sk` = `${sortDate}#${id}`  — sortable ISO date then the item id.
 *
 * Crucial property for the query engine: an item's `sk` is IDENTICAL across
 * every partition it belongs to (sortDate is computed once per item at write
 * time), so intersecting tag partitions is a sorted merge on `sk`, and the
 * pagination cursor is just the last emitted `sk`.
 *
 * INTENTIONALLY VENDORED (mirrors the copy in ac-fn-calculate-relationship-
 * updates and ac-commander) — see that file's header for why.
 */

export const SEARCH_KEY_SEP = "#";

/** Partition key: one partition per (tag key, value). */
export const searchPartitionKey = (key: string, value: string): string =>
  `${key}${SEARCH_KEY_SEP}${value}`;
