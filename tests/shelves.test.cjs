const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildShelves,loadShelf}=require('../bridge/shelves.cjs');
const addons=[{id:'a',name:'Catalogs',base:'https://example.test/private',catalogs:[
 {id:'popular',type:'movie',name:'Popular'}, {id:'hidden',type:'movie',name:'Hidden'},
 {id:'search',type:'movie',name:'Search',extra:[{name:'search',isRequired:true}]}]}];
const settings={items:[{addon_id:'a',type:'movie',catalog_id:'hidden',enabled:false,order:0},
 {is_collection:true,collection_id:'decades',enabled:true,order:1},
 {addon_id:'a',type:'movie',catalog_id:'popular',custom_title:'My movies',order:2}]};
const collections=[{id:'decades',title:'Decades',folders:[{id:'80s',title:"80's Movies",sources:[
 {provider:'addon',addonId:'a',type:'movie',catalogId:'1980s',genre:'80s'}]}]}];
test('account shelves honor disabled rows and order, and preserve collection folders',()=>{
 const result=buildShelves(addons,settings,collections);
 assert.deepEqual(result.rows.map(r=>r.title),['Decades','My movies']);
 assert.equal(result.rows[0].items[0].title,"80's Movies");
 assert.equal(result.rows[0].items[0].type,'folder');
 assert.equal(result.folders.length,1);
});
test('collection source can load a catalog excluded from ordinary home rows',async()=>{
 const row=buildShelves(addons,settings,collections).folders[0]; let requested;
 const items=await loadShelf(row,async url=>{requested=url;return {metas:[{id:'tt1234567',type:'movie',name:'Movie',poster:'https://images.test/a.jpg'}]};},{tmdb:'https://tmdb.test',key:'key',language:'en-US'});
 assert.equal(requested,'https://example.test/private/catalog/movie/1980s/genre=80s.json');
 assert.deepEqual(items,[{id:'tt1234567',type:'movie',title:'Movie',poster:'https://images.test/a.jpg',rating:null}]);
});
test('multi-source streaming folders interleave, deduplicate and retain movie/show types',async()=>{
 const row={sources:[{provider:'addon',base:'https://movie.test',type:'movie',catalogId:'netflix'},{provider:'addon',base:'https://show.test',type:'series',catalogId:'netflix'}]};
 const items=await loadShelf(row,async url=>url.includes('movie.test')?{metas:[{id:'tt1',name:'Movie'},{id:'tt2',name:'Movie 2'}]}:{metas:[{id:'tt3',name:'Show'}]},{});
 assert.deepEqual(items.map(i=>[i.id,i.type]),[['tt1','movie'],['tt3','series'],['tt2','movie']]);
});
test('a failed source does not hide a streaming folder when another source works',async()=>{
 const row={sources:[{provider:'addon',base:'https://bad.test',type:'movie',catalogId:'one'},{provider:'addon',base:'https://good.test',type:'movie',catalogId:'two'}]};
 const items=await loadShelf(row,async u=>{if(u.includes('bad'))throw new Error('offline');return {metas:[{id:'tt1',name:'Works'}]};},{});
 assert.equal(items[0].title,'Works');
});
test('TMDB franchise collections produce numeric IDs usable by the existing player',async()=>{
 const items=await loadShelf({sources:[{provider:'tmdb',tmdbSourceType:'COLLECTION',tmdbId:99}]},async u=>{
 assert.equal(new URL(u).pathname,'/collection/99');return {parts:[{id:7,title:'Film',poster_path:'/a.jpg'}]};},{tmdb:'https://tmdb.test',key:'key',language:'en-US'});
 assert.equal(items[0].id,7);assert.equal(items[0].type,'movie');assert.equal(items[0].title,'Film');
});
test('a fully failed shelf reports failure instead of appearing successfully empty',async()=>{
 await assert.rejects(loadShelf({sources:[{provider:'addon',base:'https://bad.test',type:'movie',catalogId:'x'}]},async()=>{throw new Error('offline');},{}));
});
test('add-on catalog ratings survive mapping and invalid ratings do not become badges',async()=>{
 const items=await loadShelf({sources:[{provider:'addon',base:'https://catalog.test',type:'movie',catalogId:'top'}]},async()=>({metas:[{id:'tt1',name:'Rated',imdbRating:'8.2'},{id:'tt2',name:'Unrated',imdbRating:'N/A'}]}),{});
 assert.equal(items[0].rating,8.2);assert.equal(items[1].rating,null);
});
