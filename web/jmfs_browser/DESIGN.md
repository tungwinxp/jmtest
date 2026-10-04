---
version: alpha
name: JMFS Workbench
description: The JMFS structure-search form (colab/app.html) on the website and in Colab.
colors:
  primary: "#3C4043"
  on-primary: "#FFFFFF"
  primary-hover: "#202124"
  primary-wash: "#F1F3F4"
  blossom: "#F29BB0"
  coral: "#F07F67"
  sage: "#A7B978"
  light-green: "#B7D69E"
  surface: "#FFFFFF"
  surface-dim: "#FAFAFA"
  ink: "#202124"
  muted: "#5F6368"
  hairline: "#DADCE0"
  outline: "#9AA0A6"
  error: "#B3261E"
  mol-geometry: "#F29BB0"
  mol-chemistry: "#C83D6F"
  mol-context: "#B8C1CC"
  mol-query: "#F29BB0"
  mol-target: "#B7D69E"
  mol-match: "#4F7E4A"
typography:
  title:
    fontFamily: system-ui
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.3
  section:
    fontFamily: system-ui
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: system-ui
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: system-ui
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.35
  data:
    fontFamily: ui-monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: '"tnum" 1'
rounded:
  control: 6px
  plate: 8px
  dot: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  panel: 376px
  hits: 400px
  control: 32px
  row: 30px
components:
  page:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
  search-key:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.section}"
    rounded: "{rounded.control}"
    height: 36px
  search-key-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button:
    backgroundColor: "{colors.surface-dim}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    height: "{spacing.control}"
  button-hover:
    backgroundColor: "{colors.primary-wash}"
    textColor: "{colors.ink}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    height: "{spacing.control}"
  field-label:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
  list-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    height: "{spacing.row}"
  list-row-selected:
    backgroundColor: "{colors.primary-wash}"
    textColor: "{colors.ink}"
  table-head:
    backgroundColor: "{colors.surface-dim}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
  hit-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    height: "{spacing.row}"
  figure-plate:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
  status-error:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.error}"
    typography: "{typography.label}"
  hairline:
    backgroundColor: "{colors.hairline}"
    height: 1px
  field-outline:
    backgroundColor: "{colors.outline}"
    height: 1px
  legend-geometry:
    backgroundColor: "{colors.mol-geometry}"
    rounded: "{rounded.dot}"
    size: 9px
  legend-chemistry:
    backgroundColor: "{colors.mol-chemistry}"
    rounded: "{rounded.dot}"
    size: 9px
  legend-context:
    backgroundColor: "{colors.mol-context}"
    rounded: "{rounded.dot}"
    size: 9px
  legend-query:
    backgroundColor: "{colors.mol-query}"
    rounded: "{rounded.dot}"
    size: 9px
  legend-target:
    backgroundColor: "{colors.mol-target}"
    rounded: "{rounded.dot}"
    size: 9px
  legend-match:
    backgroundColor: "{colors.mol-match}"
    rounded: "{rounded.dot}"
    size: 9px
---

# JMFS Workbench

## Overview

The JMFS Colab panel, taken out of the notebook. It keeps the material of a
Google Colab form cell — a white surface, grey hairlines, the system font at
13px, with understated gray controls — and drops what the notebook
forced on it: the single narrow column, the stacked cards, the scrolling past
your settings to reach your results.

The reader is a structural biologist who knows what a motif and an RMSD are.
The page explains nothing and sells nothing. Form follows the three steps of
the work: say what to look for, say where to look, read what came back.
Reading takes longest, so the results get the most room and the settings stay
beside them.

The interface is minimal: white surfaces, gray hairlines, charcoal controls.
Light pink belongs to query structures; dark pink marks chemistry-gated residues.
Light green complements pink and the green JUMP logo in multichain structures;
further chains use coral and sage. Colors use brighter variants of the user's
Ponyo and Ghibli references, with 85% opacity for context chains.
Chain legends repeat the molecule
colors, so identification does not depend on color alone. A small Options
button at the top left of each viewer exposes color pickers and a reset.

## Colors

The interface uses a neutral palette. Primary controls use charcoal with
white labels. Molecule colors are independently adjustable.

- **Surface** `{colors.surface}` is the page and every figure plate.
  **Surface-dim** `{colors.surface-dim}` fills quiet buttons and table heads.
- **Ink** `{colors.ink}` is all text. **Muted** `{colors.muted}` is labels,
  hints, units and captions.
- **Hairline** `{colors.hairline}` separates sections and rows and outlines
  plates; **outline** `{colors.outline}` outlines fields and buttons on hover.
- **Primary** `{colors.primary}` is the Search key, focus rings and links;
  **primary-wash** `{colors.primary-wash}` is hover and the selected row.
- **Error** `{colors.error}` is only the text of a failed search.

