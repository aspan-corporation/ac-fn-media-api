/**
 * Recursively enumerate the items under a folder prefix by walking the meta
 * table's `by-folder` GSI, instead of a full-table Scan with
 * begins_with(id, prefix).
 *
 * The GSI partitions by the `folder` attribute (an item's immediate parent
 * folder). Folder-marker items (ids ending in "/") make the tree navigable:
 * querying folder=P returns P's direct children, including any sub-folder
 * markers, which we then descend into. Marker coverage is complete for the
 * library (validated 2026-07-01: every distinct folder value has a marker and
 * every marker's parent chain is intact), so this walk returns the same set as
 * the Scan — while reading only the subtree, not all ~91k rows.
 *
 * The dependency is expressed as a narrow interface so this module stays free
 * of the (ESM-only) ac-shared runtime import and is trivially unit-testable.
 */

export type FolderTag = { key: string; value: string };
export type FolderItem = { id: string; tags: FolderTag[] };

export interface FolderQueryClient {
  queryCommand(input: {
    TableName: string;
    IndexName: string;
    KeyConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
    ProjectionExpression: string;
    ExclusiveStartKey?: Record<string, unknown>;
  }): Promise<{
    Items?: Array<Record<string, unknown>>;
    LastEvaluatedKey?: Record<string, unknown>;
  }>;
}

export const BY_FOLDER_INDEX = "by-folder";

const isMarker = (id: string): boolean => id.endsWith("/");

/**
 * Collect every descendant item under `rootPrefix`.
 *
 * @param opts.includeMarkers when false, folder-marker rows are still traversed
 *   (so their subtrees are found) but omitted from the result — matching
 *   bulk-tag's "real media items only" semantics. hide-folder passes true so
 *   the whole folder tree, markers included, gets the hidden tag.
 *
 * Note: this returns the *descendants* of `rootPrefix`. The marker whose id
 * equals `rootPrefix` (the folder itself) is not returned here — a caller that
 * needs it (hide-folder, to hide the folder from its parent's listing) fetches
 * it directly.
 */
export const collectFolderTree = async (
  client: FolderQueryClient,
  tableName: string,
  rootPrefix: string,
  opts: { includeMarkers: boolean },
): Promise<FolderItem[]> => {
  const results: FolderItem[] = [];
  const visited = new Set<string>();
  const queue: string[] = [rootPrefix];

  while (queue.length > 0) {
    const folder = queue.shift() as string;
    if (visited.has(folder)) continue;
    visited.add(folder);

    let startKey: Record<string, unknown> | undefined;
    do {
      const { Items, LastEvaluatedKey } = await client.queryCommand({
        TableName: tableName,
        IndexName: BY_FOLDER_INDEX,
        KeyConditionExpression: "#folder = :folder",
        ExpressionAttributeNames: { "#folder": "folder", "#tags": "tags" },
        ExpressionAttributeValues: { ":folder": folder },
        ProjectionExpression: "id, #tags",
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      });

      for (const raw of (Items ?? []) as Array<{ id?: string; tags?: FolderTag[] }>) {
        if (typeof raw.id !== "string") continue;
        if (isMarker(raw.id)) {
          queue.push(raw.id); // always descend so no subtree is missed
          if (!opts.includeMarkers) continue;
        }
        results.push({ id: raw.id, tags: raw.tags ?? [] });
      }

      startKey = LastEvaluatedKey;
    } while (startKey);
  }

  return results;
};
