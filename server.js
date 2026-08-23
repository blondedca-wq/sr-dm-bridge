// sr-dm-bridge — SecondRing DM Rescue demo bridge
// Serves: /dm/ (connect page), /dm/login, /dm/callback (OAuth),
//         /dm/webhook (Meta verify + message events), /dm/inbox (assisted-reply UI),
//         /dm/api/* (inbox data + send), /dm/health
// Storage: data.json next to this file. Demo-grade; production moves to Supabase.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');

const PORT = parseInt(process.env.PORT || '8090', 10);
const BIND_HOST = process.env.BIND_HOST || '172.18.0.1';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://auto.secondring.ca/dm';
const IG_APP_ID = process.env.IG_APP_ID || '';
const IG_APP_SECRET = process.env.IG_APP_SECRET || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'sr-dm-verify';
const GRAPH = 'https://graph.instagram.com/v23.0';

const DATA_FILE = path.join(__dirname, 'data.json');
let db = { token: null, ig_user_id: null, username: null, profile_pic: null, conversations: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
function save() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
function log(...a) { console.log('[dm]', ...a); }

// ---------- helpers ----------
function send(res, code, body, type) {
    res.writeHead(code, { 'Content-Type': type || 'text/html; charset=utf-8' });
    res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj), 'application/json'); }
async function readBody(req) {
    return new Promise((resolve) => {
          let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b));
    });
}
function hoursSince(ts) { return (Date.now() - ts) / 3600000; }

// ---------- OAuth (Instagram Business Login) ----------
function loginUrl() {
    const p = new URLSearchParams({
          client_id: IG_APP_ID,
          redirect_uri: PUBLIC_URL + '/callback',
          response_type: 'code',
          scope: 'instagram_business_basic,instagram_business_manage_messages'
    });
    return 'https://www.instagram.com/oauth/authorize?' + p.toString();
}

async function handleCallback(q, res) {
    try {
          const form = new URLSearchParams({
                  client_id: IG_APP_ID, client_secret: IG_APP_SECRET,
                  grant_type: 'authorization_code',
                  redirect_uri: PUBLIC_URL + '/callback', code: q.get('code')
          });
          let r = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form });
          let t = await r.json();
          if (!t.access_token) { log('token exchange failed', JSON.stringify(t)); return send(res, 500, page('Connect failed', '<p class="err">Token exchange failed. Check logs.</p>')); }
          // long-lived token
      r = await fetch('https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=' + IG_APP_SECRET + '&access_token=' + t.access_token);
          const ll = await r.json();
          db.token = ll.access_token || t.access_token;
          // profile
      r = await fetch(GRAPH + '/me?fields=user_id,username,profile_picture_url&access_token=' + db.token);
          const me = await r.json();
          db.ig_user_id = me.user_id || me.id; db.username = me.username; db.profile_pic = me.profile_picture_url || '';
          save();
          log('connected IG account', db.username, db.ig_user_id);
          res.writeHead(302, { Location: PUBLIC_URL + '/' }); res.end();
    } catch (e) { log('callback error', e.message); send(res, 500, page('Error', '<p class="err">' + e.message + '</p>')); }
}

