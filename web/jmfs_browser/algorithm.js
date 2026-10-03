// Browser orchestration only. CAD decode, chemistry semantics, FP64 fitting,
// observed-count planning, frontier joins, and final acceptance run in Rust/WASM.

export async function searchChunk({
  chunk,
  query,
  core,
  wasmCoords,
  wasmSequence,
  gpuChunk = null,
  packedSequence = null,
  rmsdCut,
  chemistryMode = "none",
  approximation = null,
  frontierCap = 1_000_000,
  matchLimit = 1000,
  shouldCancel = () => false,
  progress = () => {},
}) {
  const started = performance.now();
  const stats = {
    targets: chunk.records.length,
    residues: chunk.residues,
    windows: 0,
    chemistryRetained: 0,
    gpuRetained: 0,
    localRetained: 0,
    gpuMs: 0,
    gpuPairMs: 0,
    gpuPairComparisons: 0,
    gpuPairRetained: 0,
  };
  const search = gpuChunk ? searchOnDevice : searchOnCpu;
  return search({
    chunk, query, core, wasmCoords, wasmSequence, gpuChunk, packedSequence, rmsdCut,
    chemistryMode, approximation, frontierCap, matchLimit, shouldCancel, progress, stats, started,
  });
}

// CPU uses the same target scanner as the CLI; JavaScript only packs physical runs.
async function searchOnCpu({
  chunk, query, wasmCoords, wasmSequence, core, rmsdCut, chemistryMode, approximation, matchLimit,
  shouldCancel, progress, stats, started,
}) {
  if (shouldCancel()) throw new DOMException("Search cancelled", "AbortError");
  progress("Searching targets in Rust");
  const { recordOffsets, runs, runOffsets } = cpuChunkMetadata(chunk);
  const search = wasmCoords.searchPlacements(
    wasmSequence, query, recordOffsets, chemistryMode,
    { runs, runOffsets, approximation }, rmsdCut * rmsdCut, matchLimit,
  );
  return {
    rows: search.rows.map((hit) => resultRow(chunk.records[hit.recordIndex], query, hit.starts, hit.rmsd2, core)),
    stats: { ...stats, ...search.stats, ...approximationStats(approximation, false), elapsedMs: performance.now() - started },
  };
}

export function cpuChunkMetadata(chunk) {
  const recordOffsets = Uint32Array.from([...chunk.records.map((r) => r.coordOffset), chunk.residues]);
  const runOffsets = new Uint32Array(chunk.records.length + 1);
  const runs = [];
  chunk.records.forEach((record, index) => {
    for (const [begin, end] of record.singleRun ? [[0, record.numres]] : record.runs) {
      runs.push(begin, end);
    }
    runOffsets[index + 1] = runs.length / 2;
  });
  return { recordOffsets, runs: Uint32Array.from(runs), runOffsets };
}

function approximationStats(approximation, gpu) {
  const [structuralMode, approxFallbackReason = ""] = (approximation?.plan.status(gpu) ?? "non-approximate").split(":");
  return { structuralMode, approxFallbackReason };
}

