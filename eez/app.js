(() => {
  const app = document.getElementById("app");
  const modal = document.getElementById("modal");
  const modalForm = document.getElementById("modal-form");
  const modalCancel = document.getElementById("modal-cancel");
  const toastEl = document.getElementById("toast");

  const INSTALL_KEY = "eez_install_dismissed_at";
  const SHARE_KEY = "eez_share_nudge_at";
  const SAFETY_KEY = "eez_safety_tip_seen";
  const SHARE_URL = "https://bjvfi.com/eez";
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

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
    toastTimer: null,
    guestKey: loadGuestKey(),
    deferredInstall: null,
    deckIdx: 0,
    deckQs: [],
    projIdx: 0,
    projList: [],
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
    "--modal", "--unread", "--red", "--bubble-theirs", "--bubble-mine", "--fade-well", "--sep",
    "--soft-inset", "--well-focus", "--chip", "--chip-strong", "--chip-soft", "--chip-faint",
    "--chip-ghost", "--composer-bg", "--skel", "--skel-shine", "--modal-scrim"];

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
      "--bubble-mine": dark
        ? "color-mix(in srgb, var(--accent-soft) 30%, #2a2624)"
        : "color-mix(in srgb, var(--accent-soft) 35%, #fffaf4)",
      "--fade-well": dark
        ? "linear-gradient(165deg, rgba(255, 255, 255, 0.075) 0%, rgba(255, 255, 255, 0.03) 100%)"
        : "linear-gradient(165deg, " + hexAlpha(ink, 0.07) + " 0%, " + hexAlpha(ink, 0.03) + " 100%)",
      "--sep": "linear-gradient(90deg, transparent, " + hexAlpha(ink, 0.1) + " 18%, " + hexAlpha(ink, 0.1) + " 82%, transparent)",
      "--soft-inset": dark ? "inset 0 1px 0 rgba(255, 255, 255, 0.06)" : "inset 0 1px 0 rgba(255, 255, 255, 0.55)",
      "--well-focus": hexAlpha(ink, dark ? 0.09 : 0.08),
      "--chip": hexAlpha(ink, dark ? 0.08 : 0.06),
      "--chip-strong": hexAlpha(ink, dark ? 0.14 : 0.12),
      "--chip-soft": hexAlpha(ink, 0.06),
      "--chip-faint": hexAlpha(ink, 0.05),
      "--chip-ghost": hexAlpha(ink, 0.045),
      "--composer-bg": dark ? "#000000" : "linear-gradient(to top, " + hexAlpha(bg, 0.94) + " 55%, transparent)",
      "--skel": hexAlpha(ink, 0.07),
      "--skel-shine": dark ? "rgba(255, 255, 255, 0.1)" : "rgba(255, 255, 255, 0.45)",
      "--modal-scrim": dark
        ? "radial-gradient(circle at 50% 70%, rgba(0, 0, 0, 0.38), rgba(0, 0, 0, 0.64))"
        : "radial-gradient(circle at 50% 70%, " + hexAlpha(ink, 0.18) + ", " + hexAlpha(ink, 0.42) + ")",
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
  function applyUitheme(name, custom, opts) {
    const preview = !!(opts && opts.preview);
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
      if (preview) return; // draft preview: paint only, persist on save
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
  function themeSavedState(persist) {
    const u = persist ? state.me : null;
    return {
      preset: persist ? (u.theme_preset || "") : storedUitheme(),
      custom: { ...(persist ? parsePackedCustom(u.theme_custom || "") : storedUithemeCustom()) },
    };
  }
  function themeDraftEqual(a, b) {
    return (a.preset || "") === (b.preset || "") &&
      a.custom.bg === b.custom.bg && a.custom.accent === b.custom.accent && a.custom.text === b.custom.text;
  }
  async function commitUitheme(persist, draft) {
    const t = UITHEMES.includes(draft.preset) ? draft.preset : "";
    applyUitheme(t, draft.custom);
    if (!persist || !state.me) return;
    try {
      const patch = { theme_preset: t };
      if (t === "custom") patch.theme_custom = packCustom(draft.custom);
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
  function bindUithemeControls(persist) {
    const saved = themeSavedState(persist);
    const draft = { preset: saved.preset, custom: { ...saved.custom } };
    const saveBtn = document.getElementById("theme-save");
    const syncUI = () => {
      document.querySelectorAll("#theme-picks .theme-pick").forEach((b) =>
        b.classList.toggle("on", b.getAttribute("data-uitheme") === draft.preset));
      const cust = document.getElementById("theme-custom-on");
      if (cust) cust.hidden = draft.preset !== "custom";
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      setVal("theme-bg-color", draft.custom.bg);
      setVal("theme-accent-color", draft.custom.accent);
      setVal("theme-text-color", draft.custom.text);
      if (saveBtn) saveBtn.disabled = themeDraftEqual(draft, saved);
    };
    const previewDraft = () => {
      applyUitheme(draft.preset, draft.custom, { preview: true });
      syncUI();
    };
    document.querySelectorAll("#theme-picks .theme-pick").forEach((btn) => {
      btn.addEventListener("click", () => {
        draft.preset = btn.getAttribute("data-uitheme");
        previewDraft();
      });
    });
    [["theme-bg-color", "bg"], ["theme-accent-color", "accent"], ["theme-text-color", "text"]].forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => {
        draft.custom[key] = validHex(el.value) || draft.custom[key];
        draft.preset = "custom";
        previewDraft();
      });
    });
    const td = document.getElementById("theme-default");
    if (td) {
      td.addEventListener("click", () => {
        draft.preset = "";
        draft.custom = { ...CUSTOM_DEFAULTS };
        previewDraft();
      });
    }
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        try {
          await commitUitheme(persist, draft);
          saved.preset = draft.preset;
          saved.custom = { ...draft.custom };
          showToast("theme saved");
        } catch (err) {
          showToast("couldn't save");
        }
        syncUI();
      });
    }
    syncUI();
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
  var projTitle = '';
  if(c.project_id){
    try{
      var pjAll = ((await ghGetJson('projects.json', true)) || {data: []}).data;
      var pr0 = pjAll.find(function(x){ return x.id === c.project_id; });
      if(pr0 && pr0.body) projTitle = 'project: ' + clip(String(pr0.body).replace(/\s+/g, ' ').trim(), 44);
    }catch(e){ /* ignore */ }
  }
  var weeklyTitle = '';
  if(c.weekly && c.weekly.markers){
    var mm = c.weekly.markers || {};
    var mineM = mm[me.id] || '';
    var peerM = '';
    Object.keys(mm).forEach(function(k){ if(k !== me.id && !peerM) peerM = mm[k]; });
    if(mineM && peerM) weeklyTitle = mineM.split('-').join(' ') + ' ⇄ ' + peerM.split('-').join(' ');
    else weeklyTitle = 'weekly chat';
  }
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
    project_title: projTitle,
    weekly_title: weeklyTitle,
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
/* ---------- weekly: deterministic client-side math (no server) ---------- */
function hashStr(s){
  var h = 0x811c9dc5;
  s = String(s);
  for(var i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function currentWeekId(d){
  d = d || new Date();
  var t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  var day = new Date(t).getUTCDay();
  var monday = t - ((day + 6) % 7) * 864e5;
  return "w" + Math.floor(monday / 6048e5);
}
var WEEKLY_K = 8;
var WEEKLY_COLORS = ["teal", "amber", "coral", "sage", "plum", "sky", "clay", "moss"];
var WEEKLY_SHAPES = ["circle", "square", "triangle", "diamond", "hexagon", "star", "wave", "cross"];
function cohortOf(identity, weekId){
  return hashStr(String(identity) + "|" + weekId) % WEEKLY_K;
}
function markerFor(identity, weekId){
  var c = WEEKLY_COLORS[hashStr(String(identity) + "|" + weekId + "|c") % WEEKLY_COLORS.length];
  var s = WEEKLY_SHAPES[hashStr(String(identity) + "|" + weekId + "|s") % WEEKLY_SHAPES.length];
  return c + "-" + s;
}
var WEEKLY_FALLBACK_PROMPTS = [
  "what did you make this week that surprised you?",
  "what is something small you got better at this week?",
  "what are you working on that nobody knows about yet?",
  "what did you learn the hard way this week?",
  "what is one thing you would do again exactly the same?",
  "what took longer than it should have, and why?"
];

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
      if(typeof patch.theme_custom === 'string'){
        var tc = patch.theme_custom.trim();
        var parts = tc.split(',');
        var okPacked = parts.length === 3 && parts.every(function(x){ return /^#[0-9a-fA-F]{6}$/.test(x.trim()); });
        if(/^#[0-9a-fA-F]{6}$/.test(tc) || okPacked) t.theme_custom = okPacked ? parts.map(function(x){ return x.trim(); }).join(',') : tc;
      }
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
    await mutateJson('weekly_shares.json', function(b){ return b.filter(function(x){ return x.author_id !== uid; }); }, 'eez: delete account');
    await mutateJson('weekly_comments.json', function(b){ return b.filter(function(x){ return x.author_id !== uid; }); }, 'eez: delete account');
    await mutateJson('projects.json', function(b){ return b.filter(function(x){ return x.author_id !== uid; }); }, 'eez: delete account');
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
        .map(function(a){
          var mine = (meQ && a.author_id === meQ.id) || (a.guest_key && a.guest_key === guestKey());
          return {id: a.id, body: a.body, mine: !!mine, parent_id: a.parent_id || null};
        });
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
    var parentIdA = String((json||{}).parent_id || '') || null;
    var qsA = (await ghGetJson('questions.json', true) || {data: []}).data;
    var qa = qsA.find(function(x){ return x.id === qidA; });
    if(!qa) throw bad('question gone', 404);
    var gkA = meA ? '' : guestKey();
    await mutateJson('answers.json', function(an){
      if(!parentIdA){
        // one top-level answer per person per question — edit it instead of posting again
        var dup = an.some(function(x){
          return x.question_id === qidA && !x.parent_id &&
            (meA ? x.author_id === meA.id : (x.guest_key && x.guest_key === gkA));
        });
        if(dup) throw bad('you already answered this. edit your answer instead', 409);
      }else{
        var parent = an.find(function(x){ return x.id === parentIdA && x.question_id === qidA; });
        if(!parent) throw bad('that answer is gone', 404);
        if(parent.parent_id) throw bad('replies go one level deep', 400);
      }
      an.push({id: newId(), question_id: qidA, parent_id: parentIdA, author_id: meA ? meA.id : null, guest_key: gkA, guest_name: '', body: abody, created_at: nowS()});
    }, 'eez: answer');
    if(qa.author_id) feedPush(qa.author_id, 'answer', 'someone answered your question', qidA);
    if(meA) await touchSeen(meA);
    return {};
  }
  var ansEditM = /^\/api\/answers\/([^/]+)$/.exec(p);
  if(ansEditM && method === 'PATCH'){
    var sessE = loadSession();
    var meE = sessE ? await findUserById(sessE.uid) : null;
    var ebody = String((json||{}).body || '').trim();
    if(!ebody) throw bad('write something first');
    if(ebody.length > 1000) throw bad('keep it under 1000 characters');
    var aidE = ansEditM[1];
    await mutateJson('answers.json', function(an){
      var tgt = an.find(function(x){ return x.id === aidE; });
      if(!tgt) throw bad('answer gone', 404);
      var own = meE ? (tgt.author_id === meE.id) : (tgt.guest_key && tgt.guest_key === guestKey());
      if(!own) throw bad('not yours', 403);
      tgt.body = ebody;
    }, 'eez: edit answer');
    if(meE) await touchSeen(meE);
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

  /* ----- weekly ----- */
  if(p === '/api/weekly' && method === 'GET'){
    var sessWl = loadSession();
    var meWl = sessWl ? await findUserById(sessWl.uid) : null;
    var identWl = meWl ? meWl.id : guestKey();
    var weekId = currentWeekId();
    var cohort = cohortOf(identWl, weekId);
    var marker = markerFor(identWl, weekId);
    // lazy expiry: prune stale weeks, writing only when something is stale
    var shRaw = await ghGetJson('weekly_shares.json', true);
    var cmRaw = await ghGetJson('weekly_comments.json', true);
    var shAll = (shRaw && shRaw.data) || [];
    var cmAll = (cmRaw && cmRaw.data) || [];
    if(shAll.some(function(s){ return s.week_id !== weekId; }))
      await mutateJson('weekly_shares.json', function(arr){ return arr.filter(function(s){ return s.week_id === weekId; }); }, 'eez: weekly prune');
    if(cmAll.some(function(c){ return c.week_id !== weekId; }))
      await mutateJson('weekly_comments.json', function(arr){ return arr.filter(function(c){ return c.week_id === weekId; }); }, 'eez: weekly prune');
    shAll = shAll.filter(function(s){ return s.week_id === weekId; });
    cmAll = cmAll.filter(function(c){ return c.week_id === weekId; });
    var prompts = ((await ghGetJson('prompts.json', true)) || {data: []}).data || [];
    if(!prompts.length) prompts = WEEKLY_FALLBACK_PROMPTS.map(function(t, i){ return {id: 'fb' + i, text: t}; });
    var prompt = prompts[hashStr(weekId + '|cohort|' + cohort) % prompts.length];
    var mineShare = shAll.find(function(s){
      return s.cohort === cohort && (meWl ? s.author_id === meWl.id : (s.guest_key && s.guest_key === identWl));
    });
    var hasShared = !!mineShare;
    var shares = [];
    if(hasShared){
      shares = shAll.filter(function(s){ return s.cohort === cohort; })
        .sort(function(a, b){ return a.created_at - b.created_at; })
        .map(function(s){
          var smine = meWl ? s.author_id === meWl.id : (s.guest_key && s.guest_key === identWl);
          var comms = cmAll.filter(function(c){ return c.share_id === s.id; })
            .sort(function(a, b){ return a.created_at - b.created_at; })
            .map(function(c){
              var cmine = meWl ? c.author_id === meWl.id : (c.guest_key && c.guest_key === identWl);
              return {id: c.id, marker: c.marker, body: c.body, mine: !!cmine, created_at: s2ms(c.created_at)};
            });
          return {id: s.id, marker: s.marker, body: s.body, mine: !!smine, created_at: s2ms(s.created_at), comments: comms};
        });
    }
    return {week_id: weekId, cohort: cohort, marker: marker, prompt: {id: prompt.id, text: prompt.text}, has_shared: hasShared, shares: shares};
  }
  if(p === '/api/weekly/shares' && method === 'POST'){
    var sessWs = loadSession();
    var meWs = sessWs ? await findUserById(sessWs.uid) : null;
    var identWs = meWs ? meWs.id : guestKey();
    var weekIdWs = currentWeekId();
    var cohortWs = cohortOf(identWs, weekIdWs);
    var markerWs = markerFor(identWs, weekIdWs);
    var wbody = String((json || {}).body || '').trim();
    if(!wbody) throw bad('write something first');
    if(wbody.length > 1000) throw bad('keep it under 1000 characters');
    var createdWs;
    await mutateJson('weekly_shares.json', function(arr){
      var dup = arr.some(function(s){
        return s.week_id === weekIdWs && (meWs ? s.author_id === meWs.id : (s.guest_key && s.guest_key === identWs));
      });
      if(dup) throw bad('you already shared this week', 409);
      createdWs = {id: newId(), week_id: weekIdWs, cohort: cohortWs,
        author_id: meWs ? meWs.id : null, guest_key: meWs ? '' : identWs,
        marker: markerWs, body: wbody, created_at: nowS()};
      arr.push(createdWs);
    }, 'eez: weekly share');
    if(meWs) await touchSeen(meWs);
    return {share: {id: createdWs.id, marker: createdWs.marker}};
  }
  if(p === '/api/weekly/comments' && method === 'POST'){
    var sessWc = loadSession();
    var meWc = sessWc ? await findUserById(sessWc.uid) : null;
    var identWc = meWc ? meWc.id : guestKey();
    var weekIdWc = currentWeekId();
    var cohortWc = cohortOf(identWc, weekIdWc);
    var cbody = String((json || {}).body || '').trim();
    if(!cbody) throw bad('write something first');
    if(cbody.length > 1000) throw bad('keep it under 1000 characters');
    var shareIdWc = String((json || {}).share_id || '');
    var sharesWc = ((await ghGetJson('weekly_shares.json', true)) || {data: []}).data;
    var targetWc = sharesWc.find(function(s){ return s.id === shareIdWc && s.week_id === weekIdWc && s.cohort === cohortWc; });
    if(!targetWc) throw bad('that share is gone', 404);
    var ownWc = sharesWc.some(function(s){
      return s.week_id === weekIdWc && s.cohort === cohortWc &&
        (meWc ? s.author_id === meWc.id : (s.guest_key && s.guest_key === identWc));
    });
    if(!ownWc) throw bad('share yours first to join in', 403);
    var markerWc = markerFor(identWc, weekIdWc);
    var createdWc;
    await mutateJson('weekly_comments.json', function(arr){
      createdWc = {id: newId(), share_id: shareIdWc, week_id: weekIdWc,
        author_id: meWc ? meWc.id : null, guest_key: meWc ? '' : identWc,
        marker: markerWc, body: cbody, created_at: nowS()};
      arr.push(createdWc);
    }, 'eez: weekly comment');
    if(meWc) await touchSeen(meWc);
    return {comment: {id: createdWc.id, marker: createdWc.marker}};
  }

  /* ----- projects ----- */
  function projMine(x, me, ident){
    return me ? x.author_id === me.id : (x.guest_key && x.guest_key === ident);
  }
  if(p === '/api/projects' && method === 'GET'){
    var sessP = loadSession();
    var meP = sessP ? await findUserById(sessP.uid) : null;
    var identP = meP ? meP.id : guestKey();
    var projs = ((await ghGetJson('projects.json', true)) || {data: []}).data;
    var list = projs
      .filter(function(x){ return !x.closed || projMine(x, meP, identP); })
      .sort(function(a, b){ return b.created_at - a.created_at; })
      .slice(0, 200)
      .map(function(x){
        return {id: x.id, body: x.body, mine: !!projMine(x, meP, identP), closed: !!x.closed, created_at: s2ms(x.created_at)};
      });
    return {projects: list};
  }
  if(p === '/api/projects' && method === 'POST'){
    var sessPp = loadSession();
    var mePp = sessPp ? await findUserById(sessPp.uid) : null;
    var pbody = String((json || {}).body || '').trim();
    if(!pbody) throw bad('write something first');
    if(pbody.length > 1000) throw bad('keep it under 1000 characters');
    var createdPp;
    await mutateJson('projects.json', function(arr){
      createdPp = {id: newId(), author_id: mePp ? mePp.id : null, guest_key: mePp ? '' : guestKey(),
        body: pbody, created_at: nowS(), closed: 0};
      arr.push(createdPp);
    }, 'eez: new project');
    if(mePp) await touchSeen(mePp);
    return {project: {id: createdPp.id}};
  }
  var projM = /^\/api\/projects\/([^/]+)$/.exec(p);
  if(projM && (method === 'PATCH' || method === 'DELETE')){
    var sessPe = loadSession();
    var mePe = sessPe ? await findUserById(sessPe.uid) : null;
    var identPe = mePe ? mePe.id : guestKey();
    var pidPe = projM[1];
    var pj = json || {};
    await mutateJson('projects.json', function(arr){
      var tgt = arr.find(function(x){ return x.id === pidPe; });
      if(!tgt) throw bad('project gone', 404);
      if(!projMine(tgt, mePe, identPe)) throw bad('not yours', 403);
      if(method === 'DELETE') return arr.filter(function(x){ return x.id !== pidPe; });
      if(typeof pj.body === 'string'){
        var nb = pj.body.trim();
        if(!nb) throw bad('write something first');
        if(nb.length > 1000) throw bad('keep it under 1000 characters');
        tgt.body = nb;
      }
      if(typeof pj.closed === 'boolean') tgt.closed = pj.closed ? 1 : 0;
    }, 'eez: update project');
    if(mePe) await touchSeen(mePe);
    return {};
  }

  /* ----- conversations from weekly / projects (share openConversation) ----- */
  async function openConversation(me, recipId, fbody, extras){
    var other = await findUserById(recipId);
    if(!other) throw bad('person not found', 404);
    var ts = nowS(), cid;
    var convosOc = await getConvos();
    var existing = convosOc.find(function(c){
      return (c.initiator_id === me.id && c.recipient_id === recipId) || (c.initiator_id === recipId && c.recipient_id === me.id);
    });
    if(existing){
      cid = existing.id;
    }else{
      cid = newId();
      await mutateJson('conversations.json', function(cs){
        var rec = {id: cid, initiator_id: me.id, recipient_id: recipId, created_at: ts, last_activity_at: ts, hidden_from_initiator: 0, bump_sent_at: 0};
        if(extras && extras.project_id) rec.project_id = extras.project_id;
        if(extras && extras.weekly) rec.weekly = extras.weekly;
        cs.push(rec);
      }, 'eez: new conversation');
    }
    var firstMsg = {id: newId(), conversation_id: cid, sender_id: me.id, body: fbody, kind: 'user', created_at: ts};
    await mutateJson('messages.json', function(ms){ ms.push(firstMsg); }, 'eez: first message');
    await mutateJson('conversations.json', function(cs){
      var c = cs.find(function(x){ return x.id === cid; });
      if(c) c.last_activity_at = ts;
    }, 'eez: touch convo');
    await mutateJson('conversation_prefs.json', function(ps){
      var mp = ps.find(function(x){ return x.user_id === me.id && x.conversation_id === cid; });
      if(!mp) ps.push({user_id: me.id, conversation_id: cid, title: '', muted: 0, read_receipts: 1, last_read_at: ts});
      else mp.last_read_at = ts;
    }, 'eez: mark read');
    await touchSeen(me);
    return cid;
  }
  if(p === '/api/conversations/from-card' && method === 'POST'){
    var meF = await requireMe();
    var recip = String((json || {}).recipient_id || '');
    var fbody = String((json || {}).body || '').trim();
    if(!recip || recip === meF.id) throw bad('invalid recipient');
    if(!fbody) throw bad('write something first');
    if(fbody.length > 2000) throw bad('keep it under 2000 characters');
    var cid = await openConversation(meF, recip, fbody, null);
    feedPush(recip, 'message', 'someone answered your card', cid);
    return {conversation_id: cid};
  }
  if(p === '/api/conversations/from-weekly' && method === 'POST'){
    var meFw = await requireMe();
    var shareIdFw = String((json || {}).share_id || '');
    var fbodyFw = String((json || {}).body || '').trim();
    if(!fbodyFw) throw bad('write something first');
    if(fbodyFw.length > 2000) throw bad('keep it under 2000 characters');
    var weekIdFw = currentWeekId();
    var cohortFw = cohortOf(meFw.id, weekIdFw);
    var sharesFw = ((await ghGetJson('weekly_shares.json', true)) || {data: []}).data;
    var shFw = sharesFw.find(function(s){ return s.id === shareIdFw && s.week_id === weekIdFw && s.cohort === cohortFw; });
    if(!shFw) throw bad('that share is gone', 404);
    var peerFw = shFw.author_id || null;
    if(!peerFw) throw bad('they need an account before you can message', 403);
    if(peerFw === meFw.id) throw bad('that is your own share');
    var markersFw = {};
    markersFw[meFw.id] = markerFor(meFw.id, weekIdFw);
    markersFw[peerFw] = shFw.marker || markerFor(peerFw, weekIdFw);
    var cidFw = await openConversation(meFw, peerFw, fbodyFw,
      {weekly: {week_id: weekIdFw, cohort: cohortFw, markers: markersFw}});
    feedPush(peerFw, 'message', 'someone messaged you from weekly', cidFw);
    return {conversation_id: cidFw};
  }
  if(p === '/api/conversations/from-project' && method === 'POST'){
    var meFp = await requireMe();
    var pidFp = String((json || {}).project_id || '');
    var fbodyFp = String((json || {}).body || '').trim();
    if(!fbodyFp) throw bad('write something first');
    if(fbodyFp.length > 2000) throw bad('keep it under 2000 characters');
    var projsFp = ((await ghGetJson('projects.json', true)) || {data: []}).data;
    var prFp = projsFp.find(function(x){ return x.id === pidFp && !x.closed; });
    if(!prFp) throw bad('that project is gone', 404);
    var ownerFp = prFp.author_id || null;
    if(!ownerFp) throw bad('they need an account before you can message', 403);
    if(ownerFp === meFp.id) throw bad('that is your own project');
    var cidFp = await openConversation(meFp, ownerFp, fbodyFp, {project_id: pidFp});
    feedPush(ownerFp, 'message', 'someone messaged you about your project', cidFp);
    return {conversation_id: cidFp};
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
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  async function requireLogin() {
    if (state.me) return true;
    showModal();
    return false;
  }

  /* ---------- Q&A deck: home is one question at a time (no swipe stack, no feed) ---------- */
  function askPanelHtml() {
    if (!state.me) {
      return `<section class="ask-guest ask-sticky">
           <p class="hint"><a href="#/login">log in</a> to ask. Anyone can answer, no names.</p>
         </section>`;
    }
    return `<section class="ask-panel ask-sticky" aria-label="ask a question">
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
         </section>`;
  }

  function bindAskForm(rerender) {
    const askForm = document.getElementById("ask-form");
    if (!askForm) return;
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
        rerender();
      } catch (err) {
        alert(err.message);
        if (postBtn) {
          postBtn.disabled = false;
          postBtn.textContent = "post";
        }
      }
    });
  }

  function qCardHtml(q) {
    const kindLabel = q.kind === "poll" ? "poll" : q.kind === "image" ? "image" : "question";
    const media =
      q.image_url
        ? `<div class="q-media"><img src="${escapeHtml(q.image_url)}" alt="" loading="lazy" /></div>`
        : "";
    const poll = (q.kind === "poll" || (q.options && q.options.length)) ? pollHtml(q) : "";
    const allAns = q.answers || [];
    const tops = allAns.filter((a) => !a.parent_id);
    const repliesBy = {};
    allAns.filter((a) => a.parent_id).forEach((r) => {
      (repliesBy[r.parent_id] = repliesBy[r.parent_id] || []).push(r);
    });
    const myTop = tops.find((a) => a.mine);
    const ansActions = (a, isReply) => {
      const edit = a.mine
        ? `<button type="button" class="linklike" data-ans-edit="${escapeHtml(a.id)}">edit</button>`
        : "";
      // reply control shows only on other people's answers, never your own
      const rep = !isReply && !a.mine
        ? `<button type="button" class="linklike" data-ans-reply="${escapeHtml(a.id)}">reply</button>`
        : "";
      return edit || rep ? `<div class="ans-actions">${edit}${rep}</div>` : "";
    };
    const answers = tops
      .map((a) => {
        const reps = (repliesBy[a.id] || [])
          .map(
            (r) => `<div class="q-answer q-reply" data-answer="${escapeHtml(r.id)}">
              <div class="q-answer-body">${escapeHtml(r.body)}</div>
              ${ansActions(r, true)}
            </div>`,
          )
          .join("");
        return `<div class="q-answer" data-answer="${escapeHtml(a.id)}">
              <div class="q-answer-body">${escapeHtml(a.body)}</div>
              ${ansActions(a, false)}
              ${reps ? `<div class="q-replies">${reps}</div>` : ""}
            </div>`;
      })
      .join("");
    const reply =
      q.kind === "poll" || myTop
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
    return `<article class="q-card" data-qid="${escapeHtml(q.id)}">
          <div class="q-meta">${kindLabel}</div>
          <div class="q-body">${escapeHtml(q.body)}</div>
          ${media}
          ${poll}
          ${answersBlock}
          ${reply}
        </article>`;
  }

  function bindQuestionCard(root, rerender) {
    root.querySelectorAll(".poll").forEach((pollEl) => {
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
            rerender();
          } catch (err) {
            pollEl.classList.remove("posting-pending");
            alert(err.message);
          }
        });
      });
    });

    root.querySelectorAll(".ans-form").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        try {
          await api(`/api/questions/${form.getAttribute("data-qid")}/answers`, {
            method: "POST",
            body: JSON.stringify({ body: fd.get("body") }),
          });
          showToast("saved");
          rerender();
        } catch (err) {
          alert(err.message);
        }
      });
    });

    // edit my own answer inline
    root.querySelectorAll("[data-ans-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const box = btn.closest("[data-answer]");
        const bodyEl = box ? box.querySelector(":scope > .q-answer-body") : null;
        const actionsEl = btn.closest(".ans-actions");
        if (!box || !bodyEl || box.querySelector(".ans-edit-form")) return;
        const form = document.createElement("form");
        form.className = "ans-edit-form";
        form.innerHTML = `<textarea required maxlength="1000" rows="3"></textarea>
          <div class="row-btns"><button class="btn sm primary" type="submit">save</button>
          <button class="btn sm ghost" type="button" data-cancel>cancel</button></div>`;
        form.querySelector("textarea").value = bodyEl.textContent;
        bodyEl.hidden = true;
        if (actionsEl) actionsEl.hidden = true;
        box.insertBefore(form, bodyEl);
        form.querySelector("[data-cancel]").addEventListener("click", () => {
          form.remove();
          bodyEl.hidden = false;
          if (actionsEl) actionsEl.hidden = false;
        });
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          try {
            await api(`/api/answers/${btn.getAttribute("data-ans-edit")}`, {
              method: "PATCH",
              body: JSON.stringify({ body: form.querySelector("textarea").value }),
            });
            showToast("saved");
            rerender();
          } catch (err) {
            alert(err.message);
          }
        });
      });
    });

    // reply to someone else's answer (one level deep)
    root.querySelectorAll("[data-ans-reply]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const box = btn.closest("[data-answer]");
        if (!box) return;
        const existing = box.querySelector(":scope > .ans-reply-form");
        if (existing) {
          existing.remove();
          return;
        }
        const card = btn.closest(".q-card");
        const qid = card ? card.getAttribute("data-qid") : "";
        const aid = btn.getAttribute("data-ans-reply");
        const form = document.createElement("form");
        form.className = "ans-reply-form";
        form.innerHTML = `<textarea required maxlength="1000" rows="2" placeholder="reply…"></textarea>
          <div class="row-btns"><button class="btn sm primary" type="submit">reply</button></div>`;
        box.appendChild(form);
        form.querySelector("textarea").focus();
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          try {
            await api(`/api/questions/${qid}/answers`, {
              method: "POST",
              body: JSON.stringify({ body: form.querySelector("textarea").value, parent_id: aid }),
            });
            showToast("saved");
            rerender();
          } catch (err) {
            alert(err.message);
          }
        });
      });
    });
  }

  function showDeckCard() {
    const box = document.getElementById("deck");
    if (!box) return;
    const qs = state.deckQs || [];
    if (!qs.length) {
      box.innerHTML = `<div class="state-block"><p class="empty-lead">quiet so far</p><p class="empty-sub">ask something, or check back when the room has a pulse.</p></div>`;
      return;
    }
    if (state.deckIdx < 0) state.deckIdx = 0;
    if (state.deckIdx >= qs.length) state.deckIdx = qs.length - 1;
    const q = qs[state.deckIdx];
    const atFirst = state.deckIdx === 0;
    const atLast = state.deckIdx === qs.length - 1;
    box.innerHTML = `${qCardHtml(q)}
      <div class="deck-pager">
        <button type="button" class="btn ghost sm" id="deck-prev"${atFirst ? " disabled" : ""}>prev</button>
        <span class="deck-count">${state.deckIdx + 1} of ${qs.length}</span>
        <button type="button" class="btn ghost sm" id="deck-next"${atLast ? " disabled" : ""}>next</button>
      </div>`;
    bindQuestionCard(box, () => renderHome());
    const prev = document.getElementById("deck-prev");
    const next = document.getElementById("deck-next");
    if (prev) prev.addEventListener("click", () => { if (state.deckIdx > 0) { state.deckIdx--; showDeckCard(); } });
    if (next) next.addEventListener("click", () => { if (state.deckIdx < (state.deckQs || []).length - 1) { state.deckIdx++; showDeckCard(); } });
  }

  async function renderHome(g) {
    setNav("home");
    app.innerHTML = fadeWrap(`<div class="qa-page deck-page">
      <h1>q&amp;a</h1>
      ${askPanelHtml()}
      <div class="deck" id="deck" aria-live="polite">
        <div class="skel skel-title"></div>
        <div class="skel skel-line"></div>
        <div class="skel skel-line w80"></div>
        <div class="skel skel-line w60"></div>
      </div>
    </div>`);
    bindAskForm(() => renderHome());
    let data;
    try {
      data = await api("/api/questions");
    } catch (err) {
      if (stale(g)) return;
      renderError(err.message);
      return;
    }
    if (stale(g)) return;
    state.deckQs = data.questions || [];
    if (state.deckIdx >= state.deckQs.length) state.deckIdx = 0;
    showDeckCard();
  }

  /* ---------- weekly: one prompt, one cohort, anonymous markers, ephemeral ---------- */
  function markerChipHtml(marker, shareId, isMine) {
    const label = String(marker || "").split("-").join(" ");
    if (isMine) return `<span class="marker-chip">${escapeHtml(label)}</span>`;
    return `<button type="button" class="marker-chip" data-weekly-msg="${escapeHtml(shareId)}">${escapeHtml(label)}</button>`;
  }

  function weeklyShareHtml(s) {
    const comments = (s.comments || [])
      .map(
        (c) => `<div class="w-comment${c.mine ? " mine" : ""}">
          ${markerChipHtml(c.marker, s.id, c.mine)}
          <div class="w-comment-body">${escapeHtml(c.body)}</div>
        </div>`,
      )
      .join("");
    return `<article class="w-share${s.mine ? " mine" : ""}" data-share="${escapeHtml(s.id)}">
      ${markerChipHtml(s.marker, s.id, s.mine)}
      <div class="w-share-body">${escapeHtml(s.body)}</div>
      ${comments ? `<div class="w-comments">${comments}</div>` : ""}
      <form class="w-comment-form" data-share="${escapeHtml(s.id)}">
        <label class="sr-only" for="wc-${escapeHtml(s.id)}">comment</label>
        <textarea id="wc-${escapeHtml(s.id)}" name="body" required maxlength="1000" placeholder="comment…" rows="2"></textarea>
        <button class="btn sm" type="submit">comment</button>
      </form>
      <div class="w-msgbox" hidden>
        <form class="w-msg-form" data-share="${escapeHtml(s.id)}">
          <p class="hint">message this person. opens a 1:1 thread</p>
          <label class="sr-only" for="wm-${escapeHtml(s.id)}">message</label>
          <textarea id="wm-${escapeHtml(s.id)}" name="body" required maxlength="2000" rows="2" placeholder="say hi…"></textarea>
          <div class="row-btns"><button class="btn sm primary" type="submit">send</button></div>
        </form>
      </div>
    </article>`;
  }

  async function renderWeekly(g) {
    setNav("weekly");
    app.innerHTML = fadeWrap(`<div class="weekly-page">
      <div class="page-head"><h1>weekly</h1></div>
      <div class="skel skel-title"></div>
      <div class="skel skel-line"></div>
      <div class="skel skel-line w80"></div>
    </div>`);
    let data;
    try {
      data = await api("/api/weekly");
    } catch (err) {
      if (stale(g)) return;
      renderError(err.message);
      return;
    }
    if (stale(g)) return;
    const prompt = data.prompt || {};
    const locked = !data.has_shared;
    const shares = data.shares || [];
    app.innerHTML = fadeWrap(`<div class="weekly-page">
      <div class="page-head"><h1>weekly</h1></div>
      <article class="q-card prompt-card">
        <div class="q-meta">this week</div>
        <div class="q-body">${escapeHtml(prompt.text || "what did you get into this week?")}</div>
      </article>
      ${
        locked
          ? `<form class="w-compose" id="w-compose">
               <p class="hint">share what you did to unlock everyone else's shares. the week wipes clean after.</p>
               <label class="sr-only" for="w-body">your share</label>
               <textarea id="w-body" name="body" required maxlength="1000" rows="4" placeholder="share what you did…"></textarea>
               <div><button class="btn primary" type="submit">share</button></div>
             </form>`
          : shares.length
            ? `<div class="w-shares">${shares.map(weeklyShareHtml).join("")}</div>`
            : `<div class="state-block"><p class="empty-lead">you’re first</p><p class="empty-sub">your share is in. others land here as they post.</p></div>`
      }
    </div>`);

    const comp = document.getElementById("w-compose");
    if (comp) {
      comp.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = comp.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try {
          await api("/api/weekly/shares", {
            method: "POST",
            body: JSON.stringify({ body: comp.querySelector("textarea").value }),
          });
          showToast("shared");
          renderWeekly();
        } catch (err) {
          alert(err.message);
          if (btn) btn.disabled = false;
        }
      });
    }

    app.querySelectorAll(".w-comment-form").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await api("/api/weekly/comments", {
            method: "POST",
            body: JSON.stringify({ share_id: form.getAttribute("data-share"), body: form.querySelector("textarea").value }),
          });
          showToast("saved");
          renderWeekly();
        } catch (err) {
          alert(err.message);
        }
      });
    });

    // tapping a marker opens a 1:1 thread with that share's author
    app.querySelectorAll(".marker-chip[data-weekly-msg]").forEach((chip) => {
      chip.addEventListener("click", async () => {
        if (!(await requireLogin())) return;
        const art = chip.closest("[data-share]");
        const box = art ? art.querySelector(".w-msgbox") : null;
        if (!box) return;
        const wasHidden = box.hidden;
        app.querySelectorAll(".w-msgbox").forEach((b) => { b.hidden = true; });
        box.hidden = !wasHidden;
        if (!box.hidden) {
          const ta = box.querySelector("textarea");
          if (ta) ta.focus();
        }
      });
    });

    app.querySelectorAll(".w-msg-form").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try {
          const res = await api("/api/conversations/from-weekly", {
            method: "POST",
            body: JSON.stringify({ share_id: form.getAttribute("data-share"), body: form.querySelector("textarea").value }),
          });
          location.hash = "#/messages/" + res.conversation_id;
        } catch (err) {
          alert(err.message);
          if (btn) btn.disabled = false;
        }
      });
    });
  }

  /* ---------- projects: one card at a time ---------- */
  function projCardHtml(p) {
    const mine = !!p.mine;
    const chip = p.closed ? `<span class="proj-closed">closed</span>` : "";
    const owner = mine
      ? `<div class="ans-actions proj-owner">
           <button type="button" class="linklike" data-proj-edit="${escapeHtml(p.id)}">edit</button>
           <button type="button" class="linklike" data-proj-toggle="${escapeHtml(p.id)}">${p.closed ? "reopen" : "close"}</button>
           <button type="button" class="linklike" data-proj-del="${escapeHtml(p.id)}">delete</button>
         </div>`
      : "";
    const msg = mine
      ? ""
      : `<div class="proj-msg-row"><button type="button" class="btn sm" data-proj-msg="${escapeHtml(p.id)}">message</button></div>`;
    return `<article class="proj-card${mine ? " mine" : ""}" data-proj="${escapeHtml(p.id)}">
      <div class="q-meta">project ${chip}</div>
      <div class="q-body proj-body">${escapeHtml(p.body)}</div>
      ${owner}
      ${msg}
      <div class="w-msgbox" hidden>
        <form class="proj-msg-form" data-proj="${escapeHtml(p.id)}">
          <p class="hint">message the owner. opens a 1:1 thread</p>
          <label class="sr-only" for="pm-${escapeHtml(p.id)}">message</label>
          <textarea id="pm-${escapeHtml(p.id)}" name="body" required maxlength="2000" rows="2" placeholder="say hi…"></textarea>
          <div class="row-btns"><button class="btn sm primary" type="submit">send</button></div>
        </form>
      </div>
    </article>`;
  }

  function showProjCard() {
    const box = document.getElementById("proj-deck");
    if (!box) return;
    const ps = state.projList || [];
    if (!ps.length) {
      box.innerHTML = `<div class="state-block"><p class="empty-lead">no projects yet</p><p class="empty-sub">post what you’re working on. someone might want in.</p></div>`;
      return;
    }
    if (state.projIdx < 0) state.projIdx = 0;
    if (state.projIdx >= ps.length) state.projIdx = ps.length - 1;
    const p = ps[state.projIdx];
    const atFirst = state.projIdx === 0;
    const atLast = state.projIdx === ps.length - 1;
    box.innerHTML = `${projCardHtml(p)}
      <div class="deck-pager">
        <button type="button" class="btn ghost sm" id="proj-prev"${atFirst ? " disabled" : ""}>prev</button>
        <span class="deck-count">${state.projIdx + 1} of ${ps.length}</span>
        <button type="button" class="btn ghost sm" id="proj-next"${atLast ? " disabled" : ""}>next</button>
      </div>`;
    const prev = document.getElementById("proj-prev");
    const next = document.getElementById("proj-next");
    if (prev) prev.addEventListener("click", () => { if (state.projIdx > 0) { state.projIdx--; showProjCard(); } });
    if (next) next.addEventListener("click", () => { if (state.projIdx < (state.projList || []).length - 1) { state.projIdx++; showProjCard(); } });

    box.querySelectorAll("[data-proj-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const card = btn.closest("[data-proj]");
        const bodyEl = card ? card.querySelector(".proj-body") : null;
        if (!card || !bodyEl || card.querySelector(".proj-edit-form")) return;
        const form = document.createElement("form");
        form.className = "proj-edit-form";
        form.innerHTML = `<textarea required maxlength="1000" rows="4"></textarea>
          <div class="row-btns"><button class="btn sm primary" type="submit">save</button>
          <button class="btn sm ghost" type="button" data-cancel>cancel</button></div>`;
        form.querySelector("textarea").value = bodyEl.textContent;
        bodyEl.hidden = true;
        card.insertBefore(form, bodyEl);
        form.querySelector("[data-cancel]").addEventListener("click", () => { form.remove(); bodyEl.hidden = false; });
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          try {
            await api(`/api/projects/${btn.getAttribute("data-proj-edit")}`, {
              method: "PATCH",
              body: JSON.stringify({ body: form.querySelector("textarea").value }),
            });
            showToast("saved");
            renderProjects();
          } catch (err) { alert(err.message); }
        });
      });
    });
    box.querySelectorAll("[data-proj-toggle]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/projects/${btn.getAttribute("data-proj-toggle")}`, {
            method: "PATCH",
            body: JSON.stringify({ closed: !ps[state.projIdx].closed }),
          });
          showToast("saved");
          renderProjects();
        } catch (err) { alert(err.message); }
      });
    });
    box.querySelectorAll("[data-proj-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!window.confirm("delete this project?")) return;
        try {
          await api(`/api/projects/${btn.getAttribute("data-proj-del")}`, { method: "DELETE" });
          showToast("deleted");
          state.projIdx = 0;
          renderProjects();
        } catch (err) { alert(err.message); }
      });
    });
    box.querySelectorAll("[data-proj-msg]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!(await requireLogin())) return;
        const card = btn.closest("[data-proj]");
        const msgbox = card ? card.querySelector(".w-msgbox") : null;
        if (!msgbox) return;
        msgbox.hidden = !msgbox.hidden;
        if (!msgbox.hidden) {
          const ta = msgbox.querySelector("textarea");
          if (ta) ta.focus();
        }
      });
    });
    box.querySelectorAll(".proj-msg-form").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try {
          const res = await api("/api/conversations/from-project", {
            method: "POST",
            body: JSON.stringify({ project_id: form.getAttribute("data-proj"), body: form.querySelector("textarea").value }),
          });
          location.hash = "#/messages/" + res.conversation_id;
        } catch (err) {
          alert(err.message);
          if (btn) btn.disabled = false;
        }
      });
    });
  }

  async function renderProjects(g) {
    setNav("projects");
    app.innerHTML = fadeWrap(`<div class="projects-page">
      <div class="page-head"><h1>projects</h1></div>
      <form class="proj-form" id="proj-form">
        <p class="ask-prompt">Post a project</p>
        <label>what you’re working on
          <textarea name="working" required maxlength="500" rows="2" placeholder="what are you working on?"></textarea>
        </label>
        <label>what you could use help with
          <textarea name="help" required maxlength="500" rows="2" placeholder="what could use a hand?"></textarea>
        </label>
        <div><button class="btn primary" type="submit">post</button></div>
      </form>
      <div class="deck" id="proj-deck" aria-live="polite">
        <div class="skel skel-title"></div>
        <div class="skel skel-line"></div>
        <div class="skel skel-line w80"></div>
      </div>
    </div>`);
    const form = document.getElementById("proj-form");
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try {
          const fd = new FormData(form);
          const working = String(fd.get("working") || "").trim();
          const help = String(fd.get("help") || "").trim();
          if (!working || !help) throw new Error("fill in both fields");
          await api("/api/projects", {
            method: "POST",
            body: JSON.stringify({ body: "working on: " + working + "\ncould use help with: " + help }),
          });
          showToast("posted");
          state.projIdx = 0;
          renderProjects();
        } catch (err) {
          alert(err.message);
          if (btn) btn.disabled = false;
        }
      });
    }
    let data;
    try {
      data = await api("/api/projects");
    } catch (err) {
      if (stale(g)) return;
      renderError(err.message);
      return;
    }
    if (stale(g)) return;
    state.projList = data.projects || [];
    if (state.projIdx >= state.projList.length) state.projIdx = 0;
    showProjCard();
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

  function convoLabel(c) {
    const custom = (c.custom_title || "").trim();
    if (custom) return clip(custom, 48);
    if (c.project_title) return clip(c.project_title, 48);
    if (c.weekly_title) return clip(c.weekly_title, 48);
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
      <section class="settings-group">
        <h2>look</h2>
        <div class="settings-sub">
          <h3>appearance</h3>
          <p class="settings-note">theme — recolors the whole app${persist ? "" : " (this device until you log in)"}</p>
          <div class="theme-picks" id="theme-picks">${uithemePicksHtml(currentPreset)}</div>
          ${themeCustomHtml(customVals)}
          <div class="row-btns theme-save-row">
            <button type="button" class="btn primary sm" id="theme-save" disabled>save theme</button>
          </div>
        </div>
      </section>
      ${persist ? `<section class="settings-group">
        <h2>lists</h2>
        <div class="settings-sub">
          <h3>bookmarks</h3>
          <div id="bookmarks-box" class="bookmark-list"><p class="hint">loading…</p></div>
        </div>
        <div class="settings-sub">
          <h3>blocked</h3>
          <div id="blocks-box" class="block-list"><p class="hint">loading…</p></div>
        </div>
      </section>
      <section class="settings-group">
        <h2>activity</h2>
        <div class="settings-sub">
          <h3>stack</h3>
          <div class="settings-card">
            <label class="toggle">quiet mode (pause the stack)
              <span class="switch">
                <input type="checkbox" id="quiet-toggle" ${u.quiet_mode ? "checked" : ""} />
                <span class="knob"></span>
              </span>
            </label>
          </div>
          <p class="settings-note">quiet hides you from home. threads you already have stay.</p>
        </div>
        <div class="settings-sub">
          <h3>notifications</h3>
          <div class="settings-card">
            <button class="btn" type="button" id="enable-push">enable in-app alerts</button>
          </div>
          <p class="settings-note">Replies and answers show up on the bell at the top of the screen.</p>
        </div>
      </section>
      <section class="settings-group">
        <h2>account</h2>
        <div class="settings-sub">
          <p class="settings-email">${escapeHtml(u.email || "")}</p>
          <div class="row-btns">
            <button class="btn ghost" type="button" id="logout">log out</button>
            <button class="btn danger ghost" type="button" id="delete-account">delete account</button>
          </div>
          <p class="settings-note">Delete permanently wipes your profile, messages, Q&amp;A, and bookmarks.</p>
        </div>
        <div class="settings-sub">
          <h3>your data</h3>
          <div class="settings-card">
            <button class="btn" type="button" id="export-data">export my data (JSON)</button>
          </div>
        </div>
      </section>` : `<section class="settings-group">
        <h2>account</h2>
        <div class="settings-sub">
          <p class="hint">log in to sync your look across devices.</p>
          <div class="row-btns">
            <a class="btn primary" href="#/login">log in</a>
            <a class="btn" href="#/register">create an account</a>
          </div>
        </div>
      </section>`}
      <section class="settings-group">
        <h2>about</h2>
        <div class="settings-sub">
          <p class="fine"><a href="#/terms">terms</a> · <a href="#/privacy">privacy</a></p>
        </div>
      </section>
    </div>`);
    bindUithemeControls(persist);
    if (persist) bindSettingsSections();
    applyUserAppearance(u);
  }

  /* bookmarks, blocks, quiet mode, push, account, and export live in settings now. */
  function bindSettingsSections() {
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
    const logoutBtn = document.getElementById("logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        await api("/api/auth/logout", { method: "POST", body: "{}" });
        state.me = null;
        closeRealtime("inbox");
        closeRealtime("thread");
        updateInboxBadgeFrom([]);
        location.hash = "#/";
      });
    }
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
        <h2>profile</h2>
        <form id="you-form" class="form">
          <label>Why are you here? <textarea name="why_here" required maxlength="500">${escapeHtml(u.why_here)}</textarea></label>
          <label>What are you into right now? <textarea name="into_now" required maxlength="500">${escapeHtml(u.into_now)}</textarea></label>
          <label>Ask them something. <textarea name="ask_them" required maxlength="500">${escapeHtml(u.ask_them)}</textarea></label>
          <p id="you-err" class="error" hidden></p>
          <button class="btn primary" type="submit">save</button>
        </form>
      </section>
    </div>`);
    applyUserAppearance(u);
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
        location.hash = "#/you";
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
      if (r.parts[0] === "qa") { location.hash = "#/"; return; }
      if (r.parts[0] === "weekly") return await renderWeekly(g);
      if (r.parts[0] === "projects") return await renderProjects(g);
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
        const href = e.kind === "answer" ? "#/" : e.ref_id ? "#/messages/" + encodeURIComponent(e.ref_id) : "#/messages";
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
      applyUserAppearance(state.me);
      ensureInboxRealtime();
      refreshAlerts();
      return refreshInboxBadge();
    })
    .catch(() => {})
    .finally(render);
})();