// ---------- Messaging ----------
async function sendReply(igsid, text, useHumanAgent) {
    const body = { recipient: { id: igsid }, message: { text } };
    if (useHumanAgent) { body.messaging_type = 'MESSAGE_TAG'; body.tag = 'HUMAN_AGENT'; }
    const r = await fetch(GRAPH + '/' + db.ig_user_id + '/messages?access_token=' + db.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const out = await r.json();
    log('send', igsid, useHumanAgent ? 'HUMAN_AGENT' : 'standard', r.status, JSON.stringify(out));
    return { status: r.status, out };
}

function recordIncoming(igsid, text, mid) {
    const c = db.conversations[igsid] || { messages: [], last_user_msg_at: 0, name: 'IG user ' + igsid.slice(-4) };
    if (c.messages.some(m => m.mid && m.mid === mid)) return; // dedupe redeliveries
  c.messages.push({ dir: 'in', text, at: Date.now(), mid });
    c.last_user_msg_at = Date.now();
    db.conversations[igsid] = c; save();
}

// ---------- HTML ----------
function page(title, inner) {
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>' + title + '</title><style>' +
        'body{font-family:system-ui,sans-serif;background:#101418;color:#e8e6e1;margin:0;padding:24px;max-width:640px;margin:auto}' +
        'h1{font-size:22px} .card{background:#1a2026;border:1px solid #2a323a;border-radius:12px;padding:20px;margin:16px 0}' +
        '.btn{display:inline-block;background:#e8a13d;color:#101418;font-weight:600;padding:12px 20px;border-radius:8px;text-decoration:none;border:none;font-size:16px;cursor:pointer}' +
        '.muted{color:#9aa4ae;font-size:14px} .err{color:#e06c5c} img.avatar{width:56px;height:56px;border-radius:50%;vertical-align:middle;margin-right:12px}' +
        '.msg{padding:8px 12px;border-radius:10px;margin:6px 0;max-width:80%} .in{background:#2a323a} .out{background:#31465a;margin-left:auto}' +
        '.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:10px;background:#5a3131;color:#f0b9b0;margin-left:8px}' +
        '.ok{background:#2e4634;color:#bfe3c0} textarea{width:100%;background:#12171c;color:#e8e6e1;border:1px solid #2a323a;border-radius:8px;padding:10px;font-size:15px}' +
        '</style></head><body><h1>SecondRing DM Rescue</h1>' + inner + '</body></html>';
}

function connectPage() {
    if (db.username) {
          return page('Connected', '<div class="card"><p>' +
                            (db.profile_pic ? '<img class="avatar" src="' + db.profile_pic + '">' : '') +
                            'Connected as <b>@' + db.username + '</b></p>' +
                            '<p class="muted">Instagram professional account linked. Incoming DMs now flow to your inbox.</p>' +
                            '<p><a class="btn" href="' + PUBLIC_URL + '/inbox">Open inbox</a></p>' +
                            '<p class="muted"><a style="color:#9aa4ae" href="' + PUBLIC_URL + '/disconnect">Disconnect</a></p></div>');
    }
    return page('Connect Instagram', '<div class="card">' +
                    '<p>Connect your Instagram professional account so SecondRing can rescue missed DMs.</p>' +
                    '<p><a class="btn" href="' + PUBLIC_URL + '/login">Connect Instagram</a></p>' +
                    '<p class="muted">You will be asked to log in with Instagram and grant access to basic profile and messages.</p></div>');
}

function inboxPage() {
    const convs = Object.entries(db.conversations).sort((a,b) => b[1].last_user_msg_at - a[1].last_user_msg_at);
    let inner = '<p class="muted">Signed in as @' + (db.username || '?') + ' — assisted replies. Nothing sends without you pressing Send.</p>';
    if (!convs.length) inner += '<div class="card"><p class="muted">No conversations yet. DM the connected account to see it appear here.</p></div>';
    for (const [igsid, c] of convs) {
          const open = hoursSince(c.last_user_msg_at) < 24;
          inner += '<div class="card"><p><b>' + c.name + '</b>' +
                  (open ? '<span class="badge ok">24h window open</span>' : '<span class="badge">window closed — Human Agent tag</span>') + '</p>';
          for (const m of c.messages.slice(-8)) {
                  inner += '<div class="msg ' + (m.dir === 'in' ? 'in' : 'out') + '">' + m.text.replace(/</g, '&lt;') +
                            (m.tag ? ' <span class="badge">HUMAN_AGENT</span>' : '') + '</div>';
          }
          inner += '<form method="POST" action="' + PUBLIC_URL + '/api/reply"><input type="hidden" name="igsid" value="' + igsid + '">' +
                  '<textarea name="text" rows="2" placeholder="Type a reply..."></textarea>' +
                  '<p><button class="btn" type="submit">' + (open ? 'Send reply' : 'Send late reply (Human Agent)') + '</button></p></form></div>';
    }
    inner += '<p class="muted"><a style="color:#9aa4ae" href="' + PUBLIC_URL + '/">Back</a></p>';
    return page('Inbox', inner);
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.replace(/^\/dm/, '') || '/';

                                   if (p === '/health') return json(res, 200, { ok: true, connected: !!db.username, conversations: Object.keys(db.conversations).length });

                                   if (p === '/' && req.method === 'GET') return send(res, 200, connectPage());
    if (p === '/login') { res.writeHead(302, { Location: loginUrl() }); return res.end(); }
    if (p === '/callback') return handleCallback(u.searchParams, res);
    if (p === '/disconnect') { db = { token: null, ig_user_id: null, username: null, profile_pic: null, conversations: db.conversations }; save(); res.writeHead(302, { Location: PUBLIC_URL + '/' }); return res.end(); }
    if (p === '/inbox') return send(res, 200, inboxPage());

                                   if (p === '/webhook' && req.method === 'GET') {
                                         if (u.searchParams.get('hub.mode') === 'subscribe' && u.searchParams.get('hub.verify_token') === VERIFY_TOKEN) {
                                                 log('webhook verified');
                                                 return send(res, 200, u.searchParams.get('hub.challenge'), 'text/plain');
                                         }
                                         return send(res, 403, 'forbidden', 'text/plain');
                                   }

                                   if (p === '/webhook' && req.method === 'POST') {
                                         const body = await readBody(req);
                                         json(res, 200, { received: true });
                                         try {
                                                 const ev = JSON.parse(body);
                                                 for (const entry of ev.entry || []) {
                                                           for (const m of entry.messaging || []) {
                                                                       if (m.message && !m.message.is_echo && m.sender && m.sender.id !== db.ig_user_id) {
                                                                                     log('incoming DM from', m.sender.id, ':', (m.message.text || '[non-text]'));
                                                                                     recordIncoming(m.sender.id, m.message.text || '[attachment]', m.message.mid);
                                                                       }
                                                           }
                                                 }
                                         } catch (e) { log('webhook parse error', e.message); }
                                         return;
                                   }

                                   if (p === '/api/reply' && req.method === 'POST') {
                                         const body = await readBody(req);
                                         const f = new URLSearchParams(body);
                                         const igsid = f.get('igsid'), text = (f.get('text') || '').trim();
                                         if (!igsid || !text) { res.writeHead(302, { Location: PUBLIC_URL + '/inbox' }); return res.end(); }
                                         const c = db.conversations[igsid];
                                         const late = !c || hoursSince(c.last_user_msg_at) >= 24;
                                         const result = await sendReply(igsid, text, late);
                                         if (result.status === 200) {
                                                 c.messages.push({ dir: 'out', text, at: Date.now(), tag: late ? 'HUMAN_AGENT' : null });
                                                 save();
                                         }
                                         res.writeHead(302, { Location: PUBLIC_URL + '/inbox' }); return res.end();
                                   }

                                   send(res, 404, 'not found', 'text/plain');
});

server.listen(PORT, BIND_HOST, () => log('sr-dm-bridge listening on ' + BIND_HOST + ':' + PORT + ' (public ' + PUBLIC_URL + ')'));
