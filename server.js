// sr-dm-bridge — SecondRing DM Rescue (Day 10: the real machine)
// Serves: /dm/ (connect page), /dm/login, /dm/callback (OAuth),
//         /dm/webhook (Meta verify + message events), /dm/inbox (assisted-reply UI),
//         /dm/api/* (inbox data + send), /dm/health
// Day 10: every inbound DM now runs the Lead Rescue pipeline against Supabase:
//   classify + qualify (Claude Haiku, confidence reported) -> graded HOT/WARM/COLD lead,
//   FAQ answers drawn from the same kv/profile the voice bridge reads,
//   price guardrail (never states a price unless can_quote_prices),
//   owner alerts through sr_gate, STOP honoured into contacts.opted_out_at.
// Mode contract (the notch), mirroring the voice bridge exactly:
//   observe  - record + grade only. Every action that WOULD have happened is
//              logged as a dm_action_held event. No leads/contacts writes, no sends.
//   approval - contact + lead recorded; the drafted reply files an approval row;
//              owner alert follows the voice actions.js approval-alert pattern.
//   autonomous - everything: contact, lead, auto-reply DM, owner alert.
// Day 13.2: approved dm_reply rows are drained by this process (see drainDecisions):
//   the console only flips approvals.status; the reply still passes sr_gate with the
//   bare approvals.id before it goes out. Rejected rows are recorded, never sent.
// Ships OBSERVE-ONLY until Meta approval lands (WAITING gate). data.json still
// backs the inbox UI; Supabase is the system of record for the machine.

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
const INBOX_KEY = process.env.INBOX_KEY || '';
const GRAPH = 'https://graph.instagram.com/v23.0';

// ---- Day 10: platform wiring ----
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TENANT_ID = process.env.TENANT_ID || '00000000-0000-0000-0000-000000000000';
const MACHINE_ID = process.env.MACHINE_ID || '1dbeb8bc-8fce-46f4-806b-68261f79d90c'; // dm_rescue
const MACHINE_KEY = process.env.MACHINE_KEY || 'dm_rescue';
const VOICE_MACHINE_ID = process.env.VOICE_MACHINE_ID || '5ca85e98-0434-4c9c-a67e-102a9ee41194'; // shared FAQ kv
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const TW_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TW_FROM = process.env.TWILIO_FROM || '';

const DATA_FILE = path.join(__dirname, 'data.json');
let db = { token: null, ig_user_id: null, username: null, profile_pic: null, conversations: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
function save() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
function log(...a) { console.log('[dm]', ...a); }

// ---------- Supabase (pattern copied from sr-voice-bridge/supabase.js) ----------
const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json'
};

async function sbGet(p) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + p, { headers: SB_HEADERS });
  if (!res.ok) throw new Error('GET ' + p.split('?')[0] + ' -> ' + res.status);
  return res.json();
}

async function sbRpcSafe(fn, args) {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST', headers: SB_HEADERS, body: JSON.stringify(args)
    });
    if (!res.ok) throw new Error('RPC ' + fn + ' -> ' + res.status);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } catch (e) { console.error('[supabase] rpc ' + fn + ' failed: ' + e.message); return null; }
}

async function tryInsert(table, row) {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
      method: 'POST', headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify(row)
    });
    if (!res.ok) console.error('[supabase] insert ' + table + ' -> ' + res.status + ': ' + (await res.text()).slice(0, 300));
    return res.ok;
  } catch (e) { console.error('[supabase] insert ' + table + ' error: ' + e.message); return false; }
}

function logEvent(subjectId, type, summary, payload) {
  if (!SUPABASE_URL) return false;
  return tryInsert('events', {
    tenant_id: TENANT_ID, machine_id: MACHINE_ID,
    event_type: type, subject_type: 'dm', subject_id: subjectId,
    summary: summary, payload: payload || {}, autonomous: true, ai_model: MODEL
  });
}

let cfgCache = { at: 0, cfg: null };
const CACHE_MS = 60000;

