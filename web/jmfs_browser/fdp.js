import { HttpRangeSource } from "./jmfs_index.js?v=30";

const CATALOG_MAGIC = "JMFSRFC1";
const CATALOG_VERSION = 1;
const CATALOG_HEADER_BYTES = 256;
const CATALOG_FOOTER_BYTES = 8 + 5 * 32;
const CATALOG_FOOTER_MAGIC = "JMFSRFE1";
const FDP_BLOCK_ROWS = 1024;
const POSTING_GAP_BYTES = 4 * 1024 * 1024;
const POSTING_BLOCK_BYTES = 8 * 1024 * 1024;
const MAX_POSTING_GETS = 4096;
const MAX_POSTING_RESPONSE_BYTES = 256 * 1024 * 1024;
const FETCH_CONCURRENCY = 6;
const PROTEIN_ALPHABET = "ARNDCQEGHILKMFPSTWYV";
const decoder = new TextDecoder();

export async function remoteFdpCandidates({
  catalogUrl,
  postingsUrl = "",
  index,
  query,
  core,
  chemistryMode,
  distanceTolerance = 0.5,
  angleTolerance = 5,
  minEdges = 1,
  progress = () => {},
  shouldCancel = () => false,
  catalog: suppliedCatalog = null,
}) {
  const started = performance.now();
  if (query.segments.length < 2 || chemistryMode === "none") {
    return { rows: null, reason: "FDP needs a discontinuous motif with chemistry anchors" };
  }
  progress("Preparing FoldDisco prefilter (FDP) query hashes");
  throwIfCancelled(shouldCancel);
  const anchors = fdpAnchors(query, core, chemistryMode);
  if (anchors.aminoAcids.length < 2) {
    return { rows: null, reason: "FDP needs at least two protein chemistry anchors" };
  }
  const groups = core.fdpQueryHashes(
    anchors.aminoAcids,
    anchors.atoms,
    anchors.allowedMasks,
    Number(distanceTolerance),
    Number(angleTolerance),
  );
  const requiredEdges = Math.max(1, Math.trunc(Number(minEdges) || 1));
  if (!groups.length || requiredEdges > groups.length) {
    return { rows: null, reason: "FDP found no usable inter-anchor edge" };
  }

  progress("Opening the remote FDP catalog");
  const catalog = suppliedCatalog
    || await RemoteFdpCatalog.open(catalogUrl, index, postingsUrl);
  throwIfCancelled(shouldCancel);
  const uniqueHashes = Array.from(new Set(groups.flatMap((group) => Array.from(group))));
  progress(`Reading ${uniqueHashes.length.toLocaleString()} remote FDP hash ranges`);
  const ranges = await catalog.postingRanges(uniqueHashes);
  const blocks = coalescePostingRanges(ranges);
  const plannedResponseBytes = blocks.reduce(
    (total, block) => total + block.end - block.start,
    0,
  );
  if (blocks.length > MAX_POSTING_GETS || plannedResponseBytes > MAX_POSTING_RESPONSE_BYTES) {
    return {
      rows: null,
      reason: `FDP proposal is too broad for a browser (${blocks.length.toLocaleString()} reads, `
        + `${formatBytes(plannedResponseBytes)}); using the complete exact scan`,
      stats: {
        fdpHashGroups: groups.length,
        fdpUniqueHashes: uniqueHashes.length,
        fdpPostingGets: 0,
        fdpResponseBytes: 0,
        fdpMs: performance.now() - started,
      },
      identity: catalog.identity,
    };
  }
  const payloads = await mapConcurrent(
    blocks,
    FETCH_CONCURRENCY,
    (block) => {
      throwIfCancelled(shouldCancel);
      return catalog.postings.read(block.start, block.end - block.start);
    },
  );
  const postings = new Map();
  let responseBytes = 0;
  blocks.forEach((block, blockIndex) => {
    const payload = payloads[blockIndex];
    responseBytes += payload.length;
    for (const member of block.members) {
      if (member.end > catalog.header.postingsSize) {
        throw new Error("FDP posting range exceeds the release-pinned postings object");
      }
      postings.set(
        member.hash,
        decodePosting(
          payload.subarray(member.start - block.start, member.end - block.start),
          index.targetCount,
        ),
      );
    }
  });
  progress("Selecting FDP candidate proteins");
  throwIfCancelled(shouldCancel);
  const rows = selectCandidates(groups, postings, requiredEdges);
  return {
    rows,
    reason: "",
    stats: {
      fdpCandidates: rows.length,
      fdpHashGroups: groups.length,
      fdpUniqueHashes: uniqueHashes.length,
      fdpPostingGets: blocks.length,
      fdpResponseBytes: responseBytes,
      fdpMs: performance.now() - started,
    },
    identity: catalog.identity,
  };
}

