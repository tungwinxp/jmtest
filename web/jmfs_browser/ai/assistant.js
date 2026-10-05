import {createAgent} from './agent.js?v=30';
import {loadLocalModel,guideGpuAvailable,MODEL_URL,forgetModel,removeRetiredModel} from './model.js?v=31';
export async function mountGuide(api,config={},enabled=false){
  const panel=document.querySelector('.panel');
  const box=document.createElement('section');box.className='group guide';
  box.innerHTML=`<div class="bar"><h2>Local AI Guide</h2><button id="guideToggle" aria-expanded="false" aria-controls="guideBody">Open guide</button></div>
  <div id="guideBody" hidden><div class="guidePrivacy"><label class="toggle"><input id="guidePrivate" type="checkbox" checked> No uploads</label><details><summary>Privacy</summary><p class="hint">Chat and computation stay on this computer. Public reference lookups contact UniProt, AlphaFold and RCSB with the requested name or ID. Files, sequences and motifs stay local while No uploads is enabled.</p></details></div>
  <div id="guideMessages" role="log" aria-live="polite" aria-label="Guide conversation"></div>
  <form id="guideForm"><label for="guideInput">Give the local guide a command</label><textarea id="guideInput" maxlength="1200" rows="3" placeholder="Find a motif, check hits, or change the protein view…"></textarea><p class="hint">Each command uses the current workbench state. Previous messages aren’t sent to the model.</p><p class="hint" style="margin-bottom:8px">Examples — click to insert: <a id="guideExample" href="#guideInput">Search a catalytic motif</a> · <a class="guidePrompt" href="#guideInput" data-prompt="Show me just the motif.">Show just the motif</a> · <a class="guidePrompt" href="#guideInput" data-prompt="Do any of these hits bind to sugars? Check the annotations and cite the evidence.">Check sugar binding</a></p>
  <div class="bar"><button id="guideSend" type="submit">Send</button><button id="guideStop" type="button" hidden>Stop</button><button id="guideLoad" type="button">Enable local AI</button></div></form>
  <progress id="guideProgress" max="1" hidden aria-label="Local AI download progress"></progress><p id="guideStatus" class="status" role="status"></p><details><summary>Guide settings</summary><button id="guideRelease">Release AI from memory</button><p class="hint">The guide unloads after one idle minute, when hidden, or when this page closes. Cached files stay available. Apple Silicon uses MiniCPM5 1B MLX at 4-bit (618 MB including tokenizer); supported browser GPUs use MiniCPM5 Agentic v3 Q4 (688 MB). These are different checkpoints. Qwen has been removed.</p><details><summary>Start the MLX companion on this Mac</summary><p class="hint">From a checkout of JumpMASTER, run <code>sh web/jmfs_browser/ai/native/start.sh</code>, then enable the guide. Stop the companion with Ctrl-C. Its downloaded files are in that checkout’s <code>ai/native/.cache</code>; browser cache controls remove browser files only.</p></details><label for="guideMcp">RCSB MCP address</label><input id="guideMcp" type="text" placeholder="https://…/mcp" spellcheck="false"><button id="guideConnect">Use address</button><p class="hint">Query setup uses verified source annotations. PDB discovery requires a connected RCSB MCP server.</p></details></div>`;
  panel.querySelector('header').after(box);
  const $=id=>document.getElementById(id),status=(text,data)=>{
    $('guideStatus').textContent=text;
    if(data?.total){$('guideProgress').hidden=false;$('guideProgress').value=data.loaded/data.total;}
    else $('guideProgress').hidden=true;
  };
  const privateMode=()=>document.getElementById('guidePrivate').checked;
  removeRetiredModel().catch(()=>{});
  let gpu,llm,loading,abort,loadAbort,idleTimer,turnBusy=false,agent=createAgent(api,{...config,privateMode});
  $('guidePrivate').checked=localStorage.getItem('jmfs-guide-private')!=='off';
  $('guidePrivate').onchange=()=>localStorage.setItem('jmfs-guide-private',$('guidePrivate').checked?'on':'off');
  const say=(role,text)=>{const p=document.createElement('p');p.className=role;p.textContent=text;$('guideMessages').append(p);$('guideMessages').scrollTop=$('guideMessages').scrollHeight;return p;};
  say('assistant','Hello! I’m your local JumpMASTER guide. I can help find motifs, explain hits, and adjust the protein view. Try an example below, or tell me what you’d like to explore.');
  $('guideMcp').value=config.rcsbMcpUrl||'';
  $('guideExample').onclick=event=>{event.preventDefault();$('guideInput').value='Search the catalytic motif of human chymotrypsin on the human database.';$('guideInput').focus();};
  box.querySelectorAll('.guidePrompt').forEach(link=>link.onclick=event=>{event.preventDefault();$('guideInput').value=link.dataset.prompt;$('guideInput').focus();});
  $('guideConnect').onclick=async()=>{await agent.close();agent=createAgent(api,{...config,privateMode,rcsbMcpUrl:$('guideMcp').value.trim()});status('MCP address saved for this page. Ask for a PDB lookup to connect.');};
  const busy=value=>{window.jmfsGuideBusy=value;$('search').disabled=value||api.state().busy;$('guideSend').disabled=$('guideLoad').disabled=$('guideRelease').disabled=value;$('guideStop').hidden=!value;if(value)clearTimeout(idleTimer);};
  async function release(){
    clearTimeout(idleTimer);loadAbort?.abort();await loading?.catch(()=>{});
    const model=llm;llm=null;if(model)await model.exit();
    $('guideLoad').hidden=false;status('AI released from memory. Cached files are kept.');
  }
  const idle=()=>{clearTimeout(idleTimer);if(llm&&!turnBusy)idleTimer=setTimeout(()=>release().catch(error=>status(error.message)),60000);};
  async function enable(){
    if(api.state().busy)throw Error('Wait for the JMFS search before loading the guide.');
    if(llm)return llm;if(loading)return loading;
    loadAbort=new AbortController();busy(true);
    gpu??=await guideGpuAvailable();
    removeRetiredModel().catch(()=>{});
    navigator.storage?.persist?.().catch(()=>{});
    loading=loadLocalModel(status,loadAbort.signal,MODEL_URL,{n_gpu_layers:gpu?99:0,n_batch:512,n_ubatch:256,requireGpu:!gpu}).then(model=>{llm=model;$('guideLoad').hidden=true;status(model.backend==='mlx'?'Local AI ready · native MLX · MiniCPM5 1B · 4-bit · 618 MB.':'Local AI ready · WebGPU · MiniCPM5 Agentic v3 · Q4 · 688 MB.');idle();return model;}).catch(error=>{status(error.name==='AbortError'?'Loading stopped.':`Local AI could not load: ${error.message}. You can still use the query form.`);throw error;}).finally(()=>{loading=null;if(!turnBusy)busy(false);});
    return loading;
  }
  $('guideLoad').onclick=()=>enable().catch(()=>{});
  $('guideRelease').onclick=()=>release().catch(error=>status(error.message));
  $('guideToggle').onclick=()=>{const open=$('guideBody').hidden;$('guideBody').hidden=!open;$('guideToggle').textContent=open?'Close guide':'Open guide';$('guideToggle').setAttribute('aria-expanded',String(open));if(open)$('guideInput').focus();};
  document.addEventListener('visibilitychange',()=>{if(document.hidden){abort?.abort();release().catch(()=>{});}});
  addEventListener('pagehide',()=>{abort?.abort();release().catch(()=>{});});
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
      if(actions.some(a=>['run_jmfs_query','search_motif'].includes(a.name)&&!a.result.error)){
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
    finally{turnBusy=false;busy(false);idle();$('guideInput').focus();}
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
      if(url===MODEL_URL){
        loadAbort?.abort();await loading?.catch(()=>{});if(llm){await llm.exit();llm=null;}
        $('guideLoad').hidden=false;status('Local model removed. Enable the guide to download it again.');
      }
      await forgetModel(url);
    }
  };
}