// { enabled, mode, kv, faq, profile } — kv is the dm machine's own settings,
// faq is the voice machine's kv (hours_text/services/emergency_policy/...),
// the same source the receptionist answers from. One truth, two channels.
async function loadConfig() {
  if (cfgCache.cfg && Date.now() - cfgCache.at < CACHE_MS) return cfgCache.cfg;
  const [tm, kvRows, faqRows, profile] = await Promise.all([
    sbGet('tenant_machines?tenant_id=eq.' + TENANT_ID + '&machine_id=eq.' + MACHINE_ID + '&select=enabled,mode&limit=1'),
    sbGet('machine_configs?tenant_id=eq.' + TENANT_ID + '&machine_id=eq.' + MACHINE_ID + '&select=key,value'),
    sbGet('machine_configs?tenant_id=eq.' + TENANT_ID + '&machine_id=eq.' + VOICE_MACHINE_ID + '&select=key,value'),
    sbRpcSafe('sr_tenant_profile', { p_tenant: TENANT_ID })
  ]);
  const kv = {}; for (const r of kvRows) kv[r.key] = r.value;
  const faq = {}; for (const r of faqRows) faq[r.key] = r.value;
  const cfg = {
    enabled: tm.length ? tm[0].enabled !== false : false,
    mode: tm.length ? tm[0].mode : 'paused',
    kv, faq, profile: profile || {}
  };
  cfgCache = { at: Date.now(), cfg };
  return cfg;
}

function gate(action, phone, messageText, subjectId) {
  return sbRpcSafe('sr_gate', {
    p_tenant: TENANT_ID, p_machine_key: MACHINE_KEY, p_action: action,
    p_phone: phone || null, p_value_cents: null,
    p_subject_type: 'dm', p_subject_id: subjectId || null,
    p_message_text: messageText || null
  });
}

function upsertContact(phone, name, notes) {
  return sbRpcSafe('sr_upsert_contact', {
    p_tenant: TENANT_ID, p_phone: phone, p_name: name || null,
    p_source: 'dm_rescue', p_notes: notes || null, p_touch: true
  });
}

// Day 13.1 - unified inbox: every DM sender is linked into the address book by
// their Instagram handle (channel=instagram, external_id=IGSID). A phone learned
// mid-conversation rides along as a hint so the resolver attaches it to the SAME
// contact (adds a phone identity too): one person, one row across Instagram + phone,
// so a later STOP on that number reaches this thread as well.
function resolveContact(channel, externalId, name, hintPhone) {
  return sbRpcSafe('sr_resolve_contact', {
    p_tenant: TENANT_ID, p_channel: channel, p_external_id: externalId,
    p_name: name || null, p_hint_phone: hintPhone || null, p_hint_email: null
  });
}

function requestApproval(actionType, summary, payload, subjectId) {
  return sbRpcSafe('sr_request_approval', {
    p_tenant: TENANT_ID, p_machine_key: MACHINE_KEY, p_action_type: actionType,
    p_summary: summary, p_payload: payload || {},
    p_subject_type: 'dm', p_subject_id: subjectId || null
  });
}

// ---------- Twilio (owner alert SMS, same env names as the voice bridge) ----------
async function sendSms(to, body) {
  if (!TW_SID || !TW_TOKEN || !TW_FROM) { log('sms skipped: twilio env missing'); return false; }
  try {
    const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + TW_SID + '/Messages.json', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(TW_SID + ':' + TW_TOKEN).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: to, From: TW_FROM, Body: body }).toString()
    });
    if (!res.ok) console.error('[twilio] send -> ' + res.status + ': ' + (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) { console.error('[twilio] send error: ' + e.message); return false; }
}

function ownerPhone(cfg) {
  const p = (cfg && cfg.profile) || {};
  const faq = (cfg && cfg.faq) || {};
  return p.owner_phone || p.owner_number || faq.escalation_number || process.env.OWNER_PHONE || null;
}

