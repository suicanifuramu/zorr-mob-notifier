import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  eventSequence,isDeath,mergeEvent,notificationKey,
  normalizeKiller,deathNotificationTitle,canNotifyDeath,RECENT_MS,
} from '../src/lifecycle.js';

const spawn=overrides=>({
  id:10,key:'msg-1:0',sequence:10,type:'spawn',dead:false,killedBy:null,killedAt:null,
  mob:'rock',rarity:8,variant:'normal',name:'Omega Rock',
  createdAt:'2026-10-21T12:00:00.000Z',source:'discord',sourceUrl:'',
  ...overrides,
});
const death=overrides=>spawn({type:'death',dead:true,killedBy:'Alice',killedAt:'2026-10-21T21:42:00.000Z',sequence:20,...overrides});

test('change sequence is preferred over the stable id and falls back for old records',()=>{
  assert.equal(eventSequence(spawn({id:4,sequence:undefined})),4);
  assert.equal(eventSequence(spawn({id:4,sequence:41})),41);
  assert.equal(eventSequence(spawn({id:4,sequence:0})),4);
  assert.equal(eventSequence(spawn({id:4,sequence:'41'})),4);
  assert.equal(eventSequence(null),0);
});

test('death updates the retained row in place and keeps spawn id, key, ordering, and time',()=>{
  const before=[spawn({id:12,key:'newer',sequence:12}),spawn()];
  const {events,action}=mergeEvent(before,death());
  assert.equal(action,'update');
  assert.equal(events.length,2,'no duplicate feed row');
  assert.equal(events[0].key,'newer','original ordering is retained');
  const row=events.find(event=>event.key==='msg-1:0');
  assert.equal(row.id,10);assert.equal(row.sequence,20);
  assert.equal(row.type,'death');assert.equal(row.dead,true);
  assert.equal(row.createdAt,'2026-10-21T12:00:00.000Z','createdAt stays the spawn time');
  assert.equal(row.killedBy,'Alice');assert.equal(row.killedAt,'2026-10-21T21:42:00.000Z');
  assert.equal(isDeath(row),true);
});

test('duplicate and stale revisions never rewind a death',()=>{
  let state=[spawn()];
  state=mergeEvent(state,death()).events;
  assert.equal(mergeEvent(state,death()).action,'stale','same sequence is a repeated delivery');
  assert.equal(mergeEvent(state,death({sequence:19,killedBy:'Eve'})).action,'stale','older revision is stale');
  assert.equal(mergeEvent(state,spawn({sequence:9})).action,'stale','older spawn replay is stale');
  assert.equal(mergeEvent(state,spawn({sequence:30})).action,'ignored','spawn must not revive a dead row');
  const row=mergeEvent(state,spawn({sequence:30})).events.find(event=>event.key==='msg-1:0');
  assert.equal(row.dead,true);assert.equal(row.killedBy,'Alice');
});

test('a newer correction can update the killer without changing identity',()=>{
  let state=mergeEvent([spawn()],death()).events;
  const {events,action}=mergeEvent(state,death({sequence:21,killedBy:'Bob'}));
  assert.equal(action,'update');
  assert.equal(events[0].id,10);assert.equal(events[0].key,'msg-1:0');
  assert.equal(events[0].killedBy,'Bob');
  assert.equal(events[0].createdAt,'2026-10-21T12:00:00.000Z');
});

test('a death without a retained spawn is upserted in spawn order',()=>{
  const {events,action}=mergeEvent([spawn({id:30,key:'other',sequence:30})],death({id:5,sequence:40,key:'gone:0'}));
  assert.equal(action,'insert');
  assert.deepEqual(events.map(event=>event.id),[30,5]);
  assert.equal(events[1].dead,true);
});

test('a sequenced death can follow a legacy snapshot row with no sequence',()=>{
  const legacy=spawn({id:100,sequence:undefined});
  const {events,action}=mergeEvent([legacy],death({id:100,sequence:5}));
  assert.equal(action,'update');
  assert.equal(events[0].dead,true);assert.equal(events[0].sequence,5);
  assert.equal(mergeEvent(events,death({id:100,sequence:5})).action,'stale');
  const collided=mergeEvent([spawn({id:5,sequence:undefined})],death({id:5,sequence:5}));
  assert.equal(collided.action,'update','an explicit change sequence wins over a same-numbered legacy id');
});

test('spawn and death alerts use independent dedupe keys',()=>{
  assert.equal(notificationKey(spawn()),'msg-1:0');
  assert.equal(notificationKey(death()),'death:msg-1:0');
  assert.notEqual(notificationKey(spawn()),notificationKey(death()));
});

test('death titles use the full event name and normalize an optional @ prefix',()=>{
  assert.equal(normalizeKiller(' Alice '),'Alice');
  assert.equal(normalizeKiller('@Alice'),'Alice');
  assert.equal(normalizeKiller('＠Alice'),'Alice');
  assert.equal(normalizeKiller(null),null);
  assert.equal(normalizeKiller('  '),null);
  assert.equal(deathNotificationTitle(death({name:'Demonic Omega Rock'})),'Demonic Omega Rock killed by ＠Alice!');
  assert.equal(deathNotificationTitle(death({killedBy:null})),'Omega Rock was defeated!');
  assert.equal(deathNotificationTitle(death({killedBy:'＠'})),'Omega Rock was defeated!');
});

test('a fresh death of a long-lived spawn alerts, but old or historical deaths do not',()=>{
  const now=Date.parse('2026-10-21T21:43:00.000Z');
  assert.equal(canNotifyDeath(death(),now),true,'killedAt is recent even though createdAt is hours old');
  assert.equal(canNotifyDeath(death({killedAt:'2026-10-21T21:41:30.000Z'}),now),true);
  assert.equal(canNotifyDeath(death({killedAt:'2026-10-21T21:38:00.000Z'}),now),false,'killedAt older than two minutes');
  assert.equal(canNotifyDeath(death({createdAt:'2026-10-21T21:42:59.000Z',killedAt:'2026-10-21T10:00:00.000Z'}),now),false,'fresh createdAt must not rescue an old death');
  assert.equal(canNotifyDeath(death({historical:true}),now),false,'history replay never alerts');
  assert.equal(canNotifyDeath(death({killedAt:null}),now),false);
  assert.equal(canNotifyDeath(death({killedAt:new Date(now+RECENT_MS+1).toISOString()}),now),false,'far-future clock skew');
  assert.equal(canNotifyDeath(spawn(),now),false);
});
