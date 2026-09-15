'use strict';
/* SiteDesk caller app. Static frontend, GitHub is the database.
   Data repo: iamnottaiiii/sitedesk-data via api.github.com.
   Lead catalog: https://bjvfi.com/sites.json (no auth).
   Auth: shared data token (config.js) + per-user PBKDF2 passwords in users.json.
   The token is never logged or displayed. Passwords and hashes are never logged. */

/* ================= pure helpers (node-testable) ================= */

function fmtNum(n){ try{ return Number(n).toLocaleString('en-US'); }catch(e){ return String(n); } }
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function digitsOnly(s){ return String(s||'').replace(/\D/g,''); }
function hasPhone(p){ return digitsOnly(p).length >= 7; }

function b64encode(bytes){
  let bin='';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for(let i=0;i<b.length;i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}
function b64decodeToBytes(b64){
  const bin = atob(String(b64).replace(/\s/g,''));
  const out = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Lead catalog entries from bjvfi.com/sites.json use SHORT keys as the primary
   format: {"s": slug, "n": name, "c": category, "p": phone, "a": address}.
   Long keys are kept only as fallbacks. */
function normalizeLead(e){
  e = e || {};
  const slug = e.s || e.slug || e.id || '';
  const name = e.n || e.name || e.business_name || '';
  const phone = e.p || e.phone || '';
  const category = e.c || e.category || '';
  const address = e.a || e.address || '';
  const url = e.url || e.site_url || e.u || '';
  return {
    slug: String(slug), name: String(name), phone: String(phone),
    category: String(category), address: String(address), url: String(url),
  };
}

function siteUrlFor(lead){
  if(lead.url) return lead.url;
  return 'https://bjvfi.com/' + lead.slug + '/';
}

function telHref(phone){ return 'tel:+' + digitsOnly(phone); }

function smsHref(phone, body){
  return 'sms:+' + digitsOnly(phone) + '?body=' + encodeURIComponent(String(body||''));
}

function directionsHref(address){
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(String(address||''));
}

var CLAIM_TTL_MS = 45 * 60 * 1000;
function claimExpired(claim, nowMs){
  if(!claim || !claim.claim_expires_at) return false;
  /* In-build and sold leads never expire back to the queue. */
  if(claim.status === 'build' || claim.status === 'sold') return false;
  return (nowMs == null ? Date.now() : nowMs) >= Number(claim.claim_expires_at);
}

function fmtCountdown(ms){
  if(ms <= 0) return 'expired';
  const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000);
  if(m >= 60) return Math.floor(m/60) + 'h ' + (m%60) + 'm left';
  return m + 'm ' + (s < 10 ? '0' : '') + s + 's left';
}

function capFeed(items, max){
  const arr = Array.isArray(items) ? items.slice() : [];
  return arr.slice(0, max == null ? 200 : max);
}

function ghErrorMessage(status, action){
  const a = action || 'request';
  if(status === 401) return 'Token rejected (401). Check the shared token in config.js is valid and scoped to the data repo.';
  if(status === 403) return 'Forbidden (403). The token may be rate limited or lack Contents write access on the data repo.';
  if(status === 404) return 'Not found (404). ' + a + ' hit a missing file or repo.';
  if(status === 422) return 'Already taken (422). Someone claimed this lead first.';
  return 'GitHub error ' + status + ' during ' + a + '.';
}

function shuffle(arr, rand){
  const a = arr.slice();
  const r = rand || Math.random;
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(r()*(i+1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

var PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function genPassword(len){
  len = len || 16;
  const out = [];
  const rnd = (typeof crypto !== 'undefined' && crypto.getRandomValues)
    ? crypto.getRandomValues(new Uint8Array(len)) : null;
  for(let i=0;i<len;i++){
    const n = rnd ? rnd[i] : Math.floor(Math.random()*256);
    out.push(PW_ALPHABET[n % PW_ALPHABET.length]);
  }
  return out.join('');
}

function getSubtle(){
  if(typeof crypto !== 'undefined' && crypto.subtle) return crypto.subtle;
  try{ return require('crypto').webcrypto.subtle; }catch(e){ return null; }
}

/* Format: pbkdf2$<iterations>$<salt-b64>$<hash-b64>, SHA-256, 256-bit key. */
async function pbkdf2Hash(password, iterations){
  const subtle = getSubtle();
  const iters = iterations || 600000;
  const salt = new Uint8Array(16);
  if(typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(salt);
  else require('crypto').randomFillSync(salt);
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({name:'PBKDF2', salt: salt, iterations: iters, hash:'SHA-256'}, key, 256);
  return 'pbkdf2$' + iters + '$' + b64encode(salt) + '$' + b64encode(new Uint8Array(bits));
}

async function pbkdf2Verify(password, stored){
  const m = /^pbkdf2\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored||''));
  if(!m) return false;
  const subtle = getSubtle();
  const iters = parseInt(m[1],10);
  if(!(iters >= 1000 && iters <= 2000000)) return false;
  const salt = b64decodeToBytes(m[2]);
  const want = b64decodeToBytes(m[3]);
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({name:'PBKDF2', salt: salt, iterations: iters, hash:'SHA-256'}, key, 256);
  const got = new Uint8Array(bits);
  if(got.length !== want.length) return false;
  let diff = 0;
  for(let i=0;i<got.length;i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

function nowISO(){ return new Date().toISOString(); }
function uid(prefix){
  const r = Math.random().toString(36).slice(2,8);
  return (prefix||'id') + '_' + Date.now().toString(36) + r;
}

/* Sales copy. Static, guide only. */
function salesLine(){
  return 'Building the site is free. Hosting and management is $27/month.';
}
function smsDraft(businessName, callerName, siteUrl){
  return 'Hi ' + businessName + ', this is ' + callerName +
    ' with BJ VFI. We built you a free preview site: ' + siteUrl +
    '. Worth a 2-min look?';
}
function callScriptText(businessName, callerName, siteUrl){
  return 'Hi, I\'m ' + callerName + ', from bjvfi, we build websites for businesses and we built ' +
    businessName + ' a website at ' + siteUrl +
    '. We used information I could find publicly, and could add things you want to it, to make it as you want. ' +
    'The building is free, and we\'ll manage and host them for $27/monthly. Thanks for your time \uD83D\uDE01';
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { esc: esc, digitsOnly: digitsOnly, hasPhone: hasPhone,
    normalizeLead: normalizeLead, siteUrlFor: siteUrlFor, telHref: telHref,
    smsHref: smsHref, directionsHref: directionsHref, claimExpired: claimExpired,
    fmtCountdown: fmtCountdown, capFeed: capFeed, ghErrorMessage: ghErrorMessage,
    shuffle: shuffle, genPassword: genPassword, pbkdf2Hash: pbkdf2Hash,
    pbkdf2Verify: pbkdf2Verify, uid: uid, salesLine: salesLine,
    smsDraft: smsDraft, callScriptText: callScriptText };
}

/* ================= GitHub data layer (only network besides bjvfi.com) ================= */

var GH_API = 'https://api.github.com/repos/iamnottaiiii/sitedesk-data';
var CATALOG_URL = 'https://bjvfi.com/sites.json';
var MAX_ACTIVE_CLAIMS = 5;
var FEED_CAP = 200;

function ghHeaders(){
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + SITEDESK_DATA_TOKEN,
    'Content-Type': 'application/json'
  };
}

async function ghFetch(path, opts){
  opts = opts || {};
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timeoutMs = opts.timeout || 30000;
  let timer = null;
  if(ctrl) timer = setTimeout(function(){ try{ ctrl.abort(); }catch(e){} }, timeoutMs);
  let res;
  try{
    res = await fetch(GH_API + path, {
      method: opts.method || 'GET',
      cache: 'no-store',
      headers: ghHeaders(),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined
    });
  }catch(e){
    if(timer) clearTimeout(timer);
    if(e && e.name === 'AbortError'){
      throw new Error('Network timed out during ' + (opts.action || ('GitHub ' + (opts.method || 'GET') + ' ' + path)) + '. Check your connection and retry.');
    }
    throw e;
  }
  if(timer) clearTimeout(timer);
  const text = await res.text();
  let json = null;
  try{ json = text ? JSON.parse(text) : null; }catch(e){ json = null; }
  if(!res.ok){
    const err = new Error(ghErrorMessage(res.status, opts.action || ('GitHub ' + (opts.method||'GET') + ' ' + path)));
    err.status = res.status;
    throw err;
  }
  return json;
}

/* Read a JSON file from the repo. Returns {data, sha} or null when missing. */
async function ghGetJson(path){
  try{
    const file = await ghFetch('/contents/' + path + '?ref=main', {action:'read ' + path});
    const raw = b64decodeToBytes(file.content || '');
    return { data: JSON.parse(new TextDecoder().decode(raw)), sha: file.sha };
  }catch(e){
    if(e.status === 404) return null;
    throw e;
  }
}

/* Write a JSON file. sha null = create-only (422 when taken). */
async function ghPutJson(path, obj, sha, message){
  const body = { message: message || ('sitedesk: update ' + path),
    content: b64encode(new TextEncoder().encode(JSON.stringify(obj, null, 2))) };
  if(sha) body.sha = sha;
  return ghFetch('/contents/' + path, { method:'PUT', body: body, action:'save ' + path });
}

async function ghDeleteFile(path, sha){
  return ghFetch('/contents/' + path, {
    method:'DELETE',
    body: { message: 'sitedesk: delete ' + path, sha: sha },
    action:'delete ' + path
  });
}

var treeCache = null;
async function ghTree(){
  if(treeCache) return treeCache;
  const t = await ghFetch('/git/trees/main?recursive=1', {action:'list repo tree'});
  treeCache = (t.tree || []).map(function(n){ return n.path; });
  return treeCache;
}
function treePaths(prefix){
  if(!treeCache) return [];
  return treeCache.filter(function(p){ return p.indexOf(prefix) === 0; });
}
function clearTreeCache(){ treeCache = null; }

/* ================= state ================= */

var state = {
  user: null,
  tab: 'queue',
  catalog: [],
  catalogAt: 0,
  claimsBySlug: {},
  treeSlugs: null,
  myClaims: [],
  myIntakes: [],
  feed: [],
  feedMaxTs: 0,
  unread: 0,
  q: '', cat: '', hasPhoneOnly: false,
  boardOrder: [],
  boardPage: 0,
  mineQ: '', mineStatus: 'all', meSlug: null,
  userQ: '', userStatus: '',
  adminSec: 'users',
  intakeStatusFilter: 'all',
  users: null, usersSha: null,
  booted: false,
  /* Unsaved builder inputs (built site URL / payment link) per intake, so a
     re-render (e.g. tapping a status chip) never wipes what was typed. */
  draftBuild: {},
};

var LS_SESSION = 'sitedesk_session_v1';
var LS_LASTREAD = 'sitedesk_lastread_v1';
var LS_NOTIF_ASKED = 'sitedesk_notif_asked_v1';

/* ================= session ================= */

function loadSession(){
  try{
    const s = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
    if(s && s.username && s.exp && s.exp > Date.now()) return s;
  }catch(e){}
  return null;
}
function saveSession(u){
  localStorage.setItem(LS_SESSION, JSON.stringify({
    username: u.username, role: u.role, name: u.name, exp: Date.now() + 7*24*3600*1000
  }));
}
function clearSession(){ localStorage.removeItem(LS_SESSION); }

function lastReadAt(){
  try{ return Number(localStorage.getItem(LS_LASTREAD) || 0) || 0; }catch(e){ return 0; }
}
function setLastRead(ts){ try{ localStorage.setItem(LS_LASTREAD, String(ts)); }catch(e){} }

var LS_DISMISSED = 'sitedesk_dismissed_v1';
function dismissedKey(){
  return LS_DISMISSED + '_' + (state.user && state.user.username ? state.user.username : 'anon');
}
function getDismissed(){
  try{
    var k = dismissedKey();
    var a = JSON.parse(localStorage.getItem(k) || 'null');
    if(!Array.isArray(a)){
      /* One-time migration from the old device-global key. */
      a = JSON.parse(localStorage.getItem(LS_DISMISSED) || '[]');
      if(Array.isArray(a) && a.length) localStorage.setItem(k, JSON.stringify(a));
    }
    return Array.isArray(a) ? a : [];
  }catch(e){ return []; }
}
function isDismissed(id){
  if(!id) return false;
  return getDismissed().indexOf(id) !== -1;
}
function dismissNotif(id){
  if(!id) return;
  var a = getDismissed();
  if(a.indexOf(id) === -1) a.push(id);
  if(a.length > 300) a = a.slice(a.length - 300);
  try{ localStorage.setItem(dismissedKey(), JSON.stringify(a)); }catch(e){}
  saveDismissedServer();
}
/* Server-side dismissed list, so dismissals follow the account across devices. */
async function loadDismissedServer(){
  if(!state.user || !state.user.username) return;
  if(state.dismissedLoaded) return;
  state.dismissedLoaded = true;
  try{
    const rec = await ghGetJson('dismissed/' + state.user.username + '.json');
    if(rec && Array.isArray(rec.data)){
      const merged = getDismissed();
      rec.data.forEach(function(id){ if(id && merged.indexOf(id) === -1) merged.push(id); });
      try{ localStorage.setItem(dismissedKey(), JSON.stringify(merged.slice(-300))); }catch(e){}
    }
  }catch(e){}
}
async function saveDismissedServer(){
  if(!state.user || !state.user.username) return;
  try{
    const rec = await ghGetJson('dismissed/' + state.user.username + '.json');
    const serverIds = rec && Array.isArray(rec.data) ? rec.data : [];
    const merged = getDismissed();
    serverIds.forEach(function(id){ if(id && merged.indexOf(id) === -1) merged.push(id); });
    const trimmed = merged.slice(-300);
    try{ localStorage.setItem(dismissedKey(), JSON.stringify(trimmed)); }catch(e){}
    await ghPutJson('dismissed/' + state.user.username + '.json', trimmed, rec ? rec.sha : null,
      'sitedesk: dismissed notifications @' + state.user.username);
  }catch(e){ /* local dismissal stands; sync is best-effort */ }
}
function recountUnread(){
  var lr = lastReadAt();
  state.unread = state.feed.filter(function(n){
    return feedItemVisible(n) && !isDismissed(n.id) && (new Date(n.created_at || 0).getTime() || 0) > lr;
  }).length;
}

/* ================= ui primitives ================= */

var toastTimer = null;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = String(msg);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('show'); }, 2600);
}

/* Generic modal. showModal(html) renders content, closeModal() dismisses. */
function showModal(html){ openModal(html); }

function openModal(html){
  const root = document.getElementById('modal-root');
  root.innerHTML = '<div class="modal-back" id="modal-back"><div class="modal" role="dialog" aria-modal="true">' +
    html + '</div></div>';
  document.getElementById('modal-back').addEventListener('click', function(e){
    if(e.target.id === 'modal-back') closeModal();
  });
}
function closeModal(){ document.getElementById('modal-root').innerHTML = ''; }

async function copyText(text, label){
  try{
    await navigator.clipboard.writeText(String(text));
    toast((label || 'Copied') + ' to clipboard');
  }catch(e){
    const ta = document.createElement('textarea');
    ta.value = String(text);
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); toast((label || 'Copied') + ' to clipboard'); }
    catch(e2){ toast('Copy failed, select manually'); }
    document.body.removeChild(ta);
  }
}

function badge(s){
  return '<span class="badge ' + esc(s||'') + '">' + esc(s || 'none') + '</span>';
}

function fmtTime(ts){
  try{ return new Date(ts).toLocaleString(); }catch(e){ return ''; }
}

/* ================= feed / notifications ================= */

function feedItemVisible(item){
  const a = item && item.audience;
  if(a === 'all') return true;
  if(state.user && a === state.user.username) return true;
  if(state.user && (state.user.role === 'admin' || state.user.role === 'head') &&
     (a === 'admin' || a === 'head' || a === 'staff')) return true;
  if(state.user && state.user.role === 'builder' && a === 'staff') return true;
  return false;
}

/* Poll the feed so alerts pop up on the device even while the app sits idle. */
function startFeedPoll(){
  try{ if(state.feedPoll) clearInterval(state.feedPoll); }catch(e){}
  state.feedPoll = setInterval(function(){
    if(!state.user) return;
    /* No alert polling while the tab is hidden: it only burns API calls.
       The next tick after the user comes back catches up. */
    if(typeof document !== 'undefined' && document.hidden) return;
    fetchFeed(true).catch(function(){});
  }, 30000);
}
function stopFeedPoll(){
  try{ if(state.feedPoll) clearInterval(state.feedPoll); }catch(e){}
  state.feedPoll = null;
}

async function fetchFeed(announce){
  let rec = null;
  try{ rec = await ghGetJson('feed.json'); }catch(e){ toast(e.message); return; }
  const items = capFeed(rec && rec.data ? rec.data : [], FEED_CAP);
  const prevMax = state.feedMaxTs;
  let maxTs = 0;
  items.forEach(function(n){ const t = new Date(n.created_at || 0).getTime() || 0; if(t > maxTs) maxTs = t; });
  state.feed = items;
  if(maxTs > state.feedMaxTs) state.feedMaxTs = maxTs;
  recountUnread();
  if(announce && prevMax){
    const fresh = items.filter(function(n){
      return feedItemVisible(n) && (new Date(n.created_at || 0).getTime() || 0) > prevMax;
    }).slice(0, 3);
    fresh.forEach(function(n){ notifyUser(n.title, n.body || ''); });
  }
  renderBell();
}

function notifyUser(title, body){
  toast(title);
  try{
    if(typeof Notification !== 'undefined' && Notification.permission === 'granted'){
      new Notification(String(title), { body: String(body || '').slice(0, 120), icon: 'icon.svg', tag: 'sitedesk-' + String(title).slice(0,40) });
    }
  }catch(e){}
}

async function postEvent(audience, title, body, link){
  let rec = null;
  try{ rec = await ghGetJson('feed.json'); }catch(e){ toast(e.message); return false; }
  const items = capFeed(rec && rec.data ? rec.data : [], FEED_CAP);
  items.unshift({ id: uid('ev'), audience: audience, title: title, body: body || '',
    link: link || '', created_at: nowISO() });
  try{
    await ghPutJson('feed.json', capFeed(items, FEED_CAP), rec ? rec.sha : null, 'sitedesk: feed event');
  }catch(e){ toast(e.message); return false; }
  await fetchFeed(true);
  return true;
}

/* True when a save failed only because someone (or a double tap) already
   saved first: the second write hit a stale SHA. Callers re-fetch and check
   whether their change is already applied, then continue silently. */
function isConflictError(e){
  return !!e && (e.status === 409 || e.status === 422);
}

function openLeadModal(slug){
  const claim = (state.myClaims || []).find(function(c){ return c.slug === slug; });
  if(!claim){ toast('Lead not found.'); return; }
  showModal('<div style="text-align:right;margin-bottom:8px"><button class="btn ghost sm" id="modal-close" type="button">Close</button></div>' + leadCard(claim));
  wireLeadCard(claim);
  const mc = document.getElementById('modal-close');
  if(mc) mc.addEventListener('click', closeModal);
}

