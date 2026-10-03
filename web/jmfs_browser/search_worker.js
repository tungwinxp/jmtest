// Keep the worker's static module graph coherent across cached deployments.
// Increment this query token whenever the browser core ABI or orchestration changes.
import { BlobRangeSource, HttpRangeSource, JmfsIndex } from "./jmfs_index.js?v=19";
import { parsePdb, prepareQuery } from "./query.js?v=19";
import { WasmCore } from "./wasm_core.js?v=19";
import { WebGpuLocalFilter } from "./webgpu.js?v=19";
import { searchChunk, cpuChunkMetadata } from "./algorithm.js?v=19";
import { remoteFdpCandidates, RemoteFdpCatalog } from "./fdp.js?v=19";
import {
  BROWSER_SEARCH_RELEASE, CHECKPOINT_VERSION, checkpointKey, deleteCheckpoint,
  loadCheckpoint, saveCheckpoint,
} from "./checkpoint.js?v=19";

let cancelled = false;
let activeGpu = null;
// A page that keeps this worker between requests reuses the instantiated core and the loaded
// index metadata; a terminated worker simply starts again.
let opened = null;
// With `request.resident`, a kept worker also keeps its WebGPU engine and, within estimated host
// and device budgets, the prepared target chunks of its last index, as `jmfs serve` does. The
// next search of that index then skips reading, uploading and decoding them.
let resident = null;

function releaseResidentChunks() {
  for (const kept of resident?.chunks.values() || []) kept.gpuChunk.dispose();
  if (resident) Object.assign(resident, { chunks: new Map(), deviceBytes: 0, hostBytes: 0 });
}

function dropResident() {
  releaseResidentChunks();
  resident = null;
}

self.onmessage = async ({ data }) => {
  if (data?.type === "cancel") {
    cancelled = true;
    activeGpu?.cancel();
    return;
  }
  if (data?.type === "describe") {
    try {
      const { index } = await openIndex(data.request);
      self.postMessage({
        type: "describe", id: data.id, targets: index.targetCount, residues: index.residueCount,
      });
    } catch (error) {
      self.postMessage({ type: "describe-error", id: data.id, message: error?.message || String(error) });
    }
    return;
  }
  if (data?.type === "scene") {
    try {
      self.postMessage({ type: "scene", id: data.id, ...await scene(data.request) });
    } catch (error) {
      self.postMessage({ type: "scene-error", id: data.id, message: error?.message || String(error) });
    }
    return;
  }
  if (data?.type !== "search") return;
  cancelled = false;
  try {
    await run(data.request);
  } catch (error) {
    // A failed or cancelled request leaves the engine in an unknown state.
    dropResident();
    self.postMessage({
      type: error?.name === "AbortError" ? "cancelled" : "error",
      message: error?.message || String(error),
      stack: error?.stack || "",
    });
  } finally {
    activeGpu = null;
  }
};

