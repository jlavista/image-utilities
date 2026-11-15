# JustTools / Image Utilities

**[Use Image Utilities](https://jlavista.github.io/image-utilities/)** &middot; **[All JustTools](https://jlavista.github.io/just-tools/)**

A static HTML, CSS, and JavaScript app. All image processing, metadata inspection, face detection, and background removal happen in the browser. No accounts, uploads, analytics, build step, CDN requests, or remote inference.

## Run locally

From the Image Utilities repository directory:

```powershell
python -m http.server 8004 --bind 127.0.0.1
```

Open http://localhost:8004/. Use HTTP on localhost or HTTPS, not `file://`. This repository is self-contained; keep the `vendor` directory alongside the app.

## GitHub Pages

The public site is https://jlavista.github.io/image-utilities/. Deploy from the `main` branch and **/ (root)** in **Settings > Pages**. Keep `.nojekyll` in the root so bundled libraries, models, and license files are served unchanged. No server-side processing or build service is needed by the app.

## Privacy

- **Remove GPS and metadata:** checked by default in the Privacy tool. Every output is re-encoded from pixels; with this checked, original EXIF, GPS, IPTC, XMP, comments, MakerNotes, and embedded thumbnails are not copied. Files can still contain ordinary encoding headers, dimensions, and browser-generated color information. This is not a lossless metadata-only byte edit; JPEG/WebP re-encoding can change quality or size.
- **Keep metadata:** uncheck **Remove GPS & metadata** to copy supported EXIF, GPS, IPTC, XMP, and comments into the processed files. Retained fields can identify locations, people, and devices. Not every field is supported by every output format, especially when converting. Old embedded previews, thumbnail directories, opaque camera MakerNotes, and original color profiles are excluded; these can contain unedited images or no longer describe the processed pixels. EXIF orientation and dimensions match the result, and stale redundant XMP orientation/dimension fields are omitted. Unreadable metadata or a writer failure fails that image explicitly; the app does not silently switch back to stripping.
- WebP keeps EXIF/XMP, not native IPTC or image comments. PNG uses a legacy text block for IPTC, which some readers do not understand. Result cards show these compatibility notices, deliberately excluded unrecognized MakerNotes, or when no compatible metadata was available to copy. Other writer warnings remain explicit failures.
- **Read GPS and metadata:** use the image inspector to read the original, or inspect the generated result. Location coordinates are shown as text without contacting a map service. Proprietary tags may not all be recognized. Read errors are explicit, not treated as proof that metadata is absent. Binary payloads and very large values are omitted or truncated in the display.
- **Cover faces:** enable automatic covering for the batch or run Detect faces on one image. The local full-range BlazeFace model suggests slightly enlarged rectangles. Draw additional covers, select and adjust their percentage coordinates, remove incorrect covers, or undo an edit. Covers are opaque pixel replacements in outputs, not removable layers or weak blur filters. Manual corrections are kept when processing again; explicitly running Detect faces again refreshes automatic suggestions.
- **Review every image.** Detection can miss small, side-on, obscured, or otherwise difficult faces. Metadata removal and face covers do not remove all identifying content, including readable text, addresses, reflections, recognizable clothing, or contextual details.
- Original filenames are retained with a `-processed` suffix unless **Use neutral filenames** is selected. ZIP contains prepared outputs only, never original images or metadata reports. Names are sanitized and duplicate ZIP names get numeric suffixes.
- Images, metadata, covers, and outputs are kept only in memory in the current tab. Nothing is written to localStorage or IndexedDB. Clear all also releases the logo, AI worker, and metadata worker. Closing the tab discards the workspace; downloads remain on disk. Browsers can cache the static app and model assets, which do not contain user images.
- A same-origin Content Security Policy prevents app scripts, image loads, and connections from contacting external services. Models and libraries are bundled, not fetched from their upstream sites at runtime.

## Utilities

1. Use **Choose images** at the top of the left sidebar, or drop files there. Select one or many using the image checkboxes.
2. Open a tool in the sidebar to adjust its settings. Only one tool is expanded at a time; closing it keeps its settings active. Resize, target-size, and watermark options appear when enabled. Format limits and extra explanations are available in the help disclosures.
3. **Process selected images** to see every prepared image in the **Processed images** gallery. Click a thumbnail for a larger view, use **Actual size (100%)** to inspect original output pixels, and return with **Close** or Escape. Download any result individually or choose **Download all results (.zip)**.

Result thumbnails come from the processed files, including their covers, cutouts, and watermarks. Unprocessed or failed inputs are not shown as results. Gallery entries update or disappear when their outputs change; selecting different input checkboxes does not hide prepared results.

Supported inputs: JPEG, PNG, WebP, AVIF, GIF, and BMP, subject to native browser decoding. Animations use the first frame. HEIC, TIFF, and SVG are deliberately rejected. Outputs: JPEG, PNG, or WebP. Original type keeps those three formats and uses PNG for other input types. If the browser cannot encode a chosen format, an error is shown rather than silently changing the file type.

- **Resize / bulk resize:** set one dimension or fit inside both bounds, preserving aspect ratio without cropping. Smaller images are not enlarged unless explicitly enabled.
- **Compress:** JPEG/WebP quality slider. PNG stays lossless; already-compressed images may grow. Result cards compare actual bytes and dimensions.
- **Compress to a target size:** find a fitting JPEG/WebP quality no higher than the slider. If necessary and permitted, reduce dimensions and retry. PNG can meet a smaller target only by reducing dimensions. Every successful output, including any retained metadata, is measured to be at or below the requested byte limit. If the target is impossible, the file fails visibly; no oversized result is provided and metadata is not silently discarded. Units use 1 KB = 1,024 bytes.
- **Convert:** preserves displayed EXIF orientation, with transparent PNG/WebP output where applicable. JPEG is flattened onto white. Browser color conversion can differ from the original color profile.
- **Background removal:** local U2Netp saliency segmentation, with a 320 x 320 model input and a soft alpha mask scaled to the output image. Existing transparency is retained. Best for a clear foreground subject; hair, transparent objects, and busy backgrounds may need further editing. JPEG has a white background, not transparency.
- **Batch watermarking:** text or a local logo, with relative sizing, opacity, color for text, and corner/center placement. Marks scale to each output image and long text is fitted within the image. A target-size downscale also scales the watermark.
- **ZIP:** includes all currently prepared results, even if their input checkboxes have since changed. Unprocessed or failed images are not included; the ready count and per-image failures remain visible. Changing shared settings invalidates results so outdated files are not accidentally downloaded.

Files are processed sequentially to limit memory. Limits: 100 files, 50 MB per input, 256 MB of inputs, 40 megapixels and 16,384 pixels per side, and 512 MB of prepared results. Actual capacity still depends on the device. Cancel stops AI and metadata workers immediately; a native image-encoding operation may finish before cancellation is observed. Completed results remain available.

## Local AI and dependencies

AI is lazy-loaded and runs in a module Web Worker, separate from the interface. ONNX Runtime uses one WASM thread, so no cross-origin isolation headers, GPU, or external server are required. The two AI feature sets load approximately 31 MB of static engines and models on first use.

The U2Netp pipeline follows rembg: resize to 320 x 320, normalize RGB by the image maximum and ImageNet means/standard deviations, run the first fused model output, min-max normalize, and scale the mask back to the image. The model's MD5 matches rembg's published checksum.

Keeping metadata lazy-loads a separate ExifTool/ZeroPerl WebAssembly worker, approximately 27 MB from this app. Default metadata removal does not load it. Its filesystem is private worker memory, not your disk. Each copy uses fixed internal filenames and removes its temporary files afterward. It never receives an ExifTool configuration or commands from image metadata or user filenames. The pinned CLI and WASM are a checksum-verified pair; the adapter source and build instructions are bundled in `vendor\exiftool`.

See `vendor\dependencies.json` for pinned versions and upstream download URLs, and `vendor\NOTICE.txt` for credits and licenses. ExifReader's unmodified source files and build configuration are included in `vendor\exifreader\source.zip` under MPL-2.0; the app itself does not modify that library.

## Browser regressions

Tests use Python unittest, Playwright, and Pillow, with an isolated Microsoft Edge profile and a temporary local server:

```powershell
python -m unittest discover -s .\tests -v
```

Set `IMAGE_UTILITIES_TEST_BROWSER` to another Chromium executable if needed. User browser profiles and files are never used. Fixtures/downloads are temporary, except the attributed public-domain image used for real AI inference. Tests verify actual output formats, dimensions, byte limits, metadata removal and retention, discarded embedded previews, opaque covers, ZIP entries, failure handling, and local-only requests.

App, worker, module, and stylesheet version strings are updated together. The visible version changes from `loading...` to `ready` only after the interface initializes.
