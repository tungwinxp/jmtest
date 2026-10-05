// Browser check: import this module on an isolated test origin.
import {rangeCache,cachedDatabases,forgetDatabase,rememberIndex,savedIndexes} from '../range_cache.js?v=28';
import {resumable,backgroundDownloads} from '../downloads.js?v=28';
import {cachedModels,forgetModel,removeRetiredModel,RETIRED_MODEL_URL,GEMMA_URL,MODEL_URL} from '../ai/model.js?v=31';
import {Wllama} from '../ai/assets/vendor.js';
const check=(value,message)=>{if(!value)throw Error(message);};
const urls=['https://cache-test.invalid/remove.jmfsgeom','https://cache-test.invalid/keep.jmfsgeom'];
const names=['cache-test-remove.jmfsgeom','cache-test-keep.jmfsgeom'];
const originalFetch=globalThis.fetch;
const preferences=['jmfs-resume','jmfs-background-downloads'].map(key=>[key,localStorage.getItem(key)]);
const llm=new Wllama({default:new URL('../ai/assets/wllama.wasm',import.meta.url).href},{suppressNativeLog:true}),cache=llm.cacheManager;
check(!(await cache.open(RETIRED_MODEL_URL))&&!(await cache.open(GEMMA_URL))&&!(await cache.open(MODEL_URL)),'Use a fresh test origin; never overwrite real guide models.');
try{
  preferences.forEach(([key])=>localStorage.removeItem(key));
  check(resumable()&&backgroundDownloads(),'Resume and supported background downloads default on.');
  localStorage.setItem('jmfs-resume','off');check(!resumable()&&!backgroundDownloads(),'Explicit opt-out persists.');
  globalThis.fetch=async()=>new Response(null,{headers:{ETag:'"cache-test"','Content-Length':'8'}});
  for(const url of urls){const store=await rangeCache(url);await store.write(0,new Uint8Array(8));}
  globalThis.fetch=async()=>new Response(null,{headers:{ETag:'W/"cache-test"','Content-Length':'8'}});
  check(await rangeCache(urls[0])===null,'Weak validators cannot authenticate cached byte intervals.');
  globalThis.fetch=originalFetch;
  for(const name of names)await rememberIndex(new File(['fixture'],name));
  await forgetDatabase({url:urls[0]});await forgetDatabase({name:names[0],file:true});
  const databases=await cachedDatabases(),files=await savedIndexes();
  check(!databases.some(d=>d.url===urls[0])&&databases.some(d=>d.url===urls[1]),'Remove only the selected database ranges.');
  check(!files.some(f=>f.name===names[0])&&files.some(f=>f.name===names[1]),'Remove only the selected browser index file.');
  for(const url of [RETIRED_MODEL_URL,GEMMA_URL,MODEL_URL])await cache.write(await cache.getNameFromURL(url),new Blob(['fixture']).stream(),{originalURL:url,originalSize:7,etag:'test'});
  await removeRetiredModel();
  const models=await cachedModels();check(!(await cache.open(RETIRED_MODEL_URL))&&models.some(m=>m.url===GEMMA_URL),'Remove the retired guide while preserving Gemma.');
  await forgetModel(MODEL_URL);check(!(await cache.open(MODEL_URL))&&await cache.open(GEMMA_URL),'Remove only the selected MiniCPM model.');
  let rejected=false;try{await forgetModel('https://unrelated.invalid/model.gguf');}catch{rejected=true;}
  check(rejected,'Reject removal of unrelated model files.');
  globalThis.cacheControlsPassed=true;
}finally{
  globalThis.fetch=originalFetch;
  preferences.forEach(([key,value])=>value===null?localStorage.removeItem(key):localStorage.setItem(key,value));
  for(const url of urls)await forgetDatabase({url});
  for(const name of names)await forgetDatabase({name,file:true});
  await cache.delete(RETIRED_MODEL_URL);await forgetModel(GEMMA_URL);await forgetModel(MODEL_URL);
}
