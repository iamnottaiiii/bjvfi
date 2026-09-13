'use strict';
/* SiteDesk caller app. Static frontend, GitHub is the database.
   Data repo: iamnottaiiii/sitedesk-data via api.github.com.
   Lead catalog: https://bjvfi.com/sites.json (no auth).
   Auth: shared data token (config.js) + per-user PBKDF2 passwords in users.json.
   The token is never logged or displayed. Passwords and hashes are never logged. */

/* ================= pure helpers (node-testable) ================= */

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
function callScriptText(businessName, callerName){
  return [
    'Opener: Hi, is this ' + businessName + '? I am ' + callerName + ' with BJ VFI.',
    '',
    'Hook: We built a free preview website for your business. No catch, it is already made.',
    '',
    'Value: ' + salesLine() + ' If you like it we can put your real info on it this week.',
    '',
    'Ask: Can I text you the link so you can see it? What is the best email to send it to?',
    '',
    'Close: Great, I will send it now. If you want changes, just reply and we handle it.'
  ].join('\n');
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
  boardShown: 60,
  mineQ: '', mineStatus: 'all', meSlug: null,
  userQ: '', userStatus: '',
  adminSec: 'users',
  intakeStatusFilter: 'all',
  users: null, usersSha: null,
  booted: false,
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
  const unreadList = items.filter(function(n){
    return feedItemVisible(n) && (new Date(n.created_at || 0).getTime() || 0) > lastReadAt();
  });
  state.unread = unreadList.length;
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
  });
  wrap.querySelector('#notif-no').addEventListener('click', done);
}

/* ================= catalog + claims ================= */

async function fetchCatalog(){
  if(state.catalog.length && Date.now() - state.catalogAt < 10*60*1000) return;
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ctrl ? setTimeout(function(){ try{ ctrl.abort(); }catch(e){} }, 45000) : null;
  let res;
  try{
    res = await fetch(CATALOG_URL, ctrl ? { signal: ctrl.signal } : undefined);
  }catch(e){
    if(timer) clearTimeout(timer);
    throw new Error('Could not load the lead catalog. Check your connection and tap Retry.');
  }
  if(timer) clearTimeout(timer);
  if(!res.ok) throw new Error('Could not load the lead catalog (bjvfi.com).');
  const raw = await res.json();
  const list = Array.isArray(raw) ? raw : (raw.sites || raw.leads || []);
  state.catalog = list.map(normalizeLead).filter(function(l){ return l.slug; });
  state.catalogAt = Date.now();
}

async function refreshTree(){
  clearTreeCache();
  const paths = await ghTree();
  state.treeSlugs = paths.filter(function(p){ return p.indexOf('claims/') === 0 && p.slice(-5) === '.json'; })
    .map(function(p){ return p.slice(7, -5); });
}

async function getClaim(slug){
  if(state.claimsBySlug[slug] !== undefined) return state.claimsBySlug[slug];
  let rec = null;
  try{ rec = await ghGetJson('claims/' + slug + '.json'); }catch(e){ toast(e.message); return null; }
  const claim = rec ? rec.data : null;
  if(claim) claim._sha = rec.sha;
  state.claimsBySlug[slug] = claim;
  return claim;
}

/* Resolve which slugs are open: no claim file, or claim expired. */
async function resolveOpenSet(slugs){
  const claimed = (state.treeSlugs || []).filter(function(s){ return slugs.indexOf(s) !== -1; });
  const jobs = claimed.map(function(s){ return getClaim(s).then(function(c){ return [s, c]; }); });
  const pairs = await Promise.all(jobs);
  const taken = {};
  pairs.forEach(function(pair){
    const s = pair[0], c = pair[1];
    if(c && !claimExpired(c)) taken[s] = true;
  });
  return taken;
}

function catalogBySlug(){
  const m = {};
  state.catalog.forEach(function(l){ m[l.slug] = l; });
  return m;
}

