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
 const camNow=()=>page.evaluate(()=>{const s=viewer.state();return {cam:s.cam,target:s.target,zoom:s.zoom,up:s.up};});
 const camSet=c=>page.evaluate(c=>{const k=viewer.controls;k.enableDamping=false;k.setFocalOffset(0,0,0,false);viewer.camera.up.fromArray(c.up||[0,0,1]);k.updateCameraUp();
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
 // ---- 1. Free orbit (the default): one continuous Shift+middle drag carries the camera over the top pole and on
 // past the bottom pole, with no stop and no flip (view direction and up vector change smoothly at every step) ----
 assert.equal(await page.evaluate(()=>viewer.state().orbitMode),'free','Free orbit is the default');
 await page.evaluate(()=>{viewer.controls.enableDamping=false;});
 await page.locator('#home').click();await page.waitForTimeout(900);
 const look=()=>page.evaluate(()=>{const s=viewer.state(),d=s.cam.map((v,i)=>v-s.target[i]),n=Math.hypot(...d);
   const p=s.pivot,r=document.querySelector('#c').getBoundingClientRect();
   return {d:d.map(v=>v/n),up:s.screenUp,camUp:s.up,pivot:p,shown:s.pivotShown,px:p?viewer.toScreen(p):null};});
 const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
 {
  const x=cx,y0=box.y+30,y1=box.y+box.height-30,N=60,samp=[await look()];
  await page.mouse.move(x,y0);await page.keyboard.down('Shift');await page.mouse.down({button:'middle'});
  for(let i=1;i<=N;i++){await page.mouse.move(x,y0+(y1-y0)*i/N);samp.push(await look());}
  await page.mouse.up({button:'middle'});await page.keyboard.up('Shift');await page.waitForTimeout(200);
  const after=await look();
  let total=0,minUp=1,minD=1;const ez=samp.map(q=>q.d[2]);
  for(let i=1;i<samp.length;i++){const c=dot(samp[i].d,samp[i-1].d);minD=Math.min(minD,c);total+=Math.acos(Math.max(-1,Math.min(1,c)))*180/Math.PI;minUp=Math.min(minUp,dot(samp[i].up,samp[i-1].up));}
  const iTop=ez.findIndex(z=>z>0.99),iBot=ez.findIndex((z,i)=>i>iTop&&z<-0.99);
  assert(iTop>0,`the drag reaches the top pole (max view z ${Math.max(...ez).toFixed(4)})`);
  assert(iBot>iTop&&iBot<samp.length-1&&ez[samp.length-1]>ez[iBot],`and carries on over it and past the bottom pole (min z ${Math.min(...ez).toFixed(4)} at ${iBot} of ${N})`);
  assert(total>200,`over 200 degrees in one drag, got ${total.toFixed(1)}`);
  assert(minD>0.98&&minUp>0.98,`no stall or flip: smallest step cos view ${minD.toFixed(4)}, up ${minUp.toFixed(4)}`);
  // ---- 2. the pivot is the centre of what is shown: it stays put on screen, the marker shows only while orbiting
  assert(samp.slice(1).every(q=>q.shown),'the pivot marker shows while orbiting');assert.equal(after.shown,false,'and not at rest');
  const pxs=samp.map(q=>q.px);
  assert(pxs.every(p=>Math.hypot(p[0]-pxs[0][0],p[1]-pxs[0][1])<1.5),`the pivot stays fixed on screen through the orbit (${JSON.stringify([pxs[0],pxs[N>>1],pxs[N]])})`);
  ok(`free orbit: one Shift+middle drag over the top pole (step ${iTop}) and past the bottom pole (step ${iBot}), ${total.toFixed(0)} deg, up continuous (min cos ${minUp.toFixed(3)})`);
 }
 // independent check of the pivot: volume centroid of the visible closed meshes (signed tetrahedra in world space)
 const centroid=()=>page.evaluate(()=>{let V=0;const C=[0,0,0];
   for(const m of viewer.meshes()){let o=m,vis=true;for(;o;o=o.parent)if(!o.visible)vis=false;if(!vis)continue;
     m.updateMatrixWorld(true);const e=m.matrixWorld.elements,p=m.geometry.attributes.position,ix=m.geometry.index?m.geometry.index.array:null,n=ix?ix.length:p.count;
     const W=i=>{const x=p.getX(i),y=p.getY(i),z=p.getZ(i);return [e[0]*x+e[4]*y+e[8]*z+e[12],e[1]*x+e[5]*y+e[9]*z+e[13],e[2]*x+e[6]*y+e[10]*z+e[14]];};
     for(let t=0;t<n;t+=3){const a=W(ix?ix[t]:t),b=W(ix?ix[t+1]:t+1),c=W(ix?ix[t+2]:t+2);
       const v=(a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;V+=v;for(let k=0;k<3;k++)C[k]+=v*(a[k]+b[k]+c[k])/4;}}
   return C.map(x=>x/V);});
 const radius=await page.evaluate(()=>{const s=viewer.state();return Math.hypot(...s.cam.map((v,i)=>v-s.target[i]));});
 const close=(a,b,eps)=>a&&b&&a.every((v,i)=>Math.abs(v-b[i])<eps);
 const pv0=(await look()).pivot,c0=await centroid();
 assert(close(pv0,c0,0.05),`pivot ${JSON.stringify(pv0)} is the visible parts' volume centroid ${JSON.stringify(c0)}`);
 const pk0=await page.evaluate(()=>{const r=document.querySelector('#c').getBoundingClientRect();
   for(let y=r.top+80;y<r.bottom-80;y+=12)for(let x=r.left+80;x<r.right-200;x+=12){const i=viewer.pickAt(x,y);if(i)return {x,y,key:i.part.key};}return null;});
 assert(pk0,'a visible part to hide');
 await page.mouse.click(pk0.x,pk0.y,{button:'right'});await page.locator('#hide-component').click();await page.waitForTimeout(200);
 const pv1=(await look()).pivot,c1=await centroid();
 assert(!close(pv1,pv0,0.5)&&close(pv1,c1,0.05),`hiding ${pk0.key} moves the pivot to the new centroid (${JSON.stringify(pv1)} vs ${JSON.stringify(c1)})`);
 await page.keyboard.press('Control+z');await page.waitForTimeout(200);
 await page.mouse.click(pk0.x,pk0.y,{button:'right'});await page.locator('#isolate-component').click();await page.waitForTimeout(200);
 const pv2=(await look()).pivot,c2=await centroid();
 assert(!close(pv2,pv0,0.5)&&close(pv2,c2,0.05),`isolating ${pk0.key} moves the pivot to that part's centroid (${JSON.stringify(pv2)} vs ${JSON.stringify(c2)})`);
 await page.keyboard.press('Control+z');await page.waitForTimeout(200);
 assert(close((await look()).pivot,c0,0.05),'undo puts the pivot back');
 await page.evaluate(()=>viewer.clearSel());
 ok('orbit pivot = volume centroid of the visible parts, moves on hide and isolate, fixed on screen while orbiting');
 // Constrained (Options): the turntable, Z stays up and the drag stops at the pole; remembered across a reload
 await page.locator('#options').click();await page.locator('input[name=orbit][value=constrained]').check();await page.keyboard.press('Escape');
 await page.locator('#home').click();await page.waitForTimeout(900);
 {
  const x=cx,y0=box.y+30,y1=box.y+box.height-30,ez=[];
  await page.mouse.move(x,y0);await page.keyboard.down('Shift');await page.mouse.down({button:'middle'});
  for(let i=1;i<=30;i++){await page.mouse.move(x,y0+(y1-y0)*i/30);const q=await look();ez.push(q.d[2]);assert(q.camUp[2]>0.9999,'Constrained keeps Z up');}
  await page.mouse.up({button:'middle'});await page.keyboard.up('Shift');await page.waitForTimeout(200);
  assert(Math.min(...ez.slice(ez.findIndex(z=>z>0.99)))>0.9,`Constrained stops at the top pole (view z ${Math.min(...ez).toFixed(3)} after it)`);
 }
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('aad-viewer-options')).orbit),'constrained','the orbit choice is remembered');
 await page.locator('#options').click();await page.locator('input[name=orbit][value=free]').check();await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>viewer.state().orbitMode),'free');ok('Constrained orbit option: Z up, stops at the pole, remembered');
 await camSet(startCam);
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
 // ---- 3. view cube arrows: two roll arrows turn the view 90 degrees about the viewing axis, four triangles step to
 // the adjacent face; animated, one undo step each, shown when the pointer is at the cube, all inside the viewport ----
 {
  await page.evaluate(()=>viewer.applyView('front'));await page.waitForTimeout(400);
  const cb2=await page.evaluate(()=>{const e=viewer.cube._domElement||viewer.cube.domElement;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
  await page.mouse.move(cx,cy);assert.equal(await page.locator('#cube-nav').evaluate(e=>getComputedStyle(e).opacity),'0','the arrows hide away from the cube');
  await page.mouse.move(cb2.x+cb2.w/2,cb2.y+cb2.h/2,{steps:4});await page.waitForTimeout(300);
  assert.equal(await page.locator('#cube-nav').evaluate(e=>e.classList.contains('show')),true,'the arrows show at the cube');
  const ids=['cube-home','cube-roll-ccw','cube-roll-cw','cube-up','cube-down','cube-left','cube-right'];
  for(const id of ids){const t=await page.locator('#'+id).getAttribute('title');assert(t&&t.length>4,`${id} has a title`);
    assert.equal(await page.locator('#'+id+' i.ic').count(),1,`${id} draws a Tabler icon`);}
  const v=await page.evaluate(()=>document.querySelector('#view').getBoundingClientRect().toJSON());
  for(const id of ids){const r=await page.locator('#'+id).boundingBox();assert(r.x>=v.x&&r.y>=v.y&&r.x+r.width<=v.x+v.width&&r.y+r.height<=v.y+v.height,`${id} inside the viewport`);}
  const frame=async()=>{const q=await look();const f=q.d.map(x=>-x),u=q.up;return {d:q.d,up:u,right:[f[1]*u[2]-f[2]*u[1],f[2]*u[0]-f[0]*u[2],f[0]*u[1]-f[1]*u[0]]};};
  const same=(a,b,e=1e-4)=>a.every((x,i)=>Math.abs(x-b[i])<e),neg=a=>a.map(x=>-x);
  const press=async(id)=>{const h=(await st()).hp;await page.locator('#'+id).click();await page.waitForTimeout(650);assert.equal((await st()).hp,h+1,`${id}: one undo step`);};
  const f0=await frame();assert(same(f0.d,[0,-1,0],1e-3),'front view to start from');
  await press('cube-roll-cw');let f1=await frame();
  assert(same(f1.d,f0.d)&&same(f1.up,neg(f0.right),1e-4),`clockwise roll: same view axis, up becomes the old left (${JSON.stringify(f1.up)})`);
  await page.keyboard.press('Control+z');await page.waitForTimeout(300);
  assert(same((await frame()).up,f0.up,1e-6),'undo restores the up vector exactly');
  await press('cube-roll-ccw');f1=await frame();assert(same(f1.d,f0.d)&&same(f1.up,f0.right,1e-4),'counter-clockwise roll: up becomes the old right');
  await page.keyboard.press('Control+z');await page.waitForTimeout(300);
  const want={'cube-up':[f0.up,neg(f0.d)],'cube-down':[neg(f0.up),f0.d],'cube-left':[neg(f0.right),f0.up],'cube-right':[f0.right,f0.up]};
  for(const [id,[d,u]] of Object.entries(want)){
   await press(id);const f=await frame();
   assert(same(f.d,d,1e-6)&&same(f.up,u,1e-6),`${id}: lands square on the adjacent face (view ${JSON.stringify(f.d)}, up ${JSON.stringify(f.up)})`);
   await page.keyboard.press('Control+z');await page.waitForTimeout(300);assert(same((await frame()).d,f0.d,1e-6),`${id}: undo returns`);
  }
  // keyboard: the arrows take focus and Enter presses them
  await page.locator('#cube-up').focus();assert.equal(await page.locator('#cube-nav').evaluate(e=>getComputedStyle(e).opacity),'1','focus shows the arrows');
  await page.keyboard.press('Enter');await page.waitForTimeout(650);assert(same((await frame()).d,f0.up,1e-6),'Enter on a focused arrow steps');
  await page.keyboard.press('Control+z');await page.waitForTimeout(300);
  // a face click on the cube lands level with Z up, even from a rolled view
  await press('cube-roll-cw');await page.locator('#cube-home').click();await page.waitForTimeout(500);
  {const q=await look();assert(Math.abs(q.camUp[2]-1)<1e-9&&Math.abs(q.up[0]*q.d[1]-q.up[1]*q.d[0])<1e-6,'Home lands level, Z up');}
  ok('view cube arrows: roll 90 degrees both ways, step up, down, left and right to the adjacent face, one undo step each, keyboard focusable');
 }
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
 assert.deepEqual(items.slice(0,2).map(t=>t.trim()),['Select','Pin'],'Select and Pin head the menu');
 for(const want of [/^Isolate/,/^Hide$/,/^Solo group/,/^Show all$/,/^Fit to part$/,/^Measure from here$/,/scope lock$/,/^Copy part name$/])
  assert(items.some(t=>want.test(t.trim())),`menu has ${want} (items ${JSON.stringify(items)})`);
 assert.equal((await st()).hp,hpMenu,'opening the menu commits nothing');assert.equal((await st()).selected,B.key,'opening the menu does not select');
 // ---- 4. every item has a Tabler icon on the left, aligned in one column
 const icons=await page.evaluate(()=>[...document.querySelectorAll('#component-menu button')].filter(b=>b.offsetParent).map(b=>{const i=b.querySelector('i.ic'),s=b.querySelector('span');
   return {t:b.textContent.trim(),icon:!!i&&getComputedStyle(i).maskImage.includes('tabler-icons'),first:b.firstElementChild===i,x:i?Math.round(i.getBoundingClientRect().x):null,tx:s?Math.round(s.getBoundingClientRect().x):null};}));
 for(const i of icons)assert(i.icon&&i.first,`menu item ${i.t} has a Tabler icon on the left`);
 assert.equal(new Set(icons.map(i=>i.x)).size,1,'icons share one column');assert.equal(new Set(icons.map(i=>i.tx)).size,1,'labels share one column');
 // Select picks the part the menu was opened on, as one undo step
 await page.locator('#select-component').click();await page.waitForTimeout(200);
 assert.equal((await st()).selected,A.key,'Select selects the right-clicked part');assert.equal((await st()).hp,hpMenu+1,'Select is one undo step');
 await page.keyboard.press('Control+z');await page.waitForTimeout(200);assert.equal((await st()).selected,B.key,'undo gives the old selection back');
 // Pin drops a pin at the right-clicked point and opens the floating pin card there (Esc closes it unsaved)
 await page.mouse.click(A.x,A.y,{button:'right'});await page.locator('#component-menu').waitFor({state:'visible'});
 const nPins=(await page.evaluate(()=>viewer.review.state().pins.length));
 await page.locator('#pin-component').click();await page.locator('#pin-dialog').waitFor({state:'visible'});
 const ed=await page.evaluate(()=>viewer.review.state().editor);
 assert.equal(ed.kind,'point','the pin is a point pin');
 const cardBox=await page.locator('#pin-dialog').boundingBox();
 assert(Math.hypot(cardBox.x+cardBox.width/2-A.x,cardBox.y+cardBox.height/2-A.y)<cardBox.width+cardBox.height,'the card opens by the clicked point');
 await page.keyboard.press('Escape');await page.waitForTimeout(200);
 assert.equal(await page.locator('#pin-dialog').isVisible(),false);assert.equal(await page.evaluate(()=>viewer.review.state().pins.length),nPins,'Esc saves nothing');
 assert.equal((await st()).hp,hpMenu,'the menu round trip leaves history where it was');
 await page.mouse.click(A.x,A.y,{button:'right'});await page.locator('#component-menu').waitFor({state:'visible'});
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
 // ---- Revisions tab: one list newest first; clicking an older revision draws its geometry as a green hologram over
 // the solid current model, and runs the diff (collateral = changed outside the scope) ----
 await page.locator('#tabs [data-tab=diff]').click();
 assert.match(await page.locator('#tabs [data-tab=diff]').textContent(),/Revisions/,'the tab is Revisions');
 assert.equal(await page.locator('#baseline, #diff-run').count(),0,'no dropdown and no Compare button');
 await page.waitForFunction(()=>document.querySelectorAll('#rev-list li[data-rev]').length>1&&!document.querySelector('#rev-list').textContent.includes('counting'),null,{timeout:120000});
 assert.match(await page.locator('#rev-list li').first().textContent(),/now/,'the current build heads the list as now');
 const opts=await page.locator('#rev-list li[data-rev]').evaluateAll(o=>o.map(x=>x.dataset.rev).filter(Boolean));
 const bl=BASELINE&&opts.includes(BASELINE)?BASELINE:opts[0];assert(bl,`a revision to compare against (rows ${opts})`);
 const row=page.locator(`#rev-list li[data-rev="${bl}"]`);
 assert.match(await row.textContent(),/\d+ parts? differ from now|same as now/,'each row says how many parts differ from now');
 const hs=()=>page.evaluate(()=>viewer.review.state().holo);
 await row.click();
 await page.waitForFunction(b=>{const r=viewer.review.state();return r.diff?.against===b&&r.holo.visible&&r.holo.edges>0;},bl,{timeout:180000});await page.waitForTimeout(600);
 rv=(await st()).review;const D=rv.diff,s=D.summary;
 assert(s.changed+s.moved+s.added+s.removed>=1,'at least one part differs from the revision');
 const full=await page.evaluate(async b=>{const r=await fetch(new URL('review/diff.json?against='+encodeURIComponent(b),location.href));return r.json();},bl);
 const differing=full.parts.filter(r=>['changed','moved','removed'].includes(r.status)).map(r=>r.name);
 let H=await hs();
 assert.equal(rv.revisions.selected,bl,'the clicked row is selected');assert.equal(await row.evaluate(e=>e.classList.contains('sel')),true,'and highlighted');
 assert.equal(H.parts,differing.length,`the hologram draws the ${differing.length} differing part(s) by default`);
 // polish 5: feature edges and curved-surface silhouettes only, no tessellation wireframe (no triangle diagonals)
 assert.equal(H.wire,0,'no wireframe in the hologram');
 assert.deepEqual(H.kinds.filter(k=>!['edge','face','hidden','sil','silHidden'].includes(k)),[],'only faces, feature edges and silhouettes: '+H.kinds);
 assert(H.sil>0&&H.silSegs>0&&H.silSegs<H.silCand,`the curved boss draws a view-dependent silhouette (${H.silSegs} of ${H.silCand} smooth edges)`);
 const holoSegs=H.edgeSegs,flatTris=H.faceTris;
 assert(holoSegs<flatTris*1.5,`feature edges (${holoSegs}) are far fewer than a wireframe's ${flatTris*3} triangle sides`);
 {
  await page.evaluate(()=>{viewer.controls.rotate(1.2,0.5,false);});await page.waitForTimeout(500);
  const H2=await hs();assert(H2.silSegs>0,'the silhouette follows the camera');
  await page.evaluate(()=>{viewer.controls.rotate(-1.2,-0.5,false);});await page.waitForTimeout(400);}
 assert(H.modelVisible&&await page.evaluate(()=>viewer.meshes().every(m=>!m.material.transparent&&m.material.opacity===1)),'the current model stays solid');
 assert.equal(H.dark,false);assert.equal(H.blending,'normal','on the light background the hologram uses normal blending');
 const g=c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16));let [hr,hg,hb]=g(H.color);
 assert(hg>hr*2&&hg>hb*1.5&&hg<160,`a dark green on a light background (${H.color})`);
 if(SHOTS){fs.mkdirSync(SHOTS,{recursive:true});await page.screenshot({path:path.join(SHOTS,'hologram-light.png')});}
 assert.equal(D.tinted,0,'tint is no longer the default view');
 for(const [k,label] of [['dark','dark'],['black','black']]){
  await page.locator('#options').click();await page.locator(`#bg-presets [data-bg=${k}]`).click();await page.keyboard.press('Escape');await page.waitForTimeout(400);
  H=await hs();[hr,hg,hb]=g(H.color);assert(H.dark&&H.blending==='additive'&&hg>200&&hg>hr*2,`a bright additive green on the ${label} background (${H.color})`);
  if(SHOTS)await page.screenshot({path:path.join(SHOTS,`hologram-${label}.png`)});
 }
 await page.locator('#options').click();await page.locator('#bg-presets [data-bg=light]').click();await page.keyboard.press('Escape');await page.waitForTimeout(300);
 // whole old model, then back to the differing parts
 await page.locator('#rev-whole').check();await page.waitForFunction(n=>viewer.review.state().holo.parts>n,differing.length,{timeout:60000});
 assert((await hs()).parts>differing.length,'Whole old model draws every old part');await page.locator('#rev-whole').uncheck();await page.waitForTimeout(300);
 // flick: hold \ to see the old revision solid in place of the current model; release goes back
 await page.locator('#c').hover();await page.keyboard.down('Backslash');await page.waitForFunction(()=>viewer.review.state().holo.oldSolid>0,null,{timeout:60000});
 H=await hs();assert(H.flick&&!H.modelVisible&&!H.visible&&H.oldSolid>0,'holding \\ shows the old revision solid and hides the current model');
 await page.keyboard.up('Backslash');await page.waitForTimeout(200);H=await hs();
 assert(!H.flick&&H.modelVisible&&H.visible&&H.oldSolid===0,'releasing \\ brings back the current model and the hologram');
 const fb=await page.locator('#rev-flick').boundingBox();await page.mouse.move(fb.x+fb.width/2,fb.y+fb.height/2);await page.mouse.down();await page.waitForTimeout(400);
 H=await hs();assert(!H.modelVisible&&H.oldSolid>0,'holding Show old does the same');await page.mouse.up();await page.waitForTimeout(200);assert((await hs()).modelVisible);
 // clicking the row again turns the hologram off; Esc does too
 await row.click();await page.waitForTimeout(200);H=await hs();
 assert(!H.visible&&(await page.evaluate(()=>viewer.review.state().revisions.selected))===null,'clicking the selected row again turns the hologram off');
 await row.click();await page.waitForFunction(()=>viewer.review.state().holo.visible,null,{timeout:60000});
 await page.locator('#c').hover();await page.keyboard.press('Escape');await page.waitForTimeout(200);assert.equal((await hs()).visible,false,'Esc turns the hologram off');
 // arrow keys step through the revisions while the list has focus; hovering another row previews it
 if(opts.length>1){
  await page.locator('#rev-list').focus();await page.keyboard.press('ArrowDown');
  await page.waitForFunction(()=>viewer.review.state().revisions.selected,null,{timeout:60000});
  const sel1=await page.evaluate(()=>viewer.review.state().revisions.selected);await page.keyboard.press('ArrowDown');
  await page.waitForFunction(a=>{const s=viewer.review.state().revisions.selected;return s&&s!==a;},sel1,{timeout:60000});
  const sel2=await page.evaluate(()=>viewer.review.state().revisions.selected);assert.equal(opts.indexOf(sel2),opts.indexOf(sel1)+1,'ArrowDown steps to the next older revision');
  await page.keyboard.press('ArrowUp');await page.waitForFunction(a=>viewer.review.state().revisions.selected===a,sel1,{timeout:60000});
  const other=opts.find(o=>o!==sel1);await page.locator(`#rev-list li[data-rev="${other}"]`).hover();
  await page.waitForFunction(o=>viewer.review.state().revisions.peek===o&&viewer.review.state().holo.visible,other,{timeout:60000});
  await page.locator('#c').hover();await page.waitForFunction(()=>!viewer.review.state().revisions.peek,null,{timeout:10000});
  await page.keyboard.press('Escape');await page.waitForTimeout(200);
 }
 await row.click();await page.waitForFunction(b=>viewer.review.state().diff?.against===b&&viewer.review.state().holo.visible,bl,{timeout:180000});
 rv=(await st()).review;
 ok(`Revisions: ${opts.length} older revision(s); ${bl} as a green hologram of ${differing.length} part(s) over the solid model, whole model, flick with \\ and Show old, click again and Esc off, arrows and hover preview`);
 for(const r of full.parts){
  const expect=r.status!=='unchanged'&&r.name!==A.node;
  assert.equal(r.collateral,expect,`collateral flag of ${r.name} (${r.status})`);
 }
 assert.deepEqual([...D.collateral].sort(),full.parts.filter(r=>r.collateral).map(r=>r.name).sort());
 const banner=await page.locator('#diff-out .banner').first().textContent();
 if(D.collateral.length)assert.match(banner,/COLLATERAL/);ok(`diff vs ${bl}: ${s.changed} changed, ${s.moved} moved, ${s.added} added, ${s.removed} removed, ${D.collateral.length} collateral`);
 // More: tint, ghost baseline and unchanged too, all off by default; retention size and Clear old revisions
 assert.equal(await page.locator('#rev-more').isVisible(),false,'More starts collapsed');
 await page.locator('#rev-more-btn').click();assert.match(await page.locator('#rev-size').textContent(),/Stored revisions [\d.]+ MB/);assert.match(await page.locator('#rev-keep').inputValue(),/^\d+$/,'Stored builds to keep shows the setting');
 await page.locator('#diff-tint').check();await page.waitForTimeout(200);assert((await st()).review.diff.tinted>=1,'Tint changes still tints');await page.locator('#diff-tint').uncheck();
 await page.locator('#diff-ghost').check();await page.waitForFunction(()=>viewer.review.state().ghost>0,null,{timeout:120000});
 await page.waitForTimeout(800);ok('ghost baseline');
 await page.locator('#diff-ghost').uncheck();await page.waitForTimeout(300);
 await page.locator('#rev-more-btn').click();await page.locator('#c').hover();await page.keyboard.press('Escape');await page.waitForTimeout(200);
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
 // the Options check reloads the page after the first packet, so lastPacket starts null here: wait for the new one
 await page.locator('#send').click();await page.waitForFunction(p=>{const l=viewer.review.state().lastPacket;return !!l&&l.packet!==p;},pk.packet,{timeout:60000});
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
   await page.waitForFunction(b=>{const r=viewer.review.state();return r.build===b&&r.diff&&r.diff.b===b;},b,{timeout:120000});
   await page.waitForTimeout(800);
  }
  rs=await rstate();const first=page.locator('#rev-list li[data-rev]:not(.now)').first();
  const rvId=await first.getAttribute('data-rev'),rvLabel=await first.textContent();
  assert.match(rvLabel,/^\s*\d\d:\d\d\s*what you reviewed/,'the newest earlier revision is what you reviewed, with its time');
  assert.equal(rs.revisions.preselected,rvId,'and it is preselected');assert.equal(await first.evaluate(e=>e.classList.contains('pre')),true);
  assert.equal(rs.holo.visible,false,'but the hologram stays off until he clicks');
  assert.equal(rs.diff.against,rvId,'the automatic diff after the second build compares against the reviewed build');
  const labels=await page.locator('#rev-list li[data-rev]:not(.now) .lab').allTextContents();
  assert(labels.includes('previous build'),`the previous build is listed below it (${labels})`);
  assert(labels.some(l=>/^version /.test(l)),'and the manifest versions');
  assert(rs.revisions.rows.length>=3,'reviewed, builds and versions are all rows');
  assert.equal(await page.locator('#tab-diff').isVisible(),true,'the Revisions tab opens after a rebuild');
  // arrow keys step back in time through the list while it has focus; hovering another row previews it
  {const ids=rs.revisions.rows.map(r=>r.id);
   await page.locator('#rev-list').focus();await page.keyboard.press('ArrowDown');
   await page.waitForFunction(id=>viewer.review.state().revisions.selected===id&&viewer.review.state().holo.visible,ids[1],{timeout:120000});
   await page.keyboard.press('ArrowDown');await page.waitForFunction(id=>viewer.review.state().revisions.selected===id,ids[2],{timeout:120000});
   await page.keyboard.press('ArrowUp');await page.waitForFunction(id=>viewer.review.state().revisions.selected===id,ids[1],{timeout:120000});
   await page.locator(`#rev-list li[data-rev="${ids[0]}"]`).hover();
   await page.waitForFunction(id=>viewer.review.state().revisions.peek===id&&viewer.review.state().holo.visible,ids[0],{timeout:120000});
   await page.locator('#c').hover();await page.waitForFunction(()=>!viewer.review.state().revisions.peek,null,{timeout:10000});
   assert.equal((await rstate()).revisions.selected,ids[1],'the preview ends and the selected revision stays');
   await page.keyboard.press('Escape');await page.waitForTimeout(200);assert.equal((await rstate()).holo.visible,false);
   await page.evaluate(id=>viewer.review.runDiff(id,true),ids[0]);await page.waitForTimeout(300);     // back to the reviewed revision
   ok(`Revisions after two builds: ${ids.length} rows (reviewed first), arrow keys step through them, hover previews`);}
  const dd=await page.evaluate(async()=>(await fetch(new URL('review/diff.json',location.href))).json());
  assert.equal(dd.a.build,B0,'the default diff is against the build the packet was sent against');assert.equal(dd.a.kind,'reviewed');
  assert.equal(dd.parts.find(r=>r.name==='screw_m5x20').status,'changed');
  assert.match(await page.locator('#diff-out .diffhead').textContent(),/old vs fixed\s+Now against since your last packet/);
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
  assert.equal((await rstate()).revisions.preselected,rvId);
  fs.rmSync(tmp,{recursive:true,force:true});
  ok(`two builds after one packet (${B1}, ${B2}) still diff against the reviewed build ${B0}; auto on rebuild and reload; ${want.length} pin(s) unchanged here`);
 }
 // ---- class groups, keep pins, repin (functions at the end of this file) ----
 const X={page,A,B,rd,box,st,rstate,pinLi,ok,shots:SHOTS};
 await checkGroupedPinCard(X);await checkKeepPinIsALock(X);await checkMarkerColours(X);await checkRepin(X);
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
   // polish 2: the action row is one line, or two lines of at least two buttons each (never one lone button);
   // icon-only buttons carry a title, Resolve, Not fixed, Repin and Reopen keep their labels
   const lines=new Map();for(const b of bs){const k=Math.round(b.top);lines.set(k,(lines.get(k)||0)+1);}
   if(lines.size>2||[...lines.values()].some(n=>n<2))bad.push(li.dataset.pin+': action lines '+JSON.stringify([...lines.values()]));
   for(const b of acts.querySelectorAll('button')){const lab=b.textContent.trim();
     if(!lab&&!b.title)bad.push(li.dataset.pin+': icon button without a title');
     if(['resolve','notfixed','repin','reopen'].includes(b.dataset.act)&&!lab)bad.push(li.dataset.pin+': '+b.dataset.act+' lost its label');}
   if(/\b[0-9a-f]{12}\b/.test(li.innerText))bad.push(li.dataset.pin+': a build hash in the card text');
   const h=li.querySelector('.hist');if(h&&!/^(reopened: part changed again|marked not fixed|resolved) at (\w{3} \d+ )?\d\d:\d\d$/.test(h.textContent))bad.push('status line '+h.textContent);
  }
  // polish 3: every tab shows its whole label and badge, 4 px apart, inside the row (or the row scrolls with a fade)
  const tabs=document.getElementById('tabs'),tr=R(tabs),tbs=[...tabs.querySelectorAll('button')].filter(vis);
  for(const b of tbs){const r=R(b),bd=b.querySelector('.badge');
   if(b.scrollWidth>b.clientWidth+0.5)bad.push('tab content overflows: '+b.dataset.tab);
   if(bd&&vis(bd)&&R(bd).right>r.right-4)bad.push('tab badge at the edge: '+b.dataset.tab);
   if(tabs.dataset.fit!=='3'&&(r.right>tr.right+0.5||r.left<tr.left-0.5))bad.push('tab cut off: '+b.dataset.tab);}
  for(let i=1;i<tbs.length;i++){const g=R(tbs[i]).left-R(tbs[i-1]).right;if(g<3.5)bad.push('tabs touching: '+tbs[i-1].dataset.tab+' / '+tbs[i].dataset.tab+' gap '+g.toFixed(1));}
  if(tabs.dataset.fit==='3'&&!tabs.classList.contains('more-right')&&!tabs.classList.contains('more-left'))bad.push('scrolling tab row without a fade');
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
 // polish 3: the tab row degrades by steps (icons, then short labels, then scrolling) at every panel width
 const fits=[];
 for(const pw of [560,480,420,380,360,340,320,300]){
  await page.evaluate(w=>document.body.style.setProperty('--panel-w',w+'px'),pw);await page.waitForTimeout(150);
  assert.deepEqual(await layout(),[],`tabs and diff panel at a ${pw} px panel`);fits.push([pw,+(await page.evaluate(()=>document.getElementById('tabs').dataset.fit))]);
 }
 assert.equal(fits[0][1],0,'a wide panel shows icons and full labels');
 assert(fits.every((f,i)=>i===0||f[1]>=fits[i-1][1]),'narrower panels never step back up: '+JSON.stringify(fits));
 await page.evaluate(()=>document.body.style.removeProperty('--panel-w'));await page.setViewportSize({width:1600,height:1050});
 ok('layout at 1280 and 1600 px and a 300 px panel: no clipped, touching or overflowing controls; pin actions on one line or two whole groups; tab row fit levels by panel width '+JSON.stringify(fits)+(SHOTS?' ('+shots.length+' screenshots)':''));
 // ---- 6: weight estimate, Part info, entity Measure, deleting and clearing measurements (functions at the end) ----
 await checkWeight(page,ok);
 await checkMeasureEntities(page,ok);
 await checkMeasureClear(page,ok);
 await checkPolish(X);
 assert.deepEqual(errors,[],'no page errors');
 const srvLog=await page.evaluate(async()=>(await (await fetch(new URL('log.json',location.href))).json()).entries.filter(e=>e.level==='error').map(e=>e.msg));
 assert.deepEqual(srvLog.filter(m=>/ResizeObserver/.test(m)),[],'no ResizeObserver loop errors from the tab row');
 console.log(JSON.stringify({passed:true,url:URL0,baseline:bl,parts:[A.node,B.node],checks,packet:pk.packet,screenshot:pk.screenshot,pins:path.join(rd,'pins.json'),shots:SHOTS||null},null,1));
 await page.close();
 }finally{if(context)await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});

