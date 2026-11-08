const {test}=require('node:test');const assert=require('node:assert/strict');const {createPosterCache,posterURL}=require('../bridge/posters.cjs');
const picture=n=>({status:200,headers:{'content-type':'image/jpeg'},body:Buffer.alloc(n)});
test('TMDB tile artwork requests w342 without changing other poster services',()=>{
 assert.equal(posterURL('https://image.tmdb.org/t/p/w600_and_h900_bestv2/movie.jpg'),'https://image.tmdb.org/t/p/w342/movie.jpg');
 assert.equal(posterURL('https://other.test/image.jpg'),'https://other.test/image.jpg');
});
test('simultaneous and repeated poster requests fetch upstream only once',async()=>{
 let calls=0;const cache=createPosterCache(async()=>{calls++;await new Promise(r=>setImmediate(r));return picture(10);});
 await Promise.all([cache.get('https://image.test/a'),cache.get('https://image.test/a')]);await cache.get('https://image.test/a');assert.equal(calls,1);
});
test('poster cache evicts by bytes and never caches failures or non-images',async()=>{
 let calls=0;const cache=createPosterCache(async url=>{calls++;return url.endsWith('bad')?{status:404,headers:{},body:Buffer.alloc(0)}:url.endsWith('html')?{status:200,headers:{'content-type':'text/html'},body:Buffer.from('error')}:picture(8);},{maxBytes:10});
 await cache.get('https://image.test/a');await cache.get('https://image.test/b');await cache.get('https://image.test/a');assert.equal(calls,3);
 await cache.get('https://image.test/bad');await cache.get('https://image.test/bad');assert.equal(calls,5);
 await cache.get('https://image.test/html');await cache.get('https://image.test/html');assert.equal(calls,7);
});
test('poster fetching respects the concurrency bound and releases queued jobs after errors',async()=>{
 let active=0,max=0;const cache=createPosterCache(async url=>{active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;if(url.endsWith('/0'))throw new Error('offline');return picture(1);},{concurrency:2});
 const results=await Promise.allSettled(Array.from({length:10},(_,i)=>cache.get('https://image.test/'+i)));
 assert.equal(max,2);assert.equal(results.filter(r=>r.status==='fulfilled').length,9);
});
test('an invalid poster URL becomes a per-item placeholder instead of failing the shelf',()=>{
 const {proxyPosterURL}=require('../bridge/posters.cjs');
 assert.equal(proxyPosterURL('https://','bridge.test:7070'),'');
 assert.equal(proxyPosterURL('file:///private/image.jpg','bridge.test:7070'),'');
 assert.match(proxyPosterURL('https://image.tmdb.org/t/p/w600_and_h900_bestv2/a.jpg','bridge.test:7070'),/^http:\/\/bridge\.test:7070\/img\?poster=1&u=/);
});
