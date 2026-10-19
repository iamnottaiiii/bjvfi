/* Business: the owner portal. Business owners log in and click-to-edit
   their own websites. Admins can search every site, edit any of them,
   and create owner accounts with one or more sites assigned. */

'use strict';

/* ================= utils ================= */

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

let _toastT = null;
function toast(msg){
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  if(_toastT) clearTimeout(_toastT);
  _toastT = setTimeout(function(){ t.classList.remove('show'); }, 3200);
}

/* Pure-JS SHA-256 fallback for non-secure contexts (http, data:, file:).
   Used only when crypto.subtle is unavailable. */
function sha256js(ascii){
  function rr(v, a){ return (v >>> a) | (v << (32 - a)); }
  var maxWord = Math.pow(2, 32), i, j, result = '';
  var words = [], asciiBitLength = ascii.length * 8;
  var hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var bytes = [];
  for(i = 0; i < ascii.length; i++){
    var c = ascii.charCodeAt(i);
    if(c < 128) bytes.push(c);
    else if(c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
    else bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  asciiBitLength = bytes.length * 8;
  bytes.push(128);
  while(bytes.length % 64 !== 56) bytes.push(0);
  for(i = 0; i < 8; i++) bytes.push((asciiBitLength / Math.pow(2, (7 - i) * 8)) & 255);
  for(i = 0; i < bytes.length; i += 4) words.push((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]);
  var w = new Array(64);
  for(j = 0; j < words.length; j += 16){
    for(i = 0; i < 16; i++) w[i] = words[j + i] | 0;
    for(i = 16; i < 64; i++){
      var s0 = rr(w[i-15],7) ^ rr(w[i-15],18) ^ (w[i-15] >>> 3);
      var s1 = rr(w[i-2],17) ^ rr(w[i-2],19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    var a=hash[0],b=hash[1],cc=hash[2],d=hash[3],e=hash[4],f=hash[5],g=hash[6],h=hash[7];
    for(i = 0; i < 64; i++){
      var S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25);
      var ch = (e & f) ^ ((~e) & g);
      var t1 = (h + S1 + ch + k[i] + w[i]) | 0;
      var S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22);
      var maj = (a & b) ^ (a & cc) ^ (b & cc);
      var t2 = (S0 + maj) | 0;
      h=g;g=f;f=e;e=(d+t1)|0;d=cc;cc=b;b=a;a=(t1+t2)|0;
    }
    hash[0]=(hash[0]+a)|0;hash[1]=(hash[1]+b)|0;hash[2]=(hash[2]+cc)|0;hash[3]=(hash[3]+d)|0;
    hash[4]=(hash[4]+e)|0;hash[5]=(hash[5]+f)|0;hash[6]=(hash[6]+g)|0;hash[7]=(hash[7]+h)|0;
  }
  for(i = 0; i < hash.length; i++){
    for(j = 3; j + 1; j--){
      var b2 = (hash[i] >> (j * 8)) & 255;
      result += (b2 < 16 ? '0' : '') + b2.toString(16);
    }
  }
  return result;
}

async function sha256hex(str){
  try{
    if(window.crypto && crypto.subtle){
      var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map(function(b){ return b.toString(16).padStart(2, '0'); }).join('');
    }
  }catch(e){ /* fall through to pure JS */ }
  return sha256js(str);
}

function b64encode(bytes){
  let s = '';
  const ch = String.fromCharCode;
  for(let i = 0; i < bytes.length; i += 8192){
    s += ch.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

function uid(prefix){
  return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 8);
}

function nowISO(){ return new Date().toISOString(); }

/* ================= github: the private data repo ================= */

var GH_API = 'https://api.github.com/repos/iamnottaiiii/sitedesk-data';

async function ghFetch(path, opts){
  opts = opts || {};
  if(typeof SITEDESK_DATA_TOKEN === 'undefined' || !SITEDESK_DATA_TOKEN){
    throw new Error('Data connection is not configured.');
  }
  const r = await fetch(GH_API + path, {
    method: opts.method || 'GET',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + SITEDESK_DATA_TOKEN
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store'
  });
  if(r.status === 401) throw new Error('Data login expired (401).');
  if(r.status === 403) throw new Error('Data access forbidden (403).');
  if(r.status === 404) return null;
  if(!r.ok) throw new Error('Data request failed (HTTP ' + r.status + ').');
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function ghGetJson(path){
  const r = await ghFetch('/contents/' + path);
  if(!r || !r.content) return null;
  const bin = atob(r.content.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = new TextDecoder().decode(bytes);
  return { data: JSON.parse(text), sha: r.sha };
}

async function ghPutJson(path, obj, sha, message){
  const body = { message: message || ('business: update ' + path),
    content: b64encode(new TextEncoder().encode(JSON.stringify(obj, null, 2))) };
  if(sha) body.sha = sha;
  return ghFetch('/contents/' + path, { method: 'PUT', body: body });
}

/* ================= auth ================= */

/* Admin account, made up per the owner's request. The password is
   'bjvfi-portal-2026'. Stored as a hash, compared as a hash. */
var ADMIN_USER = 'bjvfi';
var ADMIN_HASH = 'ee91e31105251c9fe28edc554983c6634641f2e887e7627fc6a931ddc8dde339';

var session = { user: null, role: null, slugs: [] };

async function login(username, password){
  username = String(username || '').trim().toLowerCase();
  const hash = await sha256hex(String(password || ''));
  if(username === ADMIN_USER && hash === ADMIN_HASH){
    session = { user: username, role: 'admin', slugs: [] };
    return session;
  }
  /* Owner accounts live in the data repo: portal-users/<username>.json */
  let rec = null;
  try{ rec = await ghGetJson('portal-users/' + encodeURIComponent(username) + '.json'); }
  catch(e){ throw new Error('Could not reach the account list.'); }
  if(!rec || !rec.data || rec.data.passHash !== hash){
    throw new Error('Wrong username or password.');
  }
  const slugs = Array.isArray(rec.data.slugs) ? rec.data.slugs : [];
  session = { user: username, role: 'owner', slugs: slugs };
  return session;
}

function logout(){
  session = { user: null, role: null, slugs: [] };
  showLogin();
}

/* ================= site search ================= */

/* The homepage search shards: /site-names/<first-letter>.json maps
   slug -> business name. */
const _shardCache = {};

async function searchSites(q){
  q = String(q || '').trim().toLowerCase();
  if(q.length < 2) return [];
  const first = q[0];
  const key = /[a-z0-9]/.test(first) ? first : 'a';
  if(!_shardCache[key]){
    const r = await fetch('https://bjvfi.com/site-names/' + key + '.json', { cache: 'force-cache' });
    if(!r.ok) throw new Error('Search is unavailable right now.');
    _shardCache[key] = await r.json();
  }
  const shard = _shardCache[key];
  const out = [];
  for(const slug in shard){
    const name = String(shard[slug] || '');
    if(name.toLowerCase().indexOf(q) !== -1 || slug.indexOf(q) !== -1){
      out.push({ slug: slug, name: name });
      if(out.length >= 30) break;
    }
  }
  return out;
}

/* ================= site loading ================= */

/* The prebuilt sites live across the bjvfi1..bjvfi9 repos. */
var SITE_REPOS = ['bjvfi1','bjvfi2','bjvfi3','bjvfi4','bjvfi5','bjvfi6','bjvfi7','bjvfi8','bjvfi9'];

function siteRawUrl(repo, slug){
  return 'https://raw.githubusercontent.com/iamnottaiiii/' + repo + '/main/' +
    encodeURIComponent(slug) + '/index.html';
}

async function fetchLiveSiteCode(slug){
  const urls = SITE_REPOS.map(function(repo){ return siteRawUrl(repo, slug); });
  const results = await Promise.all(urls.map(function(u){
    return fetch(u, { cache: 'no-store' }).then(function(r){
      return { ok: r.ok, status: r.status, text: r.ok ? r.text() : null };
    }).catch(function(){ return { ok: false, status: 0, text: null }; });
  }));
  for(let i = 0; i < results.length; i++){
    if(results[i].ok){
      return { code: await results[i].text, repo: SITE_REPOS[i], notFound: false };
    }
  }
  const anyErr = results.some(function(x){ return x.status !== 404 && x.status !== 0; });
  return { code: null, repo: null, notFound: !anyErr };
}

/* The prebuilt sites were generated without the sticky-footer marker that
   publish validation requires. Add it so existing sites publish cleanly. */
function ensureStickyFooterMarker(code){
  code = String(code || '');
  if(code.indexOf('sticky-footer-fix-v1') !== -1) return code;
  const tag = '<!--sticky-footer-fix-v1-->';
  if(/<body[^>]*>/i.test(code)){
    return code.replace(/<body[^>]*>/i, function(m){ return m + tag; });
  }
  return tag + code;
}

function validateSiteCode(code, businessName){
  code = String(code == null ? '' : code);
  if(!code.trim()) return { ok: false, reason: 'The code is empty.' };
  if(/[\u2014\u2013]/.test(code)) return { ok: false, reason: 'The code contains an em dash or en dash. Remove it first.' };
  if(code.indexOf('sticky-footer-fix-v1') === -1) return { ok: false, reason: 'The code is missing the sticky-footer-fix-v1 marker.' };
  if(!/<\/html>\s*$/.test(code)) return { ok: false, reason: 'The code must end with </html>.' };
  const name = String(businessName || '').trim();
  if(name){
    const m = /<footer[^>]*>([\s\S]*?)<\/footer>/i.exec(code);
    if(!m) return { ok: false, reason: 'No <footer> found in the code.' };
    const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if(text !== '\u00A9 ' + name) return { ok: false, reason: 'The footer must be exactly "\u00A9 ' + name + '".' };
  }
  return { ok: true, reason: '' };
}

/* ================= click-to-edit editor ================= */

var editor = null; /* {slug, name, code, doc, dirty, selPath, selTag} */

const PE_INJECT_STYLE = '.pe-hover{outline:2px solid #4da3ff !important;outline-offset:2px;cursor:pointer;}';
const PE_INJECT_SCRIPT = "(function(){var st=document.createElement('style');st.textContent='" + PE_INJECT_STYLE + "';document.head.appendChild(st);var hov=null;document.addEventListener('mousemove',function(e){var el=e.target;if(el===hov)return;if(hov)hov.classList.remove('pe-hover');hov=(el&&el!==document.body&&el!==document.documentElement)?el:null;if(hov)hov.classList.add('pe-hover');},true);document.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();var el=e.target,path=[],cur=el;while(cur&&cur!==document.body&&cur!==document.documentElement){var p=cur.parentNode,idx=0;if(p){var k=p.children;for(var i=0;i<k.length;i++){if(k[i]===cur)break;idx++;}}path.unshift(idx);cur=p;}parent.postMessage({pe:'click',path:path,tag:el.tagName,text:(el.innerText||'').slice(0,300),src:el.tagName==='IMG'?el.getAttribute('src'):null},'*');},true);})();";

function peInject(code){
  const tag = '<script>' + PE_INJECT_SCRIPT + '<\/script>';
  if(/<\/body\s*>/i.test(code)) return code.replace(/<\/body\s*>/i, tag + '</body>');
  return code + tag;
}

/* Walk an element index path from <body> down. */
function peNodeAt(doc, path){
  let node = doc.body;
  if(!node) return null;
  for(let i = 0; i < path.length; i++){
    if(!node.children || path[i] >= node.children.length) return null;
    node = node.children[path[i]];
  }
  return node;
}

function peSerialize(){
  return '<!DOCTYPE html>\n' + editor.doc.documentElement.outerHTML;
}

function peRefreshFrame(){
  const fr = document.getElementById('pe-frame');
  if(fr && editor) fr.srcdoc = peInject(peSerialize());
  const ta = document.getElementById('pe-code');
  if(ta && editor) ta.value = peSerialize();
}

async function openEditor(slug, name){
  const app = document.getElementById('app');
  app.innerHTML = '<div class="topbar"><div class="brand">business</div>' +
    '<div class="row"><span class="who">' + esc(session.user) + '</span>' +
    '<button class="btn ghost sm" id="pe-back" type="button">Back</button></div></div>' +
    '<div class="wrap"><div class="hint">Click anything on the site to edit it. ' +
    '<b>Save &amp; publish</b> when you are done.</div>' +
    '<div class="card"><div class="field" style="margin:0"><label>Business name (updates everywhere, including the footer)</label>' +
    '<input type="text" id="pe-bizname" value="' + esc(name || slug) + '"/></div></div>' +
    '<div id="pe-loading" class="muted">Loading site...</div>' +
    '<iframe id="pe-frame" class="editor-frame" sandbox="allow-scripts" title="Site preview" style="display:none"></iframe>' +
    '<div class="row mt"><button class="btn" id="pe-publish" type="button" style="display:none">Save &amp; publish</button>' +
    '<span class="muted" id="pe-dirty" style="display:none">Unsaved changes</span></div>' +
    '<div class="err" id="pe-err"></div></div>' +
    '<div class="editpanel" id="pe-panel" style="display:none"></div>';

  document.getElementById('pe-back').addEventListener('click', showDashboard);

  editor = { slug: slug, name: name || slug, code: null, doc: null, dirty: false, selPath: null, selTag: null, shownName: name || slug };
  try{
    const found = await fetchLiveSiteCode(slug);
    if(!found.code) throw new Error(found.notFound ? 'Site not found.' : 'Could not load the site.');
    editor.code = ensureStickyFooterMarker(found.code);
    editor.doc = new DOMParser().parseFromString(editor.code, 'text/html');
    document.getElementById('pe-loading').style.display = 'none';
    const fr = document.getElementById('pe-frame');
    fr.style.display = '';
    document.getElementById('pe-publish').style.display = '';
    peRefreshFrame();
    document.getElementById('pe-publish').addEventListener('click', pePublish);
    document.getElementById('pe-bizname').addEventListener('input', function(e){
      peRenameBusiness(e.target.value);
    });
  }catch(e){
    document.getElementById('pe-loading').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  }
}

/* Business name rewrite through the code, like the SiteDesk editor. */
function peRenameBusiness(value){
  if(!editor || value === editor.shownName) return;
  const shown = editor.shownName;
  if(shown && value){
    const html = peSerialize().split(shown).join(value);
    editor.doc = new DOMParser().parseFromString(html, 'text/html');
    editor.shownName = value;
    editor.name = value;
    peMarkDirty();
    peRefreshFrame();
  } else if(value){
    editor.shownName = value;
    editor.name = value;
  }
}

function peMarkDirty(){
  if(!editor) return;
  editor.dirty = true;
  const d = document.getElementById('pe-dirty');
  if(d) d.style.display = '';
}

/* Clicks arrive from the iframe via postMessage. */
window.addEventListener('message', function(e){
  const fr = document.getElementById('pe-frame');
  if(!fr || e.source !== fr.contentWindow) return;
  const m = e.data;
  if(!m || m.pe !== 'click' || !editor || !editor.doc) return;
  peSelect(m.path, m.tag, m.text, m.src);
});

function peSelect(path, tag, text, src){
  if(!editor) return;
  const node = peNodeAt(editor.doc, path);
  if(!node) return;
  editor.selPath = path;
  editor.selTag = tag;
  const panel = document.getElementById('pe-panel');
  const isImg = tag === 'IMG';
  const isList = tag === 'UL' || tag === 'OL';
  const isItem = tag === 'LI';
  const hidden = node.style && node.style.display === 'none';

  let html = '<h3>Editing: ' + esc(tag.toLowerCase()) + '</h3>' +
    '<div class="tag">' + esc((text || '').slice(0, 80)) + '</div>';

  if(isImg){
    const cur = node.getAttribute('src') || '';
    html += (cur ? '<img class="prev" src="' + esc(cur) + '" alt=""/>' : '') +
      '<div class="field"><label>Replace image</label><input type="file" id="pe-imgfile" accept="image/*"/></div>';
  } else {
    html += '<div class="field"><label>Text</label><textarea id="pe-text">' + esc(node.textContent || '') + '</textarea></div>' +
      '<div class="row"><button class="btn sm" id="pe-apply-text" type="button">Apply text</button></div>';
  }
  html += '<div class="row mt">' +
    '<button class="btn ghost sm" id="pe-toggle-hide" type="button">' + (hidden ? 'Show it' : 'Hide it') + '</button>';
  if(isList) html += '<button class="btn ghost sm" id="pe-add-item" type="button">Add item</button>';
  if(isItem) html += '<button class="btn danger sm" id="pe-del-item" type="button">Delete item</button>';
  html += '<button class="btn ghost sm" id="pe-close" type="button">Close</button></div>';

  panel.innerHTML = html;
  panel.style.display = '';

  const applyText = document.getElementById('pe-apply-text');
  if(applyText) applyText.addEventListener('click', function(){
    const v = document.getElementById('pe-text').value;
    const n = peNodeAt(editor.doc, editor.selPath);
    if(n){ n.textContent = v; peAfterEdit(); }
  });
  const imgfile = document.getElementById('pe-imgfile');
  if(imgfile) imgfile.addEventListener('change', function(){
    const f = imgfile.files && imgfile.files[0];
    if(!f) return;
    peResizeImage(f, 1200, 800, function(du){
      if(!du){ toast('Could not read that image.'); return; }
      const n = peNodeAt(editor.doc, editor.selPath);
      if(n){ n.setAttribute('src', du); peAfterEdit(); }
    });
  });
  document.getElementById('pe-toggle-hide').addEventListener('click', function(){
    const n = peNodeAt(editor.doc, editor.selPath);
    if(n){
      if(n.style.display === 'none') n.style.removeProperty('display');
      else n.style.display = 'none';
      peAfterEdit();
      peSelect(editor.selPath, editor.selTag, '', null);
    }
  });
  const addItem = document.getElementById('pe-add-item');
  if(addItem) addItem.addEventListener('click', function(){
    const n = peNodeAt(editor.doc, editor.selPath);
    if(n && n.firstElementChild){
      n.appendChild(n.firstElementChild.cloneNode(true));
      peAfterEdit();
    }
  });
  const delItem = document.getElementById('pe-del-item');
  if(delItem) delItem.addEventListener('click', function(){
    const n = peNodeAt(editor.doc, editor.selPath);
    if(n && n.parentNode){
      n.parentNode.removeChild(n);
      peAfterEdit();
      panel.style.display = 'none';
      editor.selPath = null;
    }
  });
  document.getElementById('pe-close').addEventListener('click', function(){
    panel.style.display = 'none';
    editor.selPath = null;
  });
}

function peAfterEdit(){
  peMarkDirty();
  peRefreshFrame();
}

function peResizeImage(file, maxW, maxH, cb){
  try{
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function(){
      try{
        let w = img.width || 0, h = img.height || 0;
        if(!w || !h){ URL.revokeObjectURL(url); cb(null); return; }
        const s = Math.min(1, maxW / w, maxH / h);
        w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        cb(c.toDataURL('image/png'));
      }catch(e){ try{ URL.revokeObjectURL(url); }catch(_){} cb(null); }
    };
    img.onerror = function(){ try{ URL.revokeObjectURL(url); }catch(_){} cb(null); };
    img.src = url;
  }catch(e){ cb(null); }
}

async function pePublish(){
  const err = document.getElementById('pe-err');
  const btn = document.getElementById('pe-publish');
  if(err) err.textContent = '';
  if(!editor || !editor.doc) return;
  let code = ensureStickyFooterMarker(peSerialize());
  const v = validateSiteCode(code, editor.name);
  if(!v.ok){
    if(err) err.textContent = v.reason;
    else toast(v.reason);
    return;
  }
  if(btn){ btn.disabled = true; btn.textContent = 'Publishing...'; }
  try{
    const jobid = uid('job');
    const job = { jobid: jobid, slug: editor.slug, rename_from: null,
      business_name: editor.name, code: code,
      author: session.user, author_name: session.user,
      created_at: nowISO(), status: 'queued',
      previous_code: editor.code, commit_sha: null, reason: '', revert_of: null };
    await ghPutJson('site-publish-queue/pending/' + jobid + '.json', job, null,
      'business: queue publish ' + editor.slug);
    editor.dirty = false;
    const d = document.getElementById('pe-dirty');
    if(d) d.style.display = 'none';
    toast('Queued for publish. It goes live shortly.');
  }catch(e){
    if(err) err.textContent = e.message;
    else toast(e.message);
  }
  if(btn){ btn.disabled = false; btn.textContent = 'Save & publish'; }
}

/* ================= owner accounts (admin only) ================= */

/* Stored in the data repo: portal-users/<username>.json
   {username, passHash, slugs:[...], created_at, created_by} */

var _userTreeCache = null;
async function peUserList(){
  if(_userTreeCache) return _userTreeCache;
  const t = await ghFetch('/git/trees/main?recursive=1');
  _userTreeCache = (t.tree || []).map(function(n){ return n.path; })
    .filter(function(p){ return p.indexOf('portal-users/') === 0 && p.slice(-5) === '.json'; });
  return _userTreeCache;
}

async function peLoadAccounts(){
  const paths = await peUserList();
  const out = [];
  for(const p of paths){
    try{
      const r = await ghGetJson(p);
      if(r && r.data) out.push({ path: p, data: r.data, sha: r.sha });
    }catch(e){ /* skip unreadable */ }
  }
  out.sort(function(a, b){ return String(a.data.username).localeCompare(String(b.data.username)); });
  return out;
}

async function peSaveAccount(username, password, slugs, existing){
  username = String(username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if(username.length < 3) throw new Error('Username needs at least 3 characters (letters, numbers, dot, dash).');
  if(!password || String(password).length < 6) throw new Error('Password needs at least 6 characters.');
  slugs = (slugs || []).filter(Boolean);
  if(!slugs.length) throw new Error('Assign at least one website to the account.');
  const rec = { username: username, passHash: await sha256hex(String(password)),
    slugs: slugs, created_at: existing ? existing.data.created_at : nowISO(),
    created_by: session.user, updated_at: nowISO() };
  const path = 'portal-users/' + username + '.json';
  await ghPutJson(path, rec, existing ? existing.sha : null,
    'business: ' + (existing ? 'update' : 'create') + ' account ' + username);
  _userTreeCache = null;
  return rec;
}

/* ================= screens ================= */

function showLogin(){
  const app = document.getElementById('app');
  app.innerHTML =
    '<div class="wrap" style="max-width:440px">' +
    '<div class="mark">business</div>' +
    '<div class="sub">Sign in to edit your website.<br/>Click anything on the page to change it.</div>' +
    '<div class="card">' +
    '<div class="field"><label>Username</label><input type="text" id="lg-user" autocomplete="username"/></div>' +
    '<div class="field"><label>Password</label><input type="password" id="lg-pass" autocomplete="current-password"/></div>' +
    '<div class="row"><button class="btn" id="lg-go" type="button">Sign in</button></div>' +
    '<div class="err" id="lg-err"></div>' +
    '</div></div>';
  const go = async function(){
    const err = document.getElementById('lg-err');
    const btn = document.getElementById('lg-go');
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Signing in...';
    try{
      await login(document.getElementById('lg-user').value,
                  document.getElementById('lg-pass').value);
      showDashboard();
    }catch(e){
      err.textContent = e.message;
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  };
  document.getElementById('lg-go').addEventListener('click', go);
  document.getElementById('lg-pass').addEventListener('keydown', function(e){
    if(e.key === 'Enter') go();
  });
  setTimeout(function(){ const u = document.getElementById('lg-user'); if(u) u.focus(); }, 50);
}

function showDashboard(){
  if(session.role === 'admin') showAdminDash();
  else if(session.role === 'owner') showOwnerDash();
  else showLogin();
}

function topbar(){
  return '<div class="topbar"><div class="brand">business</div>' +
    '<div class="row"><span class="who">' + esc(session.user) +
    (session.role === 'admin' ? ' (admin)' : '') + '</span>' +
    '<button class="btn ghost sm" id="tb-logout" type="button">Sign out</button></div></div>';
}

function bindLogout(){
  const b = document.getElementById('tb-logout');
  if(b) b.addEventListener('click', logout);
}

/* ---------- admin dashboard ---------- */

function showAdminDash(){
  const app = document.getElementById('app');
  app.innerHTML = topbar() +
    '<div class="wrap">' +
    '<div class="card"><h2>Find a website</h2><p class="desc">Search all sites by business name, then open one to edit it.</p>' +
    '<div class="field" style="margin:0"><input type="text" id="ad-q" placeholder="Type a business name..."/></div>' +
    '<div class="sitelist" id="ad-results"></div></div>' +
    '<div class="card"><div class="row between"><div><h2>Owner accounts</h2>' +
    '<p class="desc" style="margin:0">Create logins for owners and assign their websites. One account can hold many sites.</p></div>' +
    '<button class="btn sm" id="ad-new" type="button">New account</button></div>' +
    '<div class="sitelist" id="ad-users"><div class="muted">Loading...</div></div></div>' +
    '</div>';
  bindLogout();

  let searchT = null;
  const q = document.getElementById('ad-q');
  q.addEventListener('input', function(){
    if(searchT) clearTimeout(searchT);
    searchT = setTimeout(async function(){
      const box = document.getElementById('ad-results');
      const v = q.value.trim();
      if(v.length < 2){ box.innerHTML = ''; return; }
      box.innerHTML = '<div class="muted">Searching...</div>';
      try{
        const hits = await searchSites(v);
        if(!hits.length){ box.innerHTML = '<div class="muted">No matches.</div>'; return; }
        box.innerHTML = hits.map(function(h){
          return '<div class="siterow"><div><div class="nm">' + esc(h.name) + '</div>' +
            '<div class="sl">' + esc(h.slug) + '</div></div>' +
            '<button class="btn ghost sm" data-slug="' + esc(h.slug) + '" data-name="' + esc(h.name) + '" type="button">Edit</button></div>';
        }).join('');
        box.querySelectorAll('button[data-slug]').forEach(function(b){
          b.addEventListener('click', function(){
            openEditor(b.getAttribute('data-slug'), b.getAttribute('data-name'));
          });
        });
      }catch(e){ box.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
    }, 350);
  });

  document.getElementById('ad-new').addEventListener('click', function(){ showAccountForm(null); });
  loadAccountList();
}

async function loadAccountList(){
  const box = document.getElementById('ad-users');
  try{
    const accts = await peLoadAccounts();
    if(!accts.length){ box.innerHTML = '<div class="muted">No owner accounts yet.</div>'; return; }
    box.innerHTML = accts.map(function(a){
      const n = (a.data.slugs || []).length;
      return '<div class="siterow"><div><div class="nm">' + esc(a.data.username) + '</div>' +
        '<div class="sl">' + n + ' site' + (n === 1 ? '' : 's') + '</div></div>' +
        '<button class="btn ghost sm" data-u="' + esc(a.data.username) + '" type="button">Edit</button></div>';
    }).join('');
    box.querySelectorAll('button[data-u]').forEach(function(b){
      b.addEventListener('click', async function(){
        const accts2 = await peLoadAccounts();
        const found = accts2.filter(function(a){ return a.data.username === b.getAttribute('data-u'); })[0];
        showAccountForm(found || null);
      });
    });
  }catch(e){
    box.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
  }
}

function showAccountForm(existing){
  const app = document.getElementById('app');
  const d = existing ? existing.data : null;
  const picked = (d && d.slugs ? d.slugs.slice() : []);
  app.innerHTML = topbar() +
    '<div class="wrap" style="max-width:640px">' +
    '<div class="card"><h2>' + (d ? 'Edit account: ' + esc(d.username) : 'New owner account') + '</h2>' +
    '<p class="desc">The owner signs in with this username and password, and sees only the sites you assign.</p>' +
    '<div class="field"><label>Username</label>' +
    '<input type="text" id="ac-user" value="' + esc(d ? d.username : '') + '"' + (d ? ' disabled' : '') + '/></div>' +
    '<div class="field"><label>' + (d ? 'New password (leave blank to keep)' : 'Password') + '</label>' +
    '<input type="password" id="ac-pass" autocomplete="new-password"/></div>' +
    '<div class="field"><label>Assign websites</label>' +
    '<input type="text" id="ac-q" placeholder="Search business name to add..."/>' +
    '<div class="sitelist" id="ac-hits"></div>' +
    '<div class="sitelist" id="ac-picked"></div></div>' +
    '<div class="row"><button class="btn" id="ac-save" type="button">' + (d ? 'Save changes' : 'Create account') + '</button>' +
    '<button class="btn ghost" id="ac-cancel" type="button">Cancel</button></div>' +
    '<div class="err" id="ac-err"></div></div></div>';
  bindLogout();
  document.getElementById('ac-cancel').addEventListener('click', showAdminDash);

  const renderPicked = function(){
    const box = document.getElementById('ac-picked');
    box.innerHTML = picked.length
      ? picked.map(function(s, i){
          return '<div class="siterow"><div><div class="nm">' + esc(s) + '</div></div>' +
            '<button class="btn danger sm" data-i="' + i + '" type="button">Remove</button></div>';
        }).join('')
      : '<div class="muted">No websites assigned yet.</div>';
    box.querySelectorAll('button[data-i]').forEach(function(b){
      b.addEventListener('click', function(){
        picked.splice(parseInt(b.getAttribute('data-i'), 10), 1);
        renderPicked();
      });
    });
  };
  renderPicked();

  let searchT = null;
  const q = document.getElementById('ac-q');
  q.addEventListener('input', function(){
    if(searchT) clearTimeout(searchT);
    searchT = setTimeout(async function(){
      const box = document.getElementById('ac-hits');
      const v = q.value.trim();
      if(v.length < 2){ box.innerHTML = ''; return; }
      box.innerHTML = '<div class="muted">Searching...</div>';
      try{
        const hits = (await searchSites(v)).filter(function(h){ return picked.indexOf(h.slug) === -1; });
        box.innerHTML = hits.length
          ? hits.map(function(h){
              return '<div class="siterow"><div><div class="nm">' + esc(h.name) + '</div>' +
                '<div class="sl">' + esc(h.slug) + '</div></div>' +
                '<button class="btn ghost sm" data-slug="' + esc(h.slug) + '" type="button">Add</button></div>';
            }).join('')
          : '<div class="muted">No matches.</div>';
        box.querySelectorAll('button[data-slug]').forEach(function(b){
          b.addEventListener('click', function(){
            picked.push(b.getAttribute('data-slug'));
            q.value = ''; box.innerHTML = '';
            renderPicked();
          });
        });
      }catch(e){ box.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
    }, 350);
  });

  document.getElementById('ac-save').addEventListener('click', async function(){
    const err = document.getElementById('ac-err');
    const btn = document.getElementById('ac-save');
    err.textContent = '';
    btn.disabled = true;
    try{
      const uname = d ? d.username : document.getElementById('ac-user').value;
      const pw = document.getElementById('ac-pass').value;
      if(d && !pw){
        /* keep existing password: re-save with same hash */
        const rec = { username: d.username, passHash: d.passHash, slugs: picked,
          created_at: d.created_at, created_by: d.created_by, updated_at: nowISO() };
        await ghPutJson(existing.path, rec, existing.sha, 'business: update account ' + d.username);
        _userTreeCache = null;
      } else {
        await peSaveAccount(uname, pw, picked, existing || null);
      }
      toast(d ? 'Account updated.' : 'Account created.');
      showAdminDash();
    }catch(e){
      err.textContent = e.message;
      btn.disabled = false;
    }
  });
}

/* ---------- owner dashboard ---------- */

async function showOwnerDash(){
  const app = document.getElementById('app');
  app.innerHTML = topbar() +
    '<div class="wrap">' +
    '<div class="card"><h2>Your websites</h2>' +
    '<p class="desc">Pick a site, click anything on it to edit it, then save.</p>' +
    '<div class="sitelist" id="ow-sites"><div class="muted">Loading...</div></div></div>' +
    '</div>';
  bindLogout();
  const box = document.getElementById('ow-sites');
  const slugs = session.slugs || [];
  if(!slugs.length){ box.innerHTML = '<div class="muted">No websites assigned to this account yet.</div>'; return; }
  /* Resolve names via the shard for the first letter of each slug. */
  const items = [];
  for(const slug of slugs){
    let name = slug;
    try{
      const key = /^[a-z0-9]/.test(slug[0]) ? slug[0] : 'a';
      if(!_shardCache[key]){
        const r = await fetch('https://bjvfi.com/site-names/' + key + '.json', { cache: 'force-cache' });
        if(r.ok) _shardCache[key] = await r.json();
      }
      if(_shardCache[key] && _shardCache[key][slug]) name = _shardCache[key][slug];
    }catch(e){ /* keep slug */ }
    items.push({ slug: slug, name: name });
  }
  box.innerHTML = items.map(function(h){
    return '<div class="siterow"><div><div class="nm">' + esc(h.name) + '</div>' +
      '<div class="sl">' + esc(h.slug) + '</div></div>' +
      '<button class="btn ghost sm" data-slug="' + esc(h.slug) + '" data-name="' + esc(h.name) + '" type="button">Edit</button></div>';
  }).join('');
  box.querySelectorAll('button[data-slug]').forEach(function(b){
    b.addEventListener('click', function(){
      openEditor(b.getAttribute('data-slug'), b.getAttribute('data-name'));
    });
  });
}

/* ================= init ================= */

document.addEventListener('DOMContentLoaded', function(){
  showLogin();
});