async function refreshMyClaims(){
  state.myClaims = [];
  if(!state.treeSlugs) await refreshTree();
  const mine = [];
  for(const slug of state.treeSlugs){
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
    '</div></div>';
  document.getElementById('home-login').addEventListener('click', renderLogin);
  document.getElementById('home-signup').addEventListener('click', renderSignup);
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
    '<p class="muted" style="margin-top:14px;font-size:12px">Already have an account? <a href="#" id="su-login" style="color:var(--amber)">Log in</a> &middot; <a href="#" id="su-home" style="color:var(--amber)">Home</a></p>' +
    '</div></div>';
  document.getElementById('su-go').addEventListener('click', doSignup);
  document.getElementById('su-pass2').addEventListener('keydown', function(e){
    if(e.key === 'Enter') doSignup();
  });
  document.getElementById('su-login').addEventListener('click', function(e){
    e.preventDefault(); renderLogin();
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
    await bootData(true);
    maybeNotifGate();
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
  clearSession();
  state.user = null; state.myClaims = []; state.myIntakes = [];
  state.feed = []; state.unread = 0; state.feedMaxTs = 0;
  state.claimsBySlug = {}; state.treeSlugs = null;
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
  try{
    if(typeof Notification === 'undefined' || Notification.permission !== 'default') return '';
  }catch(e){ return ''; }
  return '<div class="notif-banner"><div class="row"><span class="muted" style="font-size:12px">' +
    'Notifications are off. Turn them on for alerts on this device.</span>' +
    '<button class="btn sm ghost" id="banner-notif" type="button">Enable</button></div></div>';
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
    '<div class="muted" style="font-size:12px">' + (hasPhone(l.phone) ? esc(l.phone) : 'no phone') + '</div>' +
    '</div><div class="row">' +
    '<a class="btn ghost sm" href="' + esc(siteUrlFor(l)) + '" target="_blank" rel="noopener">site</a>' +
    '<button class="btn sm" data-grab="' + esc(l.slug) + '" type="button">Grab</button>' +
    '</div></div>';
}

async function renderQueueInto(el){
  el.innerHTML = '<div class="card"><div class="empty">Loading leads...</div></div>';
  try{
    await fetchCatalog();
    if(!state.treeSlugs) await refreshTree();
    const slugs = state.catalog.map(function(l){ return l.slug; });
    const taken = await resolveOpenSet(slugs);
    const list = filteredOpen(taken);
    if(!state.boardOrder.length || state._boardKey !== boardKey()){
      state.boardOrder = shuffle(list.map(function(l){ return l.slug; }));
      state._boardKey = boardKey();
    }
    const active = activeClaimCount();
    const atCap = active >= MAX_ACTIVE_CLAIMS;
    const cats = allCategories();
    const shown = state.boardOrder
      .map(function(s){ return state.catalog.find(function(l){ return l.slug === s; }); })
      .filter(Boolean)
      .slice(0, state.boardShown);

    let html = statsRow();
    html += '<div class="row" style="justify-content:space-between;margin-bottom:14px"><div>' +
      '<h2 style="font-size:18px">Open leads</h2>' +
      '<p class="muted" style="font-size:12px">Unclaimed only \xB7 scattered \xB7 45 min claim \xB7 ' +
      '<strong>' + active + '/' + MAX_ACTIVE_CLAIMS + '</strong> claimed</p></div>' +
      '<button class="btn sm" id="btn-grab-random" type="button"' + (atCap ? ' disabled' : '') + '>Grab random</button></div>';
    if(atCap) html += '<p class="err" style="margin-bottom:12px">Claim cap reached (' + active + '/' + MAX_ACTIVE_CLAIMS + '). Release or finish an active lead first.</p>';
    html += '<p class="review-note"><strong>Review first.</strong> Open the business page and understand who they are, what they do, how they sound, before you call or send a message.</p>';
    html += '<div class="card"><h2>Board</h2><div class="filters">' +
      '<input id="queue-q" value="' + esc(state.q) + '" placeholder="Name, slug, phone"/>' +
      '<div class="chiprow scroll">' +
      '<button type="button" class="chip' + (state.cat === '' ? ' on' : '') + '" data-cat="">All</button>' +
      cats.slice(0, 24).map(function(c){
        return '<button type="button" class="chip' + (state.cat === c ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
      }).join('') + '</div>' +
      '<div class="chiprow"><button type="button" class="chip' + (state.hasPhoneOnly ? ' on' : '') + '" id="chip-phone">Has phone</button>' +
      '<button type="button" class="btn sm" id="btn-filter">Apply</button></div></div>';
    if(shown.length){
      html += '<div class="open-board">' + shown.map(leadRowHtml).join('') + '</div>' +
        '<p class="muted" style="font-size:11px;margin:10px 0">' + list.length + ' open match' + (list.length === 1 ? '' : 'es') + '</p>' +
        '<div class="board-actions"><button class="btn ghost block" id="btn-next-batch" type="button">Next \xB7 scatter more</button></div>';
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
  }catch(e){
    el.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) +
      '<br/><button class="btn" id="btn-retry-queue" type="button">Retry</button></div></div>';
    const r = document.getElementById('btn-retry-queue');
    if(r) r.addEventListener('click', function(){ renderQueueInto(el); });
  }
}

function boardKey(){ return state.q + '|' + state.cat + '|' + (state.hasPhoneOnly ? 1 : 0); }

function wireQueue(el){
  const q = el.querySelector('#queue-q');
  const apply = function(){
    state.q = q ? q.value : '';
    state.boardShown = 60;
    state.boardOrder = [];
    renderQueueInto(el);
  };
  const fa = el.querySelector('#btn-filter');
  if(fa) fa.addEventListener('click', apply);
  if(q) q.addEventListener('keydown', function(e){ if(e.key === 'Enter') apply(); });
  el.querySelectorAll('[data-cat]').forEach(function(chip){
    chip.addEventListener('click', function(){
      state.cat = chip.getAttribute('data-cat');
      state.boardShown = 60;
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
  const nb = el.querySelector('#btn-next-batch');
  if(nb) nb.addEventListener('click', function(){
    state.boardOrder = shuffle(state.boardOrder);
    state.boardShown = 60;
    renderQueueInto(el);
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
  const WAIT_S = 120;
  let siteOpened = false;
  let remaining = WAIT_S;
  let iv = null;
  function fmt(s){ return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  let html = '<h2>Review before you grab</h2>' +
    '<p class="muted" style="font-size:13px;line-height:1.55;margin-bottom:14px">Study their site first: what they do, their services, their vibe, so you sound like you know them on the call. The timer gives you <strong>2 minutes</strong> to look, then the grab unlocks.</p>' +
    '<div style="font-size:15px;font-weight:600;margin-bottom:4px">' + esc(l.name) + '</div>' +
    (l.category ? '<div class="muted" style="font-size:12px;margin-bottom:2px">' + esc(l.category) + '</div>' : '') +
    (hasPhone(l.phone) ? '<div style="font-size:13px;margin-bottom:2px">' + esc(l.phone) + '</div>' : '') +
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
    if(remaining > 0){ confirmBtn.disabled = true; confirmBtn.textContent = 'Grab in ' + fmt(remaining); return; }
    confirmBtn.disabled = false; confirmBtn.textContent = 'Grab this lead';
  }
  openBtn.addEventListener('click', function(){
    window.open(url, '_blank', 'noopener');
    if(!siteOpened){
      siteOpened = true;
      openBtn.textContent = 'Site opened \u2713 Reopen';
      iv = setInterval(function(){
        remaining--;
        if(remaining <= 0){ remaining = 0; stopTimer(); }
        refresh();
      }, 1000);
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
  const script = callScriptText(lead.name, state.user.name);
  const canRelease = ['claimed','interested'].indexOf(claim.status) !== -1;

  let html = '<div class="lead-title">' + esc(lead.name) + '</div>' +
    '<div class="row" style="margin:8px 0 10px">' + badge(claim.status) + '</div>' +
    claimTimerHtml(claim);

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
      '<p class="muted" style="font-size:12px;margin-bottom:12px;line-height:1.55">When they are <strong>interested</strong>, save that, then you get the <strong>Add build details</strong> form.</p>' +
      '<div class="field"><label>Outcome</label><div class="pick compact" id="outcome-pick">' +
      OUTCOMES.map(function(o, i){
        return '<button type="button" class="' + (i === 0 ? 'on' : '') + '" data-outcome="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>Note</label><textarea id="outcome-note" placeholder="What did they say?"></textarea></div>' +
      '<button class="btn block" id="btn-outcome" type="button">Save outcome</button>' +
      '<div class="err" id="outcome-err"></div></div>';
  }

  if(claim.status === 'interested'){
    html += '<div class="card" id="intake-panel" style="margin:18px 0"><h2>Add build details</h2>' +
      '<p class="muted" style="font-size:12px;margin-bottom:14px;line-height:1.55">They are interested. Capture everything the builder needs.</p>' +
      '<div class="field"><label>Business *</label><input id="in-business" value="' + esc(lead.name) + '"/></div>' +
      '<div class="grid2"><div class="field"><label>Contact name *</label><input id="in-contact" placeholder="Who you spoke with"/></div>' +
      '<div class="field"><label>Phone *</label><input id="in-phone" type="tel" value="' + esc(lead.phone) + '"/></div></div>' +
      '<div class="field"><label>Email</label><input id="in-email" type="email" inputmode="email" placeholder="owner@business.com"/></div>' +
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
  const err = document.getElementById('outcome-err');
  err.textContent = '';
  const pick = document.querySelector('#outcome-pick .on');
  const outcome = pick ? pick.getAttribute('data-outcome') : 'interested';
  const note = (document.getElementById('outcome-note').value || '').trim();
  claim.status = outcome;
  claim.note = note;
  claim.timeline = claim.timeline || [];
  claim.timeline.push({ t: nowISO(), k: 'outcome: ' + outcome, note: note });
  try{
    const rec = await ghGetJson('claims/' + claim.slug + '.json');
    await ghPutJson('claims/' + claim.slug + '.json', claim, rec ? rec.sha : null, 'sitedesk: outcome ' + claim.slug);
  }catch(e){
    err.textContent = e.message;
    return;
  }
  if(outcome !== 'interested'){
    await releaseLead(claim, true);
    return;
  }
  toast('Saved: interested');
  state.claimsBySlug[claim.slug] = claim;
  renderApp();
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
  if(!business || !contact || !phone || !wants){ err.textContent = 'Business, contact, phone, and what they want are required.'; return; }
  const intake = {
    id: uid('intake'), slug: claim.slug, business: business, contact_name: contact,
    phone: phone, email: email, wants: wants, notes: notes,
    claimer: state.user.username, claimer_name: state.user.name,
    status: 'open', created_at: nowISO(), files: []
  };
  const btn = document.getElementById('btn-intake');
  const fileInput = document.getElementById('in-files');
  const nFiles = fileInput && fileInput.files ? Math.min(fileInput.files.length, 12) : 0;
  try{
    if(nFiles){
      if(btn){ btn.disabled = true; }
      err.textContent = '';
      intake.files = await uploadIntakeFiles(intake.id, fileInput, function(d, total){
        if(btn) btn.textContent = 'Uploading ' + d + '/' + total + '...';
      });
      if(btn){ btn.disabled = false; btn.textContent = 'Submit to builders'; }
    }
    await ghPutJson('intakes/' + intake.id + '.json', intake, null, 'sitedesk: intake ' + intake.id);
    claim.status = 'sold';
    claim.timeline = claim.timeline || [];
    claim.timeline.push({ t: nowISO(), k: 'intake submitted', note: 'Build details sent to builders' });
    const rec = await ghGetJson('claims/' + claim.slug + '.json');
    if(rec) await ghPutJson('claims/' + claim.slug + '.json', claim, rec.sha, 'sitedesk: sold ' + claim.slug);
  }catch(e){
    err.textContent = e.message;
    if(btn){ btn.disabled = false; btn.textContent = 'Submit to builders'; }
    return;
  }
  await postEvent('staff', 'Intake: ' + business, state.user.name + ' submitted build details for ' + business + '.', '');
  clearTreeCache();
  delete state.claimsBySlug[claim.slug];
  await refreshMyClaims();
  await refreshMyIntakes();
  toast('Sent to builders');
  renderApp();
}

async function renderMineInto(el){
  el.innerHTML = '<div class="card"><div class="empty">Loading your leads...</div></div>';
  try{
    await fetchCatalog();
    await refreshMyClaims();
    await refreshMyIntakes();
  }catch(e){
    el.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) +
      '<br/><button class="btn" id="btn-retry-mine" type="button">Retry</button></div></div>';
    const r = document.getElementById('btn-retry-mine');
    if(r) r.addEventListener('click', function(){ renderMineInto(el); });
    return;
  }
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
    [['all','All'],['claimed','Claimed'],['interested','Interested'],['sold','Sold']].map(function(p){
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
      const slug = b.getAttribute('data-open-mine');
      const claim = state.myClaims.find(function(c){ return c.slug === slug; });
      if(!claim) return;
      showModal('<div style="text-align:right;margin-bottom:8px"><button class="btn ghost sm" id="modal-close" type="button">Close</button></div>' + leadCard(claim));
      wireLeadCard(claim);
      const mc = document.getElementById('modal-close');
      if(mc) mc.addEventListener('click', closeModal);
    });
  });
  const meClaim = list.find(function(c){ return c.slug === state.meSlug; }) || list[0];
  if(meClaim) wireLeadCard(meClaim);
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

var INTAKE_STATUSES = [['open','Open'],['building','Building'],['done','Done']];

async function renderIntakesInto(el){
  el.innerHTML = '<div class="card"><div class="empty">Loading intakes...</div></div>';
  let items = [];
  try{ items = await loadIntakes('all'); }
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
    [['all','All'],['open','Open'],['building','Building'],['done','Done']].map(function(p){
      return '<button type="button" class="chip' + (state.intakeStatusFilter === p[0] ? ' on' : '') + '" data-istatus="' + p[0] + '">' + p[1] + '</button>';
    }).join('') + '</div>';
  if(!items.length){
    html += '<div class="empty">No intakes yet.</div>';
  } else {
    html += items.map(function(i){
      return '<div class="card" style="margin-bottom:10px;padding:14px">' +
        '<div class="row" style="justify-content:space-between;margin-bottom:8px"><div>' +
        '<div style="font-weight:600">' + esc(i.business || i.slug) + '</div>' +
        '<div class="muted" style="font-size:12px">' + esc(i.contact_name || '') +
        (i.phone ? ' \xB7 ' + esc(i.phone) : '') + '</div>' +
        '<div class="muted" style="font-size:11px">from ' + esc(i.claimer_name || i.claimer || '') +
        ' \xB7 ' + esc(fmtTime(i.created_at)) + '</div></div>' + badge(i.status) + '</div>' +
        '<div class="copybox" style="margin-bottom:10px">' + esc(i.wants || '') +
        (i.notes ? '\n\nNotes: ' + i.notes : '') + '</div>' +
        (i.files && i.files.length ?
          '<div class="field" style="margin-bottom:10px"><label>Attached files (' + i.files.length + ')</label><div class="row">' +
          i.files.map(function(f){
            return '<button type="button" class="btn ghost sm" data-intake-file="' + esc(f.path) + '" data-intake-filename="' + esc(f.name) + '">\uD83D\uDCCE ' + esc(f.name) + '</button>';
          }).join('') + '</div></div>' : '') +
        '<div class="field" style="margin-bottom:0"><label>Build status</label><div class="chiprow">' +
        INTAKE_STATUSES.map(function(p){
          return '<button type="button" class="chip' + (i.status === p[0] ? ' on' : '') +
            '" data-intake="' + esc(i.id) + '" data-inewstatus="' + p[0] + '">' + p[1] + '</button>';
        }).join('') + '</div></div></div>';
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
  el.querySelectorAll('[data-intake-file]').forEach(function(b){
    b.addEventListener('click', function(){
      viewIntakeFile(b.getAttribute('data-intake-file'), b.getAttribute('data-intake-filename'));
    });
  });
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
    await ghPutJson('intakes/' + id + '.json', intake, rec.sha, 'sitedesk: intake ' + id + ' -> ' + ns);
    if(intake.claimer && old !== ns){
      await postEvent(intake.claimer, 'Intake update: ' + (intake.business || intake.slug),
        'Build status: ' + ns + '.', '');
    }
    toast('Status: ' + ns);
    renderIntakesInto(el);
  }catch(e){ toast(e.message); chip.disabled = false; }
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
      (u.status === 'pending' ? '<button class="btn sm" data-uact="approve" data-u="' + esc(r.username) + '" type="button">Approve</button>' +
        '<button class="btn ghost sm" data-uact="reject" data-u="' + esc(r.username) + '" type="button">Reject</button>' : '') +
      (u.status !== 'disabled' ? '<button class="btn danger sm" data-uact="disable" data-u="' + esc(r.username) + '" type="button">Disable</button>' :
        '<button class="btn ghost sm" data-uact="approve" data-u="' + esc(r.username) + '" type="button">Re-enable</button>') +
      (state.user.role === 'head' ? '<select data-urole="' + esc(r.username) + '" style="min-height:42px;width:auto">' +
        ['caller','builder','admin','head'].map(function(ro){
          return '<option value="' + ro + '"' + (u.role === ro ? ' selected' : '') + '>' + ro + '</option>';
        }).join('') + '</select>' : '') +
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
    b.addEventListener('click', function(){ userAction(b.getAttribute('data-u'), b.getAttribute('data-uact'), el); });
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
      await postEvent(username, 'Payment sent', '$' + amount + (note ? ' \xB7 ' + note : ''), '');
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
      u.role = act.slice(5);
      await saveUsers();
      toast('Role updated');
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
  const list = state.feed.filter(feedItemVisible);
  let html = '<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:12px">' +
    '<h2 style="margin:0">Alerts</h2>' +
    '<button class="btn ghost sm" id="btn-feed-refresh" type="button">Refresh</button></div>';
  if(!list.length){
    html += '<div class="empty">No notifications.<br/><span class="muted" style="font-size:12px">Approvals, intakes, and announcements show up here.</span></div>';
  } else {
    const lr = lastReadAt();
    html += list.map(function(n){
      const isNew = (new Date(n.created_at || 0).getTime() || 0) > lr;
      return '<div style="padding:12px 0;background-image:var(--sep);background-size:100% 1px;background-repeat:no-repeat;background-position:bottom">' +
        '<div style="font-weight:600">' + esc(n.title) + (isNew ? ' <span class="badge unread-new">new</span>' : '') + '</div>' +
        (n.body ? '<div class="muted" style="font-size:12px">' + esc(n.body) + '</div>' : '') +
        '<div class="muted" style="font-size:11px">' + esc(fmtTime(n.created_at)) + '</div></div>';
    }).join('');
  }
  html += '<button class="btn ghost block" id="mark-read" style="margin-top:12px" type="button">Mark all read</button></div>';
  el.innerHTML = html;
  el.querySelector('#mark-read').addEventListener('click', function(){
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
    '<div class="card" style="margin-top:14px"><h2>Payments received</h2>' +
    '<div id="pay-history">' + payHistoryHtml(u) + '</div></div>' +
    helpHtml();
  el.querySelector('#btn-logout').addEventListener('click', logout);
  el.querySelector('#btn-save-pay').addEventListener('click', saveOwnPaymentMethod);
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

/* How-to-use guide: how the app works, by role. */
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
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">Log what happened. <strong>No answer</strong> or <strong>sent message</strong> resets your 45-minute timer so you can follow up. <strong>Interested</strong> opens the build-details form: write down what they want and <strong>attach photos and files</strong> (logo, menus, site pictures), the builder sees all of it. <strong>Release</strong> gives a lead back to the queue.</p>';
  }
  if(builder){
    h += '<h3 style="margin:14px 0 8px">Builds</h3>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">New intakes from callers land in <strong>' + (u.role === 'builder' ? 'Builds' : 'Intakes') + '</strong> with the customer details, what they want, and attached photos and files. Tap a file to view it. Update the build status (Open, Building, Done) so the caller stays in the loop.</p>';
  }
  if(admin){
    h += '<h3 style="margin:14px 0 8px">Admin</h3>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:8px">The <strong>Admin</strong> tab is where you approve or reject new accounts, disable users, and change roles. Approving sends the caller an alert that they can log in.</p>';
  }
  h += '<h3 style="margin:14px 0 8px">Alerts</h3>' +
    '<p class="muted" style="font-size:12px;line-height:1.65;margin-bottom:4px">The bell shows approvals, intake updates, and announcements. Opening Alerts marks everything read. If popups are off on your device, use the Enable button in Alerts to turn them on.</p>';
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

function renderInstallGate(){
  closeInstallGate();
  var ios = isIOS();
  var gate = document.createElement('div');
  gate.id = 'install-gate';
  var inner = '<div class="gate-card">' +
    '<div class="gate-logo">sitedesk</div>' +
    '<h1>Install SiteDesk to continue</h1>' +
    '<p class="muted">SiteDesk must be installed on your home screen before you can use it. As an installed app your call and payout notifications will pop up properly. In a normal browser tab they will not.</p>' +
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
  updateGateNote();
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
  if(!isStandalone() && !/testbypass=1/.test(location.search)){
    renderInstallGate();
    return;
  }
  bootMain();
}

if(typeof document !== 'undefined'){
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
