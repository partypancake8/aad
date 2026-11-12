// aad view: a local three.js CAD viewer with a review workspace (served by aad/viewer/server.py).
// Loads every file of /models.json (.glb, .stl, .ply; mm, Z up), one tree module per file or directory group
// (or the --tree part tree), with review or fitted camera buttons, section planes, explode, picking, a
// movable group with pose save, live reload, and one undo/redo history over every committed state change.
// Navigation is camera-controls (orbit about the point under the cursor, pan, zoom to cursor), the view cube is
// three-viewport-gizmo, picking runs on three-mesh-bvh, and the review workspace (pins, measure, scope lock, diff,
// tour, packets; review.js) shares this page's history. All libraries are vendored under vendor/.
import * as THREE from 'three';
import CameraControls from 'camera-controls';
import {ViewportGizmo} from 'three-viewport-gizmo';
import {computeBoundsTree,disposeBoundsTree,acceleratedRaycast,MeshBVH} from 'three-mesh-bvh';
import {solidOf as solidCalc,weldIds,csr,csrMap,edgeTopology,segGrid,gridQuery} from './prep.js';
import {CSS2DRenderer,CSS2DObject} from 'three/addons/renderers/CSS2DRenderer.js';
import {initReview} from './review.js';
import {initWeight} from './weight.js';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import {PLYLoader} from 'three/addons/loaders/PLYLoader.js';
// Version-prefixed URLs keep different tabs independent, including model polling and poses.
const fetch=(input,init)=>window.fetch(typeof input==='string'&&input.startsWith('/')?new URL('.'+input,location.href):input,init);
const $=id=>document.getElementById(id);
const log=(level,msg)=>window.__log&&window.__log(level,msg);
// The toolbar's left group is three flex items: the DEV or PROD badge (never shrinks), the model name and the build
// status. When the row runs out of width, fitBrand() shortens in this order: the status to its compact form ("build
// ok"), then the status goes, then the name truncates with an ellipsis down to about 8 characters. Full texts stay in
// the tooltips.
function setViewerTitle(title){
  const el=$('title'),badge=$('envbadge'),match=/^(PROD|DEV) \| (.+)$/.exec(title);
  badge.hidden=!match;
  if(match){
    badge.className='environment-pill '+match[1].toLowerCase();badge.textContent=match[1];
    badge.title=match[1]==='DEV'?'Development working copy':'Production baseline';
  }
  el.textContent=match?match[2]:title;
  const icon=$('favicon');                          // tint the tab icon like the DEV or PROD badge
  if(icon)icon.setAttribute('href',match?'favicon-'+match[1].toLowerCase()+'.svg':'favicon.svg');
  el.title=title;                                  // the name may be cut short on a narrow toolbar
  document.title=title+' viewer';
  el.style.minWidth='';fitBrandSoon();
}
function fitBrand(){
  const b=$('brand'),t=$('title'),st=$('status'),top=$('top');if(!b||!t||!st)return;
  if(!t.style.minWidth&&t.textContent){            // the name's floor: about 8 characters, or all of a shorter name
    t.style.minWidth='0px';const w=t.scrollWidth,n=t.textContent.length;
    t.style.minWidth=Math.ceil(n>9?w/n*8.5:w)+'px';
  }
  const full=st.dataset.full||st.textContent,short=st.dataset.short||full;
  const cut=e=>!e.hidden&&e.scrollWidth>e.clientWidth+0.5,over=()=>top.scrollWidth>top.clientWidth+0.5;
  for(let lv=0;lv<3;lv++){
    b.dataset.fit=String(lv);st.hidden=lv===2;st.textContent=lv===0?full:short;
    if(lv===2||!(cut(t)||cut(st)||over()))break;
  }
}
let brandRaf=0;const fitBrandSoon=()=>{if(!brandRaf)brandRaf=requestAnimationFrame(()=>{brandRaf=0;fitBrand();});};
// refit when the window or any toolbar group changes size (labels collapse, buttons appear)
if(window.ResizeObserver){const ro=new ResizeObserver(fitBrandSoon),tb=document.getElementById('top');ro.observe(tb);for(const c of tb.children)if(c.id!=='brand')ro.observe(c);}
const D2R=Math.PI/180,R2D=180/Math.PI;
THREE.Object3D.DEFAULT_UP.set(0,0,1);
CameraControls.install({THREE});
THREE.BufferGeometry.prototype.computeBoundsTree=computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree=disposeBoundsTree;
THREE.Mesh.prototype.raycast=acceleratedRaycast;

// ---- renderer, cameras, lights ----
const host=$('view'),canvas=$('c');
// WebGL when the browser has it; otherwise (headless Chrome with --disable-gpu) a software z-buffer preview on
// a 2D canvas that draws the same scene state (camera, visibility, explode, clip, highlight).
// (no separate probe context: creating and dropping a throwaway WebGL context cost about 250 ms on every load)
let renderer=null;
try{renderer=new THREE.WebGLRenderer({canvas,antialias:true});}catch(e){renderer=null;}
// a device pixel ratio above 2 multiplies fill cost with no visible gain on a CAD model
if(renderer){renderer.setPixelRatio(Math.min(2,devicePixelRatio||1));renderer.localClippingEnabled=true;renderer.autoClear=false;}
const SOFT=!renderer;
const BG='#e5e7eb';                                   // light viewport (CAD convention) inside the dark page chrome
let bgDefault=BG;                                     // the light grey preset (a shaded-edges project lightens it)
const scene=new THREE.Scene();scene.background=new THREE.Color(BG);
const FOV=30,OB=200;                                   // ortho base half-height (mm at zoom 1)
const persp=new THREE.PerspectiveCamera(FOV,1,1,100000);
const ortho=new THREE.OrthographicCamera(-OB,OB,OB,-OB,1,100000);
for(const c of [persp,ortho]){c.up.set(0,0,1);scene.add(c);}
let cam=ortho;
scene.add(new THREE.HemisphereLight(0xffffff,0x78818c,0.85));
const key=new THREE.DirectionalLight(0xffffff,1.0);key.position.set(-0.5,0.8,1);cam.add(key);
// Navigation presets (Options, remembered per browser):
//   Fusion (default, Autodesk Fusion's "Pan, Zoom, Orbit shortcuts: Fusion"): middle drag pans, Shift+middle drag
//     orbits, the wheel zooms toward the cursor, a middle double-click fits; on a Mac trackpad two-finger scroll
//     pans, Shift+two-finger scroll orbits and pinch zooms toward the cursor. The left button never moves the camera:
//     it belongs to the active tool (select, pin, region, measure, scope), so navigation is the same in every mode.
//   Classic: left drag orbits, right or middle drag pans, Shift+middle orbits, wheel and two-finger scroll zoom.
// An orbit pivots about the point under the cursor when it starts (else the selection). The pivot is set with a
// focal offset so the view does not jump; when the move ends the offset is folded back into a plain position +
// target, which is all the undo history and the review camera store.
const controls=new CameraControls(cam,canvas),ACT=CameraControls.ACTION;
Object.assign(controls,{dollyToCursor:true,infinityDolly:false,minDistance:1,maxDistance:200000,minZoom:0.005,maxZoom:5000,
  azimuthRotateSpeed:0.8,polarRotateSpeed:0.8,truckSpeed:1,dollySpeed:1,smoothTime:SOFT?0:0.14,draggingSmoothTime:SOFT?0:0.06,restThreshold:0.004});
// the older OrbitControls flag scripted checks set; false means every move lands at once
Object.defineProperty(controls,'enableDamping',{get(){return controls.smoothTime>0;},set(v){controls.smoothTime=v?0.14:0;controls.draggingSmoothTime=v?0.06:0;}});
// viewer options (navigation preset, background, edges): one localStorage entry; the page works without storage
const OPT_KEY='aad-viewer-options';
const OPTS=(()=>{let o={};try{o=JSON.parse(localStorage.getItem(OPT_KEY)||'{}')||{};}catch(e){o={};}
  return {nav:o.nav==='classic'?'classic':'fusion',bg:typeof o.bg==='string'?o.bg:null,edges:typeof o.edges==='boolean'?o.edges:null,
    orbit:o.orbit==='constrained'?'constrained':'free',large:o.large===false?false:true,pivot:['selection','cursor'].includes(o.pivot)?o.pivot:'view',
    through:o.through===false?false:true,fadeHidden:o.fadeHidden===false?false:true};})();
function saveOpts(){try{localStorage.setItem(OPT_KEY,JSON.stringify(OPTS));}catch(e){}}
const NAV_HINT={fusion:'Navigation Fusion: middle drag pans, Shift+middle orbits, wheel zooms, double middle-click fits; trackpad: scroll pans, Shift+scroll orbits, pinch zooms',
  classic:'Navigation Classic: left drag orbits, right or middle drag pans, wheel zooms'};
let shiftDown=false,leftAction=ACT.ROTATE;
const fusionNav=()=>OPTS.nav==='fusion';
function mouseMap(){
  const zoom=cam.isOrthographicCamera?ACT.ZOOM:ACT.DOLLY;
  controls.mouseButtons.middle=shiftDown?ACT.ROTATE:ACT.TRUCK;controls.mouseButtons.wheel=zoom;
  if(fusionNav()){controls.mouseButtons.left=ACT.NONE;controls.mouseButtons.right=ACT.NONE;}
  else{controls.mouseButtons.left=leftAction;controls.mouseButtons.right=ACT.TRUCK;}
  controls.touches.one=ACT.TOUCH_ROTATE;controls.touches.two=cam.isOrthographicCamera?ACT.TOUCH_ZOOM_TRUCK:ACT.TOUCH_DOLLY_TRUCK;
}
mouseMap();
function setNav(n){OPTS.nav=n==='classic'?'classic':'fusion';saveOpts();mouseMap();
  const h=document.getElementById('navhint');if(h)h.textContent=NAV_HINT[OPTS.nav];
  document.querySelectorAll('input[name=nav]').forEach(r=>{r.checked=r.value===OPTS.nav;});}
// Shift is read from every pointer event too, so a Shift pressed while focus was elsewhere (the pin note) still counts
const syncShift=s=>{if(s!==shiftDown){shiftDown=s;mouseMap();}};
addEventListener('keydown',e=>{if(e.key==='Shift')syncShift(true);});
addEventListener('keyup',e=>{if(e.key==='Shift')syncShift(false);});
addEventListener('blur',()=>syncShift(false));
addEventListener('pointermove',e=>syncShift(e.shiftKey),true);
const _t=new THREE.Vector3(),_p=new THREE.Vector3();
const camTarget=(o=new THREE.Vector3(),end=false)=>controls.getTarget(o,end);
// place the camera at pos looking at target (zoom for the ortho camera), through the controls so they agree
function placeCam(pos,target,zoom,animate=false){
  controls.updateCameraUp();                       // callers set cam.up first (free orbit leaves any up)
  controls.setFocalOffset(0,0,0,false);
  controls.setLookAt(pos.x,pos.y,pos.z,target.x,target.y,target.z,animate);
  if(zoom!=null&&cam.isOrthographicCamera)controls.zoomTo(zoom,animate);
  if(!animate)controls.update(0);
  dirty=true;
}
// fold a focal offset (left by orbit-about-point) back into position + target, keeping the exact view
function bakeOrbit(){
  const fo=controls.getFocalOffset(_p);if(fo.lengthSq()<1e-12)return;
  controls.update(0);cam.updateMatrixWorld();
  const pos=cam.position.clone(),dir=cam.getWorldDirection(new THREE.Vector3()),r=Math.max(1,camTarget(_t).distanceTo(pos));
  const z=cam.zoom;controls.setFocalOffset(0,0,0,false);
  controls.setLookAt(pos.x,pos.y,pos.z,pos.x+dir.x*r,pos.y+dir.y*r,pos.z+dir.z*r,false);
  if(cam.isOrthographicCamera)controls.zoomTo(z,false);controls.update(0);
}
controls.addEventListener('controlend',()=>{bakeOrbit();orbitPivot=null;showPivot(null);dirty=true;});
// ---- Free orbit (Options, default; Fusion's Free Orbit): the drag turns the camera about a screen-space axis
// (horizontal drag about the view's up, vertical drag about its right), rotating position, target and up together
// about the pivot, so the model keeps turning through and past the top and bottom with no locked up axis.
// camera-controls stays the controller for pan, zoom to cursor and transitions: its rotate step is replaced, and
// its orbit space is re-based on the camera's new up after every step (updateCameraUp), so its polar clamp never
// meets a pole. Constrained is the camera-controls turntable with world Z up. ----
const ZUP=new THREE.Vector3(0,0,1);
const freeOrbit=()=>OPTS.orbit!=='constrained';
let orbitPivot=null;
const _qa=new THREE.Quaternion(),_ax=new THREE.Vector3(),_cr=new THREE.Vector3(),_cu=new THREE.Vector3();
function placeFree(pos,tgt,up){
  cam.up.copy(up).normalize();controls.updateCameraUp();controls.setFocalOffset(0,0,0,false);
  controls.setLookAt(pos.x,pos.y,pos.z,tgt.x,tgt.y,tgt.z,false);controls.update(0);dirty=true;
}
// rotate the camera by quaternion q about point P (position, target and up together)
function turnCam(q,P){
  const pos=controls.getPosition(new THREE.Vector3()).sub(P).applyQuaternion(q).add(P);
  const tgt=camTarget(new THREE.Vector3()).sub(P).applyQuaternion(q).add(P);
  cam.updateMatrixWorld();placeFree(pos,tgt,_cu.setFromMatrixColumn(cam.matrixWorld,1).applyQuaternion(q));
}
// deltaX, deltaY as camera-controls passes them (previous minus current pointer, px); same speed as its rotate
function freeRotate(deltaX,deltaY){
  const dx=-deltaX,dy=-deltaY;if(!dx&&!dy)return;
  const h=controls._elementRect.height||canvas.clientHeight||1,k=2*Math.PI*controls.azimuthRotateSpeed/h;
  cam.updateMatrixWorld();_cr.setFromMatrixColumn(cam.matrixWorld,0);_cu.setFromMatrixColumn(cam.matrixWorld,1);
  _ax.copy(_cu).multiplyScalar(dx).addScaledVector(_cr,dy);const len=_ax.length();_ax.divideScalar(len);
  // the model turns with the pointer: the camera turns the other way
  turnCam(_qa.setFromAxisAngle(_ax,-k*len),orbitPivot||camTarget(new THREE.Vector3()));
}
const ccRotate=controls._rotateInternal;
controls._rotateInternal=(dx,dy)=>{if(freeOrbit())freeRotate(dx,dy);else ccRotate(dx,dy);};
// a level, Z-up view in the same direction (straight down or up: nudged a hair toward -Y, as the review views do)
function levelUp(){
  bakeOrbit();const t=camTarget(new THREE.Vector3()),p=controls.getPosition(new THREE.Vector3()),d=p.clone().sub(t);
  if(cam.up.distanceToSquared(ZUP)<1e-12&&Math.abs(d.clone().normalize().z)<=0.9999)return;
  if(Math.abs(d.clone().normalize().z)>0.9999)p.y-=1e-3*d.length();
  cam.up.copy(ZUP);placeCam(p,t,cam.isOrthographicCamera?cam.zoom:null);
}
let lastFrame=performance.now();              // frame delta for the controls' smoothing (THREE.Clock is deprecated in r187)
let R=null;                          // the review workspace (review.js), once the manifest says review is on
let Wt=null;                         // the weight estimate and Part info (weight.js), once a model is loaded
let cube=null;                       // the view cube (three-viewport-gizmo)
let showSides=false;                 // named sides overlay
// labels drawn over the canvas (pins, measurements, named sides): CSS2DRenderer, no pointer events except pins
const labels=new CSS2DRenderer();labels.domElement.id='labels';host.append(labels.domElement);
// ---- orbit pivot (Options): "view" (default) is the centre of what is being viewed, the volume centroid of the
// visible parts (or of the selection when there is one); "selection" is the selection's centroid, else the view's
// target; "cursor" is the point under the cursor (else the selection, else the view centroid). The centroid is the
// true solid centroid of each closed mesh (signed tetrahedra from the origin, cached per geometry), weighted by
// its volume; an open or flat mesh counts as its bounding box (centre, box volume). It is computed when an orbit
// starts, so hiding, isolating, solo, a version switch and explode all move it; section planes do not. ----
// For a large model the solid numbers come from the background preparation (prep_worker.js); until a part's arrive
// it counts as its bounding box, so starting an orbit never waits on a full pass over millions of triangles.
const solidCache=new WeakMap();
const asSolid=r=>({closed:r.closed,volume:r.volume,centroid:r.centroid?new THREE.Vector3(...r.centroid):null});
function solidOf(g){
  let s=solidCache.get(g);if(s)return s;
  if(prepPending.has(g))return {closed:false,volume:0,centroid:null};
  s=asSolid(solidCalc(posArray(g.attributes.position),g.index?g.index.array:null));solidCache.set(g,s);return s;
}
// a compact xyz Float32Array of a position attribute (a copy only when it is interleaved, offset or not float)
function posArray(p){
  if(!p.isInterleavedBufferAttribute&&p.itemSize===3&&p.array instanceof Float32Array&&!p.normalized&&p.array.length===p.count*3)return p.array;
  const out=new Float32Array(p.count*3);for(let i=0;i<p.count;i++){out[3*i]=p.getX(i);out[3*i+1]=p.getY(i);out[3*i+2]=p.getZ(i);}return out;
}
function centroidOf(meshes){
  scene.updateMatrixWorld();let W=0;const sum=new THREE.Vector3(),t=new THREE.Vector3(),bb=new THREE.Box3(),sz=new THREE.Vector3();
  for(const m of meshes){
    const s=solidOf(m.geometry);let w;
    if(s.closed){w=s.volume*Math.abs(m.matrixWorld.determinant());t.copy(s.centroid).applyMatrix4(m.matrixWorld);}
    else{if(!m.geometry.boundingBox)m.geometry.computeBoundingBox();bb.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      bb.getSize(sz);w=Math.max(sz.x*sz.y*sz.z,1e-9);bb.getCenter(t);}
    sum.addScaledVector(t,w);W+=w;
  }
  return W>0?sum.divideScalar(W):null;
}
const visibleMeshes=()=>meshList.filter(effVisible);
function selMeshes(){if(!sel)return [];const out=[];for(const l of sel.rec.leaves){const r=nodes.get(l);if(r)r.obj.traverse(m=>{if(m.isMesh&&effVisible(m))out.push(m);});}return out;}
const viewCentre=()=>centroidOf(visibleMeshes());
function pivotFor(e){
  const sc=sel?centroidOf(selMeshes()):null;
  if(OPTS.pivot==='cursor'){const h=e?pickHit(e):null;return h?h.point.clone():sc||viewCentre();}
  if(OPTS.pivot==='selection')return sc;
  return sc||viewCentre();
}
// a small marker at the pivot while an orbit runs (none at rest)
const pivotEl=document.createElement('div');pivotEl.id='pivot-marker';
const pivotObj=new CSS2DObject(pivotEl);pivotObj.visible=false;pivotObj.name='Orbit pivot';scene.add(pivotObj);
function showPivot(p){pivotObj.visible=!!p;if(p)pivotObj.position.copy(p);dirty=true;}
// when an orbit starts. This capture listener runs before camera-controls sees the event, so the button map always
// matches the event's own Shift state. Free: the target moves onto the view ray nearest the pivot (the same view,
// so nothing moves on screen) and the drag turns about the pivot. Constrained: the view is levelled (Z up) and the
// pivot is a camera-controls orbit point (a focal offset, folded back when the move ends).
function orbitAbout(e){
  const p=pivotFor(e);
  if(freeOrbit()){
    orbitPivot=p;
    if(p){
      bakeOrbit();controls.update(0);cam.updateMatrixWorld();
      const pos=controls.getPosition(new THREE.Vector3()),dir=cam.getWorldDirection(new THREE.Vector3()),d=p.clone().sub(pos).dot(dir);
      if(d>1e-3){const t=pos.clone().addScaledVector(dir,d);controls.setLookAt(pos.x,pos.y,pos.z,t.x,t.y,t.z,false);controls.update(0);}
    }
  }else{levelUp();if(p){controls.setOrbitPoint(p.x,p.y,p.z);controls.update(0);}}
  showPivot(p||camTarget(new THREE.Vector3()));
}
let midClick={t:0,x:0,y:0};
canvas.addEventListener('pointerdown',e=>{
  syncShift(e.shiftKey);
  if(SOFT||fishOn()||!controls.enabled)return;
  if(e.button===1){
    e.preventDefault();                                  // no autoscroll cursor
    const t=performance.now();
    if(fusionNav()&&t-midClick.t<400&&Math.hypot(e.clientX-midClick.x,e.clientY-midClick.y)<6){midClick.t=0;camAction(fitAll);return;}
    midClick={t,x:e.clientX,y:e.clientY};
  }
  const orbit=(e.button===1&&e.shiftKey)||(!fusionNav()&&e.button===0&&leftAction===ACT.ROTATE&&!e.ctrlKey);
  if(orbit)orbitAbout(e);
},true);
// wheel: camera-controls zooms toward the cursor (and always zooms on a trackpad pinch, which arrives as ctrl+wheel).
// Under the Fusion preset a trackpad scroll pans and Shift+scroll (trackpad or wheel) orbits; those are handled
// here and never reach camera-controls.
let wheelT=0,wheelKind=null,wheelBake=0;
function trackpadWheel(e){
  if(e.deltaMode!==0)return false;
  if(e.wheelDeltaY&&e.wheelDeltaY===-3*e.deltaY)return true;          // macOS trackpad in Chromium and Safari
  return e.deltaX!==0||!Number.isInteger(e.deltaY);
}
canvas.addEventListener('wheel',e=>{
  syncShift(e.shiftKey);
  if(SOFT||fishOn()||!controls.enabled||!fusionNav()||e.ctrlKey)return;
  const t=performance.now(),fresh=t-wheelT>250;wheelT=t;
  // one gesture keeps one meaning: a scroll stream classified as trackpad stays a pan until it pauses
  const kind=e.shiftKey?'orbit':(fresh||!wheelKind||wheelKind==='orbit')?(trackpadWheel(e)?'pan':'zoom'):wheelKind;
  if(fresh||kind!==wheelKind){controls._getClientRect(controls._elementRect);if(kind==='orbit')orbitAbout(e);}
  wheelKind=kind;
  if(kind==='zoom')return;
  e.preventDefault();e.stopImmediatePropagation();
  // with Shift a mouse wheel arrives as deltaX in most browsers; either axis orbits. Content follows the fingers.
  const dx=e.deltaX,dy=e.deltaY;
  if(kind==='orbit')controls._rotateInternal(-dx,-dy);else controls._truckInternal(-dx,-dy,false,false);
  dirty=true;clearTimeout(wheelBake);
  wheelBake=setTimeout(()=>{wheelBake=0;bakeOrbit();orbitPivot=null;showPivot(null);dirty=true;},500);    // the scroll paused: fold the pivot back
},{capture:true,passive:false});
let dirty=true,renders=0,ctrlTrue=0;
const lastC={cam:null,p:new THREE.Vector3(),q:new THREE.Quaternion(),z:0,t:new THREE.Vector3()};
function camMoved(){
  const t=camTarget(_t);
  const m=lastC.cam!==cam||lastC.p.distanceToSquared(cam.position)>1e-8||8*(1-Math.abs(lastC.q.dot(cam.quaternion)))>1e-9||
    Math.abs(lastC.z-cam.zoom)>1e-9||lastC.t.distanceToSquared(t)>1e-8;
  if(m){lastC.cam=cam;lastC.p.copy(cam.position);lastC.q.copy(cam.quaternion);lastC.z=cam.zoom;lastC.t.copy(t);}
  return m;
}
// ground grid at Z 0 (20 mm cells, grows with the model) and axes at the origin
const GRID={size:600,cell:20};let grid=null,showGrid=false;
function setGrid(size){
  if(grid&&GRID.size===size)return;GRID.size=size;
  if(grid){scene.remove(grid);grid.geometry.dispose();}
  grid=new THREE.GridHelper(size,Math.round(size/GRID.cell),0x64748b,0xabb2bd);grid.rotation.x=Math.PI/2;scene.add(grid);dirty=true;
  grid.visible=showGrid;
}
setGrid(600);
function setGridVisible(visible){
  showGrid=visible;grid.visible=visible;
  $('grid').classList.toggle('on',visible);$('grid').setAttribute('aria-pressed',String(visible));
  $('grid').title=visible?'Hide ground grid':'Show ground grid';dirty=true;
}
$('grid').onclick=()=>{setGridVisible(!showGrid);commit();};
const axes=new THREE.AxesHelper(60);scene.add(axes);
// ---- named sides overlay: FRONT/BACK/LEFT/RIGHT/TOP/BOTTOM at the model's faces plus a labelled axis triad at its
// lower corner, so "the left side" means one thing (front is -Y, right is +X, top is +Z) ----
const sides=new THREE.Group();sides.name='Named sides';sides.visible=false;scene.add(sides);
function buildSides(){
  for(const o of sides.children)if(o.element)o.element.remove();
  sides.clear();
  // around what is shown (a review view may hide most of the model)
  const vb=new THREE.Box3();for(const m of meshList)if(effVisible(m))vb.expandByObject(m);
  const bbox=vb.isEmpty()?modelBox():vb;if(bbox.isEmpty())return;
  const c=bbox.getCenter(new THREE.Vector3()),s=bbox.getSize(new THREE.Vector3()),m=Math.max(8,0.06*Math.max(s.x,s.y,s.z));
  const tag=(t,cls,p)=>{const d=document.createElement('div');d.className='side-label '+cls;d.textContent=t;const o=new CSS2DObject(d);o.position.copy(p);sides.add(o);};
  tag('FRONT  -Y','side',new THREE.Vector3(c.x,bbox.min.y-m,c.z));tag('BACK  +Y','side',new THREE.Vector3(c.x,bbox.max.y+m,c.z));
  tag('LEFT  -X','side',new THREE.Vector3(bbox.min.x-m,c.y,c.z));tag('RIGHT  +X','side',new THREE.Vector3(bbox.max.x+m,c.y,c.z));
  tag('TOP  +Z','side',new THREE.Vector3(c.x,c.y,bbox.max.z+m));tag('BOTTOM  -Z','side',new THREE.Vector3(c.x,c.y,bbox.min.z-m));
  const L=Math.max(20,0.25*Math.min(s.x,s.y)),o=new THREE.Vector3(bbox.min.x-m,bbox.min.y-m,bbox.min.z);
  const ax=new THREE.AxesHelper(L);ax.position.copy(o);ax.material.depthTest=false;ax.renderOrder=5;sides.add(ax);
  tag('X','axis x',o.clone().add(new THREE.Vector3(L*1.12,0,0)));tag('Y','axis y',o.clone().add(new THREE.Vector3(0,L*1.12,0)));tag('Z','axis z',o.clone().add(new THREE.Vector3(0,0,L*1.12)));
  sides.visible=showSides;
}
const modelBox=()=>bbox;
function setSides(v){showSides=!!v;if(showSides)buildSides();sides.visible=showSides;$('sides').classList.toggle('on',showSides);$('sides').setAttribute('aria-pressed',String(showSides));dirty=true;}
$('sides').onclick=()=>{setSides(!showSides);commit();};
// corner triad
const tScene=new THREE.Scene(),tCam=new THREE.OrthographicCamera(-1.6,1.6,1.6,-1.6,0.1,10);
tCam.up.set(0,0,1);tScene.add(new THREE.AxesHelper(1));
for(const [t,p,c] of [['X',[1.3,0,0],'#b42318'],['Y',[0,1.3,0],'#166534'],['Z',[0,0,1.3],'#1d4ed8']]){
  const cv=document.createElement('canvas');cv.width=cv.height=64;const g=cv.getContext('2d');
  g.fillStyle=c;g.font='bold 48px system-ui';g.textAlign='center';g.textBaseline='middle';g.fillText(t,32,34);
  const s=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(cv),depthTest:false}));
  s.position.set(...p);s.scale.setScalar(0.55);tScene.add(s);
}
function resize(){
  const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;
  if(renderer)renderer.setSize(w,h,false);const a=w/h;
  persp.aspect=a;persp.updateProjectionMatrix();
  ortho.left=-OB*a;ortho.right=OB*a;ortho.top=OB;ortho.bottom=-OB;ortho.updateProjectionMatrix();
  labels.setSize(w,h);if(cube)cube.update();dirty=true;
}
new ResizeObserver(resize).observe(host);
// ---- resizable panes: drag the divider between the left panel and the view, or between the view and the right
// panel (6 px hit area; Left and Right arrows move a focused divider 16 px; double-click resets that panel), and the
// one between the part tree and the block below it. Limits: left 200 to 520 px, right 300 to 720 px, the view never
// under 360 px (the panel being dragged gives way). The fold button on a divider (or , and . for left and right)
// collapses a panel to a slim rail. Sizes are remembered in this browser (aad-pane-*); a window too narrow for
// them clamps the layout without overwriting what is saved. The canvas, camera aspect, view cube and labels follow
// through the ResizeObserver on the view.
const PANES={side:{min:200,max:520,def:320},panel:{min:300,max:720,def:380}},VIEW_MIN=360,RAIL=22,TREE_MIN=60,PANE_KEY='aad-pane-';
const paneGet=k=>{try{return localStorage.getItem(PANE_KEY+k);}catch(e){return null;}};
const paneSet=(k,v)=>{try{if(v==null)localStorage.removeItem(PANE_KEY+k);else localStorage.setItem(PANE_KEY+k,String(v));}catch(e){}};
const paneNum=k=>{const v=+paneGet(k);return Number.isFinite(v)&&v>0?v:null;};
const pane={side:paneNum('side'),panel:paneNum('panel'),tree:paneNum('tree'),sideOff:paneGet('side-collapsed')==='1',panelOff:paneGet('panel-collapsed')==='1'};
const hasPanel=()=>!document.body.classList.contains('no-panel');
// the widths this window shows: saved (or default) values, clamped to their limits and to the window
function paneWidths(){
  const W=document.body.clientWidth,cl=(k,w)=>Math.max(PANES[k].min,Math.min(PANES[k].max,w));
  let s=pane.sideOff?RAIL:cl('side',pane.side??PANES.side.def),p=!hasPanel()?0:pane.panelOff?RAIL:cl('panel',pane.panel??PANES.panel.def);
  let over=s+p+VIEW_MIN-W;
  if(over>0&&hasPanel()&&!pane.panelOff){const d=Math.min(over,p-PANES.panel.min);p-=d;over-=d;}
  if(over>0&&!pane.sideOff){const d=Math.min(over,s-PANES.side.min);s-=d;}
  return {side:s,panel:p};
}
function lowContent(){const lo=$('side-low');let h=0;for(const c of lo.children)if(c.offsetParent!==null){const cs=getComputedStyle(c);h+=c.offsetHeight+parseFloat(cs.marginTop)+parseFloat(cs.marginBottom);}return h;}
function treeMax(){const sd=$('side'),t=$('tree');return sd.getBoundingClientRect().bottom-t.getBoundingClientRect().top-6-lowContent();}
function applyPanes(){
  const b=document.body,w=paneWidths();
  b.style.setProperty('--side-w',w.side+'px');if(hasPanel())b.style.setProperty('--panel-w',w.panel+'px');
  b.classList.toggle('side-off',pane.sideOff);b.classList.toggle('panel-off',pane.panelOff&&hasPanel());
  $('split-l').setAttribute('aria-valuenow',String(w.side));$('split-r').setAttribute('aria-valuenow',String(w.panel));
  const t=$('tree');
  if(pane.tree&&!pane.sideOff){b.classList.add('tree-sized');t.style.height=Math.round(Math.max(TREE_MIN,Math.min(pane.tree,treeMax())))+'px';}
  else{b.classList.remove('tree-sized');t.style.height='';}
}
function setPaneWidth(k,w){
  const other=paneWidths()[k==='side'?'panel':'side'];
  pane[k]=Math.round(Math.max(PANES[k].min,Math.min(PANES[k].max,document.body.clientWidth-other-VIEW_MIN,w)));applyPanes();
}
function setCollapsed(k,on){
  if(k==='panel'&&!hasPanel())return;
  pane[k+'Off']=!!on;paneSet(k+'-collapsed',on?'1':null);applyPanes();
  ($(on?(k==='side'?'rail-l':'rail-r'):(k==='side'?'split-l':'split-r'))||document.body).focus?.({preventScroll:true});
}
function dragDivider(el,axis,start,move,end){
  el.addEventListener('pointerdown',e=>{
    if(e.button!==0||e.target.closest('.fold'))return;
    e.preventDefault();e.stopPropagation();el.setPointerCapture(e.pointerId);
    const b=document.body;b.classList.add('pane-drag');b.classList.toggle('rows',axis==='y');el.classList.add('drag');
    const s0=start(),p0=axis==='x'?e.clientX:e.clientY;let at=p0,raf=0;
    const mv=ev=>{at=axis==='x'?ev.clientX:ev.clientY;if(!raf)raf=requestAnimationFrame(()=>{raf=0;move(s0,at-p0);});};
    const up=()=>{cancelAnimationFrame(raf);raf=0;move(s0,at-p0);end();b.classList.remove('pane-drag','rows');el.classList.remove('drag');
      el.removeEventListener('pointermove',mv);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up);};
    el.addEventListener('pointermove',mv);el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);
  });
}
for(const [id,k,sign] of [['split-l','side',1],['split-r','panel',-1]]){
  const el=$(id);
  dragDivider(el,'x',()=>paneWidths()[k],(w0,d)=>setPaneWidth(k,w0+sign*d),()=>paneSet(k,pane[k]));
  el.addEventListener('dblclick',e=>{if(e.target.closest('.fold'))return;e.stopPropagation();pane[k]=null;paneSet(k,null);applyPanes();});
  el.addEventListener('keydown',e=>{
    if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();e.stopPropagation();
    setPaneWidth(k,paneWidths()[k]+sign*(e.key==='ArrowRight'?16:-16));paneSet(k,pane[k]);
  });
  el.querySelector('.fold').addEventListener('click',e=>{e.stopPropagation();setCollapsed(k,true);});
  el.querySelector('.fold').addEventListener('pointerdown',e=>e.stopPropagation());
}
$('rail-l').onclick=()=>setCollapsed('side',false);$('rail-r').onclick=()=>setCollapsed('panel',false);
{const el=$('split-t'),t=$('tree');
  dragDivider(el,'y',()=>t.getBoundingClientRect().height,(h0,d)=>{pane.tree=Math.round(Math.max(TREE_MIN,Math.min(h0+d,treeMax())));applyPanes();},()=>paneSet('tree',pane.tree));
  el.addEventListener('dblclick',e=>{e.stopPropagation();pane.tree=null;paneSet('tree',null);applyPanes();});
  el.addEventListener('keydown',e=>{
    if(e.key!=='ArrowUp'&&e.key!=='ArrowDown')return;e.preventDefault();e.stopPropagation();
    pane.tree=Math.round(Math.max(TREE_MIN,Math.min(t.getBoundingClientRect().height+(e.key==='ArrowDown'?16:-16),treeMax())));applyPanes();paneSet('tree',pane.tree);
  });}