// ======== class groups, keep pins and repin ========
const GROUPS=['change_request','problem','note','other'];
const GROUP_LABELS=['Change request','Problem','Note to the agent','Other'];
const GROUP_CLASSES={change_request:['design_change','appearance','resize','move','add_feature','remove_feature','simplify','lighten','strengthen'],
  problem:['weird_geometry','incoherent_addition','collateral_damage','floating_unsupported','orientation_mirror','fit_clearance','printability',
    'holes_ports_blocked','fasteners_assembly','regression','belt_pulley','envelope_size','intent_misread'],note:['question','keep','reference'],other:['other']};
const REPIN_LINE='The user moved this pin after your last attempt: the earlier spot and note are in history. The previous change did not address what is wrong; read the new anchor and reason.';
const snapPins=page=>page.evaluate(()=>viewer.review.snapshot());
const lastPin=async page=>{const p=(await snapPins(page)).p;return p[p.length-1];};
// a screen point on a part (the page's own picker), near the middle of what is visible of it
async function pointOn(page,key){
  return page.evaluate(k=>{const r=document.querySelector('#c').getBoundingClientRect(),hits=[];
    for(let y=r.top+50;y<r.bottom-50;y+=9)for(let x=r.left+50;x<r.right-50;x+=9){const i=viewer.pickAt(x,y);if(i&&i.part.key===k)hits.push([x,y]);}
    if(!hits.length)return null;hits.sort((a,b)=>a[1]-b[1]||a[0]-b[0]);const m=hits[Math.floor(hits.length/2)];return {x:m[0],y:m[1]};},key);
}
async function pinAt(X,P,cls,note=''){
  const {page}=X;await page.locator('#modes [data-mode=pin]').click();await page.mouse.click(P.x,P.y);
  await page.locator('#pin-dialog').waitFor({state:'visible'});if(note)await page.locator('#pin-note').fill(note);
  await page.locator(`#pin-chips [data-class=${cls}]`).click();await page.waitForTimeout(400);
  assert.equal(await page.locator('#pin-dialog').isVisible(),false,`one click on ${cls} saves`);
  return lastPin(page);
}

