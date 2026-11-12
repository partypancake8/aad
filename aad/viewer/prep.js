// prep.js: per-part preparation shared by the page (view.js, measure.js) and the background preparer
// (prep_worker.js). Plain typed-array functions with no three.js dependency, so the same code runs in both places:
//   weldIds      positions quantized to 0.1 micrometre (the 1e4 grid EdgesGeometry and the edge pick use) -> one id
//                per distinct point; the same equality as the "x,y,z" string keys it replaces, without the strings
//   solidOf      volume, volume centroid and closed-shell flag of a triangle mesh (the orbit pivot's weights)
//   csr          a compressed adjacency list (vertex -> segments, vertex -> triangles) in push order
//   segGrid      a uniform grid over a part's feature-edge segments, part-local, so an edge pick tests only the
//                segments near the pointer ray instead of every segment of every part
//   gridQuery    the segment ids within a tolerance tube around a ray (a superset of what the screen test accepts)

// open addressing on exact quantized coordinates; ids are assigned in first-seen order
export function weldIds(a,count,q=1e4){
  const vw=new Int32Array(count);let cap=1;while(cap<count*2)cap<<=1;cap=Math.max(cap,16);
  const kx=new Float64Array(cap),ky=new Float64Array(cap),kz=new Float64Array(cap),slot=new Int32Array(cap).fill(-1);
  let n=0;const mask=cap-1;
  for(let i=0;i<count;i++){
    const x=Math.round(a[3*i]*q)+0,y=Math.round(a[3*i+1]*q)+0,z=Math.round(a[3*i+2]*q)+0;   // +0: -0 and 0 are one key
    let h=(Math.imul(x|0,73856093)^Math.imul(y|0,19349663)^Math.imul(z|0,83492791))&mask;
    for(;;){
      const s=slot[h];
      if(s<0){slot[h]=n;kx[h]=x;ky[h]=y;kz[h]=z;vw[i]=n++;break;}
      if(kx[h]===x&&ky[h]===y&&kz[h]===z){vw[i]=s;break;}
      h=(h+1)&mask;
    }
  }
  return {vw,n};
}

// the same numbers as the page's former solidOf: signed tetrahedra from the origin, closed when every welded edge is
// shared by exactly two triangles
export function solidOf(pos,idx){
  const count=pos.length/3,n=idx?idx.length/3:count/3,{vw}=weldIds(pos,count),edges=new Map();
  let V=0,cx=0,cy=0,cz=0;
  for(let t=0;t<n;t++){
    const i0=idx?idx[3*t]:3*t,i1=idx?idx[3*t+1]:3*t+1,i2=idx?idx[3*t+2]:3*t+2;
    const ax=pos[3*i0],ay=pos[3*i0+1],az=pos[3*i0+2],bx=pos[3*i1],by=pos[3*i1+1],bz=pos[3*i1+2],qx=pos[3*i2],qy=pos[3*i2+1],qz=pos[3*i2+2];
    const v=(ax*(by*qz-bz*qy)+ay*(bz*qx-bx*qz)+az*(bx*qy-by*qx))/6;V+=v;
    cx+=(ax+bx+qx)*v/4;cy+=(ay+by+qy)*v/4;cz+=(az+bz+qz)*v/4;
    const w0=vw[i0],w1=vw[i1],w2=vw[i2];
    if(w0!==w1){const k=w0<w1?w0*2097152+w1:w1*2097152+w0;edges.set(k,(edges.get(k)||0)+1);}
    if(w1!==w2){const k=w1<w2?w1*2097152+w2:w2*2097152+w1;edges.set(k,(edges.get(k)||0)+1);}
    if(w2!==w0){const k=w2<w0?w2*2097152+w0:w0*2097152+w2;edges.set(k,(edges.get(k)||0)+1);}
  }
  let closed=n>0&&Math.abs(V)>1e-9;if(closed)for(const m of edges.values())if(m!==2){closed=false;break;}
  return {closed,volume:Math.abs(V),centroid:closed?[cx/V,cy/V,cz/V]:null};
}

// item lists per key in push order: for each record r (ascending), keys(r) in order
export function csr(nKeys,nRec,per,keyAt){
  const start=new Int32Array(nKeys+1);
  for(let r=0;r<nRec;r++)for(let j=0;j<per;j++)start[keyAt(r,j)+1]++;
  for(let k=0;k<nKeys;k++)start[k+1]+=start[k];
  const fill=start.slice(0,nKeys),items=new Int32Array(start[nKeys]);
  for(let r=0;r<nRec;r++)for(let j=0;j<per;j++)items[fill[keyAt(r,j)]++]=r;
  return {start,items};
}
// a CSR as the Map-like the edge chain walk and the measure plane test read (get(key) -> the key's items)
export const csrMap=c=>({get:k=>c.start&&k>=0&&k+1<c.start.length?c.items.subarray(c.start[k],c.start[k+1]):undefined});

// edge vertex ids and the vertex -> segment lists of a LineSegments position array
export function edgeTopology(a){
  const nv=a.length/3,n=nv/2,{vw:vid,n:nIds}=weldIds(a,nv);
  const adj=csr(nIds,n,2,(s,j)=>vid[2*s+j]);
  return {vid,adjStart:adj.start,adjItems:adj.items};
}