// , and . collapse or bring back the left and right panels ([ and ] already pitch a part in Move)
addEventListener('keydown',e=>{
  if(e.metaKey||e.ctrlKey||e.altKey||e.repeat)return;const t=e.target;
  if(t&&(t.tagName==='TEXTAREA'||t.tagName==='SELECT'||t.isContentEditable||(t.tagName==='INPUT'&&!['checkbox','radio','range','button','color'].includes(t.type))))return;
  if(e.key===','){e.preventDefault();setCollapsed('side',!pane.sideOff);}
  else if(e.key==='.'&&hasPanel()){e.preventDefault();setCollapsed('panel',!pane.panelOff);}
});
addEventListener('resize',applyPanes);
{let np=hasPanel();new MutationObserver(()=>{if(hasPanel()!==np){np=hasPanel();applyPanes();}}).observe(document.body,{attributes:true,attributeFilter:['class']});}
applyPanes();
// ---- view cube, tight in the viewport's top-right corner: faces, edges and corners are clickable, and dragging the
// cube orbits the camera live, as in Fusion; CAD names (Z up, front is -Y). The cube moves the camera itself (a
// click animates, a drag sets it every pointer move); while it does, the controls are not updated, or their own
// state would put the camera back each frame. When it ends the controls take the new pose: one undo step. ----
let cubeDrag=false,cubeClick=false;
if(!SOFT){
  const face=(label)=>({label,color:'#d7dee8',labelColor:'#0d1117',hover:{color:'#1f6feb',labelColor:'#ffffff'}});
  cube=new ViewportGizmo(cam,renderer,{type:'cube',container:host,placement:'top-right',size:116,offset:{top:6,right:6},
    font:{family:'-apple-system,system-ui,sans-serif',weight:800},resolution:256,
    right:face('RIGHT'),left:face('LEFT'),top:face('TOP'),bottom:face('BOTTOM'),front:face('BACK'),back:face('FRONT'),   // the gizmo's front is +Y once Z is up
    background:{enabled:false},corners:{color:'#9aa7b6',hover:{color:'#1f6feb'}},edges:{color:'#9aa7b6',opacity:1,hover:{color:'#1f6feb'}}});
  {const el=cube._domElement||cube.domElement;if(el){el.id="viewcube";el.style.zIndex="4";}}   // under the cube arrows
  cube.addEventListener('start',()=>{bakeOrbit();if(ready&&!restoring&&hp>=0)hist[hp].cam=snapCam();cube.target.copy(camTarget());controls.enabled=false;exitCamMode();
    cubeDrag=!cube.animating;cubeClick=cube.animating;});
  cube.addEventListener('change',()=>{dirty=true;});
  cube.addEventListener('end',()=>{
    cubeDrag=false;
    const t=cube.target.clone(),p=cam.position.clone(),d=p.clone().sub(t);
    // a face, edge or corner click lands level with Z up (the cube animates to a Z-up pose); a drag keeps the up it
    // turned with. Straight down or up with Z up: nudge a hair toward -Y so +Y stays up on screen (as the review views)
    if(cubeClick)cam.up.copy(ZUP);cubeClick=false;
    if(cam.up.z>0.9999&&Math.abs(d.clone().normalize().z)>0.9999)p.y-=1e-3*d.length();
    placeCam(p,t,cam.isOrthographicCamera?cam.zoom:null);controls.enabled=!fishOn();markView(null);
    if(ready&&!restoring)pushHist();
  });
  // a press on the cube that neither drags nor hits a face sends no 'end': give the camera back to the controls
  addEventListener('pointerup',()=>{if(cubeDrag)setTimeout(()=>{if(cubeDrag&&!cube._dragging&&!cube.animating){cubeDrag=false;controls.enabled=!fishOn();}},0);});
}
// ---- view cube arrows (Fusion's ViewCube): roll the view 90 degrees about the viewing axis, or step to the face
// above, below, left or right (a 90 degree turn about the view's horizontal or vertical axis through the target;
// from a face view the result snaps to the axes). Animated, one undo step each, keyboard focusable. ----
let camAnim=null;
const _m4=new THREE.Matrix4();
function animateCam(posF,tgtF,upF,ms=320){
  if(camAnim)camAnim.finish();
  bakeOrbit();if(ready&&!restoring&&hp>=0)hist[hp].cam=snapCam();
  const p0=controls.getPosition(new THREE.Vector3()),t0=camTarget(new THREE.Vector3());cam.updateMatrixWorld();
  const u0=new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld,1);
  const q0=new THREE.Quaternion().setFromRotationMatrix(_m4.lookAt(p0,t0,u0)),qf=new THREE.Quaternion().setFromRotationMatrix(_m4.lookAt(posF,tgtF,upF));
  const dq=qf.clone().multiply(q0.clone().invert()),qi=new THREE.Quaternion(),start=performance.now();
  const finish=()=>{camAnim=null;placeFree(posF,tgtF,upF);markView(null);if(ready&&!restoring)pushHist();};
  if(SOFT||ms<=0)return finish();
  camAnim={finish,step(now){const k=Math.min(1,(now-start)/ms);if(k>=1)return finish();const e=k*k*(3-2*k);
    qi.identity().slerp(dq,e);const t=t0.clone().lerp(tgtF,e);
    placeFree(p0.clone().sub(t0).applyQuaternion(qi).add(t),t,u0.clone().applyQuaternion(qi));}};
}
const snapAxis=v=>{const a=[Math.abs(v.x),Math.abs(v.y),Math.abs(v.z)],i=a.indexOf(Math.max(...a)),o=new THREE.Vector3();o.setComponent(i,Math.sign(v.getComponent(i)));return o;};
const COS2=Math.cos(2*D2R);
function cubeTurn(kind){
  if(fishOn()||!ready)return;exitCamMode();bakeOrbit();
  const p=controls.getPosition(new THREE.Vector3()),t=camTarget(new THREE.Vector3()),L=p.distanceTo(t);cam.updateMatrixWorld();
  const n=p.clone().sub(t).normalize(),r=new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld,0),u=new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld,1);
  let nF=n.clone(),uF=u.clone();
  if(kind==='cw')uF.copy(r).negate();else if(kind==='ccw')uF.copy(r);
  else if(kind==='up'){nF.copy(u);uF.copy(n).negate();}else if(kind==='down'){nF.copy(u).negate();uF.copy(n);}
  else if(kind==='left')nF.copy(r).negate();else if(kind==='right')nF.copy(r);
  const sn=snapAxis(n),su=snapAxis(u);
  if(sn.dot(n)>COS2&&su.dot(u)>COS2){nF=snapAxis(nF);uF=snapAxis(uF);}       // a face view lands on a face view
  animateCam(t.clone().addScaledVector(nF,L),t,uF);
}
for(const [id,k] of [['cube-roll-cw','cw'],['cube-roll-ccw','ccw'],['cube-up','up'],['cube-down','down'],['cube-left','left'],['cube-right','right']])
  $(id).onclick=()=>cubeTurn(k);
$('cube-home').onclick=()=>{if(camAnim)camAnim.finish();camAction(goHome);};
// the arrows show while the pointer is over or near the cube (and while one has keyboard focus)
host.addEventListener('pointermove',e=>{const n=$('cube-nav');if(SOFT||fishOn()){n.classList.remove('show');return;}
  const r=n.getBoundingClientRect(),m=24,inside=e.clientX>r.left-m&&e.clientX<r.right+m&&e.clientY>r.top-m&&e.clientY<r.bottom+m;
  n.classList.toggle('show',inside);});
host.addEventListener('pointerleave',()=>$('cube-nav').classList.remove('show'));
if(SOFT)$('cube-nav').hidden=true;

resize();

// ---- movable group (--movable): gizmo, pose fields, nudges, pose save ----
let M=null;                         // /models.json manifest
let mask=null,tc=null;              // the movable wrapper group (persists over reloads) and its gizmo
const loadedPose={p:new THREE.Vector3(),q:new THREE.Quaternion(),s:new THREE.Vector3(1,1,1)};
let savedPose=null,headMode=false;

