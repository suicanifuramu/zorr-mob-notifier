import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {indexCatalog,validateRule,matchesRule} from '../src/matching.js';
import {loadSettings} from '../src/storage.js';

test('legacy petal settings lose removed restrictions while mob settings are preserved',async()=>{
  const catalog=indexCatalog(JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url))));
  const petal={id:'petal',kind:'petal',target:'moon',variant:'demonic',mobMin:9,dropMin:7,enabled:true};
  const mob={id:'mob',kind:'mob',target:'rock',variant:'shiny',mobMin:7,dropMin:0,enabled:false};
  const original=globalThis.localStorage;
  globalThis.localStorage={getItem:()=>JSON.stringify({version:1,rules:[petal,mob]})};
  try{
    const settings=loadSettings(catalog,validateRule);
    assert.deepEqual(settings.rules[0],{...petal,variant:'*',mobMin:0,dropMin:0});
    assert.ok(matchesRule(catalog,{mob:'rock',rarity:0,variant:'normal'},settings.rules[0]));
    assert.deepEqual(settings.rules[1],mob);
  }finally{if(original===undefined)delete globalThis.localStorage;else globalThis.localStorage=original}
});
