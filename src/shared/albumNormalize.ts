import { TAG_VIRTUAL_ALBUM } from "./albumTags.js";
import type { Album, MediaType, SavedSearch } from "./types.js";

const VALID_MEDIA_TYPES = new Set<MediaType>(["all", "photo", "video", "audio", "diary"]);

/**
 * Normalize a raw AlbumsTable row into the always-{kind,search} `Album` shape.
 *
 * New rows (written by create-album) already carry `kind` and `search`
 * explicitly. This also backward-normalizes rows written before the album
 * unification — which had neither field on a plain album, and only `search`
 * (no `kind`) on a saved-search album — so every reader (get-albums,
 * delete-album) sees the same invariant without requiring a one-time
 * AlbumsTable rewrite: a manual album's search is synthesized from its id.
 */
export const normalizeAlbum = (raw: {
  id: string;
  name: string;
  kind?: unknown;
  search?: unknown;
}): Album => {
  const isManual = raw.kind === "manual" || (!raw.kind && !raw.search);
  if (isManual) {
    return {
      id: raw.id,
      name: raw.name,
      kind: "manual",
      search: {
        tags: [{ key: TAG_VIRTUAL_ALBUM, value: raw.id }],
        mediaType: "all",
      },
    };
  }

  const rawSearch = (raw.search ?? {}) as Omit<Partial<SavedSearch>, "mediaType"> & {
    mediaType?: unknown;
  };
  // Legacy rows may carry the old "both" sentinel.
  const rawMediaType =
    rawSearch.mediaType === "both" ? "all" : rawSearch.mediaType;
  const mediaType: MediaType = VALID_MEDIA_TYPES.has(rawMediaType as MediaType)
    ? (rawMediaType as MediaType)
    : "all";

  return {
    id: raw.id,
    name: raw.name,
    kind: "smart",
    search: { tags: rawSearch.tags ?? [], mediaType },
  };
};
