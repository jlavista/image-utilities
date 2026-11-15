import { LocalWorker } from "./worker-client.js?v=2026.11.15.1";

export class LocalAI extends LocalWorker {
  constructor() {
    super(new URL("./ai-worker.js?v=2026.11.15.1", import.meta.url), "AI");
  }

  run(operation, image, signal, progress) {
    return super.run(operation, { width: image.width, height: image.height, pixels: image.data.buffer },
      signal, progress, [image.data.buffer]);
  }
}
