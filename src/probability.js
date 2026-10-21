// Rarity roll rates from the audited 1K580MS96 client tooltip
// (research/drop-probability.mjs, research/drop-findings.md).
//
// The tooltip formula is
//   percent(r) = 100 * ((1 - q + q*threshold[r+1])**N - (1 - q + q*threshold[r])**N)
// with threshold[r] = 1 - exp(-r*(r+1)/2) and threshold[top] replaced by 1.
// The thresholds are built with the same cumulative multiplication as the client
// so the displayed two-decimal values match the audited function.
//
// The client rounds every roll with Math.round(percent * 100) / 100 and keeps
// only rows whose rounded value is positive. That rounded pool is what the
// in-game gallery shows, so it is mirrored exactly here: rates that round to
// 0.00 are omitted instead of being displayed as a smaller unrounded value.
const divisors=[60000,15000,10000,800,30,0.6,0.008,0.0003,0.0000035,6e-7];
const percentFormat=new Intl.NumberFormat('en',{maximumFractionDigits:2});

const thresholds=[];
{
  let product=1;
  for(let rarity=0;rarity<divisors.length;rarity++){
    product*=Math.exp(rarity);
    thresholds[rarity]=1-1/product;
  }
}

export function dropProbabilities(mobRarity,q){
  if(!Number.isInteger(mobRarity)||mobRarity<0||mobRarity>=divisors.length)return [];
  if(typeof q!=='number'||!Number.isFinite(q)||q<=0||q>1)return [];
  const top=Math.max(1,mobRarity),rolls=300000/divisors[mobRarity],result=[];
  for(let rarity=0;rarity<=Math.min(7,top);rarity++){
    const lower=thresholds[rarity];
    const upper=rarity===top?1:thresholds[rarity+1];
    const raw=100*((q*upper+(1-q))**rolls-(q*lower+(1-q))**rolls);
    const percent=Math.round(raw*100)/100;
    if(percent>0)result.push({rarity,percent});
  }
  return result;
}

export const formatProbability=percent=>
  Number.isFinite(percent)?`${percentFormat.format(percent)}%`:'';
