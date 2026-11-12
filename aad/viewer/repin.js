// repin.js: Repin, for a fix presented as done or attempted that left something wrong. From a resolved pin, a pin
// whose part changed since the packet, a not-fixed pin or a tour stop: the view goes into a pick state ("Click the
// spot that is wrong now"), a click on a part point or an edge (or Enter / Esc to keep the old spot) opens the pin
// card prefilled with the old class and note, and one click on a class saves. The SAME pin id gets the new anchor,
// class and note, status open, attempts + 1, the previous state appended to `history`, and moves to the top. One undo
// step restores it exactly. While it is open, its old spot stays as a small hollow marker joined to the new one by a
// thin line. A tour stop without a pin gets a new pin (the stop counts as rejected).
export const REPIN_HINT='Click the spot that is wrong now (Esc keeps the old spot)';

export function initRepin(A){
  // A: {V, THREE, CSS2DObject, $, S, server(), setMode, openDialog, changed, now, esc, label, meaningOf, keyFor, meshOf,
  //     boxOf, nodeKey, toast, setHot, markerOf(id), groupFill(id), tour()}
  const {V,THREE,CSS2DObject,$,S}=A;
  let pick=null;                                                   // {pin, stop, keys} while choosing the new spot
  const trails=new Map();                                          // pin id -> {dot, line}
  const trailGroup=new THREE.Group();trailGroup.name='Repin trails';V.scene.add(trailGroup);

  const isRepinned=p=>!!p.repinned_at&&(p.status==='open'||p.status==='reopened');
  const lastHist=p=>(p.history||[])[(p.history||[]).length-1]||null;
  const wasLine=h=>h?`was: ${A.label(h.issue_class)}, ${h.note||A.meaningOf(h.issue_class)}`:'';
  function stopPin(st){
    const d=S.decisions[st.id];
    return (d?.pin&&S.pins.find(p=>p.id===d.pin))||[...S.pins].reverse().find(p=>p.tour_stop===st.id)||null;
  }
  function stopKeys(st){const nk=A.nodeKey();return st.parts.map(p=>V.nodes.has(p)?p:nk.get(p)).filter(Boolean);}

  // ---- start: the pick state ----
  function start(p,stop=null){
    if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();
    pick={pin:p?.id||null,stop:stop?.id||null,keys:stop?stopKeys(stop):null,stopNote:stop?.note||''};
    A.setMode('pin');
    const h=$('modehint');h.hidden=false;h.textContent=REPIN_HINT;
    A.toast(p?`Repin <b>#${p.n}</b>: click the spot that is wrong now, or press Enter to keep the old spot.`:
      `Repin tour stop: click the spot that is wrong now, or press Enter to pin the stop's parts.`,false,3500);
  }
  function onMode(m){if(m!=='pin')pick=null;}
  // a click in Pin mode while picking (point or edge)
  function picked(hit){
    if(!pick)return false;
    const c={...hit};end(c,false);return true;
  }
  function onKey(e){
    if(!pick)return false;
    if(e.key==='Escape'||e.key==='Enter'){e.preventDefault?.();end(null,true);return true;}
    return false;
  }
  // open the prefilled card at the new spot (c) or at the old one (keep)
  function end(c,keep){
    const P=pick;pick=null;A.setMode('select');
    const p=P.pin&&S.pins.find(x=>x.id===P.pin);
    if(!p){                                                       // a tour stop without a pin: a new pin
      const base=keep||!c?{kind:'region',keys:P.keys||[]}:c;
      A.openDialog({...base,title:'Repin tour stop',note:`Tour stop ${P.stop} still wrong: ${P.stopNote}`,
        issue_class:'intent_misread',source:'tour',tour_stop:P.stop,
        after:pin=>{S.decisions[P.stop]={decision:'reject',at:A.now(),pin:pin.id};}});
      return;
    }
    let base=c;
    if(keep||!c){
      if(p.anchor){const k=A.keyFor(p.anchor.part),m=k&&A.meshOf(k);
        base={kind:p.kind==='edge'&&p.edge?'edge':'point',edge:p.edge||null,keepAnchor:true,
          info:{name:k?(V.nodes.get(k).leaf?.name||k):p.anchor.part.node,local:p.anchor.local,world:p.anchor.world,mesh:m||null,part:p.anchor.part}};
        if(base.kind==='edge'&&!m)base.kind='point';
      }else base={kind:'region',keys:(p.parts||[]).map(A.keyFor).filter(Boolean),keepAnchor:true};
    }
    A.openDialog({...base,repin:p.id,stop:P.stop,title:`Repin #${p.n}`,repinN:p.n,note:p.note||'',issue_class:p.issue_class,
      severity:p.severity,was:wasLine(p)});
  }

  // ---- save: the same pin id, one undo step ----
  function save(c,v){
    const p=S.pins.find(x=>x.id===c.repin);if(!p)return false;
    const build=A.server()?.build||null,t=A.now();
    const prev={at:t,build,kind:p.kind,anchor:p.anchor||null,edge:p.edge||null,parts:JSON.parse(JSON.stringify(p.parts||[])),
      issue_class:p.issue_class,note:p.note||'',severity:p.severity,status:p.status,attempts:p.attempts||0,tour_stop:p.tour_stop||null};
    p.history=[...(p.history||[]),prev];
    if(!c.keepAnchor){
      if(c.kind==='point'||c.kind==='edge'){const i=c.info;
        p.kind=c.kind;p.anchor={part:i.part,local:i.local,normal_local:i.normal_local,world:i.world,normal_world:i.normal_world,bbox:i.bbox};
        p.parts=[i.part];p.rect=null;if(c.kind==='edge')p.edge=c.edge;else delete p.edge;
      }else{p.kind='region';p.anchor=null;delete p.edge;p.parts=(c.keys||[]).map(k=>V.partRef(k)).filter(Boolean);p.rect=c.rect||null;}
    }
    Object.assign(p,{issue_class:v.issue_class,note:v.note,severity:v.severity,status:'open',attempts:(p.attempts||0)+1,
      repinned_at:t,repinned_build:build,updated:t,resolved_at:null,resolved_build:null,reopened_at:null,reopened_reason:null,camera:V.camera()});
    if(c.stop)S.decisions[c.stop]={decision:'reject',at:t,pin:p.id};
    S.pins.splice(S.pins.indexOf(p),1);S.pins.unshift(p);         // to the top of the list
    A.setHot(p.id);A.changed();
    A.toast(`Pin <b>#${p.n}</b> repinned (attempt ${p.attempts}). The next packet lists it first with its history.`,true,3500);
    return true;
  }

  // ---- panels ----
  // when to offer Repin on a pin: resolved, not fixed, or its part changed since the packet
  const offer=(p,partChanged)=>p.status==='resolved'||p.status==='not_fixed'||!!partChanged;
  const badge=p=>isRepinned(p)?`<span class="chip repinned">Repinned, attempt ${p.attempts||1}</span>`:'';
  const was=p=>isRepinned(p)&&lastHist(p)?`<div class="was">${A.esc(wasLine(lastHist(p)))}</div>`:'';

  // ---- the old spot: a hollow marker and a thin line to the new one ----
  const _a=new THREE.Vector3(),_b=new THREE.Vector3();
  function oldWorld(h,out){
    if(h.anchor){const k=A.keyFor(h.anchor.part);if(k){const m=A.meshOf(k);m.updateMatrixWorld();return out.set(...h.anchor.local).applyMatrix4(m.matrixWorld);}
      return out.set(...h.anchor.world);}
    const keys=(h.parts||[]).map(A.keyFor).filter(Boolean);if(!keys.length)return null;
    const b=A.boxOf(keys);return b.isEmpty()?null:b.getCenter(out);
  }
  function renderTrails(){
    for(const [,t] of trails){t.dot.removeFromParent();t.dot.element.remove();t.line.removeFromParent();t.line.geometry.dispose();}
    trails.clear();
    for(const p of S.pins){
      if(!isRepinned(p))continue;const h=lastHist(p);if(!h)continue;
      const el=document.createElement('div');el.className='pin-old';el.dataset.pin=p.id;el.title=`#${p.n} was here: ${wasLine(h)}`;
      const dot=new CSS2DObject(el);dot.center.set(0.5,0.5);V.scene.add(dot);
      const g=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]);
      const line=new THREE.Line(g,new THREE.LineBasicMaterial({color:0xf85149,depthTest:false,transparent:true,opacity:0.9}));
      line.renderOrder=11;line.frustumCulled=false;trailGroup.add(line);
      trails.set(p.id,{dot,line,h,p});
    }
    update();
  }
  function update(){
    for(const [id,t] of trails){
      const m=A.markerOf(id),a=oldWorld(t.h,_a);
      if(!m||!a){t.dot.visible=false;t.line.visible=false;continue;}
      m.getWorldPosition(_b);
      const same=a.distanceTo(_b)<1e-3;
      t.dot.position.copy(a);t.dot.visible=!same&&m.visible!==false;t.line.visible=t.dot.visible;
      const pos=t.line.geometry.attributes.position;pos.setXYZ(0,a.x,a.y,a.z);pos.setXYZ(1,_b.x,_b.y,_b.z);pos.needsUpdate=true;
    }
  }
  const state=()=>({picking:!!pick,pick:pick?{pin:pick.pin,stop:pick.stop}:null,trails:[...trails].filter(([,t])=>t.dot.visible).map(([id])=>id)});
  return {start,onMode,picked,onKey,save,offer,badge,was,wasLine,isRepinned,stopPin,renderTrails,beforeLabels:update,state,
    picking:()=>!!pick};
}
