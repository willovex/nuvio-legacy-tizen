const {test}=require('node:test');const assert=require('node:assert/strict');
const {chooseImdbMatch,parseTmdbId,createJsonCache,createCredentialReader}=require('../bridge/metadata.cjs');
test('IMDb matches select the requested media type when both movie and show results exist',()=>{
 const found={movie_results:[{id:100}],tv_results:[{id:200}]};
 assert.deepEqual(chooseImdbMatch(found,'series'),{id:200,type:'tv'});
 assert.deepEqual(chooseImdbMatch(found,'movie'),{id:100,type:'movie'});
});
test('TMDB IDs accept typed prefixes without treating provider IDs as numbers',()=>{
 assert.equal(parseTmdbId('tmdb:tv:123'),123);assert.equal(parseTmdbId('tmdb:456'),456);assert.equal(parseTmdbId('789'),789);assert.equal(parseTmdbId('nzbdav:abc'),null);
});
test('metadata cache coalesces concurrent lookups, bounds entries, and retries failures',async()=>{
 let calls=0;const cache=createJsonCache(async key=>{calls++;await new Promise(r=>setImmediate(r));if(key==='bad')throw new Error('offline');return {key};},{maxEntries:1});
 await Promise.all([cache.get('a'),cache.get('a')]);await cache.get('a');assert.equal(calls,1);
 await cache.get('b');await cache.get('a');assert.equal(calls,3);
 await assert.rejects(cache.get('bad'));await assert.rejects(cache.get('bad'));assert.equal(calls,5);
});
test('account credentials are pulled once, parse JSON, and invalidate when profile scope changes',async()=>{
 let calls=0,scope='account:1';const reader=createCredentialReader(()=>scope,async()=>{calls++;return [{provider:'tmdb',credential_json:{api_key:'test-key'}},{provider:'mdblist',credential_json:'{"api_key":"test-mdb"}'}];});
 assert.deepEqual(await Promise.all([reader.get('tmdb'),reader.get('mdblist')]),['test-key','test-mdb']);assert.equal(calls,1);
 scope='account:2';assert.equal(await reader.get('tmdb'),'test-key');assert.equal(calls,2);
 scope=null;assert.equal(await reader.get('tmdb'),null);assert.equal(calls,2);
});
