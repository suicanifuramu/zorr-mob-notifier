// Pure spawn/death lifecycle helpers. Kept free of DOM so tests can exercise
// revision ordering, notification de-duplication, and death wording directly.

export const RECENT_MS=120000;
export const FUTURE_MS=30000;

// `sequence` is the change cursor introduced with death updates. Records from
// older backends only have the stable insertion `id`, so fall back to it.
export function eventSequence(event){
  if(Number.isSafeInteger(event?.sequence)&&event.sequence>0)return event.sequence;
  return Number.isSafeInteger(event?.id)&&event.id>0?event.id:0;
}

export function isDeath(event){return event?.type==='death'||event?.dead===true}

export function sortEvents(events){return [...events].sort((a,b)=>b.id-a.id)}

// Merge one flat record into the local list. Returns the next list plus what
// happened so the caller can decide whether to notify:
//   insert  - new key (including a death whose spawn is no longer retained)
//   update  - newer revision of a retained record, updated in place
//   stale   - repeated or out-of-order delivery; ignore
//   ignored - a spawn replay that must not revive a dead record
export function mergeEvent(events,event,{limit=200}={}){
  const sequence=eventSequence(event);
  if(!sequence)return {events,action:'ignored'};
  const index=events.findIndex(item=>item.key===event.key);
  if(index<0)return {events:sortEvents([event,...events]).slice(0,limit),action:'insert'};
  const existing=events[index];
  const existingSequence=eventSequence(existing);
  const hasExistingSequence=Number.isSafeInteger(existing.sequence)&&existing.sequence>0;
  const hasIncomingSequence=Number.isSafeInteger(event.sequence)&&event.sequence>0;
  // Once a record carries a change sequence, compare revisions strictly. A
  // snapshot record from an older backend has only its stable id: the first
  // sequenced change is always accepted, and repeated legacy records with the
  // same id stay stale.
  const stale=hasExistingSequence?sequence<=existingSequence:!hasIncomingSequence&&sequence===existingSequence;
  if(stale)return {events,action:'stale'};
  // Death is terminal for a key. Older (or duplicated) spawn revisions must not
  // bring the row back to life.
  if(isDeath(existing)&&!isDeath(event))return {events,action:'ignored'};
  const merged={...existing,...event,id:existing.id,key:existing.key};
  if(isDeath(event)){
    merged.type='death';merged.dead=true;
    // A correction may only mention the killer; keep the previous death time.
    if(event.killedAt===undefined)merged.killedAt=existing.killedAt??null;
    if(event.killedBy===undefined)merged.killedBy=existing.killedBy??null;
  }
  const next=events.slice();next[index]=merged;
  return {events:next,action:'update'};
}

// Canonical backend names have no @ prefix, but tolerate one in either width.
export function normalizeKiller(value){
  if(typeof value!=='string')return null;
  const name=value.trim().replace(/^[@＠]/,'').trim();
  return name||null;
}

export function notificationKey(event){
  return isDeath(event)?`death:${event.key}`:event.key;
}

export function deathNotificationTitle(event){
  const killer=normalizeKiller(event.killedBy);
  return killer?`${event.name} killed by ＠${killer}!`:`${event.name} was defeated!`;
}

// Death age is measured from killedAt, never from the (possibly ancient)
// spawn createdAt. History/backfill changes never alert.
export function canNotifyDeath(event,now=Date.now()){
  if(!isDeath(event)||event.historical)return false;
  const killedAt=Date.parse(event.killedAt||'');
  if(!Number.isFinite(killedAt))return false;
  const age=now-killedAt;
  return age<=RECENT_MS&&age>=-FUTURE_MS;
}