// ---- camera buttons: review cameras from /views.json, or iso/front/right/back/top/bottom fitted to the model ----
let VIEWS=[],fitted=false,activeView=null,defaultView=null;
let cadAppearance=null,showEdges=true;
const viewHidden=new Set();     // leaf keys hidden by the current view's `hide` list
function setCam(c){
  if(c===cam)return;
  bakeOrbit();
  const t=camTarget(),dir=cam.position.clone().sub(t);
  const half=cam.isOrthographicCamera?OB/cam.zoom:dir.length()*Math.tan(cam.fov*Math.PI/360);
  dir.normalize();
  if(c.isOrthographicCamera){c.zoom=OB/half;c.position.copy(t).addScaledVector(dir,Math.max(2000,half*6,radius*4));}
  else{c.zoom=1;c.position.copy(t).addScaledVector(dir,half/Math.tan(c.fov*Math.PI/360));}
  c.up.copy(cam.up);c.updateProjectionMatrix();c.lookAt(t);
  const pos=c.position.clone();useCam(c);placeCam(pos,t,c.zoom);
}
function useCam(c){
  if(c!==cam){cam.remove(key);c.add(key);cam=c;controls.camera=c;if(tc)tc.camera=c;if(cube)cube.camera=c;mouseMap();}
  $('proj-label').textContent=c.isOrthographicCamera?'Ortho':'Persp';$('proj').classList.toggle('on',!c.isOrthographicCamera);dirty=true;
}
// ---- camera view (kind "camera"): the true lens image, not a perspective stand-in. A cube map rendered at the
// lens point (eye) holds the whole scene exactly as the tree shows it; only the view's fisheye.observer parts (the
// camera's own board and lens, which a lens cannot see) are left out of that one render, the way a ray-traced
// lens simulation leaves them out of its rays. Every output pixel is a sensor pixel of the view's lens model: p = pixel offset
// from the frame centre (sensor_px, image right/up), theta = |p| / f (equidistant, f in px/rad), direction =
// right*sin(theta)cos(phi) + up*sin(theta)sin(phi) + axis*cos(theta), black beyond theta_max (the image circle).
// The frame keeps the sensor aspect, centred in the view. Orbit is off (the lens fixes the viewpoint); Escape or
// any other view button leaves it. Picking and hover cast the same per-pixel rays from the lens.
let camMode=null,projBefore=null,viewBefore=null;   // the active camera view, the camera and view to go back to
const FISH={rt:null,cube:null,scene:null,cam:null,mat:null,rect:null};
function fishInit(fe){
  if(FISH.mat)return;
  const gl2=renderer.capabilities.isWebGL2;      // half float faces: no banding in dark parts
  FISH.rt=new THREE.WebGLCubeRenderTarget(1024,{type:gl2?THREE.HalfFloatType:THREE.UnsignedByteType,generateMipmaps:false,
    minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
  FISH.cube=new THREE.CubeCamera(fe.near_mm||0.5,5000,FISH.rt);
  FISH.mat=new THREE.ShaderMaterial({
    uniforms:{env:{value:FISH.rt.texture},R:{value:new THREE.Matrix3()},sensor:{value:new THREE.Vector2(4,3)},f:{value:1},thMax:{value:Math.PI},px:{value:1}},
    vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
    // 2 x 2 sub-pixel rays per screen pixel (px = sensor pixels per screen pixel), each black beyond the circle
    fragmentShader:`uniform samplerCube env;uniform mat3 R;uniform vec2 sensor;uniform float f;uniform float thMax;uniform float px;varying vec2 vUv;
vec3 ray(vec2 p){float r=length(p);float th=r/f;if(th>thMax)return vec3(0.0);
  vec2 q=r>1e-6?p/r:vec2(0.0);return textureCube(env,R*vec3(q*sin(th),cos(th))).rgb;}
void main(){
  vec2 p=(vUv-0.5)*sensor;float h=0.25*px;
  gl_FragColor=vec4(0.25*(ray(p+vec2(-h,-h))+ray(p+vec2(h,-h))+ray(p+vec2(-h,h))+ray(p+vec2(h,h))),1.0);
  #include <colorspace_fragment>
}`,depthTest:false,depthWrite:false});
  FISH.scene=new THREE.Scene();FISH.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),FISH.mat));
  FISH.cam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
}
function fishRect(){
  const W=host.clientWidth,H=host.clientHeight,g=12,top=44,s=camMode.fisheye.sensor_px,a=s[0]/s[1];
  const w=Math.max(1,Math.min(W-2*g,(H-top-g)*a)),h=w/a;
  return {x:Math.round((W-w)/2),y:Math.round(top+(H-top-g-h)/2),w:Math.round(w),h:Math.round(h)};
}
const observerObjs=()=>{const o=(camMode&&camMode.fisheye&&camMode.fisheye.observer)||[],out=[];
  for(const [,r] of nodes)if(r.leaf&&o.includes(r.leaf.component))out.push(r.obj);return out;};
function fishRender(){
  const v=camMode,fe=v.fisheye;fishInit(fe);
  const r=fe.right,u=fe.up,a=fe.axis,U=FISH.mat.uniforms;
  U.R.value.set(r[0],u[0],a[0],r[1],u[1],a[1],r[2],u[2],a[2]);
  U.sensor.value.set(fe.sensor_px[0],fe.sensor_px[1]);U.f.value=fe.f_px_per_rad;U.thMax.value=fe.theta_max_rad;
  FISH.cube.position.fromArray(v.eye);FISH.cube.updateMatrixWorld(true);
  // viewer helpers (axes, grid, gizmo) and the observer's own body are not in the lens image; the tree is untouched
  const off=[axes,grid,tc&&tc.getHelper(),sides,...observerObjs()].filter(o=>o&&o.visible);
  for(const o of off)o.visible=false;
  const ac=renderer.autoClear;renderer.autoClear=true;
  try{FISH.cube.update(renderer,scene);}finally{renderer.autoClear=ac;for(const o of off)o.visible=true;}
  renderer.setRenderTarget(null);
  const W=host.clientWidth,H=host.clientHeight;renderer.setScissorTest(false);renderer.setViewport(0,0,W,H);
  renderer.setClearColor(0x0d1117,1);renderer.clear();
  const R=fishRect();FISH.rect=R;U.px.value=fe.sensor_px[0]/R.w;renderer.setViewport(R.x,H-R.y-R.h,R.w,R.h);renderer.render(FISH.scene,FISH.cam);
}
function fishDir(ev){
  const R=FISH.rect;if(!R)return null;const cr=canvas.getBoundingClientRect(),fe=camMode.fisheye;
  const u=(ev.clientX-cr.left-R.x)/R.w,w=1-(ev.clientY-cr.top-R.y)/R.h;if(u<0||u>1||w<0||w>1)return null;
  const x=(u-0.5)*fe.sensor_px[0],y=(w-0.5)*fe.sensor_px[1],r=Math.hypot(x,y),th=r/fe.f_px_per_rad;if(th>fe.theta_max_rad)return null;
  const s=r>1e-9?Math.sin(th)/r:0;
  return new THREE.Vector3().fromArray(fe.right).multiplyScalar(x*s).addScaledVector(new THREE.Vector3().fromArray(fe.up),y*s)
    .addScaledVector(new THREE.Vector3().fromArray(fe.axis),Math.cos(th)).normalize();
}
const fishOn=()=>!!(camMode&&camMode.fisheye&&!SOFT);
function enterCamMode(v){
  if(!camMode){projBefore=cam;viewBefore=activeView;}
  camMode=v;persp.fov=FOV;persp.updateProjectionMatrix();useCam(persp);camUI();
}
function exitCamMode(){
  if(!camMode)return;
  camMode=null;
  if(projBefore&&projBefore!==cam)setCam(projBefore);
  projBefore=null;camUI();
}
function camLabel(){
  if(!camMode){$('camnote-t').textContent='';return;}
  let n=0;for(const [k,r] of nodes)if(r.leaf&&!leafShown(k))n++;
  const extra=[];if(+$('explode').value>0)extra.push('explode on');if(clipPlanes.length)extra.push('section on');
  if(SOFT&&camMode.fisheye)extra.push('no WebGL: perspective preview, not the lens');
  $('camnote-t').textContent=(camMode.note||camMode.caption||camMode.name)+', '+(n?n+' part'+(n===1?'':'s')+' hidden':'nothing hidden')+(extra.length?', '+extra.join(', '):'');
}
function camUI(){
  const v=camMode;$('proj').disabled=!!v;$('proj').title=v?'The camera view is the lens projection':'Orthographic matches the review packet PNGs';
  $('camnote').hidden=!v;controls.enabled=!fishOn();$('triad-label').hidden=fishOn();if(cube)cube.enabled=!fishOn();camLabel();
  if(!v)FISH.rect=null;
  dirty=true;
}
function applyCameraView(v){
  enterCamMode(v);
  const eye=new THREE.Vector3(...v.eye),f=v.focal?new THREE.Vector3(...v.focal):eye.clone().addScaledVector(new THREE.Vector3(...v.axis).normalize(),v.scale||100);
  cam.up.set(0,0,1);cam.zoom=1;cam.updateProjectionMatrix();placeCam(eye,f,1);
}
function applyView(v){
  if(v.assembled){$('explode').value=0;applyExplode();}
  if(v.kind==='camera')applyCameraView(v);else{exitCamMode();applyFramedView(v);}
  // the view's hide list (module:<name> or a regex over component names), undone by the next view
  for(const k of viewHidden){if(nodes.has(k)&&!leafShown(k))setVis(k,true,false);}
  viewHidden.clear();
  // the camera view is a reference of what the lens sees: entering it shows every part
  if(v.kind==='camera')for(const [k,n] of nodes)if(n.leaf)vis.set(k,true);
  for(const [k,n] of nodes){
    if(!n.leaf)continue;
    const hit=(v.hide||[]).some(h=>h.startsWith('module:')?n.leaf.module===h.slice(7):new RegExp(h).test(n.leaf.component));
    if(hit&&leafShown(k)){setVis(k,false,false);viewHidden.add(k);}
  }
  applyVisibility();
  markView(v.name);
}
function applyFramedView(v){
  const eye=new THREE.Vector3(...v.eye),f=new THREE.Vector3(...v.focal),up=new THREE.Vector3(...v.up).normalize();
  // Free orbit takes the view's own up exactly (made square to the view direction). Constrained keeps Z up: a view
  // with another up vector (top: +Y up, looking down -Z) gets its eye nudged a hair toward -up, which gives the same
  // screen orientation and framing
  const d0=eye.clone().sub(f).normalize(),u=up.clone().addScaledVector(d0,-up.dot(d0));
  if(freeOrbit()&&Math.abs(up.z)<0.99&&u.lengthSq()>1e-8)cam.up.copy(u.normalize());   // a Z-up view keeps Z exactly
  else{if(Math.abs(up.z)<0.99)eye.addScaledVector(up,-1e-3*eye.distanceTo(f));cam.up.copy(ZUP);}
  const dir=eye.clone().sub(f);let pos,zoom=null;
  if(cam.isOrthographicCamera){pos=f.clone().addScaledVector(dir.clone().normalize(),Math.max(dir.length(),radius*4));zoom=OB/v.scale;}
  else pos=f.clone().addScaledVector(dir.normalize(),v.scale/Math.tan(FOV*Math.PI/360));
  placeCam(pos,f,zoom);
}
// Assembly review views may separate components along their installation axes.
// Keep these display-only offsets independent of model geometry and the explode slider.
const viewOffsets=new Map();
function applyViewOffsets(v){
  for(const [obj,base] of viewOffsets){obj.position.copy(base.p);obj.quaternion.copy(base.q);obj.scale.copy(base.s);}
  viewOffsets.clear();
  for(const [,rec] of nodes){
    if(!rec.leaf)continue;
    const entry=(v?.offsets||[]).find(x=>new RegExp(x.match).test(rec.leaf.component));
    if(!entry)continue;
    viewOffsets.set(rec.obj,{p:rec.obj.position.clone(),q:rec.obj.quaternion.clone(),s:rec.obj.scale.clone()});
    if(entry.pivot&&entry.axis&&Number.isFinite(entry.angle_deg)){
      scene.updateMatrixWorld(true);rec.obj.updateMatrix();
      const pivot=new THREE.Vector3(...entry.pivot),axis=new THREE.Vector3(...entry.axis).normalize();
      const motion=new THREE.Matrix4().makeTranslation(...pivot.toArray())
        .multiply(new THREE.Matrix4().makeRotationAxis(axis,entry.angle_deg*Math.PI/180))
        .multiply(new THREE.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
      const parent=rec.obj.parent?.matrixWorld||new THREE.Matrix4();
      rec.obj.applyMatrix4(parent.clone().invert().multiply(motion).multiply(parent));
    }
    if(entry.xyz)rec.obj.position.add(new THREE.Vector3(...entry.xyz));
  }
}
function markView(n){activeView=n;applyViewOffsets(VIEWS.find(v=>v.name===n));document.querySelectorAll('#views button').forEach(b=>b.classList.toggle('on',b.dataset.v===n));dirty=true;}
const FITTED=[['iso',[1,-1,0.8],[0,0,1]],['front',[0,-1,0],[0,0,1]],['right',[1,0,0],[0,0,1]],['back',[0,1,0],[0,0,1]],
  ['top',[0,0,1],[0,1,0]],['bottom',[0,0,-1],[0,-1,0]]];
function fittedViews(){
  const c=bbox.getCenter(new THREE.Vector3()),r=Math.max(1,radius);
  return FITTED.map(([name,d,up])=>{const n=new THREE.Vector3(...d).normalize();
    return {name,caption:name+' view fitted to the model',eye:c.clone().addScaledVector(n,r*4).toArray(),focal:c.toArray(),up,scale:r*1.08};});
}
function renderViewButtons(){
  const box=$('views');box.innerHTML='';
  for(const v of VIEWS){
    const b=document.createElement('button');b.dataset.v=v.name;b.textContent=v.label||v.name;b.title=v.caption||v.name;
    b.onclick=()=>camAction(()=>applyView(v));box.append(b);
  }
  markView(activeView);
}
async function loadViews(){
  let j={};try{j=await (await fetch('/views.json')).json();}catch(e){console.warn('views.json',e);}
  cadAppearance=j.appearance||null;
  if(cadAppearance?.style==='shaded-edges'){
    bgDefault='#eef1f5';
    scene.add(new THREE.AmbientLight(0xffffff,0.6));
    key.intensity=1.5;
    for(const light of scene.children)if(light.isHemisphereLight)light.intensity=1.3;
    const b=document.createElement('button');b.id='edges';b.innerHTML='<i class="ic i-edges"></i><span>Edges</span>';b.className='on';
    b.title='Show visible feature edges';b.setAttribute('aria-pressed','true');
    b.onclick=()=>setEdges(!showEdges,true);
    $('grid').after(b);
  }
  VIEWS=j.views||[];fitted=!!j.fitted||!VIEWS.length;defaultView=j.default_view||null;
  applyBg();setEdges(edgesWanted(),false);
  renderViewButtons();
}
function fitAll(){exitCamMode();endTargetFocus();const b=new THREE.Box3();for(const m of meshList)if(effVisible(m))b.expandByObject(m);if(!b.isEmpty())focusBox(b,false);markView(null);}
// Home: the project's default review view (else iso), the view the page opened with
function goHome(){endTargetFocus();const v=VIEWS.find(x=>x.name===(defaultView||(headMode?'front':'iso'))&&x.kind!=='camera');if(v)applyView(v);else{levelUp();fitAll();}}
function fitSelection(){if(sel)showTarget({keys:[sel.key]},false);else fitAll();}
$('proj').onclick=()=>{if(!camMode)camAction(()=>setCam(cam===ortho?persp:ortho));};
$('fit').onclick=()=>camAction(fitAll);
$('home').onclick=()=>camAction(goHome);
$('fitsel').onclick=()=>camAction(fitSelection);
// ---- Options popover (navigation preset; background and edges below) ----
const optPop=$('options-pop');
function closeOptions(){if(optPop.hidden)return;optPop.hidden=true;$('options').setAttribute('aria-expanded','false');$('options').classList.remove('on');}
$('options').onclick=()=>{
  if(!optPop.hidden)return closeOptions();
  optPop.hidden=false;$('options').setAttribute('aria-expanded','true');$('options').classList.add('on');
  const b=$('options').getBoundingClientRect();
  optPop.style.left=Math.max(8,Math.min(b.left,innerWidth-optPop.offsetWidth-8))+'px';optPop.style.top=(b.bottom+6)+'px';
};
addEventListener('pointerdown',e=>{if(!optPop.contains(e.target)&&!$('options').contains(e.target))closeOptions();},true);
addEventListener('keydown',e=>{if(e.key==='Escape'&&!optPop.hidden){e.preventDefault();e.stopImmediatePropagation();closeOptions();}},true);
document.querySelectorAll('input[name=nav]').forEach(r=>r.onchange=()=>{if(r.checked)setNav(r.value);});
$('navhint').title='Change it in Options';
// orbit style and pivot (Options, remembered per browser)
function setOrbitOpt(k,v){OPTS[k]=v;saveOpts();document.querySelectorAll(`input[name=${k}]`).forEach(r=>{r.checked=r.value===OPTS[k];});
  if(k==='orbit'&&v==='constrained')camAction(levelUp);}
for(const k of ['orbit','pivot'])document.querySelectorAll(`input[name=${k}]`).forEach(r=>{r.checked=r.value===OPTS[k];r.onchange=()=>{if(r.checked)setOrbitOpt(k,r.value);};});
setNav(OPTS.nav);
// viewport background: light grey (the CAD default), white, dark, black, or any colour; overlays switch to light
// text on a dark background so labels stay readable
const BG_PRESETS={light:null,white:'#ffffff',dark:'#2d333b',black:'#000000'};
function applyBg(){
  const c=new THREE.Color(OPTS.bg||bgDefault),hex='#'+c.getHexString();
  scene.background.set(c);if(renderer)renderer.setClearColor(c,1);host.style.background=hex;
  const lum=0.2126*c.r+0.7152*c.g+0.0722*c.b;host.classList.toggle('dark-bg',lum<0.35);
  document.querySelectorAll('#bg-presets button').forEach(b=>{const v=BG_PRESETS[b.dataset.bg];b.classList.toggle('on',(v||null)===(OPTS.bg||null)||(!!v&&OPTS.bg&&v===OPTS.bg.toLowerCase()));});
  $('bg-custom').value=hex;dirty=true;
}
document.querySelectorAll('#bg-presets button').forEach(b=>b.onclick=()=>{OPTS.bg=BG_PRESETS[b.dataset.bg];saveOpts();applyBg();});
$('bg-custom').oninput=e=>{OPTS.bg=e.target.value;saveOpts();applyBg();};
$('opt-edges').onchange=e=>setEdges(e.target.checked,true);
$('opt-large').checked=OPTS.large!==false;
$('opt-through').checked=OPTS.through!==false;
$('opt-through').onchange=e=>{OPTS.through=e.target.checked;saveOpts();pickMemo=null;edgeMemo=null;lastMove=lastMove||lastPointer;dirty=true;};
// Options: Fade other parts when the target is hidden (on by default, remembered); off ends a target fade now
$('opt-fade').checked=OPTS.fadeHidden!==false;
$('opt-fade').onchange=e=>{OPTS.fadeHidden=e.target.checked;saveOpts();if(!OPTS.fadeHidden)endTargetFocus();};
$('opt-large').onchange=e=>{OPTS.large=e.target.checked;saveOpts();largeNoted='';largeNote();if(R)R.onLargeMode?.();};
$('large-note-x').onclick=()=>{$('large-note').hidden=true;};

// ---- model, tree, visibility ----
const gltfLoader=new GLTFLoader(),stlLoader=new STLLoader(),plyLoader=new PLYLoader();
let modelRoot=null;                 // THREE.Group of module groups
let meshByNode=new Map();           // "<file index>:<node name>" -> Mesh
let meshList=[];
let tree=null;
const nodes=new Map();              // key -> {obj, leaf?, el, cb, path, count}
const vis=new Map();                // key -> bool (survives reloads, by tree path)
const openState=new Map();          // key -> bool
const modules=[];                   // {key, group, centroid}
const explodeParts=[];              // fitted overlays: independent meshes, with their assembled transforms
let topKeys=[];
const keyOf=path=>path.join(' > ');
const srgb=c=>c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);
const clipPlanes=[];
const planeZ=new THREE.Plane(new THREE.Vector3(0,0,-1),0),planeX=new THREE.Plane(new THREE.Vector3(-1,0,0),0);
const HL=new THREE.Color('#1f6feb');
const PALETTE=[0x7a9cc6,0xc6937a,0x8fb88f,0xb88fb0,0xc9b67a,0x7ab8b8,0xb87a7a,0x9a9ac9,0xa8b86f,0xb8a08f];
const groupOf=i=>M.groups.find(g=>g.files.includes(i));
const inMask=g=>!!(g&&mask&&(g.movable||g.second));

const seenMats=new WeakSet();
function prepMesh(m,glb){
  // one material per part: tints (selection, diff, scope) must not bleed into parts that shared a glTF material
  if(Array.isArray(m.material))m.material=m.material.map(x=>{if(seenMats.has(x))x=x.clone();seenMats.add(x);return x;});
  else{if(seenMats.has(m.material))m.material=m.material.clone();seenMats.add(m.material);}
  const mats=Array.isArray(m.material)?m.material:[m.material];
  for(const mat of mats){
    // the GLB writers this viewer is used with (trimesh, aad.review.glb) store sRGB values in the linear
    // factor: convert so the colours match the source
    if(glb)mat.color&&mat.color.convertSRGBToLinear();
    mat.side=THREE.DoubleSide;mat.clippingPlanes=clipPlanes;mat.clipShadows=true;
    mat.userData.emissive0=mat.emissive?mat.emissive.clone():null;
  }
  const col=m.geometry.attributes.color;
  if(glb&&col){
    const a=col.array,n=col.itemSize,norm=col.normalized,div=a instanceof Uint8Array?255:a instanceof Uint16Array?65535:1;
    const f=new Float32Array(a.length);
    for(let i=0;i<a.length;i++){const v=norm||div===1?a[i]/div:a[i];f[i]=(i%n)===3?v:srgb(v);}
    m.geometry.setAttribute('color',new THREE.BufferAttribute(f,n));
  }
}
// Optional engineering display profile. Manufacturing/export material colours stay unchanged.
function styleCadMesh(m){
  if(cadAppearance?.style!=='shaded-edges')return;
  const leaf=m.userData.leaf||{},n=leaf.component||'';
  if(m.userData.cadStyled===n)return;
  m.userData.cadStyled=n;
  const override=cadAppearance.colors?.[n]||(leaf.kind==='printed'?'#aebdcb':null);
  const mats=Array.isArray(m.material)?m.material:[m.material];
  for(const mat of mats){
    if(override){mat.color.set(override);mat.vertexColors=false;}
    if(mat.metalness!==undefined)mat.metalness=Math.min(mat.metalness,0.12);
    if(mat.roughness!==undefined)mat.roughness=0.72;
    mat.polygonOffset=true;mat.polygonOffsetFactor=1;mat.polygonOffsetUnits=1;mat.needsUpdate=true;
  }
  addEdges(m,cadAppearance.edgeAngles?.[n]??35);
}
// visible feature edges (EdgesGeometry, 35 deg crease by default) as a child of the mesh; the Edges display, the
// edge pick and edge pins all use these segments
function addEdges(m,angle=35){
  if(m.children.some(e=>e.userData.cadEdge))return;
  const geo=edgesGeometry(m,angle);if(!geo)return;              // a part still being prepared gets them on arrival
  const mats=Array.isArray(m.material)?m.material:[m.material];
  const clear=mats.every(x=>x.transparent&&x.opacity<0.5);
  const edges=new THREE.LineSegments(geo,new THREE.LineBasicMaterial({
    color:0x263747,transparent:true,opacity:clear?0.25:0.82,depthTest:true,depthWrite:false,clippingPlanes:clipPlanes}));
  edges.name='Visible feature edges';edges.userData.cadEdge=true;edges.visible=showEdges;
  edges.raycast=()=>{};m.add(edges);
}
// the crease edges of a part: the prepared segments when the background preparation made them at this angle (the same
// EdgesGeometry output), null while it is still working on the part, else built here
function edgesGeometry(m,angle){
  const P=prepOf.get(m.geometry);
  if(P&&P.angle===angle){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(P.edges,3));return g;}
  if(prepPending.has(m.geometry))return null;
  return new THREE.EdgesGeometry(m.geometry,angle);
}
const edgeAngleOf=m=>cadAppearance?.edgeAngles?.[m.userData.leaf?.component]??35;