// Owner alert through the gate, mirroring sr-voice-bridge actions.js exactly
// (including the Day 9 Ask-me approval-alert pattern already established there).
async function gatedOwnerSms(subjectId, to, body, action) {
  if (!to) { logEvent(subjectId, 'dm_alert_skipped', 'No owner number configured'); return false; }
  const g = await gate(action || 'owner_alert', to, body, subjectId);
  const allowed = g && g.allowed === true;
  const reason = (g && g.reason) ? String(g.reason) : (g ? 'unknown' : 'gate_unreachable');
  if (allowed) {
    const ok = await sendSms(to, body);
    logEvent(subjectId, 'dm_owner_alerted', 'Owner texted: ' + body.slice(0, 80),
      { action: action || 'owner_alert', gate: g, sent: ok });
    return ok;
  }
  const optedOut = /opt/i.test(reason);
  if (/approval/i.test(reason) && !optedOut) {
    // Ask-me: the refused alert IS the approval notification (voice Day 9 pattern).
    const ok = await sendSms(to, body);
    logEvent(subjectId, 'dm_approval_alert_sent',
      'Ask-me: approval request texted to the owner (' + reason + ')',
      { action: action || 'owner_alert', gate: g, sent: ok });
    return ok;
  }
  logEvent(subjectId, 'dm_send_blocked', 'Owner alert held back by gate: ' + reason,
    { action: action || 'owner_alert', gate: g });
  return false;
}

// ---------- Day 10: classification + qualification ----------
const STOP_RX = /^\s*(stop|arret|arrêt|unsubscribe|end|quit|cancel)\s*[.!]*\s*$/i;

function convoText(c, cap) {
  return (c.messages || []).slice(-12)
    .map(m => (m.dir === 'in' ? 'Customer: ' : 'Business: ') + m.text)
    .join('\n').slice(0, cap || 8000);
}

async function classifyDm(cfg, convo) {
  const kv = cfg.kv || {}, faq = cfg.faq || {}, p = cfg.profile || {};
  const canQuote = kv.can_quote_prices === true || kv.can_quote_prices === 'true';
  const sys = [
    'You are the DM assistant for a trade business, qualifying Instagram/Facebook messages',
    'exactly the way its phone receptionist qualifies calls.',
    'Reply with ONLY a JSON object, no prose, with exactly these keys:',
    '{"sender_name": string|null, "phone": string|null, "service": string|null,',
    ' "address": string|null, "time_window": string|null, "message": string|null,',
    ' "wants_booking": boolean, "is_emergency": boolean, "asked_price": boolean,',
    ' "grade": "HOT"|"WARM"|"COLD"|"SPAM", "grade_reason": string,',
    ' "reply": string, "needs_human": boolean, "confidence": number}',
    '',
    'Business facts (answer ONLY from these — never invent):',
    p.business_name ? 'Business: ' + p.business_name : '',
    faq.hours_text ? 'Hours: ' + faq.hours_text : '',
    faq.services ? 'Services: ' + faq.services : '',
    faq.emergency_policy ? 'Emergency policy: ' + faq.emergency_policy : '',
    canQuote && faq.call_out_fee_text ? 'Pricing line you MAY use: ' + faq.call_out_fee_text : '',
    '',
    'Grading (Lead Rescue spec): HOT = emergency, ready to book, strong buying intent.',
    'WARM = interested, gathering information. COLD = low intent, general inquiry.',
    'SPAM = promotion, bot, or irrelevant.',
    kv.grading_notes ? 'Business-specific grading notes: ' + kv.grading_notes : '',
    '',
    '"reply" is the next message to the customer: short, natural, plain trade English,',
    'no emoji. Answer their question from the business facts above if it is a common',
    'question (hours, services, emergency policy). If they want booking or a quote,',
    'collect what is missing (name, phone, address, timing) one ask at a time.',
    canQuote ? '' : 'PRICE RULE: you must NEVER state a price, rate, or fee. If asked, say the owner will confirm pricing and move to collecting details.',
    '"needs_human" true if the customer asks for a person or the conversation is beyond you.',
    '"confidence" 0-1: how certain the facts and grade are. Short or ambiguous = low.',
    'Use null for anything not actually in the conversation. Never invent.'
  ].filter(Boolean).join('\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, system: sys, messages: [{ role: 'user', content: convo }] })
  });
  if (!res.ok) throw new Error('classify ' + res.status);
  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('classify: no JSON in reply');
  return JSON.parse(m[0]);
}

