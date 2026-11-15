let engine;
const metadataNotices = new Map([
  ["Warning: No writable tags set from /original", "No compatible metadata was available to copy."],
  ["Warning: [minor] Unrecognized MakerNotes - /original", "Opaque camera MakerNotes were excluded along with old previews."],
  ["Warning: [minor] Creating non-standard IPTC in PNG - /pixels", "IPTC was kept in a PNG text block; some apps may not read it."],
]);

async function getEngine(progress) {
  if (engine) return engine;
  progress("Loading local metadata support. Images and GPS stay on your device...");
  try {
    const { ZeroPerl, MemoryFileSystem, exiftool } = await import("./vendor/exiftool/runtime.js");
    const files = new MemoryFileSystem({ "/": "" });
    files.addFile("/exiftool", exiftool);
    const diagnostics = [];
    const perl = await ZeroPerl.create({
      fileSystem: files, outputBuffers: true,
      stdout: () => {},
      stderr: bytes => diagnostics.push(bytes.slice()),
    });
    engine = { files, perl, diagnostics };
    return engine;
  } catch (error) {
    const failure = new Error(`Could not load local metadata support. Try again or enable metadata removal. ${error.message}`);
    failure.name = "MetadataLoadError";
    throw failure;
  }
}

async function copyMetadata({ source, output, width, height }, progress) {
  if (!(source instanceof Blob) || !(output instanceof Blob) ||
      !["image/jpeg", "image/png", "image/webp"].includes(output.type)) {
    throw new Error("Metadata can only be copied to a processed JPEG, PNG, or WebP image.");
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Metadata needs valid output image dimensions.");
  }
  const { files, perl, diagnostics } = await getEngine(progress);
  diagnostics.length = 0;
  await perl.reset();
  try {
    files.addFile("/original", source);
    files.addFile("/pixels", output);
    progress("Keeping supported metadata locally and removing old embedded previews...");
    // Opaque MakerNotes and original image payloads can retain unredacted previews.
    const args = [
      "-config", "", "-tagsFromFile", "/original",
      "-EXIF:all", "-XMP:all", "-IPTC:all", "-PNG:all", "-Comment",
      "--IFD1:all", "--SubIFD:all", "--MakerNotes", "--MakerNotes:all", "--ThumbnailImage",
      "--PreviewImage", "--JpgFromRaw", "--OtherImage", "--ImageSourceData",
      "--XMP-xmp:Thumbnails", "--ICC_Profile", "--ICC_Profile:all",
      "--Gamma", "--SRGBRendering", "--XMP-photoshop:ICCProfile",
      // EXIF below describes the rendered pixels; omit stale redundant XMP values.
      "--XMP-tiff:Orientation", "--XMP-tiff:ImageWidth", "--XMP-tiff:ImageHeight",
      "--XMP-exif:ExifImageWidth", "--XMP-exif:ExifImageHeight", "--XMP-exif:ColorSpace",
      "-IFD0:Orientation#=1", `-IFD0:ImageWidth=${width}`, `-IFD0:ImageHeight=${height}`,
      `-ExifIFD:ExifImageWidth=${width}`, `-ExifIFD:ExifImageHeight=${height}`,
      "-ExifIFD:ColorSpace#=1", "-InteropIFD:InteropIndex=R98",
      "-o", "/result", "/pixels",
    ];
    const result = await perl.runFile("/exiftool", args);
    perl.flush();
    const details = (await new Blob(diagnostics).text()).trim();
    const warnings = details ? details.split(/\r?\n/) : [];
    if (!result.success || result.exitCode !== 0 || warnings.some(warning => !metadataNotices.has(warning))) {
      throw new Error(`Could not preserve metadata. ${details || perl.getLastError() || "The metadata engine failed."} Enable removal to export without it.`);
    }
    const file = files.lookup("/result");
    if (!file || file.type !== "file") throw new Error("The metadata engine did not produce an output image.");
    const blob = new Blob([file.content], { type: output.type });
    if (!blob.size) throw new Error("The metadata engine produced an empty output image.");
    const notes = [...new Set(warnings.map(warning => metadataNotices.get(warning)))];
    if (output.type === "image/webp") notes.push("WebP keeps EXIF/XMP, not native IPTC or image comments.");
    return { blob, note: notes.join(" ") };
  } finally {
    for (const path of ["/original", "/pixels", "/result"]) files.removeFile(path);
    diagnostics.length = 0;
  }
}

self.onmessage = async ({ data }) => {
  const progress = message => self.postMessage({ id: data.id, type: "progress", message });
  try {
    if (data.operation !== "copy") throw new Error("Unknown metadata operation.");
    const result = await copyMetadata(data, progress);
    self.postMessage({ id: data.id, type: "result", result });
  } catch (error) {
    self.postMessage({ id: data.id, type: "error", name: error.name, message: error.message || String(error) });
  }
};
