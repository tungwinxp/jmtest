import initWebCore, { WebGpuRunner, Approximation } from "./assets/jmfs_web_core_bindings.js?v=19";

export class WasmCore {
  static async load(url = "./assets/jmfs_web_core.wasm") {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`JMFS WASM fetch failed (${response.status})`);
    // Buffering avoids browser-specific instantiateStreaming stalls in module
    // workers without changing the Rust algorithm or keeping a second path.
    return WasmCore.fromModule(await WebAssembly.compile(await response.arrayBuffer()));
  }

  static async fromModule(module) {
    const core = new WasmCore(await initWebCore({ module_or_path: module }));
    if (core.exports.jmfs_core_version() !== 8) {
      throw new Error("JMFS browser core version mismatch");
    }
    return core;
  }

  constructor(exports) {
    this.exports = exports;
  }

  bytes(pointer, length) {
    return new Uint8Array(this.exports.memory.buffer, pointer, length);
  }

  f32(pointer, length) {
    return new Float32Array(this.exports.memory.buffer, pointer, length);
  }

  f64(pointer, length) {
    return new Float64Array(this.exports.memory.buffer, pointer, length);
  }

  u32(pointer, length) {
    return new Uint32Array(this.exports.memory.buffer, pointer, length);
  }

  decodeCad1(encoded, numres) {
    const input = this.exports.jmfs_alloc_bytes(encoded.length);
    const outputLength = numres * 3;
    const output = this.exports.jmfs_alloc_f32(outputLength);
    try {
      this.bytes(input, encoded.length).set(encoded);
      const status = this.exports.jmfs_decode_cad1(
        input,
        encoded.length,
        numres,
        output,
        outputLength,
      );
      if (status !== 0) throw new Error(`CAD1 decode failed (${status})`);
      return new Float32Array(this.f32(output, outputLength));
    } finally {
      this.exports.jmfs_dealloc_bytes(input, encoded.length);
      this.exports.jmfs_dealloc_f32(output, outputLength);
    }
  }

  decodeCad1Batch(encoded, metadata, outputPoints) {
    const input = this.exports.jmfs_alloc_bytes(encoded.length);
    const metadataPointer = this.exports.jmfs_alloc_u32(metadata.length);
    const outputLength = outputPoints * 3;
    const output = this.exports.jmfs_alloc_f32(outputLength);
    try {
      this.bytes(input, encoded.length).set(encoded);
      this.u32(metadataPointer, metadata.length).set(metadata);
      const status = this.exports.jmfs_decode_cad1_batch(
        input, encoded.length, metadataPointer, metadata.length / 4,
        output, outputPoints,
      );
      if (status !== 0) throw new Error(`CAD1 batch decode failed (${status})`);
      return new Float32Array(this.f32(output, outputLength));
    } finally {
      this.exports.jmfs_dealloc_bytes(input, encoded.length);
      this.exports.jmfs_dealloc_u32(metadataPointer, metadata.length);
      this.exports.jmfs_dealloc_f32(output, outputLength);
    }
  }

  uploadPackedSequence(bytes, layout) {
    return new WasmPackedSequence(this, bytes, layout);
  }

  uploadCoords(coords) {
    return new WasmCoords(this, coords);
  }

  uploadSequence(sequence) {
    return new WasmSequence(this, sequence);
  }

  approximation(query, chemistryMode, options, rmsdCut) {
    if (!options || options === "off") return null;
    const settings = typeof options === "object" ? options : { mode: options === true ? "auto" : options };
    const mode = ["auto", "single", "spacing", "anchor"].indexOf(settings.mode ?? "auto") + 1;
    if (!mode) throw new Error("Approximate mode must be auto, single, spacing, or anchor");
    const config = Approximation.defaultOptions();
    config[0] = mode;
    ["spacingSlack", "spacingBudget", "maxLocalGap", "anchorScale", "partnerRadiusScale",
      "maxAnchorRate", "probeScale", "probeCap"].forEach((name, index) => {
      if (settings[name] != null) config[index + 1] = settings[name];
    });
    const chains = new Map();
    const labels = Uint32Array.from((query.labels || []).flatMap(({ chain, resSeq, insertion }, index) => {
      if (!chains.has(chain)) chains.set(chain, chains.size);
      return [chains.get(chain), resSeq, (insertion || " ").charCodeAt(0), query.sourceRuns?.[index] ?? 0xffffffff];
    }));
    const chemistrySegments = [0];
    const chemistryOffsets = [];
    query.segments.forEach((segment) => {
      chemistryOffsets.push(...segment.chemistryOffsets);
      chemistrySegments.push(chemistryOffsets.length);
    });
    const plan = new Approximation(query.coords, query.sequence,
      Uint32Array.from(query.segments, s => s.qStart), Uint32Array.from(query.segments, s => s.length),
      labels, Uint32Array.from(chemistrySegments), Uint32Array.from(chemistryOffsets),
      chemistryMode === "none" ? 0 : chemistryMode === "reduced" ? 2 : 1, config, rmsdCut);
    return { plan, config, labels };
  }

  querySourceRuns(residues) {
    const chains = new Map();
    const labels = Uint32Array.from(residues.flatMap(({ chain, resSeq, insertion, sourceRun = 0 }) => {
      if (!chains.has(chain)) chains.set(chain, chains.size);
      return [chains.get(chain), resSeq, (insertion || " ").charCodeAt(0), sourceRun];
    }));
    return Approximation.sourceRuns(labels, Uint8Array.from(residues, residue => residue.code));
  }

  sequenceLetter(code) {
    return String.fromCharCode(this.exports.jmfs_sequence_letter(code));
  }

  chemistryTable(queryCodes, mode) {
    if (mode !== "exact" && mode !== "reduced") throw new Error("chemistry table needs an enabled mode");
    const encodedMode = mode === "reduced" ? 2 : 1;
    const table = new Uint32Array(queryCodes.length * 256);
    queryCodes.forEach((queryCode, gate) => {
      for (let targetCode = 0; targetCode < 256; targetCode += 1) {
        table[gate * 256 + targetCode] = this.exports.jmfs_chemistry_allowed(
          queryCode, targetCode, encodedMode,
        );
      }
    });
    return table;
  }

  fdpQueryHashes(aminoAcids, atoms, allowedMasks, distanceTolerance = 0.5, angleTolerance = 5) {
    if (!(aminoAcids instanceof Uint32Array) || !(atoms instanceof Float32Array)
        || !(allowedMasks instanceof Uint32Array)
        || aminoAcids.length < 2 || allowedMasks.length !== aminoAcids.length
        || atoms.length !== aminoAcids.length * 12) {
      throw new Error("FDP hashing requires matching amino-acid, backbone, and allowance rows");
    }
    const pointers = [];
    const alloc = (kind, values) => copyToWasm(this, pointers, kind, values);
    const aminoPointer = alloc("u32", aminoAcids);
    const atomsPointer = alloc("f32", atoms);
    const allowedPointer = alloc("u32", allowedMasks);
    try {
      const needed = this.exports.jmfs_fdp_query_hashes(
        aminoPointer, atomsPointer, allowedPointer, aminoAcids.length,
        distanceTolerance, angleTolerance, 0, 0,
      );
      if (needed <= 0) throw new Error(`shared Rust FDP hashing failed (${needed})`);
      const outputPointer = this.exports.jmfs_alloc_u32(needed);
      try {
        const written = this.exports.jmfs_fdp_query_hashes(
          aminoPointer, atomsPointer, allowedPointer, aminoAcids.length,
          distanceTolerance, angleTolerance, outputPointer, needed,
        );
        if (written !== needed) throw new Error(`shared Rust FDP hash write failed (${written})`);
        const words = new Uint32Array(this.u32(outputPointer, needed));
        const groupCount = words[0];
        if (groupCount + 2 > words.length) throw new Error("shared Rust FDP hashes are truncated");
        return Array.from({ length: groupCount }, (_, group) => {
          const begin = words[group + 1];
          const end = words[group + 2];
          if (begin > end || end > words.length) throw new Error("shared Rust FDP hash offsets are invalid");
          return words.slice(begin, end);
        });
      } finally {
        this.exports.jmfs_dealloc_u32(outputPointer, needed);
      }
    } finally {
      freeWasm(this, pointers);
    }
  }

  frontierPlanCounts(query, counts, targetCount, rmsd2Cut) {
    return planFrontierCounts(this, query, counts, targetCount, rmsd2Cut);
  }

  residueCode(name, protein) {
    const encoded = new TextEncoder().encode(name);
    const pointer = this.exports.jmfs_alloc_bytes(encoded.length);
    try {
      this.bytes(pointer, encoded.length).set(encoded);
      const code = this.exports.jmfs_residue_name_code(pointer, encoded.length, protein ? 1 : 0);
      if (code === 0xffffffff) throw new Error(`Cannot encode residue name ${name}`);
      return code;
    } finally {
      this.exports.jmfs_dealloc_bytes(pointer, encoded.length);
    }
  }

  // Scene mmCIF from the shared `jmfs visualize` writer: superposition, PULCHRA backbone and
  // secondary structure are the CLI's own. The packed little-endian request is six u32
  // (query id bytes, target id bytes, query residues, segments, target residues, atoms), an f64
  // RMSD, both ids, padding to four bytes, u32 segment starts then lengths, float32 xyz for the
  // query motif then the whole target, their residue codes, padding to four bytes, and 36-byte
  // query atoms: name[4], residue name[4], chain[4], i32 residue number, insertion code with
  // three pad bytes, float32 xyz and float32 B factor.
  sceneCif({ queryId, targetId, rmsd, segBeg, segLen, queryCoords, querySeq, targetCoords, targetSeq, atoms }) {
    const encoder = new TextEncoder();
    const ids = [encoder.encode(queryId), encoder.encode(targetId)];
    const pad = (length) => (4 - (length % 4)) % 4;
    const idBytes = ids[0].length + ids[1].length;
    const sequenceBytes = querySeq.length + targetSeq.length;
    const length = 32 + idBytes + pad(idBytes) + segBeg.length * 8
      + queryCoords.length * 4 + targetCoords.length * 4
      + sequenceBytes + pad(sequenceBytes) + atoms.length * 36;
    const input = this.exports.jmfs_alloc_bytes(length);
    try {
      const bytes = this.bytes(input, length);
      bytes.fill(0);
      const view = new DataView(bytes.buffer, bytes.byteOffset, length);
      [ids[0].length, ids[1].length, querySeq.length, segBeg.length, targetSeq.length, atoms.length]
        .forEach((value, word) => view.setUint32(word * 4, value, true));
      view.setFloat64(24, rmsd, true);
      let at = 32;
      for (const id of ids) { bytes.set(id, at); at += id.length; }
      at += pad(idBytes);
      for (const value of [...segBeg, ...segLen]) { view.setUint32(at, value, true); at += 4; }
      for (const coords of [queryCoords, targetCoords]) {
        for (const value of coords) { view.setFloat32(at, value, true); at += 4; }
      }
      bytes.set(querySeq, at); at += querySeq.length;
      bytes.set(targetSeq, at); at += targetSeq.length + pad(sequenceBytes);
      const text = (value, offset) => bytes.set(encoder.encode(value).subarray(0, 4), offset);
      for (const atom of atoms) {
        text(atom.name, at);
        text(atom.resName, at + 4);
        text(atom.chain, at + 8);
        view.setInt32(at + 12, atom.resSeq, true);
        bytes[at + 16] = (atom.insertion || " ").charCodeAt(0);
        atom.xyz.forEach((value, axis) => view.setFloat32(at + 20 + axis * 4, value, true));
        view.setFloat32(at + 32, atom.bFactor, true);
        at += 36;
      }
      const needed = this.exports.jmfs_scene_cif(input, length, 0, 0);
      if (needed < 0) throw new Error(`scene export failed (${needed})`);
      const output = this.exports.jmfs_alloc_bytes(needed);
      try {
        this.exports.jmfs_scene_cif(input, length, output, needed);
        return new TextDecoder().decode(this.bytes(output, needed));
      } finally {
        this.exports.jmfs_dealloc_bytes(output, needed);
      }
    } finally {
      this.exports.jmfs_dealloc_bytes(input, length);
    }
  }

  fit(target, query, withPose = false) {
    if (target.length !== query.length || target.length % 3 !== 0) {
      throw new Error("exact fit expects equal flat xyz arrays");
    }
    const length = target.length;
    const targetPointer = this.exports.jmfs_alloc_f32(length);
    const queryPointer = this.exports.jmfs_alloc_f32(length);
    try {
      this.f32(targetPointer, length).set(target);
      this.f32(queryPointer, length).set(query);
      if (!withPose) {
        return { rmsd2: this.exports.jmfs_kabsch_rmsd2(targetPointer, queryPointer, length / 3) };
      }
      const outputPointer = this.exports.jmfs_alloc_f64(13);
      try {
        const status = this.exports.jmfs_kabsch_pose(
          targetPointer,
          queryPointer,
          length / 3,
          outputPointer,
          13,
        );
        if (status !== 0) throw new Error(`exact pose failed (${status})`);
        const output = new Float64Array(this.f64(outputPointer, 13));
        return {
          rmsd2: output[0],
          rotation: [
            Array.from(output.subarray(1, 4)),
            Array.from(output.subarray(4, 7)),
            Array.from(output.subarray(7, 10)),
          ],
          translation: Array.from(output.subarray(10, 13)),
        };
      } finally {
        this.exports.jmfs_dealloc_f64(outputPointer, 13);
      }
    } finally {
      this.exports.jmfs_dealloc_f32(targetPointer, length);
      this.exports.jmfs_dealloc_f32(queryPointer, length);
    }
  }
}