// A1: the pin card shows its class chips in labelled groups (Change request, Problem, Note to the agent, Other); one click
// on a change-request chip saves a pin whose marker has its own group colour; Pins list badge; Issues by group then class
async function checkGroupedPinCard(X){
  const {page,A,B,st}=X;
  await page.locator('#tabs [data-tab=pins]').click();
  await page.locator('#modes [data-mode=pin]').click();await page.mouse.click(A.x,A.y);await page.locator('#pin-dialog').waitFor({state:'visible'});
  await page.waitForTimeout(300);
  const groups=await page.locator('#pin-chips .cgroup').evaluateAll(gs=>gs.map(g=>({id:g.dataset.group,label:g.querySelector('.cgl').textContent,
    chips:[...g.querySelectorAll('button')].map(b=>b.dataset.class)})));
  assert.deepEqual(groups.map(g=>g.id),GROUPS,'chip groups in order');assert.deepEqual(groups.map(g=>g.label),GROUP_LABELS,'group labels');
  for(const g of groups)assert.deepEqual(g.chips,GROUP_CLASSES[g.id],`chips of ${g.id}`);
  const titles=await page.locator('#pin-chips button').evaluateAll(bs=>bs.map(b=>b.title));
  assert(titles.every(t=>/^[A-Z].*\.$/.test(t)&&!t.includes('\u2014')),'every chip carries its one-sentence meaning');
  const ed=await page.evaluate(()=>viewer.review.state().editor);
  const clipped=await page.evaluate(()=>{const c=document.getElementById('pin-dialog').getBoundingClientRect();
    return [...document.querySelectorAll('#pin-dialog button,#pin-dialog .cgl')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&(r.right>c.right-1||r.left<c.left+1);}).length;});
  assert.equal(clipped,0,'nothing clipped in the pin card');
  if(X.shots){await page.locator('#pin-dialog').screenshot({path:path.join(X.shots,'pin-card-groups.png')});await page.screenshot({path:path.join(X.shots,'pin-card-groups-window.png')});}
  const hp=(await st()).hp,n=(await snapPins(page)).p.length;
  await page.locator('#pin-chips [data-class=appearance]').click();await page.waitForTimeout(400);       // one click saves
  assert.equal(await page.locator('#pin-dialog').isVisible(),false,'a change-request chip saves and closes the card');
  const cp=await lastPin(page);assert.equal((await snapPins(page)).p.length,n+1);assert.equal(cp.issue_class,'appearance');assert.equal((await st()).hp,hp+1,'one undo step');
  const mk=page.locator(`.pin-marker[data-pin=${cp.id}]`);assert.equal(await mk.evaluate(e=>e.classList.contains('g-change_request')),true,'marker has the change-request class');
  assert.equal(await mk.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(124, 58, 237)','change-request marker colour');
  assert.equal((await X.pinLi(cp.id).locator('.chip.grp').textContent()).trim(),'Change','the Pins list shows the group badge');
  X.change=cp;
  // a question pin (a note to the agent) at B, for the badge checks after the next build
  X.question=await pinAt(X,B,'question');
  assert.equal((await X.rstate()).pins.find(p=>p.id===X.question.id).group,'note');
  await page.locator('#modes [data-mode=select]').click();
  await page.locator('#tabs [data-tab=issues]').click();await page.waitForFunction(()=>document.querySelector('#issues-out [data-group=change_request] [data-class=appearance] .bn')?.textContent.startsWith('1'),null,{timeout:20000});
  const ig=await page.locator('#issues-out .igroup').evaluateAll(gs=>gs.map(g=>({id:g.dataset.group,head:g.querySelector('.igh').textContent,classes:[...g.querySelectorAll('[data-class]')].map(b=>b.dataset.class)})));
  assert.deepEqual(ig.map(g=>g.id),GROUPS,'Issues tab: groups in order');
  for(const g of ig)assert.deepEqual([...g.classes].sort(),[...GROUP_CLASSES[g.id]].sort(),`Issues tab: the classes of ${g.id} under it`);
  assert.match(ig[0].head,/^Change request\s*\d+/,'group header with its count');
  await page.locator('#tabs [data-tab=pins]').click();
  const rj=JSON.parse(review('--json'));assert.equal(rj.open_pins.find(p=>p.id===cp.id).group,'change_request','aad review --json carries group');
  assert.equal(rj.open_pins.find(p=>p.id===X.question.id).instruction,'answer only, change nothing');
  X.ok(`pin card: ${groups.length} labelled groups (${groups.map(g=>g.chips.length).join(', ')} chips), change-request pin ${cp.id} in one click, violet marker, badge, Issues by group`);
}

