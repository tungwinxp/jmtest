import {loadCheckpoint,saveCheckpoint,deleteCheckpoint,listCheckpoints} from './checkpoint.js?v=25';

const BLOCK=8*1024*1024,controllers=new Map();
export const resumable=()=>localStorage.getItem('jmfs-resume')!=='off';
export const backgroundDownloads=()=>resumable()&&localStorage.getItem('jmfs-background-downloads')!=='off';
export function etaText(ms){
  if(!Number.isFinite(ms)||ms<0)return 'Estimating ETA…';
  const seconds=Math.ceil(ms/1000);return seconds<60?`ETA ${seconds}s`:`ETA ${Math.ceil(seconds/60)} min`;
}
export function progressText(loaded,total,ms){return `${Math.floor(100*loaded/Math.max(1,total))}% · ${(loaded/1e6).toFixed(1)} / ${(total/1e6).toFixed(1)} MB · ${etaText(ms)}`;}
async function folder(id){return (await navigator.storage.getDirectory()).getDirectoryHandle(id,{create:true});}
async function identifier(url){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url));return 'download:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}
function notify(job){if(typeof document!=='undefined')window.dispatchEvent(new CustomEvent('jmfs-download',{detail:job}));}
async function writeJob(job){await saveCheckpoint(job.key,job);notify(job);}
export const downloadJobs=()=>listCheckpoints('download:');
export async function prepareDownload({url,name,bytes,kind='index',immutable=false}){
  url=new URL(url,location.href).href;
  if(!['http:','https:'].includes(new URL(url).protocol))throw Error('Download requires an HTTP address.');
  const key=await identifier(url);let job=await loadCheckpoint(key);
  if(!immutable){
    const head=await fetch(url,{method:'HEAD',cache:'no-cache'});
    if(!head.ok)throw Error(`Download HEAD failed (${head.status}).`);
    const etag=head.headers.get('etag'),size=Number(head.headers.get('content-length'));
    if(!etag||!Number.isSafeInteger(size)||size<=0)throw Error('Resumable downloads need an ETag and file size.');
    if(job&&(job.etag!==etag||job.bytes!==size)){await stopDownload(key);job=null;}
    bytes=size;
    if(!job)job={key,url,name,bytes,kind,etag,blocks:[],loaded:0,status:'paused'};
  }
  job||={key,url,name,bytes,kind,immutable,blocks:[],loaded:0,status:'paused'};
  if(!Number.isSafeInteger(job.bytes)||job.bytes<=0)throw Error('Download size is missing.');
  await writeJob(job);return job;
}
function blockSize(job,offset){return Math.min(BLOCK,job.bytes-offset);}
export async function saveDownloadBlock(job,offset,response){
  const length=blockSize(job,offset);
  if(response.status!==206||response.headers.get('content-range')!==`bytes ${offset}-${offset+length-1}/${job.bytes}`){await response.body?.cancel();throw Error('Server returned an invalid byte range.');}
  if(job.etag&&response.headers.get('etag')!==job.etag){await response.body?.cancel();throw Error('The remote file changed. Start the download again.');}
  const dir=await folder(job.key),handle=await dir.getFileHandle(String(offset),{create:true});
  let received=0;
  await response.body.pipeThrough(new TransformStream({transform(bytes,controller){received+=bytes.length;if(received>length)throw Error('Download exceeded its byte range.');controller.enqueue(bytes);},flush(){if(received!==length)throw Error('Incomplete download range.');}})).pipeTo(await handle.createWritable());
  if((await handle.getFile()).size!==length){await dir.removeEntry(String(offset));throw Error('Incomplete download range.');}
  const current=await loadCheckpoint(job.key);
  if(!current||current.status==='stopped'){await dir.removeEntry(String(offset)).catch(()=>{});throw new DOMException('Stopped','AbortError');}
  job.status=current.status;
  if(!job.blocks.includes(offset)){job.blocks.push(offset);job.loaded+=length;}
  await writeJob(job);
}
export async function downloadedFile(job){
  const dir=await folder(job.key);
  try{const file=await (await dir.getFileHandle('complete')).getFile();if(file.size===job.bytes)return file;}catch{}
  if(job.loaded!==job.bytes)throw Error('Download is incomplete.');
  const handle=await dir.getFileHandle('complete',{create:true}),writer=await handle.createWritable();
  try{
    for(let offset=0;offset<job.bytes;offset+=BLOCK){
      const file=await(await dir.getFileHandle(String(offset))).getFile(),reader=file.stream().getReader();
      try{while(true){const {done,value}=await reader.read();if(done)break;await writer.write(value);}}finally{reader.releaseLock();}
    }
    await writer.close();
  }catch(error){await writer.abort();throw error;}
  for(const offset of job.blocks)await dir.removeEntry(String(offset));
  job.status='complete';await writeJob(job);return handle.getFile();
}
export async function runDownload(job,{signal,onProgress=()=>{},background=false}={}){
  if(controllers.has(job.key))throw Error('This download is already running.');
  if(job.status==='complete')return downloadedFile(job);
  const controller=new AbortController();let finished;
  controllers.set(job.key,{controller,done:new Promise(resolve=>finished=resolve)});
  const stop=()=>controller.abort();signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  const started=performance.now(),initial=job.loaded;
  const report=(loaded=job.loaded)=>{const moved=loaded-initial,eta=moved>0?(job.bytes-loaded)*(performance.now()-started)/moved:NaN;onProgress({loaded,total:job.bytes,etaMs:eta});};
  try{
    job.status='running';delete job.error;await writeJob(job);
    const registration=background?await navigator.serviceWorker.ready:null,manager=registration?.backgroundFetch;
    if(manager){
      let active=await manager.get(job.key);
      if(!active){
        const requests=[];
        for(let offset=0;offset<job.bytes;offset+=BLOCK)if(!job.blocks.includes(offset))requests.push(new Request(job.url,{headers:{Range:`bytes=${offset}-${offset+blockSize(job,offset)-1}`}}));
        if(requests.length)active=await manager.fetch(job.key,requests,{title:job.name,downloadTotal:job.bytes-job.loaded});
      }
      if(active){
        const base=job.loaded;const update=()=>report(Math.min(job.bytes,base+active.downloaded));active.addEventListener('progress',update);
        // The browser downloads; the service worker commits completed ranges, even after page close.
        try{
          while(true){
            controller.signal.throwIfAborted();update();
            const saved=await loadCheckpoint(job.key);if(!saved||saved.status==='stopped')throw new DOMException('Stopped','AbortError');
            if(saved.status==='complete'){Object.assign(job,saved);break;}
            if(saved.status==='paused'||saved.status==='error')throw Error(saved.error||'Download paused.');
            await new Promise(resolve=>setTimeout(resolve,500));
          }
        }finally{active.removeEventListener('progress',update);}
      }
    }else{
      report();
      for(let offset=0;offset<job.bytes;offset+=BLOCK){
        controller.signal.throwIfAborted();if(job.blocks.includes(offset))continue;
        const response=await fetch(job.url,{headers:{Range:`bytes=${offset}-${offset+blockSize(job,offset)-1}`},signal:controller.signal,cache:'no-store'});
        await saveDownloadBlock(job,offset,response);report();
      }
    }
    controller.signal.throwIfAborted();const file=await downloadedFile(job);report(job.bytes);return file;
  }catch(error){
    const saved=await loadCheckpoint(job.key);
    if(saved&&saved.status!=='complete'&&saved.status!=='stopped'){Object.assign(job,saved);job.status='paused';if(error.name!=='AbortError')job.error=error.message;await writeJob(job);}
    throw error;
  }finally{controllers.delete(job.key);signal?.removeEventListener('abort',stop);finished();}
}
export async function pauseDownload(key){
  const job=await loadCheckpoint(key);if(!job)return;
  job.status='paused';await writeJob(job);controllers.get(key)?.controller.abort();
  const registration=await navigator.serviceWorker?.getRegistration();await (await registration?.backgroundFetch?.get(key))?.abort();
}
export async function stopDownload(key){
  await pauseDownload(key);const job=await loadCheckpoint(key);if(!job)return;
  job.status='stopped';await writeJob(job);
  await controllers.get(key)?.done;
  // Active fetch handlers check stopped before committing another range.
  await navigator.storage.getDirectory().then(root=>root.removeEntry(key,{recursive:true})).catch(()=>{});
  await deleteCheckpoint(key);notify({...job,status:'stopped'});
}
export async function finishBackgroundDownload(event){
  const key=event.registration.id;let job=await loadCheckpoint(key);if(!job||job.status==='stopped')return;
  try{
    for(const record of await event.registration.matchAll()){
      const current=await loadCheckpoint(key);if(!current||current.status==='stopped')return;
      job={...current,blocks:[...current.blocks]};
      const offset=Number(record.request.headers.get('range')?.match(/^bytes=(\d+)-/)?.[1]);
      if(!Number.isSafeInteger(offset)||job.blocks.includes(offset))continue;
      try{await saveDownloadBlock(job,offset,await record.responseReady);}catch(error){job.error=error.message;}
    }
    const current=await loadCheckpoint(key);if(!current||current.status==='stopped')return;
    if(job.loaded===job.bytes){job.status='complete';await writeJob(job);}
    else{job.status='paused';job.error||=event.registration.failureReason||'Download paused.';await writeJob(job);}
    const clients=await self.clients.matchAll();for(const client of clients)client.postMessage({type:'jmfs-download',key});
  }catch(error){const current=await loadCheckpoint(key);if(current&&current.status!=='stopped'){job.status='error';job.error=error.message;await writeJob(job);}}
}
