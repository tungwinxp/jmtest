// Finishes index downloads that continue after the page has closed.
import {finishBackgroundDownload} from './downloads.js?v=28';
for(const type of ['backgroundfetchsuccess','backgroundfetchfailure','backgroundfetchabort'])self.addEventListener(type,event=>{if(event.registration.id.startsWith('download:'))event.waitUntil(finishBackgroundDownload(event));});
self.addEventListener('backgroundfetchclick',event=>event.waitUntil(self.clients.openWindow(new URL('./colab.html',self.location.href).href)));
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
