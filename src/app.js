import {indexCatalog,matchingRules,dropsFor,validateRule,validEvent,normalizeName} from './matching.js';
import {loadSettings,saveSettings,claimNotification} from './storage.js';

const $=id=>document.getElementById(id);
const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node};
let catalog,settings,stream,registration,editingId=null;
let events=[],streamConnected=false,botStatus=null,toastTimer,reconnectTimer,streamCursor=0;
const permission=()=>('Notification' in window?Notification.permission:'unsupported');
const timeFormat=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const dateFormat=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});

function notice(message,error=false,{persistent=false}={}){
  clearTimeout(toastTimer);$('notice').hidden=false;$('notice').textContent=message;$('notice').classList.toggle('error',error);
  if(!persistent)toastTimer=setTimeout(()=>$('notice').hidden=true,7000);
}
function save(){if(!saveSettings(settings))notice('設定を保存できません。このタブを閉じると設定が失われます。',true)}

function sprite(kind,item,{size='',rarity=7}={}){
  const node=make('span',`sprite ${size}`);node.setAttribute('role','img');node.setAttribute('aria-label',item.name);node.title=item.name;
  node.style.setProperty('--rarity-color',catalog.rarities[rarity].color);
  const columns=kind==='mob'?catalog.rendering.mobColumns:catalog.rendering.petalColumns;
  const rows=Math.ceil((kind==='mob'?catalog.mobs:catalog.petals).length/columns);
  const image=make('img');image.alt='';image.src=kind==='mob'?catalog.rendering.mobAtlas:catalog.rendering.petalAtlas;
  image.style.width=`${columns*100}%`;image.style.height=`${rows*100}%`;
  image.style.left=`-${(item.id%columns)*100}%`;image.style.top=`-${Math.floor(item.id/columns)*100}%`;
  image.decoding='async';node.append(image);return node;
}

function ruleName(rule){return rule.kind==='any'?'すべてのモブ':(rule.kind==='mob'?catalog.mobBySlug:catalog.petalBySlug).get(rule.target)?.name||rule.target}
function ruleSubtitle(rule){const variant=rule.variant==='*'?'All variants':catalog.variantBySlug.get(rule.variant).name;return `${variant} · Mob ${catalog.rarities[rule.mobMin].name}+${rule.kind==='petal'?` · Petal ${catalog.rarities[rule.dropMin].name}+`:''}`}

