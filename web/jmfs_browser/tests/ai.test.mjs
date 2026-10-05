import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHints,draftFromHints,makeTools} from '../ai/tools.js';
import {createAgent,forModel} from '../ai/agent.js';
import {pdbId,cifAtoms} from '../structure.js';
import {parsePdb} from '../query.js';
import {HttpRangeSource} from '../jmfs_index.js';
import {supportedGuideGpu,firstToolCall} from '../ai/model.js';

test('Lightweight guide GPU selection accepts Apple Metal and NVIDIA, rejects fallback adapters',()=>{
  assert(supportedGuideGpu({vendor:'apple',architecture:'metal-3',isFallbackAdapter:false},8));
  assert(supportedGuideGpu({vendor:'nvidia',architecture:'ada',isFallbackAdapter:false},8));
  assert(!supportedGuideGpu({vendor:'nvidia',isFallbackAdapter:true},8));
  assert(supportedGuideGpu({vendor:'nvidia'},4));
  assert(!supportedGuideGpu({vendor:'nvidia'},2));
  assert(!supportedGuideGpu(undefined,8));
});

test('Explicit intent, reference organism and target database remain separate',()=>{
  const state={databases:[{id:'0',name:'Example',available:true,example:true},{id:'1',name:'Homo sapiens',available:true}]};
  const hints=parseHints('Search a bovine enzyme on the human database at RMSD 1.5 Å');
  assert.deepEqual(draftFromHints(hints,state),{database_ids:['1'],rmsd:1.5});
  assert.equal(parseHints('Set RMSD to 1 Å but do not run the search').run,false);
  assert.equal(parseHints('Explain why the search found these hits').run,false);
  assert.equal(pdbId('PDB_00004CHA'),'pdb_00004cha');
  assert.throws(()=>pdbId('pdb_123'),/PDB ID/);
});

test('mmCIF retains author chains, labels, physical runs and first model',()=>{
  const cif=`data_test
loop_
_atom_site.group_PDB
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.auth_asym_id
_atom_site.label_seq_id
_atom_site.auth_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.pdbx_PDB_model_num
ATOM CA . HIS X AB 1 57 1 2 3 1
ATOM CA B HIS X AB 1 57 8 8 8 1
ATOM CA . ASP Y AB 2 102 4 5 6 1
ATOM CA . SER Z C 3 195 7 8 9 1
ATOM CA . SER Z C 3 195 9 9 9 2
#`;
  assert.equal(cifAtoms(cif).length,5);
  const rows=parsePdb(cif,{residueCode:()=>0});
  assert.deepEqual(rows.map(r=>[r.chain,r.resSeq,r.sourceRun,r.coord]),[['AB',57,0,[1,2,3]],['AB',102,1,[4,5,6]],['C',195,2,[7,8,9]]]);
});

test('Range reads verify intervals and reject silent full downloads',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response(new Uint8Array(4),{status:206,headers:{'Content-Range':'bytes 4-7/16'}});
    await assert.rejects(new HttpRangeSource('https://example.invalid/index').read(0,4),/does not match/);
    globalThis.fetch=async()=>new Response(new Uint8Array(4),{status:200});
    await assert.rejects(new HttpRangeSource('https://example.invalid/index').read(0,4),/ignored HTTP Range/);
  }finally{globalThis.fetch=original;}
});

test('Model calls are validated; setup-only cannot run and private mode blocks uploads',async()=>{
  const {z}=await import('../ai/assets/vendor.js');const {schemas}=makeTools(z);
  assert.throws(()=>schemas.set_jmfs_query.parse({database_ids:['https://evil.invalid']}));
  assert.throws(()=>schemas.set_jmfs_query.parse({unexpected:1}));
  let runs=0,queries=0;
  const api={state:()=>({query:{motif:'A1-3',database_ids:['0'],rmsd:2},databases:[{id:'0',name:'Example',example:true,available:true}],results:null}),run:()=>{runs++;},setQuery:()=>{queries++;}};
  let calls=0;
  const llm={createChatCompletion:async params=>{assert.equal(params.temperature,0);assert.equal(params.seed,0);assert.match(params.messages[0].content,/Preserve verified motif ranges exactly/);return {choices:[{message:++calls===1?{role:'assistant',tool_calls:[{id:'1',function:{name:'run_jmfs_query',arguments:'{}'}}]}:{role:'assistant',content:'Setup only.'}}]};}};
  const agent=createAgent(api);await agent.turn('Prepare this query but do not run the search',llm);
  assert.equal(runs,0);assert.match(agent.trace[0].result.error,/explicitly ask/);
  calls=0;
  const uploadModel={createChatCompletion:async()=>({choices:[{message:++calls===1?{role:'assistant',tool_calls:[{id:'2',function:{name:'pdb_sequence_search',arguments:JSON.stringify({mode:'motif',pattern:'N-X-S'})}}]}:{role:'assistant',content:'Kept local.'}}]})};
  await agent.turn('Search this sequence in the PDB',uploadModel);
  assert.match(agent.trace.at(-1).result.error,/No uploads/);assert.equal(queries,0);
});