async function run(request) {
  const started = performance.now();
  postProgress("Loading the shared exact core", 0);
  const reuse = openedFor(request);
  const core = reuse?.core || (request.wasmModule
    ? await WasmCore.fromModule(request.wasmModule)
    : await WasmCore.load(new URL("./assets/jmfs_web_core.wasm", import.meta.url)));
  const source = reuse?.source || (request.index.kind === "file"
    ? new BlobRangeSource(request.index.file)
    : new HttpRangeSource(request.index.url));
  const keep = Boolean(request.resident) && !request.fdp?.enabled;
  if (!keep) dropResident();
  // The adapter, device and shader pipelines are prepared while the index metadata loads.
  const gpuStartup = request.backend === "wasm" ? null
    : resident ? Promise.resolve({ filter: resident.gpu })
      : WebGpuLocalFilter.create((message) => postProgress(message, 0)).then(
        (filter) => ({ filter }),
        (error) => ({ error }),
      );
  const index = reuse?.index
    || await JmfsIndex.open(source, (message) => postProgress(message, 0));
  opened = reuse || { identity: indexIdentity(request), core, source, index };
  const query = prepareQuery(request.pdbText, request.motif, request.chemistry || "", core);
  // The joins of this query compile while the index loads.
  gpuStartup?.then((started) => started.filter?.prepareJoins(query.segments.length));
  const rmsdCut = finiteNumber(request.rmsdCut, 3.0, 0.001, 100);
  const matchLimit = Math.trunc(finiteNumber(request.matchLimit, 1000, 1, 100000));
  const frontierCap = Math.trunc(finiteNumber(request.frontierCap, 1_000_000, 1000, 10_000_000));
  const fdp = normalizeFdpRequest(request.fdp);
  // Approximate CPU and GPU plans can differ; never resume their partial results together.
  const approxBackend = request.approx && request.approx !== "off"
    ? (await gpuStartup)?.filter ? "webgpu" : "wasm"
    : null;
  let checkpoint = null;
  // A page may split a CPU scan across workers; each then scans one contiguous target range.
  const range = Array.isArray(request.targetRange)
    ? [Math.trunc(request.targetRange[0]), Math.trunc(request.targetRange[1])]
    : null;
  if (range && (fdp || approxBackend
      || !(range[0] >= 0 && range[0] < range[1] && range[1] <= index.targetCount))) {
    throw new Error("targetRange needs a non-empty database range without FDP or approximation");
  }
  let checkpointEnabled = request.checkpoint !== false && !range;
  let checkpointWarning = "";
  if (checkpointEnabled) {
    try {
      checkpoint = await prepareCheckpoint(index, source, request, {
        rmsdCut, matchLimit, frontierCap, fdp, approxBackend,
      });
    } catch (error) {
      checkpointEnabled = false;
      checkpointWarning = error?.message || String(error);
      self.postMessage({ type: "checkpoint-warning", message: checkpointWarning });
    }
  }

  let cursor = checkpoint?.state?.cursor || range?.[0] || 0;
  let rows = checkpoint?.state?.rows || [];
  const totals = checkpoint?.state?.totals || {};
  let chunks = checkpoint?.state?.chunks || 0;
  let candidateRows = checkpoint?.state?.candidateRows == null
    ? null
    : Uint32Array.from(checkpoint.state.candidateRows);
  let fdpComplete = checkpoint?.state?.fdpComplete || false;
  let fdpIdentity = checkpoint?.state?.fdpIdentity || null;
  let fdpReason = checkpoint?.state?.fdpReason || "";
  const clearSavedRun = async () => {
    if (checkpoint?.key) await deleteCheckpoint(checkpoint.key);
    if (checkpoint) {
      checkpoint.resumed = false;
      checkpoint.state = null;
    }
    cursor = 0;
    rows = [];
    chunks = 0;
    candidateRows = null;
    fdpComplete = false;
    fdpIdentity = null;
    for (const key of Object.keys(totals)) delete totals[key];
  };

  if (fdp && candidateRows) {
    postProgress("Validating the saved FDP release", 0);
    try {
      const current = await RemoteFdpCatalog.open(fdp.catalogUrl, index, fdp.postingsUrl);
      if (!sameIdentity(current.identity, fdpIdentity)) await clearSavedRun();
    } catch (error) {
      await clearSavedRun();
      fdpComplete = true;
      fdpReason = `${error?.message || String(error)}; using the complete exact scan`;
    }
  }
  if (fdp && !fdpComplete) {
    let result;
    try {
      result = await remoteFdpCandidates({
        ...fdp,
        index,
        query,
        core,
        chemistryMode: request.chemistryMode || "none",
        progress: (message) => postProgress(message, 0),
        shouldCancel: () => cancelled,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      result = {
        rows: null,
        reason: `${error?.message || String(error)}; using the complete exact scan`,
      };
    }
    candidateRows = result.rows;
    fdpComplete = true;
    fdpIdentity = result.identity || null;
    fdpReason = result.reason || "";
    if (result.stats) Object.assign(totals, result.stats);
    if (checkpointEnabled) {
      try {
        await saveCheckpoint(checkpoint.key, {
          cursor: 0, candidateRows, fdpComplete, fdpIdentity, fdpReason, rows, totals, chunks,
        });
      } catch (error) {
        checkpointEnabled = false;
        checkpointWarning = error?.message || String(error);
        self.postMessage({ type: "checkpoint-warning", message: checkpointWarning });
      }
    }
  }
  const workTotal = candidateRows?.length ?? range?.[1] ?? index.targetCount;
  const workloadResidues = candidateRows
    ? candidateRows.reduce((total, target) => total + index.entry(target).numres, 0)
    : index.residueCount;

  let gpu = null;
  let backend = "WASM CPU";
  let fallbackReason = "";
  if (gpuStartup) {
    const started = await gpuStartup;
    if (started.filter) {
      gpu = started.filter;
      activeGpu = gpu;
      backend = "WebGPU";
    } else {
      fallbackReason = started.error?.message || String(started.error);
      if (request.backend === "webgpu") throw started.error;
    }
  }
  const cpuResidueLimit = Math.trunc(finiteNumber(request.cpuResidueLimit, 5_000_000, 1, 1e12));
  if (!gpu && workloadResidues > cpuResidueLimit && !request.allowLargeCpu) {
    throw new Error(
      `WebGPU is unavailable (${fallbackReason || "no adapter"}). The WASM fallback is limited to ` +
      `${cpuResidueLimit.toLocaleString()} residues by default; choose the explicit large-CPU option to continue.`,
    );
  }

  self.postMessage({
    type: "ready",
    backend,
    fallbackReason,
    adapterInfo: gpu?.adapterInfo || null,
    index: { label: source.label, targets: index.targetCount, residues: index.residueCount },
    query: { residues: query.totalLength, segments: query.segments.length },
    fdp: fdp ? {
      enabled: true,
      candidates: candidateRows?.length ?? index.targetCount,
      reason: fdpReason,
      release: fdpIdentity?.release || "",
    } : null,
    checkpoint: checkpoint ? {
      key: checkpoint.key,
      resumed: checkpoint.resumed && cursor > 0,
      targetsDone: cursor,
    } : null,
  });
  const chunkResidues = Math.trunc(finiteNumber(
    request.chunkResidues,
    gpu ? Math.min(16_000_000, Math.floor(gpu.maxStorageBufferBindingSize / 12)) : 100_000,
    10_000,
    50_000_000,
  ));
  const chunkTargets = Math.trunc(finiteNumber(
    request.chunkTargets, gpu ? 65_536 : 4096, 1, 100_000,
  ));
  const chunkHotBytes = Math.trunc(finiteNumber(
    request.chunkHotBytes, gpu ? 128 * 1024 * 1024 : 64 * 1024 * 1024, 1024, 512 * 1024 * 1024,
  ));
  const planKey = [indexIdentity(request), chunkResidues, chunkTargets, chunkHotBytes].join("\0");
  if (gpu && keep) {
    if (!resident) resident = { gpu, chunks: new Map(), deviceBytes: 0, hostBytes: 0 };
    if (resident.planKey !== planKey) releaseResidentChunks();
    resident.planKey = planKey;
  }
  const residentDeviceBudget = finiteNumber(
    request.residentDeviceBytes, (navigator.deviceMemory || 4) >= 8 ? 3 * 2 ** 30 : 2 ** 30, 0, 2 ** 36,
  );
  const residentHostBudget = finiteNumber(request.residentHostBytes, residentDeviceBudget / 2, 0, 2 ** 36);
  // Estimated retained bytes: decoded coordinates and packed sequence on the device, compressed
  // geometry and packed sequence on the host.
  const retainChunk = (plan, chunk, gpuChunk) => {
    if (!resident || resident.gpu !== gpu || candidateRows) return false;
    const sequenceBytes = chunk.sequenceSlice?.bytes.length || 0;
    const deviceBytes = chunk.residues * 12 + sequenceBytes;
    const hostBytes = chunk.hot.length + sequenceBytes;
    if (resident.deviceBytes + deviceBytes > residentDeviceBudget
        || resident.hostBytes + hostBytes > residentHostBudget) return false;
    resident.chunks.set(plan.start, { plan, chunk, gpuChunk, deviceBytes, hostBytes });
    resident.deviceBytes += deviceBytes;
    resident.hostBytes += hostBytes;
    return true;
  };
  let smoothedTargetsPerMs = 0;
  if (cursor) {
    postProgress(`Resuming after ${cursor.toLocaleString()} completed targets`, cursor / workTotal);
  }
  // With WebGPU the device reads residue codes from the packed planes and the host decodes only
  // candidate targets, from the index's own copy; the WASM copy (114 MiB for Swiss-Prot) serves
  // the CPU backend.
  // The copy lives as long as this worker keeps the index open, so a CPU scan split into several
  // ranges uploads it once.
  const packedSequence = gpu
    ? { decodeBatch: (rows, length) => index.decodeSequenceRows(rows, length) }
    : opened.packedSequence ||= core.uploadPackedSequence(index.seq, index.sequenceLayout);
  const loadChunkAt = (start) => {
    const kept = gpu && !candidateRows && resident?.gpu === gpu ? resident.chunks.get(start) : null;
    if (kept) return Promise.resolve({ plan: kept.plan, chunk: kept.chunk, kept });
    const plan = candidateRows
      ? index.planListedChunk(candidateRows, start, chunkResidues, chunkTargets, chunkHotBytes)
      : index.planChunk(start, chunkResidues, chunkTargets, chunkHotBytes, workTotal);
    const reading = candidateRows
      ? `Reading FDP candidates ${plan.start + 1}-${plan.end} of ${workTotal.toLocaleString()}`
      : `Reading targets ${plan.start + 1}-${plan.end}`;
    postProgress(reading, workTotal ? plan.start / workTotal : 1);
    // WebGPU decodes CAD1 on the device; the CPU backend decodes it in WASM.
    const loading = candidateRows
      ? index.loadListedChunk(plan, core, packedSequence, !gpu)
      : index.loadChunk(plan, core, packedSequence, !gpu);
    return loading.then(
      (chunk) => ({ plan, chunk, staged: stageChunk(chunk) }),
      (error) => ({ plan, error }),
    );
  };
  // The next chunk's packed bytes go to the device as soon as they are read, while the device
  // is still searching the current chunk; only its decode waits for its turn.
  const stageChunk = (chunk) => {
    if (!gpu) return null;
    const started = performance.now();
    try {
      return gpu.uploadCompressed(chunk.hot, chunk.hotMetadata, chunk.residues, chunk.sequenceSlice);
    } catch {
      return null; // The ordinary preparation below reports the failure.
    } finally {
      totals.deviceUploadMs = (totals.deviceUploadMs || 0) + performance.now() - started;
    }
  };
  const approximation = core.approximation(query, request.chemistryMode || "none", request.approx, rmsdCut);
  const sampleAnchors = async () => {
    if (approximation?.plan.status(false) !== "non-approximate:anchor_sampling_unavailable") return;
    const selected = approximation.plan.sampleTargets(workTotal);
    const sampleRows = candidateRows ? Uint32Array.from(selected, row => candidateRows[row]) : selected;
    // Rust chooses the sample and counts passing windows; JavaScript only reads bounded chunks.
    for (let at = 0; at < sampleRows.length;) {
      if (cancelled) throw new DOMException("Search cancelled", "AbortError");
      postProgress(`Sampling approximate anchors ${at + 1}-${sampleRows.length}`, 0);
      const plan = index.planListedChunk(sampleRows, at, Math.min(chunkResidues, 100_000), chunkTargets, chunkHotBytes);
      const chunk = await index.loadListedChunk(plan, core, packedSequence, true);
      const { recordOffsets, runs, runOffsets } = cpuChunkMetadata(chunk);
      approximation.plan.sample(chunk.coords, chunk.sequence, recordOffsets, runs, runOffsets);
      at = plan.end;
    }
  };
  let pendingChunk = null;
  try {
    if (!gpu) await sampleAnchors();
    pendingChunk = cursor < workTotal ? loadChunkAt(cursor) : null;
    let chunkStarted = performance.now();
    while (pendingChunk) {
      const waitStarted = performance.now();
      const loaded = await pendingChunk;
      totals.chunkWaitMs = (totals.chunkWaitMs || 0) + performance.now() - waitStarted;
      if (loaded.error) throw loaded.error;
      if (cancelled) throw new DOMException("Search cancelled", "AbortError");
      const chunkStartCursor = cursor;
      const { plan, chunk } = loaded;
      let completed = false;
      pendingChunk = plan.end < workTotal ? loadChunkAt(plan.end) : null;
      if (!gpu && !chunk.coords) {
        chunk.coords = core.decodeCad1Batch(chunk.hot, chunk.hotMetadata, chunk.residues);
      }
      if (!gpu || loaded.kept) loaded.staged?.dispose();
      let wasmCoords = chunk.coords ? core.uploadCoords(chunk.coords) : null;
      let wasmSequence = chunk.coords ? core.uploadSequence(chunk.sequence) : null;
      let gpuChunk = null;
      try {
        if (gpu) {
          const prepareStarted = performance.now();
          const prepare = () => gpu.prepareCompressed(
            chunk.hot, chunk.hotMetadata, chunk.residues, chunk.sequenceSlice,
          );
          if (loaded.kept) {
            gpuChunk = loaded.kept.gpuChunk;
            totals.residentChunks = (totals.residentChunks || 0) + 1;
          } else {
            // Retained chunks are the first thing to give back when the device is full.
            gpuChunk = await (loaded.staged ? loaded.staged.decode() : prepare()).catch((error) => {
              if (!resident?.chunks.size) throw error;
              releaseResidentChunks();
              return prepare();
            });
          }
          totals.devicePrepareMs = (totals.devicePrepareMs || 0) + performance.now() - prepareStarted;
        }
        let result;
        const searchStarted = performance.now();
        try {
          result = await runChunk(gpuChunk);
        } catch (error) {
          // Switching executors can change an approximate plan and its recall restrictions.
          if (!gpu || request.backend !== "auto" || approximation) throw error;
          if (workloadResidues > cpuResidueLimit && !request.allowLargeCpu) {
            throw new Error(`WebGPU stopped (${error.message}); large WASM fallback was not enabled`);
          }
          dropResident();
          gpuChunk.dispose();
          gpuChunk = null;
          fallbackReason = error.message || String(error);
          gpu = null;
          backend = "WASM CPU";
          self.postMessage({ type: "backend", backend, fallbackReason });
          if (!chunk.coords) {
            chunk.coords = core.decodeCad1Batch(chunk.hot, chunk.hotMetadata, chunk.residues);
            wasmCoords = core.uploadCoords(chunk.coords);
            wasmSequence = core.uploadSequence(chunk.sequence);
          }
          result = await runChunk(null);
        }
        totals.chunkSearchMs = (totals.chunkSearchMs || 0) + performance.now() - searchStarted;
        rows.push(...result.rows);
        rows.sort(compareRows);
        if (rows.length > matchLimit) rows.length = matchLimit;
        addStats(totals, result.stats);
        chunks += 1;
        completed = true;

        function runChunk(activeGpuChunk) {
          return searchChunk({
            chunk,
            query,
            core,
            wasmCoords,
            wasmSequence,
            gpuChunk: activeGpuChunk,
            packedSequence,
            rmsdCut,
            chemistryMode: request.chemistryMode || "none",
            approximation,
            frontierCap,
            matchLimit,
            shouldCancel: () => cancelled,
            progress: (message) => postProgress(message, workTotal ? plan.start / workTotal : 1),
          });
        }
      } finally {
        const retained = gpuChunk && (resident?.chunks.get(plan.start)?.gpuChunk === gpuChunk
          || (completed && retainChunk(plan, chunk, gpuChunk)));
        if (!retained) gpuChunk?.dispose();
        wasmSequence?.dispose();
        wasmCoords?.dispose();
      }
      cursor = plan.end;
      if (checkpointEnabled) {
        try {
          await saveCheckpoint(checkpoint.key, {
            cursor, candidateRows, fdpComplete, fdpIdentity, fdpReason, rows, totals, chunks,
          });
        } catch (error) {
          checkpointEnabled = false;
          checkpointWarning = error?.message || String(error);
          self.postMessage({ type: "checkpoint-warning", message: checkpointWarning });
        }
      }
      const chunkRate = (cursor - chunkStartCursor) / Math.max(1, performance.now() - chunkStarted);
      chunkStarted = performance.now();
      smoothedTargetsPerMs = smoothedTargetsPerMs
        ? smoothedTargetsPerMs * 0.7 + chunkRate * 0.3
        : chunkRate;
      self.postMessage({
        type: "chunk",
        progress: workTotal ? cursor / workTotal : 1,
        targetsDone: cursor,
        targetsTotal: workTotal,
        databaseTargets: index.targetCount,
        fdp: Boolean(candidateRows),
        hits: rows.length,
        targetsPerSecond: smoothedTargetsPerMs * 1000,
        etaMs: (workTotal - cursor) / smoothedTargetsPerMs,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    // A request that ends early may leave the next chunk staged on the device.
    pendingChunk?.then((loaded) => loaded.staged?.dispose());
    approximation?.plan.free();
  }
  if (checkpointEnabled) {
    await deleteCheckpoint(checkpoint.key);
    self.postMessage({ type: "checkpoint-cleared", key: checkpoint.key });
  }
  if (totals.pairCandidates) {
    totals.pairReuse = totals.pairComparisons / totals.pairCandidates;
  }
  self.postMessage({
    type: "result",
    rows,
    backend,
    adapterInfo: gpu?.adapterInfo || null,
    index: { label: source.label, targets: index.targetCount, residues: index.residueCount },
    query: {
      motif: query.motif,
      chemistry: query.chemistry,
      residues: query.totalLength,
      segments: query.segments.length,
    },
    stats: {
      ...totals,
      chunks,
      elapsedMs: performance.now() - started,
      fallbackReason,
      checkpointWarning,
      resumed: checkpoint?.resumed || false,
      residentDeviceBytes: resident?.deviceBytes || 0,
      residentHostBytes: resident?.hostBytes || 0,
      targetsSearched: workTotal - (range?.[0] || 0),
      databaseTargets: index.targetCount,
      fdpReason,
    },
  });
}

function indexIdentity(request) {
  const { kind, file, url } = request.index;
  return kind === "file" ? `file\0${file.name}\0${file.size}\0${file.lastModified}` : `url\0${url}`;
}

function openedFor(request) {
  return opened?.identity === indexIdentity(request) ? opened : null;
}

// One placement as the `jmfs visualize` scene: the shared Rust writer superposes the indexed
// target on the query, rebuilds its backbone and derives secondary structure.
async function openIndex(request) {
  const reuse = openedFor(request);
  const core = reuse?.core || (request.wasmModule
    ? await WasmCore.fromModule(request.wasmModule)
    : await WasmCore.load(new URL("./assets/jmfs_web_core.wasm", import.meta.url)));
  const source = reuse?.source || (request.index.kind === "file"
    ? new BlobRangeSource(request.index.file)
    : new HttpRangeSource(request.index.url));
  const index = reuse?.index || await JmfsIndex.open(source);
  opened = reuse || { identity: indexIdentity(request), core, source, index };
  return opened;
}

async function scene(request) {
  const started = performance.now();
  const { core, index } = await openIndex(request);
  const query = prepareQuery(request.pdbText, request.motif, request.chemistry || "", core);
  const entry = index.entry(request.targetIndex);
  const plan = index.planListedChunk(Uint32Array.of(request.targetIndex), 0, entry.numres, 1, entry.hotLength);
  const chunk = await index.loadListedChunk(
    plan, core, { decodeBatch: (rows, length) => index.decodeSequenceRows(rows, length) }, true,
  );
  const targetId = chunk.records[0].id;
  const atoms = parsePdb(request.pdbText, core).flatMap((residue) =>
    Array.from(residue.atoms, ([name, xyz]) => ({
      name,
      resName: residue.resName,
      chain: residue.chain,
      resSeq: residue.resSeq,
      insertion: residue.insertion,
      xyz,
      bFactor: residue.bFactors.get(name),
    })));
  const cif = core.sceneCif({
    queryId: request.queryId || "query",
    targetId,
    rmsd: request.rmsd,
    segBeg: request.starts,
    segLen: query.segments.map((segment) => segment.length),
    queryCoords: query.coords,
    querySeq: query.sequence,
    targetCoords: chunk.coords,
    targetSeq: chunk.sequence,
    atoms,
  });
  return { cif, targetId, elapsedMs: performance.now() - started };
}

async function prepareCheckpoint(index, source, request, limits) {
  const sections = Array.from(index.sections.values(), (section) => ({
    tag: section.tag,
    version: section.version,
    offset: section.offset,
    length: section.length,
    aux: section.aux.toString(16),
  }));
  const sourceIdentity = request.index.kind === "file" ? {
    kind: "file",
    name: source.blob.name || "",
    size: source.blob.size,
    lastModified: source.blob.lastModified || 0,
  } : {
    kind: "url",
    url: source.url,
    size: source.size,
  };
  const key = await checkpointKey({
    source: sourceIdentity,
    targets: index.targetCount,
    residues: index.residueCount,
    sections,
  }, {
    pdbText: request.pdbText,
    motif: request.motif,
    chemistryMode: request.chemistryMode || "none",
    chemistry: request.chemistry || "",
    approx: request.approx || null,
    ...limits,
  });
  const stored = await loadCheckpoint(key);
  const candidateRows = stored?.candidateRows == null
    ? null
    : Uint32Array.from(stored.candidateRows);
  const candidateRowsValid = candidateRows == null || candidateRows.every((target, row) =>
    target < index.targetCount && (row === 0 || target > candidateRows[row - 1]));
  const workTotal = candidateRows?.length ?? index.targetCount;
  const fdpStateValid = limits.fdp
    ? stored?.fdpComplete === true
    : stored?.fdpComplete !== true && candidateRows == null;
  const valid = stored
    && stored.checkpointVersion === CHECKPOINT_VERSION
    && stored.browserSearchRelease === BROWSER_SEARCH_RELEASE
    && Number.isInteger(stored.cursor)
    && stored.cursor >= 0
    && stored.cursor <= workTotal
    && candidateRowsValid
    && fdpStateValid
    && Array.isArray(stored.rows)
    && stored.rows.length <= limits.matchLimit
    && stored.totals && typeof stored.totals === "object"
    && Number.isInteger(stored.chunks) && stored.chunks >= 0
    && (stored.cursor === 0 || stored.chunks > 0);
  if (stored && !valid) await deleteCheckpoint(key);
  return { key, resumed: Boolean(valid && stored.cursor > 0), state: valid ? stored : null };
}

function postProgress(message, progress) {
  self.postMessage({ type: "progress", message, progress });
}

function finiteNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeFdpRequest(value) {
  if (!value?.enabled) return null;
  const catalogUrl = String(value.catalogUrl || "").trim();
  if (!catalogUrl) throw new Error("Remote FDP is enabled but no .jmfsremote catalog URL was provided");
  return {
    catalogUrl,
    postingsUrl: String(value.postingsUrl || "").trim(),
    distanceTolerance: finiteNumber(value.distanceTolerance, 0.5, 0, 20),
    angleTolerance: finiteNumber(value.angleTolerance, 5, 0, 180),
    minEdges: Math.trunc(finiteNumber(value.minEdges, 1, 1, 1_000_000)),
  };
}

function sameIdentity(left, right) {
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function addStats(total, current) {
  for (const [key, value] of Object.entries(current)) {
    if (typeof value === "number") total[key] = (total[key] || 0) + value;
    else total[key] = value;
  }
}

function compareRows(a, b) {
  return a.rmsd - b.rmsd || a.targetId.localeCompare(b.targetId) || a.starts.join(",").localeCompare(b.starts.join(","));
}
