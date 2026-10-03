const HEADER_LENGTH = 64;
const SECTION_LENGTH = 32;
const DIR_LENGTH = 56;
const MAGIC = "JMFSGEO1";
const VERSION = 5;
const FLAG_SEQ5 = 1 << 0;
const FLAG_CAD1 = 1 << 2;
const FLAG_SEQ7 = 1 << 7;
const RANGE_READ_CONCURRENCY = 6;
const RANGE_COALESCE_GAP = 64 * 1024;
const RANGE_COALESCE_BYTES = 16 * 1024 * 1024;
const textDecoder = new TextDecoder();

// Two 32-bit reads instead of getBigUint64: the directory is parsed for every target of every chunk,
// and BigInt conversion was 0.2 s per Swiss-Prot search. The high word must stay below 2^21.
function u64(view, offset, label) {
  const high = view.getUint32(offset + 4, true);
  if (high > 0x1fffff) throw new Error(`${label} exceeds browser integer range`);
  return high * 0x100000000 + view.getUint32(offset, true);
}

function tag(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export class BlobRangeSource {
  constructor(blob) {
    this.blob = blob;
    this.size = blob.size;
    this.label = blob.name || "local index";
  }

  async read(offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new Error(`index read is outside ${this.label}`);
    }
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}

// One target of a direct-GPU chunk. Identifier, run ranges and the sequence row are derived on
// use; the search reads numres, coordOffset and singleRun for every target.
class ChunkRecord {
  constructor(index, targetIndex, numres, coordOffset, singleRun, sequenceRows, sequenceAt) {
    this.index = index;
    this.targetIndex = targetIndex;
    this.numres = numres;
    this.coordOffset = coordOffset;
    this.singleRun = singleRun;
    this.sequence = null;
    this.sequenceRows = sequenceRows;
    this.sequenceAt = sequenceAt;
  }

  get id() { return this.index.id(this.index.entry(this.targetIndex)); }

  get runs() {
    return this.singleRun
      ? [[0, this.numres]]
      : this.index.runRanges(this.index.entry(this.targetIndex));
  }

  get sequenceRow() { return this.sequenceRows.subarray(this.sequenceAt, this.sequenceAt + 3); }
}

export class HttpRangeSource {
  constructor(url, maxWholeFetch = 64 * 1024 * 1024) {
    this.url = url;
    this.label = url;
    this.size = null;
    this.whole = null;
    this.maxWholeFetch = maxWholeFetch;
  }

  async read(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
      throw new Error("index range must use non-negative safe integers");
    }
    if (this.size != null && offset + length > this.size) {
      throw new Error(`index read is outside ${this.label}`);
    }
    if (length === 0) return new Uint8Array();
    if (this.whole) return this.whole.slice(offset, offset + length);
    const response = await fetch(this.url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      cache: "force-cache",
    });
    if (!(response.status === 206 || response.status === 200)) {
      throw new Error(`index range request failed (${response.status})`);
    }
    if (response.status === 206) {
      const contentRange = response.headers.get("content-range") || "";
      const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
      if (match && (Number(match[1]) !== offset || Number(match[2]) !== offset + length - 1)) {
        await response.body?.cancel();
        throw new Error("HTTP response does not match the requested index range");
      }
      // Content-Range is not CORS-safelisted. Some immutable object stores
      // return the correct 206 bytes but do not expose that header to JS.
      // Exact response length still authenticates the requested interval;
      // retain an unknown total size until an exposed response supplies it.
      if (match) this.size = Number(match[3]);
      if (this.size != null && (!Number.isSafeInteger(this.size) || offset + length > this.size)) {
        await response.body?.cancel();
        throw new Error("HTTP index length is invalid");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== length) throw new Error(`short HTTP range: ${bytes.length} of ${length}`);
      return bytes;
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > this.maxWholeFetch) {
      await response.body?.cancel();
      throw new Error(
        "This host ignored HTTP Range or omitted a bounded length. Enable byte-range responses before serving a .jmfsgeom file.",
      );
    }
    this.whole = new Uint8Array(await response.arrayBuffer());
    this.size = this.whole.length;
    return this.whole.slice(offset, offset + length);
  }
}

