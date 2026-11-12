const assert=require('node:assert/strict');
// Run against a live model viewer with at least two visible parts.
// PLAYWRIGHT_MODULE may point to an installed playwright or playwright-core package.
// node tests/browser/isolate.cjs http://127.0.0.1:7891/   (tests/browser/run.py runs it on the bracket demo)
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1600,height:1050}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.argv[2]||'http://127.0.0.1:7891/');
 await page.waitForFunction(()=>window.viewer?.state().ready,null,{timeout:90000});
 await page.waitForTimeout(800);
 await page.evaluate(()=>{viewer.controls.enableDamping=false;});
 const state=()=>page.evaluate(()=>{const s=viewer.state();return {hidden:s.hidden.sort(),selected:s.selected,hp:s.hp,history:s.history,cam:s.cam.map(x=>+x.toFixed(7)),target:s.target.map(x=>+x.toFixed(7)),zoom:+s.zoom.toFixed(7),view:s.view,clip:s.clip,explode:s.explode};});
 const points=await page.evaluate(async()=>{
  const T=await import('three'),r=document.querySelector('#c').getBoundingClientRect(),ray=new T.Raycaster(),ndc=new T.Vector2();
  const objs=[...viewer.nodes.values()].filter(n=>n.leaf&&n.obj.visible).map(n=>n.obj),found=new Map();
  for(let y=r.top+40;y<r.bottom-40;y+=16)for(let x=r.left+40;x<r.right-40;x+=16){
   ndc.set((x-r.left)/r.width*2-1,-(y-r.top)/r.height*2+1);ray.setFromCamera(ndc,viewer.camera);
   const hit=ray.intersectObjects(objs,true).find(h=>h.object.isMesh&&h.object.userData.key);
   if(hit&&!found.has(hit.object.userData.key))found.set(hit.object.userData.key,{key:hit.object.userData.key,x,y});
  }return [...found.values()];
 });
 assert(points.length>1,'need visible component samples');
 const [a,b]=points;
 await page.mouse.click(a.x,a.y);const before=await state();assert.equal(before.selected,a.key);
 await page.mouse.click(b.x,b.y,{button:'right'});
 assert(await page.locator('#component-menu').isVisible());assert.deepEqual(await state(),before,'menu must not select or commit');
 await page.keyboard.press('Escape');assert(await page.locator('#component-menu').isHidden());assert.deepEqual(await state(),before,'Escape dismiss must not clear selection');
 await page.mouse.click(b.x,b.y,{button:'right'});await page.locator('#title').click();
 assert(await page.locator('#component-menu').isHidden());assert.deepEqual(await state(),before,'outside dismissal adds no history');
 const canvasBox=await page.locator('#c').boundingBox();
 await page.mouse.click(canvasBox.x+2,canvasBox.y+2,{button:'right'});assert(await page.locator('#component-menu').isHidden());assert.deepEqual(await state(),before,'background right-click does not deselect');
 await page.mouse.click(b.x,b.y,{button:'right'});await page.locator('#isolate-component').click();
 const isolated=await state();assert.equal(isolated.hp,before.hp+1);assert.equal(isolated.selected,b.key);assert.deepEqual(isolated.cam,before.cam);assert.equal(isolated.view,before.view);
 assert.deepEqual(await page.evaluate(()=>[...viewer.nodes].filter(([k,r])=>r.leaf&&(viewer.vis.get(k)??true)).map(([k])=>k)),[b.key]);
 await page.keyboard.press('Control+z');let restored=await state();assert.deepEqual({...restored,history:before.history},before);
 await page.keyboard.press('Meta+Shift+z');assert.deepEqual(await state(),isolated);
 await page.keyboard.press('Meta+z');await page.keyboard.press('Control+y');assert.deepEqual(await state(),isolated);
 // Fusion navigation (the default): a middle drag pans; it neither opens a menu nor consumes an undo step, and a
 // right drag opens no menu either.
 assert.equal(await page.evaluate(()=>viewer.state().nav),'fusion');
 await page.mouse.move(b.x,b.y);await page.mouse.down({button:'right'});await page.mouse.move(b.x+90,b.y+40,{steps:8});await page.mouse.up({button:'right'});
 assert(await page.locator('#component-menu').isHidden(),'a right drag opens no menu');assert.deepEqual((await state()).cam,isolated.cam,'a right drag does not move the camera under Fusion');
 await page.mouse.move(b.x,b.y);await page.mouse.down({button:'middle'});await page.mouse.move(b.x+90,b.y+40,{steps:8});await page.mouse.up({button:'middle'});await page.waitForTimeout(800);
 const panned=await state();assert.equal(panned.hp,isolated.hp);assert.notDeepEqual(panned.cam,isolated.cam);assert(await page.locator('#component-menu').isHidden());
 await page.keyboard.press('Control+z');const panUndo=await state();assert.deepEqual(panUndo.hidden,before.hidden);assert.equal(panUndo.selected,before.selected);assert.deepEqual(panUndo.cam,panned.cam,'visibility undo preserves later orbit/pan');
 // Tree context menu works for hidden components and preserves existing selection until execution.
 await page.evaluate(k=>{const r=viewer.nodes.get(k);r.el.scrollIntoView({block:'center'});},b.key);
 const bb=await page.evaluate(k=>{const r=viewer.nodes.get(k).el.getBoundingClientRect();return{x:r.x+80,y:r.y+r.height/2};},b.key);
 await page.mouse.click(bb.x,bb.y,{button:'right'});assert(await page.locator('#component-menu').isVisible());const treeBefore=await state();assert.equal(treeBefore.hp,panUndo.hp);
 await page.locator('#isolate-component').click();assert.equal((await state()).hp,treeBefore.hp+1);
 await page.keyboard.press('Control+z');assert.deepEqual((await state()).hidden,treeBefore.hidden);
 // Camera actions retain their own history before and after isolation.
 await page.locator('#fit').click();const changedView=await state();
 await page.keyboard.press('Control+z');assert.equal((await state()).view,treeBefore.view);assert.deepEqual((await state()).cam,treeBefore.cam);
 await page.keyboard.press('Control+Shift+z');assert.equal((await state()).view,changedView.view);assert.deepEqual((await state()).cam,changedView.cam);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['canvas hit context menu','menu/Escape/outside dismissal no history or selection changes','blank right-click preserves selection','single-step isolation','Ctrl+Z','Cmd+Z','Cmd+Shift+Z','Ctrl+Y','middle-drag pan (Fusion), right drag inert','pan preserved on isolation undo','tree isolation','view action undo/redo'],samples:points.length}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
