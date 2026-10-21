import {indexCatalog,matchingRules,dropsFor,validateRule,validEvent,normalizeName} from './matching.js';
import {loadSettings,saveSettings,claimNotification} from './storage.js';
import {createElement,Bell,BellRing,BellOff} from 'lucide';
import {dropProbabilities,formatProbability} from './probability.js';

const $=id=>document.getElementById(id);
const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node};
let catalog,settings,stream,registration,editingId=null,selectedTargetSlug=null;
let events=[],streamConnected=false,botStatus=null,toastTimer,reconnectTimer,streamCursor=0;
let polling=false,pollTimer,connectionTimer,connectionFailures=0;
let permissionRequest;
const permission=()=>('Notification' in window?Notification.permission:'unsupported');
const timeFormat=new Intl.DateTimeFormat('en',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const dateFormat=new Intl.DateTimeFormat('en',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});

function notice(message,error=false,{persistent=false}={}){
  clearTimeout(toastTimer);$('notice').hidden=false;$('notice').textContent=message;$('notice').classList.toggle('error',error);
  if(!persistent)toastTimer=setTimeout(()=>$('notice').hidden=true,7000);
}
function save(){if(!saveSettings(settings))notice('Unable to save settings. Changes will be lost when this tab closes.',true)}

function sprite(kind,item,{size='',rarity=7}={}){
  const node=make('span',`sprite ${size}`);node.setAttribute('role','img');node.setAttribute('aria-label',item.name);node.title=item.name;
  node.style.setProperty('--rarity-color',catalog.rarities[rarity].color);
  const columns=kind==='mob'?catalog.rendering.mobColumns:catalog.rendering.petalColumns;
  const rows=Math.ceil((catalog.rendering[`${kind}Cells`]||(kind==='mob'?catalog.mobs:catalog.petals).length)/columns);
  const cell=kind==='mob'?(item.iconIndex??item.id):(item.iconIndices?.[Math.min(7,rarity)]??item.id);
  const image=make('img');image.alt='';image.src=kind==='mob'?catalog.rendering.mobAtlas:catalog.rendering.petalAtlas;
  image.style.width=`${columns*100}%`;image.style.height=`${rows*100}%`;
  image.style.left=`-${(cell%columns)*100}%`;image.style.top=`-${Math.floor(cell/columns)*100}%`;
  image.decoding='async';node.append(image);return node;
}

function ruleName(rule){return rule.kind==='any'?'All mobs':(rule.kind==='mob'?catalog.mobBySlug:catalog.petalBySlug).get(rule.target)?.name||rule.target}
function ruleSubtitle(rule){if(rule.kind==='petal')return '';const variant=rule.variant==='*'?'All variants':catalog.variantBySlug.get(rule.variant).name;return `${variant} · Mob ${catalog.rarities[rule.mobMin].name}+`}

function renderRules(){
  $('rules').replaceChildren();$('rule-count').textContent=settings.rules.filter(r=>r.enabled).length;
  $('rule-empty').hidden=settings.rules.length>0;
  for(const rule of settings.rules){
    const row=make('div',`rule${rule.enabled?'':' disabled'}`);
    if(rule.kind==='any'){const icon=make('span','sprite small');icon.append(make('span','empty-flower','✿'));row.append(icon)}
    else row.append(sprite(rule.kind,(rule.kind==='mob'?catalog.mobBySlug:catalog.petalBySlug).get(rule.target),{size:'small'}));
    const info=make('div','rule-info');info.append(make('div','rule-name',ruleName(rule)));const subtitle=ruleSubtitle(rule);if(subtitle)info.append(make('div','rule-subtitle',subtitle));
    const actions=make('div','rule-actions'),toggle=make('label','switch'),input=make('input');input.type='checkbox';input.checked=rule.enabled;input.setAttribute('aria-label',`Enable filter for ${ruleName(rule)}`);input.onchange=()=>{rule.enabled=input.checked;save();renderRules();renderFeed()};toggle.append(input,make('span'));actions.append(toggle);
    const edit=make('button','icon-button','✎');edit.type='button';edit.title='Edit';edit.setAttribute('aria-label',`Edit ${ruleName(rule)}`);edit.onclick=()=>openEditor(rule);
    const remove=make('button','icon-button delete','×');remove.type='button';remove.title='Delete';remove.setAttribute('aria-label',`Delete ${ruleName(rule)}`);remove.onclick=()=>{settings.rules=settings.rules.filter(r=>r.id!==rule.id);save();renderRules();renderFeed()};
    actions.append(edit,remove);row.append(info,actions);$('rules').append(row);
  }
}

