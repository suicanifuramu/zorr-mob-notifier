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

// Canonical rules keep targets/variants as arrays. Legacy rules stored one
// scalar target/variant; these helpers read both shapes without rewriting.
export function ruleTargets(rule) {
  if(rule?.targets!==undefined)return Array.isArray(rule.targets)?rule.targets:[];
  if(!rule || rule.kind==='any' || typeof rule.target!=='string')return [];
  return [rule.target];
}

export function ruleVariants(rule) {
  if(rule?.variants!==undefined)return Array.isArray(rule.variants)?rule.variants:[];
  if(typeof rule?.variant==='string')return [rule.variant];
  return ['*'];
}

function validSlugList(values,slugs,max) {
  if(!Array.isArray(values)||values.length<1||values.length>max)return false;
  const seen=new Set();
  for(const slug of values){
    if(typeof slug!=='string'||!slugs.has(slug)||seen.has(slug))return false;
    seen.add(slug);
  }
  return true;
}

function validVariantList(catalog,values) {
  if(!Array.isArray(values)||values.length<1||values.length>catalog.variants.length)return false;
  if(values.length===1&&values[0]==='*')return true;
  if(values.includes('*'))return false;
  return validSlugList(values,catalog.variantBySlug,catalog.variants.length);
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
  if(!rule?.enabled || !catalog.mobBySlug.has(event.mob))return false;
  const mobMin=Number.isInteger(rule.mobMin)?rule.mobMin:(rule.kind==='petal'?0:8);
  if(event.rarity < mobMin)return false;
  const variants=ruleVariants(rule);
  if(!(variants.length===1&&variants[0]==='*') && !variants.includes(event.variant))return false;
  if(rule.kind==='any')return true;
  const targets=ruleTargets(rule);
  if(rule.kind==='mob')return targets.includes(event.mob);
  if(rule.kind==='petal'){
    // Saved petal rarity thresholds use the possible rarity range. Gallery
    // probabilities are rounded separately for display.
    const dropMin=Number.isInteger(rule.dropMin)?rule.dropMin:0;
    const highestPossible=Math.min(7,Math.max(1,event.rarity));
    return dropMin<=highestPossible && dropsFor(catalog,event).some(d=>targets.includes(d.petal.slug));
  }
  return false;
}

// A rule matches once no matter how many of its selected petals a spawn drops.
export const matchingRules=(catalog,event,rules)=>rules.filter(rule=>matchesRule(catalog,event,rule));

export function validateRule(catalog,rule) {
  if(!rule || typeof rule.id!=='string' || rule.id.length>=100 ||
    !['petal','mob','any'].includes(rule.kind) || typeof rule.enabled!=='boolean')return false;
  if(rule.mobMin!==undefined && (!Number.isInteger(rule.mobMin) || rule.mobMin<0 || rule.mobMin>9))return false;
  if(rule.dropMin!==undefined && (!Number.isInteger(rule.dropMin) || rule.dropMin<0 || rule.dropMin>7))return false;
  if(rule.targets!==undefined && !Array.isArray(rule.targets))return false;
  if(rule.variants!==undefined && !Array.isArray(rule.variants))return false;
  if(Array.isArray(rule.targets)){
    // Canonical arrays take precedence over stale legacy scalars.
    if(rule.kind==='any'){
      if(rule.targets.length!==0)return false;
    }else{
      const slugs=rule.kind==='mob'?catalog.mobBySlug:catalog.petalBySlug;
      const max=rule.kind==='mob'?catalog.mobs.length:catalog.petals.length;
      if(!validSlugList(rule.targets,slugs,max))return false;
    }
  }else if(rule.kind!=='any'){
    const slugs=rule.kind==='mob'?catalog.mobBySlug:catalog.petalBySlug;
    if(typeof rule.target!=='string'||!slugs.has(rule.target))return false;
  }
  if(Array.isArray(rule.variants)){
    if(!validVariantList(catalog,rule.variants))return false;
  }else if(rule.variant!=='*' &&
    !(typeof rule.variant==='string'&&catalog.variantBySlug.has(rule.variant)))return false;
  return true;
}

// Canonical form written back to storage. Petal rules ignore variant and mob
// thresholds; mob/any rules default their mob rarity threshold to Omega (8).
export function normalizeRule(catalog,rule) {
  if(!validateRule(catalog,rule))return null;
  const kind=rule.kind;
  return {
    id:rule.id,
    kind,
    targets:kind==='any'?[]:[...new Set(ruleTargets(rule))],
    variants:kind==='petal'?['*']:[...new Set(ruleVariants(rule))],
    mobMin:kind==='petal'?0:(Number.isInteger(rule.mobMin)?rule.mobMin:8),
    dropMin:kind==='petal'?0:(Number.isInteger(rule.dropMin)?rule.dropMin:0),
    enabled:rule.enabled,
  };
}

export function validEvent(catalog,event) {
  return event && Number.isSafeInteger(event.id) && event.id>0 &&
    typeof event.key==='string' && event.key.length<=150 && catalog.mobBySlug.has(event.mob) &&
    Number.isInteger(event.rarity) && event.rarity>=0 && event.rarity<=9 &&
    catalog.variantBySlug.has(event.variant) && Number.isFinite(Date.parse(event.createdAt));
}
