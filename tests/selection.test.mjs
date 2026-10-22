import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HOLD_MS,HOLD_TOLERANCE,toggled,removed,visibleItems,selectIcon,holdCanceled,consumesHoldClick,CLICK_GRACE} from '../src/selection.js';

const normalize=value=>String(value).toLowerCase().replace(/[^a-z0-9]/g,'');
const visible=['moon','rock','rose','halo'];
const items=[{name:'Moon'},{name:'Moon Egg'},{name:'Rock'},{name:'Rose'},{name:'Halo'}];

test('plain selection replaces the previous choice and moves the anchor',()=>{
  assert.deepEqual(selectIcon({selected:['rock','rose'],anchor:'rose',visible,slug:'moon',mode:'single'}),
    {selected:['moon'],anchor:'moon'});
});

test('toggle adds then removes an icon and keeps it as the anchor',()=>{
  assert.deepEqual(selectIcon({selected:['rock'],anchor:'rock',visible,slug:'rose',mode:'toggle'}),
    {selected:['rock','rose'],anchor:'rose'});
  assert.deepEqual(selectIcon({selected:['rock','rose'],anchor:'rose',visible,slug:'rock',mode:'toggle'}),
    {selected:['rose'],anchor:'rock'});
});

test('range selects the contiguous visible slice in both directions',()=>{
  assert.deepEqual(selectIcon({selected:['halo'],anchor:'rock',visible,slug:'rose',mode:'range'}),
    {selected:['rock','rose'],anchor:'rock'});
  assert.deepEqual(selectIcon({selected:['halo'],anchor:'rose',visible,slug:'moon',mode:'range'}),
    {selected:['moon','rock','rose'],anchor:'rose'});
});

test('range uses only current search results, not the whole catalog',()=>{
  const filtered=['moon','moon_egg'];
  assert.deepEqual(selectIcon({selected:[],anchor:'moon',visible:filtered,slug:'moon_egg',mode:'range'}),
    {selected:['moon','moon_egg'],anchor:'moon'});
  assert.deepEqual(selectIcon({selected:['rock'],anchor:'rock',visible:filtered,slug:'moon_egg',mode:'range'}),
    {selected:['moon_egg'],anchor:'moon_egg'});
});

test('range without a visible anchor falls back to a single selection',()=>{
  assert.deepEqual(selectIcon({selected:['rock'],anchor:null,visible,slug:'rose',mode:'range'}),
    {selected:['rose'],anchor:'rose'});
  assert.deepEqual(selectIcon({selected:['rock'],anchor:'rock',visible:['rose','halo'],slug:'halo',mode:'range'}),
    {selected:['halo'],anchor:'halo'});
});

test('search results keep catalog order and match normalized names',()=>{
  assert.deepEqual(visibleItems(items,'moon',normalize).map(i=>i.name),['Moon','Moon Egg']);
  assert.deepEqual(visibleItems(items,'',normalize).map(i=>i.name),['Moon','Moon Egg','Rock','Rose','Halo']);
  assert.deepEqual(visibleItems(items,'moon egg',normalize).map(i=>i.name),['Moon Egg']);
});

test('removal keeps order and never mutates the input array',()=>{
  const original=['rock','rose','moon'];
  assert.deepEqual(removed(original,'rose'),['rock','moon']);
  assert.deepEqual(original,['rock','rose','moon']);
  assert.deepEqual(toggled(original,'rose'),['rock','moon']);
  assert.deepEqual(original,['rock','rose','moon']);
});

test('a hold cancels on movement beyond the tolerance only',()=>{
  const start={x:100,y:100};
  assert.equal(holdCanceled(start,105,100),false);
  assert.equal(holdCanceled(start,100,100-HOLD_TOLERANCE),false);
  assert.equal(holdCanceled(start,100+HOLD_TOLERANCE+1,100),true);
  assert.equal(holdCanceled(start,100,100+HOLD_TOLERANCE+1),true);
  assert.equal(HOLD_MS,500);
});

test('hold click suppression is bound to the gesture icon, never to a release timer',()=>{
  const held={slug:'rock',pointerId:3,releasedAt:0};
  // A pointer click is still the held gesture's click no matter how long the
  // pointer stayed down, or how long the release-to-click gap is.
  assert.equal(consumesHoldClick(held,'rock',1,5000),true);
  assert.equal(consumesHoldClick(held,'rock',1,999999),true);
  assert.equal(consumesHoldClick(held,'rose',1,10),false);
  assert.equal(consumesHoldClick(null,'rock',1,10),false);
});

test('keyboard activation after a hold is not mistaken for the gesture click',()=>{
  const held={slug:'rock',pointerId:3,releasedAt:0};
  assert.equal(consumesHoldClick(held,'rock',0,CLICK_GRACE+100),false);
  // Programmatic or synthetic clicks that land right after release still count.
  assert.equal(consumesHoldClick(held,'rock',0,CLICK_GRACE),true);
});
