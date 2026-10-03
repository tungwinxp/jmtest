import { deleteCheckpoint } from "./checkpoint.js?v=19";

const $ = (id) => document.getElementById(id);
const form = $("search-form");
let worker = null;
let lastResult = null;
let activeCheckpointKey = null;
const wasmModule = fetch("./assets/jmfs_web_core.wasm?v=19")
  .then((response) => {
    if (!response.ok) throw new Error(`JMFS WASM fetch failed (${response.status})`);
    return response.arrayBuffer();
  })
  .then((bytes) => WebAssembly.compile(bytes));

$("index-file").addEventListener("change", () => {
  const file = $("index-file").files[0];
  $("index-file-name").textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "Choose an index file";
});

$("query-file").addEventListener("change", async () => {
  const file = $("query-file").files[0];
  if (file) $("query-pdb").value = await file.text();
});

$("fdp-enabled").addEventListener("change", () => {
  $("fdp-fields").hidden = !$("fdp-enabled").checked;
});

$("load-example").addEventListener("click", async () => {
  try {
    setStatus("Loading example", "Reading the tracked query fixture.");
    const response = await fetch("../../jmfs/fixtures/protein/serine_three_segment.pdb");
    if (!response.ok) throw new Error(`example fetch failed (${response.status})`);
    $("query-pdb").value = await response.text();
    $("motif").value = "B56-58,B101-103,C194-196";
    $("chemistry-mode").value = "exact";
    $("chemistry").value = "B57,B102,C195";
    $("rmsd").value = "1.0";
    $("match-limit").value = "5000";
    setStatus(
      "Swiss-Prot example ready",
      "Searches the His-Asp-Ser motif with exact chemistry and a 1.0 Å complete-motif cutoff.",
    );
  } catch (error) { setError(error.message); }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  requestPersistentStorage();
  const indexFile = $("index-file").files[0];
  const indexUrl = $("index-url").value.trim();
  const pdbText = $("query-pdb").value;
  if (!indexFile && !indexUrl) return setError("Choose a local .jmfsgeom index or enter its HTTPS URL.");
  if (!pdbText.trim()) return setError("Load or paste a PDB query structure.");
  start({
    index: indexFile ? { kind: "file", file: indexFile } : { kind: "url", url: indexUrl },
    pdbText,
    motif: $("motif").value.trim(),
    chemistryMode: $("chemistry-mode").value,
    approx: $("approx-mode").value,
    chemistry: $("chemistry").value.trim(),
    rmsdCut: Number($("rmsd").value),
    backend: $("backend").value,
    matchLimit: Number($("match-limit").value),
    allowLargeCpu: $("large-cpu").checked,
    fdp: {
      enabled: $("fdp-enabled").checked,
      catalogUrl: $("fdp-catalog-url").value.trim(),
      postingsUrl: $("fdp-postings-url").value.trim(),
      distanceTolerance: 0.5,
      angleTolerance: 5,
      minEdges: 1,
    },
  });
});

$("cancel").addEventListener("click", () => stop("Stopped"));
$("discard").addEventListener("click", async () => {
  const key = activeCheckpointKey;
  stop();
  try {
    await deleteCheckpoint(key);
    clearCheckpoint(key);
    finish();
    setStatus("Saved run discarded", "A future search with these inputs will start at the beginning.");
  } catch (error) {
    finish();
    setError(`Could not discard saved progress: ${error.message || String(error)}`);
  }
});
$("download").addEventListener("click", () => {
  if (!lastResult) return;
  const header = ["target_id", "target_offsets_1based", "target_sequence", "rmsd_angstrom"];
  const lines = [header, ...lastResult.rows.map((row) => [
    row.targetId, row.positions.join(","), row.targetSequence, row.rmsd.toFixed(6),
  ])].map((fields) => fields.map(tsvField).join("\t"));
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/tab-separated-values" }));
  link.download = "jmfs_browser_hits.tsv";
  link.click();
  URL.revokeObjectURL(link.href);
});

