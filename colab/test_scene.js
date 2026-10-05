// Run with node test_scene.js; no browser or database is required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
vm.runInThisContext(fs.readFileSync(__dirname + '/scene.js', 'utf8'));
const selection=[73,74,75,103,120,121,122,215,216,217].map(resi=>({chain:'A',resi}));
assert.equal(jmfsMotifRanges(selection),'A73-75,A103,A120-122,A215-217');
assert.equal(jmfsMotifRanges(selection.filter(a=>a.resi!==103)),'A73-75,A120-122,A215-217');
assert.equal(jmfsMotifRanges([{chain:'B',resi:1},{chain:'B',resi:1},{chain:'B',resi:2},{chain:'C',resi:3},{chain:'C',resi:5}]),'B1-2,C3,C5');
const atoms = [
  {chain:'query_A',resi:112,resn:'GLY',atom:'CA',x:-1,y:0,z:0},
  {chain:'query_A',resi:113,resn:'PRO',atom:'CA',x:0,y:0,z:0},
  {chain:'query_A',resi:114,resn:'ASP',atom:'CA',x:1,y:0,z:0},
  {chain:'query_match',resi:1,resn:'PRO',atom:'CA',x:0,y:0,z:0},
  {chain:'target_A',resi:7,resn:'SER',atom:'CA',x:0,y:1,z:0},
  {chain:'target_match',resi:7,resn:'SER',atom:'CA',x:0,y:1,z:0},
  {chain:'target_B',resi:8,resn:'GLY',atom:'CA',x:1,y:1,z:0},
  {chain:'target_C',resi:9,resn:'ALA',atom:'CA',x:2,y:1,z:0},
  {chain:'target_D',resi:10,resn:'ASP',atom:'CA',x:3,y:1,z:0},
  {chain:'query_A',resi:113,resn:'PRO',atom:'CB',x:0,y:0,z:1},
  {chain:'target_A',resi:7,resn:'SER',atom:'CB',x:0,y:1,z:1},
  {chain:'target_A',resi:7,resn:'SER',atom:'N',x:0,y:1,z:2},
  {chain:'query_A',resi:113,resn:'PRO',atom:'N',x:0,y:0,z:2},
];
let hover, unhover, styles = [], colors = [], sticks = [], zoomed;
// A stand-in for the viewer's element: 300 x 200, holding the hover note.
const container = {
  children: [],
  ownerDocument: {createElement: () => ({style: {}, hidden: false, textContent: '', offsetWidth: 180, offsetHeight: 40})},
  appendChild(node) { this.children.push(node); },
  querySelector() { return this.children[0] || null; },
  getBoundingClientRect: () => ({left: 10, top: 20, width: 300, height: 200}),
};
const note = () => container.children[0];
const shown = () => (note() && !note().hidden ? note().textContent : null);
const model = {selectedAtoms: sel => sel.predicate ? atoms.filter(sel.predicate) : atoms};
const viewer = {
  getModel: () => model,
  setStyle: (sel, style) => { if (!sel.predicate) {styles=[];colors=[];sticks=[];} else {styles.push(sel.predicate);colors.push({predicate:sel.predicate,style});} },
  addStyle: (sel, style) => {if(style.stick)sticks.push({predicate:sel.predicate,style});},
  setHoverDuration: () => {},
  setHoverable: (sel, value, enter, leave) => {hover=enter;unhover=leave;},
  render: () => {}, zoom: () => {}, zoomTo: sel => {zoomed=model.selectedAtoms(sel);},
};
installJMFSScene(viewer, [], {query_A:'A',target_A:'A'},[{chain:'A',start:113,end:113}]);
const colorOf=atom=>colors.findLast(entry=>entry.predicate(atom)).style.cartoon.color;
assert.equal(colorOf(atoms[3]),'#f4adb3');
assert.equal(colorOf(atoms[4]),'#e2e5e9');
assert.equal(colorOf(atoms[5]),'#b8bdc5');
for(const atom of atoms.slice(6).filter(a=>a.chain.startsWith('target_')))assert.equal(colorOf(atom),'#e2e5e9');
assert.notEqual(colorOf(atoms[3]),colorOf(atoms[4]));
assert(!styles.some(predicate=>predicate(atoms[1])),'Default hides the whole query chain.');
assert(styles.some(predicate=>predicate(atoms[3])),'Default keeps the query motif visible.');
assert.equal(sticks.find(s=>s.predicate(atoms[9])).style.stick.color,'#c83d6f');
assert.equal(sticks.find(s=>s.predicate(atoms[10])).style.stick.color,'#b8bdc5');
assert(!sticks.some(s=>s.predicate(atoms[2])),'Do not show non-motif side chains.');
assert(!sticks.some(s=>s.predicate(atoms[11])||s.predicate(atoms[12])),'Chemistry sticks omit protein backbone stubs.');
hover(atoms[3], viewer, {clientX: 60, clientY: 70}, container);
assert.equal(shown(), 'Query · PRO (P) · chain A · residue 113 · atom CA\nG[P]D');
assert.deepEqual([note().style.left, note().style.top], ['62px', '62px']);
// Near the right and bottom edges the note moves back inside the viewer.
hover(atoms[3], viewer, {clientX: 305, clientY: 215}, container);
assert.deepEqual([note().style.left, note().style.top], ['116px', '156px']);
unhover();assert.equal(shown(),null);
viewer.jmfsVisibility(['target_A'],true,true,false);
assert(!styles.some(predicate=>predicate(atoms[3])));
hover(atoms[3], viewer, {clientX: 60, clientY: 70}, container);assert.equal(shown(),null);
viewer.jmfsVisibility(['query_A','target_A'],true,true,false);
assert(styles.some(predicate=>predicate(atoms[3])));
viewer.jmfsVisibility(['query_A','target_A'],true,true,true);
assert(!styles.some(predicate=>predicate(atoms[1])));
assert(styles.some(predicate=>predicate(atoms[3])));
viewer.jmfsFocus();assert.deepEqual(zoomed,[atoms[3],atoms[5]]);
viewer.jmfsVisibility(['query_A','target_A'],false,true,false,false);assert.equal(sticks.length,0);
// Motif tubes interpolate real CA positions instead of beta-sheet midpoints.
atoms.push({chain:'query_A',resi:113,resn:'PRO',atom:'O',x:0,y:1,z:0});
installJMFSScene(viewer,[{chain:'query_A',start:112,end:114,ss:'s'}],{},[{chain:'A',start:113,end:113}]);
assert.equal(atoms[1].ss,'c');assert.equal(atoms[0].ss,'s');assert.equal(atoms[2].ss,'s');
assert.equal(colors.findLast(s=>s.predicate(atoms[1])).style.cartoon.style,'oval');
assert(sticks.some(s=>s.predicate(atoms[1])),'The CA–CB bond retains its real attachment point.');
console.log('Scene hover, hover placement, visibility restore, motif-only and focus checks passed.');
