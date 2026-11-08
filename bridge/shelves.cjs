'use strict';
const {createHash}=require('node:crypto');
function key(value){return createHash('sha256').update(value).digest('hex').slice(0,24);}
function name(value){return String(value||'').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,'').trim();}
function buildShelves(addons,settings={},collections=[]){
 const rows=[],folders=[],known=new Map(),prefs=new Map();
 const identity=(a,t,c)=>[a,t,c].join('\n');
 for(const [index,p] of (settings.items||[]).entries()){
  const id=p.is_collection||p.isCollection?'collection:'+ (p.collection_id||p.collectionId):identity(p.addon_id||p.addonId,p.type,p.catalog_id||p.catalogId);
  prefs.set(id,{...p,order:Number.isFinite(Number(p.order))?Number(p.order):index});
 }
 function add(row,pref){
  if(pref?.enabled===false)return;
  row.title=name(pref?.custom_title||pref?.customTitle||row.title);
  row.order=pref?.order??100000+rows.length;rows.push(row);
 }
 for(const addon of addons){
  for(const c of addon.catalogs||[]){
   const id=identity(addon.id,c.type,c.id);if(known.has(id))continue;known.set(id,true);
   if(c.showInHome===false||(c.extra||[]).some(e=>e.isRequired))continue;
   add({id:key(id),title:c.name||c.id,sources:[{provider:'addon',base:addon.base,type:c.type,catalogId:c.id}]},prefs.get(id));
  }
 }
 for(const collection of collections){
  const pref=prefs.get('collection:'+collection.id);if(pref?.enabled===false)continue;
  const items=[];
  for(const folder of collection.folders||[]){
   const sources=(folder.sources?.length?folder.sources:(folder.catalogSources||[])).map(s=>{
    if(s.provider==='tmdb')return s;
    const addon=addons.find(a=>a.id===(s.addonId||s.addon_id));
    if(!addon)return null; // Use installed account add-ons only, never an arbitrary client URL.
    return {provider:'addon',base:addon.base,type:s.type||s.apiType,catalogId:s.catalogId||s.catalog_id,genre:s.genre};
   }).filter(Boolean);
   if(!sources.length)continue;
   const id=key('folder\n'+collection.id+'\n'+folder.id);
   folders.push({id,title:name(folder.title),sources});
   items.push({id,type:'folder',title:name(folder.title),poster:folder.coverImageUrl||''});
  }
  if(items.length)add({id:key('collection\n'+collection.id),title:collection.title,items},pref);
 }
 rows.sort((a,b)=>a.order-b.order);
 return {rows,folders};
}
function rating(value) {
 const number = Number.parseFloat(value);
 return Number.isFinite(number) && number > 0 && number <= 10 ? Math.round(number * 10) / 10 : null;
}
function mapMeta(m,type){
 const t=m.type||type;
 return {id:m.id,type:t==='tv'||t==='series'?'series':'movie',title:m.name||m.title||'',poster:m.poster||'',rating:rating(m.imdbRating ?? m.rating ?? m.vote_average)};
}
async function loadShelf(row,getJSON,tmdb){
 const results=await Promise.allSettled((row.sources||[]).map(async source=>{
  if(source.provider==='tmdb'){
   if(source.tmdbSourceType!=='COLLECTION'||!Number.isInteger(Number(source.tmdbId)))throw new Error('Unsupported collection source');
   const u=new URL(tmdb.tmdb+'/collection/'+source.tmdbId);u.searchParams.set('api_key',tmdb.key);u.searchParams.set('language',tmdb.language);
   const j=await getJSON(u.href);
   return (j.parts||[]).map(m=>({id:m.id,type:'movie',title:m.title||'',poster:m.poster_path?'https://image.tmdb.org/t/p/w342'+m.poster_path:'',rating:rating(m.vote_average)}));
  }
  const extra=source.genre?'/genre='+encodeURIComponent(source.genre):'';
  const url=source.base+'/catalog/'+encodeURIComponent(source.type)+'/'+encodeURIComponent(source.catalogId)+extra+'.json';
  const j=await getJSON(url);if(j.error)throw new Error('Catalog source failed');
  return (j.metas||[]).filter(m=>m.id&&(m.name||m.title)).map(m=>mapMeta(m,source.type));
 }));
 const good=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
 if(!good.length)throw new Error('Shelf sources are unavailable. Please try again.');
 const out=[],seen=new Set(),longest=Math.max(0,...good.map(r=>r.length));
 for(let i=0;i<longest&&out.length<100;i++)for(const list of good){
  const item=list[i];if(!item)continue;const id=item.type+':'+item.id;
  if(!seen.has(id)){seen.add(id);out.push(item);}if(out.length>=100)break;
 }
 return out;
}
module.exports={buildShelves,loadShelf};