// A2: a keep pin is a local lock: after a packet, a build that changes geometry within 5 mm of it is flagged at the
// top of the Revisions tab like collateral and in aad review, even with its part inside the scope lock; no "Unchanged
// here since your packet" badge on keep or question pins
async function checkKeepPinIsALock(X){
  const {page,A}=X;
  X.keep=await pinAt(X,A,'keep');
  await page.locator('#modes [data-mode=select]').click();
  if(!MODEL){X.ok('keep pin saved (no --model: the rebuild check is skipped)');return;}
  const scope=(await X.rstate()).scope;
  assert(scope.includes(A.node),'the keep pin\'s part is inside the scope lock');
  await page.locator('#send').click();await page.waitForFunction(()=>viewer.review.state().lastPacket,null,{timeout:60000});
  const pk=(await X.rstate()).lastPacket,sent=JSON.parse(fs.readFileSync(pk.packet,'utf8'));
  await page.waitForFunction(p=>viewer.review.state().lastPacket?.packet===p,pk.packet);
  validate(pk.packet,'packet');assert(sent.pins.every(p=>p.group),'packet pins carry group');
  assert.equal(sent.pins.find(p=>p.id===X.keep.id).instruction,'locked by the user');
  // the next build adds a 2 mm nub to the part 1.5 mm off the keep pin's point (inside the scope lock: no collateral)
  const tmp=fs.mkdtempSync(path.join(path.dirname(MODEL),'.keep-'));const v3=path.join(tmp,'v3.glb');
  py('import numpy as np\nfrom aad.review.glb import read_parts, write_parts\nps=read_parts(sys.argv[2])\n'+
    'c=np.array(eval(sys.argv[4]));nrm=np.array(eval(sys.argv[5]));hit=0\n'+
    'cube=np.array([[x,y,z] for x in (-1,1) for y in (-1,1) for z in (-1,1)],float)\n'+
    'f=np.array([(0,2,3),(0,3,1),(4,5,7),(4,7,6),(0,1,5),(0,5,4),(2,6,7),(2,7,3),(0,4,6),(0,6,2),(1,3,7),(1,7,5)])\n'+
    'for p in ps:\n if p.name==sys.argv[6]:\n  n=len(p.vertices);p.vertices=np.vstack([p.vertices,c+1.5*nrm+cube]);p.triangles=np.vstack([p.triangles,f+n]);hit=1\n'+
    'assert hit\nwrite_parts(sys.argv[3],ps)',
    MODEL,v3,JSON.stringify(X.keep.anchor.local),JSON.stringify(X.keep.anchor.normal_local),X.keep.anchor.part.node);
  const B3=py('from aad.review.store import build_id\nprint(build_id([sys.argv[2]]))',v3);
  const t=MODEL+'.tmp';fs.copyFileSync(v3,t);fs.renameSync(t,MODEL);
  await page.waitForFunction(b=>{const r=viewer.review.state();return r.build===b&&r.diff&&r.diff.b===b;},B3,{timeout:120000});
  await page.waitForTimeout(800);
  const first=await page.locator('#diff-out > *').first();
  assert.equal(await first.getAttribute('id'),'keep-banner','the keep flag is the first thing in the Revisions tab');
  assert.match(await first.textContent(),new RegExp(`KEEP: 1 spot you locked changed.*#${X.keep.n} on ${A.node}: geometry within 5 mm changed`));
  assert.equal(await page.locator('#diff-count').evaluate(e=>e.classList.contains('bad')),true,'the Revisions tab count turns red');
  const dd=await page.evaluate(async()=>(await fetch(new URL('review/diff.json',location.href))).json());
  assert.deepEqual(dd.keep.map(k=>k.id),[X.keep.id],'the server diff lists the keep pin');assert.equal(dd.a.kind,'reviewed');
  const rj=JSON.parse(review('--json'));assert.deepEqual(rj.keep_changed.map(k=>k.id),[X.keep.id],'aad review --json keep_changed');
  const rt=review();assert(rt.includes(`KEEP PIN CHANGED keep pin #${X.keep.n} on ${A.node}: geometry within 5 mm of it changed`),'aad review text flags it');
  X.keepText=rt;
  // no "Unchanged here since your packet" on keep, question or reference pins; Repin on pins whose part changed
  await page.waitForFunction(()=>viewer.review.state().pinChanges,null,{timeout:60000});
  const pc=await page.evaluate(async()=>(await fetch(new URL('review/pin-changes.json',location.href))).json());
  await page.locator('#tabs [data-tab=pins]').click();await page.waitForTimeout(300);
  for(const p of [X.keep,X.question])assert.equal(await X.pinLi(p.id).locator('.chip.same').count(),0,`no Unchanged here badge on the ${p.issue_class} pin`);
  const qc=pc.pins[X.question.id];
  if(qc&&!qc.part_changed&&qc.near_changed===false)X.ok(`question pin ${X.question.id} unchanged on the server, badge still hidden`);
  const changedIds=Object.entries(pc.pins).filter(([,c])=>c.part_changed||c.near_changed===true).map(([id])=>id);
  assert(changedIds.length>=1,'some pin of the packet has its part changed');
  for(const id of changedIds)if(await X.pinLi(id).count())assert.equal(await X.pinLi(id).locator('[data-act=repin]').count(),1,`Repin on ${id}, whose part changed since the packet`);
  fs.rmSync(tmp,{recursive:true,force:true});
  X.ok(`keep pin ${X.keep.id}: build ${B3} changed geometry within 5 mm, flagged first in the Revisions tab and in aad review; Repin on ${changedIds.length} changed pin(s)`);
}

