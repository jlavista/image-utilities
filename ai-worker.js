let faceDetector;
let segmentation;
let ort;
const asset = path => new URL(path, import.meta.url).href;

async function faces(image, progress) {
  if (!faceDetector) {
    progress("Loading the face detector from this app. Photos stay on your device...");
    try {
      const { FaceDetector, FilesetResolver } = await import("./vendor/mediapipe/vision_bundle.mjs");
      const fileset = await FilesetResolver.forVisionTasks(asset("./vendor/mediapipe/wasm/"), true);
      faceDetector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: asset("./vendor/models/blaze_face_full_range.tflite"), delegate: "CPU" },
        runningMode: "IMAGE", minDetectionConfidence: .5, minSuppressionThreshold: .3,
      });
    } catch (error) {
      const failure = new Error(`Could not load the local face detector. ${error.message}`);
      failure.name = "ModelLoadError";
      throw failure;
    }
  }
  progress("Finding faces locally. You will still need to review the covers...");
  return faceDetector.detect(image).detections.map(({ boundingBox: box }) => {
    const x = Math.max(0, (box.originX - box.width * .15) / image.width);
    const y = Math.max(0, (box.originY - box.height * .2) / image.height);
    const right = Math.min(1, (box.originX + box.width * 1.15) / image.width);
    const bottom = Math.min(1, (box.originY + box.height * 1.15) / image.height);
    return { x, y, width: right - x, height: bottom - y };
  }).filter(box => box.width > 0 && box.height > 0);
}

async function background(image, progress) {
  if (!segmentation) {
    progress("Loading the background-removal model from this app. Nothing is uploaded...");
    try {
      ort = await import("./vendor/onnx/dist/ort.wasm.min.mjs");
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = asset("./vendor/onnx/dist/");
      segmentation = await ort.InferenceSession.create(asset("./vendor/models/u2netp.onnx"), {
        executionProviders: ["wasm"], graphOptimizationLevel: "all",
      });
    } catch (error) {
      const failure = new Error(`Could not load local background removal. ${error.message}`);
      failure.name = "ModelLoadError";
      throw failure;
    }
  }
  progress("Separating the subject from its background on your device...");
  const source = new OffscreenCanvas(image.width, image.height);
  const resized = new OffscreenCanvas(320, 320);
  let input, outputs;
  try {
    const sourceContext = source.getContext("2d"), context = resized.getContext("2d");
    if (!sourceContext || !context) throw new Error("Not enough image memory for background removal.");
    sourceContext.putImageData(image, 0, 0);
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, 320, 320);
    const pixels = context.getImageData(0, 0, 320, 320).data;
    let maximum = 1;
    for (let i = 0; i < pixels.length; i += 4) maximum = Math.max(maximum, pixels[i], pixels[i + 1], pixels[i + 2]);
    const area = 320 * 320, tensor = new Float32Array(3 * area);
    const means = [.485, .456, .406], deviations = [.229, .224, .225];
    for (let channel = 0; channel < 3; channel++) {
      for (let i = 0; i < area; i++) tensor[channel * area + i] = (pixels[4 * i + channel] / maximum - means[channel]) / deviations[channel];
    }
    input = new ort.Tensor("float32", tensor, [1, 3, 320, 320]);
    outputs = await segmentation.run({ [segmentation.inputNames[0]]: input });
    const prediction = outputs[segmentation.outputNames[0]].data;
    if (prediction.length !== area) throw new Error("Unexpected background-model output.");
    let minimum = Infinity, max = -Infinity;
    for (const value of prediction) { minimum = Math.min(minimum, value); max = Math.max(max, value); }
    if (!Number.isFinite(max) || !Number.isFinite(minimum) || max - minimum < 1e-6) {
      throw new Error("No clear subject could be separated. Try another image or turn off background removal.");
    }
    const data = new Uint8ClampedArray(area);
    for (let i = 0; i < area; i++) data[i] = (prediction[i] - minimum) / (max - minimum) * 255;
    return { width: 320, height: 320, data };
  } finally {
    input?.dispose();
    if (outputs) for (const output of Object.values(outputs)) output.dispose();
    source.width = source.height = resized.width = resized.height = 0;
  }
}

self.onmessage = async ({ data }) => {
  const { id, operation, pixels, width, height } = data;
  const progress = message => self.postMessage({ id, type: "progress", message });
  try {
    const image = new ImageData(new Uint8ClampedArray(pixels), width, height);
    let result;
    if (operation === "faces") result = await faces(image, progress);
    else if (operation === "background") result = await background(image, progress);
    else throw new Error("Unknown AI operation.");
    self.postMessage({ id, type: "result", result }, operation === "background" ? [result.data.buffer] : []);
  } catch (error) {
    self.postMessage({ id, type: "error", name: error.name, message: error.message || String(error) });
  }
};
