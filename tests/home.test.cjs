const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
function boot(){
 class Element{
  constructor(){this.childNodes=[];this.style={};this.className='';this.html='';this.attrs={};}
  set innerHTML(s){this.html=s;this.childNodes=[];}get innerHTML(){return this.html;}
  get firstChild(){return this.childNodes[0];}removeChild(e){this.childNodes.splice(this.childNodes.indexOf(e),1);}
  set textContent(s){this.innerHTML=s;}get textContent(){return this.innerHTML;}
  appendChild(e){this.childNodes.push(e);return e;}setAttribute(k,v){this.attrs[k]=v;}getAttribute(k){return this.attrs[k];}scrollIntoView(){}
 }
 const elements={},all=[],requests=[],listeners={};
 const make=()=>{const e=new Element();all.push(e);return e;};
 const document={getElementById:id=>elements[id]||(elements[id]=make()),createElement:make,documentElement:{clientWidth:1920,clientHeight:1080},addEventListener:(n,f)=>listeners[n]=f,querySelectorAll:()=>all.filter(e=>e.className.includes('focused')),querySelector:()=>null};
 function XHR(){this.open=(method,url)=>{this.url=url;};this.send=()=>requests.push(this);this.setRequestHeader=()=>{};}
 const sandbox={document,XMLHttpRequest:XHR,window:{innerWidth:1920,innerHeight:1080,addEventListener(){}},setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},console,Date};
 document.getElementById('topbar');
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../tizen-app/js/app.js'),'utf8'),sandbox);sandbox.window.onload();
 function respond(route,data,status=200){const req=requests.find(r=>r.url.endsWith(route)&&!r.done);assert.ok(req,'App requested '+route);req.done=true;req.status=status;req.responseText=JSON.stringify(data);req.readyState=4;req.onreadystatechange();}
 return {elements,requests,respond,key:k=>listeners.keydown({keyCode:k})};
}
test('saved collection shelves open folders and Back restores the home rows',()=>{
 const app=boot();app.respond('/me/status',{loggedIn:true});
 app.respond('/me/shelves',{rows:[{id:'decades',title:'Decades',items:[{id:'80s',type:'folder',title:"80's Movies",poster:''}]}]});
 app.respond('/me/continue',{items:[]});
 assert.equal(app.elements.rows.childNodes[1].childNodes[0].innerHTML,'Decades');
 app.key(40);app.key(13);
 app.respond('/api/shelf/80s',{items:[{id:'tt123',type:'movie',title:'Movie',poster:''}]});
 assert.equal(app.elements.rows.childNodes[0].childNodes[0].innerHTML,"80's Movies");
 app.key(10009);assert.equal(app.elements.rows.childNodes[1].childNodes[0].innerHTML,'Decades');
});
test('one failed catalog remains navigable and can be retried with OK',()=>{
 const app=boot();app.respond('/me/status',{loggedIn:true});
 app.respond('/me/shelves',{rows:[{id:'a',title:'Broken'},{id:'b',title:'Works',items:[{id:'tt2',title:'Title',type:'movie'}]}]});
 app.respond('/me/continue',{items:[]});app.respond('/api/shelf/a',{},500);
 app.key(40);app.key(13);assert.equal(app.requests.filter(r=>r.url.endsWith('/api/shelf/a')).length,2);
 app.key(40);app.key(13);assert.ok(app.requests.some(r=>r.url.includes('/api/meta/movie/tt2')));
});
test('scrolling uses actual shelf positions so later rows stay visible',()=>{
 const app=boot();app.respond('/me/status',{loggedIn:true});app.respond('/me/shelves',{rows:[{id:'a',title:'A',items:[{id:1,type:'movie',title:'A'}]},{id:'b',title:'B',items:[{id:2,type:'movie',title:'B'}]}]});
 app.respond('/me/continue',{items:[]});
 app.elements.rows.childNodes.forEach((row,i)=>row.offsetTop=i*413);
 app.key(40);app.key(40);assert.equal(app.elements.rows.style.transform,'translateY(-413px)');
});
function posterItems(count){return Array.from({length:count},(_,i)=>({id:i+1,type:'movie',title:'Movie '+i,poster:'http://images.test/'+i+'.jpg',rating:7.4}));}
test('the eighth visible tile has artwork before horizontal navigation, including the next row',()=>{
 const app=boot();app.respond('/me/status',{loggedIn:true});app.respond('/me/shelves',{rows:[{id:'a',title:'A',items:posterItems(20)}]});app.respond('/me/continue',{items:posterItems(20)});
 assert.equal(app.elements.rows.childNodes[0].childNodes[1].childNodes[7].childNodes[0].src,'http://images.test/7.jpg');
 assert.equal(app.elements.rows.childNodes[1].childNodes[1].childNodes[7].childNodes[0].src,'http://images.test/7.jpg');
 app.key(39);assert.equal(app.elements.rows.childNodes[0].childNodes[1].childNodes[8].childNodes[0].src,'http://images.test/8.jpg');
});
test('offscreen shelves do not build or fetch all their poster cards during startup',()=>{
 const app=boot();app.respond('/me/status',{loggedIn:true});app.respond('/me/shelves',{rows:Array.from({length:20},(_,i)=>({id:'row'+i,title:'Row '+i,items:posterItems(100)}))});
 const offscreen=app.elements.rows.childNodes[10].childNodes[1];
 assert.equal(offscreen.childNodes.length,0);
});
test('returning from a collection reuses existing home cards and their loaded images',()=>{
 const app=boot();app.respond('/me/status',{loggedIn:true});app.respond('/me/shelves',{rows:[{id:'a',title:'A',items:[{id:'f',type:'folder',title:'Folder',poster:'http://images.test/f.jpg'}]}]});app.respond('/me/continue',{items:[]});app.key(40);
 const card=app.elements.rows.childNodes[1].childNodes[1].childNodes[0];
 app.key(13);app.respond('/api/shelf/f',{items:posterItems(20)});app.key(10009);
 assert.equal(app.elements.rows.childNodes[1].childNodes[1].childNodes[0],card);
});
test('later posters load even when legacy WebKit reports a default nonempty image src',()=>{
 const app=boot();app.respond('/me/status',{loggedIn:true});app.respond('/me/shelves',{rows:[]});app.respond('/me/continue',{items:posterItems(30)});
 const image=app.elements.rows.childNodes[0].childNodes[1].childNodes[18].childNodes[0];image.src='file:///app/index.html';
 for(let i=0;i<10;i++)app.key(39);
 assert.equal(image.src,'http://images.test/18.jpg');
});
test('the partially visible third shelf also has artwork on initial Home',()=>{
 const app=boot();app.respond('/me/status',{loggedIn:true});app.respond('/me/shelves',{rows:[{id:'a',title:'A',items:posterItems(20)},{id:'b',title:'B',items:posterItems(20)}]});app.respond('/me/continue',{items:posterItems(20)});
 const card=app.elements.rows.childNodes[2].childNodes[1].childNodes[7];assert.ok(card,'Third visible shelf is rendered');assert.equal(card.childNodes[0].src,'http://images.test/7.jpg');
});
function openTestFolder(items){
 const app=boot();app.respond('/me/status',{loggedIn:true});app.respond('/me/shelves',{rows:[{id:'services',title:'Streaming Services',items:[{id:'netflix',type:'folder',title:'Netflix',poster:''}]}]});app.respond('/me/continue',{items:[]});app.key(40);app.key(13);app.respond('/api/shelf/netflix',{items});return app;
}
test('folders use an eight-column grid with Down moving to the next grid row',()=>{
 const app=openTestFolder(posterItems(30));
 assert.match(app.elements.rows.childNodes[0].className,/folder-grid/);
 app.key(40);app.key(13);assert.ok(app.requests.some(r=>r.url.endsWith('/api/meta/movie/9')));
});
test('grid navigation reaches a short final row and prevents horizontal wrapping',()=>{
 const app=openTestFolder(posterItems(19));
 for(let i=0;i<7;i++)app.key(39);app.key(39); // right edge stays on column eight
 app.key(40);app.key(40);app.key(13);
 assert.ok(app.requests.some(r=>r.url.endsWith('/api/meta/movie/19')));
});
test('Back from details restores grid focus and Back from grid restores Home selection',()=>{
 const app=openTestFolder(posterItems(30));app.key(40);app.key(13);
 app.respond('/api/meta/movie/9',{id:9,type:'movie',title:'Film'});app.key(10009);
 const content=app.elements.rows.childNodes[0].childNodes[1].childNodes[0];
 assert.match(content.childNodes[8].className,/focused/);
 app.key(10009);assert.equal(app.elements.rows.childNodes[1].childNodes[0].textContent,'Streaming Services');
});

test('the logo and clock hide throughout the player view and return after playback',()=>{
 const app=boot();app.respond('/me/status',{loggedIn:true});
 app.respond('/me/shelves',{rows:[{id:'movies',title:'Movies',items:[{id:'tt123',type:'movie',title:'Film'}]}]});app.respond('/me/continue',{items:[]});
 assert.doesNotMatch(app.elements.topbar.className,/hidden/);
 app.key(40);app.key(13);app.respond('/api/meta/movie/tt123',{id:123,type:'movie',title:'Film'});
 app.key(13);app.respond('/api/streams/movie/123',{streams:[{url:'http://example.test/movie',provider:'Test'}]});app.key(13);
 assert.match(app.elements.topbar.className,/hidden/);
 app.key(10009);assert.doesNotMatch(app.elements.topbar.className,/hidden/);
});