export class RemoteFdpCatalog {
  static async open(url, index, postingsOverride = "") {
    const resolvedUrl = new URL(url, globalThis.location?.href).href;
    if (!/^https?:/i.test(resolvedUrl)) throw new Error("Remote FDP catalog must use HTTP or HTTPS");
    const source = new HttpRangeSource(resolvedUrl, 256 * 1024 * 1024);
    const bytes = await source.read(0, CATALOG_HEADER_BYTES);
    const header = decodeCatalogHeader(bytes);
    if (source.size != null && header.footerOffset + CATALOG_FOOTER_BYTES !== source.size) {
      throw new Error("Remote FDP catalog size does not match its header");
    }
    if (header.targetCount !== index.targetCount) {
      throw new Error(
        `FDP catalog has ${header.targetCount.toLocaleString()} targets; `
        + `JMFSGEOM has ${index.targetCount.toLocaleString()}`,
      );
    }
    const orderHash = await targetOrderSha256(index);
    if (orderHash !== header.targetOrderSha256) {
      throw new Error("FDP catalog target order does not match this JMFSGEOM index");
    }
    const [directory, metadataBytes, footer] = await Promise.all([
      source.read(header.fdpDirectory.offset, header.fdpDirectory.length),
      source.read(header.metadata.offset, header.metadata.length),
      source.read(header.footerOffset, CATALOG_FOOTER_BYTES),
    ]);
    if (directory.length !== header.fdpBlockCount * 8) {
      throw new Error("Remote FDP directory length is inconsistent");
    }
    await verifyCatalogParts(directory, metadataBytes, footer);
    const metadata = parseMetadata(metadataBytes);
    const postingsValue = postingsOverride || metadata.folddisco_postings_url;
    if (!postingsValue) throw new Error("Remote FDP catalog does not name its postings URL");
    if (metadata.target_count && Number(metadata.target_count) !== header.targetCount) {
      throw new Error("Remote FDP metadata target count disagrees with its header");
    }
    if (metadata.target_order_sha256 && metadata.target_order_sha256 !== orderHash) {
      throw new Error("Remote FDP metadata target order hash disagrees with its header");
    }
    if (metadata.folddisco_postings_bytes
        && Number(metadata.folddisco_postings_bytes) !== header.postingsSize) {
      throw new Error("Remote FDP postings size disagrees with its header");
    }
    const postingsUrl = new URL(postingsValue, resolvedUrl).href;
    if (!/^https?:/i.test(postingsUrl)) {
      throw new Error("Remote FDP postings must use HTTP or HTTPS");
    }
    const postings = new HttpRangeSource(postingsUrl);
    postings.size = header.postingsSize;
    return new RemoteFdpCatalog(source, postings, header, directory, {
      catalogUrl: resolvedUrl,
      postingsUrl,
      release: metadata.release || "",
      targetOrderSha256: orderHash,
      folddiscoOffsetSha256: metadata.folddisco_offset_sha256 || "",
      postingsBytes: header.postingsSize,
      postingsEtag: metadata.folddisco_postings_etag || "",
      fdpDataSha256: hex(footer.subarray(8 + 3 * 32, 8 + 4 * 32)),
    });
  }

  constructor(source, postings, header, directory, identity) {
    this.source = source;
    this.postings = postings;
    this.header = header;
    this.directory = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    this.identity = identity;
  }

