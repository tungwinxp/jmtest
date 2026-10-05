import {createAgent} from './agent.js?v=28';
import {loadLocalModel,guideGpuAvailable,GEMMA_URL,MODEL_URL,forgetModel} from './model.js?v=28';
export async function mountGuide(api,config={},enabled=false){
  const panel=document.querySelector('.panel');
  const box=document.createElement('section');box.className='group guide';
  box.innerHTML=`<div class="bar"><h2>Local AI Guide</h2><button id="guideToggle" aria-expanded="false" aria-controls="guideBody">Open guide</button></div>
  <div id="guideBody" hidden><div class="guidePrivacy"><label class="toggle"><input id="guidePrivate" type="checkbox" checked> No uploads</label><details><summary>Privacy</summary><p class="hint">Chat and computation stay on this computer. Public reference lookups contact UniProt, AlphaFold and RCSB with the requested name or ID. Files, sequences and motifs stay local while No uploads is enabled.</p></details></div>
  <div id="guideMessages" role="log" aria-live="polite" aria-label="Guide conversation"></div>
  <form id="guideForm"><label for="guideInput">Message the local guide</label><textarea id="guideInput" maxlength="1200" rows="3" placeholder="Ask about a motif, a result, or change the protein view…"></textarea><p class="hint" style="margin-bottom:8px">Examples — click to insert: <a id="guideExample" href="#guideInput">Search a catalytic motif</a> · <a class="guidePrompt" href="#guideInput" data-prompt="Show me just the motif.">Show just the motif</a> · <a class="guidePrompt" href="#guideInput" data-prompt="Do any of these hits bind to sugars? Check the annotations and cite the evidence.">Check sugar binding</a></p>
  <div class="bar"><button id="guideSend" type="submit">Send</button><button id="guideStop" type="button" hidden>Stop</button><button id="guideLoad" type="button">Enable local AI · 418 MB</button></div></form>
  <progress id="guideProgress" max="1" hidden aria-label="Local AI download progress"></progress><p id="guideStatus" class="status" role="status"></p><details><summary>Guide settings</summary><button id="guideGemma" hidden>Use Gemma E2B with WebGPU · 1.73 GB</button><button id="guideSmall" hidden>Use smaller CPU guide</button><p class="hint">Models and fetched database data are cached in this browser. Clearing site data removes them.</p><label for="guideMcp">RCSB MCP address</label><input id="guideMcp" type="text" placeholder="https://…/mcp" spellcheck="false"><button id="guideConnect">Use address</button><p class="hint">Query setup uses verified source annotations. PDB discovery requires a connected RCSB MCP server.</p></details></div>`;
  panel.querySelector('header').after(box);
  const $=id=>document.getElementById(id),status=(text,data)=>{
    $('guideStatus').textContent=text;
    if(data?.total){$('guideProgress').hidden=false;$('guideProgress').value=data.loaded/data.total;}
    else $('guideProgress').hidden=true;
  };
  const privateMode=()=>document.getElementById('guidePrivate').checked;
  const gpu=await guideGpuAvailable(),preferred=localStorage.getItem('jmfs-guide-model');
  let llm,loading,abort,loadAbort,turnBusy=false,modelKind=preferred==='small'?'small':gpu?'gemma':'small',agent=createAgent(api,{...config,privateMode});
  $('guideLoad').textContent=modelKind==='gemma'?'Enable local AI · 1.73 GB':'Enable local AI · 418 MB';
  $('guidePrivate').checked=localStorage.getItem('jmfs-guide-private')!=='off';
  $('guidePrivate').onchange=()=>localStorage.setItem('jmfs-guide-private',$('guidePrivate').checked?'on':'off');
  const say=(role,text)=>{const p=document.createElement('p');p.className=role;p.textContent=text;$('guideMessages').append(p);$('guideMessages').scrollTop=$('guideMessages').scrollHeight;return p;};
  say('assistant','Hello! I’m your local JumpMASTER guide. I can help find motifs, explain hits, and adjust the protein view. Try an example below, or tell me what you’d like to explore.');
  $('guideMcp').value=config.rcsbMcpUrl||'';
  $('guideExample').onclick=event=>{event.preventDefault();$('guideInput').value='Search the catalytic motif of human chymotrypsin on the human database.';$('guideInput').focus();};
  box.querySelectorAll('.guidePrompt').forEach(link=>link.onclick=event=>{event.preventDefault();$('guideInput').value=link.dataset.prompt;$('guideInput').focus();});
  $('guideConnect').onclick=async()=>{await agent.close();agent=createAgent(api,{...config,privateMode,rcsbMcpUrl:$('guideMcp').value.trim()});status('MCP address saved for this page. Ask for a PDB lookup to connect.');};
  const busy=value=>{$('guideSend').disabled=$('guideLoad').disabled=$('guideGemma').disabled=$('guideSmall').disabled=value;$('guideStop').hidden=!value;};
  async function enable(kind=modelKind){
    if(kind!==modelKind&&api.state().busy)throw Error('Wait for the JMFS search before changing models.');
    if(kind!==modelKind&&llm){await llm.exit();llm=null;}
    modelKind=kind;
    localStorage.setItem('jmfs-guide-model',kind);
    if(llm)return llm;if(loading)return loading;
    loadAbort=new AbortController();busy(true);
    navigator.storage?.persist?.().catch(()=>{});
    loading=loadLocalModel(status,loadAbort.signal,kind==='gemma'?GEMMA_URL:undefined,kind==='gemma'?{n_gpu_layers:99}:{}).then(model=>{llm=model;$('guideLoad').hidden=true;status(kind==='gemma'?'Local AI ready · Gemma E2B.':'Local AI ready · CPU/WASM. JMFS can use the GPU.');return model;}).catch(error=>{status(error.name==='AbortError'?'Loading stopped.':`Local AI could not load: ${error.message}. You can still use the query form.`);throw error;}).finally(()=>{loading=null;if(!turnBusy)busy(false);});
    return loading;
  }
  $('guideLoad').onclick=()=>enable().catch(()=>{});
  $('guideGemma').hidden=$('guideSmall').hidden=!gpu;
  $('guideGemma').onclick=()=>enable('gemma').catch(error=>status(error.message));
  $('guideSmall').onclick=()=>enable('small').catch(error=>status(error.message));
  $('guideToggle').onclick=()=>{const open=$('guideBody').hidden;$('guideBody').hidden=!open;$('guideToggle').textContent=open?'Close guide':'Open guide';$('guideToggle').setAttribute('aria-expanded',String(open));if(open)$('guideInput').focus();};
  $('guideStop').onclick=()=>{abort?.abort();loadAbort?.abort();};
  $('guideForm').onsubmit=async event=>{
    event.preventDefault();const text=$('guideInput').value.trim();if(!text)return;
    say('user',text);$('guideInput').value='';const reply=say('assistant','');abort=new AbortController();turnBusy=true;busy(true);
    const priorTrace=agent.trace.slice();
    try{
      // Every guide action is chosen by the local model.
      await agent.turn(text,llm||{createChatCompletion:async params=>{const model=await enable();return model.createChatCompletion(params);}},{signal:abort.signal,onText:value=>reply.textContent=value,onStatus:status});
      const actions=agent.trace.filter(item=>!priorTrace.includes(item));
      const addNote=text=>{const note=document.createElement('small');note.className='guideEvidence';note.textContent=text;reply.append(note);return note;};
      if(actions.some(a=>a.name==='run_jmfs_query'&&!a.result.error)){
        const result=api.state().results;
        if(result)addNote('Searched '+result.query.motif+' · '+result.retained_placements+' retained placements'+(result.possibly_capped?' · limit '+result.query.limit:'')+(result.top_hits[0]?' · best RMSD '+Number(result.top_hits[0].rmsd).toFixed(4)+' Å':''));
      }
      const evidence=actions.findLast(a=>a.name==='annotate_hits'&&!a.result.error)?.result;
      if(evidence){
        const note=addNote('Evidence checked: ');
        for(const entry of evidence.entries.filter(e=>e.source)){const link=document.createElement('a');link.href=entry.source;link.textContent=entry.accession;link.target='_blank';link.rel='noopener noreferrer';note.append(link,document.createTextNode(' '));}
        addNote(evidence.scope+' Missing binding annotations leave binding unknown.');
      }
      status('');
    }catch(error){reply.textContent=error.name==='AbortError'?'Stopped.':error.message;status('');}
    finally{turnBusy=false;busy(false);$('guideInput').focus();}
  };
  $('guideInput').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!turnBusy)$('guideForm').requestSubmit();}};
  if(enabled){$('guideToggle').click();enable().catch(()=>{});}
  return {enable,get agent(){return agent;},
    async clearConversation(){
      if(turnBusy)throw Error('Stop the guide before clearing the conversation.');
      await agent.close();agent=createAgent(api,{...config,privateMode,rcsbMcpUrl:$('guideMcp').value.trim()});
      $('guideMessages').replaceChildren();say('assistant','Hello! We’ve cleared the conversation. What would you like to explore?');
    },
    async forgetModel(url){
      if(turnBusy)throw Error('Stop the guide before removing its model.');
      if(url===(modelKind==='gemma'?GEMMA_URL:MODEL_URL)){
        loadAbort?.abort();await loading?.catch(()=>{});if(llm){await llm.exit();llm=null;}
        $('guideLoad').hidden=false;status('Local model removed. Enable the guide to download it again.');
      }
      await forgetModel(url);
    }
  };
}
