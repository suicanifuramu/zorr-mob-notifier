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
const round2=percent=>Math.round(percent*100)/100;
const rowsByRarity=mobRarity=>new Map(dropProbabilities(mobRarity,0.0375).map(row=>[row.rarity,row.percent]));

test('Rock q=0.0375 matches the audited client tooltip table',()=>{
  const expected=new Map([
    [0,new Map([[0,10.69],[1,6.71]])],
    [3,new Map([[0,0.55],[1,49.07],[2,46.95],[3,3.43]])],
    [6,new Map([[4,65.04],[5,34.85],[6,0.11]])],
    [7,new Map([[5,97.2],[6,2.8]])],
    [8,new Map([[5,8.74],[6,91.04],[7,0.22]])],
    [9,new Map([[6,98.71],[7,1.29]])],
  ]);
  for(const [mobRarity,table] of expected){
    const rates=rowsByRarity(mobRarity);
    for(const [rarity,percent] of rates)
      assert.equal(round2(percent),table.get(rarity)??0,`mob ${mobRarity} rarity ${rarity}`);
    for(const [rarity,percent] of table)
      assert.equal(round2(rates.get(rarity)),percent,`mob ${mobRarity} rarity ${rarity}`);
  }
});

test('every rate matches the fixed client reference fixture',()=>{
  const {provenance,cases}=reference;
  assert.equal(cases.length,50,'fixture must cover 5 q values x 10 mob rarities');
  assert.deepEqual([...new Set(cases.map(c=>c.q))],provenance.q);
  assert.deepEqual(provenance.q,[0.0375,0.0125,0.000625,0.11,0.25]);
  let tinyRows=0;
  for(const {mobRarity,q,rows} of cases){
    const ours=dropProbabilities(mobRarity,q);
    const displayed=ours
      .map(({rarity,percent})=>[rarity,round2(percent)])
      .filter(([,percent])=>percent>0);
    assert.deepEqual(displayed,rows,`mob ${mobRarity} q ${q}`);
    for(const {rarity,percent} of ours){
      assert.ok(Number.isFinite(percent)&&percent>0,`mob ${mobRarity} q ${q} rarity ${rarity} percent ${percent}`);
      // Rows the client tooltip rounds away must survive as tiny positives here.
      if(round2(percent)===0){
        tinyRows++;
        assert.ok(percent<0.01,`mob ${mobRarity} q ${q} rarity ${rarity} percent ${percent}`);
        assert.equal(formatProbability(percent),'<0.01%');
      }
    }
  }
  assert.ok(tinyRows>0,'fixture should exercise at least one rounded-away rate');
});

test('rates the rounded tooltip hides stay positive',()=>{
  const rates=rowsByRarity(7);
  const superPetal=rates.get(7);
  assert.ok(Math.abs(superPetal-0.0025867861894846023)<1e-12,`got ${superPetal}`);
  assert.equal(round2(superPetal),0);
  assert.equal(formatProbability(superPetal),'<0.01%');
  assert.ok(rates.get(4)>0&&round2(rates.get(4))===0);
});

test('log1p fallback keeps rates that would cancel to zero',()=>{
  const naive=(mobRarity,q,rarity)=>{
    const divisors=[60000,15000,10000,800,30,0.6,0.008,0.0003,0.0000035,6e-7];
    const top=Math.max(1,mobRarity);
    const threshold=r=>r===0?0:1-Math.exp(-r*(r+1)/2);
    const lower=threshold(rarity),upper=rarity===top?1:threshold(rarity+1);
    const rolls=300000/divisors[mobRarity];
    return 100*((1-q+q*upper)**rolls-(1-q+q*lower)**rolls);
  };
  assert.equal(naive(7,1e-15,7),0);
  for(const q of [1e-15,1e-300]){
    const rates=dropProbabilities(7,q);
    assert.equal(rates.length,8);
    for(const {percent} of rates){
      assert.ok(Number.isFinite(percent)&&percent>0,`q ${q} percent ${percent}`);
      assert.equal(formatProbability(percent),'<0.01%');
    }
    assert.ok(rates.find(row=>row.rarity===7).percent>0);
  }
});

test('bounds hold for every mob rarity and q',()=>{
  const divisors=[60000,15000,10000,800,30,0.6,0.008,0.0003,0.0000035,6e-7];
  for(let mobRarity=0;mobRarity<10;mobRarity++){
    for(const q of [0.000625,0.0375,0.25,1]){
      const rates=dropProbabilities(mobRarity,q),top=Math.min(7,Math.max(1,mobRarity));
      const rarities=rates.map(row=>row.rarity);
      assert.deepEqual(rarities,[...rarities].sort((a,b)=>a-b));
      assert.equal(new Set(rarities).size,rarities.length);
      for(const rarity of rarities)assert.ok(rarity>=0&&rarity<=top,`mob ${mobRarity} rarity ${rarity}`);
      assert.equal(rarities.at(-1),top,`mob ${mobRarity} top row`);
      for(const {percent} of rates)assert.ok(Number.isFinite(percent)&&percent>0);
      const total=rates.reduce((sum,row)=>sum+row.percent,0);
      assert.ok(total>0&&total<=100+1e-9,`mob ${mobRarity} q ${q} total ${total}`);
      if(mobRarity<=7){
        const complete=rarities.length===top+1&&rarities[0]===0;
        if(complete)
          assert.ok(Math.abs(total-100*(1-(1-q)**(300000/divisors[mobRarity])))<1e-9,`mob ${mobRarity} q ${q} total ${total}`);
      } else assert.ok(total>99,`mob ${mobRarity} q ${q} total ${total}`);
    }
  }
});

test('invalid input yields no rows',()=>{
  for(const mobRarity of [-1,1.5,10,NaN])
    assert.deepEqual(dropProbabilities(mobRarity,0.25),[]);
  for(const q of [0,-0.1,1.1,NaN,Infinity])
    assert.deepEqual(dropProbabilities(0,q),[]);
});

test('formatProbability shows two decimals and flags tiny positives',()=>{
  assert.equal(formatProbability(56.2),'56.2%');
  assert.equal(formatProbability(10.69),'10.69%');
  assert.equal(formatProbability(91.04),'91.04%');
  assert.equal(formatProbability(0.22),'0.22%');
  assert.equal(formatProbability(0.01),'0.01%');
  assert.equal(formatProbability(0.0099),'<0.01%');
  assert.equal(formatProbability(0.0000001),'<0.01%');
  assert.equal(formatProbability(Number.NaN),'');
});
