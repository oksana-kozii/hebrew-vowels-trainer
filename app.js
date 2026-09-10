'use strict';

/* ------------------------------------------------------------------ *
 * Nekudot — behaviour (Slice 3)
 *
 * Slice 2 built the study loop. Slice 3 adds the GROUP FILTER:
 *   • A row of chips built at runtime from groups.json — multi-select.
 *   • The deck becomes the UNION of the selected groups, kept in deck
 *     (card-ID) order, never in chip-tap order.
 *   • "All" means NO group filter. An empty selection means the same
 *     thing, so turning off your last chip lands you back on "All"
 *     rather than on an empty deck — that behaviour falls out of the
 *     rule; there is no special case for it in the code.
 *   • Everything downstream — the progress bar, "Card N / N", wrapping,
 *     shuffle — rescopes to the filtered deck on its own, because all
 *     of it reads state.order, and state.order is now the filtered set.
 * ------------------------------------------------------------------ */

/* --- Configuration --- */
const CONFIG = {
  dataPath: 'data/',
  imagePath: 'img/',
  defaultLang: 'en'
};

/* --- State ---
   One source of truth for "which card": an ORDER (list of card positions)
   plus a POSITION pointer. The card on screen is cards[order[position]].
   New in Slice 3: selectedGroups, the one input the filter reads. */
const state = {
  cards: [],
  groups: [],
  uiStrings: {},
  lang: CONFIG.defaultLang,

  mode: 'inorder',           // 'inorder' | 'shuffle'
  selectedGroups: new Set(), // group ids; EMPTY = no filter = every card
  order: [],                 // card positions, in display order
  position: 0,               // where we are in `order`
  revealed: false,           // is the current card's answer showing?
  seen: new Set()            // ids of cards seen in the CURRENT pass
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

    buildChips();          // one button per group, from the data
    buildOrder();          // builds the filtered order AND starts the first pass
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

/* A content value that varies by language ({en,uk,ru}) — same fallback rule
   as t(), but for card / group data rather than interface text. */
function localized(trio) {
  if (!trio) return '';
  return trio[state.lang] || trio[CONFIG.defaultLang] || '';
}

/* Fill the fixed text (title, tap-hint, button labels, empty-state). */
function applyStaticText() {
  document.querySelectorAll('[data-string]').forEach(function (el) {
    el.textContent = t(el.dataset.string);
  });
}

/* ---------------------------------------------------------------- *
 * The group filter
 * ---------------------------------------------------------------- */

function groupById(id) {
  return state.groups.find(function (group) { return group.id === id; });
}

/* Which card IDs the current group selection allows.
   Returns null for "no filter at all" — a different thing from an empty
   set, and the difference matters: null lets everything through, an empty
   set would let nothing through. */
function allowedCardIds() {
  if (state.selectedGroups.size === 0) return null;

  const ids = new Set();
  state.groups.forEach(function (group) {
    if (!state.selectedGroups.has(group.id)) return;
    group.cardIds.forEach(function (cardId) { ids.add(cardId); });
  });
  return ids;
}

/* Positions of the cards that pass the filter, in DECK order.
   Walking cards.json and testing each card — rather than walking the
   selected groups and collecting their cards — is what keeps the deck in
   card-ID order no matter which chip was tapped first. It also means a
   group pointing at a card ID that doesn't exist simply matches nothing,
   instead of crashing.
   Slice 4 adds the difficulty test to the same `if`. */
function activePositions() {
  const allowed = allowedCardIds();
  const positions = [];
  state.cards.forEach(function (card, i) {
    if (allowed === null || allowed.has(card.id)) positions.push(i);
  });
  return positions;
}

/* Tap a group chip: turn that group on or off, then re-deal. */
function toggleGroup(groupId) {
  if (state.selectedGroups.has(groupId)) {
    state.selectedGroups.delete(groupId);
  } else {
    state.selectedGroups.add(groupId);
  }
  buildOrder();
  render();
}

/* Tap "All": drop the group filter. Already there = nothing happens,
   exactly like tapping the radio button that is already chosen. */
function selectAllGroups() {
  if (state.selectedGroups.size === 0) return;
  state.selectedGroups.clear();
  buildOrder();
  render();
}

/* ---------------------------------------------------------------- *
 * The deck order and the "pass"
 * ---------------------------------------------------------------- */

/* Build the order for the current filter + mode, then start a fresh pass.
   In order -> deck order; Shuffle -> a random permutation (each card once). */
function buildOrder() {
  const positions = activePositions();
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
  if (state.order.length === 0) return;
  state.revealed = !state.revealed;
  render();
}

/* Next: step forward; off the last card, start a NEW lap (reshuffling in
   Shuffle mode). A new lap resets the progress bar.
   Slice 3 fix: the reshuffle now re-deals the FILTERED deck. It used to
   reach for the whole deck — harmless while nothing could filter it, and
   it would have quietly undone the filter the moment something could. */
function goNext() {
  if (state.order.length === 0) return;

  if (state.position < state.order.length - 1) {
    state.position += 1;
    state.revealed = false;
    markCurrentSeen();
  } else {
    if (state.mode === 'shuffle') {
      state.order = shuffle(activePositions());   // fresh random lap, same filter
    }
    startPass();                                  // back to first, progress cleared
  }
  render();
}

/* Previous: step back; off the first card, wrap to the last — same lap,
   so progress is not reset (going back is reviewing, not restarting). */
function goPrev() {
  if (state.order.length === 0) return;

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
  // A filter can in principle select nothing. Groups alone can't do it
  // (an empty selection means "All"), so today this is a safety net rather
  // than a route the learner can take; Slice 4's difficulty filter is what
  // can genuinely empty a deck. Either way the app shows a message instead
  // of a broken card and a "Card 1 / 0".
  const isEmpty = state.order.length === 0;
  document.getElementById('app').classList.toggle('is-empty', isEmpty);
  document.getElementById('empty-state').hidden = !isEmpty;

  renderChips();
  if (!isEmpty) {
    renderCard();
    renderProgress();
  }
  renderControls();
}

/* Build one button per group, plus the "All" chip in front of them.
   Called once — the set of groups doesn't change while the app is open.
   The LABELS are written on every render instead of here, so the language
   toggle in Slice 5 gets them for free. */
function buildChips() {
  const row = document.getElementById('chips');
  row.innerHTML = '';

  row.appendChild(makeChip('all', selectAllGroups));
  state.groups.forEach(function (group) {
    row.appendChild(makeChip(group.id, function () { toggleGroup(group.id); }));
  });
}

function makeChip(id, onClick) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.dataset.group = id;
  // aria-pressed is the standard way to tell a screen reader that a button
  // is an on/off switch, and which way it is currently set.
  chip.setAttribute('aria-pressed', 'false');
  chip.addEventListener('click', onClick);
  return chip;
}

