// weight.js: the Weight estimate block at the bottom of the left panel and the right-click "Part info" card.
// Volume and surface area come from the server (/part-stats.json, the review diff's own per-part numbers:
// aad.review.mesh.stats, signed tetrahedron sum and triangle sum), so the page and `aad review diff` never
// disagree. Nothing is assigned to a part and nothing is written to the project: the last material and the print
// settings are remembered in this browser only.
//   solid   = density x volume
//   printed = density x (shell + infill x (volume - shell)), shell = min(area x wall thickness, volume)
// A part whose mesh is not a closed shell reads "open mesh, estimate unavailable", never a number.
export const MATERIALS=[
  {id:'pla',name:'PLA',rho:1.24,printed:true},{id:'petg',name:'PETG',rho:1.27,printed:true},
  {id:'acrylic',name:'Acrylic',rho:1.18,printed:false},{id:'alu',name:'Aluminium',rho:2.70,printed:false},
  {id:'steel',name:'Steel',rho:7.85,printed:false}];
const KEY='aad-viewer-weight';

export function estimate(st,mat,print){
  // st: {volume mm3, area mm2, closed}; returns grams (solid, printed or null)
  if(!st||!st.closed||!(st.volume>0))return null;
  const solid=mat.rho*st.volume/1000;
  let printed=null;
  if(mat.printed&&print.on){
    const shell=Math.min(st.area*print.walls,st.volume);
    printed=mat.rho*(shell+print.infill/100*(st.volume-shell))/1000;
  }
  return {solid,printed};
}
export const fmtMass=g=>g==null?'':g>=1000?(g/1000).toFixed(2)+' kg':g>=100?g.toFixed(0)+' g':g.toFixed(1)+' g';
const fmtVol=mm3=>(mm3/1000).toFixed(2)+' cm3';

