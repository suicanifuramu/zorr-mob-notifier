import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {indexCatalog,dropsFor,matchesRule,matchingRules,validateRule} from '../src/matching.js';
const catalog=indexCatalog(JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url))));
const rule=overrides=>({id:'test',kind:'petal',target:'moon',variant:'*',mobMin:0,dropMin:0,enabled:true,...overrides});
const spawn=overrides=>({mob:'rock',rarity:8,variant:'normal',...overrides});

test('petal rules include normal drops and generated eggs',()=>{
  assert.ok(matchesRule(catalog,spawn(),rule()));
  assert.ok(matchesRule(catalog,spawn(),rule({target:'rock_egg'})));
  assert.ok(!matchesRule(catalog,spawn({mob:'ladybug'}),rule()));
});
test('Magic and Arcane replace petals and omit unsupported pet eggs',()=>{
  for(const variant of ['magic','arcane']){
    const drops=dropsFor(catalog,spawn({mob:'ladybug',variant})).map(d=>d.petal.slug);
    assert.ok(drops.includes('magic_rose'));assert.ok(!drops.includes('rose'));
    assert.ok(!matchesRule(catalog,spawn({mob:'ladybug',variant}),rule({target:'rose'})));
    assert.ok(matchesRule(catalog,spawn({mob:'ladybug',variant}),rule({target:'magic_rose'})));
  }
});
test('variant extra drops and all possible Flash candidates are matched',()=>{
  assert.ok(matchesRule(catalog,spawn({variant:'angelic'}),rule({target:'halo'})));
  assert.ok(!matchesRule(catalog,spawn(),rule({target:'halo'})));
  for(const target of ['ticket','fractal','lithium','usain_bolt','hel_lightning','lightning'])
    assert.ok(matchesRule(catalog,spawn({variant:'flash'}),rule({target})),target);
});
test('base and Flash rows with the same slug and q stay separately classified',()=>{
  const synth=indexCatalog({
    mobs:[{slug:'echo',drops:[['fractal',0.1]]}],
    petals:catalog.petals,
    variants:catalog.variants,
    variantDrops:{flash:[['ticket',0.005],['fractal',0.1]]},
    flashDrops:[['fractal',0.1]],
  });
  const [fractal,ticket]=dropsFor(synth,{mob:'echo',variant:'flash'});
  assert.deepEqual(fractal.rolls,[{q:0.1,conditional:false},{q:0.1,conditional:true}]);
  assert.equal(fractal.q,0.1);
  assert.equal(fractal.conditional,false);
  assert.deepEqual(ticket.rolls,[{q:0.005,conditional:false}]);
  assert.equal(ticket.conditional,false);
});

test('only Flash candidate rows are conditional; base rows and Ticket are not',()=>{
  const drops=dropsFor(catalog,spawn({mob:'firefly',variant:'flash'}));
  const lightning=drops.find(drop=>drop.petal.slug==='lightning');
  assert.deepEqual(lightning.rolls,[{q:0.0075,conditional:false},{q:0.3,conditional:true}]);
  assert.equal(lightning.q,0.0075);
  assert.equal(lightning.conditional,false,`lightning also drops normally`);
  for(const slug of ['fractal','lithium','usain_bolt','hel_lightning'])
    assert.deepEqual(drops.find(drop=>drop.petal.slug===slug).rolls,[{q:slug==='fractal'?0.1:0.2,conditional:true}]);
  assert.deepEqual(drops.find(drop=>drop.petal.slug==='ticket').rolls,[{q:0.005,conditional:false}]);
  const angelic=dropsFor(catalog,spawn({variant:'angelic'})).find(drop=>drop.petal.slug==='halo');
  assert.deepEqual(angelic.rolls,[{q:0.1,conditional:false}]);
});

test('Magic replacement keeps one roll per source row instead of merging them',()=>{
  for(const variant of ['magic','arcane']){
    const drops=dropsFor(catalog,spawn({mob:'zatan',variant}));
    const marks=drops.filter(drop=>drop.petal.slug==='magic_mark');
    assert.equal(marks.length,1);
    assert.deepEqual(marks[0].rolls,[{q:0.25,conditional:false},{q:0.05,conditional:false}]);
    assert.equal(marks[0].q,0.25);
    assert.equal(marks[0].conditional,false);
    assert.deepEqual(drops.map(drop=>drop.petal.slug).filter(slug=>slug==='mark'||slug==='void_mark'),[]);
  }
});

test('every mob and variant lists one row per petal with positive rolls',()=>{
  for(const mob of catalog.mobs){
    for(const {slug:variant} of catalog.variants){
      const drops=dropsFor(catalog,{mob:mob.slug,rarity:0,variant});
      const slugs=drops.map(drop=>drop.petal.slug);
      assert.equal(new Set(slugs).size,slugs.length,`${mob.slug} ${variant} duplicate petal`);
      for(const drop of drops){
        assert.ok(drop.rolls.length>0);
        for(const roll of drop.rolls){
          assert.ok(roll.q>0);
          if(variant!=='flash')assert.equal(roll.conditional,false,`${mob.slug} ${variant}`);
        }
      }
    }
  }
});

test('conditions within one rule are AND; enabled rules are OR',()=>{
  assert.ok(!matchesRule(catalog,spawn(),rule({variant:'demonic'})));
  assert.ok(!matchesRule(catalog,spawn(),rule({mobMin:9})));
  assert.ok(!matchesRule(catalog,spawn(),rule({enabled:false})));
  assert.ok(matchesRule(catalog,spawn(),rule({kind:'mob',target:'rock'})));
  assert.ok(matchesRule(catalog,spawn({variant:'shiny'}),rule({kind:'any',target:'*',variant:'shiny'})));
  assert.equal(matchingRules(catalog,spawn(),[rule({target:'rose'}),rule()]).length,1);
});
test('legacy petal rarity thresholds use the possible rarity range',()=>{
  assert.ok(matchesRule(catalog,spawn({rarity:7}),rule({target:'rock',dropMin:7})));
  assert.ok(!matchesRule(catalog,spawn({rarity:6}),rule({target:'rock',dropMin:7})));
  assert.ok(matchesRule(catalog,spawn({rarity:0}),rule({dropMin:1})));
  assert.ok(!matchesRule(catalog,spawn({rarity:0}),rule({dropMin:2})));
});
test('saved rules are checked against the current catalog',()=>{
  assert.ok(validateRule(catalog,rule()));
  assert.ok(!validateRule(catalog,rule({target:'missing'})));
  assert.ok(!validateRule(catalog,rule({variant:'missing'})));
  assert.ok(!validateRule(catalog,rule({dropMin:8})));
});
