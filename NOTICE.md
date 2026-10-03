# Notices

JumpMASTER is distributed under the GNU General Public License, version 3
(`GPL-3.0-only`). The full GPLv3 text is in `LICENSE`; project-specific
licensing notes are in `LICENSE.md`.

The crate includes Rust reimplementations of selected MASTER search concepts and
compatibility behavior. The local upstream reference is `../master_cpp`.

For this project, the upstream MASTER codebase is treated as GPL-3.0 covered.
Some MASTER source files contain LGPL-3.0-or-later header wording; those
conflicting headers are not used here to relax the license. JumpMASTER and its
MASTER-compatible portions should not be described or distributed as LGPL.

MASTER attribution:

- Copyright (C) 2014 Jianfu Zhou, Gevorg Grigoryan

The native and browser builds share FoldDisco-compatible query hashing,
including adaptations of FoldDisco geometry routines. FoldDisco is GPLv3
software by Hyunbin Kim and contributors. See `LICENSE.md` and the
[source-provenance audit](docs/licensing_audit.md) for the inspected upstream
version and source references.

The UniDoc structure-domain routines derive from Yang Lab UniDoc. The later
upstream release `20251022` retains these routines and supplies the MIT license:
Copyright (c) 2025 Jianyi Yang (Shandong University). Its complete notice is in
`jmfs/src/annotate/LICENSE.unidoc`; the version comparison is recorded in
`docs/unidoc_rsasa_annotation.md`.

Protein backbone reconstruction uses the MIT-licensed PULCHRA fragment library:
Copyright (c) 2000–2009 Piotr Rotkiewicz. The complete notice and reference
version are in `jmfs/src/visualize/pulchra/LICENSE` and its adjacent README.