export function createWebGpuRunner() {
  return WebGpuRunner.create();
}

export class WasmCoords {
  constructor(core, coords) {
    this.core = core;
    this.length = coords.length;
    this.pointer = core.exports.jmfs_alloc_f32(coords.length);
    core.f32(this.pointer, coords.length).set(coords);
    this.disposed = false;
  }

  searchPlacements(wasmSequence, query, recordOffsets, chemistryMode, input, rmsd2Cut, matchLimit) {
    if (this.disposed || wasmSequence.disposed) throw new Error("WASM chunk was disposed");
    if (wasmSequence.core !== this.core) throw new Error("WASM chunk cores do not match");
    const { core } = this;
    const segmentCount = query.segments.length;
    const stride = segmentCount + 1;
    const { proposals, runs, runOffsets, approximation } = input;
    if (proposals && !proposals.length) return { rows: [], proposals: 0, rejected: 0 };
    if (proposals && proposals.length % stride) throw new Error("placement proposal layout is invalid");
    const segmentOffsets = Uint32Array.from(query.segments, (segment) => segment.qStart);
    const segmentLens = Uint32Array.from(query.segments, (segment) => segment.length);
    const chemistrySegmentOffsets = new Uint32Array(segmentCount + 1);
    const chemistryOffsets = [];
    query.segments.forEach((segment, index) => {
      chemistryOffsets.push(...segment.chemistryOffsets);
      chemistrySegmentOffsets[index + 1] = chemistryOffsets.length;
    });
    const flatChemistryOffsets = Uint32Array.from(chemistryOffsets);
    const capacity = Math.max(1, matchLimit);
    const pointers = [];
    const alloc = (kind, values) => copyToWasm(core, pointers, kind, values);
    const reserve = (kind, length) => reserveWasm(core, pointers, kind, length);
    const recordOffsetsPointer = alloc("u32", recordOffsets);
    const queryPointer = alloc("f32", query.coords);
    const querySequencePointer = alloc("bytes", query.sequence);
    const segmentOffsetsPointer = alloc("u32", segmentOffsets);
    const segmentLensPointer = alloc("u32", segmentLens);
    const chemistrySegmentOffsetsPointer = alloc("u32", chemistrySegmentOffsets);
    const chemistryOffsetsPointer = alloc("u32", flatChemistryOffsets);
    const anchorRates = !proposals && approximation ? approximation.plan.rates() : [];
    const extra = proposals
      ? [alloc("u32", proposals), proposals.length / stride]
      : [alloc("u32", runs), runs.length / 2, alloc("u32", runOffsets),
        alloc("f64", approximation?.config ?? []), approximation?.config.length ?? 0,
        alloc("u32", approximation?.labels ?? []), approximation?.labels.length ?? 0,
        alloc("f64", anchorRates), anchorRates.length];
    const outputRecordsPointer = reserve("u32", capacity);
    const outputStartsPointer = reserve("u32", capacity * segmentCount);
    const outputRmsdPointer = reserve("f64", capacity);
    const outputStatsPointer = reserve("f64", 5);
    const mode = chemistryMode === "none" ? 0 : chemistryMode === "reduced" ? 2 : 1;
    try {
      const execute = proposals ? core.exports.jmfs_verify_placements : core.exports.jmfs_search_cpu;
      const count = execute(
        this.pointer,
        this.length / 3,
        wasmSequence.pointer,
        wasmSequence.length,
        recordOffsetsPointer,
        recordOffsets.length - 1,
        queryPointer,
        query.totalLength,
        querySequencePointer,
        query.sequence.length,
        segmentOffsetsPointer,
        segmentLensPointer,
        segmentCount,
        chemistrySegmentOffsetsPointer,
        chemistryOffsetsPointer,
        flatChemistryOffsets.length,
        mode,
        ...extra,
        rmsd2Cut,
        capacity,
        outputRecordsPointer,
        outputStartsPointer,
        outputRmsdPointer,
        outputStatsPointer,
      );
      if (count === 0xffffffff) throw new Error("Rust placement search rejected its inputs");
      const records = core.u32(outputRecordsPointer, count);
      const starts = core.u32(outputStartsPointer, count * segmentCount);
      const rmsd2 = core.f64(outputRmsdPointer, count);
      const stats = core.f64(outputStatsPointer, 5);
      return {
        rows: Array.from({ length: count }, (_, row) => ({
          recordIndex: records[row],
          starts: Array.from(starts.subarray(row * segmentCount, (row + 1) * segmentCount)),
          rmsd2: rmsd2[row],
        })),
        proposals: stats[0],
        rejected: stats[1],
        stats: proposals ? {} : {
          exactCheckpoints: stats[0], sequenceRejected: stats[1],
          segmentRejected: stats[2], frontierRejected: stats[3], acceptedPlacements: stats[4],
        },
      };
    } finally {
      freeWasm(core, pointers);
    }
  }

