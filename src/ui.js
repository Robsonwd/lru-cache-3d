import { chapters } from './chapters.js';
import { validateCapacity } from './validate.js';

const SPEEDS = [0.5, 1, 2];
const FLASH_MS = 1800;
const CARD_CODE = /^([a-z]\w*\([^)]*\))(:\s)/i;

const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Restart a CSS animation that is driven by a class.
function replay(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

export function createUI(handlers) {
  const root = $('overlay');
  const chapterList = $('chapter-list');
  const modeButtons = [...root.querySelectorAll('#mode-switch button')];
  const opBox = $('op');
  const opText = $('op-text');
  const caption = $('caption');
  const captionLines = [...caption.querySelectorAll('.caption-line')];
  const playPause = $('play-pause');
  const speedButtons = [...root.querySelectorAll('.speed-btn')];
  const statEls = { hits: $('stat-hits'), misses: $('stat-misses'), evictions: $('stat-evictions') };
  const counter = $('counter');
  const counterLabel = $('counter-label');
  const counterValue = $('counter-value');
  const log = $('log');
  const logEmpty = $('log-empty');
  const flash = $('flash');
  const flashNumber = $('flash-number');
  const flashTitle = $('flash-title');
  const veil = $('veil');
  const form = $('sandbox');
  const keyInput = $('key-input');
  const valueInput = $('value-input');
  const fieldErrors = { key: $('key-error'), value: $('value-error') };
  const fieldInputs = { key: keyInput, value: valueInput };
  const capacityInput = $('capacity-input');
  const card = $('card');
  const cardTitle = $('card-title');
  const cardLines = $('card-lines');

  let mode = 'tour';
  let captionText = '';
  let captionFront = 0;
  let capacity = Number(capacityInput.value);
  let flashTimer = 0;
  const lastStats = { hits: 0, misses: 0, evictions: 0 };

  // ----- Chapter list -----
  const chapterButtons = chapters.map((chapter, index) => {
    const item = el('li');
    const button = el('button', 'chapter-btn');
    button.type = 'button';
    button.dataset.chapter = String(index);
    button.setAttribute('aria-label', `Chapter ${index + 1}: ${chapter.title}`);
    button.title = `Chapter ${index + 1}: ${chapter.title}`;
    button.append(el('span', 'chapter-num', pad2(index + 1)), el('span', 'chapter-title', chapter.title));
    button.addEventListener('click', () => handlers.onChapter(index));
    item.append(button);
    chapterList.append(item);
    return button;
  });

  // ----- Controls -----
  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      if (button.dataset.mode !== mode) handlers.onMode(button.dataset.mode);
    });
  }
  playPause.addEventListener('click', () => handlers.onPlayPause());
  $('step-back').addEventListener('click', () => handlers.onStepBack());
  $('step-forward').addEventListener('click', () => handlers.onStepForward());
  for (const button of speedButtons) {
    button.addEventListener('click', () => handlers.onSpeed(Number(button.dataset.speed)));
  }

  // After a submit, the next operation can be typed straight away: focus
  // returns to the key field with its text selected. A rejected submit
  // focuses the field that was rejected instead.
  const submit = (type) => {
    handlers.onSubmit({ type, key: keyInput.value, value: valueInput.value });
    const invalid = Object.values(fieldInputs).find((input) => input.getAttribute('aria-invalid') === 'true');
    const next = invalid ?? keyInput;
    next.focus();
    next.select();
  };
  $('get-btn').addEventListener('click', () => submit('get'));
  $('put-btn').addEventListener('click', () => submit('put'));
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit('get'); }
  });
  valueInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit('put'); }
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  // The capacity field only shows a capacity the app accepted: main.js calls
  // setCapacity() synchronously when it accepts one, so anything else is reverted.
  // Enter commits and the blur that follows fires change: the second request
  // carries the capacity already in force, and an unchanged value is not a
  // change, so neither resets the cache. The comparison is by number, so "04"
  // at capacity 4 is unchanged too.
  function requestCapacity(raw) {
    if (validateCapacity(String(raw).trim()) === capacity) {
      capacityInput.value = String(capacity);
      return;
    }
    handlers.onCapacity(raw);
    if (capacityInput.value !== String(capacity)) {
      capacityInput.value = String(capacity);
      replay(capacityInput, 'is-rejected');
    }
  }
  capacityInput.addEventListener('change', () => requestCapacity(capacityInput.value));
  capacityInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); requestCapacity(capacityInput.value); }
  });
  $('capacity-down').addEventListener('click', () => requestCapacity(String(capacity - 1)));
  $('capacity-up').addEventListener('click', () => requestCapacity(String(capacity + 1)));
  $('reset-btn').addEventListener('click', () => handlers.onReset());

  // ----- Keyboard -----
  // A pointer click must not leave the button focused, or the next Space would
  // press that button again instead of toggling playback.
  root.addEventListener('click', (e) => {
    if (e.detail > 0 && e.target instanceof Element) e.target.closest('button')?.blur();
  });

  const isField = (target) => target instanceof Element && target.closest('input, select, textarea') !== null;
  // A button reached with the keyboard owns Space: its own activation is the only effect.
  const ownsSpace = (target) => target instanceof HTMLButtonElement && target.matches(':focus-visible');
  let swallowSpaceUp = false;

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    if (isField(target)) return;
    if (e.key === ' ' || e.code === 'Space') {
      if (ownsSpace(target)) return;
      e.preventDefault();
      if (e.repeat) return;
      // A button focused some other way must not also activate on keyup.
      swallowSpaceUp = target instanceof HTMLButtonElement;
      handlers.onPlayPause();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      handlers.onStepForward();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      handlers.onStepBack();
    }
  });
  document.addEventListener('keyup', (e) => {
    if ((e.key === ' ' || e.code === 'Space') && swallowSpaceUp) {
      swallowSpaceUp = false;
      e.preventDefault();
    }
  });

  // ----- Methods -----
  function setCaption(text) {
    const next = text ?? '';
    if (next === captionText) return;
    captionText = next;
    const outgoing = captionLines[captionFront];
    outgoing.classList.remove('is-on');
    // Only the line on screen is in the accessibility tree.
    outgoing.setAttribute('aria-hidden', 'true');
    if (next === '') {
      caption.classList.remove('has-text');
      return;
    }
    captionFront = 1 - captionFront;
    const incoming = captionLines[captionFront];
    incoming.textContent = next;
    incoming.removeAttribute('aria-hidden');
    incoming.classList.add('is-on');
    caption.classList.add('has-text');
  }

  function setOp(text) {
    if (text === null || text === undefined || text === '') {
      opBox.classList.remove('is-on');
      return;
    }
    opText.textContent = text;
    opBox.classList.add('is-on');
  }

  function setChapter(index, title, total) {
    chapterButtons.forEach((button, i) => {
      if (i === index) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    flashNumber.textContent = `Chapter ${pad2(index + 1)} / ${pad2(total)}`;
    flashTitle.textContent = title;
    replay(flash, 'is-on');
    // A dip to dark behind the title: it covers the scene being rebuilt for
    // the new chapter, so nothing visibly pops.
    replay(veil, 'is-on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flash.classList.remove('is-on'), FLASH_MS + 100);
  }

  function setMode(next) {
    mode = next;
    root.dataset.mode = next;
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === next));
    }
    form.hidden = next !== 'sandbox';
    $('chapters').hidden = next === 'sandbox';
    if (next === 'sandbox') {
      // The hand-off: the same dip as a chapter change covers the rebuild,
      // the form lights up once, and the key field takes focus, so it is
      // plain that it is the viewer's turn and where to type.
      replay(veil, 'is-on');
      replay(form, 'is-intro');
      keyInput.focus({ preventScroll: true });
    }
  }

  function setPlaying(playing) {
    playPause.classList.toggle('is-paused', !playing);
    playPause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function setSpeed(n) {
    for (const button of speedButtons) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === n && SPEEDS.includes(n)));
    }
  }

  function syncLog() {
    logEmpty.hidden = log.childElementCount > 0;
    log.scrollTop = log.scrollHeight;
    log.classList.toggle('is-overflowing', log.scrollHeight > log.clientHeight + 1);
  }

  function logEntry({ call, kind, outcome }) {
    const item = el('li', 'log-entry');
    item.dataset.kind = kind;
    item.append(el('span', 'log-num', pad2(log.childElementCount + 1)), el('span', 'log-call', call));
    const out = el('span', 'log-outcome');
    const marker = ', evicted ';
    const at = outcome.indexOf(marker);
    if (at >= 0) {
      item.dataset.evicted = '';
      out.append(document.createTextNode(outcome.slice(0, at + 2)), el('span', 'log-evicted', outcome.slice(at + 2)));
    } else {
      out.textContent = outcome;
    }
    item.append(out);
    log.append(item);
    syncLog();
  }

  function truncateLog(count) {
    while (log.childElementCount > Math.max(0, count)) log.lastElementChild.remove();
    syncLog();
  }

  function clearLog() {
    log.replaceChildren();
    syncLog();
  }

  function setStats(stats) {
    for (const name of Object.keys(statEls)) {
      const value = stats[name] ?? 0;
      const node = statEls[name];
      node.textContent = String(value);
      node.classList.toggle('is-zero', value === 0);
      if (value > lastStats[name]) replay(node, 'bump');
      lastStats[name] = value;
    }
  }

  function setCounter(label, n) {
    if (label === null || label === undefined) {
      counter.classList.remove('is-on');
      return;
    }
    counterLabel.textContent = label;
    const text = String(n ?? 0);
    if (counterValue.textContent !== text) {
      counterValue.textContent = text;
      replay(counterValue, 'tick');
    }
    counter.classList.add('is-on');
  }

  function showCard(content) {
    if (!content) {
      card.classList.remove('is-open');
      card.setAttribute('aria-hidden', 'true');
      return;
    }
    cardTitle.textContent = content.title;
    cardLines.replaceChildren(...content.lines.map((line, i) => {
      const item = el('li');
      const text = el('span', 'card-text');
      const match = CARD_CODE.exec(line);
      if (match) {
        text.append(el('span', 'card-code', match[1]), document.createTextNode(line.slice(match[1].length)));
      } else {
        text.textContent = line;
      }
      item.append(el('span', 'card-num', pad2(i + 1)), text);
      return item;
    }));
    card.setAttribute('aria-hidden', 'false');
    replay(card, 'is-open');
  }

  function showFieldError(field, message) {
    for (const name of Object.keys(fieldErrors)) {
      const active = name === field;
      fieldErrors[name].textContent = active ? (message ?? '') : '';
      if (active) fieldInputs[name].setAttribute('aria-invalid', 'true');
      else fieldInputs[name].removeAttribute('aria-invalid');
    }
  }

  function setCapacity(n) {
    capacity = n;
    capacityInput.value = String(n);
  }

  syncLog();
  setStats(lastStats);

  return {
    setCaption,
    setOp,
    setChapter,
    setMode,
    setPlaying,
    setSpeed,
    log: logEntry,
    truncateLog,
    clearLog,
    setStats,
    setCounter,
    showCard,
    showFieldError,
    setCapacity,
  };
}
