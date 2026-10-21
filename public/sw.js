self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const destination=new URL('/',self.location.origin);
  if(event.notification.data?.eventId)destination.hash=`spawn-${event.notification.data.eventId}`;
  event.waitUntil((async()=>{
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const tab=clients.find(client=>new URL(client.url).origin===destination.origin);
    if(tab){await tab.navigate(destination.href);return tab.focus()}
    return self.clients.openWindow(destination.href);
  })());
});