// marker colours: change request, problem and note pins each have their own colour, distinct from resolved green and
// not-fixed red, with white numbers, readable on the light, white, dark and black viewport presets
async function checkMarkerColours(X){
  const {page}=X;
  const r=await page.evaluate(()=>{
    const rgb=c=>{const m=c.match(/[\d.]+/g).map(Number);return m.slice(0,3);};
    const out={};for(const g of ['change_request','problem','note']){const e=document.querySelector(`.pin-marker.g-${g}:not(.orphan)`);
      if(e){const cs=getComputedStyle(e);out[g]={fill:rgb(cs.backgroundColor),text:rgb(cs.color),ring:rgb(cs.borderTopColor),ringW:parseFloat(cs.borderTopWidth)};}}
    out.bgs=[...document.querySelectorAll('#bg-presets [data-bg] .sw')].map(s=>({name:s.parentElement.dataset.bg,c:rgb(getComputedStyle(s).backgroundColor)}));
    return out;});
  const lum=c=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;};return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]);};
  const con=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);},dist=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
  for(const g of ['change_request','problem','note'])assert(r[g],`a ${g} marker is on the model`);
  const fills=['change_request','problem','note'].map(g=>r[g].fill);
  for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)assert(dist(fills[i],fills[j])>=60,`group colours distinct: ${fills[i]} vs ${fills[j]}`);
  for(const f of fills)for(const [n,c] of [['resolved green',[26,127,55]],['not-fixed red',[248,81,73]],['high red',[209,36,47]]])assert(dist(f,c)>=60,`${f} distinct from ${n}`);
  assert.deepEqual(r.bgs.map(b=>b.name),['light','white','dark','black']);
  for(const g of ['change_request','problem','note']){const m=r[g];
    assert(con(m.fill,m.text)>=4.5,`${g}: number readable on its fill (${con(m.fill,m.text).toFixed(2)})`);
    assert(m.ringW>=2,`${g}: ring`);
    for(const b of r.bgs)assert(Math.max(con(m.fill,b.c),con(m.ring,b.c))>=3,`${g} marker readable on the ${b.name} background`);}
  X.ok('marker colours: change '+fills[0]+', problem '+fills[1]+', note '+fills[2]+'; distinct from green and red, readable on light, white, dark and black');
}

// B: Repin, from a resolved pin, a not-fixed pin and tour stops: same pin id, new anchor, attempts + 1, history, top of
// the list with a red badge, old spot as a hollow marker with a line, one undo step restores it exactly
async function checkRepin(X){
  const {page,A,B,st}=X;
  await page.locator('#tabs [data-tab=pins]').click();await page.locator('#modes [data-mode=select]').click();
  const P1=(await snapPins(page)).p.find(p=>p.note==='Wall next to this hole looks too thin, keep the boss solid');
  assert(P1&&P1.status!=='resolved','the first pin is open');
  await X.pinLi(P1.id).locator('[data-act=resolve]').click();await page.waitForTimeout(300);
  if(!(await page.locator('#resolved-list').count()))await page.locator('#resolved-toggle').click();
  const rp=page.locator(`#resolved-list li[data-pin=${P1.id}] [data-act=repin]`);
  assert.equal(await rp.count(),1,'a resolved pin offers Repin');
  assert.equal(await rp.locator('.ic.i-map-pin-exclamation').count(),1,'with a Tabler icon');assert.match((await rp.textContent()).trim(),/^Repin$/,'and a label');
  const before=await snapPins(page),old=before.p.find(p=>p.id===P1.id),hp=(await st()).hp;
  await rp.click();await page.waitForTimeout(200);
  let rs=await X.rstate();assert.equal(rs.repin.picking,true,'Repin starts the pick state');assert.equal(rs.mode,'pin');
  assert.equal(await page.locator('#modehint').textContent(),'Click the spot that is wrong now (Esc keeps the old spot)');
  const PB=await pointOn(page,B.key)||B;await page.mouse.click(PB.x,PB.y);await page.locator('#pin-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#pin-dialog-h').textContent(),`Repin #${old.n}`);
  assert.equal(await page.locator('#pin-note').inputValue(),old.note,'the card is prefilled with the old note');
  assert.equal(await page.locator('#pin-chips button.on').getAttribute('data-class'),old.issue_class,'and the old class');
  assert.equal(await page.locator('#pin-was').textContent(),`was: Weird geometry, ${old.note}`);
  await page.locator('#pin-note').fill('The boss is fine; the wall next to the slot is what is too thin');
  await page.locator('#pin-chips [data-class=fit_clearance]').click();await page.waitForTimeout(500);   // one click saves
  assert.equal(await page.locator('#pin-dialog').isVisible(),false);
  const after=await snapPins(page),np=after.p.find(p=>p.id===P1.id);
  assert.equal(after.p.length,before.p.length,'no new pin: the same pin id');assert.equal(after.nx,before.nx,'no new number');
  assert.equal(np.anchor.part.key,B.key,'the anchor moved to the clicked part');assert.notDeepEqual(np.anchor.local,old.anchor.local);
  assert.equal(np.issue_class,'fit_clearance');assert.equal(np.status,'open');assert.equal(np.attempts,(old.attempts||0)+1,'attempts + 1');
  assert.equal(np.history.length,(old.history||[]).length+1);const h=np.history[np.history.length-1];
  assert.deepEqual(h.anchor,old.anchor,'history keeps the previous anchor');assert.equal(h.issue_class,old.issue_class);assert.equal(h.note,old.note);assert.equal(h.status,'resolved');assert(h.at&&'build' in h);
  assert.equal((await st()).hp,hp+1,'a repin is one undo step');
  assert.equal(await page.locator('#pin-list > li.item').first().getAttribute('data-pin'),P1.id,'the repinned pin moves to the top');
  const badge=X.pinLi(P1.id).locator('.chip.repinned');assert.equal((await badge.textContent()).trim(),`Repinned, attempt ${np.attempts}`);
  assert.equal(await badge.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(248, 81, 73)','the badge is red');
  assert.equal((await X.pinLi(P1.id).locator('.was').textContent()).trim(),`was: Weird geometry, ${old.note}`,'one was: line on the card');
  rs=await X.rstate();assert(rs.repin.trails.includes(P1.id),'the old spot stays as a hollow marker joined by a line');
  assert.equal(await page.locator(`.pin-old[data-pin=${P1.id}]`).isVisible(),true);
  if(X.shots){await page.screenshot({path:path.join(X.shots,'repinned-pin.png')});await page.locator('#panel').screenshot({path:path.join(X.shots,'repinned-panel.png')});}
  // one undo step restores the pin exactly (and its place), redo repins it again
  await page.keyboard.press('Control+z');await page.waitForTimeout(400);
  assert.deepEqual(await snapPins(page),before,'undo restores the pins exactly');
  assert.equal(await page.locator(`.pin-old[data-pin=${P1.id}]`).count(),0,'and the old-spot marker goes');
  await page.keyboard.press('Control+Shift+z');await page.waitForTimeout(400);
  assert.deepEqual((await snapPins(page)).p.find(p=>p.id===P1.id),np,'redo repins it again');
  await pause(700);validate(path.join(X.rd,'pins.json'),'pins');
  const pf=JSON.parse(fs.readFileSync(path.join(X.rd,'pins.json'),'utf8')).pins.find(p=>p.id===P1.id);
  assert.equal(pf.history.length,np.history.length,'pins.json keeps the history');assert(pf.repinned_at);
  const rj=JSON.parse(review('--json')),rp1=rj.open_pins.find(p=>p.id===P1.id);
  assert.equal(rp1.escalation,REPIN_LINE);assert.equal(rp1.history.length,np.history.length,'aad review --json carries the history');assert.equal(rp1.group,'problem');
  const firstNonTop=rj.open_pins.findIndex(p=>p.status!=='not_fixed'&&!p.repinned_at);
  assert(rj.open_pins.indexOf(rj.open_pins.find(p=>p.id===P1.id))<firstNonTop,'aad review lists the repinned pin with the not-fixed ones');
  const rt=review();assert(rt.includes(`#${np.n} (${P1.id}) [REPINNED, attempt ${np.attempts}]`)&&rt.includes(REPIN_LINE)&&rt.includes(`weird_geometry: ${old.note}`),'aad review text: badge, line, history');
  X.ok(`Repin from Resolved: ${P1.id} moved from ${old.anchor.part.node} to ${np.anchor.part.node}, attempt ${np.attempts}, history ${np.history.length}, top, one undo step`);
  // Enter keeps the anchor (a not-fixed pin)
  const NF=(await snapPins(page)).p.find(p=>p.status==='not_fixed');
  if(NF){
    const hp2=(await st()).hp;await X.pinLi(NF.id).locator('[data-act=repin]').click();await page.waitForTimeout(150);
    await page.keyboard.press('Enter');await page.locator('#pin-dialog').waitFor({state:'visible'});
    await page.locator('#pin-chips [data-class=regression]').click();await page.waitForTimeout(400);
    const nf2=(await snapPins(page)).p.find(p=>p.id===NF.id);
    assert.deepEqual(nf2.anchor,NF.anchor,'Enter keeps the old anchor');assert.equal(nf2.attempts,NF.attempts+1);assert.equal(nf2.status,'open');
    assert.equal(nf2.issue_class,'regression');assert.equal((await st()).hp,hp2+1);
    assert.equal(await page.locator(`.pin-old[data-pin=${NF.id}]`).count()?await page.locator(`.pin-old[data-pin=${NF.id}]`).isVisible():false,false,'no old-spot marker when the spot is kept');
    X.ok(`Repin of not-fixed ${NF.id} with Enter keeps its anchor, attempt ${nf2.attempts}`);
  }
  // tour stops: Repin beside Accept and Reject; a stop's pin moves on its own id, a stop without a pin gets one
  const build=(await X.rstate()).build;
  fs.writeFileSync(path.join(X.rd,'tour.json'),JSON.stringify({schema:'cadreview/1',build,title:'Repin check',author:'test',
    stops:[{id:'s1',parts:[A.node],note:'Moved the hole',kind:'changed',ghost:false},{id:'s2',parts:[B.node],note:'Thickened the plate',kind:'changed',ghost:false}]}));
  await page.reload();await page.waitForFunction(()=>window.viewer?.state().ready&&window.viewer.review,null,{timeout:120000});await page.waitForTimeout(800);
  await page.locator('#tabs [data-tab=tour]').click();await page.locator('#tour-start').click();await page.waitForTimeout(600);
  const tb=await page.locator('#tour-out .row2').first().evaluate(r=>[...r.querySelectorAll('button')].map(b=>b.id));
  assert.deepEqual(tb.slice(-3),['tour-accept','tour-reject','tour-repin'],'Repin sits beside Accept and Reject');
  await page.locator('#tour-reject').click();await page.locator('#pin-dialog').waitFor({state:'visible'});
  await page.locator('#pin-chips [data-class=intent_misread]').click();await page.waitForTimeout(400);
  const T1=await lastPin(page);assert.equal(T1.tour_stop,'s1');assert.equal(T1.kind,'region');
  const tBefore=await snapPins(page),hp3=(await st()).hp;
  await page.locator('#tour-repin').click();await page.waitForTimeout(200);assert.equal((await X.rstate()).repin.picking,true);
  const PA=await pointOn(page,A.key);assert(PA,'part A on screen at the tour stop');
  await page.mouse.click(PA.x,PA.y);await page.locator('#pin-dialog').waitFor({state:'visible'});
  await page.locator('#pin-chips [data-class=move]').click();await page.waitForTimeout(400);
  const tAfter=await snapPins(page),T1b=tAfter.p.find(p=>p.id===T1.id);
  assert.equal(tAfter.p.length,tBefore.p.length,'the stop\'s pin keeps its id');assert.equal(T1b.kind,'point');assert.equal(T1b.anchor.part.key,A.key);
  assert.equal(T1b.attempts,1);assert.equal(T1b.history.length,1);assert.equal(T1b.history[0].kind,'region');assert.equal(T1b.issue_class,'move');
  assert.equal(tAfter.td.s1.pin,T1.id);assert.equal((await st()).hp,hp3+1,'one undo step');
  await page.keyboard.press('Control+z');await page.waitForTimeout(400);assert.deepEqual(await snapPins(page),tBefore,'undo restores the stop\'s pin exactly');
  await page.keyboard.press('Control+Shift+z');await page.waitForTimeout(400);
  await page.locator('#tour-next').click();await page.waitForTimeout(600);
  const n0=tAfter.p.length;await page.locator('#tour-repin').click();await page.waitForTimeout(150);
  await page.keyboard.press('Escape');await page.locator('#pin-dialog').waitFor({state:'visible'});     // Esc keeps the stop's parts
  assert.equal(await page.locator('#pin-dialog-h').textContent(),'Repin tour stop');
  await page.locator('#pin-chips [data-class=regression]').click();await page.waitForTimeout(400);
  const s2=await snapPins(page),T2=s2.p[s2.p.length-1];
  assert.equal(s2.p.length,n0+1,'a stop without a pin gets a new one');assert.equal(T2.tour_stop,'s2');assert.equal(s2.td.s2.pin,T2.id);assert.equal(s2.td.s2.decision,'reject');
  await pause(700);validate(path.join(X.rd,'pins.json'),'pins');validate(path.join(X.rd,'tour.json'),'tour');
  // a packet lists the repinned pins first with the line and the history
  await page.locator('#tabs [data-tab=pins]').click();
  const prev=(await X.rstate()).lastPacket?.packet;await page.locator('#send').click();
  await page.waitForFunction(p=>viewer.review.state().lastPacket&&viewer.review.state().lastPacket.packet!==p,prev||null,{timeout:60000});
  const pk=(await X.rstate()).lastPacket,pd=JSON.parse(fs.readFileSync(pk.packet,'utf8'));validate(pk.packet,'packet');
  const top=pd.pins.findIndex(p=>p.status!=='not_fixed'&&!p.repinned_at);
  assert(pd.pins.slice(0,top).some(p=>p.id===P1.id)&&pd.pins.slice(0,top).some(p=>p.id===T1.id),'the packet lists repinned pins first');
  const pp=pd.pins.find(p=>p.id===P1.id);assert.equal(pp.escalation,REPIN_LINE);assert(pp.history.length>=1);assert.match(pd.prompt,/REPINNED/);
  X.ok(`Repin from tour stops: ${T1.id} moved on its own id (stop s1), ${T2.id} created for stop s2; packet ${pd.id} lists repinned pins first`);
}