function renderFeed(){
  const filtered=settings.onlyMatches?events.filter(e=>matchingRules(catalog,e,settings.rules).length):events;
  const feed=$('feed'),fragment=document.createDocumentFragment();
  for(const event of filtered.slice(0,100)){
    const mob=catalog.mobBySlug.get(event.mob),rarity=catalog.rarities[event.rarity],variant=catalog.variantBySlug.get(event.variant);
    const matches=matchingRules(catalog,event,settings.rules),row=make('article',`spawn${matches.length?' match':''}`);row.id=`spawn-${event.id}`;
    row.append(sprite('mob',mob,{rarity:event.rarity}));
    const main=make('div','spawn-main'),meta=make('div','spawn-meta');const r=make('span','',rarity.name);r.style.color=rarity.color;meta.append(r);
    if(event.variant!=='normal'){const badge=make('span','variant-badge',variant.name);badge.style.setProperty('--variant-color',variant.color);meta.append(badge)}
    if(event.source==='demo')meta.append(make('span','variant-badge','DEMO'));
    if(matches.length)meta.append(make('span','match-label','Match'));
    main.append(meta,make('div','spawn-name',mob.name));
    const drops=dropsFor(catalog,event),dropRow=make('div','spawn-drops');
    for(const drop of drops.slice(0,5)){
      const wanted=matches.some(rule=>rule.kind==='petal'&&rule.target===drop.petal.slug);
      const button=make('button',`drop-button${wanted?' wanted':''}`);button.type='button';button.title=`${drop.petal.name}${drop.conditional?' (possible Flash drop)':''}`;button.setAttribute('aria-label',`Possible drops including ${drop.petal.name}`);button.append(sprite('petal',drop.petal,{size:'tiny'}));button.onclick=()=>showDrops(event);dropRow.append(button);
    }
    if(drops.length>5){const more=make('button','more-drops',`+${drops.length-5}`);more.type='button';more.setAttribute('aria-label','Show all possible drops');more.onclick=()=>showDrops(event);dropRow.append(more)}
    main.append(dropRow);
    const stamp=make('div','spawn-time'),time=make('time','',timeFormat.format(new Date(event.createdAt)));time.dateTime=event.createdAt;time.title=dateFormat.format(new Date(event.createdAt));
    if(/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(event.sourceUrl||'')){const link=make('a');link.href=event.sourceUrl;link.target='_blank';link.rel='noopener noreferrer';link.title='Open original message in Discord';link.append(time);stamp.append(link)}else stamp.append(time);
    row.append(main,stamp);fragment.append(row);
  }
  feed.replaceChildren(fragment);$('feed-count').textContent=filtered.length;$('feed-empty').hidden=filtered.length>0;
  if(!filtered.length){
    $('empty-feed-title').textContent=settings.onlyMatches?'No matching spawns yet':streamConnected?'Waiting for the next spawn…':'Connecting to spawn feed…';
  }
}

function showDrops(event){
  const mob=catalog.mobBySlug.get(event.mob),rarity=catalog.rarities[event.rarity];
  $('drops-name').textContent=event.name||(mob?`${rarity?.name||''} ${mob.name}`.trim():'');
  const grid=$('drop-grid');grid.replaceChildren();
  const drops=dropsFor(catalog,event);let conditional=false,rendered=0;
  for(const {petal,rolls=[]} of drops){
    const row=make('div','drop-row'),summary=make('div','drop-summary'),cells=make('div','drop-rarities');
    summary.append(make('div','drop-name',petal.name));
    if(rolls.length&&rolls.every(roll=>roll.conditional))summary.append(make('small','conditional','Flash choice'));
    const rates=new Map();
    for(const [index,roll] of rolls.entries())for(const chance of dropProbabilities(event.rarity,roll.q)){
      if(roll.conditional)conditional=true;
      if(!rates.has(chance.rarity))rates.set(chance.rarity,[]);
      rates.get(chance.rarity).push({...chance,conditional:roll.conditional,index});
    }
    if(!rates.size)continue;
    for(const [dropRarity,chances] of [...rates].sort((a,b)=>a[0]-b[0])){
      const info=catalog.rarities[dropRarity];if(!info)continue;
      const cell=make('div','drop-cell'),label=make('div','drop-rarity',info.name);label.style.color=info.color;
      cell.append(sprite('petal',petal,{rarity:dropRarity}),label);
      for(const chance of chances){
        const rate=make('div','drop-rate',formatProbability(chance.percent));
        rate.title=`${chance.percent.toPrecision(8)}%${chance.conditional?' · conditional Flash extra':''}${rolls.length>1?` · roll ${chance.index+1}`:''}`;
        if(chance.conditional||rolls.length>1)rate.append(make('small','drop-roll',chance.conditional?'Flash':`Roll ${chance.index+1}`));
        cell.append(rate);
      }
      cells.append(cell);
    }
    row.append(summary,cells);grid.append(row);rendered++;
  }
  if(!rendered)grid.append(make('p','drop-none','No known drops for this mob.'));
  const note=$('drop-note');note.hidden=!rendered;
  note.textContent=rendered?`Base rates · before personal bonuses${conditional?' · Flash rates assume that extra drop is selected.':''}`:'';
  $('drops-dialog').showModal();
}

