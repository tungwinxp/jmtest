// Browser host for the shared Colab form (colab/app.html). The notebook answers the form's
// `search` and `scene` calls in Python with the installed binary; this module answers the same
// two calls with local search workers, so the shared Rust core runs on this computer's WebGPU
// adapter or, without one, on WASM CPU workers. Nothing is uploaded.

// One kept worker. A failed or cancelled request replaces it.
class Lane {
  constructor(workerUrl) {
    this.workerUrl = workerUrl;
    this.worker = null;
  }

  exchange(message, accept) {
    return new Promise((resolve, reject) => {
      this.worker ||= new Worker(this.workerUrl, { type: "module" });
      const active = this.worker;
      const settle = (finish, value) => {
        active.removeEventListener("message", onMessage);
        active.removeEventListener("error", onError);
        finish(value);
      };
      const fail = (error) => {
        active.terminate();
        if (this.worker === active) this.worker = null;
        settle(reject, error);
      };
      const onMessage = ({ data }) => {
        try {
          const done = accept(data);
          if (done !== undefined) settle(resolve, done);
        } catch (error) { fail(error); }
      };
      const onError = (event) => fail(new Error(event.message || "Browser worker failed"));
      active.addEventListener("message", onMessage);
      active.addEventListener("error", onError);
      active.postMessage(message);
    });
  }
}

const compareRows = (a, b) => a.rmsd - b.rmsd || a.targetId.localeCompare(b.targetId)
  || a.starts.join(",").localeCompare(b.starts.join(","));

