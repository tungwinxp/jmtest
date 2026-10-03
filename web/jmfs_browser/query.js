export function parsePdb(text, core) {
  const residues = [];
  const byKey = new Map();
  let sourceRun = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.slice(0, 6).trim() === "TER") {
      sourceRun++;
      continue;
    }
    if (!(line.startsWith("ATOM  ") || line.startsWith("HETATM")) || line.length < 54) continue;
    const alternate = line.slice(16, 17);
    if (!(alternate === " " || alternate === "A" || alternate === ".")) continue;
    const atom = line.slice(12, 16).trim().replace("*", "'");
    const resName = line.slice(17, 20).trim().toUpperCase();
    const chain = line.slice(21, 22).trim() || "_";
    const resSeq = Number.parseInt(line.slice(22, 26).trim(), 10);
    const insertion = line.slice(26, 27) || " ";
    const xyz = [30, 38, 46].map((offset) => Number.parseFloat(line.slice(offset, offset + 8)));
    if (!Number.isInteger(resSeq) || xyz.some((value) => !Number.isFinite(value))) continue;
    const bFactor = Number.parseFloat(line.slice(60, 66));
    const key = `${sourceRun}\0${chain}\0${resSeq}\0${insertion}\0${resName}`;
    let residue = byKey.get(key);
    if (!residue) {
      residue = { sourceRun, chain, resSeq, insertion, resName, atoms: new Map(), bFactors: new Map() };
      byKey.set(key, residue);
      residues.push(residue);
    }
    if (!residue.atoms.has(atom)) {
      residue.atoms.set(atom, xyz);
      residue.bFactors.set(atom, Number.isFinite(bFactor) ? bFactor : 0);
    }
  }
  const anchors = [];
  for (const residue of residues) {
    const protein = residue.atoms.has("CA") && !residue.atoms.has("C4'");
    const anchor = protein ? residue.atoms.get("CA") : residue.atoms.get("C4'");
    if (!anchor) continue;
    anchors.push({
      sourceRun: residue.sourceRun,
      chain: residue.chain,
      resSeq: residue.resSeq,
      insertion: residue.insertion,
      resName: residue.resName,
      coord: anchor,
      code: core.residueCode(residue.resName, protein),
      atoms: residue.atoms,
      bFactors: residue.bFactors,
    });
  }
  if (!anchors.length) throw new Error("Query PDB has no protein CA or nucleotide C4' anchors");
  return anchors;
}

export function prepareQuery(pdbText, motifText, chemistryText = "", core) {
  if (!core) throw new Error("The shared JMFS Rust core is required");
  const residues = parsePdb(pdbText, core);
  const sourceRuns = core.querySourceRuns(residues);
  const groups = parseSelection(motifText);
  if (!groups.length) throw new Error("Choose at least one motif segment");
  const selected = [];
  const selectedRuns = [];
  const segments = [];
  const selectedByLabel = new Map();
  for (const group of groups) {
    let qStart = selected.length;
    let previousIndex = null;
    for (const selector of group) {
      const index = residues.findIndex(
        (residue) => residue.chain === selector.chain && residue.resSeq === selector.resSeq,
      );
      if (index < 0) throw new Error(`Query residue ${selector.chain}${selector.resSeq} was not found`);
      if (previousIndex != null && (index !== previousIndex + 1 || sourceRuns[index] !== sourceRuns[previousIndex])) {
        segments.push({ qStart, length: selected.length - qStart });
        qStart = selected.length;
      }
      const residue = residues[index];
      selectedByLabel.set(`${residue.chain}\0${residue.resSeq}`, selected.length);
      selected.push(residue);
      selectedRuns.push(sourceRuns[index]);
      previousIndex = index;
    }
    const length = selected.length - qStart;
    if (!length) throw new Error("Motif contains an empty segment");
    segments.push({ qStart, length });
  }
  const chemistryPositions = new Set();
  if (chemistryText.trim()) {
    for (const group of parseSelection(chemistryText)) {
      for (const selector of group) {
        const index = selectedByLabel.get(`${selector.chain}\0${selector.resSeq}`);
        if (index == null) throw new Error(`Chemistry residue ${selector.chain}${selector.resSeq} is not in the motif`);
        chemistryPositions.add(index);
      }
    }
  } else {
    for (let index = 0; index < selected.length; index += 1) chemistryPositions.add(index);
  }
  const coords = new Float32Array(selected.length * 3);
  const sequence = new Uint8Array(selected.length);
  selected.forEach((residue, index) => {
    coords.set(residue.coord.map(indexCoordinate), index * 3);
    sequence[index] = residue.code;
  });
  for (const segment of segments) {
    segment.coords = coords.slice(segment.qStart * 3, (segment.qStart + segment.length) * 3);
    segment.centroid = centroid(segment.coords);
    segment.centered = centerPoints(segment.coords);
    segment.norm = squaredNorm(segment.centered);
    segment.chemistryOffsets = [];
    for (let offset = 0; offset < segment.length; offset += 1) {
      if (chemistryPositions.has(segment.qStart + offset)) segment.chemistryOffsets.push(offset);
    }
  }
  return {
    coords,
    sequence,
    sourceRuns: Uint32Array.from(selectedRuns),
    labels: selected.map(({ chain, resSeq, insertion, resName }) => ({ chain, resSeq, insertion, resName })),
    sourceResidues: selected,
    segments,
    totalLength: selected.length,
    motif: motifText.trim(),
    chemistry: chemistryText.trim(),
  };
}

export function centroid(flat) {
  const center = [0, 0, 0];
  const points = flat.length / 3;
  for (let index = 0; index < flat.length; index += 3) {
    center[0] += flat[index];
    center[1] += flat[index + 1];
    center[2] += flat[index + 2];
  }
  return center.map((value) => value / points);
}

export function centerPoints(flat) {
  const center = centroid(flat);
  const output = new Float32Array(flat.length);
  for (let index = 0; index < flat.length; index += 3) {
    output[index] = flat[index] - center[0];
    output[index + 1] = flat[index + 1] - center[1];
    output[index + 2] = flat[index + 2] - center[2];
  }
  return output;
}

function squaredNorm(flat) {
  let sum = 0;
  for (const value of flat) sum += value * value;
  return sum;
}

function parseSelection(text) {
  const groups = [];
  for (const raw of text.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const match = token.match(/^(.+?)(-?\d+)(?:-(-?\d+))?$/);
    if (!match) throw new Error(`Bad motif token: ${token}`);
    const chain = match[1];
    const begin = Number(match[2]);
    const end = Number(match[3] ?? match[2]);
    const step = begin <= end ? 1 : -1;
    const group = [];
    for (let resSeq = begin; ; resSeq += step) {
      group.push({ chain, resSeq });
      if (resSeq === end) break;
      if (group.length > 10000) throw new Error(`Motif range is too long: ${token}`);
    }
    groups.push(group);
  }
  return groups;
}

// The native parser stores query coordinates as index coordinates: integer milliangstroms
// (rounded half away from zero), then `milli as f32 * 0.001` as in cad1_core.rs. Parsing the
// PDB decimal straight to float32 differed by one float32 step on some atoms and moved RMSDs by
// up to 1.2e-6 A (a self-match gave 8.5e-7 A instead of 4e-15 A).
const MILLI = Math.fround(0.001);
function indexCoordinate(value) {
  const scaled = value * 1000;
  const milli = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return Math.fround(Math.fround(milli) * MILLI);
}