export class JmfsIndex {
  static async open(source, progress = () => {}, maxMetadataBytes = 512 * 1024 * 1024) {
    progress("Reading index header");
    const headerBytes = await source.read(0, HEADER_LENGTH);
    if (textDecoder.decode(headerBytes.subarray(0, 8)) !== MAGIC) throw new Error("Not a JMFSGEOM index");
    const header = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
    if (header.getUint32(8, true) !== VERSION) {
      throw new Error(`Browser requires JMFSGEOM v${VERSION}`);
    }
    if (header.getUint32(12, true) !== HEADER_LENGTH || header.getUint32(20, true) !== DIR_LENGTH) {
      throw new Error("Unsupported JMFSGEOM header or directory layout");
    }
    const sectionCount = header.getUint32(16, true);
    const targetCount = u64(header, 24, "target count");
    const residueCount = u64(header, 32, "residue count");
    const tableOffset = u64(header, 56, "section table offset");
    const tableBytes = await source.read(tableOffset, sectionCount * SECTION_LENGTH);
    const table = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength);
    const sections = new Map();
    for (let index = 0; index < sectionCount; index += 1) {
      const base = index * SECTION_LENGTH;
      const name = tag(table, base);
      const section = {
        tag: name,
        version: table.getUint32(base + 4, true),
        offset: u64(table, base + 8, `${name} offset`),
        length: u64(table, base + 16, `${name} length`),
        // AUX may be a full-width checksum rather than a byte count.
        aux: table.getBigUint64(base + 24, true),
      };
      if (source.size != null && section.offset + section.length > source.size) {
        throw new Error(`${name} section extends beyond the index`);
      }
      sections.set(name, section);
    }
    for (const required of ["DIR ", "IDS ", "SEQK", "RUNS", "HOTC"]) {
      if (!sections.has(required)) throw new Error(`JMFSGEOM lacks ${required} section`);
    }
    const metadataNames = ["DIR ", "IDS ", "SEQK", "RUNS"];
    const metadataBytes = metadataNames.reduce((sum, name) => sum + sections.get(name).length, 0);
    if (metadataBytes > maxMetadataBytes) {
      throw new Error(
        `Index metadata is ${(metadataBytes / 2 ** 20).toFixed(1)} MiB; browser limit is ${(maxMetadataBytes / 2 ** 20).toFixed(0)} MiB`,
      );
    }
    const loaded = {};
    for (const name of metadataNames) {
      const section = sections.get(name);
      progress(`Loading ${name.trim()} metadata (${(section.length / 2 ** 20).toFixed(1)} MiB)`);
      loaded[name] = await source.read(section.offset, section.length);
    }
    if (loaded["DIR "].length !== targetCount * DIR_LENGTH) {
      throw new Error("JMFSGEOM directory length does not match target count");
    }
    return new JmfsIndex(source, sections, loaded, targetCount, residueCount);
  }

  constructor(source, sections, loaded, targetCount, residueCount) {
    this.source = source;
    this.sections = sections;
    this.dir = loaded["DIR "];
    this.dirView = new DataView(this.dir.buffer, this.dir.byteOffset, this.dir.byteLength);
    this.ids = loaded["IDS "];
    this.seq = loaded.SEQK;
    this.runs = loaded.RUNS;
    this.targetCount = targetCount;
    this.residueCount = residueCount;
    this.sequenceLayout = parseSequenceLayout(this.seq);
  }

  entry(index) {
    if (index < 0 || index >= this.targetCount) throw new Error("target index out of range");
    const base = index * DIR_LENGTH;
    return {
      index,
      idOffset: u64(this.dirView, base, "id offset"),
      hotOffset: u64(this.dirView, base + 8, "HOT offset"),
      seqOffset: u64(this.dirView, base + 16, "sequence offset"),
      runOffset: u64(this.dirView, base + 24, "run offset"),
      idLength: this.dirView.getUint32(base + 32, true),
      numres: this.dirView.getUint32(base + 36, true),
      hotLength: this.dirView.getUint32(base + 40, true),
      seqLength: this.dirView.getUint32(base + 44, true),
      runLength: this.dirView.getUint32(base + 48, true),
      flags: this.dirView.getUint16(base + 54, true),
    };
  }

  id(entry) {
    return textDecoder.decode(this.ids.subarray(entry.idOffset, entry.idOffset + entry.idLength));
  }

  sequence(entry) {
    const bits = entry.flags & FLAG_SEQ7 ? 7 : entry.flags & FLAG_SEQ5 ? 5 : 0;
    if (!bits || entry.seqLength !== entry.numres) throw new Error("bad target sequence layout");
    const pool = bits === 5 ? this.sequenceLayout.five : this.sequenceLayout.seven;
    if (entry.seqOffset + entry.numres > pool.residues) throw new Error("sequence range out of bounds");
    const output = new Uint8Array(entry.numres);
    for (let position = 0; position < entry.numres; position += 1) {
      const absolute = entry.seqOffset + position;
      let code = 0;
      for (let plane = 0; plane < bits; plane += 1) {
        const byte = this.seq[pool.dataOffset + plane * pool.planeLength + (absolute >> 3)];
        code |= ((byte >> (absolute & 7)) & 1) << plane;
      }
      output[position] = code;
    }
    return output;
  }

  // Residue codes for rows of (pool offset, residues, bit width, output offset), the layout of the
  // shared Rust decoder (jmfs_decode_sequence_batch), read from this index's packed planes. The
  // WebGPU route needs host codes only for candidate targets, so the planes are not copied into
  // WASM memory.
  decodeSequenceRows(rows, outputLength) {
    const output = new Uint8Array(outputLength);
    for (let row = 0; row < rows.length; row += 4) {
      const [start, residues, bits, at] = [rows[row], rows[row + 1], rows[row + 2], rows[row + 3]];
      const pool = bits === 5 ? this.sequenceLayout.five : bits === 7 ? this.sequenceLayout.seven : null;
      if (!pool || at + residues > outputLength || start + residues > pool.residues) {
        throw new Error("bad target sequence row");
      }
      for (let position = 0; position < residues; position += 1) {
        const absolute = start + position;
        const byte = pool.dataOffset + Math.floor(absolute / 8);
        const bit = absolute % 8;
        let code = 0;
        for (let plane = 0; plane < bits; plane += 1) {
          code |= ((this.seq[byte + plane * pool.planeLength] >> bit) & 1) << plane;
        }
        output[at + position] = code;
      }
    }
    return output;
  }

  runRanges(entry) {
    if (!entry.runLength) return [[0, entry.numres]];
    if (entry.runOffset + entry.runLength > this.runs.length || entry.runLength % 4) {
      throw new Error("target RUNS range is invalid");
    }
    const view = new DataView(
      this.runs.buffer,
      this.runs.byteOffset + entry.runOffset,
      entry.runLength,
    );
    const markers = Array.from({ length: entry.runLength / 4 }, (_, index) =>
      view.getUint32(index * 4, true),
    );
    if (markers.length < 2) return [[0, entry.numres]];
    const ranges = [];
    for (let index = 0; index + 1 < markers.length; index += 1) {
      const begin = markers[index] === 0xffffffff ? 0 : markers[index] + 1;
      const end = markers[index + 1] === 0xffffffff ? 0 : Math.min(markers[index + 1] + 1, entry.numres);
      if (begin < end) ranges.push([begin, end]);
    }
    return ranges.length ? ranges : [[0, entry.numres]];
  }

  planChunk(start, maxResidues = 250000, maxTargets = 4096, maxHotBytes = 64 * 1024 * 1024,
    lastTarget = this.targetCount) {
    let end = start;
    let residues = 0;
    let hotBytes = 0;
    while (end < lastTarget && end - start < maxTargets) {
      const base = end * DIR_LENGTH;
      const numres = this.dirView.getUint32(base + 36, true);
      const hotLength = this.dirView.getUint32(base + 40, true);
      if (end > start && (residues + numres > maxResidues || hotBytes + hotLength > maxHotBytes)) break;
      residues += numres;
      hotBytes += hotLength;
      end += 1;
    }
    return { start, end, residues, hotBytes };
  }

  planListedChunk(targetRows, start, maxResidues = 250000, maxTargets = 4096,
    maxHotBytes = 64 * 1024 * 1024) {
    if (!(targetRows instanceof Uint32Array) && !Array.isArray(targetRows)) {
      throw new Error("listed target rows must be a Uint32Array or array");
    }
    if (!Number.isInteger(start) || start < 0 || start >= targetRows.length) {
      throw new Error("listed target cursor is out of range");
    }
    let end = start;
    let residues = 0;
    let hotBytes = 0;
    while (end < targetRows.length && end - start < maxTargets) {
      const target = Number(targetRows[end]);
      if (!Number.isInteger(target) || target < 0 || target >= this.targetCount
          || (end > 0 && target <= Number(targetRows[end - 1]))) {
        throw new Error("listed target rows must be unique, increasing database rows");
      }
      const entry = this.entry(target);
      if (end > start && (residues + entry.numres > maxResidues
          || hotBytes + entry.hotLength > maxHotBytes)) break;
      residues += entry.numres;
      hotBytes += entry.hotLength;
      end += 1;
    }
    return {
      start,
      end,
      residues,
      hotBytes,
      targetRows: Uint32Array.from(targetRows.slice(start, end)),
    };
  }

  async loadChunk(plan, wasm, packedSequence = null, decodeCoords = true) {
    if (plan.end <= plan.start) throw new Error("empty target chunk");
    if (!decodeCoords && this.seq) return this.loadDeviceChunk(plan);
    const entries = Array.from({ length: plan.end - plan.start }, (_, offset) => this.entry(plan.start + offset));
    let hotBegin = Number.POSITIVE_INFINITY;
    let hotEnd = 0;
    for (const entry of entries) {
      hotBegin = Math.min(hotBegin, entry.hotOffset);
      hotEnd = Math.max(hotEnd, entry.hotOffset + entry.hotLength);
    }
    const hotSection = this.sections.get("HOTC");
    const bytes = await this.source.read(hotSection.offset + hotBegin, hotEnd - hotBegin);
    const offsets = Uint32Array.from(entries, (entry) => entry.hotOffset - hotBegin);
    return this.loadEntries(plan, entries, wasm, packedSequence, decodeCoords, { bytes, offsets });
  }

  // Direct-GPU route for a contiguous chunk: per-target metadata is written straight from the
  // directory into typed arrays, and each target's record keeps only what the search reads on
  // every target (building a directory object, closures and views per target cost about 0.9 s
  // of CPU and garbage collection per Swiss-Prot search).
  async loadDeviceChunk(plan) {
    const view = this.dirView;
    const count = plan.end - plan.start;
    let hotBegin = Number.POSITIVE_INFINITY;
    let hotEnd = 0;
    for (let target = plan.start; target < plan.end; target += 1) {
      const base = target * DIR_LENGTH;
      const hotOffset = u64(view, base + 8, "HOT offset");
      hotBegin = Math.min(hotBegin, hotOffset);
      hotEnd = Math.max(hotEnd, hotOffset + view.getUint32(base + 40, true));
    }
    const hotSection = this.sections.get("HOTC");
    const hot = await this.source.read(hotSection.offset + hotBegin, hotEnd - hotBegin);
    const hotMetadata = new Uint32Array(count * 4);
    const sequenceMetadata = new Uint32Array(count * 4);
    const records = new Array(count);
    let coordOffset = 0;
    for (let row = 0; row < count; row += 1) {
      const target = plan.start + row;
      const base = target * DIR_LENGTH;
      const numres = view.getUint32(base + 36, true);
      const flags = view.getUint16(base + 54, true);
      if (!(flags & FLAG_CAD1)) throw new Error(`target ${target} lacks CAD1 geometry`);
      const bits = flags & FLAG_SEQ7 ? 7 : flags & FLAG_SEQ5 ? 5 : 0;
      const seqOffset = u64(view, base + 16, "sequence offset");
      if (!bits || view.getUint32(base + 44, true) !== numres || seqOffset > 0xffffffff) {
        throw new Error("bad target sequence layout");
      }
      const at = row * 4;
      hotMetadata[at] = u64(view, base + 8, "HOT offset") - hotBegin;
      hotMetadata[at + 1] = view.getUint32(base + 40, true);
      hotMetadata[at + 2] = numres;
      hotMetadata[at + 3] = coordOffset;
      sequenceMetadata[at] = seqOffset;
      sequenceMetadata[at + 1] = numres;
      sequenceMetadata[at + 2] = bits;
      sequenceMetadata[at + 3] = coordOffset;
      records[row] = new ChunkRecord(
        this, target, numres, coordOffset, view.getUint32(base + 48, true) === 0, sequenceMetadata, at,
      );
      coordOffset += numres;
    }
    const sequenceSlice = packedSequenceSlice(this.seq, this.sequenceLayout, sequenceMetadata);
    return {
      ...plan, hot, hotMetadata, coords: null, sequence: null, sequenceSlice, records,
    };
  }

  async loadListedChunk(plan, wasm, packedSequence = null, decodeCoords = true) {
    if (plan.end <= plan.start || plan.targetRows?.length !== plan.end - plan.start) {
      throw new Error("empty or inconsistent listed target chunk");
    }
    const entries = Array.from(plan.targetRows, (target) => this.entry(target));
    return this.loadEntries(plan, entries, wasm, packedSequence, decodeCoords);
  }

  async loadEntries(plan, entries, wasm, packedSequence = null, decodeCoords = true,
    loadedHot = null) {
    for (const entry of entries) {
      if (!(entry.flags & FLAG_CAD1)) throw new Error(`target ${entry.index} lacks CAD1 geometry`);
    }
    const { bytes: hot, offsets: hotOffsets } = loadedHot || await this.loadHotEntries(entries);
    const hotMetadata = new Uint32Array(entries.length * 4);
    const sequenceMetadata = new Uint32Array(entries.length * 4);
    let coordOffset = 0;
    entries.forEach((entry, row) => {
      const bits = entry.flags & FLAG_SEQ7 ? 7 : entry.flags & FLAG_SEQ5 ? 5 : 0;
      if (!bits || entry.seqLength !== entry.numres || entry.seqOffset > 0xffffffff) {
        throw new Error("bad target sequence layout");
      }
      hotMetadata.set([
        hotOffsets[row], entry.hotLength, entry.numres, coordOffset,
      ], row * 4);
      sequenceMetadata.set([entry.seqOffset, entry.numres, bits, coordOffset], row * 4);
      coordOffset += entry.numres;
    });
    const coords = decodeCoords ? wasm.decodeCad1Batch(hot, hotMetadata, plan.residues) : null;
    // The direct-GPU route (no host coordinates) reads residue codes from the packed bit planes
    // on the device; host codes are decoded later for candidate targets only.
    const sequenceSlice = decodeCoords || !this.seq
      ? null
      : packedSequenceSlice(this.seq, this.sequenceLayout, sequenceMetadata);
    const sequence = sequenceSlice
      ? null
      : packedSequence
        ? packedSequence.decodeBatch(sequenceMetadata, plan.residues)
        : new Uint8Array(plan.residues);
    const records = [];
    coordOffset = 0;
    for (const [row, entry] of entries.entries()) {
      if (sequence && !packedSequence) sequence.set(this.sequence(entry), coordOffset);
      const targetSequence = sequence
        ? sequence.subarray(coordOffset, coordOffset + entry.numres)
        : null;
      const index = this;
      records.push({
        targetIndex: entry.index,
        // Decoded on first use: only reported rows need the identifier.
        get id() { return index.id(entry); },
        numres: entry.numres,
        coordOffset,
        sequence: targetSequence,
        sequenceRow: sequenceMetadata.subarray(row * 4, row * 4 + 3),
        runs: this.runRanges(entry),
      });
      coordOffset += entry.numres;
    }
    return { ...plan, hot, hotMetadata, coords, sequence, sequenceSlice, records };
  }

  async loadHotEntries(entries) {
    const hotSection = this.sections.get("HOTC");
    const offsets = new Uint32Array(entries.length);
    let compactBytes = 0;
    const ranges = entries.map((entry, row) => {
      if (!entry.hotLength || compactBytes + entry.hotLength > 0xffffffff) {
        throw new Error("target CAD1 chunk exceeds browser offset range");
      }
      offsets[row] = compactBytes;
      compactBytes += entry.hotLength;
      return {
        row,
        start: entry.hotOffset,
        end: entry.hotOffset + entry.hotLength,
      };
    }).sort((left, right) => left.start - right.start || left.end - right.end);
    const blocks = [];
    for (const range of ranges) {
      const last = blocks.at(-1);
      if (last && range.start >= last.end
          && range.start - last.end <= RANGE_COALESCE_GAP
          && range.end - last.start <= RANGE_COALESCE_BYTES) {
        last.end = range.end;
        last.members.push(range);
      } else {
        blocks.push({ start: range.start, end: range.end, members: [range] });
      }
    }
    const payloads = await mapConcurrent(blocks, RANGE_READ_CONCURRENCY, (block) =>
      this.source.read(hotSection.offset + block.start, block.end - block.start));
    const bytes = new Uint8Array(compactBytes);
    blocks.forEach((block, blockIndex) => {
      const payload = payloads[blockIndex];
      for (const member of block.members) {
        const encoded = payload.subarray(member.start - block.start, member.end - block.start);
        if (encoded.length !== entries[member.row].hotLength) throw new Error("short CAD1 target range");
        bytes.set(encoded, offsets[member.row]);
      }
    });
    return { bytes, offsets };
  }
}

