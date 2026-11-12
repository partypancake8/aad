// measure.js: entity-based Measure for the aad viewer, like Fusion's. Each click picks an entity within the
// screen-space snap threshold, in priority order: a vertex (an end of a feature-edge chain: a corner or a junction),
// an edge (the same feature-edge chain the edge pin uses, view.js pickEdge), else a point on a face, with the face's
// plane when the hit triangle's neighbourhood is flat. A pair then reads the true dimension:
//   edge to edge      minimum distance between the edges; straight parallel edges: the perpendicular distance
//                     between their lines (clicks anywhere along them read the same), with the angle when not parallel
//   vertex to edge    perpendicular distance to the edge (its line when straight)
//   vertex to vertex  point distance
//   plane to plane    two points on parallel planar faces: the distance between the planes
//   vertex or straight edge to a parallel plane: distance to the plane
//   anything else     point to point between the clicks, labelled so
//   the same edge twice: its length along the chain
// Mesh level only: a curved edge is the polyline of its tessellation, so distances to it are within the mesh's chord
// tolerance. Labels sit beside their dimension line (offset along its screen normal) and step apart when two
// labels or a label and an end dot would overlap.
import {weldIds,csr,csrMap} from './prep.js';
export function initMeasure(V){
  const {THREE,CSS2DObject}=V;
  const VERT_PX=10,PAR_COS=Math.cos(0.5*Math.PI/180),FLAT_DEG=0.5,CREASE_DEG=35;
  const D=(a,b)=>a.distanceTo(b);
  const v3=a=>new THREE.Vector3(...a),arr=(v,n=4)=>v.toArray().map(x=>+x.toFixed(n));

  // ---- picking ----
  function toScreen(p){
    const r=V.canvas.getBoundingClientRect(),q=p.clone().project(V.cam);
    return {x:r.left+(q.x*0.5+0.5)*r.width,y:r.top+(0.5-q.y*0.5)*r.height,z:q.z};
  }
  function chainWorld(mesh,chain){mesh.updateMatrixWorld();return chain.pts.map(p=>p.clone().applyMatrix4(mesh.matrixWorld));}
  // a polyline is straight when every point lies within 0.005 mm (or 1e-4 of its length) of the line through its ends
  function straightness(pts){
    const a=pts[0],b=pts[pts.length-1],L=D(a,b);if(L<1e-9)return {straight:false,dir:null,length:0};
    const dir=b.clone().sub(a).divideScalar(L),tol=Math.max(0.005,1e-4*L);
    for(const p of pts){const t=p.clone().sub(a).dot(dir);if(p.distanceTo(a.clone().addScaledVector(dir,t))>tol)return {straight:false,dir,length:L};}
    return {straight:true,dir,length:L};
  }
  function chainLength(pts){let L=0;for(let i=1;i<pts.length;i++)L+=D(pts[i],pts[i-1]);return L;}
  // welded vertex -> triangles of a geometry (positions quantized to 0.1 micrometre), built once per geometry: the weld
  // from the background preparation of a large model when it has arrived, then compact lists (typed arrays, no
  // per-vertex strings or arrays, so the first hover over a part with a million triangles stays a few milliseconds)
  const adjCache=new WeakMap();
  function adjacency(geo){
    const had=adjCache.get(geo);if(had&&had.index===geo.index)return had;
    const pos=geo.attributes.position,idx=geo.index,ia=idx?idx.array:null,nt=idx?idx.count/3:pos.count/3;
    const P=V.prepOf?V.prepOf(geo):null,vw=P&&P.weld&&P.weld.length===pos.count?P.weld:weldIds(V.posArray(pos),pos.count).vw;
    let nIds=0;for(let i=0;i<vw.length;i++)if(vw[i]>=nIds)nIds=vw[i]+1;
    const byV=csrMap(csr(nIds,nt,3,ia?(t,j)=>vw[ia[3*t+j]]:(t,j)=>vw[3*t+j]));
    const tv=t=>ia?[ia[3*t],ia[3*t+1],ia[3*t+2]]:[3*t,3*t+1,3*t+2];
    const A={vw,byV,tv,pos,index:geo.index};adjCache.set(geo,A);return A;
  }
  const _ta=new THREE.Vector3(),_tb=new THREE.Vector3(),_tc=new THREE.Vector3();
  function triNormal(A,t,out){const [i,j,k]=A.tv(t);_ta.fromBufferAttribute(A.pos,i);_tb.fromBufferAttribute(A.pos,j);_tc.fromBufferAttribute(A.pos,k);
    return out.subVectors(_tb,_ta).cross(_tc.sub(_ta)).normalize();}
  // the face under a hit is planar when no triangle around it (sharing a vertex) meets it at a shallow angle: a
  // neighbour is either coplanar (within 0.5 deg) or across a crease (over 35 deg). A tessellated cylinder or fillet
  // has shallow neighbours, so it is not a plane.
  function planeAt(h){
    if(!h||!h.face||h.faceIndex==null)return null;
    const m=h.object,A=adjacency(m.geometry),t0=h.faceIndex,n0=triNormal(A,t0,new THREE.Vector3());
    if(!isFinite(n0.x)||n0.lengthSq()<0.5)return null;
    const seen=new Set([t0]),n=new THREE.Vector3();
    for(const v of A.tv(t0))for(const t of A.byV.get(A.vw[v])||[]){
      if(seen.has(t))continue;seen.add(t);triNormal(A,t,n);if(!isFinite(n.x)||n.lengthSq()<0.5)continue;
      const ang=Math.acos(Math.max(-1,Math.min(1,n.dot(n0))))*180/Math.PI;
      if(ang>FLAT_DEG&&ang<CREASE_DEG)return null;
    }
    m.updateMatrixWorld();
    return {n:n0.clone().transformDirection(m.matrixWorld).normalize(),p:h.point.clone()};
  }
  // ev: the pointer event, h: the face hit under it (V.pickHit), edge: the feature edge near it (V.pickEdge) or null
  function pick(ev,h,edge){
    if(edge){
      const pts=chainWorld(edge.mesh,edge.chain),info=V.pickInfo(edge.hit),st=straightness(pts);
      const ends=[pts[0],pts[pts.length-1]];
      for(const p of ends){const s=toScreen(p);if(Math.hypot(s.x-ev.clientX,s.y-ev.clientY)<=VERT_PX)
        return {type:'vertex',world:p.clone(),info:{...info,world:arr(p)},mesh:edge.mesh};}
      return {type:'edge',world:v3(info.world),info,mesh:edge.mesh,chain:edge.chain,pts,straight:st.straight,dir:st.dir,length:chainLength(pts)};
    }
    if(!h)return null;
    return fromHit(h);
  }
  function fromHit(h){const info=V.pickInfo(h);return {type:'face',world:v3(info.world),info,mesh:h.object,plane:planeAt(h)};}

  // ---- geometry ----
  function closestOnSeg(p,a,b){const ab=b.clone().sub(a),l2=ab.lengthSq();const t=l2>0?Math.max(0,Math.min(1,p.clone().sub(a).dot(ab)/l2)):0;return a.clone().addScaledVector(ab,t);}
  function closestOnPoly(p,pts){let best=null,bd=Infinity;for(let i=1;i<pts.length;i++){const c=closestOnSeg(p,pts[i-1],pts[i]),d=c.distanceTo(p);if(d<bd){bd=d;best={c,i};}}
    return best||{c:pts[0].clone(),i:1};}
  // closest points of segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection 5.1.9)
  function segSeg(p1,q1,p2,q2){
    const d1=q1.clone().sub(p1),d2=q2.clone().sub(p2),r=p1.clone().sub(p2),a=d1.dot(d1),e=d2.dot(d2),f=d2.dot(r),E=1e-12;
    let s,t;
    if(a<=E&&e<=E){s=t=0;}
    else if(a<=E){s=0;t=Math.max(0,Math.min(1,f/e));}
    else{const c=d1.dot(r);if(e<=E){t=0;s=Math.max(0,Math.min(1,-c/a));}
      else{const b=d1.dot(d2),den=a*e-b*b;s=den!==0?Math.max(0,Math.min(1,(b*f-c*e)/den)):0;t=(b*s+f)/e;
        if(t<0){t=0;s=Math.max(0,Math.min(1,-c/a));}else if(t>1){t=1;s=Math.max(0,Math.min(1,(b-c)/a));}}}
    const c1=p1.clone().addScaledVector(d1,s),c2=p2.clone().addScaledVector(d2,t);return {c1,c2,d:c1.distanceTo(c2),i:0,j:0};
  }
  function polyPoly(A,B){
    let best=null;const sa=Math.max(1,Math.ceil((A.length*B.length)/200000));
    for(let i=1;i<A.length;i+=sa)for(let j=1;j<B.length;j++){const r=segSeg(A[i-1],A[i],B[j-1],B[j]);if(!best||r.d<best.d){best=r;best.i=i;best.j=j;}}
    return best;
  }
  const angDeg=(u,v)=>{const c=Math.min(1,Math.abs(u.clone().normalize().dot(v.clone().normalize())));return Math.acos(c)*180/Math.PI;};
  const footOnLine=(p,a,dir)=>a.clone().addScaledVector(dir,p.clone().sub(a).dot(dir));
  function edgeEdge(A,B){
    if(A.mesh===B.mesh&&A.chain===B.chain){const p=A.pts;return {kind:'edge_length',a:p[0],b:p[p.length-1],distance:A.length,label:'edge length'};}
    if(A.straight&&B.straight&&Math.abs(A.dir.dot(B.dir))>=PAR_COS){
      // parallel lines: the span at the middle of the edges' overlap (else at A's click), square to both
      const a0=A.pts[0],tb=[B.pts[0],B.pts[B.pts.length-1]].map(p=>p.clone().sub(a0).dot(A.dir)).sort((x,y)=>x-y);
      const lo=Math.max(0,tb[0]),hi=Math.min(A.length,tb[1]);
      const t=lo<=hi?(lo+hi)/2:A.world.clone().sub(a0).dot(A.dir);
      const a=a0.clone().addScaledVector(A.dir,t),b=footOnLine(a,B.pts[0],B.dir);
      return {kind:'edge_edge',a,b,distance:D(a,b),angle:0,label:'edge to edge, parallel'};
    }
    const r=polyPoly(A.pts,B.pts);
    const da=A.straight?A.dir:A.pts[r.i].clone().sub(A.pts[r.i-1]),db=B.straight?B.dir:B.pts[r.j].clone().sub(B.pts[r.j-1]);
    return {kind:'edge_edge',a:r.c1,b:r.c2,distance:r.d,angle:angDeg(da,db),label:'edge to edge, minimum'};
  }
  function vertexEdge(P,E){
    const b=E.straight?footOnLine(P.world,E.pts[0],E.dir):closestOnPoly(P.world,E.pts).c;
    return {kind:'vertex_edge',a:P.world.clone(),b,distance:D(P.world,b),label:'vertex to edge'};
  }
  function toPlane(p,pl){const d=p.clone().sub(pl.p).dot(pl.n);return {b:p.clone().addScaledVector(pl.n,-d),d:Math.abs(d)};}
  // order: A and B as clicked; the result's a end is always on A
  function result(A,B){
    const T=A.type+'_'+B.type;let r=null,flip=false;
    const swap=x=>({...x,a:x.b,b:x.a});
    if(T==='edge_edge')r=edgeEdge(A,B);
    else if(T==='vertex_vertex')r={kind:'vertex_vertex',a:A.world.clone(),b:B.world.clone(),distance:D(A.world,B.world),label:'vertex to vertex'};
    else if(T==='vertex_edge')r=vertexEdge(A,B);
    else if(T==='edge_vertex'){r=swap(vertexEdge(B,A));}
    else if(T==='face_face'&&A.plane&&B.plane&&Math.abs(A.plane.n.dot(B.plane.n))>=PAR_COS){
      const t=toPlane(A.world,B.plane);r={kind:'plane_plane',a:A.world.clone(),b:t.b,distance:t.d,angle:0,label:'plane to plane, parallel'};
    }
    else if((T==='vertex_face'&&B.plane)||(T==='face_vertex'&&A.plane)){
      const [P,F]=T==='vertex_face'?[A,B]:[B,A],t=toPlane(P.world,F.plane);
      r={kind:'vertex_plane',a:P.world.clone(),b:t.b,distance:t.d,label:'vertex to plane'};flip=T!=='vertex_face';
    }
    else if((T==='edge_face'&&B.plane&&A.straight&&Math.abs(A.dir.dot(B.plane.n))<=Math.sin(0.5*Math.PI/180))||
            (T==='face_edge'&&A.plane&&B.straight&&Math.abs(B.dir.dot(A.plane.n))<=Math.sin(0.5*Math.PI/180))){
      const [E,F]=T==='edge_face'?[A,B]:[B,A],t=toPlane(E.world,F.plane);
      r={kind:'edge_plane',a:E.world.clone(),b:t.b,distance:t.d,angle:0,label:'edge to plane, parallel'};flip=T!=='edge_face';
    }
    if(r&&flip)r=swap(r);
    if(!r){
      r={kind:'point_point',a:A.world.clone(),b:B.world.clone(),distance:D(A.world,B.world),label:'point to point'};
      if(A.type==='face'&&B.type==='face'&&A.plane&&B.plane)r.angle=angDeg(A.plane.n,B.plane.n);
      else if(A.type==='edge'&&B.type==='edge'&&A.straight&&B.straight)r.angle=angDeg(A.dir,B.dir);
    }
    const d=r.b.clone().sub(r.a);
    return {kind:r.kind,label:r.label,a:arr(r.a),b:arr(r.b),distance:+r.distance.toFixed(4),delta:arr(d),
      angle_deg:r.angle==null?null:+r.angle.toFixed(3),point_distance:+D(A.world,B.world).toFixed(4),
      clicks:[arr(A.world),arr(B.world)],entities:[A.type,B.type],a_part:A.info.part,b_part:B.info.part};
  }
  // a single entity's own reading for the toast and the hover tip
  function describe(E){
    if(E.type==='edge')return `edge ${E.length.toFixed(2)} mm${E.straight?'':' (curved, along the polyline)'}`;
    if(E.type==='vertex')return 'vertex';
    return E.plane?'point on a planar face':'point on a face';
  }

  // ---- hover preview: a dot on the vertex the next click would take (the edge highlight is view.js's own) ----
  let hoverDot=null,raf=0,lastEv=null,active=()=>false;
  const pointer={x:null,y:null};
  function showHoverDot(p){
    if(!p){if(hoverDot){hoverDot.removeFromParent();hoverDot.element.remove();hoverDot=null;V.dirty();}return;}
    if(!hoverDot){const el=document.createElement('div');el.className='measure-dot hover';el.id='measure-hover-vertex';hoverDot=new CSS2DObject(el);V.scene.add(hoverDot);}
    hoverDot.position.copy(p);V.dirty();
  }
  V.canvas.addEventListener('pointermove',e=>{pointer.x=e.clientX;pointer.y=e.clientY;lastEv=e;if(raf)return;
    raf=requestAnimationFrame(()=>{raf=0;const ev=lastEv;if(!active()||(ev.buttons&&ev.buttons!==0)){showHoverDot(null);return;}
      if(V.moving)return;                             // no picking while the camera moves; the next move picks
      const h=V.pickHit(ev),E=pick(ev,h,V.pickEdge(ev,h));showHoverDot(E&&E.type==='vertex'?E.world:null);
      hoverEntity=E;});});
  V.canvas.addEventListener('pointerleave',()=>{pointer.x=pointer.y=null;showHoverDot(null);hoverEntity=null;});
  let hoverEntity=null;

  // ---- label layout: beside the line, off the end dots, apart from each other ----
  // items: [{a,b (Vector3 world), box (the label's inner element), dots: [Vector3]}] of the measurements shown now
  function layout(items){
    const host=V.host,W=host.clientWidth,H=host.clientHeight,placed=[],obst=[];
    const scr=p=>{const q=p.clone().project(V.cam);return {x:(q.x*0.5+0.5)*W,y:(0.5-q.y*0.5)*H,ok:q.z>=-1&&q.z<=1};};
    for(const it of items)for(const p of it.dots){const s=scr(p);obst.push({l:s.x-8,t:s.y-8,r:s.x+8,b:s.y+8});}
    const hit=(q,list)=>list.some(o=>!(q.l>=o.r||q.r<=o.l||q.t>=o.b||q.b<=o.t));
    for(const it of items){
      const A=scr(it.a),B=scr(it.b),mx=(A.x+B.x)/2,my=(A.y+B.y)/2,w=it.box.offsetWidth||60,h=it.box.offsetHeight||22;
      let dx=B.x-A.x,dy=B.y-A.y;const L=Math.hypot(dx,dy);
      let nx,ny;if(L<1){nx=0;ny=-1;}else{nx=-dy/L;ny=dx/L;if(ny>0||(ny===0&&nx<0)){nx=-nx;ny=-ny;}}   // the side facing up
      const base=Math.abs(nx)*w/2+Math.abs(ny)*h/2+10,step=h+6;
      // candidate offsets along the normal: this side, then the other side, stepping out one label height at a time
      let pos=null;
      for(const k of [0,-1,1,-2,2,-3,3,-4,4,-5,5]){
        const d=k>=0?base+k*step:-(base+(-k-1)*step),cx=mx+nx*d,cy=my+ny*d,q={l:cx-w/2,t:cy-h/2,r:cx+w/2,b:cy+h/2};
        if(!pos)pos={cx,cy,q};
        if(!hit(q,placed)&&!hit(q,obst)){pos={cx,cy,q};break;}
      }
      placed.push(pos.q);
      it.box.style.transform=`translate(${(pos.cx-mx).toFixed(1)}px,${(pos.cy-my).toFixed(1)}px)`;
      it.screen={x:pos.cx,y:pos.cy,w,h};
    }
  }
  return {pick,fromHit,result,describe,layout,toScreen,pointer,get hoverEntity(){return hoverEntity;},
    setActive:f=>{active=f;if(!f())showHoverDot(null);},hideHover:()=>showHoverDot(null)};
}
