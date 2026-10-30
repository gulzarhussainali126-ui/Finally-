'use strict';
const fs = require('fs');
const zlib = require('zlib');
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = baileys;
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// ====================== SETTINGS (EDIT THIS BLOCK) ======================
// Most of these can be changed from the ADMIN SHEET (Google Sheet) without touching code.
// Values in the Admin Sheet override the values below. Anything marked FILL_ME there is ignored.
const SETTINGS = {
  BUSINESS_NAME: 'RGD',
  BUSINESS_TYPE: 'restaurant',            // restaurant / pizza shop / salon / clinic / shop / other
  CITY: 'Lahore',
  CALL_PHONE: '03XX-XXXXXXX',             // PLACEHOLDER: number customers call
  OPENING_HOURS: '12:00 PM - 12:00 AM (daily)',
  BOT_NUMBER: '03XXXXXXXXX',              // PLACEHOLDER: WhatsApp number the bot runs on
  OWNER_NUMBER: '',                       // optional, order/booking alerts go here (03XXXXXXXXX)
  FLOW: 'ORDER',                          // 'ORDER' | 'BOOKING' | 'INFO'
  CURRENCY: 'Rs',
  MIN_ORDER: 0,
  STORE_OPEN: true,
  CLOSED_MESSAGE: '',
  WELCOME_EXTRA: '',

  // Links (Google Sheets: "Anyone with the link: Viewer"). Better: put them in GitHub Secrets.
  ADMIN_SHEET_URL: '',                    // link of RGD_Admin_Panel (or secret ADMIN_SHEET_URL)
  PRODUCTS_SHEET_URL: '',                 // link of RGD_Products_Stock (or set it inside the Admin Sheet)
  BUSINESS_DOC_URL: '',                   // optional Google Doc link
  DOC_FILE: 'RGD_Business_Info.docx',     // Word file in the repo root, read automatically if it exists

  // Groq AI. Best: GitHub secret GROQ_API_KEY. Writing the key here also works in a PRIVATE repo only.
  GROQ_API_KEY: '',
  GROQ_MODEL: 'llama-3.3-70b-versatile',

  // Backup menu, used only until the Products sheet has been read
  ITEMS: [
    { name: '[ITEM 1 NAME]', price: 100, category: '', stock: null, desc: '' },
    { name: '[ITEM 2 NAME]', price: 200, category: '', stock: null, desc: '' },
    { name: '[ITEM 3 NAME]', price: 300, category: '', stock: null, desc: '' },
  ],
  DELIVERY: { enabled: true, fee: 150, time: '30-45 minutes' },
  PAYMENT: {
    cash: true,
    online: [
      { method: 'JazzCash', number: '03XXXXXXXXX', title: '[ACCOUNT TITLE]' },
      { method: 'EasyPaisa', number: '03XXXXXXXXX', title: '[ACCOUNT TITLE]' },
    ],
  },
  EXTRA_RULES: '',
  DOC_TEXT: '',
};
// =========================================================================

const S = SETTINGS;
const SESSION_DIR = 'session_bot';
const logger = pino({ level: 'silent' });
let FLOW = String(S.FLOW || 'ORDER').toUpperCase();
const GROQ_KEY = (process.env.GROQ_API_KEY || S.GROQ_API_KEY || '').trim();