// Post-filter: belt and braces on the price rule.
function priceScrub(cfg, reply) {
  const kv = cfg.kv || {};
  const canQuote = kv.can_quote_prices === true || kv.can_quote_prices === 'true';
  if (canQuote || !reply) return reply;
  if (/\$\s*\d|\d+\s*(dollars|bucks)/i.test(reply)) {
    return 'The owner will confirm exact pricing with you directly — can I grab your name and the best number to reach you?';
  }
  return reply;
}

function asText(v, cap) { return v == null ? null : String(v).slice(0, cap || 300); }

function alertGrades(cfg) {
  const kv = (cfg && cfg.kv) || {};
  const raw = typeof kv.alert_grades === 'string' && kv.alert_grades ? kv.alert_grades : 'hot';
  return raw === 'hot_warm' ? ['hot', 'warm'] : raw === 'all' ? ['hot', 'warm', 'cold'] : raw.toLowerCase().split(',').map(s => s.trim());
}

// The pipeline. Runs once per inbound DM, after recordIncoming.
async function processDm(igsid, text, mid) {
  if (!SUPABASE_URL) return; // platform not wired — inbox-only demo mode
  let cfg;
  try { cfg = await loadConfig(); }
  catch (e) { console.error('[dm] config load failed: ' + e.message); return; }
  const subjectId = 'ig:' + igsid;
  const c = db.conversations[igsid] || { messages: [{ dir: 'in', text, at: Date.now(), mid }] };

  if (!cfg.enabled || cfg.mode === 'paused') return; // off is off — record in inbox only

  // STOP in a DM: honoured in every mode, silences auto-replies for this thread
  // and (when a phone is on file from earlier turns) writes the platform opt-out.
  if (STOP_RX.test(text || '')) {
    c.do_not_contact = true; db.conversations[igsid] = c; save();
    logEvent(subjectId, 'dm_opt_out', 'Customer sent STOP in DM — thread muted' +
      (c.phone ? ', contact opt-out written' : ''), { igsid, mid });
    if (c.phone) {
      await sbRpcSafe('sr_handle_inbound_keyword', { p_tenant: TENANT_ID, p_phone: c.phone, p_body: 'STOP' });
    }
    return;
  }
  if (c.do_not_contact) {
    logEvent(subjectId, 'dm_action_held', 'Thread is do-not-contact — no reply, no lead', { held: true, igsid });
    return;
  }

  logEvent(subjectId, 'dm_message_received', 'DM in: ' + (text || '[attachment]').slice(0, 120), { igsid, mid });

  let ex;
  try { ex = await classifyDm(cfg, convoText(c)); }
  catch (e) {
    console.error('[dm] classify failed: ' + e.message);
    logEvent(subjectId, 'dm_classify_failed', 'Classification failed: ' + e.message, { igsid, mid });
    return;
  }

  const grade = ['HOT', 'WARM', 'COLD', 'SPAM'].includes(ex.grade) ? ex.grade : 'COLD';
  const conf = typeof ex.confidence === 'number' && isFinite(ex.confidence)
    ? Math.max(0, Math.min(1, ex.confidence)) : null;
  const reply = priceScrub(cfg, asText(ex.reply, 900));
  if (ex.phone) { c.phone = asText(ex.phone, 25); db.conversations[igsid] = c; save(); }
  if (ex.sender_name && (!c.name || /^IG user/.test(c.name))) { c.name = asText(ex.sender_name, 80); save(); }

  // Grading is recording — it happens in every live mode (mirrors voice_graded).
  logEvent(subjectId, 'dm_graded', 'DM graded ' + grade + ': ' + (ex.grade_reason || ''), {
    grade, reason: ex.grade_reason, ai_confidence: conf, emergency: ex.is_emergency === true,
    asked_price: ex.asked_price === true, needs_human: ex.needs_human === true,
    conversation: convoText(c, 4000), draft_reply: reply, igsid, mid
  });

  // Spam is recorded and goes no further — no lead, no reply, no alert. Any mode.
  if (grade === 'SPAM') return;

  const wantsAlert = alertGrades(cfg).includes(grade.toLowerCase()) || ex.is_emergency === true;
  const autoReplyOn = cfg.kv.auto_reply !== false && cfg.kv.auto_reply !== 'false';
  const answerFaqs = cfg.kv.answer_faqs !== false && cfg.kv.answer_faqs !== 'false';
  const maxReplies = parseInt(cfg.kv.max_replies_per_conversation, 10) || 6;
  const sentCount = (c.messages || []).filter(m => m.dir === 'out' && m.auto).length;

  // ---- observe: the WAITING machine. Log what would happen, do none of it. ----
  if (cfg.mode === 'observe') {
    const held = [];
    held.push('link ' + (ex.sender_name || 'this IG sender') + (ex.phone ? ' (' + ex.phone + ')' : '') + ' into the address book by their Instagram handle');
    held.push('file a ' + grade + ' lead into Lead Saver');
    if (autoReplyOn && answerFaqs && reply && !ex.needs_human) held.push('reply in the DM: "' + reply.slice(0, 100) + '"');
    if (ex.needs_human) held.push('hand the thread to a human');
    if (wantsAlert) held.push('text the owner about this ' + grade + ' DM lead');
    for (const h of held) {
      logEvent(subjectId, 'dm_action_held', 'WATCH: would ' + h, { held: true, grade, ai_confidence: conf, igsid });
    }
    return;
  }

  // ---- live modes: actions are real from here down ----

  // Contact: EVERY DM sender joins the address book, resolved by their Instagram
  // handle via the unified-inbox front door (Day 13.1) - not only when a phone is
  // known. A phone pulled from the chat rides as a hint so it enriches and
  // cross-links the same contact instead of creating a second row.
  let contactId = await resolveContact('instagram', igsid, asText(ex.sender_name, 120), c.phone || null);
  if (contactId && typeof contactId === 'string') {
    if (c.contact_id !== contactId) { c.contact_id = contactId; db.conversations[igsid] = c; save(); }
    logEvent(subjectId, 'dm_contact_saved',
      'Customer linked: ' + (ex.sender_name || 'IG user ' + igsid.slice(-4)) + (c.phone ? ' (' + c.phone + ')' : ' (IG only)'),
      { contact_id: contactId, channel: 'instagram', igsid, phone: c.phone || null });
  } else {
    contactId = null;
    logEvent(subjectId, 'dm_contact_resolve_failed', 'sr_resolve_contact returned no id', { igsid });
  }

  // Lead Saver: every non-spam DM enquiry lands graded.
  await tryInsert('leads', {
    tenant_id: TENANT_ID, machine_id: MACHINE_ID, contact_id: contactId,
    caller_number: c.phone || null, call_sid: subjectId,
    status: grade.toLowerCase(),
    ai_job_type: asText(ex.service, 120),
    ai_urgency: ex.is_emergency ? 'emergency' : grade.toLowerCase(),
    ai_summary: asText(ex.grade_reason, 300),
    message: asText(ex.message || text, 500)
  });
  logEvent(subjectId, 'dm_lead_saved', grade + ' lead filed for ' + (ex.sender_name || 'IG user ' + igsid.slice(-4)),
    { grade, ai_confidence: conf, contact_id: contactId, igsid });

  // The reply itself.
  const shouldReply = autoReplyOn && answerFaqs && reply && !ex.needs_human && sentCount < maxReplies;
  if (shouldReply) {
    if (cfg.mode === 'approval_required') {
      const ap = await requestApproval('dm_reply',
        'DM reply to ' + (ex.sender_name || 'IG user ' + igsid.slice(-4)) + ': ' + reply.slice(0, 140),
        { igsid, reply, grade, ai_confidence: conf }, subjectId);
      logEvent(subjectId, 'dm_reply_pending_approval', 'Reply waiting for your OK: ' + reply.slice(0, 100), { approval: ap, igsid });
    } else {
      const g = await gate('dm_reply', c.phone || null, reply, subjectId);
      if (g && g.allowed === true) {
        const r = await sendReply(igsid, reply, false);
        if (r.status === 200) {
          c.messages.push({ dir: 'out', text: reply, at: Date.now(), auto: true });
          db.conversations[igsid] = c; save();
        }
        logEvent(subjectId, 'dm_reply_sent', 'Auto-replied: ' + reply.slice(0, 100), { gate: g, status: r.status, igsid });
      } else {
        logEvent(subjectId, 'dm_send_blocked', 'DM reply held back by gate: ' + ((g && g.reason) || 'gate_unreachable'), { gate: g, igsid });
      }
    }
  }
  if (ex.needs_human) {
    logEvent(subjectId, 'dm_handoff', 'Customer asked for a human — thread left for the inbox', { igsid });
  }

  // Owner alert for qualified prospects.
  if (wantsAlert) {
    const bits = [];
    bits.push((ex.is_emergency ? 'EMERGENCY DM - ' : grade + ' DM lead - ') + (ex.sender_name || 'IG user ' + igsid.slice(-4)));
    if (ex.service) bits.push(ex.service);
    if (c.phone) bits.push(c.phone);
    if (ex.time_window) bits.push('wants ' + ex.time_window);
    if (ex.message) bits.push('Msg: ' + asText(ex.message, 120));
    bits.push('Inbox: ' + PUBLIC_URL + '/inbox');
    await gatedOwnerSms(subjectId, ownerPhone(cfg), bits.join(' | ').slice(0, 480), 'owner_alert');
  }
}

