(() => {
  'use strict';
  const KEY = 'orbit-pages-v1';
  const COLORS = ['blue', 'mint', 'pink', 'amber'];
  const $ = selector => document.querySelector(selector);
  const uuid = () => crypto.randomUUID();
  let state, spaceMode = 'new', editSiteId = null, toastTimer;
  const fresh = () => { const id = uuid(); return { version: 1, activeId: id, spaces: [{ id, name: 'Personal', color: 'blue', sites: [] }] }; };
  function websiteUrl(raw) {
    const text = String(raw ?? '').trim();
    if (!text || /\s/.test(text) || /^[a-z][\w+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) return null;
    try {
      const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.') && !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }
  function sanitized(data) {
    if (!data || !Array.isArray(data.spaces)) return null;
    const ids = new Set();
    const spaces = data.spaces.slice(0, 50).filter(s => s && typeof s.id === 'string' && !ids.has(s.id) && ids.add(s.id)).map((s, index) => {
      const siteIds = new Set();
      return { id: s.id, name: String(s.name || 'Untitled').slice(0, 48), color: COLORS.includes(s.color) ? s.color : COLORS[index % 4], sites: (Array.isArray(s.sites) ? s.sites : []).slice(0, 200).filter(site => site && typeof site.id === 'string' && !siteIds.has(site.id) && siteIds.add(site.id) && websiteUrl(site.url)).map(site => ({ id: site.id, name: String(site.name || new URL(site.url).hostname).slice(0, 80), url: websiteUrl(site.url) })) };
    });
    if (!spaces.length) return null;
    return { version: 1, activeId: spaces.some(s => s.id === data.activeId) ? data.activeId : spaces[0].id, spaces };
  }
  try { state = sanitized(JSON.parse(localStorage.getItem(KEY))) || fresh(); } catch { state = fresh(); }
  const current = () => state.spaces.find(s => s.id === state.activeId);
  function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3500); }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); render(); return true; }
    catch { toast('Browser storage is unavailable or full. Export a backup before leaving.'); return false; }
  }
  function openSite(url) {
    const safe = websiteUrl(url); if (!safe) return toast('Enter a valid http or https website address.');
    const a = document.createElement('a'); a.href = safe; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click();
  }
  function render() {
    const selected = current();
    const nav = $('#spaces'); nav.replaceChildren();
    state.spaces.forEach(s => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'space-item' + (s.id === selected.id ? ' active' : ''); button.setAttribute('aria-current', s.id === selected.id ? 'page' : 'false');
      const dot = document.createElement('span'); dot.className = `space-dot ${s.color}`;
      const name = document.createElement('span'); name.textContent = s.name;
      const count = document.createElement('span'); count.className = 'space-count'; count.textContent = s.sites.length;
      button.append(dot, name, count); button.addEventListener('click', () => { state.activeId = s.id; save(); }); nav.append(button);
    });
    $('#currentName').textContent = selected.name; $('#currentDot').className = `space-dot ${selected.color}`;
    $('#collectionTitle').textContent = `${selected.name} websites`; $('#siteCount').textContent = `${selected.sites.length} saved`;
    $('#deleteSpace').disabled = state.spaces.length === 1;
    const grid = $('#sites'); grid.replaceChildren();
    if (!selected.sites.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state';
      const icon = document.createElement('span'); icon.className = 'empty-icon'; icon.textContent = '◇'; icon.setAttribute('aria-hidden', 'true');
      const title = document.createElement('strong'); title.textContent = 'Nothing saved here yet';
      const hint = document.createElement('p'); hint.textContent = 'Add a website you want to find quickly next time.';
      const button = document.createElement('button'); button.className = 'empty-add'; button.type = 'button'; button.textContent = 'Save your first website'; button.addEventListener('click', () => openSiteDialog());
      empty.append(icon, title, hint, button); grid.append(empty);
    }
    selected.sites.forEach(site => {
      const card = document.createElement('article'); card.className = 'site-card';
      const link = document.createElement('a'); link.href = site.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'site-link';
      const host = new URL(site.url).hostname;
      const glyph = document.createElement('span'); glyph.className = 'site-glyph'; glyph.textContent = host[0].toUpperCase(); glyph.setAttribute('aria-hidden', 'true');
      const content = document.createElement('span'); content.className = 'site-details';
      const name = document.createElement('strong'); name.textContent = site.name;
      const domain = document.createElement('small'); domain.textContent = host;
      const arrow = document.createElement('span'); arrow.className = 'site-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
      content.append(name, domain); link.append(glyph, content, arrow);
      const actions = document.createElement('div'); actions.className = 'site-actions';
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit'; edit.addEventListener('click', () => openSiteDialog(site));
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.addEventListener('click', () => {
        if (!confirm(`Remove “${site.name}” from this Space? This does not affect the website or your sign-in.`)) return;
        selected.sites = selected.sites.filter(item => item.id !== site.id); save(); toast('Website removed');
      });
      actions.append(edit, remove); card.append(link, actions); grid.append(card);
    });
    document.title = `${selected.name} · Orbit Spaces`;
  }
  function openSpaceDialog(mode) {
    spaceMode = mode; $('#spaceDialogTitle').textContent = mode === 'new' ? 'Create a space' : 'Rename space';
    $('#spaceDialogDescription').textContent = mode === 'new' ? 'Organize your saved websites in a new collection.' : 'Your saved websites will remain in this Space.';
    $('#confirmSpace').textContent = mode === 'new' ? 'Create space' : 'Save name'; $('#spaceName').value = mode === 'rename' ? current().name : '';
    $('#spaceDialog').showModal(); $('#spaceName').focus(); $('#spaceName').select();
  }
  function openSiteDialog(site = null) {
    editSiteId = site?.id || null; $('#siteDialogTitle').textContent = site ? 'Edit website' : 'Save a website';
    $('#confirmSite').textContent = site ? 'Save changes' : 'Save website'; $('#siteName').value = site?.name || ''; $('#siteUrl').value = site?.url || ''; $('#siteError').textContent = '';
    $('#siteDialog').showModal(); $('#siteName').focus();
  }
  $('#addSpace').addEventListener('click', () => openSpaceDialog('new'));
  $('#renameSpace').addEventListener('click', () => openSpaceDialog('rename'));
  $('#cancelSpace').addEventListener('click', () => $('#spaceDialog').close());
  $('#spaceForm').addEventListener('submit', event => {
    event.preventDefault(); const name = $('#spaceName').value.trim(); if (!name) return;
    if (spaceMode === 'new') { if (state.spaces.length >= 50) return toast('The 50-Space limit has been reached.'); const id = uuid(); state.spaces.push({ id, name, color: COLORS[state.spaces.length % COLORS.length], sites: [] }); state.activeId = id; }
    else current().name = name;
    save(); $('#spaceDialog').close(); toast(spaceMode === 'new' ? 'Space created' : 'Space renamed');
  });
  $('#deleteSpace').addEventListener('click', () => {
    if (state.spaces.length <= 1 || !confirm(`Delete “${current().name}” and its saved links? This does not delete browser sign-ins.`)) return;
    state.spaces = state.spaces.filter(s => s.id !== state.activeId); state.activeId = state.spaces[0].id; save(); toast('Space deleted');
  });
  $('#addSite').addEventListener('click', () => openSiteDialog()); $('#primarySave').addEventListener('click', () => openSiteDialog());
  $('#cancelSite').addEventListener('click', () => $('#siteDialog').close());
  $('#siteForm').addEventListener('submit', event => {
    event.preventDefault(); const url = websiteUrl($('#siteUrl').value); const name = $('#siteName').value.trim();
    if (!url) { $('#siteError').textContent = 'Enter a valid http or https website address.'; $('#siteUrl').focus(); return; }
    const existing = current().sites.find(site => site.id === editSiteId);
    if (existing) { existing.name = name; existing.url = url; }
    else { if (current().sites.length >= 200) return toast('The 200-link limit for this Space has been reached.'); current().sites.push({ id: uuid(), name, url }); }
    save(); $('#siteDialog').close(); toast(existing ? 'Website updated' : 'Website saved');
  });
  $('#quickForm').addEventListener('submit', event => {
    event.preventDefault(); const text = $('#quickAddress').value.trim(); if (!text) return;
    if (websiteUrl(text)) openSite(text); else if (/^[a-z][\w+.-]*:/i.test(text)) toast('Only http and https websites can be opened.'); else openSite(`https://www.google.com/search?q=${encodeURIComponent(text)}`);
  });
  $('#exportData').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'orbit-spaces-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  $('#importFile').addEventListener('change', async event => {
    const file = event.target.files[0]; event.target.value = ''; if (!file) return;
    if (file.size > 2_000_000) return toast('That file is too large. Choose a backup under 2 MB.');
    try {
      const incoming = sanitized(JSON.parse(await file.text())); if (!incoming) throw Error('Invalid backup');
      if (!confirm('Replace the Spaces and links saved in this browser with this backup?')) return;
      state = incoming; save(); toast('Backup imported');
    } catch { toast('That file is not a valid Orbit Spaces backup.'); }
  });
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#quickAddress').focus(); } });
  render();
})();
