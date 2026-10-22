// Pure selection helpers for the icon picker. Kept DOM-free so the
// click / range / hold semantics can be tested without a browser.

export const HOLD_MS=500;
export const HOLD_TOLERANCE=10;

export function toggled(keys,key){
  return keys.includes(key)?keys.filter(k=>k!==key):[...keys,key];
}

export function removed(keys,key){
  return keys.filter(k=>k!==key);
}

// Search results keep catalog order and only include names matching the query.
export function visibleItems(items,query,normalize){
  const needle=normalize(query||'');
  return needle?items.filter(item=>normalize(item.name).includes(needle)):[...items];
}

// modes:
//   single - replace the selection with this icon (plain click / tap)
//   toggle - add or remove this icon (Ctrl/Meta-click, or any tap in multi mode)
//   range  - replace the selection with the visible range from the anchor
//            to this icon; falls back to single when the anchor is not visible.
export function selectIcon({selected=[],anchor=null,visible=[],slug,mode='single'}){
  if(mode==='range'){
    const from=visible.indexOf(anchor),to=visible.indexOf(slug);
    if(from>=0&&to>=0){
      const start=Math.min(from,to),end=Math.max(from,to);
      return {selected:visible.slice(start,end+1),anchor};
    }
    return {selected:[slug],anchor:slug};
  }
  if(mode==='toggle')return {selected:toggled(selected,slug),anchor:slug};
  return {selected:[slug],anchor:slug};
}

export function holdCanceled(start,x,y,tolerance=HOLD_TOLERANCE){
  return Math.abs(x-start.x)>tolerance||Math.abs(y-start.y)>tolerance;
}

// A completed hold suppresses exactly one follow-up click for the icon that
// was held. The suppression is bound to the gesture, not a countdown: it stays
// valid however long the pointer was down, until the click consumes it or a
// new pointerdown clears it. detail 0 is normally keyboard activation and
// passes through, unless it lands immediately after the pointer release.
export const CLICK_GRACE=250;

export function consumesHoldClick(held,slug,detail,now){
  if(!held||held.slug!==slug)return false;
  return detail!==0||now-held.releasedAt<=CLICK_GRACE;
}
