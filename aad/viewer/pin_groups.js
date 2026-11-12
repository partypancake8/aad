// pin_groups.js: the issue-class groups of the review workspace (Change request, Problem, Note to the agent, Other).
// Every class in issue_classes.json names its group; the pin card shows its chips in labelled groups in that order,
// markers and badges take the group's colour, the Issues tab counts by group then class, and keep pins (local
// locks) are flagged at the top of the Revisions tab when the geometry near them changed.
export const GROUPS_FALLBACK=[{id:'change_request',label:'Change request',badge:'Change'},{id:'problem',label:'Problem',badge:'Problem'},
  {id:'note',label:'Note to the agent',badge:'Note'},{id:'other',label:'Other',badge:'Other'}];
// marker fills (white numbers, white ring): distinct from resolved green #1a7f37 and not-fixed red #f85149, at least
// 3:1 against light, white and black viewports (the white ring carries the dark one)
export const GROUP_FILL={change_request:'#7c3aed',problem:'#b35900',note:'#0e7490',other:'#b35900'};
// pins that ask for nothing to change never show "Unchanged here since your packet"
export const NO_UNCHANGED_BADGE=new Set(['keep','question','reference']);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

export function groupOf(classes,id){return (classes.find(c=>c.id===id)||{}).group||(id==='other'?'other':'problem');}
export const groupFill=(classes,id)=>GROUP_FILL[groupOf(classes,id)]||GROUP_FILL.problem;

// the pin card's chips, one labelled row of chips per group; onPick(id) on a click
export function renderChipGroups(box,classes,groups,onPick){
  box.innerHTML='';
  for(const g of groups){
    const cs=classes.filter(c=>groupOf(classes,c.id)===g.id);if(!cs.length)continue;
    const sec=document.createElement('div');sec.className='cgroup g-'+g.id;sec.dataset.group=g.id;sec.setAttribute('role','group');sec.setAttribute('aria-label',g.label);
    sec.innerHTML=`<div class="cgl">${esc(g.label)}</div><div class="cgc"></div>`;
    for(const c of cs){const b=document.createElement('button');b.type='button';b.dataset.class=c.id;b.dataset.group=g.id;b.textContent=c.label;b.title=c.meaning||c.hint||'';
      b.onclick=()=>onPick(c.id);sec.lastElementChild.append(b);}
    box.append(sec);
  }
}

// the small group badge on a pin in the Pins list
export function groupBadge(classes,groups,id){
  const g=groupOf(classes,id),gg=groups.find(x=>x.id===g)||{badge:g};
  return `<span class="chip grp g-${g}" title="${esc(gg.label||g)}">${esc(gg.badge||gg.label||g)}</span>`;
}

// Issues tab: per group (in order) its total, then its classes by count
export function issuesHTML(classes,groups,tot,op){
  const max=Math.max(1,...Object.values(tot));let h='';
  for(const g of groups){
    const rows=classes.filter(c=>groupOf(classes,c.id)===g.id).map(c=>({c,n:tot[c.id]||0,o:op[c.id]||0}))
      .sort((a,b)=>b.n-a.n||a.c.label.localeCompare(b.c.label));
    if(!rows.length)continue;
    const n=rows.reduce((s,r)=>s+r.n,0),o=rows.reduce((s,r)=>s+r.o,0);
    h+=`<div class="igroup g-${g.id}" data-group="${g.id}"><div class="igh"><span>${esc(g.label)}</span><span class="bn">${n}${o?` (${o} open)`:''}</span></div>`+
      rows.map(r=>`<div class="bar" data-class="${r.c.id}" title="${esc(r.c.meaning||r.c.hint||'')}"><span class="bl">${esc(r.c.label)}</span><span class="bt"><span class="bf" style="display:block;width:${(100*r.n/max).toFixed(1)}%"></span></span><span class="bn">${r.n}${r.o?` (${r.o} open)`:''}</span></div>`).join('')+'</div>';
  }
  return h;
}

// top of the Revisions tab: keep pins whose neighbourhood changed (the server's diff `keep` list), shown like collateral
export function keepBanner(diff){
  const k=diff?.keep||[];if(!k.length)return '';
  return `<div class="banner keep" id="keep-banner"><b><i class="ic i-lock"></i>KEEP: ${k.length} spot${k.length===1?'':'s'} you locked changed</b><ul>${
    k.slice(0,12).map(x=>`<li data-pin="${esc(x.id)}">#${x.n} on ${esc(x.nodes.join(', '))}: ${x.near_changed==null?'its part changed':`geometry within ${x.radius_mm} mm changed`}</li>`).join('')}</ul></div>`;
}