const money = (n) => `${S.CURRENCY} ${n}`;
const toIntl = (num) => {
  let d = String(num || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '92' + d.slice(1);
  return d;
};
const validIntl = (d) => /^92\d{10}$/.test(d);
const logErr = (tag, e) => console.log(tag, e && e.message ? e.message : e);

// ------------------------- state -------------------------
const sessions = new Map();
const aiHistory = new Map();
const welcomed = new Set();
const newSession = () => ({ step: 'IDLE', cart: {}, phone: '' });
const getS = (chat) => {
  if (!sessions.has(chat)) sessions.set(chat, newSession());
  return sessions.get(chat);
};
const resetS = (chat) => sessions.set(chat, newSession());
const seen = new Set();
const usedIds = new Set();
const genId = (prefix) => {
  let id;
  do { id = `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`; } while (usedIds.has(id));
  usedIds.add(id);
  return id;
};

// ------------------------- Google Sheets / Docs loading -------------------------
function sheetCsvUrl(link) {
  link = String(link || '').trim();
  if (!link) return '';
  if (/output=csv|format=csv/i.test(link)) return link;
  let m = link.match(/\/spreadsheets\/d\/e\/([^/?#]+)/);
  if (m) return `https://docs.google.com/spreadsheets/d/e/${m[1]}/pub?output=csv`;
  m = link.match(/\/spreadsheets\/d\/([^/?#]+)/);
  if (!m) return '';
  const g = link.match(/[#&?]gid=(\d+)/);
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${g ? '&gid=' + g[1] : ''}`;
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function fetchBuf(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url.slice(0, 60));
  return Buffer.from(await res.arrayBuffer());
}

async function loadCsv(link) {
  const url = sheetCsvUrl(link);
  if (!url) throw new Error('Not a Google Sheets link: ' + String(link).slice(0, 50));
  const text = (await fetchBuf(url)).toString('utf8').replace(/^﻿/, '');
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('Sheet is not public. Share > Anyone with the link > Viewer.');
  return parseCSV(text).filter((r) => r.some((c) => String(c).trim()));
}

const PLACEHOLDER_RE = /^\s*(fill_me|fill|todo|tbd|n\/a|-)\s*$/i;
const isPlaceholder = (v) => v == null || String(v).trim() === '' || PLACEHOLDER_RE.test(String(v)) || /^\s*\[?\s*fill/i.test(String(v)) || /x{4,}/i.test(String(v));

// ---------- Admin sheet ----------
const ADMIN_KEYS = new Set([
  'BUSINESS_NAME', 'BUSINESS_TYPE', 'CITY', 'CALL_PHONE', 'OPENING_HOURS', 'BOT_NUMBER', 'OWNER_NUMBER',
  'FLOW', 'STORE_OPEN', 'CLOSED_MESSAGE', 'WELCOME_EXTRA', 'CURRENCY', 'MIN_ORDER', 'DELIVERY_ENABLED',
  'DELIVERY_FEE', 'DELIVERY_TIME', 'PAY_CASH', 'PAY_1_METHOD', 'PAY_1_NUMBER', 'PAY_1_TITLE',
  'PAY_2_METHOD', 'PAY_2_NUMBER', 'PAY_2_TITLE', 'PAY_3_METHOD', 'PAY_3_NUMBER', 'PAY_3_TITLE',
  'PRODUCTS_SHEET_URL', 'BUSINESS_DOC_URL', 'EXTRA_RULES', 'GROQ_MODEL',
]);
const yes = (v, dflt) => (v === '' ? dflt : /^(yes|y|true|1|on|haan|ha)$/i.test(v));

function applyAdmin(map) {
  const get = (k) => (isPlaceholder(map[k]) ? '' : String(map[k]).trim());
  const setStr = (k) => { const v = get(k); if (v) S[k] = v; };
  ['BUSINESS_NAME', 'BUSINESS_TYPE', 'CITY', 'CALL_PHONE', 'OPENING_HOURS', 'CURRENCY', 'GROQ_MODEL',
    'PRODUCTS_SHEET_URL', 'BUSINESS_DOC_URL'].forEach(setStr);
  // optional texts: an empty cell means "none"
  ['CLOSED_MESSAGE', 'WELCOME_EXTRA', 'EXTRA_RULES'].forEach((k) => { if (k in map) S[k] = isPlaceholder(map[k]) ? '' : String(map[k]).trim(); });

  const fl = get('FLOW').toUpperCase();
  if (['ORDER', 'BOOKING', 'INFO'].includes(fl)) { S.FLOW = fl; FLOW = fl; }

  const bn = toIntl(get('BOT_NUMBER'));
  if (validIntl(bn)) S.BOT_NUMBER = get('BOT_NUMBER');
  const on = toIntl(get('OWNER_NUMBER'));
  S.OWNER_NUMBER = validIntl(on) ? get('OWNER_NUMBER') : '';

  if ('STORE_OPEN' in map) S.STORE_OPEN = yes(get('STORE_OPEN'), true);
  const mo = parseFloat(get('MIN_ORDER'));
  if (!Number.isNaN(mo) && mo >= 0) S.MIN_ORDER = mo;

  const de = get('DELIVERY_ENABLED');
  if (de) S.DELIVERY.enabled = yes(de, true);
  const fee = parseFloat(get('DELIVERY_FEE'));
  if (!Number.isNaN(fee) && fee >= 0) S.DELIVERY.fee = fee;
  if (get('DELIVERY_TIME')) S.DELIVERY.time = get('DELIVERY_TIME');

  if ('PAY_CASH' in map) S.PAYMENT.cash = yes(get('PAY_CASH'), true);
  const online = [];
  for (const n of [1, 2, 3]) {
    const number = get(`PAY_${n}_NUMBER`);
    if (!number) continue;
    online.push({ method: get(`PAY_${n}_METHOD`) || 'Online', number, title: get(`PAY_${n}_TITLE`) || '-' });
  }
  if ('PAY_1_NUMBER' in map || 'PAY_2_NUMBER' in map || 'PAY_3_NUMBER' in map) S.PAYMENT.online = online;
}

async function loadAdmin() {
  const link = process.env.ADMIN_SHEET_URL || S.ADMIN_SHEET_URL;
  if (!link) return;
  try {
    const rows = await loadCsv(link);
    const map = {};
    for (const r of rows) {
      const k = String(r[0] || '').trim().toUpperCase();
      if (ADMIN_KEYS.has(k)) map[k] = r[1] == null ? '' : String(r[1]).trim();
    }
    if (!Object.keys(map).length) throw new Error('No settings found. Keep the Settings sheet as the FIRST tab.');
    applyAdmin(map);
    console.log(`[ADMIN] Settings loaded (${Object.keys(map).length} keys): ${S.BUSINESS_NAME}, open=${S.STORE_OPEN}, flow=${FLOW}`);
  } catch (e) {
    logErr('[ADMIN ERROR]', e);
  }
}

// ---------- Products sheet ----------
async function loadProducts() {
  const link = S.PRODUCTS_SHEET_URL || process.env.PRODUCTS_SHEET_URL || process.env.SHEET_URL;
  if (!link) return;
  try {
    const rows = await loadCsv(link);
    if (rows.length < 2) throw new Error('Products sheet has no data rows');
    const head = rows[0].map((h) => String(h).trim().toLowerCase());
    const find = (re, not) => head.findIndex((h, i) => re.test(h) && i !== not);
    let ni = find(/item name|^name$|name|item|service|product|dish/);
    let pi = find(/^price|price|rate|amount/);
    if (ni < 0 || pi < 0 || ni === pi) { ni = 0; pi = 1; }
    const ai = find(/^available$|available|status/);
    const ci = find(/categor/);
    const si = find(/stock left|stock qty|in stock/);
    const di = find(/descr/);
    const items = [];
    for (const r of rows.slice(1)) {
      const name = String(r[ni] || '').trim();
      const price = parseFloat(String(r[pi] || '').replace(/[^\d.]/g, ''));
      if (!name || !(price > 0)) continue;
      if (ai >= 0 && /^(no|n|0|false|out|out of stock|unavailable|hidden)$/i.test(String(r[ai] || '').trim())) continue;
      let stock = null;
      if (si >= 0) {
        const sv = parseFloat(String(r[si] || '').replace(/[^\d.-]/g, ''));
        if (!Number.isNaN(sv) && sv < 9999) stock = sv;
      }
      items.push({
        name, price,
        category: ci >= 0 ? String(r[ci] || '').trim() : '',
        stock,
        desc: di >= 0 ? String(r[di] || '').trim() : '',
      });
    }
    if (!items.length) throw new Error('No valid items found (need "Item Name" and "Price (Rs)" columns)');
    // group by category (keeps first-seen order) so numbers match what is displayed
    const order = [];
    for (const it of items) if (!order.includes(it.category)) order.push(it.category);
    S.ITEMS = order.flatMap((c) => items.filter((it) => it.category === c));
    console.log(`[SHEET] Loaded ${S.ITEMS.length} menu items`);
  } catch (e) {
    logErr('[SHEET ERROR]', e);
    console.log('[SHEET] keeping previous menu');
  }
}

// ---------- Business document (.docx / Google Doc) ----------
function unzipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip/docx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    if (name === wanted) {
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nl + el + cl;
  }
  return null;
}

function xmlText(s) {
  return s
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function docxToText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('word/document.xml not found');
  let s = xml.toString('utf8');
  // tables: one line per row, cells joined with " | "
  s = s.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, (tr) => {
    const cells = (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map((tc) => xmlText(tc.replace(/<\/w:p>/g, ' ')).trim());
    return `<w:p><w:r><w:t>${cells.join(' | ').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`;
  });
  return xmlText(s);
}

function cleanDoc(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  const out = [];
  for (const l of lines) {
    if (!l) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    if (/\[\s*fill/i.test(l)) continue;           // unfilled placeholder lines are ignored
    if (/^instructions?\s*:/i.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').trim().slice(0, 6000);
}

async function docFromUrl(link) {
  let m = link.match(/\/document\/d\/([^/?#]+)/);
  let buf;
  if (m) buf = await fetchBuf(`https://docs.google.com/document/d/${m[1]}/export?format=txt`);
  else {
    m = link.match(/\/file\/d\/([^/?#]+)/) || link.match(/[?&]id=([^&#]+)/);
    buf = await fetchBuf(m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : link);
  }
  if (buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b) return docxToText(buf);
  const t = buf.toString('utf8');
  if (/^\s*<(!doctype|html)/i.test(t)) throw new Error('Document is not public (Anyone with the link: Viewer)');
  return t.replace(/^﻿/, '');
}

async function loadDoc() {
  let text = '';
  if (S.BUSINESS_DOC_URL) {
    try { text = await docFromUrl(S.BUSINESS_DOC_URL); } catch (e) { logErr('[DOC URL ERROR]', e); }
  }
  if (!text && S.DOC_FILE && fs.existsSync(S.DOC_FILE)) {
    try { text = docxToText(fs.readFileSync(S.DOC_FILE)); } catch (e) { logErr('[DOC FILE ERROR]', e); }
  }
  if (text) {
    S.DOC_TEXT = cleanDoc(text);
    console.log(`[DOC] Business document loaded (${S.DOC_TEXT.length} chars)`);
  }
}

let reloading = false;
async function loadAll() {
  if (reloading) return;
  reloading = true;
  try { await loadAdmin(); await loadProducts(); await loadDoc(); }
  catch (e) { logErr('[RELOAD ERROR]', e); }
  reloading = false;
}

// ------------------------- texts -------------------------
const listWord = () => (FLOW === 'BOOKING' ? 'services' : 'menu');

function welcomeText() {
  return (
    `👋 Welcome to *${S.BUSINESS_NAME}*!\n` +
    `📍 ${S.CITY}\n` +
    `📞 Call us: ${S.CALL_PHONE}\n` +
    `🕐 Hours: ${S.OPENING_HOURS}\n` +
    (S.WELCOME_EXTRA ? `\n🎁 ${S.WELCOME_EXTRA}\n` : '') +
    `\nReply *1* or *MENU* to see the ${listWord()} 😊`
  );
}

function closedText() {
  return (
    (S.CLOSED_MESSAGE ? `😴 ${S.CLOSED_MESSAGE}\n\n` : `😴 *${S.BUSINESS_NAME}* is closed right now, sorry!\n\n`) +
    `🕐 Hours: ${S.OPENING_HOURS}\n📞 ${S.CALL_PHONE}\nPlease message us again when we are open 🙏`
  );
}

const lowNote = (it) => (it.stock != null && it.stock <= 5 ? ` _(only ${it.stock} left)_` : '');

function menuText() {
  const lines = [];
  let last = null;
  S.ITEMS.forEach((it, i) => {
    if (it.category && it.category !== last) { lines.push(`\n📌 *${it.category}*`); last = it.category; }
    lines.push(`${i + 1}. ${it.name} — ${money(it.price)}${lowNote(it)}`);
  });
  let head, foot;
  if (FLOW === 'BOOKING') {
    head = `💇 *${S.BUSINESS_NAME} — Services*`;
    foot = `\n📅 Tell me which service you want, or reply with its number.\n❌ Reply *0* to cancel.`;
  } else if (FLOW === 'INFO') {
    head = `📋 *${S.BUSINESS_NAME} — Menu*`;
    foot = `\n📞 For orders or bookings please call: ${S.CALL_PHONE}`;
  } else {
    head = `🍽️ *${S.BUSINESS_NAME} — Menu*`;
    foot =
      `\n🛒 To order, send item numbers like: *1x2, 5, 9*\n(1x2 = item 1, quantity 2) or just tell me what you want 😊\n` +
      (S.DELIVERY.enabled
        ? `🚚 Delivery: ${money(S.DELIVERY.fee)} • ${S.DELIVERY.time}\n`
        : `🏪 Pickup only (no delivery)\n`) +
      (S.MIN_ORDER > 0 ? `📦 Minimum order: ${money(S.MIN_ORDER)}\n` : '') +
      `❌ Reply *0* to cancel.`;
  }
  const extra = S.EXTRA_RULES ? `\nℹ️ ${S.EXTRA_RULES}` : '';
  return `${head}\n${lines.join('\n')}\n${foot}${extra}`;
}

function totals(s) {
  let sub = 0;
  for (const [i, q] of Object.entries(s.cart)) {
    const it = S.ITEMS[i - 1];
    if (it) sub += it.price * q;
  }
  const fee = S.DELIVERY.enabled ? S.DELIVERY.fee : 0;
  return { sub, fee, total: sub + fee };
}
function cartLines(s) {
  const out = [];
  for (const [i, q] of Object.entries(s.cart)) {
    const it = S.ITEMS[i - 1];
    if (it) out.push(`${q} x ${it.name} = ${money(it.price * q)}`);
  }
  return out;
}
function summaryText(s) {
  const t = totals(s);
  return (
    `🧾 *Your order*\n${cartLines(s).join('\n')}\n\n` +
    `Subtotal: ${money(t.sub)}\n` +
    (S.DELIVERY.enabled ? `Delivery: ${money(t.fee)}\n` : `Pickup: no delivery fee\n`) +
    `*Total: ${money(t.total)}*\n\n` +
    `Reply:\n*1* ✅ Confirm\n*2* ➕ Add more\n*0* ❌ Cancel`
  );
}
// returns a problem text if the cart cannot be accepted, else ''
function cartProblem(cart) {
  const t = totals({ cart });
  if (S.MIN_ORDER > 0 && t.sub < S.MIN_ORDER) {
    return `📦 Minimum order is ${money(S.MIN_ORDER)} (your items: ${money(t.sub)}). Please add a little more 😊`;
  }
  for (const [i, q] of Object.entries(cart)) {
    const it = S.ITEMS[i - 1];
    if (it && it.stock != null && q > it.stock) {
      return `😔 Sorry, only ${it.stock} of *${it.name}* ${it.stock === 1 ? 'is' : 'are'} left. Please choose a smaller quantity or another item.`;
    }
  }
  return '';
}

function validAccounts() {
  return (S.PAYMENT.online || []).filter((a) => !isPlaceholder(a.number));
}
function payOptions() {
  const o = [];
  if (S.PAYMENT.cash) o.push('cash');
  if (validAccounts().length) o.push('online');
  if (!o.length) o.push('cash');
  return o;
}
const cashLabel = () => (S.DELIVERY.enabled ? 'Cash on delivery' : 'Cash on pickup');

function accountsText(s) {
  const t = totals(s);
  const acc = validAccounts().map((a) => `• ${a.method}: *${a.number}*\n  Title: ${a.title}`).join('\n');
  return (
    `💳 *Online payment*\nPlease send *${money(t.total)}* to:\n${acc}\n\n` +
    `Then send the payment *screenshot* 📸 or type *PAID*.` +
    (payOptions().includes('cash') ? `\n(Type *CASH* to pay by cash instead.)` : '') +
    `\n❌ Reply *0* to cancel.`
  );
}

// ------------------------- sending -------------------------
async function send(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (e) {
    console.log('[SEND ERROR]', jid, e && e.message ? e.message : e);
    return false;
  }
}
async function notifyOwner(sock, text) {
  const d = toIntl(S.OWNER_NUMBER);
  if (!validIntl(d)) return;
  await send(sock, `${d}@s.whatsapp.net`, text);
}

// ------------------------- parsing -------------------------
function parseOrder(raw) {
  const txt = raw
    .toLowerCase()
    .replace(/(\d+)\s*[x×*]\s*(\d+)/g, '$1x$2')
    .replace(/\band\b/g, ' ');
  const tokens = txt.split(/[\s,;+&\n]+/).filter(Boolean);
  const added = [];
  const bad = [];
  for (const tk of tokens) {
    let idx, qty;
    const m = tk.match(/^(\d{1,3})x(\d{1,2})$/);
    if (m) { idx = +m[1]; qty = +m[2]; }
    else if (/^\d{1,3}$/.test(tk)) { idx = +tk; qty = 1; }
    else { bad.push(tk); continue; }
    if (idx < 1 || idx > S.ITEMS.length || qty < 1 || qty > 50) { bad.push(tk); continue; }
    added.push({ idx, qty });
  }
  return { added, bad };
}

// "1x2, 5, 9" -> natural sentence for the AI
function codesToText(raw) {
  if (!/^[\d\sx×*,;+&]+$/i.test(raw) || !/\d/.test(raw)) return '';
  const { added, bad } = parseOrder(raw);
  if (!added.length || bad.length) return '';
  const tmp = {};
  for (const a of added) tmp[a.idx] = (tmp[a.idx] || 0) + a.qty;
  const parts = Object.entries(tmp).map(([i, q]) => `${q} x ${S.ITEMS[i - 1].name}`);
  return `I want to order: ${parts.join(', ')}`;
}

const GREET_RE = /^(hi+|hello+|hey+|hlo+|salam|salaam|slam|aoa|assalam\S*|assalamualaikum|good (morning|evening|afternoon|night)|menu|1|start|ok|okay|yes|hmm)[\s!.?]*$/i;
const isRealQuestion = (raw) => raw.length >= 6 && !GREET_RE.test(raw);

// ------------------------- flow helpers (step-by-step backup flow) -------------------------
async function askAddressOrName(sock, chat, s) {
  if (S.DELIVERY.enabled) {
    s.step = 'ADDRESS';
    return send(sock, chat, `📍 Please send your *full delivery address* (house no, street, area, landmark).\n❌ Reply *0* to cancel.`);
  }
  s.step = 'NAME';
  return send(sock, chat, `😊 Please send your *name* for the pickup.\n❌ Reply *0* to cancel.`);
}

async function choosePayment(sock, chat, s, kind) {
  if (kind === 'cash') {
    s.payment = cashLabel();
    await send(sock, chat, `💵 ${s.payment} selected.`);
    return askAddressOrName(sock, chat, s);
  }
  s.payment = 'Online';
  s.step = 'PAY_WAIT';
  return send(sock, chat, accountsText(s));
}

async function startPayment(sock, chat, s) {
  const opts = payOptions();
  if (opts.length === 1) return choosePayment(sock, chat, s, opts[0]);
  s.step = 'PAYMENT';
  const lines = opts.map((o, i) => `*${i + 1}* ${o === 'cash' ? '💵 ' + cashLabel() : '💳 Online (JazzCash / EasyPaisa / bank)'}`);
  return send(sock, chat, `💰 How would you like to pay?\n\n${lines.join('\n')}\n\n❌ Reply *0* to cancel.`);
}

async function finalizeOrder(sock, chat, s) {
  const id = genId('ORD');
  const t = totals(s);
  const where = S.DELIVERY.enabled ? `📍 Address: ${s.address}` : `🙋 Name: ${s.name}`;
  const eta = S.DELIVERY.enabled
    ? `⏱️ Your order will reach you in *${S.DELIVERY.time}*.`
    : `⏱️ Your order will be ready for pickup in *${S.DELIVERY.time}*.`;
  const msg =
    `🎉 *Order confirmed!*\n🧾 Order ID: *${id}*\n\n${cartLines(s).join('\n')}\n` +
    `Total: *${money(t.total)}*\n💳 Payment: ${s.payment}${s.payNote ? ' (' + s.payNote + ')' : ''}\n${where}\n\n` +
    `${eta}\nThank you for choosing *${S.BUSINESS_NAME}*! 🙏\n📞 ${S.CALL_PHONE}`;
  await send(sock, chat, msg);
  await notifyOwner(
    sock,
    `🔔 *NEW ORDER ${id}*\n📱 Customer: ${s.phone || chat}\n${cartLines(s).join('\n')}\n` +
      `Delivery fee: ${money(t.fee)}\n*Total: ${money(t.total)}*\n💳 ${s.payment}${s.payNote ? ' — ' + s.payNote : ''}\n${where}`
  );
  console.log(`[ORDER] ${id} from ${s.phone || chat} total ${t.total}`);
  resetS(chat);
  aiHistory.delete(chat);
}

async function finalizeBooking(sock, chat, s) {
  const id = genId('BKG');
  const it = S.ITEMS[s.service - 1];
  await send(
    sock,
    chat,
    `🎉 *Booking received!*\n🧾 Booking ID: *${id}*\n\n💇 Service: ${it.name} (${money(it.price)})\n📅 When: ${s.when}\n👤 Name: ${s.name}\n\n` +
      `We will see you soon at *${S.BUSINESS_NAME}*, ${S.CITY}. 🙏\n🕐 ${S.OPENING_HOURS}\n📞 ${S.CALL_PHONE}`
  );
  await notifyOwner(
    sock,
    `🔔 *NEW BOOKING ${id}*\n📱 Customer: ${s.phone || chat}\n👤 ${s.name}\n💇 ${it.name} (${money(it.price)})\n📅 ${s.when}`
  );
  console.log(`[BOOKING] ${id} from ${s.phone || chat}`);
  resetS(chat);
  aiHistory.delete(chat);
}

// ------------------------- step-by-step conversation (backup) -------------------------
async function converse(sock, chat, phone, text, isMedia) {
  const s = getS(chat);
  if (phone) s.phone = phone;
  const raw = (text || '').trim();
  const l = raw.toLowerCase();
  const reply = (t) => send(sock, chat, t);

  if (s.step !== 'IDLE' && (l === '0' || l === 'cancel' || l === 'cancel order' || l === 'cancel booking')) {
    resetS(chat);
    return reply(`❌ Cancelled. No problem! 😊\nReply *MENU* anytime to start again.`);
  }

  switch (s.step) {
    case 'IDLE': {
      if (l === '1' || l === 'menu' || l === 'services') {
        if (FLOW === 'ORDER') s.step = 'ORDERING';
        else if (FLOW === 'BOOKING') s.step = 'B_SERVICE';
        return reply(menuText());
      }
      return reply(welcomeText());
    }

    case 'ORDERING': {
      if (l === 'menu') return reply(menuText());
      const { added, bad } = parseOrder(raw);
      if (!added.length) {
        return reply(`🤔 I didn't get that.\nSend item numbers like *1x2, 5, 9* (item x quantity).\nSend *MENU* to see the list or *0* to cancel.`);
      }
      for (const a of added) s.cart[a.idx] = Math.min(50, (s.cart[a.idx] || 0) + a.qty);
      s.step = 'CONFIRM';
      const note = bad.length ? `⚠️ Skipped: ${bad.join(', ')}\n\n` : '';
      return reply(note + summaryText(s));
    }

    case 'CONFIRM': {
      if (['1', 'confirm', 'yes', 'y', 'ok', 'okay'].includes(l)) {
        const prob = cartProblem(s.cart);
        if (prob) { s.step = 'ORDERING'; return reply(prob + `\n\nSend more items like *3x1*, or *0* to cancel.`); }
        return startPayment(sock, chat, s);
      }
      if (l === 'menu') { s.step = 'ORDERING'; return reply(menuText()); }
      if (['2', 'add', 'add more', 'more'].includes(l)) {
        s.step = 'ORDERING';
        return reply(`➕ Send more items like *3x1, 4*.\nSend *MENU* to see the list again.\n\nCurrent cart:\n${cartLines(s).join('\n')}`);
      }
      return reply(`Please reply:\n*1* ✅ Confirm\n*2* ➕ Add more\n*0* ❌ Cancel`);
    }

    case 'PAYMENT': {
      const opts = payOptions();
      let kind = null;
      const n = parseInt(l, 10);
      if (n >= 1 && n <= opts.length && String(n) === l) kind = opts[n - 1];
      else if (['cash', 'cod'].includes(l) && opts.includes('cash')) kind = 'cash';
      else if (['online', 'jazzcash', 'easypaisa'].includes(l) && opts.includes('online')) kind = 'online';
      if (!kind) return reply(`Please reply with ${opts.length > 1 ? '*1* or *2*' : '*1*'} to choose payment, or *0* to cancel.`);
      return choosePayment(sock, chat, s, kind);
    }

    case 'PAY_WAIT': {
      if (l === 'cash' && payOptions().includes('cash')) return choosePayment(sock, chat, s, 'cash');
      if (isMedia) {
        s.payNote = 'screenshot received';
      } else if (/\b(paid|done)\b/.test(l)) {
        s.payNote = 'customer says PAID, please verify';
      } else {
        return reply(`📸 Please send the payment *screenshot* or type *PAID*.` + (payOptions().includes('cash') ? `\nType *CASH* for cash instead.` : '') + `\nReply *0* to cancel.`);
      }
      await reply(`✅ Thank you! Payment noted.`);
      return askAddressOrName(sock, chat, s);
    }

    case 'ADDRESS': {
      if (raw.length < 8) return reply(`📍 Please send your *complete address* (house no, street, area).\nReply *0* to cancel.`);
      s.address = raw;
      return finalizeOrder(sock, chat, s);
    }

    case 'NAME': {
      if (raw.length < 2) return reply(`😊 Please send your *name*.\nReply *0* to cancel.`);
      s.name = raw;
      return finalizeOrder(sock, chat, s);
    }

    case 'B_SERVICE': {
      if (l === 'menu') return reply(menuText());
      const n = parseInt(l, 10);
      if (String(n) === l && n >= 1 && n <= S.ITEMS.length) {
        s.service = n;
        s.step = 'B_DATETIME';
        return reply(`✅ *${S.ITEMS[n - 1].name}* selected.\n\n📅 Send your preferred *date and time*, e.g. *Friday 5 PM*\n🕐 Hours: ${S.OPENING_HOURS}\n❌ Reply *0* to cancel.`);
      }
      return reply(`Please reply with a *service number* (1-${S.ITEMS.length}).\nSend *MENU* to see the list or *0* to cancel.`);
    }

    case 'B_DATETIME': {
      if (raw.length < 3) return reply(`📅 Please send date and time, e.g. *Friday 5 PM*.\nReply *0* to cancel.`);
      s.when = raw;
      s.step = 'B_NAME';
      return reply(`😊 Please send your *name* to complete the booking.\n❌ Reply *0* to cancel.`);
    }

    case 'B_NAME': {
      if (raw.length < 2) return reply(`😊 Please send your *name*.\nReply *0* to cancel.`);
      s.name = raw;
      return finalizeBooking(sock, chat, s);
    }

    default: {
      resetS(chat);
      return reply(welcomeText());
    }
  }
}

// ------------------------- AI CHAT (Groq) -------------------------
function systemPrompt() {
  const menu = S.ITEMS.map((it, i) =>
    `${i + 1}. ${it.name} - ${money(it.price)}` +
    (it.category ? ` [${it.category}]` : '') +
    (it.stock != null && it.stock <= 10 ? ` (only ${it.stock} left)` : '') +
    (it.desc ? ` - ${it.desc}` : '')
  ).join('\n');
  const accounts = validAccounts().map((a) => `${a.method}: ${a.number} (account title: ${a.title})`);
  const pay = [S.PAYMENT.cash ? `Cash (${cashLabel()})` : null, ...accounts].filter(Boolean).join('; ') || `Cash (${cashLabel()})`;
  const delivery = S.DELIVERY.enabled
    ? `Delivery fee ${money(S.DELIVERY.fee)}, arrives in ${S.DELIVERY.time}.`
    : `No delivery, pickup only (ready in ${S.DELIVERY.time}).`;
  let task;
  if (FLOW === 'ORDER') {
    task =
      `YOUR JOB: take orders. Collect: items with quantities, payment method, ` +
      (S.DELIVERY.enabled ? `full delivery address` : `customer name for pickup`) + `. ` +
      `Ask only one or two things at a time. Show a short summary with subtotal, delivery fee and total, and ask the customer to confirm in words (yes / confirm). ` +
      (S.MIN_ORDER > 0 ? `Minimum order (items only) is ${money(S.MIN_ORDER)}. ` : '') +
      `If they pay online, give the account details and wait until they send a screenshot or write PAID. ` +
      `Only when the customer has confirmed AND you have the payment and ` + (S.DELIVERY.enabled ? 'address' : 'name') + `, ` +
      `end your message with ONE final line exactly in this format (nothing after it): ` +
      `ORDER_JSON: {"items":[{"n":1,"q":2}],"payment":"Cash or Online","address":"full address","name":"customer name or empty"} ` +
      `(n = menu number, q = quantity). Never write ORDER_JSON before the customer confirmed. ` +
      `Do NOT write an order ID or say the order is placed; the system sends the final confirmation itself.`;
  } else if (FLOW === 'BOOKING') {
    task =
      `YOUR JOB: take appointment bookings. Collect: service, date and time (within opening hours), customer name. Repeat the details and ask the customer to confirm in words. ` +
      `Then end your message with ONE final line exactly in this format (nothing after it): ` +
      `BOOKING_JSON: {"service":1,"when":"Friday 5 PM","name":"Ali"} (service = menu number). Never write it before the customer confirmed. ` +
      `Do NOT write a booking ID; the system sends the confirmation itself.`;
  } else {
    task = `YOUR JOB: only answer questions about the menu, prices, timings and location. For orders or bookings ask them to call ${S.CALL_PHONE}.`;
  }
  return (
    `You are the friendly WhatsApp assistant of "${S.BUSINESS_NAME}" (${S.BUSINESS_TYPE}) in ${S.CITY}.\n` +
    `Phone for calls: ${S.CALL_PHONE}. Opening hours: ${S.OPENING_HOURS}.\n\n` +
    `MENU / SERVICES (numbers are for ORDER_JSON):\n${menu}\n\n${delivery}\nPayment: ${pay}\n` +
    `${S.EXTRA_RULES ? 'Business rules: ' + S.EXTRA_RULES + '\n' : ''}` +
    `${S.DOC_TEXT ? '\nABOUT THE BUSINESS (from the owner, use it to answer questions; prices always come from the menu above):\n' + S.DOC_TEXT + '\n' : ''}\n` +
    `${task}\n\n` +
    `STYLE: Talk like a real, polite, warm human, never like a robot. Reply in the customer's own language (English, Urdu, or Roman Urdu). ` +
    `Keep replies short (2-5 lines) with a few emojis. Never ask the customer to reply with numbers like 1 or 2; use normal words. ` +
    `Only sell items from the menu with the exact prices above. Never invent items, prices, discounts, or timings. ` +
    `If something is not on the menu, say sorry and suggest similar menu items. If the question is unrelated, answer briefly and steer back. ` +
    `If you do not know something, ask the customer to call ${S.CALL_PHONE}.`
  );
}

function splitAI(out) {
  const mm = out.match(/(ORDER|BOOKING)_JSON\s*:?\s*/);
  if (!mm) return { visible: out.trim(), kind: '', data: null };
  const visible = out.slice(0, mm.index).replace(/```\w*\s*$/, '').trim();
  const rest = out.slice(mm.index + mm[0].length);
  const st = rest.indexOf('{');
  let data = null;
  if (st >= 0) {
    let depth = 0, end = -1;
    for (let i = st; i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      else if (rest[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > 0) {
      try { data = JSON.parse(rest.slice(st, end + 1)); }
      catch (e) { console.log('[AI JSON ERROR]', e.message); }
    }
  }
  return { visible, kind: mm[1], data };
}

async function groqChat(messages) {
  const models = [...new Set([S.GROQ_MODEL, 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'].filter(Boolean))];
  let lastErr = new Error('no model');
  for (const model of models) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GROQ_KEY },
        body: JSON.stringify({ model, temperature: 0.4, max_tokens: 500, messages }),
        signal: AbortSignal.timeout(25000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (out && out.trim()) return out;
        lastErr = new Error(model + ': empty reply');
        continue;
      }
      lastErr = new Error(`${model} HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      if (res.status === 401 || res.status === 403) break; // wrong key: other models will fail too
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function aiConverse(sock, chat, phone, text, isMedia) {
  const raw = (text || '').trim();
  const h = aiHistory.get(chat) || [];
  h.push({ role: 'user', content: raw || (isMedia ? '[Customer sent a photo/screenshot]' : '[empty message]') });
  while (h.length > 20) h.shift();
  while (h.length && h[0].role !== 'user') h.shift();

  let out = '';
  try {
    out = await groqChat([{ role: 'system', content: systemPrompt() }, ...h]);
  } catch (e) {
    logErr('[AI ERROR]', e);
    h.pop();
    aiHistory.set(chat, h);
    return false;
  }

  const { visible, kind, data } = splitAI(out);
  let problem = '';
  let order = null;

  if (data && kind === 'ORDER' && FLOW === 'ORDER') {
    const cart = {};
    for (const it of data.items || []) {
      const n = +it.n, q = +it.q;
      if (n >= 1 && n <= S.ITEMS.length && q >= 1 && q <= 50) cart[n] = (cart[n] || 0) + q;
    }
    if (Object.keys(cart).length) {
      problem = cartProblem(cart);
      if (!problem) {
        const online = !/cash|cod/i.test(String(data.payment || 'cash'));
        order = {
          cart, phone,
          address: String(data.address || '-'),
          name: String(data.name || '-'),
          payment: online ? 'Online' : cashLabel(),
          payNote: online ? 'screenshot/PAID from customer, please verify' : '',
        };
      }
    }
  }

  if (problem) {
    // do not send the AI text that promised the order; tell the customer the real problem instead
    await send(sock, chat, problem);
    h.push({ role: 'assistant', content: problem });
    aiHistory.set(chat, h);
    return true;
  }

  if (visible) await send(sock, chat, visible);
  h.push({ role: 'assistant', content: visible || 'OK' });
  aiHistory.set(chat, h);

  if (order) {
    await finalizeOrder(sock, chat, order);
  } else if (data && kind === 'BOOKING' && FLOW === 'BOOKING') {
    const svc = +data.service;
    if (svc >= 1 && svc <= S.ITEMS.length) {
      await finalizeBooking(sock, chat, { service: svc, when: String(data.when || '-'), name: String(data.name || '-'), phone });
    }
  }
  return true;
}

// ------------------------- main handler -------------------------
// after the menu is shown the step-by-step flow is ready for item numbers (used when AI is off or down)
function enterListStep(s) {
  if (s.step !== 'IDLE') return;
  if (FLOW === 'ORDER') s.step = 'ORDERING';
  else if (FLOW === 'BOOKING') s.step = 'B_SERVICE';
}

async function handle(sock, chat, phone, text, isMedia) {
  const s = getS(chat);
  if (phone) s.phone = phone;
  const raw = (text || '').trim();
  const l = raw.toLowerCase();
  const first = !welcomed.has(chat);
  let justWelcomed = false;

  // shop closed (set STORE_OPEN = NO in the Admin Sheet)
  if (!S.STORE_OPEN) {
    welcomed.add(chat);
    return send(sock, chat, closedText());
  }

  // cancel at any step
  if (!first && (l === '0' || l === 'cancel' || l === 'cancel order' || l === 'cancel booking')) {
    resetS(chat);
    aiHistory.delete(chat);
    return send(sock, chat, `❌ Cancelled. No problem! 😊\nReply *MENU* anytime to start again.`);
  }

  // first message from this number: welcome
  if (first) {
    welcomed.add(chat);
    await send(sock, chat, welcomeText());
    justWelcomed = true;
    if (l === '1' || l === 'menu' || l === 'services') {
      s.menuShown = true;
      enterListStep(s);
      return send(sock, chat, menuText());
    }
    if (!isRealQuestion(raw)) return;
  }

  if (GROQ_KEY) {
    // menu shortcut: "menu" any time, "1" only the first time (later "1" may be a quantity)
    if (!justWelcomed && (l === 'menu' || l === 'services' || (l === '1' && !s.menuShown && s.step === 'IDLE'))) {
      s.menuShown = true;
      enterListStep(s);
      return send(sock, chat, menuText());
    }
    const msg = codesToText(raw) || raw;
    const ok = await aiConverse(sock, chat, phone, msg, isMedia);
    if (ok) return;
    // AI is down: let the step-by-step flow take over (item codes like 1x2, 5 start an order)
    if (s.step === 'IDLE' && FLOW === 'ORDER' && codesToText(raw)) s.step = 'ORDERING';
  }

  // backup: step-by-step flow
  if (justWelcomed) return;
  await converse(sock, chat, phone, text, isMedia);
}

// ------------------------- message plumbing -------------------------
function unwrap(msg) {
  let c = msg;
  for (let i = 0; i < 4; i++) {
    if (c && c.ephemeralMessage) c = c.ephemeralMessage.message;
    else if (c && c.viewOnceMessage) c = c.viewOnceMessage.message;
    else if (c && c.viewOnceMessageV2) c = c.viewOnceMessageV2.message;
    else if (c && c.documentWithCaptionMessage) c = c.documentWithCaptionMessage.message;
    else break;
  }
  return c || {};
}

const locks = new Map();
function runLocked(chat, fn) {
  const prev = locks.get(chat) || Promise.resolve();
  const next = prev.then(() => fn()).catch((e) => logErr('[HANDLER ERROR]', e));
  locks.set(chat, next);
  next.then(() => { if (locks.get(chat) === next) locks.delete(chat); });
  return next;
}

async function onMessage(sock, m) {
  const key = m.key || {};
  if (!m.message || key.fromMe) return;
  const rjid = key.remoteJid || '';
  if (!rjid || rjid === 'status@broadcast' || rjid.endsWith('@g.us') || rjid.endsWith('@newsletter') || rjid.endsWith('@broadcast')) return;

  if (key.id) {
    if (seen.has(key.id)) return;
    seen.add(key.id);
    if (seen.size > 3000) seen.delete(seen.values().next().value);
  }

  const alt = key.remoteJidAlt;
  let chat = rjid;
  if (rjid.endsWith('@lid') && alt && alt.endsWith('@s.whatsapp.net')) chat = alt;
  const phoneJid = [alt, rjid].find((j) => j && j.endsWith('@s.whatsapp.net'));
  const phone = phoneJid ? phoneJid.split('@')[0] : '';

  const c = unwrap(m.message);
  if (c.protocolMessage || c.reactionMessage || c.pollUpdateMessage) return;
  const text =
    c.conversation ||
    (c.extendedTextMessage && c.extendedTextMessage.text) ||
    (c.imageMessage && c.imageMessage.caption) ||
    (c.videoMessage && c.videoMessage.caption) ||
    (c.documentMessage && c.documentMessage.caption) ||
    '';
  const isMedia = !!(c.imageMessage || c.documentMessage);

  await runLocked(chat, async () => {
    try {
      await handle(sock, chat, phone, text, isMedia);
    } catch (e) {
      logErr('[FLOW ERROR]', e);
      await send(sock, chat, `Sorry, something went wrong 🙏 Reply *MENU* to start again or call ${S.CALL_PHONE}.`);
      resetS(chat);
      aiHistory.delete(chat);
    }
  });
}

// ===== BOOT =====
let currentSock = null;
let startTimer = null;
function scheduleStart(ms) {
  if (startTimer) return;
  startTimer = setTimeout(() => {
    startTimer = null;
    start().catch((e) => {
      logErr('[START ERROR]', e);
      scheduleStart(4000);
    });
  }, ms);
}

function pairingNumber() {
  for (const cand of [S.BOT_NUMBER, process.env.BOT_NUMBER]) {
    const n = toIntl(cand);
    if (validIntl(n)) return n;
  }
  return '';
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
  });
  currentSock = sock;
  let pairingRequested = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (sock !== currentSock) return;
    const { connection, lastDisconnect, qr } = u;

    if (qr && !sock.authState.creds.registered) {
      console.log('QR LINK: https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(qr));
      try { qrcode.generate(qr, { small: true }); } catch (e) { /* ignore */ }
      if (!pairingRequested) {
        pairingRequested = true;
        const num = pairingNumber();
        if (!num) {
          console.log('[WARN] BOT_NUMBER is not valid (need 03XXXXXXXXX). Put it in the Admin Sheet (BOT_NUMBER) or the BOT_NUMBER secret. Use the QR link above meanwhile.');
        } else {
          setTimeout(async () => {
            for (let i = 1; i <= 5; i++) {
              try {
                const code = await sock.requestPairingCode(num);
                const pretty = String(code).match(/.{1,4}/g).join('-');
                console.log('PAIRING CODE: ' + pretty);
                return;
              } catch (e) {
                console.log('[PAIRING ERROR] try ' + i + ':', e && e.message ? e.message : e);
                await new Promise((r) => setTimeout(r, 3000));
              }
            }
          }, 1000);
        }
      }
    }

    if (connection === 'open') {
      console.log(`✅ ${S.BUSINESS_NAME} bot is LIVE (flow: ${FLOW}, AI: ${GROQ_KEY ? 'Groq ON' : 'OFF (no key)'}, items: ${S.ITEMS.length}, doc: ${S.DOC_TEXT ? 'yes' : 'no'})`);
    }

    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : undefined;
      console.log('[CONN] closed, code:', code);
      if (code === DisconnectReason.loggedOut) {
        console.log('[CONN] Logged out. Clearing session and starting fresh pairing...');
        try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
      scheduleStart(4000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (sock !== currentSock || type !== 'notify') return;
    for (const m of messages) {
      try { await onMessage(sock, m); } catch (e) { logErr('[UPSERT ERROR]', e); }
    }
  });
}

process.on('unhandledRejection', (e) => logErr('[UNHANDLED]', e));
process.on('uncaughtException', (e) => logErr('[UNCAUGHT]', e));

(async () => {
  console.log(`Starting WhatsApp bot...`);
  await loadAll();
  console.log(`Business: ${S.BUSINESS_NAME} | city: ${S.CITY} | flow: ${FLOW} | AI key: ${GROQ_KEY ? 'set' : 'MISSING'}`);
  setInterval(() => { loadAll().catch(() => {}); }, 3 * 60 * 1000);
  try { await start(); }
  catch (e) {
    logErr('[START ERROR]', e);
    scheduleStart(4000);
  }
})();
