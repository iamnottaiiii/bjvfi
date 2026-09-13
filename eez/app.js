(() => {
  const app = document.getElementById("app");
  const modal = document.getElementById("modal");
  const modalForm = document.getElementById("modal-form");
  const modalCancel = document.getElementById("modal-cancel");
  const toastEl = document.getElementById("toast");

  const HISTORY_MAX = 12;
  const SORT_KEY = "eez_stack_sort";
  const INSTALL_KEY = "eez_install_dismissed_at";
  const SHARE_KEY = "eez_share_nudge_at";
  const SAFETY_KEY = "eez_safety_tip_seen";
  const SHARE_URL = "https://bjvfi.com/eez";
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

  function loadStackSort() {
    try {
      const s = localStorage.getItem(SORT_KEY);
      if (s === "active" || s === "oldest" || s === "unseen") return s;
    } catch { /* ignore */ }
    return "active";
  }

  function saveStackSort(s) {
    state.stackSort = s;
    try { localStorage.setItem(SORT_KEY, s); } catch { /* ignore */ }
  }

  function formatPresence(ts) {
    if (!ts) return "a while ago";
    const diff = Date.now() - Number(ts);
    if (diff < 2 * 60 * 1000) return "active now";
    if (diff < 60 * 60 * 1000) {
      const m = Math.max(1, Math.floor(diff / 60000));
      return m + "m ago";
    }
    if (diff < 24 * 60 * 60 * 1000) {
      const h = Math.max(1, Math.floor(diff / 3600000));
      return h + "h ago";
    }
    if (diff < 30 * 24 * 60 * 60 * 1000) {
      const d = Math.max(1, Math.floor(diff / 86400000));
      return d === 1 ? "1d ago" : d + "d ago";
    }
    if (diff < 365 * 24 * 60 * 60 * 1000) {
      const mo = Math.max(1, Math.floor(diff / (30 * 86400000)));
      return mo === 1 ? "1mo ago" : mo + "mo ago";
    }
    const y = Math.max(1, Math.floor(diff / (365 * 86400000)));
    return y === 1 ? "a year ago" : y + "y ago";
  }

  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
      if (navigator.standalone) return true;
    } catch { /* ignore */ }
    return false;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  const state = {
    me: null,
    exclude: loadExclude(),
    history: [],
    pendingAnswer: null,
    card: null,
    enterFrom: "right",
    enterMode: "forward",
    toastTimer: null,
    guestKey: loadGuestKey(),
    stackSort: loadStackSort(),
    deferredInstall: null,
  };
  let renderGen = 0;

  const realtime = {
    thread: null, // { timer, closed } — polling replaces the old socket
    inbox: null,
  };

  // GitHub port: no WebSocket server exists. Polling replaces realtime.
  // openRealtime keeps its signature; the slot decides the interval.
  function openRealtime(slot, path, onEvent, { match } = {}) {
    closeRealtime(slot);
    const conn = { timer: null, closed: false };
    realtime[slot] = conn;
    const tick = async () => {
      if (conn.closed || realtime[slot] !== conn) return;
      if (match && !match()) return;
      try {
        await onEvent({ type: "poll" });
      } catch (err) {
        console.error("poll handler", err);
      }
    };
    conn.timer = setInterval(tick, slot === "thread" ? 2500 : 30000);
  }

  function closeRealtime(slot) {
    const conn = realtime[slot];
    if (!conn) return;
    conn.closed = true;
    if (conn.timer) clearInterval(conn.timer);
    realtime[slot] = null;
  }

  function appendLiveMessage(msg) {
    if (!msg || !msg.id) return false;
    const scroller = document.getElementById("thread-scroll");
    const thread = scroller && scroller.querySelector(".thread");
    if (!thread) return false;
    if (seenMessageIds().has(msg.id)) return false;
    const empty = thread.querySelector(".empty");
    if (empty) empty.remove();

    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    if (msg.kind === "system") {
      thread.insertAdjacentHTML(
        "beforeend",
        `<div class="bubble system" data-mid="${escapeHtml(msg.id)}">${escapeHtml(msg.body)}</div>`,
      );
    } else {
      const mine = state.me && msg.sender_id === state.me.id;
      // Drop matching optimistic bubble (no data-mid) with same body from me
      if (mine) {
        const opts = thread.querySelectorAll(".bubble.mine:not([data-mid])");
        for (const el of opts) {
          if (el.textContent === msg.body) {
            const next = el.nextElementSibling;
            el.remove();
            if (next && next.classList.contains("bubble-time") && !next.getAttribute("data-mid")) next.remove();
            break;
          }
        }
      }
      const receiptBit =
        mine && document.querySelector(".receipt")
          ? ` · <span class="receipt" data-receipt-for="${escapeHtml(msg.id)}">delivered</span>`
          : "";
      thread.insertAdjacentHTML(
        "beforeend",
        `<div class="bubble ${mine ? "mine" : "theirs"}" data-mid="${escapeHtml(msg.id)}" data-created="${msg.created_at}">${escapeHtml(msg.body)}</div><div class="bubble-time ${mine ? "mine" : "theirs"}">${escapeHtml(formatClock(msg.created_at))}${receiptBit}</div>`,
      );
    }
    if (nearBottom || (state.me && msg.sender_id === state.me.id)) scrollThreadEnd(scroller);
    return true;
  }

  function patchInboxRow(ev) {
    const list = document.querySelector(".inbox-list");
    if (!list || !ev || !ev.conversation_id) return false;
    const row = list.querySelector(`a.inbox-row[href="#/messages/${CSS.escape(ev.conversation_id)}"]`);
    if (!row) {
      // New or unknown thread — light refetch
      return false;
    }
    const preview = row.querySelector(".inbox-preview");
    const time = row.querySelector(".inbox-time");
    const who =
      ev.last_kind === "system"
        ? ""
        : ev.last_sender_id && state.me && ev.last_sender_id === state.me.id
          ? "you · "
          : "";
    if (preview) preview.textContent = who + (ev.last_body || "");
    if (time) time.textContent = formatRel(ev.last_message_at || ev.last_activity_at || Date.now());
    const fromMe = state.me && ev.last_sender_id === state.me.id && ev.last_kind !== "system";
    if (!fromMe) {
      row.classList.add("unread");
      let flags = row.querySelector(".inbox-flags");
      if (flags && !flags.querySelector(".unread-dot")) {
        flags.insertAdjacentHTML("beforeend", `<span class="unread-dot" aria-hidden="true"></span>`);
      }
      if (flags && !flags.querySelector(".flag.hot")) {
        const old = flags.querySelector(".flag");
        if (old) old.remove();
        flags.insertAdjacentHTML("afterbegin", `<span class="flag hot">new</span>`);
      }
      document.querySelectorAll('[data-nav="messages"]').forEach((el) => el.classList.add("has-unread"));
    }
    // Move row to top
    list.prepend(row);
    return true;
  }

  let lastInboxSig = "";

  function ensureInboxRealtime() {
    if (!state.me) {
      closeRealtime("inbox");
      return;
    }
    if (realtime.inbox && !realtime.inbox.closed) return;
    // GitHub port: poll the conversation list every 30s instead of a socket.
    openRealtime(
      "inbox",
      "inbox-poll",
      async () => {
        const onInbox = document.body.classList.contains("page-inbox");
        try {
          const data = await api("/api/conversations");
          const list = data.conversations || [];
          updateInboxBadgeFrom(list);
          if (onInbox) {
            const g = renderGen;
            const sig = JSON.stringify(list.map((c) => [c.id, c.last_activity_at, c.unread ? 1 : 0, c.last_body]));
            if (!stale(g) && sig !== lastInboxSig) {
              lastInboxSig = sig;
              renderMessages(g);
            }
          }
        } catch {
          /* keep last known state */
        }
      },
      { match: () => Boolean(state.me) },
    );
  }

  function ensureThreadRealtime(conversationId, g) {
    // GitHub port: poll the thread every 5s instead of a socket.
    openRealtime("thread", "thread-poll:" + conversationId, async () => {
      if (stale(g)) return;
      if (route().parts[0] !== "messages" || route().parts[1] !== conversationId) return;
      try {
        const data = await ghThreadPoll(conversationId);
        if (stale(g)) return;
        if (route().parts[0] !== "messages" || route().parts[1] !== conversationId) return;
        (data.messages || []).forEach((m) => appendLiveMessage(m));
        if (data.other_last_read_at) applyReadReceipts(data.other_last_read_at);
      } catch {
        /* keep last known state */
      }
    });
  }

  function stale(g) {
    return g != null && g !== renderGen;
  }

  function applyBaseTheme() {
    // The app is dark by default, always. Whole-UI themes recolor from here.
    const root = document.documentElement;
    root.setAttribute("data-theme", "dark");
    root.style.colorScheme = "dark";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", "#000000");
    const apple = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (apple) apple.setAttribute("content", "black-translucent");
  }

  function applyUserAppearance(user) {
    if (!user) {
      applyUitheme(storedUitheme(), storedUithemeCustom());
      return;
    }
    applyUitheme(user.theme_preset || "", parsePackedCustom(user.theme_custom || ""));
  }

  /* whole-UI themes: 3 presets + custom (background / highlight / text). Replaces the old dark/light toggle. */
  const UITHEMES = ["midnight", "paper", "ocean", "custom"];
  const UITHEME_KEY = "eez_uitheme";
  const UITHEME_BG_KEY = "eez_theme_bg";
  const UITHEME_ACCENT_KEY = "eez_theme_accent";
  const UITHEME_TEXT_KEY = "eez_theme_text";
  const CUSTOM_DEFAULTS = { bg: "#101318", accent: "#5b9cff", text: "#f4f5f7" };
  const CUSTOM_THEME_VARS = ["--bg", "--bg2", "--bg3", "--surface", "--ink", "--muted", "--muted2",
    "--accent", "--accent-soft", "--accent-ink", "--btn-bg", "--btn-fg", "--toast-bg", "--toast-fg",
    "--modal", "--unread", "--red", "--bubble-theirs"];

  function storedUitheme() {
    try {
      const t = localStorage.getItem(UITHEME_KEY);
      return UITHEMES.includes(t) ? t : "";
    } catch {
      return "";
    }
  }
  function validHex(c) {
    return /^#[0-9a-fA-F]{6}$/.test(c || "") ? c : "";
  }
  function storedUithemeCustom() {
    const out = { ...CUSTOM_DEFAULTS };
    try {
      const bg = validHex(localStorage.getItem(UITHEME_BG_KEY));
      const ac = validHex(localStorage.getItem(UITHEME_ACCENT_KEY));
      const tx = validHex(localStorage.getItem(UITHEME_TEXT_KEY));
      if (bg) out.bg = bg;
      if (ac) out.accent = ac;
      if (tx) out.text = tx;
      // migrate the old single-color custom theme: it becomes the highlight
      const legacy = validHex(localStorage.getItem("eez_uitheme_custom"));
      if (legacy && !ac) out.accent = legacy;
    } catch {
      /* ignore */
    }
    return out;
  }
  function parsePackedCustom(packed) {
    const out = { ...CUSTOM_DEFAULTS };
    const parts = String(packed || "").split(",");
    const bg = validHex(parts[0]), ac = validHex(parts[1]), tx = validHex(parts[2]);
    if (bg) out.bg = bg;
    if (ac) out.accent = ac;
    if (tx) out.text = tx;
    return out;
  }
  function packCustom(c) {
    return [c.bg, c.accent, c.text].join(",");
  }
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return "#" + c(r) + c(g) + c(b);
  }
  function shade(hex, pct) {
    // pct -100..100: negative darkens toward black, positive lightens toward white
    const [r, g, b] = hexToRgb(hex);
    const t = pct < 0 ? 0 : 255;
    const p = Math.abs(pct) / 100;
    return rgbToHex(r + (t - r) * p, g + (t - g) * p, b + (t - b) * p);
  }
  function mixHex(a, b, t) {
    const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
    return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
  }
  function hexAlpha(hex, a) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  function lum(hex) {
    const [r, g, b] = hexToRgb(hex).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function applyCustomThemeVars(custom) {
    const root = document.documentElement;
    const c = { ...CUSTOM_DEFAULTS, ...(custom || {}) };
    const bg = validHex(c.bg) || CUSTOM_DEFAULTS.bg;
    const accent = validHex(c.accent) || CUSTOM_DEFAULTS.accent;
    const ink = validHex(c.text) || CUSTOM_DEFAULTS.text;
    const dark = lum(bg) < 0.4;
    const onAccent = lum(accent) > 0.5 ? "#0b0e12" : "#f4f5f7";
    const vars = {
      "--bg": bg,
      "--bg2": shade(bg, dark ? 5 : -4),
      "--bg3": shade(bg, dark ? 10 : -8),
      "--surface": hexAlpha(shade(bg, dark ? 8 : -6), 0.85),
      "--ink": ink,
      "--muted": mixHex(ink, bg, 0.35),
      "--muted2": mixHex(ink, bg, 0.55),
      "--accent": accent,
      "--accent-soft": shade(accent, -12),
      "--accent-ink": onAccent,
      "--btn-bg": accent,
      "--btn-fg": onAccent,
      "--toast-bg": accent,
      "--toast-fg": onAccent,
      "--modal": hexAlpha(bg, 0.96),
      "--unread": accent,
      "--red": "#e08080",
      "--bubble-theirs": hexAlpha(accent, 0.08),
    };
    Object.keys(vars).forEach((k) => root.style.setProperty(k, vars[k]));
    root.style.colorScheme = dark ? "dark" : "light";
  }
  function clearCustomThemeVars() {
    const root = document.documentElement;
    CUSTOM_THEME_VARS.forEach((v) => root.style.removeProperty(v));
    root.style.colorScheme = "";
  }
  function currentUitheme() {
    return document.documentElement.getAttribute("data-uitheme") || "";
  }
  function applyUitheme(name, custom) {
    const t = UITHEMES.includes(name) ? name : "";
    const root = document.documentElement;
    clearCustomThemeVars();
    if (t === "custom") {
      const c = custom && (custom.bg || custom.accent || custom.text)
        ? { ...storedUithemeCustom(), ...custom }
        : storedUithemeCustom();
      applyCustomThemeVars(c);
    }
    if (t) {
      root.setAttribute("data-uitheme", t);
      // The theme owns the whole canvas: drop the flat base background so the
      // theme's --bg (and light color-scheme for light themes) actually applies.
      root.style.background = "";
      if (document.body) document.body.style.background = "";
      if (t !== "custom") root.style.colorScheme = "";
    } else {
      root.removeAttribute("data-uitheme");
      root.style.background = "";
      if (document.body) document.body.style.background = "";
      root.style.colorScheme = "dark";
    }
    try {
      const m = document.querySelector('meta[name="theme-color"]');
      if (m) {
        const bg = t ? getComputedStyle(root).getPropertyValue("--bg").trim() : "";
        m.setAttribute("content", bg || "#000000");
      }
      const apple = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (apple) apple.setAttribute("content", t === "paper" ? "default" : "black-translucent");
    } catch {
      /* ignore */
    }
    try {
      if (t) localStorage.setItem(UITHEME_KEY, t);
      else localStorage.removeItem(UITHEME_KEY);
      if (custom && (custom.bg || custom.accent || custom.text)) {
        const c = { ...storedUithemeCustom(), ...custom };
        localStorage.setItem(UITHEME_BG_KEY, c.bg);
        localStorage.setItem(UITHEME_ACCENT_KEY, c.accent);
        localStorage.setItem(UITHEME_TEXT_KEY, c.text);
      }
    } catch {
      /* ignore */
    }
  }
  async function saveUitheme(name, custom) {
    const t = UITHEMES.includes(name) ? name : "";
    applyUitheme(t, custom);
    if (!state.me) return;
    try {
      const patch = { theme_preset: t };
      if (t === "custom" && custom) patch.theme_custom = packCustom({ ...storedUithemeCustom(), ...custom });
      const data = await api("/api/me", { method: "PATCH", body: JSON.stringify(patch) });
      state.me = data.user;
    } catch {
      /* keep the local choice */
    }
  }
  function uithemePicksHtml(current) {
    const cur = current || "";
    return ["midnight", "paper", "ocean"]
      .map(
        (n) =>
          `<button type="button" class="theme-pick ${n === cur ? "on" : ""}" data-uitheme="${n}" title="${n}" aria-label="theme ${n}"></button>`,
      )
      .join("");
  }
  function markPicks(selector, activeEl) {
    document.querySelectorAll(selector).forEach((b) => b.classList.toggle("on", b === activeEl));
  }
  function clearUitheme(persist) {
    markPicks("#theme-picks .theme-pick", null);
    const cust = document.getElementById("theme-custom-on");
    if (cust) cust.hidden = true;
    if (persist) return saveUitheme("");
    applyUitheme("");
    return Promise.resolve();
  }
  function themeCustomHtml(values) {
    const v = { ...storedUithemeCustom(), ...(values || {}) };
    return `<div class="theme-custom-row">
      <label class="color-pick"><input type="color" id="theme-bg-color" value="${v.bg}" aria-label="background color" /><span>background</span></label>
      <label class="color-pick"><input type="color" id="theme-accent-color" value="${v.accent}" aria-label="highlight color" /><span>highlight</span></label>
      <label class="color-pick"><input type="color" id="theme-text-color" value="${v.text}" aria-label="text color" /><span>text</span></label>
      <span class="settings-note" id="theme-custom-on"${currentUitheme() === "custom" ? "" : " hidden"}>custom on</span>
      <button type="button" class="btn ghost sm" id="theme-default">default</button>
    </div>`;
  }
  function readCustomInputs() {
    const g = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : "";
    };
    return {
      bg: validHex(g("theme-bg-color")) || CUSTOM_DEFAULTS.bg,
      accent: validHex(g("theme-accent-color")) || CUSTOM_DEFAULTS.accent,
      text: validHex(g("theme-text-color")) || CUSTOM_DEFAULTS.text,
    };
  }
  function bindUithemeControls(persist) {
    document.querySelectorAll("#theme-picks .theme-pick").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const t = btn.getAttribute("data-uitheme");
        markPicks("#theme-picks .theme-pick", btn);
        if (persist) await saveUitheme(t);
        else applyUitheme(t);
        showToast("theme set");
      });
    });
    ["theme-bg-color", "theme-accent-color", "theme-text-color"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => {
        markPicks("#theme-picks .theme-pick", null);
        const cust = document.getElementById("theme-custom-on");
        if (cust) cust.hidden = false;
        applyUitheme("custom", readCustomInputs());
      });
      el.addEventListener("change", async () => {
        if (persist) await saveUitheme("custom", readCustomInputs());
      });
    });
    const td = document.getElementById("theme-default");
    if (td) {
      td.addEventListener("click", async () => {
        markPicks("#theme-picks .theme-pick", null);
        const cust = document.getElementById("theme-custom-on");
        if (cust) cust.hidden = true;
        if (persist) await saveUitheme("");
        else applyUitheme("");
        showToast("default look");
      });
    }
  }

  function initTheme() {
    // Base look is always dark now. Whole-UI themes (3 presets + custom) recolor from here.
    applyBaseTheme();
    applyUitheme(storedUitheme(), storedUithemeCustom());
  }

  function scrubLegacyTopChrome() {
    try {
      // Strip legacy top *nav* only — keep .brand-word (brand mark at top).
      document.querySelectorAll("header.top, .top, .top-nav, nav.top-nav").forEach((el) => {
        el.remove();
      });
    } catch {
      /* ignore */
    }
  }

  function clip(s, n) {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    if (t.length <= n) return t;
    return t.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
  }

  function substanceLabel(s, n) {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    // Never show handle/name-like tokens (short single word / handle shape).
    if (/^[a-zA-Z0-9_.-]{1,24}$/.test(t)) return "";
    return clip(t, n);
  }


  function formatRel(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    const diff = now - d;
    if (diff < 45 * 1000) return "now";
    if (diff < 60 * 60 * 1000) return Math.max(1, Math.floor(diff / 60000)) + "m";
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (d >= startToday) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (d >= new Date(startToday.getTime() - 86400000)) return "yesterday";
    if (diff < 6.5 * 86400000) return d.toLocaleDateString([], { weekday: "short" });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  function formatClock(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function formatDayLabel(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startD = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const days = Math.round((startToday - startD) / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: "long" });
    return d.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
  }

  function sameDay(a, b) {
    const da = new Date(a);
    const db = new Date(b);
    return (
      da.getFullYear() === db.getFullYear() &&
      da.getMonth() === db.getMonth() &&
      da.getDate() === db.getDate()
    );
  }

  function fadeWrap(html) {
    return `<div class="page-fade">${html}</div>`;
  }

  function renderError(msg) {
    app.innerHTML = fadeWrap(`<div class="state-block">
      <p class="empty-lead">something went wrong</p>
      <p class="empty-sub">${escapeHtml(msg || "try again in a moment")}</p>
      <button type="button" class="btn" id="retry-btn">try again</button>
    </div>`);
    const btn = document.getElementById("retry-btn");
    if (btn) btn.addEventListener("click", render);
  }

  function updateInboxBadgeFrom(convos) {
    const n = (convos || []).filter((c) => c.unread).length;
    document.querySelectorAll('[data-nav="messages"]').forEach((el) => {
      el.classList.toggle("has-unread", n > 0);
    });
  }

  async function refreshInboxBadge() {
    if (!state.me) {
      updateInboxBadgeFrom([]);
      return;
    }
    try {
      const data = await api("/api/conversations");
      updateInboxBadgeFrom(data.conversations || []);
    } catch {
      /* ignore */
    }
  }

  function loadExclude() {
    try {
      const raw = localStorage.getItem("eez_exclude");
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  function saveExclude() {
    localStorage.setItem("eez_exclude", JSON.stringify(state.exclude.slice(-200)));
  }

  function rememberExclude(id) {
    if (!id || state.exclude.includes(id)) return;
    state.exclude.push(id);
    saveExclude();
  }

  function forgetExclude(id) {
    state.exclude = state.exclude.filter((x) => x !== id);
    saveExclude();
  }

  function loadGuestKey() {
    try {
      let k = localStorage.getItem("eez_guest");
      if (!k) {
        k = "g_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem("eez_guest", k);
      }
      return k;
    } catch {
      return "g_anon";
    }
  }

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.hidden = false;
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl.classList.add("show"));
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      setTimeout(() => {
        toastEl.hidden = true;
      }, 240);
    }, 1600);
  }