  async postingRanges(hashes) {
    const byBlock = new Map();
    for (const hash of hashes) {
      const block = this.blockForHash(hash);
      if (block == null) continue;
      if (!byBlock.has(block)) byBlock.set(block, []);
      byBlock.get(block).push(hash);
    }
    const blocks = Array.from(byBlock.keys()).sort((left, right) => left - right);
    const payloads = await mapConcurrent(blocks, FETCH_CONCURRENCY, (block) => {
      const begin = this.directory.getUint32(block * 8 + 4, true);
      const end = block + 1 < this.header.fdpBlockCount
        ? this.directory.getUint32((block + 1) * 8 + 4, true)
        : this.header.fdpData.length;
      if (begin > end || end > this.header.fdpData.length) {
        throw new Error("Remote FDP catalog block is outside its data section");
      }
      return this.source.read(this.header.fdpData.offset + begin, end - begin);
    });
    const output = new Map();
    blocks.forEach((block, index) => {
      const wanted = new Set(byBlock.get(block));
      const entries = Math.min(
        FDP_BLOCK_ROWS,
        this.header.fdpEntryCount - block * FDP_BLOCK_ROWS,
      );
      for (const [hash, range] of decodePostingBlock(payloads[index], entries, wanted)) {
        output.set(hash, range);
      }
    });
    return output;
  }

  blockForHash(hash) {
    let left = 0;
    let right = this.header.fdpBlockCount;
    while (left < right) {
      const middle = left + Math.floor((right - left) / 2);
      if (this.directory.getUint32(middle * 8, true) <= hash) left = middle + 1;
      else right = middle;
    }
    return left ? left - 1 : null;
  }
}

function decodeCatalogHeader(bytes) {
  if (decoder.decode(bytes.subarray(0, 8)) !== CATALOG_MAGIC) {
    throw new Error("Not a JMFS remote FDP catalog");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== CATALOG_VERSION
      || view.getUint32(12, true) !== CATALOG_HEADER_BYTES) {
    throw new Error("Unsupported remote FDP catalog version");
  }
  const number64 = (offset, label) => {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds browser range`);
    return Number(value);
  };
  const bounds = (offset, label) => ({
    offset: number64(offset, `${label} offset`),
    length: number64(offset + 8, `${label} length`),
  });
  const header = {
    targetCount: number64(16, "FDP target count"),
    postingsSize: number64(32, "FDP postings size"),
    fdpEntryCount: number64(48, "FDP entry count"),
    fdpBlockCount: number64(56, "FDP block count"),
    fdpDirectory: bounds(96, "FDP directory"),
    fdpData: bounds(112, "FDP data"),
    metadata: bounds(128, "FDP metadata"),
    footerOffset: number64(144, "FDP footer"),
    targetOrderSha256: hex(bytes.subarray(152, 184)),
  };
  if (!header.targetCount || !header.postingsSize
      || header.fdpBlockCount !== Math.ceil(header.fdpEntryCount / FDP_BLOCK_ROWS)
      || header.fdpDirectory.length !== header.fdpBlockCount * 8
      || !orderedSections([
        header.fdpDirectory,
        header.fdpData,
        header.metadata,
        { offset: header.footerOffset, length: CATALOG_FOOTER_BYTES },
      ])) {
    throw new Error("Remote FDP catalog header is inconsistent");
  }
  return header;
}

function parseMetadata(bytes) {
  const output = {};
  for (const line of decoder.decode(bytes).split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab > 0) output[line.slice(0, tab)] = line.slice(tab + 1);
  }
  return output;
}

async function targetOrderSha256(index) {
  if (!index.targetOrderSha256Promise) {
    index.targetOrderSha256Promise = (async () => {
      const bytes = new Uint8Array(index.ids.length + index.targetCount);
      let cursor = 0;
      for (let row = 0; row < index.targetCount; row += 1) {
        const entry = index.entry(row);
        const id = index.ids.subarray(entry.idOffset, entry.idOffset + entry.idLength);
        bytes.set(id, cursor);
        cursor += id.length;
        bytes[cursor] = 10;
        cursor += 1;
      }
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return hex(new Uint8Array(digest));
    })();
  }
  return index.targetOrderSha256Promise;
}

function decodePostingBlock(bytes, entries, wanted) {
  if (!entries || bytes.length < 12) throw new Error("Remote FDP catalog block is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let hash = view.getUint32(0, true);
  let postingOffset = safeBigUint64(view, 4, "FDP posting offset");
  let cursor = 12;
  const output = new Map();
  for (let row = 0; row < entries; row += 1) {
    if (row) {
      const decoded = readUleb(bytes, cursor);
      cursor = decoded.cursor;
      if (decoded.value > 0xffffffff - hash) throw new Error("Remote FDP hash delta overflows u32");
      hash += decoded.value;
    }
    const decoded = readUleb(bytes, cursor);
    cursor = decoded.cursor;
    const length = decoded.value;
    if (wanted.has(hash)) output.set(hash, [postingOffset, postingOffset + length]);
    postingOffset += length;
    if (!Number.isSafeInteger(postingOffset)) throw new Error("Remote FDP posting offset overflows browser range");
  }
  if (cursor !== bytes.length) throw new Error("Remote FDP catalog block has trailing bytes");
  return output;
}

function readUleb(bytes, begin) {
  let cursor = begin;
  let value = 0;
  let multiplier = 1;
  for (let count = 0; count < 10; count += 1) {
    if (cursor >= bytes.length) throw new Error("Remote FDP varint is truncated");
    const byte = bytes[cursor];
    cursor += 1;
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) throw new Error("Remote FDP varint exceeds browser range");
    if (!(byte & 0x80)) return { value, cursor };
    multiplier *= 128;
  }
  throw new Error("Remote FDP varint is too long");
}

function safeBigUint64(view, offset, label) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds browser range`);
  return Number(value);
}

