export const normalizeName = value => String(value).toLowerCase().replace(/[^a-z0-9]/g,'');

function flashSlugSet(rows) {
  const slugs=new Set();
  for(const row of rows||[])slugs.add(row[0]);
  return slugs;
}

export function indexCatalog(catalog) {
  return {...catalog,
    mobBySlug:new Map(catalog.mobs.map(m=>[m.slug,m])),
    petalBySlug:new Map(catalog.petals.map(p=>[p.slug,p])),
    variantBySlug:new Map(catalog.variants.map(v=>[v.slug,v])),
    flashCandidateSlugs:flashSlugSet(catalog.flashDrops),
  };
}

export function dropsFor(catalog,event) {
  const mob=catalog.mobBySlug.get(event.mob);
  if(!mob)return [];
  const magic=event.variant==='magic'||event.variant==='arcane';
  const flashCandidates=catalog.flashCandidateSlugs||flashSlugSet(catalog.flashDrops);
  // Each source row stays its own roll. A Magic replacement can map several rows
  // to one petal (Mark/Void Mark/Frozen Mark/Poo Mark -> Magic Mark); those rolls
  // are listed separately instead of being merged or treated as independent.
  const drops=new Map();
  const addRoll=(slug,q,fromFlashChoice)=>{
    let petal=catalog.petalBySlug.get(slug);
    if(!petal || !(q>0))return;
    if(magic){
      if(petal.magicPetal)petal=catalog.petalBySlug.get(petal.magicPetal);
      else if(petal.pet)return;
    }
    if(!petal)return;
    // Only the Flash variant's extra candidate rows are conditional. Ticket is
    // always added with Flash, and mob rows are never conditional, even when the
    // same slug also appears as a Flash candidate.
    const conditional=fromFlashChoice && flashCandidates.has(slug);
    const drop=drops.get(petal.slug)||{petal,q,conditional:true,rolls:[]};
    drop.rolls.push({q,conditional});drop.conditional&&=conditional;drops.set(petal.slug,drop);
  };
  const sources=[
    {rows:mob.drops,fromFlashChoice:false},
    {rows:catalog.variantDrops[event.variant]||[],fromFlashChoice:event.variant==='flash'},
  ];
  for(const source of sources)
    for(let index=0;index<source.rows.length;index++){
      const [slug,q]=source.rows[index];
      addRoll(slug,q,source.fromFlashChoice);
    }
  return [...drops.values()];
}

export function matchesRule(catalog,event,rule) {
  if(!rule.enabled || !catalog.mobBySlug.has(event.mob) || event.rarity < rule.mobMin)return false;
  if(rule.variant!=='*' && rule.variant!==event.variant)return false;
  if(rule.kind==='any')return true;
  if(rule.kind==='mob')return event.mob===rule.target;
  if(rule.kind==='petal'){
    // Do not round tiny probabilities to zero. This is a possible-drop filter,
    // not a guarantee or a claim about the server's luck/buff implementation.
    const highestPossible=Math.min(7,Math.max(1,event.rarity));
    return rule.dropMin<=highestPossible && dropsFor(catalog,event).some(d=>d.petal.slug===rule.target);
  }
  return false;
}

export const matchingRules=(catalog,event,rules)=>rules.filter(rule=>matchesRule(catalog,event,rule));

export function validateRule(catalog,rule) {
  return rule && typeof rule.id==='string' && rule.id.length<100 &&
    ['petal','mob','any'].includes(rule.kind) && typeof rule.enabled==='boolean' &&
    Number.isInteger(rule.mobMin) && rule.mobMin>=0 && rule.mobMin<=9 &&
    Number.isInteger(rule.dropMin) && rule.dropMin>=0 && rule.dropMin<=7 &&
    (rule.variant==='*'||catalog.variantBySlug.has(rule.variant)) &&
    (rule.kind==='any'||(rule.kind==='mob'?catalog.mobBySlug:catalog.petalBySlug).has(rule.target));
}

export function validEvent(catalog,event) {
  return event && Number.isSafeInteger(event.id) && event.id>0 &&
    typeof event.key==='string' && event.key.length<=150 && catalog.mobBySlug.has(event.mob) &&
    Number.isInteger(event.rarity) && event.rarity>=0 && event.rarity<=9 &&
    catalog.variantBySlug.has(event.variant) && Number.isFinite(Date.parse(event.createdAt));
}