  dispose() {
    if (!this.disposed) {
      this.core.exports.jmfs_dealloc_f32(this.pointer, this.length);
      this.disposed = true;
    }
  }
}

function copyToWasm(core, pointers, kind, values) {
  const pointer = core.exports[`jmfs_alloc_${kind}`](values.length);
  core[kind === "bytes" ? "bytes" : kind](pointer, values.length).set(values);
  pointers.push([kind, pointer, values.length]);
  return pointer;
}

function reserveWasm(core, pointers, kind, length) {
  const pointer = core.exports[`jmfs_alloc_${kind}`](length);
  pointers.push([kind, pointer, length]);
  return pointer;
}

function freeWasm(core, pointers) {
  for (const [kind, pointer, length] of pointers.reverse()) {
    core.exports[`jmfs_dealloc_${kind}`](pointer, length);
  }
}

function planFrontierCounts(core, query, counts, targetCount, rmsd2Cut) {
  const segmentCount = query.segments.length;
  if (counts.length !== segmentCount
      || counts.some((row) => row.length !== targetCount)) {
    throw new Error("frontier counts do not match the query and target chunk");
  }
  const segmentOffsets = Uint32Array.from(query.segments, (segment) => segment.qStart);
  const segmentLens = Uint32Array.from(query.segments, (segment) => segment.length);
  const flatCounts = new Uint32Array(segmentCount * targetCount);
  counts.forEach((row, segment) => flatCounts.set(row, segment * targetCount));
  const pointers = [];
  const alloc = (kind, values) => copyToWasm(core, pointers, kind, values);
  const queryPointer = alloc("f32", query.coords);
  const segmentOffsetsPointer = alloc("u32", segmentOffsets);
  const segmentLensPointer = alloc("u32", segmentLens);
  const countsPointer = alloc("u32", flatCounts);
  const outputOrderPointer = reserveWasm(core, pointers, "u32", segmentCount);
  const outputMetricsPointer = reserveWasm(core, pointers, "f64", 5);
  const outputLowerPointer = reserveWasm(core, pointers, "f64", segmentCount * segmentCount);
  const outputUpperPointer = reserveWasm(core, pointers, "f64", segmentCount * segmentCount);
  try {
    const status = core.exports.jmfs_frontier_plan_counts(
      queryPointer,
      query.totalLength,
      segmentOffsetsPointer,
      segmentLensPointer,
      segmentCount,
      countsPointer,
      targetCount,
      rmsd2Cut,
      outputOrderPointer,
      outputMetricsPointer,
      outputLowerPointer,
      outputUpperPointer,
    );
    if (status !== 0) throw new Error(`Rust frontier count planner rejected its inputs (${status})`);
    const metrics = new Float64Array(core.f64(outputMetricsPointer, 5));
    return {
      order: Array.from(core.u32(outputOrderPointer, segmentCount)),
      lower2: metrics[0],
      upper2: metrics[1],
      pairCandidates: metrics[2],
      pairComparisons: metrics[3],
      pairReuse: metrics[4],
      lower2Matrix: new Float64Array(core.f64(outputLowerPointer, segmentCount * segmentCount)),
      upper2Matrix: new Float64Array(core.f64(outputUpperPointer, segmentCount * segmentCount)),
    };
  } finally {
    freeWasm(core, pointers);
  }
}

