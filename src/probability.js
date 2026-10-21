// Rarity roll rates from the audited 1K580MS96 client tooltip
// (research/drop-probability.mjs, research/drop-findings.md).
//
// The tooltip formula is
//   percent(r) = 100 * ((1 - q + q*threshold[r+1])**N - (1 - q + q*threshold[r])**N)
// with threshold[r] = 1 - exp(-r*(r+1)/2) and threshold[top] replaced by 1.
// The thresholds are built with the same cumulative multiplication as the client
// so the displayed two-decimal values match the audited function.
//
// Those bases sit just below 1, so the subtraction cancels and the smallest
// positive rates become exactly 0. When that happens the row is recomputed with
// the equivalent tail form and log1p/expm1, which keeps the row positive.
// Cancellation only reaches 0 far below 0.01%, never for a displayed rate.
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

function stablePercent(rolls,q,lowerTail,upperTail){
  const upper=rolls*Math.log1p(-q*upperTail),lower=rolls*Math.log1p(-q*lowerTail);
  return 100*Math.exp(upper)*(-Math.expm1(lower-upper));
}

export function dropProbabilities(mobRarity,q){
  if(!Number.isInteger(mobRarity)||mobRarity<0||mobRarity>=divisors.length)return [];
  if(typeof q!=='number'||!Number.isFinite(q)||q<=0||q>1)return [];
  const top=Math.max(1,mobRarity),rolls=300000/divisors[mobRarity],result=[];
  for(let rarity=0;rarity<=Math.min(7,top);rarity++){
    const lower=thresholds[rarity];
    const upper=rarity===top?1:thresholds[rarity+1];
    let percent=100*((1-q+q*upper)**rolls-(1-q+q*lower)**rolls);
    if(!(percent>0)||!Number.isFinite(percent))
      percent=stablePercent(rolls,q,1-lower,1-upper);
    if(percent>0&&Number.isFinite(percent))result.push({rarity,percent});
  }
  return result;
}

export const formatProbability=percent=>
  !Number.isFinite(percent)?'':percent>0&&percent<0.01?'<0.01%':`${percentFormat.format(percent)}%`;
