export const LIMITS = { files: 100, fileBytes: 50 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, pixels: 40000000, dimension: 16384, resultsBytes: 512 * 1024 * 1024 };
export const MIME_TYPES = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException("Cancelled.", "AbortError");
}

export function validateSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > LIMITS.dimension || height > LIMITS.dimension || width * height > LIMITS.pixels) {
    throw new Error("Images must be at most 40 megapixels and 16,384 pixels per side.");
  }
}

export function makeCanvas(width, height) {
  validateSize(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Not enough image memory. Try a smaller image or fewer files.");
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

export async function canvasBlob(canvas, mime = "image/png", quality = 1, signal) {
  checkAbort(signal);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, quality));
  checkAbort(signal);
  if (!blob || !blob.size) throw new Error("The browser could not encode this image. Try a smaller size.");
  if (blob.type !== mime) throw new Error(`This browser cannot create ${mime.replace("image/", "").toUpperCase()} files. Choose PNG or JPEG.`);
  return blob;
}

export async function sniffType(file) {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const text = new TextDecoder("latin1").decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 137 && text.slice(1, 8) === "PNG\r\n\x1a\n") return "image/png";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  if (/^GIF8[79]a/.test(text)) return "image/gif";
  if (text.startsWith("BM")) return "image/bmp";
  if (text.slice(4, 8) === "ftyp" && /avif|avis/.test(text.slice(8))) return "image/avif";
  throw new Error("Unsupported image. Use JPEG, PNG, WebP, AVIF, GIF, or BMP. HEIC, TIFF, and SVG are not supported.");
}

export async function decodeImage(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (error) { throw new Error(`This image could not be decoded by your browser. It may be damaged or unsupported. ${error.message}`); }
  try { validateSize(bitmap.width, bitmap.height); }
  catch (error) { bitmap.close(); throw error; }
  return bitmap;
}

export function fitSize(width, height, resize) {
  if (!resize) return { width, height };
  const { width: maxWidth, height: maxHeight, upscale } = resize;
  if (!maxWidth && !maxHeight) throw new Error("Enter a resize width or height.");
  for (const value of [maxWidth, maxHeight]) {
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > LIMITS.dimension)) {
      throw new Error("Resize dimensions must be whole numbers from 1 to 16,384.");
    }
  }
  const scale = Math.min(maxWidth === null ? Infinity : maxWidth / width,
    maxHeight === null ? Infinity : maxHeight / height, upscale ? Infinity : 1);
  const result = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  validateSize(result.width, result.height);
  return result;
}

export async function imagePreview(file, edge = 1400, signal) {
  const bitmap = await decodeImage(file);
  let canvas;
  try {
    checkAbort(signal);
    const size = fitSize(bitmap.width, bitmap.height, { width: edge, height: edge, upscale: false });
    const surface = makeCanvas(size.width, size.height);
    canvas = surface.canvas;
    surface.context.drawImage(bitmap, 0, 0, size.width, size.height);
    return { blob: await canvasBlob(canvas, "image/png", 1, signal), width: bitmap.width, height: bitmap.height };
  } finally { bitmap.close(); if (canvas) canvas.width = canvas.height = 0; }
}

export async function imagePixels(file, signal) {
  const bitmap = await decodeImage(file);
  let canvas;
  try {
    checkAbort(signal);
    const size = fitSize(bitmap.width, bitmap.height, { width: 1600, height: 1600, upscale: false });
    const surface = makeCanvas(size.width, size.height);
    canvas = surface.canvas;
    surface.context.fillStyle = "#ffffff";
    surface.context.fillRect(0, 0, size.width, size.height);
    surface.context.drawImage(bitmap, 0, 0, size.width, size.height);
    return surface.context.getImageData(0, 0, size.width, size.height);
  } finally { bitmap.close(); if (canvas) canvas.width = canvas.height = 0; }
}

