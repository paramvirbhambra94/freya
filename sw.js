const C='freya-v11';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/app.js','/sections.js', '/eyes.js','/style.css','/manifest.webmanifest','/icon-192.png','/icon-512.png','/mark.svg','/icon.svg'])));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
  e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(C).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request)));
});

// Push notifications: Critical = loud & sticky, High = normal, Low = silent.
self.addEventListener('push',e=>{
  let d={};try{d=e.data.json()}catch(x){d={title:'F.R.E.Y.A.',body:e.data?e.data.text():''}}
  const pr=d.priority||'high';
  const opts={body:d.body||'',icon:'/icon-192.png',badge:'/icon-192.png',tag:d.tag||pr,data:{url:d.url||'/'},renotify:pr!=='low'};
  if(pr==='critical'){opts.requireInteraction=true;opts.vibrate=[500,200,500,200,800];}
  else if(pr==='low'){opts.silent=true;}
  else{opts.vibrate=[180,80,180];}
  e.waitUntil(self.registration.showNotification(d.title||'F.R.E.Y.A.',opts));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=(e.notification.data&&e.notification.data.url)||'/';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{
    for(const w of ws){if('focus' in w){w.navigate(url);return w.focus();}}
    return clients.openWindow(url);
  }));
});