function renderRules(){
  $('rules').replaceChildren();$('rule-count').textContent=settings.rules.filter(r=>r.enabled).length;
  $('rule-empty').hidden=settings.rules.length>0;
  for(const rule of settings.rules){
    const row=make('div',`rule${rule.enabled?'':' disabled'}`);
    if(rule.kind==='any'){const icon=make('span','sprite small');icon.append(make('span','empty-flower','✿'));row.append(icon)}
    else row.append(sprite(rule.kind,(rule.kind==='mob'?catalog.mobBySlug:catalog.petalBySlug).get(rule.target),{size:'small'}));
    const info=make('div','rule-info');info.append(make('div','rule-name',ruleName(rule)),make('div','rule-subtitle',ruleSubtitle(rule)));
    const actions=make('div','rule-actions'),toggle=make('label','switch'),input=make('input');input.type='checkbox';input.checked=rule.enabled;input.setAttribute('aria-label',`${ruleName(rule)} の通知条件を有効にする`);input.onchange=()=>{rule.enabled=input.checked;save();renderRules();renderFeed()};toggle.append(input,make('span'));actions.append(toggle);
    const edit=make('button','icon-button','✎');edit.type='button';edit.title='編集';edit.setAttribute('aria-label',`${ruleName(rule)} を編集`);edit.onclick=()=>openEditor(rule);
    const remove=make('button','icon-button delete','×');remove.type='button';remove.title='削除';remove.setAttribute('aria-label',`${ruleName(rule)} を削除`);remove.onclick=()=>{settings.rules=settings.rules.filter(r=>r.id!==rule.id);save();renderRules();renderFeed()};
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
    if(matches.length)meta.append(make('span','match-label','一致'));
    main.append(meta,make('div','spawn-name',mob.name));
    const drops=dropsFor(catalog,event),dropRow=make('div','spawn-drops');
    for(const drop of drops.slice(0,5)){
      const wanted=matches.some(rule=>rule.kind==='petal'&&rule.target===drop.petal.slug);
      const button=make('button',`drop-button${wanted?' wanted':''}`);button.type='button';button.title=`${drop.petal.name}${drop.conditional?' (Flash候補)':''}`;button.setAttribute('aria-label',`${drop.petal.name}を含むドロップ候補`);button.append(sprite('petal',drop.petal,{size:'tiny'}));button.onclick=()=>showDrops(event);dropRow.append(button);
    }
    if(drops.length){const more=make('button','more-drops',drops.length>5?`+${drops.length-5}`:'Drops');more.type='button';more.setAttribute('aria-label','すべてのドロップ候補');more.onclick=()=>showDrops(event);dropRow.append(more)}
    main.append(dropRow);
    const stamp=make('div','spawn-time'),time=make('time','',timeFormat.format(new Date(event.createdAt)));time.dateTime=event.createdAt;time.title=dateFormat.format(new Date(event.createdAt));
    if(/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(event.sourceUrl||'')){const link=make('a');link.href=event.sourceUrl;link.target='_blank';link.rel='noopener noreferrer';link.title='Discordで元メッセージを開く';link.append(time);stamp.append(link)}else stamp.append(time);
    row.append(main,stamp);fragment.append(row);
  }
  feed.replaceChildren(fragment);$('feed-count').textContent=filtered.length;$('feed-empty').hidden=filtered.length>0;
  if(!filtered.length){
    $('empty-feed-title').textContent=settings.onlyMatches?'一致する出現ログはまだありません':streamConnected?'次の出現を待っています':'出現ログに接続しています';
    $('empty-feed-description').textContent=settings.onlyMatches?'通知条件に一致したモブがここに表示されます。':'新しいモブが出現すると、ここに表示されます。';
  }
}

function showDrops(event){
  $('drops-name').textContent=event.name;$('drop-grid').replaceChildren();
  const drops=dropsFor(catalog,event);
  for(const {petal,conditional} of drops){const box=make('div');box.append(sprite('petal',petal),make('small','',petal.name));if(conditional)box.append(make('span','conditional','Flash候補'));$('drop-grid').append(box)}
  if(!drops.length)$('drop-grid').append(make('p','drop-none','このモブのドロップ候補はありません。'));
  $('drops-dialog').showModal();
}

function updateTarget(){
  const kind=$('rule-kind').value;$('target-field').hidden=kind==='any';$('drop-field').hidden=kind!=='petal';$('rule-preview').replaceChildren();
  $('rule-target').required=kind!=='any';$('rule-target').setCustomValidity('');
  const options=kind==='mob'?catalog.mobs:catalog.petals;
  $('target-options').replaceChildren(...options.map(p=>new Option(p.name,p.name)));
  $('rule-description').textContent=kind==='petal'?'このペタルを落とす可能性があるモブを通知。卵・Magic置換・variant追加候補も含みます。':kind==='mob'?'このモブの出現を、選んだvariantとレアリティの範囲で通知します。':'選んだvariantとレアリティに一致する、すべてのモブを通知します。';
  previewTarget();
}
function selectedTarget(){const kind=$('rule-kind').value;return (kind==='mob'?catalog.mobs:catalog.petals).find(p=>normalizeName(p.name)===normalizeName($('rule-target').value)||p.slug===$('rule-target').value)}
function previewTarget(){const target=selectedTarget();$('rule-preview').replaceChildren();if(target&&$('rule-kind').value!=='any')$('rule-preview').append(sprite($('rule-kind').value,target));$('rule-error').hidden=true;$('rule-target').setCustomValidity('')}
function openEditor(rule){
  if(!rule&&settings.rules.length>=100){notice('通知条件は100件まで保存できます。',true);return}
  editingId=rule?.id||null;$('rule-title').textContent=rule?'通知条件を編集':'通知条件を追加';
  $('rule-kind').value=rule?.kind||'petal';$('rule-target').value=rule&&rule.kind!=='any'?ruleName(rule):'';
  $('rule-variant').value=rule?.variant||'*';$('rule-mob-min').value=rule?.mobMin??0;$('rule-drop-min').value=rule?.dropMin??0;
  updateTarget();$('rule-error').hidden=true;$('rule-dialog').showModal();
  if($('rule-kind').value!=='any')$('rule-target').focus();
}
function saveRule(event){
  event.preventDefault();const kind=$('rule-kind').value,target=selectedTarget();
  if(kind!=='any'&&!target){$('rule-error').textContent='候補から正しい名前を選択してください。';$('rule-error').hidden=false;$('rule-target').focus();return}
  const previous=settings.rules.find(r=>r.id===editingId);
  const rule={id:editingId||crypto.randomUUID(),kind,target:kind==='any'?'*':target.slug,variant:$('rule-variant').value,
    mobMin:Number($('rule-mob-min').value),dropMin:Number($('rule-drop-min').value),enabled:previous?.enabled??true};
  if(!validateRule(catalog,rule))return;
  if(editingId)settings.rules=settings.rules.map(r=>r.id===editingId?rule:r);else settings.rules.push(rule);
  save();renderRules();renderFeed();$('rule-dialog').close();
  if(!settings.enabled)notice('通知条件を保存しました。上の「通知を有効に」でデスクトップ通知を開始できます。');
}