async function start(request) {
  stop();
  lastResult = null;
  $("results").hidden = true;
  $("download").disabled = true;
  $("run").disabled = true;
  $("cancel").disabled = false;
  $("discard").disabled = !activeCheckpointKey;
  $("progress").value = 0;
  setStatus("Starting", "Opening the index in one bounded worker.");
  const runWorker = new Worker("./search_worker.js?v=19", { type: "module" });
  worker = runWorker;
  runWorker.onmessage = ({ data }) => {
    if (worker !== runWorker) return;
    if (data.type === "progress") {
      $("progress").value = data.progress || 0;
      setStatus("Searching", data.message);
    } else if (data.type === "ready") {
      activeCheckpointKey = data.checkpoint?.key || null;
      $("discard").disabled = !activeCheckpointKey;
      const adapter = data.adapterInfo?.description || data.adapterInfo?.device || "browser adapter";
      $("hardware").innerHTML = `<span class="signal active"></span>${escapeHtml(data.backend === "WebGPU" ? `WebGPU · ${adapter}` : "WASM CPU fallback")}`;
      $("run-summary").textContent = data.fdp && !data.fdp.reason
        ? `${data.fdp.candidates.toLocaleString()} FDP candidates · ${data.index.targets.toLocaleString()} database targets`
        : `${data.index.targets.toLocaleString()} targets · ${data.index.residues.toLocaleString()} residues`;
      const readyDetail = data.checkpoint?.resumed
        ? `Resuming after ${data.checkpoint.targetsDone.toLocaleString()} completed targets.`
        : data.fdp?.reason ? `FDP not applied: ${data.fdp.reason}. Exact search will inspect all targets.`
          : data.fallbackReason ? `GPU fallback: ${data.fallbackReason}` : "Exact verifier ready.";
      setStatus(data.backend, readyDetail);
    } else if (data.type === "chunk") {
      $("progress").value = data.progress;
      const eta = data.etaMs > 0 ? ` · about ${formatDuration(data.etaMs)} left` : "";
      const unit = data.fdp ? "FDP candidates" : "targets";
      setStatus("Searching in this tab", `${data.targetsDone.toLocaleString()} / ${data.targetsTotal.toLocaleString()} ${unit} · ${data.hits.toLocaleString()} retained hits${eta}`);
    } else if (data.type === "backend") {
      $("hardware").innerHTML = `<span class="signal active"></span>${escapeHtml(data.backend)}`;
      setStatus(data.backend, `WebGPU fallback: ${data.fallbackReason}`);
    } else if (data.type === "checkpoint-warning") {
      setStatus("Searching without resume", `Checkpoint unavailable: ${data.message}`);
    } else if (data.type === "checkpoint-cleared") {
      clearCheckpoint(data.key);
    } else if (data.type === "result") {
      lastResult = data;
      finish();
      render(data);
    } else if (data.type === "error") {
      finish();
      setError(data.message);
    } else if (data.type === "cancelled") {
      finish();
      setStatus("Stopped", activeCheckpointKey
        ? "Progress through the last completed chunk is saved on this device."
        : "The browser worker stopped.");
    }
  };
  runWorker.onerror = (event) => {
    if (worker !== runWorker) return;
    finish(); setError(event.message || "Browser worker failed");
  };
  try {
    const module = await wasmModule;
    if (worker === runWorker) {
      runWorker.postMessage({ type: "search", request: { ...request, wasmModule: module } });
    }
  } catch (error) {
    if (worker === runWorker) {
      finish();
      setError(error.message || String(error));
    }
  }
}

function render(result) {
  $("progress").value = 1;
  const seconds = result.stats.elapsedMs / 1000;
  const structuralMode = result.stats.structuralMode || "non-approximate";
  const approximation = structuralMode === "non-approximate" ? structuralMode : `approximate ${structuralMode}`;
  const fallback = result.stats.approxFallbackReason ? ` (${result.stats.approxFallbackReason})` : "";
  setStatus("Complete", `${result.rows.length.toLocaleString()} hits in ${seconds.toFixed(2)} s with ${result.backend}; ${approximation}${fallback}.`);
  $("run-summary").textContent = result.stats.targetsSearched < result.stats.databaseTargets
    ? `${result.stats.targetsSearched.toLocaleString()} FDP candidates · ${result.stats.databaseTargets.toLocaleString()} database targets`
    : `${result.index.targets.toLocaleString()} targets · ${result.stats.chunks} chunks`;
  $("result-count").textContent = `${result.rows.length.toLocaleString()} retained`;
  $("result-body").replaceChildren(...result.rows.map((row) => {
    const tr = document.createElement("tr");
    for (const value of [row.targetId, row.positions.join(" · "), row.targetSequence, row.rmsd.toFixed(3)]) {
      const td = document.createElement("td"); td.textContent = value; tr.append(td);
    }
    return tr;
  }));
  $("results").hidden = false;
  $("download").disabled = !result.rows.length;
  const fdp = result.stats.fdpCandidates == null ? "" :
    `FDP retained ${result.stats.fdpCandidates.toLocaleString()} proteins in ${(result.stats.fdpMs / 1000).toFixed(2)} s; `;
  $("detail").textContent = fdp + `${Math.round(result.stats.windows || 0).toLocaleString()} local windows; ` +
    `${Math.round(result.stats.localRetained || 0).toLocaleString()} local candidates retained; ` +
    `${Math.round(result.stats.exactCheckpoints || 0).toLocaleString()} exact frontier checks.`;
}

function stop(label) {
  if (worker) { worker.terminate(); worker = null; }
  if (label) {
    finish();
    setStatus(label, activeCheckpointKey
      ? "Progress through the last completed chunk is saved on this device. Submit the same inputs to resume."
      : "The browser worker stopped before its first durable checkpoint.");
  }
}

function finish() {
  if (worker) { worker.terminate(); worker = null; }
  $("run").disabled = false;
  $("cancel").disabled = true;
  $("discard").disabled = !activeCheckpointKey;
}

function clearCheckpoint(key) {
  if (!key || activeCheckpointKey === key) activeCheckpointKey = null;
  $("discard").disabled = !activeCheckpointKey;
}

function requestPersistentStorage() {
  // This must originate in the window's user gesture. Failure only means the
  // browser may evict old checkpoints under storage pressure.
  navigator.storage?.persist?.().catch(() => {});
}

function setStatus(status, detail) { $("status").textContent = status; $("detail").textContent = detail; }
function setError(message) { setStatus("Could not search", message); $("progress").value = 0; }
function formatBytes(bytes) { return bytes < 2 ** 20 ? `${(bytes / 2 ** 10).toFixed(1)} KiB` : `${(bytes / 2 ** 20).toFixed(1)} MiB`; }
function formatDuration(milliseconds) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} min ${remainder} s` : `${minutes} min`;
}
function tsvField(value) { return String(value).replace(/[\t\r\n]/g, " "); }
function escapeHtml(value) { const span = document.createElement("span"); span.textContent = value; return span.innerHTML; }
