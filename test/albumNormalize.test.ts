import { normalizeAlbum } from "../src/shared/albumNormalize";

describe("normalizeAlbum", () => {
  it("treats a row with neither kind nor search as a manual album, synthesizing its membership search", () => {
    const album = normalizeAlbum({ id: "abc", name: "Holidays" });
    expect(album).toEqual({
      id: "abc",
      name: "Holidays",
      kind: "manual",
      search: {
        tags: [{ key: "ac:ediacara:va", value: "abc" }],
        mediaType: "all",
      },
    });
  });

  it("respects an explicit kind: manual even if search is (unexpectedly) present", () => {
    const album = normalizeAlbum({
      id: "abc",
      name: "Holidays",
      kind: "manual",
      search: { tags: [{ key: "x", value: "y" }], mediaType: "photo" },
    });
    // Manual is always synthesized from id — never trusts a stored search.
    expect(album.search).toEqual({
      tags: [{ key: "ac:ediacara:va", value: "abc" }],
      mediaType: "all",
    });
  });

  it("treats a row with only search (no kind) as smart — legacy pre-unification shape", () => {
    const album = normalizeAlbum({
      id: "xyz",
      name: "France",
      search: { tags: [{ key: "ac:tau:country", value: "France" }], mediaType: "photo" },
    });
    expect(album.kind).toBe("smart");
    expect(album.search).toEqual({
      tags: [{ key: "ac:tau:country", value: "France" }],
      mediaType: "photo",
    });
  });

  it("maps a legacy 'both' mediaType sentinel to 'all' on read", () => {
    const album = normalizeAlbum({
      id: "xyz",
      name: "Legacy",
      search: { tags: [], mediaType: "both" },
    });
    expect(album.search.mediaType).toBe("all");
  });

  it("falls back to 'all' for an unrecognized mediaType", () => {
    const album = normalizeAlbum({
      id: "xyz",
      name: "Weird",
      search: { tags: [], mediaType: "pictures" }, // pre-rename legacy value
    });
    expect(album.search.mediaType).toBe("all");
  });

  it("defaults tags to [] when search.tags is missing", () => {
    const album = normalizeAlbum({ id: "xyz", name: "Empty", search: {} });
    expect(album.search.tags).toEqual([]);
  });
});