function renderNotificationButton(){
  const p=permission(),active=settings.enabled&&p==='granted';$('notifications').classList.toggle('active',active);
  $('notification-label').textContent=p==='unsupported'?'通知に未対応':p==='denied'?'通知がブロックされています':active?'通知オン':'通知を有効に';
  $('notifications').disabled=p==='unsupported';$('test-notification').disabled=p!=='granted'||!settings.enabled;
  $('notifications').setAttribute('aria-pressed',String(active));
}
async function enableNotifications(){
  if(permission()==='unsupported')return;
  if(permission()==='denied'){notice('ブラウザのサイト設定から通知を許可して、ページを再読み込みしてください。',true);return}
  if(settings.enabled&&permission()==='granted'){settings.enabled=false;save();renderNotificationButton();return}
  // Request permission directly in the click handler, before waiting for the SW.
  const result=await Notification.requestPermission();
  settings.enabled=result==='granted';save();renderNotificationButton();
  if(settings.enabled){notice(settings.rules.length?'通知を有効にしました。新しい一致モブの出現時に通知します。':'通知を有効にしました。続けて通知条件を追加してください。');}
  else notice('通知は許可されませんでした。出現ログは引き続き利用できます。',true);
}
async function showNotification(title,body,{tag,eventId}={}){
  const options={body,tag,icon:new URL('/favicon.svg',location.origin).href,data:{eventId},renotify:false};
  try{
    const reg=await registration;
    if(reg)return await reg.showNotification(title,options);
    const notification=new Notification(title,options);notification.onclick=()=>{window.focus();if(eventId)document.getElementById(`spawn-${eventId}`)?.scrollIntoView({block:'center',behavior:'smooth'});notification.close()};
  }catch{notice('通知を表示できませんでした。ブラウザとOSの通知設定を確認してください。',true)}
}
async function notifySpawn(event){
  if(!settings.enabled||permission()!=='granted'||event.historical)return;
  const age=Date.now()-Date.parse(event.createdAt);if(age>120000||age< -30000)return;
  const rules=matchingRules(catalog,event,settings.rules);if(!rules.length)return;
  if(!await claimNotification(event.key))return;
  const labels=[...new Set(rules.map(ruleName))].join(', ');
  await showNotification(`${event.name} spawned!`,`条件: ${labels}`,{tag:`zorr-${event.key}`,eventId:event.id});
}

