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
test('conditions within one rule are AND; enabled rules are OR',()=>{
  assert.ok(!matchesRule(catalog,spawn(),rule({variant:'demonic'})));
  assert.ok(!matchesRule(catalog,spawn(),rule({mobMin:9})));
  assert.ok(!matchesRule(catalog,spawn(),rule({enabled:false})));
  assert.ok(matchesRule(catalog,spawn(),rule({kind:'mob',target:'rock'})));
  assert.ok(matchesRule(catalog,spawn({variant:'shiny'}),rule({kind:'any',target:'*',variant:'shiny'})));
  assert.equal(matchingRules(catalog,spawn(),[rule({target:'rose'}),rule()]).length,1);
});
test('drop rarity boundary preserves tiny rates hidden by rounded tooltip',()=>{
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