test('Viewer actions and ligand evidence use tools without launching a search or uploading structures',async()=>{
  const commands=[],requests=[];let runs=0;
  const api={state:()=>({query:{motif:'A1-3',database_ids:['0']},databases:[],viewer:{chains:['query_A','target_B']},results:{top_hits:[{target_id:'AF-P12345-F1',uniprot_accession:'P12345'},{target_id:'custom.pdb'}]}}),viewerCommand:input=>{commands.push(input);return {motif_only:true};},run:()=>{runs++;}};
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async(url,options)=>{requests.push({url,options});return Response.json({entryType:'UniProtKB reviewed (Swiss-Prot)',comments:[{commentType:'FUNCTION',texts:[{value:'Binds a carbohydrate',evidences:[{evidenceCode:'ECO:0000269',source:'PubMed',id:'1234'}]}]}],features:[]});};
    const agent=createAgent(api);let calls=0;
    const llm={createChatCompletion:async()=>({choices:[{message:++calls===1?{role:'assistant',tool_calls:[{id:'view',function:{name:'protein_view',arguments:'{"action":"motif"}'}},{id:'evidence',function:{name:'annotate_hits',arguments:'{}'}}]}:{role:'assistant',content:'Motif shown; evidence checked.'}}]})};
    await agent.turn('Show just the motif and check whether these hits bind sugars',llm);
    assert.deepEqual(commands,[{action:'motif'}]);assert.equal(runs,0);
    assert.equal(requests[0].url,'https://rest.uniprot.org/uniprotkb/P12345.json');assert.equal(requests[0].options.body,undefined);
    const result=agent.trace[1].result;assert.equal(result.entries[0].comments[0].texts[0].evidences[0].id,'1234');assert.deepEqual(result.unidentified,['custom.pdb']);assert.match(result.note,/unknown/);
  }finally{globalThis.fetch=original;}
});

test('Simple viewer requests use one cached inference and retry failed actions',async()=>{
  let calls=0,fail=true;const menus=[];
  const api={state:()=>({query:{motif:'A1-3',database_ids:['0']},databases:[],results:null}),viewerCommand:()=>{if(fail){fail=false;throw Error('Try again');}return {motif_only:true};}};
  const llm={createChatCompletion:async params=>{calls++;assert.equal(params.cache_prompt,true);assert.equal(params.chat_template_kwargs.enable_thinking,false);menus.push(JSON.stringify(params.tools));assert.deepEqual(params.tools.map(t=>t.function.name),['protein_view']);return {choices:[{message:{role:'assistant',tool_calls:[{id:String(calls),function:{name:'protein_view',arguments:'{"action":"motif"}'}}]}}]};}};
  const agent=createAgent(api);await agent.turn('Show just the motif',llm);
  assert.equal(calls,2);assert.equal(menus[0],menus[1]);assert.match(agent.trace[0].result.error,/Try again/);
  calls=0;await agent.turn('Show just the motif',llm);assert.equal(calls,1);
});

test('Greetings reply immediately without loading or invoking a model',async()=>{
  const agent=createAgent({state:()=>{throw Error('A greeting needs no query state');}});
  assert.match(await agent.turn('Hello!',{createChatCompletion:()=>{throw Error('No greeting inference');}}),/^Hello!/);
});

test('Commands carry current state without previous chat turns and bound generation',async()=>{
  const api={state:()=>({query:{motif:'A1-3',database_ids:['0']},databases:[],results:null})};
  let calls=0;
  const llm={createChatCompletion:async params=>{
    calls++;assert.equal(params.messages.length,2);assert.equal(params.max_tokens,128);
    assert.equal(params.messages[1].content,calls===1?'Explain the query':'Explain reduced chemistry');
    return {choices:[{message:{role:'assistant',content:'Current settings explained.'}}]};
  }};
  const agent=createAgent(api);
  await agent.turn('Explain the query',llm);await agent.turn('Explain reduced chemistry',llm);
  assert.equal(calls,2);
});

test('Native companion cancellation and page closure release the fixed model',async()=>{
  const {localMlx}=await import('../ai/native.js');
  const previous={fetch:globalThis.fetch,add:globalThis.addEventListener,remove:globalThis.removeEventListener};
  const events=new EventTarget(),requests=[];
  globalThis.addEventListener=events.addEventListener.bind(events);
  globalThis.removeEventListener=events.removeEventListener.bind(events);
  globalThis.fetch=async(url,options={})=>{
    const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):undefined;requests.push({path,body});
    if(path==='/health')return Response.json({backend:'mlx',model:'mlx-community/MiniCPM5-1B-4bit'});
    if(path==='/v1/chat/completions')return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true}));
    return Response.json({});
  };
  try{
    const native=await localMlx(()=>{}),abort=new AbortController();
    const inference=native.createChatCompletion({messages:[],abortSignal:abort.signal});
    abort.abort();await assert.rejects(inference,{name:'AbortError'});
    const generated=requests.find(r=>r.path==='/v1/chat/completions');
    assert.equal(requests.find(r=>r.path==='/cancel').body.request_id,generated.body.request_id);
    events.dispatchEvent(new Event('pagehide'));
    assert(requests.some(r=>r.path==='/release'));
    await native.exit();
  }finally{
    globalThis.fetch=previous.fetch;
    previous.add?globalThis.addEventListener=previous.add:delete globalThis.addEventListener;
    previous.remove?globalThis.removeEventListener=previous.remove:delete globalThis.removeEventListener;
  }
});

