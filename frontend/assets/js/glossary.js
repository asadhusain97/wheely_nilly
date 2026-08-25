export function initializeGlossary() {
  const trigger = document.querySelector('#open-glossary');
  const overlay = document.querySelector('#glossary-dialog');
  const sheet = overlay.querySelector('.glossary-sheet');
  const body = overlay.querySelector('.glossary-sheet-body');
  const search = overlay.querySelector('#glossary-search');
  const searchStatus = overlay.querySelector('#glossary-search-status');
  const empty = overlay.querySelector('#glossary-empty');
  const groups = [...overlay.querySelectorAll('.glossary-group')];
  const dragZone = document.querySelector('#glossary-drag-zone');
  const background = [
    document.querySelector('.app-bar'),
    document.querySelector('main'),
    document.querySelector('.bottom-nav'),
  ];
  let lastFocused = null;
  let closeTimer = null;
  let drag = null;

  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const setBackgroundInert = (value) => {
    for (const node of background) node.inert = value;
  };

  function filterGlossary() {
    const query = search.value.trim().toLocaleLowerCase();
    let matches = 0;
    for (const group of groups) {
      const heading = group.querySelector('h3').textContent.toLocaleLowerCase();
      let groupMatches = 0;
      for (const entry of group.querySelectorAll('.glossary-entry')) {
        const visible = !query || `${heading} ${entry.textContent}`.toLocaleLowerCase().includes(query);
        entry.hidden = !visible;
        if (visible) groupMatches += 1;
      }
      group.hidden = groupMatches === 0;
      matches += groupMatches;
    }
    empty.hidden = !query || matches > 0;
    searchStatus.textContent = query ? `${matches} definition${matches === 1 ? '' : 's'} found.` : '';
  }

  function finishClose() {
    clearTimeout(closeTimer);
    overlay.hidden = true;
    overlay.classList.remove('is-dragging');
    sheet.style.transform = '';
    overlay.querySelector('.glossary-backdrop').style.opacity = '';
    document.body.classList.remove('has-modal');
    setBackgroundInert(false);
    if (lastFocused?.isConnected) lastFocused.focus();
  }

  function closeGlossary({ fromDrag = false } = {}) {
    if (overlay.hidden) return;
    trigger.setAttribute('aria-expanded', 'false');
    overlay.classList.remove('is-open', 'is-dragging');
    sheet.style.transform = fromDrag ? 'translateY(100%)' : '';
    overlay.querySelector('.glossary-backdrop').style.opacity = '';
    if (reducedMotion()) finishClose();
    else closeTimer = setTimeout(finishClose, 260);
  }

  function openGlossary() {
    clearTimeout(closeTimer);
    lastFocused = document.activeElement;
    body.scrollTop = 0;
    search.value = '';
    filterGlossary();
    overlay.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.body.classList.add('has-modal');
    setBackgroundInert(true);
    requestAnimationFrame(() => {
      overlay.classList.add('is-open');
      sheet.focus();
    });
  }

  function keepFocusInside(event) {
    if (event.key !== 'Tab' || overlay.hidden) return;
    const focusable = [...sheet.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) {
      event.preventDefault();
      sheet.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && [first, sheet].includes(document.activeElement)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function startDrag(event) {
    if (event.target.closest('button')) return;
    drag = { pointerId: event.pointerId, startY: event.clientY, startedAt: performance.now(), distance: 0 };
    dragZone.setPointerCapture(event.pointerId);
    overlay.classList.add('is-dragging');
  }

  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.distance = Math.max(0, event.clientY - drag.startY);
    sheet.style.transform = `translateY(${drag.distance}px)`;
    overlay.querySelector('.glossary-backdrop').style.opacity = String(Math.max(0.35, 1 - drag.distance / 400));
  }

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const velocity = drag.distance / Math.max(1, performance.now() - drag.startedAt);
    const shouldClose = drag.distance > 88 || (drag.distance > 28 && velocity > 0.55);
    drag = null;
    if (shouldClose) {
      closeGlossary({ fromDrag: true });
      return;
    }
    overlay.classList.remove('is-dragging');
    sheet.style.transform = '';
    overlay.querySelector('.glossary-backdrop').style.opacity = '';
  }

  trigger.addEventListener('click', openGlossary);
  search.addEventListener('input', filterGlossary);
  for (const button of overlay.querySelectorAll('[data-glossary-close]')) {
    button.addEventListener('click', closeGlossary);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) closeGlossary();
    else keepFocusInside(event);
  });
  dragZone.addEventListener('pointerdown', startDrag);
  dragZone.addEventListener('pointermove', moveDrag);
  dragZone.addEventListener('pointerup', endDrag);
  dragZone.addEventListener('pointercancel', endDrag);
}
