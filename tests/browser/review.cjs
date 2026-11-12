const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
// End-to-end review workspace check against a live `aad view` with review on (one headless page):
// load, orbit, view cube face, pick two parts, two pins with notes and classes, undo and redo a pin, measure and
// attach it, scope lock, diff against a baseline (changed parts tinted, collateral = changed outside the scope),
// ghost, send a packet; then .cadreview/pins.json, scope.json and the packet must exist and match their schemas.
// Then: a checked-off pin leaves the list and the model (Resolved row, Reopen, undo); Not fixed (badge, first in the
// list, pins.json, aad review); follow-up pins from a pin and from the part menu; a second packet; with --model,
// two rebuilds after that packet still diff against the reviewed build (default choice, auto on rebuild and on
// reload) and Unchanged here since your packet; layout at 1280 and 1600 px wide and a 300 px panel (nothing
// clipped, touching or overflowing; screenshots of the Pins and Diff panels go to --shots DIR). Zero page errors.
//   node tests/browser/review.cjs http://127.0.0.1:7904/ --project /tmp/x/proj --baseline good \
//        --model /tmp/x/demo/bad/bracket_demo.glb --shots /tmp/x/shots
// The test writes pins and packets into the project, so it refuses a --project outside a temp or scratch directory
// unless --allow-real-project is given. --model is the file the viewer serves (a scratch copy: it is replaced to
// simulate rebuilds).
// PLAYWRIGHT_MODULE may point at an installed playwright or playwright-core package. VIDEO_DIR records the run
// (1600 x 1050 webm). AAD_PYTHON is the python that runs `aad review` and validates the files (default python3, with numpy).
// tests/browser/run.py starts the viewer on a scratch copy of the bracket demo and runs this file.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const URL0=process.argv[2]&&!process.argv[2].startsWith('--')?process.argv[2]:'http://127.0.0.1:7891/';
const PROJECT=arg('--project'),BASELINE=arg('--baseline'),VIDEO=process.env.VIDEO_DIR,MODEL=arg('--model'),SHOTS=arg('--shots');
const REPO=path.resolve(__dirname,'..','..'),PY=process.env.AAD_PYTHON||'python3';
assert(PROJECT,'--project DIR is required (the CAD project whose .cadreview/ the viewer writes)');
// never write test pins into a real project: --project (and --model) must be under a temp or scratch directory
function scratchy(p){
  const real=fs.realpathSync(p),os=require('node:os');
  const roots=[os.tmpdir(),'/tmp','/private/tmp','/var/folders','/private/var/folders'].filter(d=>fs.existsSync(d)).map(d=>fs.realpathSync(d));
  return roots.some(d=>real===d||real.startsWith(d+path.sep))||/[\/]scratch(pad)?[\/]/i.test(real+path.sep);
}
for(const [k,p] of [['--project',PROJECT],['--model',MODEL]])if(p&&!scratchy(p)&&!process.argv.includes('--allow-real-project')){
  console.error(`refusing to run: ${k} ${p} is not under a temp or scratch directory (this test writes pins and packets there; pass --allow-real-project to override)`);
  process.exit(2);
}
function py(code,...args){
  const r=spawnSync(PY,['-I','-c','import sys\nsys.path.insert(0,sys.argv[1])\n'+code,REPO,...args],{encoding:'utf8'});
  assert.equal(r.status,0,`python failed: ${r.stderr}`);return r.stdout.trim();
}
function review(...args){
  const r=spawnSync(PY,['-m','aad','review','--project',PROJECT,...args],{encoding:'utf8',env:{...process.env,PYTHONPATH:REPO}});
  assert.equal(r.status,0,`aad review failed: ${r.stderr}`);return r.stdout;
}
function validate(file,schema){
  const code='import json,sys\nsys.path.insert(0,sys.argv[1])\nfrom aad.review.schema import validate\n'+
    'validate(json.load(open(sys.argv[2])),sys.argv[3])\nprint("valid",sys.argv[3])';
  const r=spawnSync(PY,['-I','-c',code,REPO,file,schema],{encoding:'utf8'});
  assert.equal(r.status,0,`${file} does not validate as ${schema}: ${r.stderr}`);return r.stdout.trim();
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const browser=await chromium.launch({headless:true});
 const checks=[];const ok=c=>{checks.push(c);};
 let context;
 try{
 context=await browser.newContext({viewport:{width:1600,height:1050},...(VIDEO?{recordVideo:{dir:VIDEO,size:{width:1600,height:1050}}}:{})});
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(URL0).origin});
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push('console.error: '+m.text());});
 await page.goto(URL0);
 await page.waitForFunction(()=>window.viewer?.state().ready&&window.viewer.review,null,{timeout:120000});
 await page.waitForTimeout(1500);
 const st=()=>page.evaluate(()=>{const s=viewer.state();return {hp:s.hp,history:s.history,cam:s.cam,target:s.target,zoom:s.zoom,selected:s.selected,view:s.view,review:s.review};});
 let s0=await st();assert(s0.review,'review workspace is on');assert.equal(await page.evaluate(()=>viewer.state().three),'187');
 assert(await page.evaluate(()=>viewer.state().cube),'view cube present');
 // earlier runs may have left pins, measurements and a scope lock in the project: count from here
 const n0=s0.review.pins.length,next0=s0.review.next,m0=s0.review.measurements.length,P1='p'+next0,P2='p'+(next0+1);
 if(s0.review.scope.length){await page.locator('#tabs [data-tab=diff]').click();await page.locator('#scope-clear').click();await page.locator('#tabs [data-tab=pins]').click();await page.waitForTimeout(300);s0=await st();}
 const box=await page.locator('#c').boundingBox();
 // ---- navigation, Fusion preset (the default): Shift+middle drag orbits about the point under the cursor, middle
 // drag pans, the wheel zooms; on a trackpad scroll pans, Shift+scroll orbits, pinch zooms. None is an undo step,
 // and every tool mode gives exactly the same camera for the same gestures (tools only take the left button). ----
 assert.equal(await page.evaluate(()=>viewer.state().nav),'fusion','Fusion navigation is the default');
 assert.match(await page.locator('#navhint').textContent(),/Fusion/,'the hint line names the navigation scheme');
 const cx=box.x+box.width/2,cy=box.y+box.height/2;
 const camNow=()=>page.evaluate(()=>{const s=viewer.state();return {cam:s.cam,target:s.target,zoom:s.zoom};});
 const camSet=c=>page.evaluate(c=>{const k=viewer.controls;k.enableDamping=false;k.setFocalOffset(0,0,0,false);
   k.setLookAt(...c.cam,...c.target,false);if(viewer.camera.isOrthographicCamera)k.zoomTo(c.zoom,false);k.update(0);},c);
 const wheels=(x,y,list)=>page.evaluate(([x,y,list])=>{const el=document.querySelector('#c');
   for(const w of list)el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:x,clientY:y,deltaMode:0,...w}));},[x,y,list]);
 const near=(a,b,eps)=>a.cam.every((v,i)=>Math.abs(v-b.cam[i])<eps)&&a.target.every((v,i)=>Math.abs(v-b.target[i])<eps)&&Math.abs(a.zoom-b.zoom)<1e-6*Math.max(1,a.zoom);
 const moved=(a,b)=>!near(a,b,1e-3);
 await camSet(await camNow());
 const startCam=await camNow();
 const gestures=async()=>{
   const out={},px=cx-40,py=cy+10;
   await page.mouse.move(px,py);await page.keyboard.down('Shift');await page.mouse.down({button:'middle'});
   await page.mouse.move(px+150,py+50,{steps:20});await page.mouse.up({button:'middle'});await page.keyboard.up('Shift');await page.waitForTimeout(250);
   out.orbit=await camNow();
   await page.mouse.move(px,py);await page.mouse.down({button:'middle'});await page.mouse.move(px+90,py-40,{steps:16});await page.mouse.up({button:'middle'});await page.waitForTimeout(250);
   out.pan=await camNow();
   await page.mouse.move(px,py);await page.mouse.wheel(0,-240);await page.waitForTimeout(700);
   out.wheel=await camNow();
   await wheels(px,py,Array.from({length:8},()=>({deltaX:6.5,deltaY:3.25})));await page.waitForTimeout(700);
   out.trackpadPan=await camNow();
   await wheels(px,py,Array.from({length:8},()=>({deltaX:5.5,deltaY:2.5,shiftKey:true})));await page.waitForTimeout(700);
   out.trackpadOrbit=await camNow();
   await wheels(px,py,Array.from({length:6},()=>({deltaY:-4.5,ctrlKey:true})));await page.waitForTimeout(700);
   out.pinch=await camNow();
   await page.mouse.move(px,py);await page.mouse.down();await page.mouse.move(px+120,py+30,{steps:12});await page.mouse.up();await page.waitForTimeout(250);
   out.leftDrag=await camNow();
   return out;
 };
 const navBy={},hp0=(await st()).hp,rv0=JSON.stringify((await page.evaluate(()=>{const r=viewer.review.state();return [r.pins.length,r.measurements.length,r.scope.length];})));
 for(const mode of ['select','pin','region','measure','scope']){
   await page.locator(`#modes [data-mode=${mode}]`).click();await camSet(startCam);await page.waitForTimeout(150);
   navBy[mode]=await gestures();
   const g=navBy[mode];
   assert(moved(g.orbit,startCam),`${mode}: Shift+middle drag orbits`);
   assert(g.orbit.target.some((v,i)=>Math.abs(v-startCam.target[i])>1e-3)||g.orbit.cam.some((v,i)=>Math.abs(v-startCam.cam[i])>1e-3),`${mode}: orbit moved`);
   assert(moved(g.pan,g.orbit)&&Math.abs(g.pan.zoom-g.orbit.zoom)<1e-9,`${mode}: middle drag pans without zooming`);
   assert(Math.abs(g.wheel.zoom-g.pan.zoom)>1e-3*g.pan.zoom||Math.hypot(...g.wheel.cam.map((v,i)=>v-g.pan.cam[i]))>1e-3,`${mode}: the wheel zooms`);
   assert(moved(g.trackpadPan,g.wheel)&&Math.abs(g.trackpadPan.zoom-g.wheel.zoom)<1e-9,`${mode}: two-finger scroll pans`);
   assert(moved(g.trackpadOrbit,g.trackpadPan),`${mode}: Shift+two-finger scroll orbits`);
   assert(Math.abs(g.pinch.zoom-g.trackpadOrbit.zoom)>1e-4*g.trackpadOrbit.zoom||moved(g.pinch,g.trackpadOrbit),`${mode}: pinch zooms`);
   assert(near(g.leftDrag,g.pinch,1e-6),`${mode}: the left button never moves the camera`);
   if(mode!=='select')for(const k of Object.keys(g))assert(near(g[k],navBy.select[k],2e-3),`${mode}: ${k} matches Select mode exactly (${JSON.stringify(g[k])} vs ${JSON.stringify(navBy.select[k])})`);
   assert.equal(await page.locator('#pin-dialog').isVisible(),false,`${mode}: navigation opens no pin editor`);
 }
 await page.keyboard.press('Escape');await page.waitForTimeout(200);
 assert.equal((await st()).hp,hp0,'navigation is not a history step');
 assert.equal(JSON.stringify(await page.evaluate(()=>{const r=viewer.review.state();return [r.pins.length,r.measurements.length,r.scope.length];})),rv0,'navigation drops no pins, measurements or scope marks');
 ok('Fusion navigation identical in select, pin, region, measure and scope');
 // Classic preset from Options: left drag orbits again; back to Fusion
 await page.locator('#options').click();await page.locator('input[name=nav][value=classic]').check();await page.keyboard.press('Escape');
 assert.match(await page.locator('#navhint').textContent(),/Classic/);
 await camSet(startCam);await page.mouse.move(cx-40,cy+10);await page.mouse.down();await page.mouse.move(cx+80,cy+40,{steps:12});await page.mouse.up();await page.waitForTimeout(250);
 assert(moved(await camNow(),startCam),'Classic: left drag orbits');
 await page.locator('#options').click();await page.locator('input[name=nav][value=fusion]').check();await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>viewer.state().nav),'fusion');await camSet(startCam);ok('Classic preset switch');
 await page.evaluate(()=>{viewer.controls.enableDamping=true;});
 const s1=await st();assert.notDeepEqual(s1.cam,s0.cam,'orbit moved the camera');ok('orbit about cursor');
 // ---- view cube: Home, then the FRONT face (lower left of the cube from the iso corner) ----
 await page.locator('#home').click();await page.waitForTimeout(900);
 const cubeBox=await page.evaluate(()=>{const e=viewer.cube._domElement||viewer.cube.domElement;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
 const hpCube=(await st()).hp;
 const dirOf=async()=>page.evaluate(()=>{const c=viewer.state();const d=c.target.map((t,i)=>t-c.cam[i]);const n=Math.hypot(...d);return d.map(x=>x/n);});
 const faceHits=[];
 for(const [fx,fy] of [[0.30,0.62],[0.27,0.66],[0.33,0.58],[0.25,0.6]]){
  await page.mouse.move(cubeBox.x+cubeBox.w*fx,cubeBox.y+cubeBox.h*fy,{steps:6});await page.mouse.click(cubeBox.x+cubeBox.w*fx,cubeBox.y+cubeBox.h*fy);
  await page.waitForTimeout(1400);const d=await dirOf();faceHits.push(d.map(x=>+x.toFixed(3)));
  if(d[1]>0.99)break;
 }
 const dFront=await dirOf();
 assert(dFront[1]>0.99,`cube FRONT face looks along +Y from the -Y side, got ${JSON.stringify(faceHits)}`);
 assert((await st()).hp>hpCube,'cube move is one undo step');ok('view cube FRONT face');
 await page.keyboard.press('Control+z');await page.waitForTimeout(400);
 const dBack=await dirOf();assert(dBack[1]<0.99,'undo brings the cube move back');ok('cube move undo');
 // ---- view cube: tight in the viewport's top-right corner, and dragging it orbits the camera live ----
 const cb=(await page.evaluate(()=>viewer.state().cubeBox));
 assert(cb.top>=0&&cb.top<=16&&cb.right>=0&&cb.right<=16,`view cube within 16 px of the viewport's top-right corner, got ${JSON.stringify(cb)}`);
 await page.waitForTimeout(600);
 const hpDrag=(await st()).hp,d0=await dirOf(),kx=cubeBox.x+cubeBox.w*0.5,ky=cubeBox.y+cubeBox.h*0.5;
 await page.mouse.move(kx,ky);await page.mouse.down();await page.mouse.move(kx+25,ky+6,{steps:6});
 await page.waitForTimeout(150);const dMid=await dirOf();
 await page.mouse.move(kx+70,ky+20,{steps:10});await page.waitForTimeout(150);const dLate=await dirOf();
 await page.mouse.up();await page.waitForTimeout(500);const d1=await dirOf();
 const ang=(a,b)=>Math.acos(Math.max(-1,Math.min(1,a[0]*b[0]+a[1]*b[1]+a[2]*b[2])))*180/Math.PI;
 assert(ang(d0,dMid)>3&&ang(dMid,dLate)>3,`dragging the cube rotates the camera while dragging (${ang(d0,dMid).toFixed(1)}, ${ang(dMid,dLate).toFixed(1)} deg)`);
 assert(ang(d1,dLate)<1,'the camera stays where the drag left it');
 assert.equal((await st()).hp,hpDrag+1,'a cube drag is one undo step');
 await page.mouse.move(cx,cy+60);await page.mouse.down({button:'middle'});await page.mouse.move(cx+30,cy+60,{steps:4});await page.mouse.up({button:'middle'});
 assert.equal(await page.evaluate(()=>viewer.state().orbit),true,'navigation works after a cube drag');
 ok('view cube in the top-right corner, drag orbits live');
 await page.keyboard.press('Control+z');await page.waitForTimeout(600);
 await page.waitForTimeout(500);
 // ---- pick two parts: sample the view with the page's own picker ----
 const samples=await page.evaluate(()=>{const r=document.querySelector('#c').getBoundingClientRect(),found=new Map();
  for(let y=r.top+60;y<r.bottom-60;y+=14)for(let x=r.left+60;x<r.right-160;x+=14){const i=viewer.pickAt(x,y);
   if(i&&!found.has(i.part.key)){const b=i.bbox,v=(b.max[0]-b.min[0])*(b.max[1]-b.min[1])*(b.max[2]-b.min[2]);found.set(i.part.key,{key:i.part.key,node:i.part.node,x,y,n:0,v});}
   if(i)found.get(i.part.key).n++;}
  return [...found.values()].sort((a,b)=>b.n-a.n);});
 assert(samples.length>=2,'need two visible parts');
 // two well-visible parts: the most sampled ones, with a stable point near the middle of each part's samples
 const pts=await page.evaluate(ss=>ss.slice(0,2).map(s=>{const r=document.querySelector('#c').getBoundingClientRect(),hits=[];
   for(let y=r.top+60;y<r.bottom-60;y+=14)for(let x=r.left+60;x<r.right-160;x+=14){const i=viewer.pickAt(x,y);if(i&&i.part.key===s.key)hits.push([x,y]);}
   hits.sort((a,b)=>a[1]-b[1]||a[0]-b[0]);const m=hits[Math.floor(hits.length/2)];return {key:s.key,node:s.node,x:m[0],y:m[1]};}),samples);
 const [A,B]=pts;
 await page.mouse.move(A.x,A.y,{steps:8});await page.mouse.click(A.x,A.y);await page.waitForTimeout(300);
 assert.equal((await st()).selected,A.key,'click selects part A');
 assert.match(await page.locator('#pickinfo').textContent(),/local .* normal .* box/,'footer shows world, local, normal and box');
 await page.mouse.move(B.x,B.y,{steps:8});await page.mouse.click(B.x,B.y);await page.waitForTimeout(300);
 assert.equal((await st()).selected,B.key,'click selects part B');ok('pick two parts');
 // ---- right-click part menu: the per-part actions; opening it neither selects nor commits ----
 const hpMenu=(await st()).hp;
 await page.mouse.click(A.x,A.y,{button:'right'});await page.locator('#component-menu').waitFor({state:'visible'});
 const items=await page.locator('#component-menu button:visible').allTextContents();
 for(const want of [/^Isolate/,/^Hide$/,/^Solo group/,/^Show all$/,/^Fit to part$/,/^Pin this part$/,/^Measure from here$/,/scope lock$/,/^Copy part name$/])
  assert(items.some(t=>want.test(t.trim())),`menu has ${want} (items ${JSON.stringify(items)})`);
 assert.equal((await st()).hp,hpMenu,'opening the menu commits nothing');assert.equal((await st()).selected,B.key,'opening the menu does not select');
 await page.locator('#hide-component').click();await page.waitForTimeout(200);
 let sh=await page.evaluate(()=>({hidden:viewer.state().hidden,hp:viewer.state().hp}));
 assert(sh.hidden.includes(A.key)&&sh.hp===hpMenu+1,'Hide hides the part as one undo step');
 await page.keyboard.press('Control+z');await page.waitForTimeout(200);
 assert(!(await page.evaluate(()=>viewer.state().hidden)).includes(A.key),'undo shows it again');
 await page.mouse.click(A.x,A.y,{button:'right'});await page.locator('#copy-component').click();await page.waitForTimeout(300);
 assert.match(await page.evaluate(()=>viewer.lastCopied),new RegExp(A.node.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'Copy part name copies the code name and tree path');
 ok('right-click part menu: '+items.length+' actions, Hide + undo, Copy part name');
 // ---- two pins with notes, classes and severities ----
 // the pin editor is a non-modal card beside the pin: no backdrop, it never covers the pin marker or the picked
 // point, and the canvas keeps orbit input while it is open
 const editorChecks=async(label)=>{
   const ed=(await page.evaluate(()=>viewer.review.state().editor));assert(ed.open&&ed.point,`${label}: editor open with its point on screen`);
   const c=ed.card,inCard=(x,y)=>x>=c.x&&x<=c.x+c.w&&y>=c.y&&y<=c.y+c.h;
   assert(!inCard(ed.point.x,ed.point.y),`${label}: the card does not cover the picked point`);
   const mk=await page.locator('#pin-draft').boundingBox();assert(mk,'draft marker shown');
   assert(mk.x>c.x+c.w||mk.x+mk.width<c.x||mk.y>c.y+c.h||mk.y+mk.height<c.y,`${label}: the card does not cover the pin marker ${JSON.stringify(mk)} card ${JSON.stringify(c)}`);
   assert(c.w*c.h<0.25*box.width*box.height,`${label}: the card is a small panel`);
   const backdrop=await page.evaluate(([b])=>[[b.x+12,b.y+b.height-12],[b.x+b.width-12,b.y+b.height-12],[b.x+12,b.y+40],[b.x+b.width/2,b.y+b.height-30]]
     .map(([x,y])=>{const e=document.elementFromPoint(x,y);return !e?'none':e.id==='c'||e.closest('#pin-dialog')||e.closest('.pin-marker,.measure-label,.measure-dot,.side-label')?'ok':(e.id||e.className||e.tagName);}),[box]);
   for(const id of backdrop)assert.equal(id,'ok',`${label}: nothing dims or blocks the canvas (found ${id})`);
   assert.equal(await page.evaluate(()=>{const d=document.getElementById('pin-dialog');return getComputedStyle(d).position+'|'+d.getAttribute('aria-modal');}),'absolute|false',`${label}: card is not modal`);
 };
 const dropPin=async(P,note,cls,sev,orbitWhileOpen=false)=>{
  await page.locator('#modes [data-mode=pin]').click();
  await page.mouse.move(P.x,P.y,{steps:8});await page.mouse.click(P.x,P.y);
  await page.locator('#pin-dialog').waitFor({state:'visible'});await page.waitForTimeout(200);
  await editorChecks('pin at '+P.node);
  if(orbitWhileOpen){
   // orbit and pan with the editor open: the camera moves, the card stays open and attached, still clear of the pin
   const c0=await camNow(),e0=await page.evaluate(()=>viewer.review.state().editor);
   const ox=box.x+box.width*0.2,oy=box.y+box.height*0.75;
   await page.mouse.move(ox,oy);await page.keyboard.down('Shift');await page.mouse.down({button:'middle'});
   await page.mouse.move(ox+110,oy-30,{steps:20});await page.mouse.up({button:'middle'});await page.keyboard.up('Shift');await page.waitForTimeout(700);
   const c1=await camNow(),e1=await page.evaluate(()=>viewer.review.state().editor);
   assert(moved(c1,c0),'Shift+middle drag orbits while the pin editor is open');assert(e1.open,'the editor stays open while orbiting');
   assert(Math.hypot(e1.point.x-e0.point.x,e1.point.y-e0.point.y)>2,'the pin point moved on screen');await editorChecks('after orbit');
   await page.mouse.move(ox,oy);await page.mouse.wheel(0,-120);await page.waitForTimeout(600);
   assert(moved(await camNow(),c1),'the wheel zooms while the pin editor is open');
   // drag the card by its header: it moves and stays attached at that offset
   const g=await page.locator('#pin-grip').boundingBox();
   await page.mouse.move(g.x+30,g.y+g.height/2);await page.mouse.down();await page.mouse.move(g.x+30,g.y+g.height/2+90,{steps:8});await page.mouse.up();
   const e2=await page.evaluate(()=>viewer.review.state().editor);assert(e2.dragged&&Math.abs(e2.card.y-e1.card.y)>40,'the card drags by its header');
   ok('pin editor non-modal: no backdrop, clear of the pin, orbit, zoom and header drag while open');
   await camSet(c0);await page.evaluate(()=>{viewer.controls.enableDamping=true;});await page.waitForTimeout(300);   // back to the view the parts were sampled in
  }
  await page.locator('#pin-note').fill(note);await page.locator('#pin-severity').selectOption(sev);
  await page.waitForTimeout(300);
  await page.locator(`#pin-chips [data-class=${cls}]`).click();          // one click on a class chip saves the pin
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#pin-dialog').isVisible(),false,'a class chip saves and closes the editor');
 };
 await dropPin(A,'Wall next to this hole looks too thin, keep the boss solid','weird_geometry','high',true);
 await dropPin(B,'Check the clearance to the neighbouring part here','fit_clearance','medium');
 let rv=(await st()).review;
 assert.equal(rv.pins.length,n0+2);assert.deepEqual(rv.pins.slice(-2).map(p=>[p.id,p.issue_class]),[[P1,'weird_geometry'],[P2,'fit_clearance']]);
 assert(rv.markers>=2,'numbered markers visible');
 const texts=await page.locator('.pin-marker').allTextContents();
 assert(texts.includes(String(next0))&&texts.includes(String(next0+1)),'markers numbered '+next0+' and '+(next0+1));ok('two pins with notes and classes');
 // ---- undo and redo a pin (the review state is in the page's one history) ----
 await page.keyboard.press('Control+z');await page.waitForTimeout(400);
 assert.equal((await st()).review.pins.length,n0+1,'undo removes the second pin');
 await pause(600);let pf=JSON.parse(fs.readFileSync(path.join(PROJECT,'.cadreview','pins.json'),'utf8'));
 assert.equal(pf.pins.length,n0+1,'pins.json follows the undo');
 await page.keyboard.press('Control+Shift+z');await page.waitForTimeout(400);
 assert.equal((await st()).review.pins.length,n0+2,'redo brings the second pin back');ok('undo and redo a pin');
 // ---- the note is optional: a class alone is a complete pin; Enter in the empty note and a click away both save ----
 for(const how of ['enter','click-away']){
  await page.locator('#modes [data-mode=pin]').click();await page.mouse.click(A.x,A.y);await page.locator('#pin-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#pin-note').getAttribute('placeholder'),'Optional');
  if(how==='enter'){await page.locator('#pin-note').focus();await page.keyboard.press('Enter');}
  else{const c=await page.evaluate(()=>viewer.review.state().editor.card);const fx=c.x>box.x+box.width/2?box.x+40:box.x+box.width-60;await page.mouse.click(fx,box.y+box.height-40);}
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#pin-dialog').isVisible(),false,`${how} saves the pin with an empty note`);
  const last=await page.evaluate(()=>{const p=viewer.review.snapshot().p;return p[p.length-1];});
  assert.equal(last.note,'',`${how}: the saved pin has an empty note`);assert.equal((await st()).review.pins.length,n0+3);
  assert.match(await page.locator(`#pin-list li[data-pin=${last.id}] .note`).textContent(),/\S/,'the pin list shows the class meaning for an empty note');
  await page.keyboard.press('Escape');await page.keyboard.press('Control+z');await page.waitForTimeout(400);
  assert.equal((await st()).review.pins.length,n0+2,'undo removes the empty-note pin');
 }
 ok('note optional: Enter and a click away save an empty-note pin');
 // ---- measure two points and attach it to pin 2 ----
 await page.locator('#modes [data-mode=measure]').click();
 await page.mouse.click(A.x,A.y);await page.waitForTimeout(250);await page.mouse.click(B.x,B.y);await page.waitForTimeout(500);
 rv=(await st()).review;assert.equal(rv.measurements.length,m0+1);assert(rv.measurements[m0]>0,'distance > 0');
 const meas=await page.evaluate(i=>viewer.review.snapshot().ms[i],m0);
 const dd=meas.b.map((v,i)=>v-meas.a[i]);assert(Math.abs(Math.hypot(...dd)-meas.distance)<1e-3,'distance = |b - a|');
 await page.locator('#measure-list select').last().selectOption(P2);await page.waitForTimeout(300);
 assert(await page.evaluate(id=>viewer.review.snapshot().p.find(p=>p.id===id).measure!==null,P2),'measurement attached to the second pin');ok('measure + attach');
 // ---- scope lock: part A may change, everything else is locked ----
 await page.locator('#modes [data-mode=scope]').click();await page.mouse.click(A.x,A.y);await page.waitForTimeout(400);
 rv=(await st()).review;assert.deepEqual(rv.scope,[A.node]);ok('scope lock');
 await page.keyboard.press('Escape');await page.waitForTimeout(200);assert.equal((await st()).review.mode,'select');
 // ---- diff against the baseline: tinted changes, collateral = changed outside the scope ----
 await page.locator('#tabs [data-tab=diff]').click();
 const opts=await page.locator('#baseline option').evaluateAll(o=>o.map(x=>x.value));
 const bl=BASELINE&&opts.includes(BASELINE)?BASELINE:opts[0];assert(bl,`a baseline to diff against (options ${opts})`);
 await page.locator('#baseline').selectOption(bl);await page.locator('#diff-run').click();
 await page.waitForFunction(()=>viewer.review.state().diff,null,{timeout:180000});await page.waitForTimeout(600);
 rv=(await st()).review;const D=rv.diff,s=D.summary;
 assert(s.changed+s.moved+s.added+s.removed>=1,'at least one part differs from the baseline');
 assert(D.tinted>=1,'changed parts are tinted');
 const full=await page.evaluate(async b=>{const r=await fetch(new URL('review/diff.json?against='+encodeURIComponent(b),location.href));return r.json();},bl);
 for(const r of full.parts){
  const expect=r.status!=='unchanged'&&r.name!==A.node;
  assert.equal(r.collateral,expect,`collateral flag of ${r.name} (${r.status})`);
 }
 assert.deepEqual([...D.collateral].sort(),full.parts.filter(r=>r.collateral).map(r=>r.name).sort());
 const banner=await page.locator('#diff-out .banner').first().textContent();
 if(D.collateral.length)assert.match(banner,/COLLATERAL/);ok(`diff vs ${bl}: ${s.changed} changed, ${s.moved} moved, ${s.added} added, ${s.removed} removed, ${D.collateral.length} collateral`);
 await page.locator('#diff-ghost').check();await page.waitForFunction(()=>viewer.review.state().ghost>0,null,{timeout:120000});
 await page.waitForTimeout(800);ok('ghost baseline');
 await page.locator('#diff-ghost').uncheck();await page.waitForTimeout(300);
 // ---- send packet: JSON + annotated screenshot + prompt on the clipboard ----
 await page.locator('#tabs [data-tab=pins]').click();
 await page.locator('#send').click();
 await page.waitForFunction(()=>viewer.review.state().lastPacket,null,{timeout:60000});
 const pk=(await st()).review.lastPacket;
 assert(fs.existsSync(pk.packet)&&fs.existsSync(pk.screenshot),'packet.json and view.png exist');
 assert(pk.markers>=2,'pins composited on the screenshot');
 const clip=await page.evaluate(()=>navigator.clipboard.readText().catch(()=>null));
 if(clip!==null)assert.equal(clip,pk.prompt,'prompt copied');
 assert.match(pk.prompt,/aad review --project/);ok('send packet');
 await page.locator('#tabs [data-tab=issues]').click();await page.waitForTimeout(700);
 await page.locator('#tabs [data-tab=pins]').click();await page.waitForTimeout(500);
 // ---- Options: the viewport background changes the renderer clear colour and survives a reload; edges toggle ----
 await page.locator('#options').click();await page.locator('#bg-presets [data-bg=black]').click();await page.waitForTimeout(200);
 let vs=await page.evaluate(()=>viewer.state());assert.equal(vs.background,'#000000');assert.equal(vs.clearColor,'#000000','renderer clear colour follows the background');
 const edgesBefore=vs.edges;await page.locator('#opt-edges').setChecked(!edgesBefore);
 assert.equal(await page.evaluate(()=>viewer.state().edges),!edgesBefore,'edge display toggles');await page.locator('#opt-edges').setChecked(edgesBefore);
 await page.keyboard.press('Escape');
 await page.reload();await page.waitForFunction(()=>window.viewer?.state().ready&&window.viewer.review,null,{timeout:120000});await page.waitForTimeout(800);
 vs=await page.evaluate(()=>viewer.state());assert.equal(vs.background,'#000000','background survives a reload');assert.equal(vs.clearColor,'#000000');
 assert.equal(await page.evaluate(()=>document.getElementById('view').classList.contains('dark-bg')),true,'overlay text switches to light on a dark background');
 await page.locator('#options').click();await page.locator('#bg-presets [data-bg=light]').click();await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>viewer.state().background),'#e5e7eb','light grey preset restores the default');
 ok('Options: background black survives reload, clear colour follows, edges toggle');
 // ---- files on disk match their schemas ----
 await pause(500);
 const rd=path.join(PROJECT,'.cadreview');
 const vals=[validate(path.join(rd,'pins.json'),'pins'),validate(path.join(rd,'scope.json'),'scope'),validate(pk.packet,'packet'),validate(path.join(rd,'diff.json'),'diff')];
 pf=JSON.parse(fs.readFileSync(path.join(rd,'pins.json'),'utf8'));
 assert.deepEqual(pf.pins.slice(-2).map(p=>p.note),['Wall next to this hole looks too thin, keep the boss solid','Check the clearance to the neighbouring part here']);
 const packet=JSON.parse(fs.readFileSync(pk.packet,'utf8'));assert.equal(packet.pins.length,n0+2);assert.equal(packet.scope.length,1);assert(packet.pins.some(p=>p.id===P2&&p.measure));
 ok('files valid: '+vals.join(', '));
 // ---- edge pin: hovering near a feature edge highlights the whole edge; a click in Pin mode pins it ----
 await page.locator('#modes [data-mode=pin]').click();
 const eb=await page.locator('#c').boundingBox();
 const cand=await page.evaluate(b=>{let best=null;for(let y=b.y+80;y<b.y+b.height-80;y+=7)for(let x=b.x+80;x<b.x+b.width-200;x+=7){
   const e=viewer.edgeAt(x,y);if(e&&e.px<1.5&&(!best||e.length>best.length))best={...e,x,y};}return best;},eb);
 assert(cand,'a feature edge is pickable on screen');
 await page.mouse.move(cand.x-30,cand.y-30);await page.mouse.move(cand.x,cand.y,{steps:6});await page.waitForTimeout(300);
 assert(await page.evaluate(()=>viewer.hoverEdge),'hovering highlights the edge');
 assert(await page.locator('#edge-lines polyline.hover').count()>0,'the hovered edge is drawn');
 assert.match(await page.locator('#tip').textContent(),/^Edge \d/,'the tooltip gives the edge length');
 await page.mouse.click(cand.x,cand.y);await page.locator('#pin-dialog').waitFor({state:'visible'});
 assert.equal((await page.evaluate(()=>viewer.review.state().editor)).kind,'edge');assert.match(await page.locator('#pin-dialog-h').textContent(),/edge/i);
 await page.waitForTimeout(300);
 assert(await page.locator('#edge-lines polyline.draft').count()>0,'the edge being pinned is drawn');
 await page.locator('#pin-chips [data-class=weird_geometry]').click();await page.waitForTimeout(700);
 const edgePin=await page.evaluate(()=>{const p=viewer.review.snapshot().p;return p[p.length-1];});
 assert.equal(edgePin.kind,'edge');assert(edgePin.edge.points.length>=2,'edge polyline stored');
 assert(Math.abs(edgePin.edge.length_mm-cand.length)<1e-3,'edge length stored');assert.equal(edgePin.anchor.part.key,cand.key);
 assert(await page.locator('#edge-lines polyline.sev-medium').count()>0,'the open edge pin stays drawn in its pin colour');
 await pause(600);const pfE=JSON.parse(fs.readFileSync(path.join(rd,'pins.json'),'utf8'));const savedE=pfE.pins.find(p=>p.id===edgePin.id);
 assert(savedE&&savedE.kind==='edge'&&savedE.edge.start.length===3&&savedE.edge.end.length===3,'pins.json carries the edge with two endpoints');
 const vE=validate(path.join(rd,'pins.json'),'pins');
 ok(`edge pin: ${cand.length.toFixed(2)} mm edge of ${savedE.anchor.part.node}, ${savedE.edge.points.length} points, ${vE}`);
 const pinLi=id=>page.locator(`#pin-list > li.item[data-pin=${id}]`);
 const rstate=()=>page.evaluate(()=>viewer.review.state());
 const pinOf=async id=>(await rstate()).pins.find(p=>p.id===id);
 await page.locator('#modes [data-mode=select]').click();await page.locator('#tabs [data-tab=pins]').click();await page.waitForTimeout(300);
 // ---- 2: checking a pin off takes it out of the list and off the model at once; Resolved (n) holds it; undo ----
 const EP=edgePin.id,hpR=(await st()).hp;
 assert.equal(await pinLi(EP).count(),1,'the edge pin is listed');assert.equal(await page.locator(`.pin-marker[data-pin=${EP}]`).count(),1);
 await pinLi(EP).locator('[data-act=resolve]').click();await page.waitForTimeout(300);
 assert.equal(await pinLi(EP).count(),0,'a resolved pin leaves the list at once');
 assert.equal(await page.locator(`.pin-marker[data-pin=${EP}]`).count(),0,'and its marker leaves the model');
 assert.equal(await page.locator('#edge-lines polyline.sev-medium').count(),0,'and its edge line');
 assert.equal((await st()).hp,hpR+1,'resolving is one undo step');
 assert.match(await page.locator('#resolved-toggle').textContent(),/^Resolved \(\d+\)$/);
 assert.equal(await page.locator('#resolved-list').count(),0,'the Resolved row starts collapsed');
 await page.locator('#resolved-toggle').click();await page.waitForTimeout(200);
 assert.equal(await page.locator(`#resolved-list li[data-pin=${EP}] [data-act=reopen]`).count(),1,'expanded, it lists the pin with Reopen');
 await page.keyboard.press('Control+z');await page.waitForTimeout(400);
 assert.equal(await pinLi(EP).count(),1,'undo brings the pin back to the list');assert.equal(await page.locator(`.pin-marker[data-pin=${EP}]`).count(),1,'and its marker');
 await page.keyboard.press('Control+Shift+z');await page.waitForTimeout(400);
 await page.locator(`#resolved-list li[data-pin=${EP}] [data-act=reopen]`).click();await page.waitForTimeout(300);
 assert.equal((await pinOf(EP)).status,'open','Reopen opens it again');assert.equal(await pinLi(EP).count(),1);
 await pinLi(EP).locator('[data-act=resolve]').click();await page.waitForTimeout(300);
 ok('resolved pins leave the list and the model; Resolved (n) with Reopen; one undo step');
 // ---- 3: Not fixed: status not_fixed, attempts, escalated build, first in the list with a red badge ----
 await pinLi(P2).locator('[data-act=notfixed]').click();await page.waitForTimeout(400);
 let pn=await pinOf(P2);assert.equal(pn.status,'not_fixed');assert.equal(pn.attempts,1);
 assert.equal(await page.locator('#pin-list > li.item').first().getAttribute('data-pin'),P2,'a not-fixed pin moves to the top');
 assert.equal((await pinLi(P2).locator('.chip.notfixed').textContent()).trim(),'Not fixed, attempt 1');
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.chip.notfixed')).backgroundColor),'rgb(248, 81, 73)','the badge is red');
 assert.match((await pinLi(P2).locator('[data-act=notfixed]').textContent()).trim(),/^Not fixed$/,'the action has a label');
 assert.equal(await pinLi(P2).locator('[data-act=notfixed] .ic.i-alert-octagon').count(),1,'and a Tabler icon');
 await pinLi(P2).locator('[data-act=notfixed]').click();await page.waitForTimeout(300);
 assert.equal((await pinOf(P2)).attempts,1,'a second click on the same build does not count another attempt');
 await pause(600);pf=JSON.parse(fs.readFileSync(path.join(rd,'pins.json'),'utf8'));
 const p2f=pf.pins.find(p=>p.id===P2),curBuild=(await rstate()).build;
 assert(p2f.status==='not_fixed'&&p2f.attempts===1&&p2f.escalated_build===curBuild&&p2f.escalated_at,'pins.json: not_fixed, attempts 1, escalated build');
 validate(path.join(rd,'pins.json'),'pins');
 const rj=JSON.parse(review('--json'));assert.equal(rj.open_pins[0].id,P2,'aad review --json lists the not-fixed pin first');
 const ESC='Previous attempt did not fix this. Do not repeat the same approach; re-read the pin and the reviewed baseline.';
 assert.equal(rj.open_pins[0].escalation,ESC);const rt=review();assert(rt.includes('[NOT FIXED, attempt 1]')&&rt.includes(ESC),'aad review text says so');
 ok('Not fixed: top of the list, red badge, attempts 1 on build '+curBuild+', aad review lists it first');
 // ---- 4: follow-up pins, from a pin's actions and from the right-click part menu ----
 await pinLi(P1).locator('[data-act=followup]').click();await page.waitForTimeout(200);
 let rs=await rstate();assert.equal(rs.mode,'pin');assert.equal(rs.followParent,P1);
 assert.match(await page.locator('#modehint').textContent(),/^Follow-up to pin #\d+/);
 await page.mouse.move(A.x,A.y,{steps:4});await page.mouse.click(A.x,A.y);await page.locator('#pin-dialog').waitFor({state:'visible'});
 assert.match(await page.locator('#pin-dialog-h').textContent(),/^Follow-up to pin #\d+$/);
 await page.locator('#pin-chips [data-class=weird_geometry]').click();await page.waitForTimeout(400);
 const F1=(await rstate()).pins.slice(-1)[0];assert.equal(F1.parent,P1,'the follow-up records its parent');assert.equal((await rstate()).mode,'select');
 assert.equal(await pinLi(F1.id).evaluate(e=>e.classList.contains('child')&&e.previousElementSibling?.dataset.pin),P1,'listed indented right under its parent');
 await page.mouse.click(A.x,A.y,{button:'right'});await page.locator('#component-menu').waitFor({state:'visible'});
 assert.match(await page.locator('#followup-component').textContent(),/^Add follow-up pin \(to #\d+\)$/,'the part menu offers a follow-up');
 await page.locator('#followup-component').click();await page.locator('#pin-dialog').waitFor({state:'visible'});
 assert.match(await page.locator('#pin-dialog-h').textContent(),/^Follow-up to pin #\d+$/);
 await page.locator('#pin-chips [data-class=fit_clearance]').click();await page.waitForTimeout(400);
 const F2=(await rstate()).pins.slice(-1)[0],F2p=await pinOf(F2.parent);
 assert(F2.parent&&F2p&&F2p.status!=='resolved','the part-menu follow-up records an open parent pin');
 assert.equal(await pinLi(F2.id).evaluate(e=>e.classList.contains('child')),true);
 await pause(600);validate(path.join(rd,'pins.json'),'pins');
 assert.equal(JSON.parse(fs.readFileSync(path.join(rd,'pins.json'),'utf8')).pins.find(p=>p.id===F1.id).parent,P1);
 ok(`follow-up pins: ${F1.id} under ${P1} from its actions, ${F2.id} under ${F2.parent} from the part menu`);
 // ---- a second packet: the not-fixed pin first, with the escalation line ----
 await page.locator('#send').click();await page.waitForFunction(p=>viewer.review.state().lastPacket?.packet!==p,pk.packet,{timeout:60000});
 const pk2=(await rstate()).lastPacket,pkd=JSON.parse(fs.readFileSync(pk2.packet,'utf8'));
 validate(pk2.packet,'packet');assert.equal(pkd.pins[0].id,P2);assert.equal(pkd.pins[0].escalation,ESC);assert.match(pkd.prompt,/NOT FIXED/);
 assert(pkd.pins.some(p=>p.id===F1.id&&p.parent===P1),'the packet carries the follow-up parent');
 const B0=pkd.model.build;ok('second packet '+pkd.id+' against build '+B0+': not-fixed pin first with the escalation line');
 // ---- 1: two builds after one packet still diff against the reviewed build ----
 if(MODEL){
  const tmp=fs.mkdtempSync(path.join(path.dirname(MODEL),'.rebuild-'));
  const mk=(src,out,k)=>py('from aad.review.glb import read_parts, write_parts\nps=read_parts(sys.argv[2])\n'+
    'for p in ps:\n if p.name=="screw_m5x20":\n  v=p.vertices.copy();v[v[:,2]>5,2]*=float(sys.argv[4]);p.vertices=v\nwrite_parts(sys.argv[3],ps)',src,out,String(k));
  const bid=f=>py('from aad.review.store import build_id\nprint(build_id([sys.argv[2]]))',f);
  const v1=path.join(tmp,'v1.glb'),v2=path.join(tmp,'v2.glb');mk(MODEL,v1,1.1);mk(MODEL,v2,1.2);
  const swap=f=>{const t=MODEL+'.tmp';fs.copyFileSync(f,t);fs.renameSync(t,MODEL);};
  const B1=bid(v1),B2=bid(v2);
  for(const [f,b] of [[v1,B1],[v2,B2]]){
   swap(f);
   await page.waitForFunction(b=>{const r=viewer.review.state();return r.build===b&&r.diff&&r.diff.b===b&&!document.querySelector('#diff-run').disabled;},b,{timeout:120000});
   await page.waitForTimeout(800);
  }
  rs=await rstate();const first=await page.locator('#baseline option').first();
  const rvId=await first.getAttribute('value'),rvLabel=await first.textContent();
  assert.match(rvLabel,/^since your last packet \(reviewed \d\d:\d\d\)$/,'the default choice is since your last packet');
  assert.equal(await page.locator('#baseline').inputValue(),rvId,'and it is selected');
  assert.equal(rs.diff.against,rvId,'the automatic diff after the second build compares against the reviewed build');
  const labels=await page.locator('#baseline option').allTextContents();
  assert(labels.some(l=>/^previous build \(\d\d:\d\d, build [0-9a-f]{12}\)$/.test(l)),`the previous build is listed below it (${labels})`);
  assert(labels.some(l=>/^version .* \(from the manifest\)$/.test(l)),'and the manifest versions');
  assert.equal(await page.locator('#tab-diff').isVisible(),true,'the Diff tab opens after a rebuild');
  const dd=await page.evaluate(async()=>(await fetch(new URL('review/diff.json',location.href))).json());
  assert.equal(dd.a.build,B0,'the default diff is against the build the packet was sent against');assert.equal(dd.a.kind,'reviewed');
  assert.equal(dd.parts.find(r=>r.name==='screw_m5x20').status,'changed');
  assert.match(await page.locator('#diff-out .diffhead').textContent(),/old vs fixed\s+Current build against since your last packet/);
  // Unchanged here since your packet: matches the server's per-pin answer
  await page.waitForFunction(()=>viewer.review.state().pinChanges,null,{timeout:60000});
  const pc=await page.evaluate(async()=>(await fetch(new URL('review/pin-changes.json',location.href))).json());
  assert.equal(pc.against.build,B0);
  const want=Object.entries(pc.pins).filter(([id,c])=>!c.part_changed&&c.near_changed!==true).map(([id])=>id).sort();
  await page.locator('#tabs [data-tab=pins]').click();await page.waitForTimeout(300);
  const shown=(await page.locator('#pin-list > li.item').evaluateAll(ls=>ls.filter(l=>l.querySelector('.chip.same')).map(l=>l.dataset.pin))).sort();
  assert.deepEqual(shown,want,'the Unchanged here badges match the server');
  if(![A.node,B.node].includes('screw_m5x20'))assert(want.includes(P1)&&shown.includes(P1),`pin ${P1} on an unchanged part shows Unchanged here since your packet`);
  assert.equal((await pinLi(P1).locator('.chip.same').textContent()).trim(),'Unchanged here since your packet');
  // a reload after the builds compares the reviewed version against the fixed one without a click
  await page.reload();await page.waitForFunction(()=>window.viewer?.state().ready&&window.viewer.review,null,{timeout:120000});
  await page.waitForFunction(id=>viewer.review.state().diff?.against===id,rvId,{timeout:120000});
  assert.equal(await page.locator('#baseline').inputValue(),rvId);
  fs.rmSync(tmp,{recursive:true,force:true});
  ok(`two builds after one packet (${B1}, ${B2}) still diff against the reviewed build ${B0}; auto on rebuild and reload; ${want.length} pin(s) unchanged here`);
 }
 // ---- 5: layout at 1280 and 1600 px and a 300 px panel: nothing clipped, touching or overflowing ----
 const layout=()=>page.evaluate(()=>{
  const bad=[],R=e=>e.getBoundingClientRect(),vis=e=>{const r=R(e);return r.width>0&&r.height>0&&!e.closest('[hidden]');};
  const pr=R(document.getElementById('panel'));
  for(const e of document.querySelectorAll('#panel *'))if(vis(e)){const r=R(e);if(r.right>pr.right+0.5||r.left<pr.left-0.5)bad.push('outside panel: '+(e.id||e.className||e.tagName));}
  for(const t of document.querySelectorAll('.tabpane'))if(vis(t)&&t.scrollWidth>t.clientWidth+1)bad.push('horizontal overflow in '+t.id);
  const pad=getComputedStyle(document.querySelector('.tabpane:not([hidden])'));if(pad.paddingLeft!=='12px'||pad.paddingRight!=='12px'||pad.paddingTop!=='12px')bad.push('panel padding '+pad.padding);
  for(const li of document.querySelectorAll('#pin-list li.item.pin')){
   if(!vis(li))continue;const lr=R(li),ph=li.querySelector('.ph'),acts=li.querySelector('.acts');
   if(R(acts).top<R(ph).bottom-0.5)bad.push(li.dataset.pin+': actions not below the header');
   const bs=[...acts.querySelectorAll('button')].map(R);
   bs.forEach((b,i)=>{if(b.right>lr.right-1||b.left<lr.left+1)bad.push(li.dataset.pin+': button '+i+' clipped');
     const n=bs[i+1];if(n&&Math.abs(n.top-b.top)<2&&n.left-b.right<7.5)bad.push(li.dataset.pin+': buttons '+i+','+(i+1)+' gap '+(n.left-b.right).toFixed(1));});
   if(/\b[0-9a-f]{12}\b/.test(li.innerText))bad.push(li.dataset.pin+': a build hash in the card text');
   const h=li.querySelector('.hist');if(h&&!/^(reopened: part changed again|marked not fixed|resolved) at (\w{3} \d+ )?\d\d:\d\d$/.test(h.textContent))bad.push('status line '+h.textContent);
  }
  const top=document.getElementById('top'),tb=[...top.querySelectorAll('button')].filter(vis).map(b=>[b.id||b.textContent.trim(),R(b)]);
  if(R(top).height>60)bad.push('toolbar wraps: '+R(top).height);
  for(const [n,r] of tb)if(r.right>innerWidth-4||r.left<4)bad.push('toolbar clipped: '+n);
  tb.sort((a,b)=>a[1].left-b[1].left);for(let i=1;i<tb.length;i++)if(tb[i][1].left-tb[i-1][1].right<3)bad.push('toolbar touching: '+tb[i-1][0]+' / '+tb[i][0]);
  return bad;});
 if(SHOTS)fs.mkdirSync(SHOTS,{recursive:true});
 const shots=[];
 for(const W of [1280,1600]){
  await page.setViewportSize({width:W,height:1000});await page.waitForTimeout(500);
  for(const tab of ['pins','diff']){
   await page.locator(`#tabs [data-tab=${tab}]`).click();await page.waitForTimeout(400);
   const bad=await layout();assert.deepEqual(bad,[],`${tab} at ${W} px`);
   if(SHOTS){const f=path.join(SHOTS,`${tab}-${W}.png`);await page.locator('#panel').screenshot({path:f});shots.push(f);}
  }
  if(SHOTS){const f=path.join(SHOTS,`window-${W}.png`);await page.screenshot({path:f});shots.push(f);}
  await page.locator('#options').click();await page.waitForTimeout(200);
  const ob=await page.evaluate(()=>{const p=document.getElementById('options-pop').getBoundingClientRect();return p.right<=innerWidth&&p.left>=0&&p.bottom<=innerHeight;});
  assert(ob,`Options popover inside the window at ${W} px`);await page.keyboard.press('Escape');
  await page.mouse.click(A.x<W?Math.min(A.x,W-420):W/2,Math.min(A.y,900),{button:'right'});await page.waitForTimeout(250);
  if(await page.locator('#component-menu').isVisible()){
   const mb=await page.evaluate(()=>{const m=document.getElementById('component-menu'),r=m.getBoundingClientRect(),bs=[...m.querySelectorAll('button')].filter(b=>!b.hidden).map(b=>b.getBoundingClientRect());
     return r.right<=innerWidth&&r.bottom<=innerHeight&&bs.every(b=>b.right<=r.right&&b.left>=r.left);});
   assert(mb,`part menu inside the window at ${W} px`);await page.keyboard.press('Escape');
  }
 }
 await page.evaluate(()=>document.body.style.setProperty('--panel-w','300px'));await page.locator('#tabs [data-tab=pins]').click();await page.waitForTimeout(400);
 assert.deepEqual(await layout(),[],'pins at a 300 px panel');
 if(SHOTS){const f=path.join(SHOTS,'pins-300px-panel.png');await page.locator('#panel').screenshot({path:f});shots.push(f);}
 await page.locator('#tabs [data-tab=diff]').click();await page.waitForTimeout(300);assert.deepEqual(await layout(),[],'diff at a 300 px panel');
 if(SHOTS){const f=path.join(SHOTS,'diff-300px-panel.png');await page.locator('#panel').screenshot({path:f});shots.push(f);}
 await page.evaluate(()=>document.body.style.removeProperty('--panel-w'));await page.setViewportSize({width:1600,height:1050});
 ok('layout at 1280 and 1600 px and a 300 px panel: no clipped, touching or overflowing controls'+(SHOTS?' ('+shots.length+' screenshots)':''));
 assert.deepEqual(errors,[],'no page errors');
 console.log(JSON.stringify({passed:true,url:URL0,baseline:bl,parts:[A.node,B.node],checks,packet:pk.packet,screenshot:pk.screenshot,pins:path.join(rd,'pins.json'),shots:SHOTS||null},null,1));
 await page.close();
 }finally{if(context)await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