// ===== weight estimate, Part info and entity-based Measure =====
// page helpers: a part's tree key by node name, world -> client pixels, a camera looking straight down at a point
const keyOfNode=(page,node)=>page.evaluate(n=>{for(const [k,r] of viewer.nodes)if(r.leaf&&r.leaf.node===n)return k;return null;},node);
const toClient=(page,pts)=>page.evaluate(pts=>{const c=viewer.camera;c.updateMatrixWorld();const r=document.querySelector('#c').getBoundingClientRect();
  const mul=(m,v)=>{const e=m.elements;return [0,1,2,3].map(i=>e[i]*v[0]+e[4+i]*v[1]+e[8+i]*v[2]+e[12+i]*v[3]);};
  return pts.map(p=>{const q=mul(c.projectionMatrix,mul(c.matrixWorldInverse,[...p,1]));return {x:r.left+(q[0]/q[3]*0.5+0.5)*r.width,y:r.top+(0.5-q[1]/q[3]*0.5)*r.height};});},pts);
const lookDown=(page,t,pxPerMm)=>page.evaluate(([t,ppm])=>{const k=viewer.controls;k.enableDamping=false;k.setFocalOffset(0,0,0,false);
  k.setLookAt(t[0],t[1]-0.05,t[2]+800,t[0],t[1],t[2],false);if(viewer.camera.isOrthographicCamera){const H=document.querySelector('#c').clientHeight;k.zoomTo(ppm*400/H,false);}k.update(0);},[t,pxPerMm]);
// the measurement graphics in the DOM: shown labels and dots (CSS2DRenderer hides with display none)
const measDom=page=>page.evaluate(()=>{const shown=e=>e.isConnected&&getComputedStyle(e.closest('.measure-anchor')||e).display!=='none'&&e.getBoundingClientRect().width>0;
  const R=e=>{const r=e.getBoundingClientRect();return {id:e.dataset.measure,l:r.left,t:r.top,r:r.right,b:r.bottom};};
  return {labels:[...document.querySelectorAll('#labels .measure-label')].filter(shown).map(e=>({...R(e),text:e.textContent})),
    dots:[...document.querySelectorAll('#labels .measure-dot[data-measure]')].filter(shown).map(R),
    all:document.querySelectorAll('#labels .measure-label').length};});
const snapMeas=page=>page.evaluate(()=>viewer.review.snapshot().ms);

async function checkWeight(page,ok){
 // (1) the Weight block sits under Section and Explode and fits a 1280 x 800 window; the tree gives way first
 await page.setViewportSize({width:1280,height:800});await page.waitForTimeout(500);
 const fit=await page.evaluate(()=>{const R=id=>document.getElementById(id).getBoundingClientRect(),w=R('weightbox'),s=R('side'),t=R('tree');
   const sec=[...document.querySelectorAll('#side .ctl')].find(e=>/Explode/.test(e.textContent)).getBoundingClientRect();
   return {inside:w.top>=s.top&&w.bottom<=s.bottom+0.5&&w.bottom<=innerHeight,below:w.top>=sec.bottom-0.5,tree:t.height};});
 assert(fit.inside&&fit.below,`Weight block fully visible under Section and Explode at 1280 x 800 (${JSON.stringify(fit)})`);
 assert(fit.tree>=40,'the tree keeps some height');
 const W=k=>page.evaluate(()=>({...document.getElementById('weight-out').dataset,text:document.getElementById('weight-out').innerText}));
 const bk=await keyOfNode(page,'bracket');assert(bk,'bracket in the tree');
 // independent mesh numbers from the page's own geometry: signed tetrahedron sum and triangle area sum (mm)
 const geo=await page.evaluate(k=>{let m=null;viewer.nodes.get(k).obj.traverse(o=>{if(!m&&o.isMesh)m=o;});m.updateMatrixWorld();
   const g=m.geometry,pos=g.attributes.position,idx=g.index,n=idx?idx.count/3:pos.count/3,e=m.matrixWorld.elements;
   const P=i=>{const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);return [e[0]*x+e[4]*y+e[8]*z+e[12],e[1]*x+e[5]*y+e[9]*z+e[13],e[2]*x+e[6]*y+e[10]*z+e[14]];};
   let v=0,a=0;for(let t=0;t<n;t++){const [A,B,C]=[0,1,2].map(j=>P(idx?idx.getX(3*t+j):3*t+j));
     const u=[B[0]-A[0],B[1]-A[1],B[2]-A[2]],w=[C[0]-A[0],C[1]-A[1],C[2]-A[2]],cr=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];
     a+=0.5*Math.hypot(...cr);v+=(A[0]*(B[1]*C[2]-B[2]*C[1])-A[1]*(B[0]*C[2]-B[2]*C[0])+A[2]*(B[0]*C[1]-B[1]*C[0]))/6;}
   return {vol:Math.abs(v),area:a,tris:n};},bk);
 await page.evaluate(k=>{viewer.select(k);viewer.commit();},bk);
 await page.locator('#weight-material').selectOption('pla');
 if(!(await page.locator('#weight-printed').isChecked()))await page.locator('#weight-printed').check();
 // polish 1: "12.5" mm walls and "100" % infill show whole in their boxes at 1280 and 1600 px; each group stays on one line
 for(const VW of [1600,1280]){
  await page.setViewportSize({width:VW,height:800});await page.waitForTimeout(300);
  await page.locator('#weight-walls').fill('12.5');await page.locator('#weight-infill').fill('100');await page.waitForTimeout(200);
  const nb=await page.evaluate(()=>{const out=[],cv=document.createElement('canvas').getContext('2d');
    for(const id of ['weight-walls','weight-infill']){const e=document.getElementById(id),cs=getComputedStyle(e);cv.font=`${cs.fontSize} ${cs.fontFamily}`;
      const room=e.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight),need=cv.measureText(e.value).width;
      if(need>room+0.5||e.scrollWidth>e.clientWidth)out.push(`${id} "${e.value}" needs ${need.toFixed(1)} px, has ${room.toFixed(1)}`);}
    for(const g of document.querySelectorAll('#weight-print-row .wg')){const r=g.getBoundingClientRect();if(r.height>28)out.push('group wraps: '+g.textContent.trim());
      const s=document.getElementById('side').getBoundingClientRect();if(r.right>s.right+0.5)out.push('outside the side panel: '+g.textContent.trim());}
    return out;});
  assert.deepEqual(nb,[],`weight inputs show 12.5 and 100 whole at ${VW} px`);
 }
 await page.locator('#weight-infill').fill('20');await page.locator('#weight-walls').fill('1.2');await page.waitForTimeout(600);
 let w=await W();
 const rel=(x,y)=>Math.abs(x-y)/Math.max(1e-9,Math.abs(y));
 assert.equal(w.parts,'1');assert.equal(w.total,'0');assert.match(w.text,/bracket/,'the readout names the part');
 assert(rel(+w.volume,geo.vol)<0.01,`volume ${w.volume} = mesh volume ${geo.vol} within 1 %`);
 assert(rel(+w.solid,1.24*geo.vol/1000)<0.01,`PLA mass ${w.solid} g = volume x 1.24 within 1 %`);
 const shell=Math.min(geo.area*1.2,geo.vol),printed=1.24*(shell+0.2*(geo.vol-shell))/1000;
 assert(rel(+w.printed,printed)<0.01,`printed estimate ${w.printed} g = density x (shell + 20 % of the interior) within 1 % (${printed.toFixed(2)})`);
 assert.match(w.text,/solid [\d.]+ g, printed about [\d.]+ g/);assert.match(w.text,/estimate/);assert.match(w.text,/[\d.]+ cm3/);
 if(SHOTS){await page.locator('#weightbox').screenshot({path:path.join(SHOTS,'weight-block-1280x800.png')});await page.screenshot({path:path.join(SHOTS,'weight-window-1280x800.png')});}
 // steel: no printed mode, solid only
 await page.locator('#weight-material').selectOption('steel');await page.waitForTimeout(500);w=await W();
 assert(rel(+w.solid,7.85*geo.vol/1000)<0.01,'steel mass = volume x 7.85');assert.equal(w.printed,'');
 assert.equal(await page.locator('#weight-printed').isDisabled(),true,'printed mode is for PLA and PETG only');
 assert.doesNotMatch(w.text,/printed/);
 // nothing selected: the total of every visible part, labelled as a total
 await page.evaluate(()=>{viewer.clearSel();viewer.commit();});await page.waitForTimeout(500);w=await W();
 assert.equal(w.total,'1');assert.match(w.text,/^Total of \d+ visible parts/);
 const tot=await page.evaluate(async()=>{const j=await (await fetch(new URL('part-stats.json',location.href))).json();return j.parts.reduce((s,p)=>s+p.volume,0);});
 assert(rel(+w.volume,tot)<1e-6,'the total sums every visible part');
 // (2) right-click > Part info: code name, tree path, box, volume, area, triangles, weight for the current material
 await page.locator('#weight-material').selectOption('petg');await page.waitForTimeout(300);
 await lookDown(page,[0,0,0],4);await page.waitForTimeout(300);
 const [pt]=await toClient(page,[[-20,-12,5]]);
 const hitKey=await page.evaluate(([x,y])=>viewer.pickAt(x,y)?.part?.key,[pt.x,pt.y]);assert.equal(hitKey,bk,'the bracket plate is under the probe point');
 await page.mouse.click(pt.x,pt.y,{button:'right'});await page.waitForTimeout(250);
 assert(await page.locator('#info-component').isVisible(),'Part info in the part menu');
 assert.equal(await page.locator('#info-component .ic.i-info-circle').count(),1,'with its Tabler icon');
 await page.locator('#info-component').click();await page.waitForTimeout(400);
 assert(await page.locator('#part-info').isVisible(),'the Part info card opens');
 const card=await page.evaluate(()=>{const o={};for(const dd of document.querySelectorAll('#part-info-body dd'))o[dd.dataset.k]=dd.textContent;
   const r=document.getElementById('part-info').getBoundingClientRect();return {o,box:{l:r.left,t:r.top,r:r.right,b:r.bottom}};});
 const c=card.o;
 assert.equal(c['Code name'],'bracket');assert.match(c['Tree path'],/bracket$/);
 assert.equal(c['Bounding box'],'60.00 x 40.00 x 35.00 mm');assert.equal(c['Triangles'],String(geo.tris));
 assert(rel(parseFloat(c['Volume']),geo.vol/1000)<0.01,'card volume');assert(rel(parseFloat(c['Surface area']),geo.area/100)<0.01,'card area');
 const pm=c['Weight'].match(/solid ([\d.]+) g, printed about ([\d.]+) g \(PETG 1\.27 g\/cm3, infill 20 %, walls 1\.2 mm, estimate\)/);
 assert(pm,`card weight line: ${c['Weight']}`);assert(rel(+pm[1],1.27*geo.vol/1000)<0.01,'card PETG mass');
 assert(card.box.l>=0&&card.box.r<=1280&&card.box.b<=800,'the card is inside the window');
 assert.equal(await page.evaluate(()=>document.getElementById('component-menu').hidden),true,'the menu closed');
 await page.locator('#part-info-copy').click();await page.waitForTimeout(200);
 assert.match(await page.evaluate(()=>viewer.weight.state().copied||''),/^Code name: bracket\nTree path: .*\nBounding box: 60\.00 x 40\.00 x 35\.00 mm\nVolume: /,'Copy puts the lines on the clipboard');
 // non-modal: the view still takes a wheel zoom with the card open; Esc closes it
 const camS=()=>page.evaluate(()=>{const s=viewer.state();return JSON.stringify([s.cam,s.target,s.zoom]);});
 const z0=await camS();await page.mouse.move(pt.x-150,pt.y);await page.mouse.wheel(0,-200);await page.waitForTimeout(700);
 assert.notEqual(await camS(),z0,'the view still navigates (wheel) with the card open');
 await page.keyboard.press('Escape');await page.waitForTimeout(150);assert.equal(await page.locator('#part-info').isVisible(),false,'Esc closes the card');
 assert.equal(await page.evaluate(()=>{try{return JSON.parse(localStorage.getItem('aad-viewer-weight')).mat;}catch(e){return null;}}),'petg','the last material is remembered');
 await page.locator('#weight-material').selectOption('pla');
 await page.setViewportSize({width:1600,height:1050});await page.waitForTimeout(400);
 ok(`weight: bracket ${(geo.vol/1000).toFixed(2)} cm3, all visible parts ${(+w.volume/1000).toFixed(2)} cm3; PLA solid and printed, steel and the total match the mesh within 1 %; Part info card with Copy; Weight block visible at 1280 x 800; walls 12.5 and infill 100 show whole at 1280 and 1600 px`);
}

