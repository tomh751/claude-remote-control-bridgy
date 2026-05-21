// Bridgy — mobile PWA client.
//
// (Markdown renderer lives lower in this file — see _renderMarkdown.)

// Asset version that this PWA tab is running. Set by /runtime-config.js
// (loaded with `defer` BEFORE app.js, so the global is populated by the
// time this module executes). The server derives the value from the
// mtime of the on-disk static files in `_VERSIONED_FILES`, so this
// constant always equals what the bridge would put in the next hello
// frame — no manual bumping per build, and no possibility of drift
// between a running bridge and stale on-disk files.
// We surface mismatch (live bridge restarted with new files since this
// tab opened) as a "tap to reload" banner so the user can refresh.
const CRC_ASSET_VERSION = (typeof window !== 'undefined' && window.CRC_ASSET_VERSION) || 'unknown';
try { console.log('[CRC] client asset_version=' + CRC_ASSET_VERSION); } catch {}

// ─── Visual-viewport diagnostics ──────────────────────────────────────
//
// Body geometry is no longer JS-driven. We use
// `interactive-widget=resizes-content` (see index.html) so iOS shrinks
// the layout viewport natively when the soft keyboard opens, and
// `body { height: 100dvh }` tracks the shrunken viewport automatically.
// No --app-h or --app-top CSS vars; no `position: fixed` shenanigans.
//
// This module is now purely diagnostic — it mounts the debug HUD when
// the in-app "Debug log" toggle is on, so we can still SEE what iOS
// reports during the keyboard animation if a new bug appears.
(function syncVisualViewport() {
  try {
    const root = document.documentElement;
    // Clear any --app-h / --app-top values left over from a previous
    // asset version under the old `resizes-visual` strategy. iOS PWAs
    // can pick up stale inline-style values via service-worker cache
    // continuity, and a stale --app-h would override our new 100dvh.
    root.style.removeProperty('--app-h');
    root.style.removeProperty('--app-top');
    root.style.removeProperty('--app-translate-y');
    const apply = () => {
      // Mirror visualViewport.height into --vv-h so body's CSS height
      // can pick `min(100dvh, var(--vv-h))`. 100dvh under
      // `interactive-widget=resizes-content` already shrinks for the
      // keyboard, but iOS draws the form-input accessory bar
      // (Previous/Next/Done) INSIDE the layout viewport so it covers
      // the composer; visualViewport.height excludes both keyboard
      // and accessory bar, giving us a tighter ceiling.
      const vv = window.visualViewport;
      if (vv && vv.height > 0) {
        root.style.setProperty('--vv-h', vv.height + 'px');
      }
    };
    apply();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', apply, { passive: true });
      window.visualViewport.addEventListener('scroll', apply, { passive: true });
    }
    window.addEventListener('resize', apply, { passive: true });
    window.addEventListener('orientationchange', apply, { passive: true });

    // Window-scroll lock. Body is `position: fixed; inset: 0` and html
    // has overflow:hidden — neither should be scrollable. But iOS's
    // auto-scroll-focused-input-into-view runs at the window level and
    // can still bump window.scrollY > 0, which on a position:fixed
    // body has no effect on body itself but DOES translate any non-
    // fixed root-positioned children (and on some iOS versions, the
    // composited body too) upward. Clamp scrollY back to 0 on any
    // attempt — cheap, idempotent, and silent when not triggered.
    const _clampScroll = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }
    };
    window.addEventListener('scroll', _clampScroll, { passive: true });
    document.addEventListener('focusin', _clampScroll, { passive: true });

    // iOS auto-scroll-into-view shim (Searls trick).
    // When the user taps the composer textarea, iOS Safari runs an
    // internal "scroll focused element into view" pass synchronously
    // on focus. With body `position: fixed; inset: 0` that scroll has
    // no net effect, but during the keyboard rise animation iOS still
    // momentarily slides body DOWN to make room — visible as the
    // topbar disappearing under the status bar and an empty black
    // band appearing above it (user video 2026-05-20 18:41).
    // The fix: on touchstart (which fires BEFORE focus), translateY
    // the textarea -9999px off-screen, then let focus fire on a
    // target Safari can't reach, then restore the transform in the
    // next animation frame. The actual focus succeeds (the element
    // is in the DOM and focusable), but Safari's scroll-into-view
    // calculation can't pin a target rectangle, so the auto-scroll
    // no-ops. Source: https://gist.github.com/searls/d6fd21a57b7c70be12f65beb17bb6149
    // Bind once on the textarea; reapply if the element is re-created
    // (we don't currently re-create it, but defensive).
    const _wireComposerAutoScrollGuard = () => {
      const ta = document.getElementById('input');
      if (!ta || ta.dataset.crcAutoscrollGuard) return;
      ta.dataset.crcAutoscrollGuard = '1';
      // Defensive: clear any translateY(-9999) left over from the
      // 1.0.214 Searls-shim experiment (service-worker cache continuity
      // can carry a stale inline style across version bumps).
      try {
        if (ta.style.transform && ta.style.transform.includes('-9999')) {
          ta.style.transform = '';
        }
      } catch {}
      // NOTE: the preemptive --vv-h shrink on touchstart (1.0.216 /
      // 1.0.217) was REMOVED — it interrupted iOS's touch-to-focus
      // chain. Setting --vv-h synchronously caused a body reflow that
      // (on iPhone 18.7 PWA standalone) blocked the keyboard from
      // appearing on the first tap (user "the first press on the
      // composer doesn't show the keyboard - just empty space",
      // 2026-05-20 21:34). The hero-slide-on-open is the lesser
      // evil — at least typing works. Future approach: shrink on
      // FOCUS (after iOS has committed the tap), not touchstart.
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _wireComposerAutoScrollGuard, { once: true });
    } else {
      _wireComposerAutoScrollGuard();
    }

    // Clear any --tabs-h / --composer-h CSS vars left over from the
    // brief position:fixed restructure attempt (1.0.207-208). Layout
    // is back to body grid (auto auto 1fr auto) so those vars are
    // unused; stale values would no-op but explicit removal is safer.
    document.documentElement.style.removeProperty('--tabs-h');
    document.documentElement.style.removeProperty('--composer-h');

    // The composer focus-class toggle was removed 2026-05-20 21:51 —
    // collapsing the mode-chip row made permission/model/agent/effort
    // pickers inaccessible while typing (user complaint). If a future
    // round needs chat-area-while-typing back, do it via a less
    // destructive change (e.g. tighter padding, not hiding the row).
    // Defensive cleanup of any stale crc-composer-focus class.
    try {
      document.querySelectorAll('.crc-composer-focus').forEach((el) => {
        el.classList.remove('crc-composer-focus');
      });
    } catch {}

    // Debug HUD — visible whenever the in-app "Debug log" toggle is ON
    // (menu → Debug log) or when ?vvdebug=1 is in the URL. Shows the
    // live viewport / scroll / body geometry so we can SEE on a real
    // iPhone what numbers iOS reports during the keyboard-open
    // animation, and pinpoint the mechanism behind the header shift.
    // The HUD auto-mounts on DOMContentLoaded so it picks up the
    // localStorage-restored toggle state without a refresh dance.
    function _mountVVHud() {
      const wantOnFromUrl = new URLSearchParams(location.search).get('vvdebug') === '1';
      let wantOnFromToggle = false;
      try { wantOnFromToggle = (localStorage.getItem('crc.debugLog') === '1'); } catch {}
      const want = wantOnFromUrl || wantOnFromToggle;
      let hud = document.getElementById('vvHud');
      if (!want) {
        if (hud) hud.remove();
        return;
      }
      if (hud) return;
      hud = document.createElement('div');
      hud.id = 'vvHud';
      hud.style.cssText = (
        'position:fixed;top:calc(6px + env(safe-area-inset-top, 0px));right:6px;z-index:99999;' +
        'font:11px/1.3 ui-monospace,Menlo,monospace;' +
        'color:#fff;background:rgba(200,40,40,.92);padding:6px 8px;' +
        'border-radius:6px;pointer-events:none;white-space:pre;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.45);max-width:62vw;'
      );
      document.body.appendChild(hud);
      const tick = () => {
        if (!document.body.contains(hud)) return; // disposed by toggle-off
        const vv = window.visualViewport;
        const tb = document.querySelector('.topbar');
        const tbR = tb ? tb.getBoundingClientRect() : { top: -1 };
        const bR = document.body.getBoundingClientRect();
        hud.textContent = (
          'vv.h=' + (vv ? vv.height.toFixed(0) : '-') +
          ' vv.t=' + (vv ? vv.offsetTop.toFixed(0) : '-') + '\n' +
          'win.h=' + window.innerHeight +
          ' sy=' + window.scrollY + '\n' +
          'body.top=' + bR.top.toFixed(0) +
          ' h=' + bR.height.toFixed(0) + '\n' +
          'topbar.top=' + tbR.top.toFixed(0) + '\n' +
          'tx=' + getComputedStyle(document.documentElement)
            .getPropertyValue('--app-translate-y').trim() + '\n' +
          'active=' + (document.activeElement && document.activeElement.id || '-')
        );
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    // Re-evaluate on each DOMContentLoaded + on focusin (the debug-log
    // toggle fires _crcRenderDebugPanel which would have flipped the
    // flag by then). Cheap to poll.
    window._mountVVHud = _mountVVHud;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _mountVVHud, { once: true });
    } else {
      _mountVVHud();
    }
    setInterval(_mountVVHud, 1000);

  } catch {}
})();

// ─── Crash telemetry ───────────────────────────────────────────────────
//
// iOS Safari can kill the WebContent process under memory pressure with
// no visible browser error and no way to ask the phone what happened.
// To get forensic data we POST a small JSON blob to /api/client-log on:
//   - `error` (uncaught exception)
//   - `unhandledrejection` (unhandled Promise rejection)
//   - `pagehide` (page being unloaded — fires before iOS suspends/kills)
//   - `boot` (one shot from a deferred timer once `State` exists)
// `navigator.sendBeacon` is the right primitive: it ships the bytes even
// when the page is mid-unload, doesn't await a response, and gracefully
// no-ops when the network is unavailable. The endpoint is intentionally
// CSRF-exempt because beacon requests can't carry custom headers, and
// it's diagnostic-only (no side effects).
//
// Breadcrumb buffer: a rolling 20-entry list of recent user/code
// actions. The `pagehide` beacon attaches it so when iOS kills the
// WebContent process we see WHAT the user was doing in the seconds
// before death — much more useful than a bare "page unloaded" event.
const _crcCrumbs = [];
function _crcCrumb(tag, info) {
  try {
    _crcCrumbs.push({
      t: Date.now(),
      tag,
      info: info == null ? '' : (typeof info === 'string' ? info.slice(0, 120) : info),
    });
    if (_crcCrumbs.length > 20) _crcCrumbs.shift();
  } catch {}
}
function _crcBeacon(kind, payload) {
  try {
    // State is declared with `const` further down — referencing it
    // before the declaration runs hits the Temporal Dead Zone and
    // throws a ReferenceError that this try/catch would silently
    // swallow (which is what hid the boot beacon in 1.0.72). Use
    // `try { State } catch {}` to detect TDZ specifically; if State
    // hasn't been initialised yet we just omit those fields.
    let tabsCount = -1;
    let activeTabId = null;
    try {
      if (typeof State === 'object' && State) {
        tabsCount = Array.isArray(State.tabs) ? State.tabs.length : -1;
        activeTabId = State.activeTabId || null;
      }
    } catch {
      // TDZ — State exists but hasn't been initialised. Leave defaults.
    }
    const body = JSON.stringify({
      kind,
      ts: Date.now(),
      v: CRC_ASSET_VERSION,
      url: location.href,
      tabs: tabsCount,
      active: activeTabId,
      heap: (performance && performance.memory) ? {
        used: Math.round(performance.memory.usedJSHeapSize / 1024),
        total: Math.round(performance.memory.totalJSHeapSize / 1024),
        limit: Math.round(performance.memory.jsHeapSizeLimit / 1024),
      } : null,
      // Include the last 20 breadcrumbs on pagehide/error so we can
      // see what the user was doing right before the crash. Other
      // beacons keep it small.
      crumbs: (kind === 'pagehide' || kind === 'error' || kind === 'rejection')
        ? _crcCrumbs.slice() : undefined,
      ua: (kind === 'boot') ? navigator.userAgent.slice(0, 200) : undefined,
      ...payload,
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/client-log', new Blob([body], { type: 'application/json' }));
    } else {
      fetch('/api/client-log', {
        method: 'POST',
        body,
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {});
    }
  } catch {}
}
window.addEventListener('error', (e) => {
  _crcBeacon('error', {
    message: e?.message || String(e),
    src: e?.filename || '',
    line: e?.lineno || 0,
    col: e?.colno || 0,
    stack: (e?.error && e.error.stack) ? String(e.error.stack).slice(0, 800) : '',
  });
});
window.addEventListener('unhandledrejection', (e) => {
  _crcBeacon('rejection', {
    message: (e?.reason && (e.reason.message || String(e.reason))) || 'unknown',
    stack: (e?.reason && e.reason.stack) ? String(e.reason.stack).slice(0, 800) : '',
  });
});
window.addEventListener('pagehide', () => {
  _crcBeacon('pagehide', {});
});
// Defer the boot beacon to a microtask. At module-top `State` is
// inside its `const` TDZ; firing immediately means the beacon body
// generator throws and the catch silently eats it (1.0.72 bug). A
// queued microtask runs after the rest of the module finishes
// executing — by then `State`, `WS`, etc. are all initialised.
queueMicrotask(() => { _crcBeacon('boot', {}); _crcCrumb('boot', ''); });

// In-app debug-log ring buffer. Patches console.{log,info,warn,error}
// at boot so messages are captured into a rolling 200-line buffer
// regardless of whether the overlay is currently visible. Toggling
// "Debug log" in the Menu sheet renders the buffer as a floating panel
// for users who can't attach Safari Web Inspector (Windows laptop).
// Reported 2026-05-16 — user wanted to capture [mic] logs without a Mac.
const _CRC_LOG_BUFFER_CAP = 200;
// Seed the buffer with the asset version so the user can confirm they're
// running fresh code by tapping Copy in the Debug panel. The log line at
// module-top fires BEFORE the console-patching IIFE installs, so it
// wouldn't otherwise land in the buffer.
const _crcLogBuffer = [(function () {
  const ts = new Date();
  const hh = String(ts.getHours()).padStart(2, '0');
  const mm = String(ts.getMinutes()).padStart(2, '0');
  const ss = String(ts.getSeconds()).padStart(2, '0');
  return { t: `${hh}:${mm}:${ss}`, lv: 'log', text: '[CRC] client asset_version=' + CRC_ASSET_VERSION };
})()];
let _crcDebugPanelEl = null;
let _crcDebugPanelEnabled = false;
try {
  _crcDebugPanelEnabled = (localStorage.getItem('crc.debugLog') === '1');
} catch {}
(function _installConsolePatch() {
  const levels = ['log', 'info', 'warn', 'error'];
  for (const lv of levels) {
    const orig = console[lv].bind(console);
    console[lv] = function (...args) {
      try {
        const ts = new Date();
        const hh = String(ts.getHours()).padStart(2, '0');
        const mm = String(ts.getMinutes()).padStart(2, '0');
        const ss = String(ts.getSeconds()).padStart(2, '0');
        const text = args.map((a) => {
          if (a == null) return String(a);
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        _crcLogBuffer.push({ t: `${hh}:${mm}:${ss}`, lv, text });
        if (_crcLogBuffer.length > _CRC_LOG_BUFFER_CAP) {
          _crcLogBuffer.splice(0, _crcLogBuffer.length - _CRC_LOG_BUFFER_CAP);
        }
        if (_crcDebugPanelEnabled) _crcRenderDebugPanel();
      } catch {}
      return orig(...args);
    };
  }
  // Also surface uncaught errors so the user sees them in the panel
  // even when the original stacktrace would only have appeared in
  // Safari Web Inspector.
  try {
    window.addEventListener('error', (e) => {
      try {
        console.error('[uncaught] ' + (e && e.message ? e.message : 'error'),
          e && e.filename ? `${e.filename}:${e.lineno}` : '');
      } catch {}
    });
    window.addEventListener('unhandledrejection', (e) => {
      try {
        const r = e && e.reason;
        console.error('[unhandled-rejection] ' + (r && r.message ? r.message : r));
      } catch {}
    });
  } catch {}
})();

function _crcRenderDebugPanel() {
  if (!_crcDebugPanelEnabled) {
    if (_crcDebugPanelEl) { try { _crcDebugPanelEl.remove(); } catch {} _crcDebugPanelEl = null; }
    return;
  }
  if (!_crcDebugPanelEl) {
    const wrap = document.createElement('div');
    wrap.id = 'crcDebugPanel';
    wrap.style.cssText =
      'position:fixed;left:8px;right:8px;bottom:140px;z-index:9990;' +
      'max-height:30vh;overflow-y:auto;overflow-x:hidden;' +
      'background:rgba(20,16,14,0.92);color:#e9e6e1;' +
      'font:11px/1.35 ui-monospace,SF Mono,Menlo,Consolas,monospace;' +
      'border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
      'padding:6px 8px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.5);' +
      'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
      '-webkit-user-select:text;user-select:text;';
    // Header row with copy + clear buttons.
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:4px;';
    const title = document.createElement('span');
    title.textContent = 'Debug log · v' + CRC_ASSET_VERSION;
    title.style.cssText = 'font-weight:600;color:#0E6E6E;';
    const actions = document.createElement('span');
    actions.style.cssText = 'display:inline-flex;gap:6px;';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.style.cssText = 'font:600 11px/1 inherit;padding:4px 8px;border-radius:6px;background:#0E6E6E;color:#1a1614;border:0;cursor:pointer;';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = _crcLogBuffer.map(l => `${l.t} [${l.lv}] ${l.text}`).join('\n');
      try {
        navigator.clipboard.writeText(text).then(
          () => { try { toast('Debug log copied'); } catch {} },
          () => { try { toast('Copy failed', 'warn'); } catch {} },
        );
      } catch { try { toast('Copy failed', 'warn'); } catch {} }
    });
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.style.cssText = 'font:600 11px/1 inherit;padding:4px 8px;border-radius:6px;background:transparent;color:#e9e6e1;border:1px solid rgba(255,255,255,0.2);cursor:pointer;';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _crcLogBuffer.length = 0;
      _crcRenderDebugPanel();
    });
    actions.append(copyBtn, clearBtn);
    head.append(title, actions);
    const body = document.createElement('div');
    body.id = 'crcDebugPanelBody';
    wrap.append(head, body);
    document.body.appendChild(wrap);
    _crcDebugPanelEl = wrap;
  }
  const body = _crcDebugPanelEl.querySelector('#crcDebugPanelBody');
  if (!body) return;
  // Render last 100 lines (the buffer can hold more, but the panel
  // only shows the tail so older context doesn't crowd the screen).
  const tail = _crcLogBuffer.slice(-100);
  body.innerHTML = tail.map(l => {
    const color = l.lv === 'error' ? '#ff6b6b' : (l.lv === 'warn' ? '#ffb84a' : (l.lv === 'info' ? '#88c1ff' : '#c7bfb6'));
    const safe = String(l.text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return `<div style="color:${color};white-space:pre-wrap;word-break:break-word;margin:2px 0;"><span style="color:#7d7570;">${l.t}</span> ${safe}</div>`;
  }).join('');
  body.scrollTop = body.scrollHeight;
}

function _toggleDebugLog() {
  _crcDebugPanelEnabled = !_crcDebugPanelEnabled;
  try { localStorage.setItem('crc.debugLog', _crcDebugPanelEnabled ? '1' : '0'); } catch {}
  const toggle = document.getElementById('debuglogToggle');
  if (toggle) toggle.setAttribute('aria-checked', _crcDebugPanelEnabled ? 'true' : 'false');
  _crcRenderDebugPanel();
  try { toast(_crcDebugPanelEnabled ? 'Debug log ON — visible above the composer' : 'Debug log OFF'); } catch {}
}

// If the toggle was left ON in localStorage, render the panel as soon as
// the DOM is ready so the user sees recent log lines on app boot. Deferred
// to DOMContentLoaded so document.body exists.
if (_crcDebugPanelEnabled) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { try { _crcRenderDebugPanel(); } catch {} }, { once: true });
  } else {
    try { _crcRenderDebugPanel(); } catch {}
  }
}

// Coarse-grained "is this a touch / mobile device?" check. Used to keep
// the on-screen-keyboard's Enter key from sending — on iOS / Android
// Enter should insert a newline; orange Send is the only way to submit.
// Declared at the top of the file so any module-level code can reference
// it (Chat methods, the keydown handler, etc.).
const IS_MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

// "Should auto-scroll the chat to the latest message when new content
// arrives?" True at boot (no scrollback yet), flipped by the scroll
// listener in wireJumpToBottom based on the user's distance from the
// bottom. Read by Chat.scrollToBottom on every append. `let` so it
// can be re-assigned from the scroll handler; declared at module top
// so it's not in TDZ when Chat methods run during app boot.
let _isFollowingBottom = true;
// Unix-ms deadline for the "force-stick-to-bottom" override. Bumped by
// the jump-to-bottom button and the "New messages" pill so that during
// the few seconds after the user explicitly asks to be at the bottom,
// every subsequent streamed delta auto-scrolls — regardless of the
// 400-px distance threshold below. Without this, a chunky markdown
// table or code block lands wider than the threshold and bounces the
// user back into "follow off" mode, forcing them to re-tap the button
// for every fresh batch of content.
let _stickToBottomUntil = 0;

// ─── Text-to-speech ───────────────────────────────────────────────────
// Read assistant messages aloud via the browser's built-in Web Speech
// API. No API key, no network round-trip, no server load — iOS Safari
// PWAs use the system TTS voices, which cover ~50 languages well
// (English, Hebrew, Russian, Arabic, etc.). The bubble's Speak button
// (added in `Chat._attachMessageActions`) toggles play/stop. Only one
// utterance plays at a time across the whole app — starting a fresh
// utterance cancels any in-flight one and updates the previous
// button's icon back to "play."
// ─── TTS tunables ────────────────────────────────────────────────────
// Pulled out so all the timing knobs live in one place — easier to
// reason about, easier to tweak per-device. All values are ms.
// • USER_SCROLL_QUIET_MS: window after a user wheel/touchmove during
//   which auto-scroll-into-view is suppressed.
// • AUDIO_LAG_MS: shifts every visual paint to match the iOS audio
//   output buffer (boundary events fire ~200 ms before the user
//   actually hears the word).
// • AVG_WORD_MS_INIT / FLOOR / CEIL: the smoothed per-word duration
//   floor/ceiling. Floor prevents synchronous boundary bursts from
//   convincing the watchdog to race ahead.
// • EMA_DELTA_MIN/MAX: only boundary deltas inside this window count
//   toward the running average; bursts or stalls are ignored.
// • STUCK_THRESHOLD_MIN / MULT: idle threshold = max(MIN, avg × MULT)
//   before the watchdog starts walking the highlight on its own.
// • STUCK_TICK_MS: poll cadence for the watchdog.
const TTS_USER_SCROLL_QUIET_MS = 4000;
const TTS_AUDIO_LAG_MS = 220;
const TTS_AVG_WORD_MS_INIT = 380;
const TTS_AVG_WORD_MS_FLOOR = 320;
const TTS_AVG_WORD_MS_CEIL = 700;
const TTS_EMA_DELTA_MIN = 150;
const TTS_EMA_DELTA_MAX = 1000;
const TTS_STUCK_THRESHOLD_MIN_MS = 550;
const TTS_STUCK_THRESHOLD_MULT = 1.8;
const TTS_STUCK_TICK_MS = 150;

const TTS_PLAY_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15 9a3 3 0 0 1 0 6"/><path d="M17.5 7a6 6 0 0 1 0 10"/></svg>';
const TTS_STOP_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';

const TTS = {
  _activeBtn: null,
  // Karaoke highlight state. Every prose word inside an assistant
  // bubble is wrapped in a clickable <span class="tts-word"> at message
  // finalization (see Chat._attachMessageActions's getSpeechText path
  // → TTS._wrapWords). Tapping any span starts reading from that word.
  // While playing, the active span gets .tts-word--active and scrolls
  // into view if it drifts off-screen.
  _highlightRoot: null,
  _wordSpans: [],
  _wordIdx: -1,
  // Voice catalog. iOS Safari returns an empty list synchronously on
  // first call — `voiceschanged` fires moments later with the real
  // list. We listen for that event in _initVoices().
  _voices: [],
  // User's preferred voice (voiceURI). null = let _pickVoiceFor decide
  // per-utterance based on language + a "natural-sounding" heuristic.
  _chosenVoiceURI: null,
  // Master enable. When false, the Speak button on each assistant
  // message is hidden, tapping a word does nothing, the composer
  // Stop button doesn't appear, and any in-flight speech is cancelled
  // immediately. Reader-voice picker stays accessible so the user can
  // configure their preferred voice before turning the feature back
  // on. Persisted at 'crc.tts.enabled'; default true (the feature is
  // opt-out, not opt-in, since most users want it).
  _enabled: true,

  // Heuristic language detection from the text. The Web Speech API
  // picks a voice off `lang`; if we don't set it, iOS defaults to the
  // page's lang (English) and Hebrew text renders silent or as
  // ASCII-name-of-letter mumbling. Coarse heuristic — checks a
  // generous sample of the text for non-Latin scripts. Bumped from
  // 200 → 1200 chars so an English preamble in front of a Hebrew
  // quote (common in code review / chat) doesn't misclassify the
  // whole turn as English when the bulk is Hebrew.
  _detectLang(text) {
    const sample = (text || '').slice(0, 1200);
    if (/[֐-׿]/.test(sample)) return 'he-IL';   // Hebrew
    if (/[؀-ۿ]/.test(sample)) return 'ar-SA';   // Arabic
    if (/[Ѐ-ӿ]/.test(sample)) return 'ru-RU';   // Cyrillic
    if (/[぀-ヿ一-鿿]/.test(sample)) return 'ja-JP'; // CJK
    return 'en-US';
  },

  // Strip markdown so the reader doesn't enunciate `**bold**` as
  // "star star bold star star". Keeps the spoken version close to
  // what the user would read silently. Conservative — leaves
  // punctuation, drops obvious markup.
  _cleanForSpeech(text) {
    let t = String(text || '');
    // Fenced code blocks — collapse to "code block" so the reader
    // doesn't spell out every character.
    t = t.replace(/```[\s\S]*?```/g, ' (code block) ');
    // Inline code, bold, italic, links — strip the markers, keep the
    // human-readable content.
    t = t.replace(/`([^`]+)`/g, '$1');
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
    t = t.replace(/__([^_]+)__/g, '$1');
    t = t.replace(/\*([^*]+)\*/g, '$1');
    t = t.replace(/_([^_]+)_/g, '$1');
    t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Bullets + heading markers at line start.
    t = t.replace(/^[ \t]*[-*+]\s+/gm, '');
    t = t.replace(/^#{1,6}\s+/gm, '');
    return t.trim();
  },

  // Wrap every word inside `.msg__body` descendants of `root` in a
  // <span class="tts-word">, returning the list in document order. Text
  // inside <code> / <pre> is skipped — speech doesn't enunciate code
  // anyway, and tapping a code character to "start reading here" is
  // meaningless. Idempotent: re-wrapping an already-wrapped bubble
  // just returns the existing spans.
  //
  // Each span gets a click handler that starts speech from THAT word,
  // turning the bubble into a tap-anywhere reader (the user's request:
  // "use our marker in a text to decide where he wants to start
  // reading"). The click is stopPropagation'd so it doesn't trigger
  // the message's long-press popover.
  _wrapWords(root) {
    if (!root) return [];
    const bodies = root.classList && root.classList.contains('msg__body')
      ? [root]
      : Array.from(root.querySelectorAll(':scope .msg__body'));
    const spans = [];
    for (const body of bodies) {
      const existing = body.querySelectorAll('.tts-word');
      if (existing.length > 0) {
        existing.forEach((s) => spans.push(s));
        continue;
      }
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          let p = n.parentNode;
          while (p && p !== body) {
            const tag = p.nodeName;
            // Skip code/pre (read-aloud of source code is gibberish) AND
            // skip <a> (without this, the .tts-word span's click handler
            // preventDefaults the link click and TTS starts reading the
            // link text instead of navigating — reported 2026-05-20).
            // The markdown renderer already wraps links with
            // target="_blank" rel="noopener", so leaving the link text
            // unwrapped lets the browser handle navigation natively.
            if (tag === 'CODE' || tag === 'PRE' || tag === 'A') return NodeFilter.FILTER_REJECT;
            p = p.parentNode;
          }
          return n.nodeValue && /\S/.test(n.nodeValue)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      for (const tn of textNodes) {
        const parent = tn.parentNode;
        const parts = tn.nodeValue.split(/(\s+)/);
        const frag = document.createDocumentFragment();
        for (const part of parts) {
          if (!part) continue;
          if (/^\s+$/.test(part)) {
            frag.appendChild(document.createTextNode(part));
          } else {
            const span = document.createElement('span');
            span.className = 'tts-word';
            span.textContent = part;
            // No per-span event listeners. Tap-to-read is delegated on
            // the body via a single `click` handler (see below). Earlier
            // attempts wired pointerdown/pointerup PER SPAN which made
            // iOS Safari treat the span as a tap target and dismiss
            // long-press selection on release. A click handler on the
            // BODY is different — iOS routes synthetic clicks only for
            // short taps, not for long-press → release, so the two
            // gestures don't collide.
            spans.push(span);
            frag.appendChild(span);
            continue;
          }
        }
        parent.replaceChild(frag, tn);
      }
      // Click delegation at the body level. Long-press → release on
      // iOS does NOT synthesize a click (selection wins), so this
      // handler only fires for short taps. We additionally bail when
      // the user has an active text selection — that's iOS firing a
      // synthetic click as it dismisses the callout, which shouldn't
      // start TTS.
      if (!body.__ttsClickDelegated) {
        body.__ttsClickDelegated = true;
        body.addEventListener('click', (e) => {
          const s = e.target && e.target.closest && e.target.closest('.tts-word');
          if (!s || !body.contains(s)) return;
          try {
            const sel = window.getSelection && window.getSelection();
            if (sel) {
              if (sel.toString && sel.toString().length > 0) return;
              if (sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) return;
            }
          } catch {}
          TTS._handleWordClick(s);
        });
      }
    }
    return spans;
  },

  // Track manual scroll input. While the user is actively scrolling
  // (or just stopped within the last 4 s), the auto-scroll-into-view
  // is suppressed — otherwise every boundary event yanks the page
  // back to the active word and the user can't read ahead.
  _lastUserScrollTs: 0,

  // Stuck-highlight watchdog. iOS sometimes stops firing `boundary`
  // events partway through a chunk — the audio keeps playing, but the
  // active-word indicator freezes on whatever word fired last. This
  // interval polls speech state and, when too much time has elapsed
  // since the last boundary, advances the highlight at the measured
  // word pace. Bounded by the current chunk so we don't run past its
  // end; the next chunk's `onstart` snaps the highlight to the right
  // word anyway. _avgWordMs is updated from real boundary deltas as
  // playback runs, so the watcher's cadence matches the actual voice
  // (a fast Hebrew voice and a slow English one each converge to
  // their own pace within ~5 words).
  _stuckTimer: 0,
  _lastBoundaryTs: 0,
  _curChunkEndIdx: -1,
  // Measured ms/word, smoothed across boundary deltas. Floor at 320 ms
  // (≈ 3 wps, the upper end of natural speech) prevents the highlight
  // racing when an engine fires a burst of boundary events
  // synchronously instead of streaming them with the audio. Ceiling at
  // 700 ms catches very slow voices without letting the watchdog idle
  // forever.
  _avgWordMs: TTS_AVG_WORD_MS_INIT,
  _firstBoundaryOfChunk: false,
  // iOS Safari's audio output is buffered by roughly 150–250 ms — the
  // `boundary` event fires when the synthesizer STARTS the word, not
  // when the user hears it through the speaker. Without compensation
  // the highlight is consistently one beat ahead of the voice. We
  // delay every visual paint by this offset so it lands on the right
  // word as the audio reaches the user. Tunable at runtime via
  // `TTS._audioLagMs = N` from the console for per-device calibration.
  _audioLagMs: TTS_AUDIO_LAG_MS,
  _pendingPaints: [],
  _playbackId: 0,

  _clearPendingPaints() {
    for (const t of this._pendingPaints) { try { clearTimeout(t); } catch {} }
    this._pendingPaints = [];
  },

  // Schedule a delayed paint that lands on the user's ear, not the
  // engine's queue. `playbackId` tags the timer so a fresh
  // _beginPlayback (or stop) cancels stale paints without having to
  // walk the timer array. The logical _wordIdx is set synchronously
  // by the caller before scheduling; only the DOM paint is deferred.
  _schedulePaint(targetIdx, force) {
    const id = this._playbackId;
    const tid = setTimeout(() => {
      if (this._playbackId !== id) return;
      this._paintWord(targetIdx, force);
    }, this._audioLagMs);
    this._pendingPaints.push(tid);
  },

  _startStuckWatcher() {
    this._stopStuckWatcher();
    this._stuckTimer = setInterval(() => {
      try {
        if (!('speechSynthesis' in window)) return this._stopStuckWatcher();
        if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) return;
        const idle = Date.now() - (this._lastBoundaryTs || 0);
        // Wait for almost two normal word intervals before the
        // watchdog concludes the engine has stopped firing events.
        // Less aggressive than 1.4× so it doesn't race ahead during
        // jittery-but-still-functional boundary streams.
        const threshold = Math.max(TTS_STUCK_THRESHOLD_MIN_MS, this._avgWordMs * TTS_STUCK_THRESHOLD_MULT);
        if (idle < threshold) return;
        const next = this._wordIdx + 1;
        if (this._curChunkEndIdx >= 0 && next > this._curChunkEndIdx) return;
        if (next >= this._wordSpans.length) return;
        // Paint via the same delayed path so the watchdog's catch-up
        // also lands on the user's ear.
        this._schedulePaint(next, false);
        // Optimistically advance _wordIdx so subsequent ticks compute
        // the right "next." Painting will lag by _audioLagMs and is
        // cancellable.
        this._wordIdx = next;
        this._lastBoundaryTs = Date.now();
      } catch {}
    }, TTS_STUCK_TICK_MS);
  },

  _stopStuckWatcher() {
    if (this._stuckTimer) {
      clearInterval(this._stuckTimer);
      this._stuckTimer = 0;
    }
  },

  // Move the active highlight to `idx`. Scrolls the word into view
  // only when (a) it has drifted near the viewport edges AND (b) the
  // user hasn't manually scrolled recently. Setting `force=true`
  // bypasses (b) — used at playback start and on each chunk's onstart
  // so the page at least follows chunk boundaries even if the user
  // poked the scroll a moment ago.
  //
  // Splits into a logical-state setter (this method) and a separate
  // _paintWord that does the DOM-level paint. The split lets the
  // boundary-driven advance pre-set _wordIdx synchronously (so the
  // next boundary computes the right target) while deferring the
  // visual paint by ~200 ms to match the iOS audio buffer.
  _setActiveWord(idx, force) {
    this._wordIdx = idx;
    this._paintWord(idx, force);
  },

  _paintWord(idx, force) {
    const root = this._highlightRoot;
    if (!root) return;
    const prev = root.querySelector('.tts-word--active');
    if (prev) prev.classList.remove('tts-word--active');
    const span = this._wordSpans[idx];
    if (!span) return;
    span.classList.add('tts-word--active');
    const userScrolledRecently = (Date.now() - this._lastUserScrollTs) < TTS_USER_SCROLL_QUIET_MS;
    if (userScrolledRecently && !force) return;
    try {
      const rect = span.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const margin = 80;
      if (rect.top < margin || rect.bottom > vh - margin) {
        span.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    } catch {}
  },

  // Greedy chunker. iOS Safari's speech engine truncates utterances
  // longer than ~15 seconds of audio (a real WebKit bug — long
  // utterances just stop mid-sentence, no error event). The fix is to
  // queue many SHORT utterances; speechSynthesis plays them
  // back-to-back. Target ~25 words per chunk, ending preferentially at
  // a sentence boundary once we've accumulated at least 8 words.
  //
  // Returns objects with the chunk's word offset within `words` so the
  // playback loop can snap the highlight to the chunk's first word
  // on its onstart event — important because iOS sometimes stops
  // firing `boundary` past the first utterance, and an onstart-only
  // fallback at least keeps the page following chunk boundaries.
  _chunkWords(words) {
    const max = 25;
    const minAtPunct = 8;
    const chunks = [];
    let cur = [];
    let pos = 0;
    for (const word of words) {
      cur.push(word);
      const endsSentence = /[.!?]['")\]]?$/.test(word);
      if (cur.length >= max || (endsSentence && cur.length >= minAtPunct)) {
        chunks.push({ text: cur.join(' '), startWord: pos, wordCount: cur.length });
        pos += cur.length;
        cur = [];
      }
    }
    if (cur.length) chunks.push({ text: cur.join(' '), startWord: pos, wordCount: cur.length });
    return chunks;
  },

  // Build the voice list. iOS Safari's `getVoices()` is empty the very
  // first time it's called — the system populates the list
  // asynchronously and fires `voiceschanged` when it's ready. Hook
  // both and store the latest snapshot for _pickVoiceFor / the picker
  // sheet to consume.
  _initVoices() {
    if (!('speechSynthesis' in window)) return;
    try { this._chosenVoiceURI = localStorage.getItem('crc.tts.voice') || null; } catch {}
    try {
      const v = localStorage.getItem('crc.tts.enabled');
      if (v === '0' || v === 'false') this._enabled = false;
    } catch {}
    this._applyEnabledClass();
    const refresh = () => {
      try { this._voices = window.speechSynthesis.getVoices() || []; } catch {}
    };
    refresh();
    try { window.speechSynthesis.addEventListener('voiceschanged', refresh); } catch {}
  },

  // Reflect the enabled state as a body class so CSS can hide the
  // Speak button and de-tap the .tts-word spans for any assistant
  // message in the DOM, regardless of when it was rendered.
  _applyEnabledClass() {
    try {
      document.body.classList.toggle('crc-tts-disabled', !this._enabled);
    } catch {}
  },

  setEnabled(enabled) {
    this._enabled = !!enabled;
    try { localStorage.setItem('crc.tts.enabled', this._enabled ? '1' : '0'); } catch {}
    this._applyEnabledClass();
    if (!this._enabled) {
      // Cancel anything in flight and clear pending visual updates.
      try { this.stop(); } catch {}
    }
  },

  // Pick the best available voice for `lang`. Honors the user's
  // override (set via the Reader voice sheet) when it covers the
  // requested language. Otherwise scores remaining voices and picks
  // the highest-scoring one — strongly preferring Apple's "Enhanced"/
  // "Premium" voices, Microsoft's "Natural", Google's "WaveNet"/
  // "Neural", and any cloud (non-localService) voice. Falls back to
  // the system default.
  _pickVoiceFor(lang) {
    const voices = this._voices || [];
    if (!voices.length) return null;
    const langPrefix = (lang || '').slice(0, 2).toLowerCase();
    // User override is absolute. If they picked Carmit (Hebrew) and the
    // message is English, Carmit reads the English — that's what they
    // asked for. Previously we silently fell back to an English voice
    // on language mismatch, which made the picker feel broken. Most
    // system voices can pronounce other-language text reasonably (the
    // intonation is foreign-accented but every grapheme still gets
    // voiced), so honoring the choice gives the user one consistent
    // narrator across languages.
    if (this._chosenVoiceURI) {
      const found = voices.find((v) => v.voiceURI === this._chosenVoiceURI);
      if (found) return found;
    }
    const eligible = voices.filter((v) => (v.lang || '').toLowerCase().startsWith(langPrefix));
    const pool = eligible.length ? eligible : voices;
    let best = null;
    let bestScore = -1;
    for (const v of pool) {
      const n = (v.name || '').toLowerCase();
      let score = 0;
      if (/enhanced|premium|natural|wavenet|neural/.test(n)) score += 10;
      if (v.localService === false) score += 5;
      if (v.default) score += 2;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  },

  setVoice(voiceURI) {
    this._chosenVoiceURI = voiceURI || null;
    try {
      if (voiceURI) localStorage.setItem('crc.tts.voice', voiceURI);
      else localStorage.removeItem('crc.tts.voice');
    } catch {}
  },

  // Speak `root`'s prose starting at word `startIdx` (0 = from the
  // top). Stops any in-flight speech first. Words are wrapped (idempotent),
  // chunked, and queued as separate utterances so iOS doesn't truncate.
  // The active highlight advances on every `boundary` event; each
  // chunk's `onstart` snaps the highlight to its first word so the
  // page tracks chunk boundaries even when iOS drops boundary events
  // on later utterances. _reset() fires once the last chunk's `end`
  // event arrives.
  //
  // `opts.scrollOnStart` controls whether we yank the bubble into
  // view at playback start. true when the user tapped the Speak ▶
  // button (which lives below the message, so the bubble may be
  // partly off-screen); false when the user tapped a specific word
  // (the word is already on-screen by definition, so a scrollIntoView
  // would jerk the page up — the bug the user reported).
  _beginPlayback(btn, root, startIdx, opts) {
    if (!('speechSynthesis' in window)) return;
    const o = opts || {};
    const scrollOnStart = o.scrollOnStart !== false;
    this.stop();
    if (!root) {
      try { toast('Nothing to read', 'warn'); } catch {}
      return;
    }
    try {
      this._highlightRoot = root;
      this._wordSpans = this._wrapWords(root);
    } catch (e) {
      // Wrap failure leaves the bubble with no clickable words and no
      // highlight target — silent fallback would have the user tap
      // Speak and see nothing happen, which they reported as
      // "broken." Surface a toast so the failure is visible.
      try { console.warn('[TTS] wrap words failed', e); } catch {}
      try { toast('Could not start reading', 'error'); } catch {}
      this._highlightRoot = null;
      this._wordSpans = [];
      return;
    }
    if (!this._wordSpans.length) {
      try { toast('Nothing to read', 'warn'); } catch {}
      return;
    }
    const idx = Math.max(0, Math.min(startIdx | 0, this._wordSpans.length - 1));
    const slice = this._wordSpans.slice(idx).map((s) => s.textContent);
    const chunks = this._chunkWords(slice);
    if (!chunks.length) return;
    const lang = this._detectLang(chunks.map((c) => c.text).join(' '));
    const voice = this._pickVoiceFor(lang);
    // Reset the user-scroll cooldown — we're starting playback fresh,
    // the user opted in by tapping play or a word, so the first scroll
    // is welcome.
    this._lastUserScrollTs = 0;
    // Generation token: any pending delayed paints scheduled under the
    // previous id are invalidated. New _schedulePaint calls below use
    // this new id.
    this._playbackId++;
    this._clearPendingPaints();
    this._wordIdx = idx - 1;
    this._activeBtn = btn || null;
    if (btn) {
      btn.innerHTML = TTS_STOP_SVG;
      btn.setAttribute('aria-label', 'Stop reading');
      btn.classList.add('msg__action--speaking');
    }
    // Mirror the inline stop into the composer row so the user can
    // silence playback without scrolling back to the bubble's Speak
    // button — handy when speech has been reading for a while and the
    // active word has scrolled off-screen.
    try {
      const cs = document.getElementById('ttsStopBtn');
      if (cs) cs.hidden = false;
    } catch {}
    if (scrollOnStart) {
      try { root.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch {}
    }
    try {
      chunks.forEach((ch, i) => {
        const absoluteStart = idx + ch.startWord;
        const absoluteEnd = absoluteStart + ch.wordCount - 1;
        const u = new SpeechSynthesisUtterance(ch.text);
        u.lang = voice ? voice.lang : lang;
        if (voice) u.voice = voice;
        u.rate = 1.0;
        u.pitch = 1.0;
        u.onstart = () => {
          // Snap to this chunk's first word so the highlight + page
          // follow chunk boundaries even when boundary events fail.
          // `force: true` overrides the user-scrolled cooldown.
          this._setActiveWord(absoluteStart, true);
          // Re-arm the stuck-highlight watchdog for this chunk's
          // window. If boundary events keep firing, _lastBoundaryTs
          // gets bumped on each one and the watchdog stays idle. If
          // they stop, the watchdog walks the highlight at the
          // estimated pace until the chunk ends. _firstBoundaryOfChunk
          // tells the boundary handler to NOT advance on the very
          // first event — the boundary for the first word arrives
          // when the engine starts speaking it, but we already painted
          // that word in onstart. Double-advancing made the highlight
          // run a word ahead of the actual audio (the bug the user
          // reported).
          this._curChunkEndIdx = absoluteEnd;
          this._lastBoundaryTs = Date.now();
          this._firstBoundaryOfChunk = true;
          this._startStuckWatcher();
        };
        u.onboundary = (ev) => {
          if (!ev || ev.name !== 'word') return;
          const now = Date.now();
          if (this._firstBoundaryOfChunk) {
            this._firstBoundaryOfChunk = false;
            this._lastBoundaryTs = now;
            return;
          }
          // Smooth-average the per-word duration from real boundary
          // events, but only counts deltas in the natural-speech window.
          // Bursts under 150 ms are synchronous queue artifacts (not
          // audible pacing) and would otherwise drag the average down
          // until the highlight raced ahead of the audio. Clamped to
          // [320, 700] ms so the watchdog stays honest even when the
          // window is empty.
          const delta = now - this._lastBoundaryTs;
          if (delta > TTS_EMA_DELTA_MIN && delta < TTS_EMA_DELTA_MAX) {
            const next = this._avgWordMs * 0.7 + delta * 0.3;
            this._avgWordMs = Math.max(TTS_AVG_WORD_MS_FLOOR, Math.min(TTS_AVG_WORD_MS_CEIL, next));
          }
          this._lastBoundaryTs = now;
          // Advance the logical index synchronously so the NEXT
          // boundary computes the right target. Defer the visual paint
          // by _audioLagMs to compensate for the iOS audio output
          // buffer — without this, the highlight lands one beat ahead
          // of what the user hears (the bug reported as "words
          // skipping way quicker than what the voice is speaking").
          const target = this._wordIdx + 1;
          this._wordIdx = target;
          this._schedulePaint(target, false);
        };
        if (i === chunks.length - 1) {
          u.onend = () => this._reset();
        }
        u.onerror = () => this._reset();
        window.speechSynthesis.speak(u);
      });
    } catch (e) {
      try { console.warn('[TTS] speak failed', e); } catch {}
      this._reset();
    }
  },

  toggle(text, btn, root) {
    if (!('speechSynthesis' in window)) return;
    if (!this._enabled) return;
    // Tapping the same Speak button while it's reading = stop.
    if (this._activeBtn === btn) {
      this.stop();
      return;
    }
    this._beginPlayback(btn, root, 0, { scrollOnStart: true });
  },

  // Handler attached to every .tts-word span. Tap → start reading
  // from that word forward. If speech is already playing, this acts
  // like a "jump to here" since _beginPlayback first stops any
  // in-flight utterance.
  //
  // We pass scrollOnStart=false here because the tapped word is
  // already on-screen by definition — otherwise the user couldn't
  // have tapped it. The previous behavior of scrolling the bubble to
  // `block: 'start'` jerked the page up and disoriented the user
  // (bug they reported: "the screen was instantly scrolling up like
  // up and then down even though I pressed on a word right in front
  // of me").
  _handleWordClick(span) {
    if (!span) return;
    if (!this._enabled) return;
    const wrap = span.closest('.msg');
    if (!wrap) return;
    const btn = wrap.querySelector('.msg__action--speak');
    const all = Array.from(wrap.querySelectorAll('.msg__body .tts-word'));
    const idx = all.indexOf(span);
    if (idx < 0) return;
    this._beginPlayback(btn || null, wrap, idx, { scrollOnStart: false });
  },

  stop() {
    try { window.speechSynthesis.cancel(); } catch {}
    this._reset();
  },

  _reset() {
    this._stopStuckWatcher();
    this._clearPendingPaints();
    this._playbackId++;
    this._curChunkEndIdx = -1;
    this._lastBoundaryTs = 0;
    if (this._activeBtn) {
      this._activeBtn.innerHTML = TTS_PLAY_SVG;
      this._activeBtn.setAttribute('aria-label', 'Read aloud');
      this._activeBtn.classList.remove('msg__action--speaking');
      this._activeBtn = null;
    }
    if (this._wordIdx >= 0 && this._wordSpans[this._wordIdx]) {
      this._wordSpans[this._wordIdx].classList.remove('tts-word--active');
    }
    this._wordIdx = -1;
    // Note: do NOT unwrap spans — they're permanent on assistant
    // bubbles so the user can tap any word to start reading later.
    this._highlightRoot = null;
    this._wordSpans = [];
    try {
      const cs = document.getElementById('ttsStopBtn');
      if (cs) cs.hidden = true;
    } catch {}
  },
};

// Kick off voice catalog load on script init. iOS populates voices
// asynchronously, so the first sheet open may still show "Loading…"
// briefly until voiceschanged fires.
try { TTS._initVoices(); } catch {}

// Keep the --composer-h CSS custom property in sync with the actual
// rendered height of the bottom composer footer, so the jump-to-bottom
// button and "new messages" pill always sit a fixed gap ABOVE the
// composer, no matter how many lines the user has typed. Falls back to
// a polling refresh if ResizeObserver isn't available (very old WebKit).
(function _observeComposerHeight() {
  const composer = document.getElementById('composer');
  if (!composer) return;
  const apply = () => {
    try {
      const h = composer.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--composer-h', h + 'px');
    } catch {}
  };
  apply();
  let _polled = false;
  try {
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(apply);
      ro.observe(composer);
    } else {
      setInterval(apply, 500);
      _polled = true;
    }
  } catch {
    if (!_polled) setInterval(apply, 500);
  }
  // Belt-and-suspenders: also re-apply on viewport changes (iOS rotation,
  // keyboard show/hide) since those can resize the composer's safe-area
  // padding without triggering ResizeObserver on every engine.
  try {
    window.addEventListener('resize', apply, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', apply, { passive: true });
    }
  } catch {}
})();

// Composer stop button (#ttsStopBtn). Tap → cancel any in-flight
// speech. Hidden by default; _beginPlayback unhides it, _reset hides
// it again.
try {
  const _ttsStop = document.getElementById('ttsStopBtn');
  if (_ttsStop) {
    _ttsStop.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { TTS.stop(); } catch {}
    });
  }
} catch {}

// User-scroll detector: any wheel/touchmove/keydown that could scroll
// the page sets `_lastUserScrollTs`. _setActiveWord uses this to
// suppress auto-scroll-into-view for ~4 s after the user touched the
// scroll — fixes the bug where every boundary event yanked the page
// back to the highlighted word and the user couldn't read ahead.
try {
  const _markScroll = () => { TTS._lastUserScrollTs = Date.now(); };
  window.addEventListener('wheel', _markScroll, { passive: true });
  window.addEventListener('touchmove', _markScroll, { passive: true });
  window.addEventListener('keydown', (e) => {
    // Don't count keys typed inside the composer (or any editable
    // surface) as scroll input. Space is a normal character there;
    // arrow keys move the caret. Without this gate, every keystroke
    // while typing would suppress TTS auto-scroll for the next 4 s.
    const t = e.target;
    if (t && t.closest && t.closest('textarea, input, [contenteditable="true"]')) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'PageDown' || k === 'PageUp' || k === 'Home' || k === 'End' || k === ' ') {
      TTS._lastUserScrollTs = Date.now();
    }
  }, { passive: true });
} catch {}

// Stop any in-flight TTS when the page is being TORN DOWN (bfcache
// page hide, real navigation). iOS fires `visibilitychange` on every
// screen-lock and app-switcher swap, even when the user is actively
// listening — we used to call TTS.stop() there too, but it killed
// audio whenever the user paused to look at something else. The Mic
// code does the same workaround in _tryAcquireWakeLock for the same
// reason. iOS Safari already pauses speechSynthesis when the page is
// truly backgrounded, so leaving the JS state intact lets playback
// resume on its own when the screen unlocks.
try {
  window.addEventListener('pagehide', () => TTS.stop());
} catch {}

// ─── In-DOM splash overlay ────────────────────────────────────────────
// Pixel-art mirror-reveal animation shown until the WebSocket is OPEN +
// initial state ('hello' frame) is received. The SVG markup is baked
// into index.html by `tools/build_splash_markup.py`; this module just
// walks each <rect> and toggles its opacity based on a 3-second
// mirror-reveal cycle.
//
// Lifecycle:
//   page load   → Splash.init() auto-starts the rAF loop
//   'hello'     → Splash.dismiss() fades the overlay out
//   ws onclose  → Splash.reshow() puts it back up while reconnecting
//
// Reduced motion: skips the per-rect cycle and just shows the icon +
// wordmark statically until dismiss. The overlay itself still fades.
const Splash = {
  _raf: 0,
  _startTime: 0,
  _shownAt: 0,           // wall-clock time the splash became visible this round
  _pendingDismiss: 0,    // setTimeout id if a dismiss is queued behind the min-duration
  _rects: null,
  _reduced: false,
  _running: false,
  // Phase boundaries — keep in sync with tools/preview_loading_animation.py.
  _DURATION_MS: 3000,
  _T_BLANK1: 0.08,
  _T_REVEAL: 0.45,
  _T_HOLD: 0.60,
  _T_COLLAPSE: 0.92,
  // Minimum on-screen time. If `hello` arrives in <500ms (typical for a
  // hot reload), the user would see a flash of the splash and then it'd
  // disappear before the animation reads. Matches the GIF's 2.3s
  // single-cycle length exactly — splash starts fading the moment the
  // kawaii lands, no awkward final-frame pause and no loop-restart.
  _MIN_VISIBLE_MS: 2300,

  init() {
    const el = document.getElementById('splashfx');
    if (!el) return;
    // Skip the animation entirely on user-initiated reloads (location
    // .reload, pull-to-refresh, the "tap to reload" stale-assets banner).
    // The user is explicitly resetting the page; they don't need to
    // watch the 3-second loading sequence again. Cold launches and
    // resume-from-background still play it (those go through different
    // entry points: this init() for cold, visibilitychange + pageshow
    // listeners for resume).
    let navType = '';
    try {
      const e = performance.getEntriesByType('navigation')[0];
      navType = (e && e.type) || '';
    } catch {}
    if (navType === 'reload') {
      el.setAttribute('data-state', 'dismiss');
      // Hide on the next tick so the CSS opacity transition's display:
      // none cleanup still applies cleanly.
      setTimeout(() => { el.hidden = true; }, 0);
      return;
    }
    this._reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._shownAt = performance.now();
    if (this._reduced) {
      el.dataset.static = '1';
      return;
    }
    this._rects = el.querySelectorAll('rect[data-phase]');
    this.start();
  },

  _progressAt(t) {
    if (t < this._T_BLANK1) return -0.01;
    if (t < this._T_REVEAL) return (t - this._T_BLANK1) / (this._T_REVEAL - this._T_BLANK1);
    if (t < this._T_HOLD) return 1.0;
    if (t < this._T_COLLAPSE) return 1.0 - (t - this._T_HOLD) / (this._T_COLLAPSE - this._T_HOLD);
    return -0.01;
  },

  start() {
    if (this._running) return;
    if (this._reduced) return;
    if (!this._rects || !this._rects.length) return;
    this._running = true;
    this._startTime = performance.now();
    const step = (now) => {
      if (!this._running) return;
      const elapsed = (now - this._startTime) % this._DURATION_MS;
      const t = elapsed / this._DURATION_MS;
      const p = this._progressAt(t);
      // Per-rect opacity. ~164 elements × 60fps = 10K style sets/s;
      // measured fine on iPhone 12+.
      for (const r of this._rects) {
        const phase = parseFloat(r.dataset.phase);
        r.style.opacity = (phase <= p) ? '1' : '0';
      }
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  },

  _stop() {
    this._running = false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  },

  // The actual fade-out + hide. Called either directly (if min-visible
  // has elapsed) or via setTimeout from dismiss().
  _finalize() {
    const el = document.getElementById('splashfx');
    if (!el) return;
    el.setAttribute('data-state', 'dismiss');
    this._stop();
    // Stamp sessionStorage so the inline boot script knows the splash
    // already played this PWA session. Real cold launches (swipe app
    // away in the app switcher, then re-open) clear sessionStorage and
    // therefore re-play the splash; intra-session reloads (WS
    // reconnect, /refresh, manual reload) keep it suppressed. localStorage
    // would persist across cold launches and suppress them, which is
    // what the user reported on 2026-05-15.
    try { sessionStorage.setItem('crc.splashDone', '1'); } catch {}
    // Also stamp a wall-clock timestamp so the inline boot script can
    // suppress the splash on iOS background-evictions within the next
    // SPLASH_SUPPRESS_MS window (6 h). Without this, every time iOS
    // reclaimed the PWA's WebContent process the next swipe-back was
    // a "cold relaunch" with empty sessionStorage and the splash
    // replayed — felt like a constant unwanted animation to the user.
    // Reported 2026-05-18.
    try { localStorage.setItem('crc.splashDoneAt', String(Date.now())); } catch {}
    // Wait for the CSS opacity transition to complete, then remove
    // from layout entirely so the splash can never accidentally
    // intercept taps even if its z-index/pointer-events weren't
    // perfectly suppressed.
    setTimeout(() => { el.hidden = true; }, 320);
  },

  dismiss() {
    const el = document.getElementById('splashfx');
    if (!el) return;
    // Honor the minimum-visible window even when 'hello' arrives early.
    // The user explicitly asked for the splash to stay up "at least 3
    // seconds" so they can see the animation on every open.
    const elapsed = performance.now() - this._shownAt;
    if (elapsed >= this._MIN_VISIBLE_MS) {
      this._finalize();
      return;
    }
    // Already a pending dismiss? Don't queue another.
    if (this._pendingDismiss) return;
    const remaining = this._MIN_VISIBLE_MS - elapsed;
    this._pendingDismiss = setTimeout(() => {
      this._pendingDismiss = 0;
      this._finalize();
    }, remaining);
  },

  reshow() {
    const el = document.getElementById('splashfx');
    if (!el) return;
    // Cancel any in-flight dismiss timer — we're going back to "show".
    if (this._pendingDismiss) {
      clearTimeout(this._pendingDismiss);
      this._pendingDismiss = 0;
    }
    // Stop any in-flight rAF loop too — if reshow fires while the
    // splash was still animating (e.g. background interrupted dismiss),
    // start() would return early because _running is still true.
    this._stop();
    // SNAP to visible, no fade-in. Without this, removing data-state
    // triggers the 280ms opacity transition (0→1), during which the
    // chat behind the splash is partially visible — that's the "weird
    // millisecond gap" the user reported when reopening the PWA.
    // We disable the transition, set the visible state, force a
    // reflow so the change is committed, then re-enable the transition
    // for the next dismiss's fade-out.
    el.style.transition = 'none';
    el.hidden = false;
    el.removeAttribute('data-state');
    // eslint-disable-next-line no-unused-expressions
    el.offsetHeight;  // force a synchronous reflow
    el.style.transition = '';
    this._shownAt = performance.now();
    if (this._reduced) {
      el.dataset.static = '1';
      return;
    }
    // Re-collect rects in case the DOM was rebuilt. Cheap (single
    // querySelectorAll on ~164 elements) and bullet-proof against
    // stale references after a long background period.
    this._rects = el.querySelectorAll('rect[data-phase]');
    this.start();
  },
};

// Boot the splash as early as possible. The HTML markup is already
// painted by the browser before this script ran; we just kick off the
// animation loop. We don't await DOMContentLoaded because the script
// is loaded with `type="module"` at the bottom of <body>, so the DOM
// is already complete when this line runs.
try { Splash.init(); } catch (e) { try { console.error('[Splash]', e); } catch {} }

// Splash-stuck circuit breaker. If `hello` never arrives within 12s of
// cold launch (bridge unreachable, Tailscale not connected, certificate
// rejected, etc.), the splash sits forever with the user staring at a
// dark screen and no idea what's wrong. Surface a visible recovery UI
// so they can at least try the "Reload" affordance instead of force-
// quitting the PWA. Cleared by the 'hello' frame handler.
let _SPLASH_HELLO_TIMER = setTimeout(() => {
  try {
    const overlay = document.getElementById('splashfx');
    if (!overlay || overlay.hidden) return;
    const stage = overlay.querySelector('.splashfx__stage');
    if (stage && !stage.querySelector('.splashfx__stuck')) {
      const box = document.createElement('div');
      box.className = 'splashfx__stuck';
      box.innerHTML =
        '<p style="color: var(--text, #e9e6e1); font-size: 14px; text-align: center; margin: 0; max-width: 240px; line-height: 1.4;">' +
        "Can't reach the bridge.<br/>Check Tailscale is on, then tap to retry." +
        '</p>' +
        '<button type="button" style="margin-top: 16px; padding: 12px 24px; min-height: 44px; background: var(--accent, #0E6E6E); color: white; border: 0; border-radius: 999px; font: inherit; font-weight: 600;">Reload</button>';
      box.style.cssText = 'display:flex;flex-direction:column;align-items:center;margin-top:24px;';
      box.querySelector('button').addEventListener('click', () => {
        try { location.reload(); } catch {}
      });
      stage.appendChild(box);
    }
  } catch (e) { try { console.error('[Splash stuck]', e); } catch {} }
}, 12000);
function _clearSplashStuckTimer() {
  if (_SPLASH_HELLO_TIMER) {
    clearTimeout(_SPLASH_HELLO_TIMER);
    _SPLASH_HELLO_TIMER = 0;
  }
}

// Diagnostic: log whether Geist actually loaded. If iOS PWA falls back to
// a serif/system font we want to KNOW that's the cause vs. some other
// rendering oddity. Logged to console; on failure also surfaces a small
// red dot in the topbar so the user can see it without DevTools.
if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    const geistOk = document.fonts.check('700 16px "Geist"');
    const geistMonoOk = document.fonts.check('400 14px "Geist Mono"');
    try { console.log('[CRC] font-status: Geist=' + geistOk + ' GeistMono=' + geistMonoOk); } catch {}
    if (!geistOk) {
      // Tag <html> so a future CSS rule can surface this visually.
      document.documentElement.setAttribute('data-font-failed', '1');
    }
  }).catch((e) => {
    try { console.warn('[CRC] document.fonts.ready rejected', e); } catch {}
  });
}

//
// Single ES module. No build step, no framework. The shape:
//
//   App.state       — local mirror of UI state (active project, mode, attachments)
//   App.ws          — WebSocket client w/ auto-reconnect
//   App.chat        — render layer: appends message DOM as protocol frames arrive
//   App.composer    — handles input, slash palette, paste, attach, mic
//
// The server is the source of truth for run lifecycle (it emits run_started /
// delta / run_finished). The client only mirrors enough state to draw the
// active assistant container into which deltas accumulate.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  // Tolerate `null` / `undefined` attrs — callers occasionally pass null
  // when they only need children. Before this, a stray `el('span', null, …)`
  // threw `Cannot convert undefined or null to object` inside Object.entries
  // and silently aborted whatever render was in progress (caught the
  // AskUserQuestion render bug at v1.0.40 — no card ever appeared on the
  // phone even though the tool_use frame had perfect data).
  if (attrs == null) attrs = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
};

// ─── State ────────────────────────────────────────────────────────────

// The user explicitly wants project selection to NOT persist across long
// gaps — they should pick a project at the start of each "session". But a
// quick refresh or 5-minute step away shouldn't lose it. So we stamp the
// pick with a timestamp and treat anything older than 15 min as expired.
const PROJECT_TTL_MS = 15 * 60 * 1000;
function _readActiveProject() {
  try {
    const project = localStorage.getItem('crc.activeProject');
    const at = parseInt(localStorage.getItem('crc.activeProjectAt') || '0', 10);
    if (!project) return null;
    if (!at || Date.now() - at > PROJECT_TTL_MS) {
      localStorage.removeItem('crc.activeProject');
      localStorage.removeItem('crc.activeProjectAt');
      return null;
    }
    return project;
  } catch { return null; }
}
function _saveActiveProject(p) {
  // iOS Safari in Private Browsing throws QuotaExceededError on every
  // localStorage.setItem (storage quota is 0). Wrap so the bridge keeps
  // working even when persistence isn't available.
  try {
    if (!p) {
      localStorage.removeItem('crc.activeProject');
      localStorage.removeItem('crc.activeProjectAt');
    } else {
      localStorage.setItem('crc.activeProject', p);
      localStorage.setItem('crc.activeProjectAt', String(Date.now()));
    }
  } catch {}
}

// Multi-tab state. Each tab has:
//   id          — client-generated UUID, also used as server-side tab_id
//   project     — project name (the tab's working directory)
//   sessionId   — claude session UUID, captured on first run, used for
//                 --resume on subsequent runs. null until first run.
//   running     — bool, true while a run is in flight
//   unread      — bool, true if claude wrote text while tab wasn't active
//   chatpane    — the DOM element holding this tab's chat history
//   attachments — per-tab attachment list (so picking files in tab A doesn't
//                 leak into tab B)
//   activeRuns  — Map<runKey, {container, hasText, cycler, spinnerTimer}>
//                 — same shape as before but scoped per tab
// Tab persistence is now active with a short TTL. Behavior:
//   - Every mutation calls _persistTabs(), which snapshots the current
//     tab list (minus DOM/Map fields that can't serialize) under
//     `crc.tabs` together with a `crc.tabsAt` timestamp.
//   - On cold boot, _loadTabsFromStorage() reads both keys. If the
//     write was within TAB_RESTORE_TTL_MS, the snapshot is returned;
//     otherwise storage is cleared and we start blank.
//   - Restoration happens in the boot's `freshStart` step (see the
//     bottom of this file). For each restored tab the boot path
//     recreates its chatpane DOM and, if the tab had a sessionId,
//     fires the existing session-replay flow so the chat history
//     re-renders without the user re-tapping anything.
//
// What gets stored: id, project, sessionId, pendingResumeSessionId,
// title, draft, model, attention, greeting. We do NOT persist
// `running`, `_activeRuns`, `_chatpane`, `_attachments`, or `_queue` —
// those are runtime-only and the server's `hello` frame reconciles
// the live-run state on reconnect anyway.
// Short TTL — restore tabs only if the PWA reopens within 5 minutes.
// Reasoning (per user request 2026-05-17): when they fully close the app
// and come back later, they expect a FRESH chat tile (Claude icon + empty
// composer), not a re-emergence of yesterday's conversation. 5 minutes
// covers the "phone slipped, swiped away, swiped back" reopen case while
// guaranteeing a real cold launch starts blank. The server keeps live
// runs alive across WS disconnects regardless of this TTL — restoration
// only governs what UI state the client rebuilds locally on reopen.
const TAB_RESTORE_TTL_MS = 5 * 60 * 1000;
function _loadTabsFromStorage() {
  try {
    const raw = localStorage.getItem('crc.tabs');
    const atRaw = localStorage.getItem('crc.tabsAt');
    if (!raw || !atRaw) return null;
    const at = parseInt(atRaw, 10);
    if (!at || Date.now() - at > TAB_RESTORE_TTL_MS) {
      // Stale snapshot — wipe so we don't keep loading it on every cold
      // boot afterwards.
      try { localStorage.removeItem('crc.tabs'); } catch {}
      try { localStorage.removeItem('crc.tabsAt'); } catch {}
      return null;
    }
    const data = JSON.parse(raw);
    if (!Array.isArray(data.tabs)) return null;
    return data;
  } catch { return null; }
}
function _persistTabs() {
  // Snapshot the active tab set so a quick close+reopen of the PWA
  // (within TAB_RESTORE_TTL_MS) lands the user back in the same
  // conversations. Past that window the boot path clears the storage
  // and falls back to a blank chat — matches the user's "if I really
  // walked away, start fresh" expectation.
  try {
    const tabs = (State.tabs || []).map((t) => ({
      id: t.id,
      project: t.project || null,
      sessionId: t.sessionId || null,
      pendingResumeSessionId: t.pendingResumeSessionId || null,
      title: t.title || null,
      draft: t.draft || '',
      model: t.model || '',
      agent: t.agent || null,
      attention: t.attention || null,
      greeting: t.greeting || '',
      // Snapshot composer attachments so they survive a reload (the
      // restart button, /refresh, even a phone unlock that closed the
      // tab). `thumbUrl` is dropped because blob: URLs from
      // URL.createObjectURL() are torn down with the document — the
      // server-side `path` is what's load-bearing for actually
      // sending the file, so the chip still works on restore (just
      // without a preview thumbnail for image attachments).
      attachments: (t._attachments || []).map((a) => ({
        name: a.name,
        path: a.path,
        size: a.size,
        mime: a.mime,
        kind: a.kind,
        dims: a.dims || null,
        url: a.url || null,
      })),
      // Snapshot the queued-prompt list too. Without this, a queue
      // built up during a long run would vanish the moment the user
      // closes the PWA — they'd come back to find Claude finished but
      // the messages they'd lined up to fire next were lost. The
      // entry's `_node` (DOM ref) is intentionally NOT serialized;
      // _restoreTabsFromSnapshot rebuilds the queued bubbles when it
      // re-hydrates the tab.
      queue: (t._queue || []).map((e) => ({
        text: e.text || '',
        attachments: (e.attachments || []).map((a) => ({
          name: a.name, path: a.path, size: a.size, mime: a.mime,
          kind: a.kind, dims: a.dims || null, url: a.url || null,
        })),
      })),
    }));
    const payload = JSON.stringify({ tabs, activeTabId: State.activeTabId || null });
    localStorage.setItem('crc.tabs', payload);
    localStorage.setItem('crc.tabsAt', String(Date.now()));
  } catch {}
}

// Rehydrate State.tabs from a localStorage snapshot. The snapshot only
// carries serializable fields (see _persistTabs) — DOM and runtime
// state are re-derived here:
//   - A fresh chatpane element is created via _ensureChatpane.
//   - If the tab had a sessionId, _replaySessionInto refetches the
//     conversation history from the server-side jsonl so the user
//     sees the prior turns rendered out before they start typing.
//   - tab.running stays false; the WS `hello` frame will reconcile any
//     run still alive on the server side once the socket connects.
function _restoreTabsFromSnapshot(snap) {
  if (!snap || !Array.isArray(snap.tabs)) return;
  const restoredIds = new Set();
  for (const s of snap.tabs) {
    if (!s || !s.id) continue;
    const tab = {
      id: s.id,
      project: s.project || null,
      sessionId: s.sessionId || null,
      // Carry the captured sessionId as a pending --resume target on
      // restore. The server's in-memory tab_id→session_id map lives in
      // the bridge process; if the bridge restarted between snapshot
      // and reopen (or it just forgot us), the server has no record
      // that this tab_id maps to s.sessionId, so without an explicit
      // force_session_id on the first prompt it would start a brand
      // new claude conversation. Forcing it on the first run is
      // idempotent when the server already knows — and corrective
      // when it doesn't.
      pendingResumeSessionId: s.sessionId || null,
      title: s.title || null,
      draft: s.draft || '',
      running: false,
      unread: false,
      model: s.model || '',
      agent: s.agent || null,
      greeting: s.greeting || pickGreeting(),
      compactPending: false,
      _compactSilent: false,
      attention: s.attention || null,
      _activeRuns: new Map(),
      _attachments: Array.isArray(s.attachments)
        ? s.attachments.map((a) => ({
            name: a.name,
            path: a.path || null,
            size: a.size || 0,
            mime: a.mime || 'application/octet-stream',
            kind: a.kind || 'file',
            dims: a.dims || null,
            url: a.url || null,
            // `thumbUrl` was dropped on persist (blob: URLs don't
            // survive reload). The chip renders without a preview;
            // image attachments still upload correctly because
            // `path` points at the server-saved file.
            thumbUrl: null,
          }))
        : [],
      // Carry persisted queue entries forward. _hydratePendingQueue()
      // below re-renders the Queued bubbles after the chatpane is
      // hydrated. Entries lack their old DOM `_node` ref by design
      // (those nodes don't survive reload) — the rehydrate step
      // re-creates them.
      _queue: Array.isArray(s.queue) ? s.queue.map((e) => ({
        text: e.text || '',
        attachments: (e.attachments || []).map((a) => ({
          name: a.name, path: a.path || null, size: a.size || 0,
          mime: a.mime || 'application/octet-stream',
          kind: a.kind || 'file', dims: a.dims || null, url: a.url || null,
          thumbUrl: null,
        })),
      })) : [],
      _chatpane: null,
    };
    State.tabs.push(tab);
    restoredIds.add(tab.id);
    // DO NOT create the chatpane for every restored tab on boot. Pre-
    // 2026-05-17 we ran `_ensureChatpane(tab)` here for all of them so
    // history replay could populate DOM in the background. On iOS
    // Safari that meant N hidden chatpanes accumulating message DOM
    // (each loaded from the session jsonl), and tapping a hidden tab
    // would trigger a `display:none → display:flex` toggle on a heavy
    // subtree — a synchronous layout pass that pushed the WebContent
    // process over its memory budget and got the page killed. After
    // 3 kills Safari shows "A problem repeatedly occurred." Solution:
    // only build the chatpane + replay history when the tab is
    // ACTIVATED. _ensureChatpaneAndReplay() below is the single entry
    // point that does both, idempotently.
  }
  if (snap.activeTabId && restoredIds.has(snap.activeTabId)) {
    State.activeTabId = snap.activeTabId;
  } else if (State.tabs.length) {
    State.activeTabId = State.tabs[0].id;
  }
  // Lazy hydrate: only the active tab gets its pane + history on boot.
  // Other tabs hydrate on first switchTab() call. See
  // _ensureChatpaneAndReplay's idempotence guard.
  const active = getActiveTab();
  if (active) {
    setTimeout(() => {
      try { _ensureChatpaneAndReplay(active); }
      catch (e) { try { console.error('restore replay (active)', e); } catch {} }
    }, 0);
  }
  // Restore the active tab's draft into the composer so the user's
  // half-typed message survived the close+reopen.
  try { _restoreActiveDraft(); } catch {}
}

// Single entry point for "make sure this tab has its chatpane DOM AND
// has loaded its session-jsonl history." Called from:
//   1) _restoreTabsFromSnapshot for the ACTIVE tab on boot.
//   2) switchTab for whichever tab is newly activated.
// Idempotent — uses tab._hydrated as a one-shot flag so a tab that's
// been visited once doesn't re-fetch its history every time it's
// re-activated. The check fires BEFORE _ensureChatpane so the WS-frame-
// first race (an inactive tab whose pane was built by Chat.beginRun
// before the user ever switched to it) does NOT re-trigger replay and
// double-render the live-streamed events. _ensureChatpane sets
// _hydrated whenever it creates a pane; this function flips the flag
// up-front for the first-visit case before any pane work happens.
function _ensureChatpaneAndReplay(tab) {
  if (!tab) return;
  if (tab._hydrated) {
    // Pane may or may not exist; ensure it does (idempotent no-op if
    // already there) and return without replaying.
    _ensureChatpane(tab);
    return;
  }
  // First-time hydrate: flip the flag NOW so a concurrent caller that
  // re-enters this function during the async replay sees `_hydrated`
  // and bails out. Then build the pane and kick replay.
  tab._hydrated = true;
  _ensureChatpane(tab);
  if (tab.sessionId && tab.project) {
    // Synchronously seed the pane with a loading spinner BEFORE
    // applyActiveTabUi runs. Without this seed the pane has 0
    // children at applyActiveTabUi time → empty-state shows → the
    // user sees a brief empty-state greeting flash before the
    // async _replaySessionInto fetches the session and renders
    // messages. Reported by user 2026-05-17 as the inter-tab "empty
    // chat session" flash. _replaySessionInto detects this pre-seeded
    // element and reuses it instead of appending a duplicate.
    const pane = tab._chatpane;
    if (pane && !pane.querySelector('.chat__loading')) {
      try {
        const loadingEl = el('div', { class: 'chat__loading' },
          el('div', { class: 'chat__loading__spinner', 'aria-hidden': 'true' }),
          el('div', { class: 'chat__loading__label' }, 'Loading conversation…'),
        );
        pane.append(loadingEl);
      } catch {}
    }
    try { _replaySessionInto(tab, tab.project, tab.sessionId); }
    catch (e) { try { console.error('hydrate replay', e); } catch {} }
  }
  // Re-render persisted queued bubbles. Restored entries have no
  // `_node` (DOM refs don't survive reload), so Chat.pushQueued is
  // re-invoked for each one to repopulate the chatpane with the
  // dimmed "Queued" placeholders the user remembers. Deferred via
  // microtask so any synchronous _ensureChatpane work settles first.
  try { _rehydrateQueueBubbles(tab); } catch (e) { try { console.error('queue rehydrate', e); } catch {} }
}

function _rehydrateQueueBubbles(tab) {
  if (!tab || !tab._queue || !tab._queue.length) return;
  for (const entry of tab._queue) {
    if (entry._node) continue; // already rendered
    const previewAttachments = (entry.attachments || []).map((a) => ({
      name: a.name, kind: a.kind, thumbUrl: null,
      path: a.path, mime: a.mime, size: a.size, dims: a.dims,
      url: a.url || null,
    }));
    try { entry._node = Chat.pushQueued(entry.text || '', previewAttachments, tab.id); } catch {}
  }
}
function _newTabId() {
  // 16 random url-safe chars — plenty of entropy for one user's tab set.
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

// Safe localStorage reads — iOS Safari Private Browsing throws on access
// in some configurations even for getItem. Always return null on failure.
function _lsGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

const State = {
  projects: [],
  permissionMode: _lsGet('crc.mode') || 'auto',
  effort: _lsGet('crc.effort') || 'xhigh',
  // Multi-tab fields.
  tabs: [],         // array of Tab records
  activeTabId: null,
};

// Backwards-compat shim so the rest of the code can keep saying
// State.activeProject without thinking about tabs. It always reflects the
// active tab's project. Setting it changes the active tab's project (or
// no-ops if there's no active tab — boot creates one).
Object.defineProperty(State, 'activeProject', {
  get() {
    const t = getActiveTab();
    return t ? t.project : null;
  },
  set(v) {
    const t = getActiveTab();
    if (t) {
      t.project = v;
      _persistTabs();
    }
  },
});
// Same shim for activeRuns / runningByProject / attachments — operate on
// the active tab's state. This lets the existing Chat.* methods keep
// referring to "State.activeRuns" without each call site having to know
// about tabs.
Object.defineProperty(State, 'activeRuns', {
  get() {
    const t = getActiveTab();
    if (!t) return new Map();
    if (!t._activeRuns) t._activeRuns = new Map();
    return t._activeRuns;
  },
});
Object.defineProperty(State, 'attachments', {
  get() {
    const t = getActiveTab();
    if (!t) return [];
    if (!t._attachments) t._attachments = [];
    return t._attachments;
  },
  set(v) {
    const t = getActiveTab();
    if (t) t._attachments = v;
  },
});
// runningByProject: now derived from tabs[].running. Kept for the send
// button mode check, but treated as a computed view rather than stored.
Object.defineProperty(State, 'runningByProject', {
  get() {
    const out = new Map();
    for (const t of State.tabs) {
      if (t.running) out.set(t.project, (out.get(t.project) || 0) + 1);
    }
    return out;
  },
});

function getActiveTab() {
  return State.tabs.find((t) => t.id === State.activeTabId) || null;
}
function getTab(tabId) {
  return State.tabs.find((t) => t.id === tabId) || null;
}

// Look up the tab currently bound to a claude session UUID, or null.
// Used by the sessions drawer / history sheet so re-tapping a past
// session focuses its already-open tab instead of opening a duplicate.
// Checks both the captured id (set once the first run completes via
// `session_init`) and the pending resume id (set the moment a history
// row creates a tab, BEFORE its first run, so re-taps in that window
// also dedupe correctly).
function findTabBySessionId(sessionId) {
  if (!sessionId) return null;
  return State.tabs.find(
    (t) => t.sessionId === sessionId || t.pendingResumeSessionId === sessionId,
  ) || null;
}

// Lazily build a per-tab chatpane element under #chat. Each tab owns its
// own DOM subtree so switching tabs doesn't rebuild messages from scratch —
// the inactive panes just have display:none. We don't tear down panes
// when a tab loses focus; only on closeTab.
function _ensureChatpane(tab) {
  if (!tab) return null;
  if (tab._chatpane && tab._chatpane.isConnected) return tab._chatpane;
  const pane = document.createElement('div');
  pane.className = 'chatpane';
  pane.dataset.tabId = tab.id;
  pane.setAttribute('data-active', tab.id === State.activeTabId ? 'true' : 'false');
  const chat = $('#chat');
  chat.appendChild(pane);
  // Mark the chat container so the fallback "no-tab" pane (used for
  // system messages on a cold app before any project is picked) gets
  // hidden the moment a real chatpane exists.
  chat.setAttribute('data-has-real-pane', '1');
  tab._chatpane = pane;
  // Do NOT set `_hydrated` here. Pane creation and history replay are
  // separate concerns: a WS frame for an inactive tab (media event,
  // delta from a still-live run, etc.) calls `_paneFor → _ensureChatpane`
  // BEFORE the user has switched to that tab. If we marked the tab
  // hydrated here, the subsequent `switchTab → _ensureChatpaneAndReplay`
  // would bail out — leaving the user staring at only the live-streamed
  // frames with no historical context above (reported 2026-05-21: user
  // saw only a video response in a tab, chat history above missing
  // until PWA relaunch). Replay handles the double-render race by
  // clearing pre-existing `.msg` elements before re-rendering, guarded
  // on `_activeRuns` being empty so an in-flight live bubble doesn't
  // get destroyed mid-stream.
  return pane;
}

function createTab(project, opts) {
  // opts.sessionId — if set, server will adopt it on first run (--resume).
  // Used by the history panel to open a past conversation as a new tab.
  // opts.title  — initial tab title (otherwise "New chat").
  const o = opts || {};
  const id = _newTabId();
  // Save the draft text of the currently-active tab before we switch.
  _captureActiveDraft();
  const tab = {
    id,
    project: project || null,
    sessionId: o.sessionId || null,
    pendingResumeSessionId: o.sessionId || null,
    title: o.title || null,
    draft: '',
    running: false,
    unread: false,
    // Inherit the user's previously-picked model from localStorage if the
    // caller didn't pass an explicit choice. Lets the picker work before
    // any tab is created — the choice carries forward to the next new tab.
    model: o.model != null ? o.model : (() => { try { return localStorage.getItem('crc.model') || ''; } catch { return ''; } })(),
    // Pick a fresh greeting at create time so every new tab gets its
    // own intro line. Storing it on the tab (not re-rolling on every
    // render) means the same tab shows the same greeting forever —
    // switching A→B→A doesn't shuffle it. Reads in refreshGreeting().
    greeting: pickGreeting(),
    // compactPending: true while the bridge is mid-compact for this tab.
    // _compactSilent: suppresses chat-bubble rendering of the compact's
    // prompt + summary frames so the user sees only the coral divider.
    // Both default false; flipped by _maybeFireAutoCompact / /compact.
    compactPending: false,
    _compactSilent: false,
    // Per-tab attention indicator state (VSCode parity, 2026-05-16):
    // null | 'awaiting' (blue dot) | 'finished' (orange dot). See
    // Chat._setTabAttention for the state machine.
    attention: null,
    _activeRuns: new Map(),
    _attachments: [],
    _chatpane: null,
    // Per-tab message queue. While `running` is true, sending a new
    // prompt pushes `{text, attachments}` here instead of rejecting;
    // run_finished drains the queue by re-calling sendPrompt for the
    // oldest entry. Lets the user line up follow-up turns the moment
    // a thought hits, without having to wait or stop the run.
    _queue: [],
  };
  State.tabs.push(tab);
  State.activeTabId = id;
  _ensureChatpane(tab);
  _persistTabs();
  renderTabs();
  applyActiveTabUi();
  try { _crcCrumb('createTab', `${project || '(no project)'} count=${State.tabs.length}`); } catch {}
  return tab;
}

// Set true for the duration of a tab switch so the `input` listener
// below doesn't write the in-flight textarea contents into the NEW
// tab's `draft` on a late-firing event (iOS Safari can dispatch a
// synthesized `input` event after a programmatic value-set in certain
// IME / autocorrect modes). Without the guard, that late event would
// overwrite the newly-restored draft of the destination tab with
// whatever leftover text was visible from the source tab — looking
// to the user like "my typed text follows me across tabs."
// Reported 2026-05-21.
let _switchInFlight = false;

// Snapshot the current textarea contents into the active tab's `draft`
// field so switching away doesn't lose half-typed text and switching back
// restores it. Called right before any tab switch / create / close.
function _captureActiveDraft() {
  const tab = getActiveTab();
  if (!tab) return;
  try {
    const v = $('#input') ? $('#input').value : '';
    tab.draft = v || '';
  } catch {}
}

// Restore the active tab's draft into the textarea (or clear if none).
// Always assigns — even if the new value matches the current one — so
// any stale text from the outgoing tab's textarea state is forcibly
// replaced. Defensive against the "text follows me across tabs" bug
// reported 2026-05-21.
function _restoreActiveDraft() {
  const tab = getActiveTab();
  const inputEl = $('#input');
  if (!inputEl) return;
  const next = (tab && tab.draft) || '';
  // Force re-assign: setting to '' first then to `next` is enough to
  // overwrite any IME composition or autocorrect-buffered text on
  // iOS Safari that a plain `value = next` would silently keep.
  inputEl.value = '';
  inputEl.value = next;
  try { autosizeInput(); } catch {}
}

function switchTab(tabId) {
  const tab = getTab(tabId);
  if (!tab) return;
  if (State.activeTabId === tabId) return;
  try { _crcCrumb('switchTab', `${State.activeTabId}->${tabId}`); } catch {}
  // Track which step the switch is on so a same-origin sanitised
  // "Script error." still tells us WHICH operation threw. Each step
  // updates the crumb tag; if we crash, the last crumb's `info`
  // reads like "step=apply" or "step=render", which is enough.
  const _ss = (s) => { try { _crcCrumb('switchStep', s); } catch {} };
  _switchInFlight = true;
  try {
    // Save what the user has typed on the outgoing tab so it isn't lost.
    _ss('capture'); _captureActiveDraft();
    State.activeTabId = tabId;
    tab.unread = false;
    // Switching to a tab IS the user's acknowledgement of any pending
    // attention flag — clear both 'awaiting' and 'finished' so the dot
    // disappears from the spark icon.
    tab.attention = null;
    // Persist BEFORE the heavy UI work. iOS Safari can kill the
    // WebContent process during applyActiveTabUi() if the activated
    // tab's chatpane is large; if persistence happens after, the
    // localStorage `activeTabId` still points at the previous tab and
    // the next reload lands the user on the wrong tab. Doing it first
    // means even a mid-switch crash boots back into the intended tab.
    _ss('persist'); _persistTabs();
    // Lazy-hydrate: build this tab's chatpane DOM + replay history
    // on first activation. Tabs that were never visited never paid
    // the cost; iOS WebKit can survive N tabs because their panes
    // don't exist until you touch them. Idempotent — see the
    // _hydrated guard inside.
    _ss('hydrate'); _ensureChatpaneAndReplay(tab);
    _ss('renderTabs'); renderTabs();
    _ss('applyUI'); applyActiveTabUi();
    // The newly-active tab's session poller was paused while hidden
    // (see _startSessionPoll's visibility gate — added 2026-05-17 to stop
    // iOS Safari's WebContent process from OOMing under N parallel
    // pollers). Fire an immediate catch-up tick so the user sees fresh
    // jsonl content right away instead of waiting up to ~1.5s.
    _ss('poke'); _pokeSessionPoll(tabId);
    _ss('done');
  } catch (e) {
    try {
      _crcBeacon('switchTab.throw', {
        target: tabId,
        message: (e && (e.message || String(e))) || 'unknown',
        stack: (e && e.stack) ? String(e.stack).slice(0, 800) : '',
      });
    } catch {}
    // Rethrow so the global onerror sees it too — we want both
    // the targeted beacon (which has step context) AND the global
    // one (which may show line/col on browsers that aren't iOS).
    throw e;
  } finally {
    // Clear the guard on the next tick — synchronous code is done,
    // but any input events synthesized during the switch should
    // settle within the current macrotask boundary.
    setTimeout(() => { _switchInFlight = false; }, 0);
  }
}

async function closeTab(tabId) {
  const tab = getTab(tabId);
  if (!tab) return;
  try { _crcCrumb('closeTab', tabId); } catch {}
  if (tab.running) {
    if (!confirm('A run is in progress for this tab. Close anyway? It will be stopped.')) return;
  }
  // Stop any live-sync poll attached to this tab.
  if (typeof _stopSessionPoll === 'function') _stopSessionPoll(tabId);
  // Tell the server to drop the session record (and stop any in-flight run).
  try { WS.send({ type: 'command', cmd: 'close_tab', tab_id: tabId }); } catch {}
  // Tear down DOM and state. Revoke any object URLs we minted for thumbnails.
  if (tab._attachments) {
    for (const a of tab._attachments) {
      if (a.thumbUrl) try { URL.revokeObjectURL(a.thumbUrl); } catch {}
    }
  }
  // Stop ghost-spinner timers before tearing the pane out — otherwise the
  // setTimeout/setInterval chain keeps firing on a detached DOM node.
  if (tab._ghostThinking && tab._ghostThinking.__cleanup) {
    try { tab._ghostThinking.__cleanup(); } catch {}
    tab._ghostThinking = null;
  }
  if (tab._chatpane) tab._chatpane.remove();
  const idx = State.tabs.findIndex((t) => t.id === tabId);
  State.tabs = State.tabs.filter((t) => t.id !== tabId);
  if (State.activeTabId === tabId) {
    // Pick the neighbor that was just to the left (or first remaining).
    const fallback = State.tabs[Math.max(0, idx - 1)] || State.tabs[0];
    State.activeTabId = fallback ? fallback.id : null;
    // CRITICAL: hydrate the new active tab's chatpane right now.
    // Chatpanes are lazily built only on switchTab(), so a tab the
    // user has never visited has `_chatpane === null`. Without this
    // hydration step, closing the active tab promotes the neighbour
    // to active but applyActiveTabUi has no pane to flip on — the
    // chat area shows the empty-state greeting instead of the
    // neighbour's actual session. Switching away and back used to
    // "fix" it by triggering switchTab's own hydration path.
    // Reported by user 2026-05-19.
    if (fallback) {
      try { _ensureChatpaneAndReplay(fallback); } catch (e) {
        try { console.warn('[closeTab] hydrate fallback failed', e); } catch {}
      }
    }
  }
  _persistTabs();
  renderTabs();
  applyActiveTabUi();
}

// Long-press drag-to-reorder for tabs. Phone-only gesture: hold a tab for
// ~380ms, then slide left/right to rearrange. The drag mutates State.tabs
// in place; _persistTabs() runs on drop so the new order survives reload.
// Click-to-switch and the × close button keep working unchanged because we
// (a) skip drag when pointerdown lands on .tab__close, and (b) suppress the
// trailing synthetic click once drag mode has been entered.
const TAB_LONGPRESS_MS = 380;
let _tabDrag = null;

// Non-passive touchmove blocker installed while a tab drag is active.
// Without this, iOS keeps scrolling the chat container vertically when
// the user's finger drifts up/down during the drag — because the touch
// gesture on #chat was already committed before the long-press fired,
// and touch-action:pan-x on the tab only governs FUTURE gestures, not
// the in-flight one. preventDefault stops the inherited scroll.
function _blockTouchMoveDuringTabDrag(e) {
  if (_tabDrag && e.cancelable) e.preventDefault();
}

function _attachTabDrag(tabEl, tab) {
  tabEl.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('.tab__close')) return;
    const startX = e.clientX, startY = e.clientY;
    const pointerId = e.pointerId;
    let longPressTimer = setTimeout(() => {
      longPressTimer = null;
      _enterTabDrag(tab.id, pointerId, startX, tabEl);
    }, TAB_LONGPRESS_MS);
    const abort = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      tabEl.removeEventListener('pointermove', onPreMove);
      tabEl.removeEventListener('pointerup', abort);
      tabEl.removeEventListener('pointercancel', abort);
    };
    const onPreMove = (ev) => {
      // Treat early movement as a scroll/scrub gesture and bail on the
      // long-press so the strip's native horizontal scroll still works.
      if (Math.abs(ev.clientX - startX) > 8 || Math.abs(ev.clientY - startY) > 8) abort();
    };
    tabEl.addEventListener('pointermove', onPreMove, { passive: true });
    tabEl.addEventListener('pointerup', abort, { passive: true });
    tabEl.addEventListener('pointercancel', abort, { passive: true });
  });
}

function _enterTabDrag(tabId, pointerId, startX, tabEl) {
  const scroll = document.getElementById('tabsScroll');
  if (!scroll) return;
  const tabEls = Array.from(scroll.querySelectorAll('.tab'));
  const originalIndex = tabEls.indexOf(tabEl);
  if (originalIndex < 0) return;
  try { if (navigator.vibrate) navigator.vibrate(18); } catch {}
  const layout = tabEls.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, left: r.left, top: r.top, width: r.width, center: r.left + r.width / 2 };
  });
  const orig = layout[originalIndex];
  // Float a clone of the tab above the strip and pin the ORIGINAL in
  // place with visibility:hidden. The hidden original keeps its slot
  // reserved so the strip layout doesn't collapse — without this, the
  // dragged tab's `translateX` left an empty gap where the slot used
  // to sit (the "blank space" the user reported). The clone follows
  // the pointer in absolute coordinates and never participates in
  // layout, so it can travel anywhere without disturbing neighbors.
  const clone = tabEl.cloneNode(true);
  clone.classList.add('tab--ghost');
  clone.removeAttribute('id');
  clone.style.position = 'fixed';
  clone.style.left = orig.left + 'px';
  clone.style.top = orig.top + 'px';
  clone.style.width = orig.width + 'px';
  clone.style.margin = '0';
  clone.style.zIndex = '200';
  clone.style.pointerEvents = 'none';
  clone.style.transform = 'scale(1.06)';
  clone.style.transformOrigin = 'center';
  clone.style.boxShadow = '0 8px 24px rgba(0,0,0,.45)';
  document.body.appendChild(clone);
  tabEl.style.visibility = 'hidden';
  tabEl.setAttribute('data-dragging', 'true');
  scroll.setAttribute('data-dragging', 'true');
  try { tabEl.setPointerCapture(pointerId); } catch {}
  _tabDrag = {
    tabId, pointerId, startX, layout, originalIndex,
    currentIndex: originalIndex, clone, originalEl: tabEl,
    origLeft: orig.left,
  };
  document.addEventListener('pointermove', _onTabDragMove);
  document.addEventListener('pointerup', _onTabDragEnd);
  document.addEventListener('pointercancel', _onTabDragEnd);
  document.addEventListener('touchmove', _blockTouchMoveDuringTabDrag, { passive: false });
}

function _onTabDragMove(e) {
  const drag = _tabDrag;
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const orig = drag.layout[drag.originalIndex];
  const draggedCenter = orig.center + dx;
  let newIndex = 0;
  for (let i = 0; i < drag.layout.length; i++) {
    if (draggedCenter >= drag.layout[i].center) newIndex = i;
  }
  // Move the floating clone along with the pointer. The original tab
  // stays visibility:hidden in its slot — its `transform` is left
  // alone since we no longer translate the original.
  drag.clone.style.left = (drag.origLeft + dx) + 'px';
  const shift = orig.width + 4;
  for (let i = 0; i < drag.layout.length; i++) {
    if (i === drag.originalIndex) continue;
    const el = drag.layout[i].el;
    if (drag.originalIndex < newIndex && i > drag.originalIndex && i <= newIndex) {
      el.style.transform = `translateX(${-shift}px)`;
    } else if (drag.originalIndex > newIndex && i < drag.originalIndex && i >= newIndex) {
      el.style.transform = `translateX(${shift}px)`;
    } else {
      el.style.transform = '';
    }
  }
  drag.currentIndex = newIndex;
}

function _onTabDragEnd() {
  const drag = _tabDrag;
  _tabDrag = null;
  if (!drag) return;
  document.removeEventListener('pointermove', _onTabDragMove);
  document.removeEventListener('pointerup', _onTabDragEnd);
  document.removeEventListener('pointercancel', _onTabDragEnd);
  // The `passive` option is ignored on remove — only `capture` matters
  // for matching the registration, and we registered without capture.
  document.removeEventListener('touchmove', _blockTouchMoveDuringTabDrag);
  // Tear down the floating clone first so the user doesn't see it
  // overlap with the reordered strip during the renderTabs rebuild.
  try {
    if (drag.clone && drag.clone.parentNode) {
      drag.clone.parentNode.removeChild(drag.clone);
    }
  } catch {}
  // Restore the original's visibility before re-render so any layout
  // flash before renderTabs() (which rebuilds the strip) looks normal.
  try { if (drag.originalEl) drag.originalEl.style.visibility = ''; } catch {}
  if (drag.currentIndex !== drag.originalIndex) {
    const idx = State.tabs.findIndex((t) => t.id === drag.tabId);
    if (idx >= 0) {
      const [moved] = State.tabs.splice(idx, 1);
      State.tabs.splice(drag.currentIndex, 0, moved);
    }
    try { _persistTabs(); } catch {}
  }
  // Swallow the synthetic click that fires after pointerup so a long-press
  // never doubles as a tab switch.
  const sup = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener('click', sup, true);
  setTimeout(() => window.removeEventListener('click', sup, true), 400);
  for (const item of drag.layout) {
    item.el.style.transform = '';
    item.el.removeAttribute('data-dragging');
  }
  const scroll = document.getElementById('tabsScroll');
  if (scroll) scroll.removeAttribute('data-dragging');
  renderTabs();
}

function renderTabs() {
  const nav = $('#tabs');
  const scroll = $('#tabsScroll');
  if (!nav || !scroll) return;
  scroll.innerHTML = '';
  // Always show the strip — the history + new-tab buttons live on it,
  // so it doubles as a slim toolbar even when there are 0 tabs. With
  // no tabs, the scroll area is just empty space between the topbar and
  // the chat, taking the strip's natural ~28px height.
  nav.hidden = false;
  for (const tab of State.tabs) {
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.setAttribute('data-active', tab.id === State.activeTabId ? 'true' : 'false');
    tabEl.setAttribute('data-running', tab.running ? 'true' : 'false');
    tabEl.setAttribute('data-unread', tab.unread ? 'true' : 'false');
    // Attention state — drives the orange/blue dot on the tab's spark icon.
    // 'awaiting' = blue (Claude needs user input), 'finished' = orange (Claude
    // completed its turn while the tab was hidden). Cleared on tab switch.
    tabEl.setAttribute('data-attention', tab.attention || 'none');
    tabEl.dataset.tabId = tab.id;
    const dot = el('span', { class: 'tab__dot' });
    // VS Code-style file-type glyph on the left of the tab. Replaced by
    // the pulsing dot whenever the tab is running (CSS hides one or the
    // other based on data-running).
    const iconWrap = el('span', { class: 'tab__icon', 'aria-hidden': 'true' });
    // The Anthropic asterisk used to live here. Replaced 2026-05-17 with
    // the kawaii bridge PNG so every tab strip carries the bridge brand
    // motif consistent with the empty-state mascot and the home-screen
    // icon. Pixel-art crisp-edge rendering is required so the 256px
    // source doesn't blur when downscaled to the 12px tab cell.
    iconWrap.innerHTML = `<img src="/icons/kawaii_bridge.png?v=${CRC_ASSET_VERSION}" alt="" />`;
    // Title: explicit tab.title (set from first user message or history
    // preview) → fall back to project name → "(new chat)".
    const titleText = tab.title || tab.project || '(new chat)';
    const title = el('span', { class: 'tab__title' }, titleText);
    const close = el('button', { class: 'tab__close', type: 'button', 'aria-label': 'Close tab' }, '×');
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    tabEl.addEventListener('click', () => switchTab(tab.id));
    _attachTabDrag(tabEl, tab);
    // Order: [running-dot OR file-icon] [title] [×]. CSS hides one of the
    // first two based on data-running so only one ever shows.
    tabEl.append(dot, iconWrap, title, close);
    scroll.appendChild(tabEl);
  }
  // Scroll the active tab into view in case it's off-screen on a long strip.
  const active = scroll.querySelector('.tab[data-active="true"]');
  if (active && typeof active.scrollIntoView === 'function') {
    try { active.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch {}
  }
}

// Token usage donut, modeled on VSCode Claude Code extension's "%
// context remaining until auto-compact" indicator. The numerator is
// the cumulative token approximation for the active tab's session;
// the denominator is the auto-compact threshold (~190K of the 200K
// context window — Claude leaves 10K headroom for the assistant's
// reply). The donut visualises USAGE; the tooltip/toast reports
// REMAINING to match VSCode's wording.
const USAGE_CONTEXT_WINDOW = 200_000;
const USAGE_COMPACT_THRESHOLD = 190_000;
// Fraction of the compact threshold at which auto-compact fires. 0.8 = 80%.
// Tunable here so future product decisions can shift the trigger point.
const AUTO_COMPACT_FRACTION = 0.8;

// Auto-compact gating. Fires from BOTH `run_finished` AND `usage` frames so
// that a long tool-heavy run that pushes context past 80% mid-stream
// triggers compact the moment the next quiet period appears — instead of
// waiting for `run_finished` which may itself be delayed by the final
// `result` event not always arriving (e.g. when the bridge terminates
// claude post-AskUserQuestion).
//
//   - `outcome` is the `frame.outcome` from a run_finished frame, OR null
//     when fired from a usage frame.
//   - Refuses to fire while a run is in flight (`tab.running`) to avoid
//     stomping on whatever the model is currently writing.
//   - `_autoCompactFiring` interlock + 60s setTimeout reset stays the
//     same — prevents a re-fire while the compact run itself is still
//     streaming, but doesn't strand the flag forever on a failure.
function _maybeFireAutoCompact(tab, outcome) {
  if (!tab) return;
  if (!tab.project) return;
  if (!tab.usage) return;
  if (tab.compactPending) return;
  if (tab._autoCompactFiring) return;
  // Don't interrupt an in-flight run; let it finish, then re-check on
  // either `usage` or `run_finished`.
  if (tab.running && outcome == null) return;
  if (outcome != null && outcome !== 'done' && outcome !== 'stopped' && outcome !== 'error') return;
  const used = tab.usage.context_used || 0;
  if (used < USAGE_COMPACT_THRESHOLD * AUTO_COMPACT_FRACTION) return;
  tab._autoCompactFiring = true;
  tab.compactPending = true;
  tab._compactSilent = true;
  const compactPrompt =
    'Please compact this conversation: produce a concise summary of '
    + 'the key context (active tasks, recent decisions, important file '
    + 'paths) so we can continue with reduced context size. After your '
    + 'summary, await my next instruction.';
  try {
    WS.send({
      type: 'prompt',
      text: compactPrompt,
      project: tab.project,
      tab_id: tab.id,
      permission_mode: serverPermissionMode(),
      effort: State.effort,
      attachments: [],
      force_session_id: null,
      // Route the compact prompt through --no-session-persistence on
      // the server so claude reads the current session as context but
      // doesn't fork into a fresh jsonl. The compact_inplace endpoint
      // then writes the boundary + summary into the ORIGINAL session,
      // keeping the user's chat anchored to the same session_id and
      // preserving the messages above the boundary as readable
      // history.
      is_compact: true,
    });
    if (tab._chatpane) {
      tab._compactingStatusEl = _appendCompactingStatus(tab._chatpane);
    }
    try { console.info('[auto-compact] fired at context_used=' + used + ' threshold=' + Math.round(USAGE_COMPACT_THRESHOLD * AUTO_COMPACT_FRACTION)); } catch {}
  } catch (e) {
    console.warn('[auto-compact] send failed', e);
    tab._autoCompactFiring = false;
    tab.compactPending = false;
    tab._compactSilent = false;
  }
  setTimeout(() => { tab._autoCompactFiring = false; }, 60_000);
}
function renderUsageDonut() {
  const donut = $('#usageDonut');
  const arc = $('#usageDonutArc');
  const pctLabel = $('#usageDonutPct');
  if (!donut || !arc) return;
  const tab = getActiveTab();
  const usage = tab && tab.usage;
  const used = (usage && (usage.context_used || 0)) || 0;
  if (!used) {
    donut.hidden = true;
    return;
  }
  // Fill the arc to "% of compact threshold used" so 100% means we're
  // at the auto-compact point. Capped so visualisation never overflows.
  const usedPct = Math.max(0, Math.min(100, (used / USAGE_COMPACT_THRESHOLD) * 100));
  const remainingPct = Math.max(0, 100 - usedPct);
  donut.hidden = false;
  arc.setAttribute('stroke-dasharray', `${usedPct} ${100 - usedPct}`);
  if (pctLabel) pctLabel.textContent = `${Math.round(remainingPct)}%`;
  donut.removeAttribute('data-warn');
  donut.removeAttribute('data-danger');
  if (usedPct >= 95) donut.setAttribute('data-danger', 'true');
  else if (usedPct >= 80) donut.setAttribute('data-warn', 'true');
  donut.setAttribute(
    'title',
    `${remainingPct.toFixed(0)}% of context remaining until auto-compact (~${(USAGE_COMPACT_THRESHOLD - used).toLocaleString()} tokens)`,
  );
}

// Tap the donut to see exact numbers (useful when the visual arc is
// ambiguous near 0 or 100). Bound once at module load.
// Tap the donut to see exact numbers + offer to compact now. Mirrors
// Custom in-app confirm dialog. Returns a Promise<boolean> — resolves
// true on Compact / confirm tap, false on Cancel / backdrop tap / Esc.
// Used instead of the browser's native `confirm()` because we need
// custom button labels ("Compact" instead of "OK") so the action is
// clear on a phone screen where the user can't see the modal's
// origin context. Reusable for any other two-button confirm flow.
function _showConfirmDialog({ text, confirmLabel = 'OK', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('confirmDialog');
    const textEl = document.getElementById('confirmDialogText');
    const okBtn = document.getElementById('confirmDialogConfirm');
    const noBtn = document.getElementById('confirmDialogCancel');
    if (!dialog || !textEl || !okBtn || !noBtn) {
      // Defensive fallback in case the markup is missing.
      resolve(window.confirm(text));
      return;
    }
    textEl.textContent = text;
    okBtn.textContent = confirmLabel;
    noBtn.textContent = cancelLabel;
    dialog.hidden = false;
    function settle(value) {
      dialog.hidden = true;
      dialog.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }
    function onClick(ev) {
      const target = ev.target.closest('[data-action]');
      if (!target) return;
      settle(target.dataset.action === 'confirm');
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); settle(false); }
      else if (ev.key === 'Enter') { ev.preventDefault(); settle(true); }
    }
    dialog.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
  });
}

// VSCode's "X% of context remaining until auto-compact. Click to
// compact now." popover.
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#usageDonut')) return;
  const tab = getActiveTab();
  if (!tab || !tab.usage) return;
  const u = tab.usage;
  const used = u.context_used || 0;
  const remain = Math.max(0, USAGE_COMPACT_THRESHOLD - used);
  const pctRemain = Math.round((remain / USAGE_COMPACT_THRESHOLD) * 100);
  // Confirm via the custom dialog so the action button reads
  // "Compact" — the native confirm() can't relabel its OK button and
  // on a phone screen "OK" gave no context for what was about to
  // happen.
  const msg = `${pctRemain}% of context remaining until auto-compact.\n\n` +
              `${used.toLocaleString()} used · ${remain.toLocaleString()} remaining.\n\n` +
              `Compact this conversation? Claude will summarize the chat ` +
              `so far, then the bridge writes a compact boundary into the ` +
              `session — same session ID continues, but from the next ` +
              `message onward claude only sees the summary instead of ` +
              `the verbatim history. Token usage drops sharply.`;
  const proceed = await _showConfirmDialog({
    text: msg, confirmLabel: 'Compact', cancelLabel: 'Cancel',
  });
  if (!proceed) return;
  if (!tab.project) { toast('Pick a project first', 'warn'); return; }
  // Send a synthetic compact request. /compact only works in Claude
  // Code's interactive REPL, so we ask via natural-language prompt.
  // Flag the tab so the next run's spinner reads "Compacting…" instead
  // of cycling random words, AND so we can hit the mark_compact
  // endpoint when the run finishes — that appends an
  // isCompactSummary marker to the jsonl which the donut's
  // count_session_context respects (resets char count to just the
  // summary, so the % display drops to reflect the compacted state).
  tab.compactPending = true;
  tab._compactSilent = true;
  const compactPrompt =
    'Please compact this conversation: produce a concise summary of ' +
    'the key context (active tasks, recent decisions, important file ' +
    'paths) so we can continue with reduced context size. After your ' +
    'summary, await my next instruction.';
  WS.send({
    type: 'prompt',
    text: compactPrompt,
    project: tab.project,
    tab_id: tab.id,
    permission_mode: serverPermissionMode(),
    effort: State.effort,
    attachments: [],
    force_session_id: null,
    // Manual /compact path takes the same --no-session-persistence
    // route as auto-compact so the chat stays anchored to the same
    // session_id and the compact_inplace writes the boundary into
    // the ORIGINAL jsonl (no forked session).
    is_compact: true,
  });
  if (tab._chatpane) {
    tab._compactingStatusEl = _appendCompactingStatus(tab._chatpane);
  }
});

// Real in-place compaction matching what VS Code's /compact does.
// Called from the WS run_finished handler when tab.compactPending is
// set and the summarize run completed successfully.
//
// Verified empirically on 2026-05-14 by inspecting existing jsonls
// under ~/.claude/projects/: VS Code's /compact appends TWO events
// to the SAME jsonl with the SAME sessionId — a
// {type:"system",subtype:"compact_boundary"} marker and an
// isCompactSummary:true user message carrying the summary text.
// claude.exe's --resume parser sees the boundary and discards
// pre-boundary events from the model's context. Session UUID stays
// continuous (no fork).
//
// The bridge can replicate this by writing those two events directly
// to the jsonl. POST /api/sessions/.../compact_inplace does that
// server-side. Same tab, same session_id, real token reduction.
async function _finalizeCompact(tab) {
  if (!tab) return;
  tab._compactSilent = false;
  if (!tab.project || !tab.sessionId) {
    _swapCompactingForDivider(tab);
    return;
  }
  try {
    const r = await fetch(
      `/api/sessions/${encodeURIComponent(tab.project)}/${encodeURIComponent(tab.sessionId)}/compact_inplace`,
      { method: 'POST', headers: CSRF_HEADERS },
    );
    if (!r.ok) {
      _swapCompactingForDivider(tab);
      return;
    }
    const data = await r.json();
    if (data && typeof data.context_used === 'number') {
      if (!tab.usage) tab.usage = {};
      tab.usage.context_used = data.context_used;
      if (tab.id === State.activeTabId) renderUsageDonut();
    }
  } catch {}
  _swapCompactingForDivider(tab);
}

// Coral "Compacting…" status pinned to the bottom of the pane while the
// silent compact run is in flight. Same visual language as the post-
// compact divider — coral hairlines + a small uppercase label — so the
// transition between the two is just a label swap, no layout shift.
function _appendCompactingStatus(pane) {
  if (!pane) return null;
  const last = pane.lastElementChild;
  if (last && last.classList
      && (last.classList.contains('msg--compacting')
          || last.classList.contains('msg--compact'))) {
    return last;
  }
  const wrap = el('div', { class: 'msg msg--compacting' },
    el('span', { class: 'msg__compactBar', 'aria-hidden': 'true' }),
    el('span', { class: 'msg__compactLabel' }, 'Compacting…'),
    el('span', { class: 'msg__compactBar', 'aria-hidden': 'true' }),
  );
  pane.append(wrap);
  return wrap;
}

// Swap the in-flight "Compacting…" status for the final divider in the
// same DOM slot. If we never drew the status (edge case — direct
// boundary observed via JSONL poll), fall back to appending fresh.
function _swapCompactingForDivider(tab) {
  if (!tab || !tab._chatpane) return;
  const statusEl = tab._compactingStatusEl;
  tab._compactingStatusEl = null;
  if (statusEl && statusEl.parentNode) {
    statusEl.classList.remove('msg--compacting');
    statusEl.classList.add('msg--compact');
    const label = statusEl.querySelector('.msg__compactLabel');
    if (label) label.textContent = 'COMPACT CONVERSATION';
    return;
  }
  _appendCompactDivider(tab._chatpane);
}

function _appendCompactDivider(pane) {
  if (!pane) return;
  // Dedup — a tab that catches the compact_complete poll event and the
  // _finalizeCompact follow-up would otherwise stack two dividers.
  const last = pane.lastElementChild;
  if (last && last.classList && last.classList.contains('msg--compact')) return;
  const wrap = el('div', { class: 'msg msg--compact' },
    el('span', { class: 'msg__compactBar', 'aria-hidden': 'true' }),
    el('span', { class: 'msg__compactLabel' }, 'COMPACT CONVERSATION'),
    el('span', { class: 'msg__compactBar', 'aria-hidden': 'true' }),
  );
  pane.append(wrap);
}

// Reflect the current active tab in the rest of the UI: show its chatpane,
// hide siblings, refresh topbar/attachments/send button, manage empty state.
function applyActiveTabUi() {
  for (const tab of State.tabs) {
    if (tab._chatpane) {
      tab._chatpane.setAttribute(
        'data-active', tab.id === State.activeTabId ? 'true' : 'false',
      );
    }
  }
  // Empty state shows only when no active tab, or active tab has no msgs
  // yet. Re-render the greeting on EVERY apply (not just hidden→shown
  // transitions) so that switching to a different empty tab surfaces
  // that tab's pre-rolled greeting instead of staying on the last one.
  // Greetings are pinned per-tab in createTab, so the visible string only
  // changes when the active tab itself changes.
  const active = getActiveTab();
  const empty = $('#emptyState');
  if (empty) {
    // Empty state shows only when the active pane has NO content AND
    // no replay is queued. `.chat__loading` is the synchronous seed
    // `_ensureChatpaneAndReplay` drops the moment a tab with a session
    // is activated — treating it as "content coming" suppresses the
    // 150ms empty-greeting flash the user reported 2026-05-17 when
    // tapping between tabs with real conversations.
    const pane = active && active._chatpane;
    const shouldShow = !active || !pane ||
      (!pane.querySelector('.msg') && !pane.querySelector('.chat__loading'));
    if (shouldShow) refreshGreeting();
    empty.hidden = !shouldShow;
  }
  renderTopbar();
  renderAttachments();
  updateSendButton();
  renderUsageDonut();
  renderModelChip();
  renderAgentChip();
  _restoreActiveDraft();
  // FORCE iOS Safari to repaint the chat viewport on every tab switch,
  // and unconditionally pin to the bottom of the newly active pane.
  // The 1px sync nudge + offsetHeight read forces a synchronous layout
  // (fixes the "black band above content" bug). The OLD version then
  // scheduled a rAF to RESTORE the previous scrollTop — but the
  // previous scrollTop was from a different tab's pane, so we'd land
  // mid-history. On tab switch the user's intent is always "show me
  // the latest message in THIS tab" — reset followBottom and pin
  // unconditionally for the first 600ms so async replay content +
  // late-loading images both land us at the true bottom. After 600ms
  // gate on _isFollowingBottom so a user who starts scrolling up to
  // read history isn't yanked back. Reported 2026-05-21.
  const scrollEl = Chat.scrollEl;
  if (scrollEl) {
    scrollEl.scrollTop = scrollEl.scrollTop + 1;
    void scrollEl.offsetHeight;
  }
  _isFollowingBottom = true;
  Chat.scrollToBottom(true);
  const pinToBottom = () => {
    const el = Chat.scrollEl;
    if (el) el.scrollTop = el.scrollHeight;
  };
  setTimeout(pinToBottom, 80);
  setTimeout(pinToBottom, 240);
  setTimeout(pinToBottom, 600);
  // Tail pin — only fires if the user hasn't scrolled away by now.
  setTimeout(() => { if (_isFollowingBottom) pinToBottom(); }, 1200);
  // Also re-pin on the next image-load event in the active pane, which
  // catches replayed-history images that were loading off-screen.
  const _activeForImgWatch = getActiveTab();
  if (_activeForImgWatch && _activeForImgWatch._chatpane) {
    _activeForImgWatch._chatpane.querySelectorAll('img').forEach((img) => {
      if (img.complete) return;
      img.addEventListener('load', pinToBottom, { once: true, passive: true });
      img.addEventListener('error', pinToBottom, { once: true, passive: true });
    });
  }
}

// Every mutating POST must carry this header. The server rejects POSTs that
// lack it with 403. Defeats CSRF because browsers won't send custom headers
// cross-origin without CORS preflight (which the server never grants).
const CSRF_HEADERS = { 'X-CRC-Request': '1' };

const MODE_LABEL = {
  ask:       'Ask before edits',
  edits:     'Edit automatically',
  plan:      'Plan mode',
  autoshift: 'Auto mode',
  auto:      'Bypass permissions',
};

// UI mode → server-side permission_mode. "Auto mode" doesn't have a direct
// CLI equivalent (Claude Code's interactive auto-picker isn't a flag), so we
// approximate it as acceptEdits — same as "Edit automatically" — but kept
// as a separate UI option so the user can see all five labels they expect.
const MODE_TO_SERVER = {
  ask: 'ask', edits: 'edits', plan: 'plan',
  autoshift: 'edits',   // best headless approximation
  auto: 'auto',
};

const EFFORT_LABEL = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra-high', max: 'Max',
};

// Status words shown while claude is thinking. The complete set Claude Code
// itself cycles through in its REPL — the user pasted this verbatim. We
// pick one at random each tick instead of going through them in order,
// because the user is more likely to see "different" words rather than
// "next" words during a short run.
const THINKING_WORDS = [
  'Accomplishing','Actioning','Actualizing','Architecting','Baking','Beaming',
  "Beboppin'",'Befuddling','Billowing','Blanching','Bloviating','Boogieing',
  'Boondoggling','Booping','Bootstrapping','Brewing','Burrowing','Calculating',
  'Canoodling','Caramelizing','Cascading','Catapulting','Cerebrating',
  'Channelling','Choreographing','Churning','Bridging','Coalescing',
  'Cogitating','Combobulating','Composing','Computing','Concocting',
  'Considering','Contemplating','Cooking','Crafting','Creating','Crystallizing',
  'Cultivating','Crunching','Deciphering','Deliberating','Determining',
  'Dilly-dallying','Discombobulating','Doing','Doodling','Drizzling','Ebbing',
  'Effecting','Elucidating','Embellishing','Enchanting','Envisioning',
  'Evaporating','Fermenting','Fiddle-faddling','Finagling','Flambéing',
  'Flibbertigibbeting','Flowing','Flummoxing','Fluttering','Forging','Forming',
  'Frosting','Frolicking','Gallivanting','Galloping','Garnishing','Generating',
  'Germinating','Gitifying','Grooving','Gusting','Harmonizing','Hashing',
  'Hatching','Herding','Hibernating','Honking','Hullaballooing','Hyperspacing',
  'Ideating','Imagining','Improvising','Incubating','Inferring','Infusing',
  'Ionizing','Jitterbugging','Julienning','Kneading','Leavening','Levitating',
  'Lollygagging','Manifesting','Marinating','Meandering','Metamorphosing',
  'Misting','Moonwalking','Moseying','Mulling','Mustering','Musing',
  'Nebulizing','Nesting','Noodling','Nucleating','Orbiting','Orchestrating',
  'Osmosing','Perambulating','Percolating','Perusing','Philosophising',
  'Photosynthesizing','Pollinating','Pontificating','Pondering','Pouncing',
  'Precipitating','Prestidigitating','Processing','Proofing','Propagating',
  'Puttering','Puzzling','Quantumizing','Razzle-dazzling','Razzmatazzing',
  'Recombobulating','Reticulating','Roosting','Ruminating','Sautéing',
  'Scampering','Scheming','Schlepping','Scurrying','Seasoning','Shenaniganing',
  'Shimmying','Simmering','Skedaddling','Sketching','Slithering','Smooshing',
  'Sock-hopping','Spelunking','Spinning','Sprouting','Stewing','Sublimating',
  'Sussing','Swirling','Swooping','Symbioting','Synthesizing','Tempering',
  'Thinking','Thundering','Tinkering','Tomfoolering','Topsy-turvying',
  'Transfiguring','Transmuting','Twisting','Undulating','Unfurling',
  'Unravelling','Vibing','Waddling','Wandering','Warping','Whatchamacalliting',
  'Whirlpooling','Whirring','Whisking','Wibbling','Working','Wrangling',
  'Zesting','Zigzagging',
];

// Empty-state greetings. A fresh tab / refresh shows a randomly-picked
// one in place of the previous hardcoded "Hi, I'm Claude." line — same
// flavor as the Claude Code REPL's rotating intro. Title only; the
// "Tap the project name above..." subtitle is unchanged. Rebranded
// 2026-05-17 from Claude-themed lines to bridge-themed — keeps the
// playful tone but matches the kawaii-on-bridge mascot and the app's
// purpose ("a bridge for AI CLIs"). Earlier set was a Claude
// reference, which felt off-brand once the icon stopped being
// Claude-specific.
const GREETINGS = [
  "Bridgy open. What's up?",
  "Hi. Bridgy is up.",
  "Hey. Where to today?",
  "Bridgy ready. Let's go.",
  "Hi. Ready to bridge.",
  "Hello. Bridgy online.",
  "Hi. What are we building?",
  "Welcome aboard.",
  "Bridgy is up. Lay it on me.",
  "Hello — Bridgy at your service.",
  "Hi. Plug me in.",
  "Hey there. What's the brief?",
  "Bridgy online. What's the plan?",
  "Hi. Coffee's brewing.",
  "Greetings, captain.",
  "Hey. Spin up a chat.",
  "Hi, friend. What's up?",
  "Hello. Tools warmed up.",
  "Bridgy reporting for duty.",
  "Hey. Drop me a project.",
  "Mission accepted.",
  "Hello. The terminal awaits.",
  "Hi. Where to?",
  "Hey hey. Bridgy on standby.",
];

function pickGreeting() {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
}

function refreshGreeting() {
  const el = $('#emptyTitle');
  if (!el) return;
  // Prefer the active tab's pre-rolled greeting (set in createTab) so
  // every tab has its OWN line that doesn't change when switching back.
  // Falls back to a fresh pick when there's no active tab yet (cold boot
  // before the first project has been chosen — `applyActiveTabUi` calls
  // through to here on the initial empty-state render).
  const tab = getActiveTab();
  el.textContent = (tab && tab.greeting) || pickGreeting();
}

// Per-tool inline SVG glyphs for the tool-call cards. Keep them small —
// 14×14, monochrome (currentColor), matching the chat font scale. The
// __default icon is used for any tool we don't have a custom glyph for.
const TOOL_ICONS = {
  Bash:        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l4 4-4 4M11 16h8"/></svg>',
  PowerShell:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l4 4-4 4M11 16h8"/></svg>',
  Edit:        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6L9 21H3v-6L14 4z M13 5l6 6"/></svg>',
  Write:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 4l4 4M12 12l4-4-4-4"/></svg>',
  Read:        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6"/></svg>',
  NotebookEdit:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v16H5z M8 4v16M3 8h2M3 12h2M3 16h2"/></svg>',
  Grep:        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  Glob:        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  WebFetch:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></svg>',
  WebSearch:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  Task:        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  // Modern builds of Claude Code rename `Task` → `Agent`. Same icon.
  Agent:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  TodoWrite:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h2l1 1M3 12h2l1 1M3 18h2l1 1M9 6h12M9 12h12M9 18h12"/></svg>',
  __default:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
};

// One-liner summary of a tool's input for the chat card. Different tools
// have different "useful" fields; keep it terse since these stack up in
// long runs and we don't want them to dominate the chat.
function _summarizeTool(name, d) {
  d = d || {};
  if (name === 'Bash' || name === 'PowerShell') {
    return d.description || (d.command || '').split('\n')[0].slice(0, 120);
  }
  if (name === 'Edit' || name === 'Write' || name === 'Read' || name === 'NotebookEdit') {
    const p = d.file_path || d.notebook_path || '';
    // Show the last 2 path segments so a phone-narrow card stays readable.
    const parts = p.split(/[\\/]/);
    return parts.slice(-2).join('/');
  }
  if (name === 'Grep' || name === 'Glob') {
    const q = d.pattern || d.query || '';
    return q.slice(0, 120);
  }
  if (name === 'WebFetch' || name === 'WebSearch') {
    return d.url || d.query || '';
  }
  if (name === 'Task' || name === 'Agent') {
    return d.description || (d.prompt || '').slice(0, 120);
  }
  if (name === 'TodoWrite') {
    const todos = d.todos || [];
    return todos.length + ' todo' + (todos.length === 1 ? '' : 's');
  }
  // Fallback: first field's first 80 chars.
  const k = Object.keys(d)[0];
  return k ? `${k}: ${String(d[k]).slice(0, 80)}` : '';
}

// For tools whose payload is a piece of code (Bash command, PowerShell
// command, agent prompt, JSON edit), render that payload as a fenced
// code-block card inside the tool card. Same shape as markdown code
// blocks so the copy + expand affordances apply uniformly — the user
// can read the full command, copy it to clipboard, expand long ones.
// Returns null when the tool has no useful code-shape payload (Edit's
// diff comes via _renderDiff; Read/Grep are summarised in one line).
function _renderToolCode(name, input) {
  input = input || {};
  let code = '';
  let lang = '';
  if (name === 'Bash') {
    code = String(input.command || '');
    lang = 'bash';
  } else if (name === 'PowerShell') {
    code = String(input.command || '');
    lang = 'powershell';
  } else if (name === 'Task' || name === 'Agent') {
    code = String(input.prompt || '');
    lang = 'task';
  } else if (name === 'TodoWrite') {
    // TodoWrite has a dedicated visual renderer (see _renderTodoList
    // below + the special branch in appendToolUse). Return null here
    // so the generic code-block path is skipped — otherwise the user
    // sees the same content twice (once as a checklist, once as a
    // code block with `[x] / [ ]` marks underneath).
    return null;
  } else if (name === 'AskUserQuestion') {
    // Same rationale as TodoWrite — the interactive question card is
    // built by _renderAskUserQuestion; we don't want the raw questions
    // JSON shown as a code block alongside it.
    return null;
  } else if (name === 'WebFetch') {
    if (input.prompt) {
      code = String(input.prompt || '');
      lang = 'prompt';
    }
  }
  if (!code) return null;

  // Build the same .md-pre structure used by the markdown renderer so
  // CSS + the global copy/expand click handlers cover this too.
  const escaped = _escapeHtml(code);
  const wrap = document.createElement('div');
  // Header lang slot says "in" (not the tool's syntax like "powershell"
  // or "bash") so it visually pairs with the matching "out" label on
  // the tool_result block. The tool name is already in the toolcard's
  // outer header — repeating it here is noise.
  wrap.className = 'md-pre toolcard__code toolcard__io--in';
  wrap.setAttribute('data-expanded', 'false');
  wrap.setAttribute('data-overflow', 'false');
  wrap.setAttribute('data-tool-lang', lang);
  wrap.innerHTML = (
    '<div class="md-pre__head">' +
      '<span class="md-pre__lang">in</span>' +
      '<button class="md-pre__copyBtn" type="button" data-copy-code="1" aria-label="Copy code">' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>' +
        '<span>copy</span>' +
      '</button>' +
    '</div>' +
    `<div class="md-pre__body"><code class="md-codeblock">${escaped}</code></div>` +
    '<button class="md-pre__expandBtn" type="button" data-expand-code="1">Show full</button>'
  );
  return wrap;
}

// Decide whether to show the one-line summary above the code block. For
// Bash/PowerShell we usually have a `description` field that explains
// WHAT the command does, which complements the actual command text well.
// For Task / TodoWrite the code block IS the content, so an extra
// summary line would be redundant.
function _shouldShowSummaryAboveCode(name) {
  return name === 'Bash' || name === 'PowerShell';
}

// AskUserQuestion renderer + submit-as-next-prompt flow.
//
// Headless `claude -p` doesn't have a tool_result round-trip mechanism for
// interactive tools — when claude calls AskUserQuestion, the run ends
// shortly after. The user-facing UX we build here mirrors the desktop
// extension visually (question header chip + options + Other free-text +
// Submit button), and when the user taps Submit, we compose their answer
// as the NEXT user message in the same tab so claude resumes naturally.
// Conversation flow looks continuous; under the hood it's just two
// chained turns.
function _renderAskUserQuestion(input, _runId, tabId, prefilledAnswer = null) {
  const questions = Array.isArray(input && input.questions) ? input.questions : [];
  if (!questions.length) return null;

  const container = el('div', { class: 'askq' });
  if (prefilledAnswer) container.classList.add('askq--answered');
  // Per-question state: which option indices are selected, and any free-
  // text "Other" the user typed. Single-select questions enforce
  // size <= 1 by clearing on every click.
  const state = questions.map(() => ({ selected: new Set(), otherText: '' }));

  function renderOptions(qi, q, opts) {
    const options = Array.isArray(q.options) ? q.options : [];
    options.forEach((opt, oi) => {
      const optBtn = el('button', { type: 'button', class: 'askq__opt' });
      optBtn.setAttribute('data-selected', 'false');
      const dot = el('span', { class: 'askq__dot', 'aria-hidden': 'true' });
      const main = el('div', { class: 'askq__optMain' });
      main.append(el('div', { class: 'askq__optLabel' }, opt.label || ''));
      if (opt.description) {
        main.append(el('div', { class: 'askq__optDesc' }, opt.description));
      }
      optBtn.append(dot, main);
      optBtn.addEventListener('click', () => {
        if (q.multiSelect) {
          if (state[qi].selected.has(oi)) {
            state[qi].selected.delete(oi);
            optBtn.setAttribute('data-selected', 'false');
          } else {
            state[qi].selected.add(oi);
            optBtn.setAttribute('data-selected', 'true');
          }
        } else {
          state[qi].selected.clear();
          state[qi].selected.add(oi);
          opts.querySelectorAll('.askq__opt').forEach((b) => b.setAttribute('data-selected', 'false'));
          optBtn.setAttribute('data-selected', 'true');
          // Auto-advance to the next un-answered tab in multi-question
          // cards once a single-select answer lands. Mirrors VS Code's
          // AskUserQuestion UX — user picks an answer, the strip glides
          // them forward so they don't have to tap the next tab
          // manually. Skipped for multi-select (user might still be
          // picking more options) and skipped on the last question.
          // A 250ms delay lets the user see the dot fill before the
          // tab swaps, which makes the auto-advance feel intentional
          // rather than abrupt.
          if (typeof advanceFromTab === 'function') {
            setTimeout(() => advanceFromTab(qi), 250);
          }
        }
      });
      opts.append(optBtn);
    });
  }

  // Tab strip — only rendered when there's more than one question.
  // Matches the VS Code AskUserQuestion card: question headers as
  // tabs across the top, only the active tab's body visible at a
  // time, active tab gets a coral underline. Single-question cards
  // skip this and render inline (a tab strip with one tab is just
  // noise).
  const multi = questions.length > 1;
  const qWraps = [];
  let activeTab = 0;

  function setActiveTab(idx, tabsRow) {
    if (idx < 0 || idx >= questions.length) return;
    activeTab = idx;
    qWraps.forEach((w, i) => { w.hidden = (i !== idx); });
    if (tabsRow) {
      tabsRow.querySelectorAll('.askq__tab').forEach((t, i) => {
        t.setAttribute('data-active', i === idx ? 'true' : 'false');
        t.setAttribute('aria-selected', i === idx ? 'true' : 'false');
        t.tabIndex = i === idx ? 0 : -1;
      });
    }
  }

  // Auto-advance helper used by single-select option clicks. Walks
  // forward from `fromIdx` to find the next tab whose question has
  // not yet been answered (no selected option, no other-text). If
  // every later tab is already answered, stays put — the user can
  // hit Submit. Multi-question only; single-question cards have no
  // tab strip and never call this.
  function advanceFromTab(fromIdx) {
    if (!multi) return;
    for (let i = fromIdx + 1; i < questions.length; i++) {
      const st = state[i];
      const answered = (st.selected.size > 0) || !!st.otherText;
      if (!answered) {
        setActiveTab(i, tabsRow);
        return;
      }
    }
    // No later unanswered tabs — wrap around to the first unanswered
    // BEFORE fromIdx so the user can complete out-of-order picks
    // without manually scrubbing back through tabs.
    for (let i = 0; i < fromIdx; i++) {
      const st = state[i];
      const answered = (st.selected.size > 0) || !!st.otherText;
      if (!answered) {
        setActiveTab(i, tabsRow);
        return;
      }
    }
  }

  let tabsRow = null;
  if (multi) {
    tabsRow = el('div', { class: 'askq__tabs', role: 'tablist', 'aria-label': 'Questions' });
    questions.forEach((q, qi) => {
      const label = (q.header && q.header.trim()) || `Q${qi + 1}`;
      const tab = el('button', {
        type: 'button',
        class: 'askq__tab',
        role: 'tab',
        'aria-selected': qi === 0 ? 'true' : 'false',
        'data-active': qi === 0 ? 'true' : 'false',
        tabIndex: qi === 0 ? '0' : '-1',
      }, label);
      tab.addEventListener('click', () => setActiveTab(qi, tabsRow));
      // Keyboard nav across the tab strip (left/right + home/end),
      // matching the WAI-ARIA tabs pattern. Mobile users won't
      // typically hit these, but a connected keyboard or external
      // accessibility input gets the right behaviour.
      tab.addEventListener('keydown', (e) => {
        let next = null;
        if (e.key === 'ArrowRight') next = (qi + 1) % questions.length;
        else if (e.key === 'ArrowLeft') next = (qi - 1 + questions.length) % questions.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = questions.length - 1;
        if (next != null) {
          e.preventDefault();
          setActiveTab(next, tabsRow);
          const nextBtn = tabsRow.querySelectorAll('.askq__tab')[next];
          if (nextBtn) nextBtn.focus();
        }
      });
      tabsRow.append(tab);
    });
    container.append(tabsRow);
  }

  questions.forEach((q, qi) => {
    const qWrap = el('div', { class: 'askq__q' });
    if (multi) qWrap.hidden = (qi !== 0);
    // Header chip is the question's category label. When tabs are
    // present, the tab strip already shows it — duplicating it inside
    // the body just clutters the card, so skip in the multi case.
    if (q.header && !multi) {
      qWrap.append(el('span', { class: 'askq__header' }, q.header));
    }
    qWrap.append(el('div', { class: 'askq__text' }, q.question || ''));
    const opts = el('div', { class: 'askq__opts' });
    renderOptions(qi, q, opts);
    // Free-text "Other" — always available, matches desktop UX.
    const otherInput = el('input', {
      type: 'text',
      class: 'askq__otherInput',
      placeholder: 'Other — type your own answer…',
      'aria-label': 'Other answer',
      // Auto-detect direction so typing in Hebrew flips RTL.
      dir: 'auto',
    });
    otherInput.addEventListener('input', () => {
      state[qi].otherText = otherInput.value.trim();
    });
    opts.append(otherInput);
    qWrap.append(opts);
    qWraps.push(qWrap);
    container.append(qWrap);
  });

  // REPLAY MODE: when this render is being re-emitted from a past
  // session (history drawer, live-sync poll, page reload), we pass in
  // the user's original answer text (the user message that followed
  // this tool_use in the jsonl). The card renders the options as a
  // read-only echo + a clearly-labeled "Your answer:" panel so the
  // user can see what they previously chose without scrolling away
  // to find their reply bubble. No event listeners are attached;
  // double-submission is impossible.
  if (prefilledAnswer) {
    container.querySelectorAll('.askq__opt').forEach((b) => { b.disabled = true; });
    container.querySelectorAll('.askq__otherInput').forEach((b) => { b.disabled = true; });
    const echo = el('div', { class: 'askq__echo' });
    echo.append(
      el('div', { class: 'askq__echoLabel' }, 'Your answer'),
      el('div', { class: 'askq__echoText' }, prefilledAnswer),
    );
    container.append(echo);
    return container;
  }

  // Submit row. For multi-question cards we show a "N/total" badge so
  // the user knows how many questions they've actually picked an
  // answer for (option selected OR "Other" text typed). Matches the
  // VS Code card's count chip.
  const submitBtn = el(
    'button',
    { type: 'button', class: 'askq__submit' },
  );
  function answeredCount() {
    return state.reduce(
      (n, st) => n + ((st.selected.size > 0 || st.otherText) ? 1 : 0),
      0,
    );
  }
  function updateSubmitLabel() {
    const total = questions.length;
    const answered = answeredCount();
    if (total > 1) {
      submitBtn.textContent = '';
      submitBtn.append(
        el('span', { class: 'askq__submitCount' }, `${answered}/${total}`),
        el('span', {}, ' Submit answers'),
      );
    } else {
      submitBtn.textContent = 'Submit answer';
    }
    // Gate the button: every question must have at least one option
    // selected (or an "Other" string filled in) before the user can
    // submit. Mirrors VS Code's AskUserQuestion card behaviour. Without
    // this, sending a partial answer set fired _submitAskQuestionAnswer
    // with "(no selection)" stubs for the un-answered questions.
    submitBtn.disabled = answered < total;
    submitBtn.setAttribute('aria-disabled', submitBtn.disabled ? 'true' : 'false');
  }
  updateSubmitLabel();
  // Keep the count fresh as the user picks options across tabs. The
  // listeners run on the BUBBLE phase (no capture flag) so by the time
  // they fire the option-click handler has already mutated state[].
  // With capture=true the count read state BEFORE the mutation and
  // always lagged one click behind (1/3 stuck showing 0/3).
  container.addEventListener('click', updateSubmitLabel);
  container.addEventListener('input', updateSubmitLabel);

  submitBtn.addEventListener('click', () => {
    // Compose a single user message capturing every answered question.
    const parts = [];
    questions.forEach((q, qi) => {
      const st = state[qi];
      const labels = [];
      for (const oi of st.selected) {
        const opt = (q.options || [])[oi];
        if (opt && opt.label) labels.push(opt.label);
      }
      if (st.otherText) labels.push('Other: ' + st.otherText);
      const answer = labels.length ? labels.join('; ') : '(no selection)';
      const header = q.header || q.question || `Q${qi + 1}`;
      parts.push(`${header}: ${answer}`);
    });
    const text = parts.join('\n');
    if (!parts.length) return;
    // Lock the card AND switch it to the answered visual state — so
    // even if the page is later reloaded and the live tab's DOM is
    // the source (vs the replay path), the card looks consistent.
    submitBtn.remove();
    container.classList.add('askq--answered');
    container.querySelectorAll('.askq__opt').forEach((b) => { b.disabled = true; });
    container.querySelectorAll('.askq__otherInput').forEach((b) => { b.disabled = true; });
    const echo = el('div', { class: 'askq__echo' });
    echo.append(
      el('div', { class: 'askq__echoLabel' }, 'Your answer'),
      el('div', { class: 'askq__echoText' }, text),
    );
    container.append(echo);
    _submitAskQuestionAnswer(text, tabId);
  });
  container.append(submitBtn);
  return container;
}

function _submitAskQuestionAnswer(text, tabId) {
  const tab = getTab(tabId) || getActiveTab();
  if (!tab || !tab.project) {
    toast('Pick a project first', 'warn');
    return;
  }
  Chat.pushUser(text, [], tab.id);
  WS.send({
    type: 'prompt',
    text,
    project: tab.project,
    tab_id: tab.id,
    permission_mode: serverPermissionMode(),
    effort: State.effort,
    attachments: [],
    // Pass the client-side session UUID so the bridge can --resume the
    // right session even if the bridge process was restarted between
    // turns. Without this, every restart wiped sess.session_id and
    // the next prompt landed in a fresh session — Claude responded
    // "I don't see any prior work in this conversation."
    force_session_id: tab.sessionId || null,
    model: tab.model || '',
    agent: tab.agent || '',
  });
}

// ExitPlanMode approval card. Renders the plan markdown body + three
// action buttons that mirror what the VSCode extension's approval menu
// offers. In headless `-p` mode the running claude.exe can't be
// "told" to change mode mid-stream the way VSCode does, so instead we
// dispatch a fresh prompt frame on click that resumes the same
// session_id with the chosen permission mode flag — same outcome from
// the user's POV.
function _renderExitPlanMode(input, tabId, _toolUseId) {
  const plan = (input && typeof input.plan === 'string') ? input.plan : '';
  const card = el('div', { class: 'toolcard toolcard--plan' });
  const head = el('div', { class: 'toolcard__head' });
  const icon = el('span', { class: 'toolcard__icon', 'aria-hidden': 'true' });
  icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>';
  head.append(icon, el('span', { class: 'toolcard__name' }, 'Plan ready'));
  const body = el('div', { class: 'toolcard__detail toolcard__plan-body' });
  try {
    body.innerHTML = _renderMarkdown(plan || '_(empty plan)_');
    _enforceBlockDir(body);
  } catch (e) {
    body.textContent = plan || '(empty plan)';
  }
  const actions = el('div', { class: 'toolcard__actions' });
  const btnEdits = el('button', { type: 'button', class: 'toolcard__btn toolcard__btn--primary', 'data-action': 'apply-edits' }, 'Approve & apply');
  const btnAuto  = el('button', { type: 'button', class: 'toolcard__btn', 'data-action': 'apply-auto' }, 'Full auto');
  const btnNo    = el('button', { type: 'button', class: 'toolcard__btn', 'data-action': 'dismiss' }, 'Keep planning');
  actions.append(btnEdits, btnAuto, btnNo);
  card.append(head, body, actions);
  // Single delegated handler. Once a choice is made the card is "decided"
  // so a fat-finger can't fire two runs back-to-back.
  card.addEventListener('click', (e) => {
    if (card.dataset.decided === '1') return;
    const trigger = e.target && e.target.closest && e.target.closest('[data-action]');
    if (!trigger || !card.contains(trigger)) return;
    const action = trigger.dataset.action;
    card.dataset.decided = '1';
    [btnEdits, btnAuto, btnNo].forEach((b) => { b.disabled = true; });
    if (action === 'apply-edits') _sendPlanApproval(tabId, 'edits');
    else if (action === 'apply-auto') _sendPlanApproval(tabId, 'auto');
    // 'dismiss' just freezes the buttons; no WS send.
  });
  // Long-press on chrome copies the plan markdown. iOS native selection
  // still handles selecting substrings inside the body (the long-press
  // handler bails on .toolcard__detail per line ~2763).
  try { _attachLongPressCopy(card, () => plan || ''); } catch {}
  return card;
}

function _sendPlanApproval(tabId, mode) {
  const tab = getTab(tabId) || getActiveTab();
  if (!tab || !tab.project) {
    toast('Pick a project first', 'warn');
    return;
  }
  // Flip the picker UI to match the chosen mode so the chip the user sees
  // after the approval matches what's actually in effect.
  try {
    State.permissionMode = mode;
    localStorage.setItem('crc.mode', mode);
    if (typeof renderMode === 'function') renderMode();
  } catch {}
  const text = 'Apply the plan you just wrote.';
  Chat.pushUser(text, [], tab.id);
  WS.send({
    type: 'prompt',
    text,
    project: tab.project,
    tab_id: tab.id,
    permission_mode: mode,
    effort: State.effort,
    attachments: [],
    force_session_id: tab.sessionId || null,
    model: tab.model || '',
    agent: tab.agent || '',
    is_plan_approval: true,
  });
}

// TodoWrite-specific visual renderer. Builds a checklist UI matching
// what Claude Code's VSCode extension shows: one row per item, with a
// status indicator on the left (filled coral check = completed, ring
// = in-progress, hollow circle = pending) and the item text on the
// right (struck through when completed, bold when in-progress).
//
// Returns a <ul> DOM node or null when there are no todos. The caller
// inserts the node into the tool card in place of the generic code
// block.
function _renderTodoList(input) {
  const todos = Array.isArray(input && input.todos) ? input.todos : [];
  if (!todos.length) return null;
  const list = el('ul', { class: 'todolist' });
  for (const t of todos) {
    const status = (t && t.status) || 'pending';
    const text = (t && (t.content || '')) || '';
    const li = el('li', { class: 'todo todo--' + status });
    const mark = el('span', { class: 'todo__check', 'aria-hidden': 'true' });
    if (status === 'completed') {
      // Coral filled square with a white check.
      mark.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 7"/></svg>';
    } else if (status === 'in_progress') {
      // Spinning ring — solid coral ring with an inner gap.
      mark.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3 a9 9 0 0 1 9 9"/></svg>';
    } else {
      mark.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>';
    }
    const body = el('span', { class: 'todo__text' }, text);
    li.append(mark, body);
    list.append(li);
  }
  return list;
}

// Diff block rendered inside Edit / Write / NotebookEdit tool cards.
// Returns a DOM node, or null if the tool doesn't have a meaningful diff.
// Each line is rendered as a span with a +/- prefix and a colored bg,
// matching the VSCode extension's edit preview. Long diffs are clamped
// to ~40 lines + a "+ N more lines" stub so they don't dominate the chat.
function _renderDiff(name, input) {
  input = input || {};
  const MAX_LINES = 40;
  let oldStr = '', newStr = '';
  if (name === 'Edit') {
    oldStr = String(input.old_string || '');
    newStr = String(input.new_string || '');
  } else if (name === 'Write') {
    // Write replaces the whole file — show only the new content as
    // additions. No old context, since we don't have it from claude.
    newStr = String(input.content || '');
  } else if (name === 'NotebookEdit') {
    oldStr = String(input.old_string || '');
    newStr = String(input.new_source || input.new_string || '');
  } else {
    return null;
  }
  if (!oldStr && !newStr) return null;

  const oldLines = oldStr ? oldStr.split('\n') : [];
  const newLines = newStr ? newStr.split('\n') : [];

  const block = document.createElement('div');
  block.className = 'toolcard__diff';
  let shown = 0;
  function pushLine(prefix, cls, line) {
    if (shown >= MAX_LINES) return;
    const row = document.createElement('div');
    row.className = 'diffrow ' + cls;
    const p = document.createElement('span');
    p.className = 'diffrow__sigil';
    p.textContent = prefix;
    const t = document.createElement('span');
    t.className = 'diffrow__text';
    t.textContent = line === '' ? ' ' : line;
    row.append(p, t);
    block.append(row);
    shown++;
  }
  for (const ln of oldLines) {
    if (shown >= MAX_LINES) break;
    pushLine('-', 'diffrow--del', ln);
  }
  for (const ln of newLines) {
    if (shown >= MAX_LINES) break;
    pushLine('+', 'diffrow--add', ln);
  }
  const remaining = oldLines.length + newLines.length - shown;
  if (remaining > 0) {
    const row = document.createElement('div');
    row.className = 'diffrow diffrow--more';
    row.textContent = `+ ${remaining} more line${remaining === 1 ? '' : 's'}`;
    block.append(row);
  }
  return block;
}

// Claude Code's actual loading spinner — 6 Unicode glyphs cycled, with the
// first and last frames held slightly longer (per the article the user
// linked). The trailing ︎ is the Unicode "text presentation" variation
// selector — without it, iOS Safari renders some of these (especially
// ✶ Six Pointed Black Star) as full-color emoji glyphs, which makes the
// "last frame is a green emoji" bug. ︎ forces text-style rendering
// across every platform.
const SPINNER_FRAMES = ['·', '✻︎', '✽︎', '✶︎', '✳︎', '✢︎'];
const SPINNER_DURATIONS_MS = [180, 110, 110, 110, 110, 180]; // ease in/out

// ─── Stale-assets banner ──────────────────────────────────────────────
// Shown when the server's hello frame reports an asset_version that
// doesn't match what's bundled in this app.js. The user can tap to
// force a hard reload (with cache-bust + storage clear). This is the
// reliable escape hatch when iOS standalone PWA caching prevents
// the new code from loading despite the bridge serving it.
function showStaleAssetsBanner(serverVersion) {
  const banner = document.getElementById('staleBanner');
  const text = document.getElementById('staleBannerText');
  const btn = document.getElementById('staleBannerBtn');
  if (!banner) return;
  if (text) text.textContent = `New build ${serverVersion} ready.`;
  banner.hidden = false;
  if (btn && !btn.__wired) {
    btn.__wired = true;
    btn.addEventListener('click', async () => {
      // Belt-and-braces. Do the JS cleanup AND navigate to /refresh,
      // which sends a Clear-Site-Data response header — the only thing
      // iOS Safari standalone PWA reliably honors. Earlier versions of
      // this handler did JS cleanup + `location.replace('/?fresh=...')`,
      // which on iOS PWA standalone silently re-served the cached
      // assets (the home-screen launcher keeps a parallel document
      // cache that ignores no-store and is invisible to CacheStorage).
      // /refresh preserves the auth cookie — /nuke is the heavier
      // option that clears everything including cookies.
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
        }
        if ('caches' in self) {
          const names = await caches.keys();
          await Promise.all(names.map((n) => caches.delete(n)));
        }
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}
      } finally {
        location.replace('/refresh');
      }
    });
  }
}

// ─── Toast ────────────────────────────────────────────────────────────

let toastTimer = 0;
function toast(text, kind = 'info') {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  t.dataset.kind = kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

// ─── Lightbox ─────────────────────────────────────────────────────────

// Lightbox zoom state. The PAGE viewport is pinned (maximum-scale=1) so
// pinching the chat doesn't zoom the whole UI. Inside the lightbox we
// implement zoom-and-pan ourselves with proper math:
//   - iOS GestureEvent for pinch (gives `scale` directly + clientX/Y
//     at the pinch midpoint, so we can scale around that point instead
//     of around the image's geometric center — which is what makes
//     pinch-to-zoom feel natural)
//   - touchmove for pan when zoomed
//   - double-tap to toggle 1x ↔ 2.5x with the tap point at center
//   - JS-managed transitions: smooth ease only for double-tap toggles,
//     instant for pinch/pan so the image tracks fingers 1:1.
const _lbZoom = {
  scale: 1, x: 0, y: 0,
  startScale: 1, startX: 0, startY: 0,
  // Pinch midpoint (viewport coords) captured at gesturestart.
  pinchCx: 0, pinchCy: 0,
  // Un-transformed image center in viewport coords — invariant during
  // a single gesture, so we capture once at gesturestart.
  naturalCx: 0, naturalCy: 0,
  panStartX: 0, panStartY: 0,
  lastTap: 0, gestured: false,
};
function _lbApply() {
  const img = $('#lightboxImg');
  if (!img) return;
  img.style.transform = `translate3d(${_lbZoom.x}px, ${_lbZoom.y}px, 0) scale(${_lbZoom.scale})`;
}
function _lbSetTransition(on) {
  const img = $('#lightboxImg');
  if (!img) return;
  img.style.transition = on ? 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1)' : 'none';
}
function _lbReset() {
  _lbZoom.scale = 1; _lbZoom.x = 0; _lbZoom.y = 0;
  _lbSetTransition(true);
  _lbApply();
}
function openLightbox(src) {
  if (!src) return;  // never open with no image — that was a stuck-state bug
  const lb = $('#lightbox');
  const img = $('#lightboxImg');
  img.src = src;
  _lbReset();
  lb.hidden = false;
}
function closeLightbox() {
  const lb = $('#lightbox');
  lb.hidden = true;
  $('#lightboxImg').src = '';
  _lbReset();
  // Always clear the gesture-suppress flag — a pinch interrupted by
  // iOS (e.g. an incoming notification) used to leave gestured=true
  // permanently, which made every subsequent tap a no-op and the
  // lightbox impossible to close without a reload.
  _lbZoom.gestured = false;
}
(function _setupLightboxZoom() {
  const img = $('#lightboxImg');
  const lb = $('#lightbox');
  if (!img || !lb) return;

  // Pinch + pan implemented purely with touch events (NOT iOS
  // GestureEvent). The gesture-event API was unreliable in this
  // codebase — sometimes `e.scale` didn't fire, sometimes preventDefault
  // didn't compose cleanly with touch-action, and debugging was hard.
  // With 2-finger touchstart capturing the initial distance + midpoint,
  // and touchmove recomputing distance, we get pinch on every browser
  // with consistent behavior.
  //
  // Listeners are bound to the WHOLE LIGHTBOX (not just #lightboxImg)
  // because iOS Safari dispatches each finger's touchstart on the
  // element directly under that finger. If the user pinches with one
  // finger on the dark backdrop, only ONE touchstart hits #lightboxImg
  // (touches.length===1); the 2-finger branch never fires. Binding to
  // the lightbox container catches every finger no matter where it
  // lands, so pinch works edge-to-edge.

  // Active gesture state. Mutually exclusive: at any moment we're either
  // in a pinch (2 fingers), a pan (1 finger), or idle.
  let pinch = null;   // {dist, midX, midY, scale0, x0, y0, naturalCx, naturalCy}
  let pan = null;     // {fx, fy, x0, y0}  — finger pos + translate at touchstart

  function _dist(t1, t2) {
    const dx = t2.clientX - t1.clientX;
    const dy = t2.clientY - t1.clientY;
    return Math.hypot(dx, dy);
  }

  lb.addEventListener('touchstart', (e) => {
    // 2-finger touch = pinch start. Always wins over pan.
    if (e.touches.length === 2) {
      e.preventDefault();
      const [t1, t2] = e.touches;
      const rect = img.getBoundingClientRect();
      pinch = {
        dist: _dist(t1, t2),
        midX: (t1.clientX + t2.clientX) / 2,
        midY: (t1.clientY + t2.clientY) / 2,
        scale0: _lbZoom.scale,
        x0: _lbZoom.x,
        y0: _lbZoom.y,
        // Un-transformed image center in viewport coords (invariant
        // during the gesture since scaling is around image center).
        naturalCx: rect.left + rect.width / 2 - _lbZoom.x,
        naturalCy: rect.top + rect.height / 2 - _lbZoom.y,
      };
      pan = null;
      _lbZoom.gestured = true;
      _lbSetTransition(false);
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    // Detect double-tap BEFORE setting up pan.
    const now = Date.now();
    if (now - _lbZoom.lastTap < 320) {
      e.preventDefault();
      _lbSetTransition(true);
      if (_lbZoom.scale > 1) {
        _lbReset();
      } else {
        _lbZoom.scale = 2.5;
        const rect = img.getBoundingClientRect();
        const tapX = t.clientX - rect.left - rect.width / 2;
        const tapY = t.clientY - rect.top - rect.height / 2;
        _lbZoom.x = -tapX * (_lbZoom.scale - 1);
        _lbZoom.y = -tapY * (_lbZoom.scale - 1);
        _lbApply();
      }
      _lbZoom.lastTap = 0;
      _lbZoom.gestured = true;
      pan = null;
      setTimeout(() => { _lbZoom.gestured = false; }, 350);
      return;
    }
    _lbZoom.lastTap = now;
    // Set up pan from this finger position.
    pan = { fx: t.clientX, fy: t.clientY, x0: _lbZoom.x, y0: _lbZoom.y };
    if (_lbZoom.scale > 1) _lbSetTransition(false);
  }, { passive: false });

  lb.addEventListener('touchmove', (e) => {
    // Pinch in progress — recompute scale + translate so the pinch
    // midpoint stays anchored under the fingers.
    if (e.touches.length === 2 && pinch) {
      e.preventDefault();
      const [t1, t2] = e.touches;
      const newDist = _dist(t1, t2);
      if (newDist <= 0 || pinch.dist <= 0) return;
      const newScale = Math.min(5, Math.max(1, pinch.scale0 * (newDist / pinch.dist)));
      const ratio = newScale / pinch.scale0;
      _lbZoom.scale = newScale;
      _lbZoom.x = (pinch.midX - pinch.naturalCx) * (1 - ratio) + pinch.x0 * ratio;
      _lbZoom.y = (pinch.midY - pinch.naturalCy) * (1 - ratio) + pinch.y0 * ratio;
      if (newScale === 1) { _lbZoom.x = 0; _lbZoom.y = 0; }
      _lbApply();
      return;
    }
    // 1-finger pan when zoomed.
    if (e.touches.length === 1 && pan && _lbZoom.scale > 1) {
      e.preventDefault();
      const t = e.touches[0];
      _lbZoom.x = pan.x0 + (t.clientX - pan.fx);
      _lbZoom.y = pan.y0 + (t.clientY - pan.fy);
      _lbApply();
    }
  }, { passive: false });

  lb.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      pinch = null;
      pan = null;
      // Hold the gesture-suppression flag long enough for the synthetic
      // `click` iOS dispatches after a multi-touch to be swallowed by
      // the lightbox close handler — 50ms was too short on real
      // hardware (click sometimes arrives ~200-300ms post-touchend) and
      // a pinch occasionally collapsed straight back into a close.
      setTimeout(() => {
        _lbZoom.gestured = false;
        _lbSetTransition(true);
      }, 350);
      return;
    }
    if (e.touches.length === 1) {
      // Pinch → single-finger pan transition. Pin a fresh pan anchor
      // to whichever finger is still touching, so dragging picks up
      // smoothly from its current position (no jump).
      pinch = null;
      if (_lbZoom.scale > 1) {
        const t = e.touches[0];
        pan = { fx: t.clientX, fy: t.clientY, x0: _lbZoom.x, y0: _lbZoom.y };
      }
    }
  });
  // Cancel handler — if iOS interrupts the gesture (call, notification,
  // etc.) reset state cleanly so the next touch starts fresh.
  lb.addEventListener('touchcancel', () => {
    pinch = null;
    pan = null;
    _lbZoom.gestured = false;
    _lbSetTransition(true);
  });
})();

$('#lightbox').addEventListener('click', (e) => {
  // Close on ANY single tap inside the lightbox — including on the
  // image itself. Previous version required tapping the dark area
  // around the image; users couldn't always find that gap on
  // full-screen photos and got stuck. The `_lbZoom.gestured` flag
  // still suppresses close right after a pinch or double-tap so
  // those gestures don't accidentally dismiss.
  if (_lbZoom.gestured) return;
  closeLightbox();
});

// ─── Sheets ───────────────────────────────────────────────────────────

function openSheet(id, opts) {
  const s = $('#' + id);
  s.hidden = false;
  // Reset any drag transform from a previous open.
  const panel = s.querySelector('.sheet__panel');
  if (panel) panel.style.transform = '';
  // Show / hide the back-to-parent button based on how the sheet was
  // opened. Sub-sheets opened from the menu (workspace, uploads, history)
  // get a back chevron so the user can return without re-tapping the
  // three-dots. Sheets opened from the topbar/compose row keep it
  // hidden — there's no parent menu to return to.
  const back = panel && panel.querySelector('.sheet__backBtn[data-back]');
  if (back) {
    if (opts && opts.from) {
      back.dataset.parent = opts.from;
      back.hidden = false;
    } else {
      back.dataset.parent = '';
      back.hidden = true;
    }
  }
}
function closeSheet(id) { $('#' + id).hidden = true; }
function closeAllSheets() { $$('.sheet').forEach((s) => (s.hidden = true)); }

$$('.sheet').forEach((sheet) => {
  sheet.addEventListener('click', (e) => {
    // Back-to-parent: close current + open whatever sheet id is on
    // the button's data-parent (set by openSheet's `from` opt).
    const backBtn = e.target.closest('.sheet__backBtn[data-back]');
    if (backBtn) {
      const parent = backBtn.dataset.parent || backBtn.dataset.back;
      closeSheet(sheet.id);
      if (parent) openSheet(parent);
      return;
    }
    // Same robustness as the lightbox handler — closest() catches taps that
    // land on children of [data-close] elements (icon glyphs, padding).
    if (e.target.closest('[data-close]')) {
      closeSheet(sheet.id);
    }
  });

  // Drag-to-close, with native touch events.
  //
  // iOS Safari was the problem: with pointer events bound to the panel,
  // pointermove was not being dispatched while a swipe-down gesture was
  // in progress inside a child with `touch-action: pan-y` (the list).
  // The drag wouldn't update visually until the finger lifted (which
  // fired pointerup → animated close). User couldn't see the panel
  // follow their finger.
  //
  // Native touchmove with `passive: false` lets us call preventDefault
  // and own the gesture even when a child says pan-y, so the visual
  // transform updates on every touchmove. Buttons / inputs / scrolled
  // list content are still bypassed so taps and content-scroll work.
  const panel = sheet.querySelector('.sheet__panel');
  const handle = sheet.querySelector('.sheet__handle');
  if (!panel) return;
  let dragStartY = 0;
  let dragOffset = 0;
  let dragging = false;
  let startedAt = 0;
  let touchId = null;
  function scrollableAncestorAtTop(node) {
    let n = node;
    while (n && n !== panel) {
      if (n.scrollHeight > n.clientHeight + 1) {
        return n.scrollTop <= 0;
      }
      n = n.parentNode;
    }
    return true;
  }
  function shouldStartDrag(target) {
    if (target.closest('[data-close]') && target !== handle && (!handle || !handle.contains(target))) {
      return false;
    }
    if (target.closest('button:not([data-close]), input, textarea, select, a')) {
      return false;
    }
    if (!scrollableAncestorAtTop(target)) {
      return false;
    }
    return true;
  }
  panel.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (!shouldStartDrag(e.target)) return;
    const t = e.touches[0];
    dragging = true;
    touchId = t.identifier;
    dragStartY = t.clientY;
    dragOffset = 0;
    startedAt = Date.now();
    panel.style.transition = 'none';
    // KEY iOS fix (matches basketil/ui/src/App.jsx pattern): the
    // entrance `slideUp` keyframe animation can still be running OR
    // its terminal `transform: translateY(0)` keeps the property
    // "owned" by the animation engine, which beats subsequent
    // inline `style.transform` writes. Clearing animation here
    // releases the property so each touchmove's translateY update
    // actually paints. Without this the panel only moves on release.
    panel.style.animation = 'none';
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = Array.from(e.touches).find((x) => x.identifier === touchId);
    if (!t) return;
    const dy = t.clientY - dragStartY;
    if (dy <= 0) {
      // user pulled back up — snap to origin but don't close
      dragOffset = 0;
      panel.style.transform = '';
      return;
    }
    dragOffset = dy;
    panel.style.transform = `translateY(${dragOffset}px)`;
    // preventDefault tells iOS we're handling this gesture ourselves,
    // so it doesn't scroll the page or fight us for the touch.
    e.preventDefault();
  }, { passive: false });
  function finishDrag() {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    const elapsed = Date.now() - startedAt;
    const fastFlick = dragOffset > 30 && elapsed < 250;
    if (fastFlick || dragOffset > 80) {
      panel.style.transform = 'translateY(100%)';
      setTimeout(() => { closeSheet(sheet.id); panel.style.transform = ''; }, 180);
    } else {
      panel.style.transform = '';
    }
    touchId = null;
  }
  panel.addEventListener('touchend', finishDrag);
  panel.addEventListener('touchcancel', () => {
    dragging = false;
    panel.style.transform = '';
    touchId = null;
  });
});

// Pressing the hardware Escape (where applicable — desktop testing) or
// Safari's back-swipe gesture should never strand the user on an open sheet.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeLightbox(); closeAllSheets(); }
});

// ─── WebSocket ────────────────────────────────────────────────────────

const WS = {
  sock: null,
  backoff: 500,
  closedByUser: false,
  // Watchdog state: every inbound frame updates `lastInboundAt`. The 25s
  // heartbeat (setInterval at the bottom of this file) checks staleness
  // before each ping and force-recycles the socket if the server hasn't
  // sent anything (not even a pong) in >55s. Fixes the "I'm staying in
  // the app and updates just stop arriving until I close+reopen" bug —
  // iOS Safari can leave a WebSocket in a half-dead state where onclose
  // never fires but no frames flow either. Without this watchdog the
  // chat appears frozen until the next visibilitychange wakes things up.
  lastInboundAt: 0,
  // Stale threshold: server-side ping cadence is 25s and we expect a
  // pong back near-immediately, so anything >55s since the last frame
  // means we missed at least one heartbeat round-trip.
  staleThresholdMs: 55000,

  async connect() {
    if (this.sock && (this.sock.readyState === WebSocket.OPEN || this.sock.readyState === WebSocket.CONNECTING)) {
      return;
    }
    // The readyState check above is racy: this method awaits a fetch
    // BEFORE assigning `this.sock`, so two concurrent callers both pass
    // the guard, both await, and both end up creating a WebSocket. On
    // iOS PWA foreground transitions, visibilitychange + pageshow + the
    // 25s heartbeat + the scheduled reconnect can fire within a single
    // tick after a long suspend — without this in-flight flag the page
    // ended up with 4 parallel WebSocket handshakes, which on real
    // hardware destabilized Safari enough to trigger its "A problem
    // repeatedly occurred" reload-loop dialog. Symptom 2026-05-19.
    if (this._connectInFlight) return;
    this._connectInFlight = true;
    this.closedByUser = false;
    setConn('connecting', 'connecting…');

    // iOS Safari in standalone PWA mode sometimes refuses to attach cookies
    // to WSS upgrades. Workaround: fetch a fresh session token via REST
    // (cookie auth is reliable there) and append it to the WSS URL.
    let token = '';
    try {
      setConn('connecting', 'fetching token…');
      const r = await fetch('/api/ws-token', { method: 'POST', headers: CSRF_HEADERS });
      if (r.ok) {
        const d = await r.json();
        token = d.token || '';
      } else if (r.status === 401) {
        setConn('closed', 'session expired');
        // CRITICAL: clear the in-flight flag BEFORE navigating away. The
        // /login navigation kicks off async, but if something blocks it
        // (cross-origin policy, page-already-leaving), the next
        // reconnect attempt sees _connectInFlight=true and silently bails
        // forever. Caught 2026-05-19 in code-review.
        this._connectInFlight = false;
        location.href = '/login';
        return;
      } else {
        setConn('closed', 'token HTTP ' + r.status);
      }
    } catch (e) {
      setConn('closed', 'token fetch: ' + (e.message || 'err'));
    }

    setConn('connecting', token ? 'opening WS…' : 'opening WS (no token)…');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    try {
      this.sock = new WebSocket(url);
    } catch (e) {
      setConn('closed', 'WS ctor: ' + (e.message || 'err'));
      this._connectInFlight = false;
      this._scheduleReconnect();
      return;
    }
    // Clear the in-flight flag now that `this.sock` is assigned — future
    // callers will be blocked by the readyState===CONNECTING/OPEN guard
    // at the top of connect().
    this._connectInFlight = false;
    this.sock.onopen = () => {
      setConn('open');
      this.backoff = 500;
      this.lastInboundAt = Date.now();
      try { _crcCrumb('ws.open', ''); } catch {}
    };
    this.sock.onmessage = (ev) => {
      // Heartbeat-watchdog feed: ANY frame from the server (including
      // bare `pong`s) proves the wire is live. Update before parsing so
      // even malformed frames still reset the staleness timer.
      this.lastInboundAt = Date.now();
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      Chat.handleFrame(frame);
    };
    this.sock.onclose = (ev) => {
      setConn('closed', 'closed code=' + ev.code + (ev.reason ? ' ' + ev.reason : ''));
      try { _crcCrumb('ws.close', `code=${ev.code}`); } catch {}
      if (ev.code === 4401) {
        // Auth lost — bounce to login.
        location.href = '/login';
        return;
      }
      if (!this.closedByUser) {
        // Splash is no longer replayed on WS reconnect — per user
        // feedback (2026-05-15), the animation should fire ONLY on a
        // truly cold launch (the app was fully closed from the
        // app-switcher). Brief WS reconnects during normal
        // background→foreground transitions just retry quietly while
        // the chat stays visible behind the connection-status chip.
        this._scheduleReconnect();
      }
    };
    this.sock.onerror = (e) => {
      setConn('closed', 'WS error');
    };
  },

  _scheduleReconnect() {
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 8000);
  },

  send(frame) {
    if (this.sock && this.sock.readyState === WebSocket.OPEN) {
      this.sock.send(JSON.stringify(frame));
      return true;
    }
    toast('Not connected — reconnecting…', 'warn');
    return false;
  },

  close() {
    this.closedByUser = true;
    if (this.sock) this.sock.close();
  },

  // Health-check + reconnect entry point used by the visibility/pageshow
  // listeners below. When iOS Safari suspends the PWA's JS context in the
  // background, any in-flight `_scheduleReconnect` setTimeout can stall —
  // we wake up to a closed socket and no pending reconnect. Calling this
  // on every foreground transition pokes the connect path back to life
  // without piling on duplicate WebSockets (the early-return inside
  // connect() guards against that).
  ensureLive() {
    if (this.closedByUser) return;
    // If the socket LOOKS connected but no frame has arrived in >55s,
    // it's almost certainly a zombie — iOS Safari sometimes leaves a
    // half-dead WebSocket where onclose never fires. Force-recycle it.
    if (this.sock && this.sock.readyState === WebSocket.OPEN) {
      if (this.lastInboundAt && Date.now() - this.lastInboundAt > this.staleThresholdMs) {
        try { this.sock.close(4001, 'stale'); } catch {}
        // onclose will schedule the reconnect; nothing else to do here.
      }
      return;
    }
    if (this.sock && this.sock.readyState === WebSocket.CONNECTING) return;
    // Reset backoff so a re-foreground after a long background doesn't
    // wait 8s for the first attempt.
    this.backoff = 500;
    this.connect();
  },
};

// iOS PWA background → foreground recovery. Without this, swiping the app
// away mid-run and coming back leaves the UI frozen: the WebSocket closed
// while suspended, the auto-reconnect's setTimeout was cancelled by iOS,
// and `_wsRunInFlight` is still true so the jsonl-poll fallback can't
// surface what claude wrote during the suspension. Two listeners cover
// both transition events the browser fires:
//   - `visibilitychange` fires on every tab/app switcher swap.
//   - `pageshow` with persisted=true fires on bfcache restore (Safari).
// On any wake event: poke WS.ensureLive(), and clear stuck _wsRunInFlight
// across every tab so the jsonl tail can resurface in-flight runs even
// if the WS reconnect is slow.
function _onAppResume() {
  if (typeof WS !== 'undefined' && WS.ensureLive) {
    try { WS.ensureLive(); } catch {}
  }
  // If any tab still has _wsRunInFlight pinned from before the
  // suspension, clear it so the jsonl-poll fallback resumes — the
  // server's session-messages endpoint will replay events from the
  // tab's last tail_offset, which is the only way to recover events
  // emitted while we were backgrounded with the WS dead.
  try {
    if (typeof State !== 'undefined' && Array.isArray(State.tabs)) {
      for (const t of State.tabs) {
        if (t && t._wsRunInFlight) t._wsRunInFlight = false;
      }
    }
  } catch {}
  // Notification cleanup: any "Claude finished" banners the SW dropped
  // into iOS notification center while the app was backgrounded are
  // now stale — the user IS in the app, they don't need to be told
  // again. Sweep them out of the OS shade. Best-effort: a browser
  // without serviceWorker / Notification simply skips.
  try { _clearVisibleNotifications(); } catch {}
}

// Tell the service worker registration to close every visible
// notification it has shown. iOS PWA: this clears the lock-screen and
// notification-center banners the user just dismissed by opening the
// app. Called on every visibilitychange-visible, pageshow-bfcache,
// and once on cold boot (in case the launch path is "tap the home-
// screen icon and there were unread notifications waiting"). Quietly
// skips if Push isn't supported in this browser or the SW hasn't
// finished registering yet.
function _clearVisibleNotifications() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration('/sw.js')
    .then((reg) => {
      if (!reg || !reg.getNotifications) return;
      return reg.getNotifications();
    })
    .then((notifs) => {
      if (!notifs) return;
      for (const n of notifs) {
        try { n.close(); } catch {}
      }
    })
    .catch(() => {});
}
// When the PWA goes to the background, snapshot tab state immediately
// so the user's latest draft / latest active tab / latest queued items
// land in localStorage BEFORE iOS suspends the JS context. The boot
// path on the next launch decides (via TAB_RESTORE_TTL_MS) whether to
// restore or wipe. Without this hook we'd lose anything typed since
// the last create/switch/close — those are the only events that call
// _persistTabs during normal use.
function _onAppBackground() {
  try {
    const tab = getActiveTab();
    if (tab && typeof input !== 'undefined' && input) {
      tab.draft = input.value || '';
    }
  } catch {}
  try { _persistTabs(); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _onAppResume();
  else if (document.visibilityState === 'hidden') _onAppBackground();
});
window.addEventListener('pagehide', () => { _onAppBackground(); });
window.addEventListener('pageshow', (e) => {
  // pageshow.persisted=true means bfcache restore (Safari standalone).
  if (e.persisted) _onAppResume();
});

function setConn(state, detail) {
  const s = $('#connStatus');
  s.dataset.state = state === 'open' ? 'open' : state === 'connecting' ? 'connecting' : 'closed';
  const label = detail
    || (state === 'open' ? 'connected'
        : state === 'connecting' ? 'connecting…'
        : 'disconnected');
  s.textContent = label;
  // Mirror to the ⋯ menu status row (which is what the user actually
  // SEES — the inline #connStatus is hidden, kept only so any legacy
  // mutation paths don't crash).
  const m = document.getElementById('menuStatus');
  if (m) {
    m.textContent = 'Status: ' + label;
    m.setAttribute('data-state',
      state === 'open' ? 'connected'
      : state === 'connecting' ? 'connecting'
      : 'disconnected');
  }
}

// ─── Markdown rendering ───────────────────────────────────────────────
//
// Focused markdown→HTML for streaming assistant text. We re-render the
// whole body on each delta — Claude streams a few tokens at a time, so
// this stays cheap. The renderer handles fenced code blocks (with copy
// + "Show full" affordances), inline code, headings, bold/italic, lists,
// links, blockquotes, and paragraphs. Everything is HTML-escaped before
// being interpreted as markdown, so a stray `<script>` in claude's
// output can't execute.
//
// Streaming edge case: a fenced code block may be mid-emission (opening
// ``` seen but closing ``` not yet). We treat any trailing unclosed
// fence as an open code block so the UI doesn't briefly render the
// opening backticks as literal text while waiting for the close.
const _MD_NUL = ' ';

function _escapeHtml(s) {
  return s.replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
}

// Pick a base direction for a markdown block based on character-count
// dominance, NOT first-strong-character. The default HTML dir="auto"
// algorithm picks the first strong-direction character, which fails for
// the common Claude pattern where a Hebrew paragraph happens to start
// with an English brand name ("**Claude Code** מאפשר לך..."): UBA picks
// LTR from the leading "C" and the entire paragraph renders left-aligned
// with the Hebrew flowing the wrong way. Reported by user 2026-05-19.
//
// Heuristic: count strong-RTL characters (Hebrew, Arabic, related
// scripts) vs strong-LTR characters (Latin). Whichever script has more
// characters wins. Ties fall back to `auto` so legacy first-strong
// behaviour kicks in (covers symbol-only blocks).
function _resolveBlockDir(text) {
  if (!text) return 'auto';
  // Strip the things that aren't real prose before counting:
  //   1. HTML tags written by earlier markdown steps (bold, italic,
  //      links) — `<strong>` / `<em>` / `<a>` are ASCII markup that
  //      would skew toward LTR.
  //   2. Markdown-renderer placeholder tokens for fenced code blocks
  //      and inline code (`\0CB<n>\0`, `\0IC<n>\0`). The letters CB/IC
  //      inside the placeholder are uppercase Latin and would otherwise
  //      tip a Hebrew paragraph that mentions code (very common with
  //      Claude's technical responses) toward LTR even though the
  //      surrounding prose is Hebrew.
  //   3. HTML entities (`&gt;`, `&amp;`, `&#x27;`) — these are
  //      punctuation, not language.
  const plain = String(text)
    .replace(/ (?:CB|IC)\d+ /g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, ' ');
  let rtl = 0;
  let ltr = 0;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    // Hebrew + Arabic + Syriac + Thaana + N'Ko (the contiguous RTL-script
    // block) plus the Hebrew/Arabic presentation forms.
    if ((code >= 0x0590 && code <= 0x08FF) ||
        (code >= 0xFB1D && code <= 0xFDFF) ||
        (code >= 0xFE70 && code <= 0xFEFC)) {
      rtl++;
    } else if ((code >= 0x0041 && code <= 0x005A) ||
               (code >= 0x0061 && code <= 0x007A) ||
               (code >= 0x00C0 && code <= 0x024F)) {
      // Basic Latin uppercase + lowercase, Latin-1 Supplement,
      // Latin Extended-A/B. CJK + digits + punctuation are neutral
      // (don't sway the decision either way).
      ltr++;
    }
  }
  // Bias toward RTL when ANY meaningful Hebrew/Arabic content exists.
  // The user's primary language is Hebrew, so a sentence that READS
  // as Hebrew (with embedded English brand names, technical terms,
  // or inline code references) should align RTL even when the raw
  // character count tips slightly LTR — Hebrew letters carry more
  // semantic weight per character than English brand names do.
  // A 3-to-1 multiplier captures "this is a Hebrew sentence with a
  // few embedded English terms" while still letting genuinely
  // English-dominant sentences (e.g. "Item one in English with עברית
  // in the middle") resolve LTR. Reported by user 2026-05-19.
  if (rtl >= 2 && ltr <= rtl * 3) return 'rtl';
  if (ltr > 0) return 'ltr';
  if (rtl > 0) return 'rtl';
  return 'auto';
}

// COMPANION to `_resolveBlockDir`: that function runs DURING markdown
// rendering and stamps a `dir="rtl"|"ltr"` attribute on each block.
// `_enforceBlockDir` runs AFTER the resulting HTML is committed to the
// DOM and additionally writes `style.direction` + `style.text-align`
// inline. They cooperate to give three layered defenses against iOS
// Safari's bidi-cache quirks; see the long comment below.
//
// Post-render walker that explicitly stamps `style.direction` and
// `style.text-align` on every block element produced by _renderMarkdown.
// This is the BULLETPROOF version of the bidi enforcement:
//
//   - The HTML `dir="rtl"` attribute sets `direction: rtl` on the element
//   - The CSS rule `.msg__body p[dir="rtl"] { direction: rtl; }` reinforces it
//   - This JS walker writes inline `style="direction: rtl"` which has the
//     HIGHEST CSS specificity (defeats any cascade quirk)
//
// Three layers because iOS Safari standalone PWAs (which is the only
// place this code ever runs) have been observed holding stale computed-
// direction for `<p>` and `<blockquote>` elements across innerHTML
// replacement when the dir attribute is the same SHAPE as before but
// the layout was originally computed with a different ancestor
// direction. Setting `el.style.direction` programmatically forces a
// recompute that the static attribute alone doesn't always trigger.
// Reported by user 2026-05-19 — even after /refresh, paragraphs 2 and 3
// of an assistant message kept rendering LTR while paragraph 1
// rendered RTL, despite all three having identical structure and
// dir="rtl" attribute. Inline style fixed it. Belt-and-braces.
// Arrow / chevron characters whose visual direction is the OPPOSITE of
// their RTL reading flow. In a Hebrew paragraph, "step A → step B" reads
// right-to-left, but `→` is a non-bidi character that keeps pointing
// right regardless of paragraph direction — which contradicts the
// reading order. We swap them so the arrow visually flows the same way
// the eye scans. Code blocks are not walked, so `=>`, `->`, `<-` in
// fenced code stay literal.
const _RTL_ARROW_SWAP = {
  '→': '←', // → ↔ ←
  '←': '→', // ← ↔ →
  '⇒': '⇐', // ⇒ ↔ ⇐
  '⇐': '⇒', // ⇐ ↔ ⇒
  '➜': '⬅', // ➜ ↔ ⬅
  '»': '«', // » ↔ «
  '«': '»', // « ↔ »
};
const _RTL_ARROW_RE = /[→←⇒⇐➜»«]/g;

function _mirrorArrowsInRtlText(el) {
  // Walk only text nodes — skip <code>, <pre>, and <a> children so
  // copy-able tokens (URLs, code) stay byte-identical to what claude
  // produced.
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      let p = n.parentNode;
      while (p && p !== el) {
        const tag = p.nodeName;
        if (tag === 'CODE' || tag === 'PRE' || tag === 'A') return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return _RTL_ARROW_RE.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    n.nodeValue = n.nodeValue.replace(_RTL_ARROW_RE, (c) => _RTL_ARROW_SWAP[c] || c);
  }
}

function _enforceBlockDir(root) {
  if (!root || !root.querySelectorAll) return;
  const selector = 'p, li, blockquote, h1, h2, h3, h4, h5, h6';
  for (const el of root.querySelectorAll(selector)) {
    const d = _resolveBlockDir(el.textContent || '');
    if (d === 'rtl') {
      el.dir = 'rtl';
      el.style.direction = 'rtl';
      el.style.textAlign = 'right';
      _mirrorArrowsInRtlText(el);
    } else if (d === 'ltr') {
      el.dir = 'ltr';
      el.style.direction = 'ltr';
      el.style.textAlign = 'left';
    }
  }
}

function _renderMarkdown(text) {
  if (!text) return '';
  // 1. Extract fully-closed fenced code blocks first so their contents
  //    aren't mangled by other regex steps.
  const codeBlocks = [];
  let working = text.replace(/```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || '', code });
    return `${_MD_NUL}CB${idx}${_MD_NUL}`;
  });
  // 1b. Then catch a single trailing UNCLOSED fence (mid-stream).
  const openMatch = working.match(/```([A-Za-z0-9_+-]*)\n?([\s\S]*)$/);
  if (openMatch) {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: openMatch[1] || '', code: openMatch[2] || '' });
    working = working.slice(0, openMatch.index) + `${_MD_NUL}CB${idx}${_MD_NUL}`;
  }
  // 2. Extract inline code spans.
  const inlineCodes = [];
  working = working.replace(/`([^`\n]+)`/g, (m, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `${_MD_NUL}IC${idx}${_MD_NUL}`;
  });
  // 3. Escape HTML on the remaining surface text.
  let html = _escapeHtml(working);
  // 4. Headings. Per-block dir resolved by character-count majority via
  //    _resolveBlockDir — see its definition above. A Hebrew heading
  //    with an English brand at the start (`## **Claude Code**…`) still
  //    resolves RTL because the Hebrew text outweighs the English brand.
  html = html.replace(/^####\s+(.+)$/gm, (m, t) => `<h3 dir="${_resolveBlockDir(t)}">${t}</h3>`);
  html = html.replace(/^###\s+(.+)$/gm,  (m, t) => `<h3 dir="${_resolveBlockDir(t)}">${t}</h3>`);
  html = html.replace(/^##\s+(.+)$/gm,   (m, t) => `<h2 dir="${_resolveBlockDir(t)}">${t}</h2>`);
  html = html.replace(/^#\s+(.+)$/gm,    (m, t) => `<h1 dir="${_resolveBlockDir(t)}">${t}</h1>`);
  // 5. Horizontal rules.
  html = html.replace(/^---+\s*$/gm, '<hr>');
  // 6. Bold / italic. Bold first so its inner asterisks aren't eaten.
  html = html.replace(/\*\*([^\n][^*\n]*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  // Italic — require a non-word boundary on the outside so we don't eat
  // characters mid-identifier (e.g. `foo_bar_baz` shouldn't become em).
  html = html.replace(/(^|[\s(\[{])\*([^*\n]+?)\*(?=[\s.,;:)!?\]}\-]|$)/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(\[{])_([^_\n]+?)_(?=[\s.,;:)!?\]}\-]|$)/g, '$1<em>$2</em>');
  // 7. Links.
  // URL scheme allowlist. Claude controls its own output — if it ever
  // emits `[click](javascript:alert(1))` (intentionally or via an
  // ingested poisoned tool result) the produced anchor would execute
  // arbitrary JS in the page origin on tap. Defence-in-depth: allow
  // only http(s) + mailto, otherwise render the text without a link.
  html = html.replace(/\[([^\]\n]+)\]\(([^)\s\n]+)\)/g, (_, label, url) => {
    const ok = /^(https?:|mailto:|\/|#|\.{0,2}\/)/i.test(url);
    if (!ok) return label;
    return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
  });
  // 7b. Auto-linkify bare URLs in prose (`/usage` output, "visit
  // https://console.anthropic.com/usage", etc.). Must run AFTER the
  // markdown-link replacement so URLs already wrapped in `<a href>`
  // aren't re-wrapped. Excludes URLs preceded by `"`, `'`, `=`, or
  // word-chars (those are inside attributes / already linked / part
  // of an identifier). Trailing punctuation like `.,;:!?)` is
  // stripped from the URL and left outside the link.
  html = html.replace(/(^|[^"'=\w/])(https?:\/\/[^\s<>"')]+)/g, (_, prefix, url) => {
    let trail = '';
    while (url.length && /[.,;:!?)\]}>]/.test(url[url.length - 1])) {
      trail = url[url.length - 1] + trail;
      url = url.slice(0, -1);
    }
    return `${prefix}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
  });
  // 8. Lists. Per-item dir from _resolveBlockDir so each item picks its
  //    own direction from its dominant script.
  html = html.replace(/(?:^|\n)((?:[ \t]*[-*]\s+[^\n]*(?:\n|$))+)/g, (m, blob) => {
    const items = blob.trim().split('\n').map((line) => {
      const cleaned = line.replace(/^[ \t]*[-*]\s+/, '');
      return `<li dir="${_resolveBlockDir(cleaned)}">${cleaned}</li>`;
    }).join('');
    return `\n<ul>${items}</ul>`;
  });
  html = html.replace(/(?:^|\n)((?:[ \t]*\d+\.\s+[^\n]*(?:\n|$))+)/g, (m, blob) => {
    const items = blob.trim().split('\n').map((line) => {
      const cleaned = line.replace(/^[ \t]*\d+\.\s+/, '');
      return `<li dir="${_resolveBlockDir(cleaned)}">${cleaned}</li>`;
    }).join('');
    return `\n<ol>${items}</ol>`;
  });
  // 9. Blockquotes.
  // NOTE: this regex runs AFTER _escapeHtml(), so the literal `>` from
  // markdown source has already been encoded to `&gt;`. Match the
  // entity, not the raw character — otherwise blockquotes silently
  // render as plain text with a leading `>` and inherit the paragraph
  // path (which defeats their custom styling AND their per-block dir).
  html = html.replace(/(?:^|\n)((?:&gt;\s?[^\n]*(?:\n|$))+)/g, (m, blob) => {
    const inner = blob.trim().split('\n').map((line) => line.replace(/^&gt;\s?/, '')).join('<br>');
    return `\n<blockquote dir="${_resolveBlockDir(inner)}">${inner}</blockquote>`;
  });
  // 9b. Pipe tables. GFM-style:
  //     | head1 | head2 |
  //     |-------|:-----:|     ← separator row (alignment markers optional)
  //     | r1c1  | r1c2  |
  //     | r2c1  | r2c2  |
  //     The separator row's `:` markers control column alignment
  //     (`:---` left, `:---:` center, `---:` right). Bold/italic/links
  //     have already been processed above, so cells already contain
  //     <strong>/<em>/<a> — fine inside <td>. The whole table is
  //     wrapped in a <div class="md-tableWrap"> so wide tables can
  //     horizontally scroll on a phone screen instead of overflowing
  //     the chat pane.
  html = html.replace(
    /(^|\n)(\|[^\n]+\|)\n(\|[\s:|\-]+\|)\n((?:\|[^\n]+\|(?:\n|$))+)/g,
    (m, lead, headerLine, sepLine, bodyLines) => {
      const parseRow = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
      const headerCells = parseRow(headerLine);
      const aligns = parseRow(sepLine).map((s) => {
        const ls = s.startsWith(':');
        const rs = s.endsWith(':');
        if (ls && rs) return 'center';
        if (rs) return 'right';
        if (ls) return 'left';
        return '';
      });
      const rows = bodyLines.trim().split('\n').map(parseRow);
      let out = lead + '<div class="md-tableWrap"><table class="md-table"><thead><tr>';
      // Table cells stay on plain dir="auto" (NOT the character-count
      // heuristic the rest of the renderer uses). Cells typically hold
      // 1-3 words — too little signal for the count to be meaningful,
      // and the user-supplied alignment markers (:--- / ---: / :---:)
      // already control text-align per-column. See
      // skills/bidi-mixed-hebrew-english.md.
      headerCells.forEach((c, i) => {
        const a = aligns[i] || '';
        out += '<th dir="auto"' + (a ? ' style="text-align:' + a + '"' : '') + '>' + c + '</th>';
      });
      out += '</tr></thead><tbody>';
      rows.forEach((row) => {
        out += '<tr>';
        headerCells.forEach((_, i) => {
          const a = aligns[i] || '';
          out += '<td dir="auto"' + (a ? ' style="text-align:' + a + '"' : '') + '>' + (row[i] || '') + '</td>';
        });
        out += '</tr>';
      });
      out += '</tbody></table></div>';
      return out;
    },
  );
  // 10. Paragraphs (split on blank lines). Keep block-level tags
  //     unwrapped so we don't end up with <p><h1>… etc. Per-paragraph
  //     dir resolved by majority script via _resolveBlockDir — this
  //     fixes the Claude-pattern bug where a Hebrew paragraph starts
  //     with an English brand ("**Claude Code** מאפשר...") and the
  //     default first-strong-character UBA picked LTR.
  const blockOpen = /^<(h[1-6]|ul|ol|pre|hr|blockquote|div)/i;
  const paragraphs = html.split(/\n{2,}/);
  html = paragraphs.map((p) => {
    const t = p.trim();
    if (!t) return '';
    if (blockOpen.test(t)) return t;
    if (t.startsWith(_MD_NUL)) return t;
    const inner = t.replace(/\n/g, '<br>');
    return `<p dir="${_resolveBlockDir(inner)}">${inner}</p>`;
  }).join('');
  // 11. Restore inline code.
  html = html.replace(new RegExp(`${_MD_NUL}IC(\\d+)${_MD_NUL}`, 'g'), (m, idx) => {
    const code = _escapeHtml(inlineCodes[Number(idx)]);
    return `<code class="md-code">${code}</code>`;
  });
  // 12. Restore code blocks as full cards with header + copy + expand.
  html = html.replace(new RegExp(`${_MD_NUL}CB(\\d+)${_MD_NUL}`, 'g'), (m, idx) => {
    const { lang, code } = codeBlocks[Number(idx)];
    const escaped = _escapeHtml(code);
    const label = lang || 'code';
    return (
      '<div class="md-pre" data-expanded="false" data-overflow="false">' +
        '<div class="md-pre__head">' +
          `<span class="md-pre__lang">${_escapeHtml(label)}</span>` +
          '<button class="md-pre__copyBtn" type="button" data-copy-code="1" aria-label="Copy code">' +
            '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>' +
            '<span>copy</span>' +
          '</button>' +
        '</div>' +
        `<div class="md-pre__body"><code class="md-codeblock">${escaped}</code></div>` +
        '<button class="md-pre__expandBtn" type="button" data-expand-code="1">Show full</button>' +
      '</div>'
    );
  });
  return html;
}

// After re-rendering markdown into a body, walk new .md-pre elements and
// set data-overflow="true" on any whose code body exceeds its collapsed
// max-height. CSS uses that attribute to reveal the "Show full" button.
function _flagCodeBlockOverflow(container) {
  if (!container) return;
  container.querySelectorAll('.md-pre').forEach((pre) => {
    const body = pre.querySelector('.md-pre__body');
    if (!body) return;
    // scrollHeight > clientHeight means content was clipped by max-height.
    if (body.scrollHeight - body.clientHeight > 2) {
      pre.setAttribute('data-overflow', 'true');
    } else {
      pre.setAttribute('data-overflow', 'false');
    }
  });
}

// Event delegation for code-block actions. Lives on document because
// chatpanes come and go and rebinding per-tab would be tedious.

// ─── Stray-navigation guard ──────────────────────────────────────────
// iOS Safari's data detector turns dates/paths/emails inside Claude's
// output into tappable phantom links. An accidental tap on one used to
// strand the user on FastAPI's `{"detail":"not found"}` JSON page —
// the PWA navigated away and there's no in-app back button on iOS.
// This capture-phase listener intercepts any same-origin click that
// would navigate outside the small allow-list of endpoints we actually
// own (/, /login, /api/*, /media/*, /static/*) and cancels it before
// the browser commits the navigation. External (different-origin)
// links are opened in a new tab via target=_blank so they don't kick
// the PWA off its root URL either.
const _NAV_ALLOWLIST = /^\/(?:c|login|api\/|media\/|static\/|runtime-config\.js|manifest\.webmanifest|icons\/|fonts\/)?$|^\/(?:c|login|api|media|static|icons|fonts)(?:\/|$|\?)/;
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  // Empty / hash-only / javascript: links — let them through.
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
  let url;
  try { url = new URL(href, location.href); } catch { return; }
  if (url.origin !== location.origin) {
    // External: open in a new tab so the PWA stays put.
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    return;
  }
  // Same origin. Allow our known endpoints; block everything else
  // (these are almost certainly Safari-data-detected phantom links).
  if (_NAV_ALLOWLIST.test(url.pathname)) return;
  e.preventDefault();
  e.stopPropagation();
  try { toast('Tap ignored — that text isn’t a real link', 'info'); } catch {}
}, true);

document.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('[data-copy-code]');
  if (copyBtn) {
    const pre = copyBtn.closest('.md-pre');
    const code = pre && pre.querySelector('code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent || '');
      copyBtn.setAttribute('data-copied', 'true');
      const lbl = copyBtn.querySelector('span');
      if (lbl) lbl.textContent = 'copied';
      setTimeout(() => {
        copyBtn.removeAttribute('data-copied');
        if (lbl) lbl.textContent = 'copy';
      }, 1500);
    } catch {
      toast('Copy failed', 'error');
    }
    return;
  }
  const expandBtn = e.target.closest('[data-expand-code]');
  if (expandBtn) {
    const pre = expandBtn.closest('.md-pre');
    if (!pre) return;
    const expanded = pre.getAttribute('data-expanded') === 'true';
    pre.setAttribute('data-expanded', expanded ? 'false' : 'true');
    expandBtn.textContent = expanded ? 'Show full' : 'Collapse';
  }
});

// ─── Long-press popover for user messages ─────────────────────────────
// Mobile UX pattern lifted from Claude.ai / iMessage: hold a finger on
// your own message → a small floating menu pops up with Copy / Edit.
// Done with a touchstart timer (500ms hold) plus an 8px move tolerance
// so a scroll-drag doesn't trigger it. preventDefault on the timer
// callback suppresses iOS's native "select word" menu so the two
// affordances don't fight.

// Track the live popover so we can dismiss it before opening another.
// Also track which message is "popped" so we can drop its lift effect
// when the popover closes.
let _activePopover = null;
let _activePoppedMsg = null;

function _dismissPopover() {
  if (_activePopover) {
    _activePopover.classList.remove('msgPopover--open');
    const pop = _activePopover;
    setTimeout(() => { if (pop.parentNode) pop.parentNode.removeChild(pop); }, 160);
    _activePopover = null;
  }
  if (_activePoppedMsg) {
    _activePoppedMsg.classList.remove('msg--popped');
    _activePoppedMsg = null;
  }
}

function _copyToClipboard(text, label) {
  if (!text || !text.trim()) { toast('Nothing to copy', 'warn'); return; }
  const done = () => toast(label || 'Copied to clipboard', 'info');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => _fallbackCopy(text, done));
  } else {
    _fallbackCopy(text, done);
  }
}
function _fallbackCopy(text, done) {
  // navigator.clipboard requires a secure context (HTTPS or localhost).
  // For plain-HTTP Tailscale, fall back to execCommand via a hidden
  // textarea. Old API but universally supported.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); }
  catch { toast('Copy failed', 'error'); }
  document.body.removeChild(ta);
}

function _showPopover(anchorEl, items, touchPos) {
  _dismissPopover();
  const pop = document.createElement('div');
  pop.className = 'msgPopover';
  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msgPopover__item' + (it.destructive ? ' msgPopover__item--destructive' : '');
    // Icon is a raw SVG literal supplied by the caller — inserted as
    // HTML. Label goes through textContent so a future caller passing
    // server-derived text (filename, project name, tool output) can
    // never inject HTML/JS through the popover.
    btn.insertAdjacentHTML('afterbegin', it.icon || '');
    const labelEl = document.createElement('span');
    labelEl.textContent = String(it.label ?? '');
    btn.appendChild(labelEl);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _dismissPopover();
      try { it.action(); } catch {}
    });
    pop.appendChild(btn);
  }
  document.body.appendChild(pop);
  _activePopover = pop;
  // Lift the message visually so the popover feels anchored to it.
  // CSS for .msg--popped does the scale + soft shadow.
  if (anchorEl) {
    anchorEl.classList.add('msg--popped');
    _activePoppedMsg = anchorEl;
  }

  const popRect = pop.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left;
  let top;
  if (touchPos && typeof touchPos.x === 'number') {
    // Anchor near the finger that triggered the long-press. This is the
    // only positioning strategy that works for tall tool cards (Bash
    // with a long stdout panel, Read with a giant file) where the card
    // extends past the viewport in both directions — there's no "top"
    // or "bottom" edge of the anchor within sight, so popping near the
    // finger is the only thing guaranteed to be visible.
    left = touchPos.x - popRect.width / 2;
    top = touchPos.y + 16;                      // just below the finger
    if (top + popRect.height > vh - 8) {
      top = touchPos.y - popRect.height - 16;   // flip above
    }
  } else {
    // Fallback when there's no touch position (right-click, programmatic
    // trigger): anchor at the visible portion of the element's rect.
    const rect = anchorEl.getBoundingClientRect();
    const clippedBottom = Math.min(rect.bottom, vh - 8);
    const clippedTop = Math.max(rect.top, 8);
    left = rect.right - popRect.width;
    top = clippedBottom + 8;
    if (top + popRect.height > vh - 8) {
      top = clippedTop - popRect.height - 8;
    }
  }
  if (left < 8) left = 8;
  if (left + popRect.width > vw - 8) left = vw - popRect.width - 8;
  if (top < 8) top = 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  // Spring-in animation. CSS handles the transition; we just flip the
  // class on the next frame so it's not at the destination yet.
  requestAnimationFrame(() => pop.classList.add('msgPopover--open'));

  // Dismiss on any tap outside.
  const onTap = (e) => {
    if (pop.contains(e.target)) return;
    _dismissPopover();
    document.removeEventListener('click', onTap, true);
    document.removeEventListener('touchstart', onTap, true);
  };
  // Arm the outside-tap dismiss listeners only AFTER the user lifts the
  // finger that triggered the popover. Without this, iOS synthesizes a
  // `click` ~300ms after touchend (the legacy 300ms click-delay) which
  // immediately dismissed the popover before the user could read it.
  // We wait for the first touchend, then add the dismiss listeners.
  const armDismissListeners = () => {
    // Tiny extra delay so the synthetic click after touchend doesn't
    // race the listener attach.
    setTimeout(() => {
      document.addEventListener('click', onTap, true);
      document.addEventListener('touchstart', onTap, true);
    }, 350);
  };
  // If the touch already ended by the time we got here (e.g. a
  // right-click on desktop), arm immediately. Otherwise wait.
  let armed = false;
  const onceTouchEnd = () => {
    if (armed) return;
    armed = true;
    document.removeEventListener('touchend', onceTouchEnd, true);
    document.removeEventListener('touchcancel', onceTouchEnd, true);
    armDismissListeners();
  };
  document.addEventListener('touchend', onceTouchEnd, true);
  document.addEventListener('touchcancel', onceTouchEnd, true);
  // Desktop / no-touch fallback: if no touchend fires in 600ms, arm
  // the dismiss listeners anyway so the popover can be closed.
  setTimeout(() => { if (!armed) onceTouchEnd(); }, 600);
}

// Long-press wiring used by user messages (Copy + Edit popover).
// `getText` is a callable returning the latest message text.
//
// Touch-target rule (per user request):
//   - Long-press on the WORD/text → fall through to iOS's native
//     selection menu (so the user can copy a single line).
//   - Long-press on the bubble's SURFACE (padding around the text) →
//     fires our Copy/Edit popover.
// We tell the two apart by inspecting `e.target` at touchstart: if it
// lands inside `.msg__bubbleText`, the native selection wins; otherwise
// we arm the long-press timer.
function attachMessageLongPress(msgEl, getText, opts) {
  if (!msgEl) return;
  const o = opts || {};
  let timer = 0;
  let cancelled = false;
  let startX = 0, startY = 0;

  // Modernized icons — thinner strokes, more breathing room. Match the
  // anti-slop checklist in skills/ui_taste_design/.
  const COPY_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg>';
  const EDIT_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
  const DELETE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

  function buildItems() {
    const text = typeof getText === 'function' ? getText() : getText;
    const items = [{
      label: 'Copy', icon: COPY_ICON, action: () => _copyToClipboard(text, 'Copied to clipboard'),
    }];
    if (o.editable) {
      // Callers can override the default chat-history Edit/Delete with
      // their own handlers (e.g. queued bubbles need queue-aware actions
      // that pull text back into the composer / drop from the queue,
      // NOT the chat-history edit-and-resend flow).
      items.push({
        label: 'Edit', icon: EDIT_ICON,
        action: o.onEdit ? o.onEdit : () => _enterMessageEdit(msgEl, text),
      });
    }
    // Delete is offered on every user bubble (and any element that opts
    // into editable=true). The action is destructive — it removes the
    // bubble from the chat view immediately, no confirm prompt (matches
    // iMessage's tap-and-it-is-gone). The underlying claude jsonl on
    // disk still has the turn, so a session replay will show it again
    // — this is a "hide from view" operation, not a history rewrite.
    if (o.editable) {
      items.push({
        label: 'Delete', icon: DELETE_ICON, destructive: true,
        action: o.onDelete ? o.onDelete : () => _deleteUserMessage(msgEl),
      });
    }
    return items;
  }

  msgEl.addEventListener('touchstart', (e) => {
    // If the user is already editing THIS message, the long-press
    // handler must NOT swallow the touch — iOS's native double-tap +
    // selection handles inside the textarea need to fire so the user
    // can highlight / copy / paste text in the editor.
    if (msgEl.classList.contains('msg--editing')) {
      cancelled = true;
      return;
    }
    // Long-press fires anywhere on a user message — text-selection is
    // suppressed via CSS (`user-select: none` on the whole bubble), so
    // iOS never starts its native highlighter and the popover wins.
    // The composer's <textarea> is the place where text selection
    // happens, which is where Edit places the message.
    cancelled = false;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    const touchPos = { x: startX, y: startY };
    timer = setTimeout(() => {
      if (cancelled) return;
      try { if (navigator.vibrate) navigator.vibrate(20); } catch {}
      try { e.preventDefault(); } catch {}
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) sel.removeAllRanges();
      } catch {}
      _showPopover(msgEl, buildItems(), touchPos);
    }, 500);
  }, { passive: false });
  msgEl.addEventListener('touchmove', (e) => {
    if (cancelled) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) {
      cancelled = true;
      clearTimeout(timer);
    }
  }, { passive: true });
  msgEl.addEventListener('touchend', () => {
    cancelled = true;
    clearTimeout(timer);
  });
  msgEl.addEventListener('touchcancel', () => {
    cancelled = true;
    clearTimeout(timer);
  });
  // Desktop fallback: right-click → same popover. Saves us a separate
  // affordance for non-touch users. Skip while editing so the
  // browser's own context menu (paste/select-all) wins inside the
  // textarea.
  msgEl.addEventListener('contextmenu', (e) => {
    if (msgEl.classList.contains('msg--editing')) return;
    e.preventDefault();
    _showPopover(msgEl, buildItems());
  });
}

// ─── Deleted-message persistence ─────────────────────────────────────
//
// When the user long-press → Delete on a user bubble, we ALSO record
// the message's text signature in localStorage so a session replay
// (close + reopen, /sessions drawer reload, etc.) doesn't re-render
// the bubble. The bridge's session jsonl on disk still has the turn —
// this is a chat-UI "hide forever" operation, not a server-side
// history rewrite.
//
// Scoping: (sessionId, djb2(text)). Two reasons:
//   - sessionId scope means a delete in chat A doesn't suppress an
//     identical message in chat B
//   - text-hash means duplicate messages within the same session
//     (e.g. user sent the same prompt twice) both get hidden, which is
//     acceptable — the next live send WITHOUT `replay:true` still
//     renders, so re-asking the same thing still works.
const DELETED_MSGS_KEY = 'crc.deletedMsgs';

function _msgSignature(text) {
  if (!text) return 'e';
  // djb2: sync, fast, collision-resistant enough for per-session hashes.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function _readDeletedMsgsMap() {
  try {
    const raw = localStorage.getItem(DELETED_MSGS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}

function _writeDeletedMsgsMap(m) {
  try { localStorage.setItem(DELETED_MSGS_KEY, JSON.stringify(m)); } catch {}
}

function _isMsgDeletedFromHistory(sessionId, text) {
  if (!sessionId || !text) return false;
  const m = _readDeletedMsgsMap();
  const arr = m[sessionId];
  return Array.isArray(arr) && arr.includes(_msgSignature(text));
}

function _markMsgDeletedInHistory(sessionId, text) {
  if (!sessionId || !text) return;
  const m = _readDeletedMsgsMap();
  if (!Array.isArray(m[sessionId])) m[sessionId] = [];
  const sig = _msgSignature(text);
  if (!m[sessionId].includes(sig)) {
    m[sessionId].push(sig);
    _writeDeletedMsgsMap(m);
  }
}

// Hide a user message from the chat view. Triggered from the long-press
// popover's Delete action. Animates out with a brief opacity/scale fade
// so the deletion feels intentional (not a glitch). ALSO persists the
// deletion to localStorage so close + reopen doesn't re-render the
// bubble (the bridge's session jsonl on disk still has the turn —
// this is a chat-UI "hide forever" operation, see the
// "Deleted-message persistence" block above).
function _deleteUserMessage(msgEl) {
  if (!msgEl || !msgEl.parentNode) return;
  try {
    const tab = getActiveTab();
    const text = msgEl.dataset.text || '';
    if (tab && tab.sessionId && text) {
      _markMsgDeletedInHistory(tab.sessionId, text);
    }
  } catch {}
  // If we were mid-edit on this message, exit edit mode first so the
  // crc-editing body class + composer hide-state get cleaned up.
  try { if (msgEl.classList.contains('msg--editing')) _exitMessageEdit({ restore: true }); } catch {}
  msgEl.classList.add('msg--deleting');
  // Animation duration matches .msg--deleting in app.css.
  setTimeout(() => {
    try { if (msgEl.parentNode) msgEl.parentNode.removeChild(msgEl); } catch {}
  }, 220);
}

// Long-press → Copy popover for assistant content (tool cards, code
// blocks). Mirrors `attachMessageLongPress` for user bubbles, but:
//   - falls through to iOS's native text selection when the press
//     lands on selectable code/text (so the user can still copy a
//     single line by holding directly on it),
//   - exposes only a Copy action (Edit doesn't apply here).
function _attachLongPressCopy(el, getText) {
  if (!el) return;
  let timer = 0;
  let cancelled = false;
  let startX = 0, startY = 0;
  const COPY_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg>';
  function items() {
    const text = (typeof getText === 'function' ? getText() : getText) || '';
    return [{
      label: 'Copy', icon: COPY_ICON,
      action: () => _copyToClipboard(text, 'Copied to clipboard'),
    }];
  }
  el.addEventListener('touchstart', (e) => {
    // If the press lands on text the user might want to select directly
    // (code, markdown body, prose), bail so iOS's native highlighter
    // wins. The "click to copy whole tool" affordance still works on
    // the header / padding / chrome of the card.
    const t = e.target;
    if (t && (
      t.closest('.md-codeblock') ||
      t.closest('.md-pre__body') ||
      t.closest('.md-pre__head button') ||
      t.closest('.toolcard__detail') ||
      // Don't override the OUT panel's own long-press handler (which
      // copies tool RESULT text, not the IN command).
      (el.classList.contains('toolcard') && t.closest('.toolcard__io--out'))
    )) {
      cancelled = true;
      return;
    }
    cancelled = false;
    const touch = e.touches[0];
    startX = touch.clientX; startY = touch.clientY;
    const touchPos = { x: startX, y: startY };
    timer = setTimeout(() => {
      if (cancelled) return;
      try { if (navigator.vibrate) navigator.vibrate(20); } catch {}
      try { e.preventDefault(); } catch {}
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) sel.removeAllRanges();
      } catch {}
      _showPopover(el, items(), touchPos);
    }, 500);
  }, { passive: false });
  el.addEventListener('touchmove', (e) => {
    if (cancelled) return;
    const touch = e.touches[0];
    if (Math.abs(touch.clientX - startX) > 8 || Math.abs(touch.clientY - startY) > 8) {
      cancelled = true;
      clearTimeout(timer);
    }
  }, { passive: true });
  el.addEventListener('touchend', () => { cancelled = true; clearTimeout(timer); });
  el.addEventListener('touchcancel', () => { cancelled = true; clearTimeout(timer); });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    _showPopover(el, items());
  });
}

// Resolve the single most useful "copy this" string for a given tool
// call. Bash command, Grep pattern, Edit's new_string, etc. — whatever
// the user is most likely to want to paste into a terminal, search,
// or other tool. Falls back to a JSON dump for unknown tools so the
// affordance is never useless.
function _toolCopyText(name, input) {
  input = input || {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return String(input.command || '');
    case 'Grep': {
      const parts = [];
      if (input.pattern) parts.push(input.pattern);
      if (input.path) parts.push(`(in ${input.path})`);
      if (input.glob) parts.push(`--glob ${input.glob}`);
      if (input.type) parts.push(`--type ${input.type}`);
      return parts.length ? parts.join(' ') : String(input.pattern || '');
    }
    case 'Glob':
      return String(input.pattern || '');
    case 'Read':
      return String(input.file_path || '');
    case 'Write':
      return String(input.content || input.file_path || '');
    case 'Edit':
      // For edits, the most useful thing to copy is the NEW string the
      // user can paste back into context. If there's an old_string we
      // include it commented so the diff direction is preserved.
      if (input.new_string && input.old_string) {
        return `// from:\n${input.old_string}\n\n// to:\n${input.new_string}`;
      }
      return String(input.new_string || input.content || '');
    case 'NotebookEdit':
      return String(input.new_source || input.content || '');
    case 'Task':
    case 'Agent':
      return String(input.prompt || '');
    case 'WebFetch':
      return String(input.url || input.prompt || '');
    case 'WebSearch':
      return String(input.query || '');
    default:
      try { return JSON.stringify(input, null, 2); } catch { return ''; }
  }
}

// Map a tool name to the fenced-code-block language hint that best
// describes its primary input. Used when serializing a whole assistant
// response as markdown so a receiving LLM (or a markdown viewer) can
// syntax-highlight the right way.
function _fenceLangForTool(name) {
  switch (name) {
    case 'Bash':          return 'bash';
    case 'PowerShell':    return 'powershell';
    case 'Edit':
    case 'NotebookEdit':  return 'diff';
    case 'Write':         return '';
    case 'Read':          return '';
    case 'Grep':          return '';
    case 'Glob':          return '';
    case 'WebFetch':
    case 'WebSearch':     return '';
    case 'Task':
    case 'Agent':         return 'markdown';
    case 'TodoWrite':     return '';
    default:              return '';
  }
}

// Quote a string in a fenced code block, picking enough backticks that
// the body never closes the fence prematurely. The markdown spec
// permits any number ≥ 3, and the opener and closer must match.
function _fenceBlock(body, lang) {
  body = String(body || '');
  let n = 3;
  // Bump if the body itself contains a run of backticks of length n.
  const longest = (body.match(/`+/g) || []).reduce((m, s) => Math.max(m, s.length), 0);
  if (longest >= n) n = longest + 1;
  const fence = '`'.repeat(n);
  return fence + (lang || '') + '\n' + body + '\n' + fence;
}

// Serialize a single toolcard DOM node as a markdown chunk. The shape
// is: a tiny header line naming the tool + key parameter, then the
// fenced IN block (command / pattern / diff), then the OUT block if
// present. TodoWrite gets a checklist instead of fences.
function _serializeToolCardAsMarkdown(card) {
  const name = card.__toolName || card.dataset.toolName || '';
  const input = card.__toolInput || {};
  // OUT panel's code text (Bash stdout, Read body, Grep hits, etc.).
  const outEl = card.querySelector('.toolcard__io--out code');
  const outText = outEl ? (outEl.textContent || '') : '';
  const isError = !!card.querySelector('.toolcard__io--err');

  if (name === 'TodoWrite') {
    const todos = Array.isArray(input && input.todos) ? input.todos : [];
    const lines = todos.map((t) => {
      const status = (t && t.status) || 'pending';
      const text = (t && t.content) || '';
      const box = status === 'completed' ? '[x]'
                 : status === 'in_progress' ? '[~]'  // distinct marker for in-progress
                 : '[ ]';
      return `- ${box} ${text}`;
    });
    return '**Todo list**\n' + lines.join('\n');
  }

  let header = '';
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      header = `**${name}** — ${input.description || 'command'}`;
      break;
    case 'Read':
      header = `**Read** \`${input.file_path || ''}\``;
      break;
    case 'Write':
      header = `**Write** \`${input.file_path || ''}\``;
      break;
    case 'Edit':
      header = `**Edit** \`${input.file_path || ''}\``;
      break;
    case 'NotebookEdit':
      header = `**NotebookEdit** \`${input.notebook_path || ''}\``;
      break;
    case 'Grep':
      header = `**Grep** \`${input.pattern || ''}\`` +
        (input.path ? ` in \`${input.path}\`` : '') +
        (input.glob ? ` (glob \`${input.glob}\`)` : '') +
        (input.type ? ` (type \`${input.type}\`)` : '');
      break;
    case 'Glob':
      header = `**Glob** \`${input.pattern || ''}\``;
      break;
    case 'WebFetch':
      header = `**WebFetch** ${input.url || ''}`;
      break;
    case 'WebSearch':
      header = `**WebSearch** \`${input.query || ''}\``;
      break;
    case 'Task':
    case 'Agent':
      header = `**${name}** ${(input.subagent_type ? `(${input.subagent_type})` : '')}`
        + (input.description ? ` — ${input.description}` : '');
      break;
    default:
      header = `**${name || 'Tool'}**`;
  }

  const lang = _fenceLangForTool(name);
  const parts = [header];

  // IN body — what the tool was asked to do.
  let inBody = '';
  if (name === 'Bash' || name === 'PowerShell') inBody = input.command || '';
  else if (name === 'Edit') {
    if (input.old_string || input.new_string) {
      const oldS = String(input.old_string || '');
      const newS = String(input.new_string || '');
      inBody = oldS.split('\n').map((l) => '- ' + l).join('\n')
        + '\n'
        + newS.split('\n').map((l) => '+ ' + l).join('\n');
    } else {
      inBody = input.content || '';
    }
  }
  else if (name === 'Write') inBody = input.content || '';
  else if (name === 'NotebookEdit') inBody = input.new_source || '';
  else if (name === 'Task' || name === 'Agent') inBody = input.prompt || '';
  else if (name === 'WebFetch') inBody = input.prompt || '';
  else {
    // Generic: dump the input object as JSON so nothing's lost.
    try { inBody = JSON.stringify(input, null, 2); } catch { inBody = ''; }
  }
  if (inBody && inBody.trim()) {
    parts.push(_fenceBlock(inBody, lang));
  }

  // OUT body — only when present and not empty.
  if (outText && outText.trim() && outText.trim() !== '(empty)') {
    parts.push((isError ? '_(error)_\n' : '') + _fenceBlock(outText, ''));
  }

  return parts.join('\n\n');
}

// Serialize an AskUserQuestion card. The card's question text lives in
// `.askq__text` (one per question in multi-question cards) and, once
// answered, the user's reply is echoed in `.askq__echoText`. The
// original selectors here (`.askq__question` / `.askq__answer`) never
// matched anything the renderer produced — see 2026-05-15 audit.
function _serializeAskCardAsMarkdown(card) {
  const qs = Array.from(card.querySelectorAll('.askq__text')).map((q) => (q.textContent || '').trim());
  const a = card.querySelector('.askq__echoText');
  const answer = a ? (a.textContent || '').trim() : '';
  if (!qs.length) return '';
  const out = ['**Asked:**'];
  for (const q of qs) if (q) out.push('- ' + q);
  if (answer) out.push('', '**Answered:** ' + answer);
  return out.join('\n');
}

// In-place message edit. Replaces the bubble's static text with a
// <textarea> + Save/Cancel footer. While editing, the composer at the
// bottom of the page is hidden via `body.crc-editing` (CSS), so there
// is exactly ONE input on screen — no duplicated text boxes, no pills
// overlapping the editor. Save sends the new text as a fresh prompt
// (the bridge keeps the original message in history; this is "edit
// and resend", not a fork). Cancel restores the bubble unchanged.
let _activeMsgEdit = null;
function _enterMessageEdit(msgEl, currentText) {
  if (!msgEl) return;
  if (_activeMsgEdit) _exitMessageEdit({ restore: true });

  const bubble = msgEl.querySelector('.msg__bubble');
  if (!bubble) return;
  const textNode = bubble.querySelector('.msg__bubbleText');

  const area = el('div', { class: 'msg__editArea' });
  const ta = el('textarea', {
    class: 'msg__editInput',
    rows: '4',
    'aria-label': 'Edit message',
    // dir="auto" so the editor flips LTR/RTL based on what the user
    // is typing — English keyboards stay left-aligned, Hebrew/Arabic
    // input flips to right-aligned automatically.
    dir: 'auto',
  });
  ta.value = currentText || '';
  const actions = el('div', { class: 'msg__editActions' });
  const cancelBtn = el('button', {
    type: 'button', class: 'msg__editBtn msg__editBtn--cancel',
  }, 'Cancel');
  const saveBtn = el('button', {
    type: 'button', class: 'msg__editBtn msg__editBtn--save',
  }, 'Save & send');
  actions.append(cancelBtn, saveBtn);
  area.append(ta, actions);
  bubble.append(area);
  msgEl.classList.add('msg--editing');
  document.body.classList.add('crc-editing');

  // If the bubble has attachments, expose per-chip X buttons so the user
  // can drop attachments before resending. We mark each chip's removal
  // state on its dataset; the save handler reads that to compute the
  // final attachments list. The original list stays on
  // msgEl.dataset.attachments so cancel can fully revert.
  let attachmentsList = [];
  try { attachmentsList = JSON.parse(msgEl.dataset.attachments || '[]'); } catch {}
  const attachmentChips = Array.from(bubble.querySelectorAll('.msg__bubbleAttachments .chip'));
  const removalButtons = [];
  for (const chip of attachmentChips) {
    if (chip.querySelector('.chip__remove')) continue;
    const x = el('button', {
      type: 'button',
      class: 'chip__remove',
      'aria-label': 'Remove attachment',
    });
    x.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M6 18L18 6"/></svg>';
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      chip.classList.toggle('chip--removed');
      // Mirror that into dataset so save() can read it without DOM walks.
      chip.dataset.removed = chip.classList.contains('chip--removed') ? '1' : '';
    });
    chip.append(x);
    removalButtons.push(x);
  }

  _activeMsgEdit = { msgEl, area, textNode, attachmentsList, attachmentChips, removalButtons };

  // Auto-grow the textarea to fit the content (up to 50vh per CSS).
  function autogrow() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, Math.floor(window.innerHeight * 0.5)) + 'px';
  }
  ta.addEventListener('input', autogrow);
  // Defer focus so the click that opened the popover doesn't immediately
  // blur the new textarea via iOS's focus arbitration. Place the cursor
  // at the START so the user lands at the FIRST word of their original
  // message — most edits begin with a tweak to the opening clause, and
  // jumping to the end forces them to scroll back up on a long message.
  setTimeout(() => {
    try { ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0; } catch {}
    autogrow();
    // Pin the TOP of the bubble to the viewport so the first line of the
    // message is visible. `block: 'start'` mirrors the cursor placement.
    try { msgEl.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch {}
  }, 60);

  cancelBtn.addEventListener('click', () => _exitMessageEdit({ restore: true }));
  saveBtn.addEventListener('click', () => {
    const newText = (ta.value || '').trim();
    // Compute the surviving attachments BEFORE _exitMessageEdit
    // tears down the edit DOM. Each chip carries
    // dataset.attachmentIndex pointing back into attachmentsList,
    // and dataset.removed='1' for ones the user x'd out.
    const keptAttachments = [];
    for (const chip of attachmentChips) {
      if (chip.dataset.removed === '1') continue;
      const idx = parseInt(chip.dataset.attachmentIndex || '-1', 10);
      if (idx >= 0 && idx < attachmentsList.length) {
        keptAttachments.push(attachmentsList[idx]);
      }
    }
    _exitMessageEdit({ restore: true });
    if (!newText && keptAttachments.length === 0) return;
    // Replace-in-place: strip the original user bubble AND any
    // assistant content that followed it, then send the edited
    // prompt. Matches Claude.ai's mobile UX — edit means rewrite the
    // turn, not append a duplicate. Applies to BOTH interrupted
    // turns (the user stopped mid-run) and completed turns (the
    // user simply wants to redo the question with different wording
    // or attachments). User can always undo via the chat scrollback
    // — the underlying jsonl still has the prior turn.
    if (msgEl.parentNode) {
      const parent = msgEl.parentNode;
      let cur = msgEl.nextSibling;
      while (cur) {
        const next = cur.nextSibling;
        try { parent.removeChild(cur); } catch {}
        cur = next;
      }
      try { parent.removeChild(msgEl); } catch {}
    }
    // Restore surviving attachments to the active tab BEFORE sendPrompt
    // so the new bubble is created with them. sendPrompt clears
    // tab._attachments after send.
    if (keptAttachments.length) {
      const activeTab = getActiveTab();
      if (activeTab) activeTab._attachments = keptAttachments.slice();
    }
    const input = document.getElementById('input');
    if (input) {
      input.value = newText;
      try { autosizeInput(); } catch {}
    }
    try { sendPrompt(); } catch (e) { try { console.error('[edit] sendPrompt', e); } catch {} }
  });
}
function _exitMessageEdit(_opts) {
  const state = _activeMsgEdit;
  if (!state) return;
  _activeMsgEdit = null;
  try { state.area.remove(); } catch {}
  // Tear down the per-chip X buttons we added in edit mode and clear
  // the "removed" visual state so re-editing later starts clean.
  if (state.removalButtons) {
    for (const x of state.removalButtons) try { x.remove(); } catch {}
  }
  if (state.attachmentChips) {
    for (const chip of state.attachmentChips) {
      chip.classList.remove('chip--removed');
      delete chip.dataset.removed;
    }
  }
  if (state.msgEl) state.msgEl.classList.remove('msg--editing');
  document.body.classList.remove('crc-editing');
}

// ─── Chat rendering ───────────────────────────────────────────────────

const Chat = {
  // #chat is the scroll container (parent of every tab's chatpane).
  // Per-tab message DOM lives in tab._chatpane, looked up by tab_id when
  // frames arrive. That's how a delta for tab B can render into tab B's
  // pane even while tab A is foregrounded.
  scrollEl: $('#chat'),
  empty: $('#emptyState'),

  // Resolve the chatpane for a tab. With no arg, falls back to active tab.
  // Returns null if no tab matches (e.g. server emits a frame for a tab the
  // user just closed — drop it).
  _paneFor(tabId) {
    const tab = tabId ? getTab(tabId) : getActiveTab();
    if (!tab) return null;
    return _ensureChatpane(tab);
  },
  _runsFor(tabId) {
    const tab = tabId ? getTab(tabId) : getActiveTab();
    if (!tab) return null;
    if (!tab._activeRuns) tab._activeRuns = new Map();
    return tab._activeRuns;
  },

  // Hides the empty state once the active tab has at least one message.
  _maybeHideEmpty(tabId) {
    const tab = tabId ? getTab(tabId) : getActiveTab();
    if (!tab || tab.id !== State.activeTabId) return;  // off-screen: skip
    if (this.empty && !this.empty.hidden) this.empty.hidden = true;
  },
  _markUnreadIfBackground(tabId) {
    if (!tabId) return;
    if (tabId === State.activeTabId) return;
    const tab = getTab(tabId);
    if (!tab) return;
    tab.unread = true;
    renderTabs();
  },
  // Per-tab attention indicator (VSCode parity, 2026-05-16):
  //   'awaiting' (BLUE dot)  — Claude is waiting for the user (AskUserQuestion
  //                            card or ExitPlanMode card present on a hidden tab).
  //   'finished' (ORANGE dot) — Claude completed its turn while the tab was hidden.
  //   null                   — no attention needed (active tab, or nothing pending).
  // `awaiting` outranks `finished`: a tab waiting for input shouldn't downgrade
  // to "just finished" when run_finished fires (the next prompt only ships when
  // the user answers the question). Cleared on tab switch by _restoreActiveDraft
  // → switchTab.
  _setTabAttention(tabId, kind) {
    if (!tabId) return;
    if (tabId === State.activeTabId) return;
    const tab = getTab(tabId);
    if (!tab) return;
    if (kind === 'finished' && tab.attention === 'awaiting') return;
    if (tab.attention === kind) return;
    tab.attention = kind;
    renderTabs();
  },

  scrollToBottom(force = false, opts) {
    // Auto-follow uses the module-level `_isFollowingBottom` flag
    // (set by the scroll listener in wireJumpToBottom from REAL
    // scroll events). Also honors `_stickToBottomUntil` — an
    // explicit "I tapped the jump button, keep me pinned" window
    // set when the user uses the jump-to-bottom button or the
    // new-messages pill.
    //
    // `force=true` overrides — used for user-initiated actions
    // (sending a message, switching tabs, replaying a past session).
    //
    // `opts.fromContent: true` means "Claude just appended something."
    // Only then do we surface the "new messages below" pill when the
    // user is scrolled up. Side-effect callers (input focus, autosize)
    // pass nothing, so the pill stays silent in those cases — which
    // was the bug: tapping the textbox while reading history popped a
    // bogus "new messages" pill even though Claude hadn't said
    // anything new.
    const e = this.scrollEl;
    const sticky = _stickToBottomUntil && Date.now() < _stickToBottomUntil;
    if (force || _isFollowingBottom || sticky) {
      const pin = () => {
        e.scrollTop = e.scrollHeight;
        _isFollowingBottom = true;
      };
      requestAnimationFrame(() => {
        pin();
        // Second rAF: catches the case where a delta lands during the
        // same frame as a layout reflow. Without this, the FIRST pin
        // can read a stale scrollHeight and end up a few px short of
        // the true bottom — which then trips the onScroll handler
        // into thinking the user scrolled up.
        requestAnimationFrame(pin);
      });
    } else if (opts && opts.fromContent) {
      _showNewMessagesPill();
    }
  },

  // Append an inline action row below an assistant or system message.
  // Modeled on Claude.ai's mobile UX: a horizontal strip of buttons
  // (Copy / Regenerate) under each Claude response. User messages use
  // a long-press popover instead — see `attachMessageLongPress`.
  //
  // `opts.getSpeechText` (optional) overrides what the Speak button
  // reads. Defaults to the full Copy payload, which for assistant runs
  // includes tool cards / askq cards. The user only wants the prose
  // (Claude's actual words), so the assistant-run wiring passes a
  // prose-only walker — see `_renderRunAsSpeech`. System messages and
  // standalone bubbles fall back to the Copy text because that IS the
  // prose.
  _attachMessageActions(wrap, getText, opts) {
    if (!wrap) return;
    const o = opts || {};
    const actions = el('div', { class: 'msg__actions' });

    // Copy — every message gets this.
    const copyBtn = el('button', {
      type: 'button', class: 'msg__action', 'aria-label': 'Copy message', title: 'Copy',
    });
    copyBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg>';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = (typeof getText === 'function' ? getText() : getText) || '';
      _copyToClipboard(t);
    });
    actions.append(copyBtn);

    // Speak — read the bubble text aloud via the browser's built-in
    // Web Speech API (free, on-device, no API key, supports many
    // languages including Hebrew via iOS system voices). The button
    // toggles between idle / speaking — tapping while speaking stops.
    // Skipped when the runtime has no speechSynthesis (very rare, but
    // some sandboxed contexts disable it).
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const speakBtn = el('button', {
        type: 'button', class: 'msg__action msg__action--speak',
        'aria-label': 'Read aloud', title: 'Read aloud',
      });
      speakBtn.innerHTML = TTS_PLAY_SVG;
      const getSpeech = o.getSpeechText || getText;
      speakBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = (typeof getSpeech === 'function' ? getSpeech() : getSpeech) || '';
        TTS.toggle(t, speakBtn, wrap);
      });
      actions.append(speakBtn);
    }

    // Regenerate — only for assistant turns. Re-sends the last user
    // message in this tab, asking Claude to redo the response. Skipped
    // for system messages (they're informational; nothing to redo).
    if (o.regenerable) {
      const regenBtn = el('button', {
        type: 'button', class: 'msg__action', 'aria-label': 'Regenerate response', title: 'Regenerate',
      });
      regenBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.36-2.64"/><path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.36 2.64"/><path d="M21 3v6h-6M3 21v-6h6"/></svg>';
      regenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tab = getActiveTab();
        if (!tab || !tab.project) {
          toast('Pick a project first', 'warn');
          return;
        }
        // Walk the pane backwards to find the most recent user message.
        const pane = tab._chatpane;
        if (!pane) return;
        const userMsgs = pane.querySelectorAll('.msg--user');
        const last = userMsgs[userMsgs.length - 1];
        const lastText = last && last.dataset ? (last.dataset.text || '') : '';
        if (!lastText.trim()) {
          toast('No prior prompt to regenerate', 'warn');
          return;
        }
        // Refuse if the tab is busy. sendPrompt would push a user bubble
        // and then bounce off the server's "session busy" error, leaving
        // a ghost message in the pane.
        if (tab.running) {
          toast('Tab busy — /stop the current run first', 'warn');
          return;
        }
        toast('Regenerating…', 'info');
        // Replace-in-place semantics, matching Claude.ai's mobile UX:
        // remove the existing assistant bubble for this turn so the
        // fresh response streams in where the old one used to live.
        // The user bubble above stays put — that's the prompt being
        // regenerated. sendPrompt is called with `skipUserBubble` so
        // it does NOT add a duplicate of the user message.
        //
        // Caveat the user should know about: the bridge spawns claude
        // with `--continue`, which means the model still sees the OLD
        // assistant response in its context. Claude understands
        // "regenerate the previous response" semantics from the
        // duplicated user prompt, but the jsonl conversation log
        // ends up with two turns recorded. Mid-2026 we may add a
        // server-side `regenerate` command that rewrites the jsonl
        // to truly rewind one turn — but that's a future change.
        try {
          // Find the most recent COMPLETED assistant bubble in this
          // pane. Skip `.msg--running` (still streaming) and
          // `.msg--sys` (system messages like /help output).
          const asstMsgs = pane.querySelectorAll('.msg--asst:not(.msg--running):not(.msg--sys)');
          const lastAsst = asstMsgs[asstMsgs.length - 1];
          // Remember the bubble's parent + position so we can put it
          // back if the WS send fails (offline, mid-reconnect, etc.) —
          // otherwise we'd silently destroy the prior response and the
          // user has no path to recover it.
          let restoreInfo = null;
          if (lastAsst) {
            restoreInfo = { parent: lastAsst.parentNode, next: lastAsst.nextSibling, node: lastAsst };
            // remove() detaches from the DOM and from any
            // mutation-observer-driven persistence the chat uses.
            lastAsst.remove();
          }
          const ok = sendPrompt({ text: lastText, skipUserBubble: true });
          if (!ok && restoreInfo) {
            // Put the bubble back exactly where it was so the user
            // doesn't lose a turn of context to a transient WS hiccup.
            restoreInfo.parent.insertBefore(restoreInfo.node, restoreInfo.next);
            toast('Regenerate failed — bridge offline', 'error');
          }
        } catch (e) {
          console.error('[regen]', e);
          toast('Regenerate failed', 'error');
        }
      });
      actions.append(regenBtn);
    }

    wrap.append(actions);
  },

  pushUser(text, attachments = [], tabId, opts) {
    // Honor a persisted user-initiated delete during replay only. Live
    // sends always render (user might be re-asking the same prompt on
    // purpose — that should appear). See `_deleteUserMessage` +
    // `_markMsgDeletedInHistory` for the storage shape.
    if (opts && opts.replay) {
      const tab = getTab(tabId);
      if (tab && tab.sessionId && text && _isMsgDeletedFromHistory(tab.sessionId, text)) {
        return null;
      }
    }
    const pane = this._paneFor(tabId);
    if (!pane) return;
    this._maybeHideEmpty(tabId);
    const wrap = el('div', { class: 'msg msg--user' });
    // Tag the bubble with its text so the poll-driven _appendLiveEvents
    // can detect when it's about to re-push an already-rendered user
    // message (optimistic local push from submitPrompt followed by
    // jsonl-replay of the same event = duplicate bubble bug).
    if (text) wrap.dataset.text = text;
    // VSCode renders attachments and the prompt inside ONE rounded
    // container with a thin divider between them. Mirror that here:
    // when there are attachments, the bubble holds an attachments row
    // up top and the message text below, separated by a 1px line.
    const hasAttachments = attachments && attachments.length > 0;
    const bubble = el('div', { class: 'msg__bubble' + (hasAttachments ? ' msg__bubble--combo' : '') });
    if (hasAttachments) {
      const row = el('div', { class: 'msg__bubbleAttachments' });
      for (const a of attachments) {
        const isImg = a.kind === 'image';
        const missing = !!a.missing;
        const chip = el('div', {
          class: 'chip chip--attached'
            + (isImg ? ' chip--img' : '')
            + (missing ? ' chip--missing' : ''),
        });
        if (isImg && a.thumbUrl) {
          const thumb = el('img', { class: 'chip__thumb', src: a.thumbUrl, alt: a.name });
          thumb.style.cursor = 'zoom-in';
          thumb.addEventListener('click', () => openLightbox(a.thumbUrl));
          // iOS Safari renders broken <img> elements as a literal "?"
          // glyph — ugly inside a chat-history chip. Fall back to a
          // small filetype tag (e.g. "GIF") so the row still reads as
          // an image-shaped pill. Tap target unchanged: clicking either
          // the thumb or the fallback still opens the lightbox, which
          // can retry the same URL with its own decode budget.
          const swapToFallback = () => {
            if (!chip.contains(thumb)) return;
            const ext = (a.name || '').split('.').pop() || 'IMG';
            const fb = el(
              'div',
              { class: 'chip__thumb chip__thumb--fallback', 'aria-hidden': 'true' },
              ext.toUpperCase().slice(0, 4),
            );
            fb.style.cursor = 'zoom-in';
            fb.addEventListener('click', () => openLightbox(a.thumbUrl));
            chip.replaceChild(fb, thumb);
          };
          thumb.addEventListener('error', swapToFallback);
          // Cached-error race: if the resource already errored before
          // our listener attached, `complete` is true and naturalWidth
          // is 0. Re-check on the next tick.
          setTimeout(() => {
            if (thumb.complete && thumb.naturalWidth === 0) swapToFallback();
          }, 0);
          chip.append(thumb);
        }
        chip.append(el('span', { class: 'chip__name' }, a.name));
        const metaText = missing
          ? 'no longer on disk'
          : (isImg && a.dims && a.dims.w && a.dims.h)
            ? `${a.dims.w}×${a.dims.h}`
            : (a.size != null ? formatBytes(a.size) : '');
        if (metaText) chip.append(el('span', { class: 'chip__size' }, metaText));
        row.append(chip);
      }
      bubble.append(row);
    }
    if (text || !hasAttachments) {
      // dir="auto" so each bubble's text direction is auto-detected from
      // its OWN content (Unicode bidi first-strong-character heuristic).
      // Without this, iOS Safari running on a Hebrew/Arabic system locale
      // right-aligned plain English text — reported 2026-05-16.
      bubble.append(el('div', { class: 'msg__bubbleText', dir: 'auto' }, text));
    }
    wrap.append(bubble);
    // Stash the attachments list on the wrap so edit-mode can find them
    // and offer per-chip remove. Attachments here are
    // {name, path, mime, kind, thumbUrl, size, dims}. We keep them on the
    // DOM rather than in a parallel map so the bubble stays
    // self-contained — deletion of the wrap also frees the metadata.
    if (hasAttachments) {
      try { wrap.dataset.attachments = JSON.stringify(attachments); } catch {}
      // Index each chip with its attachment array position so edit mode
      // can map "this X click → this attachment".
      const chips = bubble.querySelectorAll('.msg__bubbleAttachments .chip');
      chips.forEach((c, i) => { c.dataset.attachmentIndex = String(i); });
    }
    // Long-press on the user bubble pops up a Copy/Edit menu (matches
    // Claude.ai's mobile UX). The inline action row stays off user
    // messages — they'd compete visually with the bubble's clean look.
    attachMessageLongPress(wrap, () => text || '', { editable: true });
    pane.append(wrap);
    this.scrollToBottom(true);
  },

  // Render a dimmed user-style bubble representing a queued prompt
  // (sent while a previous run was still in flight). Visually distinct
  // from a live bubble — same shape, lower opacity, a small "Queued"
  // chip — so the user sees the message landed and knows it will fire
  // automatically when the in-flight run finishes. The returned node
  // is stashed on the queue entry so the drain step can remove the
  // placeholder before sendPrompt appends the real bubble.
  pushQueued(text, attachments = [], tabId) {
    const pane = this._paneFor(tabId);
    if (!pane) return null;
    this._maybeHideEmpty(tabId);
    const wrap = el('div', { class: 'msg msg--user msg--queued' });
    if (text) wrap.dataset.text = text;
    const hasAttachments = attachments && attachments.length > 0;
    const bubble = el('div', { class: 'msg__bubble' + (hasAttachments ? ' msg__bubble--combo' : '') });
    if (hasAttachments) {
      const row = el('div', { class: 'msg__bubbleAttachments' });
      for (const a of attachments) {
        const isImg = a.kind === 'image';
        const chip = el('div', {
          class: 'chip chip--attached' + (isImg ? ' chip--img' : ''),
        });
        if (isImg && a.thumbUrl) {
          chip.append(el('img', { class: 'chip__thumb', src: a.thumbUrl, alt: a.name }));
        }
        chip.append(el('span', { class: 'chip__name' }, a.name));
        row.append(chip);
      }
      bubble.append(row);
    }
    if (text || !hasAttachments) {
      bubble.append(el('div', { class: 'msg__bubbleText', dir: 'auto' }, text));
    }
    // "Queued" badge so the user understands this hasn't actually shipped
    // to claude yet — it'll auto-send when the current run completes.
    const tag = el('div', { class: 'msg__queuedTag', 'aria-label': 'Queued' }, 'Queued');
    bubble.append(tag);
    wrap.append(bubble);
    pane.append(wrap);
    // Long-press menu (Copy / Edit / Delete) — same gesture as sent user
    // messages, but the actions are queued-specific: Edit pulls the entry
    // back into the composer (and removes from queue), Delete drops the
    // entry from the queue without touching chat history (the message
    // never actually shipped). Copy is identical to the sent-message case.
    attachMessageLongPress(wrap, () => wrap.dataset.text || text || '', {
      editable: true,
      // Custom handlers passed via the options bag so attachMessageLongPress
      // doesn't need to know about the queue at all.
      onEdit: () => _editQueuedEntry(tabId, wrap),
      onDelete: () => _deleteQueuedEntry(tabId, wrap),
    });
    this.scrollToBottom(true);
    return wrap;
  },

  pushSystem(text, _tag, tabId) {
    // Note: we deliberately ignore `_tag` — the project name lives in the
    // topbar, not on individual messages. Showing it twice is noise.
    //
    // If no tab/pane is available (cold app, user typed a slash command
    // before picking a project), fall back to a "no-tab" pane parked at
    // the bottom of #chat so the message renders inline alongside the
    // empty-state welcome. This is what makes /usage, /memory, /help
    // etc. work BEFORE the user has started a conversation.
    const pane = this._paneFor(tabId) || this._fallbackPane();
    if (!pane) return;
    this._maybeHideEmpty(tabId);
    const body = el('div', { class: 'msg__body' });
    body.innerHTML = _renderMarkdown(text || '');
    _enforceBlockDir(body);
    _flagCodeBlockOverflow(body);
    const wrap = el('div', { class: 'msg msg--asst msg--sys' }, body);
    // System messages get Copy only — no regenerate.
    this._attachMessageActions(wrap, () => text || '', { regenerable: false });
    pane.append(wrap);
    this._markUnreadIfBackground(tabId);
    this.scrollToBottom(false, { fromContent: true });
  },

  // Creates (or reuses) a chat pane that lives outside any tab, used as a
  // sink for system messages emitted before the user has picked a
  // project. Stays in the DOM after a real tab opens — its messages just
  // get covered by the active tab's pane via `data-active=true` z-stack.
  _fallbackPane() {
    let pane = document.getElementById('chatpaneFallback');
    if (pane) return pane;
    pane = document.createElement('div');
    pane.id = 'chatpaneFallback';
    pane.className = 'chatpane chatpane--fallback';
    pane.setAttribute('data-active', 'true');
    $('#chat').appendChild(pane);
    return pane;
  },

  // Begins an assistant run container. Returns the element.
  // `opts.silent` skips the tab.running/renderTabs/updateSendButton
  // mutation — used by the replay path which re-renders past turns
  // without touching the SERVER-authoritative running state (the
  // server's hello frame is the source of truth for which tabs have
  // live subprocesses).
  beginRun(project, runId, tabId, opts) {
    const pane = this._paneFor(tabId);
    if (!pane) return null;
    this._maybeHideEmpty(tabId);
    // Head shows just the live dot + 'Bridgy' label. Project name is in the
    // topbar; repeating it on every message bubble was visual noise.
    // Rebranded 2026-05-17 → 'Bridgy' as the app's mascot name
    // (capitalised + -y suffix per user request, matches the wordmark
    // shown on the splash).
    const head = el('div', { class: 'msg__head' },
      el('span', { class: 'msg__dot' }),
      el('span', { class: 'msg__hint' }, 'Bridgy'),
    );
    // "Thinking" placeholder: Claude's actual 6-frame Unicode spinner + a
    // word picked from the full Claude Code rotation list. Spinner uses
    // per-frame easing (first/last frames hold longer) per the reverse-
    // engineering article — implemented as a self-rescheduling setTimeout
    // chain so each frame can have its own duration.
    //
    // SPECIAL CASE: when the tab is mid-summarize (the user just tapped
    // the donut's Summarize button), pin the word to "Summarizing…"
    // and skip the random-word cycler — the user wants a clear status
    // signal, not a random Marinating / Hashing / etc. (The flag is
    // still named `compactPending` for historical reasons but the
    // operation is now a summary in-chat, not a true compact.)
    const _tabForBeginRun = getTab(tabId) || getActiveTab();
    const _isCompactingRun = !!(_tabForBeginRun && _tabForBeginRun.compactPending);
    const startWord = _isCompactingRun
      ? 'Summarizing'
      : THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
    // Spinner intentionally removed 2026-05-17. The bouncing kawaii
    // already conveys "still working" and stacking it with the Unicode
    // propeller glyph just felt busy. We keep the SPINNER_FRAMES
    // constants and tickSpinner closure below in case we ever want to
    // re-enable it, but no element is created and no timer ticks.
    const thinkingWord = el('span', { class: 'thinking__word' }, startWord);
    const thinkingDots = el('span', { class: 'thinking__dots' }, '…');
    const thinkingMascot = el('img', {
      class: 'thinking__mascot',
      src: '/icons/kawaii_blob.png?v=1.0.83',
      alt: '',
      'aria-hidden': 'true',
      width: '18',
      height: '18',
    });
    const thinking = el('div', { class: 'msg__thinking' }, thinkingMascot, thinkingWord, thinkingDots);

    // Spinner-tick removed 2026-05-17 along with the spinner element.
    // `spinnerTimer` is still declared so the `cleanup` closure registered
    // a few lines down can call `clearTimeout(spinnerTimer)` without
    // throwing (it ran on a 0-sentinel before any real timer was ever
    // scheduled in this branch, which is a safe no-op).
    let spinnerTimer = 0;

    // Cycle the status word every ~2.5s — picked at random each time so
    // the same word doesn't repeat between consecutive runs. Skipped
    // when this run is a compact (the word is pinned to "Compacting").
    const wordCycler = _isCompactingRun ? null : setInterval(() => {
      thinkingWord.textContent = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
    }, 2500);

    // .msg__stream is the chronological list of segments — alternating
    // text bodies and tool-call cards in the order claude produces them.
    // appendDelta appends to (or creates) the last text body; appendToolUse
    // appends a card; the NEXT delta after a card creates a fresh text body.
    // So the latest thing claude did — text or tool — is always at the
    // very bottom of the stream, right above the still-working spinner.
    const stream = el('div', { class: 'msg__stream' });
    const media = el('div', { class: 'msg__media' });
    const status = el('div', { class: 'msg__status', hidden: true });

    const wrap = el('div', { class: 'msg msg--asst msg--running' }, head, stream, thinking, media, status);
    wrap.dataset.project = project;
    wrap.dataset.runId = String(runId);
    if (tabId) wrap.dataset.tabId = tabId;

    pane.append(wrap);
    const runs = this._runsFor(tabId);
    if (runs) {
      runs.set(String(runId), {
        container: wrap, hasText: false,
        cycler: wordCycler,
        spinnerTimer: () => clearTimeout(spinnerTimer),
      });
    }
    // Mark this tab as running so the send button flips to stop-mode when
    // this tab is foregrounded, and the tab strip shows the pulsing dot.
    const tab = getTab(tabId) || getActiveTab();
    if (tab && !(opts && opts.silent)) {
      tab.running = true;
      renderTabs();
      updateSendButton();
    }
    // A real running container now exists — any ghost spinner placeholder
    // from prior reconciliation should go away.
    if (tab) this.ensureRunningSpinner(tab.id);
    // Respect the user's scroll position when a new run starts —
    // scrollToBottom() without `force` keeps them put if they've scrolled
    // up to read history. Forcing here yanked them down every time
    // claude started a new turn, which made reading scrollback during
    // a long streaming response impossible.
    this.scrollToBottom(false, { fromContent: true });
    return wrap;
  },

  // Walk an assistant run container and serialize EVERYTHING in it as
  // Markdown — prose bodies, tool calls (fenced as ```bash, ```powershell,
  // etc.), tool results (fenced as plain code blocks), and TodoWrite
  // checklists (as `- [x]` / `- [ ]` lines). Returns a single string
  // suitable for pasting into another AI chat (Claude.ai, ChatGPT, etc.)
  // — the receiver renders the code fences as code and the prose as
  // prose, instead of seeing one flat blob of plain text.
  _renderRunAsMarkdown(container) {
    if (!container) return '';
    const stream = container.querySelector('.msg__stream');
    if (!stream) return '';
    const parts = [];
    for (const node of stream.children) {
      if (node.classList.contains('msg__body')) {
        const raw = (node.__raw || node.textContent || '').trim();
        if (raw) parts.push(raw);
        continue;
      }
      if (node.classList.contains('toolcard')) {
        const block = _serializeToolCardAsMarkdown(node);
        if (block) parts.push(block);
        continue;
      }
      if (node.classList.contains('askq')) {
        const q = _serializeAskCardAsMarkdown(node);
        if (q) parts.push(q);
        continue;
      }
    }
    return parts.join('\n\n').trim();
  },

  // Speech-only variant: yields ONLY the prose Claude wrote (msg__body
  // segments). Skips tool cards, askq cards, ExitPlanMode cards, etc. —
  // the user explicitly does not want the reader to enunciate file
  // names, code blocks, tool argument JSON, or attachment captions.
  // TTS._cleanForSpeech then strips any markdown that survived.
  _renderRunAsSpeech(container) {
    if (!container) return '';
    const stream = container.querySelector('.msg__stream');
    if (!stream) return '';
    const parts = [];
    for (const node of stream.children) {
      if (!node.classList.contains('msg__body')) continue;
      const raw = (node.__raw || node.textContent || '').trim();
      if (raw) parts.push(raw);
    }
    return parts.join('\n\n').trim();
  },

  // Return the trailing text body in this run's stream, or create a new
  // one if the last segment is a tool card (or the stream is empty). This
  // is what keeps text+tools interleaved in chronological order.
  _ensureBodySegment(run) {
    const stream = run.container.querySelector('.msg__stream');
    let last = stream.lastElementChild;
    if (last && last.classList.contains('msg__body')) return last;
    const body = document.createElement('div');
    body.className = 'msg__body';
    stream.append(body);
    return body;
  },

  _runFor(tabId, runId) {
    const runs = this._runsFor(tabId);
    if (!runs) return null;
    return runs.get(String(runId)) || null;
  },

  // Render a tool invocation as a compact card appended to the stream.
  // Card looks like the VSCode extension's tool-call display: icon + name
  // + a one-line detail (command for Bash, file path for Edit/Write/Read,
  // URL for WebFetch). Future text deltas land in a NEW body below this
  // card, preserving "claude said X, then ran Y, then said Z" order.
  // Was this run explicitly stopped by the user? If so, drop any
  // straggling frames that arrive after the optimistic UI clear so the
  // spinner doesn't reappear from a delta that was already in flight
  // when the user tapped stop.
  _isStopped(tabId, runId) {
    const tab = tabId ? getTab(tabId) : getActiveTab();
    if (!tab) return false;
    if (!tab._stoppedRuns) return false;
    return tab._stoppedRuns.has(String(runId));
  },

  appendToolUse(project, runId, name, input, tabId, toolUseId, replayAnswer) {
    if (this._isStopped(tabId, runId)) return;
    let run = this._runFor(tabId, runId);
    if (!run) {
      this.beginRun(project, runId, tabId);
      run = this._runFor(tabId, runId);
    }
    if (!run) return;
    this._hideThinkingFor(run);
    const stream = run.container.querySelector('.msg__stream');

    // ToolSearch is a meta-tool the harness uses to lazily load
    // deferred tool schemas (AskUserQuestion, WebFetch, etc.). It has
    // no user-facing semantics — the user cares about what Claude DOES
    // with the tool, not the fact that the schema was loaded. Skip
    // rendering entirely so the chat shows only the actual work.
    if (name === 'ToolSearch') {
      this._markUnreadIfBackground(tabId);
      return;
    }

    // AskUserQuestion renders as a STANDALONE card — no toolcard
    // wrapper, no "AskUserQuestion" header, no in/out panels. Matches
    // the desktop extension's clean question-card look and means the
    // interactive content (or the answered echo, in replay) takes
    // the whole visual footprint. `replayAnswer` is the user's
    // original answer text when we're re-rendering a past session;
    // when present, the card is read-only and shows the answer.
    if (name === 'AskUserQuestion') {
      // Wrap in try/catch — a render failure here used to silently
      // abort the whole appendToolUse method, leaving the user with
      // no card and Claude's follow-up text talking about a card the
      // user never saw. Surface the error to the console + render a
      // small fallback so the user at least knows something went
      // wrong on the client side.
      let ask = null;
      try {
        ask = _renderAskUserQuestion(input, runId, tabId, replayAnswer || null);
      } catch (e) {
        try { console.error('[askq render]', e); } catch {}
      }
      if (ask) {
        if (toolUseId) ask.dataset.toolUseId = toolUseId;
        ask.dataset.toolName = name;
        stream.append(ask);
      }
      this._markUnreadIfBackground(tabId);
      this._setTabAttention(tabId, 'awaiting');
      this.scrollToBottom(false, { fromContent: true });
      return;
    }

    // ExitPlanMode is Claude's signal that plan-mode is ready for the
    // user to approve and apply. Render as a STANDALONE coral-bordered
    // card with the plan markdown body + three action buttons:
    // "Approve & apply" (mode=edits), "Full auto" (mode=auto), and
    // "Keep planning" (dismiss). Matches the VSCode extension's
    // approval flow but adapted for the headless `-p` model — buttons
    // dispatch a fresh prompt frame that resumes the same session_id
    // with the user-chosen permission mode. Reference:
    // code.claude.com/docs/en/tools-reference.md.
    if (name === 'ExitPlanMode') {
      let planCard = null;
      try {
        planCard = _renderExitPlanMode(input || {}, tabId, toolUseId);
      } catch (e) {
        try { console.error('[plan render]', e); } catch {}
      }
      if (planCard) {
        if (toolUseId) planCard.dataset.toolUseId = toolUseId;
        planCard.dataset.toolName = name;
        stream.append(planCard);
      }
      this._markUnreadIfBackground(tabId);
      this._setTabAttention(tabId, 'awaiting');
      this.scrollToBottom(false, { fromContent: true });
      return;
    }

    const card = el('div', { class: 'toolcard' });
    if (toolUseId) card.dataset.toolUseId = toolUseId;
    // Tag the card with the tool name so renderers / suppression rules
    // can dispatch on it. TodoWrite, for instance, uses this in
    // appendToolResult to skip the "out" panel — its result is just a
    // confirmation string the user doesn't need to see on the phone.
    if (name) card.dataset.toolName = name;
    // Stash the raw tool input on the card itself (expando, never
    // serialized to HTML) so the "Copy whole response" walker in
    // `_renderRunAsMarkdown` can emit a faithful fenced code block —
    // not just whatever subset of the input the visual card chose to
    // display.
    card.__toolName = name;
    card.__toolInput = input;
    const iconWrap = el('span', { class: 'toolcard__icon' });
    iconWrap.innerHTML = TOOL_ICONS[name] || TOOL_ICONS.__default;
    // For Agent / Task tool calls, surface the subagent type next to
    // the tool name (e.g. "Agent · researcher") so the user can see at
    // a glance WHICH specialist subagent was delegated to, not just
    // that an Agent was called.
    const headChildren = [iconWrap, el('span', { class: 'toolcard__name' }, name)];
    if ((name === 'Agent' || name === 'Task') && input && input.subagent_type) {
      headChildren.push(
        el('span', { class: 'toolcard__subtype' }, input.subagent_type),
      );
    }
    const head = el('div', { class: 'toolcard__head' }, ...headChildren);
    card.append(head);

    // One-line summary (description / file path / etc.) — only when the
    // actual code block won't cover it.
    const summary = _summarizeTool(name, input);
    const codeBlock = _renderToolCode(name, input);
    if (summary && (!codeBlock || _shouldShowSummaryAboveCode(name))) {
      const detail = el('div', { class: 'toolcard__detail' }, summary);
      card.append(detail);
    }
    // Render the actual command / payload as a code block so the user
    // can see exactly what's being run (Bash, PowerShell, etc.), with
    // the same copy + expand affordances as markdown code blocks.
    // Tag the code block as the IN side so the matching OUT result
    // panel can sit visually paired with it.
    if (codeBlock) {
      codeBlock.classList.add('toolcard__io', 'toolcard__io--in');
      card.append(codeBlock);
    }

    // For Edit / Write / NotebookEdit, render the actual change inline as
    // a diff block: red `-` lines for old_string, green `+` lines for
    // new_string. So you can see exactly what claude is changing without
    // leaving the chat. Other tools (Bash, Read, …) don't get a diff.
    const diff = _renderDiff(name, input);
    if (diff) card.append(diff);

    // TodoWrite gets a dedicated checklist UI in place of the generic
    // code-block renderer (which would just show `[x] / [ ]` text).
    // Matches what the VSCode extension shows.
    if (name === 'TodoWrite') {
      const todoList = _renderTodoList(input);
      if (todoList) card.append(todoList);
    }
    // (AskUserQuestion is handled with an early-return at the top of
    // this method — it skips the toolcard wrapper entirely and renders
    // a standalone interactive card. See the if-branch above.)

    stream.append(card);
    if (codeBlock) _flagCodeBlockOverflow(card);
    // Long-press anywhere on the card's chrome (header, icon, name,
    // padding) pops a Copy menu that grabs the tool's primary input —
    // Bash command, Grep pattern, Edit new_string, etc. Press on the
    // code block body itself still triggers iOS's native text-selection
    // handles so the user can grab just a substring.
    try { _attachLongPressCopy(card, () => _toolCopyText(name, input)); } catch {}
    // Also attach the same long-press to the IN code block itself so
    // pressing the "in" label / its surround works even when bubble-up
    // is blocked by the code block's overflow:hidden ancestor stack.
    if (codeBlock) {
      try { _attachLongPressCopy(codeBlock, () => _toolCopyText(name, input)); } catch {}
    }
    // For an Agent (subagent) launched in the background, mark the
    // card as running. The `agent_complete` handler removes the badge
    // and swaps in the real result once the subagent reports back.
    if (name === 'Task' || name === 'Agent') {
      card.classList.add('toolcard--agent-running');
      const badge = el('span', { class: 'toolcard__runbadge' }, 'running…');
      head.append(badge);
    }
    this._markUnreadIfBackground(tabId);
    this.scrollToBottom(false, { fromContent: true });
  },

  // Find the Agent toolcard for a given tool_use_id and graft the
  // subagent's final report onto it. Replaces the placeholder OUT
  // panel (the "Async agent launched…" launch confirmation) with the
  // real `<result>` content, and removes the "running" badge.
  appendAgentComplete(toolUseId, summary, result, status, tabId) {
    if (!toolUseId) return;
    const pane = this._paneFor(tabId);
    if (!pane) return;
    // Find the matching card. Search ALL panes for this tab — replay
    // path puts cards inside synthetic runs whose container differs
    // from a live run.
    const card = pane.querySelector(`.toolcard[data-tool-use-id="${CSS.escape(toolUseId)}"]`);
    if (!card) return;
    card.classList.remove('toolcard--agent-running');
    const badge = card.querySelector('.toolcard__runbadge');
    if (badge) {
      badge.textContent = status === 'completed' ? 'done' : (status || 'finished');
      badge.classList.add('toolcard__runbadge--done');
    }
    // Replace any prior OUT panel (which carries the useless launch
    // confirmation) with the real subagent result. Keep one OUT block
    // per card.
    const existingOut = card.querySelector('.toolcard__io--out');
    if (existingOut) existingOut.remove();
    const wrap = document.createElement('div');
    const isError = status && status !== 'completed';
    wrap.className = 'md-pre toolcard__code toolcard__io--out' + (isError ? ' toolcard__io--err' : '');
    wrap.setAttribute('data-expanded', 'false');
    wrap.setAttribute('data-overflow', 'false');
    const headerLabel = summary ? `result · ${summary}` : 'result';
    wrap.innerHTML = (
      '<div class="md-pre__head">' +
        `<span class="md-pre__lang">${_escapeHtml(headerLabel)}</span>` +
        '<button class="md-pre__copyBtn" type="button" data-copy-code="1" aria-label="Copy result">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>' +
          '<span>copy</span>' +
        '</button>' +
      '</div>' +
      `<div class="md-pre__body"><code class="md-codeblock">${_escapeHtml(result || '(no result)')}</code></div>` +
      '<button class="md-pre__expandBtn" type="button" data-expand-code="1">Show full</button>'
    );
    card.append(wrap);
    _flagCodeBlockOverflow(card);
    try { _attachLongPressCopy(wrap, () => result || ''); } catch {}
    this._markUnreadIfBackground(tabId);
    this.scrollToBottom(false, { fromContent: true });
  },

  // OUT side of a tool call — claude's tool_result content paired with
  // the matching IN block via tool_use_id. Built with the SAME DOM
  // structure as _renderToolCode (the IN renderer) so .toolcard__code
  // CSS rules (max-height, margins, expand affordance) apply identically
  // — same size, same Show-full button behavior. Just two extra classes
  // mark it as the OUT side and the error variant when applicable.
  appendToolResult(project, runId, toolUseId, text, isError, tabId) {
    if (!toolUseId) return;
    const run = this._runFor(tabId, runId);
    if (!run) return;
    this._hideThinkingFor(run);
    // AskUserQuestion's IN side renders as a standalone .askq card (not
    // wrapped in .toolcard), so look for either. Either way, its
    // tool_result is suppressed below — finding the card just lets us
    // honor the data-toolName dispatch.
    const card = (
      run.container.querySelector(`.toolcard[data-tool-use-id="${CSS.escape(toolUseId)}"]`)
      || run.container.querySelector(`.askq[data-tool-use-id="${CSS.escape(toolUseId)}"]`)
    );
    if (!card) return;
    // Suppress tool_result rendering for tools whose immediate result
    // is meaningless or noisy on a phone screen:
    //   TodoWrite           — result is just a confirmation string; user already sees the checklist.
    //   AskUserQuestion     — model-side outcome of the (un-answered, in -p mode) prompt; user's answer will supersede.
    //   Task / Agent (subagent) — `run_in_background=true` returns an
    //     immediate launch-confirmation blob ("Async agent launched
    //     successfully. agentId: ...  output_file: C:\\...\\tasks\\....output")
    //     which is internal plumbing, not what the subagent actually
    //     said. The real return text arrives later via the
    //     `agent_complete` event (extracted from the
    //     `<task-notification>` user event) and `appendAgentComplete`
    //     fills the OUT panel + flips the running badge to "done".
    const dropResultFor = card.dataset.toolName;
    if (dropResultFor === 'TodoWrite' || dropResultFor === 'AskUserQuestion'
        || dropResultFor === 'Task' || dropResultFor === 'Agent'
        || dropResultFor === 'ExitPlanMode') return;
    // Avoid double-render (poll-driven replay of an already-rendered
    // tool_result, WS reconnect mid-run, etc.)
    if (card.querySelector('.toolcard__io--out')) return;
    const wrap = document.createElement('div');
    wrap.className = 'md-pre toolcard__code toolcard__io--out' + (isError ? ' toolcard__io--err' : '');
    wrap.setAttribute('data-expanded', 'false');
    wrap.setAttribute('data-overflow', 'false');
    wrap.innerHTML = (
      '<div class="md-pre__head">' +
        `<span class="md-pre__lang">${isError ? 'out · error' : 'out'}</span>` +
        '<button class="md-pre__copyBtn" type="button" data-copy-code="1" aria-label="Copy output">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>' +
          '<span>copy</span>' +
        '</button>' +
      '</div>' +
      `<div class="md-pre__body"><code class="md-codeblock">${_escapeHtml(text || '(empty)')}</code></div>` +
      '<button class="md-pre__expandBtn" type="button" data-expand-code="1">Show full</button>'
    );
    card.append(wrap);
    _flagCodeBlockOverflow(card);
    // Long-press anywhere on the OUT panel's chrome copies the result
    // text (file contents, command output, grep hits). Inner code text
    // still falls through to iOS native selection for substring copy.
    try { _attachLongPressCopy(wrap, () => text || ''); } catch {}
    this._markUnreadIfBackground(tabId);
    this.scrollToBottom(false, { fromContent: true });
  },

  // Render a tool error inline as a red-edged card. The user explicitly
  // asked to see WHY edits / writes fail — without this they only saw the
  // tool_use card and then claude's vague follow-up text.
  appendToolError(project, runId, errorText, tabId, toolUseId) {
    if (this._isStopped(tabId, runId)) return;
    let run = this._runFor(tabId, runId);
    if (!run) {
      this.beginRun(project, runId, tabId);
      run = this._runFor(tabId, runId);
    }
    if (!run) return;
    this._hideThinkingFor(run);
    // AskUserQuestion always errors in headless `-p` mode — claude.exe
    // writes a synthetic is_error=true tool_result because there's no
    // interactive answer round-trip. The interactive card itself
    // already rendered and gives the user a way to actually answer;
    // showing a red "Tool error: Answer questions?" card on top of it
    // is confusing noise. Suppress when the tool_use_id points at an
    // askq card.
    if (toolUseId) {
      const askMatch = run.container.querySelector(
        `.askq[data-tool-use-id="${CSS.escape(toolUseId)}"]`,
      );
      if (askMatch) return;
    }
    const stream = run.container.querySelector('.msg__stream');
    const card = el('div', { class: 'toolcard toolcard--err' });
    const head = el('div', { class: 'toolcard__head' },
      el('span', { class: 'toolcard__icon' }, '⚠'),
      el('span', { class: 'toolcard__name' }, 'Tool error'),
    );
    const detail = el('div', { class: 'toolcard__detail' }, (errorText || '').slice(0, 600));
    card.append(head, detail);
    stream.append(card);
    // Long-press anywhere on the card's chrome copies the full error text.
    // Pressing on the .toolcard__detail body falls through to iOS native
    // selection (see _attachLongPressCopy at line ~2763 for the bail rule).
    try { _attachLongPressCopy(card, () => errorText || ''); } catch {}
    this._markUnreadIfBackground(tabId);
    this.scrollToBottom(false, { fromContent: true });
  },

  // No-op since 2026-05-17. Pre-fix this function called
  // `container.appendChild(thinking)` after every new segment to keep
  // the running-indicator row visually pinned to the bottom of the
  // bubble. But `appendChild` on an existing child counts as a DOM
  // move, and any element with an in-flight CSS animation has that
  // animation RESTARTED on a move — the user noticed the kawaii
  // mascot's bounce kept re-starting from frame 0 on every delta. The
  // visual anchoring is now done by `.msg__thinking { order: 99 }` in
  // app.css; the DOM no longer needs to be touched. Kept as a no-op
  // (rather than deleted) because there are many call sites and the
  // historical name is fine.
  _hideThinkingFor(run) {  // eslint-disable-line no-unused-vars
    /* intentionally empty — see comment above */
  },

  appendDelta(project, runId, text, tabId, opts) {
    if (this._isStopped(tabId, runId)) return;
    let run = this._runFor(tabId, runId);
    if (!run) {
      // Server emitted a delta before run_started, or after we lost it on
      // reconnect. Build the container lazily so we don't drop text.
      this.beginRun(project, runId, tabId);
      run = this._runFor(tabId, runId);
    }
    if (!run) return;
    this._hideThinkingFor(run);
    run.hasText = true;
    const body = this._ensureBodySegment(run);
    // Accumulate raw markdown source so we can re-render the full HTML
    // (markdown can't be parsed correctly char-by-char). For replay we
    // get many synchronous deltas in a row; rendering each one would be
    // O(N²) and can lock the JS thread, so the caller may opt to defer
    // the render until the end of the turn via opts.deferRender.
    body.__raw = (body.__raw || '') + text;
    if (opts && opts.deferRender) {
      return;
    }
    body.innerHTML = _renderMarkdown(body.__raw);
    _enforceBlockDir(body);
    _flagCodeBlockOverflow(body);
    this._markUnreadIfBackground(tabId);
    this.scrollToBottom(false, { fromContent: true });
  },

  // Flush any deferred markdown renders for a run by walking its text
  // bodies and rendering each one's accumulated __raw text. Called by
  // the history-replay path after a turn's events have all been pushed,
  // so the user sees the final formatted output but we only paid the
  // markdown-parsing cost once per body.
  flushDeferredRender(runId, tabId) {
    const run = this._runFor(tabId, runId);
    if (!run || !run.container) return;
    run.container.querySelectorAll('.msg__body').forEach((body) => {
      if (body.__raw == null) return;
      body.innerHTML = _renderMarkdown(body.__raw);
      _enforceBlockDir(body);
      _flagCodeBlockOverflow(body);
    });
  },

  appendMedia(project, runId, m, tabId) {
    if (this._isStopped(tabId, runId)) return;
    let run = this._runFor(tabId, runId);
    if (!run) {
      this.beginRun(project, runId, tabId);
      run = this._runFor(tabId, runId);
    }
    if (!run) return;
    this._hideThinkingFor(run);
    const media = run.container.querySelector('.msg__media');
    let inner;
    if (m.kind === 'video') {
      inner = el('video', { src: m.url, controls: true, playsinline: true });
    } else {
      inner = el('img', { src: m.url, alt: m.name });
    }
    const wrap = el('a', {
      class: 'msg__mediaItem',
      onclick: (e) => { e.preventDefault(); openLightbox(m.url); },
    }, inner, el('div', { class: 'msg__mediaCaption' }, m.name));
    media.append(wrap);
    this._markUnreadIfBackground(tabId);
    this.scrollToBottom(false, { fromContent: true });
  },

  // `opts.silent` (used by replay) skips the tab.running mutation and
  // the renderTabs/updateSendButton/attention/queue-drain bookkeeping —
  // replay is just re-rendering past turns, not finishing live runs, so
  // the server's running flag (set by hello) must not be clobbered.
  finishRun(project, runId, outcome, detail, tabId, opts) {
    const run = this._runFor(tabId, runId);
    if (!run) {
      // No matching run record (replay used synthetic IDs, real run_id
      // arrived after replay; or WS reconnect lost the in-memory run).
      // Still reconcile tab.running from the server's perspective: this
      // frame is authoritative, the run is OVER. Otherwise the composer
      // is stuck on "stop" and the ghost spinner never clears.
      if (!(opts && opts.silent)) {
        const tab = getTab(tabId);
        if (tab) {
          // Defensive: kill any stale .msg--asst.msg--running in this
          // tab's pane. If the runs map has an orphan from a prior
          // (mismatched) run_started, the cycler on that container
          // never gets cleared via the main finishRun path and the
          // kawaii + gibberish-word animation keeps spinning forever
          // even though Claude is done. Sweep them on every orphan
          // run_finished so they can never leak.
          const pane = tab._chatpane;
          if (pane) {
            pane.querySelectorAll('.msg--asst.msg--running:not(.msg--ghostThinking)')
              .forEach((stale) => {
                try { stale.classList.remove('msg--running'); } catch {}
              });
          }
          const runs = this._runsFor(tabId);
          // Trust the server: a run_finished frame means there's nothing
          // active. Clear the local runs map even on orphans so a stale
          // entry can't keep tab.running stuck true.
          if (runs) runs.clear();
          tab.running = false;
          tab._lastFinishedAt = Date.now();
          renderTabs();
          updateSendButton();
          this.ensureRunningSpinner(tab.id);
        }
      }
      return;
    }
    if (run.cycler) { clearInterval(run.cycler); run.cycler = null; }
    if (run.spinnerTimer) { run.spinnerTimer(); run.spinnerTimer = null; }
    const { container } = run;
    // Remove the running class — CSS will hide the spinner. Don't physically
    // remove the .msg__thinking element so the layout doesn't shift.
    container.classList.remove('msg--running');
    const status = container.querySelector('.msg__status');
    // Only surface a status chip when something went wrong. The user finds
    // the green "✓ done" noisy — they can see the run finished because the
    // pulsing dot stopped pulsing.
    if (outcome === 'done' || outcome === 'stopped') {
      // "done" — natural completion, no chip needed (the pulsing dot
      // stopping is enough signal).
      // "stopped" — user explicitly stopped this run; the "Interrupted"
      // chip on the user's bubble (set by _markLatestUserBubbleInterrupted
      // at stop-click time) already tells the story. A second "⏹ stopped"
      // chip + "(no text)" placeholder + a separate "Stopped." system
      // bubble was clutter the user explicitly asked us to remove.
      status.remove();
      // ALSO remove the empty assistant container entirely when the run
      // had no text AND no tool calls — leaves the user's bubble (with
      // its Interrupted chip) as the only artifact of the interaction,
      // exactly what the user requested.
      if (outcome === 'stopped' && !run.hasText && !container.querySelector('.toolcard')) {
        try { container.remove(); } catch {}
        const runs = this._runsFor(tabId);
        if (runs) runs.delete(String(runId));
        return;
      }
    } else {
      status.hidden = false;
      status.classList.add(`msg__status--${outcome}`);
      const icon = '⚠';
      status.textContent = `${icon} ${outcome}${detail ? ` — ${detail}` : ''}`;
      if (outcome === 'error' && detail && /session is in use/i.test(detail)) {
        try { toast('Session in use by VSCode — close it or start a new tab here', 'warn'); } catch {}
      }
    }
    if (outcome !== 'stopped' && !run.hasText && !container.querySelector('.toolcard')) {
      // Run produced literally nothing — no text, no tool calls. Make sure
      // the user sees SOMETHING so the bubble doesn't look empty. Skipped
      // for "stopped" runs (the empty container is removed above).
      const stream = container.querySelector('.msg__stream');
      if (stream && !stream.firstChild) {
        const body = document.createElement('div');
        body.className = 'msg__body';
        body.textContent = '(no text)';
        stream.append(body);
      }
    }
    const runs = this._runsFor(tabId);
    if (runs) runs.delete(String(runId));
    // Sweep phantom entries that came from a lazy beginRun on a frame
    // whose run_id was null/undefined (e.g. a watcher-driven media
    // frame that raced with run_finished and lost _run_id server-side).
    // Their run_finished can never arrive, so without sweeping them
    // tab.running stays stuck on at runs.size > 0 forever and the
    // composer's stop button never flips back to send.
    // Legitimate concurrent /ask runs use run_id >= 1_000_000 (see
    // sessions.py:143) so they have finite numeric keys and survive.
    if (runs && runs.size > 0) {
      for (const [key, entry] of Array.from(runs.entries())) {
        if (Number.isFinite(Number(key))) continue;
        try { entry.container && entry.container.classList.remove('msg--running'); } catch {}
        if (entry.cycler) { try { clearInterval(entry.cycler); } catch {} entry.cycler = null; }
        if (entry.spinnerTimer) { try { entry.spinnerTimer(); } catch {} entry.spinnerTimer = null; }
        runs.delete(key);
      }
    }
    // Attach copy action to the completed assistant message. Walks
    // the entire stream — prose bodies AND every tool card / result —
    // and serializes them to markdown so the clipboard payload
    // round-trips cleanly into any other AI chat (code stays code,
    // todos stay checklists, prose stays prose). Skipped when the
    // bubble already has an actions row from a re-renderable path.
    if (!container.querySelector(':scope > .msg__actions')) {
      this._attachMessageActions(container, () => this._renderRunAsMarkdown(container), {
        regenerable: true,
        getSpeechText: () => this._renderRunAsSpeech(container),
      });
      // Pre-wrap prose words so the user can tap any word to start
      // reading from there (TTS._handleWordClick), without having to
      // hit Speak first and then click. Idempotent — safe to call
      // every finalization.
      try { TTS._wrapWords(container); } catch {}
    }
    // Clear tab running flag if no runs remain. The tab strip dot stops
    // pulsing and the send button flips back to send-mode. Replay path
    // skips this — its synthetic finishRun calls must not clobber the
    // server-authoritative tab.running set by the hello frame.
    const tab = getTab(tabId);
    if (tab && !(opts && opts.silent)) {
      tab.running = runs && runs.size > 0;
      // Mark the local moment of finish so a stale hello frame arriving
      // within the next few seconds (server hasn't fully cleared its
      // list_running yet) can't re-assert tab.running=true and re-spawn
      // the ghost spinner with its own cycler.
      if (!tab.running) tab._lastFinishedAt = Date.now();
      renderTabs();
      // Drain ONE queued prompt — the next run_finished cycle picks
      // up the next one. Each queued prompt becomes its own turn in
      // the chat. Skip on `stopped` (the user already cancelled the
      // queue when they tapped Stop). Skip on `error` too — surfacing
      // the failure first lets the user decide whether to keep going.
      if (!tab.running && outcome === 'done' && tab._queue && tab._queue.length) {
        // Defer one tick so any UI cleanup tied to run_finished
        // (status chips, autoscroll, etc.) settles BEFORE we kick a
        // new run and start mutating the same chatpane again.
        setTimeout(() => _drainNextQueuedPrompt(tab), 0);
      }
    }
    // Per-tab attention dot: orange = "Claude finished while you were
    // away on another tab." Only fires for outcome=done (errors and
    // stopped runs are shown via other UI). Skipped for the active tab
    // and skipped when 'awaiting' (AskUserQuestion/ExitPlanMode) is
    // already pending on the same tab — that one outranks.
    if (outcome === 'done' && !(opts && opts.silent)) {
      this._setTabAttention(tabId, 'finished');
    }
    if (!(opts && opts.silent)) updateSendButton();
    // Recompute the ghost spinner: if tab.running is still true (queued
    // run, or hello says server is still busy on this tab), ensure the
    // spinner stays visible while the next container hasn't appeared.
    // Skipped during silent replay — replay calls finishRun on every
    // past turn, and creating+destroying a ghost on each one is wasted
    // churn. The end-of-replay caller handles the final sync.
    if (tab && !(opts && opts.silent)) this.ensureRunningSpinner(tab.id);
    // No `fromContent: true` here — the actions row + status chip we
    // just appended below the assistant bubble aren't NEW content the
    // user hasn't seen; they're trailing UI for content the user
    // already read. Passing fromContent would flash the "New messages"
    // pill when the user scrolled up DURING the run and the run then
    // completed, which read as a false alarm (Claude is done, nothing
    // new is coming). Plain scrollToBottom keeps follow-bottom users
    // pinned without raising the pill for scrolled-up users. Reported
    // 2026-05-19.
    this.scrollToBottom(false);
  },

  // Maintain a placeholder "thinking" container at the bottom of a
  // chatpane whenever the tab is marked running but no real
  // `.msg--asst.msg--running` container exists. Two scenarios need it:
  //   1. A tab restored from localStorage where the server-side run is
  //      still in flight — `_replaySessionInto` renders the past turns
  //      via synthetic IDs and removes their `.msg--running` class, so
  //      without the ghost the user sees the stop button but nothing
  //      animating.
  //   2. A WS reconnect that lost the in-memory run record but the
  //      server's hello frame still lists the tab as live.
  // Idempotent — safe to call after any state change.
  ensureRunningSpinner(tabId) {
    const tab = tabId ? getTab(tabId) : getActiveTab();
    if (!tab) return;
    const pane = tab._chatpane;
    if (!pane) return;
    const hasReal = pane.querySelector('.msg--asst.msg--running:not(.msg--ghostThinking)');
    if (hasReal || !tab.running) {
      const ghost = tab._ghostThinking;
      if (ghost) {
        try { if (ghost.__cleanup) ghost.__cleanup(); } catch {}
        try { ghost.remove(); } catch {}
        tab._ghostThinking = null;
      }
      return;
    }
    if (tab._ghostThinking && tab._ghostThinking.isConnected) return;
    const head = el('div', { class: 'msg__head' },
      el('span', { class: 'msg__dot' }),
      el('span', { class: 'msg__hint' }, 'Bridgy'),
    );
    // Same composition as the primary thinking row in Chat.beginRun
    // (mascot + word + dots, no propeller spinner — removed 2026-05-17
    // per user feedback that the stacked spinner+mascot felt busy).
    const mascot = el('img', {
      class: 'thinking__mascot',
      src: '/icons/kawaii_blob.png?v=1.0.83',
      alt: '',
      'aria-hidden': 'true',
      width: '18',
      height: '18',
    });
    const word = el('span', { class: 'thinking__word' },
      THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)]);
    const dots = el('span', { class: 'thinking__dots' }, '…');
    const thinking = el('div', { class: 'msg__thinking' }, mascot, word, dots);
    const cycler = setInterval(() => {
      word.textContent = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
    }, 2500);
    const wrap = el('div',
      { class: 'msg msg--asst msg--running msg--ghostThinking' },
      head, thinking,
    );
    wrap.__cleanup = () => { clearInterval(cycler); };
    pane.append(wrap);
    tab._ghostThinking = wrap;
    this.scrollToBottom(false, { fromContent: true });
  },

  // Capture claude's session UUID for the originating tab. Used both to
  // thread subsequent --resume runs and to label the tab in history later.
  // Also refresh the drawer if it's open — the .jsonl file is now on
  // disk, so the new chat should appear at the top of the sessions list.
  setSessionId(tabId, sessionId) {
    const tab = getTab(tabId);
    if (!tab || !sessionId) return;
    tab.sessionId = sessionId;
    _persistTabs();
    if (typeof isSessionsDrawerOpen === 'function' && isSessionsDrawerOpen()) {
      _loadSessionsIntoDrawer();
    }
  },

  // Top-level frame dispatch.
  handleFrame(frame) {
    const tid = frame.tab_id || null;
    switch (frame.type) {
      case 'hello':
        // App is live — dismiss the splash overlay. Initial paint is
        // already in place by the time hello arrives, so the fade-out
        // reveals the chat UI directly underneath.
        try { _clearSplashStuckTimer(); } catch {}
        try { Splash.dismiss(); } catch {}
        State.projects = frame.projects || [];
        // Initialize mode from server default if local isn't set yet.
        if (!_lsGet('crc.mode') && frame.default_permission_mode) {
          State.permissionMode = frame.default_permission_mode;
        }
        // Reconcile per-tab running state against the server's
        // authoritative list. Fixes the "send button stuck on stop"
        // bug after the PWA returns from background: while suspended,
        // the run finished on the laptop and the run_finished frame
        // was lost, so `tab.running` stayed true client-side. The
        // hello frame's `running` array tells us exactly which tabs
        // still have live runs; everything else flips back to ready.
        try {
          const liveTabIds = new Set((frame.running || []).map((r) => r.tab_id));
          for (const tab of State.tabs || []) {
            const live = liveTabIds.has(tab.id);
            if (tab.running && !live) {
              // Server says this tab isn't running anymore — `run_finished`
              // never reached us (WS reconnect, background suspend, etc.).
              // Sweep cyclers from any tracked runs AND strip `msg--running`
              // from every orphan container in the DOM, otherwise the kawaii
              // mascot + status word keeps animating forever (reported
              // 2026-05-20).
              if (tab._activeRuns) {
                for (const run of tab._activeRuns.values()) {
                  if (run.cycler) { clearInterval(run.cycler); run.cycler = null; }
                  if (run.spinnerTimer) { try { run.spinnerTimer(); } catch {} run.spinnerTimer = null; }
                  if (run.container) { try { run.container.classList.remove('msg--running'); } catch {} }
                }
                tab._activeRuns.clear();
              }
              if (tab._chatpane) {
                tab._chatpane.querySelectorAll(
                  '.msg--asst.msg--running:not(.msg--ghostThinking)'
                ).forEach((stale) => {
                  try { stale.classList.remove('msg--running'); } catch {}
                });
              }
              tab.running = false;
              tab._lastFinishedAt = Date.now();
            } else if (live) {
              // Ignore "still running" if we JUST finished a run locally.
              // Server's list_running has a brief reconciliation lag; a
              // hello arriving within ~3s of finishRun would otherwise
              // re-mark the tab as live and spawn a ghost spinner whose
              // cycler runs forever (kawaii + gibberish-word stuck —
              // reported 2026-05-19).
              const finishedAge = tab._lastFinishedAt
                ? Date.now() - tab._lastFinishedAt
                : Infinity;
              if (finishedAge < 3000) {
                tab.running = false;
                if (tab._activeRuns) tab._activeRuns.clear();
              } else {
                // If tab.running was ALREADY true before this hello, the
                // WS just reconnected mid-run — deltas claude emitted
                // between ws.close and ws.open went to the dropped
                // queue and are now lost. Flag the tab so the upcoming
                // run_finished handler backfills the missing chunk from
                // jsonl instead of discarding events (reported
                // 2026-05-21: assistant text was incomplete on resume
                // until the user refreshed the page).
                if (tab.running) {
                  tab._lossyRun = true;
                }
                tab.running = true;
              }
            }
            // After reconciling, sync the placeholder spinner so a
            // restored tab whose run is still alive on the server
            // shows a "still working" indicator even though replay's
            // synthetic finishRun calls already stripped msg--running
            // from every rendered container.
            try { Chat.ensureRunningSpinner(tab.id); } catch {}
            // Persisted queue drain: if the user queued prompts during
            // a long run, closed the PWA, and the run finished while
            // they were away, the run_finished frame never reached
            // this client and the regular drain trigger never fired.
            // Now that hello told us the tab is no longer running, fire
            // the queue ourselves. Defer one tick so any pane hydration
            // tied to this hello settles first.
            if (!tab.running && tab._queue && tab._queue.length) {
              setTimeout(() => { try { _drainNextQueuedPrompt(tab); } catch {} }, 0);
            }
          }
          renderTabs();
          updateSendButton();
        } catch (e) { try { console.warn('[hello] running sync failed:', e && e.message); } catch {} }
        renderTopbar();
        renderMode();
        // Mic visibility = browser-capability check. Whisper runs on the
        // laptop, so the only requirement on the client side is the ability
        // to capture audio (getUserMedia) and stream it into a Blob
        // (MediaRecorder). Both are universal on modern Safari/Chrome.
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
          const micBtn = $('#micBtn');
          if (micBtn) micBtn.style.display = 'none';
        }
        // Stale-assets banner. iOS standalone PWAs sometimes serve a
        // cached app.js even after the bridge restarts with new code;
        // this is the canonical "you need to reload" signal so the
        // user isn't left wondering why nothing changed.
        if (frame.asset_version && frame.asset_version !== CRC_ASSET_VERSION) {
          console.warn('[CRC] asset mismatch: client=' + CRC_ASSET_VERSION + ' server=' + frame.asset_version);
          showStaleAssetsBanner(frame.asset_version);
        }
        // Build version lives in the ⋯ menu (Menu → "Build …") so it
        // doesn't crowd the meta row. Show client+server in case they
        // disagree (which would also trigger the stale banner above).
        const statusEl = $('#connStatus');
        if (statusEl) statusEl.setAttribute('title', 'client v' + CRC_ASSET_VERSION + ' · server v' + (frame.asset_version || '?'));
        const verEl = $('#menuVersion');
        if (verEl) {
          const server = frame.asset_version || '?';
          verEl.textContent = (CRC_ASSET_VERSION === server)
            ? `Build v${CRC_ASSET_VERSION}`
            : `Build v${CRC_ASSET_VERSION} · server v${server}`;
        }
        break;
      case 'run_started': {
        if (tid && getTab(tid) && getTab(tid)._compactSilent) break;
        // Server confirmed the run started — the prompt we sent is now
        // in flight, so it can no longer be rejected as "Tab busy".
        // Clear the captured payload so future "Tab busy" text frames
        // don't accidentally re-queue this completed handoff.
        const startedTab = tid ? getTab(tid) : getActiveTab();
        if (startedTab) startedTab._lastSendPayload = null;
        this.beginRun(frame.project, frame.run_id, tid);
        break;
      }
      case 'delta':
        if (tid && getTab(tid) && getTab(tid)._compactSilent) break;
        this.appendDelta(frame.project, frame.run_id, frame.text || '', tid);
        break;
      case 'tool_use':
        if (tid && getTab(tid) && getTab(tid)._compactSilent) break;
        this.appendToolUse(frame.project, frame.run_id, frame.name || '', frame.input || {}, tid, frame.tool_use_id || '');
        break;
      case 'tool_error':
        if (tid && getTab(tid) && getTab(tid)._compactSilent) break;
        this.appendToolError(frame.project, frame.run_id, frame.text || '', tid, frame.tool_use_id || '');
        break;
      case 'tool_result':
        if (tid && getTab(tid) && getTab(tid)._compactSilent) break;
        this.appendToolResult(frame.project, frame.run_id, frame.tool_use_id || '', frame.text || '', !!frame.is_error, tid);
        break;
      case 'media':
        if (tid && getTab(tid) && getTab(tid)._compactSilent) break;
        this.appendMedia(frame.project, frame.run_id, frame, tid);
        break;
      case 'text': {
        const txt = frame.text || '';
        if (tid && getTab(tid) && getTab(tid)._compactSilent) break;
        // Server-side "Tab busy" rejection — the user's client thought
        // the tab was idle but the server is still mid-run (typically
        // a tab.running desync after a page reload or a long-running
        // turn). Re-route the rejected payload into the client queue
        // instead of showing the user a "Tab busy" system message that
        // would otherwise eat their prompt. The existing run_finished
        // drain code picks it up automatically when the current turn
        // completes.
        if (/^Tab busy/i.test(txt.trim())) {
          const tab = tid ? getTab(tid) : getActiveTab();
          if (tab && tab._lastSendPayload) {
            const payload = tab._lastSendPayload;
            tab._lastSendPayload = null;
            // Server is busy → mark the tab running so the composer
            // flips to "queue" mode and the ghost spinner appears.
            tab.running = true;
            if (!tab._queue) tab._queue = [];
            tab._queue.push(payload);
            // Persist immediately — without this, a queued prompt added
            // via the server-busy path (vs. the client-side _enqueueCurrentPrompt
            // path which already persists) vanishes on app close+reopen.
            // The other persist sites won't pick it up because nothing else
            // mutates here until run_finished or the user types again.
            try { _persistTabs(); } catch {}
            // The user already saw their bubble appear (sendPrompt
            // pushed it). Visually demote it to "queued" so they know
            // the message isn't being processed YET — it's stacked up.
            try { _markLatestUserBubbleQueued(tab.id); } catch {}
            try { Chat.ensureRunningSpinner(tab.id); } catch {}
            try { renderTabs(); } catch {}
            try { updateSendButton(); } catch {}
            try { toast('Server busy — queued for after current run', 'info'); } catch {}
            break;
          }
        }
        this.pushSystem(txt, frame.project, tid);
        break;
      }
      case 'run_finished':
        this.finishRun(frame.project, frame.run_id, frame.outcome, frame.detail || '', tid);
        // `lastRunCost` is captured on the final `usage` WS frame (carries
        // cost_usd) rather than here, since the run's cost arrives via
        // claude's `result` stream-json event before run_finished fires.
        // If this run was a compact (donut → Compact button set
        // tab.compactPending), hit the server's mark_compact endpoint
        // so the jsonl gets an isCompactSummary marker — the donut's
        // char counter resets at that boundary and the % display
        // honestly reflects the post-compact state.
        if (tid) {
          const tabForCompact = getTab(tid);
          if (tabForCompact && tabForCompact.compactPending && frame.outcome === 'done') {
            tabForCompact.compactPending = false;
            // Auto-compact set this; clear here too so a subsequent
            // run that re-crosses the threshold can re-trigger
            // (otherwise the 60s setTimeout below was the only path
            // back, suppressing re-fires for a full minute even on
            // success).
            tabForCompact._autoCompactFiring = false;
            _finalizeCompact(tabForCompact);
          } else if (tabForCompact) {
            // If the compact run errored or was stopped, drop the
            // flag so the next normal run uses normal spinner words.
            tabForCompact.compactPending = false;
            tabForCompact._compactSilent = false;
            tabForCompact._autoCompactFiring = false;
          }
          // ─── Auto-compact ────────────────────────────────────────
          // After a successful natural run, check if context is over
          // 80% of the auto-compact threshold. If so, fire the same
          // compact flow as the manual donut-tap path — no dialog, no
          // user interaction. The user explicitly asked for compact to
          // fire automatically when the donut crosses the warning
          // line (~85% used in their report).
          // Auto-compact also fires on `stopped` and `error` outcomes,
          // not only on `done`. The user crossing 80% context and then
          // pausing the run (outcome=stopped) used to leave the session
          // perpetually over-budget — compact never ran because the
          // gate required `done`. Now: whenever the run is OVER and
          // context is past 80%, schedule the compact. The donut and
          // the user's mental model agree: "I'm at 80%, the next thing
          // should be a compact, regardless of how this run ended."
          if (tabForCompact) _maybeFireAutoCompact(tabForCompact, frame.outcome);
        }
        // The phone-driven run is done. Re-arm the jsonl poll, but
        // first advance the tail offset to the current file size so
        // we don't re-render the events the WS just streamed. We do
        // that by fetching once with the current `since` and just
        // taking the new tail_offset (events themselves are discarded
        // here — they've already been rendered live via WS).
        //
        // ALSO: if the tab is flagged `_lossyRun` (the hello handler
        // saw a WS reconnect while a run was still in flight), the
        // live container is missing the chunk of text claude emitted
        // during the WS-down window. Backfill from jsonl instead of
        // discarding events: strip every node after the last user
        // bubble and re-render the turn via `_appendLiveEvents`.
        if (tid) {
          const tab = getTab(tid);
          const needsLossyBackfill = !!(tab && tab._lossyRun);
          if (tab && (tab._wsRunInFlight || needsLossyBackfill)) {
            const proj = tab.project;
            const sid = tab.sessionId;
            const since = tab.sessionTailOffset || 0;
            if (proj && sid) {
              fetch(
                `/api/sessions/${encodeURIComponent(proj)}/${encodeURIComponent(sid)}/messages?since=${since}`,
                { headers: CSRF_HEADERS },
              ).then((r) => r.ok ? r.json() : null)
               .then((data) => {
                 if (needsLossyBackfill) {
                   tab._lossyRun = false;
                   const evs = (data && data.events) || [];
                   if (evs.length) {
                     try { _lossyBackfillTurn(tab, proj, evs); } catch (e) {
                       try { console.warn('[lossy-backfill] failed:', e && e.message); } catch {}
                     }
                   }
                 }
                 if (data && typeof data.tail_offset === 'number') {
                   tab.sessionTailOffset = data.tail_offset;
                 }
                 tab._wsRunInFlight = false;
               })
               .catch(() => {
                 if (needsLossyBackfill) tab._lossyRun = false;
                 tab._wsRunInFlight = false;
               });
            } else {
              if (needsLossyBackfill) tab._lossyRun = false;
              tab._wsRunInFlight = false;
            }
          }
        }
        break;
      case 'session_init':
        this.setSessionId(tid, frame.session_id);
        break;
      case 'usage':
        // Per-message usage. The server now precomputes context_used
        // by walking the session's jsonl on disk (chars / 3.5 + fixed
        // overhead) and sends it on every usage frame — we just use
        // that directly. The other fields (input/output/cache_*) are
        // for the donut's tap-to-see-detail toast.
        if (tid) {
          const tab = getTab(tid);
          if (tab) {
            tab.usage = {
              input: frame.input_tokens || 0,
              output: frame.output_tokens || 0,
              cache_read: frame.cache_read_tokens || 0,
              cache_creation: frame.cache_creation_tokens || 0,
              context_used: frame.context_used || 0,
              ts: Date.now(),
            };
            // Cost is only populated on `result`-driven usage frames
            // (i.e. the run's final frame). Carry forward so /cost can
            // show the last billed amount.
            if (typeof frame.cost_usd === 'number') {
              tab.lastRunCost = frame.cost_usd;
            }
            // Server reports the model that actually served this turn.
            // When the user's picker is on "Auto" (tab.model = ''), we
            // surface this as "Auto · Sonnet 4.6" so they see what
            // claude.exe's default resolved to. When they've picked a
            // specific model, this is mostly redundant but kept so we
            // can detect a mismatch (e.g. they asked for Opus but got
            // Sonnet because their subscription doesn't include Opus).
            if (frame.model) {
              tab.modelInUse = frame.model;
              if (tid === State.activeTabId) renderModelChip();
            }
            if (tid === State.activeTabId) renderUsageDonut();
            // Re-check auto-compact on every usage update. Catches the
            // case where context crossed the threshold mid-run but
            // `run_finished` either hasn't arrived yet or was the
            // post-AskUserQuestion terminate where the final `result`
            // event never reached us. _maybeFireAutoCompact's gating
            // refuses to interrupt an in-flight run, so the actual
            // fire still waits for the natural quiet point.
            _maybeFireAutoCompact(tab, null);
          }
        }
        break;
      case 'state':
        // Legacy: server doesn't emit this anymore, but be tolerant.
        break;
      case 'error':
        toast(frame.error || 'Error', 'error');
        // Server-side validation errors (e.g. "Invalid model", attachment
        // outside uploads jail) are emitted as `error` with no run_started
        // and no run_finished. The client optimistically set _wsRunInFlight
        // on `WS.send`, which then stays pinned forever — blocking the
        // jsonl-poll for that tab. Clear the in-flight flag (and the stop
        // chip) so the user can recover without a refresh. Most server
        // error frames don't carry a tab_id, so fall back to the active
        // tab (the one whose prompt frame we just sent).
        {
          const errTab = (tid && getTab(tid)) || getActiveTab();
          if (errTab) {
            errTab._wsRunInFlight = false;
            if (errTab.running && (!errTab._activeRuns || errTab._activeRuns.size === 0)) {
              errTab.running = false;
              renderTabs();
              updateSendButton();
            }
          }
        }
        break;
      case 'pong': break;
      default:
        console.warn('Unknown frame', frame);
    }
  },
};

// ─── Top bar / project switcher ───────────────────────────────────────

function renderTopbar() {
  const active = getActiveTab();
  $('#projectName').textContent = (active && active.project) ? active.project : '(no project)';
}

// Whether the next project pick should create a NEW tab vs. mutate the
// active tab's project. Default behavior:
//   - "+" tab button or "no tabs" state: create new tab
//   - tapping the topbar chip on an existing tab: replace that tab's
//     project (but ONLY if the tab has no messages yet — otherwise create
//     a new tab so we don't strand an existing conversation).
let _projectPickerMode = 'auto';  // 'new' | 'replace' | 'auto'

function openProjectPicker(mode) {
  _projectPickerMode = mode || 'auto';
  const list = $('#projectList');
  list.innerHTML = '';
  if (!State.projects.length) {
    list.append(el('li', {}, el('div', { class: 'sheet__optDesc' }, 'No projects found. Check PROJECTS_ROOT.')));
  }
  const activeProject = (getActiveTab() || {}).project || null;
  for (const name of State.projects) {
    const li = el('li',
      { dataset: { project: name }, 'aria-selected': name === activeProject ? 'true' : 'false' },
      el('div', { class: 'sheet__optTitle' }, name),
    );
    li.addEventListener('click', () => {
      pickProject(name);
      closeSheet('projectSheet');
    });
    list.append(li);
  }
  // Shortcut row at the bottom — one tap to the folder picker with
  // Home / Desktop / Documents / Downloads / default root visible. Without
  // this the user has to dig through Menu → Workspace → Browse to switch
  // root, which buries the most common "I want a different repo" flow.
  const browseLi = el('li',
    { class: 'projectList__browse', dataset: { action: 'browse-folders' } },
    el('div', { class: 'sheet__optTitle' }, 'Browse other folders…'),
    el('div', { class: 'sheet__optDesc' }, 'Pick a project from Desktop, Documents, Downloads, or anywhere else.'),
  );
  browseLi.addEventListener('click', () => {
    closeSheet('projectSheet');
    openWorkspaceSheet({ openPicker: true });
  });
  list.append(browseLi);
  openSheet('projectSheet');
}

function pickProject(name) {
  // Decide whether to mutate the active tab or open a new one.
  let mode = _projectPickerMode;
  const active = getActiveTab();
  if (mode === 'auto') {
    if (!active) {
      mode = 'new';   // no tabs yet — first project pick creates the first tab
    } else if (active._chatpane && active._chatpane.querySelector('.msg')) {
      mode = 'new';   // active tab already has a conversation — new tab
    } else {
      mode = 'replace';   // empty active tab — just point it at the picked project
    }
  }
  if (mode === 'new') {
    createTab(name);
  } else {
    // 'replace': just change the project label on the empty active tab.
    if (active) {
      active.project = name;
      // Different project → different .claude/agents/ — clear any agent
      // pick from the prior project so we don't try to spawn claude with
      // an --agent name that doesn't exist in the new workspace.
      active.agent = null;
      _persistTabs();
      renderTabs();
      renderTopbar();
      updateSendButton();
      renderAgentChip();
    } else {
      createTab(name);
    }
  }
  _saveActiveProject(name);
  _projectPickerMode = 'auto';
}

$('#projectBtn').addEventListener('click', () => openProjectPicker('auto'));

// Clock icon on the tab strip: same as Menu → Past conversations, but
// one tap away. The menu entry stays for discoverability.
const historyTabBtn = $('#historyTabBtn');
if (historyTabBtn) historyTabBtn.addEventListener('click', () => openHistorySheet());

// Topbar + button: opens a small chooser every tap so the user can pick
// between "another chat on this project" and "pick a different project"
// — two-different-projects-in-two-tabs is the main reason this chooser
// exists. If there's no active project yet (cold start), skip the
// chooser and jump straight to the project picker.
$('#newSessionBtn').addEventListener('click', () => {
  const active = getActiveTab();
  if (!active || !active.project) {
    openProjectPicker('new');
    return;
  }
  const sameLbl = $('#newTabSameTitle');
  if (sameLbl) sameLbl.textContent = `New chat in ${active.project}`;
  openSheet('newTabSheet');
});

$$('#newTabList li').forEach((li) => {
  li.addEventListener('click', () => {
    const which = li.dataset.newtab;
    closeSheet('newTabSheet');
    if (which === 'same') {
      const active = getActiveTab();
      if (active && active.project) createTab(active.project);
      else openProjectPicker('new');
    } else if (which === 'different') {
      openProjectPicker('new');
    }
  });
});

// Hamburger / logo button: opens the sessions drawer. Same data as
// Menu → Past conversations, but listing sessions across all projects
// in one place — modeled on the VS Code Claude Code extension's
// Sessions panel.
$('#logoBtn').addEventListener('click', () => openSessionsDrawer());

$('#reloadBtn').addEventListener('click', () => {
  // Same as ⋯ → Reload app + the pull-to-refresh gesture, just one tap
  // away. Forces a fresh fetch of HTML/CSS/JS — useful after server-side
  // changes since iOS Safari PWA mode disables native pull-to-refresh.
  location.reload();
});

// ─── Permission mode ──────────────────────────────────────────────────

function renderMode() {
  const label = MODE_LABEL[State.permissionMode] || State.permissionMode;
  const eff = EFFORT_LABEL[State.effort] || State.effort;
  $('#modeChipLabel').textContent = `${label} · ${eff}`;
}

// Server-side permission_mode is one of {ask, edits, plan, auto}. The UI
// has 5 labels — "autoshift" (Auto mode) maps to "edits" server-side.
function serverPermissionMode() {
  return MODE_TO_SERVER[State.permissionMode] || State.permissionMode;
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

function renderEffortSlider() {
  const idx = Math.max(0, EFFORT_ORDER.indexOf(State.effort));
  $$('#effortTrack .effortRow__dot').forEach((stop, i) => {
    stop.removeAttribute('data-active');
    stop.removeAttribute('data-passed');
    if (i < idx) stop.setAttribute('data-passed', '');
    if (i === idx) stop.setAttribute('data-active', '');
  });
  const val = $('#effortValue');
  if (val) val.textContent = `(${EFFORT_LABEL[State.effort] || State.effort})`;
  const track = $('#effortTrack');
  if (track) track.setAttribute('aria-valuenow', String(idx));
}

$('#modeChip').addEventListener('click', () => {
  $$('#modeList li').forEach((li) => {
    li.setAttribute('aria-selected', li.dataset.mode === State.permissionMode ? 'true' : 'false');
  });
  renderEffortSlider();
  openSheet('modeSheet');
});
$$('#modeList li').forEach((li) => {
  li.addEventListener('click', () => {
    State.permissionMode = li.dataset.mode;
    try { localStorage.setItem('crc.mode', State.permissionMode); } catch {}
    if (State.permissionMode === 'ask') {
      toast('Ask mode: Write/Edit return a permission error; Bash + reads run.', 'info');
    }
    $$('#modeList li').forEach((x) => x.setAttribute('aria-selected', x.dataset.mode === State.permissionMode ? 'true' : 'false'));
    renderMode();
  });
});

// Per-tab model picker. Each tab can use a different Claude model and you
// can swap mid-conversation — claude.exe handles `--resume <id> --model
// <new>` by reading the prior turns from the jsonl and continuing with
// the new model. State lives on the tab so switching tabs preserves
// each one's choice. Empty string = "Auto" = let the server's
// CLAUDE_MODEL config decide.
const MODEL_LABELS = {
  '': 'Auto',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};
function _activeTabModel() {
  const tab = getActiveTab();
  if (tab && tab.model != null) return tab.model;
  // Fall back to the global default stored in localStorage. Set when
  // the user taps a model in the picker before any tab exists.
  try { return localStorage.getItem('crc.model') || ''; } catch { return ''; }
}
// SVG shapes for the model chip, keyed by model id. Same vocabulary
// as the picker sheet: target / mountain peak / hexagon / bolt. Auto
// shares the target glyph. Returns a string of SVG markup sized for
// the 14px modechip__icon slot.
const _MODEL_CHIP_SVGS = {
  // Empty string = Auto.
  '': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><path d="M12 2.5v3M12 18.5V21.5M2.5 12h3M18.5 12h3"/></svg>',
  'claude-opus-4-7':
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2 20.5L7.5 11l3 4 4.5-8 7 13.5z"/><circle cx="15" cy="5" r="1.6"/></svg>',
  'claude-sonnet-4-6':
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5L12 2.5z"/></svg>',
  'claude-haiku-4-5-20251001':
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13.7 1.8L4.5 13.5h6l-1.7 8.7L19.5 9.5h-6.2z"/></svg>',
};

function renderModelChip() {
  const label = $('#modelChipLabel');
  if (!label) return;
  const tab = getActiveTab();
  // Use the same source-of-truth as _activeTabModel: tab.model first,
  // then the global default from localStorage. Without this fallback,
  // picking a model on a cold app (no tab yet) updated localStorage
  // but the chip label kept showing "Auto" because tab.model was null.
  const picked = _activeTabModel();
  const inUse = tab && tab.modelInUse ? tab.modelInUse : '';
  // Swap the chip's icon to match the picked model. Falls back to the
  // Auto glyph (target) for unknown ids.
  const iconSlot = $('#modelChip .modechip__icon');
  if (iconSlot) {
    iconSlot.innerHTML = _MODEL_CHIP_SVGS[picked] || _MODEL_CHIP_SVGS[''];
  }
  if (!picked) {
    // Auto — show what model claude.exe's default resolved to (once
    // we've received a usage frame). Until then just "Auto".
    if (inUse) {
      label.textContent = `Auto · ${MODEL_LABELS[inUse] || inUse}`;
    } else {
      label.textContent = 'Auto';
    }
  } else {
    // User picked a specific model. Show its display name. If for some
    // reason the server reports a different model in use (subscription
    // doesn't include their pick, claude.exe fell back), surface the
    // mismatch so they're not misled.
    const pickedLabel = MODEL_LABELS[picked] || picked;
    if (inUse && inUse !== picked) {
      label.textContent = `${pickedLabel} · ⚠ ${MODEL_LABELS[inUse] || inUse}`;
    } else {
      label.textContent = pickedLabel;
    }
  }
}
$('#modelChip').addEventListener('click', () => {
  const current = _activeTabModel();
  $$('#modelList li').forEach((li) => {
    li.setAttribute('aria-selected', li.dataset.model === current ? 'true' : 'false');
  });
  openSheet('modelSheet');
});
$$('#modelList li').forEach((li) => {
  li.addEventListener('click', () => {
    const choice = li.dataset.model || '';
    const tab = getActiveTab();
    // Always persist the choice as the default for future tabs.
    // Without this, tapping a model on a cold app (before any project
    // is picked) did nothing — `getActiveTab()` was null and the
    // handler bailed silently. Now it lands in localStorage and the
    // next tab createTab() reads it.
    try { localStorage.setItem('crc.model', choice); } catch {}
    if (tab) {
      tab.model = choice;
      _persistTabs();
    }
    $$('#modelList li').forEach((x) => x.setAttribute('aria-selected', x.dataset.model === choice ? 'true' : 'false'));
    renderModelChip();
    closeSheet('modelSheet');
  });
});

// ─── Agent chip ───────────────────────────────────────────────────────
// Per-tab subagent selection. Tap → bottom sheet listing
// `.claude/agents/*.md` for the active project. Pick one to route the
// next prompt through claude's `--agent <name>` flag.
const _agentChipCache = { project: null, agents: [] };

async function _loadAgentsForActiveTab() {
  const tab = getActiveTab();
  if (!tab || !tab.project) {
    _agentChipCache.project = null;
    _agentChipCache.agents = [];
    return [];
  }
  if (_agentChipCache.project === tab.project) return _agentChipCache.agents;
  try {
    const r = await fetch(
      '/api/agents?project=' + encodeURIComponent(tab.project),
      { headers: CSRF_HEADERS },
    );
    const data = await r.json();
    _agentChipCache.project = tab.project;
    _agentChipCache.agents = Array.isArray(data.agents) ? data.agents : [];
  } catch {
    _agentChipCache.project = tab.project;
    _agentChipCache.agents = [];
  }
  return _agentChipCache.agents;
}

async function renderAgentChip() {
  const chip = $('#agentChip');
  const label = $('#agentChipLabel');
  if (!chip || !label) return;
  const tab = getActiveTab();
  if (!tab || !tab.project) {
    chip.hidden = true;
    return;
  }
  const agents = await _loadAgentsForActiveTab();
  if (!agents.length) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const picked = tab.agent || '';
  if (!picked) {
    label.textContent = 'Default';
  } else {
    label.textContent = picked;
  }
}

function _renderAgentList() {
  const list = $('#agentList');
  const empty = $('#agentListEmpty');
  if (!list) return;
  const tab = getActiveTab();
  const picked = (tab && tab.agent) || '';
  const agents = _agentChipCache.agents;
  list.querySelectorAll('li[data-agent]').forEach((li) => li.remove());
  if (empty) empty.hidden = agents.length > 0;
  const rows = [
    { name: '', desc: 'Use Claude\'s default main thread (no --agent flag).', tools: '' },
    ...agents.map((a) => ({
      name: a.name,
      desc: a.description || '(no description)',
      tools: a.tools || '',
    })),
  ];
  for (const row of rows) {
    const li = document.createElement('li');
    li.dataset.agent = row.name;
    li.setAttribute('aria-selected', row.name === picked ? 'true' : 'false');
    const title = document.createElement('div');
    title.className = 'sheet__optTitle';
    title.textContent = row.name || 'Default';
    const desc = document.createElement('div');
    desc.className = 'sheet__optDesc';
    desc.textContent = row.tools ? `${row.desc} (tools: ${row.tools})` : row.desc;
    const wrap = document.createElement('div');
    wrap.appendChild(title);
    wrap.appendChild(desc);
    li.appendChild(wrap);
    li.addEventListener('click', () => {
      const choice = li.dataset.agent || '';
      const t = getActiveTab();
      if (t) {
        t.agent = choice || null;
        _persistTabs();
      }
      $$('#agentList li[data-agent]').forEach((x) =>
        x.setAttribute('aria-selected', x.dataset.agent === choice ? 'true' : 'false'),
      );
      renderAgentChip();
      closeSheet('agentSheet');
    });
    list.appendChild(li);
  }
}

$('#agentChip').addEventListener('click', async () => {
  await _loadAgentsForActiveTab();
  _renderAgentList();
  openSheet('agentSheet');
});

// ─── MCP server manager ────────────────────────────────────────────────
// Read-and-write wrapper around `claude mcp list / add / remove`. Opened
// via `/mcp` in the slash picker. Persists nothing in the bridge itself
// — every action shells out to claude and re-reads the canonical list.

async function _refreshMcpList() {
  const list = $('#mcpList');
  const empty = $('#mcpListEmpty');
  if (!list || !empty) return;
  list.querySelectorAll('li[data-mcp]').forEach((li) => li.remove());
  empty.hidden = false;
  empty.textContent = 'Loading…';
  const tab = getActiveTab();
  const qs = tab && tab.project
    ? '?project=' + encodeURIComponent(tab.project)
    : '';
  try {
    const r = await fetch('/api/mcp/servers' + qs, { headers: CSRF_HEADERS });
    const data = await r.json();
    if (!r.ok) {
      empty.textContent = 'List failed: ' + (data.detail || r.status);
      empty.hidden = false;
      return;
    }
    const servers = data.servers || [];
    if (!servers.length) {
      empty.textContent = '(no MCP servers configured for this project)';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const s of servers) {
      const li = document.createElement('li');
      li.dataset.mcp = s.name;
      const left = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'sheet__optTitle';
      title.textContent = s.name;
      const desc = document.createElement('div');
      desc.className = 'sheet__optDesc';
      desc.textContent = s.target + (s.status ? ` · ${s.status}` : '');
      left.appendChild(title); left.appendChild(desc);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sheet__rowAction';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove MCP server "${s.name}"?`)) return;
        btn.disabled = true;
        const project = (getActiveTab() && getActiveTab().project) || '';
        const url = '/api/mcp/servers/' + encodeURIComponent(s.name)
          + '?scope=project'
          + (project ? '&project=' + encodeURIComponent(project) : '');
        try {
          const r = await fetch(url, { method: 'DELETE', headers: CSRF_HEADERS });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            toast('Remove failed: ' + (data.detail || r.status), 'warn');
            btn.disabled = false;
            return;
          }
          toast(`Removed "${s.name}"`, 'info');
          await _refreshMcpList();
        } catch (err) {
          toast('Remove failed: ' + (err.message || err), 'warn');
          btn.disabled = false;
        }
      });
      li.appendChild(left);
      li.appendChild(btn);
      list.appendChild(li);
    }
  } catch (e) {
    empty.textContent = 'List failed: ' + (e.message || e);
    empty.hidden = false;
  }
}

function openMcpSheet() {
  _refreshMcpList();
  openSheet('mcpSheet');
}

// ─── Agents CRUD ────────────────────────────────────────────────────────
// /agents opens an admin sheet listing every subagent file with edit /
// delete buttons + a "New agent" entry point. Save flows through
// /api/agents POST/PUT (atomic writes with .bak backups server-side), and
// the agent-chip cache is invalidated on every change so the next chip
// open shows the fresh list.

async function _refreshAgentsAdminList() {
  const list = $('#agentsAdminList');
  const empty = $('#agentsAdminEmpty');
  if (!list || !empty) return;
  list.querySelectorAll('li[data-agent-row]').forEach((li) => li.remove());
  empty.hidden = false;
  empty.textContent = 'Loading…';
  const tab = getActiveTab();
  if (!tab || !tab.project) {
    empty.textContent = 'Open a project first.';
    return;
  }
  try {
    const r = await fetch(
      '/api/agents?project=' + encodeURIComponent(tab.project),
      { headers: CSRF_HEADERS },
    );
    const data = await r.json();
    if (!r.ok) {
      empty.textContent = 'List failed: ' + (data.detail || r.status);
      return;
    }
    const agents = data.agents || [];
    if (!agents.length) {
      empty.textContent = '(no subagents yet — tap "+ New agent" to create one)';
      return;
    }
    empty.hidden = true;
    for (const a of agents) {
      const li = document.createElement('li');
      li.dataset.agentRow = a.name;
      const left = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'sheet__optTitle';
      title.textContent = a.name;
      const desc = document.createElement('div');
      desc.className = 'sheet__optDesc';
      desc.textContent = a.description || '(no description)';
      left.appendChild(title); left.appendChild(desc);
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'sheet__rowAction';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAgentEditSheet(a.name);
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'sheet__rowAction';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete subagent "${a.name}"? A .bak copy stays on disk.`)) return;
        delBtn.disabled = true;
        const project = (getActiveTab() && getActiveTab().project) || '';
        const url = '/api/agents/' + encodeURIComponent(a.name)
          + '?project=' + encodeURIComponent(project);
        try {
          const r = await fetch(url, { method: 'DELETE', headers: CSRF_HEADERS });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            toast('Delete failed: ' + (data.detail || r.status), 'warn');
            delBtn.disabled = false;
            return;
          }
          toast(`Deleted "${a.name}"`, 'info');
          _agentChipCache.project = null;   // force reload
          await _refreshAgentsAdminList();
          renderAgentChip();
        } catch (err) {
          toast('Delete failed: ' + (err.message || err), 'warn');
          delBtn.disabled = false;
        }
      });
      li.appendChild(left);
      li.appendChild(editBtn);
      li.appendChild(delBtn);
      list.appendChild(li);
    }
  } catch (e) {
    empty.textContent = 'List failed: ' + (e.message || e);
  }
}

function openAgentsAdminSheet() {
  _refreshAgentsAdminList();
  openSheet('agentsAdminSheet');
}

// /schedule sheet — lists every Task Scheduler entry with a `crc-` prefix,
// lets the user create new ones (interval / daily / once) and delete
// existing ones. Backed by /api/schedule/* (Windows-only — server returns
// 503 elsewhere, which the client surfaces as an inline note).
async function openScheduleSheet() {
  // Populate the project <select> with the projects we know about.
  try {
    const sel = document.getElementById('scheduleProjectSelect');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = '';
      const projects = Array.isArray(State.projects) ? State.projects : [];
      for (const p of projects) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        sel.appendChild(opt);
      }
      const tab = getActiveTab();
      const want = (tab && tab.project) || cur || (projects[0] || '');
      if (want) sel.value = want;
    }
  } catch {}
  openSheet('scheduleSheet');
  _refreshScheduleList();
}

async function _refreshScheduleList() {
  const list = document.getElementById('scheduleList');
  const empty = document.getElementById('scheduleListEmpty');
  if (list) Array.from(list.querySelectorAll('.scheduleRow')).forEach((n) => n.remove());
  if (empty) { empty.hidden = false; empty.textContent = 'Loading…'; }
  try {
    const r = await fetch('/api/schedule/list', { headers: CSRF_HEADERS });
    const data = await r.json();
    if (!r.ok) {
      if (empty) { empty.hidden = false; empty.textContent = 'Load failed: ' + (data.detail || r.status); }
      return;
    }
    if (data.supported === false) {
      if (empty) { empty.hidden = false; empty.textContent = 'Scheduling needs a Windows host (laptop side).'; }
      return;
    }
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    if (!tasks.length) {
      if (empty) { empty.hidden = false; empty.textContent = 'No scheduled tasks yet. Create one below.'; }
      return;
    }
    if (empty) empty.hidden = true;
    for (const t of tasks) {
      const li = el('li', { class: 'sheet__opt scheduleRow' });
      const head = el('div', { class: 'sheet__optTitle' }, t.name);
      const meta = el('div', { class: 'sheet__optDesc' },
        `${t.status || '?'}  ·  next: ${t.next_run || '—'}  ·  last: ${t.last_run || '—'}`);
      const delBtn = el('button', {
        type: 'button', class: 'sheet__primaryBtn', style: 'margin-top:8px;max-width:120px;background:#a83232',
      }, 'Delete');
      delBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        delBtn.disabled = true;
        delBtn.textContent = 'Deleting…';
        try {
          const r = await fetch('/api/schedule/delete', {
            method: 'POST',
            headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: t.name }),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            toast('Delete failed: ' + (d.detail || r.status), 'error');
            delBtn.disabled = false;
            delBtn.textContent = 'Delete';
            return;
          }
          toast('Task deleted', 'info');
          _refreshScheduleList();
        } catch (e) {
          toast('Delete failed: ' + (e.message || e), 'error');
          delBtn.disabled = false;
          delBtn.textContent = 'Delete';
        }
      });
      li.append(head, meta, delBtn);
      list.append(li);
    }
  } catch (e) {
    if (empty) { empty.hidden = false; empty.textContent = 'Load failed: ' + (e.message || e); }
  }
}

// Wire the schedule form's submit + kind-switcher once at module load.
(function _wireScheduleSheet() {
  const form = document.getElementById('scheduleAddForm');
  if (!form) return;
  const kindSel = document.getElementById('scheduleKindSelect');
  const status = document.getElementById('scheduleAddStatus');
  function refreshKindVisibility() {
    const kind = kindSel ? kindSel.value : 'interval';
    document.querySelectorAll('#scheduleAddForm [data-when]').forEach((el) => {
      el.hidden = el.dataset.when !== kind;
    });
  }
  if (kindSel) kindSel.addEventListener('change', refreshKindVisibility);
  refreshKindVisibility();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (status) { status.hidden = true; status.textContent = ''; }
    const fd = new FormData(form);
    const kind = fd.get('kind') || 'interval';
    const body = {
      name: (fd.get('name') || '').toString().trim(),
      project: (fd.get('project') || '').toString().trim(),
      prompt: (fd.get('prompt') || '').toString().trim(),
      kind,
    };
    if (kind === 'interval') body.minutes = parseInt(fd.get('minutes') || '0', 10);
    if (kind === 'daily') body.time = (fd.get('time') || '').toString();
    if (kind === 'once') body.when = (fd.get('when') || '').toString();
    const submit = form.querySelector('button[type=submit]');
    if (submit) { submit.disabled = true; submit.textContent = 'Creating…'; }
    try {
      const r = await fetch('/api/schedule/create', {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) {
        if (status) { status.hidden = false; status.textContent = 'Create failed: ' + (data.detail || r.status); }
        return;
      }
      if (status) { status.hidden = false; status.textContent = 'Created ' + data.name; }
      // Clear the form + reload the list so the new task appears.
      form.reset();
      refreshKindVisibility();
      _refreshScheduleList();
    } catch (e) {
      if (status) { status.hidden = false; status.textContent = 'Create failed: ' + (e.message || e); }
    } finally {
      if (submit) { submit.disabled = false; submit.textContent = 'Create'; }
    }
  });
})();

// /memory editor — list memory files for the active project, tap one to
// open it in a textarea, Save POSTs back via /api/memory/file. Path-jail
// runs server-side; the client just hands the user-tappable list of
// known-good paths back to the server with each fetch.
let _memoryEditorState = { path: null, originalContent: null };

async function openMemorySheet() {
  const tab = getActiveTab();
  if (!tab || !tab.project) {
    Chat.pushSystem('Pick a project first — /memory needs an active workspace.');
    return;
  }
  // Reset to list view every time the sheet opens.
  _showMemoryListView();
  const list = $('#memoryList');
  const empty = $('#memoryListEmpty');
  if (list) {
    // Clear any previously-rendered rows but keep the empty/loading row.
    Array.from(list.querySelectorAll('.memoryRow')).forEach((n) => n.remove());
  }
  if (empty) { empty.hidden = false; empty.textContent = 'Loading…'; }
  openSheet('memorySheet');
  try {
    const r = await fetch(
      '/api/memory/list?project=' + encodeURIComponent(tab.project),
      { headers: CSRF_HEADERS },
    );
    const data = await r.json();
    if (!r.ok) {
      if (empty) { empty.hidden = false; empty.textContent = 'Load failed: ' + (data.detail || r.status); }
      return;
    }
    const files = Array.isArray(data.files) ? data.files : [];
    if (!files.length) {
      if (empty) { empty.hidden = false; empty.textContent = 'No memory files for this project yet. Create one by writing to CLAUDE.md.'; }
      return;
    }
    if (empty) empty.hidden = true;
    for (const f of files) {
      const li = el('li', {
        class: 'sheet__opt memoryRow',
        'data-path': f.path,
        role: 'button',
        tabindex: '0',
      });
      const label = el('div', { class: 'sheet__optTitle' }, f.label || f.path);
      const sub = el('div', { class: 'sheet__optDesc' },
        `${f.path}  ·  ${(f.size || 0).toLocaleString()} B`);
      li.append(label, sub);
      li.addEventListener('click', () => _openMemoryEditor(tab.project, f.path));
      list.append(li);
    }
  } catch (e) {
    if (empty) { empty.hidden = false; empty.textContent = 'Load failed: ' + (e.message || e); }
  }
}

function _showMemoryListView() {
  const listView = $('#memoryListView');
  const editorView = $('#memoryEditorView');
  const backBtn = $('#memoryBackBtn');
  const title = $('#memoryTitle');
  if (listView) listView.hidden = false;
  if (editorView) editorView.hidden = true;
  if (backBtn) backBtn.hidden = true;
  if (title) title.textContent = 'Memory';
  _memoryEditorState = { path: null, originalContent: null };
}

function _showMemoryEditorView(label) {
  const listView = $('#memoryListView');
  const editorView = $('#memoryEditorView');
  const backBtn = $('#memoryBackBtn');
  const title = $('#memoryTitle');
  if (listView) listView.hidden = true;
  if (editorView) editorView.hidden = false;
  if (backBtn) backBtn.hidden = false;
  if (title) title.textContent = label || 'Memory';
}

async function _openMemoryEditor(project, relPath) {
  const ta = $('#memoryEditor');
  const pathLabel = $('#memoryEditorPath');
  const status = $('#memoryEditorStatus');
  if (status) { status.hidden = true; status.textContent = ''; }
  _showMemoryEditorView(relPath.split('/').slice(-1)[0] || 'Memory');
  if (ta) { ta.value = 'Loading…'; ta.disabled = true; }
  if (pathLabel) pathLabel.textContent = relPath;
  try {
    const r = await fetch(
      '/api/memory/file?project=' + encodeURIComponent(project)
        + '&path=' + encodeURIComponent(relPath),
      { headers: CSRF_HEADERS },
    );
    const data = await r.json();
    if (!r.ok) {
      if (ta) { ta.value = ''; ta.disabled = false; }
      if (status) { status.hidden = false; status.textContent = 'Load failed: ' + (data.detail || r.status); }
      return;
    }
    if (ta) {
      ta.value = data.content || '';
      ta.disabled = false;
      _memoryEditorState = { project, path: data.path, originalContent: ta.value };
    }
  } catch (e) {
    if (ta) { ta.value = ''; ta.disabled = false; }
    if (status) { status.hidden = false; status.textContent = 'Load failed: ' + (e.message || e); }
  }
}

// Wire the editor sheet's controls. Done once at module load; the sheet
// itself is reused across every /memory invocation.
(function _wireMemorySheet() {
  const backBtn = document.getElementById('memoryBackBtn');
  if (backBtn) backBtn.addEventListener('click', _showMemoryListView);
  const saveBtn = document.getElementById('memoryEditorSaveBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const ta = document.getElementById('memoryEditor');
      const status = document.getElementById('memoryEditorStatus');
      const { project, path } = _memoryEditorState;
      if (!path || !project) return;
      if (status) { status.hidden = true; status.textContent = ''; }
      saveBtn.disabled = true;
      const prevLabel = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';
      try {
        const r = await fetch('/api/memory/file', {
          method: 'POST',
          headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ project, path, content: ta.value || '' }),
        });
        const data = await r.json();
        if (!r.ok) {
          if (status) { status.hidden = false; status.textContent = 'Save failed: ' + (data.detail || r.status); }
          return;
        }
        _memoryEditorState.originalContent = ta.value || '';
        if (status) { status.hidden = false; status.textContent = `Saved · ${data.size} B`; }
        toast('Memory saved', 'info');
      } catch (e) {
        if (status) { status.hidden = false; status.textContent = 'Save failed: ' + (e.message || e); }
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = prevLabel;
      }
    });
  }
})();

async function openAgentEditSheet(existingName) {
  const form = $('#agentEditForm');
  const title = $('#agentEditTitle');
  if (!form || !title) return;
  const status = $('#agentEditStatus');
  if (status) { status.hidden = true; status.textContent = ''; }
  // Reset
  form.reset();
  form.elements.original_name.value = '';
  if (existingName) {
    title.textContent = 'Edit ' + existingName;
    const tab = getActiveTab();
    if (tab && tab.project) {
      try {
        const r = await fetch(
          '/api/agents/' + encodeURIComponent(existingName)
            + '?project=' + encodeURIComponent(tab.project),
          { headers: CSRF_HEADERS },
        );
        const data = await r.json();
        if (r.ok) {
          form.elements.original_name.value = existingName;
          form.elements.name.value = data.name || existingName;
          form.elements.description.value = data.description || '';
          form.elements.tools.value = data.tools || '';
          form.elements.model.value = data.model || '';
          form.elements.body.value = data.body || '';
        } else if (status) {
          status.hidden = false;
          status.textContent = 'Load failed: ' + (data.detail || r.status);
        }
      } catch (e) {
        if (status) { status.hidden = false; status.textContent = 'Load failed: ' + e.message; }
      }
    }
  } else {
    title.textContent = 'New agent';
  }
  openSheet('agentEditSheet');
}

const _agentEditForm = $('#agentEditForm');
if (_agentEditForm) {
  _agentEditForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tab = getActiveTab();
    if (!tab || !tab.project) {
      toast('Open a project first', 'warn');
      return;
    }
    const fd = new FormData(_agentEditForm);
    const originalName = (fd.get('original_name') || '').toString();
    const body = {
      project: tab.project,
      name: (fd.get('name') || '').toString().trim(),
      description: (fd.get('description') || '').toString().trim(),
      tools: (fd.get('tools') || '').toString().trim(),
      model: (fd.get('model') || '').toString().trim(),
      body: (fd.get('body') || '').toString(),
    };
    const status = $('#agentEditStatus');
    if (status) { status.hidden = false; status.textContent = 'Saving…'; }
    try {
      let url, method;
      if (originalName) {
        url = '/api/agents/' + encodeURIComponent(originalName);
        method = 'PUT';
      } else {
        url = '/api/agents';
        method = 'POST';
      }
      const r = await fetch(url, {
        method,
        headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (status) { status.textContent = 'Failed: ' + (data.detail || r.status); }
        return;
      }
      if (status) { status.textContent = 'Saved.'; }
      _agentChipCache.project = null;
      await _refreshAgentsAdminList();
      renderAgentChip();
      setTimeout(() => {
        closeSheet('agentEditSheet');
        if (status) status.hidden = true;
      }, 600);
    } catch (err) {
      if (status) { status.textContent = 'Failed: ' + (err.message || err); }
    }
  });
}

$('#agentsAdminNewBtn').addEventListener('click', () => {
  openAgentEditSheet(null);
});

const _mcpAddForm = $('#mcpAddForm');
if (_mcpAddForm) {
  _mcpAddForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(_mcpAddForm);
    const tab = getActiveTab();
    const body = {
      name: (fd.get('name') || '').toString().trim(),
      transport: (fd.get('transport') || 'http').toString(),
      target: (fd.get('target') || '').toString().trim(),
      scope: (fd.get('scope') || 'project').toString(),
      project: (tab && tab.project) || '',
    };
    const status = $('#mcpAddStatus');
    status.hidden = false;
    status.textContent = 'Adding…';
    try {
      const r = await fetch('/api/mcp/servers', {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        status.textContent = 'Failed: ' + (data.detail || r.status);
        return;
      }
      status.textContent = 'Added.';
      _mcpAddForm.reset();
      await _refreshMcpList();
      setTimeout(() => { status.hidden = true; }, 1500);
    } catch (err) {
      status.textContent = 'Failed: ' + (err.message || err);
    }
  });
}

// Effort slider — tap a stop OR drag along the track. Pointer events cover
// touch + mouse + pen with one code path.
function pickEffortFromEvent(e) {
  const track = $('#effortTrack');
  const stops = $$('#effortTrack .effortRow__dot');
  const rect = track.getBoundingClientRect();
  const x = (e.clientX != null ? e.clientX : (e.touches && e.touches[0].clientX)) - rect.left;
  // Snap to nearest stop by comparing x against each stop's center.
  let best = 0, bestDist = Infinity;
  stops.forEach((s, i) => {
    const c = s.getBoundingClientRect();
    const cx = c.left - rect.left + c.width / 2;
    const d = Math.abs(x - cx);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return EFFORT_ORDER[best];
}
function setEffort(value) {
  if (value === State.effort) return;
  State.effort = value;
  try { localStorage.setItem('crc.effort', value); } catch {}
  renderEffortSlider();
  renderMode();
}
const effortTrack = $('#effortTrack');
let effortDragging = false;
if (effortTrack) {
  effortTrack.addEventListener('pointerdown', (e) => {
    effortDragging = true;
    effortTrack.setPointerCapture(e.pointerId);
    setEffort(pickEffortFromEvent(e));
  });
  effortTrack.addEventListener('pointermove', (e) => {
    if (!effortDragging) return;
    setEffort(pickEffortFromEvent(e));
  });
  effortTrack.addEventListener('pointerup', (e) => {
    effortDragging = false;
    try { effortTrack.releasePointerCapture(e.pointerId); } catch {}
  });
  effortTrack.addEventListener('pointercancel', () => { effortDragging = false; });
  // Keyboard a11y
  effortTrack.addEventListener('keydown', (e) => {
    const idx = EFFORT_ORDER.indexOf(State.effort);
    if (e.key === 'ArrowRight' && idx < EFFORT_ORDER.length - 1) setEffort(EFFORT_ORDER[idx + 1]);
    if (e.key === 'ArrowLeft' && idx > 0) setEffort(EFFORT_ORDER[idx - 1]);
  });
}

// ─── Slash palette ────────────────────────────────────────────────────

// Unified slash command execution — called by the picker, the inline
// autocomplete, AND when the user just types a /command and hits send.
function executeSlash(cmd) {
  const meta = ALL_SLASH_COMMANDS.find((c) => c.cmd === cmd);
  if (!meta) return false;   // not a known slash command
  if (meta.kind === 'bridge') {
    // Bridge commands — dispatched through the WS as command frames. They
    // all target the active tab.
    const bare = cmd.slice(1);
    const tab = getActiveTab();
    if (bare === 'stop' || bare === 'new') {
      if (!tab) { toast('Open a tab first', 'warn'); return true; }
      WS.send({ type: 'command', cmd: bare, tab_id: tab.id });
      if (bare === 'new') {
        // Server resets session_id silently — the client owns visual feedback.
        // Mirror /clear (wipe DOM, reset run map, show empty state) and toast
        // a message that explains the conversation was reset, not just the view.
        if (tab._chatpane) {
          tab._chatpane.querySelectorAll('.msg').forEach((m) => m.remove());
        }
        if (tab._activeRuns) tab._activeRuns.clear();
        tab.sessionId = null;
        $('#emptyState').hidden = false;
        toast('Fresh conversation — next message starts a new session', 'info');
      }
    } else if (bare === 'ask') {
      toast('Tap / button → Ask, or type /ask <question> as a normal message', 'info');
      input.value = '/ask ';
      autosizeInput(); input.focus();
      return true;
    } else {
      WS.send({ type: 'command', cmd: bare, args: [], tab_id: tab ? tab.id : null });
    }
    return true;
  }
  // bridge-local + claude-local share the same dispatch table now —
  // both are "handled entirely in the client" from the user's POV.
  // /clear is the only handler still living outside the table since it
  // mutates DOM directly.
  if (meta.kind === 'bridge-local' || meta.kind === 'claude-local') {
    if (cmd === '/clear') {
      const tab = getActiveTab();
      if (tab && tab._chatpane) {
        tab._chatpane.querySelectorAll('.msg').forEach((m) => m.remove());
      }
      if (tab && tab._activeRuns) tab._activeRuns.clear();
      $('#emptyState').hidden = false;
      toast('Cleared local view', 'info');
      return true;
    }
    const h = CLAUDE_LOCAL_HANDLERS[cmd];
    if (h) h();
    return true;
  }
  // kind === 'claude' — drop into the input so the user sees what's about
  // to fire, and let them tap send. Avoids surprise side-effects.
  input.value = cmd;
  autosizeInput(); input.focus();
  toast(`Tap send to run ${cmd}`, 'info');
  return true;
}

// ─── Slash autocomplete: shows above the input as the user types `/` ────
const autocomplete = $('#slashAutocomplete');
// Tracks where the "/" we're completing lives in the textarea, so a
// tap on a suggestion replaces only THAT token (not the whole input).
// Reset to null whenever the dropdown is hidden.
let _autocompleteSlashStart = null;
function renderAutocomplete(matches) {
  if (!matches.length) { autocomplete.hidden = true; autocomplete.innerHTML = ''; _autocompleteSlashStart = null; return; }
  autocomplete.innerHTML = '';
  matches.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'autocomplete__item';
    if (i === 0) row.setAttribute('data-active', '');
    row.dataset.cmd = m.cmd;
    row.innerHTML =
      `<span class="autocomplete__cmd">${m.cmd}</span>` +
      `<span class="autocomplete__desc">${m.desc}</span>` +
      `<span class="autocomplete__kind">${m.kind.replace('-local', '')}</span>`;
    row.addEventListener('click', () => {
      _applyAutocompletePick(m.cmd);
    });
    autocomplete.append(row);
  });
  autocomplete.hidden = false;
}

// Replace the "/foo" token under the caret with the picked command.
// If the chosen command was typed at the very start of the input AND
// nothing else is in the box, route through executeSlash (same as the
// old behavior — a one-tap slash command). Otherwise, splice the token
// into place and let the user keep typing arguments.
function _applyAutocompletePick(cmd) {
  const start = _autocompleteSlashStart;
  autocomplete.hidden = true;
  _autocompleteSlashStart = null;
  if (start == null) {
    input.value = '';
    autosizeInput();
    executeSlash(cmd);
    return;
  }
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  // The current token ends at the first whitespace AFTER start (or caret/EOL).
  let tokenEnd = caret;
  for (let i = start; i < v.length; i++) {
    if (/\s/.test(v[i])) { tokenEnd = i; break; }
    if (i === v.length - 1) tokenEnd = v.length;
  }
  const before = v.slice(0, start);
  const after = v.slice(tokenEnd);
  // If the input is JUST the slash command (no other text), preserve
  // the old send-immediately UX — most users still expect "/help<enter>"
  // to fire the command, not type "/help" into a prompt.
  if (before.trim() === '' && after.trim() === '') {
    input.value = '';
    autosizeInput();
    executeSlash(cmd);
    return;
  }
  input.value = before + cmd + after;
  const newCaret = (before + cmd).length;
  try { input.setSelectionRange(newCaret, newCaret); } catch {}
  autosizeInput();
  input.focus();
}

function updateAutocomplete() {
  const v = input.value;
  if (!v) { autocomplete.hidden = true; _autocompleteSlashStart = null; return; }
  // Find the "/" token under the caret. The token starts at a "/" that's
  // either at position 0 OR immediately preceded by whitespace, and
  // contains no whitespace itself. This lets the menu pop when the user
  // types "/" mid-message ("ok now /sto…"), not just at the beginning.
  const caret = input.selectionStart ?? v.length;
  // Walk back from the caret to find the start of the current word.
  let wordStart = caret;
  while (wordStart > 0 && !/\s/.test(v[wordStart - 1])) wordStart--;
  if (v[wordStart] !== '/') {
    autocomplete.hidden = true;
    _autocompleteSlashStart = null;
    return;
  }
  // Token from wordStart up to the next whitespace (or caret).
  let tokenEnd = caret;
  for (let i = wordStart; i < v.length; i++) {
    if (/\s/.test(v[i])) { tokenEnd = i; break; }
    if (i === v.length - 1) tokenEnd = v.length;
  }
  const token = v.slice(wordStart, Math.max(tokenEnd, caret)).toLowerCase();
  _autocompleteSlashStart = wordStart;
  const matches = ALL_SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(token));
  renderAutocomplete(matches);
}
// (Autocomplete blur listener is attached later — after `const input` is
// declared. Attaching it here would be a TDZ access of `input`, which
// silently halts module evaluation in browsers and was the root cause of
// the chat page being stuck on its HTML-default "connecting…" indicator.)

// Build the slash command picker dynamically from ALL_SLASH_COMMANDS so the
// picker and the inline autocomplete can never drift out of sync. Two
// visual sections: bridge commands first, then everything claude-related.
function renderSlashPicker() {
  const root = $('#slashScroll');
  if (!root) return;
  root.innerHTML = '';
  const sections = [
    { title: 'Bridge', match: (c) => c.kind === 'bridge' || c.kind === 'bridge-local' },
    { title: 'Claude', match: (c) => c.kind === 'claude' || c.kind === 'claude-local' },
  ];
  for (const sec of sections) {
    const label = document.createElement('div');
    label.className = 'sheet__sectionLabel';
    if (sec.title !== 'Bridge') label.classList.add('sheet__sectionLabel--inline');
    label.innerHTML = `<span>${sec.title}</span>`;
    root.append(label);
    const ul = document.createElement('ul');
    ul.className = 'sheet__list sheet__list--flat';
    ALL_SLASH_COMMANDS.filter(sec.match).forEach((c) => {
      const li = document.createElement('li');
      li.dataset.cmd = c.cmd;
      li.innerHTML = `<div class="sheet__optTitle">${c.cmd}</div><div class="sheet__optDesc">${c.desc}</div>`;
      // /ask is a special case — it needs the textarea's text as the question.
      if (c.cmd === '/ask') {
        li.addEventListener('click', () => {
          closeSheet('slashSheet');
          const text = $('#input').value.trim();
          if (!text) { toast('Type your question first, then tap /ask', 'warn'); return; }
          const tab = getActiveTab();
          if (!tab || !tab.project) { toast('Pick a project first', 'warn'); return; }
          $('#input').value = '';
          autosizeInput();
          Chat.pushUser('/ask ' + text, [], tab.id);
          WS.send({
            type: 'command', cmd: 'ask', args: [],
            text, project: tab.project, tab_id: tab.id,
            permission_mode: serverPermissionMode(),
            effort: State.effort,
          });
        });
      } else {
        li.addEventListener('click', () => {
          closeSheet('slashSheet');
          executeSlash(c.cmd);
        });
      }
      ul.append(li);
    });
    root.append(ul);
  }
}

$('#slashBtn').addEventListener('click', () => {
  // Re-render every open so any future changes to ALL_SLASH_COMMANDS
  // (e.g. config-driven inclusion) are reflected. Cheap — ~21 list
  // items.
  renderSlashPicker();
  openSheet('slashSheet');
});

// Claude built-in slash commands. The Claude Code CLI distinguishes commands
// that work in `claude -p` (headless / piped) from ones that ONLY work in
// the interactive REPL. Empirically (claude 2.1.123, 2026-05-12):
//
//   Work as-is in -p:    /context  /usage  /compact  /init  /review
//                        /security-review
//   Return "isn't        /help  /memory  /model  /agents  /diff
//   available...":       /output-style  /resume
//
//   Special remap:       /cost  →  /usage  (current claude exposes cost data
//                                           through /usage in headless mode)
//
// For the second group, forwarding them to claude is pointless — the user
// just sees "/help isn't available in this environment." Instead we intercept
// here and render a useful local explanation as a system bubble.

// Single source of truth for every slash command shown in the picker AND
// the inline autocomplete. `kind` selects how the command is executed:
//   bridge       — sent to the server as a WS command frame
//   bridge-local — handled entirely in the client (e.g. /clear)
//   claude       — forwarded as a normal prompt; claude -p handles it
//   claude-local — intercepted client-side because Claude doesn't support
//                  it in headless mode (see researcher findings in memory)
const ALL_SLASH_COMMANDS = [
  { cmd: '/projects', desc: 'List project folders', kind: 'bridge' },
  { cmd: '/new',      desc: 'Fresh conversation', kind: 'bridge' },
  { cmd: '/sessions', desc: 'Running claude processes', kind: 'bridge' },
  { cmd: '/stop',     desc: 'Stop current run', kind: 'bridge' },
  { cmd: '/ask',      desc: 'Side-channel question', kind: 'bridge' },
  { cmd: '/status',   desc: 'Bridge status', kind: 'bridge' },
  { cmd: '/clear',    desc: 'Clear this chat view', kind: 'bridge-local' },
  { cmd: '/help',     desc: "Show what's available", kind: 'claude-local' },
  // The CLI's slash-command processor only fires for these in the interactive
  // REPL — piping them to `claude -p` makes claude respond as if asked
  // about them (useless). So everything below is intercepted client-side
  // with a useful local message, EXCEPT /init /review /security-review,
  // which work fine as natural-language requests.
  { cmd: '/init',     desc: 'Create CLAUDE.md',             kind: 'claude' },
  { cmd: '/review',   desc: 'Review PR',                    kind: 'claude' },
  { cmd: '/security-review', desc: 'Security audit',        kind: 'claude' },
  { cmd: '/context',  desc: 'Token usage for this tab',     kind: 'bridge-local' },
  { cmd: '/usage',    desc: 'Open claude.ai subscription page', kind: 'bridge-local' },
  { cmd: '/cost',     desc: 'Last run’s cost (USD)',       kind: 'bridge-local' },
  { cmd: '/compact',  desc: 'Compress conversation in place',  kind: 'bridge-local' },
  { cmd: '/memory',   desc: 'Memory file locations',           kind: 'bridge-local' },
  { cmd: '/model',    desc: 'Open the model picker',           kind: 'bridge-local' },
  { cmd: '/diff',     desc: 'git diff for active project',     kind: 'bridge-local' },
  { cmd: '/agents',   desc: 'List subagents in this project',  kind: 'bridge-local' },
  { cmd: '/output-style', desc: 'Output style (not applicable)', kind: 'bridge-local' },
  { cmd: '/resume',   desc: 'Open the sessions drawer',        kind: 'bridge-local' },
  { cmd: '/mcp',      desc: 'Manage MCP servers',              kind: 'bridge-local' },
  // Local replacements for Claude Code's REPL-only commands that have
  // useful phone analogues. We DO the action rather than print text.
  { cmd: '/effort',   desc: 'Set model effort',                kind: 'bridge-local' },
  { cmd: '/recap',    desc: 'Brief recap of this chat',        kind: 'bridge-local' },
  // REPL-only plugin / built-in commands that DON'T work when piped to
  // `claude -p` (the bridge's only mode). Previously these were marked
  // `kind: 'claude'` and the bridge sent them verbatim — claude.exe then
  // answered them as free-form questions, which looked broken. Switched
  // to `claude-local` with explicit "do this on your laptop" handlers so
  // the user gets a clear, actionable response. /schedule has a real
  // implementation below (CLAUDE_LOCAL_HANDLERS) — the rest just explain.
  { cmd: '/schedule',     desc: 'Schedule a task',           kind: 'bridge-local' },
  { cmd: '/loop',         desc: 'Loop a prompt (laptop only)', kind: 'claude-local' },
  { cmd: '/batch',        desc: 'Batch ops (laptop only)',   kind: 'claude-local' },
  { cmd: '/simplify',     desc: 'Simplify code (laptop only)', kind: 'claude-local' },
  { cmd: '/remote-control', desc: 'Remote-control (laptop only)', kind: 'claude-local' },
  { cmd: '/team-onboarding', desc: 'Team onboarding (laptop only)', kind: 'claude-local' },
  { cmd: '/update-config', desc: 'Update Claude config (laptop only)', kind: 'claude-local' },
  { cmd: '/debug',        desc: 'Debug info (laptop only)',  kind: 'claude-local' },
  { cmd: '/heapdump',     desc: 'Heap dump (laptop only)',   kind: 'claude-local' },
  { cmd: '/insights',     desc: 'Insights (laptop only)',    kind: 'claude-local' },
  { cmd: '/extra-usage',  desc: 'Detailed usage (laptop only)', kind: 'claude-local' },
  { cmd: '/fewer-permission-prompts', desc: 'Permission tuning (laptop only)', kind: 'claude-local' },
  { cmd: '/claude-api',   desc: 'API config (laptop only)',  kind: 'claude-local' },
];

// Polite "this is REPL-only" handler factory. Used for every command that
// Claude Code only supports in the interactive REPL and we don't have a
// useful bridge-side analogue for. Avoids the previous bad UX where these
// got piped to `claude -p` and answered as natural-language questions.
function _laptopOnlyHandler(name, hint) {
  return () => Chat.pushSystem(
    `\`${name}\` only works in the interactive Claude REPL on your laptop. ` +
    (hint || 'Run it there; nothing to do on mobile.')
  );
}

const CLAUDE_LOCAL_HANDLERS = {
  '/help': () => Chat.pushSystem(
    'Bridge commands:\n' +
    '  /projects · list folders     /new · fresh conversation\n' +
    '  /sessions · running claudes  /stop · kill current run\n' +
    '  /ask · side-channel query    /status · bridge status\n' +
    '  /clear · wipe chat view\n\n' +
    'Claude commands that work here (sent through to claude -p):\n' +
    '  /context · token usage       /usage · subscription info\n' +
    '  /compact · compress history  /init · create CLAUDE.md\n' +
    '  /review · review PR          /security-review · audit\n\n' +
    'Not available remotely (interactive REPL only):\n' +
    '  /memory, /model, /agents, /diff, /output-style, /resume.\n' +
    'For /model: use the mode chip below. For /resume: use /new instead.'
  ),
  '/context': () => {
    // Surface the same number the topbar donut shows — VSCode's /context
    // does the same thing (token-usage breakdown). The bridge tracks
    // tokens per-tab in `tab.usage`, refreshed by every `run_finished`
    // event and on every /compact.
    const tab = getActiveTab();
    if (!tab || !tab.usage || typeof tab.usage.context_used !== 'number') {
      Chat.pushSystem(
        "No token-usage data yet for this tab. Send a message first and the " +
        "donut + /context will populate from the run's result event."
      );
      return;
    }
    const used = tab.usage.context_used;
    const limit = tab.usage.context_limit || 200_000;
    const pct = Math.round((used / limit) * 100);
    Chat.pushSystem(
      `Context: ${used.toLocaleString()} / ${limit.toLocaleString()} tokens ` +
      `(${pct}% used). Tap the donut in the topbar to /compact when it gets ` +
      `tight.`
    );
  },
  '/usage': () => {
    // Subscription info lives at claude.ai/settings/usage — not something
    // the bridge can fetch (it would need the user's web-session cookie,
    // which we don't have). We don't `window.open()` because iOS PWA
    // standalone mode routes that through SFSafariViewController, which
    // has separate cookies from Safari proper — Google's OAuth then
    // rejects the sign-in as a suspicious context and returns
    // "link malformed" (400). Showing a plain link lets the user
    // long-press → Open in Safari, where their session cookies live
    // and OAuth works.
    Chat.pushSystem(
      "Subscription + plan limits aren't exposed by the Claude API, so the bridge can't surface them here.\n\n" +
      "Open this in **your laptop browser** (or long-press the link below → Open in Safari on the phone):\n\n" +
      "https://claude.ai/settings/usage"
    );
  },
  '/cost': () => {
    // The stream-json `result` event Claude emits carries the run's
    // total_cost_usd. The bridge forwards it on the final `usage` WS
    // frame; the client stashes it on tab.lastRunCost.
    const tab = getActiveTab();
    const cost = tab && tab.lastRunCost;
    if (typeof cost !== 'number') {
      Chat.pushSystem(
        "No cost data yet for this tab. Send a message and /cost will show " +
        "the run's billed amount once it completes."
      );
      return;
    }
    Chat.pushSystem(
      `Last run cost: $${cost.toFixed(4)} USD. ` +
      `For your running total across all runs, see claude.ai/settings/usage.`
    );
  },
  '/compact': () => {
    // Same flow as tapping the donut and confirming the compact dialog:
    // append a real compact_boundary + summary event to the session's
    // jsonl on disk so claude.exe's next --resume sees the discarded
    // history. Session UUID stays continuous.
    const tab = getActiveTab();
    if (!tab || !tab.project || !tab.sessionId) {
      Chat.pushSystem("Can't /compact: no live session in this tab yet.");
      return;
    }
    _finalizeCompact(tab);
  },
  '/model': () => {
    // Same affordance as the model chip in the composer — open the
    // model picker sheet. Selection writes to State for the next run.
    openSheet('modelSheet');
  },
  '/resume': () => {
    // VSCode's /resume opens the sessions list. We do the same — the
    // hamburger drawer lists every Claude session across every project,
    // newest first. Tap a row to open it as a fresh tab.
    openSessionsDrawer();
  },
  '/diff': async () => {
    // Run `git diff` server-side in the active project and render the
    // result in the chat as a system message. Matches VSCode's /diff:
    // show working-tree changes plus staged changes.
    const tab = getActiveTab();
    if (!tab || !tab.project) {
      Chat.pushSystem("Open a project first — /diff needs an active workspace.");
      return;
    }
    Chat.pushSystem("Running `git diff` in " + tab.project + "…");
    try {
      const r = await fetch(
        '/api/git_diff?project=' + encodeURIComponent(tab.project),
        { headers: CSRF_HEADERS },
      );
      const data = await r.json();
      if (!r.ok) {
        Chat.pushSystem("/diff failed: " + (data.detail || r.status));
        return;
      }
      if (!data.diff || !data.diff.trim()) {
        Chat.pushSystem("Clean working tree — no diff in " + tab.project + ".");
        return;
      }
      // Render as a fenced code block so the markdown renderer
      // applies the diff color coding.
      Chat.pushSystem("```diff\n" + data.diff + "\n```");
    } catch (e) {
      Chat.pushSystem("/diff failed: " + (e.message || e));
    }
  },
  '/agents': () => openAgentsAdminSheet(),
  '/memory': () => Chat.pushSystem(
    "Memory files for the active project:\n" +
    "  • `CLAUDE.md` at the project root (loaded every run)\n" +
    "  • `.claude/agents/<name>/memory/*.md` per-agent\n" +
    "Edit any of them from your laptop or via a chat prompt — they're picked up on the next run."
  ),
  '/output-style': () => Chat.pushSystem(
    "/output-style is an interactive REPL preference — it doesn't apply to the bridge's headless runs. " +
    "Claude uses its default response format here. If you want shorter / longer answers, ask in the prompt."
  ),
  '/mcp': () => openMcpSheet(),
  '/memory': () => openMemorySheet(),
  '/schedule': () => openScheduleSheet(),
  // /effort — opens the mode sheet, which has the effort slider pinned at
  // the bottom. The REPL's `/effort` opens a picker; we open the sheet that
  // hosts ours. Reuses the existing UI rather than building a duplicate.
  '/effort': () => openSheet('modeSheet'),
  // /recap — generate a brief recap of the current conversation as a
  // side-channel run. Same plumbing as `/ask`: bypasses the per-tab lock
  // (so it works even while a main run is in flight) and uses
  // --no-session-persistence so the recap doesn't pollute the chat's jsonl
  // history. The reply renders as a normal assistant bubble in this tab.
  // REPL-only commands — short, honest handlers instead of fake passthrough.
  '/loop': _laptopOnlyHandler('/loop', 'Schedules a recurring prompt; use the bridge\'s `/schedule` instead.'),
  '/batch': _laptopOnlyHandler('/batch', 'Parallelizes large refactors via subagents — write it as a normal prompt here ("refactor X across the repo").'),
  '/simplify': _laptopOnlyHandler('/simplify', 'Reviews and tightens code — ask Claude here ("simplify file.py").'),
  '/remote-control': _laptopOnlyHandler('/remote-control', 'Puts a VSCode session into phone-controllable mode. Bridgy IS that mode for `claude -p`; nothing to toggle.'),
  '/team-onboarding': _laptopOnlyHandler('/team-onboarding'),
  '/update-config': _laptopOnlyHandler('/update-config', 'Edits `.claude/settings.json` — use `/memory` to browse those files.'),
  '/debug': _laptopOnlyHandler('/debug', 'Use the Debug log toggle in the ⋯ menu for a live console.'),
  '/heapdump': _laptopOnlyHandler('/heapdump'),
  '/insights': _laptopOnlyHandler('/insights'),
  '/extra-usage': _laptopOnlyHandler('/extra-usage', 'See `/usage` here, or claude.ai/settings/usage in a browser.'),
  '/fewer-permission-prompts': _laptopOnlyHandler('/fewer-permission-prompts'),
  '/claude-api': _laptopOnlyHandler('/claude-api'),
  '/recap': () => {
    const tab = getActiveTab();
    if (!tab || !tab.project) {
      Chat.pushSystem("Pick a project first — /recap needs an active conversation.");
      return;
    }
    if (!tab.sessionId) {
      Chat.pushSystem("Nothing to recap yet — send a message first.");
      return;
    }
    const prompt = "Briefly recap this conversation so far in 3-5 short bullets: "
      + "what we worked on, what's done, what's still open. Keep each bullet under one line.";
    const ok = WS.send({
      type: 'command', cmd: 'ask', args: [prompt],
      text: prompt,
      project: tab.project, tab_id: tab.id,
      permission_mode: serverPermissionMode(),
      effort: State.effort,
    });
    if (ok) {
      Chat.pushUser('/recap', [], tab.id);
    } else {
      Chat.pushSystem('Could not start /recap — bridge connection is down.');
    }
  },
};

// (#slashList and #slashListClaude no longer exist — they're rendered
// dynamically by renderSlashPicker(). Click handlers attached there.)

// (#slashList click handlers are attached by renderSlashPicker().)

// ─── Menu ─────────────────────────────────────────────────────────────

$('#menuBtn').addEventListener('click', () => {
  openSheet('menuSheet');
  // Re-read live state for any toggle whose value could have changed
  // outside the app — Notification permission, push subscription. Also
  // kick a silent restore: if iOS still has permission granted but the
  // browser dropped the push subscription (push service rotation, SW
  // restart), this re-establishes it before the toggle is rendered, so
  // the user doesn't see a misleading OFF state after a bridge update.
  (async () => {
    try { await _restorePushSubscriptionIfWanted(); } catch {}
    try { await _updateNotifsToggleLabel(); } catch {}
  })();
  // Sync the debug-log toggle's visual state on menu open so the
  // checked-state matches the persisted setting.
  try {
    const t = document.getElementById('debuglogToggle');
    if (t) t.setAttribute('aria-checked', _crcDebugPanelEnabled ? 'true' : 'false');
  } catch {}
  // Same for the read-aloud toggle — it lives in localStorage so its
  // state could have been flipped on a different device / session.
  try {
    const t = document.getElementById('ttsToggle');
    if (t) t.setAttribute('aria-checked', TTS._enabled ? 'true' : 'false');
  } catch {}
});
$$('#menuList li').forEach((li) => {
  li.addEventListener('click', async () => {
    const action = li.dataset.action;
    // Theme and notifs are toggles — keep the menu open so the user
    // sees the switch animate and can flip it back without reopening
    // the menu. Every other action navigates / mutates app state, so
    // closing the menu is the right move.
    if (action !== 'theme' && action !== 'notifs' && action !== 'tts') closeSheet('menuSheet');
    if (action === 'history') {
      openHistorySheet({ from: 'menuSheet' });
      return;
    }
    if (action === 'workspace') {
      openWorkspaceSheet({ from: 'menuSheet' });
      return;
    }
    if (action === 'uploads') {
      openUploadsSheet({ from: 'menuSheet' });
      return;
    }
    if (action === 'voice') {
      openVoiceSheet({ from: 'menuSheet' });
      return;
    }
    if (action === 'tts') {
      const next = !TTS._enabled;
      TTS.setEnabled(next);
      const t = document.getElementById('ttsToggle');
      if (t) t.setAttribute('aria-checked', next ? 'true' : 'false');
      return;
    }
    if (action === 'notifs') {
      _togglePushNotifications();
      return;
    }
    if (action === 'debuglog') {
      _toggleDebugLog();
      return;
    }
    if (action === 'restart') {
      // Single "restart app" affordance — wipes Cache Storage to pick
      // up new HTML / CSS / JS, then cache-bust-reloads. CRITICAL: we
      // do NOT unregister service workers here — that would also wipe
      // the active Web Push subscription, so the user would have to
      // re-toggle Notifications after every "Restart app". The SW is
      // idempotent (no-op service worker; the cache wipe handles the
      // freshness concern by itself).
      _showRestartOverlay();
      (async () => {
        try {
          if ('caches' in self) {
            const names = await caches.keys();
            for (const n of names) { try { await caches.delete(n); } catch {} }
          }
        } catch {}
        const bust = Date.now();
        location.replace(`/?_=${bust}`);
      })();
      return;
    }
    if (action === 'passkey') {
      registerPasskey();
      return;
    }
    if (action === 'theme') {
      // Flip the theme + persist. Also update the meta theme-color so
      // the iOS status-bar tint matches the new palette without needing
      // a reload.
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      if (next === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
      try { localStorage.setItem('crc.theme', next); } catch {}
      const meta = document.querySelector('meta#themeColorMeta');
      if (meta) meta.setAttribute('content', next === 'light' ? '#faf6f1' : '#1a1614');
      _updateThemeMenuLabel();
    } else if (action === 'logout') {
      try { await fetch('/logout', { method: 'POST', headers: CSRF_HEADERS }); } catch {}
      // Clear local app state so the next login is truly fresh (no stale
      // project selection, no carry-over). Keep nothing — the password
      // re-entry is the boundary.
      try {
        localStorage.removeItem('crc.activeProject');
        localStorage.removeItem('crc.mode');
        localStorage.removeItem('crc.effort');
        localStorage.removeItem('crc.tabs');
      } catch {}
      location.href = '/login';
    }
  });
});

// ─── Sessions drawer ──────────────────────────────────────────────────
//
// Slide-in column on the left side, modeled on the VS Code Claude Code
// extension's Sessions panel. Lists ALL Claude sessions across every
// project under PROJECTS_ROOT, newest first. Tapping a row spawns a new
// tab with --resume so the user picks up where that conversation left
// off. Refreshing the page wipes the in-memory tab strip but the
// sessions on disk persist, so the drawer is the canonical view of
// "everything I've ever discussed with Claude."

function openSessionsDrawer() {
  const drawer = $('#sessionsDrawer');
  if (!drawer) return;
  drawer.hidden = false;
  drawer.setAttribute('aria-hidden', 'false');
  // Body class so chat-only floating UI (jump-to-bottom, new-messages
  // pill) can hide while the drawer is open and reappear when it
  // closes. Pure CSS toggle — see `.crc-drawer-open` in app.css.
  document.body.classList.add('crc-drawer-open');
  _loadSessionsIntoDrawer();
}

function closeSessionsDrawer() {
  const drawer = $('#sessionsDrawer');
  if (!drawer) return;
  drawer.hidden = true;
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('crc-drawer-open');
  // Exit select mode on close so reopening doesn't show stale checkboxes.
  if (SessionsSelection && SessionsSelection.selecting) {
    SessionsSelection.selecting = false;
    SessionsSelection.selected.clear();
    const list = $('#sessionsList');
    if (list) list.classList.remove('is-selecting');
    _updateSessionsFooter(null);
  }
}

function isSessionsDrawerOpen() {
  const drawer = $('#sessionsDrawer');
  return !!(drawer && !drawer.hidden);
}

// Backdrop + × close. Refresh button refetches without closing. Edit
// button toggles select mode. Delete button issues the bulk delete.
// Select-all toggles all rows.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-drawer-close]')) closeSessionsDrawer();
  if (e.target.closest('#sessionsRefreshBtn')) _loadSessionsIntoDrawer();
  if (e.target.closest('#sessionsEditBtn')) _toggleSessionsEdit();
  if (e.target.closest('#sessionsDeleteBtn')) _deleteSelectedSessions();
  if (e.target.closest('#sessionsSelectAllBtn')) _toggleSelectAllSessions();
});

function _toggleSelectAllSessions() {
  const list = $('#sessionsList');
  if (!list) return;
  const rows = Array.from(list.querySelectorAll('li[data-session-id]'));
  const allSelected = rows.length > 0 && rows.every((li) =>
    li.getAttribute('data-selected') === 'true');
  if (allSelected) {
    rows.forEach((li) => li.removeAttribute('data-selected'));
    SessionsSelection.selected.clear();
  } else {
    rows.forEach((li) => {
      li.setAttribute('data-selected', 'true');
      SessionsSelection.selected.add(li.dataset.sessionId);
    });
  }
  _updateSessionsFooter(rows.map((li) => ({ session_id: li.dataset.sessionId })));
}

// Select-mode state for the sessions drawer. When `selecting` is true,
// rows show checkboxes and tapping a row toggles selection rather than
// resuming. A footer with "Delete N" appears. Exiting select mode (via
// the Edit toggle or after a delete) restores the normal tap-to-resume
// flow.
const SessionsSelection = {
  selecting: false,
  selected: new Set(),  // session_id strings
};

async function _loadSessionsIntoDrawer() {
  const list = $('#sessionsList');
  if (!list) return;
  list.innerHTML = '';
  list.append(el('li', { class: 'drawer__empty' }, 'Loading sessions…'));
  let data;
  try {
    const resp = await fetch('/api/sessions', { headers: CSRF_HEADERS });
    if (!resp.ok) {
      list.innerHTML = '';
      list.append(el('li', { class: 'drawer__empty' }, `Couldn't load sessions: HTTP ${resp.status}`));
      return;
    }
    data = await resp.json();
  } catch (e) {
    list.innerHTML = '';
    list.append(el('li', { class: 'drawer__empty' }, `Couldn't load sessions: ${e.message || 'network error'}`));
    return;
  }
  const rows = (data && data.sessions) || [];
  // Prune SessionsSelection.selected to drop anything that's gone.
  const ids = new Set(rows.map((r) => r.session_id));
  for (const id of Array.from(SessionsSelection.selected)) {
    if (!ids.has(id)) SessionsSelection.selected.delete(id);
  }
  list.innerHTML = '';
  if (!rows.length) {
    list.append(el('li', { class: 'drawer__empty' }, 'No past conversations yet. Start a chat and Claude will save it for next time.'));
    _updateSessionsFooter(rows);
    return;
  }
  // Find the most-recent session PER project so we can flag it with an
  // "Active" badge — that's the row matching the live VSCode chat for
  // that project, helping the user pick the right one.
  const seenProjectsTop = new Set();
  for (const s of rows) {
    const li = document.createElement('li');
    li.dataset.sessionId = s.session_id;
    const isActive = s.is_most_recent && !seenProjectsTop.has(s.project);
    if (isActive) seenProjectsTop.add(s.project);
    // Hidden in non-select mode via CSS. SVG check mark; appears on
    // selected rows via [data-selected="true"].
    const checkbox = el('span', { class: 'drawer__checkbox' });
    checkbox.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';
    // Prefer the Claude-generated ai-title (same string VSCode shows)
    // over the first user message. Falls back to first message when
    // ai-title hasn't been generated yet.
    const label = s.ai_title || s.preview || '(no message)';
    const top = el('div', { class: 'drawer__rowTop' },
      checkbox,
      el('span', { class: 'drawer__rowDot' }),
      el('span', { class: 'drawer__rowPreview' }, label),
    );
    const metaChildren = [
      el('span', { class: 'drawer__rowMeta--project' }, s.project || ''),
      el('span', {}, _fmtAgo(s.modified_at)),
    ];
    if (isActive) {
      metaChildren.push(el('span', { class: 'drawer__rowMeta--active' }, 'Active'));
    }
    const meta = el('div', { class: 'drawer__rowMeta' }, ...metaChildren);
    li.append(top, meta);
    if (isActive) li.setAttribute('data-active-session', 'true');
    if (SessionsSelection.selected.has(s.session_id)) {
      li.setAttribute('data-selected', 'true');
    }
    li.addEventListener('click', () => {
      if (SessionsSelection.selecting) {
        // Toggle selection.
        const selected = li.getAttribute('data-selected') === 'true';
        if (selected) {
          li.removeAttribute('data-selected');
          SessionsSelection.selected.delete(s.session_id);
        } else {
          li.setAttribute('data-selected', 'true');
          SessionsSelection.selected.add(s.session_id);
        }
        _updateSessionsFooter(rows);
        return;
      }
      closeSessionsDrawer();
      // If this session is already open as a tab, focus it instead of
      // opening a duplicate. Re-tapping a row the user already has
      // open should land them back on the chat they were reading, not
      // double-render history + spawn a parallel tab. Match by claude
      // session UUID — survives across reloads since tab.sessionId is
      // recaptured from the session_init event on the first run.
      const existing = findTabBySessionId(s.session_id);
      if (existing) {
        switchTab(existing.id);
        toast('Switched to open tab for this session', 'info');
        return;
      }
      // Normal mode: resume as new tab. Create the tab first so the user
      // sees instant feedback, then fetch the past message timeline and
      // replay it into the new tab's chatpane. Server's `--resume` will
      // pick up from the same session_id on the next prompt.
      // Prefer the Claude-generated ai-title (matches VSCode's chat
      // label) so the tab title reads the same in both places. Falls
      // back to the first user message preview when no ai-title is set.
      const preTitle = ((s.ai_title || s.preview || '').slice(0, 32).replace(/\s+/g, ' ').trim()) || null;
      const tab = createTab(s.project, { sessionId: s.session_id, title: preTitle });
      _replaySessionInto(tab, s.project, s.session_id);
    });
    list.append(li);
  }
  // Apply the .is-selecting class if we entered select mode while loading.
  list.classList.toggle('is-selecting', SessionsSelection.selecting);
  _updateSessionsFooter(rows);
}

function _updateSessionsFooter(allRows) {
  const footer = $('#sessionsFooter');
  const countEl = $('#sessionsSelCount');
  const deleteBtn = $('#sessionsDeleteBtn');
  const selectAllBtn = $('#sessionsSelectAllBtn');
  const editBtn = $('#sessionsEditBtn');
  if (!footer) return;
  footer.hidden = !SessionsSelection.selecting;
  if (editBtn) editBtn.setAttribute('data-active', SessionsSelection.selecting ? 'true' : 'false');
  const n = SessionsSelection.selected.size;
  if (countEl) countEl.textContent = `${n} selected`;
  if (deleteBtn) deleteBtn.disabled = n === 0;
  // "Select all" toggles between "select all" and "deselect all" based
  // on whether everything is currently selected.
  if (selectAllBtn && allRows) {
    const allSelected = allRows.length > 0 && SessionsSelection.selected.size === allRows.length;
    selectAllBtn.textContent = allSelected ? 'Deselect all' : 'Select all';
  }
}

function _toggleSessionsEdit() {
  SessionsSelection.selecting = !SessionsSelection.selecting;
  if (!SessionsSelection.selecting) SessionsSelection.selected.clear();
  const list = $('#sessionsList');
  if (list) list.classList.toggle('is-selecting', SessionsSelection.selecting);
  // Update [data-selected] markers on rows
  if (list && !SessionsSelection.selecting) {
    list.querySelectorAll('li[data-selected="true"]').forEach((li) => {
      li.removeAttribute('data-selected');
    });
  }
  _updateSessionsFooter(null);
}

async function _deleteSelectedSessions() {
  const ids = Array.from(SessionsSelection.selected);
  if (!ids.length) return;
  const confirmText = ids.length === 1
    ? 'Delete this session permanently?'
    : `Delete ${ids.length} sessions permanently?`;
  if (!confirm(confirmText)) return;
  try {
    const resp = await fetch('/api/sessions/delete', {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_ids: ids }),
    });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      toast(d.detail || `Delete failed: HTTP ${resp.status}`, 'error');
      return;
    }
    const data = await resp.json();
    toast(`Deleted ${data.deleted} session${data.deleted === 1 ? '' : 's'}.`, 'info');
    // Drop tab references to deleted sessions, since --resume would fail.
    for (const t of State.tabs) {
      if (t.sessionId && ids.includes(t.sessionId)) {
        t.sessionId = null;
        t.pendingResumeSessionId = null;
      }
    }
    SessionsSelection.selected.clear();
    SessionsSelection.selecting = false;
    const list = $('#sessionsList');
    if (list) list.classList.remove('is-selecting');
    await _loadSessionsIntoDrawer();
  } catch (e) {
    toast(`Delete failed: ${e.message || 'network error'}`, 'error');
  }
}

// Hardware Escape closes the drawer (parity with sheets).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSessionsDrawer();
});

// Fetch the past Claude session's event timeline and render it into the
// given tab's chatpane so the user sees the conversation history before
// continuing it. We use a synthetic `runId = 0` for the assistant turn so
// the existing Chat.* methods (which expect run records keyed by runId)
// work without modification. The replayed run is marked finished before
// any new prompt is sent, so the spinner doesn't linger.
// Given the turn-grouped replay events, return a map of
// tool_use_id → answerText for every AskUserQuestion call whose
// answer is captured in the same jsonl. The "answer" is the user
// message that opens the next turn — that's how the bridge routes
// AskUserQuestion submissions (see `_submitAskQuestionAnswer`).
// Lets the replay path show the original answer right inside the
// re-rendered card, so the user doesn't lose what they chose when
// they reload the chat.
function _buildAskQuestionAnswerMap(turns) {
  const out = {};
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t.assistant || !t.assistant.length) continue;
    // The answer is the next turn's user message text. If this is the
    // last turn or the next turn has no user (synthetic assistant-only
    // turn), there's no answer to surface yet.
    const nextUser = (i + 1 < turns.length && turns[i + 1].user) ? turns[i + 1].user.text || '' : '';
    if (!nextUser) continue;
    for (const a of t.assistant) {
      if (a.type === 'tool_use' && a.name === 'AskUserQuestion' && a.tool_use_id) {
        out[a.tool_use_id] = nextUser;
      }
    }
  }
  return out;
}

async function _replaySessionInto(tab, project, sessionId) {
  if (!tab || !project || !sessionId) return;
  // In-chat loading affordance: nicer than a bottom-right toast and
  // makes it clear which tab is loading. Disappears as soon as the
  // replay starts rendering messages (or shows an error in-place).
  const pane = _ensureChatpane(tab);
  let loadingEl = null;
  if (pane) {
    // Reuse the pre-seeded loading element if `_ensureChatpaneAndReplay`
    // already inserted one synchronously to suppress the inter-tab
    // empty-state flash (2026-05-17). If we're called from a path that
    // doesn't pre-seed (e.g. history drawer → "open in new tab"), the
    // pane has no loading element yet and we add ours now.
    loadingEl = pane.querySelector('.chat__loading');
    if (!loadingEl) {
      loadingEl = el('div', { class: 'chat__loading' },
        el('div', { class: 'chat__loading__spinner', 'aria-hidden': 'true' }),
        el('div', { class: 'chat__loading__label' }, 'Loading conversation…'),
      );
      pane.append(loadingEl);
    }
    // Hide the empty-state since the loading affordance now occupies the
    // pane and showing both at once feels cluttered.
    const empty = $('#emptyState');
    if (empty) empty.hidden = true;
    Chat.scrollToBottom(true);
  }
  const removeLoading = () => { if (loadingEl && loadingEl.parentNode) loadingEl.remove(); };
  let data;
  try {
    const resp = await fetch(
      `/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(sessionId)}/messages`,
      { headers: CSRF_HEADERS },
    );
    if (!resp.ok) {
      removeLoading();
      toast(`Couldn't load past chat: HTTP ${resp.status}`, 'error');
      return;
    }
    data = await resp.json();
  } catch (e) {
    removeLoading();
    toast(`Couldn't load past chat: ${e.message || 'network error'}`, 'error');
    return;
  }
  let events = (data && data.events) || [];
  // Remember the byte offset so periodic polling can ask "what's new
  // since here?" — that's the live-sync hook with whatever VSCode /
  // terminal Claude session is writing to the same jsonl.
  tab.sessionTailOffset = data && data.tail_offset || 0;
  // Seed the tab's usage from the server-computed cumulative summary
  // (sum of input + cache_creation + output across every assistant
  // message in the jsonl). That's the figure the donut needs to match
  // VSCode's "% context remaining" indicator. Without seeding here the
  // donut stayed empty on resumed sessions until the user sent a
  // fresh prompt.
  if (data && data.usage && (data.usage.context_used || data.usage.input_tokens)) {
    tab.usage = {
      input: data.usage.input_tokens || 0,
      output: data.usage.output_tokens || 0,
      cache_read: data.usage.cache_read_tokens || 0,
      cache_creation: data.usage.cache_creation_tokens || 0,
      context_used: data.usage.context_used || 0,
      ts: Date.now(),
    };
    if (tab.id === State.activeTabId) renderUsageDonut();
    // If a resumed session loads ALREADY past the auto-compact threshold
    // (user closed the PWA right before the donut crossed 80% and
    // re-opened it the next day), fire compact NOW so the next prompt
    // they type doesn't waste another full turn over budget. The gate
    // refuses to fire while tab.running is true OR a compact is
    // pending, so this is safe to call eagerly here.
    _maybeFireAutoCompact(tab, 'done');
  }
  removeLoading();
  if (!events.length) {
    toast('Past chat is empty.', 'info');
    return;
  }
  // If a WS frame already built this pane and rendered events into it
  // (typically a media frame or live delta arriving for an inactive
  // tab BEFORE the user switched to it), wipe those bubbles before we
  // replay — otherwise jsonl re-emits them and the user sees every
  // event twice. Skip the clear when an active run is in flight: its
  // assistant container is registered in `_activeRuns` and destroying
  // it would orphan the next live delta.
  const hasActiveRun = !!(tab._activeRuns && tab._activeRuns.size > 0);
  if (pane && !hasActiveRun) {
    try { pane.querySelectorAll('.msg').forEach((n) => n.remove()); } catch {}
  }
  // Hide any synthetic compact prompts + the streamed summary that
  // followed them. The boundary divider still drops in between the
  // pre- and post-compact halves; the user just doesn't see the
  // mechanical "Please compact this conversation…" exchange.
  events = _stripCompactSpan(events);
  // Group flat events into per-turn runs so each assistant bubble is
  // created → populated → finished as one atomic unit. Avoids the
  // spinner ping-ponging if we'd called beginRun/finishRun out of order.
  const turns = [];
  let curr = null;
  for (const ev of events) {
    if (ev.type === 'user') {
      if (curr) turns.push(curr);
      curr = { user: ev, assistant: [] };
    } else if (ev.type === 'system_notification') {
      // Render as its own gray system message between turns, never
      // bundled into an assistant run (it isn't Claude's output) and
      // never as a user message (the human didn't type it).
      if (curr) turns.push(curr);
      turns.push({ system: ev });
      curr = null;
    } else if (ev.type === 'agent_complete') {
      // Subagent return — graft onto its matching Agent toolcard
      // (rendered earlier in this same replay walk). The walker
      // emits a sentinel turn that the renderer below dispatches
      // to `appendAgentComplete`.
      if (curr) turns.push(curr);
      turns.push({ agentComplete: ev });
      curr = null;
    } else if (ev.type === 'compact_complete') {
      if (curr) turns.push(curr);
      turns.push({ compact: true });
      curr = null;
    } else if (curr) {
      curr.assistant.push(ev);
    } else {
      // Sessions occasionally begin with an assistant event (system
      // greeting / continued chain). Start a synthetic turn for it.
      curr = { user: null, assistant: [ev] };
    }
  }
  if (curr) turns.push(curr);

  // Pre-compute the answer map for AskUserQuestion calls. Each
  // tool_use_id of an AskUserQuestion gets mapped to the text of the
  // user message that immediately followed it in the next turn —
  // that's the user's original answer, which we'll show inside the
  // re-rendered card so the answer survives chat reload.
  const askAnswers = _buildAskQuestionAnswerMap(turns);

  let syntheticId = -1;
  try {
    for (const t of turns) {
      if (t.system) {
        Chat.pushSystem(t.system.text || '', undefined, tab.id);
        continue;
      }
      if (t.compact) {
        const pane = tab._chatpane;
        if (pane) _appendCompactDivider(pane);
        continue;
      }
      if (t.agentComplete) {
        const a = t.agentComplete;
        Chat.appendAgentComplete(a.tool_use_id || '', a.summary || '', a.result || '', a.status || 'completed', tab.id);
        continue;
      }
      if (t.user) Chat.pushUser(t.user.text || '', t.user.attachments || [], tab.id, { replay: true });
      if (t.assistant.length) {
        const rid = syntheticId--;
        Chat.beginRun(project, rid, tab.id, { silent: true });
        for (const a of t.assistant) {
          if (a.type === 'assistant_text') {
            // Defer markdown re-render — flushDeferredRender below will
            // do one final parse per body once all events for this run
            // have been appended. Avoids O(N²) re-parsing during replay.
            Chat.appendDelta(project, rid, a.text || '', tab.id, { deferRender: true });
          } else if (a.type === 'tool_use') {
            const tid = a.tool_use_id || '';
            const replayAnswer = a.name === 'AskUserQuestion' ? (askAnswers[tid] || null) : null;
            Chat.appendToolUse(project, rid, a.name || '', a.input || {}, tab.id, tid, replayAnswer);
          } else if (a.type === 'tool_error') {
            Chat.appendToolError(project, rid, a.text || '', tab.id, a.tool_use_id || '');
          } else if (a.type === 'tool_result') {
            Chat.appendToolResult(project, rid, a.tool_use_id || '', a.text || '', !!a.is_error, tab.id);
          } else if (a.type === 'media') {
            // Image / video re-emitted by the server's replay path so the
            // chat retains inline media after the user closes and reopens
            // it. Same renderer as the live WS media frame.
            Chat.appendMedia(project, rid, a, tab.id);
          }
        }
        Chat.flushDeferredRender(rid, tab.id);
        Chat.finishRun(project, rid, 'done', '', tab.id, { silent: true });
      }
    }
  } catch (err) {
    console.error('replay failed', err);
    toast('Couldn\'t fully render past chat — see console.', 'error');
  }
  Chat.scrollToBottom(true);
  // If the server says this tab still has a live run (hello frame set
  // tab.running=true while or before replay was running), surface the
  // ghost spinner now that replay has stopped overwriting containers.
  // Otherwise nothing visible signals "still working" until the next
  // delta lands — and on a tool-heavy turn that can be many seconds.
  Chat.ensureRunningSpinner(tab.id);
  // Kick off the live-sync poller for this tab. New messages written
  // to the same jsonl by VSCode / terminal will appear here within a
  // few seconds.
  _startSessionPoll(tab, project, sessionId);
}

// Per-tab polling timer registry. Lets us cancel polls when the tab
// closes / the session changes / the page reloads.
const _sessionPollTimers = new Map();
const SESSION_POLL_INTERVAL_MS = 1500;

function _stopSessionPoll(tabId) {
  const rec = _sessionPollTimers.get(tabId);
  if (rec) {
    // rec is always {handle, kick} — `_startSessionPoll` is the sole
    // writer and was refactored to that shape 2026-05-17. If a future
    // change re-introduces a raw-handle writer, this access throws
    // (TypeError on undefined.handle in dev) — which is exactly what
    // we want so the regression doesn't hide.
    clearTimeout(rec.handle);
    _sessionPollTimers.delete(tabId);
  }
  const tab = getTab(tabId);
  if (tab && tab._liveIdleCloseTimer) {
    clearTimeout(tab._liveIdleCloseTimer);
    tab._liveIdleCloseTimer = null;
  }
}

// Map of tabId → {handle, kick}. `kick` re-arms the timer to fire
// immediately so switchTab() can refresh the newly-active tab without
// waiting up to SESSION_POLL_INTERVAL_MS for the next scheduled tick.
function _startSessionPoll(tab, project, sessionId) {
  if (!tab || !project || !sessionId) return;
  _stopSessionPoll(tab.id);
  let inFlight = false;
  const arm = (ms) => {
    const handle = setTimeout(tick, ms);
    _sessionPollTimers.set(tab.id, { handle, kick });
  };
  const kick = () => {
    const rec = _sessionPollTimers.get(tab.id);
    if (rec && rec.handle) {
      clearTimeout(rec.handle);
    }
    arm(0);
  };
  const tick = async () => {
    if (inFlight) {
      arm(SESSION_POLL_INTERVAL_MS);
      return;
    }
    // Tab might have been closed / session swapped while we were
    // waiting; bail out cleanly in that case.
    const live = getTab(tab.id);
    if (!live || live.sessionId !== sessionId) {
      _sessionPollTimers.delete(tab.id);
      return;
    }
    // Visibility gate. iOS Safari kills the WebContent process when
    // its memory budget is exceeded — and with N tabs we previously
    // ran N concurrent pollers, each doing a fetch + JSON parse +
    // (potentially) a synchronous DOM append every 1.5s. On a phone
    // with 3+ tabs that bandwidth/CPU/heap pressure piles on top of
    // the tab-switch layout pass and pushes WebKit over the edge;
    // when the page is killed Safari auto-reloads, the same scenario
    // recurs, and after the 3rd kill Safari shows the persistent
    // "A problem repeatedly occurred" page. Pausing fetches for
    // tabs that aren't the active one removes that pile-on entirely.
    // The timer chain stays alive (cheap setTimeout wakeup) so when
    // the user switches the next tick fetches — and switchTab() also
    // calls kick() to fire immediately.
    if (live.id !== State.activeTabId || document.hidden) {
      arm(SESSION_POLL_INTERVAL_MS);
      return;
    }
    inFlight = true;
    try {
      // If a phone-driven WS run is currently in flight for this tab,
      // skip the fetch entirely. The WS stream is already rendering
      // this run's events live; if we ALSO pulled them from jsonl we'd
      // double-render the whole turn (user message, tool IN, tool OUT,
      // assistant text). When the WS run finishes (handler below) we
      // advance the tail offset to the post-run file size so subsequent
      // polls cleanly resume from after the run's events.
      if (live._wsRunInFlight) {
        return;
      }
      const since = live.sessionTailOffset || 0;
      const resp = await fetch(
        `/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(sessionId)}/messages?since=${since}`,
        { headers: CSRF_HEADERS },
      );
      if (resp.ok) {
        const data = await resp.json();
        const evs = (data && data.events) || [];
        if (evs.length) {
          _appendLiveEvents(live, project, evs);
        }
        if (data && typeof data.tail_offset === 'number') {
          live.sessionTailOffset = data.tail_offset;
        }
      }
    } catch (e) {
      // network blip — try again next tick
    } finally {
      inFlight = false;
      arm(SESSION_POLL_INTERVAL_MS);
    }
  };
  arm(SESSION_POLL_INTERVAL_MS);
}

// Force an immediate session-poll tick for one tab — IFF that tab
// already has a registered poller. Called from switchTab; on a tab
// that was just hydrated for the first time, the poller is registered
// asynchronously inside _replaySessionInto AFTER its fetch resolves,
// so this call no-ops (no record yet) and the first real tick lands
// ~1.5s later via the poller's own initial arm. Already-hydrated tabs
// get the immediate refresh as advertised.
function _pokeSessionPoll(tabId) {
  const rec = _sessionPollTimers.get(tabId);
  if (rec && typeof rec.kick === 'function') rec.kick();
}

// Token-estimation constants — same math as bridge/jsonl_helpers.py so
// the live-update path lands at the same number as the server-computed
// replay value. chars/5.0 + per-event tool cap, system-prompt overhead
// is already baked into the initial seed.
const _CTX_CHARS_PER_TOKEN = 5.0;
const _CTX_TOOL_CAP = 4500;

function _estimateEventTokens(ev) {
  let chars = 0;
  if (ev.type === 'user' && ev.text) {
    chars += ev.text.length;
  } else if (ev.type === 'assistant_text' && ev.text) {
    chars += ev.text.length;
  } else if (ev.type === 'tool_use') {
    chars += (ev.name || '').length;
    try {
      const inputStr = JSON.stringify(ev.input || {});
      chars += Math.min(inputStr.length, _CTX_TOOL_CAP);
    } catch {}
  } else if (ev.type === 'tool_error' && ev.text) {
    chars += Math.min(ev.text.length, _CTX_TOOL_CAP);
  }
  return Math.floor(chars / _CTX_CHARS_PER_TOKEN);
}

// Recognise the synthetic compact prompt the donut-tap / auto-compact
// path sends so the live-replay path can hide it. Belt-and-braces — the
// `_compactSilent` flag handles the in-flight case; this catches the
// follow-up poll that re-fetches the same events after the flag clears.
const _COMPACT_PROMPT_SIG = 'Please compact this conversation';

// Walk a poll batch and drop the synthetic compact-prompt user event,
// every assistant_text / tool_use / tool_result / tool_error event that
// follows it (the streamed summary), and the terminating compact_complete
// Replay the latest turn from jsonl into a tab whose live WS stream
// missed events during a mid-run reconnect. Strips every node after
// the last user bubble (the partial assistant container the live
// stream built) and re-renders via `_appendLiveEvents`. Set on
// `tab._lossyRun` by the hello handler when the WS reconnects with
// a still-running tab — see the comment on the run_finished case.
function _lossyBackfillTurn(tab, project, events) {
  if (!tab || !tab._chatpane || !Array.isArray(events) || !events.length) return;
  const pane = tab._chatpane;
  // Remove everything after the last user bubble — the partial
  // assistant container the live stream built, plus any stray
  // status/system rows the session poll may have inserted in the
  // meantime. _appendLiveEvents will re-create them from jsonl.
  const userBubbles = pane.querySelectorAll('.msg--user');
  const lastUser = userBubbles[userBubbles.length - 1];
  if (lastUser) {
    let n = lastUser.nextElementSibling;
    while (n) {
      const x = n;
      n = n.nextElementSibling;
      try { x.remove(); } catch {}
    }
  }
  // Drop any tracked active-run entries for this tab — the live
  // containers they pointed at are gone, and leaving the map populated
  // would keep tab.running stuck at true (runs.size > 0).
  if (tab._activeRuns) {
    for (const run of tab._activeRuns.values()) {
      if (run.cycler) { try { clearInterval(run.cycler); } catch {} run.cycler = null; }
      if (run.spinnerTimer) { try { run.spinnerTimer(); } catch {} run.spinnerTimer = null; }
    }
    tab._activeRuns.clear();
  }
  // Also clear any open synthetic run on the live-replay path so the
  // backfill starts fresh instead of accumulating onto a stale entry.
  _liveTurnRunIds.set(tab.id, null);
  // Render the events. _appendLiveEvents will create a fresh
  // synthetic-runId container for the assistant text; the user event
  // at the head of the batch dedupes against the surviving user
  // bubble (line check inside _appendLiveEvents), so we don't get a
  // second user message.
  _appendLiveEvents(tab, project, events);
  // _appendLiveEvents leaves the synthetic runId "open" with the 4s
  // idle timer as its only close path. The run is actually DONE
  // (we're called from run_finished), so close it now — otherwise
  // the user sees the kawaii + status word spinning for ~4s on an
  // already-finished turn.
  const openId = _liveTurnRunIds.get(tab.id);
  if (openId != null) {
    if (tab._liveIdleCloseTimer) {
      try { clearTimeout(tab._liveIdleCloseTimer); } catch {}
      tab._liveIdleCloseTimer = null;
    }
    try { Chat.flushDeferredRender(openId, tab.id); } catch {}
    try { Chat.finishRun(project, openId, 'done', '', tab.id); } catch {}
    _liveTurnRunIds.set(tab.id, null);
  }
  try { Chat.scrollToBottom(true); } catch {}
}

// marker. Returns a new array; never mutates the input.
function _stripCompactSpan(events) {
  if (!Array.isArray(events) || !events.length) return events;
  const out = [];
  let inCompact = false;
  for (const ev of events) {
    if (!inCompact && ev && ev.type === 'user' && typeof ev.text === 'string'
        && ev.text.startsWith(_COMPACT_PROMPT_SIG)) {
      inCompact = true;
      continue;
    }
    if (inCompact) {
      if (ev && ev.type === 'compact_complete') {
        // End of the span — keep the boundary marker so a divider gets
        // drawn between the pre-compact tail and the post-compact half.
        inCompact = false;
        out.push(ev);
        continue;
      }
      if (ev && (ev.type === 'assistant_text' || ev.type === 'tool_use'
                 || ev.type === 'tool_result' || ev.type === 'tool_error'
                 || ev.type === 'media' || ev.type === 'turn_end')) {
        continue;
      }
      // A real user message or something else outside the swallow set —
      // we've fallen off the end of the compact run without seeing the
      // boundary. Close the span and render this event normally.
      inCompact = false;
    }
    out.push(ev);
  }
  return out;
}

// Append a batch of incremental events to a tab's chatpane, using the
// same per-turn grouping as the initial replay (user message + one
// assistant run with its tool uses and text). Each incremental batch
// creates its own synthetic run, so claude turns that span multiple
// polls land in the same visual bubble.
const _liveTurnRunIds = new Map();   // tabId → current synthetic run_id

function _appendLiveEvents(tab, project, events) {
  if (!tab || !tab._chatpane) return;
  // While a silent compact run is in flight, do not render any of its
  // events — the user message is the synthetic compact prompt and the
  // assistant text is the summary, both of which should stay invisible.
  // The donut still updates from the usage frame elsewhere.
  if (tab._compactSilent) return;
  // Strip the synthetic compact-prompt user event and everything Claude
  // produced in response to it (assistant_text summary, tool calls), up
  // to the compact_complete marker. The post-compact replay starts after
  // the boundary anyway, and the model already has the summary baked
  // into the seed message; rendering the prompt + summary as bubbles
  // would just spoil the illusion that nothing happened.
  events = _stripCompactSpan(events);
  let runId = _liveTurnRunIds.get(tab.id);
  // Track how much new context this batch adds so the donut catches up
  // alongside the chat. Without this the donut would stay at whatever
  // value the initial replay reported, even as VSCode keeps adding
  // tokens via the same jsonl.
  let addedTokens = 0;
  // Reset the "no more activity" idle timer ONLY when events actually
  // arrive. If we reset on every poll cycle (including empty ones),
  // the 6s window never elapses and the spinner stays forever.
  if (events && events.length && tab._liveIdleCloseTimer) {
    clearTimeout(tab._liveIdleCloseTimer);
    tab._liveIdleCloseTimer = null;
  }
  for (const ev of events) {
    addedTokens += _estimateEventTokens(ev);
    if (ev.type === 'user') {
      // Boundary — close any open assistant turn, open a fresh one
      // on the NEXT assistant event.
      if (runId != null) {
        try { Chat.flushDeferredRender(runId, tab.id); } catch {}
        try { Chat.finishRun(project, runId, 'done', '', tab.id); } catch {}
      }
      runId = null;
      // Dedup against optimistic local push. When the user types a
      // prompt on the phone, Chat.pushUser is called immediately for
      // responsiveness. The bridge then runs claude which appends the
      // SAME user event to the jsonl, which the poll re-fetches —
      // without this check the message would render twice.
      const incoming = ev.text || '';
      const userMsgs = tab._chatpane && tab._chatpane.querySelectorAll('.msg--user');
      const last = userMsgs && userMsgs.length ? userMsgs[userMsgs.length - 1] : null;
      const lastText = last && last.dataset ? (last.dataset.text || '') : '';
      if (incoming && lastText === incoming) {
        continue;
      }
      Chat.pushUser(incoming, ev.attachments || [], tab.id);
    } else if (ev.type === 'assistant_text') {
      if (runId == null) {
        runId = -(Math.floor(Math.random() * 1e6) + 1);
        Chat.beginRun(project, runId, tab.id);
      }
      Chat.appendDelta(project, runId, ev.text || '', tab.id, { deferRender: true });
    } else if (ev.type === 'tool_use') {
      if (runId == null) {
        runId = -(Math.floor(Math.random() * 1e6) + 1);
        Chat.beginRun(project, runId, tab.id);
      }
      // Look ahead for the user event that answered this AskUserQuestion
      // (if any) so the card replays in its answered state.
      let replayAnswer = null;
      if (ev.name === 'AskUserQuestion' && ev.tool_use_id) {
        const myIdx = events.indexOf(ev);
        for (let j = myIdx + 1; j < events.length; j++) {
          if (events[j].type === 'user') {
            replayAnswer = events[j].text || '';
            break;
          }
        }
      }
      Chat.appendToolUse(project, runId, ev.name || '', ev.input || {}, tab.id, ev.tool_use_id || '', replayAnswer);
    } else if (ev.type === 'tool_error') {
      if (runId == null) {
        runId = -(Math.floor(Math.random() * 1e6) + 1);
        Chat.beginRun(project, runId, tab.id);
      }
      Chat.appendToolError(project, runId, ev.text || '', tab.id, ev.tool_use_id || '');
    } else if (ev.type === 'tool_result') {
      if (runId == null) {
        runId = -(Math.floor(Math.random() * 1e6) + 1);
        Chat.beginRun(project, runId, tab.id);
      }
      Chat.appendToolResult(project, runId, ev.tool_use_id || '', ev.text || '', !!ev.is_error, tab.id);
    } else if (ev.type === 'agent_complete') {
      // Subagent finished — graft its `<result>` onto the matching
      // Agent toolcard (replacing the launch-confirmation OUT panel)
      // and drop the "running" badge. No separate gray bubble.
      if (runId != null) {
        try { Chat.flushDeferredRender(runId, tab.id); } catch {}
        try { Chat.finishRun(project, runId, 'done', '', tab.id); } catch {}
        runId = null;
      }
      Chat.appendAgentComplete(ev.tool_use_id || '', ev.summary || '', ev.result || '', ev.status || 'completed', tab.id);
    } else if (ev.type === 'system_notification') {
      // Subagent-completion banners (Claude Code writes them as `user`
      // events but the human didn't type them). Render as a gray system
      // bubble so the user can see them without mistaking them for
      // their own input. Close any open assistant run so it sits on
      // its own line.
      if (runId != null) {
        try { Chat.flushDeferredRender(runId, tab.id); } catch {}
        try { Chat.finishRun(project, runId, 'done', '', tab.id); } catch {}
        runId = null;
      }
      Chat.pushSystem(ev.text || '', undefined, tab.id);
    } else if (ev.type === 'compact_complete') {
      // External Claude Code process just compacted this session.
      // Render the same divider mobile-driven /compact uses, and refresh
      // the donut so the freed tokens are visible.
      if (runId != null) {
        try { Chat.flushDeferredRender(runId, tab.id); } catch {}
        try { Chat.finishRun(project, runId, 'done', '', tab.id); } catch {}
        runId = null;
      }
      if (tab._chatpane) _appendCompactDivider(tab._chatpane);
      // After compact, the next assistant `usage` event will overwrite
      // the donut to the post-compact value. Don't bother estimating
      // here — the actual numbers land in milliseconds.
    } else if (ev.type === 'media') {
      // Server's replay path re-emits media for image Read/Write tool
      // calls. Render inline in the current synthetic run.
      if (runId == null) {
        runId = -(Math.floor(Math.random() * 1e6) + 1);
        Chat.beginRun(project, runId, tab.id);
      }
      Chat.appendMedia(project, runId, ev, tab.id);
    } else if (ev.type === 'turn_end') {
      // Authoritative "Claude finished this turn" signal from the
      // server's view of the jsonl (it saw a `result` event). Close
      // the synthetic run + spinner immediately so we don't depend on
      // the idle timer below — which used to fire too aggressively
      // during long tool calls and caused the spinner to flicker
      // on/off mid-turn on the observing phone.
      if (runId != null) {
        try { Chat.flushDeferredRender(runId, tab.id); } catch {}
        try { Chat.finishRun(project, runId, 'done', '', tab.id); } catch {}
        runId = null;
      }
      if (tab._liveIdleCloseTimer) {
        clearTimeout(tab._liveIdleCloseTimer);
        tab._liveIdleCloseTimer = null;
      }
      // OVERWRITE the donut with the authoritative token count from
      // the result event. Earlier we'd been ACCUMULATING char-based
      // estimates (addedTokens) into tab.usage.context_used, which
      // drifted upward by 20%+ over a long session. Zero `addedTokens`
      // for this batch too so the post-loop bump doesn't undo this.
      if (typeof ev.context_used === 'number' && ev.context_used > 0) {
        if (!tab.usage) tab.usage = {};
        tab.usage.context_used = ev.context_used;
        addedTokens = 0;
        if (tab.id === State.activeTabId) renderUsageDonut();
      }
    }
  }
  // Flush deferred markdown rendering for the open run (if any) so
  // the user sees text as it arrives, not just on turn boundaries.
  if (runId != null) {
    try { Chat.flushDeferredRender(runId, tab.id); } catch {}
  }
  _liveTurnRunIds.set(tab.id, runId);
  // Idle fallback: if we never see a `turn_end` event (older sessions,
  // killed mid-stream so no `result` lands in the jsonl), close the
  // run after 4s of silence. Previously 12s, which left the spinner
  // stuck visibly long after the run actually finished — users on
  // resume saw "thinking..." for 12s even though their notification
  // had already fired. The `turn_end` event is still the primary
  // signal; 4s is a tight safety-net for the rare case it doesn't
  // arrive.
  if (runId != null) {
    tab._liveIdleCloseTimer = setTimeout(() => {
      try { Chat.flushDeferredRender(runId, tab.id); } catch {}
      try { Chat.finishRun(project, runId, 'done', '', tab.id); } catch {}
      _liveTurnRunIds.set(tab.id, null);
      tab._liveIdleCloseTimer = null;
    }, 4_000);
  }
  // Donut bump: add this batch's tokens to the running context total
  // and re-render. Keeps mobile aligned with VSCode's "% remaining"
  // even when VSCode is the one driving the conversation.
  if (addedTokens > 0) {
    if (!tab.usage) tab.usage = { context_used: 0 };
    tab.usage.context_used = (tab.usage.context_used || 0) + addedTokens;
    if (tab.id === State.activeTabId) renderUsageDonut();
  }
  // Auto-scroll only if user is already near the bottom — if they're
  // reading scrollback, don't yank them down.
  Chat.scrollToBottom(false, { fromContent: true });
}

// ─── History ──────────────────────────────────────────────────────────
//
// Claude Code writes each interactive session as a `.jsonl` file under
// `~/.claude/projects/<encoded-cwd>/`. The bridge surfaces those via
// `GET /api/sessions/<project>`; tapping a row opens that session as a
// new tab whose first run will `--resume <id>` to thread it.

function _fmtAgo(unixSecs) {
  if (!unixSecs) return '';
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Workspace switcher ──────────────────────────────────────────────
//
// PROJECTS_ROOT (from .env.local) is the bootstrap default that the
// user picks at install time. The workspace sheet lets them swap the
// ACTIVE root at runtime to any other folder on disk — so a user with
// multiple project trees doesn't have to edit .env.local + restart to
// flip between them. Selecting a folder hits POST /api/workspace/set_root
// on the server, which updates `state.active_root` and validates the
// path; subsequent project picks resolve against the new root.
//
// Reverts to the default on every bridge restart so the install stays
// reproducible from the .env.local file.
let _workspaceBrowsePath = null;  // current dir shown in the folder picker

async function openWorkspaceSheet(opts) {
  openSheet('workspaceSheet', opts);
  await _refreshWorkspaceInfo();
  const picker = $('#workspacePicker');
  // `openPicker: true` is used by the "Browse other folders…" entry in
  // the project picker — skip the intermediate sheet and jump straight
  // to the folder picker (shortcuts row + breadcrumb + folder list).
  if (opts && opts.openPicker) {
    _openWorkspaceBrowse(null);
  } else if (picker) {
    picker.hidden = true;
  }
}

// ─── Manage Uploads sheet ────────────────────────────────────────────
//
// Lists every project subfolder under <PROJECTS_ROOT>/.web-uploads/
// with its size + file count, lets the user check rows and bulk-delete
// via /api/uploads/clear. Two top-level buttons: "Clear selected" (only
// the checked rows) and "Clear all" (every project). Both require a
// confirm() before firing.

function _formatBytesUploads(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}

async function openUploadsSheet(opts) {
  openSheet('uploadsSheet', opts);
  await _refreshUploadsList();
}

// Reader-voice sheet (menu → Reader voice). Lists every voice the
// system has shipped; tapping the row selects it (and persists), the
// per-row speaker button previews without selecting, and the search
// box at the top filters by name or language. "Auto" clears the
// override so _pickVoiceFor's heuristic chooses per-utterance.
// The "premium / high-quality" voice tags Apple, Microsoft and Google
// use in voice names. Shared by both the sort comparator and the
// per-row "high quality" badge so the two stay in sync.
const _PREMIUM_VOICE_RE = /enhanced|premium|natural|wavenet|neural/i;

function openVoiceSheet(opts) {
  openSheet('voiceSheet', opts);
  const search = document.getElementById('voiceSearch');
  // Bind once per page lifetime — the sheet element is permanent in
  // index.html so we don't need a defensive re-bind on each open.
  if (search && !openVoiceSheet._bound) {
    search.addEventListener('input', () => _renderVoiceList(search.value));
    openVoiceSheet._bound = true;
  }
  if (search) search.value = '';
  _renderVoiceList('');
  // iOS often has empty voices on first sheet-open; the voiceschanged
  // event fills the list a moment later. { once: true } guarantees
  // the listener detaches itself even if voices never load (so we
  // don't leak listeners across re-opens).
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        _renderVoiceList(search ? search.value : '');
      }, { once: true });
    } catch {}
  }
}

// Short sample phrases to preview a voice with. Picked per language so
// Hebrew voices speak Hebrew, Arabic voices Arabic, etc. — otherwise
// the preview reads English with the wrong voice and sounds wrong.
// Falls back to English for unmapped languages.
const _VOICE_PREVIEW_SAMPLES = {
  en: 'Hello, this is how I sound when reading a message.',
  he: 'שלום, ככה אני נשמע כשאני קורא הודעה.',
  ar: 'مرحبا، هذا هو صوتي عندما أقرأ رسالة.',
  ru: 'Привет, вот как звучит мой голос при чтении сообщения.',
  ja: 'こんにちは、これがメッセージを読むときの私の声です。',
  zh: '你好，这就是我朗读消息时的声音。',
  es: 'Hola, así es como sueno cuando leo un mensaje.',
  fr: 'Bonjour, voici comment je sonne en lisant un message.',
  de: 'Hallo, so klinge ich beim Vorlesen einer Nachricht.',
  it: 'Ciao, ecco come suono quando leggo un messaggio.',
  pt: 'Olá, é assim que soo ao ler uma mensagem.',
};

function _previewSampleFor(voice) {
  const lang = (voice && voice.lang) || 'en-US';
  const prefix = lang.slice(0, 2).toLowerCase();
  return _VOICE_PREVIEW_SAMPLES[prefix] || _VOICE_PREVIEW_SAMPLES.en;
}

// Speaker icon used in the preview button. Coral-stroke when speaking
// (handled by CSS class), neutral otherwise.
const _VOICE_PREVIEW_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15 9a3 3 0 0 1 0 6"/><path d="M17.5 7a6 6 0 0 1 0 10"/></svg>';

// Track which preview button is currently speaking so we can flip its
// icon back when speech ends OR when a new preview supersedes it.
let _activePreviewBtn = null;

function _previewVoice(voice, btn) {
  if (!('speechSynthesis' in window)) return;
  // Cancel any in-flight speech (main TTS or a previous preview) and
  // reset its button.
  try { window.speechSynthesis.cancel(); } catch {}
  if (_activePreviewBtn && _activePreviewBtn !== btn) {
    _activePreviewBtn.classList.remove('voiceList__preview--speaking');
  }
  // If this same button was already speaking, the cancel above turned
  // it off — treat as toggle.
  if (_activePreviewBtn === btn) {
    btn.classList.remove('voiceList__preview--speaking');
    _activePreviewBtn = null;
    return;
  }
  try {
    const u = new SpeechSynthesisUtterance(_previewSampleFor(voice));
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    else { u.lang = 'en-US'; }
    u.rate = 1.0;
    u.pitch = 1.0;
    const off = () => {
      btn.classList.remove('voiceList__preview--speaking');
      if (_activePreviewBtn === btn) _activePreviewBtn = null;
    };
    u.onend = off;
    u.onerror = off;
    btn.classList.add('voiceList__preview--speaking');
    _activePreviewBtn = btn;
    window.speechSynthesis.speak(u);
  } catch (e) {
    try { console.warn('[voice preview]', e); } catch {}
  }
}

function _voiceMatchesQuery(voice, q) {
  if (!q) return true;
  const haystack = ((voice.name || '') + ' ' + (voice.lang || '')).toLowerCase();
  if (haystack.includes(q)) return true;
  // Friendly aliases: typing "hebrew" matches he-IL voices, "english"
  // matches en-* voices, etc. Keeps the search useful for users who
  // don't know BCP-47 codes.
  const aliases = {
    hebrew: 'he', english: 'en', arabic: 'ar', russian: 'ru',
    japanese: 'ja', chinese: 'zh', spanish: 'es', french: 'fr',
    german: 'de', italian: 'it', portuguese: 'pt', korean: 'ko',
    dutch: 'nl', polish: 'pl', turkish: 'tr', swedish: 'sv',
    norwegian: 'no', danish: 'da', finnish: 'fi', greek: 'el',
    thai: 'th', vietnamese: 'vi', indonesian: 'id', czech: 'cs',
    hungarian: 'hu', romanian: 'ro', ukrainian: 'uk',
  };
  const code = aliases[q];
  if (code && (voice.lang || '').toLowerCase().startsWith(code)) return true;
  return false;
}

function _renderVoiceList(query) {
  const ul = document.getElementById('voiceList');
  if (!ul) return;
  if (!('speechSynthesis' in window)) {
    ul.innerHTML = '<li aria-disabled="true">Speech synthesis is not available in this browser.</li>';
    return;
  }
  const allVoices = (TTS._voices || []).slice();
  if (!allVoices.length) {
    ul.innerHTML = '<li aria-disabled="true">Loading voices…</li>';
    return;
  }
  const q = (query || '').trim().toLowerCase();
  const voices = allVoices.filter((v) => _voiceMatchesQuery(v, q));
  voices.sort((a, b) => {
    const an = (a.name || '').toLowerCase();
    const bn = (b.name || '').toLowerCase();
    const score = (n) => (_PREMIUM_VOICE_RE.test(n) ? 1 : 0);
    const sd = score(bn) - score(an);
    if (sd !== 0) return sd;
    const la = (a.lang || '').localeCompare(b.lang || '');
    if (la !== 0) return la;
    return an.localeCompare(bn);
  });
  ul.innerHTML = '';
  // Auto entry — always present, ignores the search filter so the user
  // can always fall back to "let the engine pick."
  const mkRow = (title, desc, voiceURI, voiceRef, isActive) => {
    const li = document.createElement('li');
    li.dataset.voice = voiceURI;
    if (isActive) li.setAttribute('aria-selected', 'true');
    const row = document.createElement('div');
    row.className = 'voiceList__row';
    const main = document.createElement('div');
    main.className = 'voiceList__rowMain';
    const t = document.createElement('div');
    t.className = 'sheet__optTitle';
    t.textContent = title;
    const d = document.createElement('div');
    d.className = 'sheet__optDesc';
    d.textContent = desc;
    main.append(t, d);
    row.append(main);
    if (voiceRef) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'voiceList__preview';
      btn.setAttribute('aria-label', 'Preview ' + (voiceRef.name || 'voice'));
      btn.title = 'Preview this voice';
      btn.innerHTML = _VOICE_PREVIEW_ICON;
      // Stash the voice's URI on the button. Single delegated click
      // listener on the <ul> (bound below at first render) reads this
      // and looks the voice up in TTS._voices — saves N inline
      // listeners per re-render.
      btn.dataset.voiceUri = voiceRef.voiceURI || '';
      row.append(btn);
    }
    li.append(row);
    return li;
  };
  const isAutoActive = !TTS._chosenVoiceURI;
  ul.append(mkRow('Auto', 'Pick the best available voice for the message language (recommended).', '', null, isAutoActive));
  if (!voices.length) {
    const empty = document.createElement('li');
    empty.setAttribute('aria-disabled', 'true');
    empty.textContent = q ? `No voices match "${query}". Try "hebrew", "en-US", or a name.` : 'No voices available.';
    ul.append(empty);
  } else {
    for (const v of voices) {
      const isCloud = v.localService === false;
      const title = (v.name || 'Unknown') + (isCloud ? ' · cloud' : '');
      const tags = [];
      if (v.lang) tags.push(v.lang);
      if (_PREMIUM_VOICE_RE.test(v.name || '')) tags.push('high quality');
      if (v.default) tags.push('system default');
      ul.append(mkRow(title, tags.join(' · ') || ' ', v.voiceURI || '', v, v.voiceURI === TTS._chosenVoiceURI));
    }
  }
  // ONE delegated click listener handles both row-tap (select) AND
  // preview-button tap (play sample). Bound on the first render and
  // left in place across re-renders, so re-rendering on every search
  // keystroke doesn't churn N listeners per voice.
  if (!ul._wired) {
    ul.addEventListener('click', (e) => {
      const previewBtn = e.target.closest('.voiceList__preview');
      if (previewBtn) {
        e.stopPropagation();
        const uri = previewBtn.dataset.voiceUri || '';
        const v = (TTS._voices || []).find((x) => (x.voiceURI || '') === uri);
        if (v) _previewVoice(v, previewBtn);
        return;
      }
      const li = e.target.closest('li[data-voice]');
      if (!li) return;
      const uri = li.dataset.voice || '';
      TTS.setVoice(uri || null);
      Array.from(ul.children).forEach((c) => {
        if (c.hasAttribute('data-voice')) {
          if (c === li) c.setAttribute('aria-selected', 'true');
          else c.removeAttribute('aria-selected');
        }
      });
    });
    ul._wired = true;
  }
}

async function _refreshUploadsList() {
  const summary = $('#uploadsSummary');
  const list = $('#uploadsList');
  const clearSelBtn = $('#uploadsClearSelectedBtn');
  if (!summary || !list) return;
  summary.textContent = 'Loading…';
  list.innerHTML = '';
  let data;
  try {
    const r = await fetch('/api/uploads/list', { headers: CSRF_HEADERS });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    summary.textContent = 'Could not load: ' + (e.message || e);
    return;
  }
  const projects = (data && data.projects) || [];
  const totalBytes = (data && data.total_bytes) || 0;
  const totalFiles = (data && data.total_files) || 0;
  summary.textContent = projects.length
    ? `${totalFiles} file${totalFiles === 1 ? '' : 's'} · ${_formatBytesUploads(totalBytes)} total across ${projects.length} project${projects.length === 1 ? '' : 's'}.`
    : 'No uploads on disk.';
  if (clearSelBtn) clearSelBtn.disabled = true;
  for (const p of projects) {
    const li = document.createElement('li');
    li.className = 'uploads__row';
    // Wrap the native checkbox in a label so the entire row (including
    // the styled box visual) is tappable, and so iOS reads it as a
    // single hit-region matching the visible card.
    const label = el('label', { class: 'uploads__rowLabel' });
    const cb = el('input', { type: 'checkbox', class: 'uploads__check uploads__check--row', 'data-project': p.project });
    cb.addEventListener('change', () => {
      _refreshUploadsSelectionState();
    });
    // Custom checkbox visual — a 22px rounded square that fills with a
    // soft coral tint when checked and shows a coral checkmark, so the
    // "selected" state is unambiguous on iOS where the native box is
    // tiny and pale.
    const box = el('span', { class: 'uploads__checkBox', 'aria-hidden': 'true' });
    box.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M2.5 8.5 L6.5 12.5 L13.5 4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const info = el('div', { class: 'uploads__info' },
      el('div', { class: 'uploads__name' }, p.project),
      el('div', { class: 'uploads__meta' },
        `${p.files} file${p.files === 1 ? '' : 's'} · ${_formatBytesUploads(p.bytes)}`,
      ),
    );
    label.append(cb, box, info);
    li.append(label);
    list.append(li);
  }
  _refreshUploadsSelectionState();
}

// Recompute the "Clear selected" enabled state and the master "Select
// all" checkbox's checked / indeterminate state based on which rows are
// currently ticked.
function _refreshUploadsSelectionState() {
  const rows = $$('.uploads__check--row');
  const checked = rows.filter((c) => c.checked);
  const clearSelBtn = $('#uploadsClearSelectedBtn');
  if (clearSelBtn) clearSelBtn.disabled = checked.length === 0;
  const master = $('#uploadsSelectAllChk');
  if (master) {
    if (checked.length === 0) {
      master.checked = false;
      master.indeterminate = false;
    } else if (checked.length === rows.length) {
      master.checked = true;
      master.indeterminate = false;
    } else {
      master.checked = false;
      master.indeterminate = true;
    }
  }
}

async function _clearUploadsProjects(names, label) {
  if (!names.length) return;
  const ok = window.confirm(
    `Delete ${label}?\n\nThis removes the files from disk permanently. Chat history will keep showing the chip name (greyed out) but thumbnails will be gone.`,
  );
  if (!ok) return;
  try {
    const r = await fetch('/api/uploads/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CSRF_HEADERS },
      body: JSON.stringify({ projects: names }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    toast(`Deleted ${data.deleted_files} file${data.deleted_files === 1 ? '' : 's'} (${_formatBytesUploads(data.deleted_bytes)})`, 'info');
    await _refreshUploadsList();
  } catch (e) {
    toast('Clear failed: ' + (e.message || e), 'error');
  }
}

async function _clearUploadsAll() {
  const ok = window.confirm(
    'Delete ALL uploads across every project?\n\nFiles will be permanently removed from disk. This cannot be undone.',
  );
  if (!ok) return;
  try {
    const r = await fetch('/api/uploads/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CSRF_HEADERS },
      body: JSON.stringify({ all: true, confirm: 'DELETE_ALL' }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    toast(`Deleted ${data.deleted_files} file${data.deleted_files === 1 ? '' : 's'} (${_formatBytesUploads(data.deleted_bytes)})`, 'info');
    await _refreshUploadsList();
  } catch (e) {
    toast('Clear all failed: ' + (e.message || e), 'error');
  }
}

// Wire up buttons once at boot — elements are in static HTML.
(function wireUploadsSheet() {
  const selBtn = document.getElementById('uploadsClearSelectedBtn');
  const allBtn = document.getElementById('uploadsClearAllBtn');
  const masterChk = document.getElementById('uploadsSelectAllChk');
  if (selBtn) selBtn.addEventListener('click', () => {
    const checks = $$('.uploads__check--row:checked');
    const names = checks.map((c) => c.dataset.project).filter(Boolean);
    if (!names.length) return;
    _clearUploadsProjects(names, names.length === 1 ? `uploads for "${names[0]}"` : `uploads for ${names.length} projects`);
  });
  if (allBtn) allBtn.addEventListener('click', _clearUploadsAll);
  // Master "Select all" — toggles every row checkbox.
  if (masterChk) {
    masterChk.addEventListener('change', () => {
      const rows = $$('.uploads__check--row');
      for (const r of rows) r.checked = masterChk.checked;
      _refreshUploadsSelectionState();
    });
  }
})();

// Don't cache the shortcuts list across the session. It's five items
// of trivial JSON; re-fetching on each picker open guarantees the client
// always sees the current server response (slug vs old emoji), which
// matters whenever the bridge gets an upgrade that changes the icon
// payload format.
async function _fetchWorkspaceShortcuts() {
  try {
    const r = await fetch('/api/workspace/shortcuts', { headers: CSRF_HEADERS });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    return (data && Array.isArray(data.shortcuts)) ? data.shortcuts : [];
  } catch {
    return [];
  }
}

// Mirror of the old server-emoji → new slug mapping. Lets the client
// keep showing real icons even if it's talking to a bridge that hasn't
// been restarted yet and is still emitting the legacy emoji glyphs.
const _LEGACY_EMOJI_TO_SLUG = {
  '🏠': 'home',
  '🖥️': 'desktop',
  '🖥': 'desktop',
  '📄': 'documents',
  '📂': 'folder',
  '⬇️': 'downloads',
  '⬇': 'downloads',
  '⭐': 'star',
  '📁': 'folder',
};

// Whitelist of generated UI icon slugs the server may reference. Anything
// else falls back to the generic folder icon — guards against an unknown
// slug producing a broken <img>.
const _UI_ICON_SLUGS = new Set(['home', 'desktop', 'documents', 'downloads', 'star', 'folder', 'up', 'refresh']);

function _uiIconImg(slug, alt) {
  // Accept either a slug (new server) or a legacy emoji glyph (server
  // that hasn't been restarted since the icon revamp) — both map to the
  // same generated PNG so the UI never looks "half-upgraded."
  let resolved = slug;
  if (slug && !_UI_ICON_SLUGS.has(slug) && _LEGACY_EMOJI_TO_SLUG[slug]) {
    resolved = _LEGACY_EMOJI_TO_SLUG[slug];
  }
  const safe = _UI_ICON_SLUGS.has(resolved) ? resolved : 'folder';
  return el('img', {
    class: 'uiIcon',
    src: '/static/icons/ui/' + safe + '.png?v=' + CRC_ASSET_VERSION,
    alt: alt || '',
    width: '20',
    height: '20',
  });
}

function _renderWorkspaceShortcuts(shortcuts) {
  const wrap = $('#workspaceShortcuts');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const sc of shortcuts) {
    const btn = el('button', { type: 'button', class: 'workspace__shortcut' });
    const iconWrap = el('span', { class: 'workspace__shortcutIcon', 'aria-hidden': 'true' });
    iconWrap.append(_uiIconImg(sc.icon || 'folder'));
    btn.append(
      iconWrap,
      el('span', { class: 'workspace__shortcutLabel' }, sc.label || ''),
    );
    btn.addEventListener('click', () => _openWorkspaceBrowse(sc.path));
    wrap.append(btn);
  }
}

function _renderWorkspaceCrumbs(path) {
  const wrap = $('#workspaceCrumbs');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!path) return;
  // Split on whichever separator the platform uses. Path is the
  // server-resolved absolute form, so on Windows it'll be
  // `C:\Users\…` and on POSIX `/home/…`. We render each ancestor as
  // a tappable chip.
  const isWindows = /^[A-Za-z]:[\\/]/.test(path);
  const sep = isWindows ? '\\' : '/';
  const parts = path.split(/[\\/]/).filter((s) => s.length > 0);
  // For Windows: the first part is the drive (e.g. "C:"). Tapping it
  // navigates to "C:\". For POSIX: the path starts with `/`, so the
  // first part is the first dir under root and we prepend a "/" chip.
  const segments = [];
  if (isWindows) {
    const drive = parts.shift();
    segments.push({ label: drive, path: drive + sep });
  } else {
    segments.push({ label: '/', path: '/' });
  }
  let acc = segments[0].path;
  for (const part of parts) {
    acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    segments.push({ label: part, path: acc });
  }
  segments.forEach((seg, i) => {
    if (i > 0) {
      wrap.append(el('span', { class: 'workspace__crumbSep', 'aria-hidden': 'true' }, sep));
    }
    const btn = el('button', { type: 'button', class: 'workspace__crumb' }, seg.label);
    btn.addEventListener('click', () => _openWorkspaceBrowse(seg.path));
    wrap.append(btn);
  });
}

async function _refreshWorkspaceInfo() {
  try {
    const r = await fetch('/api/state', { headers: CSRF_HEADERS });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const ws = data.workspace || {};
    const activeEl = $('#workspaceActive');
    const defEl = $('#workspaceDefault');
    if (activeEl) activeEl.textContent = ws.active_root || '—';
    if (defEl) defEl.textContent = ws.default_root || '—';
    // Update menu subtitle too so the user sees the current root
    // without opening the sheet.
    const menuDesc = $('#workspaceMenuDesc');
    if (menuDesc && ws.active_root) {
      menuDesc.textContent = 'Currently: ' + ws.active_root;
    }
    // Refresh the projects list in app state so any project picker
    // sheet that opens next reflects the new root.
    if (Array.isArray(data.projects)) State.projects = data.projects;
  } catch (e) {
    toast('Couldn\'t load workspace info: ' + (e.message || e), 'error');
  }
}

async function _openWorkspaceBrowse(path) {
  const picker = $('#workspacePicker');
  if (!picker) return;
  picker.hidden = false;
  // Lazy-load shortcuts on first open. They don't change per session
  // (Home / Desktop / Downloads / Documents / default root).
  const shortcuts = await _fetchWorkspaceShortcuts();
  _renderWorkspaceShortcuts(shortcuts);
  const listEl = $('#workspacePickerList');
  if (listEl) listEl.innerHTML = '<li class="workspace__pickerLoading">Loading…</li>';
  const url = path
    ? '/api/workspace/browse?path=' + encodeURIComponent(path)
    : '/api/workspace/browse';
  try {
    const r = await fetch(url, { headers: CSRF_HEADERS });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || ('HTTP ' + r.status));
    }
    const data = await r.json();
    _renderWorkspaceBrowse(data);
  } catch (e) {
    if (listEl) {
      listEl.innerHTML = '';
      const li = el('li', { class: 'workspace__pickerLoading' }, e.message || 'Browse failed');
      listEl.append(li);
    }
  }
}

function _renderWorkspaceBrowse(data) {
  _workspaceBrowsePath = data && data.path || null;
  _renderWorkspaceCrumbs(_workspaceBrowsePath);
  const listEl = $('#workspacePickerList');
  if (!listEl) return;
  listEl.innerHTML = '';

  // Always show ".." at the top of the list when we have a parent —
  // single-tap "go up" affordance familiar from every native file
  // picker. Visually distinct from real folders.
  if (data && data.parent) {
    const upLi = el('li', { class: 'workspace__pickerItem workspace__pickerItem--up' });
    const upIcon = el('span', { class: 'workspace__pickerIcon', 'aria-hidden': 'true' });
    upIcon.append(_uiIconImg('up'));
    upLi.append(
      upIcon,
      el('span', { class: 'workspace__pickerName' }, '.. (up one folder)'),
    );
    upLi.addEventListener('click', () => _openWorkspaceBrowse(data.parent));
    listEl.append(upLi);
  }

  const dirs = (data && Array.isArray(data.dirs)) ? data.dirs : [];
  if (!dirs.length && !(data && data.parent)) {
    listEl.append(el('li', { class: 'workspace__pickerEmpty' }, '(no subfolders here)'));
    return;
  }
  if (!dirs.length) {
    listEl.append(el('li', { class: 'workspace__pickerEmpty' }, '(this folder has no subfolders — use it as workspace, or tap .. to go up)'));
    return;
  }
  for (const d of dirs) {
    const li = el('li', { class: 'workspace__pickerItem' });
    const iconWrap = el('span', { class: 'workspace__pickerIcon', 'aria-hidden': 'true' });
    iconWrap.append(_uiIconImg('folder'));
    li.append(
      iconWrap,
      el('span', { class: 'workspace__pickerName' }, d.name),
    );
    li.addEventListener('click', () => _openWorkspaceBrowse(d.path));
    listEl.append(li);
  }
}

async function _setWorkspaceRoot(path) {
  try {
    const r = await fetch('/api/workspace/set_root', {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || ('HTTP ' + r.status));
    }
    const data = await r.json();
    if (Array.isArray(data.projects)) State.projects = data.projects;
    toast('Workspace: ' + (data.active_root || path), 'info');
    await _refreshWorkspaceInfo();
    const picker = $('#workspacePicker');
    if (picker) picker.hidden = true;
  } catch (e) {
    toast('Couldn\'t switch workspace: ' + (e.message || e), 'error');
  }
}

async function _resetWorkspaceRoot() {
  try {
    const r = await fetch('/api/workspace/reset_root', {
      method: 'POST',
      headers: CSRF_HEADERS,
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || ('HTTP ' + r.status));
    }
    const data = await r.json();
    if (Array.isArray(data.projects)) State.projects = data.projects;
    toast('Workspace reset to default', 'info');
    await _refreshWorkspaceInfo();
    const picker = $('#workspacePicker');
    if (picker) picker.hidden = true;
  } catch (e) {
    toast('Couldn\'t reset workspace: ' + (e.message || e), 'error');
  }
}

async function _mkdirInWorkspace() {
  const name = (prompt('New folder name (letters/digits/space/dash/dot only):') || '').trim();
  if (!name) return;
  const parent = _workspaceBrowsePath || null;
  try {
    const r = await fetch('/api/workspace/mkdir', {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(parent ? { name, parent } : { name }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || ('HTTP ' + r.status));
    }
    const data = await r.json();
    if (Array.isArray(data.projects)) State.projects = data.projects;
    toast('Created folder: ' + (data.name || name), 'info');
    await _refreshWorkspaceInfo();
    // Refresh the picker so the new folder shows in the current view
    // immediately. Was previously invisible until manual re-navigation.
    const picker = $('#workspacePicker');
    if (picker && !picker.hidden) {
      await _openWorkspaceBrowse(parent || null);
    }
    // Quality-of-life: offer to open the new folder as a project right
    // now. The user said "I want to immediately start working from
    // there" — without this they'd have to (a) navigate up so the
    // parent becomes the workspace root, (b) open the project picker,
    // (c) tap the new folder. Three taps replaced by one confirm.
    const newPath = data && data.path;
    const newParent = (data && data.parent) || parent;
    if (newPath && newParent) {
      const openIt = window.confirm(
        `Open "${data.name || name}" as the active project now?`
        + '\n\nThis sets the workspace root to its parent folder and starts a fresh chat tab in the new project.',
      );
      if (openIt) {
        // 1. Set workspace root = parent so the new folder becomes a
        //    visible project entry.
        try {
          const wr = await fetch('/api/workspace/set_root', {
            method: 'POST',
            headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: newParent }),
          });
          if (wr.ok) {
            const wd = await wr.json();
            if (Array.isArray(wd.projects)) State.projects = wd.projects;
          }
        } catch {}
        // 2. Close both sheets and spawn a tab pointing at the new
        //    project. createTab handles all the rest of the wiring.
        closeSheet('workspaceSheet');
        try { createTab(data.name || name); } catch (e) { console.warn('createTab failed', e); }
        await _refreshWorkspaceInfo();
      }
    }
  } catch (e) {
    toast('Couldn\'t create folder: ' + (e.message || e), 'error');
  }
}

// Wire workspace sheet buttons. Done at boot since the elements are
// in the static HTML.
(function wireWorkspaceSheet() {
  const browseBtn = $('#workspaceBrowseBtn');
  if (browseBtn) browseBtn.addEventListener('click', () => _openWorkspaceBrowse(null));
  const mkdirBtn = $('#workspaceMkdirBtn');
  if (mkdirBtn) mkdirBtn.addEventListener('click', _mkdirInWorkspace);
  const resetBtn = $('#workspaceResetBtn');
  if (resetBtn) resetBtn.addEventListener('click', _resetWorkspaceRoot);
  // Up navigation is now via the breadcrumb chips + the explicit ".."
  // entry at the top of the folder list (see _renderWorkspaceBrowse).
  // No standalone Up button — both feel more native.
  const closeBtn = $('#workspacePickerClose');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    const picker = $('#workspacePicker');
    if (picker) picker.hidden = true;
  });
  const useBtn = $('#workspaceUseHereBtn');
  if (useBtn) useBtn.addEventListener('click', () => {
    if (_workspaceBrowsePath) _setWorkspaceRoot(_workspaceBrowsePath);
  });
})();

async function openHistorySheet(opts) {
  const list = $('#historyList');
  const empty = $('#historyEmpty');
  if (!list) return;
  // Pick which project's history to show. If there's an active tab with a
  // project, use that; otherwise prompt the user to pick one.
  const tab = getActiveTab();
  const project = (tab && tab.project) || null;
  list.innerHTML = '';
  if (!project) {
    list.append(el('li', { class: 'sheet__optDesc' },
      'Pick a project first (tap the name in the topbar).'));
    openSheet('historySheet', opts);
    return;
  }
  list.append(el('li', { class: 'sheet__optDesc' }, `Loading sessions for ${project}…`));
  openSheet('historySheet', opts);
  let data;
  try {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(project)}`, {
      headers: CSRF_HEADERS,
    });
    if (!resp.ok) {
      list.innerHTML = '';
      list.append(el('li', { class: 'sheet__optDesc' },
        `Couldn't load history: HTTP ${resp.status}`));
      return;
    }
    data = await resp.json();
  } catch (e) {
    list.innerHTML = '';
    list.append(el('li', { class: 'sheet__optDesc' },
      `Couldn't load history: ${e.message || 'network error'}`));
    return;
  }
  const sessions = (data && data.sessions) || [];
  list.innerHTML = '';
  if (!sessions.length) {
    list.append(el('li', { class: 'sheet__optDesc' },
      `No past sessions found for ${project}. (Each conversation is saved by Claude Code under ~/.claude/projects/.)`));
    return;
  }
  for (const s of sessions) {
    const title = el('div', { class: 'sheet__optTitle' }, s.preview || '(no message)');
    const desc = el('div', { class: 'sheet__optDesc' },
      `${_fmtAgo(s.modified_at)} · ${s.session_id.slice(0, 8)}`);
    const li = el('li');
    li.append(title, desc);
    li.addEventListener('click', () => {
      closeSheet('historySheet');
      // Dedupe: re-tapping a row that's already open in a tab should
      // focus it, not double-open. See `findTabBySessionId` for the
      // matching rules (covers both fully-captured sessions and tabs
      // that were created from a history row but haven't run yet).
      const existing = findTabBySessionId(s.session_id);
      if (existing) {
        switchTab(existing.id);
        toast('Switched to open tab for this session', 'info');
        return;
      }
      // Open the past session as a fresh tab with --resume. Pre-seed the
      // tab title from the session's first user message so the strip
      // entry is meaningful before the user has typed anything new.
      const preTitle = (s.preview || '').slice(0, 32).replace(/\s+/g, ' ').trim() || null;
      createTab(project, { sessionId: s.session_id, title: preTitle });
      toast('Resumed past conversation — type a message to continue.', 'info');
    });
    list.append(li);
  }
}

// ─── Composer / input ─────────────────────────────────────────────────

const input = $('#input');
const form = $('#composerForm');
const sendBtn = $('#sendBtn');

// Toggle the send button's icon + behavior based on (a) whether the
// active tab has a claude run in flight and (b) whether the composer
// has text. Three modes:
//   normal → form submit (sends prompt)
//   stop   → stop the active tab (cancels the run) — running + empty input
//   queue  → enqueue the typed message (drained after run_finished) — running + text
// The mode flips live as the user types/clears the textarea — autosizeInput
// re-calls this so the icon always matches what tapping will do.
function updateSendButton() {
  const tab = getActiveTab();
  const running = !!(tab && tab.running);
  const hasText = !!(input && input.value.trim());
  const hasAttachments = !!(tab && tab._attachments && tab._attachments.length);
  sendBtn.classList.remove('composer__send--stop', 'composer__send--queue');
  // While the mic is recording or its transcript is still in flight,
  // the composer might be missing trailing words the user said. Sending
  // mid-transcription would send a half-finished prompt — disable the
  // button outright until Mic._teardown sets mode back to null.
  // Reported by the user: "I'm able to send a message midway, and
  // that's something I don't want."
  const micBusy = typeof Mic !== 'undefined' && !!Mic.mode;
  if (micBusy) {
    sendBtn.classList.add('composer__send--disabled');
    sendBtn.disabled = true;
    const label = Mic.mode === 'recording' ? 'Recording — wait to send' : 'Transcribing — wait to send';
    sendBtn.setAttribute('aria-label', label);
    sendBtn.title = label;
    sendBtn.type = 'button';
    return;
  }
  sendBtn.classList.remove('composer__send--disabled');
  sendBtn.disabled = false;
  sendBtn.title = '';
  if (running && (hasText || hasAttachments)) {
    sendBtn.classList.add('composer__send--queue');
    sendBtn.setAttribute('aria-label', 'Queue message (sends when current run finishes)');
    sendBtn.type = 'button';
  } else if (running) {
    sendBtn.classList.add('composer__send--stop');
    sendBtn.setAttribute('aria-label', 'Stop run');
    sendBtn.type = 'button';
  } else {
    sendBtn.setAttribute('aria-label', 'Send');
    // ALWAYS `type="button"` — see the keyboard-fix comment below for why
    // we route the action through pointerup ourselves instead of relying
    // on form submission from a type="submit" button. Hardware-keyboard
    // Enter still submits via the textarea's keydown handler + the form
    // submit listener, both of which are unaffected.
    sendBtn.type = 'button';
  }
}
// iOS keyboard fix v2 (2026-05-19 — supersedes the earlier pointerdown-only
// attempt). The bug: while the textarea has focus and the keyboard is up,
// tapping Send used to do nothing — the first tap dismissed the keyboard,
// only the second tap actually sent. The earlier attempt added a
// `pointerdown` preventDefault to keep focus on the textarea so the
// keyboard wouldn't dismiss. That kept focus, but on iOS PWA standalone
// preventDefault on pointerdown can ALSO suppress the synthesized `click`
// event entirely — so the keyboard stayed up but nothing else happened.
//
// New approach:
//   1. Fire the action on `pointerup` directly so we never depend on a
//      synthesized click that iOS might drop.
//   2. Still preventDefault on pointerdown when the input is focused —
//      that keeps the keyboard up for the action.
//   3. `_sendTapHandled` flag dedupes against the synthetic click that
//      may or may not arrive after pointerup, depending on iOS mood.
//   4. Button is `type="button"` so click-on-submit can't double-fire
//      the form's submit handler either.
let _sendTapHandled = false;
let _sendTapResetTimer = 0;
function _runSendAction() {
  // `/ask <question>` MUST bypass the queue gate. updateSendButton flips
  // the send button to `composer__send--queue` whenever `running &&
  // hasText`, and the queue branch below short-circuits ALL routing —
  // so without this pre-check a /ask typed during a live run would be
  // queued (and later drained as a regular prompt by
  // _drainNextQueuedPrompt) instead of spawning the parallel adhoc
  // claude. Reported 2026-05-21: "/ask while running just queues."
  // Fix lives here rather than below because the queue gate has to
  // see /ask BEFORE deciding whether to queue.
  if (sendBtn.classList.contains('composer__send--queue') &&
      input && /^\/ask\s+/i.test(input.value.trim())) {
    sendPrompt();
    return;
  }
  if (sendBtn.classList.contains('composer__send--queue')) {
    _enqueueCurrentPrompt();
    return;
  }
  if (sendBtn.classList.contains('composer__send--stop')) {
    const tab = getActiveTab();
    if (!tab) return;
    if (!tab._stoppedRuns) tab._stoppedRuns = new Set();
    if (tab._activeRuns && tab._activeRuns.size) {
      const runIds = Array.from(tab._activeRuns.keys());
      for (const runId of runIds) {
        tab._stoppedRuns.add(String(runId));
        Chat.finishRun(tab.project, runId, 'stopped', '', tab.id);
      }
    }
    tab.running = false;
    tab._lastFinishedAt = Date.now();
    if (tab._queue && tab._queue.length) {
      _clearQueuedBubbles(tab);
      tab._queue = [];
      try { _persistTabs(); } catch {}
    }
    renderTabs();
    updateSendButton();
    // Reap the ghost spinner — without this, the kawaii mascot + status
    // word kept cycling forever after the user tapped Stop (reported
    // 2026-05-20: composer flipped to send mode but the spinner stayed).
    try { Chat.ensureRunningSpinner(tab.id); } catch {}
    try { _markLatestUserBubbleInterrupted(tab.id); } catch {}
    WS.send({ type: 'stop', tab_id: tab.id, project: tab.project });
    return;
  }
  // Idle / send mode — same path as the form submit handler so the two
  // surfaces stay in lockstep.
  if (typeof Mic !== 'undefined' && Mic.mode) {
    try { toast(Mic.mode === 'recording' ? 'Recording in progress' : 'Waiting for transcription to finish', 'warn'); } catch {}
    return;
  }
  const tab = getActiveTab();
  const running = !!(tab && tab.running);
  const hasText = !!(input && input.value.trim());
  const hasAttachments = !!(tab && tab._attachments && tab._attachments.length);
  // `/ask <question>` bypasses the per-tab session lock by design —
  // it spawns a parallel adhoc claude run with --no-session-persistence,
  // so the user can ask side-questions while a long main run is in
  // flight. Don't queue it; route straight through sendPrompt so its
  // existing `/ask` handler dispatches the `ask` command frame.
  if (running && hasText && /^\/ask\s+/i.test(input.value.trim())) {
    sendPrompt();
    return;
  }
  if (running && (hasText || hasAttachments)) { _enqueueCurrentPrompt(); return; }
  if (running) return;
  sendPrompt();
}
sendBtn.addEventListener('pointerdown', (e) => {
  // Clear any stale dedupe flag from a previous interaction — a slow
  // synthesized click after a long iOS UI stall could otherwise fire
  // _runSendAction twice. Re-arming on every fresh pointerdown is safe.
  if (_sendTapResetTimer) { clearTimeout(_sendTapResetTimer); _sendTapResetTimer = 0; }
  _sendTapHandled = false;
  // Keep focus on the textarea so iOS doesn't dismiss the keyboard out
  // from under the user mid-tap. Only matters when the input is currently
  // focused — desktop hover/click is untouched.
  if (document.activeElement === input) {
    e.preventDefault();
  }
});
sendBtn.addEventListener('pointerup', (e) => {
  // Some pointer types (touch on iOS PWA standalone) drop the synthesized
  // click after pointerdown.preventDefault. Run the action here so the
  // first tap always works. Set the dedupe flag so the click handler
  // (if it does fire) doesn't double-trigger.
  if (sendBtn.disabled) return;
  e.preventDefault();
  // Pointer Events spec: pointerup fires on the element that captured
  // pointerdown EVEN IF the finger dragged off. Native <button> click
  // suppresses in that case — match that UX so a "press send, slide off
  // to cancel" gesture works the way users expect. elementFromPoint
  // returns null when coords are outside the viewport — treat that as
  // off-button (cancel).
  const at = document.elementFromPoint(e.clientX, e.clientY);
  if (!at || !sendBtn.contains(at)) return;
  if (_sendTapResetTimer) clearTimeout(_sendTapResetTimer);
  _sendTapHandled = true;
  _sendTapResetTimer = setTimeout(() => { _sendTapHandled = false; }, 500);
  _runSendAction();
});
sendBtn.addEventListener('click', (e) => {
  // Fallback for environments where pointerup never fires (older browsers,
  // keyboard-activated buttons via Enter/Space). Skip if pointerup just
  // handled it.
  if (_sendTapHandled) { _sendTapHandled = false; e.preventDefault(); return; }
  e.preventDefault();
  if (sendBtn.disabled) return;
  _runSendAction();
});

// Enqueue the composer's current contents (text + attachments) for
// the active tab. Renders a greyed-out "queued" bubble so the user
// sees the message landed, clears the composer so they can type the
// next one, and stashes the payload on tab._queue for the
// run_finished handler to drain.
function _enqueueCurrentPrompt() {
  const tab = getActiveTab();
  if (!tab) return;
  const rawText = input ? input.value : '';
  const text = _normalizeSmartPunctuation(rawText.trim());
  const attachments = (tab._attachments || []).slice();
  if (!text && !attachments.length) return;
  if (!tab.project) {
    toast('Pick a project first', 'warn');
    return;
  }
  if (!tab._queue) tab._queue = [];
  const entry = { text, attachments };
  tab._queue.push(entry);
  // Survive close + reopen — without this, a queued prompt vanishes
  // the moment the user closes the PWA before the in-flight run
  // finishes. _persistTabs serialises tab._queue as part of the
  // snapshot; the matching restore path rehydrates the bubbles and
  // the post-hello drain trigger fires them.
  try { _persistTabs(); } catch {}
  // Render a placeholder bubble so the user can see what's queued and
  // in what order. Distinct from a live user bubble — dimmed + a small
  // "Queued" badge — so they don't think it's already been sent.
  const previewAttachments = attachments.map((a) => ({
    name: a.name, kind: a.kind, thumbUrl: a.thumbUrl,
    path: a.path, mime: a.mime, size: a.size, dims: a.dims,
    url: a.url || null,
  }));
  const node = Chat.pushQueued(text, previewAttachments, tab.id);
  entry._node = node;
  // Clear the composer so the user can stack the next thought.
  input.value = '';
  tab.draft = '';
  try { autosizeInput(); } catch {}
  clearAttachments();
  updateSendButton();
}

// Best-effort removal of any queued-bubble DOM nodes for the tab.
// Called when the user hits Stop — the queue is discarded along with
// the in-flight run.
function _clearQueuedBubbles(tab) {
  if (!tab || !tab._queue) return;
  for (const entry of tab._queue) {
    try { entry._node?.remove(); } catch {}
  }
}

// Long-press → Edit on a queued bubble. Pulls the queued text back into
// the composer, restores any attachments, removes the entry from
// tab._queue (so it won't auto-fire when the current run finishes),
// removes the dimmed bubble from the chat, and persists the new state.
// The user can then re-edit and either re-queue or send fresh.
function _editQueuedEntry(tabId, node) {
  const tab = tabId ? getTab(tabId) : getActiveTab();
  if (!tab || !tab._queue || !node) return;
  const idx = tab._queue.findIndex((e) => e && e._node === node);
  if (idx < 0) return;
  const [entry] = tab._queue.splice(idx, 1);
  if (input) {
    // If the composer already has typed text, prepend the queued text
    // with a newline gap so we don't silently destroy the draft.
    const existing = input.value || '';
    input.value = existing
      ? `${entry.text || ''}\n\n${existing}`
      : (entry.text || '');
    tab.draft = input.value;
    try { autosizeInput(); } catch {}
    try { input.focus(); } catch {}
  }
  // Restore attachments to the composer chip row. If there are already
  // attachments on the composer, merge — don't blow them away.
  if (entry.attachments && entry.attachments.length) {
    tab._attachments = (tab._attachments || []).concat(entry.attachments);
    try { renderAttachments(); } catch {}
  }
  try { node.remove(); } catch {}
  try { _persistTabs(); } catch {}
  try { updateSendButton(); } catch {}
}

// Long-press → Delete on a queued bubble. Drops the entry from the
// queue and removes the bubble. No chat-history concern because the
// message was never actually shipped to claude.
function _deleteQueuedEntry(tabId, node) {
  const tab = tabId ? getTab(tabId) : getActiveTab();
  if (!tab || !tab._queue || !node) return;
  const idx = tab._queue.findIndex((e) => e && e._node === node);
  if (idx >= 0) tab._queue.splice(idx, 1);
  try { node.remove(); } catch {}
  try { _persistTabs(); } catch {}
  try { updateSendButton(); } catch {}
}

// Drain one queued prompt for `tab` and ship it. Called from the
// run_finished handler once `tab.running` has flipped back to false
// and the wire is idle for this tab. Only the head of the queue is
// fired — the NEXT run_finished cycle picks up the next one, so
// each queued prompt becomes its own discrete turn in the chat
// instead of being concatenated into a mega-prompt.
function _drainNextQueuedPrompt(tab) {
  if (!tab || !tab._queue || !tab._queue.length) return false;
  // Don't drain if the tab somehow re-entered running (e.g. a stray
  // /ask side-channel) — wait for that to settle.
  if (tab.running) return false;
  // Snapshot the active tab's typed draft + any attachments the user
  // added while the run was in flight, so we can restore them after
  // shipping the queued message. Without this, drain blindly clobbers
  // whatever the user has just typed into the composer with the
  // queued text, which has been the headline queue bug.
  const draftBefore = input ? input.value : '';
  const attachmentsBefore = (tab._attachments || []).slice();
  const next = tab._queue.shift();
  // Keep the persisted snapshot in sync so a close-during-drain
  // doesn't re-fire an already-drained prompt.
  try { _persistTabs(); } catch {}
  // sendPrompt reads attachments from tab._attachments unconditionally,
  // so we swap them in before the call and restore the user's draft
  // attachments in the ok branch below. opts.text overrides the
  // composer read entirely, so input.value is untouched here.
  tab._attachments = next.attachments || [];
  try {
    // Pass the owning tab explicitly so sendPrompt routes the WS
    // frame + the new user bubble to THIS tab, not whichever tab
    // happens to be foregrounded right now. Without `opts.tab`,
    // a queued message in tab A would leak into tab B if tab B
    // was active at run_finished time. Reported 2026-05-21.
    const ok = sendPrompt({ text: next.text || '', tab });
    if (ok) {
      // sendPrompt only clears the composer when reading from
      // input.value (opts.text==null). Drain passes opts.text
      // explicitly, so the composer was never touched — no restore
      // needed. Restore tab A's attachments (we swapped them on the
      // line above), but ONLY touch input.value / tab.draft when
      // tab A is currently active: otherwise draftBefore is the
      // OTHER tab's typing, and writing it into tab.draft would
      // poison tab A's draft so that next time the user switched
      // into tab A they'd see the other tab's text in the composer
      // (reported 2026-05-21 as "composer leaks across tabs" from
      // the queue-drain path).
      tab._attachments = attachmentsBefore;
      if (tab === getActiveTab()) {
        if (input) input.value = draftBefore;
        tab.draft = draftBefore;
        try { autosizeInput(); } catch {}
        try { renderAttachments(); } catch {}
      }
      // Drop the queued bubble for the message we just shipped — the
      // new user bubble Chat.pushUser appended is its replacement.
      try { next._node?.remove(); } catch {}
      // Chat.pushUser appended the new user bubble at the END of the
      // pane, but any remaining queued bubbles for this tab are still
      // sitting where they were originally pushed — BEFORE the new
      // bubble. Move them back to the end so the visual order matches
      // the data order (sent → assistant thinking → queued). Without
      // this, the user sees their queued msgs above the message
      // that just shipped, which reads as a regression.
      const pane = tab._chatpane;
      if (pane) {
        for (const remaining of tab._queue) {
          const node = remaining && remaining._node;
          if (node && node.isConnected) pane.appendChild(node);
        }
      }
      try { updateSendButton(); } catch {}
      try { Chat.scrollToBottom(true); } catch {}
    } else {
      // Send failed — push the entry back so the user doesn't lose it.
      // Restore the pre-drain composer ONLY if tab A is the active
      // tab; otherwise draftBefore is the active tab's text, and
      // writing it into tab A's draft would leak (see same guard
      // above in the ok branch).
      tab._queue.unshift(next);
      tab._attachments = attachmentsBefore;
      if (tab === getActiveTab()) {
        if (input) input.value = draftBefore;
        tab.draft = draftBefore;
        try { autosizeInput(); } catch {}
        try { renderAttachments(); } catch {}
      }
      try { _persistTabs(); } catch {}
    }
    return !!ok;
  } catch (e) {
    try { console.error('[queue drain]', e); } catch {}
    // Same recovery as the !ok branch — push the entry back and
    // restore the user's typing state if and only if tab A is the
    // active tab (see same guard above).
    tab._queue.unshift(next);
    tab._attachments = attachmentsBefore;
    if (tab === getActiveTab()) {
      if (input) input.value = draftBefore;
      tab.draft = draftBefore;
      try { autosizeInput(); } catch {}
      try { renderAttachments(); } catch {}
    }
    return false;
  }
}

// Walk back the chatpane and tag the most-recent .msg--user as the
// "interrupted" prompt. Adds a small grayish chip the CSS renders next
// to the bubble. Idempotent — calling twice doesn't duplicate the chip.
function _markLatestUserBubbleInterrupted(tabId) {
  const tab = tabId ? getTab(tabId) : getActiveTab();
  if (!tab || !tab._chatpane) return;
  const userMsgs = tab._chatpane.querySelectorAll('.msg--user');
  if (!userMsgs.length) return;
  const last = userMsgs[userMsgs.length - 1];
  last.classList.add('msg--interrupted');
  if (!last.querySelector('.msg__interruptedTag')) {
    const bubble = last.querySelector('.msg__bubble') || last;
    const tag = el('div', { class: 'msg__interruptedTag', 'aria-label': 'Interrupted' }, 'Interrupted');
    bubble.append(tag);
  }
}

// Flag the most-recent user bubble as queued (server was busy when the
// prompt was sent, so it didn't actually start a run). The bubble keeps
// its content but visually dims with a "Queued" tag so the user knows
// the message is waiting for the current run to finish.
function _markLatestUserBubbleQueued(tabId) {
  const tab = tabId ? getTab(tabId) : getActiveTab();
  if (!tab || !tab._chatpane) return;
  const userMsgs = tab._chatpane.querySelectorAll('.msg--user');
  if (!userMsgs.length) return;
  const last = userMsgs[userMsgs.length - 1];
  last.classList.add('msg--queued');
  if (!last.querySelector('.msg__queuedTag')) {
    const bubble = last.querySelector('.msg__bubble') || last;
    const tag = el('div', { class: 'msg__queuedTag', 'aria-label': 'Queued for next run' }, 'Queued');
    bubble.append(tag);
  }
}

// Hide autocomplete on input blur (with a tiny delay so a tap on an
// autocomplete row registers first).
input.addEventListener('blur', () => setTimeout(() => { autocomplete.hidden = true; }, 150));

// Coarse-grained "is this a touch / mobile device?" check. Used to keep
// the on-screen-keyboard's Enter key from sending — on iOS / Android
// Enter should insert a newline (matching every other chat app); the
// only way to submit on mobile is the orange Send button. On desktop,
// Enter still submits and Shift+Enter newlines.
// (Declared earlier at file top so Chat methods can reference it.)

function autosizeInput() {
  // Before resizing, note whether the chat is already pinned to the
  // newest message. If yes, we'll snap back to the bottom AFTER the
  // textarea grows so the latest message doesn't disappear behind the
  // taller composer. Threshold matches the rest of the auto-follow
  // behavior in Chat.scrollToBottom.
  const chat = document.getElementById('chat');
  const wasNearBottom = chat ? (chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 80) : false;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
  if (wasNearBottom && chat) {
    // rAF lets the layout settle (the chat container shrinks to make
    // room for the bigger composer) before we re-measure scrollHeight.
    requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
  }
}
input.addEventListener('input', () => {
  autosizeInput();
  updateAutocomplete();
  // Send-button mode depends on whether the composer has text (during
  // a live run, text flips the icon from "stop" to "queue"). Re-run
  // every keystroke so the icon tracks the textarea state live.
  updateSendButton();
  // Keep the per-tab draft in sync so we don't lose typing if the user
  // backgrounds the app and iOS reloads it later. Suppressed during a
  // tab switch so a late iOS-Safari `input` event doesn't smear the
  // outgoing tab's text into the incoming tab's draft.
  if (_switchInFlight) return;
  const tab = getActiveTab();
  if (tab) tab.draft = input.value || '';
});
// Belt-and-braces for iOS: a few users reported the slash popup never
// appearing when they typed `/`. The root cause is that iOS Safari can
// route certain characters through compositionend / autocorrect instead
// of firing a normal `input` event, so the `input` listener above never
// runs. Mirror the autocomplete trigger on `keyup`, `compositionend`,
// AND on caret-position changes (click / select) so it pops the moment
// the cursor lands inside a `/word` token mid-message — not just when
// the text starts with `/`.
input.addEventListener('keyup', () => { try { updateAutocomplete(); } catch {} });
input.addEventListener('compositionend', () => { try { updateAutocomplete(); } catch {} });
input.addEventListener('click', () => { try { updateAutocomplete(); } catch {} });
input.addEventListener('select', () => { try { updateAutocomplete(); } catch {} });

// ─── Viewport / keyboard handling ────────────────────────────────────
//
// The actual sync runs near the top of this file (`syncVisualViewport`):
// body's height and top are driven by `window.visualViewport` so the
// layout matches the visible region above the keyboard. dvh alone was
// not enough — dvh shrinks for browser UI but NOT for the iOS soft
// keyboard, so the composer ended up behind the keyboard and iOS auto-
// scrolled the page, pushing the topbar off-screen. A prior attempt
// failed because it also translated inner elements, which double-shifted
// against iOS's own scroll; the current pass keeps the work on <body>
// only and leaves the inner grid alone.

// On input focus, if the user was already near the bottom of chat, keep
// them there. If they were scrolled up reading older messages, don't yank
// — their position stays put (scrollToBottom() without force respects that).
input.addEventListener('focus', () => {
  requestAnimationFrame(() => Chat.scrollToBottom());
  // If the input already starts with `/` (e.g. user restored a draft,
  // or the previous blur fired the 150ms hide but they're back), re-
  // arm the autocomplete on focus.
  try { updateAutocomplete(); } catch {}
});

// Jump-to-bottom floating button. The chat's auto-follow behavior is
// "stick to bottom only when you're already there" (scrollToBottom()
// without `force`). When the user scrolls UP to read history, new
// streamed content piles up below and they need a way to fast-track
// back to the latest message — this button is that affordance. Shown
// when scrollTop is more than ~120px above the bottom; tapping it
// force-scrolls and the sticky behavior resumes on its own because
// the user is now near the bottom again.
// "New messages below" transient pill, used when claude streams new
// content while the user is scrolled up reading history. Set by
// Chat.scrollToBottom when its near-bottom check fails. Cleared when
// the user scrolls back near the bottom OR taps the pill.
function _showNewMessagesPill() {
  const pill = document.getElementById('newMessagesPill');
  if (!pill) return;
  pill.hidden = false;
}
function _hideNewMessagesPill() {
  const pill = document.getElementById('newMessagesPill');
  if (!pill) return;
  pill.hidden = true;
}

(function wireJumpToBottom() {
  const chat = document.getElementById('chat');
  const btn = document.getElementById('jumpBottomBtn');
  const pill = document.getElementById('newMessagesPill');
  if (!chat || !btn) return;

  // Update visibility + the follow flag from REAL scroll events only.
  // Earlier we also wired a MutationObserver here, but content-append
  // events fire BEFORE the auto-scroll rAF runs, so big chunks (300+
  // px markdown tables / code blocks / tool cards) momentarily made
  // distance > threshold and flashed the buttons on screen even
  // though the user never scrolled away from the bottom. Now the
  // flag and UI track the user's intent (where they actually
  // scrolled), and Chat.scrollToBottom takes care of pinning during
  // streaming.
  // Auto-follow ONLY when the user is essentially at the bottom. A
  // tighter 80px threshold matches the user's intent ("don't yank me
  // back down when I'm in the middle of reading"). The earlier 400px
  // value was too forgiving — anytime the user was reading the LAST
  // 1-2 paragraphs of a Claude response, they were technically still
  // "following" and finishRun's auto-scroll would yank them off their
  // reading position. 80px ≈ one bubble's worth, so the user has to
  // be visually pinned at the end of the chat for follow-mode to
  // stay engaged. Reported 2026-05-19.
  const FOLLOW_THRESHOLD_PX = 80;
  const JUMP_BTN_THRESHOLD_PX = 200;
  // While the sticky window is open we don't let scroll events flip
  // _isFollowingBottom off — see the jumpToBottom branch below.
  const onScroll = () => {
    const distance = chat.scrollHeight - (chat.scrollTop + chat.clientHeight);
    const sticky = _stickToBottomUntil && Date.now() < _stickToBottomUntil;
    if (sticky) {
      _isFollowingBottom = true;
      btn.hidden = true;
      _hideNewMessagesPill();
      return;
    }
    _isFollowingBottom = distance < FOLLOW_THRESHOLD_PX;
    btn.hidden = distance < JUMP_BTN_THRESHOLD_PX;
    if (distance < JUMP_BTN_THRESHOLD_PX) _hideNewMessagesPill();
  };
  chat.addEventListener('scroll', onScroll, { passive: true });

  const jumpToBottom = () => {
    chat.scrollTop = chat.scrollHeight;
    btn.hidden = true;
    _hideNewMessagesPill();
    _isFollowingBottom = true;
    // Hold the auto-follow open for the next ~6 seconds even if a
    // big delta temporarily pushes the user above the threshold.
    // Cleared early if the user genuinely scrolls up (see below).
    _stickToBottomUntil = Date.now() + 6000;
  };
  btn.addEventListener('click', jumpToBottom);
  if (pill) pill.addEventListener('click', jumpToBottom);

  // Any deliberate touch-drag (finger moved DOWN, content revealed
  // upward = user wants to read history) IMMEDIATELY drops both the
  // sticky window AND the follow flag, regardless of current scroll
  // distance. Without this, a user reading the last paragraph of a
  // Claude response while it was streaming could still be "following"
  // (within 80px of bottom) and the next delta would yank them to
  // the bottom mid-read. Now an active swipe is unambiguous: the
  // user is reading, suspend auto-follow until they choose to come
  // back via the jump-to-bottom button.
  let _touchStartY = 0;
  chat.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches[0]) _touchStartY = e.touches[0].clientY;
  }, { passive: true });
  chat.addEventListener('touchmove', (e) => {
    if (!e.touches || !e.touches[0]) return;
    const dy = e.touches[0].clientY - _touchStartY;
    if (dy > 30) {
      _stickToBottomUntil = 0;
      _isFollowingBottom = false;
    }
  }, { passive: true });
})();

// Submit on Enter (desktop), newline on Shift+Enter. On MOBILE,
// Enter always inserts a newline — the on-screen keyboard's return
// key shouldn't double as Send (matches every native messaging app);
// the orange Send button is the only way to submit. See IS_MOBILE
// detection above.
input.addEventListener('keydown', (e) => {
  // If the autocomplete is open, ↑/↓ navigate, Enter picks, Esc closes.
  if (!autocomplete.hidden) {
    const items = $$('#slashAutocomplete .autocomplete__item');
    if (!items.length) return;
    const activeIdx = items.findIndex((it) => it.hasAttribute('data-active'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (activeIdx + 1) % items.length;
      items.forEach((it, i) => it.toggleAttribute('data-active', i === next));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (activeIdx - 1 + items.length) % items.length;
      items.forEach((it, i) => it.toggleAttribute('data-active', i === next));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const pick = items[activeIdx >= 0 ? activeIdx : 0];
      _applyAutocompletePick(pick.dataset.cmd);
      return;
    }
    if (e.key === 'Escape') {
      autocomplete.hidden = true;
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    // On mobile, fall through to the textarea's default behavior so
    // a newline is inserted. Send is only via the orange button.
    if (IS_MOBILE) return;
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  // Same three-mode dispatch as the send-button click handler. Without
  // this, a form submit (Enter on hardware keyboard, or any path that
  // triggers form submission while the button has not yet flipped to
  // type="button") would bypass queue mode entirely and try to send a
  // new prompt during a run — the bridge's session lock then rejects
  // it as "session busy" and the typed text was discarded. Reported
  // by user 2026-05-17.
  // Block submission while mic is still recording / transcribing so a
  // hardware Enter key can't bypass the visually-disabled send button.
  if (typeof Mic !== 'undefined' && Mic.mode) {
    try { toast(Mic.mode === 'recording' ? 'Recording in progress' : 'Waiting for transcription to finish', 'warn'); } catch {}
    return;
  }
  const tab = getActiveTab();
  const running = !!(tab && tab.running);
  const hasText = !!(input && input.value.trim());
  const hasAttachments = !!(tab && tab._attachments && tab._attachments.length);
  // `/ask <question>` bypasses the per-tab session lock — see the
  // matching short-circuit in _runSendAction for the rationale.
  if (running && hasText && /^\/ask\s+/i.test(input.value.trim())) {
    sendPrompt();
    return;
  }
  if (running && (hasText || hasAttachments)) {
    _enqueueCurrentPrompt();
    return;
  }
  if (running) {
    // Submit-while-running-with-empty-composer: do nothing. The button
    // is in stop-mode visually; a stop would have come through the
    // click handler, not a form submit.
    return;
  }
  sendPrompt();
});

// Normalize iOS smart-punctuation back to ASCII before sending. iOS
// keyboards (with "Smart Punctuation" on, the default) auto-replace
// straight quotes/dashes with typographic equivalents — U+2019 for
// the apostrophe, U+201C/D for double quotes, U+2026 for ellipsis.
// Those bytes are valid UTF-8, but when downstream tools (PowerShell
// console, log readers using cp1252) print them, they mojibake into
// "Iג€™m" etc. Replacing on the way out keeps the wire format ASCII
// and avoids the confusion.
function _normalizeSmartPunctuation(s) {
  if (!s) return s;
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, '...');
}

function sendPrompt(opts) {
  // opts.text         — explicit text (regenerate path). When set, the
  //                     compose textarea is NOT cleared on send and NOT
  //                     read from. Default: read input.value.
  // opts.skipUserBubble — when true, skip Chat.pushUser. Used by
  //                     regenerate, which removes the prior assistant
  //                     bubble and re-streams a new one in place — the
  //                     existing user bubble is reused.
  // opts.tab          — explicit destination tab. Used by the queue
  //                     drain so a message queued in tab A doesn't get
  //                     misrouted to whatever tab happens to be active
  //                     when its run finishes. Falls back to the active
  //                     tab when omitted (the normal compose path).
  opts = opts || {};
  const rawText = opts.text != null ? opts.text : input.value;
  const text = _normalizeSmartPunctuation(rawText.trim());
  const tab = opts.tab || getActiveTab();
  const attachments = tab ? (tab._attachments || []) : [];
  if (!text && !attachments.length) return;
  // If the message is JUST a slash command we recognize, route it through
  // executeSlash so it goes to the right handler (bridge / claude-local /
  // claude forward). Without this, typing `/help` and hitting send would
  // round-trip to claude and get "/help isn't available in this environment."
  //
  // Skip when opts.text is set: regenerate re-sends a prior user turn,
  // and most prior turns are plain prompts. If the original turn WAS a
  // recognised slash command, the user wants the bridge-side response
  // anyway, so we fall through and route via WS as normal — there is
  // nothing for executeSlash to "regenerate" (a fresh /help would just
  // re-print static text). Also: clearing input.value here would clobber
  // the user's draft, which the regenerate path is explicitly trying to
  // preserve.
  if (opts.text == null && text.startsWith('/') && !text.includes(' ')) {
    if (ALL_SLASH_COMMANDS.some((c) => c.cmd === text)) {
      input.value = '';
      autosizeInput();
      autocomplete.hidden = true;
      executeSlash(text);
      return false;
    }
  }
  // `/ask <question>` typed inline — route as a bridge `ask` command so the
  // server spawns the parallel adhoc run (bypasses the per-tab lock, uses
  // --no-session-persistence). Without this branch the leading `/ask` would
  // be sent verbatim to claude -p as a prompt, which is not what the
  // documented slash command does.
  if (opts.text == null && /^\/ask\s+/i.test(text)) {
    const question = text.replace(/^\/ask\s+/i, '').trim();
    if (!question) {
      toast('Usage: /ask <question>', 'warn');
      return false;
    }
    if (!tab || !tab.project) {
      toast('Pick a project first', 'warn');
      return false;
    }
    const ok = WS.send({
      type: 'command', cmd: 'ask', args: [question],
      text: question,
      project: tab.project, tab_id: tab.id,
      permission_mode: serverPermissionMode(),
      effort: State.effort,
    });
    if (ok) {
      Chat.pushUser(text, [], tab.id);
      input.value = '';
      autosizeInput();
      autocomplete.hidden = true;
    }
    return !!ok;
  }
  if (!tab || !tab.project) {
    toast('Pick a project first', 'warn');
    return;
  }
  // A real user prompt must never get swallowed by a stuck silent-compact
  // flag (e.g. a WS reconnect during the compact run that never delivered
  // run_finished). Clearing here is cheap insurance.
  tab._compactSilent = false;
  tab.compactPending = false;
  const attachmentsPayload = attachments.map((a) => ({
    name: a.name, path: a.path, mime: a.mime, ephemeral: a.kind !== 'url' && a.kind !== 'context',
    url: a.url || null,
    kind: a.kind || 'file',
  }));
  // Bubble copy: include EVERY field the edit flow needs to rebuild a
  // payload (path, mime, kind, url, size, dims), not just the thumb-
  // rendering fields. _enterMessageEdit reads JSON.stringified
  // attachments back off the bubble's dataset and hands them to
  // sendPrompt — if path/mime weren't preserved here, the resend hits
  // the server's "Attachment missing path" guard. None of these fields
  // are secrets (the client uploaded the file in the first place).
  const previewAttachments = attachments.map((a) => ({
    name: a.name, kind: a.kind, thumbUrl: a.thumbUrl,
    path: a.path, mime: a.mime, size: a.size, dims: a.dims,
    url: a.url || null,
  }));
  // First message in a tab becomes its title — same trick as the Claude
  // web app uses to label conversations in the sidebar. Truncate to keep
  // the strip readable; the full message is in the pane.
  if (!tab.title) {
    tab.title = text.slice(0, 32).replace(/\s+/g, ' ').trim() || '(new chat)';
    renderTabs();
    _persistTabs();
  }
  if (!opts.skipUserBubble) {
    Chat.pushUser(text, previewAttachments, tab.id);
  }
  // On the FIRST run of a tab created from history, hand the server the
  // session_id we want to resume — claude will pick up where that past
  // conversation left off via --resume <id>. After that, sessionId is
  // populated normally by the session_init frame.
  const force = tab.pendingResumeSessionId || null;
  // Remember what we just shipped on the tab so a server-side "Tab busy"
  // rejection can re-route the same payload into the client queue without
  // losing the user's text + attachments. Cleared on the next
  // run_started OR on a manual stop.
  tab._lastSendPayload = {
    text,
    attachments: attachments.map((a) => ({
      name: a.name, path: a.path, size: a.size, mime: a.mime,
      kind: a.kind, dims: a.dims || null, url: a.url || null,
      thumbUrl: a.thumbUrl || null,
    })),
  };
  const ok = WS.send({
    type: 'prompt',
    text,
    project: tab.project,
    tab_id: tab.id,
    permission_mode: serverPermissionMode(),
    effort: State.effort,
    attachments: attachmentsPayload,
    force_session_id: force,
    // Fallback resume hint. The server's in-memory tab→session_id map
    // is wiped on bridge restart, so without this the next prompt the
    // user fires (queued OR fresh) spawns a brand-new claude session
    // and the conversation forks off whatever the user was just
    // reading. `tab.sessionId` lives in localStorage, so it survives
    // restarts; the server only honors it when its own record is None.
    client_session_id: (tab.sessionId || null),
    model: tab.model || '',
    agent: tab.agent || '',
  });
  if (ok) {
    // Consume the one-shot resume hint — subsequent runs in this tab
    // continue via the captured session_id from session_init.
    tab.pendingResumeSessionId = null;
    // Only clear the composer when we READ from it. Regenerate passes
    // text explicitly via opts.text and leaves the composer untouched
    // so the user doesn't lose what they were typing.
    if (opts.text == null) {
      tab.draft = '';
      input.value = '';
      autosizeInput();
      clearAttachments();
    }
    _persistTabs();
    // Pause the jsonl poll for this tab while the phone-driven run is
    // in flight. The WS stream is the canonical event source for this
    // turn — letting the poll ALSO fetch the same events would render
    // the whole turn twice (user msg, tool IN, tool OUT, assistant
    // text). Cleared in the run_finished handler, which also advances
    // the tail offset to the post-run file size.
    tab._wsRunInFlight = true;
  }
  // Surface the WS send result so callers (notably regenerate) can
  // distinguish "queued / streaming" from "WS offline, nothing sent."
  // Without this signal, regenerate would silently destroy the prior
  // assistant bubble while the user just sees a "Not connected" toast
  // and no way to recover the lost message.
  return !!ok;
}

// ─── Attachments ──────────────────────────────────────────────────────

const attachmentsEl = $('#attachments');
const fileInput = $('#fileInput');

// + button opens the attach sheet — same three options as the VSCode
// extension's plus menu (Upload / Add context / Browse the web).
$('#plusBtn').addEventListener('click', () => {
  if (!State.activeProject) { toast('Pick a project first', 'warn'); return; }
  openSheet('plusSheet');
});

$$('#plusList li').forEach((li) => {
  li.addEventListener('click', () => {
    const action = li.dataset.plus;
    if (action === 'upload') {
      // Keep the parent "Attach" sheet open behind iOS's native
      // file-source picker (Photo Library / Take Photo / Choose Files).
      // The native picker floats above any DOM — once the user picks a
      // file the fileInput change handler runs uploadFiles and we close
      // the plusSheet there. If they cancel, the parent sheet stays so
      // they can pick a different action.
      fileInput.click();
    } else if (action === 'context') {
      closeSheet('plusSheet');
      $('#contextInput').value = '';
      openSheet('contextSheet');
      setTimeout(() => $('#contextInput').focus(), 250);
    } else if (action === 'web') {
      closeSheet('plusSheet');
      $('#webInput').value = '';
      openSheet('webSheet');
      setTimeout(() => $('#webInput').focus(), 250);
    }
  });
});

// Add context: user types a project-relative path. Server validates that it
// resolves inside the active project's PROJECTS_ROOT (defense-in-depth — the
// same jail as resolve_project), then we add it as an attachment chip.
$('#contextForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const path = $('#contextInput').value.trim();
  if (!path) return;
  closeSheet('contextSheet');
  try {
    const resp = await fetch('/api/context', {
      method: 'POST', headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: State.activeProject, path }),
    });
    const data = await resp.json();
    if (!resp.ok) { toast(data.detail || 'Path not in project', 'error'); return; }
    State.attachments.push({
      name: path,
      path: data.path,
      size: data.size || 0,
      mime: data.mime || 'application/octet-stream',
      kind: 'context',     // real project file — do NOT delete after the run
      thumbUrl: null,
    });
    renderAttachments();
    toast(`Added ${path}`, 'info');
  } catch (err) { toast('Network error', 'error'); }
});

// Browse the web: we don't fetch the URL ourselves — claude has its own
// WebFetch tool. We just label the request so the prompt clearly carries the URL.
$('#webForm').addEventListener('submit', (e) => {
  e.preventDefault();
  let url = $('#webInput').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  closeSheet('webSheet');
  State.attachments.push({
    name: url, path: null, size: 0,
    mime: 'text/uri-list', kind: 'url', thumbUrl: null, url,
  });
  renderAttachments();
  toast('URL queued for next message', 'info');
});

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = '';
  if (files.length) {
    // User actually picked files — close the parent Attach sheet so
    // they can see their new attachment chips and start typing.
    closeSheet('plusSheet');
    await uploadFiles(files);
  }
  // If the picker was cancelled (no files), leave plusSheet open so
  // they can choose a different attach option without re-tapping +.
});

// Paste images / files from clipboard
window.addEventListener('paste', async (e) => {
  if (!State.activeProject) return;
  const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
  const files = [];
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    e.preventDefault();
    await uploadFiles(files);
  }
});

// Read an image's natural pixel dimensions from the local File object,
// so the attachment chip can show "381×437" the way Claude Code does
// instead of the on-disk byte size. Resolves to null for non-images or
// unreadable files; render logic falls back to bytes in that case.
function _readImageDimensions(file, objectUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = objectUrl;
  });
}

async function uploadFiles(files) {
  const form = new FormData();
  form.append('project', State.activeProject);
  for (const f of files) form.append('files', f, f.name);

  toast(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`, 'info');
  try {
    const resp = await fetch('/api/upload', { method: 'POST', body: form, headers: CSRF_HEADERS });
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.json()).detail || ''; } catch {}
      throw new Error(detail || `upload failed: ${resp.status}`);
    }
    const data = await resp.json();
    for (let i = 0; i < data.files.length; i++) {
      const meta = data.files[i];
      const file = files[i];
      const isImage = meta.mime && meta.mime.startsWith('image/');
      const thumbUrl = isImage ? URL.createObjectURL(file) : null;
      let dims = null;
      if (isImage && thumbUrl) {
        try { dims = await _readImageDimensions(file, thumbUrl); } catch {}
      }
      State.attachments.push({
        name: meta.name,
        path: meta.path,
        size: meta.size,
        mime: meta.mime,
        kind: isImage ? 'image' : 'file',
        thumbUrl,
        dims,   // {w, h} for images; null otherwise
      });
    }
    renderAttachments();
  } catch (e) {
    toast(`Upload failed: ${e.message}`, 'error');
  }
}

function _chipMeta(a) {
  // Images get pixel dimensions ("381×437") — matches the Claude Code
  // extension's attachment chip style. Everything else falls back to
  // the byte size, which is more relevant for documents.
  if (a.kind === 'image' && a.dims && a.dims.w && a.dims.h) {
    return `${a.dims.w}×${a.dims.h}`;
  }
  return formatBytes(a.size);
}

function renderAttachments() {
  attachmentsEl.innerHTML = '';
  // Persist on every mutation so attachments survive a reload (the
  // restart button, /refresh, an iOS PWA swipe-and-reopen). Without
  // this, the draft text was kept but attachments silently disappeared
  // on restore — reported 2026-05-18.
  try { _persistTabs(); } catch {}
  if (!State.attachments.length) {
    attachmentsEl.hidden = true;
    // Attachment state feeds into send-button mode (during a run, an
    // attachment alone — no typed text — should still flip "stop" to
    // "queue" so the user can stack an image-only follow-up).
    try { updateSendButton(); } catch {}
    return;
  }
  attachmentsEl.hidden = false;
  try { updateSendButton(); } catch {}
  for (const a of State.attachments) {
    const chip = el('div', { class: 'chip' + (a.kind === 'image' ? ' chip--img' : '') });
    if (a.kind === 'image' && a.thumbUrl) {
      chip.append(el('img', { class: 'chip__thumb', src: a.thumbUrl, alt: '' }));
    }
    chip.append(el('span', { class: 'chip__name' }, a.name));
    chip.append(el('span', { class: 'chip__size' }, _chipMeta(a)));
    const close = el('button', { class: 'chip__close', type: 'button', 'aria-label': `Remove ${a.name}` }, '×');
    close.addEventListener('click', () => {
      State.attachments = State.attachments.filter((x) => x !== a);
      if (a.thumbUrl) URL.revokeObjectURL(a.thumbUrl);
      renderAttachments();
    });
    chip.append(close);
    attachmentsEl.append(chip);
  }
}

function clearAttachments() {
  // Do NOT revoke blob URLs here — by this point Chat.pushUser has
  // already wired the same URL into the user-message bubble's <img>
  // thumbnail in the chat history. Revoking would break that image
  // (browser renders a "?" / broken-image placeholder when the src
  // resolves to a torn-down blob). The blob URLs are reclaimed by
  // the browser when the document unloads, which is fine for a
  // phone bridge that the user reopens daily.
  State.attachments = [];
  renderAttachments();
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Mic — record → local Whisper transcription, one tap to start ────
//
// Audio is captured on the phone via MediaRecorder, POSTed to the
// laptop's /api/transcribe endpoint, decoded + transcribed by
// faster-whisper entirely in memory (no disk writes), and the
// resulting text is dropped into the composer at the caret. The user
// then reviews and hits send like any typed message — the text becomes
// a normal turn in the thread, the audio is never persisted.
//
// One tap → start recording. Audio bars to the left of the mic show
// the level. Second tap → stop, transcribe, insert text. The mic
// button enters a brief "transcribing" state while we wait for the
// server's response.
//
// Replaces the previous webkitSpeechRecognition flow — iOS Apple
// Dictation was unreliable (random stalls, AirPods incompatibility,
// no-speech timeouts, 6s budgets). Local Whisper runs on the laptop
// the user already has open, so latency is just network + a sub-second
// inference pass on a `base.en` model.

const Mic = {
  // 'recording' while MediaRecorder is capturing; 'transcribing' while
  // we wait for the final server response; null when idle.
  mode: null,

  // MediaRecorder state
  recorder: null,
  chunks: [],
  mimeType: '',

  // Caret position where transcribed text should land
  baseBefore: '',
  baseAfter: '',

  // The tab the user started recording in. Switching tabs mid-record
  // or mid-transcribe must NOT route the resulting text into whichever
  // tab is now visible — it has to land in the originating tab's draft
  // so the user comes back to find their dictation waiting. See
  // _applyTranscript for the routing logic.
  tabId: null,

  // Live-partial state: poll every ~1.5s during recording so the user
  // sees text appear as they speak. Each partial re-transcribes the
  // growing clip (Whisper isn't truly streaming) — best-effort, dropped
  // if a previous request is still in flight.
  _partialTimer: 0,
  _partialInflight: false,

  // Shared: audio-level visualization
  stream: null,
  audioCtx: null,
  analyser: null,
  rafId: 0,

  async start() {
    // Server beacon on entry — lets us tell from bridge.err.log whether
    // the mic button tap actually got into Mic.start(), without needing
    // Safari devtools. Reported 2026-05-20: "mic isn't letting me record".
    try { _crcBeacon('mic-start-entry', { mode: this.mode }); } catch {}
    if (this.mode) {
      try { console.warn('[mic] start() blocked: mode=' + this.mode); } catch {}
      try { _crcBeacon('mic-fail', { stage: 'mode-busy', mode: this.mode }); } catch {}
      toast(`Mic is stuck (mode=${this.mode}). Reloading the page should clear it.`, 'warn');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      try { _crcBeacon('mic-fail', { stage: 'no-getUserMedia' }); } catch {}
      toast('Mic needs HTTPS — switch to the https URL.', 'error');
      return;
    }
    if (!window.MediaRecorder) {
      try { _crcBeacon('mic-fail', { stage: 'no-MediaRecorder' }); } catch {}
      toast('This browser does not support audio recording.', 'error');
      return;
    }
    try { console.info('[mic] start: cycle begin'); } catch {}
    // Restored 2026-05-20 21:45 — origin/main (commit 6b6ae5c) mic
    // flow was working smoothly per the user. My intermediate edits
    // (move gum to be first await, drop wakeLock-pre-gum, drop the
    // permissions.query + warmup-gum) introduced a perceptible
    // delay before recording began. Restoring the proven flow:
    //   1. wakeLock BEFORE gum (iOS otherwise treats the perm overlay
    //      as a background → cold-relaunch on resume)
    //   2. permissions.query — useful when state is already 'granted'
    //      so we can skip the warmup gum (one fewer dialog)
    //   3. early-return on 'denied' — actionable toast
    //   4. warmup gum ({audio: true}, throwaway) before the real gum —
    //      mitigates WebKit's UserMediaPermissionRequestProxy crash
    //      on first grant
    //   5. real gum with voice-mode constraints
    // The mic-fail beacons stay in for diagnostics.
    this._tryAcquireWakeLock = async (reason) => {
      try {
        if (!navigator.wakeLock) return;
        if (this.wakeLock && !this.wakeLock.released) return;
        this.wakeLock = await navigator.wakeLock.request('screen');
        try {
          this.wakeLock.addEventListener('release', () => {
            console.warn('[mic] wake lock released by OS (' + reason + ')');
          });
        } catch {}
      } catch (e) {
        console.warn('[mic] wake lock denied (' + reason + '):', e && e.message);
      }
    };
    await this._tryAcquireWakeLock('pre-getUserMedia');
    let _needsWarmup = true;
    let _permState = '';
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: 'microphone' });
        _permState = status && status.state || '';
        if (_permState === 'granted') _needsWarmup = false;
      }
    } catch {}
    try { _crcBeacon('mic-perm', { state: _permState, gumGranted: _lsGet('crc.mic.granted') === '1' }); } catch {}
    try {
      if (_lsGet('crc.mic.granted') === '1') _needsWarmup = false;
    } catch {}
    if (_permState === 'denied') {
      try { this.wakeLock && this.wakeLock.release(); } catch {}
      this.wakeLock = null;
      try { _crcBeacon('mic-fail', { stage: 'perm-denied', permState: _permState }); } catch {}
      toast('Mic is blocked. On iPhone: Settings → Safari → Microphone → Allow (or tap the “aA” in Safari → Website Settings).', 'error');
      return;
    }
    if (_needsWarmup) {
      try {
        const warm = await navigator.mediaDevices.getUserMedia({ audio: true });
        try { warm.getTracks().forEach((t) => t.stop()); } catch {}
        try { _lsSet('crc.mic.granted', '1'); } catch {}
      } catch (e) {
        try { this.wakeLock && this.wakeLock.release(); } catch {}
        this.wakeLock = null;
        const name = (e && e.name) || '';
        try { _crcBeacon('mic-fail', { stage: 'warmup-gum', err: name, msg: (e && e.message || '').slice(0, 200) }); } catch {}
        if (name === 'NotAllowedError') {
          try { _lsSet('crc.mic.granted', ''); } catch {}
          toast('Mic is blocked. iPhone: Settings → Safari → Microphone → Allow, then reload the PWA.', 'error');
        } else if (name === 'NotFoundError') {
          toast('No microphone detected on this device.', 'error');
        } else if (name === 'NotReadableError') {
          toast('Mic is already in use by another app. Close it and tap again.', 'error');
        } else {
          toast('Mic permission denied' + (name ? ` (${name})` : ''), 'error');
        }
        return;
      }
    }
    // Voice-mode constraints (echoCancellation / autoGainControl /
    // noiseSuppression) nudge iOS into the "PlayAndRecord" audio session,
    // which forces Bluetooth devices (AirPods) onto the HFP profile —
    // the only Bluetooth profile that carries microphone audio. Without
    // these, iOS often keeps AirPods in A2DP (output-only) and captures
    // from the built-in mic muted by the AirPods.
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        },
      });
      try { _lsSet('crc.mic.granted', '1'); } catch {}
    } catch (e) {
      try { this.wakeLock && this.wakeLock.release(); } catch {}
      this.wakeLock = null;
      const name = (e && e.name) || '';
      try { _crcBeacon('mic-fail', { stage: 'main-gum', err: name, msg: (e && e.message || '').slice(0, 200) }); } catch {}
      if (name === 'NotAllowedError') {
        try { _lsSet('crc.mic.granted', ''); } catch {}
        toast('Mic is blocked. iPhone: Settings → Safari → Microphone → Allow, then reload the PWA.', 'error');
      } else if (name === 'NotReadableError') {
        toast('Mic is already in use by another app. Close it and tap again.', 'error');
      } else {
        toast('Mic permission denied' + (name ? ` (${name})` : ''), 'error');
      }
      return;
    }
    try {
      const tracks = this.stream.getAudioTracks();
      if (tracks && tracks.length) {
        console.info('[mic] acquired audio track:', tracks[0].label || '(unlabeled)');
      }
    } catch {}
    this._startVis();

    // Snapshot caret position so transcribed text lands where the user
    // had the cursor (or at end if there was no focus).
    const caretAtStart = input.selectionStart ?? input.value.length;
    this.baseBefore = input.value.slice(0, caretAtStart);
    this.baseAfter = input.value.slice(caretAtStart);
    // Pin the recording to whichever tab is active right now. If the
    // user switches tabs before transcription returns, _applyTranscript
    // routes the text into this tab's saved draft instead of clobbering
    // whatever the user pulled up.
    this.tabId = State.activeTabId || null;

    // MediaRecorder mime selection: iOS Safari emits audio/mp4 (AAC),
    // Chrome/Firefox prefer audio/webm;codecs=opus. Faster-whisper +
    // PyAV decodes both. Let the browser pick its preferred container
    // by omitting the mimeType option unless we explicitly support one.
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    this.mimeType = '';
    for (const c of candidates) {
      if (window.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) {
        this.mimeType = c;
        break;
      }
    }
    this.chunks = [];
    try {
      const opts = this.mimeType ? { mimeType: this.mimeType } : undefined;
      this.recorder = new MediaRecorder(this.stream, opts);
    } catch (e) {
      console.warn('[mic] MediaRecorder construct failed:', e && e.message);
      toast('Could not start recording', 'error');
      this._teardown();
      return;
    }
    this.recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    this.recorder.onstop = () => {
      // The user already saw the stop happen (mode flipped to
      // 'transcribing' synchronously in stop()). _finishRecording does
      // the actual POST + insertion.
      this._finishRecording().catch((e) => {
        console.warn('[mic] _finishRecording error:', e && e.message);
        toast('Transcription failed: ' + (e && e.message || 'unknown error'), 'error');
        this._teardown();
      });
    };
    try {
      // 250ms timeslice → ondataavailable fires periodically so we
      // accumulate chunks instead of getting one giant blob at stop.
      // Doesn't change the final result, just keeps memory pressure
      // sane on very long clips.
      this.recorder.start(250);
    } catch (e) {
      console.warn('[mic] MediaRecorder.start failed:', e && e.message);
      toast('Could not start recording', 'error');
      this._teardown();
      return;
    }
    this.mode = 'recording';
    try { updateSendButton(); } catch {}
    $('#micBtn').setAttribute('aria-pressed', 'true');
    $('#micLevel').hidden = false;
    // Live partial transcription. Fire the first poll ~250ms after
    // recording begins so the user sees text almost immediately, then
    // poll every 500ms after that. Each poll re-runs Whisper on the
    // full accumulated audio; the `_partialInflight` guard drops a
    // tick if the previous request is still in flight (the practical
    // ceiling on cadence is whichever is slower: poll interval or
    // inference time for the growing clip).
    const tick = () => {
      this._pollPartial().catch((e) => {
        try { console.warn('[mic] _pollPartial error:', e && e.message); } catch {}
      });
    };
    this._partialInflight = false;
    setTimeout(() => {
      if (this.mode !== 'recording') return;
      tick();
      this._partialTimer = setInterval(tick, 500);
    }, 250);
  },

  // Replace the textarea content with `text` spliced at the saved
  // caret position. Used by both the live partial poller and the final
  // on-stop transcription so insertion behaviour stays consistent.
  //
  // Tab-switch contract: if the user has switched away from the tab
  // they started recording in, write the transcript into THAT tab's
  // saved draft string instead of the live textarea — otherwise we'd
  // overwrite whatever they came over to look at. Live partials are
  // dropped in this case (no point updating an invisible draft 2x/sec);
  // the final on-stop transcription lands the canonical text.
  _applyTranscript(text, opts) {
    const isFinal = !!(opts && opts.final);
    const left = this.baseBefore;
    const right = this.baseAfter;
    const leftJoin = (left && !/\s$/.test(left) && text) ? ' ' : '';
    const rightJoin = (right && !/^\s/.test(right) && text) ? ' ' : '';
    const joined = left + leftJoin + text + rightJoin + right;
    const onRecordingTab = (this.tabId && this.tabId === State.activeTabId);
    if (!onRecordingTab) {
      if (!isFinal) return;
      const recTab = this.tabId ? getTab(this.tabId) : null;
      if (!recTab) {
        try { toast('Transcript lost — recording tab was closed', 'warn'); } catch {}
        return;
      }
      recTab.draft = joined;
      try {
        const name = recTab.project || 'another tab';
        toast('Transcript added to ' + name, 'info');
      } catch {}
      return;
    }
    input.value = joined;
    autosizeInput();
    const newCaret = (left + leftJoin + text).length;
    try { input.setSelectionRange(newCaret, newCaret); } catch {}
    if (newCaret === input.value.length && input.scrollHeight > input.scrollTop + input.clientHeight + 4) {
      input.scrollTop = input.scrollHeight;
    }
  },

  async _pollPartial() {
    if (this.mode !== 'recording') return;
    if (this._partialInflight) return;
    // Need at least one chunk before a partial can be meaningful.
    if (!this.chunks.length) return;
    // Ask MediaRecorder to flush the latest audio into a chunk so the
    // partial includes everything the user just said, not only the
    // previous 1.5s. requestData() fires dataavailable synchronously
    // on most engines but we still yield a tick to let the handler push.
    try {
      if (this.recorder && this.recorder.state === 'recording') this.recorder.requestData();
    } catch {}
    // Yield one microtask + a tiny timeout so the ondataavailable
    // handler can push the freshly-flushed chunk before we snapshot.
    await new Promise((r) => setTimeout(r, 5));
    if (this.mode !== 'recording') return;
    const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' });
    if (blob.size < 500) return;  // too small to bother transcribing
    this._partialInflight = true;
    try {
      // Hint to the server this is a partial — it skips VAD filtering
      // on partials to save ~50-100ms per request. The final on-stop
      // transcribe (no ?partial=1) keeps VAD on for the canonical text.
      // Send the Blob as the raw request body (NOT multipart) so the
      // server can read straight off request.stream() — keeps audio in
      // RAM only, never spilled to a Starlette tempfile.
      const resp = await fetch('/api/transcribe?partial=1', {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
      if (!resp.ok) return;
      const data = await resp.json().catch(() => ({}));
      const text = (data.text || '').trim();
      // Bail if recording stopped while we were waiting on the network —
      // _finishRecording will handle the final/canonical insertion.
      if (this.mode !== 'recording' || !text) return;
      this._applyTranscript(text);
    } finally {
      this._partialInflight = false;
    }
  },

  async _finishRecording() {
    // Tear down the capture stream + audio context immediately so the
    // mic indicator drops off the OS-level UI even while the network
    // round-trip is in flight. Keep the wake lock + composer state
    // until the text actually lands.
    cancelAnimationFrame(this.rafId);
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.audioCtx && this.audioCtx.close(); } catch {}
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.rafId = 0;

    if (!this.chunks.length) {
      toast('No audio captured', 'warn');
      this._teardown();
      return;
    }
    const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' });
    this.chunks = [];
    // Empty / sub-200-byte payloads from MediaRecorder mean the
    // codec didn't actually start (happens occasionally on iOS when
    // start() races with permission grant). Surface as a clean error.
    if (blob.size < 200) {
      toast('Recording was empty — try again', 'warn');
      this._teardown();
      return;
    }

    let resp;
    try {
      // Raw-body POST (NOT multipart) — keeps audio in server RAM only.
      resp = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
    } catch (e) {
      toast('Network error — couldn\'t reach laptop. Try again.', 'error');
      this._teardown();
      return;
    }
    if (!resp.ok) {
      let detail = '';
      try { const d = await resp.json(); detail = d.detail || ''; } catch {}
      toast('Transcription failed: ' + (detail || ('HTTP ' + resp.status)), 'error');
      this._teardown();
      return;
    }
    let text = '';
    try { const data = await resp.json(); text = (data.text || '').trim(); } catch {}
    if (!text) {
      // Keep whatever the last partial showed in the textarea; only
      // toast if the user got NOTHING (no partial ever landed either).
      // The "did a partial land" check is only meaningful when we're
      // still on the recording tab — partials are dropped off-tab.
      const onRecordingTab = (this.tabId && this.tabId === State.activeTabId);
      const hadPartial = onRecordingTab && (input.value !== (this.baseBefore + this.baseAfter));
      if (!hadPartial) toast('Whisper heard silence', 'warn');
      this._teardown();
      return;
    }
    this._applyTranscript(text, { final: true });
    try {
      if (this.tabId && this.tabId === State.activeTabId) input.focus();
    } catch {}
    this._teardown();
  },

  _startVis() {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.6;
    source.connect(this.analyser);
    const bars = $$('#micLevel span');
    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(buf);
      // Sample 5 bands across the spectrum, scaled to percentage height.
      const bins = bars.length;
      const step = Math.floor(buf.length / bins);
      for (let i = 0; i < bins; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += buf[i * step + j];
        const amp = Math.min(1, (sum / step) / 180);
        bars[i].style.setProperty('--bar-h', (10 + amp * 90) + '%');
      }
      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  },

  stop() {
    if (!this.mode) return;
    if (this.mode === 'transcribing') {
      // Already past stop — second tap during the round-trip just
      // surfaces a hint, don't double-teardown.
      try { toast('Transcribing — hold on…', 'warn'); } catch {}
      return;
    }
    // Flip the visible state synchronously so a second tap doesn't
    // restart recording before MediaRecorder.onstop fires.
    this.mode = 'transcribing';
    try { updateSendButton(); } catch {}
    // Cancel the live-partial poller — _finishRecording will produce
    // the canonical transcript.
    if (this._partialTimer) { clearInterval(this._partialTimer); this._partialTimer = 0; }
    $('#micBtn').setAttribute('aria-pressed', 'false');
    $('#micBtn').setAttribute('aria-busy', 'true');
    $('#micLevel').hidden = true;
    $$('#micLevel span').forEach((b) => b.style.setProperty('--bar-h', '20%'));
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch (e) {
      console.warn('[mic] recorder.stop() threw:', e && e.message);
      this._teardown();
    }
  },

  _teardown() {
    cancelAnimationFrame(this.rafId);
    if (this._partialTimer) { clearInterval(this._partialTimer); this._partialTimer = 0; }
    this._partialInflight = false;
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.audioCtx && this.audioCtx.close(); } catch {}
    try { this.wakeLock && this.wakeLock.release(); } catch {}
    this.wakeLock = null;
    this.mode = null;
    this.recorder = null;
    this.chunks = [];
    this.mimeType = '';
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.rafId = 0;
    this.baseBefore = '';
    this.baseAfter = '';
    this.tabId = null;
    try { updateSendButton(); } catch {}
    $('#micBtn').setAttribute('aria-pressed', 'false');
    $('#micBtn').removeAttribute('aria-busy');
    $('#micLevel').hidden = true;
    $$('#micLevel span').forEach((b) => b.style.setProperty('--bar-h', '20%'));
    try { console.info('[mic] _teardown complete'); } catch {}
  },
};

// Diagnostic: log every interaction with the mic button at three event
// layers (pointerdown, touchend, click) so the in-app Debug log can
// distinguish "tap never reached JS" from "tap fired but routing broke"
// from "click eaten by an overlay". Reported 2026-05-16: after two
// onend→teardown cycles, a third tap produced ZERO log entries — meaning
// the click handler itself didn't run. These probes will pinpoint which
// layer dropped the event next time.
function _micStateDump(via) {
  try {
    const btn = $('#micBtn');
    if (!btn) { console.warn('[mic] tap ' + via + ': #micBtn NOT IN DOM'); return; }
    const cs = window.getComputedStyle(btn);
    console.info('[mic] tap ' + via +
      ' | mode=' + Mic.mode +
      ' disabled=' + btn.disabled +
      ' hidden=' + btn.hidden +
      ' aria-pressed=' + btn.getAttribute('aria-pressed') +
      ' display=' + cs.display +
      ' visibility=' + cs.visibility +
      ' pointer-events=' + cs.pointerEvents +
      ' opacity=' + cs.opacity);
  } catch (e) {
    try { console.warn('[mic] state dump failed:', e && e.message); } catch {}
  }
}
$('#micBtn').addEventListener('pointerdown', () => { _micStateDump('pointerdown'); }, { passive: true });
$('#micBtn').addEventListener('touchend', () => { _micStateDump('touchend'); }, { passive: true });
$('#micBtn').addEventListener('click', () => {
  _micStateDump('click');
  // Server-side beacon so we can see mic taps in bridge.err.log without
  // needing Safari devtools. User reported 2026-05-20 that the mic stopped
  // working — this lets us tell whether the tap is reaching JS at all,
  // before any getUserMedia / MediaRecorder action.
  try { _crcBeacon('mic-tap', { mode: Mic.mode, ts: Date.now() }); } catch {}
  if (Mic.mode) Mic.stop(); else Mic.start();
});

// Closing should never leave a hot mic, but DON'T auto-stop on
// visibilitychange — iOS fires `visibilitychange` whenever the screen
// auto-locks, even if the user is still actively dictating. The wake
// lock requested in Mic.start keeps the screen on while dictation is
// in flight; if the screen still goes off (user explicitly hit the
// side button, or iOS overrode the wake lock to save battery), the
// mic continues until either pagehide fires (full close) or the user
// taps the mic button again.
window.addEventListener('pagehide', () => { if (Mic.mode) Mic.stop(); });

// Full-screen overlay shown briefly between tapping "Restart app" and
// the page actually reloading. Previously the only feedback was a tiny
// `toast('Restarting app…')` in a corner which iOS sometimes paints on
// a white background mid-transition — looking like a browser error
// rather than intentional UX. The overlay below covers the viewport,
// matches the bridge's color tokens, and shows the same Claude spark
// icon as the topbar so it reads as "the app, not the browser".
function _showRestartOverlay() {
  if (document.getElementById('crcRestartOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'crcRestartOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10001;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:var(--bg,#1a1614);color:var(--fg,#e9e6e1);font:600 17px/1.4 inherit;-webkit-user-select:none;user-select:none;animation:crcOverlayIn 220ms var(--ease-out,ease-out);';
  overlay.innerHTML = (
    '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent,#0E6E6E);animation:crcSpin 1.4s linear infinite;">' +
      '<path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z"/>' +
    '</svg>' +
    '<div style="text-align:center;max-width:240px;">' +
      '<div style="font-size:18px;font-weight:600;">Restarting Bridgy…</div>' +
      '<div style="margin-top:6px;font-size:14px;color:var(--fg-2,#c7bfb6);font-weight:400;">Picking up the latest build. The chat will return in a moment.</div>' +
    '</div>'
  );
  // Inject keyframes once.
  if (!document.getElementById('crcRestartOverlayStyle')) {
    const style = document.createElement('style');
    style.id = 'crcRestartOverlayStyle';
    style.textContent = (
      '@keyframes crcSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }' +
      '@keyframes crcOverlayIn { from { opacity: 0; } to { opacity: 1; } }'
    );
    document.head.appendChild(style);
  }
  document.body.appendChild(overlay);
}

// Splash plays ONLY on cold launch (Splash.init at module load) and on
// WS reconnect after a real onclose (see WS.connect's onclose handler).
// Earlier versions also called Splash.reshow() on every visibilitychange
// + pageshow, which made the animation play every time the user swiped
// away and came back — disruptive for a phone that backgrounds the PWA
// every few seconds during normal use. Per user feedback (2026-05-15),
// resume-from-background now just lets the chat reappear in place.

// ─── Heartbeat ────────────────────────────────────────────────────────
//
// Two responsibilities, fired together every 25s:
//   1. Watchdog: WS.ensureLive() checks staleness and force-closes a
//      zombie socket so the onclose handler kicks reconnect. Without
//      this, iOS Safari can park a WebSocket in a half-dead state where
//      no frames flow but onclose never fires either — the chat looks
//      frozen and the user has to swipe the app away and reopen to get
//      new messages. We catch that case here instead.
//   2. Ping: keeps NAT/proxy idle-timers from killing the connection
//      and provides the inbound traffic the watchdog measures against
//      (server replies with `pong`, which feeds lastInboundAt).

setInterval(() => {
  WS.ensureLive();
  WS.send({ type: 'ping' });
}, 25000);

// Defensive periodic reconciler — runs every 5s.
//
// Why this exists: the kawaii mascot + status-word animation lives on
// every `.msg--asst.msg--running` container and on `tab._ghostThinking`.
// Both have their own setInterval cyclers. The user reported (2026-05-20)
// repeated cases where Claude clearly finished but the spinner kept
// animating — usually because a code path mutated `tab.running` without
// also calling `Chat.ensureRunningSpinner()`, OR a `run_finished` WS
// frame got dropped (background suspend, WS reconnect, server restart)
// and no client-side path ever reaped the stale msg--running container.
//
// This sweep heals BOTH classes of leak within 5s. Cheap (DOM query on
// the active pane only) so it's safe to run continuously.
function _reconcileRunningState() {
  try {
    for (const tab of State.tabs || []) {
      if (!tab._chatpane) continue;
      const realRunning = tab._chatpane.querySelectorAll(
        '.msg--asst.msg--running:not(.msg--ghostThinking)'
      );
      if (!tab.running && realRunning.length) {
        // Leak: tab.running=false but stale msg--running cyclers are
        // still ticking. Strip the class + clear any tracked cyclers.
        realRunning.forEach((node) => {
          try { node.classList.remove('msg--running'); } catch {}
        });
        if (tab._activeRuns) {
          for (const run of tab._activeRuns.values()) {
            if (run.cycler) { clearInterval(run.cycler); run.cycler = null; }
            if (run.spinnerTimer) { try { run.spinnerTimer(); } catch {} run.spinnerTimer = null; }
          }
          tab._activeRuns.clear();
        }
      }
      // Sync the ghost spinner state in both directions — creates the
      // ghost when tab.running=true and no real running message exists,
      // removes it when tab.running=false or a real one exists.
      try { Chat.ensureRunningSpinner(tab.id); } catch {}
    }
  } catch (e) {
    try { console.warn('[reconciler]', e && e.message); } catch {}
  }
}
setInterval(_reconcileRunningState, 5000);

// ─── Face ID / passkey registration ──────────────────────────────────
// base64url ↔ ArrayBuffer helpers — same as on login.html, kept inline so
// the two pages don't need a shared bundle.
function b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - s.length % 4) : '';
  const bin = atob(s + pad);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function showPasskeyMenuItemIfAvailable() {
  // Hide unconditionally if the browser lacks WebAuthn.
  if (!window.PublicKeyCredential) return;
  try {
    const r = await fetch('/api/passkey/status');
    if (!r.ok) return;
    const data = await r.json();
    if (!data.available) return;
    // Show "Set up Face ID" only if no passkey is registered yet — once
    // there's one, the registration menu item is just clutter.
    if (!data.has_credentials) $('#passkeyMenuItem').hidden = false;
  } catch {}
}

async function registerPasskey() {
  if (!window.PublicKeyCredential) {
    toast('Passkeys not supported in this browser', 'error');
    return;
  }
  try {
    const startResp = await fetch('/api/passkey/register/start', { method: 'POST', headers: CSRF_HEADERS });
    if (!startResp.ok) {
      const d = await startResp.json().catch(() => ({}));
      toast(d.detail || 'Could not start passkey registration', 'error');
      return;
    }
    const opts = await startResp.json();
    const publicKey = {
      challenge: b64urlToBuf(opts.challenge),
      rp: opts.rp,
      user: { id: b64urlToBuf(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
      pubKeyCredParams: opts.pubKeyCredParams,
      timeout: opts.timeout,
      excludeCredentials: (opts.excludeCredentials || []).map((c) => ({
        id: b64urlToBuf(c.id), type: c.type,
      })),
      authenticatorSelection: opts.authenticatorSelection,
      attestation: opts.attestation,
    };
    const cred = await navigator.credentials.create({ publicKey });
    if (!cred) throw new Error('No credential created');
    const credential = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        attestationObject: bufToB64url(cred.response.attestationObject),
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
      },
      clientExtensionResults: cred.getClientExtensionResults(),
    };
    const label = (navigator.userAgent.match(/iPhone|iPad|Macintosh|Windows|Android/) || ['Device'])[0];
    const finish = await fetch('/api/passkey/register/finish', {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, label }),
    });
    if (!finish.ok) {
      const d = await finish.json().catch(() => ({}));
      toast(d.detail || 'Registration failed', 'error');
      return;
    }
    toast('Face ID set up. Next login can use it.', 'info');
    $('#passkeyMenuItem').hidden = true;
  } catch (e) {
    if (e && e.name !== 'NotAllowedError') {
      toast('Face ID error: ' + (e.message || e.name), 'error');
    }
  }
}

showPasskeyMenuItemIfAvailable();

// Notifications row used to be a one-shot enable button — it would
// hide itself once permission was granted. Now that it's a toggle
// (see _togglePushNotifications), we only hide it when the browser
// can't possibly support push notifications at all. The toggle's
// aria-checked state already reflects "subscribed vs not", so leaving
// the row visible lets the user disable notifications later without
// digging through iOS Settings.
(function maybeHideNotifsItem() {
  const item = document.getElementById('notifsMenuItem');
  if (!item) return;
  const supported = ('Notification' in window) && ('serviceWorker' in navigator) && ('PushManager' in window);
  if (!supported) item.hidden = true;
})();

// Sync the theme toggle's aria-checked state with the current theme so
// the iOS-style switch visually matches reality. Off = warm dark (the
// default), on = warm cream. Called on boot and after every theme flip.
function _updateThemeMenuLabel() {
  const toggle = document.getElementById('themeToggle');
  if (!toggle) return;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  toggle.setAttribute('aria-checked', isLight ? 'true' : 'false');
}
_updateThemeMenuLabel();

// ─── Notifications when claude finishes a run in the background ──────
//
// On iOS, the Notification API works *only* when the app is installed to
// the home screen (standalone PWA mode) and only on iOS 16.4+. Desktop
// browsers support it any time. We request permission on first run_finished
// after the user has minimized / backgrounded the tab. If granted, every
// subsequent finish while the document is hidden fires a notification —
// title is the project, body is the first 120 chars of claude's last text.

// Convert a URL-safe base64 string (the format VAPID public keys come
// in) into the Uint8Array the PushManager.subscribe API requires.
function _urlBase64ToUint8(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// Sync the notifications toggle's aria-checked state with reality:
// the switch shows ON only if Notification.permission is granted AND
// there's a live push subscription on this device. Called on menu
// open + after any toggle action.
async function _updateNotifsToggleLabel() {
  const toggle = document.getElementById('notifsToggle');
  if (!toggle) return;
  let on = false;
  try {
    if ('Notification' in window && Notification.permission === 'granted'
        && 'serviceWorker' in navigator && 'PushManager' in window) {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        on = !!sub;
      }
    }
  } catch {}
  toggle.setAttribute('aria-checked', on ? 'true' : 'false');
}

// The notifs row in the menu is a toggle (like Light mode). Tap to
// flip: enables (subscribes via PushManager + POSTs to /api/push/
// subscribe) OR disables (browser-side unsubscribe + DELETE on server)
// based on the current state. Sync is non-trivial because the user can
// also revoke Notification permission in iOS Settings outside the app —
// we always re-read state when the menu opens via
// _updateNotifsToggleLabel.
async function _togglePushNotifications() {
  const toggle = document.getElementById('notifsToggle');
  if (!toggle) return;
  const wasOn = toggle.getAttribute('aria-checked') === 'true';
  if (wasOn) {
    await _disablePushNotifications();
  } else {
    await _enablePushNotifications();
  }
  await _updateNotifsToggleLabel();
}

async function _disablePushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) {
      toast('Notifications off', 'info');
      return;
    }
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch {}
    try {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...CSRF_HEADERS },
        credentials: 'same-origin',
        body: JSON.stringify({ endpoint }),
      });
    } catch {}
    // Clear the persisted intent so we don't silently re-subscribe.
    try { localStorage.removeItem('crc.push.enabled'); } catch {}
    toast('Notifications off', 'info');
  } catch (e) {
    console.error('[push] disable failed', e);
    toast('Disable failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

// On every page load, if the user previously enabled notifications but
// the browser has lost the push subscription (cold launch + SW restart,
// stale subscription, push service rotation), re-establish it silently
// — Notification.permission is already 'granted' so no prompt fires.
//
// `Notification.permission === 'granted'` is the persistent intent
// signal: iOS / the browser persists it across PWA restarts and bridge
// updates, and the user explicitly granted it. We do NOT key off the
// `crc.push.enabled` localStorage flag — that flag was added later and
// users who enabled notifications in an older client version don't have
// it set, so requiring it caused the toggle to flip OFF after every
// bridge update. Permission-granted is enough.
//
// We also ALWAYS re-POST the subscription to the bridge on restore (even
// if the browser still has one) so server-side state is re-synced after
// a fresh `.crc-push.json` or a bridge upgrade. The bridge dedups by
// endpoint, so this is idempotent.
async function _restorePushSubscriptionIfWanted() {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    // Re-run the full enable path; it's idempotent. `silent: true`
    // suppresses toasts and permission prompts.
    await _enablePushNotifications({ silent: true });
    try { _updateNotifsToggleLabel(); } catch {}
  } catch (e) {
    console.warn('[push] silent restore failed', e);
  }
}
// Restore the push subscription as soon as the SW is actually ready
// (active + claimed) rather than guessing with a wall-clock timeout.
// The old 2500ms fixed delay was a race: on slow Tailscale reconnects
// the SW could still be `installing` at the 2.5s mark, the restore
// would short-circuit, and a `run_finished` push arriving in the next
// few seconds would land at a SW that wasn't ready to call
// showNotification.
(async () => {
  try {
    if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
  } catch {}
  try { _restorePushSubscriptionIfWanted(); } catch {}
})();

// User tapped "Enable notifications" — request permission, register the
// service worker, subscribe to Web Push, and ship the subscription to
// the bridge so it can fire pushes on `run_finished`. Works through full
// app-closure on iOS PWAs (16.4+) and Android Chrome installations.
async function _enablePushNotifications(opts) {
  const silent = !!(opts && opts.silent);
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (!silent) toast('Notifications not supported on this browser', 'error');
    return;
  }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    if (!silent) toast('HTTPS required for notifications — use the Tailscale Serve / cloudflared URL', 'warn');
    return;
  }
  try {
    // Silent restore path: never prompt; only continue if permission is
    // already granted from a previous user action.
    let perm = Notification.permission;
    if (perm === 'default') {
      if (silent) return;
      perm = await Notification.requestPermission();
    }
    if (perm !== 'granted') {
      if (!silent) toast(perm === 'denied'
        ? 'Notifications denied — enable in iOS Settings → Notifications'
        : 'Notification permission dismissed', 'warn');
      return;
    }
    // Ensure our service worker is registered (needed for the push handler).
    let reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg) reg = await navigator.serviceWorker.register('/sw.js');
    // Make sure activation actually finishes before we subscribe.
    await navigator.serviceWorker.ready;
    // Pull VAPID public key from the bridge.
    const keyResp = await fetch('/api/push/vapid-public-key', { credentials: 'same-origin' });
    if (!keyResp.ok) {
      if (!silent) toast('Notifications unavailable: bridge returned ' + keyResp.status, 'error');
      return;
    }
    const { key } = await keyResp.json();
    if (!key) {
      if (!silent) toast('Notifications unavailable: missing VAPID key', 'error');
      return;
    }
    // Subscribe — re-uses the existing browser subscription if there is one.
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // If the VAPID key has rotated since last subscription, the
      // existing one's `applicationServerKey` won't match; resubscribe.
      const existingKey = sub.options && sub.options.applicationServerKey;
      if (existingKey) {
        // Compare key bytes; if different, unsubscribe + resubscribe.
        const want = _urlBase64ToUint8(key);
        const have = new Uint8Array(existingKey);
        let same = want.length === have.length;
        if (same) for (let i = 0; i < want.length; i++) if (want[i] !== have[i]) { same = false; break; }
        if (!same) {
          try { await sub.unsubscribe(); } catch {}
          sub = null;
        }
      }
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8(key),
      });
    }
    // Hand subscription off to the bridge.
    const postResp = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CSRF_HEADERS },
      credentials: 'same-origin',
      body: JSON.stringify({
        subscription: sub.toJSON(),
        label: (navigator.userAgent || '').slice(0, 60),
      }),
    });
    if (!postResp.ok) {
      if (!silent) toast('Subscription failed: bridge returned ' + postResp.status, 'error');
      return;
    }
    // Remember the user's intent so we can silently re-subscribe on a
    // future cold launch if the browser dropped the subscription (push
    // services do that periodically).
    try { localStorage.setItem('crc.push.enabled', '1'); } catch {}
    if (!silent) toast('Notifications on — you\'ll be pinged when Claude finishes', 'info');
  } catch (e) {
    console.error('[push] enable failed', e);
    if (!silent) toast('Notifications enable failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

// ─── Service worker cleanup ───────────────────────────────────────────
//
// Legacy-SW cleanup. The bridge used to ship a self-destructing SW
// whose activate handler force-navigated clients into a reload loop
// (Safari eventually caught it as "A problem repeatedly occurred").
// We have a REAL SW now at /sw.js — it powers Web Push notifications
// — so the unregister sweep must spare it. Killing /sw.js on every
// page load destroyed the push subscription and silently swallowed
// every `run_finished` push that arrived during the ~2.5s window
// before `_restorePushSubscriptionIfWanted` re-established it. That
// was the "no banner after a version upgrade" bug.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => Promise.all(regs
      .filter((r) => {
        const url = (r.active && r.active.scriptURL)
          || (r.waiting && r.waiting.scriptURL)
          || (r.installing && r.installing.scriptURL)
          || '';
        // Keep our push SW. Unregister anything else (typically the
        // legacy self-destructing SW from before push was added).
        return !url.endsWith('/sw.js');
      })
      .map((r) => r.unregister().catch(() => {}))
    ))
    .catch(() => {});
}

// ─── Boot ─────────────────────────────────────────────────────────────

// (Pull-to-refresh lives in ptr.js — it's installed at document level and
// works on every page including login. No chat-specific PTR needed here.)

// Boot wrapped so a single broken step doesn't strand the page on
// "connecting…" forever. Each step is best-effort; if it throws, we log
// the error visibly in the connection status indicator so the user can
// tell us what to fix.
// Push deep link: when the SW opens /c?project=X after a notification
// tap, fetch the latest session for that project and resume it as a
// fresh tab. That way the banner takes you straight back to the
// conversation Claude just finished, not whichever tab was active last.
//
// Two entry points call this:
//   1) boot() on cold start, reading project from location.search.
//   2) SW postMessage handler when an already-open client receives a
//      `crc-deep-link` event (a notificationclick on iOS that focused
//      this window instead of spawning a new one).
async function _applyPushDeepLink(overrideParams) {
  let project;
  let wantTabId;
  let wantSessionId;
  if (overrideParams && (overrideParams.project || overrideParams.tab || overrideParams.session)) {
    project = overrideParams.project;
    wantTabId = overrideParams.tab;
    wantSessionId = overrideParams.session;
  } else {
    try {
      const params = new URL(location.href).searchParams;
      project = params.get('project');
      wantTabId = params.get('tab');
      wantSessionId = params.get('session');
    } catch { /* fallthrough */ }
  }
  if (!project && !wantTabId && !wantSessionId) return;
  // Strip the params from the address bar so a refresh doesn't keep
  // re-resuming. History API only — no reload.
  try { history.replaceState({}, '', location.pathname); } catch {}
  // Drop the session id if it doesn't look like a claude session UUID
  // (server-side _SESSION_ID_RE is `^[A-Za-z0-9_-]{8,128}$`). A crafted
  // push URL with `?session=<junk>` would otherwise set tab.sessionId
  // to garbage, and the next prompt would ship that garbage as
  // force_session_id — the server rejects it with a 400, but the UX
  // is a confusing error toast. Client-side shape check matches the
  // server's regex so we never store a bogus session ref. Hardening
  // suggested by 2026-05-19 security audit.
  if (wantSessionId && !/^[A-Za-z0-9_-]{8,128}$/.test(wantSessionId)) {
    wantSessionId = undefined;
  }
  // First preference: the SPECIFIC tab the notification was fired for.
  // The bridge stamps `tab=<tab_id>` into the push URL so a project with
  // multiple open tabs lands on the exact conversation that finished,
  // not the first tab it happens to find by project name. Without this
  // the user opens a "done" banner for tab B and lands on tab A's chat,
  // which is the bug they reported 2026-05-19.
  if (wantTabId) {
    try {
      const exact = (State.tabs || []).find((t) => t.id === wantTabId);
      if (exact) {
        switchTab(exact.id);
        return;
      }
    } catch {}
  }
  // Second preference: a local tab whose sessionId matches. Banners are
  // long-lived (iOS notification center keeps them indefinitely), so by
  // the time a HOURS-OLD push is tapped the originating tab may have
  // been closed — but if the user reopened that same session in a
  // different tab via History, we should still land there. The bridge
  // stamps `session=<uuid>` into the push URL exactly for this case.
  if (wantSessionId) {
    try {
      const bySession = (State.tabs || []).find((t) => t.sessionId === wantSessionId);
      if (bySession) {
        switchTab(bySession.id);
        return;
      }
    } catch {}
  }
  // Third preference: no local tab matches by id or session, but we
  // have BOTH a session id and a project from the push — spawn a
  // fresh tab that resumes THAT specific session, not "the most
  // recent session for the project" (which after multiple hours is
  // almost certainly a different conversation). Reported by user
  // 2026-05-19: tapping a 9-hour-old banner landed on a blank new
  // chat instead of the resumed session. Note: requires `project`
  // because createTab + the session-replay endpoint are both scoped
  // by project. Push URLs from the current server always carry
  // project; the (!project) fallthrough below covers any future
  // session-only push variants.
  if (wantSessionId && project) {
    try {
      const tab = createTab(project, { sessionId: wantSessionId });
      _replaySessionInto(tab, project, wantSessionId);
      return;
    } catch (e) {
      console.warn('[push] direct-session resume failed', e);
    }
  }
  if (!project) return;
  // Fourth preference: a tab already open for this project. (Falls
  // through when the original tab was closed AND no session id was
  // carried in the push — we resume the most-recent session for the
  // project below instead.)
  try {
    const existing = (State.tabs || []).find((t) => t.project === project);
    if (existing) {
      switchTab(existing.id);
      return;
    }
  } catch {}
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(project), { headers: CSRF_HEADERS });
    if (!r.ok) {
      createTab(project);
      return;
    }
    const data = await r.json();
    const sessions = (data && Array.isArray(data.sessions)) ? data.sessions : [];
    if (!sessions.length) {
      createTab(project);
      return;
    }
    const s = sessions[0];
    const preTitle = ((s.ai_title || s.preview || '').slice(0, 32).replace(/\s+/g, ' ').trim()) || null;
    const tab = createTab(project, { sessionId: s.session_id, title: preTitle });
    _replaySessionInto(tab, project, s.session_id);
  } catch (e) {
    console.warn('[push] deep-link resume failed', e);
    try { createTab(project); } catch {}
  }
}

// Listen for deep-link messages from the SW notificationclick handler.
// We can't rely on Client.navigate() on iOS PWAs, so the SW posts the
// target params and we act on them in-app — no reload required.
try {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const d = event && event.data;
      if (!d || d.type !== 'crc-deep-link') return;
      try { _applyPushDeepLink(d.params || {}); } catch (e) { console.warn('[push] deep-link from SW failed', e); }
    });
  }
} catch {}

(function boot() {
  function step(name, fn) {
    try { fn(); }
    catch (e) {
      console.error('boot.' + name + ' failed', e);
      const s = document.getElementById('connStatus');
      if (s) {
        s.dataset.state = 'closed';
        s.textContent = 'boot fail: ' + name + ' — ' + (e && e.message ? e.message : e);
      }
    }
  }
  step('freshStart', () => {
    // Tabs persist with TAB_RESTORE_TTL_MS (30 days). Closing the PWA
    // and reopening within the window restores the open tabs (DOM +
    // chat history re-fetched via the existing session-replay flow)
    // and forces --resume on the first prompt so the conversation
    // continues even if the bridge process was restarted in between.
    // _loadTabsFromStorage already handles the expiry sweep.
    const snap = _loadTabsFromStorage();
    if (snap && Array.isArray(snap.tabs) && snap.tabs.length) {
      try { _restoreTabsFromSnapshot(snap); } catch (e) {
        console.error('boot.tabRestore failed', e);
        try { localStorage.removeItem('crc.tabs'); } catch {}
        try { localStorage.removeItem('crc.tabsAt'); } catch {}
      }
    }
    renderTabs();
    applyActiveTabUi();
  });
  step('renderTopbar', renderTopbar);
  step('renderMode', renderMode);
  step('renderSlashPicker', renderSlashPicker);
  step('WS.connect', () => { WS.connect(); });
  // Push-notification deep link. The SW navigates to /c?project=X (and
  // optionally &tab=Y) when the user taps a "Claude finished" banner.
  // Resume the most-recent session for that project as a new tab so
  // the user lands directly on the conversation they were pinged about.
  step('applyPushDeepLink', _applyPushDeepLink);
  // Cold-launch case: the user just tapped the home-screen icon (or a
  // pending notification) and there may be unread "Claude finished"
  // banners still sitting in iOS notification center. Sweep them now
  // so the user isn't told twice about something they came to see.
  // visibilitychange + pageshow handle the warm-resume cases above;
  // this covers the fresh-launch one.
  step('clearStaleNotifs', () => { _clearVisibleNotifications(); });
})();

// Focus input on cold boot (desktop only — on iOS this would force the
// keyboard up immediately, which is annoying).
if (!/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
  input.focus();
}

// Test-surface bridge. Top-level `const` declarations are NOT auto-
// added to `window`, so headless probes invoked via `page.evaluate`
// can't reach the singletons (`TTS`, `Mic`, `Chat`, `State`, etc.).
// Expose them explicitly — but ONLY in probe/dev contexts so the
// production iPhone PWA doesn't carry an extra surface for console
// pokers. The security analyst correctly flagged this as "no security
// delta" (same-origin code already had script access), but the code
// reviewer wanted the visibility scoped. Enable via either:
//   - navigator.webdriver === true   (Playwright / headless drivers set this)
//   - `?probe=1` in the page URL     (manual override for debugging)
//   - localStorage 'crc.testbridge' = '1'
try {
  const _wantTestBridge = (
    (navigator && navigator.webdriver === true) ||
    /\bprobe=1\b/.test(location.search || '') ||
    (function(){ try { return localStorage.getItem('crc.testbridge') === '1'; } catch { return false; } })()
  );
  if (_wantTestBridge) {
    window.TTS = TTS;
    window.Mic = Mic;
    window.Chat = Chat;
    window.State = State;
    window.updateSendButton = updateSendButton;
    window._enterTabDrag = _enterTabDrag;
    window._onTabDragMove = _onTabDragMove;
    window._onTabDragEnd = _onTabDragEnd;
    // Queue-feature handles for the probe (tools/probe_queue.py). Same
    // testbridge gate as everything above — these stay private in real
    // user sessions.
    window.getActiveTab = getActiveTab;
    window.getTab = getTab;
    window.createTab = createTab;
    window.applyActiveTabUi = applyActiveTabUi;
    window.renderTabs = renderTabs;
    window._enqueueCurrentPrompt = _enqueueCurrentPrompt;
    window._drainNextQueuedPrompt = _drainNextQueuedPrompt;
    window._clearQueuedBubbles = _clearQueuedBubbles;
    window._persistTabs = _persistTabs;
    window.switchTab = switchTab;
    window._applyPushDeepLink = _applyPushDeepLink;
    window._renderMarkdown = _renderMarkdown;
    window._deleteUserMessage = _deleteUserMessage;
    window._isMsgDeletedFromHistory = _isMsgDeletedFromHistory;
    window._markMsgDeletedInHistory = _markMsgDeletedInHistory;
  }
} catch {}