/* Label + on/off state for every chip. "All" is ACTIVE when no group is
   selected — derived, never stored, so it cannot drift out of step with
   the actual selection. */
function renderChips() {
  document.querySelectorAll('#chips .chip').forEach(function (chip) {
    const id = chip.dataset.group;
    const isAll = (id === 'all');
    const group = isAll ? null : groupById(id);

    chip.textContent = isAll ? t('filter_all') : localized(group.name);

    const isActive = isAll
      ? state.selectedGroups.size === 0
      : state.selectedGroups.has(id);
    chip.classList.toggle('is-active', isActive);
    chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function renderCard() {
  const card = currentCard();
  if (!card) return;

  const pictogram = document.getElementById('pictogram');
  pictogram.src = CONFIG.imagePath + card.picture;
  pictogram.alt = localized(card.name);

  // Revealed text set every render, even while hidden, so it's in place
  // the instant the reveal fades it in.
  document.getElementById('card-name').textContent = localized(card.name);
  document.getElementById('card-sound').textContent = localized(card.sound);
  fitSound();   // shrink the sound letter if this string wraps to two lines

  document.getElementById('card').classList.toggle('is-revealed', state.revealed);

  const position = t('card_position')
    .replace('{n}', String(state.position + 1))
    .replace('{m}', String(state.order.length));
  document.getElementById('card-position').textContent = position;
}

/* The two-line rule: measure the sound letter at full size; if it has
   wrapped onto a second line (a long string like Shva), add .is-two-line
   so it shrinks. Short single-glyph sounds never trip it, so they keep the
   full 3.4rem cap. Re-run on every render and on resize (orientation). */
function fitSound() {
  const el = document.getElementById('card-sound');
  if (!el) return;
  el.classList.remove('is-two-line');                 // measure at full size
  const fontSize = parseFloat(getComputedStyle(el).fontSize);
  // Height taller than ~1.5 lines (line-height 1.1) means it wrapped.
  if (el.scrollHeight > fontSize * 1.1 * 1.5) {
    el.classList.add('is-two-line');
  }
}

function renderProgress() {
  // "Seen" = distinct cards viewed in the CURRENT pass, out of the CURRENT
  // filtered deck. Both numbers come from state.order, so the bar rescoped
  // itself the moment the filter started shaping that list.
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

  // Card width can change (orientation) — re-check whether the sound wraps.
  window.addEventListener('resize', fitSound);
}

function showLoadError(err) {
  const box = document.getElementById('load-error');
  box.hidden = false;
  box.textContent =
    'Could not load the card data. If you just deployed, check that the ' +
    'JSON files sit in the data/ folder of your repo. (' + err.message + ')';
}

document.addEventListener('DOMContentLoaded', init);
