# JMFS structure search in the browser

**Open the site: <https://tungwinxp.github.io/jmtest/>**

A zero-install page for JMFS structure-motif search. It is the form of the JMFS
Colab notebook; here the search runs on your own computer, in the browser.

- Pick a built-in query or upload a PDB, click residues in the figure or type
  them to set the motif, press **Search**.
- Tick databases in the list. The listed databases live on Google Drive, which
  does not let a web page read them directly: **Get file** downloads one, and
  **Add .jmfsgeom files** adds the saved file, which is read in place; nothing
  is uploaded. Any other `.jmfsgeom` file can be added the same way. The first
  row is a two-structure example.
- With a WebGPU adapter the search runs on the GPU (Metal on a Mac) and up to
  two databases stay loaded for the next search. Without one, or with **CPU**
  selected, it runs on WebAssembly CPU workers.
- Hits are named with their gene symbol, protein name and organism. For this
  the page sends the hits' UniProt accessions to UniProt after a search; it is
  the only request the page makes about a search.
- Selecting a hit superposes it on the query; results and structures download
  as TSV and mmCIF. Protein backbones are rebuilt from the stored Cα atoms and
  RNA to all atoms from the stored C4′ atoms.

Tested in Chrome 154 on an Apple M3 Pro. Other browsers and platforms have not
been tested. The 3D viewer loads 3Dmol.js from its CDN and needs WebGL.

`web/jmfs_browser/` holds the page, its worker and the compiled search core
(`assets/jmfs_web_core.wasm`); `colab/` holds the shared form. They are built
from the JMFS source repository, which is not public yet.

## License

GPL-3.0-only; see `LICENSE`, `LICENSE.md` and `NOTICE.md`. Backbone
reconstruction uses the MIT-licensed PULCHRA fragment library
(`jmfs/src/visualize/pulchra/LICENSE`). RNA reconstruction is adapted from
Arena by Zion R. Perry, Anna Marie Pyle and Chengxin Zhang, published under
CC BY 4.0 at <https://doi.org/10.5281/zenodo.18963141>; the attribution and
the changes made are in `jmfs/src/visualize/arena/`.