async function checkMeasureEntities(page,ok){
 // (3) the 5 mm wall of bracket (y 15..20, top at z 35), seen from above: its two long top edges, clicked at
 // different places along them, read the wall thickness, not the distance between the clicks
 await page.evaluate(()=>{viewer.clearSel();viewer.commit();});await page.locator('#tabs [data-tab=pins]').click();
 await page.locator('#modes [data-mode=measure]').click();await page.waitForTimeout(150);
 assert.equal(await page.locator('#meas-keep').isChecked(),true,'Keep visible is on in Measure mode');
 await lookDown(page,[0,17.5,35],14);await page.waitForTimeout(400);
 const n0=(await snapMeas(page)).length;
 const [a,b]=await toClient(page,[[-12,15,35],[16,20,35]]);
 await page.mouse.move(a.x,a.y,{steps:4});await page.waitForTimeout(300);
 const he=await page.evaluate(()=>viewer.hoverEdge);assert(he&&Math.abs(he.length-60)<0.01,`hover previews the 60 mm top edge (${JSON.stringify(he)})`);
 await page.mouse.click(a.x,a.y);await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>viewer.review.state().measPending),'edge','the first click took the edge');
 await page.mouse.move(b.x,b.y,{steps:4});await page.waitForTimeout(200);await page.mouse.click(b.x,b.y);await page.waitForTimeout(500);
 let ms=await snapMeas(page),m=ms[ms.length-1];
 assert.equal(ms.length,n0+1);assert.equal(m.kind,'edge_edge',`edge to edge (${m.kind})`);
 assert(Math.abs(m.distance-5)<0.01,`the wall reads its true thickness 5.00 mm, got ${m.distance}`);
 assert(Math.abs(m.point_distance-Math.hypot(28,5))<0.05,`the clicks themselves are ${m.point_distance} mm apart`);
 assert.equal(m.angle_deg,0);assert.deepEqual(m.entities,['edge','edge']);
 assert(Math.abs(Math.hypot(...m.delta)-m.distance)<1e-3,'the dimension line is the shortest span');
 assert(Math.abs(Math.abs(m.delta[1])-5)<0.01&&Math.abs(m.delta[0])<0.01&&Math.abs(m.delta[2])<0.01,'square to both edges');
 const row=page.locator(`#measure-list li[data-measure=${m.id}]`);
 assert.equal((await row.locator('.mval').textContent()).trim(),'5.00 mm','two decimals in the list');
 assert.match(await row.locator('.msec').textContent(),/point to point 28\.4\d mm, dX [-\d.]+, dY [-\d.]+, dZ [-\d.]+/);
 const lab=(await measDom(page)).labels.find(l=>l.id===m.id);assert(lab&&lab.text==='5.00 mm','the label on the model reads 5.00 mm');
 if(SHOTS){await page.locator('#view').screenshot({path:path.join(SHOTS,'measure-wall-5mm.png')});}
 const wallId=m.id;
 // two points on parallel planar faces (bracket plate top z 5, base plate top z 0), far apart: the plane distance
 await lookDown(page,[0,-10,5],3);await page.waitForTimeout(400);
 const [c,d]=await toClient(page,[[-22,-15,5],[40,-34,0]]);
 await page.mouse.click(c.x,c.y);await page.waitForTimeout(200);await page.mouse.click(d.x,d.y);await page.waitForTimeout(400);
 ms=await snapMeas(page);m=ms[ms.length-1];
 assert.equal(m.kind,'plane_plane');assert(Math.abs(m.distance-5)<0.01,`plane to plane 5.00, got ${m.distance}`);
 // vertex to vertex: the two top corners of the wall's front edge; the same edge twice: its length
 await lookDown(page,[0,17.5,35],6);await page.waitForTimeout(400);
 const [v1,v2,e1,e2]=await toClient(page,[[-30,15,35],[30,15,35],[-5,15,35],[8,15,35]]);
 await page.mouse.click(v1.x,v1.y);await page.waitForTimeout(200);await page.mouse.click(v2.x,v2.y);await page.waitForTimeout(400);
 ms=await snapMeas(page);m=ms[ms.length-1];assert.equal(m.kind,'vertex_vertex');assert(Math.abs(m.distance-60)<0.01,`corner to corner 60.00, got ${m.distance}`);
 await page.mouse.click(e1.x,e1.y);await page.waitForTimeout(200);await page.mouse.click(e2.x,e2.y);await page.waitForTimeout(400);
 ms=await snapMeas(page);m=ms[ms.length-1];assert.equal(m.kind,'edge_length');assert(Math.abs(m.distance-60)<0.01,`one edge twice: its length, got ${m.distance}`);
 // vertex to edge: a corner of the front edge to the back edge, perpendicular
 const [v3,e3]=await toClient(page,[[-30,15,35],[10,20,35]]);
 await page.mouse.click(v3.x,v3.y);await page.waitForTimeout(200);await page.mouse.click(e3.x,e3.y);await page.waitForTimeout(400);
 ms=await snapMeas(page);m=ms[ms.length-1];assert.equal(m.kind,'vertex_edge');assert(Math.abs(m.distance-5)<0.01,`vertex to edge 5.00, got ${m.distance}`);
 // round trip: attach the wall measurement to an open pin; pins.json validates and aad review --json carries it
 const pin=await page.evaluate(()=>viewer.review.state().pins.find(p=>p.status!=='resolved'));assert(pin,'an open pin to attach to');
 await page.locator(`#measure-list li[data-measure=${wallId}] select`).selectOption(pin.id);await page.waitForTimeout(1200);
 const pins=JSON.parse(fs.readFileSync(path.join(PROJECT,'.cadreview','pins.json'),'utf8'));
 const pm=pins.pins.find(p=>p.id===pin.id).measure;assert(pm&&pm.kind==='edge_edge'&&Math.abs(pm.distance-5)<0.01,'pins.json holds the attached measurement');
 validate(path.join(PROJECT,'.cadreview','pins.json'),'pins');
 const rj=JSON.parse(review('--json'));const rp=rj.open_pins.find(p=>p.id===pin.id);
 assert(rp&&rp.measure&&rp.measure.kind==='edge_edge'&&rp.measure.point_distance>5,'aad review --json round-trips the measurement');
 assert.match(review(),new RegExp(`measured 5\\.00 mm`),'and the text status prints it');
 ok(`measure: wall top edges 5.00 mm (clicks ${Math.hypot(28,5).toFixed(2)} mm apart), plane to plane 5.00, vertex to vertex 60.00, edge length 60.00, vertex to edge 5.00; attached, pins.json valid, aad review --json round trip`);
}