function updateTarget(){
  const kind=$('rule-kind').value;$('target-picker').hidden=kind==='any';$('rule-options').hidden=kind==='petal';
  $('target-grid').setAttribute('aria-label',kind==='mob'?'Mobs':'Petals');
  renderTargets();
}
function selectedTarget(){const kind=$('rule-kind').value;return (kind==='mob'?catalog.mobs:catalog.petals).find(p=>selectedTargetSlug?p.slug===selectedTargetSlug:normalizeName(p.name)===normalizeName($('rule-target').value))}
function renderTargets(){
  const kind=$('rule-kind').value,grid=$('target-grid');grid.replaceChildren();$('rule-error').hidden=true;
  if(kind==='any')return;
  const query=normalizeName($('rule-target').value),selected=selectedTarget();
  const targets=(kind==='mob'?catalog.mobs:catalog.petals).filter(item=>normalizeName(item.name).includes(query));
  const fragment=document.createDocumentFragment();
  for(const item of targets){
    const button=make('button','target-option');button.type='button';button.dataset.target=item.slug;button.setAttribute('aria-label',item.name);button.setAttribute('aria-pressed',String(selected?.slug===item.slug));
    const icon=sprite(kind,item);icon.setAttribute('aria-hidden','true');button.append(icon);if(kind==='mob')button.append(make('span','target-name',item.name));
    button.onclick=()=>{selectedTargetSlug=item.slug;$('rule-error').hidden=true;for(const option of grid.children)option.setAttribute('aria-pressed',String(option===button))};
    fragment.append(button);
  }
  grid.append(fragment);grid.scrollTop=0;$('target-empty').hidden=targets.length>0;
}
function openEditor(rule){
  if(!rule&&settings.rules.length>=100){notice('You can save up to 100 filters.',true);return}
  editingId=rule?.id||null;selectedTargetSlug=rule&&rule.kind!=='any'?rule.target:null;$('rule-title').textContent=rule?'Edit filter':'Add filter';
  $('rule-kind').value=rule?.kind||'petal';$('rule-target').value=rule&&rule.kind!=='any'?ruleName(rule):'';
  $('rule-variant').value=rule?.variant||'*';$('rule-mob-min').value=rule?.mobMin??8;
  updateTarget();$('rule-error').hidden=true;$('rule-dialog').showModal();
  if($('rule-kind').value!=='any')$('rule-target').focus();
}
function saveRule(event){
  event.preventDefault();const kind=$('rule-kind').value,target=selectedTarget();
  if(kind!=='any'&&!target){$('rule-error').textContent='Select an icon.';$('rule-error').hidden=false;$('rule-target').focus();return}
  const previous=settings.rules.find(r=>r.id===editingId);
  const rule={id:editingId||crypto.randomUUID(),kind,target:kind==='any'?'*':target.slug,variant:kind==='petal'?'*':$('rule-variant').value,
    mobMin:kind==='petal'?0:Number($('rule-mob-min').value),dropMin:0,enabled:previous?.enabled??true};
  if(!validateRule(catalog,rule))return;
  if(editingId)settings.rules=settings.rules.map(r=>r.id===editingId?rule:r);else settings.rules.push(rule);
  save();renderRules();renderFeed();$('rule-dialog').close();
}