// ---- part preparation. A model over PREP_SYNC_TRIS triangles is shown as soon as it is parsed; its parts' picking
// trees, crease edges and solid numbers are then built by a few background workers (prep_worker.js, largest parts
// first), and each part becomes pickable and gets its edges when its result arrives. A small strip in the viewport
// counts the parts still being prepared. A smaller model is prepared at once while loading, as before. Without
// module workers the parts are prepared one per task on this thread. ----
const PREP_SYNC_TRIS=60000;
const prepOf=new WeakMap();           // geometry -> {angle, edges, topo, grid, weld}
const prepPending=new WeakSet();      // geometries whose preparation has not arrived yet
let prepRun=null,prepPool=null,prepBroken=false,pickGen=0;
const edgeQ=[];                       // edges-only jobs (the Revisions hologram of a large model): {geometry, angle, resolve}
const PERF={raycasts:0,pickCalls:0,edgePicks:0,edgePickCalls:0,segTests:0,hovers:0,prepMs:0,prepParts:0,prepMode:null};
function prepStrip(){
  const el=$('prep');if(!el)return;const r=prepRun;
  if(!r||r.done>=r.total){el.hidden=true;return;}
  el.hidden=false;$('prep-t').textContent=`Preparing parts for picking and edges: ${r.done} of ${r.total} ready`;
  $('prep-bar').style.width=(100*r.done/Math.max(1,r.total)).toFixed(1)+'%';
}
function startPrep(list){
  if(prepRun)prepRun.cancelled=true;
  const byGeo=new Map();
  for(const m of list){const g=m.geometry;if(!prepPending.has(g))continue;let j=byGeo.get(g);if(!j)byGeo.set(g,j={geometry:g,meshes:[],angle:edgeAngleOf(m),tris:triCount(g)});j.meshes.push(m);}
  const jobs=[...byGeo.values()].sort((a,b)=>b.tris-a.tris);
  const run=prepRun={jobs,total:jobs.length,done:0,t0:performance.now(),cancelled:false,busy:0};
  PERF.prepParts=jobs.length;prepStrip();
  if(!jobs.length)return;
  ensurePool();
  PERF.prepMode=prepBroken?'main':'workers';
  if(prepBroken)prepMain(run);else for(const w of prepPool)prepNext(w);
}
function ensurePool(){
  if(prepBroken||prepPool)return;
  try{
    const n=Math.max(1,Math.min(4,(navigator.hardwareConcurrency||4)-1));
    prepPool=[];for(let i=0;i<n;i++){const w=new Worker(new URL('prep_worker.js',location.href),{type:'module'});w.job=null;prepPool.push(w);
      w.onmessage=e=>prepResult(w,e.data);w.onerror=e=>{e.preventDefault?.();prepFail(w,e.message||'worker failed');};}
  }catch(e){prepBroken=true;prepPool=null;}
}
// crease edges of any geometry (EdgesGeometry segments) built off this thread; resolves to the position array
function edgesAsync(geometry,angle=35){
  return new Promise(resolve=>{
    edgeQ.push({kind:'edges',geometry,angle,resolve});ensurePool();
    if(prepBroken)drainEdgesMain();else for(const w of prepPool)prepNext(w);
  });
}
function drainEdgesMain(){
  const j=edgeQ.shift();if(!j)return;
  j.resolve(new THREE.EdgesGeometry(j.geometry,j.angle).attributes.position.array);setTimeout(drainEdgesMain,0);
}
let prepJobId=0;
function prepNext(w){
  if(w.job)return;
  const run=prepRun,j=(run&&!run.cancelled?run.jobs.shift():null)||edgeQ.shift();
  if(!j){if(prepPool&&!prepPool.some(x=>x.job)){for(const x of prepPool)x.terminate();prepPool=null;}return;}   // idle: free them
  const edgesOnly=j.kind==='edges';
  if(!edgesOnly&&!prepPending.has(j.geometry))return prepNext(w);
  const g=j.geometry,pos=posArray(g.attributes.position).slice(),index=g.index?g.index.array.slice():null;
  w.job={...j,id:++prepJobId,run:edgesOnly?null:run};
  w.postMessage({id:w.job.id,pos,index,angle:j.angle,edgesOnly},[pos.buffer,...(index?[index.buffer]:[])]);
}
function prepFail(w,why){
  console.warn('part preparation worker:',why);
  const j=w.job;w.job=null;prepBroken=true;
  const back=x=>{if(x.kind==='edges')edgeQ.unshift(x);else if(!x.run.cancelled)x.run.jobs.unshift(x);};
  if(prepPool){for(const x of prepPool){if(x.job&&x!==w)back(x.job);x.job=null;x.terminate();}prepPool=null;}
  if(j)back(j);
  PERF.prepMode='main';if(prepRun&&!prepRun.cancelled)prepMain(prepRun);drainEdgesMain();
}
function prepResult(w,r){
  const j=w.job;if(!j||r.id!==j.id)return;
  if(!r.ok){prepFail(w,r.error);return;}
  w.job=null;
  if(j.kind==='edges'){j.resolve(r.edges);prepNext(w);return;}
  if(!j.run.cancelled&&prepPending.has(j.geometry)){
    const g=j.geometry;
    g.boundsTree=MeshBVH.deserialize({version:1,roots:r.roots,index:r.index,indirectBuffer:null},g,{setIndex:true});
    solidCache.set(g,asSolid(r.solid));
    prepOf.set(g,{angle:j.angle,edges:r.edges,topo:r.topo,grid:r.grid,weld:r.weld});
    prepArrived(j);
  }
  prepNext(w);
}
// without workers: one part per task, so the page still draws and answers between parts
function prepMain(run){
  const step=()=>{
    if(run.cancelled)return;const j=run.jobs.shift();if(!j)return;
    const g=j.geometry;
    if(prepPending.has(g)){
      if(!g.boundsTree)g.computeBoundsTree();
      prepPending.delete(g);
      const e=new THREE.EdgesGeometry(g,j.angle).attributes.position.array;
      prepOf.set(g,{angle:j.angle,edges:e,topo:null,grid:null,weld:null});
      prepArrived(j);
    }
    setTimeout(step,0);
  };
  setTimeout(step,0);
}
function prepArrived(j){
  const g=j.geometry;prepPending.delete(g);pickGen++;j.run.done++;
  if(j.run.done>=j.run.total)PERF.prepMs=Math.round(performance.now()-j.run.t0);
  const want=showEdges||cadAppearance?.style==='shaded-edges';
  for(const m of j.meshes)if(m.parent&&want)addEdges(m,edgeAngleOf(m));
  prepStrip();dirty=true;
}
const triCount=g=>g.index?g.index.count/3:g.attributes.position.count/3;
// Large model mode (Options, on by default; applies over LARGE_TRIS triangles): the Revisions hologram draws crease
// edges built in the background and leaves out the curved-surface silhouettes, whose per-view update walks every
// smooth edge of the old model. A one-line notice says so once per model and can be dismissed.
const LARGE_TRIS=2500000;let modelTris=0,largeNoted='';
const largeMode=()=>OPTS.large!==false&&modelTris>LARGE_TRIS;
function largeNote(){
  const el=$('large-note');if(!el)return;const on=largeMode()&&!!R,key=String(modelTris);
  if(!on){el.hidden=true;return;}
  if(largeNoted===key)return;largeNoted=key;
  $('large-note-t').textContent=`Large model, ${(modelTris/1e6).toFixed(1)} M triangles: the Revisions hologram shows crease edges only, no silhouettes. Options turns this off.`;
  el.hidden=false;
}

// Edges on by default for CAD looks (shaded-edges views, review workspaces), off for scans; Options can override
const edgesWanted=()=>OPTS.edges??(cadAppearance?.style==='shaded-edges'||(!!M?.review?.enabled&&!headMode));
function setEdges(v,persist){
  showEdges=!!v;if(persist){OPTS.edges=showEdges;saveOpts();}
  for(const m of meshList){if(showEdges)addEdges(m,cadAppearance?.edgeAngles?.[m.userData.leaf?.component]??35);for(const e of m.children)if(e.userData.cadEdge)e.visible=showEdges;}
  const b=$('edges');if(b){b.classList.toggle('on',showEdges);b.setAttribute('aria-pressed',String(showEdges));}
  $('opt-edges').checked=showEdges;dirty=true;
}
function meshMaterial(f,geo){
  const g=groupOf(f.i);
  if(f.color){
    const opacity=inMask(g)?+$('op').value:1;
    // Matte CAD display colours lift dark prints enough to reveal their geometry.
    // The manifest retains the actual filament colour.
    const color=new THREE.Color(f.color);
    if(Math.max(color.r,color.g,color.b)<0.04)color.set('#7b8490');
    const material=new THREE.MeshStandardMaterial({color,roughness:1,metalness:0,transparent:opacity<1,opacity,depthWrite:opacity>=1});
    material.userData.printColor=f.color;
    return material;
  }
  if(inMask(g)&&headMode){
    const opacity=+$('op').value;
    return new THREE.MeshStandardMaterial({color:0x8b949e,roughness:0.6,metalness:0.1,transparent:opacity<1,opacity,depthWrite:opacity>=1});
  }
  if(geo.hasAttribute('color'))return new THREE.MeshStandardMaterial({vertexColors:true,roughness:0.85,metalness:0});
  const opaque=!inMask(g)||+$('op').value>=1;
  return new THREE.MeshStandardMaterial({color:PALETTE[f.i%PALETTE.length],roughness:0.6,metalness:0.1,transparent:!opaque,opacity:opaque?1:+$('op').value});
}
const leafKey=n=>(n.file??M.first_glb??0)+':'+n.node;

function assemble(){
  closeComponentMenu();
  // module > sub-assembly > (Fasteners > joint >) parts, as THREE groups so visibility and explode are per node
  resetExplode();
  if(modelRoot){scene.remove(modelRoot);}
  modelRoot=new THREE.Group();modelRoot.name='model';scene.add(modelRoot);
  if(mask){mask.clear();modelRoot.add(mask);}
  nodes.clear();modules.length=0;topKeys=[];
  const used=new Set();
  function build(n,path,parent,depth){
    const p=path.concat([n.name]);let k=keyOf(p);
    for(let i=2;nodes.has(k);i++)k=keyOf(p)+' #'+i;          // duplicate sibling names stay separate
    if(!n.children){
      const lk=leafKey(n),m=meshByNode.get(lk);if(!m)return [];
      used.add(lk);m.userData.key=k;m.userData.leaf=n;
      if(depth===0){const g=new THREE.Group();g.name=n.name;g.userData.key=k;g.add(m);parent.add(g);nodes.set(k,{obj:g,leaf:n,path:p,count:1,leaves:[k]});topKeys.push(k);}
      else{parent.add(m);nodes.set(k,{obj:m,leaf:n,path:p,leaves:[k]});}
      return [k];
    }
    const g=new THREE.Group();g.name=n.name;g.userData.key=k;parent.add(g);
    const rec={obj:g,path:p,count:0,depth,leaves:[]};nodes.set(k,rec);if(depth===0)topKeys.push(k);
    for(const ch of n.children)for(const l of build(ch,p,g,depth+1))rec.leaves.push(l);
    rec.count=rec.leaves.length;return rec.leaves;
  }
  const mods=(tree&&tree.modules)||[];
  for(const mod of mods){
    const g=mod.group!=null?M.groups.find(x=>x.name===mod.group):null;
    const k0=topKeys.length;build(mod,[],inMask(g)?mask:modelRoot,0);
    if(g&&g.second&&topKeys.length>k0){                                                     // --second starts hidden
      const r=nodes.get(topKeys[k0]);if(!vis.has(topKeys[k0])&&!r.leaves.some(l=>vis.has(l)))for(const l of r.leaves)vis.set(l,false);
    }
  }
  const rest=[...meshByNode.keys()].filter(n=>!used.has(n));
  if(rest.length)build({name:'Other',children:rest.map(n=>({name:n.slice(n.indexOf(':')+1),node:n.slice(n.indexOf(':')+1),file:+n.slice(0,n.indexOf(':')),component:n,path:['Other',n]}))},[],modelRoot,0);
  // visibility lives on leaves only: an older branch-level flag (from a reload) becomes its leaves' flags
  for(const [k,v] of [...vis]){const r=nodes.get(k);if(r&&!r.leaf){vis.delete(k);if(v===false)for(const l of r.leaves)vis.set(l,false);}}
  modelRoot.updateMatrixWorld(true);
  for(const k of topKeys){
    const g=nodes.get(k).obj,b=new THREE.Box3().setFromObject(g);
    const c=b.isEmpty()?new THREE.Vector3():b.getCenter(new THREE.Vector3()).applyMatrix4(g.parent.matrixWorld.clone().invert());
    modules.push({key:k,group:g,centroid:c});
  }
  explodeParts.length=0;
  if(headMode)for(const m of meshList){
    if(!inMask(groupOf(m.userData.file)))continue;
    m.geometry.computeBoundingBox();m.updateMatrix();
    const centroid=m.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(m.matrix);
    explodeParts.push({mesh:m,position:m.position.clone(),centroid});
  }
  for(const m of meshList){styleCadMesh(m);if(showEdges)addEdges(m);}
  buildTreeDom();applyVisibility();applyExplode();
}

function buildTreeDom(){
  const root=$('tree');const st=root.scrollTop;root.innerHTML='';
  function row(k,rec,parentEl,isMod){
    const d=document.createElement('div');d.className='node'+(isMod?' mod':'');
    const line=document.createElement('div');line.className='line';
    line.addEventListener('contextmenu',e=>{e.preventDefault();openComponentMenu(k,e.clientX,e.clientY);});
    const kids=rec.leaf?null:rec.obj.children;
    if(kids&&kids.length){
      const open=openState.get(k)??false;if(!open)d.classList.add('closed');
      const c=document.createElement('button');c.className='caret';c.textContent=open?'▾':'▸';
      c.onclick=()=>{const o=d.classList.toggle('closed');openState.set(k,!o);c.textContent=o?'▸':'▾';};
      line.append(c);
    }else{const s=document.createElement('span');s.className='spacer';line.append(s);}
    const cb=document.createElement('input');cb.type='checkbox';
    cb.onchange=()=>{for(const l of rec.leaves)viewHidden.delete(l);setVis(k,cb.checked);commit();};
    const nm=document.createElement('span');nm.className='nm';nm.textContent=rec.leaf?rec.leaf.name:rec.obj.name;nm.title=keyOf(rec.path);
    nm.onclick=()=>{select(k,false);commit();};nm.ondblclick=()=>{select(k,false);focusKey(k);};
    line.append(cb,nm);
    rec.cnt=null;rec.soloEl=null;
    if(!rec.leaf){const n=document.createElement('span');n.className='cnt';n.textContent=rec.count;line.append(n);rec.cnt=n;}
    if(isMod){const s=document.createElement('button');s.className='solo';s.textContent='solo';s.title='show only this module';s.onclick=()=>{solo(k);commit();};line.append(s);rec.soloEl=s;}
    d.append(line);rec.el=line;rec.cb=cb;parentEl.append(d);
    if(kids&&kids.length){
      const kd=document.createElement('div');kd.className='kids';d.append(kd);
      for(const ch of kids){const ck=ch.userData.key;const cr=nodes.get(ck);if(cr)row(ck,cr,kd,false);}
    }
  }
  for(const k of topKeys)row(k,nodes.get(k),root,true);
  root.scrollTop=st;
  renderTreeState();
}
// One source of truth for visibility: `vis` holds one flag per leaf (part). Every path that shows or hides parts
// (tree checkboxes, solo, show all, hide fasteners, view buttons, ?view= and the other URL params, undo/redo, reload)
// goes through setVis/applyVisibility, and the tree is rendered from `vis`: a branch is checked when all its parts
// show, unchecked when none do, indeterminate in between, and its count reads shown/total when partial.
const leafShown=l=>vis.get(l)??true;
function setVis(k,v,apply=true){const r=nodes.get(k);for(const l of (r?r.leaves:[k]))vis.set(l,v);if(apply)applyVisibility();}
function renderTreeState(){
  const shownMods=[];
  for(const [k,r] of nodes){
    let n=0;for(const l of r.leaves)if(leafShown(l))n++;
    const all=n===r.leaves.length;r.shown=n;
    if(r.cb){r.cb.checked=all;r.cb.indeterminate=!all&&n>0;}
    if(r.cnt){r.cnt.textContent=all?String(r.count):n+'/'+r.count;r.cnt.title=n+' of '+r.count+' parts shown';}
    if(r.el)r.el.classList.toggle('off',n===0);
  }
  for(const m of modules){const r=nodes.get(m.key);if(r&&r.shown>0)shownMods.push(m.key);}
  const soloKey=modules.length>1&&shownMods.length===1?shownMods[0]:null;
  for(const m of modules){const r=nodes.get(m.key);if(r&&r.soloEl)r.soloEl.classList.toggle('on',m.key===soloKey);}
}
function applyVisibility(){
  pickGen++;
  for(const [k,r] of nodes)r.obj.visible=r.leaf?leafShown(k):true;
  if(showSides)buildSides();
  renderTreeState();
  if(sel&&!sel.rec.leaves.some(leafShown))clearSel();
  camLabel();dirty=true;
}
function effVisible(o){for(;o;o=o.parent)if(!o.visible)return false;return true;}
function solo(k){for(const m of modules)setVis(m.key,m.key===k,false);applyVisibility();}
function hideFasteners(){for(const [k,r] of nodes)if(!r.leaf&&r.obj.name==='Fasteners')setVis(k,false,false);applyVisibility();}
$('showall').onclick=()=>{for(const [k,r] of nodes)if(r.leaf)vis.set(k,true);viewHidden.clear();applyVisibility();commit();};
$('hidefast').onclick=()=>{hideFasteners();commit();};
$('collapse').onclick=()=>{openState.clear();buildTreeDom();};

// ---- explode: fitted pieces move away from the fixed scan; other assemblies explode by module ----
let radius=300;const explodeO=new THREE.Vector3();
function resetExplode(){
  for(const p of explodeParts)p.mesh.position.copy(p.position);
  for(const m of modules)m.group.position.set(0,0,0);
}
function applyExplode(){
  pickGen++;
  const e=+$('explode').value;$('explodev').textContent=e.toFixed(2);
  resetExplode();
  if(headMode){
    modelRoot.updateMatrixWorld(true);
    const headBox=new THREE.Box3();
    for(const m of meshList)if(!inMask(groupOf(m.userData.file)))headBox.expandByObject(m);
    const origin=headBox.isEmpty()?explodeO:headBox.getCenter(new THREE.Vector3());
    for(const p of explodeParts){
      // Compute the outward direction in world space, then convert the displaced centre back to the
      // mesh's parent frame. Rotation, translation and nonuniform scale of the fitted mask still work.
      const c=p.centroid.clone().applyMatrix4(p.mesh.parent.matrixWorld),offset=c.clone().sub(origin);
      const d=offset.length()>1?offset.clone().normalize():new THREE.Vector3(0,0,1);
      c.addScaledVector(offset,1.5*e).addScaledVector(d,0.35*radius*e);
      const local=p.mesh.parent.worldToLocal(c).sub(p.centroid);
      if(e!==0)p.mesh.position.copy(p.position).add(local);
    }
  }else for(const m of modules){
    const c=m.centroid.clone().sub(explodeO),d=c.length()>1?c.clone().normalize():new THREE.Vector3(0,0,1);
    m.group.position.copy(c).multiplyScalar(1.5*e).addScaledVector(d,0.35*radius*e);
  }
  applyViewOffsets(VIEWS.find(v=>v.name===activeView));
  camLabel();dirty=true;
}
$('explode').addEventListener('input',applyExplode);
$('explode').addEventListener('change',()=>commit());

// ---- section planes (local clipping on every material) ----
let bbox=new THREE.Box3(new THREE.Vector3(-150,-150,-125),new THREE.Vector3(150,150,200));
function setRanges(){
  for(const [id,a] of [['clipZ','z'],['clipX','x']]){
    const s=$(id),lo=Math.floor(bbox.min[a])-1,hi=Math.ceil(bbox.max[a])+1,keep=s.dataset.init?+s.value:null;
    const def=a==='x'&&M.explode_origin==='origin'?0:Math.round((lo+hi)/2);
    s.min=lo;s.max=hi;s.value=keep??def;s.dataset.init=1;
  }
  applyClip();
}
function applyClip(){
  pickGen++;clipPlanes.length=0;
  for(const [id,p,n] of [['clipZ',planeZ,new THREE.Vector3(0,0,-1)],['clipX',planeX,new THREE.Vector3(-1,0,0)]]){
    const v=+$(id).value,flip=$(id+'flip').checked;$(id+'v').textContent=v+' mm';
    if(flip)p.set(n.clone().negate(),-v);else p.set(n,v);
    if($(id+'on').checked)clipPlanes.push(p);
  }
  for(const m of meshList)m.traverse(o=>{if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(x=>x.needsUpdate=true);});
  camLabel();dirty=true;
}
const CLIP_IDS=['clipZ','clipX','clipZon','clipXon','clipZflip','clipXflip'];
for(const id of CLIP_IDS){$(id).addEventListener('input',applyClip);$(id).addEventListener('change',()=>commit());}   // commit on release

