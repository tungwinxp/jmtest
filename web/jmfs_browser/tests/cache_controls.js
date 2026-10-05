// Browser check: import this module on an isolated test origin.
import {rangeCache,cachedDatabases,forgetDatabase,rememberIndex,savedIndexes} from '../range_cache.js?v=28';
import {resumable,backgroundDownloads} from '../downloads.js?v=28';
const check=(value,message)=>{if(!value)throw Error(message);};
const urls=['https://cache-test.invalid/remove.jmfsgeom','https://cache-test.invalid/keep.jmfsgeom'];
const names=['cache-test-remove.jmfsgeom','cache-test-keep.jmfsgeom'];
const originalFetch=globalThis.fetch;
const preferences=['jmfs-resume','jmfs-background-downloads'].map(key=>[key,localStorage.getItem(key)]);
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
  globalThis.cacheControlsPassed=true;
}finally{
  globalThis.fetch=originalFetch;
  preferences.forEach(([key,value])=>value===null?localStorage.removeItem(key):localStorage.setItem(key,value));
  for(const url of urls)await forgetDatabase({url});
  for(const name of names)await forgetDatabase({name,file:true});
}
