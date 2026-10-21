import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {indexCatalog,validateRule} from '../src/matching.js';
import {loadSettings,saveSettings,claimNotification} from '../src/storage.js';
import {notificationState} from '../src/app.js';

const catalog=indexCatalog(JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url))));

function readSettings(value){
  const original=globalThis.localStorage;
  globalThis.localStorage={getItem:()=>value===undefined?null:typeof value==='string'?value:JSON.stringify(value)};
  try{return loadSettings(catalog,validateRule)}
  finally{if(original===undefined)delete globalThis.localStorage;else globalThis.localStorage=original}
}

test('a first visit may request permission and the accepted flag persists',()=>{
  assert.equal(readSettings({version:1}).permissionRequested,false);
  assert.equal(readSettings({version:1,permissionRequested:true}).permissionRequested,true);
  // Only a persisted boolean suppresses the one-time load request.
  assert.equal(readSettings({version:1,permissionRequested:'true'}).permissionRequested,false);
  assert.equal(readSettings('{broken').permissionRequested,false);
});

test('saved notification preferences reload unchanged',()=>{
  const original=globalThis.localStorage;let written;
  globalThis.localStorage={setItem:(key,value)=>{written=JSON.parse(value)}};
  try{
    assert.equal(saveSettings({version:1,enabled:true,permissionRequested:true,onlyMatches:false,rules:[]}),true);
  }finally{if(original===undefined)delete globalThis.localStorage;else globalThis.localStorage=original}
  assert.equal(written.permissionRequested,true);
  assert.equal(readSettings(JSON.stringify(written)).enabled,true);
});

test('bell state distinguishes active, available, and blocked permission',()=>{
  assert.deepEqual(notificationState('granted',true),{active:true,disabled:false,icon:'bell-ring',label:'Notifications enabled — click to disable'});
  assert.deepEqual(notificationState('granted',false),{active:false,disabled:false,icon:'bell',label:'Notifications disabled — click to enable'});
  assert.deepEqual(notificationState('default',false),{active:false,disabled:false,icon:'bell',label:'Notifications disabled — click to enable'});
  const blocked=notificationState('denied',false);
  assert.equal(blocked.icon,'bell-off');assert.equal(blocked.active,false);assert.equal(blocked.disabled,false);
  const unavailable=notificationState('unsupported',true);
  assert.equal(unavailable.icon,'bell-off');assert.equal(unavailable.active,false);assert.equal(unavailable.disabled,true);
});

test('notification claims are deduplicated without IndexedDB',async()=>{
  const key=`notification-test-${Date.now()}-${Math.random()}`;
  assert.equal(await claimNotification(key),true);
  assert.equal(await claimNotification(key),false);
  assert.equal(await claimNotification(`${key}-other`),true);
});
