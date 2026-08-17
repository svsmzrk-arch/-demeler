importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAFPhb4LmtKyQZcog0lubAgxmGrjywrRj4",
  authDomain: "odeme-takip-b7c1f.firebaseapp.com",
  projectId: "odeme-takip-b7c1f",
  storageBucket: "odeme-takip-b7c1f.firebasestorage.app",
  messagingSenderId: "179050084056",
  appId: "1:179050084056:web:2ef5a69bab382555a3c9ad"
});

const messaging = firebase.messaging();

// Arka planda gelen bildirimleri göster
messaging.onBackgroundMessage(function(payload) {
  const title = payload.notification.title || 'Ödeme Hatırlatma';
  const options = {
    body: payload.notification.body || '',
    icon: './icon.svg',
    badge: './icon.svg',
    vibrate: [200, 100, 200],
    tag: payload.data && payload.data.tag ? payload.data.tag : 'odeme',
    requireInteraction: payload.data && payload.data.urgent === 'true',
    data: { url: './' }
  };
  return self.registration.showNotification(title, options);
});

// Bildirime tıklanınca uygulamayı aç
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
      if (cs.length > 0) return cs[0].focus();
      return clients.openWindow('./');
    })
  );
});