/* Jump straight to whatever an alert points at: lead:<slug>, intake:<id>, tab:profile. */
function goAlertLink(link){
  if(!link) return;
  closeModal();
  if(link.indexOf('lead:') === 0){
    state.tab = 'mine';
    state.pendingLeadSlug = link.slice(5);
    renderApp();
  } else if(link.indexOf('intake:') === 0){
    if(!canInbox()){ toast('You do not have builder access.'); return; }
    state.tab = 'inbox';
    state.pendingIntakeId = link.slice(7);
    renderApp();
  } else if(link === 'tab:profile'){
    state.tab = 'profile';
    renderApp();
  }
}

function renderBell(){
  const b = document.getElementById('btn-bell');
  if(!b) return;
  b.className = 'bell' + (state.unread ? ' has-unread' : '');
  b.innerHTML = (state.unread ? '<span class="dot"></span>' : '') + (state.unread ? state.unread : 'Alerts');
}

function maybeNotifGate(){
  try{
    if(typeof Notification === 'undefined') return;
    if(Notification.permission !== 'default') return;
    if(localStorage.getItem(LS_NOTIF_ASKED)) return;
  }catch(e){ return; }
  const wrap = document.createElement('div');
  wrap.className = 'notif-gate';
  wrap.innerHTML = '<div class="panel"><h2>Turn on notifications</h2>' +
    '<p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:14px">Enable notifications ' +
    'so you get a popup on this device when an admin approves you or a builder updates your intake.</p>' +
    '<div class="row"><button class="btn" id="notif-yes" type="button">Enable</button>' +
    '<button class="btn ghost" id="notif-no" type="button">Not now</button></div></div>';
  document.body.appendChild(wrap);
  function done(){
    try{ localStorage.setItem(LS_NOTIF_ASKED, '1'); }catch(e){}
    wrap.remove();
  }
  wrap.querySelector('#notif-yes').addEventListener('click', async function(){
    try{ await Notification.requestPermission(); }catch(e){}
    done();
    ensurePushSubscribed();
    renderApp();
  });
  wrap.querySelector('#notif-no').addEventListener('click', done);
}

