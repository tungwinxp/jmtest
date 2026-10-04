export const MODEL={revision:'fff685b81430bd58e703547bb6014f7b5d482f48',file:'Qwen3.5-0.8B-S-TS-Q4_K_S.gguf',bytes:417701248,sha256:'8916be129e5bb4ea16001f73f67888517e41fad86cb14e48b0fe34b333c063d0'};
export const MODEL_URL=`https://huggingface.co/TheStageAI/Qwen3.5-0.8B-GGUF/resolve/${MODEL.revision}/${MODEL.file}`;
export const GEMMA={revision:'57cbf0912db499cff5cc9cf0d800c2247c49e376',file:'gemma-4-E2B-it-XS-TS-Q3_K_S.gguf',bytes:1733114080,sha256:'d1e358e0a9f945084e8757090684ef698f9e99f41693dcd465f5aeaa3564c3b5'};
export const GEMMA_URL=`https://huggingface.co/TheStageAI/gemma-4-E2B-it-GGUF/resolve/${GEMMA.revision}/${GEMMA.file}`;
export async function metalAvailable(){
  const adapter=await navigator.gpu?.requestAdapter().catch(()=>null);
  return Boolean(adapter&&!adapter.info.isFallbackAdapter&&adapter.info.vendor==='apple'&&adapter.info.architecture.startsWith('metal')&&(navigator.deviceMemory??8)>=8);
}
export async function loadLocalModel(progress,signal,url=MODEL_URL,options={}){
  const {Wllama}=await import('./assets/vendor.js');
  const {runtime={},...loadOptions}=options;
  const llm=new Wllama({default:new URL('./assets/wllama.wasm',import.meta.url).href},{suppressNativeLog:true,allowOffline:true,...runtime});
  try{
    await llm.loadModelFromUrl(url,{n_ctx:8192,n_parallel:1,n_batch:256,n_ubatch:64,n_gpu_layers:0,n_threads:Math.max(1,Math.min(8,(navigator.hardwareConcurrency??4)-1)),jinja:true,default_template_kwargs:{enable_thinking:false},signal,
      progressCallback:({loaded,total})=>progress(total?`Loading local guide · ${Math.round(100*loaded/total)}%`:'Loading local guide…'),...loadOptions});
    return llm;
  }catch(error){await llm.exit().catch(()=>{});throw error;}
}
