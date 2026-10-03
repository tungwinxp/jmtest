import { createWebGpuRunner } from "./wasm_core.js?v=19";

const CALL_TIMEOUT_MS = 60000;

// Browser glue for the shared Rust WebGPU engine. Rust owns every shader,
// pipeline, device buffer, dispatch, and readback; this file only packs the
// browser's query and index objects into typed arrays.
export class WebGpuLocalFilter {
  static async create(progress = () => {}) {
    if (!globalThis.navigator?.gpu) throw new Error("WebGPU is unavailable in this browser");
    progress("Starting the shared Rust WebGPU engine");
    const rust = await engineCall(createWebGpuRunner(), 10000, "engine startup");
    return new WebGpuLocalFilter(rust);
  }

  constructor(rust) {
    this.rust = rust;
    this.maxStorageBufferBindingSize = Number(rust.maxStorageBufferBindingSize);
    this.adapterInfo = {
      vendor: "",
      architecture: "",
      device: "",
      description: rust.adapterName,
    };
  }

  prepareJoins(segmentCount) {
    this.rust.prepareJoins(segmentCount).catch(() => {});
  }

  async prepareCompressed(hot, metadata, outputPoints, sequence) {
    return this.uploadCompressed(hot, metadata, outputPoints, sequence).decode();
  }

  // Copies the packed bytes to the device now; `decode()` later yields the searchable chunk.
  // The worker stages its next chunk this way while the device searches the current one.
  uploadCompressed(hot, metadata, outputPoints, sequence) {
    requireArray(hot, Uint8Array, "CAD1 byte stream");
    requireArray(metadata, Uint32Array, "CAD1 target metadata");
    if (!(sequence?.bytes instanceof Uint8Array)
        || !(sequence.meta instanceof Uint32Array)
        || !(sequence.params instanceof Uint32Array)
        || sequence.params.length !== 6) {
      throw new TypeError("WebGPU CAD1 decode requires a packed sequence slice");
    }
    if (!Number.isSafeInteger(outputPoints) || outputPoints < 0) {
      throw new RangeError("WebGPU CAD1 decode requires a valid output residue count");
    }
    let upload = this.rust.uploadCompressed(
      hot, metadata, outputPoints, sequence.bytes, sequence.meta, sequence.params,
    );
    return {
      decode: async () => {
        const staged = upload;
        if (!staged) throw new Error("WebGPU chunk upload was already consumed");
        upload = null;
        // `decode` consumes the Rust upload whether or not it succeeds.
        return new WebGpuChunk(this, await engineCall(
          staged.decode(), CALL_TIMEOUT_MS, "compressed chunk preparation",
        ));
      },
      dispose: () => {
        upload?.free();
        upload = null;
      },
    };
  }

  cancel() {
    this.rust.cancel();
  }
}

class WebGpuChunk {
  constructor(owner, rust) {
    this.owner = owner;
    this.rust = rust;
    this.disposed = false;
  }

  async prepareGroupedWindows(requests, targetCount) {
    if (this.disposed) throw new Error("WebGPU coordinate chunk was disposed");
    if (!requests.length || !targetCount) {
      throw new Error("grouped windows need targets and segments");
    }
    const started = performance.now();
    const packed = packWindowRequests(requests);
    const rust = await engineCall(this.rust.selectWindows(
      packed.runs,
      packed.queries,
      packed.gateOffsets,
      packed.allowedCodes,
      packed.metadata,
      packed.fits,
    ), CALL_TIMEOUT_MS, "candidate window selection");
    const flatCounts = rust.counts();
    const totals = rust.totals();
    if (flatCounts.length !== requests.length * targetCount || totals.length !== requests.length) {
      rust.free();
      throw new Error("shared WebGPU engine returned inconsistent window counts");
    }
    const sets = Array.from(totals, (total, segment) => ({
      counts: flatCounts.slice(segment * targetCount, (segment + 1) * targetCount),
      total,
    }));
    return new WebGpuCandidateBatch(rust, sets, targetCount, started);
  }