// ---------- Day 13.2: act on the owner's decisions (approved / rejected dm_reply rows) ----------
// Mirrors sr-upsell PASS 2. The console only flips approvals.status; this loop is the only
// path from an approved reply to the customer, and it still passes sr_gate - with the BARE
// approvals.id as the subject, which is what the __approved_send_guard__ matches.
// A held row (quiet hours, daily cap, gate unreachable, Graph error) is retried after
// DRAIN_RETRY_MS, up to DRAIN_MAX_ATTEMPTS; a final refusal (opted out, taken over, paused)
// is settled by its dm_send_blocked event and never retried. Watch mode drains nothing.
const DRAIN_EVERY_MS = 60000;
const DRAIN_RETRY_MS = 15 * 60000;
const DRAIN_MAX_ATTEMPTS = 3;
const heldUntil = new Map();
const attempts = new Map();
let draining = false;

async function drainDecisions() {
  if (!SUPABASE_URL || draining) return;
  draining = true;
  try {
    const cfg = await loadConfig();
    if (!cfg.enabled || cfg.mode === 'paused' || cfg.mode === 'observe') return;
    const decisions = await sbGet('approvals?tenant_id=eq.' + TENANT_ID + '&machine_id=eq.' + MACHINE_ID +
      '&action_type=eq.dm_reply&status=in.(approved,rejected)' +
      '&select=id,status,subject_id,proposed_payload,edited_payload,decision_note&order=created_at.asc&limit=100');
    if (!decisions.length) return;
    const settled = new Set(
      (await sbGet('events?tenant_id=eq.' + TENANT_ID + '&machine_id=eq.' + MACHINE_ID +
        '&event_type=in.(dm_reply_sent,dm_reply_rejected,dm_send_blocked)&payload->>approval_id=not.is.null' +
        '&select=payload&limit=2000'))
        .filter(e => e.payload && e.payload.approval_id && e.payload.final !== false)
        .map(e => e.payload.approval_id));
    for (const a of decisions) {
      if (settled.has(a.id)) continue;
      if ((heldUntil.get(a.id) || 0) > Date.now()) continue;
      const pl = a.proposed_payload || {};
      const igsid = pl.igsid || String(a.subject_id || '').replace(/^ig:/, '');
      const subjectId = 'ig:' + igsid;
      if (a.status === 'rejected') {
        logEvent(subjectId, 'dm_reply_rejected',
          'You turned down the reply' + (a.decision_note ? ': ' + asText(a.decision_note, 120) : ''),
          { approval_id: a.id, igsid, final: true });
        continue;
      }
      const edited = !!(a.edited_payload && a.edited_payload.reply);
      const text = edited ? String(a.edited_payload.reply) : String(pl.reply || '');
      if (!igsid || !text) {
        logEvent(subjectId, 'dm_send_blocked', 'Approved reply is missing the sender id or the text', { approval_id: a.id, final: true });
        continue;
      }
      const c = db.conversations[igsid] || { messages: [], last_user_msg_at: 0, name: 'IG user ' + igsid.slice(-4) };
      const g = await gate('dm_reply', c.phone || null, text, a.id);
      if (g && g.allowed === true) {
        const n = (attempts.get(a.id) || 0) + 1; attempts.set(a.id, n);
        const late = hoursSince(c.last_user_msg_at) >= 24;
        const r = await sendReply(igsid, text, late);
        const ok = r.status === 200;
        if (ok) {
          c.messages.push({ dir: 'out', text, at: Date.now(), auto: true, approval_id: a.id, tag: late ? 'HUMAN_AGENT' : null });
          db.conversations[igsid] = c; save();
        } else if (n < DRAIN_MAX_ATTEMPTS) { heldUntil.set(a.id, Date.now() + DRAIN_RETRY_MS); }
        logEvent(subjectId, ok ? 'dm_reply_sent' : 'dm_send_blocked',
          (ok ? 'Sent after your OK' + (edited ? ' (edited)' : '') + ': ' + text.slice(0, 100)
              : 'Approved reply failed at Instagram (HTTP ' + r.status + '), attempt ' + n + '/' + DRAIN_MAX_ATTEMPTS),
          { approval_id: a.id, igsid, edited, gate: g, status: r.status, human_agent: late, final: ok || n >= DRAIN_MAX_ATTEMPTS });
      } else {
        const reason = (g && g.reason) ? String(g.reason) : 'gate_unreachable';
        const final = !/quiet|cap|unreachable/i.test(reason);
        if (!final) heldUntil.set(a.id, Date.now() + DRAIN_RETRY_MS);
        logEvent(subjectId, 'dm_send_blocked', 'Approved reply held by gate: ' + reason + (final ? '' : ' - will retry'),
          { approval_id: a.id, igsid, gate: g, final });
      }
    }
  } catch (e) { console.error('[dm] drain error: ' + e.message); }
  finally { draining = false; }
}

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