export function notificationState(permission,enabled){
  const unsupported=permission==='unsupported',blocked=permission==='denied'||unsupported;
  const active=permission==='granted'&&enabled===true;
  return {active,disabled:unsupported,icon:blocked?'bell-off':active?'bell-ring':'bell',
    label:unsupported?'Notifications unavailable':blocked?'Notifications blocked':active?'Notifications enabled — click to disable':'Notifications disabled — click to enable'};
}
function renderNotificationButton(){
  const state=notificationState(permission(),settings.enabled),button=$('notifications'),icons={bell:Bell,'bell-ring':BellRing,'bell-off':BellOff};
  button.classList.toggle('active',state.active);
  $('notification-icon').replaceChildren(createElement(icons[state.icon],{'aria-hidden':'true',class:`lucide lucide-${state.icon}`,width:20,height:20}));
  button.title=state.label;button.setAttribute('aria-label',state.label);button.disabled=state.disabled;
  $('test-notification').disabled=!state.active;button.setAttribute('aria-pressed',String(state.active));
}
async function enableNotifications(){
  if(permission()==='unsupported')return;
  if(permission()==='denied'){notice('Allow notifications in your browser settings, then reload this page.',true);return}
  if(settings.enabled&&permission()==='granted'){
    settings.enabled=false;save();renderNotificationButton();notice('Notifications disabled.');
    return;
  }
  return requestNotifications();
}
function requestNotifications(){
  if(permissionRequest)return permissionRequest;
  // Persist before prompting so a dismissed prompt is not repeated on every load.
  settings.permissionRequested=true;save();
  const request=(async()=>{
    let result;
    // Called synchronously from the click handler (and from init) so the user activation is still present.
    try{result=await Notification.requestPermission()}
    catch{
      settings.enabled=false;save();renderNotificationButton();
      notice('Notifications disabled. Click the bell to enable.',true);return;
    }
    settings.enabled=result==='granted';save();renderNotificationButton();
    if(settings.enabled)notice(settings.rules.length?'Notifications enabled for new matching spawns.':'Notifications enabled. Add a filter to receive alerts.');
    else notice(result==='denied'?'Notifications blocked. Allow them in your browser settings, then reload.':'Notifications disabled. Click the bell to enable.');
  })();
  permissionRequest=request;
  // Clear after this request settles, but never overwrite a newer request. Clearing inside the
  // async body would run before this assignment when the body settles synchronously.
  const clear=()=>{if(permissionRequest===request)permissionRequest=null};
  request.then(clear,clear);
  return request;
}
async function showNotification(title,body,{tag,eventId}={}){
  const options={body,tag,data:{eventId},renotify:false};
  try{
    const reg=await registration;
    if(reg)return await reg.showNotification(title,options);
    const notification=new Notification(title,options);notification.onclick=()=>{window.focus();if(eventId)document.getElementById(`spawn-${eventId}`)?.scrollIntoView({block:'center',behavior:'smooth'});notification.close()};
  }catch{notice('Unable to show notifications. Check your browser and system notification settings.',true)}
}
async function notifySpawn(event){
  if(!settings.enabled||permission()!=='granted'||event.historical)return;
  const age=Date.now()-Date.parse(event.createdAt);if(age>120000||age< -30000)return;
  const rules=matchingRules(catalog,event,settings.rules);if(!rules.length)return;
  if(!await claimNotification(event.key))return;
  const labels=[...new Set(rules.map(ruleName))].join(', ');
  await showNotification(`${event.name} spawned!`,`Filters: ${labels}`,{tag:`zorr-${event.key}`,eventId:event.id});
}

