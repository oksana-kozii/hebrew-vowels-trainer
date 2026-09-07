'use strict';

/* ------------------------------------------------------------------ *
 * Nekudot — behaviour (Slice 2, revised)
 * Reveal in place, navigation, study modes, and progress — now with:
 *   • Wrapping — Previous / Next never dead-end. Next off the last card
 *     loops to the first (In order) or deals a fresh shuffled lap
 *     (Shuffle); Previous off the first wraps to the last.
 *   • Per-pass progress — "seen" is scoped to the current lap and resets
 *     whenever a new lap starts or the mode changes.
 * ------------------------------------------------------------------ */

/* --- Configuration --- */
const CONFIG = {
  dataPath: 'data/',
  imagePath: 'img/',
  defaultLang: 'en'
};

/* --- State ---
   One source of truth for "which card": an ORDER (list of card positions)
   plus a POSITION pointer. The card on screen is cards[order[position]]. */
const state = {
  cards: [],
  groups: [],
  uiStrings: {},
  lang: CONFIG.defaultLang,

  mode: 'inorder',      // 'inorder' | 'shuffle'
  order: [],            // card positions, in display order
  position: 0,          // where we are in `order`
  revealed: false,      // is the current card's answer showing?
  seen: new Set()       // ids of cards seen in the CURRENT pass
};

/* --- Start here --- */
async function init() {
  try {
    const [cards, groups, uiStrings] = await Promise.all([
      loadJson(CONFIG.dataPath + 'cards.json'),
      loadJson(CONFIG.dataPath + 'groups.json'),
      loadJson(CONFIG.dataPath + 'ui-strings.json')
    ]);

    state.cards = cards;
    state.groups = groups;
    state.uiStrings = uiStrings;

    buildOrder();          // builds the order AND starts the first pass
    applyStaticText();     // fixed labels: title, tap-hint, button words
    attachEvents();
    render();
  } catch (err) {
    showLoadError(err);
  }
}

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Could not load ' + url + ' (HTTP ' + response.status + ')');
  }
  return response.json();
}

/* Interface string by language-neutral ID, with an English fallback. */
function t(stringId) {
  const entry = state.uiStrings[stringId];
  if (!entry) return '[' + stringId + ']';
  return entry[state.lang] || entry[CONFIG.defaultLang] || '[' + stringId + ']';
}

/* Fill the fixed text (title, tap-hint, button labels). */
function applyStaticText() {
  document.querySelectorAll('[data-string]').forEach(function (el) {
    el.textContent = t(el.dataset.string);
  });
}

/* ---------------------------------------------------------------- *
 * The deck order and the "pass"
 * ---------------------------------------------------------------- */

/* Every card position, 0..n-1, in deck order. */
function allPositions() {
  return state.cards.map(function (_card, i) { return i; });
}

/* Build the order for the current mode, then start a fresh pass.
   In order -> deck order; Shuffle -> a random permutation (each card once). */
function buildOrder() {
  const positions = allPositions();
  state.order = (state.mode === 'shuffle') ? shuffle(positions) : positions;
  startPass();
}

/* Begin a new pass: back to the first card, hidden, progress cleared. */
function startPass() {
  state.position = 0;
  state.revealed = false;
  state.seen = new Set();     // per-pass reset — this is what makes the bar restart
  markCurrentSeen();
}

/* Fisher–Yates shuffle: unbiased random ordering. Returns a new array. */
function shuffle(input) {
  const a = input.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

function currentCard() {
  return state.cards[state.order[state.position]];
}

/* Record the current card as seen this pass (a Set, so it's idempotent —
   revisiting a card never double-counts). */
function markCurrentSeen() {
  const card = currentCard();
  if (card) state.seen.add(card.id);
}

/* ---------------------------------------------------------------- *
 * Actions
 * ---------------------------------------------------------------- */

/* Tap the card: reveal if hidden, hide if shown. Never advances. */
function toggleReveal() {
  state.revealed = !state.revealed;
  render();
}

/* Next: step forward; off the last card, start a NEW lap (reshuffling in
   Shuffle mode). A new lap resets the progress bar. */
function goNext() {
  if (state.position < state.order.length - 1) {
    state.position += 1;
    state.revealed = false;
    markCurrentSeen();
  } else {
    if (state.mode === 'shuffle') {
      state.order = shuffle(allPositions());   // fresh random lap
    }
    startPass();                               // back to first, progress cleared
  }
  render();
}

/* Previous: step back; off the first card, wrap to the last — same lap,
   so progress is not reset (going back is reviewing, not restarting). */
function goPrev() {
  state.position = (state.position > 0)
    ? state.position - 1
    : state.order.length - 1;
  state.revealed = false;
  markCurrentSeen();
  render();
}

/* Switch study mode: rebuild the order and start a fresh pass. */
function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  buildOrder();
  render();
}

/* ---------------------------------------------------------------- *
 * Rendering — draw the screen FROM state.
 * ---------------------------------------------------------------- */
function render() {
  renderCard();
  renderProgress();
  renderControls();
}

function renderCard() {
  const card = currentCard();
  if (!card) return;

  const pictogram = document.getElementById('pictogram');
  pictogram.src = CONFIG.imagePath + card.picture;
  pictogram.alt = card.name[state.lang];

  // Revealed text set every render, even while hidden, so it's in place
  // the instant the reveal fades it in.
  document.getElementById('card-name').textContent = card.name[state.lang];
  document.getElementById('card-sound').textContent = card.sound[state.lang];

  document.getElementById('card').classList.toggle('is-revealed', state.revealed);

  const position = t('card_position')
    .replace('{n}', String(state.position + 1))
    .replace('{m}', String(state.order.length));
  document.getElementById('card-position').textContent = position;
}

function renderProgress() {
  // "Seen" = distinct cards viewed in the CURRENT pass. Deck is all 29 in
  // Slice 2; when filters arrive, total and seen scope to the filtered deck.
  const total = state.order.length;
  const seen = state.seen.size;
  const percent = total ? Math.round((seen / total) * 100) : 0;

  document.getElementById('progress-fill').style.width = percent + '%';
  document.getElementById('progress-line').textContent = t('progress_viewed')
    .replace('{seen}', String(seen))
    .replace('{total}', String(total))
    .replace('{percent}', String(percent));
}

function renderControls() {
  // Drive the sliding switch: one class moves the pill, colours the active
  // label, and shows its check. Prev / Next never disable (the deck wraps).
  const mode = document.querySelector('.mode');
  mode.classList.toggle('is-inorder', state.mode === 'inorder');
  mode.classList.toggle('is-shuffle', state.mode === 'shuffle');
}

/* ---------------------------------------------------------------- *
 * Events
 * ---------------------------------------------------------------- */
function attachEvents() {
  document.getElementById('card').addEventListener('click', toggleReveal);
  document.getElementById('btn-prev').addEventListener('click', goPrev);
  document.getElementById('btn-next').addEventListener('click', goNext);
  document.getElementById('mode-inorder')
    .addEventListener('click', function () { setMode('inorder'); });
  document.getElementById('mode-shuffle')
    .addEventListener('click', function () { setMode('shuffle'); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') goNext();
    else if (e.key === 'ArrowLeft') goPrev();
  });
}

function showLoadError(err) {
  const box = document.getElementById('load-error');
  box.hidden = false;
  box.textContent =
    'Could not load the card data. If you just deployed, check that the ' +
    'JSON files sit in the data/ folder of your repo. (' + err.message + ')';
}

document.addEventListener('DOMContentLoaded', init);