// ---- picking: hover tooltip, click select, double-click focus ----
const ray=new THREE.Raycaster(),ndc=new THREE.Vector2();
// The hover tip, Pin and Measure all ask for the hit under the same pointer in the same frame: one raycast answers
// them all. The memo holds while the frame, the pointer, the camera and the pickable scene (visibility, section,
// explode, parts prepared) are unchanged.
let frameNo=0,pickMemo=null,edgeMemo=null;
function pickKey(ev){
  cam.updateMatrixWorld();
  return {x:ev.clientX,y:ev.clientY,f:frameNo,g:pickGen,c:cam,cv:camMode,m:cam.matrixWorld.elements.slice(),p0:cam.projectionMatrix.elements[0],p5:cam.projectionMatrix.elements[5]};
}
function sameKey(a,b){
  if(!a||a.x!==b.x||a.y!==b.y||a.f!==b.f||a.g!==b.g||a.c!==b.c||a.cv!==b.cv||a.p0!==b.p0||a.p5!==b.p5)return false;
  for(let i=0;i<16;i++)if(a.m[i]!==b.m[i])return false;return true;
}
// ---- see-through parts: a part whose material (after the viewer's own overrides, such as the review focus fade) is
// clear, opacity under CLEAR_OPACITY or any transmission, is see-through. It never hides a pin (review.js asks
// pickOpaque), and by default a click, hover, right-click or edge pick goes through it to the nearest opaque part behind
// (Options: Pick through clear parts, on by default). Holding Alt, or a spot with nothing opaque behind, takes the
// clear part itself; the hover tip names what a click takes and adds "(through <clear part>)". The tree and the
// right-click menu's "Pick the clear part in front" still reach the clear part. One raycast gives the ordered hits. ----
const CLEAR_OPACITY=0.6;
function seeThrough(m){
  const mats=Array.isArray(m.material)?m.material:[m.material];
  return mats.length>0&&mats.every(x=>x&&((x.transparent&&x.opacity<CLEAR_OPACITY)||(x.transmission||0)>0));
}
const throughWanted=ev=>OPTS.through!==false&&!(ev&&ev.altKey);
// the nearest visible hit under a pointer event (section planes respected; BVH-accelerated), or null. A part of a
// large model is pickable once its preparation has arrived (until then it would be a brute-force raycast). With a
// see-through part in front and an opaque one behind it, the opaque hit is returned (its `through` is the clear hit)
// unless Alt is held or Options turned picking through off.
function pickHit(ev){
  const r=pickHits(ev);if(!r.first)return null;
  if(r.opaque&&r.opaque!==r.first&&throughWanted(ev))return r.opaque;
  return r.first;
}
// the nearest opaque hit (see-through parts skipped), for the pin occlusion test
function pickOpaque(ev){return pickHits(ev).opaque;}
// what a hit picks through: the see-through hit in front of it, or null
const throughOf=h=>h&&h.through&&h.through!==h?h.through:null;
function pickHits(ev){
  PERF.pickCalls++;
  const key=pickKey(ev);if(pickMemo&&sameKey(pickMemo.key,key))return pickMemo.h;
  const h=pickHitsNow(ev);pickMemo={key,h};return h;
}
function pickHitNow(ev){const r=pickHitsNow(ev);return r.first&&r.opaque&&r.opaque!==r.first&&throughWanted(ev)?r.opaque:r.first;}
function pickHitsNow(ev){
  PERF.raycasts++;
  const r=canvas.getBoundingClientRect();
  let list=meshList.filter(m=>effVisible(m)&&!prepPending.has(m.geometry));
  if(fishOn()){
    const d=fishDir(ev);if(!d)return {first:null,opaque:null};ray.set(new THREE.Vector3(...camMode.eye),d);
    const obs=new Set();for(const o of observerObjs())o.traverse(m=>obs.add(m));list=list.filter(m=>!obs.has(m));
  }else{ndc.set(((ev.clientX-r.left)/r.width)*2-1,-((ev.clientY-r.top)/r.height)*2+1);ray.setFromCamera(ndc,cam);}
  // firstHitOnly: each part's nearest hit, still ordered over all parts (the clear part in front, then what is behind)
  ray.firstHitOnly=!clipPlanes.length;
  const hits=ray.intersectObjects(list,false);
  let first=null,opaque=null;
  for(const h of hits){
    if(!h.object.userData.key||!clipPlanes.every(p=>p.distanceToPoint(h.point)>=0))continue;
    if(!first)first=h;
    if(!seeThrough(h.object)){opaque=h;break;}
  }
  if(opaque&&first!==opaque)opaque.through=first;
  return {first,opaque};
}
const pick=ev=>{const h=pickHit(ev);return h?h.object:null;};
// everything a review pin or the footer needs about one hit: part key and tree path, world and part-local point and
// normal, the part's world bounding box
function pickInfo(h){
  if(!h)return null;const m=h.object,leaf=m.userData.leaf||{};m.updateMatrixWorld();
  const nl=(h.face?h.face.normal.clone():new THREE.Vector3(0,0,1)).normalize();
  const nw=nl.clone().transformDirection(m.matrixWorld).normalize();
  const local=m.worldToLocal(h.point.clone()),b=new THREE.Box3().setFromObject(m);
  const r3=(v,n=4)=>v.toArray().map(x=>+x.toFixed(n));
  return {part:partRef(m.userData.key),world:r3(h.point),local:r3(local),normal_local:r3(nl,5),normal_world:r3(nw,5),
    bbox:{min:r3(b.min,3),max:r3(b.max,3)},name:leaf.name||m.name,mesh:m};
}
function partRef(k){
  const r=nodes.get(k);if(!r)return null;const l=r.leaf||{};
  return {key:k,node:l.node??r.obj.name,component:l.component??null,file:l.file??(r.obj.userData.file??null),path:r.path.slice()};
}
let sel=null;
// one tint pass over every mesh: selection (blue) wins, then the review layers (diff status, scope lock, tour stop)
const tintColor=new THREE.Color();
function retint(){
  const selMeshes=new Set();
  if(sel)for(const l of sel.rec.leaves){const r=nodes.get(l);if(r)r.obj.traverse(m=>{if(m.isMesh)selMeshes.add(m);});}
  for(const m of meshList){
    const t=selMeshes.has(m)?{c:HL,i:0.55}:(R&&R.tintFor(m.userData.key));
    for(const x of (Array.isArray(m.material)?m.material:[m.material])){
      if(!x.emissive)continue;
      if(t){x.emissive.copy(t.c);x.emissiveIntensity=t.i;}else{x.emissive.copy(x.userData.emissive0||tintColor.set(0));x.emissiveIntensity=1;}
    }
  }
  dirty=true;
}
const HINT='Click to select. Right-click to isolate. Double-click to focus. Esc clears. Cmd/Ctrl+Z undoes.';
function clearSel(){if(sel){sel.rec.el&&sel.rec.el.classList.remove('sel');}sel=null;retint();
  $('selname').textContent=HINT;$('selpath').textContent='';$('pickinfo').textContent='';}
function select(k,reveal=true){
  const rec=nodes.get(k);if(!rec)return;clearSel();
  sel={key:k,rec,objs:[rec.obj]};retint();
  $('selname').textContent=rec.leaf?rec.leaf.name:rec.obj.name+' ('+rec.count+' parts)';
  $('selpath').textContent=keyOf(rec.path)+(rec.leaf&&rec.leaf.component&&rec.leaf.component!==rec.leaf.name?'   ['+rec.leaf.component+(rec.leaf.kind?', '+rec.leaf.kind:'')+']':'');
  if(reveal){
    for(let i=1;i<rec.path.length;i++){const pk=keyOf(rec.path.slice(0,i));openState.set(pk,true);
      const pr=nodes.get(pk);if(pr&&pr.el){const d=pr.el.parentElement;d.classList.remove('closed');const c=pr.el.querySelector('.caret');if(c)c.textContent='▾';}}
  }
  if(rec.el){rec.el.classList.add('sel');if(reveal)rec.el.scrollIntoView({block:'nearest'});}
}
function focusBox(b,animate=true){
  bakeOrbit();
  const c=b.getCenter(new THREE.Vector3()),r=Math.max(2,b.getBoundingSphere(new THREE.Sphere()).radius)*1.25;
  const dir=cam.position.clone().sub(camTarget()).normalize();
  const p=cam.isOrthographicCamera?c.clone().addScaledVector(dir,Math.max(2000,r*6)):c.clone().addScaledVector(dir,r/Math.tan(cam.fov*Math.PI/360));
  placeCam(p,c,cam.isOrthographicCamera?OB/r:null,animate&&!SOFT);
}
// fit a part or assembly as a target (the shared routine below: clearest view, fade when still hidden)
function focusKey(k,animate=true){if(fishOn()||!nodes.has(k))return null;return showTarget({keys:[k]},animate);}
// fly to a world point at the current zoom (pins)
function flyToPoint(p,animate=true){
  bakeOrbit();const t=new THREE.Vector3(...p),off=cam.position.clone().sub(camTarget());
  placeCam(t.clone().add(off),t,null,animate&&!SOFT);
}
// Opening a context menu is not a selection or history action. A right drag remains an orbit-control pan.
const componentMenu=$('component-menu');let contextKey=null,contextFocus=null,contextHit=null;
function closeComponentMenu(restoreFocus=false){
  if(componentMenu.hidden)return false;
  componentMenu.hidden=true;contextKey=null;contextHit=null;
  if(restoreFocus&&contextFocus?.isConnected)contextFocus.focus({preventScroll:true});
  contextFocus=null;return true;
}
// hit: the canvas pick under the right-click (part-local point for Pin this part and Measure from here), null from the tree
function openComponentMenu(k,x,y,hit=null){
  const r=nodes.get(k);if(!r)return;
  contextFocus=componentMenu.hidden?document.activeElement:contextFocus;contextKey=k;contextHit=hit;
  $('component-menu-name').textContent=r.leaf?r.leaf.name:r.obj.name;
  const lab=(id,t)=>{$(id).querySelector('span').textContent=t;};
  lab('isolate-component',r.leaf?'Isolate component':'Isolate assembly');
  const pk=parentKey(k);$('solo-group').hidden=!pk;if(pk)lab('solo-group','Solo group ('+nodes.get(pk).obj.name+')');
  $('fit-component').disabled=fishOn();
  $('pin-component').hidden=!R;$('measure-component').hidden=!R||!hit;
  const th=throughOf(hit);$('clear-component').hidden=!th;if(th)lab('clear-component','Pick the clear part in front: '+nameOf(th.object));
  const fu=R?R.followUpFor(k):null;$('followup-component').hidden=!fu;if(fu)lab('followup-component',`Add follow-up pin (to #${fu.n})`);
  $('scope-component').hidden=!R;if(R){const on=R.inScope(k);lab('scope-component',on?'Remove from scope lock':'Add to scope lock');$('scope-component').querySelector('i').className='ic '+(on?'i-lock-open':'i-lock');}
  componentMenu.hidden=false;
  componentMenu.style.left=Math.max(8,Math.min(x,innerWidth-componentMenu.offsetWidth-8))+'px';
  componentMenu.style.top=Math.max(8,Math.min(y,innerHeight-componentMenu.offsetHeight-8))+'px';
  $('tip').style.display='none';lastMove=null;$('select-component').focus({preventScroll:true});
}
// switch the menu to the see-through part the right-click went through (its own Select, Pin, Measure and the rest)
$('clear-component').onclick=()=>{const h=throughOf(contextHit),x=parseFloat(componentMenu.style.left)||0,y=parseFloat(componentMenu.style.top)||0;
  if(!h)return closeComponentMenu(true);const k=h.object.userData.key;openComponentMenu(k,x,y,h);};
$('scope-component').onclick=()=>{const k=contextKey;closeComponentMenu(true);if(R&&k)R.toggleScope(k);};
// the parent group of a part in the tree (its sub-assembly or module), if it has one
function parentKey(k){const r=nodes.get(k);if(!r||r.path.length<2)return null;const pk=keyOf(r.path.slice(0,-1));return nodes.has(pk)?pk:null;}
const menuAct=(id,fn)=>{$(id).onclick=()=>{const k=contextKey,h=contextHit;closeComponentMenu(true);if(k&&nodes.has(k))fn(k,h);};};
menuAct('hide-component',k=>{for(const l of nodes.get(k).leaves)viewHidden.delete(l);setVis(k,false);commit();});
menuAct('solo-group',k=>{const pk=parentKey(k);if(!pk)return;const keep=new Set(nodes.get(pk).leaves);
  for(const [l,n] of nodes)if(n.leaf)vis.set(l,keep.has(l));viewHidden.clear();applyVisibility();commit();});
menuAct('showall-component',()=>$('showall').onclick());
menuAct('fit-component',k=>camAction(()=>focusKey(k)));
// Select: the part the menu was opened on (one undo step). Pin: a pin at the right-clicked point, its floating card
// opened there (from the tree, with no point, a pin over the part's whole region)
menuAct('select-component',k=>{select(k);commit();});
menuAct('info-component',k=>{if(Wt)Wt.partInfo(k,parseFloat(componentMenu.style.left)||0,parseFloat(componentMenu.style.top)||0);});
menuAct('pin-component',(k,h)=>{if(R)R.pinPart(k,h&&h.object.userData.key===k?h:null);});
menuAct('measure-component',(k,h)=>{if(R&&h)R.measureFrom(h);});
menuAct('followup-component',(k,h)=>{if(R)R.followUpPart(k,h&&h.object.userData.key===k?h:null);});
menuAct('copy-component',async k=>{
  const r=nodes.get(k),l=r.leaf||{},name=l.component||l.node||r.obj.name,text=name+'\n'+keyOf(r.path);
  let done=false;try{await navigator.clipboard.writeText(text);done=true;}catch(e){
    try{const ta=document.createElement('textarea');ta.value=text;document.body.append(ta);ta.select();done=document.execCommand('copy');ta.remove();}catch(e2){}}
  lastCopied=text;showToast(done?'Copied <b>'+escHTML(name)+'</b> and its tree path.':'Could not reach the clipboard.',!done);
});
let lastCopied=null;
const escHTML=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function showToast(html,bad=false,ms=3500){const t=$('toast');t.innerHTML=html;t.className=bad?'bad':'';t.hidden=false;clearTimeout(showToast.t);showToast.t=setTimeout(()=>{t.hidden=true;},ms);}
$('isolate-component').onclick=()=>{
  const k=contextKey,r=nodes.get(k);closeComponentMenu(true);if(!r)return;
  const keep=new Set(r.leaves);
  for(const [l,n] of nodes)if(n.leaf)vis.set(l,keep.has(l));
  viewHidden.clear();applyVisibility();select(k);commit();
};
addEventListener('pointerdown',e=>{if(!componentMenu.contains(e.target))closeComponentMenu();},true);
addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!componentMenu.hidden){e.preventDefault();e.stopImmediatePropagation();closeComponentMenu(true);}
},true);
addEventListener('resize',()=>closeComponentMenu());
addEventListener('blur',()=>closeComponentMenu());
document.addEventListener('scroll',()=>closeComponentMenu(),true);
let down=null,hoverT=0,lastMove=null,lastPointer=null;
canvas.addEventListener('pointerdown',e=>{
  down={x:e.clientX,y:e.clientY,button:e.button,context:e.button===2||(e.button===0&&e.ctrlKey),moved:false};
  $('tip').style.display='none';
});
canvas.addEventListener('contextmenu',e=>{e.preventDefault();});
canvas.addEventListener('pointercancel',()=>{down=null;});
canvas.addEventListener('wheel',()=>{closeComponentMenu();$('tip').style.display='none';},{passive:true});
canvas.addEventListener('pointerup',e=>{
  const d=down;down=null;
  if(!d||d.moved||Math.hypot(e.clientX-d.x,e.clientY-d.y)>4||(tc&&tc.dragging))return;
  if(d.context){const h=pickHit(e);if(h)openComponentMenu(h.object.userData.key,e.clientX,e.clientY,h);return;}
  if(d.button!==0)return;
  const h=pickHit(e);
  const edge=R&&R.wantsEdges()?pickEdge(e,h):null;
  if(R&&R.onClick(e,h,edge))return;
  if(h){select(h.object.userData.key);showPick(pickInfo(h));}else clearSel();commit();
});
const f1=x=>(+x).toFixed(1);
const nameOf=m=>m.userData.leaf?m.userData.leaf.name:m.name;
function showPick(i){
  if(!i){$('pickinfo').textContent='';return;}
  const s=new THREE.Vector3().fromArray(i.bbox.max).sub(new THREE.Vector3().fromArray(i.bbox.min));
  $('pickinfo').textContent=`world ${i.world.map(f1).join(', ')}  local ${i.local.map(f1).join(', ')}  normal ${i.normal_world.map(x=>(+x).toFixed(2)).join(', ')}  box ${[s.x,s.y,s.z].map(f1).join(' x ')} mm`;
}
canvas.addEventListener('dblclick',e=>{const m=pick(e);if(m){select(m.userData.key);if(!fishOn())focusKey(m.userData.key);commit();}});
canvas.addEventListener('pointermove',e=>{lastMove=e;lastPointer=e;if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)>4)down.moved=true;});
canvas.addEventListener('pointerleave',()=>{lastMove=null;lastPointer=null;$('tip').style.display='none';});
// Alt pressed or released over the view: hover again at the same spot (the tip says what a click takes now)
for(const t of ['keydown','keyup'])addEventListener(t,e=>{
  if(!['Alt','Shift','Meta'].includes(e.key)||!lastPointer||e.repeat)return;
  const p=lastPointer,on=t==='keydown';
  lastPointer=lastMove={clientX:p.clientX,clientY:p.clientY,buttons:0,shiftKey:e.key==='Shift'?on:e.shiftKey,altKey:e.key==='Alt'?on:e.altKey,metaKey:e.key==='Meta'?on:e.metaKey};hoverT=0;
});
// at most one hover pick per 70 ms, none while the camera moves or a button is held (the last pointer position is
// kept, so the tip catches up once the view settles)
function hover(now){
  if(!componentMenu.hidden||!lastMove||now-hoverT<70||(down&&lastMove.buttons)||camMoving)return;hoverT=now;
  PERF.hovers++;
  const e=lastMove;lastMove=null;const h=pickHit(e),tip=$('tip');
  // Pin and Measure modes: a feature edge within a few pixels wins over the face behind it and is drawn whole
  const ed=R&&R.wantsEdges()?pickEdge(e,h):null;
  if((ed&&ed.chain)!==(hoverEdge&&hoverEdge.chain)){hoverEdge=ed;dirty=true;}else if(!ed&&hoverEdge){hoverEdge=null;dirty=true;}
  const m=ed?ed.mesh:h?h.object:null;
  if(!m){tip.style.display='none';canvas.style.cursor='';return;}
  const r=host.getBoundingClientRect(),nm=nameOf(m),th=throughOf(ed?ed.hit:h);
  tip.textContent=(ed?`Edge ${edgeLenText(ed.record.length_mm)} mm on ${nm}`:nm)+(th&&th.object!==m?` (through ${nameOf(th.object)})`:'');
  tip.style.display='block';canvas.style.cursor='pointer';
  // a long tip (a "through" name) flips to the left of the cursor rather than running off the view
  const tw=tip.offsetWidth,x=e.clientX-r.left;tip.style.left=Math.max(4,x+14+tw>r.width-4?x-14-tw:x+14)+'px';tip.style.top=(e.clientY-r.top+14)+'px';
}

