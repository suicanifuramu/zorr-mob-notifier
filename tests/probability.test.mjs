import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dropProbabilities,formatProbability} from '../src/probability.js';

// The expected tooltip rows come from a committed fixture, never from research/:
// research/drop-probability.mjs is a gitignored local snapshot and is absent in
// a fresh checkout. The fixture was generated once from that audited snapshot
// (SHA-256 6745aaa9fff4d9490eef420ad89f4124206b900c3f133953182eed16ec21a6ef,
// extracted from 1K580MS96-deobfuscated.js, SHA-256
// 031868d80573bcd36d25a9f63c9abab866ee373ade15e192d70e5e2ad9b5039d) and
// records the exact 50 (mobRarity, q) cases below. Regenerate only if the
// audited client extraction changes, and update the hashes in the fixture.
const reference=JSON.parse(readFileSync(new URL('./fixtures/probability-reference.json',import.meta.url),'utf8'));
const catalog=JSON.parse(readFileSync(new URL('../data/catalog.json',import.meta.url),'utf8'));
const asRows=rows=>rows.map(([rarity,percent])=>({rarity,percent}));

test('Rock q=0.0375 matches the audited client tooltip table',()=>{
  const expected=new Map([
    [0,[[0,10.69],[1,6.71]]],
    [3,[[0,0.55],[1,49.07],[2,46.95],[3,3.43]]],
    [6,[[4,65.04],[5,34.85],[6,0.11]]],
    [7,[[5,97.2],[6,2.8]]],
    [8,[[5,8.74],[6,91.04],[7,0.22]]],
    [9,[[6,98.71],[7,1.29]]],
  ]);
  for(const [mobRarity,rows] of expected)
    assert.deepEqual(dropProbabilities(mobRarity,0.0375),asRows(rows),`mob ${mobRarity}`);
});

test('all 50 reference cases match the client rows exactly',()=>{
  const {provenance,cases}=reference;
  assert.equal(cases.length,50,'fixture must cover 5 q values x 10 mob rarities');
  assert.deepEqual([...new Set(cases.map(c=>c.q))],provenance.q);
  assert.deepEqual(provenance.q,[0.0375,0.0125,0.000625,0.11,0.25]);
  for(const {mobRarity,q,rows} of cases)
    assert.deepEqual(dropProbabilities(mobRarity,q),asRows(rows),`mob ${mobRarity} q ${q}`);
});

test('Omega Momy Void Mark shows only the rarities in the game gallery',()=>{
  const momy=catalog.mobs.find(mob=>mob.name==='Momy');
  assert.ok(momy,'catalog should contain Momy');
  const entry=momy.drops.find(([slug])=>slug==='void_mark');
  assert.ok(entry,'Momy should drop Void Mark');
  assert.equal(entry[1],0.0025,'catalog q already includes the 0.25 roll multiplier');
  // Omega is mob rarity 8. Raw Legendary is ~3e-27, so the client rounds it away
  // and its gallery omits Legendary Void Mark for this mob.
  const rates=dropProbabilities(8,entry[1]);
  assert.deepEqual(rates,[
    {rarity:5,percent:85},
    {rarity:6,percent:14.98},
    {rarity:7,percent:0.01},
  ]);
  assert.equal(formatProbability(rates.at(-1).percent),'0.01%');
});

test('Super Rock rounds its Super roll away instead of showing <0.01%',()=>{
  const rates=dropProbabilities(7,0.0375);
  assert.deepEqual(rates,[{rarity:5,percent:97.2},{rarity:6,percent:2.8}]);
  assert.ok(!rates.some(row=>row.rarity===7),'rounded-away Super row must be omitted');
});

test('rounding to two decimals happens before the positive cutoff',()=>{
  // Top row is raw 0.005709...%, below 0.01 but rounds to 0.01 and must display.
  assert.deepEqual(dropProbabilities(8,0.001),[
    {rarity:5,percent:93.71},
    {rarity:6,percent:6.29},
    {rarity:7,percent:0.01},
  ]);
  for(const q of [1e-15,1e-300])
    assert.deepEqual(dropProbabilities(0,q),[],`q ${q} rounds to zero`);
});

test('bounds hold for every mob rarity and q',()=>{
  const divisors=[60000,15000,10000,800,30,0.6,0.008,0.0003,0.0000035,6e-7];
  for(let mobRarity=0;mobRarity<10;mobRarity++){
    for(const q of [0.000625,0.0375,0.25,1]){
      const rates=dropProbabilities(mobRarity,q),top=Math.min(7,Math.max(1,mobRarity));
      const rarities=rates.map(row=>row.rarity),slack=0.005*rates.length+1e-9;
      assert.deepEqual(rarities,[...rarities].sort((a,b)=>a-b));
      assert.equal(new Set(rarities).size,rarities.length);
      for(const rarity of rarities)assert.ok(rarity>=0&&rarity<=top,`mob ${mobRarity} rarity ${rarity}`);
      for(const {percent} of rates){
        assert.ok(Number.isFinite(percent)&&percent>0);
        assert.equal(percent,Math.round(percent*100)/100,`mob ${mobRarity} q ${q} percent ${percent}`);
      }
      const total=rates.reduce((sum,row)=>sum+row.percent,0);
      assert.ok(total>0&&total<=100+slack,`mob ${mobRarity} q ${q} total ${total}`);
      if(mobRarity<=7){
        const complete=rarities.length===top+1&&rarities[0]===0;
        if(complete)
          assert.ok(Math.abs(total-100*(1-(1-q)**(300000/divisors[mobRarity])))<=slack,`mob ${mobRarity} q ${q} total ${total}`);
      } else assert.ok(total>99,`mob ${mobRarity} q ${q} total ${total}`);
    }
  }
});

test('invalid input yields no rows',()=>{
  for(const mobRarity of [-1,1.5,10,NaN])
    assert.deepEqual(dropProbabilities(mobRarity,0.25),[]);
  for(const q of [0,-0.1,1.0000001,NaN,Infinity])
    assert.deepEqual(dropProbabilities(0,q),[]);
});

test('formatProbability shows two decimals and never invents a tiny positive',()=>{
  assert.equal(formatProbability(56.2),'56.2%');
  assert.equal(formatProbability(10.69),'10.69%');
  assert.equal(formatProbability(91.04),'91.04%');
  assert.equal(formatProbability(0.22),'0.22%');
  assert.equal(formatProbability(0.01),'0.01%');
  assert.equal(formatProbability(0.0099),'0.01%');
  assert.equal(formatProbability(0.005),'0.01%');
  assert.equal(formatProbability(0.0049),'0%');
  assert.equal(formatProbability(0),'0%');
  assert.equal(formatProbability(Number.NaN),'');
});