// With WebGPU: every segment's candidate windows (chemistry mask, then local fit), one generic
// join per added segment, then Rust/WASM verification of the complete placements.
async function searchOnDevice({
  chunk,
  query,
  core,
  gpuChunk,
  packedSequence,
  rmsdCut,
  chemistryMode,
  approximation,
  frontierCap,
  matchLimit,
  shouldCancel,
  progress,
  stats,
  started,
}) {
  const sseLimit = rmsdCut * rmsdCut * query.totalLength + 1.0e-9;
  Object.assign(stats, approximationStats(approximation, true));
  const spacingBounds = approximation?.plan.startBounds() ?? new Int32Array();
  const targetRuns = approximation ? cpuChunkMetadata(chunk) : null;
  const geometryOnly = chemistryMode === "none";
  const segmentCount = query.segments.length;
  const requests = query.segments.map((segment) => {
    const runs = buildRuns(chunk, segment.length);
    stats.windows += runs.windowCount;
    const request = { runs, segment, localCut2: sseLimit / segment.length };
    if (!geometryOnly) {
      request.gateOffsets = Uint32Array.from(segment.chemistryOffsets);
      const queryCodes = Array.from(request.gateOffsets,
        (offset) => query.sequence[segment.qStart + offset]);
      request.allowedTable = core.chemistryTable(queryCodes, chemistryMode);
    }
    return request;
  });
  if (shouldCancel()) throw new DOMException("Search cancelled", "AbortError");
  progress("Selecting candidate windows on WebGPU");
  const batch = await gpuChunk.prepareGroupedWindows(requests, chunk.records.length);
  try {
    for (const set of batch.sets) {
      stats.chemistryRetained += set.total;
      stats.gpuRetained += set.total;
      stats.localRetained += set.total;
    }
    if (batch.sets.some((set) => set.total === 0)) {
      return { rows: [], stats: { ...stats, elapsedMs: performance.now() - started } };
    }
    const plan = segmentCount > 1
      ? core.frontierPlanCounts(
        query, batch.sets.map((set) => set.counts), chunk.records.length, rmsdCut * rmsdCut,
      )
      : { order: [0], pairComparisons: 0, pairCandidates: 0, pairReuse: 0 };
    if (shouldCancel()) throw new DOMException("Search cancelled", "AbortError");
    progress("Joining the motif on WebGPU");
    const needCodes = chemistryMode !== "none";
    const verifiedHits = [];
    let complete = 0;
    let exactCheckpoints = 0;
    let frontierRejected = 0;
    let verificationMs = 0;
    let announcedVerification = false;
    const verifyPage = async (deviceRows) => {
      if (!deviceRows.length) return;
      if (shouldCancel()) throw new DOMException("Search cancelled", "AbortError");
      if (!announcedVerification) {
        progress("Verifying complete motifs in Rust");
        announcedVerification = true;
      }
      const verificationStarted = performance.now();
      let proposals = placementsFromRows(deviceRows, plan.order, chunk);
      if (approximation) proposals = approximation.plan.filterPlacements(proposals, targetRuns.runs, targetRuns.runOffsets);
      if (!proposals.length) return;
      complete += proposals.length / (segmentCount + 1);
      const exact = decodePlacementSubset(
        core, chunk, segmentCount, proposals, packedSequence, needCodes,
      );
      const exactCoords = core.uploadCoords(exact.coords);
      const exactSequence = core.uploadSequence(exact.sequence);
      let verified;
      try {
        verified = exactCoords.searchPlacements(
          exactSequence,
          query,
          exact.recordOffsets,
          chemistryMode,
          { proposals: exact.proposals },
          rmsdCut * rmsdCut,
          matchLimit,
        );
      } finally {
        exactSequence.dispose();
        exactCoords.dispose();
      }
      exactCheckpoints += verified.proposals;
      frontierRejected += verified.rejected;
      if (!needCodes) decodeReportedCodes(exact.records, verified.rows, packedSequence);
      for (const hit of verified.rows) {
        const record = exact.records[hit.recordIndex];
        verifiedHits.push({
          recordIndex: record.chunkIndex,
          starts: hit.starts,
          rmsd2: hit.rmsd2,
          row: resultRow(record, query, hit.starts, hit.rmsd2, core),
        });
      }
      if (verifiedHits.length >= matchLimit * 2) sortAndLimitVerified(verifiedHits, matchLimit);
      verificationMs += performance.now() - verificationStarted;
    };
    const joined = await gpuChunk.joinSegments(
      batch, plan.order, query, plan.lower2Matrix, plan.upper2Matrix, sseLimit, frontierCap,
      verifyPage, spacingBounds,
    );
    stats.gpuMs = performance.now() - batch.started - verificationMs;
    stats.gpuPairComparisons = plan.pairComparisons;
    stats.gpuPairRetained = joined.counts[0] ?? 0;
    const planStats = {
      pairComparisons: plan.pairComparisons,
      pairCandidates: plan.pairCandidates,
      pairReuse: plan.pairReuse,
      pairProposals: joined.counts[0] ?? complete,
      frontierRows: complete,
      predictedPartner: false,
      seedPair: plan.order.slice(0, 2).map((value) => value + 1),
      extensionOrder: plan.order.slice(2).map((value) => value + 1),
    };
    if (!complete) {
      return {
        rows: [],
        stats: {
          ...stats, ...planStats, exactCheckpoints: 0, frontierRejected: 0,
          elapsedMs: performance.now() - started,
        },
      };
    }
    sortAndLimitVerified(verifiedHits, matchLimit);
    const rows = verifiedHits.map((hit) => hit.row);
    return {
      rows,
      stats: {
        ...stats,
        ...planStats,
        exactCheckpoints,
        frontierRejected,
        elapsedMs: performance.now() - started,
      },
    };
  } finally {
    batch.dispose();
  }
}

// Join rows (target, coordinate starts in join order) to verifier proposals (target, residue
// start of each segment in query order).
function placementsFromRows(rows, order, chunk) {
  const width = order.length + 1;
  const proposals = new Uint32Array(rows.length);
  for (let row = 0; row < rows.length; row += width) {
    const record = rows[row];
    const offset = chunk.records[record].coordOffset;
    proposals[row] = record;
    for (let j = 0; j < order.length; j += 1) proposals[row + 1 + order[j]] = rows[row + 1 + j] - offset;
  }
  return proposals;
}

