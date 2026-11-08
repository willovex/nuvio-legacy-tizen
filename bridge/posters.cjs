'use strict';
function posterURL(value) {
 const url=new URL(value);
 if(url.hostname==='image.tmdb.org')url.pathname=url.pathname.replace(/^\/t\/p\/[^/]+\//,'/t/p/w342/');
 return url.href;
}
function proxyPosterURL(value, host) {
 try {
  const url = posterURL(value);
  if (!/^https?:\/\//.test(url)) return '';
  return 'http://' + host + '/img?poster=1&u=' + encodeURIComponent(url);
 } catch (_) { return ''; }
}
function createPosterCache(load,{maxBytes=32*1024*1024,maxEntries=256,ttlMs=3600000,concurrency=6}={}) {
 const cache=new Map(),pending=new Map(),queue=[];let bytes=0,active=0;
 function remove(key){const old=cache.get(key);if(old){bytes-=old.body.length;cache.delete(key);}}
 function pump(){
  while(active<concurrency&&queue.length){
   const job=queue.shift();active++;
   Promise.resolve().then(()=>load(job.url)).then(job.resolve,job.reject).finally(()=>{active--;pump();});
  }
 }
 async function get(value){
  const url=posterURL(value),old=cache.get(url);
  if(old&&old.expires>Date.now()){cache.delete(url);cache.set(url,old);return {...old,cacheStatus:'HIT'};}
  if(old)remove(url);
  if(pending.has(url))return {...await pending.get(url),cacheStatus:'COALESCED'};
  if(pending.size>=256)throw new Error('Poster queue busy');
  const promise=(async()=>{
   const response=await new Promise((resolve,reject)=>{queue.push({url,resolve,reject});pump();});
   if(response.status===200&&/^image\//i.test(response.headers['content-type']||'')&&response.body.length<=maxBytes){
    remove(url);
    while(cache.size&&(bytes+response.body.length>maxBytes||cache.size>=maxEntries))remove(cache.keys().next().value);
    const saved={...response,expires:Date.now()+ttlMs};cache.set(url,saved);bytes+=response.body.length;
   }
   return response;
  })();
  pending.set(url,promise);
  try{return {...await promise,cacheStatus:'MISS'};}finally{pending.delete(url);}
 }
 return {get};
}
module.exports={posterURL,proxyPosterURL,createPosterCache};
