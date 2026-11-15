export class LocalWorker {
  constructor(url, name) {
    this.url = url;
    this.name = name;
    this.worker = null;
    this.pending = false;
    this.sequence = 0;
  }

  run(operation, payload, signal, progress, transfer = []) {
    if (this.pending) return Promise.reject(new Error(`Another ${this.name} operation is still running.`));
    if (signal?.aborted) return Promise.reject(new DOMException("Cancelled.", "AbortError"));
    this.worker ||= new Worker(this.url, { type: "module" });
    const worker = this.worker, id = ++this.sequence;
    this.pending = true;
    return new Promise((resolve, reject) => {
      const finish = (error, value, terminate = false) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        worker.onmessage = worker.onerror = null;
        this.pending = false;
        if (terminate) { worker.terminate(); this.worker = null; }
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new DOMException("Cancelled.", "AbortError"), null, true);
      const timer = setTimeout(() => finish(new Error(`The local ${this.name} engine timed out. Try again or disable this feature for the batch.`), null, true), 180000);
      signal?.addEventListener("abort", abort, { once: true });
      worker.onmessage = ({ data }) => {
        if (data.id !== id) return;
        if (data.type === "progress") { progress?.(data.message); return; }
        if (data.type === "error") {
          const error = new Error(data.message);
          error.name = data.name || "Error";
          finish(error, null, true);
        } else finish(null, data.result);
      };
      worker.onerror = event => {
        event.preventDefault();
        finish(new Error(`The local ${this.name} engine could not run. ${event.message}`), null, true);
      };
      try { worker.postMessage({ ...payload, id, operation }, transfer); }
      catch (error) { finish(error, null, true); }
    });
  }

  close() { this.worker?.terminate(); this.worker = null; }
}