export class WasmSequence {
  constructor(core, sequence) {
    this.core = core;
    this.length = sequence.length;
    this.pointer = core.exports.jmfs_alloc_bytes(sequence.length);
    core.bytes(this.pointer, sequence.length).set(sequence);
    this.disposed = false;
  }

  dispose() {
    if (!this.disposed) {
      this.core.exports.jmfs_dealloc_bytes(this.pointer, this.length);
      this.disposed = true;
    }
  }
}

export class WasmPackedSequence {
  constructor(core, bytes, layout) {
    this.core = core;
    this.length = bytes.length;
    this.layout = layout;
    this.pointer = core.exports.jmfs_alloc_bytes(bytes.length);
    core.bytes(this.pointer, bytes.length).set(bytes);
    this.disposed = false;
  }

  decodeBatch(metadata, outputLength) {
    if (this.disposed) throw new Error("WASM packed sequence was disposed");
    const { core } = this;
    const metadataPointer = core.exports.jmfs_alloc_u32(metadata.length);
    const outputPointer = core.exports.jmfs_alloc_bytes(outputLength);
    try {
      core.u32(metadataPointer, metadata.length).set(metadata);
      const status = core.exports.jmfs_decode_sequence_batch(
        this.pointer,
        this.length,
        this.layout.five.dataOffset,
        this.layout.five.planeLength,
        this.layout.seven.dataOffset,
        this.layout.seven.planeLength,
        metadataPointer,
        metadata.length / 4,
        outputPointer,
        outputLength,
      );
      if (status !== 0) throw new Error(`sequence batch decode failed (${status})`);
      return new Uint8Array(core.bytes(outputPointer, outputLength));
    } finally {
      core.exports.jmfs_dealloc_u32(metadataPointer, metadata.length);
      core.exports.jmfs_dealloc_bytes(outputPointer, outputLength);
    }
  }

  dispose() {
    if (!this.disposed) {
      this.core.exports.jmfs_dealloc_bytes(this.pointer, this.length);
      this.disposed = true;
    }
  }
}