function renderConnection(){
  const online=streamConnected&&botStatus?.connected;
  $('connection').className=`connection ${online?'online':'offline'}`;
  $('connection').querySelector('span').textContent=botStatus?.demo?'Demo feed':!streamConnected?'Reconnecting…':online?'Live · connected':'Discord reconnecting…';
  if(botStatus?.lastSpawnAt)$('last-update').textContent=`Last spawn ${timeFormat.format(new Date(botStatus.lastSpawnAt))}`;
}
function applySnapshot(data){
  events=(data.events||[]).filter(e=>validEvent(catalog,e)).sort((a,b)=>b.id-a.id).slice(0,200);
  streamCursor=data.cursor||0;botStatus=data.status;streamConnected=true;renderConnection();renderFeed();
  // History, including after a cursor reset, must never generate notifications.
  const target=location.hash&&document.getElementById(location.hash.slice(1));target?.scrollIntoView({block:'center'});
}
function applySpawn(event){
  if(!validEvent(catalog,event)||events.some(e=>e.key===event.key))return;
  streamCursor=Math.max(streamCursor,event.id);events=[event,...events].sort((a,b)=>b.id-a.id).slice(0,200);
  if(botStatus)botStatus.lastSpawnAt=event.createdAt;renderFeed();renderConnection();void notifySpawn(event);
}
function resetHeartbeat(){clearTimeout(connectionTimer);connectionTimer=setTimeout(startPolling,45000)}
async function pollEvents(){
  try{
    const response=await fetch(`/api/events?after=${streamCursor}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Event request failed');
    const data=await response.json();if(!Array.isArray(data.events))throw new Error('Invalid event response');
    if(data.snapshot)applySnapshot(data);else{for(const event of data.events)applySpawn(event);streamCursor=Math.max(streamCursor,data.cursor||0);botStatus=data.status;streamConnected=true;renderConnection()}
  }catch{streamConnected=false;renderConnection()}
  finally{pollTimer=setTimeout(pollEvents,5000)}
}
function startPolling(){
  if(polling)return;
  polling=true;clearTimeout(reconnectTimer);clearTimeout(connectionTimer);clearTimeout(pollTimer);stream?.close();void pollEvents();
}
function connect(){
  clearTimeout(reconnectTimer);
  if(polling)return;
  clearTimeout(connectionTimer);connectionTimer=setTimeout(startPolling,12000);
  stream=new EventSource(`/api/stream${streamCursor?`?after=${streamCursor}`:''}`);
  stream.onopen=()=>{if(polling)return;connectionFailures=0;streamConnected=true;resetHeartbeat();renderConnection()};
  stream.addEventListener('status',event=>{
    if(polling)return;
    try{botStatus=JSON.parse(event.data);streamConnected=true;renderConnection();
      resetHeartbeat();
      if(botStatus.demo)notice('Demo feed: spawns shown here are test data.',false,{persistent:true});
    }catch{}
  });
  stream.addEventListener('snapshot',event=>{
    if(polling)return;
    try{applySnapshot(JSON.parse(event.data));resetHeartbeat()}catch{}
  });
  stream.addEventListener('spawn',message=>{
    if(polling)return;
    try{applySpawn(JSON.parse(message.data));resetHeartbeat()}catch{}
  });
  stream.onerror=()=>{if(polling)return;streamConnected=false;renderConnection();if(!events.length)$('empty-feed-title').textContent='Reconnecting to spawn feed…';
    // HTTP 502/503 can put native EventSource in CLOSED, which will not retry.
    if(stream.readyState===EventSource.CLOSED){stream.close();if(++connectionFailures>=2)startPolling();else reconnectTimer=setTimeout(connect,5000)}
  };
}

async function init(){
  const response=await fetch(__CATALOG_URL__);if(!response.ok)throw new Error('Catalog load failed');
  catalog=indexCatalog(await response.json());settings=loadSettings(catalog,validateRule);
  registration='serviceWorker' in navigator?navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).catch(()=>null):Promise.resolve(null);
  $('rule-variant').append(new Option('All variants','*'),...catalog.variants.map(v=>new Option(v.name,v.slug)));
  for(const r of catalog.rarities)$('rule-mob-min').add(new Option(r.name,r.id));
  $('rule-form').onsubmit=saveRule;$('rule-kind').onchange=()=>{selectedTargetSlug=null;$('rule-target').value='';$('rule-variant').value='*';$('rule-mob-min').value=8;updateTarget()};$('rule-target').oninput=()=>{selectedTargetSlug=null;renderTargets()};
  $('add-rule').onclick=()=>openEditor();$('close-rule').onclick=$('cancel-rule').onclick=()=>$('rule-dialog').close();$('close-drops').onclick=()=>$('drops-dialog').close();
  for(const id of ['rule-dialog','drops-dialog'])$(id).addEventListener('click',event=>{if(event.target===$(id)){const b=$(id).getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)$(id).close()}});
  $('only-matches').checked=settings.onlyMatches;$('only-matches').onchange=()=>{settings.onlyMatches=$('only-matches').checked;save();renderFeed()};
  $('notifications').onclick=enableNotifications;$('test-notification').onclick=()=>void showNotification('Zorr notifier','Desktop notifications are enabled.',{tag:'zorr-notifier-test'});
  document.addEventListener('visibilitychange',renderNotificationButton);
  renderRules();renderFeed();renderNotificationButton();connect();
  if(!settings.permissionRequested&&permission()==='default')void requestNotifications();
}
if(typeof document!=='undefined')init().catch(()=>{notice('Unable to load the page. Please reload.',true,{persistent:true});$('empty-feed-title').textContent='Failed to load'});
