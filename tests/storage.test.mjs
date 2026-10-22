import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {indexCatalog,validateRule,matchesRule} from '../src/matching.js';
import {loadSettings,saveSettings,claimNotification} from '../src/storage.js';

const catalog=indexCatalog(JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url))));

function read(value){
  const original=globalThis.localStorage;
  globalThis.localStorage={getItem:()=>JSON.stringify(value)};
  try{return loadSettings(catalog,validateRule)}
  finally{if(original===undefined)delete globalThis.localStorage;else globalThis.localStorage=original}
}

test('legacy petal settings lose removed restrictions while mob and any keep their filters',()=>{
  const petal={id:'petal',kind:'petal',target:'moon',variant:'demonic',mobMin:9,dropMin:7,enabled:true};
  const mob={id:'mob',kind:'mob',target:'rock',variant:'shiny',mobMin:7,dropMin:0,enabled:false};
  const any={id:'any',kind:'any',target:'*',variant:'magic',mobMin:5,dropMin:0,enabled:true};
  const settings=read({version:1,enabled:true,permissionRequested:true,onlyMatches:true,rules:[petal,mob,any]});
  assert.equal(settings.enabled,true);
  assert.equal(settings.permissionRequested,true);
  assert.equal(settings.onlyMatches,true);
  assert.deepEqual(settings.rules,[
    {id:'petal',kind:'petal',targets:['moon'],variants:['*'],mobMin:0,dropMin:0,enabled:true},
    {id:'mob',kind:'mob',targets:['rock'],variants:['shiny'],mobMin:7,dropMin:0,enabled:false},
    {id:'any',kind:'any',targets:[],variants:['magic'],mobMin:5,dropMin:0,enabled:true},
  ]);
  assert.ok(matchesRule(catalog,{mob:'rock',rarity:0,variant:'normal'},settings.rules[0]));
  assert.ok(!matchesRule(catalog,{mob:'rock',rarity:8,variant:'normal'},settings.rules[1]));
  const enabledMob={...settings.rules[1],enabled:true};
  assert.ok(matchesRule(catalog,{mob:'rock',rarity:7,variant:'shiny'},enabledMob));
  assert.ok(!matchesRule(catalog,{mob:'rock',rarity:7,variant:'magic'},enabledMob));
  assert.ok(matchesRule(catalog,{mob:'ladybug',rarity:5,variant:'magic'},settings.rules[2]));
  assert.ok(!matchesRule(catalog,{mob:'ladybug',rarity:5,variant:'normal'},settings.rules[2]));
});

test('canonical grouped rules survive reload and malformed selections are dropped',()=>{
  const grouped={id:'grouped',kind:'mob',targets:['rock','ladybug'],variants:['shiny','magic'],mobMin:6,dropMin:0,enabled:true};
  const mixed={id:'mixed',kind:'any',targets:[],variants:['*','magic'],mobMin:8,dropMin:0,enabled:true};
  const empty={id:'empty',kind:'petal',targets:[],variants:['*'],mobMin:0,dropMin:0,enabled:true};
  const settings=read({version:1,rules:[mixed,empty,grouped]});
  assert.deepEqual(settings.rules,[grouped]);
});

test('settings save/reload round-trips grouped rules and notification claims stay deduplicated',async()=>{
  const original=globalThis.localStorage;
  let stored;
  globalThis.localStorage={
    getItem:()=>stored??null,
    setItem:(key,value)=>{stored=value},
  };
  try{
    const rules=[{id:'petal',kind:'petal',targets:['rose','magic_rose'],variants:['*'],mobMin:0,dropMin:0,enabled:true}];
    assert.equal(saveSettings({version:1,enabled:true,permissionRequested:false,onlyMatches:true,rules}),true);
    const reloaded=loadSettings(catalog,validateRule);
    assert.deepEqual(reloaded,{version:1,enabled:true,permissionRequested:false,onlyMatches:true,rules});
    assert.ok(matchesRule(catalog,{mob:'ladybug',rarity:8,variant:'magic'},reloaded.rules[0]));
    const key=`storage-dedupe-${Date.now()}-${Math.random()}`;
    assert.equal(await claimNotification(key),true);
    assert.equal(await claimNotification(key),false);
  }finally{if(original===undefined)delete globalThis.localStorage;else globalThis.localStorage=original}
});
