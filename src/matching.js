export const normalizeName = value => String(value).toLowerCase().replace(/[^a-z0-9]/g,'');

export function indexCatalog(catalog) {
  return {...catalog,
    mobBySlug:new Map(catalog.mobs.map(m=>[m.slug,m])),
    petalBySlug:new Map(catalog.petals.map(p=>[p.slug,p])),
    variantBySlug:new Map(catalog.variants.map(v=>[v.slug,v])),
  };
}

export function dropsFor(catalog,event) {
  const mob=catalog.mobBySlug.get(event.mob);
  if(!mob)return [];
  const pool=[...mob.drops,...(catalog.variantDrops[event.variant]||[])];
  const magic=event.variant==='magic'||event.variant==='arcane';
  const drops=new Map();
  for(const [slug,q] of pool){
    let petal=catalog.petalBySlug.get(slug);
    if(!petal || !(q>0))continue;
    if(magic){
      if(petal.magicPetal)petal=catalog.petalBySlug.get(petal.magicPetal);
      else if(petal.pet)continue;
    }
    if(petal)drops.set(petal.slug,{petal,q,conditional:event.variant==='flash' && catalog.flashDrops.some(d=>d[0]===slug)});
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
