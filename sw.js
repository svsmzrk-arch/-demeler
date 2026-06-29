var CACHE = 'odeme-v6';
var STORAGE_KEY = 'odeme-v8';

// ── Install ──────────────────────────────────────────────
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return c.addAll(['./index.html', './manifest.json', './icon.svg']);
    })
  );
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(ks) {
      return Promise.all(
        ks.filter(function(k){ return k !== CACHE; })
          .map(function(k){ return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
  // Schedule daily check when SW activates
  scheduleDailyCheck();
});

// ── Fetch (offline support) ───────────────────────────────
self.addEventListener('fetch', function(e) {
  e.respondWith(
    caches.match(e.request).then(function(r) {
      return r || fetch(e.request).then(function(res) {
        var clone = res.clone();
        caches.open(CACHE).then(function(c){ c.put(e.request, clone); });
        return res;
      }).catch(function() {
        return caches.match('./index.html');
      });
    })
  );
});

// ── Notification click ────────────────────────────────────
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(cs) {
      if (cs.length > 0) {
        return cs[0].focus();
      }
      return clients.openWindow('./');
    })
  );
});

// ── Message from app ──────────────────────────────────────
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (e.data && e.data.type === 'CHECK_NOW') {
    checkAndNotify();
  }
  if (e.data && e.data.type === 'SCHEDULE') {
    scheduleDailyCheck();
  }
});

// ── Daily check via setTimeout chain ─────────────────────
function scheduleDailyCheck() {
  var now = new Date();
  // Fire at 09:00 today, or tomorrow if already past
  var next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0);
  if (next <= now) next = new Date(next.getTime() + 86400000);
  var delay = next.getTime() - now.getTime();

  setTimeout(function() {
    checkAndNotify();
    // Re-schedule for tomorrow
    setInterval(checkAndNotify, 86400000);
  }, delay);
}

// ── Core check logic ─────────────────────────────────────
function checkAndNotify() {
  // Read payments from all clients via IndexedDB / localStorage proxy
  self.clients.matchAll().then(function(cs) {
    if (cs.length > 0) {
      cs[0].postMessage({type: 'GET_PAYMENTS'});
    }
  });
  // Also try reading from cache-stored data
  readPaymentsAndNotify();
}

function readPaymentsAndNotify() {
  // Service workers can't access localStorage directly.
  // We use a small IndexedDB store that the app writes to.
  openPaymentDB().then(function(db) {
    var tx = db.transaction('payments', 'readonly');
    var store = tx.objectStore('payments');
    var req = store.get('all');
    req.onsuccess = function() {
      if (req.result) {
        processPayments(JSON.parse(req.result.data));
      }
    };
  }).catch(function() {});
}

function openPaymentDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open('odeme-db', 1);
    req.onupgradeneeded = function(e) {
      e.target.result.createObjectStore('payments', {keyPath: 'id'});
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror = reject;
  });
}

function processPayments(payments) {
  if (!Array.isArray(payments)) return;
  var now = new Date();
  now.setHours(0, 0, 0, 0);
  var yr = now.getFullYear(), mo = now.getMonth(), day = now.getDate();

  var today = [];
  var soon = [];   // 1-3 days
  var overdue = [];

  payments.forEach(function(p) {
    var dueDate = null;

    if (p.type === 't') {
      var d = new Date(p.date + 'T00:00:00');
      if (d.getFullYear() === yr && d.getMonth() === mo) {
        dueDate = d;
      }
    } else {
      var inMonth = p.months === 'always' ? true :
        (Array.isArray(p.months) && p.months.indexOf(mo) >= 0);
      if (inMonth) {
        dueDate = new Date(yr, mo, p.dueDay);
      }
    }

    if (!dueDate) return;

    // Check if already paid this month
    var pkey = yr + '-' + mo;
    var paid = !!(p.paidMonths && p.paidMonths[pkey]);
    if (paid) return;

    dueDate.setHours(0, 0, 0, 0);
    var diff = Math.round((dueDate - now) / 86400000);

    if (diff < 0) overdue.push({name: p.name, diff: diff});
    else if (diff === 0) today.push({name: p.name});
    else if (diff <= 3) soon.push({name: p.name, diff: diff});
  });

  // Send notifications
  if (overdue.length > 0) {
    var names = overdue.map(function(x){ return x.name; }).join(', ');
    sendNotification(
      '⚠️ Geciken Ödeme' + (overdue.length > 1 ? 'ler' : '') + ' (' + overdue.length + ')',
      names + ' — hemen ödeyin!',
      'overdue'
    );
  }

  if (today.length > 0) {
    var names2 = today.map(function(x){ return x.name; }).join(', ');
    sendNotification(
      '📅 Bugün Son Gün' + (today.length > 1 ? ' (' + today.length + ' ödeme)' : '') + '!',
      names2,
      'today'
    );
  }

  if (soon.length > 0) {
    var names3 = soon.map(function(x){ return x.name + ' (' + x.diff + ' gün)'; }).join(', ');
    sendNotification(
      '🔔 Yaklaşan Ödeme' + (soon.length > 1 ? 'ler' : '') + ' (' + soon.length + ')',
      names3,
      'soon'
    );
  }
}

function sendNotification(title, body, tag) {
  return self.registration.showNotification(title, {
    body: body,
    tag: tag,
    icon: './icon.svg',
    badge: './icon.svg',
    vibrate: [200, 100, 200],
    requireInteraction: tag === 'overdue',
    data: {url: './'}
  });
}
