// Shared molecular rendering for the native notebook and optional HTML form.
// Brighter variants of the user's Ghibli palette, reserved for structures.
function jmfsChainColor(index){return globalThis.jmfsColors?.chains?.[index%4]||['#f29bb0','#b7d69e','#f07f67','#a7b978'][index%4];}
function jmfsColor(name){return globalThis.jmfsColors?.[name]||{queryMatch:'#c83d6f',chemistry:'#c83d6f',targetMatch:'#4f7e4a'}[name];}
function installJMFSScene(viewer, secondary, chainNames={}) {
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
  let showQuery=true,showTarget=true,motifOnly=false;
  for(const role of ['query','target']){
    const context=atoms.filter(a=>a.chain.startsWith(role+'_')&&!isMatch(a)&&(a.atom==='CA'||a.atom==="C4'"));
    for(const a of atoms.filter(a=>a.chain===role+'_match')){
      const origins=context.filter(b=>a.atom===b.atom&&a.resn===b.resn&&Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<.003);
      a.contextChains=[...new Set(origins.map(b=>b.chain))];
      if(origins.length===1)a.jmfsOrigin=origins[0];
    }
  }
  function visible(a){
    if(!(a.chain.startsWith('query_')?showQuery:showTarget))return false;
    if(isMatch(a))return !a.contextChains.length||a.contextChains.some(c=>enabled.has(c));
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
    if(!visible(atom)||!container)return;
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
  viewer.jmfsVisibility=function(chains,query=true,target=true,motif=false){
    clearHover();
    enabled=new Set(chains);showQuery=query;showTarget=target;motifOnly=motif;
    viewer.setStyle({},{});
    for(const [role,offset,opacity] of [['query',0,.85],['target',1,.85]]){
      const chains=[...new Set(atoms.filter(a=>a.chain.startsWith(role+'_')&&!isMatch(a)).map(a=>a.chain))].sort();
      chains.forEach((chain,index)=>viewer.setStyle({predicate:a=>visible(a)&&a.chain===chain}, {cartoon:{arrows:true,color:jmfsChainColor(index+offset),opacity}}));
      const motifColor=jmfsColor(role+'Match');
      viewer.setStyle({predicate:a=>visible(a)&&a.chain===role+'_match'}, {cartoon:{style:'trace',color:motifColor,thickness:role==='query'?.18:.35},sphere:{color:motifColor,radius:role==='query'?.23:.36}});
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