function decodePlacementSubset(core, chunk, segmentCount, proposals, packedSequence, needCodes = true) {
  const stride = segmentCount + 1;
  const selected = Array.from(new Set(
    Array.from({ length: proposals.length / stride }, (_, row) => proposals[row * stride]),
  )).sort((left, right) => left - right);
  const remap = new Map(selected.map((record, index) => [record, index]));
  const metadata = new Uint32Array(selected.length * 4);
  const recordOffsets = new Uint32Array(selected.length + 1);
  // Only the selected targets' CAD1 records go to WASM (the chunk's stream is about 80 MB).
  let hotBytes = 0;
  for (const record of selected) hotBytes += chunk.hotMetadata[record * 4 + 1];
  const hot = new Uint8Array(hotBytes);
  let residues = 0;
  let hotCursor = 0;
  selected.forEach((record, index) => {
    const [hotOffset, hotLength, numres] = chunk.hotMetadata.subarray(record * 4, record * 4 + 3);
    hot.set(chunk.hot.subarray(hotOffset, hotOffset + hotLength), hotCursor);
    metadata.set([hotCursor, hotLength, numres, residues], index * 4);
    recordOffsets[index] = residues;
    residues += numres;
    hotCursor += hotLength;
  });
  recordOffsets[selected.length] = residues;
  const coords = core.decodeCad1Batch(hot, metadata, residues);
  // Candidate targets only: the device read the chunk's codes from the packed planes.
  let sequence = new Uint8Array(residues);
  if (needCodes && selected.some((record) => !chunk.records[record].sequence)) {
    const rows = new Uint32Array(selected.length * 4);
    selected.forEach((record, index) => {
      rows.set(chunk.records[record].sequenceRow, index * 4);
      rows[index * 4 + 3] = recordOffsets[index];
    });
    sequence = packedSequence.decodeBatch(rows, residues);
  }
  const records = [];
  selected.forEach((record, index) => {
    const source = chunk.records[record];
    const begin = recordOffsets[index];
    const end = recordOffsets[index + 1];
    if (source.sequence) sequence.set(source.sequence, begin);
    records.push({
      chunkIndex: record,
      targetIndex: source.targetIndex,
      id: source.id,
      numres: source.numres,
      coordOffset: begin,
      sequence: needCodes || source.sequence ? sequence.subarray(begin, end) : null,
      sequenceRow: source.sequenceRow,
    });
  });
  const remappedProposals = new Uint32Array(proposals);
  for (let row = 0; row < remappedProposals.length; row += stride) {
    remappedProposals[row] = remap.get(remappedProposals[row]);
  }
  return { coords, sequence, records, recordOffsets, proposals: remappedProposals };
}

function sortAndLimitVerified(hits, limit) {
  hits.sort((left, right) => {
    if (left.rmsd2 !== right.rmsd2) return left.rmsd2 - right.rmsd2;
    if (left.recordIndex !== right.recordIndex) return left.recordIndex - right.recordIndex;
    for (let index = 0; index < left.starts.length; index += 1) {
      if (left.starts[index] !== right.starts[index]) return left.starts[index] - right.starts[index];
    }
    return 0;
  });
  if (hits.length > limit) hits.length = limit;
}

// Residue codes of the targets that appear in reported rows (the route without chemistry
// verifies on geometry alone).
function decodeReportedCodes(records, hits, packedSequence) {
  const reported = Array.from(new Set(hits.map((hit) => hit.recordIndex)))
    .filter((record) => !records[record].sequence);
  if (!reported.length) return;
  const rows = new Uint32Array(reported.length * 4);
  let total = 0;
  reported.forEach((record, index) => {
    rows.set(records[record].sequenceRow, index * 4);
    rows[index * 4 + 3] = total;
    total += records[record].numres;
  });
  const codes = packedSequence.decodeBatch(rows, total);
  reported.forEach((record, index) => {
    const begin = rows[index * 4 + 3];
    records[record].sequence = codes.subarray(begin, begin + records[record].numres);
  });
}

export function buildRuns(chunk, length) {
  let rows = 0;
  for (const record of chunk.records) rows += record.singleRun ? 1 : record.runs.length;
  const words = new Uint32Array(rows * 4);
  let used = 0;
  let windowCount = 0;
  const add = (recordIndex, record, begin, end) => {
    const count = Math.max(0, end - begin - length + 1);
    if (!count) return;
    words[used] = recordIndex;
    words[used + 1] = record.coordOffset + begin;
    words[used + 2] = begin;
    words[used + 3] = count;
    used += 4;
    windowCount += count;
  };
  chunk.records.forEach((record, recordIndex) => {
    if (record.singleRun) {
      add(recordIndex, record, 0, record.numres);
      return;
    }
    for (const [begin, end] of record.runs) add(recordIndex, record, begin, end);
  });
  return { words: words.subarray(0, used), windowCount };
}

function resultRow(record, query, starts, rmsd2, core) {
  const targetSequence = starts.map((start, segmentIndex) => {
    const length = query.segments[segmentIndex].length;
    return Array.from(
      record.sequence.subarray(start, start + length),
      (code) => core.sequenceLetter(code),
    ).join("");
  }).join("/");
  return {
    targetIndex: record.targetIndex,
    targetId: record.id,
    starts,
    positions: starts.map((start, index) => `${start + 1}-${start + query.segments[index].length}`),
    targetSequence,
    rmsd: Math.sqrt(Math.max(rmsd2, 0)),
  };
}
