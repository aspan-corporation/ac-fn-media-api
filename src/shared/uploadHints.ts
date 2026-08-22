/**
 * Presigned-upload helpers shared by every route that hands the browser a
 * presigned PUT (diary uploads, media-library uploads): reducing a
 * browser-supplied filename to a safe S3 leaf, and validating the device
 * date/location hints that ride along as S3 user metadata.
 */

// Reduce a browser-supplied filename to a safe S3 leaf name: strip any path
// components, collapse anything outside a conservative allowlist to "_", and
// cap the length. Returns "" for empty / all-dot names.
export const sanitizeFilename = (raw: string): string => {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._ ()-]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return /^\.*$/.test(cleaned) ? "" : cleaned;
};

// Device hints sent by the browser alongside an upload — the file's own
// timestamp and (for just-taken photos) the device's current position. Mobile
// OSes strip GPS EXIF from files handed to web pages, so this is the only
// location source available. Embedded as S3 user metadata on the presigned
// PUT; the meta-extractor reads them as fallback where EXIF came up empty.
// Validation is deliberately forgiving: hints are best-effort, so a bad value
// is dropped rather than failing the upload with a 400.
export const parseUploadHints = (raw: unknown): Record<string, string> => {
  if (typeof raw !== "object" || raw === null) return {};
  const { date, latitude, longitude } = raw as Record<string, unknown>;
  const out: Record<string, string> = {};

  if (typeof date === "string") {
    const d = new Date(date);
    // Sanity range: after consumer digital cameras existed, not in the future.
    if (
      !isNaN(d.getTime()) &&
      d.getFullYear() >= 1970 &&
      d.getTime() <= Date.now() + 24 * 3600 * 1000
    ) {
      out["hint-date"] = d.toISOString();
    }
  }

  // Coordinates only make sense as a pair; 0 is valid (equator/meridian).
  if (typeof latitude === "number" && typeof longitude === "number") {
    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
    ) {
      out["hint-latitude"] = String(latitude);
      out["hint-longitude"] = String(longitude);
    }
  }

  return out;
};