// ---------- access key (reviewer/inbox auth) ----------
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function inboxAuthed(u, req) {
  if (!INBOX_KEY) return true; // no key configured — open (dev only)
  return u.searchParams.get('key') === INBOX_KEY || getCookie(req, 'sr_key') === INBOX_KEY;
}
function keyPage() {
  return page('Access key required', '<div class="card"><p class="err">This inbox requires an access key.</p>' +
    '<p class="muted">Open the inbox using the link with <b>?key=...</b> exactly as provided in the reviewer instructions.</p></div>');
}

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
    r = await fetch('https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=' + IG_APP_SECRET + '&access_token=' + t.access_token);
    const ll = await r.json();
    db.token = ll.access_token || t.access_token;
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
  if (c.messages.some(m => m.mid && m.mid === mid)) return false; // dedupe redeliveries
  c.messages.push({ dir: 'in', text, at: Date.now(), mid });
  c.last_user_msg_at = Date.now();
  db.conversations[igsid] = c; save();
  return true;
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
  const convs = Object.entries(db.conversations).sort((a, b) => b[1].last_user_msg_at - a[1].last_user_msg_at);
  let inner = '<p class="muted">Signed in as @' + (db.username || '?') + ' — assisted replies. Nothing sends without you pressing Send.</p>';
  if (!convs.length) inner += '<div class="card"><p class="muted">No conversations yet. DM the connected account to see it appear here.</p></div>';
  for (const [igsid, c] of convs) {
    const open = hoursSince(c.last_user_msg_at) < 24;
    inner += '<div class="card"><p><b>' + c.name + '</b>' +
      (c.do_not_contact ? '<span class="badge">do not contact</span>' : '') +
      (open ? '<span class="badge ok">24h window open</span>' : '<span class="badge">window closed — Human Agent tag</span>') + '</p>';
    for (const m of c.messages.slice(-8)) {
      inner += '<div class="msg ' + (m.dir === 'in' ? 'in' : 'out') + '">' + m.text.replace(/</g, '&lt;') +
        (m.tag ? ' <span class="badge">HUMAN_AGENT</span>' : '') + (m.auto ? ' <span class="badge ok">auto</span>' : '') + '</div>';
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

  if (p === '/health') {
    let mode = null, enabled = null;
    try { const cfg = await loadConfig(); mode = cfg.mode; enabled = cfg.enabled; } catch (e) {}
    return json(res, 200, { ok: true, connected: !!db.username, conversations: Object.keys(db.conversations).length, machine: MACHINE_KEY, enabled, mode });
  }

  if (p === '/' && req.method === 'GET') return send(res, 200, connectPage());
  if (p === '/login') { res.writeHead(302, { Location: loginUrl() }); return res.end(); }
  if (p === '/callback') return handleCallback(u.searchParams, res);
  if (p === '/disconnect') {
    if (!inboxAuthed(u, req)) return send(res, 401, keyPage());
    db = { token: null, ig_user_id: null, username: null, profile_pic: null, conversations: db.conversations }; save(); res.writeHead(302, { Location: PUBLIC_URL + '/' }); return res.end();
  }
  if (p === '/inbox') {
    if (!inboxAuthed(u, req)) return send(res, 401, keyPage());
    if (INBOX_KEY && u.searchParams.get('key') === INBOX_KEY) {
      res.setHeader('Set-Cookie', 'sr_key=' + INBOX_KEY + '; Path=/dm; HttpOnly; Secure; SameSite=Lax');
    }
    return send(res, 200, inboxPage());
  }

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
            const fresh = recordIncoming(m.sender.id, m.message.text || '[attachment]', m.message.mid);
            if (fresh) {
              // Day 10: the machine. Fire-and-forget so webhook latency stays flat.
              processDm(m.sender.id, m.message.text || '[attachment]', m.message.mid)
                .catch(e => console.error('[dm] pipeline error: ' + e.message));
            }
          }
        }
      }
    } catch (e) { log('webhook parse error', e.message); }
    return;
  }

  if (p === '/api/reply' && req.method === 'POST') {
    if (!inboxAuthed(u, req)) return send(res, 401, 'forbidden', 'text/plain');
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
      logEvent('ig:' + igsid, 'dm_manual_reply', 'Human replied from the inbox: ' + text.slice(0, 100), { igsid, human_agent: late });
    }
    res.writeHead(302, { Location: PUBLIC_URL + '/inbox' }); return res.end();
  }

  send(res, 404, 'not found', 'text/plain');
});

server.listen(PORT, BIND_HOST, () => log('sr-dm-bridge listening on ' + BIND_HOST + ':' + PORT + ' (public ' + PUBLIC_URL + ') machine=' + MACHINE_KEY));

// Day 13.2: drain the owner's decisions shortly after boot, then every minute.
setTimeout(() => drainDecisions().catch(e => console.error('[dm] drain error: ' + e.message)), 10000);
setInterval(() => drainDecisions().catch(e => console.error('[dm] drain error: ' + e.message)), DRAIN_EVERY_MS);
