import {normalizeRule} from './matching.js';

const KEY='zorr-notifier-settings-v1';
const defaults=()=>({version:1,enabled:false,permissionRequested:false,onlyMatches:false,rules:[]});

export function loadSettings(catalog,validate){
  try{const value=JSON.parse(localStorage.getItem(KEY));
    if(value?.version!==1)return defaults();
    const rules=Array.isArray(value.rules)
      ?value.rules.filter(r=>validate(catalog,r)).slice(0,100).map(rule=>normalizeRule(catalog,rule)).filter(Boolean)
      :[];
    return {...defaults(),enabled:value.enabled===true,permissionRequested:value.permissionRequested===true,onlyMatches:value.onlyMatches===true,rules};
  }catch{return defaults()}
}

export function saveSettings(value){
  try{localStorage.setItem(KEY,JSON.stringify(value));return true}catch{return false}
}

let database;
const memory=new Set();
async function openDatabase(){
  if(database)return database;
  database=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('zorr-notifier',1);
    request.onupgradeneeded=()=>{const store=request.result.createObjectStore('notifications',{keyPath:'key'});store.createIndex('createdAt','createdAt')};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  return database;
}

export async function claimNotification(key){
  try{
    const db=await openDatabase();
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction('notifications','readwrite');
      const store=tx.objectStore('notifications');
      store.add({key,createdAt:Date.now()});
      const expired=store.index('createdAt').openCursor(IDBKeyRange.upperBound(Date.now()-86400000));
      expired.onsuccess=()=>{const cursor=expired.result;if(cursor){cursor.delete();cursor.continue()}};
      tx.oncomplete=()=>resolve(true);
      tx.onabort=()=>{if(tx.error?.name==='ConstraintError')resolve(false);else reject(tx.error)};
    });
  }catch{
    if(memory.has(key))return false;
    memory.add(key);if(memory.size>1000)memory.delete(memory.values().next().value);
    return true;
  }
}
