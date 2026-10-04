// GitHub Pages cannot set COOP/COEP. Scope this worker to the JMFS demo only.
import {finishBackgroundDownload} from './downloads.js?v=25';
for(const type of ['backgroundfetchsuccess','backgroundfetchfailure','backgroundfetchabort'])self.addEventListener(type,event=>{if(event.registration.id.startsWith('download:'))event.waitUntil(finishBackgroundDownload(event));});
self.addEventListener('backgroundfetchclick',event=>event.waitUntil(self.clients.openWindow(new URL('./colab.html',self.location.href).href)));
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const request=event.request;
  // Let the page make external requests, including permission-gated loopback MCP.
  if(new URL(request.url).origin!==self.location.origin)return;
  if(request.cache==='only-if-cached'&&request.mode!=='same-origin')return;
  event.respondWith((async()=>{
    const response=await fetch(request);
    if(response.type==='opaque')return response;
    const headers=new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy','same-origin');
    headers.set('Cross-Origin-Embedder-Policy','require-corp');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  })());
});
