import {resumable,backgroundDownloads,downloadJobs,prepareDownload,runDownload,pauseDownload,stopDownload,downloadedFile,progressText} from './downloads.js?v=25';
import {deleteCheckpoint} from './checkpoint.js?v=25';
import {rememberIndex} from './range_cache.js';

export async function mountJobs(api,transport){
  const section=document.createElement('section');section.className='group';
  section.innerHTML=`<details style="margin:0"><summary>Downloads and jobs</summary><label class="pair"><input id="resumeJobs" type="checkbox"> Save progress and resume on return</label><p class="hint">Keeps interrupted downloads, query settings and search checkpoints locally. Searches pause when this page closes.</p><label class="pair"><input id="backgroundDownloads" type="checkbox"> Continue downloads after closing this page</label><p id="backgroundHint" class="hint"></p></details><div id="savedJobs" aria-live="polite"></div>`;
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
  let refreshing=false;
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
        else controls.append(action(download.kind==='index'?'Save to Downloads':'Enable guide',()=>download.kind==='index'?finishIndex(download):window.jmfsGuide.enable()));
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
  const timer=setInterval(refresh,1000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  await refresh();
  const saved=await transport.savedJob();
  if(saved?.status==='running'&&resume.checked)api.resumeJob(saved).catch(error=>notice(error.message));
  else if(saved?.status==='complete'&&resume.checked)await api.restoreJob(saved);
}
