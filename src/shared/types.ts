export type Maybe<T> = T | null | undefined;

export type Tag = { key: string; value: string };
export type TagInput = { key: string; value: string };
export type MetaData = { id: string; tags: Tag[] };
export type MetaDataInput = { tags: TagInput[] };
export type SearchInput = { filter: MetaDataInput };
export type FolderConnection = { entries: MetaData[]; nextToken?: Maybe<string> };
export type TagsConnection = { tags: Tag[]; nextToken?: Maybe<string> };
export type Album = { id: string; name: string };
export type AlbumsConnection = { albums: Album[]; nextToken?: Maybe<string> };
export type CreateAlbumInput = { name: string };