async function mapConcurrent(items, limit, operation) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

// Byte ranges of the packed SEQK bit planes that hold the residues of one chunk, laid out pool by
// pool (5-bit, then 7-bit) and plane by plane, with the per-target (pool offset, bit width) rows
// the device decoder needs. Bit k of residue a in a pool is bit (a & 7) of plane k's byte a / 8.
export function packedSequenceSlice(seq, layout, sequenceMetadata) {
  const records = sequenceMetadata.length / 4;
  const span = { 5: [Infinity, 0], 7: [Infinity, 0] };
  const meta = new Uint32Array(records * 2);
  for (let row = 0; row < records; row += 1) {
    const offset = sequenceMetadata[row * 4];
    const length = sequenceMetadata[row * 4 + 1];
    const bits = sequenceMetadata[row * 4 + 2];
    const range = span[bits];
    range[0] = Math.min(range[0], offset);
    range[1] = Math.max(range[1], offset + length);
    meta[row * 2] = offset;
    meta[row * 2 + 1] = bits;
  }
  const params = new Uint32Array(6);
  const parts = [];
  let base = 0;
  for (const [slot, bits] of [[0, 5], [1, 7]]) {
    const [lo, hi] = span[bits];
    if (!(hi > lo)) continue;
    const pool = bits === 5 ? layout.five : layout.seven;
    const byteLo = Math.floor(lo / 8);
    const byteHi = Math.ceil(hi / 8);
    const stride = byteHi - byteLo;
    params.set([base, stride, byteLo * 8], slot * 3);
    for (let plane = 0; plane < bits; plane += 1) {
      const start = pool.dataOffset + plane * pool.planeLength + byteLo;
      parts.push(seq.subarray(start, start + stride));
    }
    base += bits * stride;
  }
  const bytes = new Uint8Array(Math.max(4, Math.ceil(base / 4) * 4));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return { bytes, meta, params };
}

function parseSequenceLayout(bytes) {
  if (bytes.length < 64 || textDecoder.decode(bytes.subarray(0, 8)) !== "JMSEQK3\0") {
    throw new Error("unsupported JMFSGEOM sequence layout");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== 1 || view.getUint32(12, true) !== 64) {
    throw new Error("unsupported sequence pool version");
  }
  const pool = (residueAt, dataAt, lengthAt, bits) => {
    const residues = u64(view, residueAt, "sequence residues");
    const dataOffset = u64(view, dataAt, "sequence data offset");
    const dataLength = u64(view, lengthAt, "sequence data length");
    const planeLength = Math.ceil(residues / 8);
    if (dataLength !== planeLength * bits || dataOffset + dataLength > bytes.length) {
      throw new Error("sequence pool is out of bounds");
    }
    return { residues, dataOffset, dataLength, planeLength, bits };
  };
  return {
    five: pool(16, 32, 40, 5),
    seven: pool(24, 48, 56, 7),
  };
}
