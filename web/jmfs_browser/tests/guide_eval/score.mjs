// Scores the real ai/agent.js and a local guide server (port 18773) against labelled commands.
// Labels are written call-first, so they are correct by construction; only the wording varies.
// usage: node score.mjs [--backend mlx] [--limit N] [--label NAME] view.jsonl intents.jsonl
import fs from 'node:fs';
const root=new URL('../../',import.meta.url);
const {createAgent}=await import(new URL('ai/agent.js',root));
const argv=process.argv.slice(2),option=name=>{const i=argv.indexOf('--'+name);return i<0?undefined:argv.splice(i,2)[1];};
const backend=option('backend'),limit=Number(option('limit'))||Infinity,label=option('label')||'model';
const server='http://127.0.0.1:18773',realFetch=globalThis.fetch;
// Public lookups are cut off: the score is the model's first decision, not the network.
globalThis.fetch=(url,options)=>String(url).startsWith(server)?realFetch(url,options):Promise.reject(Error('offline during scoring'));
const accessions=['P17538','P00766','P07477','P00760','P08246','P00734','P00750','P07478','P35030','Q9UNI1'];
const state={query:{source_label:'Serine protease motif',motif:'B56-58,B101-103,C194-196',chemistry:'reduced',chemistry_positions:'B57,B102,C195',rmsd:2,limit:100,cpu:'auto',database_ids:['0']},chemistry_help:'',busy:false,
  databases:[{id:'0',name:'Example · two structures',available:true,example:true},{id:'1',name:'Homo sapiens proteome (AFDB v4)',available:true,example:false},{id:'2',name:'AFDB50',available:true,example:false}],
  results:{query:{motif:'B56-58,B101-103,C194-196',chemistry:'reduced',chemistry_positions:'B57,B102,C195',rmsd:2,limit:100,database_ids:['1']},retained_placements:42,possibly_capped:false,
    top_hits:accessions.map((accession,i)=>({target_id:'AF-'+accession+'-F1-model_v4',rmsd:.2+i/10,uniprot_accession:accession,annotation:'Serine protease'}))},
  viewer:{hit_rank:1,chains:['A','B','C'],visible_chains:['A','B','C'],query:false,target:true,motif_only:false,sidechains:true}};
const databaseIds={example:['0'],human:['1'],afdb50:['2']};
function sameView(got,want){
  if(!got||got.action!==want.action)return false;
  for(const key of new Set([...Object.keys(got),...Object.keys(want)])){
    if(key==='action')continue;const g=got[key],w=want[key];
    if(key==='color'&&w==='*'){if(!/^#[\da-f]{6}$/i.test(g||''))return false;continue;}
    if(want.action==='zoom'&&key==='factor'){const factor=g??1.5;if(factor===1||(factor>1)!==((w??1.5)>1))return false;continue;}
    if(want.action==='rotate'&&((key==='angle'&&(g??90)===(w??90))||(key==='axis'&&(g??'y')===(w??'y'))))continue;
    if(JSON.stringify(g)!==JSON.stringify(w))return false;
  }
  return true;
}
const lower=value=>String(value??'').toLowerCase().trim();
const totals={},failures=[],times=[];
const count=(group,ok)=>{const t=totals[group]||={right:0,total:0};t.total++;if(ok)t.right++;};
let done=0;
for(const file of argv){
  const rows=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  // An even stride keeps every group represented when a limit is set.
  const stride=Math.max(1,Math.ceil(rows.length/limit));
  for(let r=0;r<rows.length;r+=stride){
    const row=rows[r],commands=[],offered=[];let calls=0;
    const api={state:()=>state,viewerCommand:async input=>{commands.push(input);return {ok:true};},setQuery:async()=>state.query,loadStructure:async()=>state.query,run:async()=>({status:'done'})};
    const llm={backend,createChatCompletion:async params=>{
      if(++calls>1)throw Error('first decision only');
      offered.push(...(params.tools||[]).map(tool=>tool.function.name));const {abortSignal,...body}=params;
      const response=await realFetch(server+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','X-JMFS-Guide':'1'},body:JSON.stringify({...body,request_id:crypto.randomUUID()})});
      const result=await response.json();if(!response.ok)throw Error(result.error);times.push(result.timings.elapsed_ms);return result;}};
    const agent=createAgent(api,{privateMode:()=>true});let thrown;
    try{await agent.turn(row.text,llm);}catch(error){thrown=error.message;}
    const first=agent.trace[0],args=first?JSON.parse(first.args):null;let ok,detail;
    if(row.kind==='view'){
      ok=row.accept.some(want=>sameView(commands[0],want));detail=commands[0]?JSON.stringify(commands[0]):first?first.name+' '+first.args:offered.includes('protein_view')?thrown||'no call':'display tool not offered by the keyword gate';
      count('view · '+row.group,ok);
    }else if(row.kind==='search'){
      const want=row.accept,tool=first?.name==='search_motif',name=tool&&lower(args.name)===want.name,organism=tool&&want.organism.includes(lower(args.organism)),database=tool&&JSON.stringify(args.database_ids)===JSON.stringify(databaseIds[want.database]);
      ok=tool&&name&&organism&&database;detail=first?first.name+' '+first.args:offered.includes('search_motif')?thrown||'no call':'search tool not offered by the keyword gate';
      count('search · tool chosen',tool);count('search · enzyme name without species',name);count('search · organism',organism);count('search · database',database);
    }else{
      ok=first?.name==='annotate_hits';detail=first?first.name+' '+first.args:offered.includes('annotate_hits')?thrown||'no call':'annotation tool not offered by the keyword gate';
    }
    count(row.kind+' · whole command',ok);count('all commands',ok);
    if(!ok)failures.push({kind:row.kind,group:row.group,text:row.text,got:detail});
    if(++done%50===0)console.error(done+' scored…');
  }
}
times.sort((a,b)=>a-b);
const summary={label,backend:backend||'browser prompt',scored:done,median_ms:Math.round(times[times.length>>1]||0),p90_ms:Math.round(times[Math.floor(times.length*.9)]||0),
  accuracy:Object.fromEntries(Object.entries(totals).sort().map(([group,t])=>[group,t.right+'/'+t.total+' ('+Math.round(100*t.right/t.total)+'%)'])),failures};
fs.writeFileSync(new URL('results-'+label+'.json',import.meta.url),JSON.stringify(summary,null,1)+'\n');
console.log(JSON.stringify({...summary,failures:failures.slice(0,12)},null,1));