test('WebGPU streaming stops at one complete tool call before repeated output',async()=>{
  let cancelled=false;
  const llm=firstToolCall({createChatCompletion:async params=>{
    params.onData({choices:[{delta:{tool_calls:[{index:0,id:'view',function:{name:'protein_view',arguments:'{"action":'}}]}}]});
    assert(!params.abortSignal.aborted);
    params.onData({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"motif"}'}}]}}]});
    cancelled=params.abortSignal.aborted;if(cancelled)throw new DOMException('Stopped','AbortError');
    throw Error('Repeated output must not run');
  }});
  const response=await llm.createChatCompletion({tools:[{function:{name:'protein_view',parameters:{required:['action']}}}]});
  assert(cancelled);assert.equal(response.choices[0].message.tool_calls.length,1);
  assert.deepEqual(JSON.parse(response.choices[0].message.tool_calls[0].function.arguments),{action:'motif'});
});

test('Small-model view calls keep what the chosen action takes; annotation answers read compact records',async()=>{
  const commands=[],state={query:{motif:'A1-3',chemistry_positions:'',database_ids:['0']},databases:[{id:'0',name:'Example',available:true,example:true}],viewer:{chains:['A']},
    results:{query:{motif:'A1-3',limit:100},retained_placements:1,possibly_capped:false,top_hits:[{target_id:'AF-P12345-F1',rmsd:.5,uniprot_accession:'P12345'}]}};
  const api={state:()=>state,viewerCommand:async input=>{commands.push(input);return {ok:true};}};
  const view=args=>({createChatCompletion:async()=>({choices:[{message:{role:'assistant',tool_calls:[{id:'view',function:{name:'protein_view',arguments:JSON.stringify(args)}}]}}]})});
  await createAgent(api).turn('Zoom in.',view({action:'zoom_in',factor:1,query:false,sidechains:false}));
  await createAgent(api).turn('Show hit 1.',view({action:'select_hit',hit_rank:1,target:false,color:'red',dx:.5}));
  await createAgent(api).turn('Show only the motif without side chains.',view({action:'motif',sidechains:false,hit_rank:1}));
  await createAgent(api).turn('Hide the target.',view({action:'target',target:false,sidechains:true}));
  assert.deepEqual(commands,[{action:'zoom',factor:2},{action:'select_hit',hit_rank:1},{action:'motif',sidechains:false},{action:'query'}]);
  const original=globalThis.fetch,site=position=>({type:'Binding site',location:{start:{value:position},end:{value:position}},ligand:{name:'Ca(2+)'},evidences:[{evidenceCode:'ECO:0000250',source:'UniProtKB',id:'P00760'}]});
  try{
    globalThis.fetch=async()=>Response.json({entryType:'UniProtKB reviewed (Swiss-Prot)',proteinDescription:{recommendedName:{fullName:{value:'Serine protease 1'}}},comments:[{commentType:'COFACTOR',cofactors:[{name:'Ca(2+)'}]}],features:[site(75),site(77)],keywords:[{name:'Calcium'}]});
    const agent=createAgent(api),seen=[];
    const llm={createChatCompletion:async params=>{seen.push(params);return {choices:[{message:seen.length===1?{role:'assistant',tool_calls:[{id:'evidence',function:{name:'annotate_hits',arguments:'{}'}}]}:{role:'assistant',content:'Serine protease 1 binds calcium by similarity.'}}]};}};
    assert.equal(await agent.turn('Do any of these hits bind calcium?',llm),'Serine protease 1 binds calcium by similarity.');
    assert.deepEqual(seen[0].tools.map(tool=>tool.function.name),['annotate_hits']);assert.doesNotMatch(seen[0].messages[0].content,/AF-P12345/);
    assert.equal(seen[1].tools,undefined);assert.equal(seen[1].messages.length,2);
    assert.match(seen[1].messages[0].content,/"binding_sites":\[\{"ligand":"Ca\(2\+\)","positions":"75,77","evidence":"by similarity"\}\]/);
    assert.equal(agent.trace[0].result.entries[0].binding_sites[0].evidences[0].id,'P00760');
    assert.deepEqual(forModel('run_jmfs_query',{status:'done'}),{status:'done'});
  }finally{globalThis.fetch=original;}
});
