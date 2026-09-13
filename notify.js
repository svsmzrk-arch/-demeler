const https = require('https');
const crypto = require('crypto');

const PROJECT_ID = 'odeme-takip-b7c1f';
const FIREBASE_SA_JSON = process.env.FIREBASE_SA_JSON;

if (!FIREBASE_SA_JSON) {
  console.error('FIREBASE_SA_JSON eksik');
  process.exit(1);
}

const sa = JSON.parse(FIREBASE_SA_JSON);

function createJWT() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  return header + '.' + payload + '.' + sign.sign(sa.private_key).toString('base64url');
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({status: res.statusCode, body: JSON.parse(data)}); }
        catch(e) { resolve({status: res.statusCode, body: data}); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getAccessToken() {
  const jwt = createJWT();
  const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;
  const res = await request({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  if (!res.body.access_token) throw new Error('Token alınamadı: ' + JSON.stringify(res.body));
  return res.body.access_token;
}

async function getUsers(token) {
  const res = await request({
    hostname: 'firestore.googleapis.com',
    path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/users`,
    method: 'GET',
    headers: {'Authorization': 'Bearer ' + token}
  });
  return res.body.documents || [];
}

function checkPayments(payments) {
  const now = new Date(); now.setHours(0,0,0,0);
  const yr = now.getFullYear(), mo = now.getMonth();
  const overdue = [], today = [], soon = [];

  (payments || []).forEach(p => {
    let dueDate = null;
    if (p.type === 't') {
      const d = new Date(p.date + 'T00:00:00');
      if (d.getFullYear() === yr && d.getMonth() === mo) dueDate = d;
    } else {
      const inMonth = p.months === 'always' || (Array.isArray(p.months) && p.months.includes(mo));
      if (inMonth) {
        if (p.startYear !== undefined && yr * 12 + mo < p.startYear * 12 + p.startMonth) return;
        dueDate = new Date(yr, mo, p.dueDay);
      }
    }
    if (!dueDate) return;
    const pkey = yr + '-' + mo;
    if (p.paidMonths && p.paidMonths[pkey]) return;
    if (Array.isArray(p.deletedMonths) && p.deletedMonths.includes(pkey)) return;
    dueDate.setHours(0,0,0,0);
    const diff = Math.round((dueDate - now) / 86400000);
    if (diff < 0) overdue.push({name: p.name, diff});
    else if (diff === 0) today.push({name: p.name});
    else if (diff <= 3) soon.push({name: p.name, diff});
  });
  return {overdue, today, soon};
}

async function sendFCM(accessToken, fcmToken, title, body, urgent) {
  // FCM V1 API
  const message = {
    message: {
      token: fcmToken,
      notification: {title, body},
      android: {
        priority: urgent ? 'high' : 'normal',
        notification: {sound: 'default'}
      }
    }
  };

  const res = await request({
    hostname: 'fcm.googleapis.com',
    path: `/v1/projects/${PROJECT_ID}/messages:send`,
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    }
  }, message);

  if (res.status !== 200) {
    console.log('FCM V1 hatası:', JSON.stringify(res.body).slice(0, 200));

    // Eski token formatı ise Legacy API dene
    if (res.body.error && res.body.error.status === 'INVALID_ARGUMENT') {
      console.log('Legacy token formatı, Legacy API deneniyor...');
      return await sendFCMLegacy(fcmToken, title, body, urgent);
    }
    return false;
  }
  console.log('FCM V1 başarılı');
  return true;
}

async function sendFCMLegacy(fcmToken, title, body, urgent) {
  // Legacy FCM API — eski token formatı için
  const message = {
    to: fcmToken,
    notification: {title, body, sound: 'default'},
    priority: urgent ? 'high' : 'normal',
    data: {urgent: urgent ? 'true' : 'false'}
  };

  // Legacy API için server key lazım — SA JSON'dan dinamik olarak alalım
  // Önce service account ile OAuth token alıp legacy API'ye göndereceğiz
  const res = await request({
    hostname: 'fcm.googleapis.com',
    path: '/fcm/send',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + await getAccessToken()
    }
  }, message);

  if (res.status === 200 && !res.body.error) {
    console.log('Legacy FCM başarılı');
    return true;
  }
  console.log('Legacy FCM hatası:', JSON.stringify(res.body).slice(0, 200));
  return false;
}

async function main() {
  console.log('Bildirimler kontrol ediliyor:', new Date().toLocaleString('tr-TR'));
  const token = await getAccessToken();
  console.log('Access token alındı');

  const users = await getUsers(token);
  console.log(users.length + ' kullanıcı bulundu');

  let sent = 0;
  for (const doc of users) {
    const f = doc.fields || {};
    const fcmToken = f.fcmToken && f.fcmToken.stringValue;
    const paymentsStr = f.payments && f.payments.stringValue;
    if (!fcmToken || !paymentsStr) continue;

    let payments;
    try { payments = JSON.parse(paymentsStr); } catch(e) { continue; }

    const {overdue, today, soon} = checkPayments(payments);
    console.log('Geciken:', overdue.length, 'Bugün:', today.length, 'Yakın:', soon.length);

    if (overdue.length > 0) {
      const ok = await sendFCM(token, fcmToken, '⚠️ ' + overdue.length + ' Geciken Ödeme!', overdue.map(x=>x.name).join(', ') + ' — lütfen ödeyin!', true);
      if (ok) sent++;
    }
    if (today.length > 0) {
      const ok = await sendFCM(token, fcmToken, '📅 Bugün Son Gün!', today.map(x=>x.name).join(', '), false);
      if (ok) sent++;
    }
    if (soon.length > 0 && overdue.length === 0 && today.length === 0) {
      const ok = await sendFCM(token, fcmToken, '🔔 Yaklaşan Ödemeler', soon.map(x=>x.name+' ('+x.diff+' gün)').join(', '), false);
      if (ok) sent++;
    }
  }
  console.log('Toplam ' + sent + ' bildirim gönderildi');
}

main().catch(e => { console.error('Hata:', e.message); process.exit(1); });