// ---- feature-edge pick (mesh level): the segments of the Edges display. A pick is the segment nearest the cursor
// within EDGE_PX on screen, not hidden behind the face under the cursor and not clipped away; it grows into its
// chain, the run of connected segments that continues near-straight or smoothly curving and stops at a sharp
// corner (over EDGE_TURN_DEG between segments) or a junction (a vertex shared by three or more segments). ----
const EDGE_PX=8,EDGE_TURN_DEG=30,EDGE_COS=Math.cos(EDGE_TURN_DEG*D2R);
let hoverEdge=null;
const offEdges=new WeakMap(),edgeDataOf=new WeakMap();   // never in userData: mesh.clone() copies userData as JSON
function edgeData(m,force=false){
  let e=m.children.find(c=>c.userData.cadEdge);
  if(!e&&force){                            // Edges display off: the same segments, built off-scene (edge pin re-match)
    e=offEdges.get(m);                      // a WeakMap, not userData: mesh.clone() copies userData as JSON
    if(!e){const geo=edgesGeometry(m,edgeAngleOf(m))||new THREE.EdgesGeometry(m.geometry,edgeAngleOf(m));
      e=new THREE.LineSegments(geo);e.visible=false;offEdges.set(m,e);}
  }
  if(!e)return null;
  const had=edgeDataOf.get(e);if(had)return had;
  // welded vertex ids (0.1 micrometre grid, first-seen order), vertex -> segment lists and the segment grid: from the
  // background preparation when it made these segments, else built here
  const a=e.geometry.attributes.position.array,P=prepOf.get(m.geometry);
  const prepared=P&&P.edges===a&&P.topo;
  const topo=prepared?P.topo:edgeTopology(a),grid=prepared?P.grid:segGrid(a);
  const n=a.length/6;
  const d={a,n,vid:topo.vid,adj:csrMap({start:topo.adjStart,items:topo.adjItems}),grid,obj:e,chainOf:new Int32Array(n).fill(-1),chains:[]};edgeDataOf.set(e,d);return d;
}
function edgeChain(d,s0){
  if(d.chainOf[s0]>=0)return d.chains[d.chainOf[s0]];
  const P=i=>new THREE.Vector3(d.a[3*i],d.a[3*i+1],d.a[3*i+2]),used=new Set([s0]);
  const walk=(end)=>{                       // leave segment s0 through vertex index `end`
    const pts=[];let cur=s0;
    for(;;){
      const nb=d.adj.get(d.vid[end]).filter(x=>x!==cur);if(nb.length!==1)break;
      const nx=nb[0];if(used.has(nx))break;
      const other=end===2*cur?2*cur+1:2*cur,near=d.vid[2*nx]===d.vid[end]?2*nx:2*nx+1,far=near===2*nx?2*nx+1:2*nx;
      const d1=P(end).sub(P(other)).normalize(),d2=P(far).sub(P(near)).normalize();
      if(d1.dot(d2)<EDGE_COS)break;
      used.add(nx);pts.push(P(far));cur=nx;end=far;
    }
    return pts;
  };
  const fw=walk(2*s0+1),bw=walk(2*s0);
  const pts=[...bw.reverse(),P(2*s0),P(2*s0+1),...fw],ch={pts,segs:[...used],record:edgeRecord(pts)};
  const id=d.chains.push(ch)-1;for(const s of used)d.chainOf[s]=id;
  return ch;
}
// every feature-edge chain of a mesh, part-local (the chains the edge pick grows), whether or not Edges are shown
function featureChains(m){
  const d=edgeData(m,true);if(!d)return [];
  for(let s=0;s<d.n;s++)if(d.chainOf[s]<0)edgeChain(d,s);
  return d.chains;
}
// the pin's edge record, part-local mm: a simplified polyline (Douglas-Peucker, 0.02 mm, at most 256 points), the
// full length along the chain, its ends, the point halfway along it and the unit direction from start to end
function edgeRecord(pts){
  let L=0;const cum=[0];for(let i=1;i<pts.length;i++){L+=pts[i].distanceTo(pts[i-1]);cum.push(L);}
  let mid=pts[0].clone();for(let i=1;i<pts.length;i++)if(cum[i]>=L/2){const t=(L/2-cum[i-1])/Math.max(1e-12,cum[i]-cum[i-1]);mid=pts[i-1].clone().lerp(pts[i],t);break;}
  const dir=pts[pts.length-1].clone().sub(pts[0]);if(dir.lengthSq()<1e-12&&pts.length>1)dir.copy(pts[1]).sub(pts[0]);dir.normalize();
  const dp=(p,tol)=>{if(p.length<3)return p;let k=0,dm=0;const a=p[0],b=p[p.length-1],ab=b.clone().sub(a),l2=ab.lengthSq();
    for(let i=1;i<p.length-1;i++){const t=l2>0?Math.max(0,Math.min(1,p[i].clone().sub(a).dot(ab)/l2)):0;const dd=p[i].distanceTo(a.clone().addScaledVector(ab,t));if(dd>dm){dm=dd;k=i;}}
    return dm>tol?[...dp(p.slice(0,k+1),tol).slice(0,-1),...dp(p.slice(k),tol)]:[a,b];};
  let tol=0.02,simp=dp(pts,tol);while(simp.length>256){tol*=2;simp=dp(pts,tol);}
  const r3=v=>v.toArray().map(x=>+x.toFixed(4));
  return {points:simp.map(r3),length_mm:+L.toFixed(4),start:r3(pts[0]),end:r3(pts[pts.length-1]),midpoint:r3(mid),direction:r3(dir)};
}
const _ea=new THREE.Vector3(),_eb=new THREE.Vector3(),_ec=new THREE.Vector3(),_mvp=new THREE.Matrix4(),_vp=new THREE.Matrix4(),_es=new THREE.Sphere();
const _inv=new THREE.Matrix4(),_ro=new THREE.Vector3(),_rd=new THREE.Vector3(),_rf=new THREE.Vector3(),_rc=new THREE.Raycaster(),_rn=new THREE.Vector2(),gridScratch={gen:0};
let edgeLinear=false;                       // scripted checks compare the grid against the full scan
// The segments of mesh m that can be within EDGE_PX of the pointer: the segment grid's answer for the pointer ray
// with the pixel tolerance turned into part-local millimetres along it (grows with depth in perspective), or null
// (test them all) without a grid. The screen-space test below stays the judge, so the pick is the same as a full scan.
function edgeCandidates(m,d,px,py,W,H,lim=EDGE_PX){
  if(!d.grid||edgeLinear)return null;
  _rn.set(px/W*2-1,-(py/H)*2+1);_rc.setFromCamera(_rn,cam);
  _inv.copy(m.matrixWorld).invert();
  _ro.copy(_rc.ray.origin).applyMatrix4(_inv);_rd.copy(_rc.ray.origin).add(_rc.ray.direction).applyMatrix4(_inv).sub(_ro);
  const L=_rd.length();if(!(L>0))return null;_rd.divideScalar(L);
  const e=m.matrixWorld.elements,sMin=Math.min(Math.hypot(e[0],e[1],e[2]),Math.hypot(e[4],e[5],e[6]),Math.hypot(e[8],e[9],e[10]));
  if(!(sMin>0))return null;
  const k=1.05*lim/sMin;let k0,k1;
  if(cam.isOrthographicCamera){k0=k*(cam.top-cam.bottom)/(H*cam.zoom);k1=0;}
  else{const fwd=cam.getWorldDirection(_rf),c=k*2*Math.tan(cam.fov*D2R/2)/H;k0=0;k1=c*Math.max(0,_rc.ray.direction.dot(fwd))/L;}
  return gridQuery(d.grid,[_ro.x,_ro.y,_ro.z],[_rd.x,_rd.y,_rd.z],k0,k1,gridScratch);
}
// Precedence (Pin, Measure and the hover tip): the part comes from the pick-through face hit first. An edge may win
// over that face only when it is an edge of the same part, or lies in front of the face along the ray on an opaque
// part. Chains shorter than EDGE_MIN_MM or EDGE_MIN_PX on screen are skipped unless the pointer is within EDGE_NEAR_PX
// of them. Hysteresis: a fresh edge needs the pointer within EDGE_IN px, the edge taken last stays until EDGE_STAY px,
// so a 1 px move never flips between face and edge. Shift forces the face (a point pick), Cmd forces the nearest edge
// within EDGE_FORCE_PX (any visible part, still never one hidden behind the face).
const EDGE_IN=6,EDGE_STAY=10,EDGE_FORCE_PX=20,EDGE_MIN_MM=2,EDGE_MIN_PX=12,EDGE_NEAR_PX=3;
const forceFace=ev=>!!(ev&&ev.shiftKey),forceEdge=ev=>!!(ev&&ev.metaKey&&!ev.shiftKey);
let edgeHyst=null;                          // the last decision: {chain (null: the face), x, y}
function pickEdge(ev,hit){
  if(!showEdges||SOFT||fishOn()||forceFace(ev))return null;
  PERF.edgePickCalls++;
  const key=pickKey(ev);key.alt=throughWanted(ev);key.force=forceEdge(ev);
  if(edgeMemo&&edgeMemo.hit===hit&&edgeMemo.key.alt===key.alt&&edgeMemo.key.force===key.force&&sameKey(edgeMemo.key,key))return edgeMemo.r;
  const r=pickEdgeNow(ev,hit,true);edgeMemo={key,hit,r};return r;
}
const edgeLenText=mm=>(mm>=10?mm.toFixed(1):mm.toFixed(2));
function pickEdgeNow(ev,hit,hyst=false){
  PERF.edgePicks++;
  const r=canvas.getBoundingClientRect(),px=ev.clientX-r.left,py=ev.clientY-r.top,W=r.width,H=r.height;
  cam.updateMatrixWorld();_vp.multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse);
  const fwd=cam.getWorldDirection(new THREE.Vector3()),depth=p=>_ec.copy(p).sub(cam.position).dot(fwd);
  const hitDepth=hit?depth(hit.point):Infinity,tol=Math.max(0.3,0.004*radius),hitMesh=hit?hit.object:null;
  const force=forceEdge(ev),lim=force?EDGE_FORCE_PX:hyst?EDGE_STAY:EDGE_IN;
  const prev=hyst&&!force&&edgeHyst&&Math.hypot(px-edgeHyst.x,py-edgeHyst.y)<=24?edgeHyst.chain:null;
  // picking through clear parts: with an opaque face under the cursor, a see-through part's edges are not candidates
  const skipClear=throughWanted(ev)&&!!hit&&!seeThrough(hit.object);
  const pxPerMm=p=>cam.isOrthographicCamera?H*cam.zoom/(cam.top-cam.bottom):H/(2*Math.max(1e-6,depth(p))*Math.tan(cam.fov*D2R/2));
  let best=null,stay=null;
  for(const m of meshList){
    if(!effVisible(m)||(skipClear&&seeThrough(m)))continue;const d=edgeData(m);if(!d||!d.obj.visible)continue;
    const own=m===hitMesh;
    if(!force&&hitMesh&&!own&&seeThrough(m))continue;                       // another part's edge must be on an opaque part
    if(!m.geometry.boundingSphere)m.geometry.computeBoundingSphere();
    _es.copy(m.geometry.boundingSphere).applyMatrix4(m.matrixWorld);_ec.copy(_es.center).applyMatrix4(_vp);
    if(Math.hypot((_ec.x*0.5+0.5)*W-px,(0.5-_ec.y*0.5)*H-py)>_es.radius*pxPerMm(_es.center)+lim)continue;
    _mvp.multiplyMatrices(_vp,m.matrixWorld);const a=d.a;
    const cand=edgeCandidates(m,d,px,py,W,H,lim),N=cand?cand.length:d.n;PERF.segTests+=N;
    for(let ci=0;ci<N;ci++){const s=cand?cand[ci]:ci;
      _ea.set(a[6*s],a[6*s+1],a[6*s+2]).applyMatrix4(_mvp);_eb.set(a[6*s+3],a[6*s+4],a[6*s+5]).applyMatrix4(_mvp);
      if(_ea.z<-1||_ea.z>1||_eb.z<-1||_eb.z>1)continue;
      const ax=(_ea.x*0.5+0.5)*W,ay=(0.5-_ea.y*0.5)*H,bx=(_eb.x*0.5+0.5)*W,by=(0.5-_eb.y*0.5)*H,dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
      const t=l2>0?Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2)):0,dist=Math.hypot(ax+t*dx-px,ay+t*dy-py);
      if(dist>lim||(best&&dist>=best.d&&(!prev||(stay&&dist>=stay.d))))continue;
      const local=new THREE.Vector3(a[6*s],a[6*s+1],a[6*s+2]).lerp(new THREE.Vector3(a[6*s+3],a[6*s+4],a[6*s+5]),t);
      const world=local.clone().applyMatrix4(m.matrixWorld),dw=depth(world);
      if(dw>hitDepth+tol)continue;                                            // behind the face under the cursor
      if(!force&&hitMesh&&!own&&!(dw<hitDepth-tol))continue;                  // another part's edge: only in front of the face
      if(!clipPlanes.every(p=>p.distanceToPoint(world)>=-1e-6))continue;
      const ch=edgeChain(d,s);
      if(!force&&dist>EDGE_NEAR_PX&&(ch.record.length_mm<EDGE_MIN_MM||ch.record.length_mm*pxPerMm(world)<EDGE_MIN_PX))continue;   // a tiny chain
      const c={d:dist,mesh:m,seg:s,local,world,ch};
      if(prev&&ch===prev&&(!stay||dist<stay.d))stay=c;
      if(!best||dist<best.d)best=c;
    }
  }
  // hysteresis: the edge taken last stays while within EDGE_STAY; any other edge needs EDGE_IN
  let pick=force?best:stay||(best&&best.d<=EDGE_IN?best:null);
  if(hyst&&!force)edgeHyst={chain:pick?pick.ch:null,x:px,y:py};
  if(!pick)return null;
  const ch=pick.ch;
  return {mesh:pick.mesh,world:pick.world,local:pick.local,chain:ch,record:ch.record,px:pick.d,seg:pick.seg,forced:force,
    hit:{object:pick.mesh,point:pick.world,face:hit&&hit.object===pick.mesh?hit.face:null,through:hit&&hit.object===pick.mesh?throughOf(hit):null}};
}
// edges drawn over the view (screen-space SVG, so they read on every background): the hovered edge, open edge pins
// in their pin colour and the edge of the pin being edited; sendPacket draws the same lines into the screenshot
const SVGNS='http://www.w3.org/2000/svg';
function edgeOverlays(){
  const out=[];if(hoverEdge&&effVisible(hoverEdge.mesh))out.push({mesh:hoverEdge.mesh,pts:hoverEdge.chain.pts,cls:'hover'});
  if(R)for(const o of R.edgeOverlays())if(o.mesh&&effVisible(o.mesh))out.push(o);
  return out;
}
function edgeScreen(o,W,H){
  o.mesh.updateMatrixWorld();_mvp.multiplyMatrices(_vp.multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse),o.mesh.matrixWorld);
  const runs=[];let run=[];
  for(const p of o.pts){const v=(p.isVector3?_ea.copy(p):_ea.fromArray(p)).applyMatrix4(_mvp);
    if(v.z<-1||v.z>1){if(run.length>1)runs.push(run);run=[];continue;}run.push([(v.x*0.5+0.5)*W,(0.5-v.y*0.5)*H]);}
  if(run.length>1)runs.push(run);return runs;
}
function drawEdgeOverlay(){
  const g=$('edge-lines');if(!g)return;g.replaceChildren();if(fishOn())return;
  const W=host.clientWidth,H=host.clientHeight;cam.updateMatrixWorld();
  for(const o of edgeOverlays()){
    const mod=o.mod?' '+o.mod:'';
    for(const run of edgeScreen(o,W,H)){
      const pts=run.map(q=>q[0].toFixed(1)+','+q[1].toFixed(1)).join(' ');
      for(const c of ['edge-halo'+mod,'edge-line '+o.cls+mod]){const l=document.createElementNS(SVGNS,'polyline');l.setAttribute('points',pts);l.setAttribute('class',c);if(o.pin)l.dataset.pin=o.pin;g.append(l);}
    }
    if(o.label&&o.at){const q=edgeScreen({mesh:o.mesh,pts:[o.at,o.at]},W,H)[0];        // a short text at a part-local point
      if(q){const t=document.createElementNS(SVGNS,'text');t.setAttribute('x',(q[0][0]+8).toFixed(1));t.setAttribute('y',(q[0][1]-8).toFixed(1));
        t.setAttribute('class','edge-label'+mod);if(o.pin)t.dataset.pin=o.pin;t.textContent=o.label;g.append(t);}}
  }
}
// ---- review focus (the change tour): the parts a stop is about stay as they are and every other part fades to
// FOCUS_FADE opacity. It is a look, not a visibility change: no tree checkbox moves, nothing enters the undo history,
// and the original material values come back exactly when focus ends. The stop's parts get their crease edges drawn
// on top in the tour colour (the outline). Faded parts count as see-through, so picks reach the stop's parts. ----
const FOCUS_FADE=0.1,focusOrig=new Map();let focusKeys=null,focusLines=[],focusOwner=null,focusName='';
function focusMats(m){const out=Array.isArray(m.material)?[...m.material]:[m.material];for(const c of m.children)if(c.userData.cadEdge&&c.material)out.push(c.material);return out;}
// owner: 'tour' (the change tour drives it) or 'target' (a go-to-target action turned it on because the target was
// hidden; the "Focused on <name>" chip shows and Esc or the chip ends it)
function setFocus(keys,owner='tour',name=''){
  for(const [mat,o] of focusOrig){mat.opacity=o.opacity;mat.transparent=o.transparent;mat.depthWrite=o.depthWrite;mat.needsUpdate=true;}
  focusOrig.clear();
  for(const l of focusLines){l.removeFromParent();l.geometry.dispose();l.material.dispose();}focusLines=[];
  const leaves=new Set();for(const k of keys||[])for(const l of (nodes.get(k)?.leaves||[k]))leaves.add(l);
  focusKeys=leaves.size?leaves:null;focusOwner=focusKeys?owner:null;focusName=focusKeys?name:'';
  if(focusKeys)for(const m of meshList){
    if(focusKeys.has(m.userData.key)){
      const g=edgesGeometry(m,edgeAngleOf(m));if(!g)continue;
      const l=new THREE.LineSegments(g,new THREE.LineBasicMaterial({color:0xeab308,transparent:true,opacity:0.95,depthTest:false,depthWrite:false,clippingPlanes:clipPlanes}));
      l.name='Tour outline';l.userData.focusOutline=true;l.renderOrder=24;l.raycast=()=>{};m.add(l);focusLines.push(l);continue;
    }
    for(const mat of focusMats(m)){
      if(focusOrig.has(mat))continue;focusOrig.set(mat,{opacity:mat.opacity,transparent:mat.transparent,depthWrite:mat.depthWrite});
      mat.opacity=Math.min(mat.opacity,FOCUS_FADE);mat.transparent=true;mat.depthWrite=false;mat.needsUpdate=true;
    }
  }
  focusChip();pickMemo=null;edgeMemo=null;dirty=true;
}
const inFocus=k=>!focusKeys||focusKeys.has(k);
// the in-view chip while a target fade is on: "Focused on <name>. Show whole model" (click or Esc ends the fade)
function focusChip(){
  const c=$('focus-chip');if(!c)return;const on=focusOwner==='target';c.hidden=!on;
  if(on)$('focus-chip-name').textContent=focusName||'the target';
}
function endTargetFocus(){if(focusOwner!=='target')return false;setFocus(null);return true;}
$('focus-chip').onclick=()=>endTargetFocus();$('focus-chip').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();endTargetFocus();}};
// see-through as the part is drawn without the focus fade (what really hides what)
function clearUnfaded(m){
  const mats=Array.isArray(m.material)?m.material:[m.material];
  return mats.every(x=>{const o=focusOrig.get(x)||x;return (o.transparent&&o.opacity<CLEAR_OPACITY)||(x.transmission||0)>0;});
}
// ---- going to a target (Fit sel, double-click, a pin's fly to, a detector warning, a changed part in Revisions, a
// tour stop): one routine. The camera fits the target looking along the current direction; then a bounded sample
// (at most TARGET_SAMPLES points on the target, one ray each per direction tried, run once, never per frame) says
// what share of it is seen. Under half: the six axis views are tried and the clearest taken. Still under half: every
// other part fades (the focus look above) when Options "Fade other parts when the target is hidden" is on. Fit and
// Home never fade and end a target fade. ----
const TARGET_SAMPLES=48,TARGET_SCAN=40000;
const leavesOf=keys=>{const s=new Set();for(const k of keys||[])for(const l of (nodes.get(k)?.leaves||[k]))s.add(l);return s;};
// sample points of the target: vertices of its parts (inside `box` when given), spread evenly, plus `point`; at most
// TARGET_SCAN vertices are looked at over all parts (a large assembly takes every n-th part), clipped-away points
// never count
function targetSamples(leaves,box,point){
  let parts=meshList.filter(m=>leaves.has(m.userData.key)&&effVisible(m));const pts=[],v=new THREE.Vector3();
  if(parts.length>TARGET_SAMPLES){const st=parts.length/TARGET_SAMPLES;parts=Array.from({length:TARGET_SAMPLES},(_,i)=>parts[Math.floor(i*st)]);}
  scene.updateMatrixWorld();
  const kept=p=>clipPlanes.every(c=>c.distanceToPoint(p)>=0);
  if(point&&kept(point))pts.push(point.clone());
  const per=Math.max(1,Math.floor(TARGET_SAMPLES/Math.max(1,parts.length))),scan=Math.max(64,Math.floor(TARGET_SCAN/Math.max(1,parts.length)));
  for(const m of parts){
    const p=m.geometry.attributes.position,step=Math.max(1,Math.floor(p.count/scan)),got=[];
    for(let i=0;i<p.count;i+=step){v.fromBufferAttribute(p,i).applyMatrix4(m.matrixWorld);if((!box||box.containsPoint(v))&&kept(v))got.push(v.clone());}
    const st=Math.max(1,got.length/per);for(let j=0;j<got.length&&pts.length<TARGET_SAMPLES+1;j+=st)pts.push(got[Math.floor(j)]);
  }
  return pts;
}
// share of `pts` seen from the eye `eye`: a ray from the eye to each point; opaque parts that are not the target hide
// it (clear parts never do, section-removed hits never do, nothing behind the eye counts)
const _vc=new THREE.Raycaster();_vc.firstHitOnly=false;
function clearanceOf(pts,leaves,eye){
  if(!pts.length)return 0;
  const list=meshList.filter(m=>effVisible(m)&&!prepPending.has(m.geometry)),eps=Math.max(0.05,radius*1e-4),dv=new THREE.Vector3();
  let seen=0;PERF.targetRays=(PERF.targetRays||0)+pts.length;
  for(const q of pts){
    dv.copy(q).sub(eye);const L=dv.length();if(!(L>eps)){seen++;continue;}
    _vc.set(eye,dv.divideScalar(L));_vc.far=L-eps;
    let hidden=false;
    for(const h of _vc.intersectObjects(list,false)){
      if(leaves.has(h.object.userData.key)||clearUnfaded(h.object))continue;
      if(!clipPlanes.every(p=>p.distanceToPoint(h.point)>=0))continue;
      hidden=true;break;
    }
    if(!hidden)seen++;
  }
  return seen/pts.length;
}
// where the camera goes to frame a sphere (centre c, radius r) looking along -d
function eyeFor(c,r,d){return cam.isOrthographicCamera?c.clone().addScaledVector(d,Math.max(2000,r*6)):c.clone().addScaledVector(d,r/Math.tan(cam.fov*Math.PI/360));}
// share of sample points on the parts `keys` seen from the camera fitted to them looking along -dir (scripted checks)
function viewClearance(keys,dir){
  const L=leavesOf(keys),b=new THREE.Box3();for(const k of keys){const n=nodes.get(k);if(n)b.expandByObject(n.obj);}if(b.isEmpty())return 0;
  const c=b.getCenter(new THREE.Vector3()),r=Math.max(2,b.getBoundingSphere(new THREE.Sphere()).radius)*1.25;
  return clearanceOf(targetSamples(L,null,null),L,eyeFor(c,r,dir.clone().normalize()));
}
const AXES=[['+X',[1,0,0]],['-X',[-1,0,0]],['+Y',[0,1,0]],['-Y',[0,-1,0]],['+Z',[0,0,1]],['-Z',[0,0,-1]]];
// t: {keys, box (world Box3, default the parts' box), point (world Vector3) + radius (mm: frame that sphere), dir
// (preferred view direction, default the current one), name (for the chip), fade: 'auto' | 'never'}. The camera
// move is animated unless animate is false. Returns {dir, axis, seen, faded, samples} or null with nothing to frame.
function showTarget(t,animate=true){
  if(fishOn())return null;
  exitCamMode();
  const keys=(t.keys||[]).filter(k=>nodes.has(k)),leaves=leavesOf(keys);
  let c,r,box=null;
  if(t.point&&t.radius){c=t.point.clone();r=t.radius;box=new THREE.Box3().setFromCenterAndSize(c,new THREE.Vector3(1,1,1).multiplyScalar(2*r));}
  else{
    box=t.box?t.box.clone():new THREE.Box3();if(!t.box)for(const k of keys){const n=nodes.get(k);if(n)box.expandByObject(n.obj);}
    if(box.isEmpty())return null;
    c=box.getCenter(new THREE.Vector3());r=Math.max(2,box.getBoundingSphere(new THREE.Sphere()).radius)*1.25;
  }
  bakeOrbit();
  const t0=performance.now();
  let d=(t.dir?t.dir.clone():cam.position.clone().sub(camTarget())).normalize(),axis=null,seen=1;
  const pts=leaves.size?targetSamples(leaves,t.point||t.box?box.clone().expandByScalar(0.01*r+0.01):null,t.point||null):[];
  if(pts.length){
    seen=clearanceOf(pts,leaves,eyeFor(c,r,d));
    if(seen<0.5){
      let best=null;
      for(const [n,a] of AXES){const ad=new THREE.Vector3(...a),s=clearanceOf(pts,leaves,eyeFor(c,r,ad)),score=s+0.01*ad.dot(d);if(!best||score>best.score)best={n,ad,s,score};}
      if(best&&best.s>seen){d=best.ad;axis=best.n;seen=best.s;}
    }
  }
  if(axis){cam.up.set(0,0,1);if(Math.abs(d.z)>0.99)cam.up.set(0,1,0);}
  placeCam(eyeFor(c,r,d),c,cam.isOrthographicCamera?OB/r:null,animate&&!SOFT);
  const fade=t.fade||'auto';let faded=false;
  if(fade==='auto'&&seen<0.5&&OPTS.fadeHidden!==false&&keys.length){setFocus(keys,'target',t.name||nameOfKey(keys[0]));faded=true;}
  else endTargetFocus();
  lastTarget={dir:d.toArray(),axis,seen:+seen.toFixed(3),faded,samples:pts.length,r:+r.toFixed(3),ms:+(performance.now()-t0).toFixed(1)};
  return lastTarget;
}
let lastTarget=null;
const nameOfKey=k=>{const r=nodes.get(k);return r?(r.leaf?r.leaf.name:r.obj.name):k;};
// the tour's fit: the same routine, the fade is the tour's own (setFocus with its stop's parts)
function fitParts(keys,dir=null,animate=true){return showTarget({keys,dir,fade:'never'},animate);}
// ---- undo / redo: one history of committed state (visibility, section, explode, selection, camera buttons,
// projection, movable group pose). Orbit drags are not in it; a camera snapshot is only restored when the step
// being undone or redone was itself a camera action. ----
const hist=[];let hp=-1,ready=false,restoring=false;
const HMAX=200;
// the camera where it is going: transitions in flight are recorded at their end values
function snapCam(){return {proj:cam===ortho?'o':'p',p:controls.getPosition(new THREE.Vector3(),true).toArray(),t:camTarget(new THREE.Vector3(),true).toArray(),u:cam.up.toArray(),
  z:cam.isOrthographicCamera?(controls._zoomEnd??cam.zoom):cam.zoom,v:activeView,
  cv:camMode?camMode.name:null,pb:projBefore===ortho?'o':projBefore===persp?'p':null};}
