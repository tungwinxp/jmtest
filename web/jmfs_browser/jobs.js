import {resumable,backgroundDownloads,downloadJobs,prepareDownload,runDownload,pauseDownload,stopDownload,downloadedFile,progressText} from './downloads.js?v=28';
import {deleteCheckpoint} from './checkpoint.js?v=25';
import {rememberIndex,cachedDatabases,forgetDatabase} from './range_cache.js?v=28';

export async function mountJobs(api,transport){
  const section=document.createElement('section');section.className='group';
  section.innerHTML=`<details style="margin:0"><summary>Downloads and jobs</summary><label class="pair"><input id="resumeJobs" type="checkbox"> Save progress and resume on return</label><p class="hint">Keeps interrupted downloads, query settings and search checkpoints locally. Searches pause when this page closes.</p><label class="pair"><input id="backgroundDownloads" type="checkbox"> Continue downloads after closing this page</label><p id="backgroundHint" class="hint"></p></details><div id="savedJobs" aria-live="polite"></div><details id="localStorageDetails"><summary>Local storage</summary><p class="hint">Remove a database or AI model to free space. Only its JMFS browser copies are removed; files saved to Downloads remain.</p><div id="cachedFiles"></div><button id="clearChat">Clear chat context</button></details>`;
  document.querySelector('.panel .run').before(section);
  const resume=section.querySelector('#resumeJobs'),background=section.querySelector('#backgroundDownloads'),list=section.querySelector('#savedJobs');
  resume.checked=resumable();background.checked=backgroundDownloads();
  const registration=await navigator.serviceWorker?.getRegistration(),supported=Boolean(registration?.backgroundFetch);
  const settings=()=>{
    background.disabled=!supported||!resume.checked;
    section.querySelector('#backgroundHint').textContent=supported?'Browser-managed downloads only. Local GPU/CPU searches resume when you return.':'This browser needs the page open to download. Saved downloads can resume on return.';
    document.getElementById('searchPause').disabled=!resume.checked;
  };
  settings();
  const notice=message=>{document.getElementById('status').textContent=message;};
  const action=(label,callback)=>{
    const button=document.createElement('button');button.textContent=label;
    button.onclick=async()=>{button.disabled=true;try{await callback();}catch(error){notice(error.message);}finally{button.disabled=false;await refresh();}};
    return button;
  };
  async function refreshStorage(){
    const container=section.querySelector('#cachedFiles');container.replaceChildren();
    const {cachedModels,forgetModel}=await import('./ai/model.js?v=31');
    const [databases,models,downloads]=await Promise.all([cachedDatabases(),cachedModels(),downloadJobs()]);
    const items=new Map();
    for(const copy of [...databases,...models,...downloads]){
      const key=copy.kind==='model'?copy.url:'database:'+copy.name;
      const item=items.get(key)||{url:copy.url,name:copy.name,kind:copy.kind,bytes:0,copies:[]};
      item.bytes+=copy.loaded??copy.bytes;item.copies.push(copy);items.set(key,item);
    }
    for(const item of items.values()){
      const row=document.createElement('div');row.className='cache-row';
      const name=document.createElement('span');name.textContent=(item.kind==='model'?'AI · ':'Database · ')+item.name.replace(/^[a-f\d]{40}_/,'')+' · '+(item.bytes/1e6).toFixed(1)+' MB';
      row.append(name,action('Remove',async()=>{
        if(api.state().busy)throw Error('Pause or stop the search before removing its data.');
        if(item.kind==='model')await (window.jmfsGuide?window.jmfsGuide.forgetModel(item.url):forgetModel(item.url));
        for(const job of await downloadJobs())if(item.kind==='model'?job.url===item.url:job.kind!=='model'&&job.name===item.name)await stopDownload(job.key);
        if(item.kind!=='model'){for(const copy of item.copies)await forgetDatabase(copy);api.forgetIndex?.(item.name);}
        notice('Removed '+item.name+' from JMFS browser storage.');await refreshStorage();
      }));container.append(row);
    }
    if(!items.size)container.textContent='No cached databases or AI models.';
  }
  section.querySelector('#localStorageDetails').ontoggle=()=>{if(section.querySelector('#localStorageDetails').open)refreshStorage().catch(error=>notice(error.message));};
  section.querySelector('#clearChat').onclick=()=>window.jmfsGuide?window.jmfsGuide.clearConversation().then(()=>notice('Command transcript cleared. Models and databases kept.')).catch(error=>notice(error.message)):notice('No guide context is loaded.');
  function row(title,progress,state){
    const item=document.createElement('div');item.className='job-row';
    const name=document.createElement('p');name.textContent=title;
    const bar=document.createElement('progress');bar.max=1;bar.value=progress;bar.setAttribute('aria-label',title+' progress');
    const note=document.createElement('p');note.className='hint';note.textContent=state;
    const controls=document.createElement('div');controls.className='job-controls';item.append(name,bar,note,controls);list.append(item);return controls;
  }
  async function finishIndex(job){
    const stored=await downloadedFile(job),file=new File([stored],job.name);
    await rememberIndex(file);api.addIndex(file);
    const link=document.createElement('a');link.href=URL.createObjectURL(file);link.download=job.name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  }
  async function startDownload(job){
    notice('Downloading '+job.name+'…');
    await runDownload(job,{background:backgroundDownloads()});
    if(job.kind==='index')await finishIndex(job);
    else notice('Model download is ready. Enable the Local AI Guide to use it.');
  }
  let refreshing=false,polling=true;
  const rates=new Map();
  async function refresh(){
    if(refreshing)return;refreshing=true;
    try{
      const [job,downloads]=await Promise.all([transport.savedJob(),downloadJobs()]);
      const active=[];
      for(const download of downloads){
        const bg=await registration?.backgroundFetch?.get(download.key);let loaded=download.loaded;
        if(bg)loaded=Math.min(download.bytes,download.loaded+bg.downloaded);
        const prior=rates.get(download.key);let eta=prior?.eta;
        if(prior&&loaded>prior.loaded)eta=(download.bytes-loaded)*(performance.now()-prior.time)/(loaded-prior.loaded);
        if(!prior||loaded!==prior.loaded)rates.set(download.key,{loaded,time:performance.now(),eta});
        active.push({download,bg,loaded,eta});
      }
      polling=active.some(item=>item.bg||item.download.status==='running');
      // Keep controls in place while focused; polling must not steal keyboard focus.
      if(list.contains(document.activeElement))return;
      list.replaceChildren();
      if(job){
        const controls=row('Local structural search',job.progress||0,job.status==='running'&&!api.state().busy?'Interrupted · ready to resume':job.status+(job.error?' · '+job.error:''));
        if(api.state().busy)controls.append(action('Pause',()=>transport.pause()));
        else if(job.status==='complete')controls.append(action('Show results',()=>api.restoreJob(job)));
        else controls.append(action('Resume',()=>api.resumeJob(job)));
        controls.append(action('Stop',async()=>{await transport.stop();await deleteCheckpoint('workbench-job');}));
      }
      for(const {download,bg,loaded,eta} of active){
        const controls=row(download.name,loaded/download.bytes,download.status+' · '+progressText(loaded,download.bytes,download.status==='complete'?0:eta)+(download.error?' · '+download.error:''));
        if(download.status==='running'||bg)controls.append(action('Pause',()=>pauseDownload(download.key)));
        else if(download.status!=='complete')controls.append(action('Resume',()=>startDownload(download)));
        else controls.append(action(download.kind==='index'?'Save to Downloads':'Enable guide',async()=>download.kind==='index'?finishIndex(download):(await window.jmfsOpenGuide()).enable()));
        controls.append(action('Stop',()=>stopDownload(download.key)));
      }
    }catch(error){notice('Saved job storage: '+error.message);}finally{refreshing=false;}
  }
  resume.onchange=async()=>{
    localStorage.setItem('jmfs-resume',resume.checked?'on':'off');
    if(!resume.checked){background.checked=false;localStorage.setItem('jmfs-background-downloads','off');await transport.stop();await deleteCheckpoint('workbench-job');for(const job of await downloadJobs())if(job.status!=='complete')await stopDownload(job.key);}
    settings();await refresh();
  };
  background.onchange=async()=>{
    localStorage.setItem('jmfs-background-downloads',background.checked?'on':'off');
    if(!background.checked)for(const job of await downloadJobs())if(await registration?.backgroundFetch?.get(job.key))await pauseDownload(job.key);
    await refresh();
  };
  // Ordinary Save index still uses the browser download manager unless resumability was chosen.
  document.getElementById('databases').addEventListener('click',event=>{
    const link=event.target.closest('a[download]');if(!link||!resume.checked)return;
    event.preventDefault();
    prepareDownload({url:link.href,name:link.download||'database.jmfsgeom'}).then(startDownload).catch(error=>notice(error.message));
  });
  window.addEventListener('jmfs-job',refresh);window.addEventListener('jmfs-download',refresh);
  navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='jmfs-download')refresh();});
  // Job and download events refresh the list; the timer only tracks work in progress.
  const timer=setInterval(()=>{if(!document.hidden&&(polling||api.state().busy))refresh();},1000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  await refresh();
  const saved=await transport.savedJob();
  if(saved?.status==='running'&&resume.checked)api.resumeJob(saved).catch(error=>notice(error.message));
  else if(saved?.status==='complete'&&resume.checked)await api.restoreJob(saved);
}