export function validateCover(cover) {
  const { x, y, width, height } = cover;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 ||
      width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
    throw new Error("A cover must have a positive size and stay inside the image.");
  }
  return cover;
}

export function drawCovers(context, covers, width, height, color) {
  context.fillStyle = color;
  for (const cover of covers) {
    validateCover(cover);
    const x = Math.floor(cover.x * width), y = Math.floor(cover.y * height);
    context.fillRect(x, y, Math.ceil((cover.x + cover.width) * width) - x, Math.ceil((cover.y + cover.height) * height) - y);
  }
}

function watermarkPosition(position, width, height, markWidth, markHeight, padding) {
  const x = position.endsWith("left") ? padding : position.endsWith("right") ? width - markWidth - padding : (width - markWidth) / 2;
  const y = position.startsWith("top") ? padding : position.startsWith("bottom") ? height - markHeight - padding : (height - markHeight) / 2;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

function drawWatermark(context, width, height, options, logo) {
  if (options.kind === "none") return;
  const padding = Math.max(1, Math.min(width, height) * .03);
  const availableWidth = Math.max(1, width - 2 * padding), availableHeight = Math.max(1, height - 2 * padding);
  context.save();
  context.globalAlpha = options.opacity;
  if (options.kind === "text") {
    let fontSize = Math.max(1, Math.min(width * options.size / 100, height * .4));
    context.font = `700 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
    fontSize *= Math.min(1, availableWidth / Math.max(1, context.measureText(options.text).width));
    context.font = `700 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
    const markWidth = context.measureText(options.text).width, markHeight = fontSize * 1.2;
    const position = watermarkPosition(options.position, width, height, markWidth, markHeight, padding);
    context.textBaseline = "top";
    context.fillStyle = options.color;
    context.fillText(options.text, position.x, position.y);
  } else {
    if (!logo) throw new Error("Choose a logo image for the watermark.");
    const scale = Math.min(width * options.size / 100 / logo.width, availableWidth / logo.width, availableHeight / logo.height);
    const markWidth = logo.width * scale, markHeight = logo.height * scale;
    const position = watermarkPosition(options.position, width, height, markWidth, markHeight, padding);
    context.drawImage(logo, position.x, position.y, markWidth, markHeight);
  }
  context.restore();
}

export async function encodeToTarget(original, mime, quality, targetBytes, allowShrink, signal, preserveMetadata) {
  if (!Number.isFinite(quality) || quality < .05 || quality > 1) throw new Error("Choose an image quality from 5% to 100%.");
  if (targetBytes !== null && (!Number.isSafeInteger(targetBytes) || targetBytes < 1)) throw new Error("Enter a positive target file size.");
  let canvas = original;
  const encode = async value => {
    const pixels = await canvasBlob(canvas, mime, value, signal);
    if (!preserveMetadata) return pixels;
    const blob = await preserveMetadata(pixels, canvas.width, canvas.height);
    checkAbort(signal);
    if (!(blob instanceof Blob) || !blob.size || blob.type !== mime) throw new Error("Metadata preservation did not return a valid output image.");
    return blob;
  };
  const metadataHint = preserveMetadata ? " Retained metadata also counts toward the limit; increase it or enable metadata removal." : "";
  try {
    for (;;) {
      checkAbort(signal);
      const blob = await encode(quality);
      if (targetBytes === null || blob.size <= targetBytes) return { blob, width: canvas.width, height: canvas.height, quality };
      let smallest = blob;
      if (mime !== "image/png") {
        smallest = await encode(.05);
        if (smallest.size <= targetBytes) {
          let low = .05, high = quality, best = smallest;
          for (let i = 0; i < 8; i++) {
            const middle = (low + high) / 2;
            const candidate = await encode(middle);
            if (candidate.size <= targetBytes) { low = middle; best = candidate; }
            else high = middle;
          }
          return { blob: best, width: canvas.width, height: canvas.height, quality: low };
        }
      }
      if (!allowShrink) throw new Error(`The target cannot be met at these dimensions. Allow smaller dimensions, choose JPEG/WebP, or increase the target.${metadataHint}`);
      if (canvas.width === 1 && canvas.height === 1) throw new Error(`The target is smaller than the format's minimum file size. Increase the target.${metadataHint}`);
      const scale = Math.min(.85, Math.sqrt(targetBytes / smallest.size) * .9);
      const surface = makeCanvas(Math.max(1, Math.floor(canvas.width * scale)), Math.max(1, Math.floor(canvas.height * scale)));
      surface.context.drawImage(original, 0, 0, surface.canvas.width, surface.canvas.height);
      if (canvas !== original) canvas.width = canvas.height = 0;
      canvas = surface.canvas;
    }
  } finally { if (canvas !== original) canvas.width = canvas.height = 0; }
}

export function resultType(format, sourceType) {
  if (format === "keep") return Object.values(MIME_TYPES).includes(sourceType) ? sourceType : "image/png";
  if (!MIME_TYPES[format]) throw new Error("Choose PNG, JPEG, or WebP as the output format.");
  return MIME_TYPES[format];
}

export async function processImage(item, settings, logo, signal, preserveMetadata) {
  const removeMetadata = settings.removeMetadata !== false;
  if (!removeMetadata && !preserveMetadata) throw new Error("Metadata preservation is unavailable. Try again or enable metadata removal.");
  const image = await decodeImage(item.file);
  let canvas;
  try {
    checkAbort(signal);
    const size = fitSize(image.width, image.height, settings.resize);
    const surface = makeCanvas(size.width, size.height);
    canvas = surface.canvas;
    const context = surface.context;
    context.drawImage(image, 0, 0, size.width, size.height);
    image.close();
    if (settings.background) {
      const mask = item.backgroundMask;
      if (!mask || mask.data.length !== mask.width * mask.height) throw new Error("Background removal has not finished for this image.");
      const small = makeCanvas(mask.width, mask.height);
      try {
        const pixels = small.context.createImageData(mask.width, mask.height);
        for (let i = 0; i < mask.data.length; i++) {
          pixels.data[i * 4] = pixels.data[i * 4 + 1] = pixels.data[i * 4 + 2] = 255;
          pixels.data[i * 4 + 3] = mask.data[i];
        }
        small.context.putImageData(pixels, 0, 0);
        context.globalCompositeOperation = "destination-in";
        context.drawImage(small.canvas, 0, 0, size.width, size.height);
        context.globalCompositeOperation = "source-over";
      } finally { small.canvas.width = small.canvas.height = 0; }
    }
    drawCovers(context, item.covers, size.width, size.height, settings.coverColor);
    drawWatermark(context, size.width, size.height, settings.watermark, logo);
    const mime = resultType(settings.format, item.type);
    if (mime === "image/jpeg") {
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size.width, size.height);
      context.globalCompositeOperation = "source-over";
    }
    const result = await encodeToTarget(canvas, mime, settings.quality, settings.targetBytes, settings.allowShrink, signal, removeMetadata ? null : preserveMetadata);
    return { ...result, type: mime, metadataRemoved: removeMetadata };
  } finally { image.close(); if (canvas) canvas.width = canvas.height = 0; }
}

export function safeFilename(name, extension) {
  let base = name.replace(/\.[^.]*$/, "").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-").replace(/^[. ]+|[. ]+$/g, "").slice(0, 100);
  if (/[\uD800-\uDBFF]$/.test(base)) base = base.slice(0, -1);
  if (!base) base = "image";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `image-${base}`;
  return `${base}-processed.${extension}`;
}

export function uniqueFilename(name, used) {
  const dot = name.lastIndexOf(".");
  let result = name, suffix = 2;
  while (used.has(result.toLowerCase())) result = `${name.slice(0, dot)}-${suffix++}${name.slice(dot)}`;
  used.add(result.toLowerCase());
  return result;
}