// ---- segment grid ----
// Cubic cells sized for about two segments per cell (at most 64 cells a side). A segment is entered in every cell
// that a sample along it at most a quarter cell apart falls in, so every point of it is within a quarter cell of a
// sample in a listed cell.
export function segGrid(a){
  const n=a.length/6;if(!n)return null;
  let x0=Infinity,y0=Infinity,z0=Infinity,x1=-Infinity,y1=-Infinity,z1=-Infinity;
  for(let i=0;i<a.length;i+=3){const x=a[i],y=a[i+1],z=a[i+2];if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;if(z<z0)z0=z;if(z>z1)z1=z;}
  const ex=x1-x0,ey=y1-y0,ez=z1-z0,big=Math.max(ex,ey,ez,1e-6);
  let cell=Math.max(big/64,Math.cbrt(Math.max(ex,big/64)*Math.max(ey,big/64)*Math.max(ez,big/64)/Math.max(1,n/2)));
  const nx=Math.floor(ex/cell)+1,ny=Math.floor(ey/cell)+1,nz=Math.floor(ez/cell)+1,nc=nx*ny*nz;
  const cellOf=(x,y,z)=>{const i=Math.min(nx-1,Math.max(0,Math.floor((x-x0)/cell))),j=Math.min(ny-1,Math.max(0,Math.floor((y-y0)/cell))),k=Math.min(nz-1,Math.max(0,Math.floor((z-z0)/cell)));return (k*ny+j)*nx+i;};
  const step=cell/4;
  const visit=(s,f)=>{const ax=a[6*s],ay=a[6*s+1],az=a[6*s+2],dx=a[6*s+3]-ax,dy=a[6*s+4]-ay,dz=a[6*s+5]-az;
    const m=Math.max(1,Math.ceil(Math.hypot(dx,dy,dz)/step));let last=-1;
    for(let i=0;i<=m;i++){const t=i/m,c=cellOf(ax+dx*t,ay+dy*t,az+dz*t);if(c!==last){f(c);last=c;}}};
  // two passes (count, fill); a cell met twice by one segment (it can leave and come back) is deduplicated at query
  const start=new Int32Array(nc+1);
  for(let s=0;s<n;s++)visit(s,c=>{start[c+1]++;});
  for(let c=0;c<nc;c++)start[c+1]+=start[c];
  const fill=start.slice(0,nc),items=new Int32Array(start[nc]);
  for(let s=0;s<n;s++)visit(s,c=>{items[fill[c]++]=s;});
  return {min:[x0,y0,z0],max:[x1,y1,z1],cell,dims:[nx,ny,nz],start,items,n};
}
// Segment ids (ascending) with a point within tol(t)=k0+k1*t of the ray o+t*u (part-local, u a unit vector, t>=0).
// The tube is walked in steps h of half a cell or half the tolerance, whichever is longer; each step takes the cells
// of a box of half-size tol+h+cell around the ray point, which covers every point within tol of the ray over that
// step plus the quarter-cell sampling slack of segGrid. scratch: {cellMark, segMark, gen} reused across calls.
export function gridQuery(G,o,u,k0,k1,scratch){
  const [x0,y0,z0]=G.min,[x1,y1,z1]=G.max,[nx,ny,nz]=G.dims,cell=G.cell;
  // the ray's span inside the box grown by the largest tolerance it can need
  const far=Math.hypot(Math.max(Math.abs(o[0]-x0),Math.abs(o[0]-x1)),Math.max(Math.abs(o[1]-y0),Math.abs(o[1]-y1)),Math.max(Math.abs(o[2]-z0),Math.abs(o[2]-z1)));
  const E=k0+k1*far+cell;
  let ta=0,tb=far+E;
  for(let ax=0;ax<3;ax++){
    const lo=G.min[ax]-E,hi=G.max[ax]+E,oa=o[ax],ua=u[ax];
    if(Math.abs(ua)<1e-12){if(oa<lo||oa>hi)return [];continue;}
    let t1=(lo-oa)/ua,t2=(hi-oa)/ua;if(t1>t2){const s=t1;t1=t2;t2=s;}
    if(t1>ta)ta=t1;if(t2<tb)tb=t2;if(ta>tb)return [];
  }
  const nc=nx*ny*nz;
  if(!scratch.cellMark||scratch.cellMark.length<nc)scratch.cellMark=new Uint32Array(nc);
  if(!scratch.segMark||scratch.segMark.length<G.n)scratch.segMark=new Uint32Array(G.n);
  const gen=scratch.gen=(scratch.gen+1)>>>0||1;
  const cm=scratch.cellMark,sm=scratch.segMark,out=[];let cells=0;
  for(let t=ta;;){
    // the tolerance only grows along the ray (k1 >= 0), so its value at the step's far end covers the whole step
    const h=Math.max(cell/2,(k0+k1*t)/2),tol=k0+k1*(t+h);
    const m=tol+h+cell,px=o[0]+u[0]*t,py=o[1]+u[1]*t,pz=o[2]+u[2]*t;
    const i0=Math.max(0,Math.floor((px-m-x0)/cell)),i1=Math.min(nx-1,Math.floor((px+m-x0)/cell));
    const j0=Math.max(0,Math.floor((py-m-y0)/cell)),j1=Math.min(ny-1,Math.floor((py+m-y0)/cell));
    const q0=Math.max(0,Math.floor((pz-m-z0)/cell)),q1=Math.min(nz-1,Math.floor((pz+m-z0)/cell));
    for(let k=q0;k<=q1;k++)for(let j=j0;j<=j1;j++){let c=(k*ny+j)*nx+i0;for(let i=i0;i<=i1;i++,c++){
      if(cm[c]===gen)continue;cm[c]=gen;cells++;
      for(let p=G.start[c],e=G.start[c+1];p<e;p++){const s=G.items[p];if(sm[s]!==gen){sm[s]=gen;out.push(s);}}
    }}
    if(t>=tb)break;t=Math.min(tb,t+h);
  }
  scratch.cells=cells;
  return out.sort((p,q)=>p-q);
}
