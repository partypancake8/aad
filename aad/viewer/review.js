// review.js: the two-way review workspace of the aad viewer (pins, region pins, measure, scope lock, diff with
// collateral flags and a ghosted baseline, the agent's change tour, known issues, Send packet). State lives in the
// CAD project (<project>/.cadreview/, written through the server's /review/ routes) and in the page's one undo
// history: snapshot() and restore() cover pins, the scope lock, measurements and tour decisions.
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

const ISSUE_FALLBACK=['weird_geometry','incoherent_addition','collateral_damage','floating_unsupported','orientation_mirror',
  'fit_clearance','printability','holes_ports_blocked','fasteners_assembly','regression','belt_pulley','envelope_size',
  'intent_misread','other'];
const MODES={select:'',pin:'Pin: click a part to drop a numbered pin. Esc leaves.',
  region:'Region: drag a box around the parts to pin together. Esc leaves.',
  measure:'Measure: click two points. Esc leaves.',scope:'Scope: click the parts the next edit may change. Esc leaves.'};
const KEYS={v:'select',p:'pin',g:'region',m:'measure',s:'scope'};

export function initReview(V){
  const {THREE,CSS2DObject,$}=V;
  const C={changed:new THREE.Color('#f59e0b'),moved:new THREE.Color('#3b82f6'),added:new THREE.Color('#22c55e'),
    collateral:new THREE.Color('#ef4444'),scope:new THREE.Color('#22c55e'),tour:new THREE.Color('#eab308')};
  const S={pins:[],next:1,scope:[],meas:[],decisions:{}};        // the undoable review state
  let server=null,classes=[],mode='select',diff=null,diffByNode=new Map(),tourIdx=-1,measA=null,lastPacket=null;
  let pinsUpdated=null,lastCam='',writing=Promise.resolve(),persisted={pins:'',scope:'',dec:''},dialogCtx=null,hotPin=null;
  const markers=new Map();                                        // pin id -> CSS2DObject
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
    mode=m;measA=null;clearMeasDraft();if(!keepFollow)followParent=null;
    document.querySelectorAll('#modes button').forEach(b=>b.classList.toggle('on',b.dataset.mode===m));
    const fp=followParent&&S.pins.find(p=>p.id===followParent);
    $('modehint').hidden=!MODES[m];$('modehint').textContent=fp?`Follow-up to pin #${fp.n}: click a part. Esc leaves.`:MODES[m];
    V.setLeftAction(m==='region'?'none':'rotate');V.canvas.style.cursor=m==='select'?'':'crosshair';
    V.retint();
  }
  document.querySelectorAll('#modes button').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
  function onKey(e){
    if(e.key==='Escape'){
      if(!card.hidden){closeDialog();return true;}
      if(measA){measA=null;clearMeasDraft();return true;}
      if(mode!=='select'){setMode('select');return true;}
      return false;
    }
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
    if(edge)h=edge.hit;
    if(!h){toast('Click on a part.',true,2500);return true;}
    const info=V.pickInfo(h);
    if(mode==='pin'){openDialog(edge?{kind:'edge',info,edge:edge.record,parent:followParent}:{kind:'point',info,parent:followParent});return true;}
    if(mode==='measure'&&edge)toast(`Edge <b>${edge.record.length_mm.toFixed(2)} mm</b> long; point snapped onto it.`,false,3500);
    if(mode==='scope'){toggleScope(info.part.key);return true;}
    if(mode==='measure'){
      if(!measA){measA=info;drawMeasDraft(info);return true;}
      const a=new THREE.Vector3(...measA.world),b=new THREE.Vector3(...info.world),d=b.clone().sub(a);
      const m={id:'m'+(S.meas.reduce((n,x)=>Math.max(n,+x.id.slice(1)),0)+1),a:measA.world,b:info.world,
        a_part:measA.part,b_part:info.part,distance:+a.distanceTo(b).toFixed(4),delta:d.toArray().map(x=>+x.toFixed(4)),pin:null};
      S.meas.push(m);measA=null;clearMeasDraft();changed();
      toast(`Distance <b>${m.distance.toFixed(2)} mm</b>, dX ${m.delta[0].toFixed(2)}, dY ${m.delta[1].toFixed(2)}, dZ ${m.delta[2].toFixed(2)} mm`,false,4000);
      return true;
    }
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
  // Issue classes are chips: one click on a chip picks the class and saves the pin (the note is optional; the class's
  // meaning is the pin's reason when the note is empty). Save, Enter in the note or a click in the view away from the
  // card saves with the highlighted class.
  let pinClass='weird_geometry';
  const meaningOf=id=>(classes.find(c=>c.id===id)||{}).meaning||'';
  function fillClasses(){
    const box=$('pin-chips');if(box.childElementCount)return;
    for(const c of classes){const b=document.createElement('button');b.type='button';b.dataset.class=c.id;b.textContent=c.label;b.title=c.meaning||c.hint||'';
      b.onclick=()=>{setPinClass(c.id);$('pin-save').click();};box.append(b);}
    setPinClass(pinClass);
  }
  function setPinClass(id){pinClass=classes.some(c=>c.id===id)?id:'weird_geometry';
    $('pin-chips').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.class===pinClass));$('pin-meaning').textContent=meaningOf(pinClass);}
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
    const el=document.createElement('div');el.className='pin-marker draft'+(c.kind==='region'?' region':'');el.textContent=String(S.next);el.id='pin-draft';
    el.addEventListener('pointerdown',e=>e.stopPropagation());
    draftMarker=new CSS2DObject(el);draftMarker.center.set(0.5,1.25);
    if(c.anchor.mesh){c.anchor.mesh.add(draftMarker);draftMarker.position.copy(c.anchor.local);}else{V.scene.add(draftMarker);draftMarker.position.copy(c.anchor.world);}
  }
  const _w=new THREE.Vector3();
  function placeCard(){
    if(card.hidden||!dialogCtx){overlay.classList.remove('leader');anchorPx=null;return;}
    const W=V.host.clientWidth,H=V.host.clientHeight,w=card.offsetWidth,h=card.offsetHeight,g=8;
    const p=anchorWorld(dialogCtx,_w);let x=null,y=null;
    if(p){p.project(V.cam);if(p.z>=-1&&p.z<=1){x=(p.x*0.5+0.5)*W;y=(0.5-p.y*0.5)*H;}}
    anchorPx=x==null?null:{x,y};
    const clamp=(l,t)=>({l:Math.max(g,Math.min(l,W-w-g)),t:Math.max(g,Math.min(t,H-h-g))});
    let pos;
    if(x==null)pos=cardPos||clamp(W-w-g,g);
    else if(cardOffset)pos=clamp(x+cardOffset.dx,y+cardOffset.dy);
    else{
      // keep clear of the marker bubble (it sits above the point) and the point itself
      const av={l:x-24,t:y-44,r:x+24,b:y+10},hit=q=>!(q.l>av.r||q.l+w<av.l||q.t>av.b||q.t+h<av.t);
      const cands=[clamp(x+44,y-h/2),clamp(x-44-w,y-h/2),clamp(x-w/2,y+26),clamp(x-w/2,y-56-h)];
      pos=cands.find(q=>!hit(q))||cands[0];
    }
    cardPos=pos;card.style.left=pos.l+'px';card.style.top=pos.t+'px';
    if(x==null){overlay.classList.remove('leader');return;}
    const cx=Math.max(pos.l,Math.min(x,pos.l+w)),cy=Math.max(pos.t,Math.min(y,pos.t+h));
    leader.setAttribute('x1',x.toFixed(1));leader.setAttribute('y1',y.toFixed(1));leader.setAttribute('x2',cx.toFixed(1));leader.setAttribute('y2',cy.toFixed(1));
    overlay.classList.add('leader');
  }
  $('pin-grip').addEventListener('pointerdown',e=>{
    if(e.button!==0||e.target.closest('button'))return;e.preventDefault();
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
    dialogCtx=c;c.anchor=dialogAnchor(c);cardOffset=null;cardPos=null;
    const where=c.kind!=='region'?`${c.info.name}  local ${c.info.local.map(x=>x.toFixed(1)).join(', ')} mm`:
      `${c.keys.length} part${c.keys.length===1?'':'s'}: `+c.keys.slice(0,5).map(k=>V.nodes.get(k)?.leaf?.name||k).join(', ')+(c.keys.length>5?', ...':'');
    const par=c.parent&&S.pins.find(p=>p.id===c.parent);
    $('pin-where').textContent=where;$('pin-dialog-h').textContent=c.title||(par?`Follow-up to pin #${par.n}`:c.kind==='region'?'New region pin':c.kind==='edge'?'New edge pin':'New pin');
    $('pin-note').value=c.note||keepNote||'';setPinClass(c.issue_class||pinClass);$('pin-severity').value=c.severity||$('pin-severity').value||'medium';
    const lm=S.meas[S.meas.length-1];$('pin-measure-row').hidden=!(lm&&!lm.pin);
    setDraftMarker(c);card.hidden=false;placeCard();V.dirty();
    setTimeout(()=>$('pin-note').focus({preventScroll:true}),0);
  }
  function closeDialog(){card.hidden=true;dialogCtx=null;cardDrag=null;setDraftMarker(null);placeCard();V.dirty();
    if(card.contains(document.activeElement))document.activeElement.blur();}
  $('pin-cancel').onclick=closeDialog;$('pin-close').onclick=closeDialog;
  card.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeDialog();return;}
    // Enter saves from the note (Shift+Enter is a new line) and Cmd/Ctrl+Enter saves from anywhere in the card
    if(e.key==='Enter'&&((e.target.id==='pin-note'&&!e.shiftKey)||e.metaKey||e.ctrlKey)){e.preventDefault();$('pin-save').click();}
  });
  $('pin-save').onclick=()=>{
    const c=dialogCtx;if(!c)return;closeDialog();
    const lm=S.meas[S.meas.length-1],attach=!$('pin-measure-row').hidden&&$('pin-measure').checked&&lm&&!lm.pin;
    const n=S.next,id='p'+n;S.next=n+1;
    const pin={schema:'cadreview/1',id,n,kind:c.kind,status:'open',note:$('pin-note').value.trim(),issue_class:pinClass,
      severity:$('pin-severity').value,anchor:null,parts:[],rect:c.rect||null,measure:null,camera:V.camera(),build:server?.build||null,
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

  // right-click "Pin this part": a point pin where the part was clicked, else a region pin of that tree node's parts
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
  function measureFrom(h){setMode('measure');measA=V.pickInfo(h);drawMeasDraft(measA);}
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
  const unchangedHere=p=>{const c=pinChanges?.pins?.[p.id];return !!c&&p.status!=='resolved'&&!c.part_changed&&c.near_changed!==true;};
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
  // a pin card: row 1 number, title and badges (wraps), row 2 the actions (8 px apart, wrap, never clipped), then
  // the note, where it is, and one short status line
  const ACT=(act,icon,text,title,cls='')=>`<button data-act="${act}"${cls?` class="${cls}"`:''} title="${title}" aria-label="${text||title.split(':')[0]}"><i class="ic i-${icon}"></i>${text?`<span>${text}</span>`:''}</button>`;
  function pinItem(p){
    const li=document.createElement('li');li.className='item pin'+(p.id===hotPin?' sel':'');li.dataset.pin=p.id;
    const orphan=orphaned(p),done=p.status==='resolved',sl=statusLine(p),par=p.parent&&S.pins.find(x=>x.id===p.parent);
    const acts=done?ACT('fly','crosshair','','Fly to this pin')+ACT('reopen','refresh','Reopen','Reopen this pin')+ACT('delete','trash','','Delete pin'):
      ACT('fly','crosshair','','Fly to this pin')+ACT('resolve','check','Resolve','Mark resolved: the pin leaves the list (undo brings it back)')+
      ACT('notfixed','alert-octagon','Not fixed','Not fixed: the last attempt did not fix this; the next packet says so and lists it first','danger')+
      ACT('followup','corner-down-right','','Add follow-up pin: the next pin you drop follows up this one')+ACT('delete','trash','','Delete pin');
    li.innerHTML=`<div class="ph"><span class="num sev-${p.severity}${done?' resolved':''}">${p.n}</span>
      <span class="cls">${esc(label(p.issue_class))}</span><span class="chip">${esc(p.severity)}</span>
      ${p.status==='reopened'?'<span class="chip reopened">reopened</span>':''}${p.status==='not_fixed'?`<span class="chip notfixed">Not fixed, attempt ${p.attempts||1}</span>`:''}
      ${unchangedHere(p)?`<span class="chip same" title="${esc(unchangedTitle(p))}">Unchanged here since your packet</span>`:''}${orphan?'<span class="chip orphan">orphaned</span>':''}</div>
      <div class="acts">${acts}</div>
      ${par?`<div class="where">follow-up to #${par.n}</div>`:''}
      <div class="note">${esc(p.note)||`<span class="muted">${esc(meaningOf(p.issue_class))}</span>`}</div>
      <div class="where">${esc(pinWhere(p))}${p.measure?`, measured ${p.measure.distance.toFixed(2)} mm`:''}</div>
      ${sl?`<div class="hist" title="${esc(sl.tip)}">${esc(sl.t)}</div>`:''}`;
    li.onclick=e=>{const a=e.target.closest('button')?.dataset.act;
      if(a==='resolve'){setStatus(p,'resolved');if(hotPin===p.id)hotPin=null;changed();toast(`Pin <b>#${p.n}</b> resolved. Undo brings it back; it is under Resolved.`,false,3000);return;}
      if(a==='reopen'){setStatus(p,'open');hotPin=p.id;changed();return;}
      if(a==='followup'){startFollowUp(p);return;}
      if(a==='notfixed'){
        if(p.status==='not_fixed'&&p.escalated_build&&p.escalated_build===server?.build){toast(`Pin <b>#${p.n}</b> is already marked not fixed on this build.`,false,3000);return;}
        p.status='not_fixed';p.attempts=(p.attempts||0)+1;p.escalated_build=server?.build||null;p.escalated_at=now();p.updated=now();
        hotPin=p.id;changed();toast(`Pin <b>#${p.n}</b> marked not fixed (attempt ${p.attempts}). The next packet lists it first.`,true,3500);return;}
      if(a==='delete'){S.pins=S.pins.filter(x=>x!==p);for(const m of S.meas)if(m.pin===p.id)m.pin=null;changed();return;}
      flyToPin(p);};
    return li;
  }
  function renderPins(){
    const ol=$('pin-list');ol.innerHTML='';
    const active=S.pins.filter(p=>p.status!=='resolved').sort((a,b)=>(a.status!=='not_fixed')-(b.status!=='not_fixed')),done=S.pins.filter(p=>p.status==='resolved');
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
  function flyToPin(p){
    hotPin=p.id;
    const k=p.anchor?keyFor(p.anchor.part):null,keys=p.parts.map(keyFor).filter(Boolean);
    V.camAction(()=>{
      if(k){const m=meshOf(k);m.updateMatrixWorld();V.flyToPoint(m.localToWorld(new THREE.Vector3(...p.anchor.local)).toArray());}
      else if(keys.length){const b=boxOf(keys);if(!b.isEmpty())V.focusBox(b);}
      else if(p.anchor)V.flyToPoint(p.anchor.world);
    });
    if(k)V.select(k);else if(keys.length)V.select(keys[0]);
    V.commit();renderPins();
  }
  function renderMarkers(){
    for(const [,o] of markers){o.removeFromParent();o.element.remove();}
    markers.clear();
    for(const p of S.pins){
      if(p.status==='resolved')continue;                         // a resolved pin leaves the model at once
      const el=document.createElement('div'),orphan=orphaned(p);
      el.className=`pin-marker sev-${p.severity}${p.status==='not_fixed'?' notfixed':''}${orphan?' orphan':''}${p.kind==='region'?' region':''}${p.id===hotPin?' hot':''}`;
      el.textContent=String(p.n);el.title=`#${p.n} ${label(p.issue_class)}: ${p.note}`+(orphan?' (part missing in this build)':'');el.dataset.pin=p.id;
      el.addEventListener('pointerdown',e=>e.stopPropagation());
      el.addEventListener('click',e=>{e.stopPropagation();flyToPin(p);});
      const o=new CSS2DObject(el);o.userData.pin=p.id;o.center.set(0.5,1.25);   // the bubble sits above its point, which stays clickable
      const k=p.anchor?keyFor(p.anchor.part):null;
      if(k){meshOf(k).add(o);o.position.set(...p.anchor.local);o.userData.key=k;}
      else if(!p.anchor&&p.parts.some(keyFor)){const keys=p.parts.map(keyFor).filter(Boolean);const b=boxOf(keys);V.scene.add(o);o.position.copy(b.getCenter(new THREE.Vector3()));o.userData.keys=keys;}
      else{V.scene.add(o);o.position.set(...(p.anchor?p.anchor.world:V.bbox.getCenter(new THREE.Vector3()).toArray()));}
      markers.set(p.id,o);
    }
    V.dirty();
  }
  // markers follow their part's visibility (CSS2D does not check ancestors)
  function beforeLabels(){
    for(const [,o] of markers){
      const vis=o.userData.key?V.effVisible(o.parent):o.userData.keys?o.userData.keys.some(k=>V.leafShown(k)):true;
      o.visible=vis;
    }
  }

  // ---- measurements ----
  let draft=null;
  function clearMeasDraft(){if(draft){draft.removeFromParent();draft.element.remove();draft=null;}V.dirty();}
  function drawMeasDraft(i){clearMeasDraft();const el=document.createElement('div');el.className='measure-dot';draft=new CSS2DObject(el);draft.position.set(...i.world);V.scene.add(draft);V.dirty();}
  function renderMeas(){
    for(const o of [...measGroup.children]){o.removeFromParent();if(o.element)o.element.remove();o.geometry?.dispose();}
    const ol=$('measure-list');ol.innerHTML='';
    for(const m of S.meas){
      const a=new THREE.Vector3(...m.a),b=new THREE.Vector3(...m.b);
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([a,b]),new THREE.LineBasicMaterial({color:0xffd43b,depthTest:false}));
      line.renderOrder=10;measGroup.add(line);
      for(const p of [a,b]){const d=document.createElement('div');d.className='measure-dot';const o=new CSS2DObject(d);o.position.copy(p);measGroup.add(o);}
      const el=document.createElement('div');el.className='measure-label';el.textContent=`${m.distance.toFixed(2)} mm`;
      const lo=new CSS2DObject(el);lo.position.copy(a.clone().add(b).multiplyScalar(0.5));measGroup.add(lo);
      const li=document.createElement('li');li.className='item';li.dataset.measure=m.id;
      const opts=S.pins.map(p=>`<option value="${p.id}"${m.pin===p.id?' selected':''}>#${p.n} ${esc(label(p.issue_class))}</option>`).join('');
      li.innerHTML=`<div class="r1"><b>${m.distance.toFixed(2)} mm</b><span class="muted">dX ${m.delta[0].toFixed(2)}, dY ${m.delta[1].toFixed(2)}, dZ ${m.delta[2].toFixed(2)}</span>
        <span class="acts"><button data-act="delete" title="Delete measurement"><i class="ic i-trash"></i></button></span></div>
        <div class="where">${esc(m.a_part?.node||'')} to ${esc(m.b_part?.node||'')}</div>
        <div class="row2"><select data-act="pin" aria-label="Attach to pin"><option value="">attach to pin...</option>${opts}</select></div>`;
      li.querySelector('[data-act=delete]').onclick=()=>{S.meas=S.meas.filter(x=>x!==m);for(const p of S.pins)if(p.measure&&p.measure.id===m.id)p.measure=null;changed();};
      li.querySelector('select').onchange=e=>{const pid=e.target.value;for(const p of S.pins){if(p.measure&&p.measure.id===m.id)p.measure=null;}
        m.pin=pid||null;const p=S.pins.find(x=>x.id===pid);if(p){p.measure={...m};p.updated=now();}changed();};
      ol.append(li);
    }
    V.dirty();
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

  // ---- diff ----
  // the diff choices come from the server, default first: "since your last packet (reviewed HH:MM)" whenever a
  // packet was sent against another build, then the earlier builds and the manifest versions, each with its time
  let baselineKey='';
  function renderBaselines(){
    const s=$('baseline'),keep=s.value,bl=server?.baselines||[],key=bl.map(b=>b.id).join('|');s.innerHTML='';
    for(const b of bl){const o=document.createElement('option');o.value=b.id;o.textContent=b.label;o.dataset.kind=b.kind;s.append(o);}
    if(!s.options.length){const o=document.createElement('option');o.value='';o.textContent='no baseline yet (appears after a rebuild or a packet)';s.append(o);}
    // a new list (a packet was sent, a build appeared) goes back to the default; otherwise the pick stays
    if(key===baselineKey&&[...s.options].some(o=>o.value===keep))s.value=keep;else s.value=s.options[0].value;
    baselineKey=key;
  }
  const reviewedChoice=()=>(server?.baselines||[]).find(b=>b.kind==='reviewed')||null;
  async function runDiff(against,auto=false){
    if(!against){toast('No baseline to compare against yet.',true);return null;}
    $('diff-out').innerHTML='<p class="hint">Comparing...</p>';$('diff-run').disabled=true;
    try{diff=await getJSON('/review/diff.json?against='+encodeURIComponent(against));}
    catch(e){$('diff-out').innerHTML=`<p class="hint">${esc(e.message)}</p>`;$('diff-run').disabled=false;return null;}
    $('diff-run').disabled=false;
    diffByNode=new Map(diff.parts.map(r=>[r.name,r]));
    if(diff.reopened?.length){await loadState(true);rerender();toast(`${diff.reopened.length} resolved pin(s) reopened: their part changed again.`,true);}
    renderDiff(auto);V.retint();
    if($('diff-ghost').checked)await loadGhost(against);
    return diff;
  }
  $('diff-run').onclick=()=>{showTab('diff');runDiff($('baseline').value);};
  $('diff-tint').onchange=()=>V.retint();
  $('diff-all').onchange=()=>renderDiff();
  $('diff-ghost').onchange=async()=>{if($('diff-ghost').checked){await loadGhost(diff?.a?.id||$('baseline').value);}ghost.visible=$('diff-ghost').checked;V.dirty();};
  function renderDiff(auto=false){
    const out=$('diff-out');if(!diff){out.innerHTML='';return;}
    const s=diff.summary,col=diff.collateral,nk=nodeKey();
    $('diff-count').textContent=String(s.changed+s.moved+s.added+s.removed||'');$('diff-count').classList.toggle('bad',col.length>0);
    let h='';
    if(diff.scope==null)h+=`<div class="banner ok">No scope lock set, so nothing is judged collateral. Mark the parts that may change (Scope mode) before the next edit.</div>`;
    else if(col.length)h+=`<div class="banner"><b>COLLATERAL: ${col.length} part${col.length===1?'':'s'} changed outside the scope lock</b><ul>${col.slice(0,12).map(n=>`<li>${esc(n)}</li>`).join('')}</ul></div>`;
    else h+=`<div class="banner ok">No collateral: every change is inside the scope lock (${diff.scope.length} part${diff.scope.length===1?'':'s'}).</div>`;
    h+=`<div class="diffhead"><span class="chip ${diff.a.kind==='reviewed'?'reviewed':''}">${diff.a.kind==='reviewed'?'old vs fixed':esc(diff.a.kind||'baseline')}</span>
      <span>Current build against <b>${esc(diff.a.label)}</b></span></div>
      <div class="muted">${auto?'Ran automatically. ':''}${diff.seconds} s</div>
      <div class="counts"><span class="chip changed">${s.changed} changed</span><span class="chip moved">${s.moved} moved</span><span class="chip added">${s.added} added</span><span class="chip removed">${s.removed} removed</span><span class="chip">${s.unchanged} unchanged</span>${s.warnings?`<span class="chip warn">${s.warnings} warnings</span>`:''}</div><ol id="diff-list">`;
    for(const r of diff.parts){
      if(r.status==='unchanged'&&!$('diff-all').checked)continue;
      const d=r.delta,k=nk.get(r.name);
      h+=`<li class="item" data-part="${esc(r.name)}"><div class="r1"><span class="chip ${r.status}">${r.status}</span>${r.collateral?'<span class="chip collateral">COLLATERAL</span>':''}${r.in_scope?'<span class="chip added">in scope</span>':''}
        <span class="cls">${esc(k?(V.nodes.get(k).leaf?.name||r.name):r.name)}</span></div>
        ${d?`<div class="where">centroid shift ${d.distance.toFixed(2)} mm, volume ${d.volume>=0?'+':''}${d.volume.toFixed(1)} mm3, triangles ${d.tris>=0?'+':''}${d.tris}</div>`:''}
        ${r.warnings.map(w=>`<div class="where"><span class="chip warn">${esc(w.kind.replace('_',' '))}</span> ${esc(w.message)}</div>`).join('')}</li>`;
    }
    h+='</ol>';
    if(diff.warnings.length)h+=`<p class="hint">Detector warnings are hints from the meshes, not errors.</p>`;
    out.innerHTML=h;
    out.querySelectorAll('[data-part]').forEach(li=>li.onclick=()=>{const k=nk.get(li.dataset.part);if(k){V.select(k);V.camAction(()=>V.focusKey(k));V.commit();}
      else{$('diff-ghost').checked=true;$('diff-ghost').onchange();}});
  }
  // the baseline's shapes of every part that is not unchanged, translucent orange, for "what did it look like"
  async function loadGhost(against){
    if(!against||!diff)return;
    const want=new Set(diff.parts.filter(r=>r.status!=='unchanged'&&r.status!=='added').map(r=>r.name));
    const gk=against+'|'+[...want].sort().join('|');
    if(ghostKey===gk){ghost.visible=true;V.dirty();return;}
    for(const o of [...ghost.children]){o.removeFromParent();o.geometry?.dispose();}
    const mat=new THREE.MeshBasicMaterial({color:0xff7b29,transparent:true,opacity:0.28,depthWrite:false,side:THREE.DoubleSide});
    const loader=new GLTFLoader();
    const nf=(server?.baselines||[]).find(b=>b.id===against)?.files||1;
    for(let i=0;i<nf;i++){
      const r=await V.fetch(`/review/baseline/${encodeURIComponent(against)}/models/${i}`);if(!r.ok)break;
      const buf=await r.arrayBuffer();if(new TextDecoder().decode(new Uint8Array(buf,0,4))!=='glTF')continue;
      const g=await loader.parseAsync(buf,''),js=g.parser.json,seen=new Map();
      g.scene.updateMatrixWorld(true);
      g.scene.traverse(o=>{if(!o.isMesh)return;const a=g.parser.associations.get(o);
        let nm=(a&&a.nodes!==undefined&&js.nodes[a.nodes]?.name)||o.name;
        if(!a||a.nodes===undefined){const pa=g.parser.associations.get(o.parent);if(pa&&pa.nodes!==undefined)nm=js.nodes[pa.nodes].name||nm;}
        const c=seen.get(nm)||0;seen.set(nm,c+1);const key=c?`${nm} #${c+1}`:nm;
        if(!want.has(key))return;
        const m=new THREE.Mesh(o.geometry,mat);m.matrixAutoUpdate=false;m.matrix.copy(o.matrixWorld);m.userData.ghostOf=key;m.raycast=()=>{};ghost.add(m);});
    }
    ghostKey=gk;ghost.visible=$('diff-ghost').checked||tourIdx>=0;V.dirty();
  }
  function tintFor(key){
    if(!key)return null;
    if(tourIdx>=0){const st=server?.tour?.stops?.[tourIdx];if(st&&st.parts.some(p=>p===key||nodeKey().get(p)===key))return {c:C.tour,i:0.6};}
    if(mode==='scope'&&inScope(key))return {c:C.scope,i:0.55};
    if(diff&&$('diff-tint').checked){
      const n=V.nodes.get(key)?.leaf?.node,r=n&&diffByNode.get(n);
      if(r&&r.status!=='unchanged')return {c:r.collateral?C.collateral:C[r.status]||C.changed,i:0.5};
    }
    return null;
  }

  // ---- tour ----
  function renderTour(){
    const out=$('tour-out'),t=server?.tour;
    if(!t){out.innerHTML='<p class="hint">No tour for this build. An agent writes one with <code>aad review tour-template</code> and saves it as .cadreview/tour.json.</p>';$('tour-count').textContent='';return;}
    const done=Object.keys(S.decisions).length;$('tour-count').textContent=`${done}/${t.stops.length}`;
    let h=`<div class="paneh">${esc(t.title||'Agent change tour')} <span class="muted">${esc(t.author||'')}</span></div>`;
    if(server.tour_for==='other')h+=`<div class="banner">This tour was written for build ${esc(t.build)}; the current build is ${esc(server.build)}.</div>`;
    const st=t.stops[tourIdx];
    if(st){
      const dec=S.decisions[st.id];
      h+=`<div class="item sel"><div class="r1"><b>Stop ${tourIdx+1} of ${t.stops.length}</b><span class="chip ${st.kind||''}">${esc(st.kind||'change')}</span>${dec?`<span class="chip ${dec.decision}">${dec.decision}</span>`:''}</div>
        <div class="note">${esc(st.note)}</div><div class="where">${esc(st.parts.join(', '))}</div>
        <div class="row2"><button id="tour-prev"><i class="ic i-chevron-left"></i>Prev</button><button id="tour-next">Next<i class="ic i-chevron-right"></i></button>
        <span class="grow"></span><button id="tour-accept" class="primary"><i class="ic i-circle-check"></i>Accept</button><button id="tour-reject"><i class="ic i-circle-x"></i>Reject</button></div></div>`;
    }else h+=`<div class="row2"><button id="tour-start" class="primary"><i class="ic i-player-play"></i>Start tour</button></div>`;
    h+='<ol>'+t.stops.map((s,i)=>{const d=S.decisions[s.id];return `<li class="item${i===tourIdx?' sel':''}" data-stop="${i}"><div class="r1"><b>${i+1}</b><span class="cls">${esc(s.parts.join(', '))}</span>${d?`<span class="chip ${d.decision}">${d.decision}</span>`:''}</div><div class="where">${esc(s.note)}</div></li>`;}).join('')+'</ol>';
    out.innerHTML=h;
    const on=(id,f)=>{const b=$(id);if(b)b.onclick=f;};
    on('tour-start',()=>goStop(0));on('tour-prev',()=>goStop(Math.max(0,tourIdx-1)));on('tour-next',()=>goStop(Math.min(t.stops.length-1,tourIdx+1)));
    on('tour-accept',()=>decide('accept'));on('tour-reject',()=>decide('reject'));
    out.querySelectorAll('[data-stop]').forEach(li=>li.onclick=()=>goStop(+li.dataset.stop));
  }
  async function goStop(i){
    const t=server?.tour;if(!t||!t.stops[i])return;tourIdx=i;const st=t.stops[i],nk=nodeKey();
    const keys=st.parts.map(p=>V.nodes.has(p)?p:nk.get(p)).filter(Boolean);
    V.camAction(()=>{
      if(st.camera)V.flyToPoint(st.camera.target);
      else if(keys.length){const b=boxOf(keys);if(!b.isEmpty())V.focusBox(b);}
    });
    if(keys.length)V.select(keys[0]);V.commit();
    renderTour();V.retint();
    if(st.ghost!==false){
      const bl=diff?.a?.id||(server.baselines[0]&&server.baselines[0].id);
      if(bl){if(!diff)await runDiff(bl);await loadGhost(bl);ghost.visible=true;V.dirty();}
    }
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
    const max=Math.max(1,...Object.values(tot));
    const rows=classes.map(c=>({c,n:tot[c.id]||0,o:op[c.id]||0})).sort((a,b)=>b.n-a.n||a.c.label.localeCompare(b.c.label));
    out.innerHTML=rows.map(r=>`<div class="bar" title="${esc(r.c.hint||'')}"><span class="bl">${esc(r.c.label)}</span><span class="bt"><span class="bf" style="display:block;width:${(100*r.n/max).toFixed(1)}%"></span></span><span class="bn">${r.n}${r.o?` (${r.o} open)`:''}</span></div>`).join('')+
      `<p class="hint">Counts every pin ever created in this project (resolved ones too), from .cadreview/history.jsonl.</p>`;
  }

  // ---- tabs ----
  function showTab(t){document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));
    for(const n of ['pins','diff','tour','issues'])$('tab-'+n).hidden=n!==t;}
  document.querySelectorAll('#tabs button').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));

  // ---- send packet ----
  async function sendPacket(){
    V.renderNow();
    const src=V.canvas,W=src.width,H=src.height,dpr=W/src.clientWidth;
    const out=document.createElement('canvas');out.width=W;out.height=H;const g=out.getContext('2d');g.drawImage(src,0,0);
    const marks=[],v=new THREE.Vector3(),SEV={high:'#d1242f',medium:'#bc4c00',low:'#9a6700'};
    for(const o of edgeOverlays()){if(!o.pin||!V.effVisible(o.mesh))continue;const p=S.pins.find(x=>x.id===o.pin);
      for(const run of V.edgeScreen(o,src.clientWidth,src.clientHeight))for(const [w,c] of [[7,'#ffffff'],[3.5,SEV[p.severity]]]){
        g.beginPath();run.forEach(([x,y],i)=>i?g.lineTo(x*dpr,y*dpr):g.moveTo(x*dpr,y*dpr));g.lineWidth=w*dpr;g.strokeStyle=c;g.lineCap=g.lineJoin='round';g.stroke();}}
    for(const p of S.pins){
      const o=markers.get(p.id);if(!o||!o.visible||p.status==='resolved')continue;
      o.getWorldPosition(v);v.project(V.cam);if(v.z<-1||v.z>1)continue;
      const x=(v.x*0.5+0.5)*W,y=(0.5-v.y*0.5)*H-21*dpr;if(x<0||y<0||x>W||y>H)continue;
      const r=15*dpr;g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.fillStyle=p.severity==='high'?'#d1242f':p.severity==='medium'?'#bc4c00':'#9a6700';g.fill();
      g.lineWidth=3*dpr;g.strokeStyle='#ffffff';g.stroke();g.fillStyle='#ffffff';g.font=`800 ${15*dpr}px -apple-system,system-ui,sans-serif`;
      g.textAlign='center';g.textBaseline='middle';g.fillText(String(p.n),x,y+1*dpr);marks.push({n:p.n,x:+(x/dpr).toFixed(1),y:+(y/dpr).toFixed(1),pin:p.id});
    }
    const ds=diff?{against:diff.a.label,against_id:diff.a.id,summary:diff.summary,collateral:diff.collateral,
      parts:diff.parts.filter(r=>r.status!=='unchanged').slice(0,60).map(r=>({name:r.name,status:r.status,collateral:r.collateral,warnings:r.warnings.map(w=>w.kind)}))}:null;
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
  // and the Diff tab opens. On a page load with a packet baseline the same compare runs, so a reload after a build
  // shows the reviewed version against the fixed one without a click.
  async function onModel(first){
    try{await loadState(first);}catch(e){console.warn('review state',e.message);return;}
    rerender();
    const def=(server.baselines||[])[0],rv=reviewedChoice();
    if(!first&&def){$('baseline').value=def.id;await runDiff(def.id,true);showTab('diff');}
    else if(first&&rv){$('baseline').value=rv.id;await runDiff(rv.id,true);}
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

  document.body.classList.remove('no-panel');$('panel').hidden=false;$('send').hidden=false;
  setMode('select');
  // edge lines the page draws over the view: open edge pins in their pin colour, and the edge of the pin being edited
  function edgeOverlays(){
    const out=[];
    for(const p of S.pins){if(p.kind!=='edge'||!p.edge||p.status==='resolved'||!p.anchor)continue;const k=keyFor(p.anchor.part);
      if(k)out.push({mesh:meshOf(k),pts:p.edge.points,cls:'sev-'+p.severity,pin:p.id});}
    if(!card.hidden&&dialogCtx?.kind==='edge'&&dialogCtx.info.mesh)out.push({mesh:dialogCtx.info.mesh,pts:dialogCtx.edge.points,cls:'draft'});
    return out;
  }
  function editorState(){
    if(card.hidden)return {open:false};
    const hr=V.host.getBoundingClientRect(),cr=card.getBoundingClientRect();
    return {open:true,kind:dialogCtx?.kind,card:{x:cr.x,y:cr.y,w:cr.width,h:cr.height},
      point:anchorPx?{x:hr.x+anchorPx.x,y:hr.y+anchorPx.y}:null,dragged:!!cardOffset};
  }
  return {wantsEdges,edgeOverlays,pinPart,measureFrom,followUpFor,followUpPart,startFollowUp,afterRender:placeCard,snapshot,restore,tintFor,beforeLabels,onClick,onKey,onModel,onStatus,toggleScope,inScope,setMode,runDiff,sendPacket,goStop,decide,showTab,
    state:()=>({mode,followParent,pins:S.pins.map(p=>({id:p.id,n:p.n,status:p.status,issue_class:p.issue_class,kind:p.kind,parts:p.parts.length,orphaned:orphaned(p),measure:!!p.measure,parent:p.parent||null,attempts:p.attempts||0})),
      pinChanges:pinChanges?{against:pinChanges.against,unchanged:Object.keys(pinChanges.pins||{}).filter(id=>{const p=S.pins.find(x=>x.id===id);return p&&unchangedHere(p);})}:null,
      next:S.next,scope:S.scope.map(p=>p.node),measurements:S.meas.map(m=>m.distance),decisions:S.decisions,tourIdx,
      diff:diff?{against:diff.a.id,kind:diff.a.kind||null,b:diff.b.build,summary:diff.summary,collateral:diff.collateral,tinted:V.meshList.filter(m=>tintFor(m.userData.key)).length}:null,
      editor:editorState(),ghost:ghost.children.length,ghostVisible:ghost.visible,markers:[...markers.values()].filter(o=>o.visible).length,lastPacket,
      build:server?.build,project:server?.project,baselines:(server?.baselines||[]).map(b=>b.id)})};
}
