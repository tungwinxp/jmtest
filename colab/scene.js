// Shared molecular rendering for the native notebook and optional HTML form.
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
  let hoverLabel=null;
  function clearHover(){
    if(hoverLabel){viewer.removeLabel(hoverLabel);hoverLabel=null;}
  }
  viewer.setHoverDuration(180);
  viewer.setHoverable({},true,function(atom){
    clearHover();
    if(!visible(atom))return;
    const a=atom.jmfsOrigin||atom;
    const role=a.chain.startsWith('query_')?'Query':'Target';
    const location=isMatch(a)?(role==='Query'?'motif position ':'exported position ')+a.resi:
      'chain '+(chainNames[a.chain]||a.chain.replace(/^(query|target)_/,''))+' · residue '+a.resi+(a.icode||'');
    const chain=sequenceChains.get(a.chain)||[];
    const index=chain.findIndex(b=>b.resi===a.resi&&(b.icode||'')===(a.icode||''));
    const nearby=index<0?'':chain.slice(Math.max(0,index-4),index+5)
      .map(b=>b===chain[index]?'['+one(b)+']':one(b)).join('');
    hoverLabel=viewer.addLabel(role+' · '+a.resn+' ('+one(a)+') · '+location+'\n'+nearby,
      {position:atom,backgroundColor:'white',backgroundOpacity:.95,fontColor:'#243247',fontSize:12,
       borderColor:'#dce2e9',borderThickness:1,inFront:true});
    viewer.render();
  },function(){clearHover();viewer.render();});
  viewer.jmfsVisibility=function(chains,query=true,target=true,motif=false){
    clearHover();
    enabled=new Set(chains);showQuery=query;showTarget=target;motifOnly=motif;
    viewer.setStyle({},{});
    for(const [role,color,opacity] of [['query','#0072B2',.72],['target','#D55E00',.72]]){
      viewer.setStyle({predicate:a=>visible(a)&&a.chain.startsWith(role+'_')&&!isMatch(a)}, {cartoon:{arrows:true,color,opacity}});
      const motifColor=role==='query'?'#000000':'#E69F00';
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