function snapshot(){
  return {vis:[...vis].sort(),vh:[...viewHidden].sort(),
    clip:CLIP_IDS.map(id=>{const e=$(id);return e.type==='checkbox'?e.checked:+e.value;}),
    ex:+$('explode').value,grid:showGrid,sel:sel?sel.key:null,cam:snapCam(),
    mask:mask?{p:mask.position.toArray(),q:mask.quaternion.toArray(),s:mask.scale.toArray()}:null,
    rv:R?R.snapshot():null,sides:showSides};
}
const PARTS=['vis','clip','ex','grid','sel','cam','mask','rv','sides'];
const J=JSON.stringify,partOf=(s,k)=>k==='vis'?J([s.vis,s.vh]):J(s[k]);
function pushHist(){
  const n=snapshot();
  if(hp>=0&&PARTS.every(k=>partOf(hist[hp],k)===partOf(n,k)))return false;
  hist.length=hp+1;hist.push(n);if(hist.length>HMAX)hist.shift();hp=hist.length-1;updUndo();return true;
}
// a committed change: the current entry first takes the live camera (orbits since then are not steps), then the
// new state is pushed. Camera actions call camAction, which records the camera before it moves.
function commit(){
  if(!ready||restoring)return;
  if(hp>=0)hist[hp].cam=snapCam();
  if(pushHist()&&mask&&partOf(hist[hp],'mask')!==(hp>0?partOf(hist[hp-1],'mask'):null))poseChanged();
}
function camAction(fn){
  if(ready&&!restoring&&hp>=0)hist[hp].cam=snapCam();
  fn();
  if(!ready||restoring)return;
  pushHist();
}
function restoreCam(c){
  const cv=c.cv&&VIEWS.find(v=>v.name===c.cv);
  camMode=cv||null;persp.fov=FOV;persp.updateProjectionMatrix();
  projBefore=cv?(c.pb==='o'?ortho:persp):null;camUI();
  const C=c.proj==='o'?ortho:persp;useCam(C);
  C.zoom=c.z;C.up.fromArray(c.u||[0,0,1]);C.updateProjectionMatrix();placeCam(new THREE.Vector3().fromArray(c.p),new THREE.Vector3().fromArray(c.t),c.z);
  markView(c.v);
}
function applyHist(i){
  closeComponentMenu();
  if(i<0||i>=hist.length||i===hp)return;
  const cur=hist[hp],t=hist[i];restoring=true;
  try{
    if(partOf(cur,'vis')!==partOf(t,'vis')){vis.clear();for(const [k,v] of t.vis)vis.set(k,v);viewHidden.clear();for(const k of t.vh)viewHidden.add(k);applyVisibility();}
    if(partOf(cur,'clip')!==partOf(t,'clip')){CLIP_IDS.forEach((id,j)=>{const e=$(id);if(e.type==='checkbox')e.checked=t.clip[j];else e.value=t.clip[j];});applyClip();}
    if(cur.ex!==t.ex){$('explode').value=t.ex;applyExplode();}
    if(cur.grid!==t.grid)setGridVisible(t.grid);
    if(partOf(cur,'cam')!==partOf(t,'cam'))restoreCam(t.cam);
    if(mask&&partOf(cur,'mask')!==partOf(t,'mask')){mask.position.fromArray(t.mask.p);mask.quaternion.fromArray(t.mask.q);mask.scale.fromArray(t.mask.s);showPose();poseChanged();}
    if(cur.sel!==t.sel||(t.sel&&!sel)){if(t.sel&&nodes.has(t.sel))select(t.sel);else clearSel();}
    if(R&&partOf(cur,'rv')!==partOf(t,'rv'))R.restore(t.rv);
    if(cur.sides!==t.sides)setSides(t.sides);
  }finally{restoring=false;}
  hp=i;updUndo();dirty=true;
}
const undo=()=>applyHist(hp-1),redo=()=>applyHist(hp+1);
function updUndo(){$('undo').disabled=hp<=0;$('redo').disabled=hp>=hist.length-1;
  $('undo').title='Undo (Cmd/Ctrl+Z), '+Math.max(0,hp)+' step'+(hp===1?'':'s');$('redo').title='Redo (Shift+Cmd/Ctrl+Z or Ctrl+Y), '+(hist.length-1-hp)+' step'+(hist.length-1-hp===1?'':'s');}
$('undo').onclick=undo;$('redo').onclick=redo;
const typing=t=>!!t&&((t.tagName==='INPUT'&&t.type!=='checkbox'&&t.type!=='range'&&document.activeElement===t)||t.tagName==='TEXTAREA'||t.isContentEditable);
addEventListener('keydown',e=>{
  if(!(e.metaKey||e.ctrlKey)||e.altKey||typing(e.target))return;
  const k=e.key.toLowerCase();if(k==='z'){e.preventDefault();e.shiftKey?redo():undo();}
  else if(k==='y'&&e.ctrlKey){e.preventDefault();redo();}
});
addEventListener('keydown',e=>{
  if(e.metaKey||e.ctrlKey||e.altKey||typing(e.target))return;
  if(e.key==='Escape'&&endTargetFocus()){e.preventDefault();return;}
  if(R&&R.onKey(e))return;
  if(e.key==='Escape'){
    if(camMode){camAction(()=>{const v=VIEWS.find(x=>x.name===viewBefore&&x.kind!=='camera');if(v)applyView(v);else fitAll();});return;}
    if(sel){clearSel();commit();}return;
  }
  if((e.key==='f'||e.key==='F')&&sel)return camAction(fitSelection);
  if((e.key==='h'||e.key==='H')&&(e.shiftKey||!R)&&!mask)return camAction(goHome);   // Shift+H (H alone toggles pins when review is on)
  if(mask)maskKey(e);
});

// ---- movable group ----
const fmt=(v,n)=>(+v.toFixed(n)).toString();
const F={px:['position','x',2],py:['position','y',2],pz:['position','z',2],rx:['rotation','x',2],ry:['rotation','y',2],rz:['rotation','z',2],sx:['scale','x',4],sy:['scale','y',4],sz:['scale','z',4]};
const lockOn=()=>$('lock').checked;
let lastScale=new THREE.Vector3(1,1,1);
function showPose(){
  if(!mask)return;
  for(const[id,[k,a,n]]of Object.entries(F)){
    const el=$(id);if(document.activeElement===el)continue;
    el.value=fmt(k==='rotation'?mask.rotation[a]*R2D:mask[k][a],n);
  }
  lastScale.copy(mask.scale);
  const dp=mask.position.clone().sub(loadedPose.p);
  const dq=loadedPose.q.clone().invert().multiply(mask.quaternion);
  const ang=2*Math.acos(Math.min(1,Math.abs(dq.w)))*R2D;
  const ds=mask.scale.clone().divide(loadedPose.s);
  $('delta').textContent=`moved ${[dp.x,dp.y,dp.z].map(v=>fmt(v,1)).join(', ')} mm (|${fmt(dp.length(),1)}|), turned ${fmt(ang,1)} deg, scale x${fmt(ds.x,3)}`;
  if(headMode&&explodeParts.length)applyExplode();
  dirty=true;
}
let saveTimer=null,saving=Promise.resolve();
function poseJSON(){
  mask.updateMatrix();
  const m=mask.matrix.elements.slice();
  const rows=[0,1,2,3].map(r=>[0,1,2,3].map(c=>m[c*4+r]));
  const head=M.files.find(f=>!inMask(groupOf(f.i)));
  return {overlay:M.movable,pieces:maskPieces(),head:headMode&&head?head.name:null,matrix:m,matrix_rows:rows,
    position_mm:mask.position.toArray(),rotation_deg:[mask.rotation.x,mask.rotation.y,mask.rotation.z].map(v=>v*R2D),rotation_order:'XYZ',
    scale:mask.scale.toArray(),frame:'mm, Z up, model frame of the loaded files',saved_at:new Date().toISOString()};
}
const maskPieces=()=>{const g=M.groups.find(x=>x.movable);return g?g.files.map(i=>M.files[i].name):[];};
async function save(){
  clearTimeout(saveTimer);saveTimer=null;
  $('posestat').textContent='saving...';
  saving=saving.then(async()=>{
    try{
      const r=await fetch('/pose',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(poseJSON())});
      const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);
      $('posestat').textContent='saved '+new Date().toLocaleTimeString([],{hour12:false});$('saved').textContent=j.saved;
    }catch(e){$('posestat').textContent='save failed: '+e.message;console.warn(e);}
  });
  return saving;
}
function poseChanged(){clearTimeout(saveTimer);saveTimer=setTimeout(save,500);}
function setMode(m){tc.setMode(m);[['mT','translate'],['mR','rotate'],['mS','scale']].forEach(([id,mm])=>$(id).classList.toggle('on',mm===m));dirty=true;}
function toggleSpace(){tc.setSpace(tc.space==='local'?'world':'local');$('mSp').textContent=tc.space;dirty=true;}
function maskKey(e){
  const step=e.shiftKey?5:1,k=e.key,kl=k.toLowerCase();
  if(k==='Shift'){tc.setTranslationSnap(5);tc.setRotationSnap(5*D2R);tc.setScaleSnap(0.01);return;}
  if(kl==='w')return setMode('translate');if(kl==='e')return setMode('rotate');if(kl==='r')return setMode('scale');
  if(kl==='x')return toggleSpace();
  let moved=true;cam.updateMatrixWorld();
  const right=new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld,0),up=new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld,1);
  if(k==='ArrowLeft')mask.position.addScaledVector(right,-step);
  else if(k==='ArrowRight')mask.position.addScaledVector(right,step);
  else if(k==='ArrowUp')mask.position.addScaledVector(up,step);
  else if(k==='ArrowDown')mask.position.addScaledVector(up,-step);
  else if(k==='PageUp')mask.position.z+=step;
  else if(k==='PageDown')mask.position.z-=step;
  else if(k==='['||k==='{')mask.rotation.x-=D2R;
  else if(k===']'||k==='}')mask.rotation.x+=D2R;
  else moved=false;
  if(moved){e.preventDefault();showPose();commit();}
}
addEventListener('keyup',e=>{if(e.key==='Shift'&&tc){tc.setTranslationSnap(null);tc.setRotationSnap(null);tc.setScaleSnap(null);}});
function setupMask(){
  mask=new THREE.Group();mask.name=M.movable;
  tc=new TransformControls(cam,canvas);
  tc.addEventListener('dragging-changed',e=>{controls.enabled=!e.value;if(!e.value){showPose();commit();}});
  tc.addEventListener('objectChange',()=>{if(lockOn()&&tc.getMode()==='scale'){const s=mask.scale,d=[s.x-lastScale.x,s.y-lastScale.y,s.z-lastScale.z].map(Math.abs);mask.scale.setScalar([s.x,s.y,s.z][d.indexOf(Math.max(...d))]);}showPose();});
  tc.addEventListener('change',()=>{dirty=true;pickGen++;});
  scene.add(tc.getHelper());            // three r169+: TransformControls is a Controls; its gizmo is the helper
  for(const[id,[k,a]]of Object.entries(F)){
    $(id).addEventListener('change',e=>{
      const v=parseFloat(e.target.value);if(!isFinite(v))return showPose();
      if(k==='rotation')mask.rotation[a]=v*D2R;else if(k==='scale'&&lockOn())mask.scale.setScalar(v);else mask[k][a]=v;
      e.target.blur();showPose();commit();
    });
  }
  $('lock').onchange=()=>{if(lockOn()){mask.scale.setScalar(mask.scale.x);showPose();commit();}};
  $('mT').onclick=()=>setMode('translate');$('mR').onclick=()=>setMode('rotate');$('mS').onclick=()=>setMode('scale');$('mSp').onclick=toggleSpace;
  $('reset').onclick=()=>{mask.position.copy(loadedPose.p);mask.quaternion.copy(loadedPose.q);mask.scale.copy(loadedPose.s);showPose();commit();};
  $('resume').onclick=()=>{applySaved();commit();};
  $('save').onclick=save;
  $('op').oninput=e=>{const o=+e.target.value;$('opv').textContent=o.toFixed(2);
    for(const m of meshList){if(!inMask(groupOf(m.userData.file)))continue;const x=m.material;x.opacity=o;x.transparent=o<1;x.depthWrite=o>=1;x.needsUpdate=true;}dirty=true;};
  $('mname').textContent=M.movable;$('maskbox').hidden=false;
  fetch('/pose-info').then(r=>r.json()).then(j=>{if(!$('saved').textContent)$('saved').textContent='saves to '+j.save_to;}).catch(()=>{});
}
function applySaved(){if(!savedPose)return;savedPose.decompose(mask.position,mask.quaternion,mask.scale);mask.rotation.setFromQuaternion(mask.quaternion);showPose();}
async function initMask(){
  tc.attach(mask);
  const n=maskPieces().length;$('mcount').textContent='('+n+' piece'+(n===1?'':'s')+')';
  $('opv').textContent=(+$('op').value).toFixed(2);
  try{
    const sp=await (await fetch('/pose')).json(),names=maskPieces();
    if(Array.isArray(sp.matrix)&&sp.matrix.length===16&&sp.matrix.every(Number.isFinite)&&Array.isArray(sp.pieces)&&sp.pieces.length===names.length&&sp.pieces.every((x,i)=>x===names[i])){
      savedPose=new THREE.Matrix4().fromArray(sp.matrix);$('resume').disabled=false;
      $('saved').textContent='resumed pose saved '+(sp.saved_at||'(unknown time)');applySaved();
    }
  }catch(e){console.warn(e);}
  showPose();
}

// ---- loading and live reload ----
let loadedSig=null,loadedMtime=null,loadedTree=null,status=null,busy=false,retryTimer=null;
const hhmmss=t=>new Date(t*1000).toLocaleTimeString([],{hour12:false});
function showStatus(flash){
  const s=status,el=$('status');if(!s)return;
  const pending=s.checks_mtime!=null&&s.mtime!=null&&s.checks_mtime<s.mtime-1;
  let txt=(s.build_ok==null&&s.checks_mtime==null?'updated ':'rebuilt ')+hhmmss(loadedMtime??s.mtime);
  let cls='';
  if(pending){txt+=', checks pending';cls='pending';}
  else if(s.build_ok===true){txt+=', build ok';cls='ok';}
  else if(s.build_ok===false){txt+=', build FAILED';cls='bad';}
  if(!pending&&s.interference_pairs!=null)txt+=', '+s.interference_pairs+' interference'+(s.interference_pairs===1?'':'s');
  if(!pending&&s.design_violations!=null)txt+=', '+s.design_violations+' design violation'+(s.design_violations===1?'':'s');
  // compact form for a narrow toolbar: the build verdict alone (the time and counts stay in the tooltip)
  const short=pending?'checks pending':s.build_ok===true?'build ok':s.build_ok===false?'build failed':txt.replace(/^(updated|rebuilt) /,'');
  const files=(s.files||[]).map(f=>f.name).join(', ')||s.glb||'';
  el.dataset.full=txt;el.dataset.short=short;el.textContent=txt;el.className=cls;el.title=txt+(files?'\n'+files:'');fitBrandSoon();
  if(flash){el.classList.add('flash');setTimeout(()=>el.classList.remove('flash'),900);}
}
async function fetchTree(){tree=await (await fetch('/tree.json?ts='+Date.now())).json();}
async function loadFile(f,fs){
  const r=await fetch(f.url+'?v='+fs.mtime);if(!r.ok)throw new Error(f.name+' '+r.status);
  const buf=await r.arrayBuffer();if(fs.size&&buf.byteLength!==fs.size)throw new Error('size changed');
  const out=[];
  if(f.ext==='.glb'){
    const gltf=await gltfLoader.parseAsync(buf,'');const json=gltf.parser.json;
    gltf.scene.traverse(o=>{
      if(!o.isMesh)return;const a=gltf.parser.associations.get(o);
      let nm=(a&&a.nodes!==undefined&&json.nodes[a.nodes]&&json.nodes[a.nodes].name)||o.userData.name||o.name;
      if(!a||a.nodes===undefined){const pa=gltf.parser.associations.get(o.parent);if(pa&&pa.nodes!==undefined)nm=json.nodes[pa.nodes].name||nm;}
      o.updateWorldMatrix(true,false);
      o.matrix.copy(o.matrixWorld);o.matrix.decompose(o.position,o.quaternion,o.scale);
      prepMesh(o,true);out.push([nm,o]);
    });
  }else{
    const geo=(f.ext==='.ply'?plyLoader:stlLoader).parse(buf);
    if(!geo.hasAttribute('normal')||f.ext==='.stl')geo.computeVertexNormals();
    const m=new THREE.Mesh(geo,meshMaterial(f,geo));m.name=f.name;prepMesh(m,false);out.push([f.name,m]);
  }
  for(const [,m] of out)m.userData.file=f.i;
  return out;
}
async function loadModel(s){
  // a file may still be mid-write: incomplete GLB header length or a short read -> retry in 1 s
  if(!s.complete)throw new Error('file incomplete');
  M=await (await fetch('/models.json?ts='+Date.now())).json();
  const next=new Map(),list=[];
  for(const f of M.files){
    const fs=(s.files||[]).find(x=>x.i===f.i)||{};
    for(const [nm,m] of await loadFile(f,fs)){let k=f.i+':'+nm;for(let j=2;next.has(k);j++)k=f.i+':'+nm+' #'+j;next.set(k,m);list.push(m);}
  }
  await fetchTree();
  const old=meshList;const selKey=sel&&sel.key;clearSel();
  meshByNode=next;meshList=list;
  // picking trees and edges: at once for a small model, in the background for a large one (startPrep below)
  // A GLB writer may store one index accessor for parts with the same topology (identical fasteners, tread links), and
  // GLTFLoader then hands those geometries one shared index attribute. Building a picking tree reorders a geometry's
  // index in place, so a shared one would be reordered again for every other part on it, leaving the earlier trees
  // pointing at the wrong triangles (missed and wrong picks). Each geometry gets its own index first.
  const idxOwner=new Map();
  for(const m of list){const g=m.geometry,ix=g.index;if(!ix)continue;const o=idxOwner.get(ix);if(!o)idxOwner.set(ix,g);else if(o!==g)g.setIndex(ix.clone());}
  let tris=0;for(const m of list)tris+=triCount(m.geometry);
  const bg=!SOFT&&tris>PREP_SYNC_TRIS;modelTris=tris;
  if(!SOFT)for(const m of list)if(!m.geometry.boundsTree){if(bg)prepPending.add(m.geometry);else m.geometry.computeBoundsTree();}
  if(!bg){PERF.prepMode=SOFT?null:'sync';PERF.prepParts=0;if(prepRun)prepRun.cancelled=true;prepRun=null;prepStrip();}
  pickGen++;
  for(const m of modules)m.group.position.set(0,0,0);
  assemble();
  for(const m of old)m.traverse(o=>{o.geometry?.boundsTree&&o.geometry.disposeBoundsTree();o.geometry?.dispose();if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(x=>x.dispose());});
  const b=new THREE.Box3();resetExplode();
  const mp=mask?[mask.position.clone(),mask.quaternion.clone(),mask.scale.clone()]:null;
  if(mask){mask.position.set(0,0,0);mask.quaternion.identity();mask.scale.set(1,1,1);}
  modelRoot.updateMatrixWorld(true);for(const m of list)b.expandByObject(m);
  if(mp){mask.position.copy(mp[0]);mask.quaternion.copy(mp[1]);mask.scale.copy(mp[2]);modelRoot.updateMatrixWorld(true);}
  if(!b.isEmpty()){bbox=b;radius=b.getBoundingSphere(new THREE.Sphere()).radius;}
  if(M.explode_origin!=='origin')b.getCenter(explodeO);else explodeO.set(0,0,0);
  const ext=Math.max(Math.abs(bbox.min.x),Math.abs(bbox.max.x),Math.abs(bbox.min.y),Math.abs(bbox.max.y));
  setGrid(Math.max(600,Math.ceil(2.4*ext/100)*100));
  applyExplode();
  setRanges();buildSides();
  if(fitted){VIEWS=fittedViews();renderViewButtons();}
  if(selKey&&nodes.has(selKey))select(selKey,false);
  const first=loadedSig===null;loadedSig=s.sig;loadedMtime=s.mtime;loadedTree=s.tree_mtime;
  if(R)await R.onModel(first);
  if(!Wt)Wt=initWeight(ctx());Wt.onModel();            // the Weight block and Part info card (weight.js)
  if(first){
    setViewerTitle(M.title||M.name);
    const v0=VIEWS.find(v=>v.name===(defaultView||(headMode?'front':'iso')));if(v0)applyView(v0);else fitAll();
    applyParams();
    restoreVersionCamera();
    if(mask)await initMask();
    ready=true;pushHist();
  }
  showStatus(!first);
  if(bg)startPrep(list);
  largeNote();
  log('info',(first?'ready':'reloaded')+' '+list.length+' meshes, '+Math.round(tris)+' triangles, '+modules.length+' modules, sig '+s.sig.slice(0,200));
}
// URL parameters for links and scripted checks: ?view=hub (?view=camera: the UC-261 fisheye lens view)&proj=persp&explode=0.5&clipz=60&clipx=0&hide=fasteners
// &solo=Rotor&select=<display name or component name>
function applyParams(){
  const q=new URLSearchParams(location.search),num=k=>q.has(k)&&isFinite(+q.get(k))?+q.get(k):null;
  if(q.get('proj')==='persp')setCam(persp);
  const v=VIEWS.find(x=>x.name===q.get('view'));if(v)applyView(v);
  if(num('explode')!==null){$('explode').value=num('explode');applyExplode();}
  if(q.has('grid'))setGridVisible(q.get('grid')!=='0');
  for(const [k,id] of [['clipz','clipZ'],['clipx','clipX']])if(num(k)!==null){$(id).value=num(k);$(id+'on').checked=true;}
  applyClip();
  if(q.get('hide')==='fasteners')hideFasteners();
  if(q.get('solo')){const m=modules.find(x=>x.group.name===q.get('solo'));if(m)solo(m.key);}
  if(q.get('select')){const w=q.get('select');for(const [k,r] of nodes)if(r.leaf&&(r.leaf.name===w||r.leaf.component===w)){select(k);break;}}
}
// what review.js may use of this page
function ctx(){return {THREE,CSS2DObject,scene,host,canvas,fetch,$,log,nodes,vis,leafShown,effVisible,
  get cam(){return cam;},get meshList(){return meshList;},get modelRoot(){return modelRoot;},get M(){return M;},get sel(){return sel;},
  get bbox(){return bbox;},get ready(){return ready;},get restoring(){return restoring;},
  setLeftAction:a=>{leftAction=a==='none'?ACT.NONE:ACT.ROTATE;mouseMap();},
  pickHit,pickOpaque,seeThrough,pickInfo,pickEdge,setFocus,inFocus,focusActive:()=>!!focusKeys,fitParts,showTarget,endTargetFocus,clipped:p=>clipPlanes.some(c=>c.distanceToPoint(p)<-1e-6),viewClearance,restoreCam,edgeScreen,featureChains,get loadedMtime(){return loadedMtime;},partRef,clipSig:()=>clipPlanes.map(p=>p.normal.toArray().join()+':'+p.constant.toFixed(3)).join('|'),select,leafKeys:k=>nodes.get(k)?.leaves||[],clearSel,focusKey,focusBox,flyToPoint,commit,camAction,snapCam,retint,
  dirty:()=>{dirty=true;},renderNow:()=>{if(!SOFT)renderNow();},soft:SOFT,
  camera:()=>{const c=snapCam();return {projection:c.proj==='o'?'ortho':'persp',position:c.p,target:c.t,up:c.u,zoom:c.z,view:c.v,fov:cam.isPerspectiveCamera?cam.fov:null};},
  hiddenKeys:()=>[...vis].filter(([,v])=>!v).map(([k])=>k),
  prepOf:g=>prepOf.get(g),posArray,largeMode,edgesAsync,
  // link the shader programs an object tree needs without blocking (parallel compile where the driver has it)
  compileAsync:o=>renderer?renderer.compileAsync(o,cam,scene).catch(()=>{}):Promise.resolve(),get moving(){return camMoving;},perf:PERF};}
