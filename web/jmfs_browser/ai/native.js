const address='http://127.0.0.1:18773';
async function post(path,body,signal){
  const response=await fetch(address+path,{method:'POST',headers:{'Content-Type':'application/json','X-JMFS-Guide':'1'},body:JSON.stringify(body),signal,keepalive:path!=='/v1/chat/completions'});
  const result=await response.json();if(!response.ok)throw Error(result.error||'Native MLX returned '+response.status);return result;
}
export async function localMlx(progress,signal){
  let health;
  try{health=await fetch(address+'/health',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(1000)]):AbortSignal.timeout(1000)}).then(r=>r.ok?r.json():null);}catch(error){if(signal?.aborted)throw error;return null;}
  if(health?.backend!=='mlx'||health.model!=='TheStageAI/gemma-4-E2B-it')return null;
  progress('Loading native MLX guide · 1.44 GB cached on this Mac…');
  await post('/load',{},signal);
  let active;
  const release=()=>post('/release',{request_id:active}).catch(()=>{});
  addEventListener('pagehide',release,{once:true});
  return {backend:'mlx',
    async createChatCompletion(params){
      const {abortSignal,...body}=params,request_id=crypto.randomUUID();active=request_id;
      const stop=()=>post('/cancel',{request_id}).catch(()=>{});abortSignal?.addEventListener('abort',stop,{once:true});
      try{return await post('/v1/chat/completions',{...body,request_id},abortSignal);}finally{abortSignal?.removeEventListener('abort',stop);active=null;}
    },
    exit:()=>{removeEventListener('pagehide',release);return post('/release',{request_id:active});}
  };
}
