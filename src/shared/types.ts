export type Maybe<T> = T | null | undefined;

export type Tag = { key: string; value: string };
export type TagInput = { key: string; value: string };
export type MetaData = {
  id: string;
  tags: Tag[];
  /** BlurHash placeholder + oriented dimensions, written by the resizer.
   *  Optional: absent on videos and on items not yet (re)processed. */
  blurhash?: string;
  width?: number;
  height?: number;
};
export type MetaDataInput = { tags: TagInput[] };
export type SearchInput = { filter: MetaDataInput };
export type FolderConnection = { entries: MetaData[]; nextToken?: Maybe<string> };
export type TagsConnection = { tags: Tag[]; nextToken?: Maybe<string> };
export type MediaType = "all" | "photo" | "video" | "audio" | "diary";
/** Saved search backing an album — a tag filter plus a media-type. */
export type SavedSearch = { tags: TagInput[]; mediaType: MediaType };
export type AlbumKind = "manual" | "smart";
/**
 * Every album is a saved search. A "manual" album's search is synthesized —
 * its single membership tag (`ac:ediacara:va = <album id>`) — so hand-curated
 * membership and self-updating "smart" searches share one open/query path.
 * `kind` discriminates the two for UI/membership-affordance purposes; `search`
 * is always present on both.
 */
export type Album = { id: string; name: string; kind: AlbumKind; search: SavedSearch };
export type AlbumsConnection = { albums: Album[]; nextToken?: Maybe<string> };
export type CreateAlbumInput = { name: string; search?: SavedSearch };
