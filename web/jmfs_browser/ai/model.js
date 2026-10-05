export const MODEL={revision:'fff685b81430bd58e703547bb6014f7b5d482f48',file:'Qwen3.5-0.8B-S-TS-Q4_K_S.gguf',bytes:417701248,sha256:'8916be129e5bb4ea16001f73f67888517e41fad86cb14e48b0fe34b333c063d0'};
export const MODEL_URL=`https://huggingface.co/TheStageAI/Qwen3.5-0.8B-GGUF/resolve/${MODEL.revision}/${MODEL.file}`;
export const GEMMA={revision:'57cbf0912db499cff5cc9cf0d800c2247c49e376',file:'gemma-4-E2B-it-XS-TS-Q3_K_S.gguf',bytes:1733114080,sha256:'d1e358e0a9f945084e8757090684ef698f9e99f41693dcd465f5aeaa3564c3b5'};
export const GEMMA_URL=`https://huggingface.co/TheStageAI/gemma-4-E2B-it-GGUF/resolve/${GEMMA.revision}/${GEMMA.file}`;
async function modelCache(){
  const {Wllama}=await import('./assets/vendor.js');
  return new Wllama({default:new URL('./assets/wllama.wasm',import.meta.url).href},{suppressNativeLog:true}).cacheManager;
}
export async function cachedModels(){
  const cache=await modelCache(),entries=await cache.list();
  return entries.filter(e=>[MODEL_URL,GEMMA_URL].includes(e.metadata?.originalURL)).map(e=>({url:e.metadata.originalURL,name:e.name,bytes:e.size,kind:'model'}));
}
export async function forgetModel(url){
  if(![MODEL_URL,GEMMA_URL].includes(url))throw Error('That is not a JMFS guide model.');
  await(await modelCache()).delete(url);
}
export function supportedGuideGpu(info,memory=8){
  const vendor=String(info?.vendor||'').toLowerCase(),architecture=String(info?.architecture||'').toLowerCase();
  return Boolean(info&&!info.isFallbackAdapter&&memory>=8&&((vendor==='apple'&&architecture.startsWith('metal'))||vendor.includes('nvidia')));
}
export async function guideGpuAvailable(){
  const adapter=await navigator.gpu?.requestAdapter().catch(()=>null);
  return supportedGuideGpu(adapter?.info,navigator.deviceMemory??8);
}
export async function loadLocalModel(progress,signal,url=MODEL_URL,options={}){
  const {Wllama}=await import('./assets/vendor.js');
  const {runtime={},...loadOptions}=options;
  const llm=new Wllama({default:new URL('./assets/wllama.wasm',import.meta.url).href},{suppressNativeLog:true,allowOffline:true,...runtime});
  const {resumable,backgroundDownloads,prepareDownload,runDownload,progressText}=await import('../downloads.js?v=28');
  const started=performance.now();let initial;
  const report=({loaded,total,etaMs})=>{
    initial??=loaded;
    const moved=loaded-initial;
    etaMs??=moved>0?(total-loaded)*(performance.now()-started)/moved:NaN;
    progress(total?`Loading local guide · ${progressText(loaded,total,etaMs)}`:'Loading local guide…',{loaded,total,etaMs});
  };
  try{
    const available=navigator.hardwareConcurrency||4,threads=Math.trunc(Number(localStorage.getItem('jmfs-cpu-cores')))||Math.min(8,available-1);
    const params={n_ctx:8192,n_parallel:1,n_batch:256,n_ubatch:64,n_gpu_layers:0,n_threads:Math.max(1,Math.min(available,threads)),jinja:true,default_template_kwargs:{enable_thinking:false},signal,progressCallback:report,...loadOptions};
    const cached=await llm.cacheManager.open(url),pin=url===GEMMA_URL?GEMMA:MODEL;
    if(resumable()&&(!cached||cached.size!==pin.bytes)){
      const job=await prepareDownload({url,name:pin.file,bytes:pin.bytes,kind:'model',immutable:true});
      const file=await runDownload(job,{signal,onProgress:report,background:backgroundDownloads()});
      signal?.throwIfAborted();progress('Preparing the cached local guide…');await llm.loadModel([file],params);
    }else await llm.loadModelFromUrl(url,params);
    return llm;
  }catch(error){await llm.exit().catch(()=>{});throw error;}
}