async function checkMeasureClear(page,ok){
 // labels: none on top of another label or on any end dot shown
 const overlap=(p,q)=>!(p.l>=q.r||p.r<=q.l||p.t>=q.b||p.b<=q.t);
 let dom=await measDom(page);
 assert(dom.labels.length>=4,`measurements shown in Measure mode (${dom.labels.length})`);
 for(let i=0;i<dom.labels.length;i++){for(let j=i+1;j<dom.labels.length;j++)assert(!overlap(dom.labels[i],dom.labels[j]),`labels ${dom.labels[i].text} and ${dom.labels[j].text} overlap`);
   for(const d of dom.dots)assert(!overlap(dom.labels[i],{l:d.l+1,t:d.t+1,r:d.r-1,b:d.b-1}),`label ${dom.labels[i].text} sits on an end dot`);}
 if(SHOTS)await page.locator('#view').screenshot({path:path.join(SHOTS,'measure-labels.png')});
 // Esc: a half-made measurement first, then the mode
 const vv=await toClient(page,[[21,17.5,35]]);
 await page.mouse.click(vv[0].x,vv[0].y);await page.waitForTimeout(200);
 assert(await page.evaluate(()=>viewer.review.state().measPending),'one point placed');
 await page.keyboard.press('Escape');await page.waitForTimeout(150);
 let rs=await page.evaluate(()=>viewer.review.state());assert.equal(rs.measPending,null,'Esc cancels the half-made measurement');assert.equal(rs.mode,'measure','and stays in Measure');
 // one delete from the row: the line, label and both dots leave the model at once; one undo brings it back
 let ms=await snapMeas(page);const un=ms.filter(m=>!m.pin);assert(un.length>=4);
 const victim=un[un.length-1].id,hp0=await page.evaluate(()=>viewer.state().hp);
 await page.locator(`#measure-list li[data-measure=${victim}] button[data-act=delete]`).click();await page.waitForTimeout(250);
 assert(!(await snapMeas(page)).some(m=>m.id===victim),'deleted from the list');
 dom=await measDom(page);assert(!dom.labels.some(l=>l.id===victim)&&!dom.dots.some(d=>d.id===victim),'its label and end dots are gone');
 assert.equal(await page.evaluate(id=>document.querySelectorAll(`#labels [data-measure="${id}"]`).length,victim),0,'nothing of it left in the label layer');
 assert.equal(await page.evaluate(()=>viewer.state().hp),hp0+1,'a delete is one undo step');
 await page.keyboard.press('Control+z');await page.waitForTimeout(250);assert((await snapMeas(page)).some(m=>m.id===victim),'undo brings it back');
 // Delete over a label removes that measurement
 dom=await measDom(page);const tl=dom.labels.find(l=>l.id===un[0].id);assert(tl,'target label shown');
 await page.mouse.move((tl.l+tl.r)/2,(tl.t+tl.b)/2,{steps:3});await page.waitForTimeout(150);await page.keyboard.press('Delete');await page.waitForTimeout(250);
 assert(!(await snapMeas(page)).some(m=>m.id===un[0].id),'Delete removes the measurement under the pointer');
 await page.keyboard.press('Control+z');await page.waitForTimeout(250);
 // leaving Measure mode hides unattached graphics unless Keep visible; attached ones show with their pin selected
 ms=await snapMeas(page);const att=ms.find(m=>m.pin);assert(att,'an attached measurement');
 await page.keyboard.press('Escape');await page.waitForTimeout(250);assert.equal((await page.evaluate(()=>viewer.review.state())).mode,'select','a second Esc leaves Measure');
 assert.equal(await page.locator('#meas-keep').isChecked(),false,'Keep visible is off outside Measure mode');
 await page.evaluate(()=>{const r=viewer.review;r.showTab('pins');});
 dom=await measDom(page);assert(!dom.labels.some(l=>ms.find(m=>m.id===l.id&&!m.pin)),'unattached measurements hidden outside Measure mode');
 await page.locator(`#pin-list li[data-pin=${att.pin}]`).click();await page.waitForTimeout(500);
 dom=await measDom(page);assert(dom.labels.some(l=>l.id===att.id),'the attached measurement shows while its pin is selected');
 await page.locator('#meas-keep').check();await page.waitForTimeout(200);
 dom=await measDom(page);assert.equal(dom.labels.length,ms.length,'Keep visible shows them all');
 // Clear all: every unattached measurement in one undo step; attached ones stay with their pins
 const hp1=await page.evaluate(()=>viewer.state().hp),nAtt=ms.filter(m=>m.pin).length;
 await page.locator('#meas-clear').click();await page.waitForTimeout(300);
 let after=await snapMeas(page);assert.equal(after.length,nAtt,'Clear all removes every unattached measurement');assert(after.every(m=>m.pin),'attached ones stay');
 dom=await measDom(page);assert(dom.labels.every(l=>after.some(m=>m.id===l.id)),'no label of a cleared measurement left');
 assert(dom.dots.every(d=>after.some(m=>m.id===d.id)),'no end dot of a cleared measurement left');
 assert.equal(await page.evaluate(()=>document.querySelectorAll('#labels .measure-label').length),nAtt,'the label layer holds only the attached ones');
 assert.match(await page.locator(`#measure-list li[data-measure=${att.id}] .where`).last().textContent(),/attached to pin #\d+, stays with its pin/);
 assert.equal(await page.evaluate(()=>viewer.state().hp),hp1+1,'Clear all is one undo step');
 await page.keyboard.press('Control+z');await page.waitForTimeout(300);assert.equal((await snapMeas(page)).length,ms.length,'one undo brings them all back');
 await page.keyboard.press('Control+Shift+z');await page.waitForTimeout(300);assert.equal((await snapMeas(page)).length,nAtt,'redo clears again');
 await page.locator('#meas-keep').uncheck();
 // a reload: unattached measurements are page state only and do not come back; attached ones live in their pin
 await page.locator('#modes [data-mode=measure]').click();
 await lookDown(page,[0,17.5,35],14);await page.waitForTimeout(300);
 const [a,b]=await toClient(page,[[-12,15,35],[16,20,35]]);
 await page.mouse.click(a.x,a.y);await page.waitForTimeout(200);await page.mouse.click(b.x,b.y);await page.waitForTimeout(1200);
 assert.equal((await snapMeas(page)).filter(m=>!m.pin).length,1,'one new unattached measurement before the reload');
 await page.reload();await page.waitForFunction(()=>window.viewer?.state().ready&&window.viewer.review,null,{timeout:120000});await page.waitForTimeout(800);
 assert.equal((await snapMeas(page)).length,0,'after a reload no unattached measurement survives');
 assert(await page.evaluate(id=>viewer.review.snapshot().p.find(p=>p.id===id)?.measure?.kind==='edge_edge',att.pin),'the attached one is still in its pin');
 ok('measurements: Esc cancels then leaves, row delete and Delete key (one undo step each, graphics gone), hidden outside Measure unless kept, attached shows with its pin, Clear all in one undo step, labels never overlap, nothing unattached survives a reload');
}

// ======== polish round (r5): long headings, hologram edges, card vs view cube, stored builds to keep ========
async function checkPolish(X){
 const {page,ok}=X;
 // 4: a long tour title, long stop notes and long part names wrap inside the panel at the default and a 300 px panel
 const build=(await X.rstate()).build,LONG='R23:base_skeleton_restored_after_pin_6_with_the_LED_faceplate_and_camera_plate_as_one_rectangle_for_pins_3_and_7';
 fs.writeFileSync(path.join(X.rd,'tour.json'),JSON.stringify({schema:'cadreview/1',build,title:LONG+' and a few more ordinary words after it',author:'test',
   stops:[{id:'s1',parts:[X.A.node],note:'Pins 3 and 7: '+LONG+' with the same corners all round; screw positions unchanged.',kind:'changed',ghost:false},
     {id:'s2',parts:[X.B.node],note:'Thickened the plate',kind:'changed',ghost:false}]}));
 await page.reload();await page.waitForFunction(()=>window.viewer?.state().ready&&window.viewer.review,null,{timeout:120000});await page.waitForTimeout(800);
 await page.locator('#tabs [data-tab=tour]').click();await page.locator('#tour-start').click();await page.waitForTimeout(600);
 const tourFit=()=>page.evaluate(()=>{const bad=[],pr=document.getElementById('panel').getBoundingClientRect(),pane=document.getElementById('tab-tour');
   for(const e of pane.querySelectorAll('*')){const r=e.getBoundingClientRect();if(r.width&&r.height&&(r.right>pr.right+0.5||r.left<pr.left-0.5))bad.push((e.id||e.className||e.tagName)+': '+e.textContent.slice(0,30));}
   if(pane.scrollWidth>pane.clientWidth+1)bad.push('horizontal overflow in the Tour tab');
   const h=pane.querySelector('.paneh');if(h.getBoundingClientRect().height<40)bad.push('the long title did not wrap');return bad;});
 assert.deepEqual(await tourFit(),[],'long tour title and stop text wrap at the default panel width');
 await page.evaluate(()=>document.body.style.setProperty('--panel-w','300px'));await page.waitForTimeout(300);
 assert.deepEqual(await tourFit(),[],'long tour title and stop text wrap at a 300 px panel');
 if(X.shots)await page.locator('#panel').screenshot({path:path.join(X.shots,'tour-long-title-300px.png')});
 await page.evaluate(()=>document.body.style.removeProperty('--panel-w'));await page.waitForTimeout(200);
 ok('long tour title and stop notes wrap inside the panel at the default width and at 300 px');
 // 6: "Diff tab" is gone from the page; a pin dropped just left of and below the view cube opens its card clear of the cube
 assert.equal(await page.evaluate(()=>/Diff tab/i.test(document.body.innerText+document.documentElement.innerHTML)),false,'no "Diff tab" left in the page');
 await page.locator('#tabs [data-tab=pins]').click();
 const p0=await pointOn(page,X.A.key);assert(p0,'part A on screen');
 const cv=await page.locator('#c').boundingBox(),cube0=await page.evaluate(()=>{const r=document.getElementById('viewcube').getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom};});
 const tgt={x:cube0.l-40,y:cube0.b+30};
 await page.mouse.move(p0.x,p0.y);await page.mouse.down({button:'middle'});await page.mouse.move(tgt.x,tgt.y,{steps:12});await page.mouse.up({button:'middle'});await page.waitForTimeout(500);
 const near=await page.evaluate(([k,t])=>{let best=null;for(let y=t.y-60;y<t.y+60;y+=4)for(let x=t.x-60;x<t.x+60;x+=4){const i=viewer.pickAt(x,y);
   if(i&&i.part.key===k&&!viewer.edgeAt(x,y)){const d=Math.hypot(x-t.x,y-t.y);if(!best||d<best.d)best={x,y,d};}}return best;},[X.A.key,tgt]);
 assert(near,'part A under the pointer beside the view cube after the pan');
 await page.locator('#modes [data-mode=pin]').click();await page.mouse.click(near.x,near.y);await page.locator('#pin-dialog').waitFor({state:'visible'});await page.waitForTimeout(300);
 const cardBox=await page.evaluate(()=>{const r=document.getElementById('pin-dialog').getBoundingClientRect(),v=document.getElementById('view').getBoundingClientRect();
   return {l:r.left,t:r.top,r:r.right,b:r.bottom,inside:r.left>=v.left&&r.right<=v.right&&r.top>=v.top&&r.bottom<=v.bottom};});
 const cubeHit=!(cardBox.l>cube0.r||cardBox.r<cube0.l||cardBox.t>cube0.b||cardBox.b<cube0.t);
 if(X.shots)await page.screenshot({path:path.join(X.shots,'pin-card-near-cube.png')});
 assert(!cubeHit&&cardBox.inside,`the pin card (${JSON.stringify(cardBox)}) stays off the view cube (${JSON.stringify(cube0)}) and inside the view`);
 await page.keyboard.press('Escape');await page.waitForTimeout(200);
 if(await page.locator('#pin-dialog').isVisible())await page.locator('#pin-close').click();
 await page.locator('#modes [data-mode=select]').click();
 ok(`no "Diff tab" text; the pin card near the top-right flips clear of the view cube (pin at ${Math.round(near.x)},${Math.round(near.y)})`);
 // Stored builds to keep: set in the Revisions tab's More row, applied on the server, remembered in this browser and
 // sent again after the server forgets it (a restart)
 const revs=()=>page.evaluate(async()=>(await fetch(new URL('review/revisions.json',location.href))).json());
 await page.locator('#tabs [data-tab=diff]').click();await page.waitForTimeout(300);
 if(!(await page.locator('#rev-keep').isVisible()))await page.locator('#rev-more-btn').click();
 const rows0=(await revs()).rows.filter(r=>r.kind!=='version').length;
 const k0=+(await page.locator('#rev-keep').inputValue());assert(k0>=1&&k0<=50,'the control starts at the server value '+k0);
 await page.locator('#rev-keep').fill('2');await page.locator('#rev-keep').press('Enter');await page.locator('#rev-keep').blur();
 await page.waitForFunction(()=>{try{return localStorage.getItem('aad-keep-builds')==='2';}catch(e){return false;}},null,{timeout:10000});
 let rj=await revs();assert.equal(rj.keep,2,'the server keeps 2 earlier builds now');
 const rows1=rj.rows.filter(r=>r.kind!=='version').length;   // 2 earlier builds plus up to 3 builds pinned by packets
 assert(rows1<=Math.min(rows0,5),`older builds pruned to the setting (${rows0} -> ${rows1} stored builds)`);
 await page.evaluate(()=>fetch(new URL('review/revisions/keep',location.href),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keep:10})}));
 assert.equal((await revs()).keep,10,'a server that forgot the setting');
 await page.reload();await page.waitForFunction(()=>window.viewer?.state().ready&&window.viewer.review,null,{timeout:120000});
 await page.locator('#tabs [data-tab=diff]').click();
 for(let i=0;i<40&&(await revs()).keep!==2;i++)await page.waitForTimeout(250);
 assert.equal((await revs()).keep,2,'the remembered value is sent again on load');
 await page.locator('#rev-more-btn').click();await page.waitForTimeout(300);assert.equal(await page.locator('#rev-keep').inputValue(),'2');
 await page.locator('#rev-keep').fill('0');await page.locator('#rev-keep').press('Enter');await page.waitForTimeout(500);
 assert.equal((await revs()).keep,2,'0 is refused');assert.equal(await page.locator('#rev-keep').inputValue(),'2','the box goes back to 2');assert.equal(await page.evaluate(()=>localStorage.getItem('aad-keep-builds')),'2');
 if(X.shots)await page.locator('#panel').screenshot({path:path.join(X.shots,'revisions-more-keep.png')});
 ok('Stored builds to keep: 2 applied on the server and pruned, remembered in this browser, re-sent after a server reset, 0 refused');
}
