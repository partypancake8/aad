// review.js: the two-way review workspace of the aad viewer (pins, region pins, measure, scope lock, diff with
// collateral flags and a ghosted baseline, the agent's change tour, known issues, Send packet). State lives in the
// CAD project (<project>/.cadreview/, written through the server's /review/ routes) and in the page's one undo
// history: snapshot() and restore() cover pins, the scope lock, measurements and tour decisions.
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {GROUPS_FALLBACK,NO_UNCHANGED_BADGE,groupOf,groupFill,renderChipGroups,groupBadge,issuesHTML,keepBanner} from './pin_groups.js';
import {initRepin} from './repin.js';
import {initMeasure} from './measure.js';

const ISSUE_FALLBACK=['weird_geometry','incoherent_addition','collateral_damage','floating_unsupported','orientation_mirror',
  'fit_clearance','printability','holes_ports_blocked','fasteners_assembly','regression','belt_pulley','envelope_size',
  'intent_misread','other'];
const MODES={select:'',pin:'Pin: click a part to drop a numbered pin. Shift+click takes the face, Cmd+click the nearest edge. Esc leaves.',
  region:'Region: drag a box around the parts to pin together. Esc leaves.',
  measure:'Measure: click two edges, vertices or faces (Shift: the face, Cmd: the nearest edge). Esc cancels, Delete removes.',scope:'Scope: click the parts the next edit may change. Esc leaves.'};
const KEYS={v:'select',p:'pin',g:'region',m:'measure',s:'scope'};