export function createTransport({ workerUrl, wasmUrl, demoIndexUrl, cpuLanes: cpuLaneCount }) {
  const wasmModule = fetch(wasmUrl).then((response) => {
    if (!response.ok) throw new Error(`JMFS WASM fetch failed (${response.status})`);
    return response.arrayBuffer();
  }).then((bytes) => WebAssembly.compile(bytes));
  // The GPU lane keeps the database resident between searches, like the notebook's resident
  // workers. CPU scans are split over several lanes, one contiguous target range at a time.
  const gpuLane = new Lane(workerUrl);
  const cpuLanes = [];
  // Each lane holds its own copy of the index metadata, so the default follows device memory.
  const cpuLaneLimit = cpuLaneCount >= 1 ? Math.trunc(cpuLaneCount)
    : Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, navigator.deviceMemory >= 8 ? 8 : 4));
  // `navigator.gpu` can exist without a usable adapter, for example with the GPU disabled.
  const adapterReady = navigator.gpu
    ? navigator.gpu.requestAdapter().then(Boolean, () => false)
    : Promise.resolve(false);
  let calls = 0;
  let last = null;

  const reply = (lane, type, request) => {
    const id = ++calls;
    return lane.exchange({ type, id, request }, (data) => {
      if (data.id !== id) return undefined;
      if (data.type === `${type}-error`) throw new Error(data.message);
      return data.type === type ? data : undefined;
    });
  };

  const searchOn = (lane, request, onProgress) => lane.exchange({ type: "search", request }, (data) => {
    if (data.type === "progress" || data.type === "chunk") onProgress(data);
    else if (data.type === "result") return data;
    else if (data.type === "error" || data.type === "cancelled") throw new Error(data.message);
    return undefined;
  });

  async function searchGpu(request, progress) {
    const run = () => searchOn(gpuLane, request, (data) => progress(data.type === "chunk"
      ? `Searching… ${data.targetsDone.toLocaleString()} of ${
        data.targetsTotal.toLocaleString()} targets · ${data.hits.toLocaleString()} retained`
      : `Searching… ${data.message}`));
    const kept = Boolean(gpuLane.worker);
    try {
      // A kept engine may have lost its device since the last search; start once more, fresh.
      return await run().catch((error) => { if (kept) return run(); throw error; });
    } catch (error) {
      // Without a working device the worker refuses a large single-worker CPU scan.
      if (!/WebGPU/.test(error.message)) throw error;
      progress(`WebGPU stopped (${error.message}); continuing on the CPU`);
      return searchCpu({ ...request, backend: "wasm", allowLargeCpu: true, resident: false }, progress);
    }
  }

  async function searchCpu(request, progress) {
    cpuLanes[0] ||= new Lane(workerUrl);
    const { targets } = await reply(cpuLanes[0], "describe", request);
    const lanes = Math.min(cpuLaneLimit, targets);
    while (cpuLanes.length < lanes) cpuLanes.push(new Lane(workerUrl));
    // Several ranges per lane keep the lanes busy when targets differ in size.
    const pieces = Math.min(targets, lanes * 4);
    const ranges = Array.from({ length: pieces }, (_, piece) => [
      Math.floor(piece * targets / pieces), Math.floor((piece + 1) * targets / pieces),
    ]);
    const results = [];
    let next = 0;
    let done = 0;
    progress(`Searching… ${targets.toLocaleString()} targets on ${lanes} CPU workers`);
    try {
      await Promise.all(cpuLanes.slice(0, lanes).map(async (lane) => {
        while (next < ranges.length) {
          const targetRange = ranges[next++];
          results.push(await searchOn(lane, { ...request, targetRange }, () => {}));
          done += targetRange[1] - targetRange[0];
          progress(`Searching… ${done.toLocaleString()} of ${targets.toLocaleString()} targets on ${
            lanes} CPU workers`);
        }
      }));
    } catch (error) {
      // The other lanes are still scanning; stop them rather than let them overlap a later search.
      for (const lane of cpuLanes) {
        lane.worker?.terminate();
        lane.worker = null;
      }
      throw error;
    }
    const rows = results.flatMap((result) => result.rows).sort(compareRows).slice(0, request.matchLimit);
    const stats = {};
    for (const result of results) {
      for (const [key, value] of Object.entries(result.stats)) {
        stats[key] = typeof value === "number" ? (stats[key] || 0) + value : value;
      }
    }
    return { ...results[0], rows, stats, backend: `WASM CPU × ${lanes}` };
  }

  async function search(payload, progress) {
    const pdbText = String(payload.pdb || "");
    if (pdbText.length > 20_000_000) throw new Error("Upload a PDB file smaller than 20 MB.");
    if (!/^(ATOM  |HETATM)/m.test(pdbText)) {
      throw new Error("The query must contain PDB ATOM or HETATM records.");
    }
    const motif = String(payload.motif || "").trim();
    if (!motif) throw new Error("Select motif residues or enter their chain and residue numbers.");
    const rmsdCut = Number(payload.rmsd);
    if (!(rmsdCut > 0 && rmsdCut <= 100)) {
      throw new Error("RMSD must be greater than zero and at most 100 Å.");
    }
    const chemistryMode = payload.chemistry || "reduced";
    if (!["none", "exact", "reduced"].includes(chemistryMode)) {
      throw new Error("Choose none, exact or reduced chemistry.");
    }
    const matchLimit = Math.trunc(Number(payload.limit));
    if (!(matchLimit >= 1 && matchLimit <= 10000)) {
      throw new Error("Choose between 1 and 10,000 retained hits.");
    }
    const indexText = String(payload.index || "").trim();
    const index = payload.index_file
      ? { kind: "file", file: payload.index_file }
      : { kind: "url", url: new URL(indexText || demoIndexUrl, location.href).href };
    // The form's CPU choice, or a browser without WebGPU, scans on the CPU however large the
    // database is; the status line shows progress.
    const onCpu = Boolean(payload.cpu) || !(await adapterReady);
    const request = {
      index,
      pdbText,
      motif,
      chemistryMode,
      chemistry: chemistryMode === "none" ? "" : String(payload.chemistry_positions || "").trim(),
      rmsdCut,
      matchLimit,
      backend: onCpu ? "wasm" : "auto",
      allowLargeCpu: onCpu,
      checkpoint: false,
      resident: !onCpu,
      wasmModule: await wasmModule,
    };
    const started = performance.now();
    const result = await (onCpu ? searchCpu : searchGpu)(request, progress);
    const elapsed = (performance.now() - started) / 1000;
    const segLen = result.rows.length
      ? result.rows[0].positions.map((positions) => {
        const [first, end] = positions.split("-").map(Number);
        return end - first + 1;
      }).join(",")
      : "";
    const rows = result.rows.map((row) => ({
      query_id: "query",
      target_id: row.targetId,
      seg_beg: row.starts.join(","),
      seg_len: segLen,
      rmsd: String(row.rmsd),
      seqout: row.targetSequence,
    }));
    const fields = ["query_id", "target_id", "seg_beg", "seg_len", "rmsd", "seqout"];
    const download = [fields, ...rows.map((row) => fields.map((field) => row[field]))]
      .map((values) => values.map((value) => String(value).replace(/[\t\r\n]/g, " ")).join("\t"))
      .join("\n") + "\n";
    const adapter = result.adapterInfo?.description || "";
    const engine = result.backend === "WebGPU" ? `WebGPU${adapter ? ` (${adapter})` : ""}` : result.backend;
    const { stats } = result;
    const log = [
      `engine=${engine}`,
      stats.fallbackReason ? `gpu_fallback=${stats.fallbackReason}` : "",
      `index=${result.index.label}`,
      `target_count=${result.index.targets}`,
      `residue_count=${result.index.residues}`,
      `windows_checked=${Math.round(stats.windows || 0)}`,
      `chunks=${stats.chunks}`,
      `resident_chunks=${stats.residentChunks || 0}`,
      `resident_device_bytes=${stats.residentDeviceBytes || 0}`,
      `resident_host_bytes=${stats.residentHostBytes || 0}`,
      `output_rows=${rows.length}`,
      `total_sec=${elapsed.toFixed(6)}`,
    ].filter(Boolean).join("\n");
    last = { request, rows: result.rows, lane: result.backend.startsWith("WASM CPU ×") ? cpuLanes[0] : gpuLane };
    return { rows, elapsed, log, download, engine };
  }

  async function scene(payload) {
    const row = last?.rows[Number(payload.row)];
    if (!row) throw new Error("Choose a result from the current search.");
    const { cif, targetId, elapsedMs } = await reply(last.lane, "scene", {
      ...last.request, targetIndex: row.targetIndex, starts: row.starts, rmsd: row.rmsd,
    });
    const token = targetId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "member";
    return {
      cif,
      elapsed: elapsedMs / 1000,
      name: `${String(Number(payload.row) + 1).padStart(5, "0")}_query_${token}.cif`,
    };
  }

  return async (method, payload, progress = () => {}) => {
    try {
      if (method === "search") return await search(payload, progress);
      if (method === "scene") return await scene(payload);
      throw new Error("Unknown action");
    } catch (error) {
      return { error: error?.message || String(error) };
    }
  };
}
