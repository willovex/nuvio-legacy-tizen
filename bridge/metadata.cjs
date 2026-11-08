'use strict';
function chooseImdbMatch(found,type){
 const tv=type==='tv'||type==='series',preferred=tv?'tv_results':'movie_results',other=tv?'movie_results':'tv_results';
 if(found[preferred]?.[0])return {id:found[preferred][0].id,type:tv?'tv':'movie'};
 if(found[other]?.[0])return {id:found[other][0].id,type:tv?'movie':'tv'};
 return null;
}
function parseTmdbId(value){const m=String(value).match(/^(?:tmdb:(?:(?:movie|tv|series):)?)?(\d+)$/);return m?Number(m[1]):null;}
function createJsonCache(load,{maxEntries=256,ttlMs=600000,concurrency=6}={}){
 const values=new Map(),pending=new Map(),queue=[];let active=0;
 function pump(){while(active<concurrency&&queue.length){const job=queue.shift();active++;Promise.resolve().then(()=>load(job.key)).then(job.resolve,job.reject).finally(()=>{active--;pump();});}}
 async function get(key){
  const saved=values.get(key);if(saved?.expires>Date.now()){values.delete(key);values.set(key,saved);return saved.value;}values.delete(key);
  if(pending.has(key))return pending.get(key);
  const promise=new Promise((resolve,reject)=>{queue.push({key,resolve,reject});pump();}).then(value=>{while(values.size>=maxEntries)values.delete(values.keys().next().value);values.set(key,{value,expires:Date.now()+ttlMs});return value;});
  pending.set(key,promise);try{return await promise;}finally{pending.delete(key);}
 }
 return {get};
}
function createCredentialReader(scope,pull,{ttlMs=300000}={}){
 let cached=null,pending=null;
 async function read(){
  const owner=scope();if(!owner)return new Map();
  if(cached?.owner===owner&&cached.expires>Date.now())return cached.values;
  if(pending?.owner===owner)return pending.promise;
  const promise=(async()=>{
   const rows=await pull(),values=new Map();
   for(const row of rows||[]){let value=row.credential_json;if(typeof value==='string'){try{value=JSON.parse(value);}catch{continue;}}values.set(String(row.provider).toLowerCase(),value||{});}
   if(scope()===owner)cached={owner,values,expires:Date.now()+ttlMs};return values;
  })();pending={owner,promise};
  try{return await promise;}finally{if(pending?.promise===promise)pending=null;}
 }
 return {async get(provider,field='api_key'){const owner=scope(),values=await read();if(scope()!==owner)return null;const value=values.get(provider)?.[field];return typeof value==='string'&&value.trim()?value.trim():null;}};
}
module.exports={chooseImdbMatch,parseTmdbId,createJsonCache,createCredentialReader};
