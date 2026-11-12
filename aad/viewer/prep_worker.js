// prep_worker.js: prepares one part of a large model off the page's main thread (view.js starts a few of these).
// For each part it builds what the page would otherwise build in one long blocking step after loading:
//   the three-mesh-bvh bounds tree (picking), with the triangle index reordered exactly as computeBoundsTree does,
//   the feature edges (THREE.EdgesGeometry at the part's crease angle) of that reordered geometry, so the segments
//   come out in the same order as on the page,
//   the edge segments' welded vertex ids and vertex -> segment lists (edge pick chains), a segment grid (edge pick),
//   the welded vertex ids of the part (Measure's flat-face test) and its volume, centroid and closed flag (the orbit
//   pivot).
// The three.js core is imported by URL; three-mesh-bvh imports the bare name 'three', which a worker cannot map, so
// its source is fetched once and imported from a blob with that one specifier pointed at the same core file.
import {solidOf,edgeTopology,segGrid,weldIds} from './prep.js';
let lib=null;
async function load(){
  if(lib)return lib;
  const core=new URL('vendor/three/build/three.core.js',self.location.href).href;
  const THREE=await import(core);
  const src=await (await fetch(new URL('vendor/three-mesh-bvh/three-mesh-bvh.module.js',self.location.href))).text();
  const url=URL.createObjectURL(new Blob([src.replace(/from\s*(['"])three\1/g,`from '${core}'`)],{type:'text/javascript'}));
  try{const {MeshBVH}=await import(url);lib={THREE,MeshBVH};}finally{URL.revokeObjectURL(url);}
  return lib;
}
self.onmessage=async e=>{
  const {id,pos,index,angle,edgesOnly}=e.data;
  try{
    const {THREE,MeshBVH}=await load();
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));
    if(index)g.setIndex(new THREE.BufferAttribute(index,1));
    if(edgesOnly){                       // the crease edges alone, in the geometry's own triangle order (hologram)
      const edges=new THREE.EdgesGeometry(g,angle).attributes.position.array;
      self.postMessage({id,ok:true,edges},[edges.buffer]);return;
    }
    const ser=MeshBVH.serialize(new MeshBVH(g),{cloneBuffers:false});                 // = computeBoundsTree()
    const idx=g.index.array;
    const edges=new THREE.EdgesGeometry(g,angle).attributes.position.array;
    const topo=edgeTopology(edges),grid=segGrid(edges),solid=solidOf(pos,idx),weld=weldIds(pos,pos.length/3).vw;
    const transfer=[...ser.roots,idx.buffer,edges.buffer,topo.vid.buffer,topo.adjStart.buffer,topo.adjItems.buffer,weld.buffer];
    if(grid)transfer.push(grid.start.buffer,grid.items.buffer);
    self.postMessage({id,ok:true,roots:ser.roots,index:idx,edges,topo,grid,solid,weld},transfer);
  }catch(err){self.postMessage({id,ok:false,error:String(err&&err.message||err)});}
};
