# JMFS motif search in the browser

**Open the site: <https://tungwinxp.github.io/jmtest/>**

A zero-install page for JMFS structure-motif search. It is the same form as the
JMFS Colab notebook; here the search runs on your own computer, in the browser.

- Paste or upload a query PDB, pick the motif residues, press **SEARCH**.
- Choose a `.jmfsgeom` database file from your computer, or enter the URL of one
  served with byte ranges. The file is read in place; nothing is uploaded. With
  no database chosen, the page searches a two-structure example.
- With a WebGPU adapter the search runs on the GPU (Metal on a Mac) and the
  database stays loaded for the next search. Without one, or with **CPU**
  selected, it runs on WebAssembly CPU workers.
- **VIEW** superposes a hit on the query; results and structures download as
  TSV and mmCIF.

Tested in Chrome 154 on an Apple M3 Pro. Other browsers and platforms have not
been tested. The 3D viewer loads 3Dmol.js from its CDN and needs WebGL.

`web/jmfs_browser/` holds the page, its worker and the compiled search core
(`assets/jmfs_web_core.wasm`); `colab/` holds the shared form. They are built
from the JMFS source repository, which is not public yet.

## License

GPL-3.0-only; see `LICENSE`, `LICENSE.md` and `NOTICE.md`. Backbone
reconstruction uses the MIT-licensed PULCHRA fragment library
(`jmfs/src/visualize/pulchra/LICENSE`).
