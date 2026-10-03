# JumpMASTER License

JumpMASTER is distributed under the GNU General Public License, version 3
(`GPL-3.0-only`). The full GPLv3 text is in `LICENSE`.

Both the native and browser WASM packages record `GPL-3.0-only` in their
`Cargo.toml` manifests.

## MASTER Compatibility

JumpMASTER includes Rust reimplementations of selected MASTER search concepts,
formulas, and compatibility behavior. For this project, the upstream MASTER
codebase is treated as GPL-3.0 covered. Some MASTER source files contain
LGPL-3.0-or-later header wording; those conflicting headers are not used here
to relax the license.

JumpMASTER and its MASTER-compatible portions should not be described or
distributed as LGPL. The combined work is distributed under GPL-3.0-only.

MASTER attribution:

- Copyright (C) 2014 Jianfu Zhou, Gevorg Grigoryan

## Folddisco Compatibility

The optional geometric-postings adapter implements Folddisco's
PDBTrRosetta feature packing and published index formats. Its query-hashing
code is shared by the native and browser builds. Folddisco is
GPL-3.0 software by Hyunbin Kim and contributors. The adapter is modified for
use only as a proposal set before JMFS placement and RMSD verification.

The [source-provenance audit](docs/licensing_audit.md) records the historical
MASTER port, its removal, current adaptations and unresolved licensing questions.

This file is the project license notice. It does not replace the verbatim GPLv3
text in `LICENSE`.
