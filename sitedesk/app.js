/* SiteDesk static PWA. Zero backend. GitHub is the database via api.github.com.
   The token is kept in localStorage and never logged or displayed. */

var OWNER = 'iamnottaiiii';
var REPO = 'bjvfi';
var API = 'https://api.github.com';
var LS_TOKEN = 'sitedesk_pat_v1';
var LS_MYCLAIMS = 'sitedesk_myclaims_v1';
var CLAIM_TTL_MIN = 45;
var MAX_ACTIVE_CLAIMS = 5;
var PAGE_SIZE = 10;
var FEED_PATH = 'sitedesk/data/feed.json';
var FEED_CAP = 200;
var LS_FEED_SEEN = 'sitedesk_feed_seen_v1';
var LS_NOTIF_ASKED = 'sitedesk_notif_asked_v1';
var MAX_POPUPS = 5;

var S = {
  token: null,
  me: null,            // {login, name, role, status}
  users: null,
  sites: null,
  sitesBySlug: {},
  claimCache: {},     // slug -> claim doc or null (null = known open)
  queue: [],
  shown: 0,
  myClaims: [],
  intakes: [],
  intakeClaimSlug: null,
  filters: { q: '', cat: '', phone: false }
};

/* ---------------- pure helpers (also exported for node tests) ---------------- */

function b64encodeUtf8(s) {
  var bytes = new TextEncoder().encode(s);
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decodeUtf8(s) {
  var bin = atob(String(s).replace(/\s+/g, ''));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function normLead(e) {
  if (!e || typeof e !== 'object') return null;
  var slug = e.slug || e.id || '';
  var name = e.business_name || e.name || '';
  if (!slug || !name) return null;
  return {
    slug: String(slug),
    name: String(name),
    phone: e.phone || '',
    category: e.category || '',
    address: e.address || '',
    site: e.site_url || e.maps_url || ''
  };
}

function normSites(data) {
  var arr = Array.isArray(data) ? data : (data && Array.isArray(data.sites) ? data.sites : []);
  var out = [], seen = {};
  for (var i = 0; i < arr.length; i++) {
    var l = normLead(arr[i]);
    if (l && !seen[l.slug]) { seen[l.slug] = 1; out.push(l); }
  }
  return out;
}

function isExpired(claim, nowMs) {
  if (!claim || !claim.claim_expires_at) return true;
  var t = Date.parse(claim.claim_expires_at);
  return !(t > nowMs);
}

function shuffle(a) {
  var x = a.slice();
  for (var i = x.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = x[i]; x[i] = x[j]; x[j] = t;
  }
  return x;
}

function phoneDigits(p) {
  return String(p || '').replace(/\D/g, '');
}

function telHref(phone) {
  var d = phoneDigits(phone);
  if (d.length === 10) return 'tel:+1' + d;
  if (d.length === 11 && d.charAt(0) === '1') return 'tel:+' + d;
  return d ? 'tel:' + d : '';
}

function smsHref(phone, body) {
  var d = phoneDigits(phone);
  var base = d.length === 10 ? 'sms:+1' + d : (d ? 'sms:+' + d : 'sms:');
  return base + '?body=' + encodeURIComponent(body || '');
}

function directionsUrl(address) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address || '');
}

function sitePreviewUrl(slug) {
  var origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
  return origin + '/' + slug + '/';
}

function sitesCatalogUrl() {
  var origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
  return origin + '/sites.json';
}

function newClaimDoc(lead, login, name) {
  var now = new Date();
  var exp = new Date(now.getTime() + CLAIM_TTL_MIN * 60 * 1000);
  return {
    slug: lead.slug,
    business_name: lead.name,
    phone: lead.phone,
    category: lead.category,
    address: lead.address,
    claimed_by: login,
    claimed_by_name: name,
    claimed_at: now.toISOString(),
    claim_expires_at: exp.toISOString(),
    status: 'claimed',
    outcome: null,
    note: null
  };
}

function newIntakeDoc(f, login, claimSlug) {
  var id = 'in_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  return {
    id: id,
    business_name: f.biz,
    contact_name: f.contact,
    phone: f.phone,
    email: f.email,
    wants: f.wants,
    notes: f.notes,
    status: 'open',
    claim_slug: claimSlug || null,
    created_by: login,
    created_at: new Date().toISOString()
  };
}

function claimPath(slug) { return 'sitedesk/data/claims/' + slug + '.json'; }
function intakePath(id) { return 'sitedesk/data/intakes/' + id + '.json'; }

function ghErrorMessage(status) {
  if (status === 401) return 'Bad token. Check your token and try again.';
  if (status === 403) return 'GitHub refused the request. The token may lack repo scope or hit a rate limit.';
  if (status === 404) return 'Not found on GitHub.';
  if (status === 422) return 'Someone else just claimed this lead.';
  return 'GitHub request failed (status ' + status + ').';
}

function feedItem(audience, title, body, link) {
  var now = new Date();
  var id = 'ev_' + now.getTime().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  return {
    id: id,
    ts: now.toISOString(),
    audience: audience,
    title: String(title || ''),
    body: String(body || ''),
    link: link || null
  };
}

function feedAppendCap(feed, item, cap) {
  var arr = Array.isArray(feed) ? feed.slice() : [];
  arr.unshift(item);
  return arr.slice(0, cap);
}

/* Newest items addressed to me or "all" that I have not seen yet,
   returned oldest-first so popups fire in order. */
function feedNewItems(feed, seenArr, login) {
  var seen = seenArr || [];
  var out = [];
  for (var i = 0; i < feed.length; i++) {
    var it = feed[i];
    if (!it || !it.id) continue;
    if (it.audience !== 'all' && it.audience !== login) continue;
    if (seen.indexOf(it.id) !== -1) continue;
    out.push(it);
  }
  out.reverse();
  return out;
}

