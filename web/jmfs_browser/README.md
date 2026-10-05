# JMFS browser search

This directory is the zero-install browser front end for the current
`JMFSGEOM` v5 search index. On macOS, Chrome implements WebGPU over Metal; on
other supported systems the browser may use Direct3D 12 or Vulkan. The shared
Rust `wgpu` runner owns the WebGPU proposal stages and compiles to both native
code and WebAssembly. The same crate owns exact search logic.

## One scientific implementation

The browser is not a JavaScript rewrite of JMFS. Native JMFS and
`jmfs-web-core` compile the same Rust modules for:

- canonical CAD1 coordinate decoding;
- protein/RNA/DNA residue and reduced-chemistry rules;
- FoldDisco-compatible FDP query geometry and hashes;
- observed-count seed planning, overlap and centroid rules, and predicted
  partner bounds; and
- FP64 local, seed-pair, and complete-motif verification.

JavaScript is limited to PDB selection, bounded file/HTTP reads, one worker,
checkpoint orchestration, typed-array adaptation, and TSV formatting. The Rust
runner owns adapter/device setup, WGSL, pipelines, buffers, dispatch, regrouping,
readback, and cancellation for CAD1 decode, chemistry, local-fit, and generic
multi-segment proposals. Every reported hit is decoded and verified by
Rust/WASM; a shader cannot accept a hit.

Browser GPU performance work belongs in this shared runner. Chromium translates
WebGPU to Metal on Apple hardware, while the same WGSL remains portable to other
browser GPU backends. Scientific rules and final acceptance belong in the
shared Rust core so the WebGPU and CPU-fallback routes cannot silently drift.

The structural-search selector defaults to non-approximate search. Approximate
CPU requests use the shared single, spacing, or anchor plan. Anchor selection
samples at most 4,096 evenly spaced selected targets, read in bounded chunks.
WebGPU uses the shared spacing plan and reports a non-approximate fallback when
that plan is unavailable. Original query labels and physical runs determine
spacing eligibility. Chemistry selection remains independent. Direct typed-array
queries must supply `sourceRuns`; missing run metadata causes an explicit spacing
fallback. PDB `TER` records preserve separate physical runs, including repeated
labels within the same chain. A written motif range splits at an original run
break. Position selectors keep the existing first-match rule for repeated
chain/residue labels. Indexes created by a reader that discarded TER must be rebuilt
from the source PDB to recover the missing breaks.

Worker requests accept `approx: "auto"`, `"single"`, `"spacing"`, `"anchor"`, or
an object with `mode`, `spacingSlack`, `spacingBudget`, `maxLocalGap`,
`anchorScale`, `partnerRadiusScale`, `maxAnchorRate`, `probeScale`, and `probeCap`.
Omitting `approx` or using `"off"` preserves the default. The result reports
`structuralMode` and `approxFallbackReason`; checkpoints include these request
options. Approximation may reduce recall, while every reported placement still
passes shared FP64 and chemistry acceptance. FoldDisco selection has its own
recall restriction.

Approximate checkpoints also record the resolved executor. A device error during
an approximate request fails that request; it does not combine results from
different approximate CPU and GPU plans. Startup may still select CPU in auto
mode. Non-approximate requests keep the existing fallback behavior.

## The Colab form as a website

The landing page opens the workbench. There is no on-device language model, and the page
never contacts a program on the visitor's computer, so the browser shows no local-network
permission prompt. Outside assistants can prepare a search through a link; see
"Assistants (ChatGPT, Codex)" below.

The workbench opens independently of service-worker readiness. Opening it does not compile
search WASM or probe a GPU adapter; the search core is prefetched while idle and Search
initializes its executor on demand. A Web Lock permits only one JMFS compute tab per origin
and browser profile. It does not control other applications or profiles. The service worker
only finishes index downloads that continue after the page closes; it adds no isolation
headers. Run the input and range checks with `npm test`.

Uploaded structures, motif selections and sequences stay local. A prepared-search link that
names an enzyme sends its name, organism or accession to the reference services, and a PDB
ID is fetched from RCSB. Named references use reviewed UniProt active-site annotations,
verified AlphaFold sequence/numbering and coordinates, and M-CSA evidence when available.
A transferred M-CSA annotation is not relabeled as a reference for the query organism.
Geometry from AlphaFold is a prediction, and a similar backbone does not establish catalysis.

Remote index ranges are saved in versioned Cache Storage keyed by object ETag and
byte interval. Reopening reuses downloaded ranges, with a HEAD request to check
the object version; an uncached interval still needs a download. Locally added
indexes are copied to OPFS and restored on reopening. No full remote index is
eagerly downloaded. Clearing site data removes caches; storage quota or browser
eviction can prevent retention.