  async joinSegments(batch, order, query, lower2, upper2, sseLimit, frontierCap, onPage = null, spacingBounds = new Int32Array()) {
    if (this.disposed || batch.disposed) throw new Error("WebGPU candidate batch was disposed");
    const pager = batch.rust.startJoin(
      Uint32Array.from(order),
      query.coords,
      Uint32Array.from(query.segments, (segment) => segment.qStart),
      Uint32Array.from(query.segments, (segment) => segment.length),
      Float32Array.from(lower2 ?? zeroMatrix(order.length)),
      Float32Array.from(upper2 ?? zeroMatrix(order.length)),
      sseLimit,
      frontierCap,
      spacingBounds.slice(0, spacingBounds.length / 2),
      spacingBounds.slice(spacingBounds.length / 2),
    );
    const pages = [];
    let counts = new Uint32Array();
    try {
      for (;;) {
        const page = await engineCall(pager.nextPage(), CALL_TIMEOUT_MS, "segment join page");
        try {
          if (page.done) {
            counts = page.stageCounts();
            break;
          }
          const rows = page.rows();
          if (onPage) await onPage(rows);
          else pages.push(rows);
        } finally {
          page.free();
        }
      }
      return { rows: onPage ? new Uint32Array() : concatenateWords(pages), counts };
    } finally {
      pager.free();
    }
  }

  dispose() {
    if (!this.disposed) {
      this.rust.free();
      this.disposed = true;
    }
  }
}

class WebGpuCandidateBatch {
  constructor(rust, sets, targetCount, started) {
    this.rust = rust;
    this.sets = sets;
    this.targetCount = targetCount;
    this.started = started;
    this.disposed = false;
  }

  dispose() {
    if (!this.disposed) {
      this.rust.free();
      this.disposed = true;
    }
  }
}

function packWindowRequests(requests) {
  let runWords = 0;
  let queryFloats = 0;
  let gateWords = 0;
  let allowedWords = 0;
  for (const request of requests) {
    requireArray(request.runs?.words, Uint32Array, "window runs");
    requireArray(request.segment?.centered, Float32Array, "centered segment");
    if (!request.segment.length
        || request.segment.centered.length !== request.segment.length * 3) {
      throw new Error("grouped windows need a centered segment");
    }
    const gates = request.gateOffsets ?? EMPTY_U32;
    const allowed = request.allowedTable ?? EMPTY_U32;
    requireArray(gates, Uint32Array, "chemistry gate offsets");
    requireArray(allowed, Uint32Array, "chemistry flags");
    if (allowed.length !== gates.length * 256) {
      throw new Error("grouped windows need 256 allowed-code flags per chemistry gate");
    }
    runWords += request.runs.words.length;
    queryFloats += request.segment.centered.length;
    gateWords += gates.length;
    allowedWords += allowed.length;
  }

  const runs = new Uint32Array(runWords);
  const queries = new Float32Array(queryFloats);
  const gateOffsets = new Uint32Array(gateWords);
  const allowedCodes = new Uint32Array(allowedWords);
  const metadata = new Uint32Array(requests.length * 8);
  const fits = new Float32Array(requests.length * 2);
  let runAt = 0;
  let queryAt = 0;
  let gateAt = 0;
  let allowedAt = 0;
  requests.forEach((request, index) => {
    const gates = request.gateOffsets ?? EMPTY_U32;
    const allowed = request.allowedTable ?? EMPTY_U32;
    const base = index * 8;
    metadata.set([
      runAt,
      runAt + request.runs.words.length,
      request.runs.windowCount,
      queryAt,
      request.segment.length,
      gateAt,
      gates.length,
      allowedAt,
    ], base);
    fits.set([request.segment.norm, request.localCut2], index * 2);
    runs.set(request.runs.words, runAt);
    queries.set(request.segment.centered, queryAt);
    gateOffsets.set(gates, gateAt);
    allowedCodes.set(allowed, allowedAt);
    runAt += request.runs.words.length;
    queryAt += request.segment.centered.length;
    gateAt += gates.length;
    allowedAt += allowed.length;
  });
  return { runs, queries, gateOffsets, allowedCodes, metadata, fits };
}

const EMPTY_U32 = new Uint32Array();

function zeroMatrix(segmentCount) {
  return new Float32Array(segmentCount * segmentCount);
}

function requireArray(value, type, label) {
  if (!(value instanceof type)) {
    throw new TypeError(`WebGPU ${label} must be ${type.name}`);
  }
}

function concatenateWords(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint32Array(length);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

async function engineCall(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`WebGPU ${label} timed out after ${milliseconds / 1000} s`)),
          milliseconds,
        );
      }),
    ]);
  } catch (error) {
    const message = error?.message || String(error);
    if (/cancelled/i.test(message)) throw new DOMException("Search cancelled", "AbortError");
    if (error instanceof Error) throw error;
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}
