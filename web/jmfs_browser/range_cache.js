// Cache fetched byte intervals, never eagerly download an entire remote index.
const STORE='jmfs-index-ranges-v1';
const key=(kind,url,version='',offset=0,length=0)=>new URL('/__jmfs_cache__/'+kind+'?'+new URLSearchParams({url,version,offset,length}),globalThis.location.origin).href;
export async function rangeCache(url){
  if(!globalThis.caches||!globalThis.location)return null;
  try{
    const cache=await caches.open(STORE),metadataKey=key('metadata',url);
    const prior=await cache.match(metadataKey);let metadata=prior?await prior.json():null;
    try{
      const response=await fetch(url,{method:'HEAD',cache:'no-cache'});
      if(!response.ok)throw Error('Index HEAD failed');
      const etag=response.headers.get('etag'),size=Number(response.headers.get('content-length'));
      // Only versioned objects qualify; do not reuse unvalidated mutable bytes.
      if(!etag||etag.startsWith('W/')||!Number.isSafeInteger(size)||size<=0)return null;
      metadata={etag,size};await cache.put(metadataKey,new Response(JSON.stringify(metadata)));
    }catch{if(!metadata)return null;}
    if(metadata.etag.startsWith('W/'))return null;
    return {etag:metadata.etag,size:metadata.size,
      async read(offset,length){const response=await cache.match(key('range',url,metadata.etag,offset,length));return response?new Uint8Array(await response.arrayBuffer()):null;},
      async write(offset,bytes){await cache.put(key('range',url,metadata.etag,offset,bytes.length),new Response(bytes));},
    };
  }catch{return null;} // Storage denial/quota must never prevent an otherwise valid search.
}

export async function savedIndexes(){
  if(!navigator.storage?.getDirectory)return [];
  try{
    const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('jmfs-index-files',{create:true}),files=[];
    for await(const handle of folder.values())if(handle.kind==='file')files.push(await handle.getFile());
    return files;
  }catch{return [];}
}
export async function rememberIndex(file){
  if(!navigator.storage?.getDirectory)return;
  const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('jmfs-index-files',{create:true});
  const handle=await folder.getFileHandle(file.name,{create:true});
  await file.stream().pipeTo(await handle.createWritable());
}

export async function cachedDatabases(){
  const items=new Map();
  if(globalThis.caches){
    const cache=await caches.open(STORE);
    for(const request of await cache.keys()){
      const address=new URL(request.url),url=address.searchParams.get('url');if(!url)continue;
      const name=decodeURIComponent(new URL(url).pathname.split('/').pop());
      const item=items.get(url)||{url,name,bytes:0};
      if(address.pathname.endsWith('/range'))item.bytes+=Number(address.searchParams.get('length'))||0;
      items.set(url,item);
    }
  }
  for(const file of await savedIndexes())items.set('file:'+file.name,{name:file.name,bytes:file.size,file:true});
  return [...items.values()];
}
export async function forgetDatabase({url,name,file}){
  if(url&&globalThis.caches){
    const cache=await caches.open(STORE);
    for(const request of await cache.keys())if(new URL(request.url).searchParams.get('url')===url)await cache.delete(request);
  }
  if(file&&navigator.storage?.getDirectory){
    const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('jmfs-index-files',{create:true});
    await folder.removeEntry(name).catch(error=>{if(error.name!=='NotFoundError')throw error;});
  }
}