export function initWeight(V){
  const {$}=V;
  let stats=null,statsFor=null,pending=null,last='';
  const S=(()=>{let o={};try{o=JSON.parse(localStorage.getItem(KEY)||'{}')||{};}catch(e){o={};}
    return {mat:MATERIALS.some(m=>m.id===o.mat)?o.mat:'pla',on:typeof o.on==='boolean'?o.on:true,
      infill:Number.isFinite(o.infill)?o.infill:20,walls:Number.isFinite(o.walls)?o.walls:1.2};})();
  const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(S));}catch(e){}};
  const mat=()=>MATERIALS.find(m=>m.id===S.mat);
  const print=()=>({on:S.on,infill:Math.max(0,Math.min(100,S.infill)),walls:Math.max(0,S.walls)});
  const sel=$('weight-material');
  for(const m of MATERIALS){const o=document.createElement('option');o.value=m.id;o.textContent=`${m.name}  ${m.rho.toFixed(2)} g/cm3`;sel.append(o);}
  sel.value=S.mat;$('weight-printed').checked=S.on;$('weight-infill').value=S.infill;$('weight-walls').value=S.walls;
  sel.onchange=()=>{S.mat=sel.value;save();render(true);};
  $('weight-printed').onchange=e=>{S.on=e.target.checked;save();render(true);};
  for(const [id,k] of [['weight-infill','infill'],['weight-walls','walls']])$(id).addEventListener('input',e=>{const v=parseFloat(e.target.value);if(Number.isFinite(v)){S[k]=v;save();render(true);}});

  // ---- stats from the server, matched to tree leaves by file and node name ----
  async function load(){
    const sig=JSON.stringify((V.M?.files||[]).map(f=>[f.name,f.mtime??null,f.size??null]))+(V.M?.version||'');
    if(stats&&statsFor===sig)return stats;
    if(pending)return pending;
    pending=(async()=>{try{const r=await V.fetch('/part-stats.json?ts='+Date.now());const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);
      stats=j;statsFor=sig;}catch(e){stats={parts:[],error:e.message};statsFor=sig;}finally{pending=null;}return stats;})();
    return pending;
  }
  function statFor(k){
    const r=V.nodes.get(k);if(!r||!r.leaf||!stats)return null;const n=r.leaf,f=V.M?.files?.[n.file];
    const inFile=stats.parts.filter(p=>!f||p.file===f.name);
    return inFile.find(p=>p.name===n.node)||(inFile.length===1&&f&&f.ext!=='.glb'?inFile[0]:null);
  }
  const leavesOf=k=>V.nodes.get(k)?.leaves||[];
  // the sum over keys: volume, area, triangles, and the estimate, or which parts have no usable mesh
  function sum(keys){
    const m=mat(),p=print();let vol=0,area=0,tris=0,solid=0,printed=0,open=[],missing=[];
    for(const k of keys){const st=statFor(k),nm=V.nodes.get(k)?.leaf?.name||k;
      if(!st){missing.push(nm);continue;}
      vol+=st.volume;area+=st.area;tris+=st.tris;
      const e=estimate(st,m,p);if(!e){open.push(nm);continue;}
      solid+=e.solid;if(e.printed!=null)printed+=e.printed;}
    const ok=!open.length&&!missing.length&&keys.length>0;
    return {n:keys.length,vol,area,tris,solid:ok?solid:null,printed:ok&&m.printed&&p.on?printed:null,open,missing,mat:m};
  }
  function visibleLeaves(){const out=[];for(const [k,r] of V.nodes)if(r.leaf&&V.leafShown(k)&&V.effVisible(r.obj))out.push(k);return out;}
  function readoutHTML(s,title,isTotal){
    const esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    let h=`<div class="wname">${esc(title)}</div>`;
    if(s.missing.length)return h+`<div class="wbad">no mesh data for ${esc(s.missing.slice(0,3).join(', '))}, estimate unavailable</div>`;
    if(s.open.length)return h+`<div class="wvol">${fmtVol(s.vol)}</div><div class="wbad">open mesh${s.n>1?` (${esc(s.open.slice(0,3).join(', '))}${s.open.length>3?', ...':''})`:''}, estimate unavailable</div>`;
    h+=`<div class="wvol">${fmtVol(s.vol)}${isTotal?'':`, area ${(s.area/100).toFixed(2)} cm2`}</div>`;
    h+=`<div class="wmass">${s.printed!=null?`solid <b>${fmtMass(s.solid)}</b>, printed about <b>${fmtMass(s.printed)}</b>`:`<b>${fmtMass(s.solid)}</b>`} <span class="muted">${esc(s.mat.name)}, estimate</span></div>`;
    return h;
  }
  async function render(force=false){
    const keys=V.sel?leavesOf(V.sel.key):visibleLeaves(),m=mat();
    $('weight-print-row').classList.toggle('off',!m.printed);$('weight-printed').disabled=!m.printed;
    $('weight-infill').disabled=$('weight-walls').disabled=!m.printed||!S.on;
    const sig=JSON.stringify([keys,S,statsFor]);if(!force&&sig===last)return;last=sig;
    await load();
    const s=sum(keys),out=$('weight-out');
    const title=V.sel?(keys.length===1?(V.nodes.get(keys[0]).leaf?.name||keys[0]):`${V.nodes.get(V.sel.key)?.obj?.name||'selection'} (${keys.length} parts)`):
      `Total of ${keys.length} visible part${keys.length===1?'':'s'}`;
    out.innerHTML=readoutHTML(s,title,!V.sel);
    Object.assign(out.dataset,{parts:String(s.n),volume:String(s.vol),area:String(s.area),solid:s.solid==null?'':String(s.solid),
      printed:s.printed==null?'':String(s.printed),total:V.sel?'0':'1',material:m.id});
    if(info.k)fillInfo();
  }
  // selection, visibility and model changes have no single event here: a cheap check four times a second
  setInterval(()=>{render(false);},250);

  // ---- Part info card (right-click > Part info) ----
  const card=$('part-info'),info={k:null};
  function infoLines(k){
    const r=V.nodes.get(k);if(!r)return [];const l=r.leaf||{},keys=leavesOf(k),s=sum(keys);
    const code=l.component||l.node||r.obj.name,path=r.path.join(' > ');
    let bb=null;for(const kk of keys){const st=statFor(kk);if(!st)continue;
      if(!bb)bb={min:[...st.bbox.min],max:[...st.bbox.max]};else for(let i=0;i<3;i++){bb.min[i]=Math.min(bb.min[i],st.bbox.min[i]);bb.max[i]=Math.max(bb.max[i],st.bbox.max[i]);}}
    const size=bb?bb.max.map((v,i)=>(v-bb.min[i]).toFixed(2)).join(' x ')+' mm':'unknown';
    const est=s.missing.length?'no mesh data, estimate unavailable':s.open.length?'open mesh, estimate unavailable':
      (s.printed!=null?`solid ${fmtMass(s.solid)}, printed about ${fmtMass(s.printed)}`:fmtMass(s.solid))+` (${s.mat.name} ${s.mat.rho.toFixed(2)} g/cm3${s.printed!=null?`, infill ${print().infill} %, walls ${print().walls} mm`:''}, estimate)`;
    return [['Code name',code],['Tree path',path],...(keys.length>1?[['Parts',String(keys.length)]]:[]),['Bounding box',size],
      ['Volume',s.missing.length?'unknown':fmtVol(s.vol)+(s.open.length?' (open mesh)':'')],['Surface area',s.missing.length?'unknown':(s.area/100).toFixed(2)+' cm2'],
      ['Triangles',String(s.tris)],['Weight',est]];
  }
  function fillInfo(){
    const lines=infoLines(info.k),dl=$('part-info-body');dl.replaceChildren();
    for(const [a,b] of lines){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=a;dd.textContent=b;dd.dataset.k=a;dl.append(dt,dd);}
    info.text=lines.map(([a,b])=>a+': '+b).join('\n');
  }
  async function partInfo(k,x,y){
    info.k=k;await load();fillInfo();card.hidden=false;
    const w=card.offsetWidth,h=card.offsetHeight;
    card.style.left=Math.max(8,Math.min(x+12,innerWidth-w-8))+'px';card.style.top=Math.max(8,Math.min(y,innerHeight-h-8))+'px';
  }
  function closeInfo(){card.hidden=true;info.k=null;}
  $('part-info-close').onclick=closeInfo;
  $('part-info-copy').onclick=async()=>{let done=false;try{await navigator.clipboard.writeText(info.text);done=true;}catch(e){
    try{const ta=document.createElement('textarea');ta.value=info.text;document.body.append(ta);ta.select();done=document.execCommand('copy');ta.remove();}catch(e2){}}
    info.copied=done?info.text:null;const b=$('part-info-copy').querySelector('span');b.textContent=done?'Copied':'Copy failed';setTimeout(()=>{b.textContent='Copy';},1500);};
  addEventListener('keydown',e=>{if(e.key==='Escape'&&!card.hidden){e.preventDefault();e.stopImmediatePropagation();closeInfo();}},true);
  for(const ev of ['pointerdown','dblclick','contextmenu','wheel'])card.addEventListener(ev,e=>e.stopPropagation());
  return {onModel:()=>{statsFor=null;render(true);},partInfo,render,
    state:()=>({material:S.mat,printed:S.on,infill:S.infill,walls:S.walls,stats:stats?stats.parts.length:null,info:info.k,copied:info.copied||null})};
}
