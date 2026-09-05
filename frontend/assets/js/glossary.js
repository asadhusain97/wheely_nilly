const LONG_PRESS_DURATION_MS = 300;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

export function createGlossaryTerm(label, term = label, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ['glossary-term', className].filter(Boolean).join(' ');
  button.dataset.glossaryTerm = term;
  button.textContent = label;
  button.title = `Press and hold for the ${label} definition`;
  button.setAttribute('aria-label', `${label}. Open definition in glossary`);
  return button;
}

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
  let termPress = null;
  let suppressClickFor = null;
  let suspendedDialog = null;
  let glossaryWasInert = false;

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
    suppressClickFor = null;
    overlay.hidden = true;
    overlay.classList.remove('is-dragging', 'is-above-modal');
    sheet.style.transform = '';
    overlay.querySelector('.glossary-backdrop').style.opacity = '';
    document.body.classList.toggle('has-modal', Boolean(suspendedDialog));
    setBackgroundInert(Boolean(suspendedDialog));
    if (suspendedDialog) {
      overlay.inert = glossaryWasInert;
      suspendedDialog.inert = false;
    }
    if (lastFocused?.isConnected) lastFocused.focus();
    suspendedDialog = null;
    glossaryWasInert = false;
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

  function openGlossary(term = '', source = document.activeElement) {
    clearTimeout(closeTimer);
    lastFocused = source;
    suspendedDialog = source?.closest?.('#settings-editor-dialog') ?? null;
    glossaryWasInert = overlay.inert;
    if (suspendedDialog) {
      suspendedDialog.inert = true;
      overlay.inert = false;
      overlay.classList.add('is-above-modal');
    }
    body.scrollTop = 0;
    search.value = term;
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

  function glossaryTermFromEvent(event) {
    const target = event.target.closest?.('[data-glossary-term]');
    return target?.dataset.glossaryTerm ? target : null;
  }

  function cancelTermPress() {
    if (!termPress) return;
    clearTimeout(termPress.timer);
    termPress.target.classList.remove('is-pressing');
    if (termPress.target.hasPointerCapture?.(termPress.pointerId)) {
      termPress.target.releasePointerCapture(termPress.pointerId);
    }
    termPress = null;
  }

  function startTermPress(event) {
    const target = glossaryTermFromEvent(event);
    if (!target || event.button !== 0 || event.isPrimary === false) return;
    cancelTermPress();
    const press = {
      target,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      opened: false,
      timer: null,
    };
    press.timer = setTimeout(() => {
      if (termPress !== press) return;
      suppressClickFor = target;
      press.opened = true;
      target.classList.remove('is-pressing');
      openGlossary(target.dataset.glossaryTerm, target);
    }, LONG_PRESS_DURATION_MS);
    termPress = press;
    target.classList.add('is-pressing');
    target.setPointerCapture?.(event.pointerId);
  }

  function moveTermPress(event) {
    if (!termPress || event.pointerId !== termPress.pointerId) return;
    if (termPress.opened) return;
    const distance = Math.hypot(event.clientX - termPress.startX, event.clientY - termPress.startY);
    if (distance > LONG_PRESS_MOVE_TOLERANCE_PX) cancelTermPress();
  }

  function endTermPress(event) {
    if (!termPress || event.pointerId !== termPress.pointerId) return;
    if (termPress.opened) event.preventDefault();
    cancelTermPress();
  }

  function handleTermClick(event) {
    const target = glossaryTermFromEvent(event);
    if (!target) return;
    event.preventDefault();
    if (suppressClickFor === target) {
      suppressClickFor = null;
      return;
    }
    if (event.detail === 0) openGlossary(target.dataset.glossaryTerm, target);
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

  trigger.addEventListener('click', () => openGlossary('', trigger));
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
  document.addEventListener('pointerdown', startTermPress);
  document.addEventListener('pointermove', moveTermPress);
  document.addEventListener('pointerup', endTermPress);
  document.addEventListener('pointercancel', endTermPress);
  document.addEventListener('click', handleTermClick);
  document.addEventListener('contextmenu', (event) => {
    if (glossaryTermFromEvent(event)) event.preventDefault();
  });
}
