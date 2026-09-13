importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

var CACHE = 'odeme-v16';

// Firebase başlat
firebase.initializeApp({
  apiKey: "AIzaSyAFPhb4LmtKyQZcog0lubAgxmGrjywrRj4",
  authDomain: "odeme-takip-b7c1f.firebaseapp.com",
  projectId: "odeme-takip-b7c1f",
  storageBucket: "odeme-takip-b7c1f.firebasestorage.app",
  messagingSenderId: "179050084056",
  appId: "1:179050084056:web:2ef5a69bab382555a3c9ad"
});

var messaging = firebase.messaging();

// Arka plan bildirimi
messaging.onBackgroundMessage(function(payload) {
  var title = (payload.notification && payload.notification.title) || 'Ödeme Hatırlatma';
  var body = (payload.notification && payload.notification.body) || '';
  var options = {
    body: body,
    icon: './icon.svg',
    badge: './icon.svg',
    vibrate: [200, 100, 200],
    tag: (payload.data && payload.data.tag) || 'odeme',
    requireInteraction: payload.data && payload.data.urgent === 'true',
    data: {url: './'}
  };
  return self.registration.showNotification(title, options);
});

// Bildirime tıklanınca uygulamayı aç
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(function(cs) {
      if (cs.length > 0) return cs[0].focus();
      return clients.openWindow('./');
    })
  );
});

// Install
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return c.addAll(['./index.html', './manifest.json', './icon.svg']);
    })
  );
  self.skipWaiting();
});

// Activate
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(ks) {
      return Promise.all(
        ks.filter(function(k) { return k !== CACHE; })
          .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch
self.addEventListener('fetch', function(e) {
  if (!e.request.url.startsWith('http')) return;
  e.respondWith(
    caches.match(e.request).then(function(r) {
      return r || fetch(e.request).then(function(res) {
        if (res.status === 200 && e.request.url.startsWith('https://')) {
          var clone = res.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return res;
      }).catch(function() {
        return caches.match('./index.html');
      });
    })
  );
});

// Message
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