/* ================= eez GitHub data layer =================
   Replaces the original server-side backend. No server code runs in this build.
   Storage: JSON files in the private iamnottaiiii/eez-data repo,
   read/written through the GitHub API with the repo-scoped token
   from config.js (EEZ_GH_TOKEN). Same patterns as SiteDesk.
   Timestamps are stored as SECONDS since epoch in the repo and
   converted to ms at the API boundary (the UI works in ms). */

var GH_API = 'https://api.github.com/repos/iamnottaiiii/eez-data';
var FEED_CAP = 200;
var LS_SESSION = 'eez_session_v1';
var LS_FEED_READ = 'eez_feed_read_v1';

function nowS(){ return Math.floor(Date.now()/1000); }
function s2ms(s){ return (s || 0) * 1000; }

function newId(){
  try{
    if(typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  }catch(e){}
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* ---- base64 (copied from SiteDesk) ---- */
function b64encode(bytes){
  var bin = '';
  var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for(var i=0;i<b.length;i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}
function b64decodeToBytes(b64){
  var bin = atob(String(b64).replace(/\s/g,''));
  var out = new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---- PBKDF2 password hashing (copied from SiteDesk) ----
   Format: pbkdf2$<iterations>$<salt-b64>$<hash-b64>, SHA-256, 256-bit key. */
function getSubtle(){
  if(typeof crypto !== 'undefined' && crypto.subtle) return crypto.subtle;
  return null;
}
async function pbkdf2Hash(password, iterations){
  var subtle = getSubtle();
  if(!subtle) throw new Error('crypto unavailable');
  var iters = iterations || 600000;
  var salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  var key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  var bits = await subtle.deriveBits({name:'PBKDF2', salt: salt, iterations: iters, hash:'SHA-256'}, key, 256);
  return 'pbkdf2$' + iters + '$' + b64encode(salt) + '$' + b64encode(new Uint8Array(bits));
}
async function pbkdf2Verify(password, stored){
  var m = /^pbkdf2\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored||''));
  if(!m) return false;
  var subtle = getSubtle();
  if(!subtle) return false;
  var iters = parseInt(m[1],10);
  if(!(iters >= 1000 && iters <= 2000000)) return false;
  var salt = b64decodeToBytes(m[2]);
  var want = b64decodeToBytes(m[3]);
  var key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  var bits = await subtle.deriveBits({name:'PBKDF2', salt: salt, iterations: iters, hash:'SHA-256'}, key, 256);
  var got = new Uint8Array(bits);
  if(got.length !== want.length) return false;
  var diff = 0;
  for(var i=0;i<got.length;i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

/* ---- GitHub API plumbing ---- */
function ghTokenOk(){
  return typeof EEZ_GH_TOKEN === 'string' && EEZ_GH_TOKEN && EEZ_GH_TOKEN.indexOf('__EEZ_TOKEN') !== 0;
}
function ghHeaders(extra){
  var h = {
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + EEZ_GH_TOKEN,
    'Content-Type': 'application/json'
  };
  if(extra) for(var k in extra) h[k] = extra[k];
  return h;
}
async function ghFetchRaw(path, opts){
  opts = opts || {};
  if(!ghTokenOk()){ var e0 = new Error('app not configured yet, try again later'); e0.status = 503; throw e0; }
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = null;
  if(ctrl) timer = setTimeout(function(){ try{ ctrl.abort(); }catch(e){} }, opts.timeout || 30000);
  var res;
  try{
    res = await fetch(GH_API + path, {
      method: opts.method || 'GET',
      cache: 'no-store',
      headers: ghHeaders(opts.headers),
      body: opts.body,
      signal: ctrl ? ctrl.signal : undefined
    });
  }catch(e){
    if(timer) clearTimeout(timer);
    if(e && e.name === 'AbortError'){ var e1 = new Error('network timed out, check your connection and retry'); e1.status = 0; throw e1; }
    throw e;
  }
  if(timer) clearTimeout(timer);
  return res;
}

/* In-memory file cache: path -> {data|bytes, sha, etag, isJson} */
var fileCache = {};

async function ghGetJson(path, useEtag){
  var cached = fileCache[path];
  var headers = null;
  if(useEtag && cached && cached.etag){ headers = {'If-None-Match': cached.etag}; }
  var res = await ghFetchRaw('/contents/' + path + '?ref=main', {headers: headers});
  if(res.status === 304 && cached) return cached;
  if(res.status === 404) return null;
  if(!res.ok){ var e = new Error('read failed (' + res.status + ')'); e.status = res.status; throw e; }
  var file = await res.json();
  var etag = res.headers.get('ETag');
  var raw = b64decodeToBytes(file.content || '');
  var rec = { data: JSON.parse(new TextDecoder().decode(raw)), sha: file.sha, etag: etag, isJson: true };
  fileCache[path] = rec;
  return rec;
}

/* Fresh read bypassing etag (used before writes to get current sha). */
async function ghGetJsonFresh(path){
  var rec = await ghGetJson(path, false);
  return rec;
}

async function ghPutJson(path, obj, sha, message){
  var body = {
    message: message || ('eez: update ' + path),
    content: b64encode(new TextEncoder().encode(JSON.stringify(obj, null, 2)))
  };
  if(sha) body.sha = sha;
  var res = await ghFetchRaw('/contents/' + path, {method: 'PUT', body: JSON.stringify(body)});
  if(!res.ok){ var e = new Error('save failed (' + res.status + ')'); e.status = res.status; throw e; }
  var out = await res.json();
  fileCache[path] = { data: obj, sha: (out.content && out.content.sha) || null, etag: null, isJson: true };
  return out;
}

/* Read-modify-write with 409/422 retry. fn receives the array (or [] when missing). */
async function mutateJson(path, fn, message){
  var lastErr = null;
  for(var i=0;i<4;i++){
    var rec = await ghGetJsonFresh(path);
    var data = rec ? rec.data : [];
    if(!Array.isArray(data)) data = [];
    var out = fn(data);
    if(out === undefined) out = data;
    try{
      await ghPutJson(path, out, rec ? rec.sha : null, message);
      return out;
    }catch(e){
      lastErr = e;
      if(e && (e.status === 409 || e.status === 422)) continue;
      throw e;
    }
  }
  var fin = new Error('save conflict, try again');
  fin.status = 409;
  throw lastErr || fin;
}

async function ghPutBinary(path, bytes, message){
  var body = { message: message || ('eez: upload ' + path), content: b64encode(bytes) };
  var res = await ghFetchRaw('/contents/' + path, {method: 'PUT', body: JSON.stringify(body)});
  if(!res.ok){ var e = new Error('upload failed (' + res.status + ')'); e.status = res.status; throw e; }
  fileCache[path] = { data: null, sha: null, etag: null, isJson: false };
  return true;
}

async function ghGetBinary(path){
  var cached = fileCache[path];
  if(cached && cached.blobUrl) return cached.blobUrl;
  var res = await ghFetchRaw('/contents/' + path + '?ref=main', {});
  if(res.status === 404) return null;
  if(!res.ok){ var e = new Error('image load failed'); e.status = res.status; throw e; }
  var file = await res.json();
  var bytes = b64decodeToBytes(file.content || '');
  var mime = 'image/jpeg';
  if(/\.png$/i.test(path)) mime = 'image/png';
  else if(/\.webp$/i.test(path)) mime = 'image/webp';
  else if(/\.gif$/i.test(path)) mime = 'image/gif';
  var url = URL.createObjectURL(new Blob([bytes], {type: mime}));
  fileCache[path] = { data: null, sha: file.sha, etag: null, isJson: false, blobUrl: url };
  return url;
}

/* ---- session (localStorage; replaces cookie sessions) ---- */
function loadSession(){
  try{
    var s = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
    if(s && s.uid && s.exp && s.exp > Date.now()) return s;
  }catch(e){}
  return null;
}
function saveSession(uid){
  try{ localStorage.setItem(LS_SESSION, JSON.stringify({uid: uid, exp: Date.now() + 30*864e5})); }catch(e){}
}
function clearSession(){
  try{ localStorage.removeItem(LS_SESSION); }catch(e){}
}
function guestKey(){
  try{ return localStorage.getItem('eez_guest') || 'g_anon'; }catch(e){ return 'g_anon'; }
}

/* ---- users ---- */
async function getUsers(){ var r = await ghGetJson('users.json', true); return r ? r.data : []; }
async function findUserById(id){ var us = await getUsers(); return us.find(function(u){ return u.id === id && !u.deleted; }) || null; }
async function findUserByEmail(email){
  var us = await getUsers();
  var em = String(email||'').trim().toLowerCase();
  return us.find(function(u){ return String(u.email||'').toLowerCase() === em && !u.deleted; }) || null;
}

var imgUrlCache = {};
async function resolveImageUrl(key){
  if(!key) return null;
  if(imgUrlCache[key]) return imgUrlCache[key];
  try{
    var url = await ghGetBinary(key);
    if(url) imgUrlCache[key] = url;
    return url;
  }catch(e){ return null; }
}

async function publicUser(u){
  if(!u) return null;
  return {
    id: u.id,
    email: u.email,
    handle: u.handle,
    why_here: u.why_here || '',
    into_now: u.into_now || '',
    ask_them: u.ask_them || '',
    quiet_mode: !!u.quiet_mode,
    stack_sort: u.stack_sort || 'active',
    theme_accent: u.theme_accent || 'default',
    theme_preset: u.theme_preset || '',
    theme_custom: u.theme_custom || '',
    theme_bg_url: u.theme_bg_key ? await resolveImageUrl(u.theme_bg_key) : null,
    digest_opt_in: !!u.digest_opt_in,
    last_seen_at: s2ms(u.last_seen_at || u.created_at || 0),
    created_at: s2ms(u.created_at || 0)
  };
}
async function requireMe(){
  var s = loadSession();
  if(!s){ var e = new Error('log in first'); e.status = 401; throw e; }
  var u = await findUserById(s.uid);
  if(!u){ clearSession(); var e2 = new Error('log in first'); e2.status = 401; throw e2; }
  return u;
}
async function touchSeen(u){
  if(!u) return;
  try{
    await mutateJson('users.json', function(us){
      var t = us.find(function(x){ return x.id === u.id; });
      if(t) t.last_seen_at = nowS();
    }, 'eez: presence');
  }catch(e){}
}
function makeHandle(email, users){
  var base = String(email||'').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,16) || 'user';
  var h = base, n = 0;
  var taken = {};
  users.forEach(function(u){ if(u.handle) taken[u.handle] = 1; });
  while(taken[h]){ n++; h = base + n; }
  return h;
}

/* ---- feed (in-app alerts; replaces push) ---- */
async function feedPush(userId, kind, summary, refId){
  if(!userId) return;
  try{
    await mutateJson('feed.json', function(items){
      items.unshift({id: newId(), user_id: userId, kind: kind, summary: summary, ref_id: refId || null, created_at: nowS()});
      return items.slice(0, FEED_CAP);
    }, 'eez: feed event');
  }catch(e){}
}
async function getFeed(userId){
  var r = await ghGetJson('feed.json', true);
  var items = r ? r.data : [];
  return items.filter(function(f){ return f.user_id === userId; }).slice(0, 50).map(function(f){
    return {id: f.id, kind: f.kind, summary: f.summary, ref_id: f.ref_id, created_at: s2ms(f.created_at)};
  });
}

/* ---- conversations ---- */
async function getConvos(){ var r = await ghGetJson('conversations.json', true); return r ? r.data : []; }
async function getMessages(){ var r = await ghGetJson('messages.json', true); return r ? r.data : []; }
async function getPrefs(){ var r = await ghGetJson('conversation_prefs.json', true); return r ? r.data : []; }
function myPrefs(prefs, uid, cid){
  return prefs.find(function(p){ return p.user_id === uid && p.conversation_id === cid; }) || null;
}
function convoParty(c, uid){ return c.initiator_id === uid || c.recipient_id === uid; }
function otherId(c, uid){ return c.initiator_id === uid ? c.recipient_id : c.initiator_id; }

async function buildConvoView(c, me, users, messages, prefs){
  var oid = otherId(c, me.id);
  var other = users.find(function(u){ return u.id === oid; }) || null;
  var mine = myPrefs(prefs, me.id, c.id) || {};
  var msgs = messages.filter(function(m){ return m.conversation_id === c.id; });
  var last = msgs.length ? msgs[msgs.length - 1] : null;
  var lastRead = mine.last_read_at || 0;
  var unread = !!last && last.sender_id !== me.id && last.created_at > lastRead;
  var replied = msgs.some(function(m){ return m.sender_id === oid && m.kind !== 'system'; });
  var waiting = c.initiator_id === me.id && !replied;
  var expiresAt = (c.created_at + 5*86400) * 1000;
  var fading = waiting && (expiresAt - Date.now() < 86400000);
  return {
    id: c.id,
    initiator_id: c.initiator_id,
    custom_title: mine.title || '',
    other_ask: other ? (other.ask_them || '') : '',
    last_body: last ? last.body : '',
    last_kind: last ? last.kind : '',
    last_sender_id: last ? last.sender_id : null,
    last_message_at: last ? s2ms(last.created_at) : s2ms(c.last_activity_at),
    last_activity_at: s2ms(c.last_activity_at),
    unread: unread,
    fading: fading,
    bumped: false,
    waiting: waiting,
    expires_at: expiresAt,
    muted: !!mine.muted,
    read_receipts: mine.read_receipts !== 0,
    other_last_read_at: (function(){ var op = myPrefs(prefs, oid, c.id); return op && op.last_read_at ? s2ms(op.last_read_at) : null; })()
  };
}

async function ghThreadData(id, me, touch){
  var convos = await getConvos();
  var c = convos.find(function(x){ return x.id === id; });
  if(!c || !convoParty(c, me.id)){ var e = new Error('not found'); e.status = 404; throw e; }
  var users = await getUsers();
  var messages = await getMessages();
  var prefs = await getPrefs();
  if(touch){
    await mutateJson('conversation_prefs.json', function(ps){
      var p = ps.find(function(x){ return x.user_id === me.id && x.conversation_id === id; });
      if(!p){ p = {user_id: me.id, conversation_id: id, title: '', muted: 0, read_receipts: 1, last_read_at: 0}; ps.push(p); }
      p.last_read_at = nowS();
    }, 'eez: mark read');
    prefs = await getPrefs();
  }
  var view = await buildConvoView(c, me, users, messages, prefs);
  var msgs = messages.filter(function(m){ return m.conversation_id === id; })
    .sort(function(a,b){ return a.created_at - b.created_at; })
    .map(function(m){ return {id: m.id, kind: m.kind || 'user', body: m.body, sender_id: m.sender_id, created_at: s2ms(m.created_at)}; });
  return {conversation: view, messages: msgs};
}

/* ---- uploads: commit image files to images/ in eez-data ---- */
function downscaleImage(file){
  return new Promise(function(resolve, reject){
    var img = new Image();
    var objUrl = URL.createObjectURL(file);
    img.onload = function(){
      URL.revokeObjectURL(objUrl);
      var max = 1200;
      var w = img.width, h = img.height;
      if(Math.max(w,h) > max){ var k = max / Math.max(w,h); w = Math.round(w*k); h = Math.round(h*k); }
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      var type = file.type === 'image/png' ? 'image/png' : (file.type === 'image/gif' ? 'image/gif' : (file.type === 'image/webp' ? 'image/webp' : 'image/jpeg'));
      cv.toBlob(function(blob){
        if(!blob){ reject(new Error('image processing failed')); return; }
        resolve({blob: blob, ext: type === 'image/png' ? 'png' : (type === 'image/gif' ? 'gif' : (type === 'image/webp' ? 'webp' : 'jpg'))});
      }, type, 0.85);
    };
    img.onerror = function(){ URL.revokeObjectURL(objUrl); reject(new Error('could not read image')); };
    img.src = objUrl;
  });
}
async function ghUpload(formData){
  var me = await requireMe();
  var file = formData.get('file');
  if(!(file instanceof File) || !file.size) throw Object.assign(new Error('no file'), {status: 400});
  if(file.size > 8*1024*1024) throw Object.assign(new Error('image too large (8MB max)'), {status: 400});
  var processed;
  try{ processed = await downscaleImage(file); }
  catch(e){ processed = {blob: file, ext: (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g,'') || 'jpg'}; }
  var buf = new Uint8Array(await processed.blob.arrayBuffer());
  var key = 'images/' + newId() + '.' + processed.ext;
  await ghPutBinary(key, buf, 'eez: upload image');
  await touchSeen(me);
  return {key: key};
}

/* ---- the api() router: implements every /api/* endpoint locally ---- */
async function ghApi(path, opts){
  opts = opts || {};
  var method = (opts.method || 'GET').toUpperCase();
  var url;
  try{ url = new URL(path, 'https://eez.local'); }catch(e){ url = {pathname: path, searchParams: new URLSearchParams()}; }
  var p = url.pathname;
  var q = url.searchParams;
  var body = opts.body;
  if(typeof FormData !== 'undefined' && body instanceof FormData){
    if(p === '/api/upload' && method === 'POST') return await ghUpload(body);
    throw Object.assign(new Error('unsupported'), {status: 400});
  }
  var json = null;
  if(body != null && body !== ''){ try{ json = JSON.parse(body); }catch(e){ json = {}; } }
  var bad = function(msg, status){ return Object.assign(new Error(msg), {status: status || 400}); };

  /* ----- auth ----- */
  if(p === '/api/me' && method === 'GET'){
    var s = loadSession();
    if(!s) return {user: null};
    var u = await findUserById(s.uid);
    return {user: await publicUser(u)};
  }
  if(p === '/api/me' && method === 'PATCH'){
    var me = await requireMe();
    var patch = json || {};
    var updated;
    await mutateJson('users.json', function(us){
      var t = us.find(function(x){ return x.id === me.id; });
      if(!t) throw bad('account gone', 404);
      if(patch.stack_sort && ['active','oldest','unseen'].indexOf(patch.stack_sort) >= 0) t.stack_sort = patch.stack_sort;
      if(typeof patch.theme_accent === 'string') t.theme_accent = patch.theme_accent.slice(0, 24);
      if(typeof patch.theme_preset === 'string') t.theme_preset = patch.theme_preset.slice(0, 24);
      if(typeof patch.theme_custom === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.theme_custom)) t.theme_custom = patch.theme_custom;
      if(typeof patch.theme_bg_key === 'string') t.theme_bg_key = patch.theme_bg_key.slice(0, 200);
      if(patch.clear_theme_bg) t.theme_bg_key = '';
      if(typeof patch.quiet_mode === 'boolean') t.quiet_mode = patch.quiet_mode ? 1 : 0;
      if(typeof patch.digest_opt_in === 'boolean') t.digest_opt_in = patch.digest_opt_in ? 1 : 0;
      if(typeof patch.why_here === 'string') t.why_here = patch.why_here.slice(0, 500);
      if(typeof patch.into_now === 'string') t.into_now = patch.into_now.slice(0, 500);
      if(typeof patch.ask_them === 'string') t.ask_them = patch.ask_them.slice(0, 500);
      t.last_seen_at = nowS();
      updated = t;
    }, 'eez: profile update');
    return {user: await publicUser(updated)};
  }
  if(p === '/api/me' && method === 'DELETE'){
    var meDel = await requireMe();
    var uid = meDel.id;
    var qr0 = await ghGetJson('questions.json', true);
    var myQids = {};
    (qr0 ? qr0.data : []).forEach(function(x){ if(x.author_id === uid) myQids[x.id] = 1; });
    var cr0 = await ghGetJson('conversations.json', true);
    var myCids = {};
    (cr0 ? cr0.data : []).forEach(function(x){ if(x.initiator_id === uid || x.recipient_id === uid) myCids[x.id] = 1; });
    await mutateJson('users.json', function(us){ return us.filter(function(x){ return x.id !== uid; }); }, 'eez: delete account');
    await mutateJson('questions.json', function(qs){ return qs.filter(function(x){ return x.author_id !== uid; }); }, 'eez: delete account');
    await mutateJson('answers.json', function(a){ return a.filter(function(x){ return x.author_id !== uid && !myQids[x.question_id]; }); }, 'eez: delete account');
    await mutateJson('poll_options.json', function(o){ return o.filter(function(x){ return !myQids[x.question_id]; }); }, 'eez: delete account');
    await mutateJson('poll_votes.json', function(v){ return v.filter(function(x){ return x.voter_key !== uid && !myQids[x.question_id]; }); }, 'eez: delete account');
    await mutateJson('conversations.json', function(cs){ return cs.filter(function(x){ return !myCids[x.id]; }); }, 'eez: delete account');
    await mutateJson('messages.json', function(ms){ return ms.filter(function(x){ return !myCids[x.conversation_id]; }); }, 'eez: delete account');
    await mutateJson('blocks.json', function(b){ return b.filter(function(x){ return x.blocker_id !== uid && x.blocked_id !== uid; }); }, 'eez: delete account');
    await mutateJson('skips.json', function(b){ return b.filter(function(x){ return x.user_id !== uid && x.skipped_id !== uid; }); }, 'eez: delete account');
    await mutateJson('bookmarks.json', function(b){ return b.filter(function(x){ return x.user_id !== uid && x.bookmarked_id !== uid; }); }, 'eez: delete account');
    await mutateJson('reports.json', function(b){ return b.filter(function(x){ return x.reporter_id !== uid && x.reported_id !== uid; }); }, 'eez: delete account');
    await mutateJson('conversation_prefs.json', function(b){ return b.filter(function(x){ return x.user_id !== uid; }); }, 'eez: delete account');
    await mutateJson('feed.json', function(b){ return b.filter(function(x){ return x.user_id !== uid; }); }, 'eez: delete account');
    clearSession();
    return {};
  }
  if(p === '/api/auth/register' && method === 'POST'){
    var reg = json || {};
    var email = String(reg.email || '').trim().toLowerCase();
    var password = String(reg.password || '');
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('enter a valid email');
    if(password.length < 8) throw bad('password must be at least 8 characters');
    var whyH = String(reg.why_here || '').trim(), intoN = String(reg.into_now || '').trim(), askT = String(reg.ask_them || '').trim();
    if(!whyH || !intoN || !askT) throw bad('answer all three prompts');
    var exists = await findUserByEmail(email);
    if(exists) throw bad('that email is taken', 409);
    var hash = await pbkdf2Hash(password);
    var created;
    await mutateJson('users.json', function(us){
      if(us.some(function(x){ return String(x.email||'').toLowerCase() === email && !x.deleted; })) throw bad('that email is taken', 409);
      created = {
        id: newId(), email: email, handle: makeHandle(email, us), pass: hash,
        why_here: whyH.slice(0,500), into_now: intoN.slice(0,500), ask_them: askT.slice(0,500),
        quiet_mode: 0, stack_sort: 'active', theme_accent: 'default', theme_preset: '', theme_custom: '', theme_bg_key: '',
        digest_opt_in: 0, last_seen_at: nowS(), created_at: nowS()
      };
      us.push(created);
    }, 'eez: register');
    saveSession(created.id);
    return {user: await publicUser(created)};
  }
  if(p === '/api/auth/login' && method === 'POST'){
    var lin = json || {};
    var lu = await findUserByEmail(lin.email);
    if(!lu) throw bad('wrong email or password', 401);
    var ok = await pbkdf2Verify(String(lin.password || ''), lu.pass);
    if(!ok) throw bad('wrong email or password', 401);
    await touchSeen(lu);
    saveSession(lu.id);
    return {user: await publicUser(lu)};
  }
  if(p === '/api/auth/logout' && method === 'POST'){
    clearSession();
    return {};
  }

  /* ----- stack ----- */
  if(p === '/api/stack' && method === 'GET'){
    var sess = loadSession();
    var meS = sess ? await findUserById(sess.uid) : null;
    var users = await getUsers();
    var blocks = (await ghGetJson('blocks.json', true) || {data: []}).data;
    var skips = meS ? ((await ghGetJson('skips.json', true) || {data: []}).data.filter(function(x){ return x.user_id === meS.id; })) : [];
    var reps = meS ? ((await ghGetJson('reports.json', true) || {data: []}).data.filter(function(x){ return x.reporter_id === meS.id; })) : [];
    var excl = {};
    (q.get('exclude') || '').split(',').forEach(function(id){ if(id) excl[id] = 1; });
    skips.forEach(function(x){ excl[x.skipped_id] = 1; });
    blocks.forEach(function(x){
      if(meS && x.blocker_id === meS.id) excl[x.blocked_id] = 1;
      if(meS && x.blocked_id === meS.id) excl[x.blocker_id] = 1;
    });
    reps.forEach(function(x){ excl[x.reported_id] = 1; });
    var sort = q.get('sort') || 'active';
    var pool = users.filter(function(x){
      if(x.deleted || x.quiet_mode) return false;
      if(meS && x.id === meS.id) return false;
      if(excl[x.id]) return false;
      if(!x.why_here || !x.ask_them) return false;
      return true;
    });
    if(sort === 'oldest' || sort === 'unseen') pool.sort(function(a,b){ return a.created_at - b.created_at; });
    else pool.sort(function(a,b){ return b.created_at - a.created_at; });
    var prof = pool[0] || null;
    return {profile: prof ? {
      id: prof.id,
      why_here: prof.why_here, into_now: prof.into_now, ask_them: prof.ask_them,
      last_seen_at: s2ms(prof.last_seen_at || prof.created_at || 0)
    } : null};
  }
  if(p === '/api/stack/skip' && method === 'POST'){
    var meSk = await requireMe().catch(function(){ return null; });
    if(meSk && json && json.id){
      var sid = String(json.id);
      await mutateJson('skips.json', function(ss){
        if(!ss.some(function(x){ return x.user_id === meSk.id && x.skipped_id === sid; }))
          ss.push({user_id: meSk.id, skipped_id: sid, created_at: nowS()});
      }, 'eez: skip');
    }
    return {};
  }
  if(p === '/api/stack/block' && method === 'POST'){
    var meB = await requireMe();
    var bid = String((json||{}).id || '');
    if(!bid || bid === meB.id) throw bad('invalid user');
    await mutateJson('blocks.json', function(bs){
      if(!bs.some(function(x){ return x.blocker_id === meB.id && x.blocked_id === bid; }))
        bs.push({id: newId(), blocker_id: meB.id, blocked_id: bid, reason: 'block', created_at: nowS()});
    }, 'eez: block');
    return {};
  }
  if(p === '/api/stack/report' && method === 'POST'){
    var meR = await requireMe();
    var rid = String((json||{}).id || '');
    if(!rid || rid === meR.id) throw bad('invalid user');
    await mutateJson('reports.json', function(rs){
      if(!rs.some(function(x){ return x.reporter_id === meR.id && x.reported_id === rid; }))
        rs.push({id: newId(), reporter_id: meR.id, reported_id: rid, reason: 'report', created_at: nowS()});
    }, 'eez: report');
    var allReps = (await ghGetJson('reports.json', true) || {data: []}).data;
    var distinct = {};
    allReps.forEach(function(x){ if(x.reported_id === rid) distinct[x.reporter_id] = 1; });
    if(Object.keys(distinct).length >= 20){
      await mutateJson('users.json', function(us){
        var t = us.find(function(x){ return x.id === rid; });
        if(t){ t.deleted = 1; t.why_here = ''; t.into_now = ''; t.ask_them = ''; t.quiet_mode = 1; }
      }, 'eez: auto-remove reported account');
    }
    return {};
  }

  /* ----- Q&A ----- */
  if(p === '/api/questions' && method === 'GET'){
    var sessQ = loadSession();
    var meQ = sessQ ? await findUserById(sessQ.uid) : null;
    var vkey = meQ ? meQ.id : guestKey();
    var qs = (await ghGetJson('questions.json', true) || {data: []}).data;
    var ans = (await ghGetJson('answers.json', true) || {data: []}).data;
    var popts = (await ghGetJson('poll_options.json', true) || {data: []}).data;
    var pvotes = (await ghGetJson('poll_votes.json', true) || {data: []}).data;
    var out = [];
    var sorted = qs.slice().sort(function(a,b){ return b.created_at - a.created_at; });
    for(var i=0;i<sorted.length;i++){
      var qq = sorted[i];
      var opts = popts.filter(function(o){ return o.question_id === qq.id; })
        .sort(function(a,b){ return a.sort_order - b.sort_order; })
        .map(function(o){
          var vc = pvotes.filter(function(v){ return v.option_id === o.id; }).length;
          return {id: o.id, label: o.label, votes: vc};
        });
      var mv = pvotes.find(function(v){ return v.question_id === qq.id && v.voter_key === vkey; });
      var qans = ans.filter(function(a){ return a.question_id === qq.id; })
        .sort(function(a,b){ return a.created_at - b.created_at; })
        .map(function(a){ return {id: a.id, body: a.body}; });
      out.push({
        id: qq.id, kind: qq.kind || 'text', body: qq.body,
        image_url: qq.image_key ? await resolveImageUrl(qq.image_key) : null,
        options: opts, my_vote: mv ? mv.option_id : null, answers: qans
      });
    }
    return {questions: out};
  }
  if(p === '/api/questions' && method === 'POST'){
    var meP = await requireMe();
    var qp = json || {};
    var qbody = String(qp.body || '').trim();
    if(!qbody) throw bad('write something first');
    if(qbody.length > 500) throw bad('keep it under 500 characters');
    var kind = qp.kind === 'poll' ? 'poll' : (qp.kind === 'image' ? 'image' : 'text');
    var qid = newId();
    if(kind === 'poll'){
      var labels = (qp.options || []).map(function(x){ return String(x||'').trim(); }).filter(Boolean).slice(0, 10);
      if(labels.length < 2) throw bad('add at least 2 options');
      await mutateJson('poll_options.json', function(os){
        labels.forEach(function(l, ix){ os.push({id: newId(), question_id: qid, label: l.slice(0,80), sort_order: ix}); });
      }, 'eez: ask poll');
    }
    if(kind === 'image' && !qp.image_key) throw bad('image required');
    await mutateJson('questions.json', function(qs){
      qs.push({id: qid, author_id: meP.id, body: qbody, kind: kind, image_key: qp.image_key || '', created_at: nowS()});
    }, 'eez: ask question');
    await touchSeen(meP);
    return {};
  }
  var voteM = /^\/api\/questions\/([^/]+)\/vote$/.exec(p);
  if(voteM && method === 'POST'){
    var sessV = loadSession();
    var meV = sessV ? await findUserById(sessV.uid) : null;
    var vk = meV ? meV.id : guestKey();
    var qidV = voteM[1], oidV = String((json||{}).option_id || '');
    var qsV = (await ghGetJson('questions.json', true) || {data: []}).data;
    var target = qsV.find(function(x){ return x.id === qidV; });
    if(!target) throw bad('question gone', 404);
    await mutateJson('poll_votes.json', function(vs){
      if(vs.some(function(v){ return v.question_id === qidV && v.voter_key === vk; })) throw bad('already voted', 409);
      vs.push({id: newId(), question_id: qidV, option_id: oidV, voter_key: vk, created_at: nowS()});
    }, 'eez: vote');
    return {};
  }
  var ansM = /^\/api\/questions\/([^/]+)\/answers$/.exec(p);
  if(ansM && method === 'POST'){
    var sessA = loadSession();
    var meA = sessA ? await findUserById(sessA.uid) : null;
    var abody = String((json||{}).body || '').trim();
    if(!abody) throw bad('write something first');
    if(abody.length > 1000) throw bad('keep it under 1000 characters');
    var qidA = ansM[1];
    var qsA = (await ghGetJson('questions.json', true) || {data: []}).data;
    var qa = qsA.find(function(x){ return x.id === qidA; });
    if(!qa) throw bad('question gone', 404);
    await mutateJson('answers.json', function(an){
      an.push({id: newId(), question_id: qidA, author_id: meA ? meA.id : null, guest_name: '', body: abody, created_at: nowS()});
    }, 'eez: answer');
    if(qa.author_id) feedPush(qa.author_id, 'answer', 'someone answered your question', qidA);
    if(meA) await touchSeen(meA);
    return {};
  }

  /* ----- conversations ----- */
  if(p === '/api/conversations' && method === 'GET'){
    var meC = await requireMe();
    var convos = await getConvos();
    var usersC = await getUsers();
    var msgsC = await getMessages();
    var prefsC = await getPrefs();
    var mine = convos.filter(function(c){
      if(!convoParty(c, meC.id)) return false;
      if(c.initiator_id === meC.id && c.hidden_from_initiator) return false;
      if(convoExpired(c, meC)) return false;
      return true;
    });
    var views = [];
    for(var ci=0; ci<mine.length; ci++) views.push(await buildConvoView(mine[ci], meC, usersC, msgsC, prefsC));
    views.sort(function(a,b){ return b.last_activity_at - a.last_activity_at; });
    return {conversations: views};
  }
  var threadM = /^\/api\/conversations\/([^/]+)$/.exec(p);
  if(threadM && method === 'GET'){
    var meT = await requireMe();
    return await ghThreadData(threadM[1], meT, true);
  }
  if(p === '/api/conversations/from-card' && method === 'POST'){
    var meF = await requireMe();
    var recip = String((json||{}).recipient_id || '');
    var fbody = String((json||{}).body || '').trim();
    if(!recip || recip === meF.id) throw bad('invalid recipient');
    if(!fbody) throw bad('write something first');
    if(fbody.length > 2000) throw bad('keep it under 2000 characters');
    var other = await findUserById(recip);
    if(!other) throw bad('person not found', 404);
    var ts = nowS(), cid, firstMsg;
    var convosF = await getConvos();
    var existing = convosF.find(function(c){
      return (c.initiator_id === meF.id && c.recipient_id === recip) || (c.initiator_id === recip && c.recipient_id === meF.id);
    });
    if(existing){
      cid = existing.id;
    }else{
      cid = newId();
      await mutateJson('conversations.json', function(cs){
        cs.push({id: cid, initiator_id: meF.id, recipient_id: recip, created_at: ts, last_activity_at: ts, hidden_from_initiator: 0, bump_sent_at: 0});
      }, 'eez: new conversation');
    }
    firstMsg = {id: newId(), conversation_id: cid, sender_id: meF.id, body: fbody, kind: 'user', created_at: ts};
    await mutateJson('messages.json', function(ms){ ms.push(firstMsg); }, 'eez: first message');
    await mutateJson('conversations.json', function(cs){
      var c = cs.find(function(x){ return x.id === cid; });
      if(c) c.last_activity_at = ts;
    }, 'eez: touch convo');
    await mutateJson('conversation_prefs.json', function(ps){
      var mp = ps.find(function(x){ return x.user_id === meF.id && x.conversation_id === cid; });
      if(!mp) ps.push({user_id: meF.id, conversation_id: cid, title: '', muted: 0, read_receipts: 1, last_read_at: ts});
      else mp.last_read_at = ts;
    }, 'eez: mark read');
    feedPush(recip, 'message', 'someone answered your card', cid);
    await touchSeen(meF);
    return {conversation_id: cid};
  }
  var msgM = /^\/api\/conversations\/([^/]+)\/messages$/.exec(p);
  if(msgM && method === 'POST'){
    var meM = await requireMe();
    var mbody = String((json||{}).body || '').trim();
    if(!mbody) throw bad('write something first');
    if(mbody.length > 2000) throw bad('keep it under 2000 characters');
    var now = Date.now();
    if(now - (lastSendAt || 0) < 1000) throw bad('slow down a little');
    lastSendAt = now;
    var mid = msgM[1];
    var convosM = await getConvos();
    var cm = convosM.find(function(x){ return x.id === mid; });
    if(!cm || !convoParty(cm, meM.id)) throw bad('not found', 404);
    var tsM = nowS();
    var msg = {id: newId(), conversation_id: mid, sender_id: meM.id, body: mbody, kind: 'user', created_at: tsM};
    await mutateJson('messages.json', function(ms){ ms.push(msg); }, 'eez: send message');
    await mutateJson('conversations.json', function(cs){
      var c = cs.find(function(x){ return x.id === mid; });
      if(c) c.last_activity_at = tsM;
    }, 'eez: touch convo');
    await mutateJson('conversation_prefs.json', function(ps){
      var mp = ps.find(function(x){ return x.user_id === meM.id && x.conversation_id === mid; });
      if(!mp) ps.push({user_id: meM.id, conversation_id: mid, title: '', muted: 0, read_receipts: 1, last_read_at: tsM});
      else mp.last_read_at = tsM;
    }, 'eez: mark read');
    var oidM = otherId(cm, meM.id);
    feedPush(oidM, 'message', 'new message', mid);
    await touchSeen(meM);
    return {message: {id: msg.id, kind: msg.kind, body: msg.body, sender_id: msg.sender_id, created_at: s2ms(msg.created_at)}};
  }
  var prefsM = /^\/api\/conversations\/([^/]+)\/prefs$/.exec(p);
  if(prefsM && method === 'PATCH'){
    var mePr = await requireMe();
    var pj = json || {};
    await mutateJson('conversation_prefs.json', function(ps){
      var mp = ps.find(function(x){ return x.user_id === mePr.id && x.conversation_id === prefsM[1]; });
      if(!mp){ mp = {user_id: mePr.id, conversation_id: prefsM[1], title: '', muted: 0, read_receipts: 1, last_read_at: 0}; ps.push(mp); }
      if(typeof pj.muted === 'boolean') mp.muted = pj.muted ? 1 : 0;
      if(typeof pj.read_receipts === 'boolean') mp.read_receipts = pj.read_receipts ? 1 : 0;
    }, 'eez: convo prefs');
    return {};
  }
  var titleM = /^\/api\/conversations\/([^/]+)\/title$/.exec(p);
  if(titleM && method === 'PATCH'){
    var meTi = await requireMe();
    var ttl = String((json||{}).title || '').trim().slice(0, 80);
    await mutateJson('conversation_prefs.json', function(ps){
      var mp = ps.find(function(x){ return x.user_id === meTi.id && x.conversation_id === titleM[1]; });
      if(!mp){ mp = {user_id: meTi.id, conversation_id: titleM[1], title: '', muted: 0, read_receipts: 1, last_read_at: 0}; ps.push(mp); }
      mp.title = ttl;
    }, 'eez: rename chat');
    return {custom_title: ttl};
  }

  /* ----- bookmarks / blocks ----- */
  if(p === '/api/bookmarks' && method === 'GET'){
    var meBk = await requireMe();
    var bms = (await ghGetJson('bookmarks.json', true) || {data: []}).data.filter(function(x){ return x.user_id === meBk.id; });
    var usBk = await getUsers();
    return {bookmarks: bms.map(function(b){
      var u = usBk.find(function(x){ return x.id === b.bookmarked_id && !x.deleted; });
      if(!u) return null;
      return {id: u.id, ask_them: u.ask_them || '', why_here: u.why_here || ''};
    }).filter(Boolean)};
  }
  if(p === '/api/bookmarks' && method === 'POST'){
    var meBp = await requireMe();
    var bpid = String((json||{}).id || '');
    if(!bpid || bpid === meBp.id) throw bad('invalid user');
    await mutateJson('bookmarks.json', function(bs){
      if(!bs.some(function(x){ return x.user_id === meBp.id && x.bookmarked_id === bpid; }))
        bs.push({user_id: meBp.id, bookmarked_id: bpid, created_at: nowS()});
    }, 'eez: bookmark');
    return {};
  }
  var bmdM = /^\/api\/bookmarks\/([^/]+)$/.exec(p);
  if(bmdM && method === 'DELETE'){
    var meBd = await requireMe();
    var bdid = decodeURIComponent(bmdM[1]);
    await mutateJson('bookmarks.json', function(bs){
      return bs.filter(function(x){ return !(x.user_id === meBd.id && x.bookmarked_id === bdid); });
    }, 'eez: unbookmark');
    return {};
  }
  if(p === '/api/blocks' && method === 'GET'){
    var meBl = await requireMe();
    var bls = (await ghGetJson('blocks.json', true) || {data: []}).data.filter(function(x){ return x.blocker_id === meBl.id; });
    var usBl = await getUsers();
    return {blocks: bls.map(function(b){
      var u = usBl.find(function(x){ return x.id === b.blocked_id; });
      return {id: b.blocked_id, ask_them: u ? (u.ask_them || '') : '', why_here: u ? (u.why_here || '') : ''};
    })};
  }
  var blkM = /^\/api\/blocks\/([^/]+)$/.exec(p);
  if(blkM && method === 'DELETE'){
    var meBu = await requireMe();
    var buid = decodeURIComponent(blkM[1]);
    await mutateJson('blocks.json', function(bs){
      return bs.filter(function(x){ return !(x.blocker_id === meBu.id && x.blocked_id === buid); });
    }, 'eez: unblock');
    return {};
  }

  if(p === '/api/me/export' && method === 'GET'){
    var meE = await requireMe();
    var uidE = meE.id;
    var qE = (await ghGetJson('questions.json', true) || {data: []}).data.filter(function(x){ return x.author_id === uidE; });
    var qidsE = {};
    qE.forEach(function(x){ qidsE[x.id] = 1; });
    var aE = (await ghGetJson('answers.json', true) || {data: []}).data.filter(function(x){ return x.author_id === uidE || qidsE[x.question_id]; });
    var cE = await getConvos();
    var myCE = cE.filter(function(x){ return convoParty(x, uidE); });
    var cidsE = {};
    myCE.forEach(function(x){ cidsE[x.id] = 1; });
    var mE = (await getMessages()).filter(function(x){ return cidsE[x.conversation_id]; })
      .map(function(x){ return {id: x.id, conversation_id: x.conversation_id, sender_id: x.sender_id, kind: x.kind, body: x.body, created_at: s2ms(x.created_at)}; });
    var bmE = (await ghGetJson('bookmarks.json', true) || {data: []}).data.filter(function(x){ return x.user_id === uidE; });
    return {export: {
      profile: await publicUser(meE),
      questions: qE.map(function(x){ return {id: x.id, body: x.body, kind: x.kind, created_at: s2ms(x.created_at)}; }),
      answers: aE.map(function(x){ return {id: x.id, question_id: x.question_id, body: x.body, created_at: s2ms(x.created_at)}; }),
      conversations: myCE.map(function(x){ return {id: x.id, initiator_id: x.initiator_id, recipient_id: x.recipient_id, created_at: s2ms(x.created_at)}; }),
      messages: mE,
      bookmarks: bmE
    }};
  }

  /* ----- misc ----- */
  if(p === '/api/presence' && method === 'POST') return {};
  if(p === '/api/feed' && method === 'GET'){
    var meFd = await requireMe();
    return {events: await getFeed(meFd.id)};
  }

  throw bad('unknown endpoint', 404);
}
/* Poll the open thread without the read-mark write storm: only touch
   last_read_at when a new incoming message actually arrived. */
async function ghThreadPoll(id){
  var sess = loadSession();
  var me = sess ? await findUserById(sess.uid) : null;
  if(!me){ var e = new Error('log in first'); e.status = 401; throw e; }
  var convos = await getConvos();
  var c = convos.find(function(x){ return x.id === id; });
  if(!c || !convoParty(c, me.id)){ var e2 = new Error('not found'); e2.status = 404; throw e2; }
  var prefs = await getPrefs();
  var mp = myPrefs(prefs, me.id, id);
  var lastRead = mp ? (mp.last_read_at || 0) : 0;
  var messages = await getMessages();
  var msgs = messages.filter(function(m){ return m.conversation_id === id; })
    .sort(function(a,b){ return a.created_at - b.created_at; });
  var newest = 0;
  msgs.forEach(function(m){ if(m.sender_id !== me.id && m.created_at > newest) newest = m.created_at; });
  if(newest > lastRead){
    await mutateJson('conversation_prefs.json', function(ps){
      var p = ps.find(function(x){ return x.user_id === me.id && x.conversation_id === id; });
      if(!p){ p = {user_id: me.id, conversation_id: id, title: '', muted: 0, read_receipts: 1, last_read_at: 0}; ps.push(p); }
      p.last_read_at = newest;
    }, 'eez: mark read');
    prefs = await getPrefs();
  }
  var op = myPrefs(prefs, otherId(c, me.id), id);
  var readAt = (op && op.last_read_at && (mp ? mp.read_receipts !== 0 : true)) ? s2ms(op.last_read_at) : null;
  return {
    messages: msgs.map(function(m){ return {id: m.id, kind: m.kind || 'user', body: m.body, sender_id: m.sender_id, created_at: s2ms(m.created_at)}; }),
    other_last_read_at: readAt
  };
}

/* Five-day fade for unanswered initiator threads (was a worker cron). */
function convoExpired(c, me){
  if(c.initiator_id !== me.id) return false;
  return (c.created_at + 5*86400) < nowS();
}

var lastSendAt = 0;

  // GitHub port: api() routes to the local GitHub data layer (datalayer.js).
  async function api(path, opts = {}) {
    return ghApi(path, opts);
  }

  async function refreshMe() {
    const data = await api("/api/me");
    state.me = data.user;
    return state.me;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function route() {
    const hash = location.hash.replace(/^#/, "") || "/";
    const parts = hash.split("/").filter(Boolean);
    return { path: "/" + parts.join("/"), parts };
  }

  function setNav(name) {
    document.querySelectorAll("[data-nav]").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-nav") === name);
    });
    document.body.classList.toggle("page-home", name === "home");
    document.body.classList.toggle("page-thread", name === "thread");
    document.body.classList.toggle("page-inbox", name === "inbox");
  }

  function showModal() {
    modal.hidden = false;
    const first = modal.querySelector("input");
    if (first) first.focus();
  }

  function hideModal() {
    modal.hidden = true;
    modalForm.reset();
  }

  modalCancel.addEventListener("click", () => {
    state.pendingAnswer = null;
    hideModal();
  });

  modalForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(modalForm);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: String(fd.get("email") || ""),
          password: String(fd.get("password") || ""),
        }),
      });
      await refreshMe();
      hideModal();
      if (state.pendingAnswer) {
        const pending = state.pendingAnswer;
        state.pendingAnswer = null;
        await sendAnswer(pending.id, pending.body);
      } else {
        render();
      }
    } catch (err) {
      alert(err.message);
    }
  });

  async function requireLogin() {
    if (state.me) return true;
    showModal();
    return false;
  }

  async function sendAnswer(recipientId, body) {
    const data = await api("/api/conversations/from-card", {
      method: "POST",
      body: JSON.stringify({ recipient_id: recipientId, body }),
    });
    rememberExclude(recipientId);
    location.hash = "#/messages/" + data.conversation_id;
  }

  async function renderHome(g) {
    setNav("home");
    const sort = (state.me && state.me.stack_sort) || state.stackSort || "active";
    app.innerHTML = `<div class="home-wrap">
      <div class="sort-bar" role="group" aria-label="sort stack">
        <button type="button" class="sort-chip ${sort === "active" ? "on" : ""}" data-sort="active">active now</button>
        <button type="button" class="sort-chip ${sort === "oldest" ? "on" : ""}" data-sort="oldest">oldest</button>
        <button type="button" class="sort-chip ${sort === "unseen" ? "on" : ""}" data-sort="unseen">haven’t seen</button>
      </div>
      <div class="stage" aria-live="polite"><div class="slide" id="slide">
      <div class="slide-body">
        <div class="skel skel-line w40"></div>
        <div class="skel skel-line"></div>
        <div class="skel skel-line w80"></div>
        <div class="skel skel-line w60"></div>
      </div>
    </div></div></div>`;
    app.querySelectorAll("[data-sort]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const next = btn.getAttribute("data-sort");
        saveStackSort(next);
        if (state.me) {
          try {
            const data = await api("/api/me", { method: "PATCH", body: JSON.stringify({ stack_sort: next }) });
            state.me = data.user;
          } catch { /* local still applied */ }
        }
        state.exclude = [];
        saveExclude();
        state.history = [];
        state.enterMode = "forward";
        app.querySelectorAll("[data-sort]").forEach((b) => b.classList.toggle("on", b.getAttribute("data-sort") === next));
        await loadCard(g);
      });
    });
    state.enterFrom = "right";
    state.enterMode = "forward";
    await loadCard(g);
  }

  async function loadCard(g) {
    const params = new URLSearchParams();
    if (state.exclude.length) params.set("exclude", state.exclude.join(","));
    const sort = (state.me && state.me.stack_sort) || state.stackSort || "active";
    params.set("sort", sort);
    const qs = params.toString() ? "?" + params.toString() : "";
    let data;
    try {
      data = await api("/api/stack" + qs);
    } catch (err) {
      if (stale(g)) return;
      const stage = app.querySelector(".stage");
      if (!stage) return;
      stage.innerHTML = `<div class="state-block">
        <p class="empty-lead">couldn’t load</p>
        <p class="empty-sub">${escapeHtml(err.message)}</p>
        <button type="button" class="btn" id="retry-stack">try again</button>
      </div>`;
      const b = document.getElementById("retry-stack");
      if (b) b.addEventListener("click", () => loadCard(g));
      return;
    }
    if (stale(g)) return;
    const stage = app.querySelector(".stage");
    if (!stage) return;
    if (!data.profile) {
      stage.innerHTML = `<div class="state-block">
        <p class="empty-lead">that’s the stack for now</p>
        <p class="empty-sub">come back later, or bring one back if you moved past too fast.</p>
        ${state.history.length ? `<button type="button" class="btn" id="empty-back">previous</button>` : ""}
      </div>`;
      state.card = null;
      const eb = document.getElementById("empty-back");
      if (eb) eb.addEventListener("click", goBack);
      return;
    }
    mountProfile(data.profile, state.enterMode || "forward");
  }

  function mountProfile(profile, mode) {
    const stage = app.querySelector(".stage");
    if (!stage) return;
    state.card = profile;
    state.enterMode = mode;
    stage.innerHTML = slideHtml(profile);
    const el = stage.querySelector(".slide");
    bindSlide(el, profile);
    enterSlide(el, mode);
  }

  function slideHtml(p) {
    const canBack = state.history.length > 0;
    const presence = formatPresence(Number(p.last_seen_at) || 0);
    const live = presence === "active now";
    return `
      <article class="slide" id="slide">
        <div class="slide-body">
          <div class="presence-row" title="last activity">
            <span class="presence-dot ${live ? "live" : ""}" aria-hidden="true"></span>
            <span class="presence-label">${escapeHtml(presence)}</span>
          </div>
          <dl class="qa">
            <div>
              <dt>Why are you here?</dt>
              <dd>${escapeHtml(p.why_here)}</dd>
            </div>
            <div>
              <dt>What are you into right now?</dt>
              <dd>${escapeHtml(p.into_now)}</dd>
            </div>
            <div>
              <dt>Ask them something.</dt>
              <dd class="ask">${escapeHtml(p.ask_them)}</dd>
            </div>
          </dl>
          <form class="answer-ambient" hidden>
            <label class="sr-only" for="answer-body">your answer</label>
            <textarea id="answer-body" name="body" required maxlength="2000" rows="3" placeholder="answer their question… (Enter to send)"></textarea>
          </form>
        </div>
        <div class="slide-bar" id="slide-bar">
          <button type="button" class="back-chip" data-act="back" aria-label="previous" ${canBack ? "" : "hidden"}>‹</button>
          <button type="button" class="btn primary sm" data-act="answer">answer</button>
          <div class="more-wrap">
            <button type="button" class="text-act more-btn" data-act="more" aria-label="more" aria-expanded="false" aria-haspopup="menu">:</button>
            <div class="more-menu" hidden role="menu">
              <button type="button" class="text-act" data-act="bookmark" role="menuitem">bookmark</button>
              <button type="button" class="text-act danger" data-act="report" role="menuitem">report</button>
              <button type="button" class="text-act danger" data-act="block" role="menuitem">block</button>
            </div>
          </div>
        </div>
      </article>`;
  }

  function enterSlide(el, mode) {
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      el.classList.add("in");
      return;
    }
    el.classList.remove("in", "out-ul", "out-dr", "enter-ul", "enter-dr", "enter-left", "enter-right", "out-left", "out-right");
    // forward after dismiss-ul AND bring-back: enter moving down-to-right
    el.classList.add("enter-dr");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.classList.remove("enter-ul", "enter-dr", "enter-left", "enter-right");
        el.classList.add("in");
      });
    });
  }

  function bindSlide(el, profile) {
    if (!el) return;
    const box = el.querySelector(".answer-ambient");
    const ta = box.querySelector("textarea");
    const moreBtn = el.querySelector('[data-act="more"]');
    const moreMenu = el.querySelector(".more-menu");

    function closeMore() {
      if (!moreMenu || !moreBtn) return;
      moreMenu.hidden = true;
      moreBtn.setAttribute("aria-expanded", "false");
    }

    function exitAnswer() {
      box.hidden = true;
      el.classList.remove("answering");
      if (ta) ta.blur();
    }

    const reportBtn = el.querySelector('[data-act="report"]');
    if (reportBtn) {
      reportBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMore();
        onReport(profile);
      });
    }
    el.querySelector('[data-act="block"]').addEventListener("click", (e) => {
      e.stopPropagation();
      closeMore();
      onBlock(profile);
    });
    const bmBtn = el.querySelector('[data-act="bookmark"]');
    if (bmBtn) {
      bmBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMore();
        onBookmark(profile);
      });
    }

    if (moreBtn && moreMenu) {
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = moreMenu.hidden;
        moreMenu.hidden = !open;
        moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      // Close on outside tap within this slide only (no document listener leak).
      el.addEventListener(
        "pointerdown",
        (ev) => {
          if (!moreMenu.hidden && !ev.target.closest(".more-wrap")) closeMore();
        },
        true,
      );
    }

    el.querySelector('[data-act="answer"]').addEventListener("click", (e) => {
      e.stopPropagation();
      closeMore();
      box.hidden = false;
      el.classList.add("answering");
      ta.focus();
    });

    const backBtn = el.querySelector('[data-act="back"]');
    if (backBtn) {
      backBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMore();
        goBack();
      });
    }

    box.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = String(new FormData(box).get("body") || "").trim();
      if (text) onAnswer(profile, text);
    });

    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exitAnswer();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        box.requestSubmit();
      }
    });

    let startX = 0;
    let startY = 0;
    let dx = 0;
    let dy = 0;
    let tracking = false;
    let locked = null;

    const onStart = (x, y) => {
      if (el.classList.contains("answering")) return;
      tracking = true;
      locked = null;
      startX = x;
      startY = y;
      dx = 0;
      dy = 0;
      el.classList.add("dragging");
    };
    const onMove = (x, y) => {
      if (!tracking) return;
      dx = x - startX;
      dy = y - startY;
      if (locked === null && Math.hypot(dx, dy) > 10) {
        // favor diagonal / horizontal for swipe; vertical stays for body scroll
        locked = Math.abs(dx) > Math.abs(dy) * 0.7 ? "x" : "y";
      }
      if (locked !== "x") return;
      // unmistakable diagonal: left→up-left, right→down-right + rotate
      const ty = dx < 0 ? dx * 0.72 : dx * 0.72;
      const rot = Math.max(-14, Math.min(14, dx / 18));
      const sc = Math.max(0.9, 1 - Math.abs(dx) / 900);
      const fade = Math.max(0.22, 1 - Math.abs(dx) / 380);
      el.style.transform = `translate(${dx}px, ${ty}px) rotate(${rot}deg) scale(${sc})`;
      el.style.opacity = String(fade);
    };
    const onEnd = () => {
      if (!tracking) return;
      tracking = false;
      el.classList.remove("dragging");
      if (locked === "x" && Math.abs(dx) > 64) {
        if (dx < 0) {
          // dismiss forward: exit up-left
          pushHistory(profile);
          dismiss("ul", () => skip(profile.id));
        } else if (state.history.length) {
          // opposite: bring back — exit current down-right then restore
          goBack();
        } else {
          // no history: also advance forward via right (still up-left exit energy flipped? use ul for next)
          pushHistory(profile);
          dismiss("ul", () => skip(profile.id));
        }
      } else {
        el.style.transform = "";
        el.style.opacity = "";
      }
    };

    el.addEventListener(
      "touchstart",
      (e) => {
        if (e.target.closest("button, textarea, input, form, a")) return;
        const t = e.changedTouches[0];
        onStart(t.clientX, t.clientY);
      },
      { passive: true },
    );
    el.addEventListener(
      "touchmove",
      (e) => {
        const t = e.changedTouches[0];
        onMove(t.clientX, t.clientY);
        if (locked === "x") e.preventDefault();
      },
      { passive: false },
    );
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);

    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      if (e.target.closest("button, textarea, input, form, a")) return;
      el.setPointerCapture(e.pointerId);
      onStart(e.clientX, e.clientY);
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      onMove(e.clientX, e.clientY);
    });
    el.addEventListener("pointerup", (e) => {
      if (e.pointerType === "touch") return;
      onEnd();
    });
  }

  function pushHistory(profile) {
    if (!profile) return;
    state.history.push({ ...profile });
    if (state.history.length > HISTORY_MAX) state.history.shift();
  }

  function dismiss(dir, after) {
    const el = document.getElementById("slide");
    if (!el) {
      after();
      return;
    }
    el.style.transform = "";
    el.style.opacity = "";
    el.classList.remove("in", "enter-ul", "enter-dr", "enter-left", "enter-right");
    // ul = up-left (dismiss), dr = down-right (leaving when going back to previous)
    el.classList.add(dir === "dr" ? "out-dr" : "out-ul");
    const ms = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420;
    setTimeout(after, ms);
  }

  async function skip(id) {
    rememberExclude(id);
    try {
      await api("/api/stack/skip", { method: "POST", body: JSON.stringify({ id }) });
    } catch {
      /* guests skip locally */
    }
    state.enterMode = "forward";
    await loadCard();
  }

  function goBack() {
    if (!state.history.length) return;
    const prev = state.history.pop();
    forgetExclude(prev.id);
    const current = state.card;
    const finish = () => {
      state.enterMode = "back";
      mountProfile(prev, "back");
    };
    if (current) {
      // current leaves down-right; previous comes in down-to-right
      dismiss("dr", finish);
    } else {
      finish();
    }
  }

  async function onBookmark(profile) {
    if (!(await requireLogin())) return;
    try {
      await api("/api/bookmarks", { method: "POST", body: JSON.stringify({ id: profile.id }) });
      showToast("bookmarked");
    } catch (err) {
      alert(err.message);
    }
  }

  async function onBlock(profile) {
    if (!(await requireLogin())) return;
    const ok = confirm("Block this person? They will not show again.");
    if (!ok) return;
    try {
      await api("/api/stack/block", { method: "POST", body: JSON.stringify({ id: profile.id, reason: "block" }) });
      rememberExclude(profile.id);
      state.history = state.history.filter((h) => h.id !== profile.id);
      state.enterMode = "forward";
      dismiss("ul", loadCard);
    } catch (err) {
      alert(err.message);
    }
  }

  async function onReport(profile) {
    if (!(await requireLogin())) return;
    const ok = confirm("Report this person? They leave your stack. At 20 distinct reports their account is removed.");
    if (!ok) return;
    try {
      await api("/api/stack/report", { method: "POST", body: JSON.stringify({ id: profile.id, reason: "report" }) });
      showToast("reported");
      rememberExclude(profile.id);
      state.history = state.history.filter((h) => h.id !== profile.id);
      state.enterMode = "forward";
      dismiss("ul", loadCard);
    } catch (err) {
      alert(err.message);
    }
  }

  async function onAnswer(profile, text) {
    if (!text) return;
    if (!state.me) {
      state.pendingAnswer = { id: profile.id, body: text };
      showModal();
      return;
    }
    try {
      await sendAnswer(profile.id, text);
    } catch (err) {
      alert(err.message);
    }
  }

  function pollHtml(q) {
    const opts = q.options || [];
    const total = opts.reduce((n, o) => n + (o.votes || 0), 0) || 0;
    const my = q.my_vote || null;
    return `<div class="poll" data-qid="${escapeHtml(q.id)}">
      ${opts
        .map((o) => {
          const pct = total ? Math.round((100 * (o.votes || 0)) / total) : 0;
          const mine = my === o.id ? "mine" : "";
          const voted = my ? "voted" : "";
          return `<button type="button" class="poll-opt ${voted} ${mine}" data-oid="${escapeHtml(o.id)}" ${my ? "disabled" : ""}>
            <span class="bar" style="width:${my ? pct : 0}%"></span>
            <span class="poll-row">
              <span class="poll-label">${escapeHtml(o.label)}</span>
              <span class="poll-count">${my ? pct + "%" : ""}</span>
            </span>
          </button>`;
        })
        .join("")}
    </div>`;
  }

  async function renderQa(g) {
    setNav("qa");
    app.innerHTML = fadeWrap(`<div class="qa-page">
      <h1>q&amp;a</h1>
      <div class="skel skel-title"></div>
      <div class="skel skel-line"></div>
      <div class="skel skel-line w80"></div>
      <div class="skel skel-line w60"></div>
    </div>`);
    let data;
    try {
      data = await api("/api/questions");
    } catch (err) {
      if (stale(g)) return;
      renderError(err.message);
      return;
    }
    if (stale(g)) return;
    const ask = state.me
      ? `<section class="ask-panel ask-sticky" aria-label="ask a question">
           <p class="ask-prompt">Ask something</p>
           <form id="ask-form">
             <div class="ask-kind" role="tablist" aria-label="question type">
               <button type="button" class="active" data-kind="text">text</button>
               <button type="button" data-kind="poll">poll</button>
               <button type="button" data-kind="image">image</button>
             </div>
             <input type="hidden" name="kind" value="text" />
             <label class="sr-only" for="ask-body">your question</label>
             <textarea id="ask-body" name="body" required maxlength="500" placeholder="what do you want to know?"></textarea>
             <div class="ask-extra" id="poll-fields" hidden>
               <div class="poll-compose" id="poll-compose">
                 <label class="sr-only">option 1</label>
                 <input name="opt" maxlength="80" placeholder="option one" />
                 <label class="sr-only">option 2</label>
                 <input name="opt" maxlength="80" placeholder="option two" />
               </div>
               <button type="button" class="btn ghost sm" id="poll-add-opt">+ add option</button>
             </div>
             <div class="ask-extra" id="img-pick" hidden>
               <div class="img-pick">
                 <label>add an image
                   <input name="image" type="file" accept="image/jpeg,image/png,image/webp,image/gif" />
                 </label>
                 <img class="img-preview" id="img-preview" alt="" />
               </div>
             </div>
             <div class="ask-actions">
               <button class="btn primary" type="submit">post</button>
             </div>
           </form>
         </section>`
      : `<section class="ask-guest ask-sticky">
           <p class="hint"><a href="#/login">log in</a> to ask. Anyone can answer, no names.</p>
         </section>`;

    const items = (data.questions || [])
      .map((q) => {
        const kindLabel = q.kind === "poll" ? "poll" : q.kind === "image" ? "image" : "question";
        const media =
          q.image_url
            ? `<div class="q-media"><img src="${escapeHtml(q.image_url)}" alt="" loading="lazy" /></div>`
            : "";
        const poll = (q.kind === "poll" || (q.options && q.options.length)) ? pollHtml(q) : "";
        const answers = (q.answers || [])
          .map((a) => `<div class="q-answer">${escapeHtml(a.body)}</div>`)
          .join("");
        const reply =
          q.kind === "poll"
            ? ""
            : `<form class="reply-row ans-form" data-qid="${escapeHtml(q.id)}">
            <label class="sr-only" for="ans-${escapeHtml(q.id)}">answer</label>
            <textarea id="ans-${escapeHtml(q.id)}" name="body" required maxlength="1000" placeholder="answer…" rows="2"></textarea>
            <button class="btn sm" type="submit">reply</button>
          </form>`;
        const answersBlock =
          q.kind === "poll"
            ? ""
            : `<div class="q-answers">${answers || `<p class="q-empty">no answers yet</p>`}</div>`;
        return `<article class="q-card">
          <div class="q-meta">${kindLabel}</div>
          <div class="q-body">${escapeHtml(q.body)}</div>
          ${media}
          ${poll}
          ${answersBlock}
          ${reply}
        </article>`;
      })
      .join("");

    app.innerHTML = fadeWrap(`<div class="qa-page"><h1>q&amp;a</h1>${ask}<div class="qa-feed">${
      items ||
      `<div class="state-block"><p class="empty-lead">quiet so far</p><p class="empty-sub">ask something, or check back when the room has a pulse.</p></div>`
    }</div></div>`);

    const askForm = document.getElementById("ask-form");
    if (askForm) {
      const kindInput = askForm.querySelector('input[name="kind"]');
      const pollFields = document.getElementById("poll-fields");
      const pollCompose = document.getElementById("poll-compose");
      const pollAdd = document.getElementById("poll-add-opt");
      const imgPick = document.getElementById("img-pick");
      const preview = document.getElementById("img-preview");
      const syncPollRequired = (on) => {
        if (!pollCompose) return;
        pollCompose.querySelectorAll('input[name="opt"]').forEach((inp, i) => {
          inp.required = on && i < 2;
        });
      };
      syncPollRequired(false);
      if (pollAdd && pollCompose) {
        pollAdd.addEventListener("click", () => {
          const n = pollCompose.querySelectorAll('input[name="opt"]').length;
          if (n >= 10) {
            showToast("max 10 options");
            return;
          }
          const wrap = document.createElement("label");
          wrap.className = "sr-only";
          wrap.textContent = "option " + (n + 1);
          const inp = document.createElement("input");
          inp.name = "opt";
          inp.maxLength = 80;
          inp.placeholder = "option " + (n + 1);
          pollCompose.appendChild(wrap);
          pollCompose.appendChild(inp);
          inp.focus();
        });
      }
      askForm.querySelectorAll(".ask-kind button").forEach((btn) => {
        btn.addEventListener("click", () => {
          askForm.querySelectorAll(".ask-kind button").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const k = btn.getAttribute("data-kind");
          kindInput.value = k;
          pollFields.hidden = k !== "poll";
          imgPick.hidden = k !== "image";
          syncPollRequired(k === "poll");
          const imgInput = askForm.querySelector('input[name="image"]');
          if (imgInput) imgInput.required = k === "image";
        });
      });
      const fileInput = askForm.querySelector('input[name="image"]');
      if (fileInput) {
        fileInput.addEventListener("change", () => {
          const f = fileInput.files && fileInput.files[0];
          if (!f) {
            preview.classList.remove("show");
            preview.removeAttribute("src");
            return;
          }
          preview.src = URL.createObjectURL(f);
          preview.classList.add("show");
        });
      }
      askForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const postBtn = askForm.querySelector('button[type="submit"]');
        if (postBtn && postBtn.disabled) return;
        const fd = new FormData(askForm);
        const kind = String(fd.get("kind") || "text");
        const payload = { body: fd.get("body"), kind };
        if (postBtn) {
          postBtn.disabled = true;
          postBtn.innerHTML = '<span class="btn-spinner"></span>posting';
        }
        try {
          if (kind === "poll") {
            const options = fd.getAll("opt")
              .map((x) => String(x || "").trim())
              .filter(Boolean);
            if (options.length < 2) throw new Error("add at least 2 options");
            payload.options = options;
          }
          if (kind === "image") {
            const file = fd.get("image");
            if (!(file instanceof File) || !file.size) throw new Error("image required");
            const up = new FormData();
            up.append("file", file);
            const uploaded = await api("/api/upload", { method: "POST", body: up });
            payload.image_key = uploaded.key;
          }
          await api("/api/questions", { method: "POST", body: JSON.stringify(payload) });
          showToast("saved");
          renderQa();
        } catch (err) {
          alert(err.message);
          if (postBtn) {
            postBtn.disabled = false;
            postBtn.textContent = "post";
          }
        }
      });
    }

    app.querySelectorAll(".poll").forEach((pollEl) => {
      pollEl.querySelectorAll(".poll-opt").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (btn.disabled) return;
          pollEl.classList.add("posting-pending");
          try {
            await api(`/api/questions/${pollEl.getAttribute("data-qid")}/vote`, {
              method: "POST",
              body: JSON.stringify({ option_id: btn.getAttribute("data-oid") }),
            });
            showToast("saved");
            renderQa();
          } catch (err) {
            pollEl.classList.remove("posting-pending");
            alert(err.message);
          }
        });
      });
    });

    app.querySelectorAll(".ans-form").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        try {
          await api(`/api/questions/${form.getAttribute("data-qid")}/answers`, {
            method: "POST",
            body: JSON.stringify({ body: fd.get("body") }),
          });
          showToast("saved");
          renderQa();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

  function convoLabel(c) {
    const custom = (c.custom_title || "").trim();
    if (custom) return clip(custom, 48);
    return substanceLabel(c.other_ask, 48) || "conversation";
  }

  function convoFlag(c) {
    if (c.unread) return { text: "new", hot: true };
    if (c.fading) return { text: "fading", hot: false };
    if (c.bumped && c.waiting) return { text: "nudged", hot: false };
    if (c.waiting && state.me && c.initiator_id === state.me.id) return { text: "waiting", hot: false };
    return null;
  }

  async function renderMessages(g) {
    setNav("messages");
    if (!state.me) {
      app.innerHTML = fadeWrap(`<div class="inbox">
        <div class="page-head"><h1>messages</h1></div>
        <div class="state-block">
          <p class="empty-lead">your inbox lives here</p>
          <p class="empty-sub">log in to read threads. answering someone on home starts a conversation.</p>
          <a class="btn primary" href="#/login">log in</a>
        </div>
      </div>`);
      return;
    }
    app.innerHTML = fadeWrap(`<div class="inbox">
      <div class="page-head"><h1>messages</h1></div>
      <div class="inbox-list">
        <div class="skel-row"><div class="skel skel-line w80"></div><div class="skel skel-line w60"></div></div>
        <div class="skel-row"><div class="skel skel-line w80"></div><div class="skel skel-line w40"></div></div>
        <div class="skel-row"><div class="skel skel-line w80"></div><div class="skel skel-line w60"></div></div>
      </div>
    </div>`);
    let data;
    try {
      data = await api("/api/conversations");
    } catch (err) {
      if (stale(g)) return;
      renderError(err.message);
      return;
    }
    if (stale(g)) return;
    updateInboxBadgeFrom(data.conversations || []);
    const items = (data.conversations || [])
      .map((c) => {
        const flag = convoFlag(c);
        const preview = c.last_body || "";
        const who =
          c.last_kind === "system" ? "" : c.last_sender_id === state.me.id ? "you · " : "";
        return `<a class="inbox-row ${c.unread ? "unread" : ""}" href="#/messages/${escapeHtml(c.id)}">
          <div class="inbox-main">
            <div class="inbox-title">${escapeHtml(convoLabel(c))}</div>
            <div class="inbox-preview">${escapeHtml(who + preview)}</div>
          </div>
          <div class="inbox-aside">
            <div class="inbox-time">${escapeHtml(formatRel(c.last_message_at || c.last_activity_at))}</div>
            <div class="inbox-flags">
              ${flag ? `<span class="flag ${flag.hot ? "hot" : ""}">${flag.text}</span>` : ""}
              ${c.unread ? `<span class="unread-dot" aria-hidden="true"></span>` : ""}
            </div>
          </div>
        </a>`;
      })
      .join("");
    app.innerHTML = fadeWrap(`<div class="inbox">
      <div class="page-head"><h1>messages</h1></div>
      ${
        items
          ? `<div class="inbox-list">${items}</div>`
          : `<div class="state-block">
              <p class="empty-lead">no conversations yet</p>
              <p class="empty-sub">answer someone on home. if they reply, it stays. if not, it fades after five days.</p>
              <a class="btn" href="#/">go home</a>
            </div>`
      }
    </div>`);
  }

  function expiryCopy(convo) {
    if (!convo || !convo.waiting || !convo.expires_at) return "";
    const left = convo.expires_at - Date.now();
    if (left <= 0) return "fading now";
    const days = Math.ceil(left / 86400000);
    if (days <= 1) return "fades today";
    if (days === 2) return "fades tomorrow";
    return `fades in ${days} days`;
  }

  function threadSub(convo) {
    if (!convo) return "";
    if (convo.waiting) {
      const exp = expiryCopy(convo);
      if (convo.bumped) return exp ? `nudged · ${exp}` : "nudged";
      return exp || "waiting";
    }
    return "";
  }

  function receiptLabel(createdAt, otherLastReadAt) {
    if (otherLastReadAt == null) return "delivered";
    if (otherLastReadAt >= createdAt) return "seen";
    return "delivered";
  }

  function renderThreadMessages(messages, { readReceipts = false, otherLastReadAt = null } = {}) {
    let html = "";
    let lastDay = null;
    let lastSender = null;
    let lastKind = null;
    let lastTs = 0;
    let lastMineId = null;
    const flushMeta = (mine, ts, mid) => {
      if (!ts) return;
      let extra = "";
      if (mine && readReceipts && mid) {
        const label = receiptLabel(ts, otherLastReadAt);
        extra = ` · <span class="receipt" data-receipt-for="${escapeHtml(mid)}">${label}</span>`;
      }
      html += `<div class="bubble-time ${mine ? "mine" : "theirs"}">${escapeHtml(formatClock(ts))}${extra}</div>`;
    };
    (messages || []).forEach((m, i) => {
      if (!lastDay || !sameDay(lastDay, m.created_at)) {
        if (lastKind === "user" && lastTs) flushMeta(lastSender === state.me.id, lastTs, lastMineId);
        html += `<div class="day-sep">${escapeHtml(formatDayLabel(m.created_at))}</div>`;
        lastDay = m.created_at;
        lastSender = null;
        lastKind = null;
        lastMineId = null;
      }
      if (m.kind === "system") {
        if (lastKind === "user" && lastTs) flushMeta(lastSender === state.me.id, lastTs, lastMineId);
        lastSender = null;
        lastKind = "system";
        lastTs = m.created_at;
        lastMineId = null;
        html += `<div class="bubble system" data-mid="${escapeHtml(m.id)}">${escapeHtml(m.body)}</div>`;
        return;
      }
      const mine = m.sender_id === state.me.id;
      const grouped =
        lastKind === "user" && lastSender === m.sender_id && m.created_at - lastTs < 4 * 60 * 1000;
      if (lastKind === "user" && lastTs && !grouped) flushMeta(lastSender === state.me.id, lastTs, lastMineId);
      html += `<div class="bubble ${mine ? "mine" : "theirs"}${grouped ? " group-follow" : ""}" data-mid="${escapeHtml(m.id)}" data-created="${m.created_at}">${escapeHtml(m.body)}</div>`;
      lastSender = m.sender_id;
      lastKind = "user";
      lastTs = m.created_at;
      lastMineId = mine ? m.id : null;
      if (i === messages.length - 1) flushMeta(mine, m.created_at, lastMineId);
    });
    return html;
  }

  function applyReadReceipts(otherLastReadAt) {
    if (otherLastReadAt == null) return;
    document.querySelectorAll(".receipt[data-receipt-for]").forEach((el) => {
      const mid = el.getAttribute("data-receipt-for");
      const bubble = document.querySelector(`.bubble[data-mid="${CSS.escape(mid)}"]`);
      if (!bubble) return;
      // Approximate: if any mine bubble exists with data-mid, use its sibling time's message created — we encode via comparing last_read
      // Prefer marking all mine receipts whose bubble appears before "now" using DOM order + stored ts on bubble-time is not available.
      // Simpler: mark all mine receipts as seen when otherLastReadAt is set; refine by scanning messages order.
      el.textContent = "seen";
    });
    // Refine: only mark receipts for messages that have been read — use data-created if present
    document.querySelectorAll(".bubble.mine[data-mid][data-created]").forEach((b) => {
      const created = Number(b.getAttribute("data-created") || 0);
      const mid = b.getAttribute("data-mid");
      const el = document.querySelector(`.receipt[data-receipt-for="${CSS.escape(mid)}"]`);
      if (!el) return;
      el.textContent = created && otherLastReadAt >= created ? "seen" : "delivered";
    });
  }

  function autosize(ta) {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 128) + "px";
  }

  function scrollThreadEnd(el) {
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function maybeShowSafetyTip() {
    try {
      if (localStorage.getItem(SAFETY_KEY)) return;
    } catch { return; }
    const tip = document.createElement("div");
    tip.className = "safety-tip";
    tip.setAttribute("role", "status");
    tip.innerHTML = `<p><strong>Stay safe.</strong> Keep personal details private until you trust someone. You can mute or leave anytime.</p>
      <button type="button" class="btn sm" id="safety-dismiss">got it</button>`;
    const head = document.querySelector(".thread-head");
    if (head) head.insertAdjacentElement("afterend", tip);
    else {
      const scroller = document.getElementById("thread-scroll");
      if (scroller) scroller.prepend(tip);
    }
    const btn = document.getElementById("safety-dismiss");
    if (btn) {
      btn.addEventListener("click", () => {
        tip.remove();
        try { localStorage.setItem(SAFETY_KEY, "1"); } catch { /* ignore */ }
      });
    }
  }

  async function renderThread(id, g) {
    setNav("thread");
    if (!state.me) {
      location.hash = "#/login";
      return;
    }
    app.innerHTML = `<div class="thread-page page-fade">
      <header class="thread-head">
        <a class="thread-back" href="#/messages" aria-label="back to messages">‹</a>
        <div class="thread-heading"><div class="thread-title">conversation</div></div>
        <button type="button" class="thread-menu-btn" id="thread-menu" aria-label="chat settings">⋯</button>
      </header>
      <div class="thread-scroll">
        <div class="skel skel-bubble"></div>
        <div class="skel skel-bubble mine"></div>
        <div class="skel skel-bubble"></div>
      </div>
    </div>`;
    let data;
    try {
      data = await api("/api/conversations/" + id);
    } catch (err) {
      if (stale(g)) return;
      if (err.status === 404) {
        app.innerHTML = fadeWrap(`<div class="state-block">
          <p class="empty-lead">this thread is gone</p>
          <p class="empty-sub">it may have faded after five days without a reply.</p>
          <a class="btn" href="#/messages">back to messages</a>
        </div>`);
        return;
      }
      renderError(err.message);
      return;
    }
    if (stale(g)) return;
    refreshInboxBadge();
    const convo = data.conversation || {};
    const title = (convo.custom_title && String(convo.custom_title).trim())
      || substanceLabel(convo.other_ask, 42)
      || "conversation";
    const sub = threadSub(convo);
    const receiptsOn = convo.read_receipts !== false;
    let otherLastRead = convo.other_last_read_at ?? null;
    const msgs = renderThreadMessages(data.messages || [], {
      readReceipts: receiptsOn,
      otherLastReadAt: otherLastRead,
    });
    const isFirstChat = !(data.messages || []).some((m) => m.kind === "user" && m.sender_id === state.me.id);
    app.innerHTML = `<div class="thread-page page-fade">
      <header class="thread-head">
        <a class="thread-back" href="#/messages" aria-label="back to messages">‹</a>
        <div class="thread-heading">
          <button type="button" class="thread-title thread-title-btn" id="rename-chat" title="rename">${escapeHtml(title)}</button>
          ${sub ? `<div class="thread-sub">${escapeHtml(sub)}</div>` : ""}
        </div>
        <button type="button" class="thread-menu-btn" id="thread-menu" aria-label="chat settings">⋯</button>
      </header>
      <div id="thread-settings" class="thread-settings" hidden>
        <label class="toggle">mute notifications
          <span class="switch">
            <input type="checkbox" id="mute-toggle" ${convo.muted ? "checked" : ""} />
            <span class="knob"></span>
          </span>
        </label>
        <label class="toggle">read receipts
          <span class="switch">
            <input type="checkbox" id="receipts-toggle" ${receiptsOn ? "checked" : ""} />
            <span class="knob"></span>
          </span>
        </label>
        <p class="settings-note">Mute hides alerts and unread badges for this chat. Receipts are on by default.</p>
      </div>
      <div class="thread-scroll" id="thread-scroll">
        <div class="thread">${msgs || `<p class="empty">no messages yet</p>`}</div>
      </div>
      <form id="msg-form" class="composer thread-compose">
        <label class="sr-only" for="msg-body">write</label>
        <textarea id="msg-body" name="body" required maxlength="2000" rows="1" placeholder="write"></textarea>
        <button class="btn primary" type="submit">send</button>
      </form>
    </div>`;
    if (isFirstChat) maybeShowSafetyTip();
    else {
      try {
        if (!localStorage.getItem(SAFETY_KEY)) maybeShowSafetyTip();
      } catch { /* ignore */ }
    }
    // One-time: if they've opened any chat before tip dismissed, tip still shows once
    const form = document.getElementById("msg-form");
    const ta = document.getElementById("msg-body");
    const scroller = document.getElementById("thread-scroll");
    const btn = form.querySelector('button[type="submit"]');
    autosize(ta);
    scrollThreadEnd(scroller);
    ta.addEventListener("input", () => autosize(ta));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    ensureThreadRealtime(id, g);
    // Live read receipts
    if (realtime.thread && !realtime.thread._receiptHook) {
      realtime.thread._receiptHook = true;
    }
    const menuBtn = document.getElementById("thread-menu");
    const settingsEl = document.getElementById("thread-settings");
    if (menuBtn && settingsEl) {
      menuBtn.addEventListener("click", () => {
        settingsEl.hidden = !settingsEl.hidden;
      });
    }
    const muteToggle = document.getElementById("mute-toggle");
    if (muteToggle) {
      muteToggle.addEventListener("change", async () => {
        try {
          await api(`/api/conversations/${id}/prefs`, {
            method: "PATCH",
            body: JSON.stringify({ muted: muteToggle.checked }),
          });
          showToast(muteToggle.checked ? "muted" : "unmuted");
          refreshInboxBadge();
        } catch (err) {
          muteToggle.checked = !muteToggle.checked;
          alert(err.message);
        }
      });
    }
    const receiptsToggle = document.getElementById("receipts-toggle");
    if (receiptsToggle) {
      receiptsToggle.addEventListener("change", async () => {
        try {
          await api(`/api/conversations/${id}/prefs`, {
            method: "PATCH",
            body: JSON.stringify({ read_receipts: receiptsToggle.checked }),
          });
          showToast(receiptsToggle.checked ? "receipts on" : "receipts off");
          // Soft re-render receipts
          renderThread(id, g);
        } catch (err) {
          receiptsToggle.checked = !receiptsToggle.checked;
          alert(err.message);
        }
      });
    }
    const renameBtn = document.getElementById("rename-chat");
    if (renameBtn) {
      renameBtn.addEventListener("click", async () => {
        const next = prompt("Chat name (only you see this)", title);
        if (next == null) return;
        try {
          const res = await api(`/api/conversations/${id}/title`, {
            method: "PATCH",
            body: JSON.stringify({ title: String(next).trim() }),
          });
          const label = (res.custom_title && String(res.custom_title).trim())
            || substanceLabel(convo.other_ask, 42)
            || "conversation";
          renameBtn.textContent = label;
          showToast("renamed");
        } catch (err) {
          alert(err.message);
        }
      });
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = String(ta.value || "").trim();
      if (!text || btn.disabled) return;
      // Safety tip on first send if not yet seen
      try {
        if (!localStorage.getItem(SAFETY_KEY) && !document.querySelector(".safety-tip")) {
          maybeShowSafetyTip();
        }
      } catch { /* ignore */ }
      btn.disabled = true;
      ta.value = "";
      autosize(ta);
      const thread = scroller.querySelector(".thread");
      const nowTs = Date.now();
      if (thread) {
        const receiptBit =
          receiptsOn
            ? ` · <span class="receipt">delivered</span>`
            : "";
        thread.insertAdjacentHTML(
          "beforeend",
          `<div class="bubble mine">${escapeHtml(text)}</div><div class="bubble-time mine">${escapeHtml(formatClock(nowTs))}${receiptBit}</div>`,
        );
        scrollThreadEnd(scroller);
      }
      showToast("sent");
      try {
        const sent = await api(`/api/conversations/${id}/messages`, {
          method: "POST",
          body: JSON.stringify({ body: text }),
        });
        if (sent && sent.message) appendLiveMessage(sent.message);
        api("/api/conversations/" + id).then(async (fresh) => {
          if (stale(g) || route().parts[1] !== id) return;
          const subEl = document.querySelector(".thread-sub");
          const next = threadSub(fresh.conversation || {});
          if (subEl) {
            subEl.textContent = next;
          } else if (next) {
            const heading = document.querySelector(".thread-heading");
            if (heading && !heading.querySelector(".thread-sub")) {
              heading.insertAdjacentHTML("beforeend", `<div class="thread-sub">${escapeHtml(next)}</div>`);
            }
          }
          if (fresh.conversation && fresh.conversation.other_last_read_at != null) {
            otherLastRead = fresh.conversation.other_last_read_at;
            applyReadReceipts(otherLastRead);
          }
        }).catch(() => { /* ignore subtitle refresh */ });
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
        ta.focus({ preventScroll: true });
      }
    });
  }

  async function renderSettings() {
    setNav("you");
    const u = state.me;
    const persist = !!u;
    const customVals = persist ? parsePackedCustom(u.theme_custom || "") : storedUithemeCustom();
    const currentPreset = persist ? u.theme_preset || "" : storedUitheme();
    app.innerHTML = fadeWrap(`<div class="settings">
      <div class="row-btns settings-back-row">
        <a class="btn ghost sm" href="#/you">&larr; back</a>
      </div>
      <h1>settings</h1>
      <section class="settings-block">
        <h2>appearance</h2>
        <p class="settings-note">theme — recolors the whole app${persist ? "" : " (this device until you log in)"}</p>
        <div class="theme-picks" id="theme-picks">${uithemePicksHtml(currentPreset)}</div>
        ${themeCustomHtml(customVals)}
      </section>
      ${persist ? "" : `<section class="settings-block">
        <h2>account</h2>
        <p class="hint">log in to sync your look across devices.</p>
        <div class="row-btns">
          <a class="btn primary" href="#/login">log in</a>
          <a class="btn" href="#/register">create an account</a>
        </div>
      </section>`}
    </div>`);
    bindUithemeControls(persist);
    applyUserAppearance(u);
  }

  async function renderYou() {
    setNav("you");
    if (!state.me) {
      app.innerHTML = fadeWrap(`<div class="settings">
        <h1>you</h1>
        <section class="settings-block">
          <h2>account</h2>
          <p class="hint">log in to edit your answers and read messages.</p>
          <div class="row-btns">
            <a class="btn primary" href="#/login">log in</a>
            <a class="btn" href="#/register">create an account</a>
          </div>
        </section>
        <section class="settings-block">
          <h2>more</h2>
          <div class="row-btns">
            <a class="btn" href="#/settings">settings</a>
          </div>
        </section>
        <section class="settings-block">
          <h2>legal</h2>
          <p class="fine"><a href="#/terms">terms</a> · <a href="#/privacy">privacy</a></p>
        </section>
      </div>`);
      applyUserAppearance(null);
      return;
    }
    const u = state.me;
    app.innerHTML = fadeWrap(`<div class="settings">
      <h1>you</h1>
      <div class="row-btns settings-link-row">
        <a class="btn" href="#/settings">settings</a>
      </div>
      <section class="settings-block">
        <h2>bookmarks</h2>
        <div id="bookmarks-box" class="bookmark-list"><p class="hint">loading…</p></div>
      </section>
      <section class="settings-block">
        <h2>blocked</h2>
        <div id="blocks-box" class="block-list"><p class="hint">loading…</p></div>
      </section>
      <section class="settings-block">
        <h2>profile</h2>
        <form id="you-form" class="form">
          <label>Why are you here? <textarea name="why_here" required maxlength="500">${escapeHtml(u.why_here)}</textarea></label>
          <label>What are you into right now? <textarea name="into_now" required maxlength="500">${escapeHtml(u.into_now)}</textarea></label>
          <label>Ask them something. <textarea name="ask_them" required maxlength="500">${escapeHtml(u.ask_them)}</textarea></label>
          <p id="you-err" class="error" hidden></p>
          <button class="btn primary" type="submit">save</button>
        </form>
      </section>
      <section class="settings-block">
        <h2>stack</h2>
        <div class="settings-card">
          <label class="toggle">quiet mode (pause the stack)
            <span class="switch">
              <input type="checkbox" id="quiet-toggle" ${u.quiet_mode ? "checked" : ""} />
              <span class="knob"></span>
            </span>
          </label>
        </div>
        <p class="settings-note">quiet hides you from home. threads you already have stay.</p>
      </section>
      <section class="settings-block">
        <h2>notifications</h2>
        <div class="settings-card">
          <button class="btn" type="button" id="enable-push">enable in-app alerts</button>
        </div>
        <p class="settings-note">Replies and answers show up on the bell at the top of the screen.</p>
      </section>
      <section class="settings-block">
        <h2>account</h2>
        <p class="settings-email">${escapeHtml(u.email || "")}</p>
        <div class="row-btns">
          <button class="btn ghost" type="button" id="logout">log out</button>
          <button class="btn danger ghost" type="button" id="delete-account">delete account</button>
        </div>
        <p class="settings-note">Delete permanently wipes your profile, messages, Q&amp;A, and bookmarks.</p>
      </section>
      <section class="settings-block">
        <h2>more</h2>
        <div class="settings-card">
          <button class="btn" type="button" id="export-data">export my data (JSON)</button>
        </div>
        <p class="fine"><a href="#/terms">terms</a> · <a href="#/privacy">privacy</a></p>
      </section>
    </div>`);
    applyUserAppearance(u);
    (async () => {
      const box = document.getElementById("bookmarks-box");
      if (box) {
        try {
          const data = await api("/api/bookmarks");
          const items = data.bookmarks || [];
          box.innerHTML = items.length
            ? items
                .map(
                  (b) => `<div class="bookmark-row" data-id="${escapeHtml(b.id)}">
              <div class="meta"><strong>${escapeHtml(substanceLabel(b.ask_them, 60) || "bookmark")}</strong>${escapeHtml(clip(b.why_here, 90))}</div>
              <button type="button" class="btn ghost sm" data-unbm="${escapeHtml(b.id)}">remove</button>
            </div>`,
                )
                .join("")
            : `<p class="hint">no bookmarks yet. save someone from the ⋮ menu on home.</p>`;
          box.querySelectorAll("[data-unbm]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const id = btn.getAttribute("data-unbm");
              try {
                await api("/api/bookmarks/" + encodeURIComponent(id), { method: "DELETE" });
                showToast("removed");
                const row = btn.closest(".bookmark-row"); if (row) row.remove();
                if (!box.querySelector(".bookmark-row")) box.innerHTML = `<p class="hint">no bookmarks yet</p>`;
              } catch (err) {
                alert(err.message);
              }
            });
          });
        } catch (err) {
          box.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
        }
      }
      const bbox = document.getElementById("blocks-box");
      if (bbox) {
        try {
          const data = await api("/api/blocks");
          const items = data.blocks || [];
          bbox.innerHTML = items.length
            ? items
                .map(
                  (b) => `<div class="block-row" data-id="${escapeHtml(b.id)}">
              <div class="meta"><strong>${escapeHtml(substanceLabel(b.ask_them, 60) || "blocked")}</strong>${escapeHtml(clip(b.why_here, 90))}</div>
              <button type="button" class="btn ghost sm" data-unblock="${escapeHtml(b.id)}">unblock</button>
            </div>`,
                )
                .join("")
            : `<p class="hint">nobody blocked</p>`;
          bbox.querySelectorAll("[data-unblock]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const id = btn.getAttribute("data-unblock");
              try {
                await api("/api/blocks/" + encodeURIComponent(id), { method: "DELETE" });
                showToast("unblocked");
                const row = btn.closest(".block-row"); if (row) row.remove();
                if (!bbox.querySelector(".block-row")) bbox.innerHTML = `<p class="hint">nobody blocked</p>`;
              } catch (err) {
                alert(err.message);
              }
            });
          });
        } catch (err) {
          bbox.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
        }
      }
    })();
    const delBtn = document.getElementById("delete-account");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        const ok = confirm("Delete your eez account permanently? This cannot be undone.");
        if (!ok) return;
        const again = prompt('Type DELETE to confirm');
        if (again !== "DELETE") {
          showToast("cancelled");
          return;
        }
        try {
          await api("/api/me", { method: "DELETE" });
          state.me = null;
          applyUserAppearance(null);
          closeRealtime("inbox");
          closeRealtime("thread");
          updateInboxBadgeFrom([]);
          showToast("account deleted");
          location.hash = "#/";
        } catch (err) {
          alert(err.message);
        }
      });
    }
    const pushBtn = document.getElementById("enable-push");
    if (pushBtn) {
      pushBtn.addEventListener("click", async () => {
        try {
          await enablePush();
          showToast("push on");
        } catch (err) {
          alert(err.message || "push unavailable");
        }
      });
    }
    const quiet = document.getElementById("quiet-toggle");
    if (quiet) {
      quiet.addEventListener("change", async () => {
        try {
          const data = await api("/api/me", {
            method: "PATCH",
            body: JSON.stringify({ quiet_mode: quiet.checked }),
          });
          state.me = data.user;
          showToast(quiet.checked ? "paused" : "visible");
        } catch (ex) {
          quiet.checked = !quiet.checked;
          alert(ex.message);
        }
      });
    }
    const exportBtn = document.getElementById("export-data");
    if (exportBtn) {
      exportBtn.addEventListener("click", async () => {
        try {
          const data = await api("/api/me/export");
          const blob = new Blob([JSON.stringify(data.export || {}, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "eez-export.json";
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          showToast("exported");
        } catch (err) {
          alert(err.message || "export failed");
        }
      });
    }
    document.getElementById("you-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const err = document.getElementById("you-err");
      try {
        const data = await api("/api/me", {
          method: "PATCH",
          body: JSON.stringify({
            why_here: fd.get("why_here"),
            into_now: fd.get("into_now"),
            ask_them: fd.get("ask_them"),
            quiet_mode: quiet ? quiet.checked : Boolean(u.quiet_mode),
          }),
        });
        state.me = data.user;
        err.hidden = true;
        showToast("saved");
      } catch (ex) {
        err.hidden = false;
        err.textContent = ex.message;
      }
    });
    document.getElementById("logout").addEventListener("click", async () => {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      state.me = null;
      closeRealtime("inbox");
      closeRealtime("thread");
      updateInboxBadgeFrom([]);
      location.hash = "#/";
    });
  }

  function authForm(kind) {
    const registerFields =
      kind === "register"
        ? `<label>Why are you here? <textarea name="why_here" required maxlength="500"></textarea></label>
           <label>What are you into right now? <textarea name="into_now" required maxlength="500"></textarea></label>
           <label>Ask them something. <textarea name="ask_them" required maxlength="500"></textarea></label>`
        : "";
    return `
      <h1>${kind === "register" ? "create account" : "log in"}</h1>
      <form id="auth-form" class="form">
        <label>email <input name="email" type="email" autocomplete="username" required /></label>
        <label>password <input name="password" type="password" autocomplete="${kind === "register" ? "new-password" : "current-password"}" required minlength="8" /></label>
        ${registerFields}
        <p id="auth-err" class="error" hidden></p>
        <button class="btn primary" type="submit">${kind === "register" ? "create" : "log in"}</button>
      </form>
      <p class="fine">${
        kind === "register"
          ? `<a href="#/login">log in</a> · <a href="#/terms">terms</a> · <a href="#/privacy">privacy</a>`
          : `<a href="#/register">create an account</a>`
      }</p>`;
  }

  async function renderLogin() {
    setNav("you");
    app.innerHTML = authForm("login");
    bindAuth("login");
  }

  async function renderRegister() {
    setNav("you");
    app.innerHTML = authForm("register");
    bindAuth("register");
  }

  function bindAuth(kind) {
    document.getElementById("auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const err = document.getElementById("auth-err");
      const payload = { email: fd.get("email"), password: fd.get("password") };
      if (kind === "register") {
        payload.why_here = fd.get("why_here");
        payload.into_now = fd.get("into_now");
        payload.ask_them = fd.get("ask_them");
      }
      try {
        const data = await api(kind === "register" ? "/api/auth/register" : "/api/auth/login", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        state.me = data.user;
        if (state.pendingAnswer) {
          const pending = state.pendingAnswer;
          state.pendingAnswer = null;
          await sendAnswer(pending.id, pending.body);
        } else {
          location.hash = "#/you";
        }
      } catch (ex) {
        err.hidden = false;
        err.textContent = ex.message;
      }
    });
  }

  async function render() {
    scrubLegacyTopChrome();
    const g = ++renderGen;
    try {
      const r = route();
      // Drop thread socket when leaving a conversation view
      if (!(r.parts[0] === "messages" && r.parts[1])) closeRealtime("thread");
      ensureInboxRealtime();
      if (r.parts[0] === "qa") return await renderQa(g);
      if (r.parts[0] === "messages" && r.parts[1]) return await renderThread(r.parts[1], g);
      if (r.parts[0] === "messages") return await renderMessages(g);
      if (r.parts[0] === "you") return await renderYou(g);
      if (r.parts[0] === "settings") return await renderSettings();
      if (r.parts[0] === "login") return await renderLogin();
      if (r.parts[0] === "register") return await renderRegister();
      if (r.parts[0] === "terms") return renderLegal("terms");
      if (r.parts[0] === "privacy") return renderLegal("privacy");
      return await renderHome(g);
    } catch (err) {
      if (stale(g)) return;
      renderError(err.message);
    }
  }

  window.addEventListener("hashchange", () => {
    render();
  });

  window.addEventListener("keydown", (e) => {
    if (route().parts.length) return;
    if (!document.body.classList.contains("page-home")) return;
    const slide = document.getElementById("slide");
    if (slide && slide.classList.contains("answering")) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      if (!state.card) return;
      e.preventDefault();
      pushHistory(state.card);
      dismiss("ul", () => skip(state.card.id));
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      if (state.history.length) goBack();
      else if (state.card) {
        pushHistory(state.card);
        dismiss("ul", () => skip(state.card.id));
      }
    }
  });

  // desktop wheel / trackpad: opposite diagonal energy
  let wheelLock = false;
  window.addEventListener(
    "wheel",
    (e) => {
      if (!document.body.classList.contains("page-home")) return;
      if (route().parts.length) return;
      const slide = document.getElementById("slide");
      if (!slide || slide.classList.contains("answering")) return;
      if (Math.abs(e.deltaX) < 8 && Math.abs(e.deltaY) < 8) return;
      if (wheelLock) return;
      // left / up-ish → dismiss; right / down-ish → back
      const forward = e.deltaX < -18 || (Math.abs(e.deltaX) < 10 && e.deltaY < -28);
      const backward = e.deltaX > 18 || (Math.abs(e.deltaX) < 10 && e.deltaY > 28);
      if (!forward && !backward) return;
      e.preventDefault();
      wheelLock = true;
      setTimeout(() => {
        wheelLock = false;
      }, 420);
      if (forward && state.card) {
        pushHistory(state.card);
        dismiss("ul", () => skip(state.card.id));
      } else if (backward) {
        if (state.history.length) goBack();
      }
    },
    { passive: false },
  );


  function renderLegal(kind) {
    setNav("you");
    const isTerms = kind === "terms";
    const title = isTerms ? "terms of use" : "privacy";
    const body = isTerms
      ? `<p>eez is a connection app built around short written answers, not photos or display names. By using eez you agree to these terms.</p>
         <p><strong>Be decent.</strong> No harassment, scams, illegal activity, or attempts to out someone’s private identity. We may remove accounts that draw repeated reports (automatically at 20 distinct reporters) or that break these rules.</p>
         <p><strong>Accounts.</strong> You are responsible for your login and what you post. Messages and answers you send are visible to the people involved. Public Q&amp;A is visible to anyone using the app.</p>
         <p><strong>Availability.</strong> eez is provided as-is. Features may change. We may suspend access to protect the community or the service.</p>
         <p><strong>Contact.</strong> Questions about these terms: hello@bjvfi.com.</p>`
      : `<p>eez stores the minimum needed to run a sparse connection app, in a private data repository on GitHub.</p>
         <p><strong>What we store.</strong> Email and password hash for login; your three profile answers; messages and conversation metadata; optional per-you chat titles; skips/blocks/reports; public Q&amp;A (and optional images you upload); in-app alert records; last-activity timestamps.</p>
         <p><strong>What we don’t emphasize.</strong> No required photos or real names. Internal handles exist only for account plumbing and are not shown on cards.</p>
         <p><strong>Sharing.</strong> We don’t sell your data. Content is shown to other users as the product requires (stack cards, threads, public Q&amp;A). Storage runs on GitHub infrastructure.</p>
         <p><strong>Retention.</strong> You can delete your account from settings (or ask us). Unanswered threads may fade from the initiator after five days. Reports may trigger automatic account deletion at 20 distinct reporters.</p>
         <p><strong>Contact.</strong> privacy@bjvfi.com / hello@bjvfi.com.</p>`;
    app.innerHTML = fadeWrap(`<div class="settings legal-page">
      <div class="page-head"><h1>${title}</h1></div>
      <section class="settings-block legal-copy">${body}
        <p class="fine"><a href="#/you">back to you</a> · <a href="#/${isTerms ? "privacy" : "terms"}">${isTerms ? "privacy" : "terms"}</a></p>
      </section>
    </div>`);
  }

  // GitHub port: browser push is replaced by in-app alerts (the bell).
  async function enablePush() {
    try {
      localStorage.setItem("eez_alerts_on", "1");
    } catch {}
    showToast("alerts on");
    return true;
  }

  async function disablePush() {
    try {
      localStorage.setItem("eez_alerts_on", "0");
    } catch {}
    showToast("alerts off");
    return true;
  }

  async function shareEez() {
    const url = SHARE_URL;
    const payload = { title: "eez", text: "sparse answers. meet people by what they write.", url };
    if (navigator.share) {
      try {
        await navigator.share(payload);
        showToast("shared");
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast("link copied");
    } catch {
      prompt("Copy this link", url);
    }
  }

  function openShareSheet() {
    const sheet = document.getElementById("share-sheet");
    if (sheet) sheet.hidden = false;
  }

  /* ---- in-app alerts (replaces browser push) ---- */
  let alertsTimer = null;
  let lastFeedSeen = 0;
  try { lastFeedSeen = Number(localStorage.getItem(LS_FEED_READ) || 0); } catch { lastFeedSeen = 0; }

  async function refreshAlerts() {
    const btn = document.getElementById("alerts-btn");
    if (!btn) return;
    const on = Boolean(state.me);
    btn.hidden = !on;
    if (!on) return;
    try {
      const data = await api("/api/feed");
      const events = data.events || [];
      const unread = events.filter((e) => e.created_at > lastFeedSeen).length;
      btn.classList.toggle("has-unread", unread > 0);
      const dot = document.getElementById("alerts-dot");
      if (dot) dot.hidden = unread === 0;
      renderAlertsPanel(events);
    } catch {
      /* keep last known state */
    }
  }

  function renderAlertsPanel(events) {
    const list = document.getElementById("alerts-list");
    if (!list) return;
    if (!events.length) {
      list.innerHTML = '<p class="hint">nothing yet</p>';
      return;
    }
    list.innerHTML = events
      .map((e) => {
        const href = e.kind === "answer" ? "#/qa" : e.ref_id ? "#/messages/" + encodeURIComponent(e.ref_id) : "#/messages";
        return `<a class="alert-row" href="${href}"><span class="alert-kind">${escapeHtml(e.kind)}</span><span class="alert-sum">${escapeHtml(e.summary)}</span><span class="alert-time">${escapeHtml(formatRel(e.created_at))}</span></a>`;
      })
      .join("");
  }

  function markAlertsRead() {
    lastFeedSeen = Date.now();
    try { localStorage.setItem(LS_FEED_READ, String(lastFeedSeen)); } catch { /* ignore */ }
    const btn = document.getElementById("alerts-btn");
    if (btn) btn.classList.remove("has-unread");
    const dot = document.getElementById("alerts-dot");
    if (dot) dot.hidden = true;
  }

  function setupAlerts() {
    const btn = document.getElementById("alerts-btn");
    const panel = document.getElementById("alerts-panel");
    if (btn && panel) {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        panel.hidden = !panel.hidden;
        if (!panel.hidden) refreshAlerts();
      });
      document.addEventListener("click", (ev) => {
        if (!panel.hidden && !panel.contains(ev.target) && !btn.contains(ev.target)) panel.hidden = true;
      });
    }
    const clear = document.getElementById("alerts-clear");
    if (clear) clear.addEventListener("click", markAlertsRead);
    if (alertsTimer) clearInterval(alertsTimer);
    // GitHub port: poll the alerts feed every 60s instead of push.
    alertsTimer = setInterval(() => {
      if (state.me) refreshAlerts();
    }, 60000);
  }

  function setupShareNudge() {
    const brand = document.getElementById("brand-share") || document.querySelector(".brand-word");
    const sheet = document.getElementById("share-sheet");
    const nativeBtn = document.getElementById("share-native");
    const copyBtn = document.getElementById("share-copy");
    const dismissBtn = document.getElementById("share-dismiss");
    if (brand) {
      brand.addEventListener("click", (e) => {
        e.preventDefault();
        openShareSheet();
      });
    }
    if (nativeBtn) nativeBtn.addEventListener("click", async () => {
      if (sheet) sheet.hidden = true;
      await shareEez();
      try { localStorage.setItem(SHARE_KEY, String(Date.now())); } catch { /* ignore */ }
    });
    if (copyBtn) copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(SHARE_URL);
        showToast("link copied");
      } catch {
        prompt("Copy this link", SHARE_URL);
      }
      if (sheet) sheet.hidden = true;
      try { localStorage.setItem(SHARE_KEY, String(Date.now())); } catch { /* ignore */ }
    });
    if (dismissBtn) dismissBtn.addEventListener("click", () => {
      if (sheet) sheet.hidden = true;
      try { localStorage.setItem(SHARE_KEY, String(Date.now())); } catch { /* ignore */ }
    });

    // Auto-nudge every 2 days
    setTimeout(() => {
      try {
        const last = Number(localStorage.getItem(SHARE_KEY) || 0);
        if (!last || Date.now() - last >= TWO_DAYS) openShareSheet();
      } catch { /* ignore */ }
    }, 60_000);
  }

  function setupInstallPrompt() {
    const sheet = document.getElementById("install-sheet");
    const accept = document.getElementById("install-accept");
    const dismiss = document.getElementById("install-dismiss");
    if (!sheet || !accept || !dismiss) return;

    const hide = () => { sheet.hidden = true; };
    const show = () => {
      if (isStandalone()) return;
      // don't stack on top of share sheet
      const share = document.getElementById("share-sheet");
      if (share && !share.hidden) return;
      sheet.hidden = false;
    };

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      state.deferredInstall = e;
    });

    accept.addEventListener("click", async () => {
      hide();
      try { localStorage.setItem(INSTALL_KEY, String(Date.now())); } catch { /* ignore */ }
      if (state.deferredInstall) {
        try {
          state.deferredInstall.prompt();
          await state.deferredInstall.userChoice;
        } catch { /* ignore */ }
        state.deferredInstall = null;
      } else {
        showToast("Use your browser’s Add to Home Screen");
      }
    });
    dismiss.addEventListener("click", () => {
      hide();
      try { localStorage.setItem(INSTALL_KEY, String(Date.now())); } catch { /* ignore */ }
    });

    // Softened: once after settle, then at most every 2 days (not every 5 min)
    setTimeout(() => {
      if (isStandalone()) return;
      try {
        const last = Number(localStorage.getItem(INSTALL_KEY) || 0);
        if (!last || Date.now() - last >= TWO_DAYS) show();
      } catch {
        show();
      }
    }, 90_000);
  }

  // GitHub port: presence is local/imprecise; no heartbeat is written to GitHub.
  function setupPresencePing() {}

  // GitHub port: no service worker in this build.
  function setupServiceWorker() {}

  scrubLegacyTopChrome();
  initTheme();
  setupShareNudge();
  setupAlerts();
  setupInstallPrompt();
  setupPresencePing();
  setupServiceWorker();
  // Keep scrubbing once more after first paint in case anything reinjects.
  requestAnimationFrame(() => scrubLegacyTopChrome());
  setTimeout(scrubLegacyTopChrome, 0);
  refreshMe()
    .then(() => {
      if (state.me && state.me.stack_sort) saveStackSort(state.me.stack_sort);
      applyUserAppearance(state.me);
      ensureInboxRealtime();
      refreshAlerts();
      return refreshInboxBadge();
    })
    .catch(() => {})
    .finally(render);
})();
