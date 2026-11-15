export async function readMetadata(file) {
  await import("./vendor/exifreader/dist/exif-reader.js");
  return globalThis.ExifReader.load(await file.arrayBuffer(), { expanded: true, async: true });
}

export function gpsSummary(tags) {
  const latitude = tags.gps?.Latitude, longitude = tags.gps?.Longitude;
  if (Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    return `GPS found: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
  }
  const hasGps = Object.entries(tags).some(([group, entries]) => entries && typeof entries === "object" &&
    Object.entries(entries).some(([key, value]) => value !== null && value !== undefined && (group === "gps" || /gps|location/i.test(key))));
  return hasGps ? "Location fields found. Inspect the metadata below for details." : "No GPS coordinates found in readable metadata.";
}

export function metadataText(tags) {
  const text = JSON.stringify(tags, (key, value) => {
    if (ArrayBuffer.isView(value)) return `[${value.byteLength} binary bytes; not displayed]`;
    if (value instanceof ArrayBuffer) return `[${value.byteLength} binary bytes; not displayed]`;
    if (typeof value === "string" && value.length > 10000) return `${value.slice(0, 10000)}... [display truncated]`;
    if (Array.isArray(value) && value.length > 200) return [...value.slice(0, 200), "[display truncated]"];
    return value;
  }, 2);
  return text.length > 100000 ? `${text.slice(0, 100000)}\n[Metadata display truncated.]` : text;
}
