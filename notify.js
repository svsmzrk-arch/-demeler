// GitHub Actions'da çalışacak Node.js scripti
// Firestore'dan ödemeleri ve FCM tokenları okur, bildirim gönderir

const https = require('https');

const PROJECT_ID = 'odeme-takip-b7c1f';
const FCM_ENDPOINT = 'fcm.googleapis.com';

// Env vars from GitHub Secrets
const FIREBASE_SERVER_KEY = process.env.FIREBASE_SERVER_KEY;
const GOOGLE_APPLICATION_CREDENTIALS_JSON = process.env.FIREBASE_SA_JSON;

function httpsRequest(options, body) {
  return new Promise(function(resolve, reject) {
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getAccessToken() {
  // Google OAuth2 token via service account
  const sa = JSON.parse(GOOGLE_APPLICATION_CREDENTIALS_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');

  const { createSign } = require('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  const signature = sign.sign(sa.private_key).toString('base64url');
  const jwt = header + '.' + payload + '.' + signature;

  const tokenRes = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}
  }, null);

  // Manual form post
  return new Promise(function(resolve, reject) {
    const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, function(res) {
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        const parsed = JSON.parse(data);
        resolve(parsed.access_token);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getFirestoreData(accessToken, collection) {
  const res = await httpsRequest({
    hostname: 'firestore.googleapis.com',
    path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}`,
    method: 'GET',
    headers: {'Authorization': 'Bearer ' + accessToken}
  });
  return res;
}

function getDayStatus(payments) {
  const now = new Date();
  now.setHours(0,0,0,0);
  const yr = now.getFullYear(), mo = now.getMonth();

  const overdue = [], today = [], soon = [];

  (payments || []).forEach(function(p) {
    let dueDate = null;
    if (p.type === 't') {
      const d = new Date(p.date + 'T00:00:00');
      if (d.getFullYear() === yr && d.getMonth() === mo) dueDate = d;
    } else {
      const inMonth = p.months === 'always' ? true :
        (Array.isArray(p.months) && p.months.includes(mo));
      if (inMonth) {
        // Check startYear
        if (p.startYear !== undefined) {
          const startTs = p.startYear * 12 + p.startMonth;
          const curTs = yr * 12 + mo;
          if (curTs < startTs) return;
        }
        dueDate = new Date(yr, mo, p.dueDay);
      }
    }
    if (!dueDate) return;

    const paidKey = yr + '-' + mo;
    const paid = !!(p.paidMonths && p.paidMonths[paidKey]);
    if (paid) return;

    const deleted = Array.isArray(p.deletedMonths) && p.deletedMonths.includes(paidKey);
    if (deleted) return;

    dueDate.setHours(0,0,0,0);
    const diff = Math.round((dueDate - now) / 86400000);
    if (diff < 0) overdue.push({name: p.name, diff});
    else if (diff === 0) today.push({name: p.name});
    else if (diff <= 3) soon.push({name: p.name, diff});
  });

  return {overdue, today, soon};
}

async function sendFCM(token, title, body, urgent) {
  const message = {
    to: token,
    notification: {title, body},
    data: {urgent: urgent ? 'true' : 'false', tag: urgent ? 'overdue' : 'reminder'},
    android: {
      priority: urgent ? 'high' : 'normal',
      notification: {sound: 'default', channel_id: urgent ? 'urgent' : 'reminders'}
    }
  };
  return httpsRequest({
    hostname: FCM_ENDPOINT,
    path: '/fcm/send',
    method: 'POST',
    headers: {
      'Authorization': 'key=' + FIREBASE_SERVER_KEY,
      'Content-Type': 'application/json'
    }
  }, message);
}

async function main() {
  console.log('Ödeme bildirimleri kontrol ediliyor...');

  try {
    const accessToken = await getAccessToken();
    console.log('Access token alındı');

    // Firestore'dan tüm kullanıcıların token + payment verilerini al
    const usersDoc = await getFirestoreData(accessToken, 'users');

    if (!usersDoc.documents || usersDoc.documents.length === 0) {
      console.log('Firestore da kayıtlı kullanıcı yok');
      return;
    }

    let totalNotifs = 0;
    for (const doc of usersDoc.documents) {
      try {
        const fields = doc.fields || {};
        const fcmToken = fields.fcmToken && fields.fcmToken.stringValue;
        const paymentsStr = fields.payments && fields.payments.stringValue;

        if (!fcmToken || !paymentsStr) continue;

        const payments = JSON.parse(paymentsStr);
        const {overdue, today, soon} = getDayStatus(payments);

        if (overdue.length > 0) {
          const names = overdue.map(x => x.name).join(', ');
          await sendFCM(
            fcmToken,
            `⚠️ ${overdue.length} Geciken Ödeme!`,
            names + ' — lütfen ödeyin!',
            true
          );
          totalNotifs++;
          console.log('Geciken bildirim gönderildi');
        }

        if (today.length > 0) {
          const names = today.map(x => x.name).join(', ');
          await sendFCM(
            fcmToken,
            `📅 Bugün Son Gün!`,
            names,
            false
          );
          totalNotifs++;
        }

        if (soon.length > 0 && overdue.length === 0 && today.length === 0) {
          const names = soon.map(x => `${x.name} (${x.diff} gün)`).join(', ');
          await sendFCM(
            fcmToken,
            `🔔 Yaklaşan Ödemeler`,
            names,
            false
          );
          totalNotifs++;
        }

      } catch(e) {
        console.error('Kullanıcı işlenirken hata:', e.message);
      }
    }

    console.log(`Toplam ${totalNotifs} bildirim gönderildi`);

  } catch(e) {
    console.error('Ana hata:', e.message);
    process.exit(1);
  }
}

main();