/* ================= web push (closed-app notifications) ================= */
function urlB64ToU8(str){
  str = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while(str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Subscribes this device for push and saves the subscription. Only runs when
   notification permission is already granted; it never prompts by itself. */
async function ensurePushSubscribed(){
  try{
    if(typeof Notification === 'undefined') return;
    if(!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if(typeof VAPID_PUBLIC_KEY === 'undefined' || !VAPID_PUBLIC_KEY) return;
    if(!state.user || !state.user.username) return;
    if(Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if(!sub){
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(VAPID_PUBLIC_KEY) });
    }
    await savePushSub(sub.toJSON());
  }catch(e){ /* push is best-effort */ }
}

async function savePushSub(sj){
  if(!sj || !sj.endpoint || !state.user) return;
  const username = state.user.username;
  for(let attempt = 0; attempt < 2; attempt++){
    let rec = null;
    try{ rec = await ghGetJson('push_subs.json'); }catch(e){ rec = null; }
    const subs = (rec && rec.data && typeof rec.data === 'object') ? rec.data : {};
    const mine = Array.isArray(subs[username]) ? subs[username] : [];
    const entry = { endpoint: sj.endpoint, keys: sj.keys || {}, updated_at: nowISO() };
    const ix = mine.findIndex(function(x){ return x && x.endpoint === entry.endpoint; });
    if(ix >= 0) mine[ix] = entry; else mine.push(entry);
    subs[username] = mine.slice(-5);
    try{
      await ghPutJson('push_subs.json', subs, rec ? rec.sha : null, 'sitedesk: push subscription ' + username);
      return;
    }catch(e){
      if(!isConflictError(e)) return;
    }
  }
}

/* ================= catalog + claims ================= */

/* ============ queue leads: one small file, 20 at a time ============ */
/* The queue shows 20 leads at a time from a single 189KB file holding 2,000
   scattered leads (100 pages). That is the entire download. Previous/Next
   page through them; nothing else is ever fetched. */
var QUEUE_URL = 'https://bjvfi.com/sitedesk/data/queue.json';

async function fetchCatalog(){
  if(state.catalog.length && Date.now() - state.catalogAt < 10*60*1000) return state.catalog;
  state.catalog = [];
  state.boardOrder = [];
  state.boardPage = 0;
  const r = await fetch(QUEUE_URL);
  if(!r.ok) throw new Error('Could not load leads.');
  const arr = await r.json();
  (Array.isArray(arr) ? arr : []).forEach(function(e){
    const l = normalizeLead(e);
    if(l.slug) state.catalog.push(l);
  });
  state.catalogAt = Date.now();
  return state.catalog;
}

/* Full load, throttled, with progress. Only used for explicit text search,
   the one action that needs every lead. Shared promise so concurrent callers
   do not double-download. */


async function refreshTree(){
  clearTreeCache();
  const paths = await ghTree();
  state.treeSlugs = paths.filter(function(p){ return p.indexOf('claims/') === 0 && p.slice(-5) === '.json' && p !== 'claims/index.json'; })
    .map(function(p){ return p.slice(7, -5); });
}

async function getClaim(slug, quiet){
  if(state.claimsBySlug[slug] !== undefined) return state.claimsBySlug[slug];
  let rec = null;
  try{ rec = await ghGetJson('claims/' + slug + '.json'); }catch(e){ if(!quiet) toast(e.message); return null; }
  const claim = rec ? rec.data : null;
  if(claim) claim._sha = rec.sha;
  state.claimsBySlug[slug] = claim;
  return claim;
}

/* ============ claim index: one read instead of one per claimed lead ============ */
/* claims/index.json maps slug -> {c: claimer, e: claim_expires_at, s: status}.
   The queue and my-leads reads use this single file; every claim write updates
   it. If the index ever drifts from the repo tree it rebuilds itself. */
var claimIndexCache = null;
var claimIndexSha = null;
var claimIndexAt = 0;

async function getClaimIndex(force){
  if(!force && claimIndexCache && Date.now() - claimIndexAt < 60000) return claimIndexCache;
  let rec = null;
  try{ rec = await ghGetJson('claims/index.json'); }catch(e){ rec = null; }
  claimIndexCache = (rec && rec.data && typeof rec.data === 'object') ? rec.data : {};
  claimIndexSha = rec ? rec.sha : null;
  claimIndexAt = Date.now();
  return claimIndexCache;
}

function indexEntryFor(claim){
  return { c: claim.claimer || '', e: Number(claim.claim_expires_at) || 0, s: claim.status || 'claimed' };
}

function indexTaken(entry, nowMs){
  if(!entry || !entry.c) return false;
  /* In-build and sold leads never expire back to the queue. */
  if(entry.s === 'build' || entry.s === 'sold') return true;
  return (nowMs == null ? Date.now() : nowMs) < Number(entry.e);
}

/* Apply a mutation to the index with conflict retry. Uses the in-memory copy
   when fresh, refetches when stale or on conflict. Never throws. */
async function updateClaimIndex(mutator){
  for(let attempt = 0; attempt < 3; attempt++){
    if(attempt > 0 || !claimIndexCache || Date.now() - claimIndexAt >= 60000){
      await getClaimIndex(true);
    }
    const before = JSON.stringify(claimIndexCache);
    try{ mutator(claimIndexCache); }catch(e){ return false; }
    if(JSON.stringify(claimIndexCache) === before) return true;
    try{
      const res = await ghPutJson('claims/index.json', claimIndexCache, claimIndexSha, 'sitedesk: claim index');
      if(res && res.content && res.content.sha){ claimIndexSha = res.content.sha; claimIndexAt = Date.now(); }
      else { claimIndexSha = null; claimIndexAt = 0; }
      return true;
    }catch(e){
      if(!isConflictError(e)) return false;
    }
  }
  return false;
}

/* Slow path, only on drift: rebuild the whole index from the claim files. */
async function rebuildClaimIndex(){
  await getClaimIndex(true);
  const idx = {};
  const jobs = (state.treeSlugs || []).map(function(s){
    return getClaim(s, true).then(function(c){
      if(c && c.claimer) idx[s] = indexEntryFor(c);
    }).catch(function(){});
  });
  await Promise.all(jobs);
  for(const k in claimIndexCache) delete claimIndexCache[k];
  for(const k in idx) claimIndexCache[k] = idx[k];
  try{
    const res = await ghPutJson('claims/index.json', claimIndexCache, claimIndexSha, 'sitedesk: rebuild claim index');
    if(res && res.content && res.content.sha){ claimIndexSha = res.content.sha; claimIndexAt = Date.now(); }
    else { claimIndexSha = null; claimIndexAt = 0; }
  }catch(e){}
  return claimIndexCache;
}

/* Make sure the index matches the repo tree (self-healing on drift). */
async function ensureClaimIndex(){
  if(!state.treeSlugs) await refreshTree();
  await getClaimIndex();
  const drifted = state.treeSlugs.some(function(s){ return !claimIndexCache[s]; });
  if(drifted){ await rebuildClaimIndex(); return; }
  const orphans = [];
  for(const k in claimIndexCache){
    if(state.treeSlugs.indexOf(k) === -1) orphans.push(k);
  }
  /* The deletes must happen inside the mutator so updateClaimIndex sees the
     change and actually pushes it to GitHub (its no-change shortcut skips
     the write when the mutator is a no-op). */
  if(orphans.length) await updateClaimIndex(function(idx){
    orphans.forEach(function(k){ delete idx[k]; });
  });
}

/* Resolve which slugs are open: no claim file, or claim expired. */
async function resolveOpenSet(slugs){
  await ensureClaimIndex();
  const nowMs = Date.now();
  const taken = {};
  for(let i = 0; i < slugs.length; i++){
    if(indexTaken(claimIndexCache[slugs[i]], nowMs)) taken[slugs[i]] = true;
  }
  return taken;
}

function catalogBySlug(){
  const m = {};
  state.catalog.forEach(function(l){ m[l.slug] = l; });
  return m;
}

async function refreshMyClaims(){
  state.myClaims = [];
  await ensureClaimIndex();
  /* Narrow to my slugs via the index first: one read per own claim file
     instead of one per claim file in the whole repo. */
  const nowMs = Date.now();
  const mineSlugs = [];
  for(const s in claimIndexCache){
    const e = claimIndexCache[s];
    if(e && e.c === state.user.username && (e.s === 'build' || e.s === 'sold' || nowMs < Number(e.e))){
      mineSlugs.push(s);
    }
  }
  const mine = [];
  for(const slug of mineSlugs){
    const c = await getClaim(slug);
    if(c && c.claimer === state.user.username && !claimExpired(c)) mine.push(c);
  }
  mine.sort(function(a,b){ return (b.claimed_at||0) - (a.claimed_at||0); });
  state.myClaims = mine;
  if(state.meSlug && !mine.some(function(c){ return c.slug === state.meSlug; })) state.meSlug = null;
  if(!state.meSlug && mine.length) state.meSlug = mine[0].slug;
}

async function refreshMyIntakes(){
  state.myIntakes = [];
  const paths = treePaths('intakes/').filter(function(p){ return p.slice(-5) === '.json'; });
  for(const p of paths){
    try{
      const rec = await ghGetJson(p);
      if(rec && rec.data && rec.data.claimer === state.user.username) state.myIntakes.push(rec.data);
    }catch(e){}
  }
}

function activeClaimCount(){
  return state.myClaims.filter(function(c){ return ['claimed','interested'].includes(c.status); }).length;
}

/* ================= auth ================= */

async function loadUsers(){
  let rec = null;
  try{ rec = await ghGetJson('users.json'); }catch(e){ throw e; }
  state.users = rec && rec.data ? rec.data : {};
  state.usersSha = rec ? rec.sha : null;
}

function renderHome(){
  document.getElementById('app').innerHTML =
    '<header class="top"><div class="brand">sitedesk<div class="brand-sub">bjvfi</div></div></header>' +
    '<div class="main auth-main"><div class="card" style="text-align:center;padding:40px 24px">' +
    '<div class="brand-sub" style="font-size:13px;letter-spacing:3px;margin-bottom:12px">bjvfi</div>' +
    '<h1 style="font-size:28px;margin:0 0 12px">Welcome to SiteDesk</h1>' +
    '<p class="muted" style="font-size:13px;margin-bottom:28px">The calling floor for the website crew.<br/>Grab leads, log outcomes, get paid.</p>' +
    '<button class="btn block" id="home-login" type="button" style="margin-bottom:10px">Login</button>' +
    '<button class="btn ghost block" id="home-signup" type="button">Create account</button>' +
    '<p class="muted" style="margin-top:18px;font-size:11px"><a href="#" id="home-legal" style="color:var(--amber)">Terms &amp; Policy</a></p>' +
    '</div></div>';
  document.getElementById('home-login').addEventListener('click', renderLogin);
  document.getElementById('home-signup').addEventListener('click', renderSignup);
  document.getElementById('home-legal').addEventListener('click', function(e){
    e.preventDefault(); renderLegalPublic();
  });
}

function renderLogin(){
  document.getElementById('app').innerHTML =
    '<header class="top"><div class="brand">sitedesk<div class="brand-sub">bjvfi</div></div></header>' +
    '<div class="main auth-main"><div class="card"><h2>Login</h2>' +
    '<p class="muted" style="margin-bottom:16px;font-size:12px">Welcome back.</p>' +
    '<div class="field"><label for="login-user">Username</label><input id="login-user" autocomplete="username" autocapitalize="none"/></div>' +
    '<div class="field"><label for="login-pass">Password</label><input id="login-pass" type="password" autocomplete="current-password"/></div>' +
    '<button class="btn block" id="login-go" type="button">Login</button>' +
    '<div class="err" id="login-err"></div>' +
    '<p class="muted" style="margin-top:14px;font-size:12px">Need an account? <a href="#" id="login-signup" style="color:var(--amber)">Create one</a> &middot; <a href="#" id="login-home" style="color:var(--amber)">Home</a></p>' +
    '</div></div>';
  document.getElementById('login-go').addEventListener('click', doLogin);
  document.getElementById('login-pass').addEventListener('keydown', function(e){
    if(e.key === 'Enter') doLogin();
  });
  document.getElementById('login-signup').addEventListener('click', function(e){
    e.preventDefault(); renderSignup();
  });
  document.getElementById('login-home').addEventListener('click', function(e){
    e.preventDefault(); renderHome();
  });
}

function renderSignup(){
  document.getElementById('app').innerHTML =
    '<header class="top"><div class="brand">sitedesk<div class="brand-sub">bjvfi</div></div></header>' +
    '<div class="main auth-main"><div class="card"><h2>Create account</h2>' +
    '<p class="muted" style="margin-bottom:16px;font-size:12px">Your admin approves new accounts before you can log in.</p>' +
    '<div class="field"><label>Your name *</label><input id="su-name" autocomplete="name"/></div>' +
    '<div class="field"><label>Username *</label><input id="su-user" autocapitalize="none" autocomplete="username" placeholder="lowercase, no spaces"/></div>' +
    '<div class="field"><label>Phone</label><input id="su-phone" type="tel" autocomplete="tel"/></div>' +
    '<div class="field"><label>Password * <span class="muted">(8+ characters)</span></label><input id="su-pass" type="password" autocomplete="new-password"/></div>' +
    '<div class="field"><label>Confirm password *</label><input id="su-pass2" type="password" autocomplete="new-password"/></div>' +
    '<button class="btn block" id="su-go" type="button">Create account</button>' +
    '<div class="err" id="su-err"></div>' +
    '<div class="field" style="margin-top:12px"><label class="checkrow"><input type="checkbox" id="su-agree-terms"/> <span>I agree to the <a href="#" id="su-terms" style="color:var(--amber)">Terms</a></span></label></div>' +
    '<div class="field"><label class="checkrow"><input type="checkbox" id="su-agree-policy"/> <span>I agree to the <a href="#" id="su-policy" style="color:var(--amber)">Policy</a></span></label></div>' +
    '<p class="muted" style="margin-top:14px;font-size:12px">Already have an account? <a href="#" id="su-login" style="color:var(--amber)">Log in</a> &middot; <a href="#" id="su-home" style="color:var(--amber)">Home</a></p>' +
    '</div></div>';
  document.getElementById('su-go').addEventListener('click', doSignup);
  document.getElementById('su-pass2').addEventListener('keydown', function(e){
    if(e.key === 'Enter') doSignup();
  });
  document.getElementById('su-login').addEventListener('click', function(e){
    e.preventDefault(); renderLogin();
  });
  document.getElementById('su-terms').addEventListener('click', function(e){
    e.preventDefault(); e.stopPropagation(); renderLegalPublic();
  });
  document.getElementById('su-policy').addEventListener('click', function(e){
    e.preventDefault(); e.stopPropagation(); renderLegalPublic();
  });
  document.getElementById('su-home').addEventListener('click', function(e){
    e.preventDefault(); renderHome();
  });
}

async function doSignup(){
  const err = document.getElementById('su-err');
  err.textContent = '';
  const name = (document.getElementById('su-name').value || '').trim();
  const username = (document.getElementById('su-user').value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'');
  const phone = (document.getElementById('su-phone').value || '').trim();
  const pw1 = document.getElementById('su-pass').value || '';
  const pw2 = document.getElementById('su-pass2').value || '';
  if(!name || !username){ err.textContent = 'Name and username are required.'; return; }
  if(username.length < 3){ err.textContent = 'Username must be at least 3 characters.'; return; }
  if(pw1.length < 8){ err.textContent = 'Password must be at least 8 characters.'; return; }
  if(pw1 !== pw2){ err.textContent = 'Passwords do not match.'; return; }
  const agreeT = document.getElementById('su-agree-terms').checked;
  const agreeP = document.getElementById('su-agree-policy').checked;
  if(!agreeT || !agreeP){ err.textContent = 'You must agree to the Terms and the Policy to create an account.'; return; }
  const btn = document.getElementById('su-go');
  btn.disabled = true; btn.textContent = 'Creating...';
  try{
    await loadUsers();
    if(state.users[username]){ err.textContent = 'That username is taken.'; return; }
    const pass = await pbkdf2Hash(pw1);
    state.users[username] = { name: name, role: 'caller', status: 'pending', phone: phone, pass: pass };
    await ghPutJson('users.json', state.users, state.usersSha, 'sitedesk: signup @' + username);
    document.getElementById('app').innerHTML =
      '<header class="top"><div class="brand">sitedesk<div class="brand-sub">bjvfi</div></div></header>' +
      '<div class="main auth-main"><div class="card"><h2>Request sent</h2>' +
      '<p style="margin:16px 0;font-size:13px">Account <b>@' + esc(username) + '</b> created. Your admin needs to approve it, then you can log in.</p>' +
      '<button class="btn block" id="su-done" type="button">Back to login</button>' +
      '</div></div>';
    document.getElementById('su-done').addEventListener('click', renderLogin);
  }catch(e){
    err.textContent = 'Could not create the account. Please try again.';
  }finally{
    btn.disabled = false; btn.textContent = 'Create account';
  }
}

async function doLogin(){
  const err = document.getElementById('login-err');
  err.textContent = '';
  const username = (document.getElementById('login-user').value || '').trim().toLowerCase();
  const password = document.getElementById('login-pass').value || '';
  if(!username || !password){ err.textContent = 'Enter your username and password.'; return; }
  const btn = document.getElementById('login-go');
  btn.disabled = true; btn.textContent = 'Checking...';
  try{
    await loadUsers();
    const u = state.users[username];
    if(!u){ err.textContent = 'No account found for that username.'; return; }
    const ok = await pbkdf2Verify(password, u.pass);
    if(!ok){ err.textContent = 'Wrong password.'; return; }
    if(u.status !== 'approved'){
      err.textContent = 'Account is ' + u.status + '. Ask your admin for approval.';
      return;
    }
    state.user = { username: username, name: u.name || username, role: u.role || 'caller', phone: u.phone || '' };
    saveSession(state.user);
    state.tab = state.user.role === 'builder' ? 'inbox' : 'queue';
    state.dismissedLoaded = false;
    await bootData(true);
    maybeNotifGate();
    ensurePushSubscribed();
    renderApp();
    startFeedPoll();
  }catch(e){
    err.textContent = e.message;
  }finally{
    btn.disabled = false; btn.textContent = 'Login';
    const pw = document.getElementById('login-pass');
    if(pw) pw.value = '';
  }
}

function logout(){
  stopFeedPoll();
  state.pendingLeadSlug = null;
  state.pendingIntakeId = null;
  clearSession();
  state.user = null; state.myClaims = []; state.myIntakes = [];
  state.feed = []; state.unread = 0; state.feedMaxTs = 0;
  state.claimsBySlug = {}; state.treeSlugs = null;
  state.dismissedLoaded = false;
  renderHome();
}

/* ================= shell ================= */

function isManager(){ return state.user && (state.user.role === 'admin' || state.user.role === 'head'); }
function canClaim(){ return state.user && (state.user.role === 'caller' || state.user.role === 'admin' || state.user.role === 'head'); }
function canInbox(){ return state.user && (state.user.role === 'builder' || state.user.role === 'admin' || state.user.role === 'head'); }

function tabDefs(){
  const u = state.user;
  if(!u) return [];
  const tabs = [];
  if(canClaim()){ tabs.push(['queue','Queue','\u2630'], ['mine','My leads','\u25CF']); }
  if(canInbox()) tabs.push(['inbox', u.role === 'builder' ? 'Builds' : 'Intakes', '\u25A3']);
  if(isManager()) tabs.push(['admin','Admin','\u25C6']);
  tabs.push(['notifs','Alerts', state.unread ? String(state.unread) : '\xB7']);
  tabs.push(['profile','Profile','\u25CE']);
  return tabs;
}

function notifBannerHtml(){
  let perm = '';
  try{
    if(typeof Notification === 'undefined') return '';
    perm = Notification.permission;
  }catch(e){ return ''; }
  /* The banner shows whenever notifications are not on (default or denied).
     Once permission is granted it disappears. */
  if(perm === 'granted') return '';
  const msg = perm === 'denied'
    ? 'Notifications are blocked for SiteDesk in this browser. Allow them in your browser site settings to get alerts on this device.'
    : 'Notifications are off. Turn them on for alerts on this device.';
  const btn = perm === 'denied' ? '' :
    '<button class="btn sm ghost" id="banner-notif" type="button">Enable</button>';
  return '<div class="notif-banner"><div class="row"><span class="muted" style="font-size:12px">' +
    msg + '</span>' + btn + '</div></div>';
}

function shell(content){
  const tabs = tabDefs();
  return '<header class="top">' +
    '<div class="brand">sitedesk<div class="brand-sub">bjvfi</div></div>' +
    '<div class="row">' +
      '<button class="bell' + (state.unread ? ' has-unread' : '') + '" id="btn-bell" type="button" aria-label="Notifications">' +
      (state.unread ? '<span class="dot"></span>' : '') + (state.unread ? state.unread : 'Alerts') + '</button>' +
      '<div class="nav-desktop">' + tabs.filter(function(t){ return t[0] !== 'notifs'; }).map(function(t){
        return '<button class="tab' + (state.tab === t[0] ? ' active' : '') +
          (t[0] === 'notifs' && state.unread ? ' unread-alert' : '') + '" data-tab="' + t[0] + '" type="button">' + t[1] + '</button>';
      }).join('') + '</div>' +
    '</div></header>' +
    '<main class="main">' + notifBannerHtml() + content + '</main>' +
    '<nav class="bottom-nav">' + tabs.map(function(t){
      return '<button class="' + (state.tab === t[0] ? 'active' : '') +
        (t[0] === 'notifs' && state.unread ? ' unread-alert' : '') + '" data-tab="' + t[0] + '" type="button">' +
        '<span class="ico">' + esc(t[2]) + '</span><span>' + esc(t[1]) + '</span></button>';
    }).join('') + '</nav>';
}

function statsRow(){
  const today = new Date().toISOString().slice(0,10);
  const claimedToday = state.myClaims.filter(function(c){ return (c.claimed_at||'').slice(0,10) === today; }).length;
  const interested = state.myClaims.filter(function(c){ return c.status === 'interested'; }).length;
  const intakes = state.myIntakes.length;
  const outcomes = state.myClaims.filter(function(c){ return !['claimed','interested'].includes(c.status); }).length;
  function stat(n,l){ return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>'; }
  return '<div class="statrow">' + stat(claimedToday,'Claimed today') + stat(interested,'Interested') +
    stat(intakes,'Intakes') + stat(outcomes,'Outcomes') + '</div>';
}

/* ================= queue ================= */

function allCategories(){
  const set = {};
  state.catalog.forEach(function(l){ if(l.category) set[l.category] = true; });
  return Object.keys(set).sort();
}

function filteredOpen(openTaken){
  const q = state.q.trim().toLowerCase();
  return state.catalog.filter(function(l){
    if(openTaken[l.slug]) return false;
    if(state.hasPhoneOnly && !hasPhone(l.phone)) return false;
    if(state.cat && l.category !== state.cat) return false;
    if(q){
      const hay = (l.name + ' ' + l.slug + ' ' + l.phone).toLowerCase();
      if(hay.indexOf(q) === -1) return false;
    }
    return true;
  });
}

function leadRowHtml(l){
  return '<div class="lead-row"><div>' +
    '<div class="lead-row-name">' + esc(l.name) + '</div>' +
    '</div><div class="row">' +
    '<a class="btn ghost sm" href="' + esc(siteUrlFor(l)) + '" target="_blank" rel="noopener">site</a>' +
    '<button class="btn sm" data-grab="' + esc(l.slug) + '" type="button">Grab</button>' +
    '</div></div>';
}

/* The set of taken (claimed and unexpired) slugs, cached in localStorage so the
   board can paint instantly from the last known state while fresh claim data
   loads in the background. */
function takenCacheLoad(){
  try{ return JSON.parse(localStorage.getItem('sd_taken_v1') || '{}'); }catch(e){ return {}; }
}
function takenCacheSave(t){
  try{ localStorage.setItem('sd_taken_v1', JSON.stringify(t)); }catch(e){}
}

function paintQueue(el, openTaken, syncing){
    const list = filteredOpen(openTaken);
    if(!state.boardOrder.length || state._boardKey !== boardKey()){
      state.boardOrder = shuffle(list.map(function(l){ return l.slug; }));
      state._boardKey = boardKey();
    }
    const active = activeClaimCount();
    const atCap = active >= MAX_ACTIVE_CLAIMS;
    const shown = state.boardOrder
      .map(function(s){ return state.catalog.find(function(l){ return l.slug === s; }); })
      .filter(Boolean)
      .slice(state.boardPage * 20, state.boardPage * 20 + 20);

    let html = statsRow();
    html += '<div class="row" style="justify-content:space-between;margin-bottom:14px"><div>' +
      '<h2 style="font-size:18px">Open leads</h2>' +
      '<p class="muted" style="font-size:12px">Unclaimed only \xB7 scattered \xB7 45 min claim \xB7 ' +
      '<strong>' + active + '/' + MAX_ACTIVE_CLAIMS + '</strong> claimed' +
      (syncing ? ' \xB7 updating&hellip;' : '') + '</p></div>' +
      '<button class="btn sm" id="btn-grab-random" type="button"' + (atCap ? ' disabled' : '') + '>Grab random</button></div>';
    if(atCap) html += '<p class="err" style="margin-bottom:12px">Claim cap reached (' + active + '/' + MAX_ACTIVE_CLAIMS + '). Release or finish an active lead first.</p>';
    html += '<p class="review-note"><strong>Review first.</strong> Open the business page and understand who they are, what they do, how they sound, before you call or send a message.</p>';
    html += '<div class="card"><h2>Board</h2><div class="filters">' +
      '<input id="queue-q" value="' + esc(state.q) + '" placeholder="Name or slug"/>' +
      '</div>';
    const nextAtEnd = (state.boardPage + 1) * 20 >= state.boardOrder.length;
    if(shown.length){
      html += '<div class="open-board">' + shown.map(leadRowHtml).join('') + '</div>' +
        '<p class="muted" style="font-size:11px;margin:10px 0">Showing ' + fmtNum(shown.length) + ' of ' + fmtNum(list.length) + ' open leads</p>' +
        '<div class="board-actions" style="display:flex;gap:8px">' +
        '<button class="btn ghost" style="flex:1" id="btn-prev-batch" type="button"' + (state.boardPage === 0 ? ' disabled' : '') + '>Previous 20</button>' +
        '<button class="btn ghost" style="flex:1" id="btn-next-batch" type="button"' + (nextAtEnd ? ' disabled' : '') + '>Next 20</button></div>';
    } else {
      html += '<div class="empty">No open leads.<br/><button class="btn" id="btn-grab-empty" type="button">Grab random</button></div>';
    }
    html += '</div>';
    html += '<div class="card script-card"><h2>Scripts</h2>' +
      '<p class="muted" style="font-size:12px;margin-bottom:8px;line-height:1.55">Guide only, adapt in your own words.</p>' +
      '<div class="copybox" id="sales-line">' + esc(salesLine()) + '</div>' +
      '<div class="row" style="margin-top:8px"><button class="btn ghost sm" data-copy="sales-line" type="button">Copy sales line</button></div>' +
      '<h3 style="margin-top:14px">SMS draft</h3>' +
      '<div class="copybox" id="sms-template">' + esc(smsDraft('<name>', '<caller>', '<url>')) + '</div>' +
      '<div class="row" style="margin-top:8px"><button class="btn ghost sm" data-copy="sms-template" type="button">Copy SMS template</button></div>' +
      '</div>';
    el.innerHTML = html;
    wireQueue(el);
}

/* Paint the board instantly from cache, then refresh the catalog and the claim
   set in the background. The old version awaited the whole network chain
   (catalog download, repo tree, one API request per claimed lead) before the
   first paint, which is why "Loading leads..." sat for seconds on mobile. */
async function renderQueueInto(el){
  let instant = state.catalog.length > 0;
  if(instant){
    try{ paintQueue(el, takenCacheLoad(), true); }
    catch(e){ instant = false; }
  }
  if(!instant) el.innerHTML = '<div class="card"><div class="empty">Loading leads...</div></div>';
  try{
    await fetchCatalog();
  }catch(e){
    if(!instant){
      el.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) +
        '<br/><button class="btn" id="btn-retry-queue" type="button">Retry</button></div></div>';
      const r = document.getElementById('btn-retry-queue');
      if(r) r.addEventListener('click', function(){ renderQueueInto(el); });
    }else{
      toast('Could not refresh leads. Showing saved copy.');
    }
    return;
  }
  instant = true;
  /* Search filters the leads already loaded, instantly, the same way the
     catalog page filters its in-memory list. The full catalog is never pulled
     on its own; a "Search all leads" button offers it explicitly. */
  /* Fresh catalog in hand: paint right away with the last known claim state,
     then resolve the real claim set without blocking the visible list. */
  try{
    const qEl = el.querySelector('#queue-q');
    if(qEl) state.q = qEl.value;
    state._lastTaken = takenCacheLoad();
    paintQueue(el, state._lastTaken, true);
  }catch(e){}
  try{
    const slugs = state.catalog.map(function(l){ return l.slug; });
    const taken = await resolveOpenSet(slugs);
    takenCacheSave(taken);
    state._lastTaken = taken;
    const qEl2 = el.querySelector('#queue-q');
    if(qEl2) state.q = qEl2.value;
    paintQueue(el, taken, false);
  }catch(e){
    try{
      const qEl3 = el.querySelector('#queue-q');
      if(qEl3) state.q = qEl3.value;
      state._lastTaken = takenCacheLoad();
      paintQueue(el, state._lastTaken, false);
    }catch(_){}
  }
}

function boardKey(){ return state.q + '|' + state.cat + '|' + (state.hasPhoneOnly ? 1 : 0); }

function wireQueue(el){
  const q = el.querySelector('#queue-q');
  const apply = function(){
    state.q = q ? q.value : '';
    state.boardPage = 0;
    state.boardOrder = [];
    renderQueueInto(el);
  };
  const fa = el.querySelector('#btn-filter');
  if(fa) fa.addEventListener('click', apply);
  if(q) q.addEventListener('keydown', function(e){ if(e.key === 'Enter') apply(); });
  /* Live filtering as you type (debounced), so typing alone narrows the board.
     Focus is restored after the re-render so typing is not interrupted. */
  if(q){
    let deb = null;
    q.addEventListener('input', function(){
      if(deb) clearTimeout(deb);
      deb = setTimeout(function(){
        apply();
        const nq = el.querySelector('#queue-q');
        if(nq){
          nq.focus();
          try{ nq.setSelectionRange(nq.value.length, nq.value.length); }catch(e){}
        }
      }, 350);
    });
  }
  el.querySelectorAll('[data-cat]').forEach(function(chip){
    chip.addEventListener('click', function(){
      state.cat = chip.getAttribute('data-cat');
      state.boardPage = 0;
      state.boardOrder = [];
      renderQueueInto(el);
    });
  });
  const hp = el.querySelector('#chip-phone');
  if(hp) hp.addEventListener('click', function(){
    state.hasPhoneOnly = !state.hasPhoneOnly;
    state.boardOrder = [];
    renderQueueInto(el);
  });
  const pb = el.querySelector('#btn-prev-batch');
  if(pb) pb.addEventListener('click', function(){
    if(state.boardPage > 0){
      state.boardPage--;
      const qEl = el.querySelector('#queue-q');
      if(qEl) state.q = qEl.value;
      paintQueue(el, state._lastTaken || {}, false);
      window.scrollTo(0, 0);
    }
  });
  const nb = el.querySelector('#btn-next-batch');
  if(nb) nb.addEventListener('click', function(){
    state.boardPage++;
    const qEl = el.querySelector('#queue-q');
    if(qEl) state.q = qEl.value;
    paintQueue(el, state._lastTaken || {}, false);
    window.scrollTo(0, 0);
  });
  el.querySelectorAll('[data-copy]').forEach(function(b){
    b.addEventListener('click', function(){
      const src = document.getElementById(b.getAttribute('data-copy'));
      if(src) copyText(src.textContent, 'Script');
    });
  });
  const gr = el.querySelector('#btn-grab-random') || el.querySelector('#btn-grab-empty');
  if(gr) gr.addEventListener('click', grabRandom);
}

/* Pre-grab preview: caller must open the business site, then wait 2 minutes, before grabbing. */
function showGrabPreview(slug){
  const bySlug = catalogBySlug();
  const l = bySlug[slug] || normalizeLead({ s: slug, n: slug, p: '' });
  const url = siteUrlFor(l);
  const WAIT_MS = 120000;
  let siteOpened = false;
  let deadline = 0;
  let iv = null;
  function fmt(s){ return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  let html = '<h2>Review before you grab</h2>' +
    '<p class="muted" style="font-size:13px;line-height:1.55;margin-bottom:14px">Study their site first: what they do, their services, their vibe, so you sound like you know them on the call. The timer gives you <strong>2 minutes</strong> to look, then the grab unlocks.</p>' +
    '<div style="font-size:15px;font-weight:600;margin-bottom:4px">' + esc(l.name) + '</div>' +
    (l.category ? '<div class="muted" style="font-size:12px;margin-bottom:2px">' + esc(l.category) + '</div>' : '') +
    (!hasPhone(l.phone) ? '<p class="muted" style="font-size:12px;margin-bottom:10px;line-height:1.55">No number on this lead? Open their site, it is usually listed there.</p>' : '') +
    (l.address ? '<div class="muted" style="font-size:12px;margin-bottom:10px">' + esc(l.address) + '</div>' : '<div style="margin-bottom:10px"></div>') +
    '<button class="btn block" id="grab-site-open" type="button" style="margin-bottom:10px">Open their site</button>' +
    '<div class="row" style="margin-top:14px">' +
    '<button class="btn ghost" id="grab-preview-cancel" type="button" style="flex:1">Cancel</button>' +
    '<button class="btn" id="grab-preview-confirm" type="button" style="flex:2" disabled>Open the site first</button>' +
    '</div>';
  showModal(html);
  const confirmBtn = document.getElementById('grab-preview-confirm');
  const openBtn = document.getElementById('grab-site-open');
  function stopTimer(){ if(iv){ clearInterval(iv); iv = null; } }
  function refresh(){
    if(!document.body.contains(confirmBtn)){ stopTimer(); return; }
    if(!siteOpened){ confirmBtn.disabled = true; confirmBtn.textContent = 'Open the site first'; return; }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if(left > 0){ confirmBtn.disabled = true; confirmBtn.textContent = 'Grab in ' + fmt(left); return; }
    stopTimer();
    confirmBtn.disabled = false; confirmBtn.textContent = 'Grab this lead';
  }
  openBtn.addEventListener('click', function(){
    window.open(url, '_blank', 'noopener');
    if(!siteOpened){
      siteOpened = true;
      deadline = Date.now() + WAIT_MS;
      openBtn.textContent = 'Site opened \u2713 Reopen';
      iv = setInterval(refresh, 1000);
    }
    refresh();
  });
  document.getElementById('grab-preview-cancel').addEventListener('click', function(){ stopTimer(); closeModal(); });
  confirmBtn.addEventListener('click', function(){
    stopTimer();
    closeModal();
    grabLead(slug);
  });
  refresh();
}

async function grabLead(slug){
  if(grabNeedsInstall()) return;
  if(activeClaimCount() >= MAX_ACTIVE_CLAIMS){ toast('Claim cap reached. Release a lead first.'); return; }
  const lead = state.catalog.find(function(l){ return l.slug === slug; });
  if(!lead){ toast('Lead not found in catalog.'); return; }
  const claim = {
    slug: slug, business_name: lead.name, phone: lead.phone,
    claimer: state.user.username, claimer_name: state.user.name,
    claimed_at: nowISO(), claim_expires_at: Date.now() + CLAIM_TTL_MS,
    status: 'claimed', note: '',
    timeline: [{ t: nowISO(), k: 'claimed', note: 'Claimed by ' + state.user.name }]
  };
  try{
    await ghPutJson('claims/' + slug + '.json', claim, null, 'sitedesk: claim ' + slug);
  }catch(e){
    toast(e.message);
    return;
  }
  clearTreeCache();
  await updateClaimIndex(function(idx){ idx[slug] = indexEntryFor(claim); });
  state.claimsBySlug[slug] = claim;
  if(state.treeSlugs && state.treeSlugs.indexOf(slug) === -1) state.treeSlugs.push(slug);
  toast('Claimed: ' + lead.name);
  state.boardOrder = [];
  await refreshMyClaims();
  state.meSlug = slug;
  state.tab = 'mine';
  renderApp();
}

async function grabRandom(){
  if(grabNeedsInstall()) return;
  if(activeClaimCount() >= MAX_ACTIVE_CLAIMS){ toast('Claim cap reached. Release a lead first.'); return; }
  toast('Finding a lead...');
  try{
    await fetchCatalog();
    if(!state.treeSlugs) await refreshTree();
    const taken = await resolveOpenSet(state.catalog.map(function(l){ return l.slug; }));
    const open = filteredOpen(taken);
    if(!open.length){ toast('No open leads match your filters.'); return; }
    await grabLead(open[Math.floor(Math.random()*open.length)].slug);
  }catch(e){ toast(e.message); }
}

/* ================= my leads ================= */

function claimTimerHtml(claim){
  const ms = Number(claim.claim_expires_at) - Date.now();
  const urgent = ms < 10*60*1000;
  return '<div class="timer' + (urgent ? ' urgent' : '') + '">Claim ' +
    (ms <= 0 ? 'expired' : 'expires in ' + esc(fmtCountdown(ms))) + '</div>';
}

function timelineHtml(claim){
  const tl = claim.timeline || [];
  if(!tl.length) return '<p class="muted" style="font-size:12px">No history yet.</p>';
  return '<ul class="timeline">' + tl.slice().reverse().map(function(ev){
    return '<li><div class="k">' + esc(ev.k || 'update') + '</div>' +
      (ev.note ? '<div>' + esc(ev.note) + '</div>' : '') +
      '<div class="t">' + esc(fmtTime(ev.t)) + '</div></li>';
  }).join('') + '</ul>';
}

var OUTCOMES = [
  ['interested','Interested'],
  ['not_interested','Not interested'],
  ['no_answer','No answer'],
  ['wrong_number','Wrong number'],
  ['do_not_call','Do not call'],
];

function leadCard(claim){
  const bySlug = catalogBySlug();
  const lead = bySlug[claim.slug] || normalizeLead({ s: claim.slug, n: claim.business_name || claim.slug, p: claim.phone || '' });
  const url = siteUrlFor(lead);
  const phoneOk = hasPhone(lead.phone);
  const draft = smsDraft(lead.name, state.user.name, url);
  const script = callScriptText(lead.name, state.user.name, url);
  const canRelease = ['claimed','interested'].indexOf(claim.status) !== -1;

  let html = '<div class="lead-title">' + esc(lead.name) + '</div>' +
    '<div class="row" style="margin:8px 0 10px">' + badge(claim.status) + '</div>' +
    ((claim.status === 'claimed' || claim.status === 'interested') ? claimTimerHtml(claim) : '');

  if(claim.status === 'build'){
    const intake = ((state.myIntakes || []).filter(function(x){ return x.slug === claim.slug; })[0]) || null;
    html += '<div class="card" style="margin:14px 0"><h2>Build status</h2>';
    if(intake){
      html += '<div class="row" style="margin:8px 0 10px">' + badge(intake.status) + '</div>';
      if(intake.builder_name){
        html += '<div style="font-size:13px;margin-bottom:6px"><strong>Builder:</strong> ' + esc(intake.builder_name) + '</div>';
        if(intake.builder_phone){
          const bt = 'Hi ' + intake.builder_name + ', checking on the ' + (intake.business || lead.name) + ' site build.';
          html += '<div class="phone-line"><span class="num">' + esc(intake.builder_phone) + '</span>' +
            '<a class="btn call sm" href="' + esc(telHref(intake.builder_phone)) + '">Call</a>' +
            '<a class="btn sms sm" href="' + esc(smsHref(intake.builder_phone, bt)) + '">Text</a></div>';
        }
      } else {
        html += '<p class="muted" style="font-size:12px;line-height:1.55">Sent to builders. A builder will pick it up soon.</p>';
      }
      if(intake.site_url){
        html += '<div class="row" style="margin:10px 0"><a class="btn sm" href="' + esc(intake.site_url) + '" target="_blank" rel="noopener">View built site</a></div>';
      }
      if(intake.status === 'ready' && intake.pay_link){
        html += '<div class="field"><label>Client payment link</label>' +
          '<div class="copybox" id="pay-link-text">' + esc(intake.pay_link) + '</div>' +
          '<div class="row" style="margin-top:8px"><button class="btn ghost sm" id="btn-copy-paylink" type="button">Copy link</button></div></div>' +
          '<p class="muted" style="font-size:12px;line-height:1.55">The site is built and the payment link is ready. Send it to the client, then mark this sold once they pay.</p>' +
          '<button class="btn block" id="btn-mark-sold" type="button">Mark sold</button>' +
          '<div class="err" id="sold-err"></div>';
      } else {
        html += '<p class="muted" style="font-size:12px;line-height:1.55">You can mark this sold once the builder submits the finished site and the client payment link.</p>';
      }
    } else {
      html += '<p class="muted" style="font-size:12px;line-height:1.55">Build details sent to builders.</p>';
    }
    html += '</div>';
  }

  if(claim.status === 'claimed'){
    html += '<p class="review-note"><strong>Know them first.</strong> Open their site and learn who they are before you call or text.</p>';
  }

  html += '<div class="card" style="margin:14px 0"><h2>Know them first</h2>' +
    '<p class="muted" style="font-size:12px;margin-bottom:10px;line-height:1.55">Everything you need before the call.</p>' +
    (lead.category ? '<div style="font-size:13px;margin-bottom:6px"><strong>Category:</strong> ' + esc(lead.category) + '</div>' : '') +
    (lead.address ? '<div style="font-size:13px;margin-bottom:6px"><strong>Address:</strong> ' + esc(lead.address) +
      ' <a href="' + esc(directionsHref(lead.address)) + '" target="_blank" rel="noopener">Directions</a></div>' : '') +
    '<div class="row" style="margin:8px 0">' +
      '<a class="btn sm" href="' + esc(url) + '" target="_blank" rel="noopener">Open site</a>' +
      '<button class="btn ghost sm" id="btn-copy-link" type="button">Copy site link</button></div>' +
    '<h3 style="margin-top:14px">Business phone</h3>' +
    '<div class="phone-line"><span class="num">' + (phoneOk ? esc(lead.phone) : 'No phone on file') + '</span>' +
    (phoneOk ? '<button class="btn ghost sm" id="btn-copy-phone" type="button">Copy phone</button>' : '') +
    (phoneOk && claim.status === 'claimed' ? '<a class="btn call sm" href="' + esc(telHref(lead.phone)) + '">Call</a>' : '') +
    '</div>' +
    (phoneOk ? '' : '<p class="muted" style="font-size:12px;margin-top:8px;line-height:1.55">No number on this lead? Open their site above, it is usually listed there.</p>') + '</div>';

  if(claim.status === 'claimed'){
    html += '<div class="card msg-card" style="margin:14px 0"><h2>Text / SMS</h2>' +
      '<p class="muted" style="font-size:12px;margin-bottom:10px;line-height:1.55">Guide only, adapt in your own words.</p>' +
      '<div class="copybox tall" id="draft-text">' + esc(draft) + '</div>' +
      '<div class="row" style="margin-top:12px">' +
      '<button class="btn" id="btn-copy-draft" type="button">Copy message</button>' +
      (phoneOk ? '<a class="btn sms" href="' + esc(smsHref(lead.phone, draft)) + '">Open SMS</a>' : '') +
      '</div></div>';
    html += '<div class="card script-card" style="margin:14px 0"><h2>Call script</h2>' +
      '<p class="muted" style="font-size:12px;margin-bottom:8px;line-height:1.55">Guide only, do not read it rigidly.</p>' +
      '<div class="copybox" id="call-script-text">' + esc(script) + '</div>' +
      '<div class="row" style="margin-top:8px"><button class="btn ghost sm" id="btn-copy-script" type="button">Copy call script</button></div>' +
      '<p class="muted" style="font-size:12px;margin-top:10px;line-height:1.55">' + esc(salesLine()) + '</p></div>';
  }

  if(claim.status === 'claimed'){
    html += '<div class="card" style="margin:18px 0"><h2>Log outcome</h2>' +
      precallNoteHtml() +
      '<p class="muted" style="font-size:12px;margin-bottom:12px;line-height:1.55">When they are <strong>interested</strong>, save that, then you get the <strong>Add build details</strong> form.</p>' +
      '<div class="field"><label>Outcome</label><div class="pick compact" id="outcome-pick">' +
      OUTCOMES.map(function(o, i){
        return '<button type="button" class="' + (i === 0 ? 'on' : '') + '" data-outcome="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>Note</label><textarea id="outcome-note" placeholder="What did they say?"></textarea></div>' +
      '<button class="btn block" id="btn-outcome" type="button">Save outcome</button>' +
      '<div class="err" id="outcome-err"></div></div>';
  }

/* Red pre-call checklist: what to ask for on the call, entered after hanging up. */
function precallNoteHtml(){
  return '<div class="precall-note"><strong>BEFORE THE CALL, READ THIS.</strong><br/>' +
    'If they sound interested, ask for all of this while you have them on the phone, then fill in the form after you hang up:' +
    '<ul><li>Brand colors (main color + accent color)</li>' +
    '<li>Logo (ask them to text or email it to you)</li>' +
    '<li>Full list of services</li>' +
    '<li>Photos: storefront, work, team</li>' +
    '<li>Which pages and features they want on the site</li>' +
    '<li>Business hours</li>' +
    '<li>Email address</li>' +
    '<li>Best contact info and social media links</li></ul></div>';
}

  if(claim.status === 'interested'){
    html += '<div class="card" id="intake-panel" style="margin:18px 0"><h2>Add build details</h2>' +
      precallNoteHtml() +
      '<p class="muted" style="font-size:12px;margin-bottom:14px;line-height:1.55">They are interested. Capture everything the builder needs.</p>' +
      '<div class="field"><label>Business *</label><input id="in-business" value="' + esc(lead.name) + '"/></div>' +
      '<div class="grid2"><div class="field"><label>Contact name *</label><input id="in-contact" placeholder="Who you spoke with"/></div>' +
      '<div class="field"><label>Phone *</label><input id="in-phone" type="tel" value="' + esc(lead.phone) + '"/></div></div>' +
      '<div class="field"><label>Email</label><input id="in-email" type="email" inputmode="email" placeholder="owner@business.com"/></div>' +
      '<div class="field"><label>Brand colors</label><input id="in-colors" placeholder="e.g. navy blue + gold"/></div>' +
      '<div class="field"><label>What they want *</label><textarea id="in-wants" placeholder="Pages, features, vibe, must-haves"></textarea></div>' +
      '<div class="field"><label>Notes</label><textarea id="in-notes" placeholder="Anything else for the builder"></textarea></div>' +
      '<div class="field"><label>Photos & files</label>' +
      '<input id="in-files" type="file" multiple accept="image/*,.pdf,.doc,.docx,.txt"/>' +
      '<div class="file-previews" id="in-files-preview"></div>' +
      '<p class="muted" style="font-size:11px;margin-top:8px;line-height:1.5">Site photos, logo, menus, anything the builder needs. Images are resized automatically.</p></div>' +
      '<button class="btn block" id="btn-intake" type="button">Submit to builders</button>' +
      '<div class="err" id="intake-err"></div></div>';
  }

  html += '<div class="row" style="margin-top:8px">' +
    (canRelease ? '<button class="btn danger sm" id="btn-release" type="button">Release lead</button>' : '') +
    '</div>';

  html += '<div style="margin:20px 0;height:1px;background:var(--sep)"></div>' +
    '<h3>History</h3>' + timelineHtml(claim);
  return html;
}

function wireLeadCard(claim){
  const lead = (catalogBySlug()[claim.slug]) || normalizeLead({ s: claim.slug, n: claim.business_name || claim.slug, p: claim.phone || '' });
  const url = siteUrlFor(lead);
  function on(id, fn){
    const el = document.getElementById(id);
    if(el) el.addEventListener('click', fn);
  }
  on('btn-copy-link', function(){ copyText(url, 'Site link'); });
  on('btn-copy-phone', function(){ copyText(lead.phone, 'Phone'); });
  on('btn-copy-draft', function(){
    const d = document.getElementById('draft-text');
    if(d) copyText(d.textContent, 'Message');
  });
  on('btn-copy-script', function(){
    const d = document.getElementById('call-script-text');
    if(d) copyText(d.textContent, 'Script');
  });
  const pick = document.getElementById('outcome-pick');
  if(pick){
    pick.querySelectorAll('[data-outcome]').forEach(function(b){
      b.addEventListener('click', function(){
        pick.querySelectorAll('[data-outcome]').forEach(function(x){ x.classList.toggle('on', x === b); });
      });
    });
  }
  on('btn-outcome', function(){ saveOutcome(claim); });
  on('btn-release', function(){ releaseLead(claim); });
  on('btn-intake', function(){ submitIntake(claim); });
  on('btn-copy-paylink', function(){
    const t = document.getElementById('pay-link-text');
    if(t) copyText(t.textContent, 'Payment link');
  });
  on('btn-mark-sold', function(){ markSold(claim); });
  const fi = document.getElementById('in-files');
  if(fi) fi.addEventListener('change', function(){ previewIntakeFiles(fi); });
}

/* Thumbnails for the intake file picker. */
function previewIntakeFiles(input){
  const prev = document.getElementById('in-files-preview');
  if(!prev) return;
  prev.innerHTML = '';
  const files = input.files ? Array.prototype.slice.call(input.files) : [];
  files.slice(0, 12).forEach(function(f){
    if(f.type.indexOf('image/') === 0){
      const img = document.createElement('img');
      img.alt = f.name;
      try{ img.src = URL.createObjectURL(f); }catch(e){}
      prev.appendChild(img);
    } else {
      const d = document.createElement('div');
      d.className = 'fp-file';
      d.textContent = f.name;
      prev.appendChild(d);
    }
  });
}

function sanitizeFileName(name){
  const parts = String(name || 'file').split('.');
  const ext = parts.length > 1 ? parts.pop().toLowerCase().replace(/[^a-z0-9]/g,'') : '';
  let base = parts.join('.').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'file';
  if(base.length > 40) base = base.slice(0, 40);
  return base + (ext ? '.' + ext : '');
}

/* Downscale an image file to max 1600px, returns {base64, name}. */
function downscaleImage(file){
  return new Promise(function(resolve, reject){
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function(){
      try{
        URL.revokeObjectURL(url);
        const max = 1600;
        let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        const scale = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = c.toDataURL('image/jpeg', 0.85);
        resolve({ base64: dataUrl.split(',')[1], name: sanitizeFileName(file.name).replace(/\.[a-z0-9]+$/, '') + '.jpg' });
      }catch(e){ reject(e); }
    };
    img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

function readFileBase64(file){
  return file.arrayBuffer().then(function(buf){ return b64encode(new Uint8Array(buf)); });
}

/* Upload intake attachments to the data repo. Returns [{name, path}]. */
async function uploadIntakeFiles(intakeId, input, onProgress){
  const files = input && input.files ? Array.prototype.slice.call(input.files) : [];
  const out = [];
  let done = 0;
  for(const f of files.slice(0, 12)){
    if(f.size > 15 * 1024 * 1024){ toast('Skipped (too big): ' + f.name); continue; }
    try{
      let base64, name;
      if(f.type.indexOf('image/') === 0){
        const r = await downscaleImage(f);
        base64 = r.base64; name = r.name;
      } else {
        base64 = await readFileBase64(f);
        name = sanitizeFileName(f.name);
      }
      const path = 'intakes/' + intakeId + '/' + name;
      await ghFetch('/contents/' + path, { method: 'PUT', timeout: 120000,
        body: { message: 'sitedesk: intake file ' + intakeId + '/' + name, content: base64 },
        action: 'upload ' + name });
      out.push({ name: name, path: path });
    }catch(e){
      toast('Upload failed: ' + f.name);
    }
    done++;
    if(onProgress) onProgress(done, Math.min(files.length, 12));
  }
  return out;
}

/* Fetch a repo file's base64 content (for private-repo attachments). */
async function ghGetFileBase64(path){
  const file = await ghFetch('/contents/' + path + '?ref=main', { action: 'read ' + path });
  return { content: (file.content || '').replace(/\s/g,''), name: path.split('/').pop() };
}

function mimeForFile(name){
  const ext = String(name || '').split('.').pop().toLowerCase();
  if(ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if(ext === 'png') return 'image/png';
  if(ext === 'gif') return 'image/gif';
  if(ext === 'webp') return 'image/webp';
  if(ext === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

/* Tap an intake attachment to view it. */
async function viewIntakeFile(path, name){
  toast('Loading file...');
  try{
    const f = await ghGetFileBase64(path);
    const mime = mimeForFile(name);
    if(mime.indexOf('image/') === 0){
      showModal('<div style="text-align:right;margin-bottom:8px"><button class="btn ghost sm" id="modal-close" type="button">Close</button></div>' +
        '<img src="data:' + mime + ';base64,' + f.content + '" style="width:100%;border-radius:12px" alt="' + esc(name) + '"/>');
    } else {
      const bin = b64decodeToBytes(f.content);
      const blob = new Blob([bin], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      toast('Download started');
      return;
    }
    const mc = document.getElementById('modal-close');
    if(mc) mc.addEventListener('click', closeModal);
  }catch(e){ toast(e.message); }
}

async function saveOutcome(claim){
  const btn = document.getElementById('btn-outcome');
  if(btn){ btn.disabled = true; btn.textContent = 'Saving...'; }
  const err = document.getElementById('outcome-err');
  err.textContent = '';
  const pick = document.querySelector('#outcome-pick .on');
  const outcome = pick ? pick.getAttribute('data-outcome') : 'interested';
  const note = (document.getElementById('outcome-note').value || '').trim();
  claim.status = outcome;
  claim.note = note;
  claim.timeline = claim.timeline || [];
  claim.timeline.push({ t: nowISO(), k: 'outcome: ' + outcome, note: note });
  function fail(msg){
    err.textContent = msg;
    if(btn){ btn.disabled = false; btn.textContent = 'Save outcome'; }
  }
  try{
    const rec = await ghGetJson('claims/' + claim.slug + '.json');
    await ghPutJson('claims/' + claim.slug + '.json', claim, rec ? rec.sha : null, 'sitedesk: outcome ' + claim.slug);
  }catch(e){
    /* Double tap: the first tap already saved. Verify and move on silently. */
    if(isConflictError(e)){
      try{
        const rec2 = await ghGetJson('claims/' + claim.slug + '.json');
        if(rec2 && rec2.data && rec2.data.status === outcome){ /* already saved, continue */ }
        else { fail(e.message); return; }
      }catch(e2){ fail(e.message); return; }
    } else { fail(e.message); return; }
  }
  if(outcome !== 'interested'){
    await releaseLead(claim, true);
    return;
  }
  toast('Saved: interested');
  await updateClaimIndex(function(idx){ idx[claim.slug] = indexEntryFor(claim); });
  state.claimsBySlug[claim.slug] = claim;
  state.meSlug = claim.slug;
  /* Advance straight to the build-details form instead of leaving the caller waiting. */
  openLeadModal(claim.slug);
  setTimeout(function(){
    const p = document.getElementById('intake-panel');
    if(p && p.scrollIntoView) p.scrollIntoView({ block: 'start' });
  }, 80);
}

async function releaseLead(claim, silent){
  try{
    const rec = await ghGetJson('claims/' + claim.slug + '.json');
    if(rec) await ghDeleteFile('claims/' + claim.slug + '.json', rec.sha);
  }catch(e){
    if(!silent) toast(e.message);
    return;
  }
  clearTreeCache();
  await updateClaimIndex(function(idx){ delete idx[claim.slug]; });
  delete state.claimsBySlug[claim.slug];
  if(state.treeSlugs) state.treeSlugs = state.treeSlugs.filter(function(s){ return s !== claim.slug; });
  state.boardOrder = [];
  await refreshMyClaims();
  closeModal();
  if(!silent) toast('Lead released');
  renderApp();
}

async function submitIntake(claim){
  const err = document.getElementById('intake-err');
  err.textContent = '';
  const v = function(id){ return (document.getElementById(id).value || '').trim(); };
  const business = v('in-business'), contact = v('in-contact'), phone = v('in-phone');
  const email = v('in-email'), wants = v('in-wants'), notes = v('in-notes');
  const brandColors = v('in-colors');
  if(!business || !contact || !phone || !wants){ err.textContent = 'Business, contact, phone, and what they want are required.'; return; }
  const btn = document.getElementById('btn-intake');
  if(btn){ btn.disabled = true; btn.textContent = 'Submitting...'; }
  /* One intake per lead: a double tap reuses the same record instead of
     creating a duplicate or showing a GitHub error. */
  const intakeId = 'intake-' + claim.slug;
  const intake = {
    id: intakeId, slug: claim.slug, business: business, contact_name: contact,
    phone: phone, email: email, wants: wants, notes: notes, brand_colors: brandColors,
    claimer: state.user.username, claimer_name: state.user.name,
    status: 'open', created_at: nowISO(), files: []
  };
  const fileInput = document.getElementById('in-files');
  const nFiles = fileInput && fileInput.files ? Math.min(fileInput.files.length, 12) : 0;
  function fail(msg){
    err.textContent = msg;
    if(btn){ btn.disabled = false; btn.textContent = 'Submit to builders'; }
  }
  async function finishAlreadySaved(){
    /* Everything is already saved (e.g. double tap): move on silently. */
    await postEvent('staff', 'Intake: ' + business, state.user.name + ' submitted build details for ' + business + '.', 'intake:' + intakeId);
    clearTreeCache();
    delete state.claimsBySlug[claim.slug];
    await refreshMyClaims();
    await refreshMyIntakes();
    toast('Sent to builders');
    closeModal();
    renderApp();
  }
  try{
    if(nFiles){
      err.textContent = '';
      intake.files = await uploadIntakeFiles(intake.id, fileInput, function(d, total){
        if(btn) btn.textContent = 'Uploading ' + d + '/' + total + '...';
      });
      if(btn) btn.textContent = 'Submitting...';
    }
    try{
      await ghPutJson('intakes/' + intake.id + '.json', intake, null, 'sitedesk: intake ' + intake.id);
    }catch(e){
      if(isConflictError(e)){
        const existing = await ghGetJson('intakes/' + intake.id + '.json');
        if(existing && existing.data && existing.data.claimer === state.user.username){
          /* Already submitted: keep the existing record, no error shown. */
        } else { throw e; }
      } else { throw e; }
    }
    claim.status = 'build';
    claim.intake_id = intake.id;
    claim.timeline = claim.timeline || [];
    claim.timeline.push({ t: nowISO(), k: 'intake submitted', note: 'Build details sent to builders' });
    try{
      const rec = await ghGetJson('claims/' + claim.slug + '.json');
      if(rec) await ghPutJson('claims/' + claim.slug + '.json', claim, rec.sha, 'sitedesk: build ' + claim.slug);
    }catch(e){
      if(isConflictError(e)){
        const rec2 = await ghGetJson('claims/' + claim.slug + '.json');
        if(rec2 && rec2.data && rec2.data.status === 'build' && rec2.data.intake_id === intake.id){
          await finishAlreadySaved();
          return;
        }
      }
      throw e;
    }
  }catch(e){
    fail(e.message);
    return;
  }
  try{
    await postEvent('staff', 'Intake: ' + business, state.user.name + ' submitted build details for ' + business + '.', 'intake:' + intake.id);
    clearTreeCache();
    await updateClaimIndex(function(idx){ idx[claim.slug] = indexEntryFor(claim); });
    delete state.claimsBySlug[claim.slug];
    await refreshMyClaims();
    await refreshMyIntakes();
    toast('Sent to builders');
  }catch(e){
    /* best-effort refresh: still re-render below so the button never sticks */
  }
  /* The intake form lives in a modal that renderApp() does not touch, so close
     it explicitly - otherwise the button sits stuck on "Submitting...". */
  closeModal();
  renderApp();
}

/* Caller marks a lead sold. Only allowed once the builder submitted the
   finished site and the client payment link (intake is Ready). */
async function markSold(claim){
  const btn = document.getElementById('btn-mark-sold');
  if(btn){ btn.disabled = true; btn.textContent = 'Marking sold...'; }
  const err = document.getElementById('sold-err');
  if(err) err.textContent = '';
  function restore(){ if(btn){ btn.disabled = false; btn.textContent = 'Mark sold'; } }
  try{
    let intakeId = claim.intake_id;
    if(!intakeId){
      const found = ((state.myIntakes || []).filter(function(x){ return x.slug === claim.slug; })[0]) || null;
      if(found) intakeId = found.id;
    }
    if(!intakeId){ if(err) err.textContent = 'Build record not found.'; restore(); return; }
    const rec = await ghGetJson('intakes/' + intakeId + '.json');
    if(!rec){ if(err) err.textContent = 'Build record not found.'; restore(); return; }
    const intake = rec.data;
    if(intake.status !== 'ready' || !intake.pay_link){
      if(err) err.textContent = 'Not ready yet. The builder still needs to submit the finished site and the client payment link.';
      restore();
      return;
    }
    intake.status = 'done';
    intake.sold_at = nowISO();
    intake.sold_by = state.user.username;
    try{
      await ghPutJson('intakes/' + intakeId + '.json', intake, rec.sha, 'sitedesk: intake ' + intakeId + ' sold');
    }catch(e){
      if(isConflictError(e)){
        const rec2 = await ghGetJson('intakes/' + intakeId + '.json');
        if(rec2 && rec2.data && rec2.data.status === 'done'){ /* already sold, continue silently */ }
        else { throw e; }
      } else { throw e; }
    }
    const crec = await ghGetJson('claims/' + claim.slug + '.json');
    if(crec){
      const c = crec.data;
      if(c.status !== 'sold'){
        c.status = 'sold';
        c.timeline = c.timeline || [];
        c.timeline.push({ t: nowISO(), k: 'sold', note: 'Marked sold by ' + state.user.name });
        try{
          await ghPutJson('claims/' + claim.slug + '.json', c, crec.sha, 'sitedesk: sold ' + claim.slug);
        }catch(e){
          if(isConflictError(e)){
            const c2 = await ghGetJson('claims/' + claim.slug + '.json');
            if(!(c2 && c2.data && c2.data.status === 'sold')) throw e;
          } else { throw e; }
        }
      }
    }
    await postEvent('staff', 'Sold: ' + (claim.business_name || claim.slug),
      state.user.name + ' marked ' + (claim.business_name || claim.slug) + ' sold.', 'intake:' + intakeId);
    clearTreeCache();
    await updateClaimIndex(function(idx){ const e = indexEntryFor(claim); e.s = 'sold'; idx[claim.slug] = e; });
    delete state.claimsBySlug[claim.slug];
    await refreshMyClaims();
    await refreshMyIntakes();
    toast('Marked sold');
    /* The lead detail is a modal renderApp() does not touch: close it so the
       button cannot sit stuck on "Marking sold...". */
    closeModal();
    renderApp();
  }catch(e){ if(err) err.textContent = e.message; else toast(e.message); restore(); }
}

function paintMine(el){
  const q = state.mineQ.trim().toLowerCase();
  let list = state.myClaims.slice();
  if(state.mineStatus !== 'all') list = list.filter(function(c){ return c.status === state.mineStatus; });
  if(q) list = list.filter(function(c){
    return (c.business_name + ' ' + c.slug + ' ' + (c.phone||'')).toLowerCase().indexOf(q) !== -1;
  });
  let html = statsRow();
  html += '<div class="card"><h2>My leads' + (list.length ? ' \xB7 ' + list.length : '') + '</h2>' +
    '<div class="filters"><input id="mine-q" value="' + esc(state.mineQ) + '" placeholder="Search business or phone"/>' +
    '<div class="chiprow">' +
    [['all','All'],['claimed','Claimed'],['interested','Interested'],['build','In build'],['sold','Sold']].map(function(p){
      return '<button type="button" class="chip' + (state.mineStatus === p[0] ? ' on' : '') + '" data-mine-status="' + p[0] + '">' + p[1] + '</button>';
    }).join('') + '</div></div>';
  if(!list.length){
    html += '<div class="empty">No leads match.<br/><button class="btn" data-tab="queue" type="button">Grab from queue</button></div>';
  } else {
    html += '<div class="mine-list">' + list.map(function(c){
      return '<button type="button" class="mine-row" data-open-mine="' + esc(c.slug) + '">' +
        '<span class="mine-row-name">' + esc(c.business_name || c.slug) + '</span>' +
        '<span class="muted" style="font-size:11px">' + esc(c.status) + '</span></button>';
    }).join('') + '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
  el.querySelectorAll('[data-mine-status]').forEach(function(chip){
    chip.addEventListener('click', function(){
      state.mineStatus = chip.getAttribute('data-mine-status');
      renderMineInto(el);
    });
  });
  const mq = el.querySelector('#mine-q');
  if(mq) mq.addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ state.mineQ = mq.value; renderMineInto(el); }
  });
  el.querySelectorAll('[data-open-mine]').forEach(function(b){
    b.addEventListener('click', function(){
      openLeadModal(b.getAttribute('data-open-mine'));
    });
  });
  const meClaim = list.find(function(c){ return c.slug === state.meSlug; }) || list[0];
  if(meClaim) wireLeadCard(meClaim);
  /* Deep link from a tapped alert: open the lead straight away. */
  if(state.pendingLeadSlug){
    const slug = state.pendingLeadSlug;
    state.pendingLeadSlug = null;
    if(list.some(function(c){ return c.slug === slug; })) openLeadModal(slug);
  }
}

/* Same instant-paint pattern as the queue: show the last known list
   immediately, refresh quietly underneath. */
async function renderMineInto(el){
  let instant = !!state.mineLoaded;
  if(instant){
    try{ paintMine(el); }
    catch(e){ instant = false; }
  }
  if(!instant) el.innerHTML = '<div class="card"><div class="empty">Loading your leads...</div></div>';
  try{
    await fetchCatalog();
    await refreshMyClaims();
    await refreshMyIntakes();
  }catch(e){
    if(!instant){
      el.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) +
        '<br/><button class="btn" id="btn-retry-mine" type="button">Retry</button></div></div>';
      const r = document.getElementById('btn-retry-mine');
      if(r) r.addEventListener('click', function(){ renderMineInto(el); });
    }else{
      toast('Could not refresh your leads. Showing saved copy.');
    }
    return;
  }
  state.mineLoaded = true;
  const mqEl = el.querySelector('#mine-q');
  if(mqEl) state.mineQ = mqEl.value;
  try{ paintMine(el); }catch(e){}
}

/* ================= intakes (builder / admin) ================= */

async function loadIntakes(scope){
  const paths = treePaths('intakes/').filter(function(p){ return p.slice(-5) === '.json'; });
  const items = [];
  for(const p of paths){
    try{
      const rec = await ghGetJson(p);
      if(rec && rec.data){
        if(scope === 'mine' && rec.data.claimer !== state.user.username) continue;
        rec.data._path = p; rec.data._sha = rec.sha;
        items.push(rec.data);
      }
    }catch(e){}
  }
  items.sort(function(a,b){ return (b.created_at||'').localeCompare(a.created_at||''); });
  return items;
}

var INTAKE_STATUSES = [['open','Open'],['building','Building'],['ready','Ready'],['done','Done']];

async function renderIntakesInto(el){
  el.innerHTML = '<div class="card"><div class="empty">Loading intakes...</div></div>';
  let items = [];
  try{
    /* Always fetch a fresh tree: new intakes submitted while the app sits open
       must appear without a manual reload. */
    clearTreeCache();
    items = await loadIntakes('all');
  }
  catch(e){
    el.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) +
      '<br/><button class="btn" id="btn-retry-intakes" type="button">Retry</button></div></div>';
    const r = document.getElementById('btn-retry-intakes');
    if(r) r.addEventListener('click', function(){ renderIntakesInto(el); });
    return;
  }
  if(state.intakeStatusFilter !== 'all') items = items.filter(function(i){ return i.status === state.intakeStatusFilter; });
  let html = '<div class="card"><h2>' + (state.user.role === 'builder' ? 'Builds' : 'Intakes') +
    (items.length ? ' \xB7 ' + items.length : '') + '</h2>' +
    '<div class="chiprow" style="margin-bottom:12px">' +
    [['all','All'],['open','Open'],['building','Building'],['ready','Ready'],['done','Done']].map(function(p){
      return '<button type="button" class="chip' + (state.intakeStatusFilter === p[0] ? ' on' : '') + '" data-istatus="' + p[0] + '">' + p[1] + '</button>';
    }).join('') + '</div>';
  if(!items.length){
    html += '<div class="empty">No intakes yet.</div>';
  } else {
    html += items.map(function(i){
      return '<div class="card" id="intake-card-' + esc(i.id) + '" style="margin-bottom:10px;padding:14px">' +
        '<div class="row" style="justify-content:space-between;margin-bottom:8px"><div>' +
        '<div style="font-weight:600">' + esc(i.business || i.slug) + '</div>' +
        '<div class="muted" style="font-size:12px">' + esc(i.contact_name || '') +
        (i.phone ? ' \xB7 ' + esc(i.phone) : '') + '</div>' +
        '<div class="muted" style="font-size:11px">from ' + esc(i.claimer_name || i.claimer || '') +
        ' \xB7 ' + esc(fmtTime(i.created_at)) + '</div></div>' + badge(i.status) + '</div>' +
        '<div class="copybox" style="margin-bottom:10px">' + esc(i.wants || '') +
        (i.brand_colors ? '\n\nBrand colors: ' + esc(i.brand_colors) : '') +
        (i.notes ? '\n\nNotes: ' + esc(i.notes) : '') + '</div>' +
        (i.files && i.files.length ?
          '<div class="field" style="margin-bottom:10px"><label>Attached files (' + i.files.length + ')</label><div class="row">' +
          i.files.map(function(f){
            return '<button type="button" class="btn ghost sm" data-intake-file="' + esc(f.path) + '" data-intake-filename="' + esc(f.name) + '">\uD83D\uDCCE ' + esc(f.name) + '</button>';
          }).join('') + '</div></div>' : '') +
        '<div class="field" style="margin-bottom:0"><label>Build status</label><div class="chiprow">' +
        INTAKE_STATUSES.map(function(p){
          return '<button type="button" class="chip' + (i.status === p[0] ? ' on' : '') +
            '" data-intake="' + esc(i.id) + '" data-inewstatus="' + p[0] + '">' + p[1] + '</button>';
        }).join('') + '</div></div>' +
        (i.site_url ? '<div style="margin-top:8px;font-size:13px"><strong>Built site:</strong> <a href="' + esc(i.site_url) + '" target="_blank" rel="noopener">Open</a></div>' : '') +
        (i.pay_link ? '<div style="margin-top:4px;font-size:13px"><strong>Payment link:</strong> <a href="' + esc(i.pay_link) + '" target="_blank" rel="noopener">Open</a></div>' : '') +
        (canInbox() ?
          '<div class="field" style="margin-top:10px"><label>Built site URL</label>' +
          '<input id="bs-site-' + esc(i.id) + '" placeholder="https://..." value="' + esc(buildDraft(i.id, 'site') || i.site_url || '') + '"/>' +
          '<label style="margin-top:8px">Client payment link</label>' +
          '<input id="bs-pay-' + esc(i.id) + '" placeholder="https://..." value="' + esc(buildDraft(i.id, 'pay') || i.pay_link || '') + '"/>' +
          '<div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-submit-build="' + esc(i.id) + '">Submit built site</button></div>' +
          '<div class="err" id="bs-err-' + esc(i.id) + '"></div></div>' +
          (i.builder_name ? '<div class="muted" style="font-size:11px">Builder: ' + esc(i.builder_name) + '</div>' : '')
          : '') +
        '</div>';
    }).join('');
  }
  html += '</div>';
  el.innerHTML = html;
  el.querySelectorAll('[data-istatus]').forEach(function(chip){
    chip.addEventListener('click', function(){
      state.intakeStatusFilter = chip.getAttribute('data-istatus');
      renderIntakesInto(el);
    });
  });
  el.querySelectorAll('[data-intake]').forEach(function(chip){
    chip.addEventListener('click', function(){ setIntakeStatus(chip, el); });
  });
  el.querySelectorAll('[data-submit-build]').forEach(function(b){
    b.addEventListener('click', function(){ submitBuiltSite(b.getAttribute('data-submit-build'), el); });
  });
  /* Keep unsaved builder inputs across re-renders. */
  el.querySelectorAll('[id^="bs-site-"]').forEach(function(inp){
    inp.addEventListener('input', function(){ buildDraft(inp.id.slice(8), 'site', inp.value); });
  });
  el.querySelectorAll('[id^="bs-pay-"]').forEach(function(inp){
    inp.addEventListener('input', function(){ buildDraft(inp.id.slice(7), 'pay', inp.value); });
  });
  el.querySelectorAll('[data-intake-file]').forEach(function(b){
    b.addEventListener('click', function(){
      viewIntakeFile(b.getAttribute('data-intake-file'), b.getAttribute('data-intake-filename'));
    });
  });
  /* Deep link from a tapped alert: scroll to the intake and flash it. */
  if(state.pendingIntakeId){
    const pid = state.pendingIntakeId;
    state.pendingIntakeId = null;
    setTimeout(function(){
      const card = document.getElementById('intake-card-' + pid);
      if(card){
        card.scrollIntoView({ block: 'start' });
        card.style.outline = '2px solid var(--amber)';
        setTimeout(function(){ card.style.outline = ''; }, 2600);
      }
    }, 120);
  }
}

async function setIntakeStatus(chip, el){
  const id = chip.getAttribute('data-intake');
  const ns = chip.getAttribute('data-inewstatus');
  chip.disabled = true;
  try{
    const rec = await ghGetJson('intakes/' + id + '.json');
    if(!rec){ toast('Intake not found.'); return; }
    const intake = rec.data;
    const old = intake.status;
    intake.status = ns;
    if(ns === 'building'){
      intake.builder = state.user.username;
      intake.builder_name = state.user.name;
      const u = (state.users || {})[state.user.username];
      if(u && u.phone) intake.builder_phone = u.phone;
    }
    await ghPutJson('intakes/' + id + '.json', intake, rec.sha, 'sitedesk: intake ' + id + ' -> ' + ns);
    if(intake.claimer && old !== ns){
      await postEvent(intake.claimer, 'Intake update: ' + (intake.business || intake.slug),
        'Build status: ' + ns + '.', 'lead:' + intake.slug);
    }
    toast('Status: ' + ns);
    renderIntakesInto(el);
  }catch(e){ toast(e.message); chip.disabled = false; }
}

/* Builder's unsaved per-intake inputs survive re-renders. */
function buildDraft(id, key, val){
  const d = state.draftBuild[id] || (state.draftBuild[id] = {});
  if(typeof val !== 'undefined') d[key] = val;
  return d[key] || '';
}

/* Builder/admin/head submits the finished site plus the client payment link.
   The intake becomes Ready and the caller is notified so they can mark it sold. */
async function submitBuiltSite(id, el){
  const btn = el ? el.querySelector('[data-submit-build="' + id + '"]') : null;
  if(btn){ btn.disabled = true; btn.textContent = 'Submitting...'; }
  const siteEl = document.getElementById('bs-site-' + id);
  const payEl = document.getElementById('bs-pay-' + id);
  const err = document.getElementById('bs-err-' + id);
  const siteUrl = ((siteEl ? siteEl.value : '') || buildDraft(id, 'site') || '').trim();
  const payLink = ((payEl ? payEl.value : '') || buildDraft(id, 'pay') || '').trim();
  if(err) err.textContent = '';
  function restore(){ if(btn){ btn.disabled = false; btn.textContent = 'Submit built site'; } }
  if(!siteUrl || !payLink){
    if(err) err.textContent = 'Add the built site URL and the client payment link.';
    restore();
    return;
  }
  function applied(it){
    return it && it.status === 'ready' && it.site_url === siteUrl && it.pay_link === payLink;
  }
  try{
    const rec = await ghGetJson('intakes/' + id + '.json');
    if(!rec){ if(err) err.textContent = 'Intake not found.'; restore(); return; }
    const intake = rec.data;
    if(applied(intake)){
      /* Already submitted (double tap): nothing to show, just refresh. */
      toast('Submitted. The caller was notified.');
      delete state.draftBuild[id];
      renderIntakesInto(el);
      return;
    }
    intake.site_url = siteUrl;
    intake.pay_link = payLink;
    intake.status = 'ready';
    intake.ready_at = nowISO();
    intake.ready_by = state.user.username;
    intake.builder = intake.builder || state.user.username;
    intake.builder_name = intake.builder_name || state.user.name;
    const u = (state.users || {})[state.user.username];
    if(u && u.phone && !intake.builder_phone) intake.builder_phone = u.phone;
    try{
      await ghPutJson('intakes/' + id + '.json', intake, rec.sha, 'sitedesk: intake ' + id + ' ready');
    }catch(e){
      if(isConflictError(e)){
        const rec2 = await ghGetJson('intakes/' + id + '.json');
        if(rec2 && applied(rec2.data)){
          toast('Submitted. The caller was notified.');
          delete state.draftBuild[id];
          renderIntakesInto(el);
          return;
        }
      }
      throw e;
    }
    if(intake.claimer){
      await postEvent(intake.claimer, 'Site ready: ' + (intake.business || intake.slug),
        state.user.name + ' finished the site. The client payment link is ready. Open the lead and mark it sold.', 'lead:' + intake.slug);
    }
    toast('Submitted. The caller was notified.');
    delete state.draftBuild[id];
    renderIntakesInto(el);
  }catch(e){ if(err) err.textContent = e.message; else toast(e.message); restore(); }
}

/* ================= admin ================= */

async function renderAdminInto(el){
  el.innerHTML = '<div class="card"><div class="empty">Loading admin...</div></div>';
  try{ await loadUsers(); await fetchCatalog(); }
  catch(e){
    el.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) +
      '<br/><button class="btn" id="btn-retry-admin" type="button">Retry</button></div></div>';
    const r = document.getElementById('btn-retry-admin');
    if(r) r.addEventListener('click', function(){ renderAdminInto(el); });
    return;
  }
  if(state.adminUser){ renderUserDashboardInto(el); return; }
  let html = '<div class="chiprow" style="margin-bottom:14px">' +
    [['users','Users'],['announce','Announcements'],['tools','Tools']].map(function(p){
      return '<button type="button" class="chip' + (state.adminSec === p[0] ? ' on' : '') + '" data-admin-sec="' + p[0] + '">' + p[1] + '</button>';
    }).join('') + '</div>';
  if(state.adminSec === 'users') html += adminUsersHtml();
  else if(state.adminSec === 'announce') html += adminAnnounceHtml();
  else html += adminToolsHtml();
  el.innerHTML = html;
  el.querySelectorAll('[data-admin-sec]').forEach(function(chip){
    chip.addEventListener('click', function(){
      state.adminSec = chip.getAttribute('data-admin-sec');
      state.adminUser = null;
      renderAdminInto(el);
    });
  });
  if(state.adminSec === 'users') wireAdminUsers(el);
  else if(state.adminSec === 'announce') wireAdminAnnounce(el);
  else wireAdminTools(el);
}

function adminUsersHtml(){
  const q = state.userQ.trim().toLowerCase();
  const names = Object.keys(state.users || {}).sort();
  const list = names.map(function(k){ return { username: k, u: state.users[k] }; })
    .filter(function(r){
      if(state.userStatus && r.u.status !== state.userStatus) return false;
      if(q){
        const hay = (r.username + ' ' + (r.u.name||'') + ' ' + (r.u.phone||'')).toLowerCase();
        if(hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  let html = '<div class="card"><h2>Users</h2>' +
    '<div class="row" style="justify-content:space-between;margin-bottom:12px">' +
    '<p class="muted" style="font-size:11px">' + list.length + ' shown \xB7 chips and search refine live</p>' +
    '<button class="btn sm" id="btn-new-user" type="button">Create user</button></div>' +
    '<div class="filters"><input id="user-q" value="' + esc(state.userQ) + '" placeholder="Search name, username, phone"/>' +
    '<div class="chiprow">' +
    [['','All'],['pending','Pending'],['approved','Approved'],['rejected','Rejected'],['disabled','Disabled']].map(function(p){
      return '<button type="button" class="chip' + (state.userStatus === p[0] ? ' on' : '') + '" data-ustatus="' + p[0] + '">' + p[1] + '</button>';
    }).join('') + '</div></div>';
  if(!list.length) html += '<div class="empty">No users match.</div>';
  else html += list.map(function(r){
    const u = r.u;
    return '<div class="card" style="margin-bottom:10px;padding:14px">' +
      '<div class="row" style="justify-content:space-between;margin-bottom:8px"><div>' +
      '<div style="font-weight:600">' + esc(u.name || r.username) + '</div>' +
      '<div class="muted" style="font-size:12px">@' + esc(r.username) + '</div>' +
      '<div class="muted" style="font-size:12px">' + esc(u.phone || 'no phone') + '</div></div>' +
      badge(u.status) + '</div>' +
      '<div class="row" style="margin-bottom:8px">' + badge(u.role) + '</div>' +
      '<div class="row">' +
      '<button class="btn ghost sm" data-udash="' + esc(r.username) + '" type="button">Dashboard</button>' +
      (u.role === 'head' ? '' :
        (u.status === 'pending' ? '<button class="btn sm" data-uact="approve" data-u="' + esc(r.username) + '" type="button">Approve</button>' +
          '<button class="btn ghost sm" data-uact="reject" data-u="' + esc(r.username) + '" type="button">Reject</button>' : '') +
        (u.status !== 'disabled' ? '<button class="btn danger sm" data-uact="disable" data-u="' + esc(r.username) + '" type="button">Disable</button>' :
          '<button class="btn ghost sm" data-uact="approve" data-u="' + esc(r.username) + '" type="button">Re-enable</button>') +
        '<button class="btn ghost sm" data-uact="resetpw" data-u="' + esc(r.username) + '" type="button">Reset password</button>' +
        (r.username !== state.user.username ? '<button class="btn danger sm" data-uact="delete" data-u="' + esc(r.username) + '" type="button">Delete</button>' : '') +
        (state.user.role === 'head' ? '<select data-urole="' + esc(r.username) + '" style="min-height:42px;width:auto">' +
          ['caller','builder','admin'].map(function(ro){
            return '<option value="' + ro + '"' + (u.role === ro ? ' selected' : '') + '>' + ro + '</option>';
          }).join('') + '</select>' : '')) +
      '</div></div>';
  }).join('');
  return html + '</div>';
}

function wireAdminUsers(el){
  const uq = el.querySelector('#user-q');
  if(uq) uq.addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ state.userQ = uq.value; renderAdminInto(el); }
  });
  el.querySelectorAll('[data-ustatus]').forEach(function(chip){
    chip.addEventListener('click', function(){
      state.userStatus = chip.getAttribute('data-ustatus');
      renderAdminInto(el);
    });
  });
  const nu = el.querySelector('#btn-new-user');
  if(nu) nu.addEventListener('click', function(){ newUserModal(el); });
  el.querySelectorAll('[data-uact]').forEach(function(b){
    b.addEventListener('click', function(){
      /* Immediate feedback: disable until the save round-trip finishes, so a
         slow network does not read as "the click did nothing". */
      b.disabled = true;
      const rearm = function(){ try{ b.disabled = false; }catch(e){} };
      try{
        const r = userAction(b.getAttribute('data-u'), b.getAttribute('data-uact'), el);
        if(r && r.then) r.then(rearm, rearm); else rearm();
      }catch(e){ rearm(); }
    });
  });
  el.querySelectorAll('[data-udash]').forEach(function(b){
    b.addEventListener('click', function(){ state.adminUser = b.getAttribute('data-udash'); renderAdminInto(el); });
  });
  el.querySelectorAll('[data-urole]').forEach(function(sel){
    sel.addEventListener('change', function(){
      userAction(sel.getAttribute('data-urole'), 'role:' + sel.value, el);
    });
  });
}

/* Admin-only: every claim in the repo, for the per-user dashboard. */
async function loadAllClaims(){
  let tree = null;
  try{ tree = await ghFetch('/git/trees/main:claims', { action: 'list claims' }); }
  catch(e){ if(e.status === 404) return []; throw e; }
  const files = (tree.tree || []).filter(function(n){ return n.type === 'blob' && n.path.slice(-5) === '.json'; });
  const out = [];
  for(let i = 0; i < files.length; i += 6){
    const batch = files.slice(i, i + 6);
    const recs = await Promise.all(batch.map(function(n){
      return ghGetJson('claims/' + n.path).catch(function(){ return null; });
    }));
    recs.forEach(function(r){ if(r && r.data) out.push(r.data); });
  }
  return out;
}

async function renderUserDashboardInto(el){
  const username = state.adminUser;
  el.innerHTML = '<div class="card"><div class="empty">Loading dashboard...</div></div>';
  let claims = [], intakes = [];
  try{
    await loadUsers();
    claims = await loadAllClaims();
    intakes = await loadIntakes('all');
  }catch(e){
    el.innerHTML = '<div class="card"><button class="btn ghost sm" id="ud-back" type="button">Back to users</button>' +
      '<div class="empty" style="margin-top:10px">' + esc(e.message) + '</div></div>';
    el.querySelector('#ud-back').addEventListener('click', function(){ state.adminUser = null; renderAdminInto(el); });
    return;
  }
  const u = state.users[username];
  if(!u){
    el.innerHTML = '<div class="card"><button class="btn ghost sm" id="ud-back" type="button">Back to users</button>' +
      '<div class="empty" style="margin-top:10px">User not found.</div></div>';
    el.querySelector('#ud-back').addEventListener('click', function(){ state.adminUser = null; renderAdminInto(el); });
    return;
  }
  const myClaims = claims.filter(function(c){ return c.claimer === username; })
    .sort(function(a, b){ return String(b.claimed_at || '').localeCompare(String(a.claimed_at || '')); });
  const myIntakes = intakes.filter(function(i){ return i.claimer === username; })
    .sort(function(a, b){ return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
  const n = function(list, st){ return list.filter(function(c){ return c.status === st; }).length; };
  const stat = function(label, val){
    return '<div style="flex:1;min-width:70px;text-align:center;padding:10px 4px">' +
      '<div style="font-size:20px;font-weight:700">' + val + '</div>' +
      '<div class="muted" style="font-size:11px">' + label + '</div></div>';
  };
  let html = '<div class="card"><button class="btn ghost sm" id="ud-back" type="button">Back to users</button>' +
    '<div style="margin-top:12px"><div style="font-size:18px;font-weight:700">' + esc(u.name || username) + '</div>' +
    '<div class="muted" style="font-size:12px">@' + esc(username) + ' \xB7 ' + esc(u.phone || 'no phone') + '</div>' +
    '<div class="row" style="margin-top:8px">' + badge(u.role) + ' ' + badge(u.status) + '</div></div>' +
    '<div class="row" style="margin-top:12px">' +
    stat('Claimed', myClaims.length) + stat('Interested', n(myClaims, 'interested')) +
    stat('Sold', n(myClaims, 'sold')) + stat('Sites done', n(myIntakes, 'done')) + '</div></div>' +
    '<div class="card" style="margin-top:14px"><h2>Payment method</h2>' +
    '<p style="font-size:14px">' + esc(u.payment_method || 'Not set') + '</p></div>' +
    '<div class="card" style="margin-top:14px"><h2>Payments</h2>' +
    '<div id="ud-pays">' + udPaysHtml(u) + '</div>' +
    '<button class="btn sm" id="ud-logpay" type="button" style="margin-top:10px">Log payment</button></div>' +
    '<div class="card" style="margin-top:14px"><h2>Leads (' + myClaims.length + ')</h2>' +
    (myClaims.length ? myClaims.map(function(c){
      return '<div class="row" style="justify-content:space-between;padding:10px 0">' +
        '<div><div style="font-weight:600;font-size:13px">' + esc(c.business_name || c.slug || c.id) + '</div>' +
        '<div class="muted" style="font-size:11px">' + esc(fmtTime(c.claimed_at)) + '</div></div>' +
        badge(c.status) + '</div>';
    }).join('') : '<div class="empty">No leads claimed yet.</div>') + '</div>' +
    '<div class="card" style="margin-top:14px"><h2>Intakes (' + myIntakes.length + ')</h2>' +
    (myIntakes.length ? myIntakes.map(function(i){
      return '<div class="row" style="justify-content:space-between;padding:10px 0">' +
        '<div><div style="font-weight:600;font-size:13px">' + esc(i.business || i.slug || i.id) + '</div>' +
        '<div class="muted" style="font-size:11px">' + esc(fmtTime(i.created_at)) + '</div></div>' +
        badge(i.status) + '</div>';
    }).join('') : '<div class="empty">No intakes yet.</div>') + '</div>';
  el.innerHTML = html;
  el.querySelector('#ud-back').addEventListener('click', function(){ state.adminUser = null; renderAdminInto(el); });
  el.querySelector('#ud-logpay').addEventListener('click', function(){ logPaymentModal(username, el); });
}

function udPaysHtml(u){
  const pays = (u && u.payments) || [];
  if(!pays.length) return '<div class="empty">No payments logged yet.</div>';
  return pays.slice().reverse().map(function(p){
    return '<div class="row" style="justify-content:space-between;padding:10px 0">' +
      '<div><div style="font-weight:600">$' + esc(String(p.amount)) + '</div>' +
      (p.note ? '<div class="muted" style="font-size:12px">' + esc(p.note) + '</div>' : '') + '</div>' +
      '<div class="muted" style="font-size:11px">' + esc(fmtTime(p.paid_at)) + '</div></div>';
  }).join('');
}

function logPaymentModal(username, el){
  openModal('<h2>Log payment</h2><p class="muted" style="font-size:12px;margin-bottom:10px;line-height:1.55">' +
    'The caller gets an alert that they were paid.</p>' +
    '<div class="field"><label>Amount *</label><input id="lp-amount" inputmode="decimal" placeholder="50"/></div>' +
    '<div class="field"><label>Note</label><input id="lp-note" placeholder="e.g. Week 12 payouts"/></div>' +
    '<div class="row"><button class="btn ghost" id="lp-cancel" type="button" style="flex:1">Cancel</button>' +
    '<button class="btn" id="lp-go" type="button" style="flex:2">Log payment</button></div>' +
    '<div class="err" id="lp-err"></div>');
  document.getElementById('lp-cancel').addEventListener('click', closeModal);
  document.getElementById('lp-go').addEventListener('click', async function(){
    const err = document.getElementById('lp-err');
    err.textContent = '';
    const amount = (document.getElementById('lp-amount').value || '').trim();
    const note = (document.getElementById('lp-note').value || '').trim();
    if(!amount || isNaN(Number(amount)) || Number(amount) <= 0){ err.textContent = 'Enter a valid amount.'; return; }
    const btn = document.getElementById('lp-go');
    btn.disabled = true;
    try{
      const entry = { id: uid('pay'), amount: amount, note: note, paid_at: new Date().toISOString(), paid_by: state.user.username };
      await updateUserRecord(username, function(u){
        u.payments = u.payments || [];
        u.payments.push(entry);
      }, 'sitedesk: payment logged @' + username);
      await postEvent(username, 'Payment sent', '$' + amount + (note ? ' \xB7 ' + note : ''), 'tab:profile');
      closeModal();
      toast('Payment logged');
      renderUserDashboardInto(el);
    }catch(e){ err.textContent = e.message; btn.disabled = false; }
  });
}

async function saveUsers(){  const rec = await ghGetJson('users.json');
  try{
    await ghPutJson('users.json', state.users, rec ? rec.sha : null, 'sitedesk: users update');
  }catch(e){
    if(e.status !== 409) throw e;
    /* Someone else saved between our read and write: re-read fresh and retry once. */
    const fresh = await ghGetJson('users.json');
    await ghPutJson('users.json', state.users, fresh ? fresh.sha : null, 'sitedesk: users update (retry)');
  }
  await loadUsers();
}

async function userAction(username, act, el){
  const u = state.users[username];
  if(!u){ toast('User not found.'); return; }
  /* The head is untouchable: no one can disable, edit, delete, or change the role of a head account.
     The head changes their own password from Profile. */
  if(u.role === 'head'){
    toast('The head account cannot be changed.');
    renderAdminInto(el);
    return;
  }
  try{
    if(act === 'approve'){
      u.status = 'approved';
      await saveUsers();
      await postEvent(username, 'Account approved', 'Your SiteDesk account is approved. You can log in now.', '');
      toast('Approved @' + username);
    } else if(act === 'reject'){
      u.status = 'rejected';
      await saveUsers();
      await postEvent(username, 'Account not approved', 'Your SiteDesk request was declined. Ask your admin for details.', '');
      toast('Rejected @' + username);
    } else if(act === 'disable'){
      if(username === state.user.username){ toast('You cannot disable yourself.'); return; }
      u.status = 'disabled';
      await saveUsers();
      toast('Disabled @' + username);
    } else if(act.indexOf('role:') === 0){
      if(state.user.role !== 'head'){ toast('Only the head can change roles.'); return; }
      if(username === state.user.username){ toast('You cannot change your own role.'); return; }
      const newRole = act.slice(5);
      /* There can only ever be one head. The role picker no longer offers
         'head', and this guard blocks any forged request too. */
      if(newRole === 'head'){ toast('There can only be one head.'); renderAdminInto(el); return; }
      u.role = newRole;
      await saveUsers();
      toast('Role updated');
    } else if(act === 'delete'){
      if(username === state.user.username){ toast('Delete your own account from Profile.'); return; }
      /* Two-tap confirm, same pattern as Profile self-delete. */
      let btn = null;
      el.querySelectorAll('[data-uact="delete"]').forEach(function(x){
        if(x.getAttribute('data-u') === username) btn = x;
      });
      if(btn && !btn.getAttribute('data-confirm')){
        btn.setAttribute('data-confirm', '1');
        btn.textContent = 'Tap again to delete @' + username;
        setTimeout(function(){
          try{ btn.removeAttribute('data-confirm'); btn.textContent = 'Delete'; }catch(e){}
        }, 6000);
        return;
      }
      if(btn){ btn.disabled = true; btn.textContent = 'Deleting...'; }
      await loadUsers();
      const target = state.users[username];
      if(!target){ toast('User not found.'); renderAdminInto(el); return; }
      if(target.role === 'head'){ toast('The head account cannot be deleted.'); renderAdminInto(el); return; }
      /* Release their active claims so the leads go back to the queue. */
      try{
        const all = await loadAllClaims();
        const mine = all.filter(function(c){
          return c && c.claimer === username && (c.status === 'claimed' || c.status === 'interested');
        });
        for(const c of mine){
          try{
            const rec = await ghGetJson('claims/' + c.slug + '.json');
            if(rec) await ghDeleteFile('claims/' + c.slug + '.json', rec.sha);
          }catch(e){}
        }
        updateClaimIndex(function(idx){ mine.forEach(function(c){ delete idx[c.slug]; }); });
      }catch(e){}
      /* Drop their push subscriptions so no pushes go to a deleted account. */
      try{
        const prec = await ghGetJson('push_subs.json').catch(function(){ return null; });
        if(prec && prec.data && prec.data[username]){
          delete prec.data[username];
          await ghPutJson('push_subs.json', prec.data, prec.sha, 'sitedesk: drop push subs @' + username);
        }
      }catch(e){}
      /* Drop their server-side dismissed notifications too. */
      try{
        const drec = await ghGetJson('dismissed/' + username + '.json').catch(function(){ return null; });
        if(drec) await ghDeleteFile('dismissed/' + username + '.json', drec.sha);
      }catch(e){}
      await loadUsers();
      delete state.users[username];
      await saveUsers();
      toast('Deleted @' + username);
      renderAdminInto(el);
      return;
    } else if(act === 'resetpw'){
      /* Admin/head resets a user's password when the user asks (e.g. by email).
         The new password is shown once so it can be sent to the user. */
      const password = genPassword(16);
      u.pass = await pbkdf2Hash(password);
      await saveUsers();
      openModal('<h2>New password for @' + esc(username) + '</h2>' +
        '<p class="helper-warn">Send this to the user now. It is shown ONCE and cannot be recovered.</p>' +
        '<div class="copybox mono" id="rp-pass-val">' + esc(password) + '</div>' +
        '<div class="row" style="margin-top:8px"><button class="btn sm" id="rp-copy" type="button">Copy password</button></div>');
      document.getElementById('rp-copy').addEventListener('click', function(){ copyText(password, 'Password'); });
      toast('Password reset for @' + username);
    }
    renderAdminInto(el);
  }catch(e){ toast(e.message); }
}

function newUserModal(el){
  let role = 'caller';
  openModal('<h2>Create user</h2>' +
    '<div class="field"><label>Name *</label><input id="nu-name"/></div>' +
    '<div class="field"><label>Username *</label><input id="nu-user" autocapitalize="none" placeholder="lowercase, no spaces"/></div>' +
    '<div class="field"><label>Phone</label><input id="nu-phone" type="tel"/></div>' +
    '<div class="field"><label>Role</label><div class="chiprow" id="nu-role">' +
    ['caller','builder','admin'].map(function(r){
      return '<button type="button" class="chip' + (r === role ? ' on' : '') + '" data-r="' + r + '">' + r + '</button>';
    }).join('') + '</div></div>' +
    '<button class="btn block" id="nu-go" type="button">Create user</button>' +
    '<div class="err" id="nu-err"></div>' +
    '<div id="nu-pass" style="margin-top:12px"></div>');
  document.querySelectorAll('#nu-role [data-r]').forEach(function(b){
    b.addEventListener('click', function(){
      role = b.getAttribute('data-r');
      document.querySelectorAll('#nu-role [data-r]').forEach(function(x){ x.classList.toggle('on', x === b); });
    });
  });
  document.getElementById('nu-go').addEventListener('click', async function(){
    const err = document.getElementById('nu-err');
    err.textContent = '';
    const name = (document.getElementById('nu-name').value || '').trim();
    const username = (document.getElementById('nu-user').value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'');
    const phone = (document.getElementById('nu-phone').value || '').trim();
    if(!name || !username){ err.textContent = 'Name and username are required.'; return; }
    if(state.users[username]){ err.textContent = 'Username already exists.'; return; }
    const btn = document.getElementById('nu-go');
    btn.disabled = true; btn.textContent = 'Hashing password...';
    try{
      const password = genPassword(16);
      const pass = await pbkdf2Hash(password);
      state.users[username] = { name: name, role: role, status: 'pending', phone: phone, pass: pass };
      await saveUsers();
      document.getElementById('nu-pass').innerHTML =
        '<p class="helper-warn">Save this password now. It is shown ONCE and cannot be recovered.</p>' +
        '<div class="copybox mono" id="nu-pass-val">' + esc(password) + '</div>' +
        '<div class="row" style="margin-top:8px"><button class="btn sm" id="nu-copy" type="button">Copy password</button></div>';
      document.getElementById('nu-copy').addEventListener('click', function(){ copyText(password, 'Password'); });
      btn.textContent = 'User created';
      toast('User created: @' + username);
      renderAdminInto(el);
    }catch(e){
      err.textContent = e.message;
      btn.disabled = false; btn.textContent = 'Create user';
    }
  });
}

function adminAnnounceHtml(){
  return '<div class="card"><h2>Announcements</h2>' +
    '<p class="muted" style="font-size:12px;margin-bottom:12px;line-height:1.55">Posts to every user as a notification.</p>' +
    '<div class="field"><label>Title *</label><input id="an-title" placeholder="e.g. New payout rules"/></div>' +
    '<div class="field"><label>Message *</label><textarea id="an-body" placeholder="What should everyone know?"></textarea></div>' +
    '<button class="btn block" id="an-go" type="button">Send to everyone</button>' +
    '<div class="err" id="an-err"></div></div>';
}

function wireAdminAnnounce(el){
  el.querySelector('#an-go').addEventListener('click', async function(){
    const err = el.querySelector('#an-err');
    err.textContent = '';
    const title = (el.querySelector('#an-title').value || '').trim();
    const body = (el.querySelector('#an-body').value || '').trim();
    if(!title || !body){ err.textContent = 'Title and message are required.'; return; }
    const ok = await postEvent('all', title, body, '');
    if(ok){
      el.querySelector('#an-title').value = '';
      el.querySelector('#an-body').value = '';
      toast('Announcement sent');
    }
  });
}

function adminToolsHtml(){
  return '<div class="card"><h2>Tools</h2>' +
    '<p class="muted" style="font-size:12px;margin-bottom:12px;line-height:1.55">Look up a claim by slug and unlock it (deletes the claim file).</p>' +
    '<div class="field"><label>Lead slug</label><input id="tool-slug" placeholder="e.g. acme-plumbing"/></div>' +
    '<button class="btn ghost block" id="tool-lookup" type="button">Look up claim</button>' +
    '<div class="err" id="tool-err"></div>' +
    '<div id="tool-result" style="margin-top:12px"></div></div>';
}

function wireAdminTools(el){
  el.querySelector('#tool-lookup').addEventListener('click', async function(){
    const err = el.querySelector('#tool-err');
    const res = el.querySelector('#tool-result');
    err.textContent = ''; res.innerHTML = '';
    const slug = (el.querySelector('#tool-slug').value || '').trim();
    if(!slug){ err.textContent = 'Enter a slug.'; return; }
    try{
      const rec = await ghGetJson('claims/' + slug + '.json');
      if(!rec){ res.innerHTML = '<p class="muted">No active claim for ' + esc(slug) + '.</p>'; return; }
      const c = rec.data;
      res.innerHTML = '<div class="card" style="padding:14px"><div style="font-weight:600">' + esc(c.business_name || slug) + '</div>' +
        '<div class="muted" style="font-size:12px">claimer: ' + esc(c.claimer_name || c.claimer || '') +
        ' \xB7 status: ' + esc(c.status || '') + '</div>' +
        '<div class="muted" style="font-size:12px">expires: ' + esc(fmtTime(c.claim_expires_at)) + '</div>' +
        '<div class="row" style="margin-top:10px"><button class="btn danger sm" id="tool-unlock" type="button">Unlock (delete claim)</button></div></div>';
      res.querySelector('#tool-unlock').addEventListener('click', async function(){
        try{
          await ghDeleteFile('claims/' + slug + '.json', rec.sha);
          clearTreeCache();
          updateClaimIndex(function(idx){ delete idx[slug]; });
          delete state.claimsBySlug[slug];
          toast('Claim unlocked');
          res.innerHTML = '<p class="muted">Claim deleted. The lead is open again.</p>';
        }catch(e){ err.textContent = e.message; }
      });
    }catch(e){ err.textContent = e.message; }
  });
}

/* ================= alerts / profile ================= */

function renderAlertsInto(el){
  const list = state.feed.filter(feedItemVisible).filter(function(n){ return !isDismissed(n.id); });
  let html = '<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:12px">' +
    '<h2 style="margin:0">Alerts</h2>' +
    '<button class="btn ghost sm" id="btn-feed-refresh" type="button">Refresh</button></div>';
  if(!list.length){
    html += '<div class="empty">No notifications.<br/><span class="muted" style="font-size:12px">Approvals, intakes, and announcements show up here.</span></div>';
  } else {
    const lr = lastReadAt();
    html += list.map(function(n){
      const isNew = (new Date(n.created_at || 0).getTime() || 0) > lr;
      const inner = '<div style="font-weight:600">' + esc(n.title) + (isNew ? ' <span class="badge unread-new">new</span>' : '') + '</div>' +
        (n.body ? '<div class="muted" style="font-size:12px">' + esc(n.body) + '</div>' : '') +
        '<div class="muted" style="font-size:11px">' + esc(fmtTime(n.created_at)) + '</div>' +
        (n.link ? '<div style="font-size:11px;color:var(--amber);margin-top:4px">Tap to open &rsaquo;</div>' : '');
      const wrap = n.link
        ? '<button type="button" class="alert-item" data-alink="' + esc(n.link) + '">' + inner + '</button>'
        : '<div class="alert-item-static">' + inner + '</div>';
      return '<div class="alert-row" style="display:flex;gap:8px;align-items:flex-start;background-image:var(--sep);background-size:100% 1px;background-repeat:no-repeat;background-position:bottom">' +
        '<div style="flex:1;min-width:0">' + wrap + '</div>' +
        '<button type="button" class="btn ghost sm alert-dismiss" data-dismiss="' + esc(n.id || '') + '" aria-label="Delete notification" style="flex:none;margin-top:6px">\u00D7</button></div>';
    }).join('');
  }
  html += '<div class="row" style="margin-top:12px;gap:8px">' +
    '<button class="btn ghost block" id="mark-read" style="flex:1;margin-top:0" type="button">Mark all read</button>' +
    '<button class="btn ghost block" id="clear-notifs" style="flex:1;margin-top:0" type="button">Clear all</button></div></div>';
  el.innerHTML = html;
  el.querySelectorAll('[data-alink]').forEach(function(b){
    b.addEventListener('click', function(){ goAlertLink(b.getAttribute('data-alink')); });
  });
  el.querySelectorAll('[data-dismiss]').forEach(function(b){
    b.addEventListener('click', function(e){
      e.stopPropagation();
      dismissNotif(b.getAttribute('data-dismiss'));
      recountUnread();
      renderApp();
    });
  });
  el.querySelector('#mark-read').addEventListener('click', function(){
    setLastRead(Date.now());
    state.unread = 0;
    renderApp();
  });
  el.querySelector('#clear-notifs').addEventListener('click', function(){
    list.forEach(function(n){ dismissNotif(n.id); });
    setLastRead(Date.now());
    state.unread = 0;
    renderApp();
  });
  el.querySelector('#btn-feed-refresh').addEventListener('click', async function(){
    await fetchFeed(true);
    renderApp();
  });
}

function renderProfileInto(el){
  const u = (state.users && state.users[state.user.username]) || state.user;
  el.innerHTML = '<div class="card"><h2>Profile</h2>' +
    '<dl class="profile-dl">' +
    '<div><dt>Name</dt><dd>' + esc(u.name) + '</dd></div>' +
    '<div><dt>Username</dt><dd>@' + esc(u.username) + '</dd></div>' +
    '<div><dt>Role</dt><dd>' + badge(u.role) + '</dd></div>' +
    (u.phone ? '<div><dt>Phone</dt><dd>' + esc(u.phone) + '</dd></div>' : '') +
    '</dl>' +
    '<div class="row" style="margin-top:16px">' +
    '<button class="btn ghost block" id="btn-logout" type="button">Log out</button></div></div>' +
    '<div class="card" style="margin-top:14px"><h2>Payment method</h2>' +
    '<p class="muted" style="font-size:12px;margin-bottom:10px;line-height:1.55">How should we pay you? Put a payment handle (e.g. Cash App tag, Zelle), not full bank numbers.</p>' +
    '<div class="field"><input id="pay-method" value="' + esc(u.payment_method || '') + '" placeholder="e.g. Cash App $yourtag" autocapitalize="none"/></div>' +
    '<button class="btn sm" id="btn-save-pay" type="button">Save payment method</button>' +
    '<div class="err" id="pay-err"></div></div>' +
    '<div class="card" style="margin-top:14px"><h2>Change password</h2>' +
    '<div class="field"><label>Current password</label><input id="pw-cur" type="password" autocomplete="current-password"/></div>' +
    '<div class="field"><label>New password <span class="muted">(8+ characters)</span></label><input id="pw-new" type="password" autocomplete="new-password"/></div>' +
    '<button class="btn sm" id="btn-change-pw" type="button">Change password</button>' +
    '<div class="err" id="pw-err"></div></div>' +
    '<div class="card" style="margin-top:14px"><h2>Payments received</h2>' +
    '<div id="pay-history">' + payHistoryHtml(u) + '</div></div>' +
    '<div class="card" style="margin-top:14px">' +
    '<button class="btn ghost block" id="btn-howto" type="button">How to use SiteDesk</button>' +
    '<button class="btn ghost block" id="btn-terms" type="button" style="margin-top:10px">Terms</button>' +
    '<button class="btn ghost block" id="btn-policy" type="button" style="margin-top:10px">Policy</button></div>' +
    '<div class="card" style="margin-top:14px"><button class="btn ghost block" id="btn-delete-acct" type="button" style="color:#ff7b7b">Delete my account</button></div>';
  el.querySelector('#btn-logout').addEventListener('click', logout);
  el.querySelector('#btn-save-pay').addEventListener('click', saveOwnPaymentMethod);
  el.querySelector('#btn-change-pw').addEventListener('click', changeOwnPassword);
  el.querySelector('#btn-howto').addEventListener('click', function(){
    state.tab = 'help';
    renderApp();
  });
  el.querySelector('#btn-terms').addEventListener('click', function(){
    state.legalSection = 'terms';
    state.tab = 'legal';
    renderApp();
  });
  el.querySelector('#btn-policy').addEventListener('click', function(){
    state.legalSection = 'policy';
    state.tab = 'legal';
    renderApp();
  });
  el.querySelector('#btn-delete-acct').addEventListener('click', deleteOwnAccount);
}

function payHistoryHtml(u){
  const pays = (u && u.payments) || [];
  if(!pays.length) return '<div class="empty">No payments logged yet.</div>';
  return pays.slice().reverse().map(function(p){
    return '<div class="row" style="justify-content:space-between;padding:10px 0">' +
      '<div><div style="font-weight:600">$' + esc(String(p.amount)) + '</div>' +
      (p.note ? '<div class="muted" style="font-size:12px">' + esc(p.note) + '</div>' : '') + '</div>' +
      '<div class="muted" style="font-size:11px">' + esc(fmtTime(p.paid_at)) + '</div></div>';
  }).join('');
}

/* Targeted write to one user record with a 409 retry. fn mutates the user object. */
async function updateUserRecord(username, fn, message){
  for(let attempt = 0; attempt < 2; attempt++){
    const rec = await ghGetJson('users.json');
    const users = rec && rec.data ? rec.data : {};
    if(!users[username]) throw new Error('User not found.');
    fn(users[username]);
    try{
      await ghPutJson('users.json', users, rec ? rec.sha : null, message || ('sitedesk: user ' + username));
      await loadUsers();
      return;
    }catch(e){ if(e.status !== 409) throw e; }
  }
  throw new Error('Could not save, please try again.');
}

async function saveOwnPaymentMethod(){
  const err = document.getElementById('pay-err');
  err.textContent = '';
  const val = (document.getElementById('pay-method').value || '').trim();
  const btn = document.getElementById('btn-save-pay');
  btn.disabled = true;
  try{
    await updateUserRecord(state.user.username, function(u){ u.payment_method = val; },
      'sitedesk: payment method @' + state.user.username);
    toast('Payment method saved');
  }catch(e){ err.textContent = e.message; }
  btn.disabled = false;
}

/* Terms of Service + Privacy Policy. */
function legalSec(t, b){
  return '<h3 style="margin:14px 0 8px">' + t + '</h3>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">' + b + '</p>';
}

function termsHtml(){
  let h = '<h2>Terms</h2>' +
    '<p class="muted" style="font-size:11px;margin-bottom:10px">Effective September 13, 2026</p>';
  h += legalSec('1. What this is',
    'SiteDesk is a project of BJVFI for the website crew. Callers claim business leads and log call outcomes, builders receive build details and deliver finished sites, and staff coordinate payments and approvals.');
  h += legalSec('2. Who these Terms cover',
    'Everyone using the app: callers, builders, staff, and admins. By creating an account or logging in, you agree to these Terms.');
  h += legalSec('3. Accounts',
    'You must be 18 or older to use SiteDesk. New accounts must be approved by an admin before login. Keep your password private and do not share your account. One account per person. You can delete your account at any time from your profile.');
  h += legalSec('4. Fair use',
    'Claim only leads you intend to work. Log outcomes honestly: do not mark interested or sold unless it really happened. The 45-minute claim timer and the 5-lead limit keep the queue fair for everyone, so do not try to get around them.');
  h += legalSec('5. Calling businesses',
    'On every call you represent BJVFI. Use your common sense: be polite, honest, and clear. Never pretend to be someone you are not, never pressure or harass anyone, and honor do-not-call requests immediately.');
  h += legalSec('6. What you must tell every client',
    'After a build, tell the client plainly: the site build is free. Hosting and management is $27/month. By accepting the site, the client agrees to a subscription of at least one year, paid monthly or in full for the year. Payments are non-refundable. The website is owned by BJVFI, and by accepting it the client gives BJVFI the authority to manage it. Extra updates or edits to the site cost $20 each.');
  h += legalSec('7. Builders',
    'Build what the caller documented, including customer notes and attached files. Keep your build status honest so callers stay informed, and deliver the finished site URL and the client payment link through the app.');
  h += legalSec('8. Crew payments',
    'Worker payouts go to the payment handle you save in your profile. Client hosting payments are collected through BJVFI\'s payment links. A lead can only be marked sold after the build is submitted with a client payment link.');
  h += legalSec('9. Content',
    'Photos and files attached to build records must be ones you have the right to use, such as customer-provided materials or public business information.');
  h += legalSec('10. Breaking the rules',
    'If you break these Terms you will get a warning first. If it continues, your account will be removed. This has to be here: someone harassing businesses or misusing lead data puts BJVFI at risk, and we need to be able to cut that off.');
  h += legalSec('11. Changes',
    'We may update these Terms as the project changes. Continued use of SiteDesk means you accept the current version.');
  h += legalSec('12. Contact',
    'Questions about these Terms: email contact@bjvfi.com.');
  h += legalSec('13. Governing',
    'These Terms govern themselves. They are not tied to the laws of any state or country.');
  return h;
}

function policyHtml(){
  let h = '<h2>Policy</h2>' +
    '<p class="muted" style="font-size:11px;margin-bottom:10px">Effective September 13, 2026</p>';
  h += legalSec('1. What we collect',
    'Your name, username, password (stored as a secure one-way hash, never plain text), phone number, and payment handle. Your activity in the app: leads you claim, call outcomes you log, build details you submit, and files you attach. If you enable notifications, your browser\'s push subscription so we can send you alerts. We do not collect your location.');
  h += legalSec('2. How we use it',
    'To run the app: sign you in, show your leads, coordinate builds between callers and builders, send you alerts, and pay you.');
  h += legalSec('3. Who sees it',
    'Builders see the caller contact info and build details for builds assigned to them. Staff and admins see the activity they need to run the operation, such as approvals, outcomes, and payments. We do not share your data with anyone outside the project, and we do not sell it to anyone.');
  h += legalSec('4. Business data',
    'Business leads come from public listings. Your call notes and outcomes are visible to the staff running the operation.');
  h += legalSec('5. Storage and security',
    'Data is stored in BJVFI\'s private data store and transmitted over HTTPS. No system is perfect, so keep your password private and email contact@bjvfi.com if you suspect misuse.');
  h += legalSec('6. Your control',
    'You can delete your account at any time from your profile. Deleting removes your account and your active lead claims.');
  h += legalSec('7. Changes',
    'We may update this Policy as the project changes. Continued use of SiteDesk means you accept the current version.');
  h += legalSec('8. Contact',
    'Questions about this Policy: email contact@bjvfi.com.');
  return h;
}

function renderLegalInto(el){
  const section = state.legalSection === 'policy' ? 'policy' : 'terms';
  const body = section === 'policy' ? policyHtml() : termsHtml();
  el.innerHTML = '<div class="row" style="margin-bottom:12px">' +
    '<button class="btn ghost sm" id="legal-back" type="button">&lsaquo; Back to profile</button></div>' +
    '<div class="card" style="padding:18px">' + body + '</div>';
  el.querySelector('#legal-back').addEventListener('click', function(){
    state.tab = 'profile';
    renderApp();
  });
}

/* Terms + Policy before login (welcome / signup screens). */
function renderLegalPublic(){
  document.getElementById('app').innerHTML =
    '<header class="top"><div class="brand">sitedesk<div class="brand-sub">bjvfi</div></div></header>' +
    '<div class="main auth-main"><div class="card" style="padding:18px;text-align:left">' + termsHtml() +
    '<div style="margin-top:8px">' + policyHtml() + '</div>' +
    '<button class="btn ghost block" id="legal-home" type="button" style="margin-top:16px">Back</button></div></div>';
  document.getElementById('legal-home').addEventListener('click', renderHome);
}

/* Profile: change your own password (head included). */
async function changeOwnPassword(){
  const err = document.getElementById('pw-err');
  err.textContent = '';
  const cur = document.getElementById('pw-cur').value || '';
  const nw = document.getElementById('pw-new').value || '';
  if(nw.length < 8){ err.textContent = 'New password must be at least 8 characters.'; return; }
  const btn = document.getElementById('btn-change-pw');
  btn.disabled = true;
  try{
    const rec = await ghGetJson('users.json');
    const users = rec && rec.data ? rec.data : {};
    const u = users[state.user.username];
    if(!u) throw new Error('User not found.');
    const ok = await pbkdf2Verify(cur, u.pass);
    if(!ok) throw new Error('Current password is wrong.');
    const hash = await pbkdf2Hash(nw);
    await updateUserRecord(state.user.username, function(x){ x.pass = hash; },
      'sitedesk: password change @' + state.user.username);
    document.getElementById('pw-cur').value = '';
    document.getElementById('pw-new').value = '';
    toast('Password changed');
  }catch(e){ err.textContent = e.message; }
  btn.disabled = false;
}

/* How-to-use guide: how the app works, by role. */
function deleteOwnAccount(){
  const btn = document.getElementById('btn-delete-acct');
  if(!btn || !state.user) return;
  if(btn.getAttribute('data-confirm') !== '1'){
    btn.setAttribute('data-confirm', '1');
    btn.textContent = 'Tap again to delete my account forever';
    setTimeout(function(){
      const b = document.getElementById('btn-delete-acct');
      if(b){ b.removeAttribute('data-confirm'); b.textContent = 'Delete my account'; }
    }, 6000);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  (async function(){
    try{
      const me = state.user.username;
      await loadUsers();
      /* The head can never be deleted, by anyone, including the head. */
      if(state.users[me] && state.users[me].role === 'head'){
        toast('The head account cannot be deleted.');
        btn.disabled = false;
        btn.textContent = 'Delete my account';
        btn.removeAttribute('data-confirm');
        return;
      }
      if(state.user.role === 'head'){
        const otherHeads = Object.keys(state.users).filter(function(k){
          const u = state.users[k];
          return u && u.role === 'head' && u.status === 'approved' && k !== me;
        });
        if(!otherHeads.length){
          toast('You are the last admin, so this account cannot be deleted.');
          btn.disabled = false;
          btn.textContent = 'Delete my account';
          btn.removeAttribute('data-confirm');
          return;
        }
      }
      const claims = state.myClaims || [];
      for(const c of claims){
        if(c.status === 'claimed' || c.status === 'interested'){
          try{
            const rec = await ghGetJson('claims/' + c.slug + '.json');
            if(rec) await ghDeleteFile('claims/' + c.slug + '.json', rec.sha);
          }catch(e){}
        }
      }
      updateClaimIndex(function(idx){ claims.forEach(function(c){ delete idx[c.slug]; }); });
      await loadUsers();
      delete state.users[me];
      await ghPutJson('users.json', state.users, state.usersSha, 'sitedesk: delete account @' + me);
      logout();
      toast('Account deleted');
    }catch(e){
      toast(e.message);
      btn.disabled = false;
      btn.textContent = 'Delete my account';
      btn.removeAttribute('data-confirm');
    }
  })();
}

/* How-to-use guide: how the app works, by role. */
function renderHelpInto(el){
  el.innerHTML = '<div class="row" style="margin-bottom:12px">' +
    '<button class="btn ghost sm" id="help-back" type="button">&lsaquo; Back to profile</button></div>' +
    helpHtml();
  el.querySelector('#help-back').addEventListener('click', function(){
    state.tab = 'profile';
    renderApp();
  });
}

function helpHtml(){
  const u = state.user;
  const caller = u.role === 'caller' || u.role === 'admin' || u.role === 'head';
  const builder = u.role === 'builder' || u.role === 'admin' || u.role === 'head';
  const admin = u.role === 'admin' || u.role === 'head';
  let h = '<div class="card" style="margin-top:14px"><h2>How to use SiteDesk</h2>';
  if(caller){
    h += '<h3 style="margin:14px 0 8px">Getting leads</h3>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">The <strong>Queue</strong> shows available leads. Tap <strong>Grab</strong> on one to claim it. You can hold up to 5 leads at a time.</p>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">Before you grab, a review pops up. You <strong>must open the business site</strong> and study it: what they do, their services, their vibe, so you sound like you know them on the call. A <strong>2-minute timer</strong> runs while you look, then the grab unlocks. Cancel anytime to back out with no claim.</p>' +
    '<h3 style="margin:14px 0 8px">Your leads and the timer</h3>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">Every lead you grab gets its <strong>own 45-minute timer</strong>, counting down every second. Under 5 minutes it turns urgent. At zero the claim expires and the lead goes back to the queue.</p>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">Tap a lead in <strong>My leads</strong> to open it: call and text buttons, the message draft, the call script, and outcome logging.</p>' +
    '<h3 style="margin:14px 0 8px">No number on a lead?</h3>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">Open their site from the lead details, the number is usually listed there.</p>' +
    '<h3 style="margin:14px 0 8px">After the call</h3>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">Log what happened. <strong>No answer</strong> or <strong>sent message</strong> resets your 45-minute timer so you can follow up. <strong>Interested</strong> opens the build-details form: write down what they want and <strong>attach photos and files</strong> (logo, menus, site pictures), the builder sees all of it. After you submit, the lead shows as <strong>In build</strong>: you can see the builder and call or text them from the lead. When the builder submits the finished site and the client payment link, you get notified, send the link to the client, and hit <strong>Mark sold</strong> once they pay. <strong>Release</strong> gives a lead back to the queue.</p>';
  }
  if(builder){
    h += '<h3 style="margin:14px 0 8px">Builds</h3>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">New intakes from callers land in <strong>' + (u.role === 'builder' ? 'Builds' : 'Intakes') + '</strong> with the customer details, what they want, and attached photos and files. Tap a file to view it. Set the build status (Open, Building) so the caller stays in the loop. When the site is finished, enter the <strong>built site URL</strong> and the <strong>client payment link</strong>, then hit <strong>Submit built site</strong>: the caller gets notified and can mark it sold.</p>';
  }
  if(admin){
    h += '<h3 style="margin:14px 0 8px">Admin</h3>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">The <strong>Admin</strong> tab is where you approve or reject new accounts, disable users, and change roles. Approving sends the caller an alert that they can log in.</p>';
  }
  h += '<h3 style="margin:14px 0 8px">Alerts</h3>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:4px">The bell shows approvals, intake updates, and announcements. Tap an alert to jump straight to what it is about: the lead, the build, or your payments. Opening Alerts marks everything read. If popups are off on your device, use the Enable button in Alerts to turn them on.</p>';
  h += '</div>';
  return h;
}

/* ================= render dispatch ================= */

function renderApp(){
  if(!state.user){ renderHome(); return; }
  if(state.user.role === 'builder' && (state.tab === 'queue' || state.tab === 'mine')) state.tab = 'inbox';
  const app = document.getElementById('app');
  if(state.tab === 'queue'){
    app.innerHTML = shell('<div id="view"></div>');
    bindApp(app);
    renderQueueInto(app.querySelector('#view'));
  } else if(state.tab === 'mine'){
    app.innerHTML = shell('<div id="view"></div>');
    bindApp(app);
    renderMineInto(app.querySelector('#view'));
  } else if(state.tab === 'inbox'){
    app.innerHTML = shell('<div id="view"></div>');
    bindApp(app);
    renderIntakesInto(app.querySelector('#view'));
  } else if(state.tab === 'admin'){
    app.innerHTML = shell('<div id="view"></div>');
    bindApp(app);
    renderAdminInto(app.querySelector('#view'));
  } else if(state.tab === 'notifs'){
    app.innerHTML = shell('<div id="view"></div>');
    bindApp(app);
    fetchFeed(false).then(function(){
      renderAlertsInto(app.querySelector('#view'));
      /* Viewing the alerts clears the unread/gold state. */
      setLastRead(Date.now());
      state.unread = 0;
      renderBell();
      const navAlerts = app.querySelector('[data-tab="notifs"]');
      if(navAlerts) navAlerts.classList.remove('unread-alert');
    });
  } else if(state.tab === 'profile'){
    app.innerHTML = shell('<div id="view"></div>');
    bindApp(app);
    renderProfileInto(app.querySelector('#view'));
  } else if(state.tab === 'help'){
    app.innerHTML = shell('<div id="view"></div>');
    bindApp(app);
    renderHelpInto(app.querySelector('#view'));
  } else if(state.tab === 'legal'){
    app.innerHTML = shell('<div id="view"></div>');
    bindApp(app);
    renderLegalInto(app.querySelector('#view'));
  }
}

function bindApp(app){
  const bell = app.querySelector('#btn-bell');
  if(bell) bell.addEventListener('click', function(){
    state.tab = 'notifs';
    renderApp();
  });
  const bn = app.querySelector('#banner-notif');
  if(bn) bn.addEventListener('click', async function(){
    try{ await Notification.requestPermission(); }catch(e){}
    try{ localStorage.setItem(LS_NOTIF_ASKED, '1'); }catch(e){}
    ensurePushSubscribed();
    renderApp();
  });
}

/* Delegated clicks survive async re-renders of the views. */
function bindGlobal(){
  document.getElementById('app').addEventListener('click', function(e){
    const tab = e.target.closest('[data-tab]');
    if(tab){
      state.tab = tab.getAttribute('data-tab');
      renderApp();
      return;
    }
    const grab = e.target.closest('[data-grab]');
    if(grab){ showGrabPreview(grab.getAttribute('data-grab')); return; }
  });
}

async function bootData(announce){
  await loadDismissedServer();
  await refreshTree();
  await fetchFeed(announce);
  if(canClaim()){
    await refreshMyClaims();
    await refreshMyIntakes();
  }
}

var deferredInstallPrompt = null;

function isStandalone(){
  try{
    if(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    if(window.navigator && window.navigator.standalone === true) return true;
  }catch(e){}
  return false;
}

function isIOS(){
  const ua = navigator.userAgent || '';
  if(/iphone|ipad|ipod/i.test(ua)) return true;
  return (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function registerServiceWorker(){
  if('serviceWorker' in navigator){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('sw.js').catch(function(){});
    });
  }
}

function closeInstallGate(){
  var g = document.getElementById('install-gate');
  if(g && g.parentNode) g.parentNode.removeChild(g);
}

function updateGateNote(){
  var note = document.getElementById('gate-note');
  if(!note) return;
  note.textContent = deferredInstallPrompt
    ? 'Tap Install below to add SiteDesk to your device, then open it from your home screen.'
    : 'Waiting for the install prompt. If nothing appears, open your browser menu and choose "Install app" or "Add to Home screen", then open SiteDesk from the new icon.';
}

function triggerInstall(){
  if(deferredInstallPrompt){
    var p = deferredInstallPrompt;
    p.prompt();
    if(p.userChoice && p.userChoice.then){
      p.userChoice.then(function(choice){
        if(choice && choice.outcome === 'accepted') deferredInstallPrompt = null;
        else updateGateNote();
      }).catch(function(){ updateGateNote(); });
    }
  } else {
    updateGateNote();
  }
}

function renderInstallGate(reason){
  closeInstallGate();
  var ios = isIOS();
  var gate = document.createElement('div');
  gate.id = 'install-gate';
  var heading = 'Install SiteDesk to continue';
  var body = 'SiteDesk must be installed on your home screen before you can use it. As an installed app your call and payout notifications will pop up properly. In a normal browser tab they will not.';
  if(reason === 'grab'){
    heading = 'Install SiteDesk to grab this lead';
    body = 'You can browse leads right here in your browser, but grabbing a lead needs the installed app. As an installed app your call and payout notifications will pop up properly. In a normal browser tab they will not.';
  }
  var inner = '<div class="gate-card">' +
    '<div class="gate-logo">sitedesk</div>' +
    '<h1>' + heading + '</h1>' +
    '<p class="muted">' + body + '</p>' +
    '<div id="gate-action"></div>';
  if(ios){
    inner += '<ol class="gate-steps">' +
      '<li>Tap the <b>Share</b> button in Safari (square with an arrow).</li>' +
      '<li>Scroll down and tap <b>Add to Home Screen</b>.</li>' +
      '<li>Tap <b>Add</b>, then open SiteDesk from your home screen.</li>' +
      '</ol>' +
      '<p class="muted gate-note">On iPhone and iPad there is no install button. Use the Share menu above, it always works.</p>';
  } else {
    inner += '<ol class="gate-steps">' +
      '<li>Tap <b>Install SiteDesk</b> below.</li>' +
      '<li>If nothing happens, open your browser menu (&#8942;) and choose <b>Install app</b> or <b>Add to Home screen</b>.</li>' +
      '<li>Open SiteDesk from your home screen or app list.</li>' +
      '</ol>';
  }
  inner += '</div>';
  gate.innerHTML = inner;
  document.body.appendChild(gate);
  var action = gate.querySelector('#gate-action');
  var btn = document.createElement('button');
  btn.className = 'btn block';
  btn.textContent = 'Install SiteDesk';
  btn.addEventListener('click', triggerInstall);
  action.appendChild(btn);
  var note = document.createElement('p');
  note.className = 'muted gate-note';
  note.id = 'gate-note';
  action.appendChild(note);
  var later = document.createElement('button');
  later.className = 'btn ghost block';
  later.textContent = 'Not now';
  later.style.marginTop = '8px';
  later.addEventListener('click', closeInstallGate);
  action.appendChild(later);
  updateGateNote();
}

/* The install gate only appears when someone tries to grab a lead while not
   running the installed app. Browsing and login work in a regular tab. */
function grabNeedsInstall(){
  if(isStandalone()) return false;
  renderInstallGate('grab');
  return true;
}

function bootMain(){
  if(state.mainBooted) return;
  state.mainBooted = true;
  const s = loadSession();
  if(s && SITEDESK_DATA_TOKEN && SITEDESK_DATA_TOKEN !== 'PUT_TOKEN_HERE'){
    state.user = { username: s.username, role: s.role, name: s.name };
    state.tab = s.role === 'builder' ? 'inbox' : 'queue';
    renderApp();
    startFeedPoll();
    ensurePushSubscribed();
    bootData(false).then(function(){ renderApp(); }).catch(function(e){ toast(e.message); });
  } else {
    if(s && (!SITEDESK_DATA_TOKEN || SITEDESK_DATA_TOKEN === 'PUT_TOKEN_HERE')){
      clearSession();
      state.user = null;
    }
    renderHome();
  }
}

function init(){
  if(typeof document === 'undefined') return;
  if(state.booted) return;
  state.booted = true;
  bindGlobal();
  registerServiceWorker();
  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
    deferredInstallPrompt = e;
    updateGateNote();
  });
  window.addEventListener('appinstalled', function(){
    deferredInstallPrompt = null;
    closeInstallGate();
    bootMain();
    setTimeout(function(){ toast('Installed. Open SiteDesk from your home screen so notifications pop up.'); }, 400);
  });
  document.addEventListener('visibilitychange', function(){
    if(!document.hidden && isStandalone() && document.getElementById('install-gate')){
      closeInstallGate();
      bootMain();
    }
  });
  /* No startup install gate (2026-09-15 per user). Login and browsing work in a
     regular browser tab; the install gate only appears when grabbing a lead. */
  bootMain();
}

if(typeof document !== 'undefined'){
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
