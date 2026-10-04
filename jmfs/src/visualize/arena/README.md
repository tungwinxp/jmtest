# Arena RNA reconstruction

JMFS rebuilds the missing atoms of RNA shown from an index, which stores one
C4′ atom per nucleotide, with a Rust port of Arena's default mode (option 5).
`../nucleic.rs` is the port; `tables.rs` holds Arena's numbers, copied by
`build_tables.py`.

Arena: Zion R. Perry, Anna Marie Pyle and Chengxin Zhang, "Arena: rapid and
accurate reconstruction of full atomic RNA structures from coarse-grained
models", J. Mol. Biol. 435, 168210 (2023),
https://doi.org/10.1016/j.jmb.2023.168210. Licence and attribution: `LICENSE.md`.

## Source

- Zenodo record https://doi.org/10.5281/zenodo.18963141 (version 4, published
  2026-03-11; all versions: https://doi.org/10.5281/zenodo.7566670), licence
  CC BY 4.0, inspected 2026-10-03.
- `Arena-main.zip`, SHA-256
  `259a553caefed6444f0811201898f05efa41538d940d94154bcaf90faa3c8319`.
- The GitHub repository https://github.com/pylelab/Arena carries no licence
  file. At commit `5d57cde` its `MissingRNAatom.hpp`, `IdealRNA.hpp`, `cssr.hpp`,
  `BondLengths.hpp`, `BaseConformation.hpp`, `AtomicClashes.hpp`,
  `GeometryTools.hpp`, `Superpose.hpp` and `PDBParser.hpp` are byte-identical to
  the Zenodo archive; only `Arena.cpp` differs, by an extended mode (option 7)
  that is not ported.
- `pstream.h` in the archive (Boost Software License, Jonathan Wakely) is not
  used.

Regenerate the tables with `python build_tables.py /path/to/Arena-main >
tables.rs`. The script copies the numbers as written and checks the atom order
stated in the headers.

## What is ported, and what differs

Ported: base-pair detection from backbone geometry (`cssr.hpp`), filling of
missing atoms from ideal A-form templates, singly, in a base pair, in a stack of
pairs and along the chain (`MissingRNAatom.hpp`, `IdealRNA.hpp`), and the
refinement rounds: bond lengths (`BondLengths.hpp`), base and base-pair shape
(`BaseConformation.hpp`) and clash removal (`AtomicClashes.hpp`). The order of
operations, thresholds and several quirks of the original are kept, and are
marked where they occur. Supplied atoms are never moved.

Differences:

- Scope. Only residues named A, C, G or U are rebuilt, in runs with one chain
  ID; a residue of another name ends a run. Arena renames DNA to RNA and then
  builds ribose; JMFS leaves DNA as supplied. A structure in which every such
  residue already has three or more standard atoms is returned unchanged, so
  full-atom queries are not refined.
- Superposition uses JMFS's own least-squares fit in place of `Superpose.hpp`.
- Two flags Arena reads uninitialised at the start of each base-pair scan start
  cleared here.
- Search only, not result: the clash step tests neighbouring residues from
  bounding boxes instead of every residue pair, and steps skip residues that
  have not changed since they were last left alone.
- Options 0-4 and 7, file reading and writing, and the per-round printing are
  not ported.

## Agreement with Arena

`benchmarks/arena_rna_rebuild_20261003/` records the comparison on the 361
structures of Arena's benchmark set reduced to C4′ atoms. The unit test in
`nucleic.rs` checks one of them, `jmfs/fixtures/rna/3snpC_*.pdb`.