Custom inputs accept PDB or mmCIF uploads, or a legacy/extended PDB ID and author
chain. The PDB-ID downloader uses mmCIF so it is ready for extended IDs without
truncating them. Author residue selectors remain distinct from RCSB label selectors.

`colab.html` is the zero-install version of the Colab form. It fetches
`colab/app.html` and `colab/scene.js` and fills them exactly as `colab/app.py`
does, so there is one form. The form makes two calls, `search` and `scene`;
the notebook answers them in Python with the installed binary, and
`colab_transport.js` answers them here with `search_worker.js`.

```bash
python3 web/jmfs_browser/serve.py            # serves the repository root
# open http://127.0.0.1:8000/web/jmfs_browser/colab.html
```

- **Look**: `DESIGN.md` (the [design.md](https://github.com/google-labs-code/design.md)
  format) holds the tokens and rules: the Colab panel's theme, settings beside
  hits beside one figure on a wide window, one column in Colab and on narrow
  windows. Lint it with `npx @google/design.md lint DESIGN.md`.
- **Queries**: the notebook's four built-in queries and their preset motif and
  chemistry settings are listed in `colab.html`; each structure is fetched when
  chosen. An uploaded PDB joins the menu.
- **Databases**: `assets/databases.tsv` is a copy, taken 2026-10-03, of the
  notebook's index sheet (`Species`, `Filename`, `URL`) with a `Bytes` column.
  Checked databases are searched one after another and the hit limit applies
  across them; the TSV then carries `source_index`. `site.json` points `mirror`
  to `https://jumpmaster-data.tungwinxp.workers.dev/files/indexes/`. All 37
  catalog indexes are hosted in R2 and read directly with cross-origin byte
  ranges. **Save index** streams a full copy to the browser's download folder
  using the Worker's attachment response, without buffering it in JavaScript.
  The browser's download settings determine the folder and any save prompt.
  **Add .jmfsgeom files** accepts a saved index, where it takes its row by
  file name. With no mirror or Drive API key, the form retains its Drive
  download fallback. Any other
  `.jmfsgeom` file can be added the same way, and **Other database** takes the
  URL of one served with byte ranges. Files are read in place; nothing is
  uploaded. The first row is `assets/demo.jmfsgeom`, the two fixture structures
  of the notebook's example database.
- **Execution**: with a WebGPU adapter the search runs on it, and the worker
  keeps the engine and the prepared database chunks for the next search, within
  an estimated 3 GiB device and 1.5 GiB host budget on machines reporting 8 GiB
  or more (1 GiB and 0.5 GiB otherwise). Choosing CPU, or having no usable
  adapter, splits the database across WASM workers, up to eight (four on
  smaller machines; `?cpuLanes=N` overrides). Two databases stay resident at
  once, each in its own worker; a third takes the place of the one used least
  recently.
- **Names**: after a search the page asks UniProt (`rest.uniprot.org`) for the
  gene symbol, protein name and organism of every hit whose target ID holds an
  accession, 300 to a request, and shows them under the target, in the caption
  and as three extra columns of the downloaded TSV. This sends the hit
  accessions to UniProt; it is the page's one request about a search. Hits are
  listed before the names arrive, and a failed lookup leaves them out. The
  form does this only when its host sets `annotate`.
- **Selecting a hit** builds the scene with the same Rust writer as `jmfs visualize`,
  including the PULCHRA backbone and secondary structure, and RNA targets
  rebuilt from their C4′ atoms by the Arena port. Target context is the
  indexed anchor trace on chain `A`, numbered from one; an index with stored
  residue labels is not read for them yet.
Motif tubes interpolate the actual source alpha carbons without beta-sheet
midpoint averaging, keeping chemistry CA–CB sticks attached. The target context
retains its gray secondary-structure ribbons. Source atomic coordinates are
unchanged; chemistry sticks remain limited to selected chemistry residues.

- **Downloads** are a TSV of `query_id`, `target_id`, zero-based `seg_beg`,
  `seg_len`, `rmsd` and the matched sequence, and the scene mmCIF. Pose columns
  and Parquet remain native features.

A static host needs `web/jmfs_browser/`, `colab/app.html`, `colab/scene.js` and
the four query structures at their repository paths;
`.github/workflows/pages.yml` stages those, without the tests, the development
server, `DESIGN.md` and this README. The molecular viewer loads
3Dmol from its CDN, as in Colab. Measurements on Apple Metal are in
`benchmarks/webgpu_m3pro_20261003/`.

## Swiss-Prot worked example

The tracked example searches the catalytic His-Asp-Ser arrangement against
AFDB Swiss-Prot v4:

| Input | Frozen value |
| --- | --- |
| JMFSGEOM | `afdb_swissprot_v4.jmfsgeom` |
| SHA-256 | `43e6078185f2f6c7a3b59653144f2358e6100faa7301b2dfb2be40eb1e64ae85` |
| Database | 542,378 proteins; 191,591,443 residues |
| Query | `jmfs/fixtures/protein/serine_three_segment.pdb` |
| Motif pieces | `B56-58,B101-103,C194-196` |
| Chemistry anchors | exact `B57,B102,C195` |
| Complete-motif cutoff | 1.0 A RMSD |
| Expected output | 979 placements |

The durable cluster-style source is
`/data/nguyentuh/jmfs_benchmarks/swissprot_jmfsgeom_20260808/afdb_swissprot_v4.jmfsgeom`.
The 2026-09-28 workstation gate used the temporary copy at
`/Users/nguyentuh/Code/final_jmfs/jmfsgeom_indexes_no_afdb50_20260909/indexes/afdb_swissprot_v4.jmfsgeom`.
The local path is provenance, not a deployment dependency.

Start the range-capable development server from the repository checkout:

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.126
CARGO_BUILD_JOBS=8 web/jmfs_browser/build_wasm.sh
python3 web/jmfs_browser/serve.py --root /Users/nguyentuh/Code/final_jmfs --port 8000
```

The CLI version must match the exact `wasm-bindgen` version in `Cargo.lock`.
The build emits the WebGPU-enabled Rust core and its generated ES module into
`web/jmfs_browser/assets/`.

Open <http://127.0.0.1:8000/jumpmaster_remote/web/jmfs_browser/>, choose the
Swiss-Prot `.jmfsgeom`, and press **Load the tracked Swiss-Prot
serine-protease query**. The button also restores the frozen motif, exact
chemistry, 1.0-A cutoff, and 5,000-row cap.

For production, replace workstation paths with immutable same-origin HTTPS
URLs. The host must support one HTTP byte range per request. Cross-origin
hosting must allow the page origin and expose `Content-Range`; same-origin
hosting avoids that CORS configuration. HTTPS is required outside the
browser's secure `localhost` exception.

## Optional remote FoldDisco prefilter

FDP is an optional target-proposal stage for discontinuous protein motifs with
chemistry anchors:

```text
query -> remote FoldDisco postings -> candidate protein rows
      -> the same JMFSGEOM search -> exact Rust verification
```

It changes which target records are fetched, never the acceptance test. If a
query is ineligible, its catalog does not match the JMFSGEOM target order, or a
proposal would exceed the browser's bounded transfer guard, JMFS explains the
reason and performs the complete exact scan.

The browser deployment needs three immutable, release-matched objects:

1. `afdb_swissprot_v4.jmfsgeom`;
2. `afdb_swissprot_v4.jmfsremote`; and
3. the raw FoldDisco postings object named by the catalog.

Generate the catalog on the cluster, where the source sidecars live. These
paths deliberately mirror the durable `/data` layout; substitute the exact
release directory and object URLs used by the deployment:

```bash
jmfs remote-catalog \
  --foldcomp-prefix /data/nguyentuh/uniprot_flatfile/afdb_swissprot_v4 \
  --folddisco-offset /data/nguyentuh/uniprot_flatfile/folddisco/afdb_swissprot_v4_folddisco.offset \
  --folddisco-lookup /data/nguyentuh/uniprot_flatfile/folddisco/afdb_swissprot_v4_folddisco.lookup \
  --foldcomp-url https://data.example.org/swissprot/afdb_swissprot_v4 \
  --folddisco-postings-url https://data.example.org/swissprot/afdb_swissprot_v4_folddisco \
  --release afdb_swissprot_v4-YYYYMMDD \
  --out /data/nguyentuh/uniprot_flatfile/folddisco/afdb_swissprot_v4.jmfsremote
```

The browser only reads the FDP sections of this catalog; the same catalog
format also supports native remote FoldComp search. A compressed `.tar.lz4`
download is not a range-addressable postings object: extract it once, host the
raw postings and sidecars, then build the catalog against those exact bytes.
Use immutable URLs plus ETags. The browser verifies the catalog footer,
directory, metadata, target count/order, postings length, and release identity;
the immutable object contract pins the range-served data bytes.

## Progress, stopping, and returning later

The workbench offers **Save progress and resume on return**, off by default.
It keeps query settings and completed CPU/WebGPU chunks in IndexedDB.
**Pause** keeps the last durable chunk; **Resume** continues it. **Stop** discards
the saved job and checkpoints. Completed results and structure-export requests
are restored on return. CPU ranges have independent checkpoint keys; results
retain one global ranked hit cap across ranges and databases.

Progress bars show completed work and ETA estimates. **Advanced compute
settings → CPU cores** sets CPU search workers and local-model threads, bounded
by the browser's logical-core count. `?cpuLanes=N` remains available.

Opt-in downloads commit 8 MiB ranges to OPFS and reuse completed bytes after
interruption. Mutable indexes require an ETag and size; models use pinned
immutable URLs. **Continue downloads after closing this page** separately opts
into Background Fetch when available. Pause aborts that registration, keeping
completed ranges; Resume downloads the remainder; Stop removes that download.
Completed indexes can be loaded and saved to Downloads. Models stay file-backed
without buffering an entire download in JavaScript. Background downloads require
browser permission and storage. Unsupported browsers need the page open.

Switching tabs normally allows the worker to continue, but browsers may freeze
or discard background pages. Closing the last page always stops its local CPU
or GPU work. Reopening can resume from the last completed chunk; reliable
computation after every tab is closed requires a remote JMFS service or native
helper, not a service worker. This follows the browser lifecycle and service
worker execution models rather than pretending a page owns a persistent GPU
process.

## Scope and validation

- Input: JMFSGEOM v5 with CAD1 geometry and packed sequence.
- Query: PDB or mmCIF with protein CA or nucleotide C4' anchors, author labels,
  physical runs and first-model/primary-altloc handling.
- Chemistry: shape-only, exact, or the native reduced alphabet.
- Compute: WebGPU when available, with the same Rust/WASM CPU fallback.
- Output: finite ranked TSV. Complete uncapped Parquet streaming, pose output,
  and server-owned close-surviving jobs remain native/server features.
- Safety: the CPU fallback refuses an unexpectedly large scan unless the user
  explicitly enables it; FDP uses bounded concurrent reads and falls back to a
  complete scan rather than issuing an unbounded remote plan.

The small tracked gate builds a one-record JMFSGEOM and requires native/WASM
and WebGPU to return the same six placements. Run:

```bash
CARGO_BUILD_JOBS=8 cargo test --locked --release -p jmfs-web-core --features webgpu -j 8
CARGO_BUILD_JOBS=8 web/jmfs_browser/build_wasm.sh
python3 -m py_compile web/jmfs_browser/serve.py
```

Then open `tests/smoke.html?backend=wasm` for direct range/WASM validation or
`tests/worker_smoke.html?backend=webgpu` for the public worker route. Chrome's
synthetic `--virtual-time-budget` pauses worker range/blob I/O and is not a
valid wall-time gate.

The database-scale result is recorded in
`benchmarks/webgpu_swissprot_20260928/`: three fresh Apple `metal-3` browser
runs returned all 979 placements in a 3.9192-second median wall time. Their
canonical placement hash exactly matches the saved retired native Metal
result. The paired native median was 3.717778 seconds, so this browser path delivered about
94.9% of native throughput on the frozen request. Treat this as a specific
engineering gate, not a general publication speed claim.

Browser lifecycle references: [Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api),
[Service Workers](https://www.w3.org/TR/service-workers/), and
[IndexedDB](https://www.w3.org/TR/IndexedDB/). WebGPU behavior is defined by
the [W3C WebGPU specification](https://www.w3.org/TR/webgpu/).

The interface uses white and gray controls. Query structures use light pink,
chemistry uses dark pink, and additional chains use light green, coral and sage.
Each viewer's small top-left **Options** disclosure provides color pickers and
Reset colors; preferences stay in browser local storage.
Closed-tab Background Fetch and interrupted download/search checks are in
`scratch/ai-demo/background-smoke.mjs` and `jobs-smoke.mjs` in the companion
Wrangler project. Compact evidence is saved in `tests/evidence/`.
See [Chrome Background Fetch](https://developer.chrome.com/blog/background-fetch)
for the browser-managed download lifecycle and its limitations.

## Assistants (ChatGPT, Codex)

An outside assistant can prepare a search and hand the user a link; the search still runs in the
user's browser and the assistant never sees the results.

- **Endpoint.** `https://jumpmaster-agent.tungwinxp.workers.dev/mcp` is a read-only MCP server
  (Streamable HTTP, no sign-in) with three tools: `jumpmaster_databases`,
  `jumpmaster_enzyme_reference` and `jumpmaster_search_link`. Source and tests are in
  `agent_worker/`; deploy with `wrangler deploy --config agent_worker/wrangler.jsonc`.
- **Codex.** `codex mcp add jumpmaster --url https://jumpmaster-agent.tungwinxp.workers.dev/mcp`.
- **ChatGPT.** Enable developer mode in settings and add a connector with that URL and no
  authentication (plans that offer developer mode).
- **Links.** `colab.html` accepts `uniprot`, `enzyme` + `organism`, `pdb` (+ `chain`), `motif`,
  `chemistry_positions`, `chemistry`, `rmsd`, `limit` and `db`. A link fills the form and never
  starts a search. `llms.txt` documents the parameters for assistants.