function coalescePostingRanges(ranges) {
  const ordered = Array.from(ranges, ([hash, [start, end]]) => ({ hash, start, end }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const blocks = [];
  for (const range of ordered) {
    const last = blocks.at(-1);
    if (last && range.start - last.end <= POSTING_GAP_BYTES
        && range.end - last.start <= POSTING_BLOCK_BYTES) {
      last.end = Math.max(last.end, range.end);
      last.members.push(range);
    } else {
      blocks.push({ start: range.start, end: range.end, members: [range] });
    }
  }
  return blocks;
}

function decodePosting(bytes, targetCount) {
  const rows = [];
  let previous = 0;
  let value = 0;
  let shift = 0;
  let first = true;
  for (const byte of bytes) {
    value += (byte & 0x7f) * 2 ** shift;
    if (!Number.isSafeInteger(value) || shift >= 32) throw new Error("FDP posting varint exceeds u32");
    if (byte & 0x80) { shift += 7; continue; }
    const row = first ? value : previous + value;
    if (!Number.isSafeInteger(row) || row >= targetCount || (!first && row < previous)) {
      throw new Error(`FDP posting target ${row} is invalid`);
    }
    rows.push(row);
    previous = row;
    value = 0;
    shift = 0;
    first = false;
  }
  if (shift) throw new Error("FDP posting varint is truncated");
  return Uint32Array.from(rows);
}

// Posting lists hold sorted target rows. A group's rows are the union of its hashes' lists, and
// a target is a candidate when at least minEdges groups contain it. Merging the sorted lists
// needs memory for the posting rows only; two arrays over every index target took 430 MB for
// AFDB50 (53.7 M targets) against 1.9 M candidate rows.
function selectCandidates(groups, postings, minEdges) {
  const groupRows = groups.map((hashes) => mergeSortedUnique(
    Array.from(hashes, (hash) => postings.get(hash)).filter((rows) => rows?.length),
  ));
  if (minEdges <= 1) return mergeSortedUnique(groupRows);
  let total = 0;
  for (const rows of groupRows) total += rows.length;
  const all = new Uint32Array(total);
  let at = 0;
  for (const rows of groupRows) {
    all.set(rows, at);
    at += rows.length;
  }
  all.sort();
  const selected = [];
  for (let begin = 0; begin < all.length;) {
    let end = begin + 1;
    while (end < all.length && all[end] === all[begin]) end += 1;
    if (end - begin >= minEdges) selected.push(all[begin]);
    begin = end;
  }
  return Uint32Array.from(selected);
}

// Union of sorted row lists without duplicates, merged pairwise.
function mergeSortedUnique(lists) {
  if (!lists.length) return new Uint32Array();
  let level = lists.map((rows) => dedupeSorted(rows));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? mergeTwo(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

function dedupeSorted(rows) {
  let used = 0;
  const output = new Uint32Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    if (!used || output[used - 1] !== rows[i]) output[used++] = rows[i];
  }
  return output.subarray(0, used);
}

function mergeTwo(left, right) {
  const output = new Uint32Array(left.length + right.length);
  let i = 0;
  let j = 0;
  let used = 0;
  while (i < left.length || j < right.length) {
    const value = j >= right.length || (i < left.length && left[i] <= right[j]) ? left[i++] : right[j++];
    if (!used || output[used - 1] !== value) output[used++] = value;
  }
  return output.subarray(0, used);
}

function fdpAnchors(query, core, chemistryMode) {
  const aminoAcids = [];
  const atomValues = [];
  const allowedMasks = [];
  for (const segment of query.segments) {
    for (const offset of segment.chemistryOffsets) {
      const queryPosition = segment.qStart + offset;
      const label = query.labels[queryPosition];
      const residue = query.sourceResidues?.[queryPosition];
      if (!residue) throw new Error(`FDP backbone atoms were not found for ${label.chain}${label.resSeq}`);
      const aminoAcid = fdpCode(core.sequenceLetter(query.sequence[queryPosition]));
      if (aminoAcid < 0) throw new Error("FDP currently supports protein chemistry anchors only");
      const table = core.chemistryTable([query.sequence[queryPosition]], chemistryMode);
      let mask = 0;
      for (let code = 0; code < 256; code += 1) {
        if (!table[code]) continue;
        const allowed = fdpCode(core.sequenceLetter(code));
        if (allowed >= 0) mask |= 1 << allowed;
      }
      if (!mask) throw new Error(`FDP anchor ${label.chain}${label.resSeq} has no protein chemistry`);
      for (const name of ["N", "CA"]) {
        const atom = residue.atoms.get(name);
        if (!atom) throw new Error(`FDP needs the ${name} atom for ${label.chain}${label.resSeq}`);
        atomValues.push(...atom);
      }
      const c = residue.atoms.get("C");
      const cb = residue.atoms.get("CB");
      if (!c && !cb) throw new Error(`FDP needs C or CB for ${label.chain}${label.resSeq}`);
      atomValues.push(...(c || [NaN, NaN, NaN]));
      atomValues.push(...(cb || [NaN, NaN, NaN]));
      aminoAcids.push(aminoAcid);
      allowedMasks.push(mask >>> 0);
    }
  }
  return {
    aminoAcids: Uint32Array.from(aminoAcids),
    atoms: Float32Array.from(atomValues),
    allowedMasks: Uint32Array.from(allowedMasks),
  };
}

function fdpCode(letter) {
  const normalized = letter === "U" ? "C" : letter === "O" ? "K" : letter;
  return PROTEIN_ALPHABET.indexOf(normalized);
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

async function verifyCatalogParts(directory, metadata, footer) {
  if (footer.length !== CATALOG_FOOTER_BYTES
      || decoder.decode(footer.subarray(0, 8)) !== CATALOG_FOOTER_MAGIC) {
    throw new Error("Remote FDP catalog footer is invalid");
  }
  for (const [bytes, checksumIndex, label] of [
    [directory, 2, "directory"],
    [metadata, 4, "metadata"],
  ]) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const expected = footer.subarray(8 + checksumIndex * 32, 8 + (checksumIndex + 1) * 32);
    if (hex(digest) !== hex(expected)) throw new Error(`Remote FDP catalog ${label} checksum mismatch`);
  }
}

function orderedSections(sections) {
  let previousEnd = CATALOG_HEADER_BYTES;
  for (const section of sections) {
    if (!Number.isSafeInteger(section.offset) || !Number.isSafeInteger(section.length)
        || section.offset < previousEnd || section.length < 0
        || section.offset + section.length > Number.MAX_SAFE_INTEGER) return false;
    previousEnd = section.offset + section.length;
  }
  return true;
}

function throwIfCancelled(shouldCancel) {
  if (shouldCancel()) throw new DOMException("Search cancelled", "AbortError");
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
