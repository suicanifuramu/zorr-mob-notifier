import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_ORDER,REGION_ORDER,validRestart,restartMaps,restartMapRows,restartMapSummary,
  latestRestarts,mergeRestart,relativeAge,restartTitle,restartBody,
} from '../src/restarts.js';

const event = overrides => ({
  key:'900000000000000101:restart',type:'restart',count:29,sequence:10,
  createdAt:'2026-11-24T18:11:30.682Z',
  servers:{EU:['Void','Desert','Plains'],US:['Plains','Desert'],AS:['Plains','Desert']},
  historical:false,...overrides,
});

test('restart map and region order follows the gallery and AS/US/EU',()=> {
  assert.deepEqual(MAP_ORDER,['Plains','Desert','Ocean','Jungle','Arctic','Bio','Void','Hel','Sewers','Jurassic']);
  assert.deepEqual(REGION_ORDER,['AS','US','EU']);
  assert.deepEqual(restartMaps(event()),['Plains','Desert','Void']);
  assert.deepEqual(restartMapRows(event()),[
    {map:'Plains',regions:['AS','US','EU']},
    {map:'Desert',regions:['AS','US','EU']},
    {map:'Void',regions:['EU']},
  ]);
});

test('unknown maps stay visible after the canonical gallery maps',()=> {
  const rows = restartMapRows(event({servers:{EU:['Mystery','hel','plains']}}));
  assert.deepEqual(rows,[
    {map:'Plains',regions:['EU']},
    {map:'Hel',regions:['EU']},
    {map:'Mystery',regions:['EU']},
  ]);
});

test('map summary combines the latest restart per region across messages',()=> {
  const single=event({
    key:'single',sequence:11,count:1,createdAt:'2026-11-24T18:12:41.177Z',
    servers:{AS:['Plains']},
  });
  const rows=restartMapSummary([single,event()],{now:Date.parse('2026-11-25T19:12:30.682Z')});
  assert.deepEqual(rows.map(row=>row.map),[ 'Plains','Desert','Void' ]);
  assert.deepEqual(rows[0].regions,['AS','US','EU']);
  assert.equal(rows[0].createdAt,'2026-11-24T18:12:41.177Z','newest region time wins');
  assert.equal(rows[0].regionTimes.US,'2026-11-24T18:11:30.682Z');
  assert.deepEqual(rows[1].regions,['AS','US','EU']);
  assert.deepEqual(restartMapSummary([single],{now:Date.parse('2026-12-05T00:00:00Z')}),[]);
});

test('restart validation accepts restart records and rejects spawns',()=> {
  assert.equal(validRestart(event()),true);
  assert.equal(validRestart(event({servers:{}})),false);
  assert.equal(validRestart(event({createdAt:'not a date'})),false);
  assert.equal(validRestart({type:'spawn',key:'x:0',createdAt:'2026-11-24T18:11:30Z'}),false);
});

test('relative restart ages are compact and update from createdAt',()=> {
  const createdAt='2026-11-24T18:11:30.682Z';
  assert.equal(relativeAge(createdAt,Date.parse('2026-11-25T19:12:30.682Z')),'1d1h1m ago');
  assert.equal(relativeAge(createdAt,Date.parse('2026-11-24T19:10:30.682Z')),'59m ago');
  assert.equal(relativeAge(createdAt,Date.parse('2026-11-24T18:12:00.682Z')),'30s ago');
  assert.equal(relativeAge(createdAt,Date.parse('2026-11-24T18:11:35.682Z')),'just now');
});

test('live restart edits upsert by key and ignore stale revisions',()=> {
  const first=mergeRestart([],event());
  assert.equal(first.action,'insert');
  assert.equal(mergeRestart(first.restarts,event()).action,'stale');
  const edited=event({sequence:11,servers:{AS:['Plains'],EU:['Desert']},editedAt:'2026-11-24T18:12:27.800Z'});
  const updated=mergeRestart(first.restarts,edited);
  assert.equal(updated.action,'update');
  assert.equal(updated.restarts.length,1);
  assert.equal(updated.restarts[0].key,first.restarts[0].key);
  assert.deepEqual(updated.restarts[0].servers,{AS:['Plains'],EU:['Desert']});
  assert.equal(mergeRestart(first.restarts,event({sequence:9})).action,'stale');
});

test('latest restarts are newest first, bounded, and produce notification text',()=> {
  const list=latestRestarts([
    event({key:'old',createdAt:'2026-11-24T18:11:30.682Z',sequence:10}),
    event({key:'new',createdAt:'2026-11-24T18:12:41.177Z',sequence:11}),
    {type:'spawn'},
  ],1);
  assert.deepEqual(list.map(item=>item.key),['new']);
  assert.equal(restartTitle(event()),'29 servers restarted');
  assert.equal(restartTitle(event({count:1,servers:{AS:['Plains']}})),'1 server restarted');
  assert.equal(restartBody(event()),'AS/US/EU · Plains, Desert, Void');
});