// a small handle for scripted checks (CDP) and the console
window.viewer={get camera(){return cam;},controls,nodes,vis,modules,select,clearSel,undo,redo,commit,get cube(){return cube;},
  meshes:()=>meshList,toScreen:p=>{const r=canvas.getBoundingClientRect(),v=new THREE.Vector3(...p).project(cam);return [r.left+(v.x+1)/2*r.width,r.top+(1-v.y)/2*r.height];},
  get review(){return R;},panes:()=>({...paneWidths(),saved:{...pane}}),get weight(){return Wt;},get lastCopied(){return lastCopied;},
  edgeAt:(x,y,o={})=>{const e={clientX:x,clientY:y,shiftKey:!!o.shift,metaKey:!!o.meta};edgeLinear=!!o.linear;try{if(forceFace(e))return null;const ed=pickEdgeNow(e,pickHitNow(e));return ed?{key:ed.mesh.userData.key,length:ed.record.length_mm,points:ed.record.points.length,px:ed.px,seg:ed.seg}:null;}finally{edgeLinear=false;}},
  get perf(){const r=prepRun;return {...PERF,prepDone:r?r.done:0,prepTotal:r?r.total:0,frame:frameNo};},
  edgeChains:k=>{let m=null;nodes.get(k)?.obj.traverse(o=>{if(!m&&o.isMesh)m=o;});return m?featureChains(m).map(c=>c.record):[];},
  get hoverEdge(){return hoverEdge?{key:hoverEdge.mesh.userData.key,length:hoverEdge.record.length_mm}:null;},pickAt:(x,y,o={})=>{const h=pickHit({clientX:x,clientY:y,altKey:!!o.alt});const i=pickInfo(h);if(i){delete i.mesh;const t=throughOf(h);i.through=t?t.object.userData.key:null;}return i;},
  seeThrough:k=>{let m=null;nodes.get(k)?.obj.traverse(o=>{if(!m&&o.isMesh)m=o;});return m?seeThrough(m):null;},
  home:()=>camAction(goHome),fitSelection:()=>camAction(fitSelection),setSides:v=>{setSides(v);commit();},
  applyView:n=>camAction(()=>applyView(VIEWS.find(v=>v.name===n))),
  // camera view: the parts a lens ray at client (x, y) passes, nearest first, transparent ones marked
  lensHits:(x,y)=>{if(!fishOn())return null;const d=fishDir({clientX:x,clientY:y});if(!d)return [];ray.set(new THREE.Vector3(...camMode.eye),d);
    const obs=new Set();for(const o of observerObjs())o.traverse(m=>obs.add(m));
    return ray.intersectObjects(meshList.filter(m=>effVisible(m)&&!obs.has(m)),false).slice(0,6).map(h=>(h.object.userData.leaf?h.object.userData.leaf.component:h.object.name)+(h.object.material.transparent?' (clear)':'')+' @'+h.distance.toFixed(1));},
  state:()=>({ready,nav:OPTS.nav,background:'#'+scene.background.getHexString(),clearColor:renderer?'#'+renderer.getClearColor(new THREE.Color()).getHexString():null,appearance:cadAppearance?.style,edges:showEdges,version:M?.version,loadedMtime,soft:SOFT,meshes:meshList.length,cam:cam.position.toArray(),target:camTarget().toArray(),zoom:cam.zoom,up:cam.up.toArray(),screenUp:(cam.updateMatrixWorld(),new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld,1).toArray()),orbitMode:OPTS.orbit,pivotMode:OPTS.pivot,pickThrough:OPTS.through!==false,focus:focusKeys?{parts:focusKeys.size,faded:meshList.filter(m=>!focusKeys.has(m.userData.key)).length,outlines:focusLines.length,owner:focusOwner,name:focusName}:null,
    goTarget:lastTarget,focusChip:$('focus-chip')&&!$('focus-chip').hidden?$('focus-chip').textContent.replace(/\s+/g,' ').trim():null,fadeHidden:OPTS.fadeHidden!==false,
    pivot:pivotFor(null)?.toArray()||null,viewCentre:viewCentre()?.toArray()||null,pivotShown:pivotObj.visible,pivotAt:pivotObj.visible?pivotObj.position.toArray():null,
    hidden:[...vis].filter(([,v])=>!v).map(([k])=>k),clip:clipPlanes.map(p=>[p.normal.toArray(),p.constant]),
    explode:+$('explode').value,grid:showGrid,view:activeView,cameraView:camMode?camMode.name:null,fov:cam.isPerspectiveCamera?cam.fov:null,
    proj:cam===ortho?'ortho':'persp',projDisabled:$('proj').disabled,fisheye:fishOn(),fishRect:FISH.rect,camLabel:$('camnote').hidden?null:$('camnote-t').textContent,orbit:controls.enabled,selected:sel&&sel.key,renders,ctrlTrue,status:$('status').dataset.full||$('status').textContent,brandFit:$('brand').dataset.fit,
    history:hist.length,hp,undo:!$('undo').disabled,redo:!$('redo').disabled,
    mask:mask?{p:mask.position.toArray(),pieces:maskPieces()}:null,sides:showSides,cube:!!cube,cubeBox:cube?(()=>{const r=(cube._domElement||cube.domElement).getBoundingClientRect(),h=host.getBoundingClientRect();return {top:r.top-h.top,right:h.right-r.right,w:r.width,h:r.height};})():null,controls:'camera-controls 3.1.2',
    three:THREE.REVISION,bvh:meshList.filter(m=>m.geometry.boundsTree).length,prepPending:meshList.filter(m=>prepPending.has(m.geometry)).length,
    pixelRatio:renderer?renderer.getPixelRatio():null,largeMode:largeMode(),modelTris,largeNote:!$('large-note').hidden,review:R?R.state():null})};
async function poll(){
  if(busy)return;busy=true;clearTimeout(retryTimer);
  try{
    status=await (await fetch('/status.json?ts='+Date.now())).json();
    window.__viewerStale?.check(status);                // a stale server (index.html): new files on disk since it started
    if(status.sig!==loadedSig){
      try{await loadModel(status);}
      catch(e){if(loadedSig===null)$('status').textContent='loading... ('+e.message+', retrying)';console.warn('load',e.message);retryTimer=setTimeout(poll,1000);}
    }else if(status.tree_mtime!==loadedTree){
      loadedTree=status.tree_mtime;await fetchTree();const k=sel&&sel.key;assemble();if(k&&nodes.has(k))select(k,false);showStatus(true);
      if(R)await R.onModel(false);
    }else showStatus(false);
    if(R)R.onStatus(status);
  }catch(e){$('status').textContent='server not reachable';$('status').className='bad';}
  finally{busy=false;}
}
function setupVersions(){
  if(!M.versions?.length)return;
  $('versionbox').hidden=false;
  for(const v of M.versions){const o=document.createElement('option');o.value=v.id;o.textContent=v.label;$('version').append(o);}
  $('version').value=M.version;
  $('version-description').textContent=M.versions.find(v=>v.id===M.version)?.description||'';
  $('version').onchange=()=>{
    const id=$('version').value;
    try{sessionStorage.setItem('aad-version-camera',JSON.stringify({version:id,p:cam.position.toArray(),q:cam.quaternion.toArray(),up:cam.up.toArray(),target:camTarget().toArray(),zoom:cam.zoom,proj:cam===ortho?'ortho':'persp',view:activeView}));}catch(e){}
    const url=new URL('/v/'+encodeURIComponent(id)+'/',location.origin);
    url.searchParams.set('view',activeView||'iso');
    url.searchParams.set('proj',cam===ortho?'ortho':'persp');
    location.assign(url);
  };
}
function restoreVersionCamera(){
  if(!M.versions?.length)return;
  try{
    const saved=JSON.parse(sessionStorage.getItem('aad-version-camera')||'null');
    sessionStorage.removeItem('aad-version-camera');
    if(!saved||saved.version!==M.version)return;
    setCam(saved.proj==='persp'?persp:ortho);
    cam.zoom=saved.zoom;cam.updateProjectionMatrix();if(Array.isArray(saved.up))cam.up.fromArray(saved.up);
    placeCam(new THREE.Vector3().fromArray(saved.p),new THREE.Vector3().fromArray(saved.target),saved.zoom);
  }catch(e){}
}
(async()=>{
  try{M=await (await fetch('/models.json')).json();}catch(e){$('status').textContent='server not reachable';return;}
  setViewerTitle(M.title||M.name);
  setupVersions();
  if(M.movable){
    setupMask();headMode=M.files.some(f=>!inMask(groupOf(f.i)));
    // Coloured prints start opaque; the opacity slider still exposes the scan for fit inspection.
    const colored=M.files.some(f=>inMask(groupOf(f.i))&&f.color);
    $('op').value=headMode&&!colored?0.45:1;
  }
  if(M.review?.enabled)R=initReview(ctx());
  else{document.body.classList.add('no-panel');$('modes').hidden=true;}
  await loadViews();await poll();setInterval(poll,2000);
})();

// ---- software preview (no WebGL) ----
const lin2s=c=>c<=0.0031308?c*12.92:1.055*Math.pow(c,1/2.4)-0.055;
let sv=new Float32Array(0),sw=new Float32Array(0),zb=new Float32Array(0);const cd=new Float64Array(6);
function softRender(){
  const W=host.clientWidth,H=host.clientHeight;if(!W||!H)return;
  if(canvas.width!==W||canvas.height!==H){canvas.width=W;canvas.height=H;}
  const ctx=canvas.getContext('2d');ctx.fillStyle='#'+scene.background.getHexString();ctx.fillRect(0,0,W,H);
  scene.updateMatrixWorld();cam.updateMatrixWorld();
  const VP=new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse);
  const toS=(v)=>{const p=v.clone().applyMatrix4(VP);return [(p.x*0.5+0.5)*W,(0.5-p.y*0.5)*H,p.z];};
  // grid at Z 0 and the axes, behind the model
  ctx.lineWidth=1;const half=GRID.size/2,nc=Math.round(half/GRID.cell);
  for(let i=-nc;showGrid&&i<=nc;i++){
    ctx.strokeStyle=i===0?'#64748b':'#abb2bd';
    for(const [a,b] of [[[i*GRID.cell,-half,0],[i*GRID.cell,half,0]],[[-half,i*GRID.cell,0],[half,i*GRID.cell,0]]]){
      const A=toS(new THREE.Vector3(...a)),B=toS(new THREE.Vector3(...b));
      if(Math.abs(A[2])>1||Math.abs(B[2])>1)continue;ctx.beginPath();ctx.moveTo(A[0],A[1]);ctx.lineTo(B[0],B[1]);ctx.stroke();
    }
  }
  const img=ctx.getImageData(0,0,W,H),px=new Uint32Array(img.data.buffer);
  if(zb.length!==W*H)zb=new Float32Array(W*H);zb.fill(Infinity);
  const L=new THREE.Vector3(0.3,0.5,1).normalize().transformDirection(cam.matrixWorld);
  const camPos=cam.position,fwd=new THREE.Vector3(0,0,-1).transformDirection(cam.matrixWorld),ortho=cam.isOrthographicCamera;
  const Mx=new THREE.Matrix4(),order=meshList.filter(effVisible);
  order.sort((a,b)=>(a.material.transparent?1:0)-(b.material.transparent?1:0));
  for(const mesh of order){
    const g=mesh.geometry,pa=g.attributes.position,n=pa.count,mat=mesh.material,col=mat.vertexColors?g.attributes.color:null;
    if(sv.length<n*3){sv=new Float32Array(n*3);sw=new Float32Array(n*3);}
    Mx.multiplyMatrices(VP,mesh.matrixWorld);const m=Mx.elements,e=mesh.matrixWorld.elements;
    for(let i=0;i<n;i++){
      const x=pa.getX(i),y=pa.getY(i),z=pa.getZ(i);
      sw[i*3]=e[0]*x+e[4]*y+e[8]*z+e[12];sw[i*3+1]=e[1]*x+e[5]*y+e[9]*z+e[13];sw[i*3+2]=e[2]*x+e[6]*y+e[10]*z+e[14];
      const w=m[3]*x+m[7]*y+m[11]*z+m[15];
      if(w<=1e-6){sv[i*3+2]=NaN;continue;}
      sv[i*3]=((m[0]*x+m[4]*y+m[8]*z+m[12])/w*0.5+0.5)*W;sv[i*3+1]=(0.5-(m[1]*x+m[5]*y+m[9]*z+m[13])/w*0.5)*H;sv[i*3+2]=(m[2]*x+m[6]*y+m[10]*z+m[14])/w;
    }
    const em=mat.emissive&&mat.emissive.equals(HL)?0.35:0,op=mat.transparent?mat.opacity:1;
    const br=mat.color.r,bg=mat.color.g,bb=mat.color.b;
    const idx=g.index?g.index.array:null,tcn=idx?idx.length/3:n/3;
    for(let t=0;t<tcn;t++){
      const i0=idx?idx[t*3]:t*3,i1=idx?idx[t*3+1]:t*3+1,i2=idx?idx[t*3+2]:t*3+2;
      const z0=sv[i0*3+2],z1=sv[i1*3+2],z2=sv[i2*3+2];
      if(!(z0>=-1&&z0<=1&&z1>=-1&&z1<=1&&z2>=-1&&z2<=1))continue;
      const ax=sw[i0*3],ay=sw[i0*3+1],az=sw[i0*3+2],ux=sw[i1*3]-ax,uy=sw[i1*3+1]-ay,uz=sw[i1*3+2]-az,vx=sw[i2*3]-ax,vy=sw[i2*3+1]-ay,vz=sw[i2*3+2]-az;
      // clip planes: drop triangles fully outside, test per pixel (distances interpolated) where one crosses
      let cut=0,out=false;
      for(let q=0;q<clipPlanes.length;q++){
        const p=clipPlanes[q],nx_=p.normal.x,ny_=p.normal.y,nz_=p.normal.z,c_=p.constant;
        const d0=nx_*ax+ny_*ay+nz_*az+c_,d1=d0+nx_*ux+ny_*uy+nz_*uz,d2=d0+nx_*vx+ny_*vy+nz_*vz;
        if(d0<0&&d1<0&&d2<0){out=true;break;}
        if(d0<0||d1<0||d2<0){cd[cut*3]=d0;cd[cut*3+1]=d1;cd[cut*3+2]=d2;cut++;}
      }
      if(out)continue;
      let nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;const nl=Math.hypot(nx,ny,nz)||1;nx/=nl;ny/=nl;nz/=nl;
      const dx=ortho?-fwd.x:camPos.x-ax,dy=ortho?-fwd.y:camPos.y-ay,dz=ortho?-fwd.z:camPos.z-az;
      if(nx*dx+ny*dy+nz*dz<0){nx=-nx;ny=-ny;nz=-nz;}
      const sh=0.32+0.6*Math.max(0,nx*L.x+ny*L.y+nz*L.z)+0.12*(nz*0.5+0.5);
      let r=br,gg=bg,b=bb;if(col){r=col.getX(i0);gg=col.getY(i0);b=col.getZ(i0);}
      const R=Math.min(255,(lin2s(Math.min(1,r*sh))+em*0.12)*255)|0,G=Math.min(255,(lin2s(Math.min(1,gg*sh))+em*0.43)*255)|0,B=Math.min(255,(lin2s(Math.min(1,b*sh))+em*0.92)*255)|0;
      const x0=sv[i0*3],y0=sv[i0*3+1],x1=sv[i1*3],y1=sv[i1*3+1],x2=sv[i2*3],y2=sv[i2*3+1];
      const area=(x1-x0)*(y2-y0)-(x2-x0)*(y1-y0);if(Math.abs(area)<1e-12)continue;
      const minx=Math.max(0,Math.floor(Math.min(x0,x1,x2))),maxx=Math.min(W-1,Math.ceil(Math.max(x0,x1,x2)));
      const miny=Math.max(0,Math.floor(Math.min(y0,y1,y2))),maxy=Math.min(H-1,Math.ceil(Math.max(y0,y1,y2)));
      if(minx>maxx||miny>maxy)continue;
      const ia=1/area;
      for(let y=miny;y<=maxy;y++){
        const py=y+0.5;
        for(let x=minx;x<=maxx;x++){
          const qx=x+0.5;
          const w0=((x1-qx)*(y2-py)-(x2-qx)*(y1-py))*ia,w1=((x2-qx)*(y0-py)-(x0-qx)*(y2-py))*ia,w2=1-w0-w1;
          if(w0<0||w1<0||w2<0)continue;
          if(cut&&(w0*cd[0]+w1*cd[1]+w2*cd[2]<0||(cut>1&&w0*cd[3]+w1*cd[4]+w2*cd[5]<0)))continue;
          const z=w0*z0+w1*z1+w2*z2,k=y*W+x;
          if(z>=zb[k])continue;
          if(op<1){const o=px[k],a=op;px[k]=0xff000000|((((o>>16)&255)*(1-a)+B*a)<<16)|((((o>>8)&255)*(1-a)+G*a)<<8)|(((o&255)*(1-a)+R*a)|0);}
          else{zb[k]=z;px[k]=0xff000000|(B<<16)|(G<<8)|R;}
        }
      }
    }
  }
  ctx.putImageData(img,0,0);
  // corner triad
  const S=110,cx=S/2,cy=H-22-S/2,q=cam.quaternion.clone().invert();
  for(const [t,v,c] of [['X',[1,0,0],'#b42318'],['Y',[0,1,0],'#166534'],['Z',[0,0,1],'#1d4ed8']]){
    const d=new THREE.Vector3(...v).applyQuaternion(q);ctx.strokeStyle=c;ctx.fillStyle=c;ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+d.x*36,cy-d.y*36);ctx.stroke();ctx.font='bold 16px system-ui';ctx.fillText(t,cx+d.x*46-5,cy-d.y*46+6);
  }
  ctx.fillStyle='#374151';ctx.font='14px system-ui';ctx.fillText('software preview: this browser has no WebGL',W-330,H-10);
}

// ---- render loop (renders only when something changed) ----
let lastDirty=0,camMoving=false;
(function loop(now){
  requestAnimationFrame(loop);frameNo++;
  const t0=performance.now(),dt=Math.min(0.5,(t0-lastFrame)/1000);lastFrame=t0;
  let moving=!!camAnim;
  if(camAnim){camAnim.step(t0);dirty=true;}
  if(cube&&(cube.animating||cubeDrag)){dirty=true;moving=true;}else if(controls.update(dt)){dirty=true;moving=true;}
  if(cube&&!cube.animating&&!cubeDrag&&dirty){camTarget(cube.target);cube.cameraUpdate();}
  if(camMoved()){dirty=true;ctrlTrue++;moving=true;}
  camMoving=moving;
  hover(now||0);
  if(!dirty)return;
  if(SOFT){if(!lastDirty){lastDirty=now;return;}if(now-lastDirty<60)return;}   // the preview takes ~1 s: draw once settled
  dirty=false;lastDirty=0;renders++;
  if(SOFT){softRender();return;}
  renderNow();
})();
function renderNow(){
  if(fishOn()){fishRender();labels.domElement.hidden=true;return;}
  labels.domElement.hidden=false;
  renderer.setViewport(0,0,host.clientWidth,host.clientHeight);renderer.setScissorTest(false);
  renderer.clear();renderer.render(scene,cam);
  // corner triad, bottom left
  const S=110;renderer.clearDepth();renderer.setScissorTest(true);renderer.setScissor(0,22,S,S);renderer.setViewport(0,22,S,S);
  const d=cam.getWorldDirection(new THREE.Vector3()).negate();tCam.position.copy(d).multiplyScalar(4);tCam.up.copy(cam.up);tCam.lookAt(0,0,0);
  renderer.render(tScene,tCam);renderer.setScissorTest(false);
  renderer.setViewport(0,0,host.clientWidth,host.clientHeight);
  if(cube)cube.render();
  if(R)R.beforeLabels();
  labels.render(scene,cam);
  drawEdgeOverlay();
  if(R)R.afterRender();
}
