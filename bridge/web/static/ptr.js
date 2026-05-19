// Pull-to-refresh.
//
// Earlier removed because the threshold was low enough to trigger on
// accidental short pulls. Re-enabled with a tighter trigger so the
// gesture only fires when the user clearly intends to refresh:
//
//   - touchstart must be within the chat scroll area (not topbar, tabs,
//     or composer)
//   - the chat must already be at scrollTop == 0 (you've scrolled to
//     the oldest message)
//   - the pull must exceed a deliberate threshold (PTR_THRESHOLD)
//   - no sheet / drawer is open (those have their own swipe-to-close
//     gestures; we don't want both to fight for the same swipe)
//
// On trigger we location.reload() the whole page — the bridge does
// no-store HTTP headers so reload gets the freshest HTML / JS / CSS.

(() => {
  const PTR_THRESHOLD = 150;   // px; was 80 — raised to prevent accidents
  const FAST_FLICK_PX = 60;
  const FAST_FLICK_MS = 200;
  const INDICATOR_FADE_MS = 200;
  const indicator = document.createElement('div');
  indicator.className = 'ptr-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = '↻';   // ↻ glyph
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(indicator));

  let dragging = false;
  let startY = 0;
  let pull = 0;
  let startedAt = 0;

  function sheetOrDrawerOpen() {
    // If any overlay is showing, don't intercept the gesture — sheets
    // have their own drag-to-close handling.
    const drawer = document.getElementById('sessionsDrawer');
    if (drawer && !drawer.hidden) return true;
    const sheets = document.querySelectorAll('.sheet');
    for (const s of sheets) {
      if (!s.hidden) return true;
    }
    return false;
  }

  function inChatScrollAtTop(node) {
    // Walk up from the touched node to find the chat scroll container.
    // PTR fires only when the chat IS the scroll container AND it's at
    // the very top (scrollTop <= 0). Touches in topbar / tabs / composer
    // simply don't match.
    let n = node;
    while (n) {
      if (n.id === 'chat') return n.scrollTop <= 0;
      if (n.scrollHeight > n.clientHeight + 1) return false;
      n = n.parentElement;
    }
    return false;
  }

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (sheetOrDrawerOpen()) return;
    if (!inChatScrollAtTop(e.target)) return;
    dragging = true;
    startY = e.touches[0].clientY;
    pull = 0;
    startedAt = Date.now();
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) {
      pull = 0;
      indicator.style.opacity = '0';
      indicator.style.transform = 'translate(-50%, 0) rotate(0deg)';
      dragging = false;
      return;
    }
    pull = dy;
    const ratio = Math.min(1, pull / PTR_THRESHOLD);
    indicator.style.opacity = String(ratio);
    indicator.style.transform = `translate(-50%, ${Math.min(70, pull * 0.55)}px) rotate(${ratio * 360}deg)`;
  }, { passive: true });

  function finish() {
    if (!dragging) return;
    dragging = false;
    const elapsed = Date.now() - startedAt;
    const fastFlick = pull > FAST_FLICK_PX && elapsed < FAST_FLICK_MS;
    if (fastFlick || pull > PTR_THRESHOLD) {
      indicator.style.opacity = '1';
      indicator.style.transform = 'translate(-50%, 70px) rotate(720deg)';
      setTimeout(() => location.reload(), 180);
      return;
    }
    indicator.style.transition = `opacity ${INDICATOR_FADE_MS}ms, transform ${INDICATOR_FADE_MS}ms`;
    indicator.style.opacity = '0';
    indicator.style.transform = 'translate(-50%, 0) rotate(0deg)';
    setTimeout(() => { indicator.style.transition = ''; }, INDICATOR_FADE_MS + 40);
  }
  document.addEventListener('touchend', finish, { passive: true });
  document.addEventListener('touchcancel', finish, { passive: true });
})();