Molecule colours. In the query figure, **geometry** residues are
`{colors.mol-geometry}` and **chemistry-gated** residues `{colors.mol-chemistry}`
over a faint `{colors.mol-context}` chain, as in the notebook. In the hit
figure `colab/scene.js` uses the complementary set: query
`{colors.mol-query}`, target `{colors.mol-target}`, matched target residues
`{colors.mol-match}` and matched query residues dark pink. Additional chains
cycle through light green, coral and sage. Text chain labels accompany every dot.

## Typography

System sans-serif at Colab's sizes: 13px for text, fields and rows, 12px for
labels and captions, 16px semibold for the name, 13px semibold for section
names. Two weights only.

Whatever a scientist copies or compares by eye is in the system monospace with
tabular figures: residue selections, target identifiers, residue ranges,
sequences, RMSD, the PDB text and the log. Numbers that are compared are
right-aligned.

Sentence case throughout. No capitals for buttons.

## Layout

Two arrangements of the same parts.

**Workbench** — the website at 1100px and wider. The window is the workbench
and does not scroll as a page. A settings panel `{spacing.panel}` wide sits on
the left, in order of use: query and motif, databases, parameters, then the
Search key with the status line under it; the key stays in view if the panel
has to scroll. The rest is the stage. The stage shows one figure at a time: the
query, where residues are clicked to build the motif, or the selected hit
superposed on the query. After a search a hit list about `{spacing.hits}` wide
appears between panel and stage and scrolls on its own, so hits can be stepped
through, by click or arrow key, with the figure always in view.

**Sheet** — Colab cells, narrow windows, phones. The same parts in one column
in the same order: settings, key, hits, hit figure. The query figure sits
beside the query settings, or under them below 720px, because the motif is
built by clicking it. Nothing hides behind a disclosure except raw PDB text,
the address of an unlisted database and the log.

A 4px unit: `{spacing.sm}` inside a group, `{spacing.lg}` between groups,
`{spacing.xl}` between sections. Controls are `{spacing.control}` tall, list and
table rows `{spacing.row}`. Labels sit above their fields. The chemistry mode
sits beside the residues it gates; the remaining parameters share one row.

## Elevation & Depth

Flat. No shadows and no layers. A hairline and space separate sections; a
hairline outlines a figure plate.

## Shapes

Colab's radii: `{rounded.control}` on fields, buttons and the key,
`{rounded.plate}` on figure plates and the database list. Legend marks are
dots. Nothing else is rounded.

## Components

- **Search key.** The filled charcoal control, as wide as the panel. Disabled
  while a search runs; the line under it reports progress, then the outcome in
  one sentence.
- **Buttons.** Surface-dim fill, hairline outline, ink label of two or three
  words. Hover is the neutral wash.
- **Fields.** White, hairline outline, 6px radius, muted label above. Focus is
  a charcoal outline. Residue selections use the data face.
- **Query source.** One menu of built-in queries with an Upload button beside
  it; an uploaded structure joins the menu. A choice fills the motif, chemistry
  residues and chemistry mode together.
- **Database list.** A bordered checklist that scrolls at six rows: name, then
  size in muted data face. Checked rows carry the wash. A database the page
  cannot read in place has a disabled box and a link that downloads it; files
  added from this computer join the same list.
- **Segmented control.** Adjacent buttons sharing borders; the selected part
  has the wash and charcoal text. Used for query/hit and for framing the figure.
- **Hit list.** A table with horizontal hairlines and a surface-dim head: rank,
  target, matched residues, RMSD; with several databases the database replaces
  the residues, which the figure caption gives. The whole row is the control;
  the selected row has the wash. Thirty-pixel rows in the data face. Where the
  host looks names up, the residues give way to a second line under the target
  in muted label type: gene symbol, protein name, organism.
- **Figure.** A white plate with a hairline outline. Above it, one row of
  actions: which figure, how to frame it, download. Below it, the caption, one
  kind of thing per line: the target in semibold data face with its link; its
  gene, protein and organism; then labelled facts (RMSD, residues, sequence),
  label muted and value in the data face; then the legend. Each legend dot
  labels the checkbox that shows or hides that part, so legend and visibility
  controls are one line. Timings and other diagnostics stay out of the caption.
- **Hover note.** A residue under the pointer is named in a small bordered box
  that wraps its text and stays inside the plate.
- **Mark.** The JUMP mark, 40px tall, left of the name; the host supplies it.

## Do's and Don'ts

- **Do** keep pink and complementary colors inside the structure figures and legends.
- **Do** keep controls in order of use and in view.
- **Do** set identifiers, residues and RMSD in the data face.
- **Do** give the figure all the room the window has.
- **Don't** add shadows, gradients, coloured header bars or nested cards.
- **Don't** capitalise labels or put icons on buttons.
- **Don't** add a hero, a tagline or explanatory paragraphs; one caption line
  per figure.
- **Don't** use complementary molecule colors as decorative page accents.
- **Don't** animate anything beyond a 120ms hover wash.
