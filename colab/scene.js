// Shared molecular rendering for the native notebook and optional HTML form.
// Brighter variants of the user's Ghibli palette, reserved for structures.
function jmfsChainColor(index){return globalThis.jmfsColors?.chains?.[index%4]||['#93c7cc','#b1bcc4','#eddaa0','#efc3b6'][index%4];}
function jmfsColor(name){return globalThis.jmfsColors?.[name]||{queryMatch:'#f4adb3',chemistry:'#c83d6f',target:'#e2e5e9',targetMatch:'#b8bdc5'}[name];}
// Viewer selections keep contiguous anchors together instead of creating singleton segments.
function jmfsMotifRanges(anchors){
  const runs=[],seen=new Set();
  for(const a of anchors){
    const key=a.chain+'\0'+a.resi;if(seen.has(key))continue;seen.add(key);
    const last=runs.at(-1);
    if(last&&last.chain===a.chain&&a.resi===last.end+1)last.end=a.resi;
    else runs.push({chain:a.chain,start:a.resi,end:a.resi});
  }
  return runs.map(r=>r.chain+r.start+(r.end===r.start?'':'-'+r.end)).join(',');
}
function installJMFSScene(viewer, secondary, chainNames={}, chemistry=[]) {
  const atoms=viewer.getModel().selectedAtoms({});
  const isMatch=a=>a.chain==='query_match'||a.chain==='target_match';
  for(const a of atoms){a.ss='c';a.ssbegin=false;a.ssend=false;}
  // 3Dmol 2.5.5 otherwise infers contacts between superposed copies.
  for(const span of secondary)for(const a of atoms){
    if(a.chain===span.chain&&a.resi>=span.start&&a.resi<=span.end){
      a.ss=span.ss;a.ssbegin=a.resi===span.start;a.ssend=a.resi===span.end;
    }
  }
  let enabled=new Set(atoms.filter(a=>!isMatch(a)).map(a=>a.chain));
  let showQuery=false,showTarget=true,motifOnly=false;
  let sideChains=true;
  const chemistryResidues=new Set(),chemistryMatches=new Set();
  for(const role of ['query','target']){
    const context=atoms.filter(a=>a.chain.startsWith(role+'_')&&!isMatch(a)&&(a.atom==='CA'||a.atom==="C4'"));
    for(const a of atoms.filter(a=>a.chain===role+'_match')){
      const origins=context.filter(b=>a.atom===b.atom&&a.resn===b.resn&&Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<.003);
      a.contextChains=[...new Set(origins.map(b=>b.chain))];
      if(origins.length===1)a.jmfsOrigin=origins[0];
    }
  }
  const queryMatches=atoms.filter(a=>a.chain==='query_match'),targetMatches=atoms.filter(a=>a.chain==='target_match');
  for(const [index,a] of queryMatches.entries()){
    const origin=a.jmfsOrigin;
    if(!origin||!chemistry.some(r=>origin.chain==='query_'+r.chain&&origin.resi>=r.start&&origin.resi<=r.end))continue;
    chemistryMatches.add(a);
    for(const anchor of [a,targetMatches[index]])if(anchor?.jmfsOrigin){const b=anchor.jmfsOrigin;chemistryResidues.add(b.chain+'\0'+b.resi+'\0'+(b.icode||''));}
  }
  function visible(a){
    if(isMatch(a))return !a.contextChains.length||a.contextChains.some(c=>enabled.has(c));
    if(!(a.chain.startsWith('query_')?showQuery:showTarget))return false;
    return !motifOnly&&enabled.has(a.chain);
  }
  const names='ALA ARG ASN ASP CYS GLN GLU GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP TYR VAL SEC PYL ASX GLX UNK MSE'.split(' ');
  const letters='ARNDCQEGHILKMFPSTWYVUOBZXM';
  const one=a=>letters[names.indexOf(a.resn)]||(/^[ACGUT]$/.test(a.resn)?a.resn:'X');
  const sequenceChains=new Map();
  for(const a of atoms.filter(a=>a.atom==='CA'||a.atom==="C4'")){
    if(!sequenceChains.has(a.chain))sequenceChains.set(a.chain,[]);
    sequenceChains.get(a.chain).push(a);
  }
  // The hover note is an HTML box kept inside the viewer, so long text wraps instead of running off it.
  let tip=null;
  function clearHover(){
    if(tip)tip.hidden=true;
  }
  viewer.setHoverDuration(180);
  viewer.setHoverable({},true,function(atom,_viewer,event,container){
    clearHover();
    if((!visible(atom)&&!atom.style?.stick)||!container)return;
    const a=atom.jmfsOrigin||atom;
    const role=a.chain.startsWith('query_')?'Query':'Target';
    const location=isMatch(a)?(role==='Query'?'motif position ':'exported position ')+a.resi:
      'chain '+(chainNames[a.chain]||a.chain.replace(/^(query|target)_/,''))+' · residue '+a.resi+(a.icode||'');
    const chain=sequenceChains.get(a.chain)||[];
    const index=chain.findIndex(b=>b.resi===a.resi&&(b.icode||'')===(a.icode||''));
    const nearby=index<0?'':chain.slice(Math.max(0,index-4),index+5)
      .map(b=>b===chain[index]?'['+one(b)+']':one(b)).join('');
    // One note per viewer, shared by every scene installed on it.
    tip||=container.querySelector('.jmfs-hover');
    if(!tip){
      tip=container.ownerDocument.createElement('div');
      tip.className='jmfs-hover';
      tip.style.cssText='position:absolute;z-index:10;box-sizing:border-box;width:max-content;max-width:calc(100% - 8px);'+
        'padding:4px 8px;border:1px solid #dce2e9;border-radius:6px;background:rgba(255,255,255,.95);color:#243247;'+
        'font:12px/1.4 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none';
      container.appendChild(tip);
    }
    tip.textContent=role+' · '+a.resn+' ('+one(a)+') · '+location+'\n'+nearby;
    tip.hidden=false;
    // Beside the pointer, moved back inside the viewer where it would cross an edge.
    const box=container.getBoundingClientRect();
    const x=event&&event.clientX!=null?event.clientX-box.left:box.width/2;
    const y=event&&event.clientY!=null?event.clientY-box.top:box.height/2;
    tip.style.left=Math.max(4,Math.min(x+12,box.width-tip.offsetWidth-4))+'px';
    tip.style.top=Math.max(4,Math.min(y+12,box.height-tip.offsetHeight-4))+'px';
  },clearHover);
  viewer.jmfsVisibility=function(chains,query=false,target=true,motif=false,sidechains=true){
    clearHover();
    enabled=new Set(chains);showQuery=query;showTarget=target;motifOnly=motif;sideChains=sidechains;
    viewer.setStyle({},{});
    for(const role of ['query','target']){
      const chains=[...new Set(atoms.filter(a=>a.chain.startsWith(role+'_')&&!isMatch(a)).map(a=>a.chain))].sort();
      chains.forEach((chain,index)=>viewer.setStyle({predicate:a=>visible(a)&&a.chain===chain}, {cartoon:{arrows:true,color:role==='target'?jmfsColor('target'):jmfsChainColor(index),opacity:.85}}));
      const motifColor=jmfsColor(role+'Match');
      viewer.setStyle({predicate:a=>visible(a)&&a.chain===role+'_match'}, {cartoon:{style:'trace',color:motifColor,thickness:role==='query'?.35:.18},sphere:{color:motifColor,radius:role==='query'?.36:.23}});
      if(role==='query')viewer.addStyle({predicate:a=>visible(a)&&chemistryMatches.has(a)},{sphere:{radius:.36,color:jmfsColor('chemistry')}});
      if(sideChains)viewer.addStyle({predicate:a=>enabled.has(a.chain)&&a.chain.startsWith(role+'_')&&!isMatch(a)&&chemistryResidues.has(a.chain+'\0'+a.resi+'\0'+(a.icode||''))},{stick:{radius:.16,color:role==='query'?jmfsColor('chemistry'):motifColor}});
    }
    viewer.render();
  };
  viewer.jmfsFocus=function(role='',match=true){
    const sel={predicate:a=>visible(a)&&(match?isMatch(a):a.chain.startsWith(role+'_')&&!isMatch(a))};
    if(!viewer.getModel().selectedAtoms(sel).length)return;
    viewer.zoomTo(sel);if(match)viewer.zoom(.7);viewer.render();
  };
  viewer.jmfsVisibility([...enabled]);
}
