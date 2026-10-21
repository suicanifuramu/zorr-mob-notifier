import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildAssetPlan,atlasLayout} from '../scripts/prepare-assets.mjs';

const catalog=JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url)));
const lightCounts=[3,3,3,3,5,5,6,6,8,11];

// Deliberately permute runtime IDs and ordering: physical frames must still be
// resolved by slug against the catalog's stable order.
function fixture(){
  const catalogMobs=catalog.mobs.map(({id,name,slug})=>({id,name,slug}));
  const catalogPetals=catalog.petals.map(({id,name,slug})=>({id,name,slug}));
  const runtimeMobs=catalogMobs.map((m,i)=>({id:(i*37+11)%179,name:m.name,slug:m.slug})).reverse();
  const runtimePetals=catalogPetals.map((p,i)=>({id:574-i,name:p.name,slug:p.slug})).reverse();
  const countsByRarity=catalogPetals.map(p=>({
    id:p.id,
    slug:p.slug,
    counts:p.slug==='light'?lightCounts:[1,1,1,1,1,1,1,1,1,1],
  }));
  return {catalogMobs,catalogPetals,runtimeMobs,runtimePetals,countsByRarity};
}

const planFor=()=>buildAssetPlan(fixture());

test('mob frames resolve by slug after the former ordering mismatch',()=>{
  const plan=planFor();
  const bySlug=new Map(plan.mobs.map(m=>[m.slug,m]));
  const bat=bySlug.get('bat_cave'),elasmosaurus=bySlug.get('elasmosaurus');
  assert.equal(bat.id,161);assert.equal(bat.iconIndex,160);
  assert.equal(elasmosaurus.id,176);assert.equal(elasmosaurus.iconIndex,175);
  // The old pipeline painted frame 161 with runtime ID 161 and cropped it for
  // catalog Bat Cave, which actually belongs at frame 160.
  assert.equal(plan.frames.mobs[160].slug,'bat_cave');
  assert.equal(plan.frames.mobs[161].slug,'vampire_digger');
  assert.equal(plan.frames.mobs[175].slug,'elasmosaurus');
  assert.equal(plan.frames.mobs[176].slug,'ankylosaurus');
  for(const [index,frame] of plan.frames.mobs.entries())assert.equal(frame.slug,catalog.mobs[index].slug);
  assert.deepEqual(plan.mobs.map(m=>m.iconIndex),[...Array(plan.mobs.length).keys()]);
});

test('petal rarities with different counts get distinct physical frames',()=>{
  const plan=planFor();
  const light=plan.petals.find(p=>p.slug==='light');
  assert.equal(light.iconIndices.length,8);
  assert.equal(light.iconIndices[0],light.iconIndices[3]);
  assert.equal(light.iconIndices[4],light.iconIndices[5]);
  assert.equal(light.iconIndices[6],light.iconIndices[7]);
  assert.notEqual(light.iconIndices[0],light.iconIndices[4]);
  assert.notEqual(light.iconIndices[4],light.iconIndices[6]);
  assert.equal(new Set(light.iconIndices).size,3);
  const counts=light.iconIndices.map(index=>plan.frames.petals[index].count);
  assert.deepEqual(counts,[3,3,3,3,5,5,6,6]);
  assert.equal(plan.cells.petals,577);
  const used=new Set(plan.petals.flatMap(p=>p.iconIndices));
  assert.equal(used.size,plan.cells.petals);
  for(const frame of plan.frames.petals)assert.ok(frame.index<plan.cells.petals);
});

test('missing, duplicate, or malformed definitions are rejected',()=>{
  const duplicateMob=fixture();duplicateMob.runtimeMobs.push({...duplicateMob.runtimeMobs[0],name:'Duplicate'});
  assert.throws(()=>buildAssetPlan(duplicateMob),/duplicate slug/);

  const missingMob=fixture();missingMob.runtimeMobs.pop();
  assert.throws(()=>buildAssetPlan(missingMob),/slug coverage/);

  const extraPetal=fixture();extraPetal.runtimePetals.push({id:999,name:'Extra',slug:'extra'});
  assert.throws(()=>buildAssetPlan(extraPetal),/slug coverage/);

  const duplicateName=fixture();duplicateName.runtimeMobs[1].name=duplicateName.runtimeMobs[0].name;
  assert.throws(()=>buildAssetPlan(duplicateName),/duplicate name/);

  const shortCounts=fixture();shortCounts.countsByRarity[0].counts=[1,2];
  assert.throws(()=>buildAssetPlan(shortCounts),/missing counts/);

  const invalidCount=fixture();invalidCount.countsByRarity[0].counts[7]=Number.NaN;
  assert.throws(()=>buildAssetPlan(invalidCount),/invalid count/);
});

test('audited catalog and generated atlases cover every frame',async()=>{
  const rendering=catalog.rendering;
  assert.equal(rendering.cellSize,128);
  assert.equal(rendering.mobCells,179);
  assert.equal(rendering.petalCells,607);
  assert.equal(catalog.mobs.length,179);
  assert.equal(catalog.petals.length,575);

  assert.deepEqual(catalog.mobs.map(m=>m.iconIndex).sort((a,b)=>a-b),[...Array(179).keys()]);
  assert.equal(new Set(catalog.mobs.map(m=>m.slug)).size,179);
  for(const mob of catalog.mobs)assert.ok(mob.iconIndex>=0&&mob.iconIndex<rendering.mobCells,mob.slug);

  const used=new Set();
  for(const petal of catalog.petals){
    assert.equal(petal.iconIndices.length,8,petal.slug);
    for(const index of petal.iconIndices){
      assert.ok(Number.isInteger(index)&&index>=0&&index<rendering.petalCells,petal.slug);
      used.add(index);
    }
  }
  assert.equal(used.size,rendering.petalCells);

  const layout={mobs:atlasLayout(rendering.mobCells,rendering.mobColumns,rendering.cellSize),petals:atlasLayout(rendering.petalCells,rendering.petalColumns,rendering.cellSize)};
  for(const [kind,name] of [['mobs','mob'],['petals','petal']]){
    const png=await readFile(new URL(`../public/assets/${name}-atlas.png`,import.meta.url));
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16),layout[kind].width,`${name} width`);
    assert.equal(png.readUInt32BE(20),layout[kind].height,`${name} height`);
    assert.ok(layout[kind].width*layout[kind].height>=rendering[`${name}Cells`]*rendering.cellSize**2);
  }
});