function capSeenIds(arr) {
  var out = [], seen = {};
  for (var i = 0; i < arr.length; i++) {
    var id = arr[i];
    if (id && !seen[id]) { seen[id] = 1; out.push(id); }
    if (out.length >= 500) break;
  }
  return out;
}

function timeAgo(ts, nowMs) {
  var t = Date.parse(ts);
  if (isNaN(t)) return '';
  var diff = Math.max(0, (nowMs || Date.now()) - t);
  var m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  var h = Math.floor(m / 60);
  if (h < 24) return h + ' hr ago';
  var d = Math.floor(h / 24);
  if (d < 7) return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  return new Date(t).toISOString().slice(0, 10);
}

/* ---------------- GitHub API layer ---------------- */

function gh(method, path, body) {
  return fetch(API + path, {
    method: method,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + S.token,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function getFile(path) {
  return gh('GET', '/repos/' + OWNER + '/' + REPO + '/contents/' + path + '?ref=main')
    .then(function (res) {
      if (res.status === 404) return { status: 404 };
      if (!res.ok) throw Object.assign(new Error(ghErrorMessage(res.status)), { status: res.status });
      return res.json().then(function (j) {
        return { status: 200, sha: j.sha, data: JSON.parse(b64decodeUtf8(j.content)) };
      });
    });
}

function putFile(path, obj, sha, message) {
  var body = { message: message, content: b64encodeUtf8(JSON.stringify(obj, null, 2)), branch: 'main' };
  if (sha) body.sha = sha;
  return gh('PUT', '/repos/' + OWNER + '/' + REPO + '/contents/' + path, body)
    .then(function (res) {
      if (!res.ok) throw Object.assign(new Error(ghErrorMessage(res.status)), { status: res.status });
      return res.json();
    });
}

function deleteFile(path, sha, message) {
  return gh('DELETE', '/repos/' + OWNER + '/' + REPO + '/contents/' + path,
    { message: message, sha: sha, branch: 'main' })
    .then(function (res) {
      if (!res.ok) throw Object.assign(new Error(ghErrorMessage(res.status)), { status: res.status });
      return res.json();
    });
}

function listTree(prefix) {
  return gh('GET', '/repos/' + OWNER + '/' + REPO + '/git/trees/main?recursive=1')
    .then(function (res) {
      if (!res.ok) throw Object.assign(new Error(ghErrorMessage(res.status)), { status: res.status });
      return res.json();
    })
    .then(function (j) {
      return (j.tree || [])
        .filter(function (n) { return n.type === 'blob' && n.path.indexOf(prefix) === 0 && n.path.slice(-5) === '.json'; })
        .map(function (n) { return n.path; });
    });
}

/* ---------------- DOM helpers ---------------- */

function el(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

var toastTimer = null;
function toast(msg, isErr) {
  var t = el('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.className = 'toast'; }, 4200);
}

function showView(name) {
  S.view = name;
  var views = document.querySelectorAll('.view');
  for (var i = 0; i < views.length; i++) views[i].classList.remove('on');
  el('view-' + name).classList.add('on');
  var btns = document.querySelectorAll('#nav button');
  for (var k = 0; k < btns.length; k++) {
    btns[k].classList.toggle('on', btns[k].getAttribute('data-view') === name);
  }
  window.scrollTo(0, 0);
}

function renderNav() {
  el('nav').style.display = S.me ? 'flex' : 'none';
  el('navAdmin').style.display = (S.me && (S.me.role === 'head' || S.me.role === 'admin')) ? 'flex' : 'none';
  el('whoLine').textContent = S.me ? (S.me.name + ' (' + S.me.role + ')') : '';
  updateBell([]);
}

/* ---------------- auth ---------------- */

function signOut() {
  S.token = null; S.me = null; S.users = null;
  S.sites = null; S.claimCache = {}; S.queue = []; S.myClaims = []; S.intakes = [];
  try { localStorage.removeItem(LS_TOKEN); } catch (e) {}
  var ask = el('notifAsk');
  if (ask) ask.style.display = 'none';
  renderNav();
  showView('signin');
}

function failSignin(msg) {
  S.token = null;
  try { localStorage.removeItem(LS_TOKEN); } catch (e) {}
  el('signinErr').textContent = msg;
}

function signIn() {
  var token = el('pat').value.trim();
  if (!token) { el('signinErr').textContent = 'Paste your token first.'; return; }
  el('signinErr').textContent = 'Checking...';
  S.token = token;
  gh('GET', '/user').then(function (res) {
    if (res.status === 401) { failSignin('Bad token. Check your token and try again.'); return null; }
    if (!res.ok) { failSignin(ghErrorMessage(res.status)); return null; }
    return res.json();
  }).then(function (u) {
    if (!u) return;
    var login = u.login;
    return getFile('sitedesk/data/users.json').then(function (f) {
      var users = f.status === 200 ? f.data : {};
      var rec = users[login];
      if (!rec) {
        if (login === OWNER) {
          rec = { role: 'head', status: 'approved', name: 'Head' };
        } else {
          failSignin('No staff record for @' + login + '. Ask the head to add you.');
          return;
        }
      }
      if (rec.status !== 'approved') {
        failSignin('Your account is ' + rec.status + '. Ask the head or an admin to approve you.');
        return;
      }
      S.me = { login: login, name: rec.name || login, role: rec.role || 'caller', status: 'approved' };
      S.users = users;
      try { localStorage.setItem(LS_TOKEN, token); } catch (e) {}
      try {
        var saved = JSON.parse(localStorage.getItem(LS_MYCLAIMS) || '[]');
        S.myClaimSlugs = Array.isArray(saved) ? saved : [];
      } catch (e) { S.myClaimSlugs = []; }
      el('pat').value = '';
      el('signinErr').textContent = '';
      renderNav();
      showView('queue');
      afterSigninNotifSetup();
      return loadSites();
    });
  }).catch(function (e) {
    failSignin(e.message || 'Sign in failed.');
  });
}

function tryAutoSignin() {
  var token = null;
  try { token = localStorage.getItem(LS_TOKEN); } catch (e) {}
  if (!token) { showView('signin'); return; }
  S.token = token;
  gh('GET', '/user').then(function (res) {
    if (!res.ok) { signOut(); showView('signin'); return null; }
    return res.json();
  }).then(function (u) {
    if (!u) return;
    return getFile('sitedesk/data/users.json').then(function (f) {
      var users = f.status === 200 ? f.data : {};
      var rec = users[u.login] || (u.login === OWNER ? { role: 'head', status: 'approved', name: 'Head' } : null);
      if (!rec || rec.status !== 'approved') { signOut(); showView('signin'); return; }
      S.me = { login: u.login, name: rec.name || u.login, role: rec.role || 'caller', status: 'approved' };
      S.users = users;
      try {
        var saved = JSON.parse(localStorage.getItem(LS_MYCLAIMS) || '[]');
        S.myClaimSlugs = Array.isArray(saved) ? saved : [];
      } catch (e) { S.myClaimSlugs = []; }
      renderNav();
      showView('queue');
      afterSigninNotifSetup();
      return loadSites();
    });
  }).catch(function () { signOut(); showView('signin'); });
}

/* ---------------- leads / queue ---------------- */

function loadSites() {
  if (S.sites) { buildQueue(); return Promise.resolve(); }
  return fetch(sitesCatalogUrl()).then(function (res) {
    if (!res.ok) throw new Error('Could not load the site catalog.');
    return res.json();
  }).then(function (data) {
    S.sites = normSites(data);
    S.sitesBySlug = {};
    S.sites.forEach(function (l) { S.sitesBySlug[l.slug] = l; });
    var cats = {};
    S.sites.forEach(function (l) { if (l.category) cats[l.category] = 1; });
    var sel = el('fcat');
    Object.keys(cats).sort().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    });
    buildQueue();
  }).catch(function (e) {
    el('queueList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  });
}

function filteredSites() {
  var q = S.filters.q.toLowerCase();
  return S.sites.filter(function (l) {
    if (S.filters.cat && l.category !== S.filters.cat) return false;
    if (S.filters.phone && !phoneDigits(l.phone)) return false;
    if (q) {
      var hay = (l.name + ' ' + l.phone + ' ' + l.address).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
}

function buildQueue() {
  S.queue = shuffle(filteredSites());
  S.shown = 0;
  el('queueList').innerHTML = '';
  renderMore(true);
}

function claimState(slug) {
  var c = S.claimCache[slug];
  if (c === undefined) return 'unknown';
  if (!c) return 'open';
  if (isExpired(c, Date.now())) return 'open';
  return c.claimed_by === (S.me && S.me.login) ? 'mine' : 'taken';
}

function checkClaim(slug) {
  if (S.claimCache[slug] !== undefined) return Promise.resolve(S.claimCache[slug]);
  return getFile(claimPath(slug)).then(function (f) {
    var doc = f.status === 200 ? f.data : null;
    S.claimCache[slug] = doc;
    return doc;
  }).catch(function () { return null; });
}

function renderMore(reset) {
  var list = el('queueList');
  if (reset) list.innerHTML = '';
  var next = S.queue.slice(S.shown, S.shown + PAGE_SIZE);
  S.shown += next.length;
  el('queueMeta').textContent = S.queue.length + ' leads in queue. Showing ' + Math.min(S.shown, S.queue.length) + '.';
  el('btnMore').style.display = S.shown < S.queue.length ? 'block' : 'none';
  if (!next.length && reset) {
    list.innerHTML = '<div class="empty">No leads match. Loosen the filters.</div>';
    return;
  }
  var jobs = next.map(function (lead) {
    return checkClaim(lead.slug).then(function () { return lead; });
  });
  Promise.all(jobs).then(function (leads) {
    leads.forEach(function (lead) { list.appendChild(queueCard(lead)); });
  });
}

function queueCard(lead) {
  var st = claimState(lead.slug);
  var div = document.createElement('div');
  div.className = 'card';
  div.id = 'q-' + lead.slug;
  var badge = st === 'mine' ? '<span class="badge claimed">yours</span>'
    : st === 'taken' ? '<span class="badge">claimed</span>'
    : '<span class="badge open">open</span>';
  div.innerHTML =
    '<div class="leadtitle">' + esc(lead.name) + '</div>' +
    '<div class="kv">' + esc(lead.category || 'No category') + ' ' + badge + '</div>' +
    (lead.phone ? '<div class="kv">Phone: <b>' + esc(lead.phone) + '</b></div>' : '') +
    (lead.address ? '<div class="kv">' + esc(lead.address) + '</div>' : '') +
    '<div class="row" style="margin-top:10px">' +
      '<a class="btn ghost small" target="_blank" rel="noopener" href="' + esc(sitePreviewUrl(lead.slug)) + '">Preview</a>' +
      (st === 'open'
        ? '<button class="btn small" data-claim="' + esc(lead.slug) + '">Claim</button>'
        : st === 'mine'
        ? '<button class="btn ghost small" data-goto-claims>View claim</button>'
        : '<span class="muted">Claimed by someone else</span>') +
    '</div>';
  var cb = div.querySelector('[data-claim]');
  if (cb) cb.addEventListener('click', function () { claimLead(lead.slug); });
  var gb = div.querySelector('[data-goto-claims]');
  if (gb) gb.addEventListener('click', function () { showView('claims'); refreshMyClaims(); });
  return div;
}

function rememberClaimSlug(slug) {
  if (S.myClaimSlugs.indexOf(slug) === -1) {
    S.myClaimSlugs.push(slug);
    try { localStorage.setItem(LS_MYCLAIMS, JSON.stringify(S.myClaimSlugs)); } catch (e) {}
  }
}

function forgetClaimSlug(slug) {
  S.myClaimSlugs = S.myClaimSlugs.filter(function (s) { return s !== slug; });
  try { localStorage.setItem(LS_MYCLAIMS, JSON.stringify(S.myClaimSlugs)); } catch (e) {}
}

function activeMyClaims() {
  return S.myClaims.filter(function (c) { return !isExpired(c, Date.now()) && c.status !== 'sold'; });
}

function claimLead(slug) {
  var lead = S.sitesBySlug[slug];
  if (!lead) return;
  if (activeMyClaims().length >= MAX_ACTIVE_CLAIMS) {
    toast('You already have ' + MAX_ACTIVE_CLAIMS + ' active claims. Finish or release one first.', true);
    return;
  }
  getFile(claimPath(slug)).then(function (f) {
    var existing = f.status === 200 ? f.data : null;
    if (existing && !isExpired(existing, Date.now())) {
      S.claimCache[slug] = existing;
      toast(existing.claimed_by === S.me.login ? 'This is already in your claims.' : 'Just claimed by someone else.', true);
      rerenderQueueCard(slug);
      return null;
    }
    var doc = newClaimDoc(lead, S.me.login, S.me.name);
    var p = (existing && existing.claim_expires_at)
      ? putFile(claimPath(slug), doc, f.sha, 'reclaim ' + slug + ' by ' + S.me.login)
      : putFile(claimPath(slug), doc, null, 'claim ' + slug + ' by ' + S.me.login);
    return p.then(function () {
      S.claimCache[slug] = doc;
      rememberClaimSlug(slug);
      rerenderQueueCard(slug);
      toast('Claimed. Call them now.');
    });
  }).catch(function (e) {
    if (e && e.status === 422) {
      S.claimCache[slug] = undefined;
      toast('Just claimed by someone else.', true);
      checkClaim(slug).then(function () { rerenderQueueCard(slug); });
    } else {
      toast((e && e.message) || 'Claim failed.', true);
    }
  });
}

function rerenderQueueCard(slug) {
  var old = el('q-' + slug);
  var lead = S.sitesBySlug[slug];
  if (old && lead) old.replaceWith(queueCard(lead));
}

/* ---------------- my claims ---------------- */

function scanClaimSlugs() {
  return listTree('sitedesk/data/claims/').then(function (paths) {
    return paths.map(function (p) {
      var m = p.match(/sitedesk\/data\/claims\/(.+)\.json$/);
      return m ? m[1] : null;
    }).filter(Boolean);
  }).catch(function () { return S.myClaimSlugs.slice(); });
}

function refreshMyClaims() {
  el('claimsList').innerHTML = '<div class="empty">Loading your claims...</div>';
  return scanClaimSlugs().then(function (slugs) {
    var jobs = slugs.map(function (slug) {
      return getFile(claimPath(slug)).then(function (f) {
        if (f.status !== 200) { forgetClaimSlug(slug); return null; }
        S.claimCache[slug] = f.data;
        f.data._sha = f.sha;
        return f.data;
      }).catch(function () { return null; });
    });
    return Promise.all(jobs);
  }).then(function (docs) {
    var now = Date.now();
    S.myClaims = docs.filter(function (d) {
      return d && d.claimed_by === S.me.login && !isExpired(d, now);
    });
    S.myClaims.forEach(function (d) { rememberClaimSlug(d.slug); });
    renderMyClaims();
  }).catch(function (e) {
    el('claimsList').innerHTML = '<div class="empty">' + esc(e.message || 'Could not load claims.') + '</div>';
  });
}

function renderMyClaims() {
  var list = el('claimsList');
  var act = activeMyClaims();
  el('claimsMeta').textContent = act.length + ' of ' + MAX_ACTIVE_CLAIMS + ' claim slots used.';
  if (!S.myClaims.length) {
    list.innerHTML = '<div class="empty">No active claims. Grab one from the queue.</div>';
    return;
  }
  list.innerHTML = '';
  S.myClaims.forEach(function (c) { list.appendChild(claimCard(c)); });
}

function claimCard(c) {
  var div = document.createElement('div');
  div.className = 'card';
  var exp = new Date(c.claim_expires_at);
  var mins = Math.max(0, Math.round((exp.getTime() - Date.now()) / 60000));
  var statusBadge = c.status === 'sold' ? '<span class="badge sold">sold</span>' : '<span class="badge claimed">claimed</span>';
  var tel = telHref(c.phone);
  div.innerHTML =
    '<div class="leadtitle">' + esc(c.business_name) + '</div>' +
    '<div class="kv">' + statusBadge +
    (c.outcome ? ' <span class="badge">' + esc(c.outcome) + '</span>' : '') +
    ' <span class="muted">expires in ' + mins + ' min</span></div>' +
    (c.phone ? '<div class="kv">Phone: <b>' + esc(c.phone) + '</b></div>' : '') +
    (c.address ? '<div class="kv">' + esc(c.address) + '</div>' : '') +
    '<div class="row" style="margin:10px 0">' +
      (tel ? '<a class="btn small" href="' + esc(tel) + '">Call</a>' : '') +
      (tel ? '<button class="btn ghost small" data-sms>Text draft</button>' : '') +
      '<a class="btn ghost small" target="_blank" rel="noopener" href="' + esc(sitePreviewUrl(c.slug)) + '">Preview</a>' +
      (c.address ? '<a class="btn ghost small" target="_blank" rel="noopener" href="' + esc(directionsUrl(c.address)) + '">Directions</a>' : '') +
    '</div>' +
    '<div class="row" style="margin-bottom:8px">' +
      ['interested', 'not interested', 'no answer', 'wrong number', 'do not call'].map(function (o) {
        return '<button class="btn ghost small" data-outcome="' + esc(o) + '">' + esc(o) + '</button>';
      }).join('') +
    '</div>' +
    '<label>Note</label><textarea data-note rows="2">' + esc(c.note || '') + '</textarea>' +
    '<div class="row" style="margin-top:8px">' +
      '<button class="btn ghost small" data-savenote>Save note</button>' +
      '<button class="btn danger small" data-release>Release</button>' +
    '</div>';
  var smsBtn = div.querySelector('[data-sms]');
  if (smsBtn) smsBtn.addEventListener('click', function () {
    var draft = 'Hi, this is ' + S.me.name + ' from SiteDesk. We built a free preview website for ' +
      c.business_name + ': ' + sitePreviewUrl(c.slug) +
      ' Building it was free. Keeping it live with hosting and management is $27 per month. Want me to turn it on for you?';
    window.location.href = smsHref(c.phone, draft);
  });
  var outs = div.querySelectorAll('[data-outcome]');
  for (var i = 0; i < outs.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () { setOutcome(c, btn.getAttribute('data-outcome'), div); });
    })(outs[i]);
  }
  div.querySelector('[data-savenote]').addEventListener('click', function () {
    saveClaimNote(c, div.querySelector('[data-note]').value);
  });
  div.querySelector('[data-release]').addEventListener('click', function () { releaseClaim(c); });
  return div;
}

function setOutcome(c, outcome, cardEl) {
  var note = cardEl.querySelector('[data-note]').value;
  getFile(claimPath(c.slug)).then(function (f) {
    if (f.status !== 200) { toast('Claim file is gone. It may have expired.', true); return; }
    var doc = f.data;
    doc.outcome = outcome;
    doc.note = note;
    return putFile(claimPath(c.slug), doc, f.sha, 'outcome ' + outcome + ' on ' + c.slug).then(function () {
      S.claimCache[c.slug] = doc;
      toast('Outcome saved: ' + outcome);
      if (outcome === 'interested') openIntakeForm(c);
      else refreshMyClaims();
    });
  }).catch(function (e) { toast((e && e.message) || 'Could not save outcome.', true); });
}

function saveClaimNote(c, note) {
  getFile(claimPath(c.slug)).then(function (f) {
    if (f.status !== 200) { toast('Claim file is gone.', true); return; }
    var doc = f.data;
    doc.note = note;
    return putFile(claimPath(c.slug), doc, f.sha, 'note on ' + c.slug).then(function () {
      S.claimCache[c.slug] = doc;
      toast('Note saved.');
    });
  }).catch(function (e) { toast((e && e.message) || 'Could not save note.', true); });
}

function releaseClaim(c) {
  if (!confirm('Release this claim? It goes back to the open queue.')) return;
  getFile(claimPath(c.slug)).then(function (f) {
    if (f.status !== 200) { toast('Claim file is gone already.'); refreshMyClaims(); return; }
    return deleteFile(claimPath(c.slug), f.sha, 'release ' + c.slug + ' by ' + S.me.login).then(function () {
      S.claimCache[c.slug] = null;
      forgetClaimSlug(c.slug);
      toast('Released back to the queue.');
      refreshMyClaims();
    });
  }).catch(function (e) { toast((e && e.message) || 'Could not release.', true); });
}

/* ---------------- intake ---------------- */

function openIntakeForm(c) {
  S.intakeClaimSlug = c.slug;
  el('intakeFor').textContent = 'For: ' + c.business_name;
  el('inBiz').value = c.business_name || '';
  el('inPhone').value = c.phone || '';
  el('inContact').value = '';
  el('inEmail').value = '';
  el('inWants').value = '';
  el('inNotes').value = c.note || '';
  el('intakeErr').textContent = '';
  showView('intake');
}

function saveIntake() {
  var f = {
    biz: el('inBiz').value.trim(),
    contact: el('inContact').value.trim(),
    phone: el('inPhone').value.trim(),
    email: el('inEmail').value.trim(),
    wants: el('inWants').value.trim(),
    notes: el('inNotes').value.trim()
  };
  if (!f.biz) { el('intakeErr').textContent = 'Business name is required.'; return; }
  var doc = newIntakeDoc(f, S.me.login, S.intakeClaimSlug);
  el('intakeErr').textContent = 'Saving...';
  putFile(intakePath(doc.id), doc, null, 'intake for ' + f.biz + ' by ' + S.me.login)
    .then(function () {
      if (!S.intakeClaimSlug) { el('intakeErr').textContent = ''; toast('Intake saved.'); showView('intakes'); refreshIntakes(); return; }
      return getFile(claimPath(S.intakeClaimSlug)).then(function (cf) {
        if (cf.status !== 200) return;
        var cdoc = cf.data;
        cdoc.status = 'sold';
        return putFile(claimPath(S.intakeClaimSlug), cdoc, cf.sha, 'sold ' + S.intakeClaimSlug);
      }).then(function () {
        S.claimCache[S.intakeClaimSlug] = undefined;
        el('intakeErr').textContent = '';
        toast('Intake saved. Claim marked sold.');
        showView('intakes');
        refreshIntakes();
      });
    })
    .catch(function (e) { el('intakeErr').textContent = (e && e.message) || 'Could not save intake.'; });
}

/* ---------------- intakes list ---------------- */

function refreshIntakes() {
  el('intakesList').innerHTML = '<div class="empty">Loading intakes...</div>';
  listTree('sitedesk/data/intakes/').then(function (paths) {
    var jobs = paths.map(function (p) {
      return getFile(p).then(function (f) {
        if (f.status !== 200) return null;
        f.data._sha = f.sha;
        f.data._path = p;
        return f.data;
      }).catch(function () { return null; });
    });
    return Promise.all(jobs);
  }).then(function (docs) {
    S.intakes = docs.filter(Boolean).sort(function (a, b) {
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    renderIntakes();
  }).catch(function (e) {
    el('intakesList').innerHTML = '<div class="empty">' + esc(e.message || 'Could not load intakes.') + '</div>';
  });
}

function canEditBuild() {
  return S.me && (S.me.role === 'head' || S.me.role === 'admin' || S.me.role === 'builder');
}

function renderIntakes() {
  var list = el('intakesList');
  if (!S.intakes.length) {
    list.innerHTML = '<div class="empty">No intakes yet.</div>';
    return;
  }
  list.innerHTML = '';
  S.intakes.forEach(function (d) {
    var div = document.createElement('div');
    div.className = 'card';
    div.innerHTML =
      '<div class="leadtitle">' + esc(d.business_name) + '</div>' +
      '<div class="kv"><span class="badge">' + esc(d.status || 'open') + '</span>' +
      ' <span class="muted">by ' + esc(d.created_by || '?') + ' on ' + esc((d.created_at || '').slice(0, 10)) + '</span></div>' +
      (d.contact_name ? '<div class="kv">Contact: <b>' + esc(d.contact_name) + '</b></div>' : '') +
      (d.phone ? '<div class="kv">Phone: <b>' + esc(d.phone) + '</b></div>' : '') +
      (d.wants ? '<div class="kv">Wants: ' + esc(d.wants) + '</div>' : '') +
      (d.notes ? '<div class="kv">Notes: ' + esc(d.notes) + '</div>' : '') +
      (canEditBuild()
        ? '<div class="row" style="margin-top:8px">' +
          ['open', 'building', 'done'].map(function (st) {
            return '<button class="btn ghost small" data-bstatus="' + st + '">' + st + '</button>';
          }).join('') + '</div>'
        : '');
    if (canEditBuild()) {
      var btns = div.querySelectorAll('[data-bstatus]');
      for (var i = 0; i < btns.length; i++) {
        (function (btn) {
          btn.addEventListener('click', function () { setIntakeStatus(d, btn.getAttribute('data-bstatus')); });
        })(btns[i]);
      }
    }
    list.appendChild(div);
  });
}

function setIntakeStatus(d, status) {
  getFile(d._path).then(function (f) {
    if (f.status !== 200) { toast('Intake file is gone.', true); return; }
    var doc = f.data;
    doc.status = status;
    return putFile(d._path, doc, f.sha, 'intake ' + d.id + ' -> ' + status).then(function () {
      toast('Build status: ' + status);
      refreshIntakes();
      if (d.created_by) {
        postEvent(d.created_by, 'Build update', (d.business_name || 'A build') + ': status is now ' + status + '.', '#intakes')
          .catch(function () { /* status saved; notification is best effort */ });
      }
    });
  }).catch(function (e) { toast((e && e.message) || 'Could not update status.', true); });
}

/* ---------------- admin ---------------- */

function isStaff() {
  return S.me && (S.me.role === 'head' || S.me.role === 'admin');
}

function renderAdmin() {
  if (!isStaff()) { showView('queue'); return; }
  var list = el('usersList');
  list.innerHTML = '';
  var logins = Object.keys(S.users || {}).sort();
  if (!logins.length) list.innerHTML = '<p class="muted">Staff list is empty.</p>';
  logins.forEach(function (login) {
    var u = S.users[login];
    var div = document.createElement('div');
    div.className = 'card';
    var roleCtl = (S.me.role === 'head')
      ? '<select data-role style="max-width:160px">' +
        ['caller', 'builder', 'admin', 'head'].map(function (r) {
          return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r + '</option>';
        }).join('') + '</select>'
      : '<span class="badge ' + esc(u.role) + '">' + esc(u.role) + '</span>';
    div.innerHTML =
      '<div class="row" style="justify-content:space-between">' +
        '<div><b>' + esc(u.name || login) + '</b> <span class="muted">@' + esc(login) + '</span></div>' +
        '<span class="badge">' + esc(u.status) + '</span>' +
      '</div>' +
      '<div class="row" style="margin-top:8px">' + roleCtl +
        (u.status === 'pending' ? '<button class="btn small" data-approve>Approve</button><button class="btn ghost small" data-reject>Reject</button>' : '') +
        (u.status === 'approved' ? '<button class="btn ghost small" data-disable>Disable</button>' : '') +
      '</div>';
    var ap = div.querySelector('[data-approve]');
    if (ap) ap.addEventListener('click', function () { setUser(login, { status: 'approved' }); });
    var rj = div.querySelector('[data-reject]');
    if (rj) rj.addEventListener('click', function () { setUser(login, { status: 'rejected' }); });
    var dis = div.querySelector('[data-disable]');
    if (dis) dis.addEventListener('click', function () { setUser(login, { status: 'disabled' }); });
    var rs = div.querySelector('[data-role]');
    if (rs) rs.addEventListener('change', function () { setUser(login, { role: rs.value }); });
    list.appendChild(div);
  });
}

function setUser(login, patch) {
  getFile('sitedesk/data/users.json').then(function (f) {
    if (f.status !== 200) { toast('Staff file is missing.', true); return; }
    var users = f.data || {};
    users[login] = Object.assign({}, users[login], patch);
    return putFile('sitedesk/data/users.json', users, f.sha, 'update staff ' + login + ' by ' + S.me.login).then(function () {
      S.users = users;
      toast('Saved.');
      renderAdmin();
      var note = null;
      if (patch.status === 'approved') {
        note = postEvent(login, 'Account approved', 'You can now sign in and start calling.', '#queue');
      } else if (patch.status === 'rejected') {
        note = postEvent(login, 'Account not approved', 'Your SiteDesk access was not approved. Contact the head if this is a mistake.', '#queue');
      }
      if (note) note.catch(function () { /* saved; notification is best effort */ });
    });
  }).catch(function (e) { toast((e && e.message) || 'Could not save.', true); });
}

function lookupClaim() {
  var slug = el('adminSlug').value.trim();
  var box = el('adminClaim');
  if (!slug) { box.innerHTML = '<p class="muted">Enter a slug.</p>'; return; }
  box.innerHTML = '<p class="muted">Looking up...</p>';
  getFile(claimPath(slug)).then(function (f) {
    if (f.status !== 200) {
      box.innerHTML = '<p class="muted">No claim file for that slug. The lead is open.</p>';
      return;
    }
    var c = f.data;
    box.innerHTML =
      '<div class="card"><div class="leadtitle">' + esc(c.business_name || slug) + '</div>' +
      '<div class="kv">Claimed by <b>' + esc(c.claimed_by_name || c.claimed_by || '?') + '</b> (@' + esc(c.claimed_by || '?') + ')</div>' +
      '<div class="kv">Status: <b>' + esc(c.status || '?') + '</b>' +
      (c.outcome ? ', outcome: <b>' + esc(c.outcome) + '</b>' : '') + '</div>' +
      '<div class="kv">Expires: ' + esc(c.claim_expires_at || '?') + '</div>' +
      '<div class="row" style="margin-top:8px"><button class="btn danger small" id="btnUnlock">Unlock claim</button></div></div>';
    el('btnUnlock').addEventListener('click', function () {
      if (!confirm('Unlock this claim? It goes back to the open queue.')) return;
      deleteFile(claimPath(slug), f.sha, 'unlock ' + slug + ' by ' + S.me.login)
        .then(function () {
          S.claimCache[slug] = null;
          box.innerHTML = '<p class="muted">Unlocked. The lead is open again.</p>';
        })
        .catch(function (e) { toast((e && e.message) || 'Could not unlock.', true); });
    });
  }).catch(function (e) { box.innerHTML = '<p class="muted">' + esc(e.message || 'Lookup failed.') + '</p>'; });
}

/* ---------------- notifications (device popups + bell, no backend) ---------------- */

function lsGetObj(key) {
  try {
    var v = JSON.parse(localStorage.getItem(key) || '{}');
    return (v && typeof v === 'object') ? v : {};
  } catch (e) { return {}; }
}

function lsSetObj(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
}

/* Returns null when this login has never seen the feed (first run: seed silently). */
function getSeenIds(login) {
  var o = lsGetObj(LS_FEED_SEEN);
  return Object.prototype.hasOwnProperty.call(o, login) ? o[login] : null;
}

function setSeenIds(login, ids) {
  var o = lsGetObj(LS_FEED_SEEN);
  o[login] = ids;
  lsSetObj(LS_FEED_SEEN, o);
}

function loadFeed() {
  return getFile(FEED_PATH).then(function (f) {
    if (f.status === 404) return [];
    return Array.isArray(f.data) ? f.data : [];
  });
}

/* Appends one event to feed.json (creates it on first use, keeps newest 200). */
function postEvent(audience, title, body, link) {
  var item = feedItem(audience, title, body, link);
  return getFile(FEED_PATH).then(function (f) {
    var feed = (f.status === 200 && Array.isArray(f.data)) ? f.data : [];
    var next = feedAppendCap(feed, item, FEED_CAP);
    return putFile(FEED_PATH, next, f.status === 200 ? f.sha : null, 'notify ' + String(audience))
      .then(function () { return item; });
  });
}

function deviceNotify(item) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(item.title || 'SiteDesk', {
        body: item.body || '',
        icon: 'icon.svg',
        tag: item.id
      });
    }
  } catch (e) {}
}

function toastSeq(msgs) {
  var i = 0;
  function next() {
    if (i >= msgs.length) return;
    toast(msgs[i], false);
    i++;
    if (i < msgs.length) setTimeout(next, 4400);
  }
  next();
}

/* Diff feed against last-seen and popup for genuinely new items (max 5). */
function announceNewItems(feed, seedIfFresh) {
  var login = S.me && S.me.login;
  if (!login) return;
  var seen = getSeenIds(login);
  if (seen === null) {
    if (seedIfFresh) {
      setSeenIds(login, capSeenIds(feed.map(function (it) { return it && it.id; })));
    }
    return;
  }
  var fresh = feedNewItems(feed, seen, login).slice(0, MAX_POPUPS);
  if (fresh.length) {
    fresh.forEach(function (it) { deviceNotify(it); });
    toastSeq(fresh.map(function (it) { return it.title + ': ' + it.body; }));
  }
  var ids = capSeenIds(feed.map(function (it) { return it && it.id; }).concat(seen));
  setSeenIds(login, ids);
}

function updateBell(feed) {
  var btn = el('bellBtn'), badge = el('bellBadge');
  if (!S.me) { btn.style.display = 'none'; return; }
  btn.style.display = 'block';
  var login = S.me.login;
  var seen = getSeenIds(login) || [];
  var unread = feedNewItems(feed || [], seen, login).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }
}

function checkFeedOnSignin() {
  loadFeed().then(function (feed) {
    announceNewItems(feed, true);
    updateBell(feed);
  }).catch(function () { updateBell([]); });
}

function openNotifs() {
  showView('notifs');
  el('notifList').innerHTML = '<div class="empty">Loading notifications...</div>';
  loadFeed().then(function (feed) {
    var login = S.me && S.me.login;
    if (login) setSeenIds(login, capSeenIds(feed.map(function (it) { return it && it.id; })));
    renderNotifs(feed);
    updateBell(feed);
  }).catch(function (e) {
    el('notifList').innerHTML = '<div class="empty">' + esc(e.message || 'Could not load notifications.') + '</div>';
  });
}

function notifGoto(target) {
  if (target === 'claims') refreshMyClaims();
  if (target === 'intakes') refreshIntakes();
  if (target === 'admin') renderAdmin();
  showView(target);
}

function renderNotifs(feed) {
  var list = el('notifList');
  var login = S.me && S.me.login;
  var mine = (feed || []).filter(function (it) {
    return it && (it.audience === 'all' || it.audience === login);
  });
  if (!mine.length) {
    list.innerHTML = '<div class="empty">No notifications yet.</div>';
    return;
  }
  list.innerHTML = '';
  mine.forEach(function (it) {
    var div = document.createElement('div');
    div.className = 'card';
    var target = (it.link && it.link.charAt(0) === '#') ? it.link.slice(1) : null;
    div.innerHTML =
      '<div class="leadtitle">' + esc(it.title || 'Notification') + '</div>' +
      (it.body ? '<div class="kv">' + esc(it.body) + '</div>' : '') +
      '<div class="ntime">' + esc(timeAgo(it.ts, Date.now())) + '</div>' +
      (target
        ? '<div class="row" style="margin-top:8px"><button class="btn ghost small" data-goto="' + esc(target) + '">Open</button></div>'
        : (it.link
          ? '<div class="row" style="margin-top:8px"><a class="btn ghost small" target="_blank" rel="noopener" href="' + esc(it.link) + '">Open</a></div>'
          : ''));
    var go = div.querySelector('[data-goto]');
    if (go) go.addEventListener('click', function () { notifGoto(go.getAttribute('data-goto')); });
    list.appendChild(div);
  });
}

function markNotifAsked() {
  if (!S.me) return;
  var o = lsGetObj(LS_NOTIF_ASKED);
  o[S.me.login] = 1;
  lsSetObj(LS_NOTIF_ASKED, o);
}

function maybeShowNotifAsk() {
  var ask = el('notifAsk');
  if (!ask) return;
  ask.style.display = 'none';
  if (typeof Notification === 'undefined') return;
  if (!S.me) return;
  var asked = lsGetObj(LS_NOTIF_ASKED);
  if (Notification.permission === 'default' && !asked[S.me.login]) {
    ask.style.display = 'block';
  }
}

function afterSigninNotifSetup() {
  checkFeedOnSignin();
  maybeShowNotifAsk();
}

function sendAnnouncement() {
  var title = el('ancTitle').value.trim();
  var body = el('ancBody').value.trim();
  if (!title || !body) { toast('Write a title and a message first.', true); return; }
  toast('Sending...');
  postEvent('all', title, body, null).then(function () {
    el('ancTitle').value = '';
    el('ancBody').value = '';
    toast('Announcement sent to all callers.');
  }).catch(function (e) {
    toast((e && e.message) || 'Could not send announcement.', true);
  });
}

/* ---------------- wiring ---------------- */

function init() {
  el('btnSignIn').addEventListener('click', signIn);
  el('pat').addEventListener('keydown', function (e) { if (e.key === 'Enter') signIn(); });

  var navBtns = document.querySelectorAll('#nav button');
  for (var i = 0; i < navBtns.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-view');
        if (v === 'claims') refreshMyClaims();
        if (v === 'intakes') refreshIntakes();
        if (v === 'admin') renderAdmin();
        showView(v);
      });
    })(navBtns[i]);
  }

  el('btnApplyFilters').addEventListener('click', function () {
    S.filters.q = el('fq').value.trim();
    S.filters.cat = el('fcat').value;
    S.filters.phone = el('fphone').checked;
    buildQueue();
  });
  el('btnShuffle').addEventListener('click', buildQueue);
  el('btnMore').addEventListener('click', function () { renderMore(false); });
  el('btnRefreshClaims').addEventListener('click', refreshMyClaims);
  el('btnRefreshIntakes').addEventListener('click', refreshIntakes);
  el('btnSaveIntake').addEventListener('click', saveIntake);
  el('btnCancelIntake').addEventListener('click', function () { showView('claims'); });
  el('btnLookupClaim').addEventListener('click', lookupClaim);
  el('btnAnnounce').addEventListener('click', sendAnnouncement);

  el('bellBtn').addEventListener('click', openNotifs);
  el('btnRefreshFeed').addEventListener('click', function () {
    el('notifList').innerHTML = '<div class="empty">Checking...</div>';
    loadFeed().then(function (feed) {
      announceNewItems(feed, false);
      renderNotifs(feed);
      updateBell(feed);
    }).catch(function (e) {
      el('notifList').innerHTML = '<div class="empty">' + esc(e.message || 'Could not load notifications.') + '</div>';
    });
  });

  el('btnNotifEnable').addEventListener('click', function () {
    markNotifAsked();
    el('notifAsk').style.display = 'none';
    if (typeof Notification === 'undefined') return;
    Notification.requestPermission().then(function (p) {
      if (p === 'granted') toast('Popups enabled on this device.');
      else toast('Popups blocked. You can allow them later in browser settings.', true);
    }).catch(function () {});
  });
  el('btnNotifLater').addEventListener('click', function () {
    markNotifAsked();
    el('notifAsk').style.display = 'none';
  });

  var copiers = document.querySelectorAll('[data-copy]');
  for (var k = 0; k < copiers.length; k++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var txt = el(btn.getAttribute('data-copy')).textContent;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(function () { toast('Copied.'); });
        } else {
          var ta = document.createElement('textarea');
          ta.value = txt;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); toast('Copied.'); } catch (e) { toast('Copy failed.', true); }
          document.body.removeChild(ta);
        }
      });
    })(copiers[k]);
  }

  tryAutoSignin();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    b64encodeUtf8: b64encodeUtf8,
    b64decodeUtf8: b64decodeUtf8,
    normLead: normLead,
    normSites: normSites,
    isExpired: isExpired,
    shuffle: shuffle,
    phoneDigits: phoneDigits,
    telHref: telHref,
    smsHref: smsHref,
    directionsUrl: directionsUrl,
    sitePreviewUrl: sitePreviewUrl,
    sitesCatalogUrl: sitesCatalogUrl,
    newClaimDoc: newClaimDoc,
    newIntakeDoc: newIntakeDoc,
    claimPath: claimPath,
    intakePath: intakePath,
    ghErrorMessage: ghErrorMessage,
    feedItem: feedItem,
    feedAppendCap: feedAppendCap,
    feedNewItems: feedNewItems,
    capSeenIds: capSeenIds,
    timeAgo: timeAgo
  };
}