export function initReview(V){
  const {THREE,CSS2DObject,$}=V;
  const C={changed:new THREE.Color('#f59e0b'),moved:new THREE.Color('#3b82f6'),added:new THREE.Color('#22c55e'),
    collateral:new THREE.Color('#ef4444'),scope:new THREE.Color('#22c55e'),tour:new THREE.Color('#eab308')};
  const S={pins:[],next:1,scope:[],meas:[],decisions:{}};        // the undoable review state
  let RP=null,groups=GROUPS_FALLBACK;                            // repin.js, the class groups (pin_groups.js)
  let server=null,classes=[],mode='select',diff=null,diffByNode=new Map(),tourIdx=-1,measA=null,lastPacket=null;
  let pinsUpdated=null,lastCam='',writing=Promise.resolve(),persisted={pins:'',scope:'',dec:''},dialogCtx=null,hotPin=null;
  const markers=new Map();                                        // pin id -> CSS2DObject
  // Pins show/hide (toolbar Pins, key H): view state only, remembered in this browser, never in pins.json or the undo
  // history. forceShow draws them anyway while Send packet renders its screenshot.
  let pinsShown=true,forceShow=false;
  try{pinsShown=localStorage.getItem('aad-pins-shown')!=='0';}catch(e){}
  const partHidden=new Map(),occluded=new Set(),cutAway=new Set(),_cw=new THREE.Vector3();
  const CUT_TITLE='cut away by the section';
  // Options: Dim pins behind geometry (on by default), remembered in this browser
  let dimOcc=true;try{dimOcc=localStorage.getItem('aad-dim-occluded')!=='0';}catch(e){}
  const OCC_TITLE='behind other geometry from this view';                  // pin id -> its part is hidden; pins behind geometry
  const measGroup=new THREE.Group();measGroup.name='Measurements';V.scene.add(measGroup);
  const ghost=new THREE.Group();ghost.name='Baseline ghost';ghost.visible=false;V.scene.add(ghost);
  let ghostKey=null;
  const J=JSON.stringify,clone=x=>JSON.parse(J(x)),now=()=>new Date().toISOString().replace(/\.\d+Z$/,'Z');
  const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const label=id=>(classes.find(c=>c.id===id)||{}).label||id;
  const toast=(html,bad=false,ms=6000)=>{const t=$('toast');t.innerHTML=html;t.className=bad?'bad':'';t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>{t.hidden=true;},ms);};

  // ---- server ----
  async function getJSON(u){const r=await V.fetch(u);const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j;}
  function post(u,body){
    const p=writing.then(async()=>{
      const r=await V.fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:J(body)});
      const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j;
    });
    writing=p.catch(e=>{toast('Review save failed: '+esc(e.message),true);console.warn('review save',e.message);});
    return p;
  }
  function persist(){
    const pj=J(S.pins),sj=J(S.scope),dj=J(S.decisions);
    if(pj!==persisted.pins){persisted.pins=pj;post('/review/pins',{pins:S.pins}).then(d=>{pinsUpdated=d.updated;refreshIssues();}).catch(()=>{});}
    if(sj!==persisted.scope){persisted.scope=sj;post('/review/scope',{parts:S.scope}).catch(()=>{});}
    if(dj!==persisted.dec&&server?.tour){persisted.dec=dj;post('/review/tour-decisions',{decisions:S.decisions}).catch(()=>{});}
  }
  async function loadState(adopt=true){
    server=await getJSON('/review/state.json');
    classes=server.issue_classes?.length?server.issue_classes:ISSUE_FALLBACK.map(id=>({id,label:id}));
    if(server.issue_groups?.length)groups=server.issue_groups;
    if(adopt){
      S.pins=server.pins.pins;S.next=server.pins.next;S.scope=server.scope.parts;S.decisions=server.tour?.decisions||{};
      persisted={pins:J(S.pins),scope:J(S.scope),dec:J(S.decisions)};pinsUpdated=server.pins.updated||null;
    }
    fillClasses();renderBaselines();renderIssues();
  }
  async function refreshIssues(){try{const s=await getJSON('/review/state.json');server.issues=s.issues;server.baselines=s.baselines;renderIssues();renderBaselines();}catch(e){}}

  // ---- parts ----
  const nodeKey=()=>{const m=new Map();for(const [k,r] of V.nodes)if(r.leaf&&!m.has(r.leaf.node))m.set(r.leaf.node,k);return m;};
  function meshOf(key){const r=V.nodes.get(key);if(!r)return null;if(r.obj.isMesh)return r.obj;let m=null;r.obj.traverse(o=>{if(!m&&o.isMesh)m=o;});return m;}
  function keyFor(ref){if(ref.key&&V.nodes.has(ref.key))return ref.key;return nodeKey().get(ref.node)||null;}
  function boxOf(keys){const b=new THREE.Box3();for(const k of keys){const r=V.nodes.get(k);if(r)b.expandByObject(r.obj);}return b;}
  const inScope=k=>S.scope.some(p=>p.key===k);

  // ---- modes ----
  let followParent=null;                                          // pin id the next pin follows up (Add follow-up pin)
  function setMode(m,keepFollow=false){
    if(!MODES.hasOwnProperty(m))m='select';
    mode=m;measA=null;clearMeasDraft();if(!keepFollow)followParent=null;RP?.onMode(m);measModeChanged();
    if(m==='pin'||m==='region')showPins();                        // a pin is never dropped or picked invisibly
    document.querySelectorAll('#modes button').forEach(b=>b.classList.toggle('on',b.dataset.mode===m));
    const fp=followParent&&S.pins.find(p=>p.id===followParent);
    $('modehint').hidden=!MODES[m];$('modehint').textContent=fp?`Follow-up to pin #${fp.n}: click a part. Esc leaves.`:MODES[m];
    V.setLeftAction(m==='region'?'none':'rotate');V.canvas.style.cursor=m==='select'?'':'crosshair';
    V.retint();
  }
  document.querySelectorAll('#modes button').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
  function onKey(e){
    if(RP?.onKey(e))return true;
    if(e.key==='Escape'){
      if(!card.hidden){closeDialog();return true;}
      if(clearEvidence())return true;
      if(tourExit())return true;
      if(revSel||revPeek){holoOff();return true;}
      if(measA){measA=null;clearMeasDraft();return true;}
      if(mode!=='select'){setMode('select');return true;}
      return false;
    }
    if(mode==='measure'&&(e.key==='Delete'||e.key==='Backspace')){deleteMeasAtPointer();return true;}
    if(e.key==='h'&&!e.shiftKey){setPinsShown(!pinsShown);return true;}
    const m=KEYS[e.key.toLowerCase()];
    if(m&&!e.shiftKey&&!(V.M&&V.M.movable)){setMode(m);return true;}
    return false;
  }

  // ---- clicks in the view ----
  // Pin and Measure take a feature edge near the cursor over the face behind it (V.pickEdge)
  const wantsEdges=()=>mode==='pin'||mode==='measure';
  function onClick(e,h,edge){
    if(!card.hidden&&dialogCtx){$('pin-save').click();return true;}       // a click in the view away from the card saves it
    if(mode==='select'||mode==='region')return false;
    if(mode==='measure')return measureClick(e,h,edge);
    if(edge)h=edge.hit;
    if(!h){toast('Click on a part.',true,2500);return true;}
    const info=V.pickInfo(h);
    if(mode==='pin'&&RP?.picking()){RP.picked(edge?{kind:'edge',info,edge:edge.record}:{kind:'point',info});return true;}
    if(mode==='pin'){openDialog(edge?{kind:'edge',info,edge:edge.record,parent:followParent}:{kind:'point',info,parent:followParent});return true;}
    if(mode==='scope'){toggleScope(info.part.key);return true;}
    return false;
  }
  // region pin: drag a rectangle; every visible part whose box centre falls inside joins one pin
  let drag=null;
  V.canvas.addEventListener('pointerdown',e=>{if(mode!=='region'||e.button!==0)return;const r=V.canvas.getBoundingClientRect();drag={x0:e.clientX-r.left,y0:e.clientY-r.top,x1:e.clientX-r.left,y1:e.clientY-r.top};drawRect();});
  addEventListener('pointermove',e=>{if(!drag)return;const r=V.canvas.getBoundingClientRect();drag.x1=e.clientX-r.left;drag.y1=e.clientY-r.top;drawRect();});
  addEventListener('pointerup',()=>{if(!drag)return;const d=drag;drag=null;$('rect').hidden=true;
    const x0=Math.min(d.x0,d.x1),x1=Math.max(d.x0,d.x1),y0=Math.min(d.y0,d.y1),y1=Math.max(d.y0,d.y1);
    if(x1-x0<6||y1-y0<6)return;
    const keys=partsInRect(x0,y0,x1,y1);
    if(!keys.length){toast('No visible part has its centre inside that box.',true,3000);return;}
    openDialog({kind:'region',keys,rect:[x0,y0,x1,y1].map(v=>+v.toFixed(1))});
  });
  function drawRect(){const d=drag,el=$('rect');el.hidden=false;
    Object.assign(el.style,{left:Math.min(d.x0,d.x1)+'px',top:Math.min(d.y0,d.y1)+'px',width:Math.abs(d.x1-d.x0)+'px',height:Math.abs(d.y1-d.y0)+'px'});}
  function partsInRect(x0,y0,x1,y1){
    const r=V.canvas.getBoundingClientRect(),out=[],c=new THREE.Vector3();
    for(const [k,n] of V.nodes){
      if(!n.leaf||!V.leafShown(k)||!V.effVisible(n.obj))continue;
      const b=new THREE.Box3().setFromObject(n.obj);if(b.isEmpty())continue;
      b.getCenter(c).project(V.cam);if(c.z<-1||c.z>1)continue;
      const x=(c.x*0.5+0.5)*r.width,y=(0.5-c.y*0.5)*r.height;
      if(x>=x0&&x<=x1&&y>=y0&&y<=y1)out.push(k);
    }
    return out;
  }

  // ---- pin dialog ----
  // A small card: the part and whether it is a point or an edge, ONE row of the 6 most recently used reasons (class
  // chips), More reasons for the full grouped list, the meaning of the hovered or selected chip, a one-line note that
  // grows as it is typed in, severity as three chips, Save. One click on a chip picks the class and saves the pin (the
  // note is optional; the class's meaning is the pin's reason when the note is empty). Save, Enter in the note or a
  // click in the view away from the card saves with the highlighted class. The recently used order is remembered in
  // this browser.
  let pinClass='weird_geometry',sevNow='medium';
  const meaningOf=id=>(classes.find(c=>c.id===id)||{}).meaning||'';
  const RECENT_KEY='aad-recent-classes',RECENT_N=6,RECENT_SEED=['weird_geometry','design_change','regression','fit_clearance','appearance','keep'];
  let recent=RECENT_SEED.slice();
  try{const r=JSON.parse(localStorage.getItem(RECENT_KEY)||'null');if(Array.isArray(r))recent=[...new Set([...r.filter(x=>typeof x==='string'),...RECENT_SEED])];}catch(e){}
  function useClass(id){recent=[id,...recent.filter(x=>x!==id)].slice(0,24);try{localStorage.setItem(RECENT_KEY,J(recent.slice(0,RECENT_N*2)));}catch(e){}}
  const chipPick=id=>{setPinClass(id);$('pin-save').click();};
  function fillClasses(){
    const box=$('pin-chips');if(box.childElementCount)return;
    renderChipGroups(box,classes,groups,chipPick);                 // labelled groups (pin_groups.js), behind More reasons
    setPinClass(pinClass);
  }
  // the row: the recently used classes that exist, the card's own class first when it is not among them
  function renderRecent(){
    const ids=recent.filter(id=>classes.some(c=>c.id===id));let row=ids.slice(0,RECENT_N);
    if(!row.includes(pinClass))row=[pinClass,...row].slice(0,RECENT_N);
    const box=$('pin-recent'),more=$('pin-more');box.innerHTML='';
    for(const id of row){const c=classes.find(x=>x.id===id)||{id,label:id};const b=document.createElement('button');b.type='button';
      b.dataset.class=id;b.className='g-'+groupOf(classes,id)+(id===pinClass?' on':'');b.textContent=c.label;b.title=c.meaning||'';b.onclick=()=>chipPick(id);box.append(b);}
    box.append(more);                                             // More reasons ends the row
  }
  function setPinClass(id){pinClass=classes.some(c=>c.id===id)?id:'weird_geometry';
    for(const b of card.querySelectorAll('#pin-chips button,#pin-recent button'))b.classList.toggle('on',b.dataset.class===pinClass);showMeaning(null);}
  // the meaning line: the hovered chip's, else the selected chip's
  function showMeaning(hov){$('pin-meaning').textContent=meaningOf(hov||pinClass);}
  for(const id of ['pin-chips','pin-recent']){const el=$(id);
    el.addEventListener('pointerover',e=>{const b=e.target.closest('button[data-class]');if(b)showMeaning(b.dataset.class);});
    el.addEventListener('pointerleave',()=>showMeaning(null));
    el.addEventListener('focusin',e=>{const b=e.target.closest('button[data-class]');if(b)showMeaning(b.dataset.class);});}
  function setMore(open){$('pin-chips').hidden=!open;$('pin-more').setAttribute('aria-expanded',String(open));refit();}
  $('pin-more').onclick=()=>setMore($('pin-chips').hidden);
  function setSev(v){sevNow=['low','medium','high'].includes(v)?v:'medium';
    for(const b of $('pin-sev').querySelectorAll('button')){const on=b.dataset.sev===sevNow;b.classList.toggle('on',on);b.setAttribute('aria-checked',String(on));}}
  $('pin-sev').querySelectorAll('button').forEach(b=>b.onclick=()=>setSev(b.dataset.sev));
  // the note is one line until it is typed in, then grows with its text (up to about six lines)
  function growNote(){const t=$('pin-note');t.style.height='auto';t.style.height=Math.min(t.scrollHeight+2,120)+'px';refit();}
  $('pin-note').addEventListener('input',growNote);
  // The pin editor is a non-modal card in the workspace, beside its pin with a leader line. It never covers the draft
  // marker or the picked point (it flips side near an edge), follows the pin while the camera moves, can be dragged
  // by its header, and leaves the canvas free: orbit, pan and zoom keep working while it is open.
  const card=$('pin-dialog'),overlay=$('overlay'),leader=$('pin-leader');
  let draftMarker=null,cardDrag=null,cardOffset=null,cardPos=null,anchorPx=null;
  function anchorWorld(c,out){
    if(c.anchor?.mesh){c.anchor.mesh.updateMatrixWorld();return out.copy(c.anchor.local).applyMatrix4(c.anchor.mesh.matrixWorld);}
    return c.anchor?.world?out.copy(c.anchor.world):null;
  }
  function dialogAnchor(c){
    if(c.kind==='point'||c.kind==='edge'){const m=c.info.mesh;return m?{mesh:m,local:new THREE.Vector3(...c.info.local)}:{world:new THREE.Vector3(...c.info.world)};}
    const b=boxOf(c.keys||[]);return {world:b.isEmpty()?V.bbox.getCenter(new THREE.Vector3()):b.getCenter(new THREE.Vector3())};
  }
  function setDraftMarker(c){
    if(draftMarker){draftMarker.removeFromParent();draftMarker.element.remove();draftMarker=null;}
    if(!c)return;
    const el=document.createElement('div');el.className='pin-marker draft'+(c.kind==='region'?' region':'');el.textContent=String(c.repinN||S.next);el.id='pin-draft';
    el.addEventListener('pointerdown',e=>e.stopPropagation());
    draftMarker=new CSS2DObject(el);draftMarker.center.set(0.5,1.25);
    if(c.anchor.mesh){c.anchor.mesh.add(draftMarker);draftMarker.position.copy(c.anchor.local);}else{V.scene.add(draftMarker);draftMarker.position.copy(c.anchor.world);}
  }
  const _w=new THREE.Vector3();let cardCube=false,docked=false,floatSize=null;
  function measureFloat(){const was=docked,st=card.style.cssText;if(was){card.classList.remove('docked');card.style.width='';}
    const r={w:card.offsetWidth,h:card.offsetHeight};if(was){card.classList.add('docked');card.style.cssText=st;}return r;}
  const refit=()=>{floatSize=null;placeCard();};
  // Docked: when the view is under DOCK_W px wide, or the card would cover more than a third of the view, or no spot
  // keeps it off the pin, the view cube and the mode hint, the card sits at the top of the right panel (under its
  // tabs) with the leader running from the pin to the panel edge. Floating, it never covers the mode hint.
  const DOCK_W=700;
  function dockRect(){
    const pn=document.getElementById('panel');if(!pn||pn.hidden||document.body.classList.contains('no-panel'))return null;
    const r=pn.getBoundingClientRect();if(r.width<200||r.height<200)return null;
    const tb=document.getElementById('tabs')?.getBoundingClientRect();return {l:r.left+8,t:(tb&&tb.height?tb.bottom:r.top)+8,w:Math.min(r.width-16,360)};
  }
  function placeCard(){
    if(card.hidden||!dialogCtx){overlay.classList.remove('leader');anchorPx=null;return;}
    const W=V.host.clientWidth,H=V.host.clientHeight,g=8;
    const p=anchorWorld(dialogCtx,_w);let x=null,y=null;
    if(p){p.project(V.cam);if(p.z>=-1&&p.z<=1){x=(p.x*0.5+0.5)*W;y=(0.5-p.y*0.5)*H;}}
    anchorPx=x==null?null:{x,y};
    const hr0=V.host.getBoundingClientRect(),mh=document.getElementById('modehint');
    const hintR=mh&&!mh.hidden&&mh.offsetWidth?(r=>({l:r.left-hr0.left-g,t:r.top-hr0.top-g,r:r.right-hr0.left+g,b:r.bottom-hr0.top+g}))(mh.getBoundingClientRect()):null;
    // the floating size decides whether it fits (measured undocked when the content changes)
    if(!floatSize||!docked)floatSize=docked?measureFloat():{w:card.offsetWidth,h:card.offsetHeight};
    const w=floatSize.w,h=floatSize.h;
    if(docked&&!(dr0=>dr0&&(W<DOCK_W||w*h>W*H/3))(dockRect())){card.classList.remove('docked');card.style.width='';docked=false;}
    const dr=dockRect(),overHint=q=>hintR&&!(q.l>hintR.r||q.l+w<hintR.l||q.t>hintR.b||q.t+h<hintR.t);
    const wantDock=!cardDrag&&!cardOffset&&dr&&(W<DOCK_W||w*h>W*H/3);
    const clamp=(l,t)=>({l:Math.max(g,Math.min(l,W-w-g)),t:Math.max(hintR&&l<hintR.r&&l+w>hintR.l?Math.max(g,hintR.b):g,Math.min(t,H-h-g))});
    if(wantDock)return dockCard(dr,x,y,W,H);
    // the view cube and its arrows (top-right) are never covered: a spot that would overlap them flips to the
    // other side of the point
    const hr=V.host.getBoundingClientRect(),cubeEl=document.getElementById('cube-nav')||document.getElementById('viewcube');
    const cr=cubeEl?cubeEl.getBoundingClientRect():null,cb=cr&&cr.width?{l:cr.left-hr.left-g,t:cr.top-hr.top-g,r:cr.right-hr.left+g,b:cr.bottom-hr.top+g}:{l:W-130,t:0,r:W,b:130};
    const over=(q,a)=>!(q.l>a.r||q.l+w<a.l||q.t>a.b||q.t+h<a.t),onCube=q=>over(q,cb);
    let pos;
    if(x==null)pos=cardPos||clamp(W-w-g,cb.b+g);
    else if(cardOffset)pos=clamp(x+cardOffset.dx,y+cardOffset.dy);
    else{
      // keep clear of the marker bubble (it sits above the point), the point itself and the view cube
      const av={l:x-24,t:y-44,r:x+24,b:y+10},hit=q=>over(q,av);
      const cands=[clamp(x+44,y-h/2),clamp(x-44-w,y-h/2),clamp(x-w/2,y+26),clamp(x-w/2,y-56-h),clamp(x-44-w,cb.b+g),clamp(x+44,cb.b+g)];
      pos=cands.find(q=>!hit(q)&&!onCube(q)&&!overHint(q));
      if(!pos&&dr&&!cardDrag)return dockCard(dr,x,y,W,H);
      pos=pos||cands.find(q=>!onCube(q)&&!overHint(q))||cands.find(q=>!onCube(q))||cands[0];
    }
    cardCube=onCube(pos);
    cardPos=pos;card.style.left=pos.l+'px';card.style.top=pos.t+'px';
    if(x==null){overlay.classList.remove('leader');return;}
    const cx=Math.max(pos.l,Math.min(x,pos.l+w)),cy=Math.max(pos.t,Math.min(y,pos.t+h));
    leader.setAttribute('x1',x.toFixed(1));leader.setAttribute('y1',y.toFixed(1));leader.setAttribute('x2',cx.toFixed(1));leader.setAttribute('y2',cy.toFixed(1));
    overlay.classList.add('leader');
  }
  function dockCard(dr,x,y,W,H){
    docked=true;card.classList.add('docked');card.style.width=dr.w+'px';card.style.left=dr.l+'px';card.style.top=dr.t+'px';cardCube=false;
    if(x==null){overlay.classList.remove('leader');return;}
    // leader: from the pin to the view's right edge (the panel edge), level with the card where it can be
    const hr=V.host.getBoundingClientRect(),cr=card.getBoundingClientRect(),ey=Math.max(4,Math.min(H-4,cr.top+Math.min(cr.height/2,40)-hr.top));
    leader.setAttribute('x1',x.toFixed(1));leader.setAttribute('y1',y.toFixed(1));leader.setAttribute('x2',(W-1).toFixed(1));leader.setAttribute('y2',ey.toFixed(1));
    overlay.classList.add('leader');
  }
  $('pin-grip').addEventListener('pointerdown',e=>{
    if(e.button!==0||e.target.closest('button')||docked)return;e.preventDefault();
    cardDrag={x:e.clientX,y:e.clientY,l:card.offsetLeft,t:card.offsetTop};$('pin-grip').setPointerCapture(e.pointerId);
  });
  $('pin-grip').addEventListener('pointermove',e=>{
    if(!cardDrag)return;
    const l=cardDrag.l+e.clientX-cardDrag.x,t=cardDrag.t+e.clientY-cardDrag.y;
    if(anchorPx)cardOffset={dx:l-anchorPx.x,dy:t-anchorPx.y};else cardPos={l,t};
    placeCard();if(!anchorPx){card.style.left=l+'px';card.style.top=t+'px';}
  });
  const endDrag=()=>{cardDrag=null;};
  $('pin-grip').addEventListener('pointerup',endDrag);$('pin-grip').addEventListener('pointercancel',endDrag);
  // the card's own events stay in the card (the canvas handlers never see them)
  for(const ev of ['pointerdown','dblclick','contextmenu'])card.addEventListener(ev,e=>e.stopPropagation());
  function openDialog(c){
    const keepNote=dialogCtx&&!card.hidden?$('pin-note').value:null;
    dialogCtx=c;c.anchor=dialogAnchor(c);cardOffset=null;cardPos=null;showPins();
    // the location line wraps between fields (name, coordinates, edge length) but never inside a number or the triple
    const fld=t=>`<span class="fld">${esc(t)}</span>`;
    // one line: the part and whether it is a point or an edge; the part-local point is in the line's tooltip
    const where=c.kind!=='region'?`<span class="fld nm">${esc(c.info.name)}</span> <span class="fld kind">${esc(c.kind==='edge'&&c.edge?.length_mm!=null?`edge ${(+c.edge.length_mm).toFixed(2)} mm`:'point')}</span>`:
      esc(`${c.keys.length} part${c.keys.length===1?'':'s'}: `)+c.keys.slice(0,5).map(k=>fld(V.nodes.get(k)?.leaf?.name||k)).join(', ')+(c.keys.length>5?', ...':'');
    const par=c.parent&&S.pins.find(p=>p.id===c.parent);
    $('pin-was').hidden=!c.was;$('pin-was').textContent=c.was||'';
    $('pin-where').innerHTML=where;$('pin-where').title=c.kind!=='region'?`${c.info.name}, local ${c.info.local.map(x=>x.toFixed(1)).join(', ')} mm`:'';$('pin-dialog-h').textContent=c.title||(par?`Follow-up to pin #${par.n}`:c.kind==='region'?'New region pin':c.kind==='edge'?'New edge pin':'New pin');
    $('pin-note').value=c.note||keepNote||'';pinClass=classes.some(x=>x.id===(c.issue_class||pinClass))?(c.issue_class||pinClass):'weird_geometry';renderRecent();setPinClass(pinClass);setSev(c.severity||sevNow||'medium');
    $('pin-chips').hidden=true;$('pin-more').setAttribute('aria-expanded','false');$('pin-note').style.height='';
    const lm=S.meas[S.meas.length-1];$('pin-measure-row').hidden=!(lm&&!lm.pin);
    setDraftMarker(c);card.hidden=false;floatSize=null;if($('pin-note').value)growNote();placeCard();V.dirty();
    setTimeout(()=>$('pin-note').focus({preventScroll:true}),0);
  }
  function closeDialog(){card.hidden=true;dialogCtx=null;cardDrag=null;setDraftMarker(null);placeCard();V.dirty();
    if(card.contains(document.activeElement))document.activeElement.blur();}
  $('pin-close').onclick=closeDialog;
  card.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeDialog();return;}
    // Enter saves from the note (Shift+Enter is a new line) and Cmd/Ctrl+Enter saves from anywhere in the card
    if(e.key==='Enter'&&((e.target.id==='pin-note'&&!e.shiftKey)||e.metaKey||e.ctrlKey)){e.preventDefault();$('pin-save').click();}
  });
  $('pin-save').onclick=()=>{
    const c=dialogCtx;if(!c)return;closeDialog();useClass(pinClass);
    if(c.repin){RP.save(c,{issue_class:pinClass,note:$('pin-note').value.trim(),severity:sevNow});return;}   // repin.js
    const lm=S.meas[S.meas.length-1],attach=!$('pin-measure-row').hidden&&$('pin-measure').checked&&lm&&!lm.pin;
    const n=S.next,id='p'+n;S.next=n+1;
    const pin={schema:'cadreview/1',id,n,kind:c.kind,status:'open',note:$('pin-note').value.trim(),issue_class:pinClass,
      severity:sevNow,anchor:null,parts:[],rect:c.rect||null,measure:null,camera:V.camera(),build:server?.build||null,
      source:c.source||'viewer',tour_stop:c.tour_stop||null,created:now(),updated:null,resolved_at:null,resolved_build:null,reopened_at:null,reopened_reason:null};
    if(c.kind==='edge')pin.edge=c.edge;
    if(c.parent&&S.pins.some(p=>p.id===c.parent))pin.parent=c.parent;
    if(c.kind==='point'||c.kind==='edge'){const i=c.info;pin.anchor={part:i.part,local:i.local,normal_local:i.normal_local,world:i.world,normal_world:i.normal_world,bbox:i.bbox};pin.parts=[i.part];}
    else pin.parts=c.keys.map(k=>V.partRef(k)).filter(Boolean);
    if(attach){pin.measure={...lm,pin:id};lm.pin=id;}
    S.pins.push(pin);
    if(c.after)c.after(pin);
    if(pin.parent&&mode==='pin'){followParent=null;setMode('select');}
    changed();hotPin=id;renderPins();
    toast(`Pin <b>#${n}</b> saved (${esc(label(pin.issue_class))}).`,false,2500);
  };

  // right-click "Pin": a point pin where the part was clicked, else a region pin of that tree node's parts
  function pinPart(k,h){
    if(h)openDialog({kind:'point',info:V.pickInfo(h)});
    else openDialog({kind:'region',keys:V.leafKeys(k)});
  }
  // Add follow-up pin: from a pin's actions (Pin mode, the next pin records `parent`), or from the right-click part
  // menu (a pin at the clicked point, following up the selected pin when it is on that part, else that part's newest
  // open pin)
  function startFollowUp(p){followParent=p.id;setMode('pin',true);toast(`Follow-up to pin <b>#${p.n}</b>: click where the new pin goes. Esc cancels.`,false,3500);}
  function followUpFor(k){
    const on=S.pins.filter(p=>p.status!=='resolved'&&(p.anchor?keyFor(p.anchor.part)===k:p.parts.some(x=>keyFor(x)===k)));
    return on.find(p=>p.id===hotPin)||on[on.length-1]||null;
  }
  function followUpPart(k,h){
    const par=followUpFor(k);if(!par)return;
    if(h)openDialog({kind:'point',info:V.pickInfo(h),parent:par.id});
    else openDialog({kind:'region',keys:V.leafKeys(k),parent:par.id});
  }
  // right-click "Measure from here": Measure mode with the first point already placed
  function measureFrom(h){setMode('measure');measA=MEAS.fromHit(h);drawMeasDraft(measA);}
  // ---- stale edge pins: an edge pin keeps the polyline of the edge it was made on (part-local mm). On a later build
  // that polyline is matched against the part's current feature-edge chains: points sampled along it lie within
  // EDGE_TOL mm of a chain (mean and max) whose length agrees within EDGE_LEN. A match draws the current edge as
  // usual; no match means the geometry changed there, so the stored polyline is history: thin, dashed, labelled
  // "edge as pinned", shown for the selected pin (its card's Show old edge says otherwise). The anchor is never
  // touched. Results are cached per pin and build.
  const EDGE_TOL=0.3,EDGE_LEN=0.05,edgeMatches=new Map(),showOld=new Map();
  const edgeBuild=p=>p.repinned_build||p.build||null,edgePinnedAt=p=>p.repinned_at||p.created;
  function polySamples(pts,n){
    const P=pts.map(q=>new THREE.Vector3(...q)),cum=[0];for(let i=1;i<P.length;i++)cum.push(cum[i-1]+P[i].distanceTo(P[i-1]));
    const L=cum[cum.length-1],out=[];if(P.length<2||L<=0)return P;
    for(let j=0,i=1;j<n;j++){const t=L*j/(n-1);while(i<P.length-1&&cum[i]<t)i++;const u=(t-cum[i-1])/Math.max(1e-12,cum[i]-cum[i-1]);out.push(P[i-1].clone().lerp(P[i],Math.max(0,Math.min(1,u))));}
    return out;
  }
  const _sa=new THREE.Vector3(),_sb=new THREE.Vector3();
  function distPoly(q,P){
    let best=Infinity;
    for(let i=1;i<P.length;i++){_sa.subVectors(P[i],P[i-1]);const l2=_sa.lengthSq();const t=l2>0?Math.max(0,Math.min(1,_sb.subVectors(q,P[i-1]).dot(_sa)/l2)):0;
      const d=_sb.copy(P[i-1]).addScaledVector(_sa,t).distanceTo(q);if(d<best)best=d;}
    return best;
  }
  // {changed, pts (the current chain when it matches), mean, max} on a build other than the pin's; null when the
  // pin is not an edge pin, is on the current build, or its part is missing
  function edgeMatch(p){
    if(p.kind!=='edge'||!p.edge?.points?.length||!p.anchor)return null;
    const cur=server?.build,b=edgeBuild(p);if(!cur||!b||b===cur)return null;
    const k=keyFor(p.anchor.part),mesh=k&&meshOf(k);if(!mesh)return null;
    const ck=p.id+'|'+b+'|'+cur+'|'+J(p.edge.points[0])+p.edge.points.length;let r=edgeMatches.get(ck);if(r)return r;
    const L=+p.edge.length_mm||0,S=polySamples(p.edge.points,Math.max(8,Math.min(64,Math.ceil(L/0.5)+1)));
    const sb=new THREE.Box3().setFromPoints(S).expandByScalar(EDGE_TOL);let best=null;
    for(const ch of V.featureChains(mesh)){
      if(Math.abs(ch.record.length_mm-L)>EDGE_LEN*Math.max(L,1e-6))continue;
      if(!ch.box)ch.box=new THREE.Box3().setFromPoints(ch.pts);if(!ch.box.intersectsBox(sb))continue;
      let sum=0,max=0;for(const q of S){const d=distPoly(q,ch.pts);sum+=d;if(d>max)max=d;if(max>EDGE_TOL)break;}
      if(max<=EDGE_TOL&&sum/S.length<=EDGE_TOL&&(!best||sum<best.sum))best={ch,sum,max};
    }
    r=best?{changed:false,pts:best.ch.pts,mean:best.sum/S.length,max:best.max}:{changed:true};
    edgeMatches.set(ck,r);return r;
  }
  const edgeChanged=p=>!!edgeMatch(p)?.changed;
  const oldEdgeShown=p=>showOld.has(p.id)?showOld.get(p.id):p.id===hotPin;
  function edgeChangedText(p){
    const t=V.loadedMtime,rb=t?when(new Date(t*1000).toISOString()):'';
    return `The pinned edge changed since this pin was made (pinned ${when(edgePinnedAt(p))}${rb?`, model rebuilt ${rb}`:''})`;
  }
  // ---- pin list, markers ----
  function pinWhere(p){
    if(p.anchor){const k=keyFor(p.anchor.part);return (k?(V.nodes.get(k).leaf?.name||k):p.anchor.part.node)+(p.edge?`, edge ${p.edge.length_mm.toFixed(2)} mm`:'')+' at '+p.anchor.local.map(x=>(+x).toFixed(1)).join(', ');}
    return p.parts.length+' parts: '+p.parts.slice(0,4).map(x=>x.node).join(', ')+(p.parts.length>4?', ...':'');
  }
  const orphaned=p=>p.anchor?!keyFor(p.anchor.part):(p.parts.length>0&&p.parts.every(x=>!keyFor(x)));
  // Checking a pin off takes it out of the list and its marker off the model at once (one undo step brings it
  // back); resolved pins wait in a collapsed "Resolved (n)" row at the bottom, each with Reopen.
  let showResolved=false,pinChanges=null;
  // "Unchanged here since your packet": the server compares each open pin of the last packet with the build that
  // packet was sent against (its part, and every triangle within 5 mm of its point)
  const unchangedHere=p=>{const c=pinChanges?.pins?.[p.id];return !!c&&p.status!=='resolved'&&!c.part_changed&&c.near_changed!==true&&!NO_UNCHANGED_BADGE.has(p.issue_class);};
  const changedHere=p=>{const c=pinChanges?.pins?.[p.id];return !!c&&(c.part_changed||c.near_changed===true);};
  const unchangedTitle=p=>`Nothing within ${pinChanges.radius_mm} mm of this pin changed and its part is unchanged against ${pinChanges.against.label} (build ${pinChanges.against.build}).`;
  async function loadPinChanges(){try{pinChanges=await getJSON('/review/pin-changes.json');}catch(e){pinChanges=null;}renderPins();}
  function setStatus(p,st){
    p.status=st;p.updated=now();
    if(st==='resolved'){p.resolved_at=now();p.resolved_build=server?.build||null;}
    else{p.resolved_at=null;p.resolved_build=null;}
  }
  // a human time for the status line: 22:12 today, else Nov 11 22:12 (build hashes stay in the title tooltip)
  function when(iso){
    const d=iso?new Date(iso):null;if(!d||isNaN(d))return '';
    const t=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});
    return d.toDateString()===new Date().toDateString()?t:d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+t;
  }
  function statusLine(p){
    if(p.status==='reopened')return {t:`reopened: part changed again at ${when(p.reopened_at)}`,tip:p.reopened_reason||''};
    if(p.status==='not_fixed')return {t:`marked not fixed at ${when(p.escalated_at)}`,tip:p.escalated_build?`escalated on build ${p.escalated_build}`:''};
    if(p.status==='resolved')return {t:`resolved at ${when(p.resolved_at)}`,tip:p.resolved_build?`resolved on build ${p.resolved_build}`:''};
    return null;
  }
  // a pin card: row 1 number, title and badges (wraps), then the actions (labelled group, icon group; each group
  // stays whole, so a wrap gives two clean lines and never one lone button), then
  // the note, where it is, and one short status line
  const NOTE_ACT={question:{label:'Answered',icon:'check',title:'Answered: the question is settled; the pin moves to Resolved (undo brings it back)',done:'answered'},
    keep:{label:'Release',icon:'lock-open',title:'Release: removes the keep lock; the pin moves to Resolved (undo brings it back)',done:'released',norepin:true},
    reference:{label:'Done',icon:'check',title:'Done: the reference was used; the pin moves to Resolved (undo brings it back)',done:'done'}};
  const ACT=(act,icon,text,title,cls='')=>`<button data-act="${act}"${cls?` class="${cls}"`:''} title="${title}" aria-label="${text||title.split(':')[0]}"><i class="ic i-${icon}"></i>${text?`<span>${text}</span>`:''}</button>`;
  function pinItem(p){
    const li=document.createElement('li');li.className='item pin'+(p.id===hotPin?' sel':'');li.dataset.pin=p.id;
    const orphan=orphaned(p),done=p.status==='resolved',sl=statusLine(p),par=p.parent&&S.pins.find(x=>x.id===p.parent);
    // a note pin gets the action that fits it (only labels and buttons differ; the stored status is still resolved):
    // a question is Answered, a keep pin is Released (the lock goes, the pin moves to Resolved), a reference is Done;
    // none of them can be "not fixed", and a keep pin is never repinned
    const nk=NOTE_ACT[p.issue_class];
    const repin=!(nk&&nk.norepin)&&RP.offer(p,changedHere(p))?ACT('repin','map-pin-exclamation','Repin','Repin: something is still wrong; click the spot that is wrong now (same pin, attempt + 1)','danger'):'';
    // two groups that wrap as units: the labelled decisions, then the icon-only tools (fly, follow-up, delete)
    const main=done?ACT('reopen','refresh','Reopen','Reopen this pin')+repin:
      nk?ACT('resolve',nk.icon,nk.label,nk.title)+repin:
      ACT('resolve','check','Resolve','Mark resolved: the pin leaves the list (undo brings it back)')+
      ACT('notfixed','alert-octagon','Not fixed','Not fixed: the last attempt did not fix this; the next packet says so and lists it first','danger')+repin;
    const tools=ACT('fly','crosshair','','Fly to this pin')+(done?'':ACT('followup','corner-down-right','','Add follow-up pin: the next pin you drop follows up this one'))+ACT('delete','trash','','Delete pin');
    const acts=`<span class="pa">${main}</span><span class="sa">${tools}</span>`;
    li.innerHTML=`<div class="ph"><span class="num sev-${p.severity} g-${groupOf(classes,p.issue_class)}${done?' resolved':''}">${p.n}</span>
      <span class="cls">${esc(label(p.issue_class))}</span>${groupBadge(classes,groups,p.issue_class)}<span class="chip">${esc(p.severity)}</span>${RP.badge(p)}
      ${p.status==='reopened'?'<span class="chip reopened">reopened</span>':''}${p.status==='not_fixed'?`<span class="chip notfixed">Not fixed, attempt ${p.attempts||1}</span>`:''}
      ${unchangedHere(p)?`<span class="chip same" title="${esc(unchangedTitle(p))}">Unchanged here since your packet</span>`:''}${orphan?'<span class="chip orphan">orphaned</span>':''}
      <span class="chip parthidden" title="Its part is hidden in the view (tree, isolate or solo), so its marker is too"${partHidden.get(p.id)?'':' hidden'}>part hidden</span>
      <span class="chip cutaway" title="Its point is on the side the section plane removes; the marker is drawn faded"${cutAway.has(p.id)?'':' hidden'}><i class="ic i-scissors"></i>cut away by the section</span></div>
      <div class="acts">${acts}</div>
      ${par?`<div class="where">follow-up to #${par.n}</div>`:''}${RP.was(p)}
      <div class="note">${esc(p.note)||`<span class="muted">${esc(meaningOf(p.issue_class))}</span>`}</div>
      <div class="where">${esc(pinWhere(p))}${p.measure?`, measured ${p.measure.distance.toFixed(2)} mm`:''}</div>
      ${!done&&edgeChanged(p)?`<div class="edge-stale" title="Pinned on build ${esc(edgeBuild(p))}; the current build is ${esc(server?.build)}. The stored edge no longer matches any edge of this part (within ${EDGE_TOL} mm). The pin stays where it was."><i class="ic i-alert-triangle"></i><span>${esc(edgeChangedText(p))}</span></div>
      <label class="old-edge" title="Draw the edge as it was when the pin was made (dashed)"><input type="checkbox" data-act="oldedge"${oldEdgeShown(p)?' checked':''}> Show old edge</label>`:''}
      ${sl?`<div class="hist" title="${esc(sl.tip)}">${esc(sl.t)}</div>`:''}`;
    li.onclick=e=>{
      if(e.target.closest('label.old-edge')){const cb=e.target.closest('label.old-edge').querySelector('input');
        if(e.target===cb){showOld.set(p.id,cb.checked);V.dirty();}return;}            // view state only, never pins.json
      const a=e.target.closest('button')?.dataset.act;
      if(a==='resolve'){setStatus(p,'resolved');if(hotPin===p.id)hotPin=null;changed();toast(`Pin <b>#${p.n}</b> ${NOTE_ACT[p.issue_class]?.done||'resolved'}. Undo brings it back; it is under Resolved.`,false,3000);return;}
      if(a==='reopen'){setStatus(p,'open');hotPin=p.id;changed();return;}
      if(a==='followup'){startFollowUp(p);return;}
      if(a==='repin'){RP.start(p);return;}
      if(a==='notfixed'&&!NOTE_ACT[p.issue_class]){
        if(p.status==='not_fixed'&&p.escalated_build&&p.escalated_build===server?.build){toast(`Pin <b>#${p.n}</b> is already marked not fixed on this build.`,false,3000);return;}
        p.status='not_fixed';p.attempts=(p.attempts||0)+1;p.escalated_build=server?.build||null;p.escalated_at=now();p.updated=now();
        hotPin=p.id;changed();toast(`Pin <b>#${p.n}</b> marked not fixed (attempt ${p.attempts}). The next packet lists it first.`,true,3500);return;}
      if(a==='delete'){S.pins=S.pins.filter(x=>x!==p);for(const m of S.meas)if(m.pin===p.id)m.pin=null;changed();return;}
      flyToPin(p);};
    return li;
  }
  function renderPins(){
    const ol=$('pin-list');ol.innerHTML='';
    const top=p=>p.status!=='not_fixed'&&!RP.isRepinned(p);         // not fixed and repinned pins first
    const active=S.pins.filter(p=>p.status!=='resolved').sort((a,b)=>top(a)-top(b)),done=S.pins.filter(p=>p.status==='resolved');
    $('pins-count').textContent=String(active.length);$('pins-sub').textContent=`${active.length} open, ${done.length} resolved`;
    // a follow-up sits indented under its parent while both are open
    const ids=new Set(active.map(p=>p.id)),kids=new Map();
    for(const p of active)if(p.parent&&ids.has(p.parent)&&p.parent!==p.id){if(!kids.has(p.parent))kids.set(p.parent,[]);kids.get(p.parent).push(p);}
    const placed=new Set(),put=(p,depth)=>{if(placed.has(p.id))return;placed.add(p.id);const li=pinItem(p);if(depth){li.classList.add('child');li.style.marginLeft=Math.min(depth,3)*16+'px';}ol.append(li);for(const k of kids.get(p.id)||[])put(k,depth+1);};
    for(const p of active)if(!(p.parent&&ids.has(p.parent)))put(p,0);
    for(const p of active)put(p,0);
    if(done.length){
      const li=document.createElement('li');li.className='resolved-row';
      li.innerHTML=`<button id="resolved-toggle" aria-expanded="${showResolved}"><i class="ic ${showResolved?'i-chevron-down':'i-chevron-right'}"></i>Resolved (${done.length})</button>`;
      li.querySelector('button').onclick=()=>{showResolved=!showResolved;renderPins();};
      ol.append(li);
      if(showResolved){const sub=document.createElement('ol');sub.id='resolved-list';for(const p of done)sub.append(pinItem(p));li.append(sub);}
    }
    renderMarkers();
  }
  // what a pin's fly to frames, in world space: {point, radius (mm, the spot's own size), edge: 'current' | 'stored' |
  // 'gone' | null}. An edge pin frames the edge as it is now (the re-match on a newer build, else the stored edge on
  // its own build) by that edge's bounding sphere; when the edge no longer exists it frames the pin's anchor point
  // like a point pin. A frame is never derived from a stale stored polyline.
  let lastSpot=null;
  function pinSpot(p,m){
    m.updateMatrixWorld();const anchor=m.localToWorld(new THREE.Vector3(...p.anchor.local));
    if(p.kind!=='edge'||!p.edge?.points?.length)return {point:anchor,radius:0,edge:null,mark:anchor};
    const em=edgeMatch(p);if(em?.changed)return {point:anchor,radius:0,edge:'gone',mark:anchor};
    const pts=(em?em.pts:p.edge.points).map(q=>(q.isVector3?q.clone():new THREE.Vector3(...q)).applyMatrix4(m.matrixWorld));
    const s=new THREE.Sphere().setFromPoints(pts);
    return {point:s.center,radius:s.radius,edge:em?'current':'stored',mark:anchor};
  }
  function flyToPin(p){
    hotPin=p.id;showPins();
    const k=p.anchor?keyFor(p.anchor.part):null,keys=p.parts.map(keyFor).filter(Boolean);
    // the pin's spot with its surroundings (never the whole of a large part); a region pin frames its parts. The
    // shared target routine picks the clearest view and fades the rest when the spot is still hidden.
    V.camAction(()=>{
      if(k){const m=meshOf(k),sp=pinSpot(p,m);lastSpot={pin:p.id,edge:sp.edge,point:sp.point.toArray(),radius:sp.radius};
        V.showTarget({keys:[k],point:sp.point,radius:sp.radius,mark:sp.mark,kind:'pin',name:`pin #${p.n} (${V.nodes.get(k)?.leaf?.name||k})`});}
      else if(keys.length)V.showTarget({keys,kind:'pin',name:`pin #${p.n}`});
      else if(p.anchor)V.flyToPoint(p.anchor.world);
    });
    if(k)V.select(k);else if(keys.length)V.select(keys[0]);
    V.commit();renderPins();
  }
  function renderMarkers(){
    for(const [,o] of markers){o.removeFromParent();o.element.remove();}
    markers.clear();fan.clear();fanSig='';
    for(const p of S.pins){
      if(p.status==='resolved')continue;                         // a resolved pin leaves the model at once
      const el=document.createElement('div'),orphan=orphaned(p);
      el.className=`pin-marker sev-${p.severity} g-${groupOf(classes,p.issue_class)}${RP.isRepinned(p)?' repinned':''}${p.status==='not_fixed'?' notfixed':''}${orphan?' orphan':''}${p.kind==='region'?' region':''}${p.id===hotPin?' hot':''}${dimOcc&&occluded.has(p.id)&&p.id!==hotPin?' occluded':''}`;
      el.textContent=String(p.n);const cb=document.createElement('i');cb.className='ic i-scissors cutb';cb.setAttribute('aria-hidden','true');el.append(cb);el.title=`#${p.n} ${label(p.issue_class)}: ${p.note}`+(orphan?' (part missing in this build)':'')+(edgeChanged(p)?'\n'+edgeChangedText(p):'');el.dataset.title=el.title;el.dataset.pin=p.id;
      if(cutAway.has(p.id))el.classList.add('cut');markTitle(el);
      el.addEventListener('pointerdown',e=>e.stopPropagation());
      el.addEventListener('click',e=>{e.stopPropagation();flyToPin(p);});
      const o=new CSS2DObject(el);o.userData.pin=p.id;o.center.set(0.5,1.25);   // the bubble sits above its point, which stays clickable
      const k=p.anchor?keyFor(p.anchor.part):null;
      if(k){meshOf(k).add(o);o.position.set(...p.anchor.local);o.userData.key=k;}
      else if(!p.anchor&&p.parts.some(keyFor)){const keys=p.parts.map(keyFor).filter(Boolean);const b=boxOf(keys);V.scene.add(o);o.position.copy(b.getCenter(new THREE.Vector3()));o.userData.keys=keys;}
      else{V.scene.add(o);o.position.set(...(p.anchor?p.anchor.world:V.bbox.getCenter(new THREE.Vector3()).toArray()));}
      markers.set(p.id,o);
    }
    RP.renderTrails();
    occSig='';V.dirty();
  }
  // markers follow their part's visibility (CSS2D does not check ancestors) and the Pins toggle; a hidden part's
  // pin says "part hidden" in the list
  function beforeLabels(){
    measBeforeLabels();
    const show=pinsShown||forceShow;
    for(const [id,o] of markers){
      const vis=o.userData.key?V.effVisible(o.parent):o.userData.keys?o.userData.keys.some(k=>V.leafShown(k)):true;
      o.visible=vis&&show;o.userData.partShown=vis;
      const fd=V.focusActive()&&!(o.userData.key?V.inFocus(o.userData.key):o.userData.keys?o.userData.keys.some(k=>V.inFocus(k)):true);
      if(o.element.classList.contains('faded')!==fd)o.element.classList.toggle('faded',fd);
      if(!!partHidden.get(id)!==!vis){partHidden.set(id,!vis);
        const c=document.querySelector(`#pin-list li[data-pin="${id}"] .chip.parthidden`);if(c)c.hidden=vis;}
      // a section plane that removes the pin's point: faded marker with a scissors badge, said in its list row too
      const cut=vis&&V.clipped(o.getWorldPosition(_cw));
      if(cut!==cutAway.has(id)){if(cut)cutAway.add(id);else cutAway.delete(id);o.element.classList.toggle('cut',cut);markTitle(o.element);
        const c=document.querySelector(`#pin-list li[data-pin="${id}"] .chip.cutaway`);if(c)c.hidden=!cut;}
    }
    RP?.beforeLabels();
    if(!forceShow)occlusionTick();
    fanTick();
  }
  // ---- overlapping markers fan out: markers whose bubbles would sit closer than FAN_GAP diameters spread on a
  // arc over their mean, each with a thin leader in its pin colour to its true point. A pin whose edge is a
  // small closed loop (a screw head's circle) moves its bubble off the loop with a leader to it, so the loop never
  // reads as another empty marker. Offsets are CSS translate (CSS2DRenderer owns transform); recomputed when the
  // camera or the markers change, every FAN_MS while it moves with few pins, else once it settles.
  const FAN_GAP=1.2,FAN_LIVE_MAX=24,FAN_MS=50,FAN_SETTLE_MS=150,fan=new Map();
  let fanSig='',fanAt=0,fanTimer=0,fanRuns=0;
  const _f=new THREE.Vector3();
  function screenOf(o,W,H){o.getWorldPosition(_f);_f.project(V.cam);return _f.z<-1||_f.z>1?null:{x:(_f.x+1)/2*W,y:(1-_f.y)/2*H};}
  // the live edge of an edge pin as a small closed loop on screen: {pts, cx, cy, r} or null
  function loopOf(p,W,H){
    if(p.kind!=='edge'||!p.edge?.points?.length||!p.anchor)return null;
    const m=edgeMatch(p);if(m?.changed)return null;
    const pts=m?m.pts:p.edge.points,a=pts[0],b=pts[pts.length-1],A=a.isVector3?a.toArray():a,B=b.isVector3?b.toArray():b;
    const L=+p.edge.length_mm||0;if(Math.hypot(A[0]-B[0],A[1]-B[1],A[2]-B[2])>Math.max(0.01,0.002*L))return null;
    const k=keyFor(p.anchor.part),mesh=k&&meshOf(k);if(!mesh)return null;
    const runs=V.edgeScreen({mesh,pts},W,H);if(runs.length!==1)return null;const q=runs[0];
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const [x,y] of q){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
    if(Math.hypot(x1-x0,y1-y0)>90)return null;
    return {pts:q,cx:(x0+x1)/2,cy:(y0+y1)/2,r:Math.max(x1-x0,y1-y0)/2};
  }
  function fanLayout(){
    fanAt=performance.now();fanRuns++;
    const W=V.host.clientWidth,H=V.host.clientHeight,items=[];
    for(const [id,o] of markers){
      const el=o.element,p=S.pins.find(x=>x.id===id),a=o.visible&&p?screenOf(o,W,H):null;
      if(!a){if(fan.delete(id))el.style.translate='';continue;}
      const w=el.offsetWidth||28,h=el.offsetHeight||28,d=Math.max(w,h),hx=a.x,hy=a.y-0.75*h;
      let cx=hx,cy=hy;const loop=loopOf(p,W,H);
      if(loop){let ux=a.x-loop.cx,uy=a.y-loop.cy;const l=Math.hypot(ux,uy);if(l<1){ux=0;uy=-1;}else{ux/=l;uy/=l;}
        const r=loop.r+d/2+12;cx=loop.cx+ux*r;cy=loop.cy+uy*r;}
      items.push({id,el,hx,hy,cx,cy,d,n:p.n,loop:!!loop});
    }
    const par=items.map((_,i)=>i),root=i=>par[i]===i?i:(par[i]=root(par[i]));
    for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){const A=items[i],B=items[j];
      if(Math.hypot(A.cx-B.cx,A.cy-B.cy)<FAN_GAP*Math.max(A.d,B.d))par[root(i)]=root(j);}
    for(const t of items){t.ox=t.cx;t.oy=t.cy;t.w=t.el.offsetWidth||28;t.h=t.el.offsetHeight||28;}
    // place each group; when bubbles of two groups land on each other, merge the groups and place again
    for(let pass=0;pass<6;pass++){
      const groups=new Map();items.forEach((it,i)=>{const r=root(i);if(!groups.has(r))groups.set(r,[]);groups.get(r).push(it);});
      for(const g of groups.values()){
        const k=g.length;for(const t of g){t.cx=t.ox;t.cy=t.oy;}if(k<2)continue;
        const mx=g.reduce((s,t)=>s+t.ox,0)/k,my=g.reduce((s,t)=>s+t.oy,0)/k,D=Math.max(...g.map(t=>t.d));
        // an arc over the top, left to right in the markers' own order: bubbles stay above their points, so the
        // points themselves stay clickable
        const R=0.65*D/Math.sin(Math.PI/(2*(k-1)));
        g.sort((a,b)=>a.ox-b.ox||a.n-b.n);
        g.forEach((t,i)=>{const th=Math.PI+i*Math.PI/(k-1);t.cx=mx+R*Math.cos(th);t.cy=my+Math.min(0,R*Math.sin(th));});
      }
      let merged=false;
      for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){const A=items[i],B=items[j];
        if(root(i)!==root(j)&&Math.abs(A.cx-B.cx)<(A.w+B.w)/2+3&&Math.abs(A.cy-B.cy)<(A.h+B.h)/2+3){par[root(i)]=root(j);merged=true;}}
      if(!merged)break;
    }
    for(const t of items){const dx=t.cx-t.hx,dy=t.cy-t.hy;
      if(Math.abs(dx)+Math.abs(dy)>0.5){fan.set(t.id,{dx,dy,loop:t.loop});t.el.style.translate=`${dx.toFixed(1)}px ${dy.toFixed(1)}px`;}
      else if(fan.delete(t.id))t.el.style.translate='';}
  }
  function fanSigNow(){
    const c=V.cam;c.updateMatrixWorld();let s=c.matrixWorld.elements.map(x=>x.toFixed(3)).join()+'|'+c.zoom.toFixed(4)+'|'+V.host.clientWidth+'x'+V.host.clientHeight+'|'+(pinsShown||forceShow);
    for(const [id,o] of markers)s+='|'+id+(o.visible?1:0)+o.element.textContent;
    return s;
  }
  function fanTick(){
    const sig=fanSigNow();if(sig===fanSig)return;
    const t=performance.now(),live=markers.size<=FAN_LIVE_MAX;
    clearTimeout(fanTimer);
    fanTimer=setTimeout(()=>{fanTimer=0;fanSig=fanSigNow();fanLayout();V.dirty();},FAN_SETTLE_MS);
    if(live&&t-fanAt>=FAN_MS){fanLayout();fanSig=sig;}
  }
  // leaders from each moved bubble to its true point (or, for a small loop, the nearest point of the loop)
  function drawLeaders(){
    const g=$('pin-leaders');if(!g)return;g.replaceChildren();
    const W=V.host.clientWidth,H=V.host.clientHeight;
    for(const [id,f] of fan){
      const o=markers.get(id),p=S.pins.find(x=>x.id===id);if(!o||!o.visible||!p)continue;
      const a=screenOf(o,W,H);if(!a)continue;
      const h=o.element.offsetHeight||28,bx=a.x+f.dx,by=a.y-0.75*h+f.dy;let tx=a.x,ty=a.y;
      if(f.loop){const L=loopOf(p,W,H);if(L){let bd=Infinity;for(const [x,y] of L.pts){const d=Math.hypot(x-bx,y-by);if(d<bd){bd=d;tx=x;ty=y;}}}}
      const len=Math.hypot(tx-bx,ty-by),r=h/2;if(len<=r+1)continue;
      const sx=bx+(tx-bx)*r/len,sy=by+(ty-by)*r/len;
      for(const [w,c,cl] of [[4,'#ffffff','ld-halo'],[1.75,groupFill(classes,p.issue_class),'ld']]){
        const l=document.createElementNS('http://www.w3.org/2000/svg','line');
        l.setAttribute('x1',sx.toFixed(1));l.setAttribute('y1',sy.toFixed(1));l.setAttribute('x2',tx.toFixed(1));l.setAttribute('y2',ty.toFixed(1));
        l.setAttribute('stroke',c);l.setAttribute('stroke-width',w);l.setAttribute('class',cl);l.dataset.pin=id;g.append(l);}
    }
  }
  function setPinsShown(on){
    pinsShown=!!on;try{localStorage.setItem('aad-pins-shown',pinsShown?'1':'0');}catch(e){}
    const b=$('pins-vis');
    if(b){b.classList.toggle('on',pinsShown);b.setAttribute('aria-pressed',String(pinsShown));b.querySelector('.ic').className='ic '+(pinsShown?'i-map-pin':'i-map-pin-off');}
    $('pins-hidden').hidden=pinsShown;occSig='';V.dirty();
  }
  function showPins(){if(!pinsShown)setPinsShown(true);}
  $('pins-vis').onclick=()=>setPinsShown(!pinsShown);$('pins-show').onclick=()=>setPinsShown(true);
  // A pin whose point is behind other visible opaque geometry from the current camera draws dimmed with a dashed ring
  // (the selected pin stays solid; see-through parts do not count). One BVH ray per point pin when the view settles; with few pins also while it moves.
  const OCC_LIVE_MAX=24,OCC_SETTLE_MS=180,OCC_LIVE_MS=120;
  let occSig='',occAt=0,occTimer=0,occRuns=0;
  const _o=new THREE.Vector3(),_h=new THREE.Vector3();
  function occlusionSig(){
    const c=V.cam;c.updateMatrixWorld();let s=c.matrixWorld.elements.map(x=>x.toFixed(3)).join()+'|'+c.zoom.toFixed(4)+'|'+(V.clipSig?V.clipSig():'')+'|'+hotPin;
    for(const [id,o] of markers)if(o.visible&&o.userData.key){o.getWorldPosition(_o);s+='|'+id+_o.x.toFixed(2)+','+_o.y.toFixed(2)+','+_o.z.toFixed(2);}
    return s;
  }
  function occlusionTick(){
    const sig=occlusionSig();if(sig===occSig)return;
    const t=performance.now(),live=markers.size<=OCC_LIVE_MAX;
    clearTimeout(occTimer);
    occTimer=setTimeout(()=>{occTimer=0;const s=occlusionSig();runOcclusion();occSig=s;},OCC_SETTLE_MS);   // after the camera stops
    if(live&&t-occAt>=OCC_LIVE_MS){runOcclusion();occSig=sig;}
  }
  function markTitle(el){el.title=(el.dataset.title||'')+(el.classList.contains('cut')?'\n'+CUT_TITLE:'')+(el.classList.contains('occluded')?'\n'+OCC_TITLE:'');}
  function markOccluded(el,on){
    if(el.classList.contains('occluded')===on)return;
    el.classList.toggle('occluded',on);markTitle(el);
  }
  const occludedNow=id=>dimOcc&&occluded.has(id)&&id!==hotPin;
  function setDimOcc(on){
    dimOcc=!!on;try{localStorage.setItem('aad-dim-occluded',dimOcc?'1':'0');}catch(e){}
    $('opt-dim-occluded').checked=dimOcc;
    if(!dimOcc){occluded.clear();for(const [,o] of markers)markOccluded(o.element,false);}
    occSig='';V.dirty();
  }
  $('opt-dim-row').hidden=false;$('opt-dim-occluded').checked=dimOcc;$('opt-dim-occluded').onchange=e=>setDimOcc(e.target.checked);
  function runOcclusion(){
    occAt=performance.now();occRuns++;
    const r=V.canvas.getBoundingClientRect(),c=V.cam,eps=Math.max(0.3,V.bbox.getSize(_h).length()*0.002);let changed=false;
    for(const [id,o] of markers){
      let occ=false;
      if(o.visible&&o.userData.key&&r.width>0){
        o.getWorldPosition(_o);const p=_o.clone().project(c);
        if(p.z>=-1&&p.z<=1&&Math.abs(p.x)<=1&&Math.abs(p.y)<=1){
          // see-through parts (clear panels, an acrylic tube) never hide a pin: the nearest opaque hit decides
          const h=V.pickOpaque({clientX:r.left+(p.x+1)/2*r.width,clientY:r.top+(1-p.y)/2*r.height});
          if(h){const da=-_o.clone().applyMatrix4(c.matrixWorldInverse).z,dh=-_h.copy(h.point).applyMatrix4(c.matrixWorldInverse).z;occ=dh<da-eps;}
        }
      }
      if(!dimOcc)occ=false;
      if(occ!==occluded.has(id)){changed=true;if(occ)occluded.add(id);else occluded.delete(id);}
      markOccluded(o.element,occ&&id!==hotPin);
    }
    if(changed)V.dirty();
  }

  // ---- measurements ----
  // Entity-based (measure.js): each click takes a vertex, an edge or a face point, and a pair reads its true dimension
  // (edge to edge, vertex to edge, plane to plane, ...). The dimension line is drawn at the true shortest span with
  // the value as its label; the clicked points' distance, dX/dY/dZ and the angle are in the list row. Unattached
  // measurements are page state only (the undo history), never written to the project: a reload starts without
  // them. Attached ones live in their pin's `measure`. Graphics: shown in Measure mode or with Keep visible on;
  // an attached one also shows while its pin is selected.
  const MEAS=initMeasure(V);
  MEAS.setActive(()=>mode==='measure');
  let draft=null,measView=new Map();                          // measurement id -> {group, objs, box, item}
  function clearMeasDraft(){if(draft){draft.removeFromParent();draft.element.remove();draft=null;}V.dirty();}
  function drawMeasDraft(E){clearMeasDraft();if(!E)return;const el=document.createElement('div');el.className='measure-dot draft';draft=new CSS2DObject(el);draft.position.copy(E.world);V.scene.add(draft);V.dirty();}
  function measureClick(e,h,edge){
    if(!card.hidden&&dialogCtx)return false;
    const E=MEAS.pick(e,h,edge);
    if(!E){toast('Click on a part: an edge, a vertex or a face.',true,2500);return true;}
    if(!measA){measA=E;drawMeasDraft(E);toast(`First pick: ${MEAS.describe(E)}. Click the second; Esc cancels.`,false,3000);V.dirty();return true;}
    const r=MEAS.result(measA,E);
    const m={id:'m'+(S.meas.reduce((n,x)=>Math.max(n,+x.id.slice(1)),0)+1),...r,pin:null};
    S.meas.push(m);measA=null;clearMeasDraft();changed();
    toast(`${esc(r.label)}: <b>${m.distance.toFixed(2)} mm</b>${m.angle_deg?`, angle ${m.angle_deg.toFixed(2)} deg`:''}`,false,4000);
    return true;
  }
  let keepVis=false;
  function measModeChanged(){keepVis=mode==='measure';const k=$('meas-keep');if(k)k.checked=keepVis;MEAS.hideHover();V.dirty();}
  $('meas-keep').onchange=e=>{keepVis=e.target.checked;V.dirty();};
  const measShown=m=>m.pin?(pinsShown||forceShow)&&(keepVis||m.pin===hotPin):keepVis;   // attached ones follow the Pins toggle
  function deleteMeas(m){
    S.meas=S.meas.filter(x=>x!==m);for(const p of S.pins)if(p.measure&&p.measure.id===m.id){p.measure=null;p.updated=now();}
    changed();
  }
  // Delete or Backspace in Measure mode: the measurement under the pointer (its line, label or dots), else the last
  // unattached one made
  function measUnderPointer(){
    const P=MEAS.pointer;if(P.x==null)return null;const hr=V.host.getBoundingClientRect(),px=P.x-hr.left,py=P.y-hr.top;
    let best=null,bd=9;
    for(const m of S.meas){const mv=measView.get(m.id);if(!mv||!mv.group.visible)continue;
      const a=MEAS.toScreen(new THREE.Vector3(...m.a)),b=MEAS.toScreen(new THREE.Vector3(...m.b));
      const ax=a.x-hr.left,ay=a.y-hr.top,bx=b.x-hr.left,by=b.y-hr.top,dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
      const t=l2>0?Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2)):0;let d=Math.hypot(ax+t*dx-px,ay+t*dy-py);
      const s=mv.item.screen;if(s&&Math.abs(px-s.x)<=s.w/2&&Math.abs(py-s.y)<=s.h/2)d=0;
      if(d<bd){bd=d;best=m;}}
    return best;
  }
  function deleteMeasAtPointer(){
    const m=measUnderPointer()||[...S.meas].reverse().find(x=>!x.pin);
    if(!m){toast('No measurement to remove.',false,2000);return;}
    deleteMeas(m);toast(`Removed the ${m.distance.toFixed(2)} mm measurement. Undo brings it back.`,false,2500);
  }
  $('meas-clear').onclick=()=>{
    const gone=S.meas.filter(m=>!m.pin),kept=S.meas.length-gone.length;
    if(!gone.length){toast(kept?`Nothing to clear: the ${kept} attached measurement${kept===1?' stays':'s stay'} with ${kept===1?'its pin':'their pins'}.`:'No measurements.',false,3000);return;}
    S.meas=S.meas.filter(m=>m.pin);changed();
    toast(`Cleared ${gone.length} measurement${gone.length===1?'':'s'}${kept?`; ${kept} attached to pins stay with their pins`:''}. Undo brings them back.`,false,3500);
  };
  function measRow(m){
    const li=document.createElement('li');li.className='item meas';li.dataset.measure=m.id;
    const pin=m.pin&&S.pins.find(p=>p.id===m.pin);
    const opts=S.pins.map(p=>`<option value="${p.id}"${m.pin===p.id?' selected':''}>#${p.n} ${esc(label(p.issue_class))}</option>`).join('');
    const sec=[];
    if(m.kind&&m.kind!=='point_point'&&m.point_distance!=null)sec.push(`point to point ${m.point_distance.toFixed(2)} mm`);
    sec.push(`dX ${m.delta[0].toFixed(2)}, dY ${m.delta[1].toFixed(2)}, dZ ${m.delta[2].toFixed(2)}`);
    if(m.angle_deg)sec.push(`angle ${m.angle_deg.toFixed(2)} deg`);
    li.innerHTML=`<div class="r1"><b class="mval">${m.distance.toFixed(2)} mm</b><span class="mkind">${esc(m.label||'point to point')}</span>
        <span class="acts"><button data-act="delete" title="Delete this measurement (one undo step)" aria-label="Delete measurement"><i class="ic i-trash"></i></button></span></div>
      <div class="where msec">${esc(sec.join(', '))}</div>
      <div class="where">${esc(m.a_part?.node||'')} to ${esc(m.b_part?.node||'')}${pin?`; attached to pin #${pin.n}, stays with its pin`:''}</div>
      <div class="row2"><select data-act="pin" aria-label="Attach to pin"><option value="">attach to pin...</option>${opts}</select></div>`;
    li.querySelector('[data-act=delete]').onclick=e=>{e.stopPropagation();deleteMeas(m);};
    li.querySelector('select').onchange=e=>{const pid=e.target.value;for(const p of S.pins){if(p.measure&&p.measure.id===m.id)p.measure=null;}
      m.pin=pid||null;const p=S.pins.find(x=>x.id===pid);if(p){p.measure={...m};p.updated=now();}changed();};
    return li;
  }
  function renderMeas(){
    for(const o of [...measGroup.children]){o.traverse(x=>{if(x.element)x.element.remove();x.geometry?.dispose();});o.removeFromParent();}
    measView.clear();
    const ol=$('measure-list');ol.innerHTML='';
    for(const m of S.meas){
      const a=new THREE.Vector3(...m.a),b=new THREE.Vector3(...m.b),g=new THREE.Group();g.name='Measurement '+m.id;g.userData.measure=m.id;
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([a,b]),new THREE.LineBasicMaterial({color:0xffd43b,depthTest:false}));
      line.renderOrder=10;g.add(line);const objs=[];
      for(const p of [a,b]){const d=document.createElement('div');d.className='measure-dot';d.dataset.measure=m.id;const o=new CSS2DObject(d);o.position.copy(p);g.add(o);objs.push(o);}
      // the label is a positioned box inside the CSS2D anchor, so the layout can offset it in screen space
      const el=document.createElement('div');el.className='measure-anchor';const box=document.createElement('div');box.className='measure-label';box.dataset.measure=m.id;
      box.textContent=`${m.distance.toFixed(2)} mm`;el.append(box);
      const lo=new CSS2DObject(el);lo.position.copy(a.clone().add(b).multiplyScalar(0.5));g.add(lo);objs.push(lo);
      measGroup.add(g);measView.set(m.id,{group:g,objs,box,item:{a,b,box,dots:[a,b]}});
      ol.append(measRow(m));
    }
    const un=S.meas.filter(m=>!m.pin).length;$('meas-clear').disabled=!un;
    $('meas-count').textContent=S.meas.length?`${S.meas.length}${S.meas.length>un?`, ${S.meas.length-un} attached`:''}`:'';
    V.dirty();
  }
  // every frame before the labels draw: which measurements show, and where their labels sit
  function measBeforeLabels(){
    const items=[];
    for(const m of S.meas){const mv=measView.get(m.id);if(!mv)continue;const on=measShown(m);mv.group.visible=on;for(const o of mv.objs)o.visible=on;if(on)items.push(mv.item);}
    if(items.length)MEAS.layout(items);
  }

  // ---- scope lock ----
  function toggleScope(k){
    const ref=V.partRef(k);if(!ref)return;
    if(inScope(k))S.scope=S.scope.filter(p=>p.key!==k);else S.scope.push(ref);
    changed();
  }
  function renderScope(){
    const ul=$('scope-list');ul.innerHTML='';
    $('scope-sum').textContent=S.scope.length?`${S.scope.length} part${S.scope.length===1?'':'s'} may change in the next edit; everything else is locked.`:
      'No parts marked. Scope mode: click the parts the next edit may change; everything else is locked.';
    for(const p of S.scope){const li=document.createElement('li');li.className='item';
      li.innerHTML=`<div class="r1"><i class="ic i-lock-open"></i><span>${esc(V.nodes.get(p.key)?.leaf?.name||p.node)}</span><span class="acts"><button title="Lock again"><i class="ic i-x"></i></button></span></div>`;
      li.querySelector('button').onclick=e=>{e.stopPropagation();S.scope=S.scope.filter(x=>x!==p);changed();};
      li.onclick=()=>{const k=keyFor(p);if(k){V.select(k);V.camAction(()=>V.focusKey(k));V.commit();}};ul.append(li);}
    for(const [k,r] of V.nodes)if(r.el)r.el.classList.toggle('inscope',!!r.leaf&&inScope(k));
  }
  $('scope-clear').onclick=()=>{if(S.scope.length){S.scope=[];changed();}};

  // ---- Revisions (the Revisions tab): one list, newest first: the current build ("now"), then every earlier revision
  // the server keeps (the reviewed build, earlier builds, manifest versions), each with how many parts differ from
  // now. Clicking a row draws that revision over the current model as a green hologram (the differing parts, or the
  // whole old model) and lists what changed under it; clicking it again or Esc turns it off; hovering another row
  // previews it; arrow keys step through the list; holding \ or Show old swaps in the old revision solid. ----
  let revRows=[],revSel=null,revPre=null,revPeek=null,revKey='',revFetch=null,flick=false;
  const hhmm=iso=>{if(!iso)return '';const d=new Date(iso);return isNaN(d)?'':d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});};
  const reviewedChoice=()=>(server?.baselines||[]).find(b=>b.kind==='reviewed')||null;
  function revLabel(b){
    if(b.kind==='reviewed')return {t:hhmm(b.reviewed_at||b.created),lab:'what you reviewed',sub:`build ${b.build||''}, packet ${b.packet||''}`};
    if(b.kind==='version')return {t:'',lab:b.label.replace(/^version (.*) \(from the manifest\)$/,'version $1'),sub:'from the manifest'};
    return {t:hhmm(b.created),lab:/^previous/.test(b.label)?'previous build':'earlier build',sub:`build ${b.build||''}`};
  }
  async function loadRevisionCounts(){
    const key=(server?.build||'')+'|'+(server?.baselines||[]).map(b=>b.id).join('|');
    if(key===revKey&&revRows.length)return;revKey=key;
    const f=revFetch=getJSON('/review/revisions.json').catch(e=>({rows:[],error:e.message}));
    const r=await f;if(f!==revFetch)return;
    revRows=r.rows||[];$('rev-size').textContent=r.size_bytes!=null?`Stored revisions ${(r.size_bytes/1048576).toFixed(1)} MB`:'';
    if(r.keep!=null){keepNow=r.keep;const ki=$('rev-keep');if(document.activeElement!==ki)ki.value=r.keep;
      if(!keepSynced){keepSynced=true;const want=readKeep();if(want&&want!==r.keep){setKeep(want,false);return;}}}
    renderBaselines();
  }
  // Stored builds to keep: the server default (AAD_KEEP_BUILDS or 10) until the reviewer sets it here; the value is kept in
  // this browser and sent to the server on every load, so no environment variable is needed
  const KEEP_KEY='aad-keep-builds';let keepSynced=false,keepNow=null;
  const readKeep=()=>{try{const v=Number(localStorage.getItem(KEEP_KEY));return Number.isInteger(v)&&v>=1&&v<=50?v:null;}catch(e){return null;}};
  async function setKeep(n,remember){
    const ki=$('rev-keep');
    if(!Number.isInteger(n)||n<1||n>50){toast('Stored builds to keep is a whole number from 1 to 50.',true,3000);if(keepNow!=null)ki.value=keepNow;return;}
    let r;try{r=await post('/review/revisions/keep',{keep:n});}catch(e){return;}
    if(remember){try{localStorage.setItem(KEEP_KEY,String(n));}catch(e){}}
    ki.value=keepNow=r.keep;if(server)server.baselines=r.baselines;revKey='';renderBaselines();
  }
  $('rev-keep').addEventListener('change',e=>setKeep(Number(e.target.value),true));
  function renderBaselines(){
    const ol=$('rev-list');if(!ol)return;const bl=server?.baselines||[],cnt=new Map(revRows.map(r=>[r.id,r]));
    if(revSel&&!bl.some(b=>b.id===revSel))holoOff(false);
    if(revPre&&!bl.some(b=>b.id===revPre))revPre=null;
    let h=`<li class="now" data-rev=""><div class="r1"><span class="t">now</span><span class="lab">current build</span></div><div class="sub">build ${esc(server?.build||'')}</div></li>`;
    for(const b of bl){const L=revLabel(b),c=cnt.get(b.id),n=c?.differ;
      const cls=[b.id===revSel?'sel':'',b.id===revPre?'pre':'',b.id===revPeek?'peek':'',holoLoading===b.id?'loading':''].filter(Boolean).join(' ');
      h+=`<li class="${cls}" data-rev="${esc(b.id)}" role="option" aria-selected="${b.id===revSel}" title="${esc(b.label)}"><div class="r1"><span class="t">${esc(L.t)}</span><span class="lab">${esc(L.lab)}</span></div>
        <div class="sub">${n==null?(c?'not readable':'counting...'):n===0?'same as now':`${n} part${n===1?' differs':'s differ'} from now`}${L.sub?', '+esc(L.sub):''}</div></li>`;}
    if(!bl.length)h+=`<li class="now"><div class="sub">No earlier revision yet: one appears after a rebuild or a packet.</div></li>`;
    ol.innerHTML=h;
    ol.querySelectorAll('li[data-rev]').forEach(li=>{const id=li.dataset.rev;if(!id)return;
      li.onclick=()=>{clearTimeout(peekT);revPeek=null;if(revSel===id)holoOff();else selectRev(id);};
      li.onmouseenter=()=>{clearTimeout(peekT);if(id!==revSel)peekT=setTimeout(()=>peekRev(id),350);};
      li.onmouseleave=()=>{clearTimeout(peekT);if(revPeek===id)peekRev(null);};});
    loadRevisionCounts();
  }
  let peekT=0;
  async function peekRev(id){revPeek=id;await showHolo(id||revSel);renderBaselines();}
  async function selectRev(id,auto=false){
    revSel=id;revPre=id;renderBaselines();
    const d=await runDiff(id,auto);
    if(revSel===id)await showHolo(id);
    return d;
  }
  function holoOff(render=true){revSel=null;revPeek=null;setFlick(false);showHolo(null);if(render)renderBaselines();}
  $('rev-list').addEventListener('keydown',e=>{
    const ids=(server?.baselines||[]).map(b=>b.id);if(!ids.length)return;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();
      const i=ids.indexOf(revSel??revPre),n=e.key==='ArrowDown'?Math.min(ids.length-1,i+1):Math.max(0,i<0?0:i-1);selectRev(ids[n]);}
    else if(e.key==='Enter'&&!revSel&&revPre){e.preventDefault();selectRev(revPre);}
  });
  $('rev-whole').onchange=()=>showHolo(revPeek||revSel);
  $('rev-more-btn').onclick=()=>{const o=$('rev-more').hidden;$('rev-more').hidden=!o;$('rev-more-btn').setAttribute('aria-expanded',String(o));};
  $('rev-clear').onclick=async()=>{
    try{const r=await post('/review/revisions/clear',{});server.baselines=r.baselines;revKey='';renderBaselines();
      toast(`Cleared ${r.removed.length} old revision${r.removed.length===1?'':'s'}; reviewed ones and the current build stay.`);}catch(e){}};
  // the hologram: green feature edges (the same EdgesGeometry crease edges as the Edges display) plus the
  // silhouette of curved surfaces for the current view, bright where seen and dimmer through the solid model, over
  // faint additive faces. No tessellation wireframe: flat faces show no triangle diagonals. Line depth is pulled a
  // hair toward the camera so old edges that lie on the new surface do not shimmer; faces skip the depth test. On a
  // light background it is a darker green with normal blending (additive green washes out on white).
  const holo=new THREE.Group();holo.name='Revision hologram';holo.visible=false;V.scene.add(holo);
  const oldSolid=new THREE.Group();oldSolid.name='Old revision (flick)';oldSolid.visible=false;V.scene.add(oldSolid);
  let holoKey='',holoDark=null,holoLoading=null,holoCompiled=null;
  const revCache=new Map();                                    // revision id -> Promise of Map(part name -> [{geometry, matrix}])
  const edgeCache=new WeakMap(),silCache=new WeakMap();
  // silhouette candidates of a geometry: the smooth edges (two faces meeting under the 35 degree crease angle, not
  // coplanar) with both face normals; an edge is on the silhouette when one face looks at the camera and the other
  // looks away. Vertices are welded by position, since GLB meshes split them at UV and normal seams.
  const SIL_MAX_TRIS=400000,COS_CREASE=Math.cos(35*Math.PI/180);
  function silData(geo){
    if(silCache.has(geo))return silCache.get(geo);
    const pos=geo.attributes.position,idx=geo.index,nt=idx?idx.count/3:pos.count/3;let out=null;
    if(nt<=SIL_MAX_TRIS){
      const weld=new Map(),vid=new Int32Array(pos.count),P=[];let q=0;
      const bb=(geo.boundingBox||(geo.computeBoundingBox(),geo.boundingBox)),tol=Math.max(1e-6,bb.getSize(new THREE.Vector3()).length()*1e-6);
      for(let i=0;i<pos.count;i++){const k=Math.round(pos.getX(i)/tol)+','+Math.round(pos.getY(i)/tol)+','+Math.round(pos.getZ(i)/tol);
        let id=weld.get(k);if(id===undefined){id=q++;weld.set(k,id);P.push(pos.getX(i),pos.getY(i),pos.getZ(i));}vid[i]=id;}
      const FN=new Float32Array(nt*3),edges=new Map(),a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
      for(let t=0;t<nt;t++){
        const v=[0,1,2].map(j=>vid[idx?idx.getX(3*t+j):3*t+j]);
        a.fromArray(P,v[0]*3);b.fromArray(P,v[1]*3);c.fromArray(P,v[2]*3);c.sub(b);b.sub(a);b.cross(c);const L=b.length();
        if(L<1e-12)continue;b.divideScalar(L);FN[3*t]=b.x;FN[3*t+1]=b.y;FN[3*t+2]=b.z;
        for(let j=0;j<3;j++){const u=v[j],w=v[(j+1)%3];if(u===w)continue;const key=u<w?u*q+w:w*q+u,e=edges.get(key);
          if(e===undefined)edges.set(key,[u,w,t,-1]);else if(e[3]===-1)e[3]=t;else e[3]=-2;}
      }
      const A=[],N=[];
      for(const [u,w,f1,f2] of edges.values()){
        if(f2<0)continue;const d=FN[3*f1]*FN[3*f2]+FN[3*f1+1]*FN[3*f2+1]+FN[3*f1+2]*FN[3*f2+2];
        if(d<COS_CREASE||d>0.99999)continue;                  // creases are feature edges already; coplanar never turn
        A.push(P[3*u],P[3*u+1],P[3*u+2],P[3*w],P[3*w+1],P[3*w+2]);N.push(FN[3*f1],FN[3*f1+1],FN[3*f1+2],FN[3*f2],FN[3*f2+1],FN[3*f2+2]);
      }
      if(A.length)out={A:new Float32Array(A),N:new Float32Array(N)};
    }
    silCache.set(geo,out);return out;
  }
  const silObjs=[],_inv=new THREE.Matrix4(),_eye=new THREE.Vector3(),_dir=new THREE.Vector3();let silSig='';
  function updateSilhouettes(camera){
    if(!holo.visible||!silObjs.length)return;
    const sig=camera.matrixWorld.elements.join(',')+(camera.isOrthographicCamera?'o':'p');if(sig===silSig)return;silSig=sig;
    for(const o of silObjs){
      const {A,N}=o.userData.sil,out=o.geometry.attributes.position.array;
      _inv.copy(o.matrix).invert();const ortho=camera.isOrthographicCamera;
      if(ortho){camera.getWorldDirection(_dir);_dir.transformDirection(_inv);}else _eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inv);
      let k=0;
      for(let e=0,n=A.length/6;e<n;e++){
        const i=6*e;let vx,vy,vz;
        if(ortho){vx=_dir.x;vy=_dir.y;vz=_dir.z;}else{vx=(A[i]+A[i+3])/2-_eye.x;vy=(A[i+1]+A[i+4])/2-_eye.y;vz=(A[i+2]+A[i+5])/2-_eye.z;}
        const d1=N[i]*vx+N[i+1]*vy+N[i+2]*vz,d2=N[i+3]*vx+N[i+4]*vy+N[i+5]*vz;
        if(d1*d2<=0&&(d1!==0||d2!==0)){for(let j=0;j<6;j++)out[k+j]=A[i+j];k+=6;}
      }
      o.geometry.setDrawRange(0,k/3);o.geometry.attributes.position.needsUpdate=true;o.userData.silCount=k/6;
    }
  }
  {const prev=V.scene.onBeforeRender;V.scene.onBeforeRender=function(r,sc,cam,...rest){if(prev)prev.call(this,r,sc,cam,...rest);updateSilhouettes(cam);};}
  const bias=m=>{m.onBeforeCompile=sh=>{sh.vertexShader=sh.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\n  gl_Position.z-=3e-6*gl_Position.w;');};m.customProgramCacheKey=()=>'holo-bias';return m;};
  const HM={};
  function holoMats(dark){
    const add=dark?THREE.AdditiveBlending:THREE.NormalBlending,col=new THREE.Color(dark?'#39ff88':'#0b7a37');
    for(const m of Object.values(HM))m.dispose();
    HM.edge=bias(new THREE.LineBasicMaterial({color:col,transparent:true,opacity:1,blending:add,depthWrite:false}));
    HM.hidden=new THREE.LineBasicMaterial({color:col,transparent:true,opacity:dark?0.3:0.35,blending:add,depthWrite:false,depthTest:false});
    HM.face=new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:dark?0.04:0.05,blending:add,depthWrite:false,depthTest:false,side:THREE.DoubleSide});
    HM.solid=new THREE.MeshStandardMaterial({color:'#9fd8b4',roughness:0.7,metalness:0.05,side:THREE.DoubleSide});
    holoDark=dark;
    // compile the hologram's programs off the critical path: showing a large hologram then only uploads geometry
    if(V.compileAsync){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(9),3));
      const d=new THREE.Group();d.add(new THREE.Mesh(g,HM.face),new THREE.LineSegments(g,HM.hidden),new THREE.LineSegments(g,HM.edge));holoCompiled=V.compileAsync(d).finally(()=>g.dispose());}
    const MK={sil:'edge',silHidden:'hidden'};holo.traverse(o=>{if(o.userData.holo)o.material=HM[MK[o.userData.holo]||o.userData.holo];});oldSolid.traverse(o=>{if(o.isMesh)o.material=HM.solid;});
  }
  const darkBg=()=>V.host.classList.contains('dark-bg');
  function loadRev(id){
    if(revCache.has(id))return revCache.get(id);
    const p=(async()=>{
      const out=new Map(),loader=new GLTFLoader();
      const nf=(server?.baselines||[]).find(b=>b.id===id)?.files||1;
      for(let i=0;i<nf;i++){
        const r=await V.fetch(`/review/baseline/${encodeURIComponent(id)}/models/${i}`);if(!r.ok)break;
        const buf=await r.arrayBuffer();if(new TextDecoder().decode(new Uint8Array(buf,0,4))!=='glTF')continue;
        const g=await loader.parseAsync(buf,''),js=g.parser.json,seen=new Map();
        g.scene.updateMatrixWorld(true);
        g.scene.traverse(o=>{if(!o.isMesh)return;const a=g.parser.associations.get(o);
          let nm=(a&&a.nodes!==undefined&&js.nodes[a.nodes]?.name)||o.name;
          if(!a||a.nodes===undefined){const pa=g.parser.associations.get(o.parent);if(pa&&pa.nodes!==undefined)nm=js.nodes[pa.nodes].name||nm;}
          const c=seen.get(nm)||0;seen.set(nm,c+1);const key=c?`${nm} #${c+1}`:nm;
          if(!out.has(key))out.set(key,[]);out.get(key).push({geometry:o.geometry,matrix:o.matrixWorld.clone()});});
      }
      return out;
    })();
    revCache.set(id,p);
    while(revCache.size>3){const [k,v]=revCache.entries().next().value;revCache.delete(k);
      if(k!==id)v.then(m=>{for(const l of m.values())for(const x of l){x.geometry.dispose();}}).catch(()=>{});}
    p.catch(()=>revCache.delete(id));
    return p;
  }
  function clearGroup(g){for(const o of [...g.children]){o.removeFromParent();if(o.userData.holo==='sil'||o.userData.holo==='silHidden'){if(o.userData.holo==='sil')o.geometry.dispose();}}
    if(g===holo){silObjs.length=0;silSig='';}}
  async function showHolo(id){
    if(!id){holo.visible=false;holoKey='';clearGroup(holo);V.dirty();return;}
    const row=revRows.find(r=>r.id===id),whole=$('rev-whole').checked;
    const key=id+'|'+whole+'|'+(row?.parts||[]).join(',');
    if(key===holoKey){holo.visible=!flick;V.dirty();return;}
    holoLoading=id;renderBaselines();
    let parts;try{parts=await loadRev(id);}catch(e){holoLoading=null;toast('Could not load that revision: '+esc(e.message),true);renderBaselines();return;}
    holoLoading=null;
    if((revPeek||revSel)!==id){renderBaselines();return;}                 // another row was picked meanwhile
    if(holoDark===null||holoDark!==darkBg())holoMats(darkBg());
    clearGroup(holo);
    const want=whole?null:new Set(row?.parts||(diff&&diff.a.id===id?diff.parts.filter(r=>['changed','moved','removed'].includes(r.status)).map(r=>r.name):[]));
    // large model mode (view.js): crease edges built in the background, no silhouettes
    const large=!!V.largeMode?.();
    if(large){
      const need=[];for(const [name,list] of parts){if(want&&!want.has(name))continue;for(const {geometry} of list)if(!edgeCache.has(geometry)&&!need.includes(geometry))need.push(geometry);}
      if(need.length){
        holoLoading=id;renderBaselines();
        const arrs=await Promise.all(need.map(g=>V.edgesAsync(g,35)));
        need.forEach((g,i)=>{const e=new THREE.BufferGeometry();e.setAttribute('position',new THREE.BufferAttribute(arrs[i],3));edgeCache.set(g,e);});
        if(holoCompiled)await holoCompiled;
        holoLoading=null;
        if((revPeek||revSel)!==id){renderBaselines();return;}
        clearGroup(holo);
      }
    }
    for(const [name,list] of parts){
      if(want&&!want.has(name))continue;
      for(const {geometry,matrix} of list){
        const add=(obj,kind,order)=>{obj.matrixAutoUpdate=false;obj.matrix.copy(matrix);obj.userData.holo=kind;obj.userData.holoOf=name;obj.renderOrder=order;obj.raycast=()=>{};holo.add(obj);};
        let eg=edgeCache.get(geometry);if(!eg){eg=new THREE.EdgesGeometry(geometry,35);edgeCache.set(geometry,eg);}
        add(new THREE.Mesh(geometry,HM.face),'face',20);
        add(new THREE.LineSegments(eg,HM.hidden),'hidden',21);add(new THREE.LineSegments(eg,HM.edge),'edge',22);
        const sd=large?null:silData(geometry);
        if(sd){const sg=new THREE.BufferGeometry();sg.setAttribute('position',new THREE.BufferAttribute(new Float32Array(sd.A.length),3).setUsage(THREE.DynamicDrawUsage));
          sg.setDrawRange(0,0);sg.boundingSphere=geometry.boundingSphere||(geometry.computeBoundingSphere(),geometry.boundingSphere);
          for(const [mat,kind,order] of [[HM.hidden,'silHidden',21],[HM.edge,'sil',22]]){const o=new THREE.LineSegments(sg,mat);o.frustumCulled=false;o.userData.sil=sd;add(o,kind,order);}
          silObjs.push(holo.children[holo.children.length-1]);}
      }
    }
    holoKey=key;holo.visible=!flick;silSig='';renderBaselines();V.dirty();
  }
  // flick: while held, the old revision solid replaces the current model; release brings the current model back
  async function setFlick(on){
    const id=revPeek||revSel||revPre;
    if(on&&!id){toast('Pick a revision first.',true,2500);return;}
    flick=!!on;$('rev-flick').classList.toggle('on',flick);
    if(flick){
      const parts=await loadRev(id);if(!flick)return;
      if(holoDark===null)holoMats(darkBg());
      if(oldSolid.userData.rev!==id){clearGroup(oldSolid);
        for(const list of parts.values())for(const {geometry,matrix} of list){const m=new THREE.Mesh(geometry,HM.solid);m.matrixAutoUpdate=false;m.matrix.copy(matrix);m.raycast=()=>{};oldSolid.add(m);}
        oldSolid.userData.rev=id;}
    }
    oldSolid.visible=flick;if(V.modelRoot)V.modelRoot.visible=!flick;holo.visible=!flick&&!!holoKey;V.dirty();
  }
  const flickBtn=$('rev-flick');
  flickBtn.addEventListener('pointerdown',e=>{e.preventDefault();flickBtn.setPointerCapture?.(e.pointerId);setFlick(true);});
  for(const ev of ['pointerup','pointercancel','lostpointercapture'])flickBtn.addEventListener(ev,()=>{if(flick)setFlick(false);});
  flickBtn.addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat){e.preventDefault();setFlick(true);}});
  flickBtn.addEventListener('keyup',e=>{if(e.key===' '||e.key==='Enter')setFlick(false);});
  const typingIn=t=>t&&(t.tagName==='TEXTAREA'||(t.tagName==='INPUT'&&!['checkbox','radio','range'].includes(t.type))||t.isContentEditable);
  addEventListener('keydown',e=>{if(e.key==='\\'&&!e.repeat&&!e.metaKey&&!e.ctrlKey&&!typingIn(e.target)){e.preventDefault();setFlick(true);}});
  addEventListener('keyup',e=>{if(e.key==='\\'&&flick)setFlick(false);});
  addEventListener('blur',()=>{if(flick)setFlick(false);});
  // keep the hologram readable when the background changes between light and dark
  function holoTheme(){if(holo.visible&&holoDark!==null&&holoDark!==darkBg()){holoMats(darkBg());V.dirty();}}

  async function runDiff(against,auto=false){
    if(!against){toast('No baseline to compare against yet.',true);return null;}
    $('diff-out').innerHTML='<p class="hint">Comparing...</p>';
    try{diff=await getJSON('/review/diff.json?against='+encodeURIComponent(against));}
    catch(e){$('diff-out').innerHTML=`<p class="hint">${esc(e.message)}</p>`;return null;}
    diffByNode=new Map(diff.parts.map(r=>[r.name,r]));clearEvidence();
    if(diff.reopened?.length){await loadState(true);rerender();toast(`${diff.reopened.length} resolved pin(s) reopened: their part changed again.`,true);}
    renderDiff(auto);V.retint();
    if($('diff-ghost').checked)await loadGhost(against);
    return diff;
  }
  $('diff-tint').onchange=()=>V.retint();
  $('diff-all').onchange=()=>renderDiff();
  $('diff-ghost').onchange=async()=>{if($('diff-ghost').checked){await loadGhost(diff?.a?.id||revSel||revPre);}ghost.visible=$('diff-ghost').checked;V.dirty();};
  function renderDiff(auto=false){
    const out=$('diff-out');if(!diff){out.innerHTML='';return;}
    const s=diff.summary,col=diff.collateral,nk=nodeKey();
    $('diff-count').textContent=String(s.changed+s.moved+s.added+s.removed||'');$('diff-count').classList.toggle('bad',col.length>0);
    // a part outside the scope lock that changed but carries the reviewer's open pin (when the packet was sent) asked
    // for that change: its own amber group, never counted as collateral
    const po=diff.pinned_outside_scope||[],pinNums=rs=>{const ns=[...new Set(rs.flatMap(r=>r.pins||[]))].sort((a,b)=>a-b);return (ns.length===1?'pin ':'pins ')+ns.map(n=>'#'+n).join(', ');};
    let h=keepBanner(diff);                                        // keep pins whose neighbourhood changed, first
    if(diff.keep?.length)$('diff-count').classList.add('bad');
    const pname=n=>{const k=nk.get(n);return k?(V.nodes.get(k).leaf?.name||n):n;};
    if(diff.scope!=null&&col.length)h+=`<div class="banner"><b>COLLATERAL: ${col.length} part${col.length===1?'':'s'} changed outside the scope lock</b><ul>${col.slice(0,12).map(n=>`<li>${esc(pname(n))}</li>`).join('')}</ul></div>`;
    if(diff.scope!=null&&po.length)h+=`<div class="banner pinned"><b>Changed, outside the scope lock, pinned by you (${esc(pinNums(po))})</b><ul>${po.slice(0,12).map(r=>`<li>${esc(pname(r.name))} <span class="muted">${esc(pinNums([r]))}</span></li>`).join('')}</ul></div>`;
    if(diff.scope!=null&&!col.length&&!po.length)h+=`<div class="banner ok">No collateral: every change is inside the scope lock (${diff.scope.length} part${diff.scope.length===1?'':'s'}).</div>`;
    h+=`<div class="diffhead"><span class="chip ${diff.a.kind==='reviewed'?'reviewed':''}">${diff.a.kind==='reviewed'?'old vs fixed':esc(diff.a.kind||'baseline')}</span>
      <span>Now against <b>${esc(diff.a.label)}</b></span></div>
      <div class="counts"><span class="chip changed">${s.changed} changed</span><span class="chip moved">${s.moved} moved</span><span class="chip added">${s.added} added</span><span class="chip removed">${s.removed} removed</span>${s.warnings?`<span class="chip warn">${s.warnings} warnings</span>`:''}</div><ol id="diff-list">`;
    for(const r of diff.parts){
      if(r.status==='unchanged'&&!$('diff-all').checked)continue;
      const d=r.delta,k=nk.get(r.name);
      h+=`<li class="item" data-part="${esc(r.name)}"><div class="r1"><span class="chip ${r.status}">${r.status}</span>${r.collateral?'<span class="chip collateral">COLLATERAL</span>':''}${r.pinned_outside_scope?`<span class="chip pinnedout" title="Outside the scope lock, but your open pin asked for this change">pinned by you, ${esc(pinNums([r]))}</span>`:''}${r.in_scope?'<span class="chip added">in scope</span>':''}
        <span class="cls">${esc(k?(V.nodes.get(k).leaf?.name||r.name):r.name)}</span></div>
        ${d?`<div class="where">centroid shift ${d.distance.toFixed(2)} mm, volume ${d.volume>=0?'+':''}${d.volume.toFixed(1)} mm3, triangles ${d.tris>=0?'+':''}${d.tris}</div>`:''}
        ${r.warnings.map((w,i)=>`<div class="warnrow${evSel===r.name+'|'+i?' on':''}" data-warn="${esc(r.name)}|${i}" role="button" tabindex="0" title="Show where: fly to it, select the part and mark the evidence"><span class="chip warn">${esc(w.kind.replace('_',' '))}</span>${w.hint?'<span class="chip hint">mesh hint</span>':''}<span class="wmsg">${esc(w.message)}</span><button class="wpin" data-wpin="${esc(r.name)}|${i}" title="Drop a ${esc(label(WARN_CLASS[w.kind]||'weird_geometry'))} pin here"><i class="ic i-map-pin"></i>Pin this</button></div>`).join('')}</li>`;
    }
    h+='</ol>';
    if(diff.warnings.length)h+=`<p class="hint">Detector warnings are hints from the meshes, not errors. Click one to see where it is.</p>`;
    out.innerHTML=h;
    out.querySelectorAll('[data-warn]').forEach(el=>{
      const go=e=>{e.stopPropagation();const [n,i]=splitWarn(el.dataset.warn);showEvidence(n,i);};
      el.onclick=go;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go(e);}};});
    out.querySelectorAll('[data-wpin]').forEach(b=>b.onclick=e=>{e.stopPropagation();const [n,i]=splitWarn(b.dataset.wpin);pinWarning(n,i);});
    out.querySelectorAll('[data-part]').forEach(li=>li.onclick=()=>{const k=nk.get(li.dataset.part);if(k){V.select(k);V.camAction(()=>V.focusKey(k));V.commit();}
      else if(diff?.a?.id&&revSel!==diff.a.id)selectRev(diff.a.id);});
  }
  // ---- detector evidence: a warning row flies to the spot, selects the part and marks what the detector saw, from
  // the diff's own evidence (part-local mm, aad.review.detectors): a thin wall's ray origin and far point as two
  // dots with a dimension line and the measured value, its two triangles tinted; sliver triangles or a loose shell
  // tinted; a floating part outlined. The marks are children of the part's mesh, so they follow explode and moves.
  // Pin this opens the pin card at the spot with the matching class and the warning as its note. Esc, another row or a
  // new diff clears them. ----
  const WARN_CLASS={thin_feature:'printability',slivers:'weird_geometry',new_components:'weird_geometry',floating:'floating_unsupported',triangle_jump:'weird_geometry'};
  const evGroup=new THREE.Group();evGroup.name='Detector evidence';let evSel=null,evMesh=null;
  const splitWarn=s=>{const i=s.lastIndexOf('|');return [s.slice(0,i),+s.slice(i+1)];};
  const warnOf=(name,i)=>diff?.parts.find(r=>r.name===name)?.warnings?.[i]||null;
  function clearEvidence(){
    if(evGroup.parent)evGroup.removeFromParent();
    for(const o of [...evGroup.children]){o.traverse(x=>{if(x.element)x.element.remove();x.geometry?.dispose();x.material?.dispose?.();});o.removeFromParent();}
    const had=!!evSel;evSel=null;evMesh=null;document.querySelectorAll('#diff-list .warnrow.on').forEach(e=>e.classList.remove('on'));if(had)V.dirty();return had;
  }
  const triGeo=flat=>{const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(flat),3));return g;};
  function tint(flat,color,opacity=0.55){
    const m=new THREE.Mesh(triGeo(flat),new THREE.MeshBasicMaterial({color,transparent:true,opacity,side:THREE.DoubleSide,depthTest:false,depthWrite:false}));
    m.renderOrder=30;m.raycast=()=>{};m.userData.evidence='tint';return m;
  }
  function dot(p,cls){const d=document.createElement('div');d.className='measure-dot evidence '+cls;const o=new CSS2DObject(d);o.position.set(...p);o.userData.evidence='dot';return o;}
  // where the evidence is (part-local box), for the camera
  function evidenceBox(w){
    const e=w.evidence||{},b=new THREE.Box3(),v=new THREE.Vector3();
    const add=f=>{for(let i=0;i+2<f.length;i+=3)b.expandByPoint(v.set(f[i],f[i+1],f[i+2]));};
    if(e.origin){add(e.origin);add(e.hit);add(e.origin_tri||[]);add(e.hit_tri||[]);}
    else if(e.tris)add(e.tris);else if(e.corners)add(e.corners);
    return b;
  }
  function showEvidence(name,i){
    const w=warnOf(name,i),k=nodeKey().get(name);clearEvidence();
    if(!w||!k){toast('That part is not in this build.',true,2500);return;}
    const mesh=meshOf(k),e=w.evidence||{};evSel=name+'|'+i;evMesh=mesh;
    if(e.origin&&e.hit){                                          // thin wall
      evGroup.add(tint([...(e.origin_tri||[]),...(e.hit_tri||[])],0xff4d4f,0.6));
      const a=new THREE.Vector3(...e.origin),b=new THREE.Vector3(...e.hit);
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([a,b]),new THREE.LineBasicMaterial({color:0xffd43b,depthTest:false}));
      line.renderOrder=31;line.raycast=()=>{};evGroup.add(line,dot(e.origin,'origin'),dot(e.hit,'hit'));
      const el=document.createElement('div');el.className='measure-anchor';const lb=document.createElement('div');lb.className='measure-label evidence';
      lb.textContent=`${(+(e.thickness??w.value)).toFixed(2)} mm`;el.append(lb);const lo=new CSS2DObject(el);lo.position.copy(a.clone().add(b).multiplyScalar(0.5));
      lb.style.translate='12px -50%';evGroup.add(lo);
    }else if(e.tris?.length)evGroup.add(tint(e.tris,w.kind==='slivers'?0xd946ef:0xff4d4f,0.7));
    else if(w.kind==='floating'||!e.tris){                        // the part itself: its crease edges, bright and on top
      const ln=new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry,35),new THREE.LineBasicMaterial({color:0xff4d4f,depthTest:false,transparent:true}));
      ln.renderOrder=31;ln.raycast=()=>{};evGroup.add(ln);
    }
    mesh.add(evGroup);
    V.select(k);
    const lb=evidenceBox(w);
    V.camAction(()=>{if(lb.isEmpty()||w.kind==='floating'||w.kind==='triangle_jump')V.focusKey(k);
      else{mesh.updateMatrixWorld();const wb=lb.clone().applyMatrix4(mesh.matrixWorld);
        V.showTarget({keys:[k],box:wb,kind:'evidence'});}});
    V.commit();
    document.querySelectorAll('#diff-list .warnrow').forEach(el=>el.classList.toggle('on',el.dataset.warn===evSel));
    V.dirty();
  }
  // Pin this: the pin card at the evidence spot (thin wall: the ray origin on the surface; slivers or a shell: their
  // largest triangle's centre; floating or a triangle jump: a region pin of the part), class and note filled in
  function pinWarning(name,i){
    const w=warnOf(name,i),k=nodeKey().get(name);if(!w||!k){toast('That part is not in this build.',true,2500);return;}
    if(evSel!==name+'|'+i)showEvidence(name,i);
    const mesh=meshOf(k),e=w.evidence||{},cls=WARN_CLASS[w.kind]||'weird_geometry',note=`Detector ${w.kind.replace('_',' ')}${w.hint?' (mesh hint)':''}: ${w.message}`;
    let local=null,nrm=null;
    if(e.origin){local=new THREE.Vector3(...e.origin);const t=e.origin_tri;if(t?.length===9)nrm=new THREE.Vector3(t[3]-t[0],t[4]-t[1],t[5]-t[2]).cross(new THREE.Vector3(t[6]-t[0],t[7]-t[1],t[8]-t[2])).normalize();}
    else if(e.tris?.length>=9){const t=e.tris;local=new THREE.Vector3((t[0]+t[3]+t[6])/3,(t[1]+t[4]+t[7])/3,(t[2]+t[5]+t[8])/3);
      nrm=new THREE.Vector3(t[3]-t[0],t[4]-t[1],t[5]-t[2]).cross(new THREE.Vector3(t[6]-t[0],t[7]-t[1],t[8]-t[2])).normalize();}
    if(!local){openDialog({kind:'region',keys:[k],issue_class:cls,note,title:'Pin this warning'});return;}
    mesh.updateMatrixWorld();const world=local.clone().applyMatrix4(mesh.matrixWorld);
    openDialog({kind:'point',info:V.pickInfo({object:mesh,point:world,face:nrm?{normal:nrm}:null}),issue_class:cls,note,title:'Pin this warning'});
  }
  // the baseline's shapes of every part that is not unchanged, translucent orange (More > Ghost baseline, and the
  // tour's before shapes); the geometry comes from the same revision cache as the hologram
  async function loadGhost(against){
    if(!against||!diff)return;
    const want=new Set(diff.parts.filter(r=>r.status!=='unchanged'&&r.status!=='added').map(r=>r.name));
    const gk=against+'|'+[...want].sort().join('|');
    if(ghostKey===gk){ghost.visible=true;V.dirty();return;}
    for(const o of [...ghost.children])o.removeFromParent();
    const mat=new THREE.MeshBasicMaterial({color:0xff7b29,transparent:true,opacity:0.28,depthWrite:false,side:THREE.DoubleSide});
    const parts=await loadRev(against);
    for(const [key,list] of parts){if(!want.has(key))continue;
      for(const {geometry,matrix} of list){const m=new THREE.Mesh(geometry,mat);m.matrixAutoUpdate=false;m.matrix.copy(matrix);m.userData.ghostOf=key;m.raycast=()=>{};ghost.add(m);}}
    ghostKey=gk;ghost.visible=$('diff-ghost').checked||tourOn;V.dirty();
  }
  function tintFor(key){
    if(!key)return null;
    if(tourOn&&tourIdx>=0){const st=server?.tour?.stops?.[tourIdx];if(st&&st.parts.some(p=>p===key||nodeKey().get(p)===key))return {c:C.tour,i:0.6};}
    if(mode==='scope'&&inScope(key))return {c:C.scope,i:0.55};
    if(diff&&$('diff-tint').checked){
      const n=V.nodes.get(key)?.leaf?.node,r=n&&diffByNode.get(n);
      if(r&&r.status!=='unchanged')return {c:r.collateral?C.collateral:C[r.status]||C.changed,i:0.5};
    }
    return null;
  }

  // ---- tour ----
  // A stop shows its parts: the camera fits them (view.js fitParts: the current direction, or the clearest axis view
  // when they would be hidden), every other part fades (a focus look, not a visibility change: no checkbox, no undo
  // step; pins on faded parts fade too) and the stop's parts are outlined. Show whole model turns the fade off. Leaving
  // the Tour tab or Esc puts the camera and every opacity back exactly as they were before the tour. Prev and Next
  // animate. A stop that names no part of this build says so and leaves the camera alone.
  let tourOn=false,tourCam=null,tourWhole=false,tourInfo=null,tourClampPending=false;
  const AGENT_ID=/\b(worker|agent|subagent|bot|model|assistant|llm|ai)\b|\d|^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/i;
  // the tour's author as the page shows it: a human-readable name from the file, else nothing; an agent's internal
  // identifier (a worker or model id) reads "coding agent"
  function authorName(a){a=String(a||'').trim();if(!a)return '';return AGENT_ID.test(a)?'coding agent':a;}
  const stopKeysOf=st=>{const nk=nodeKey();return (st.parts||[]).map(p=>V.nodes.has(p)?p:nk.get(p)).filter(Boolean);};
  function tourExit(){
    if(!tourOn)return false;
    tourOn=false;tourInfo=null;V.setFocus(null);ghostFocus();if(tourCam)V.restoreCam(tourCam);tourCam=null;
    ghost.visible=$('diff-ghost').checked;renderTour();V.retint();V.dirty();return true;
  }
  const NOTE_LINES=6;
  function clampNotes(root){
    root.querySelectorAll('.clamp').forEach(el=>{
      const more=el.nextElementSibling?.classList.contains('more')?el.nextElementSibling:null;if(more)more.remove();
      if(el.scrollHeight<=el.clientHeight+2)return;
      const b=document.createElement('button');b.className='more';b.innerHTML='<i class="ic i-chevron-down"></i>Show more';b.setAttribute('aria-expanded','false');
      b.onclick=e=>{e.stopPropagation();const open=el.classList.toggle('open');b.classList.toggle('open',open);b.lastChild.textContent=open?'Show less':'Show more';b.setAttribute('aria-expanded',String(open));};
      el.after(b);
    });
  }
  function renderTour(){
    const out=$('tour-out'),t=server?.tour;
    if(!t){out.innerHTML='<p class="hint">No tour for this build. An agent writes one with <code>aad review tour-template</code> and saves it as .cadreview/tour.json.</p>';$('tour-count').textContent='';return;}
    const done=Object.keys(S.decisions).length;$('tour-count').textContent=`${done}/${t.stops.length}`;
    const au=authorName(t.author);
    let h=`<div class="paneh">${esc(t.title||'Agent change tour')}${au?` <span class="muted tour-author">by ${esc(au)}</span>`:''}</div>`;
    if(server.tour_for==='other')h+=`<div class="banner">This tour was written for build ${esc(t.build)}; the current build is ${esc(server.build)}.</div>`;
    const st=t.stops[tourIdx];
    if(st){
      const dec=S.decisions[st.id],nparts=stopKeysOf(st).length;
      h+=`<div class="item sel"><div class="r1"><b>Stop ${tourIdx+1} of ${t.stops.length}</b><span class="chip ${st.kind||''}">${esc(st.kind||'change')}</span>${dec?`<span class="chip ${dec.decision}">${dec.decision}</span>`:''}</div>
        <div class="note clamp" style="--lines:${NOTE_LINES}">${esc(st.note)}</div><div class="where">${esc(st.parts.join(', '))}</div>
        ${nparts?`<label class="tour-whole" title="Show every part at full opacity; the camera stays"><input type="checkbox" id="tour-whole"${tourWhole?' checked':''}> Show whole model</label>`:
          `<div class="banner tour-noparts">This stop names no part of this build, so the view stays where it is.</div>`}
        <div class="row2"><button id="tour-prev"><i class="ic i-chevron-left"></i>Prev</button><button id="tour-next">Next<i class="ic i-chevron-right"></i></button>
        <span class="grow"></span><button id="tour-accept" class="primary"><i class="ic i-circle-check"></i>Accept</button><button id="tour-reject"><i class="ic i-circle-x"></i>Reject</button><button id="tour-repin" class="danger" title="Repin: this stop is presented as done but something is still wrong; click the spot that is wrong now"><i class="ic i-map-pin-exclamation"></i>Repin</button></div>
        ${tourOn?'<div class="hint tour-esc">Esc or another tab puts the view back as it was before the tour.</div>':''}</div>`;
    }else h+=`<div class="row2"><button id="tour-start" class="primary"><i class="ic i-player-play"></i>Start tour</button></div>`;
    h+='<ol>'+t.stops.map((s,i)=>{const d=S.decisions[s.id];return `<li class="item${i===tourIdx?' sel':''}" data-stop="${i}"><div class="r1"><b>${i+1}</b><span class="cls">${esc(s.parts.join(', ')||'no parts')}</span>${d?`<span class="chip ${d.decision}">${d.decision}</span>`:''}</div><div class="where clamp" style="--lines:${NOTE_LINES}">${esc(s.note)}</div></li>`;}).join('')+'</ol>';
    out.innerHTML=h;
    const on=(id,f)=>{const b=$(id);if(b)b.onclick=f;};
    on('tour-start',()=>goStop(0));on('tour-prev',()=>goStop(Math.max(0,tourIdx-1)));on('tour-next',()=>goStop(Math.min(t.stops.length-1,tourIdx+1)));
    on('tour-accept',()=>decide('accept'));on('tour-reject',()=>decide('reject'));
    on('tour-repin',()=>{const st=t.stops[tourIdx];if(st)RP.start(RP.stopPin(st),st);});
    const wb=$('tour-whole');if(wb)wb.onchange=()=>{tourWhole=wb.checked;const st=t.stops[tourIdx];if(tourOn&&st)V.setFocus(tourWhole?null:stopKeysOf(st));ghostFocus();V.dirty();};
    out.querySelectorAll('[data-stop]').forEach(li=>li.onclick=()=>goStop(+li.dataset.stop));
    if(!$('tab-tour').hidden)clampNotes(out);else tourClampPending=true;
  }
  async function goStop(i){
    const t=server?.tour;if(!t||!t.stops[i])return;
    if(!tourOn){tourCam=V.snapCam();tourOn=true;}
    tourIdx=i;const st=t.stops[i],keys=stopKeysOf(st);
    if(keys.length){
      const d=st.camera?new THREE.Vector3(...st.camera.eye).sub(new THREE.Vector3(...st.camera.target)):null;
      tourInfo=V.fitParts(keys,d&&d.lengthSq()>0?d:null,true);
      V.setFocus(tourWhole?null:keys);
    }else{tourInfo=null;V.setFocus(null);}
    renderTour();V.retint();
    if(st.ghost!==false){
      const bl=diff?.a?.id||(server.baselines[0]&&server.baselines[0].id);
      if(bl){if(!diff)await runDiff(bl);await loadGhost(bl);ghost.visible=tourOn;ghostFocus();V.dirty();}
    }
  }
  // in focus, the baseline ghost shows the stop's own parts only (the rest would cover the view in orange)
  function ghostFocus(){
    const st=tourOn&&!tourWhole?server?.tour?.stops?.[tourIdx]:null,names=st?new Set(stopKeysOf(st).map(k=>V.nodes.get(k)?.leaf?.node).filter(Boolean)):null;
    for(const g of ghost.children)g.visible=!names||names.has(g.userData.ghostOf);
  }
  function decide(d){
    const st=server.tour.stops[tourIdx];if(!st)return;
    if(d==='accept'){S.decisions[st.id]={decision:'accept',at:now(),pin:null};changed();if(tourIdx<server.tour.stops.length-1)goStop(tourIdx+1);return;}
    const nk=nodeKey(),keys=st.parts.map(p=>V.nodes.has(p)?p:nk.get(p)).filter(Boolean);
    openDialog({kind:'region',keys:keys.length?keys:[],title:`Reject stop ${tourIdx+1}`,note:`Tour stop ${st.id} rejected: ${st.note}`,
      issue_class:st.issue_class||'intent_misread',source:'tour',tour_stop:st.id,
      after:pin=>{S.decisions[st.id]={decision:'reject',at:now(),pin:pin.id};}});
  }

  // ---- issues ----
  function renderIssues(){
    const out=$('issues-out'),tot=server?.issues?.total||{},op=server?.issues?.open||{};
    out.innerHTML=issuesHTML(classes,groups,tot,op)+                // by group, then class (pin_groups.js)
      `<p class="hint">Counts every pin ever created in this project (resolved ones too), from .cadreview/history.jsonl.</p>`;
  }

  // ---- tabs ----
  function showTab(t){document.querySelectorAll('#tabs button').forEach(b=>{b.classList.toggle('on',b.dataset.tab===t);if(b.dataset.tab===t&&$('tabs').dataset.fit==='3')b.scrollIntoView({block:'nearest',inline:'nearest'});});
    for(const n of ['pins','diff','tour','issues'])$('tab-'+n).hidden=n!==t;
    if(t!=='tour')tourExit();else if(tourClampPending){tourClampPending=false;clampNotes($('tour-out'));}}
  document.querySelectorAll('#tabs button').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
  // the tab row never clips a label: it steps down until everything fits (0 icons and labels, 1 labels only,
  // 2 short labels and tighter padding, 3 the same row scrolling sideways with a fade on the cut edge)
  const tabsEl=$('tabs');let fitting=false;
  function fitTabs(){
    if(fitting)return;fitting=true;
    try{
      let lv=0;for(;lv<3;lv++){tabsEl.dataset.fit=String(lv);if(tabsEl.scrollWidth<=tabsEl.clientWidth+0.5)break;}
      tabsEl.dataset.fit=String(lv);tabScrollEdges();
    }finally{fitting=false;}
  }
  function tabScrollEdges(){const s=tabsEl.dataset.fit==='3';
    tabsEl.classList.toggle('more-right',s&&tabsEl.scrollLeft+tabsEl.clientWidth<tabsEl.scrollWidth-1);tabsEl.classList.toggle('more-left',s&&tabsEl.scrollLeft>1);}
  tabsEl.addEventListener('scroll',tabScrollEdges,{passive:true});
  // refit on the next frame, not inside the observer callback (a layout change there is a ResizeObserver loop)
  let fitRaf=0;const fitSoon=()=>{if(!fitRaf)fitRaf=requestAnimationFrame(()=>{fitRaf=0;fitTabs();});};
  if(window.ResizeObserver)new ResizeObserver(fitSoon).observe(tabsEl);
  new MutationObserver(fitSoon).observe(tabsEl,{subtree:true,childList:true,characterData:true});
  fitTabs();

  // ---- send packet ----
  async function sendPacket(){
    forceShow=true;V.renderNow();                                 // the packet shows the pins whatever the Pins toggle says
    const src=V.canvas,W=src.width,H=src.height,dpr=W/src.clientWidth;
    const out=document.createElement('canvas');out.width=W;out.height=H;const g=out.getContext('2d');g.drawImage(src,0,0);
    const marks=[],v=new THREE.Vector3(),SEV={high:'#d1242f',medium:'#bc4c00',low:'#9a6700'};
    for(const o of edgeOverlays()){if(!o.pin||!V.effVisible(o.mesh))continue;const p=S.pins.find(x=>x.id===o.pin);
      const old=o.mod==='stale';
      for(const run of V.edgeScreen(o,src.clientWidth,src.clientHeight))for(const [w,c] of old?[[4,'#ffffffaa'],[1.75,groupFill(classes,p.issue_class)]]:[[7,'#ffffff'],[3.5,groupFill(classes,p.issue_class)]]){
        g.beginPath();run.forEach(([x,y],i)=>i?g.lineTo(x*dpr,y*dpr):g.moveTo(x*dpr,y*dpr));g.lineWidth=w*dpr;g.strokeStyle=c;g.lineCap=g.lineJoin='round';
        g.setLineDash(old?[5*dpr,4*dpr]:[]);g.stroke();g.setLineDash([]);}}
    for(const p of S.pins){
      const o=markers.get(p.id);if(!o||!o.visible||p.status==='resolved')continue;
      o.getWorldPosition(v);v.project(V.cam);if(v.z<-1||v.z>1)continue;
      const f=fan.get(p.id),ax=(v.x*0.5+0.5)*W,ay=(0.5-v.y*0.5)*H,x=ax+(f?f.dx*dpr:0),y=ay-21*dpr+(f?f.dy*dpr:0);if(x<0||y<0||x>W||y>H)continue;
      if(f){g.beginPath();g.moveTo(x,y);g.lineTo(ax,ay);g.lineWidth=1.75*dpr;g.strokeStyle=groupFill(classes,p.issue_class);g.stroke();}
      const r=15*dpr;g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.fillStyle=groupFill(classes,p.issue_class);g.fill();
      g.lineWidth=3*dpr;g.strokeStyle='#ffffff';g.stroke();g.fillStyle='#ffffff';g.font=`800 ${15*dpr}px -apple-system,system-ui,sans-serif`;
      g.textAlign='center';g.textBaseline='middle';g.fillText(String(p.n),x,y+1*dpr);marks.push({n:p.n,x:+(x/dpr).toFixed(1),y:+(y/dpr).toFixed(1),pin:p.id});
    }
    forceShow=false;V.dirty();
    const ds=diff?{against:diff.a.label,against_id:diff.a.id,summary:diff.summary,collateral:diff.collateral,pinned_outside_scope:diff.pinned_outside_scope||[],
      parts:diff.parts.filter(r=>r.status!=='unchanged').slice(0,60).map(r=>({name:r.name,status:r.status,collateral:r.collateral,...(r.pinned_outside_scope?{pinned_outside_scope:true,pins:r.pins}:{}),warnings:r.warnings.map(w=>w.kind)}))}:null;
    const payload={camera:V.camera(),selection:V.sel?V.partRef(V.sel.key):null,pins:S.pins,scope:S.scope,measurements:S.meas,
      hidden:V.hiddenKeys(),diff:ds,tour:server?.tour?{stops:server.tour.stops.length,decisions:S.decisions}:null,screenshot_markers:marks,
      model:{name:V.M.name,title:V.M.title},png:out.toDataURL('image/png')};
    await writing;
    let res;
    try{res=await post('/review/packet',payload);}catch(e){toast('Packet failed: '+esc(e.message),true);return null;}
    let copied=false;
    try{await navigator.clipboard.writeText(res.prompt);copied=true;}catch(e){
      try{const ta=document.createElement('textarea');ta.value=res.prompt;document.body.append(ta);ta.select();copied=document.execCommand('copy');ta.remove();}catch(e2){}}
    lastPacket={...res,copied,markers:marks.length};
    toast(`Packet <b>${esc(res.id)}</b> written to <code>${esc(res.dir)}</code>. ${copied?'Agent prompt copied to the clipboard.':'Copy the prompt from packet.json.'}`,false,9000);
    refreshIssues();
    return lastPacket;
  }
  $('send').onclick=()=>sendPacket();

  // ---- history, render ----
  function changed(){rerender();persist();V.commit();}
  function rerender(){renderPins();renderMeas();renderScope();renderTour();V.retint();}
  function snapshot(){return {p:clone(S.pins),nx:S.next,sc:clone(S.scope),ms:clone(S.meas),td:clone(S.decisions)};}
  function restore(r){if(!r)return;S.pins=clone(r.p);S.next=r.nx;S.scope=clone(r.sc);S.meas=clone(r.ms);S.decisions=clone(r.td);rerender();persist();}

  // After a rebuild the diff runs by itself against the default choice (since your last packet when one was sent)
  // and the Revisions tab opens. On a page load with a packet baseline the same compare runs, so a reload after a build
  // shows the reviewed version against the fixed one without a click.
  async function onModel(first){
    try{await loadState(first);}catch(e){console.warn('review state',e.message);return;}
    rerender();
    if(tourOn){const st=server?.tour?.stops?.[tourIdx];V.setFocus(st&&!tourWhole?stopKeysOf(st):null);}   // the reloaded meshes get the focus look again
    const def=(server.baselines||[])[0],rv=reviewedChoice();
    // the default revision is preselected and compared, but its hologram stays off until he clicks it
    if(!first&&def){revPre=def.id;await runDiff(def.id,true);showTab('diff');renderBaselines();}
    else if(first&&rv){revPre=rv.id;await runDiff(rv.id,true);renderBaselines();}
    if(rv)await loadPinChanges();else if(pinChanges){pinChanges=null;renderPins();}
  }
  function onStatus(st){
    if(st.review_pins_updated&&pinsUpdated&&st.review_pins_updated!==pinsUpdated){
      pinsUpdated=st.review_pins_updated;
      writing.then(()=>getJSON('/review/state.json')).then(s=>{server=s;S.pins=s.pins.pins;S.next=s.pins.next;persisted.pins=J(S.pins);rerender();renderIssues();}).catch(()=>{});
    }else if(st.review_pins_updated&&!pinsUpdated)pinsUpdated=st.review_pins_updated;
    const c=J(V.camera())+J(V.sel?.key||null);
    if(c!==lastCam&&V.ready){lastCam=c;post('/review/camera',{camera:V.camera(),selection:V.sel?V.partRef(V.sel.key):null}).catch(()=>{});}
  }

  RP=initRepin({V,THREE,CSS2DObject,$,S,server:()=>server,setMode,openDialog,changed,now,esc,label,meaningOf,keyFor,meshOf,boxOf,nodeKey,toast,
    setHot:id=>{hotPin=id;},markerOf:id=>markers.get(id)});
  document.body.classList.remove('no-panel');$('panel').hidden=false;$('send').hidden=false;$('pins-vis').hidden=false;setPinsShown(pinsShown);
  setMode('select');
  // edge lines the page draws over the view: open edge pins in their pin colour, and the edge of the pin being edited
  function edgeOverlays(){
    const out=[];
    if(pinsShown||forceShow)for(const p of S.pins){if(p.kind!=='edge'||!p.edge||p.status==='resolved'||!p.anchor)continue;const k=keyFor(p.anchor.part);
      if(!k)continue;const m=edgeMatch(p),cls='sev-'+p.severity+' g-'+groupOf(classes,p.issue_class);
      if(m?.changed){if(oldEdgeShown(p))out.push({mesh:meshOf(k),pts:p.edge.points,cls,mod:'stale',pin:p.id,label:'edge as pinned',at:p.edge.midpoint||p.edge.points[0]});}
      else out.push({mesh:meshOf(k),pts:m?m.pts:p.edge.points,cls,pin:p.id,mod:[occludedNow(p.id)?'occluded':'',tourOn&&V.focusActive()&&!V.inFocus(k)?'faded':''].filter(Boolean).join(' ')});}
    if(!card.hidden&&dialogCtx?.kind==='edge'&&dialogCtx.info.mesh)out.push({mesh:dialogCtx.info.mesh,pts:dialogCtx.edge.points,cls:'draft'});
    if(mode==='measure'&&measA?.type==='edge')out.push({mesh:measA.mesh,pts:measA.chain.pts,cls:'draft'});
    return out;
  }
  function editorState(){
    if(card.hidden)return {open:false};
    const hr=V.host.getBoundingClientRect(),cr=card.getBoundingClientRect();
    const mh=$('modehint'),hr2=mh.getBoundingClientRect(),hintCovered=!mh.hidden&&!(cr.left>hr2.right||cr.right<hr2.left||cr.top>hr2.bottom||cr.bottom<hr2.top);
    return {open:true,kind:dialogCtx?.kind,card:{x:cr.x,y:cr.y,w:cr.width,h:cr.height},docked,hintCovered,more:!$('pin-chips').hidden,recent:[...$('pin-recent').querySelectorAll('button[data-class]')].map(b=>b.dataset.class),severity:sevNow,cls:pinClass,
      point:anchorPx?{x:hr.x+anchorPx.x,y:hr.y+anchorPx.y}:null,dragged:!!cardOffset};
  }
  return {wantsEdges,edgeOverlays,pinPart,measureFrom,followUpFor,followUpPart,startFollowUp,setPinsShown,pinsShown:()=>pinsShown,onLargeMode:()=>{holoKey='';if(revPeek||revSel)showHolo(revPeek||revSel);},afterRender:()=>{placeCard();holoTheme();drawLeaders();},selectRev,holoOff,setFlick,showEvidence,tourExit,clearEvidence,pinWarning,snapshot,restore,tintFor,beforeLabels,onClick,onKey,onModel,onStatus,toggleScope,inScope,setMode,runDiff,sendPacket,goStop,decide,showTab,
    state:()=>({mode,followParent,repin:RP.state(),pins:S.pins.map(p=>({id:p.id,n:p.n,status:p.status,issue_class:p.issue_class,group:groupOf(classes,p.issue_class),repinned:RP.isRepinned(p),history:(p.history||[]).length,kind:p.kind,parts:p.parts.length,orphaned:orphaned(p),measure:!!p.measure,parent:p.parent||null,attempts:p.attempts||0,edgeChanged:edgeChanged(p),oldEdge:p.kind==='edge'?oldEdgeShown(p):null})),
      pinChanges:pinChanges?{against:pinChanges.against,unchanged:Object.keys(pinChanges.pins||{}).filter(id=>{const p=S.pins.find(x=>x.id===id);return p&&unchangedHere(p);})}:null,
      next:S.next,scope:S.scope.map(p=>p.node),measurements:S.meas.map(m=>m.distance),measureKinds:S.meas.map(m=>m.kind||'point_point'),measPending:measA?measA.type:null,measKeep:keepVis,decisions:S.decisions,tourIdx,tour:{on:tourOn,whole:tourWhole,info:tourInfo,author:server?.tour?authorName(server.tour.author):null,faded:[...markers.values()].filter(o=>o.element.classList.contains('faded')).length},
      diff:diff?{against:diff.a.id,kind:diff.a.kind||null,b:diff.b.build,summary:diff.summary,collateral:diff.collateral,pinnedOutside:diff.pinned_outside_scope||[],cutAway:[...cutAway],tinted:V.meshList.filter(m=>tintFor(m.userData.key)).length}:null,
      evidence:evSel?{warn:evSel,marks:evGroup.children.map(o=>o.userData.evidence||o.type),dots:evGroup.children.filter(o=>o.userData.evidence==='dot').length,
        label:evGroup.children.map(o=>o.element?.textContent).filter(Boolean).join(' '),tinted:evGroup.children.filter(o=>o.userData.evidence==='tint').reduce((n,o)=>n+o.geometry.attributes.position.count/3,0),
        part:evMesh?.userData.key||null}:null,
      editor:editorState(),lastSpot,pinsShown,occluded:[...occluded].filter(id=>markers.get(id)?.visible),occRuns,dimOccluded:dimOcc,fanRuns,fanned:[...fan.keys()],partHidden:[...partHidden].filter(([,v])=>v).map(([k])=>k),ghost:ghost.children.length,ghostVisible:ghost.visible,
      revisions:{selected:revSel,preselected:revPre,peek:revPeek,rows:(server?.baselines||[]).map(b=>({id:b.id,kind:b.kind,differ:revRows.find(r=>r.id===b.id)?.differ??null}))},
      holo:{visible:holo.visible,parts:new Set(holo.children.map(o=>o.userData.holoOf)).size,edges:holo.children.filter(o=>o.userData.holo==='edge').length,
        wire:holo.children.filter(o=>o.userData.holo==='wire').length,kinds:[...new Set(holo.children.map(o=>o.userData.holo))].sort(),
        edgeSegs:holo.children.filter(o=>o.userData.holo==='edge').reduce((n,o)=>n+o.geometry.attributes.position.count/2,0),
        faceTris:holo.children.filter(o=>o.userData.holo==='face').reduce((n,o)=>n+(o.geometry.index?o.geometry.index.count:o.geometry.attributes.position.count)/3,0),sil:silObjs.length,silSegs:silObjs.reduce((n,o)=>n+(o.userData.silCount||0),0),silCand:silObjs.reduce((n,o)=>n+o.userData.sil.A.length/6,0),dark:holoDark,color:HM.edge?'#'+HM.edge.color.getHexString():null,
        blending:HM.edge?.blending===THREE.AdditiveBlending?'additive':'normal',flick,oldSolid:oldSolid.visible?oldSolid.children.length:0,modelVisible:V.modelRoot?.visible??true},markers:[...markers.values()].filter(o=>o.visible).length,lastPacket,
      build:server?.build,project:server?.project,baselines:(server?.baselines||[]).map(b=>b.id)})};
}