function renderConnection(){
  const online=streamConnected&&botStatus?.connected;
  $('connection').className=`connection ${online?'online':'offline'}`;
  $('connection').querySelector('span').textContent=botStatus?.demo?'Demo feed':!streamConnected?'Reconnecting…':online?'Live · connected':'Discord reconnecting…';
  if(botStatus?.lastSpawnAt)$('last-update').textContent=`Last spawn ${timeFormat.format(new Date(botStatus.lastSpawnAt))}`;
}
function connect(){
  clearTimeout(reconnectTimer);
  stream=new EventSource(`/api/stream${streamCursor?`?after=${streamCursor}`:''}`);
  stream.onopen=()=>{streamConnected=true;renderConnection()};
  stream.addEventListener('status',event=>{
    try{botStatus=JSON.parse(event.data);streamConnected=true;renderConnection();
      if(botStatus.demo)notice('デモ配信です。表示される出現はテストデータです。',false,{persistent:true});
    }catch{}
  });
  stream.addEventListener('snapshot',event=>{
    try{const data=JSON.parse(event.data);events=(data.events||[]).filter(e=>validEvent(catalog,e)).sort((a,b)=>b.id-a.id).slice(0,200);streamCursor=data.cursor||0;botStatus=data.status;streamConnected=true;renderConnection();renderFeed();
      // A snapshot is history, including after a cursor reset: never notify it.
      const target=location.hash&&document.getElementById(location.hash.slice(1));target?.scrollIntoView({block:'center'});
    }catch{}
  });
  stream.addEventListener('spawn',message=>{
    try{const event=JSON.parse(message.data);if(!validEvent(catalog,event)||events.some(e=>e.key===event.key))return;
      streamCursor=Math.max(streamCursor,event.id);events=[event,...events].sort((a,b)=>b.id-a.id).slice(0,200);
      if(botStatus)botStatus.lastSpawnAt=event.createdAt;renderFeed();renderConnection();void notifySpawn(event);
    }catch{}
  });
  stream.onerror=()=>{streamConnected=false;renderConnection();if(!events.length){$('empty-feed-title').textContent='配信に再接続しています';$('empty-feed-description').textContent='接続が戻ると自動でログを再開します。'}
    // HTTP 502/503 can put native EventSource in CLOSED, which will not retry.
    if(stream.readyState===EventSource.CLOSED){stream.close();reconnectTimer=setTimeout(connect,5000)}
  };
}

async function init(){
  const response=await fetch(__CATALOG_URL__);if(!response.ok)throw new Error('Catalog load failed');
  catalog=indexCatalog(await response.json());settings=loadSettings(catalog,validateRule);
  registration='serviceWorker' in navigator?navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).catch(()=>null):Promise.resolve(null);
  $('rule-variant').append(new Option('All variants','*'),...catalog.variants.map(v=>new Option(v.name,v.slug)));
  for(const r of catalog.rarities){$('rule-mob-min').add(new Option(r.name,r.id));if(r.id<=7)$('rule-drop-min').add(new Option(r.name,r.id))}
  $('rule-form').onsubmit=saveRule;$('rule-kind').onchange=()=>{$('rule-target').value='';updateTarget()};$('rule-target').oninput=previewTarget;
  $('add-rule').onclick=()=>openEditor();$('close-rule').onclick=$('cancel-rule').onclick=()=>$('rule-dialog').close();$('close-drops').onclick=()=>$('drops-dialog').close();
  for(const id of ['rule-dialog','drops-dialog'])$(id).addEventListener('click',event=>{if(event.target===$(id)){const b=$(id).getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)$(id).close()}});
  $('only-matches').checked=settings.onlyMatches;$('only-matches').onchange=()=>{settings.onlyMatches=$('only-matches').checked;save();renderFeed()};
  $('notifications').onclick=enableNotifications;$('test-notification').onclick=()=>void showNotification('Zorr notifier','デスクトップ通知が有効です。',{tag:'zorr-notifier-test'});
  $('source-date').textContent=`Game data · ${catalog.source.snapshotDate}`;
  document.addEventListener('visibilitychange',renderNotificationButton);
  renderRules();renderFeed();renderNotificationButton();connect();
}
init().catch(()=>{notice('ページを読み込めませんでした。再読み込みしてください。',true,{persistent:true});$('empty-feed-title').textContent='読み込みに失敗しました'});
