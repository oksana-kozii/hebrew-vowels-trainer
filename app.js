'use strict';

/* ------------------------------------------------------------------ *
 * Nekudot — behaviour (Slice 2)
 * Builds on Slice 1. Adds:
 *   • Reveal in place  — tap the card to fade in its name + sound; tap
 *                        again to hide. A tap does ONE job (log 40): it
 *                        never advances the deck.
 *   • Navigation       — Previous / Next stepper (+ desktop arrow keys).
 *   • Study modes      — In order / Shuffle (a random pass through the
 *                        whole deck, each card once).
 *   • Progress         — a bar + "Viewed: X of Y (Z%)" above the card.
 * Group and difficulty filters, and the language switch, arrive later.
 * ------------------------------------------------------------------ */

/* --- Configuration: the few things set once, in one place. --- */
const CONFIG = {
  dataPath: 'data/',    // where the JSON data files live
  imagePath: 'img/',    // where the pictograms live (the folder path lives here, once)
  defaultLang: 'en'     // default language: English (spec §4.1)
};

/* --- State: everything the running app holds in memory. ---
   ONE source of truth for "which card is showing": the deck is an ORDER
   (a list of card positions) plus a POSITION pointer into it. The card on
   screen is always cards[order[position]] — never a second, separate
   index that could drift out of step with this one. */
const state = {
  cards: [],            // filled from cards.json
  groups: [],           // filled from groups.json (used from the filter slice on)
  uiStrings: {},        // filled from ui-strings.json
  lang: CONFIG.defaultLang,

  mode: 'inorder',      // 'inorder' | 'shuffle'
  order: [],            // card positions, in the order they'll be shown
  position: 0,          // where we are in `order` (0 = the first card)
  revealed: false,      // is the current card's answer showing?
  seen: new Set()       // ids of cards that have been displayed this session
};

/* --- Start here: load the data, build the deck, wire up the controls,
       draw the first card. --- */
async function init() {
  try {
    // Fetch all three files at once, then wait for them together.
    const [cards, groups, uiStrings] = await Promise.all([
      loadJson(CONFIG.dataPath + 'cards.json'),
      loadJson(CONFIG.dataPath + 'groups.json'),
      loadJson(CONFIG.dataPath + 'ui-strings.json')
    ]);

    state.cards = cards;
    state.groups = groups;
    state.uiStrings = uiStrings;

    buildOrder();          // fill state.order for the current mode
    markCurrentSeen();     // the first card is now on screen -> it's "seen"

    applyStaticText();     // the fixed labels: title, tap-hint, button words
    attachEvents();        // make the card, buttons, and arrow keys respond
    render();              // draw everything from state
  } catch (err) {
    showLoadError(err);
  }
}

/* Fetch one JSON file and return the parsed data.
   Throws a clear error if the file is missing or unreadable. */
async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Could not load ' + url + ' (HTTP ' + response.status + ')');
  }
  return response.json();
}

/* Look up an interface string by its language-neutral ID, in the current
   language. Falls back to the default language, then to a visible [id]
   marker — so a missing string is never a silent blank. */
function t(stringId) {
  const entry = state.uiStrings[stringId];
  if (!entry) return '[' + stringId + ']';
  return entry[state.lang] || entry[CONFIG.defaultLang] || '[' + stringId + ']';
}

/* Fill in text that isn't tied to a specific card: the title, the
   tap-hint, and the button labels. Any element with a data-string="..."
   attribute gets that string. Runs once at start-up (and again when the
   language changes, in a later slice). */
function applyStaticText() {
  document.querySelectorAll('[data-string]').forEach(function (el) {
    el.textContent = t(el.dataset.string);
  });
}

/* ---------------------------------------------------------------- *
 * The deck order
 * ---------------------------------------------------------------- */

/* Build state.order for the current mode, and return to the first card.
   In order  -> 0, 1, 2, …            (deck order)
   Shuffle   -> a random permutation of the same positions, so every card
               appears exactly once per pass (a "shuffled bag" — not
               independent random draws, which could repeat one card
               before others appear and make the progress bar meaningless). */
function buildOrder() {
  const positions = state.cards.map(function (_card, i) { return i; });
  state.order = (state.mode === 'shuffle') ? shuffle(positions) : positions;
  state.position = 0;
  state.revealed = false;
}

/* Fisher–Yates shuffle: the standard way to get an unbiased random
   ordering — walk from the end, swapping each item with a random earlier
   one. Returns a NEW array; it doesn't disturb the input. */
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

/* The card currently on screen (found via the order + position). */
function currentCard() {
  return state.cards[state.order[state.position]];
}

/* Record that the current card has been displayed. Uses a Set, so adding
   a card that's already been seen is harmless (idempotent) — the count
   only ever reflects DISTINCT cards seen. */
function markCurrentSeen() {
  const card = currentCard();
  if (card) state.seen.add(card.id);
}

/* ---------------------------------------------------------------- *
 * Actions — what the taps, buttons, and keys do
 * ---------------------------------------------------------------- */

/* Tap the card: show the answer if hidden, hide it if shown.
   This is the ONE thing a tap does — it never moves to another card. */
function toggleReveal() {
  state.revealed = !state.revealed;
  render();
}

/* Next / Previous: step through the order. They STOP at the ends (no
   wrap): Previous is inert on the first card, Next on the last. Each move
   starts the new card hidden again (progressive disclosure). */
function goNext() {
  if (state.position < state.order.length - 1) {
    state.position += 1;
    state.revealed = false;
    markCurrentSeen();
    render();
  }
}

function goPrev() {
  if (state.position > 0) {
    state.position -= 1;
    state.revealed = false;
    render();
  }
}

/* Switch study mode. Rebuilds the order and returns to its first card,
   hidden. (Toggling to Shuffle deals a fresh random pass.) */
function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  buildOrder();
  markCurrentSeen();
  render();
}

/* ---------------------------------------------------------------- *
 * Rendering — draw the screen FROM state. Nothing here decides
 * anything; it only reflects the current state. Call it after any change,
 * and the screen is always a faithful picture of state.
 * ---------------------------------------------------------------- */
function render() {
  renderCard();
  renderProgress();
  renderControls();
}

function renderCard() {
  const card = currentCard();
  if (!card) return;

  // Pictogram: the folder path + the card's bare filename, e.g. img/ + pic01.svg
  const pictogram = document.getElementById('pictogram');
  pictogram.src = CONFIG.imagePath + card.picture;
  pictogram.alt = card.name[state.lang];   // per-card alt text, current language

  // The revealed answer: name (top-left) and sound (beneath the mark).
  // We set the text every time, even while hidden, so the correct words
  // are already in place the instant the reveal fades them in.
  document.getElementById('card-name').textContent = card.name[state.lang];
  document.getElementById('card-sound').textContent = card.sound[state.lang];

  // One class flips both from invisible to visible (the CSS fade).
  document.getElementById('card').classList.toggle('is-revealed', state.revealed);

  // "Card {n} / {m}" — position within the current deck.
  const position = t('card_position')
    .replace('{n}', String(state.position + 1))
    .replace('{m}', String(state.order.length));
  document.getElementById('card-position').textContent = position;
}

function renderProgress() {
  // "Seen" counts DISTINCT cards that have been displayed. In Slice 2 the
  // deck is all 29 cards, so the total is the whole deck. When the filters
  // arrive (Slices 3–4), this is the spot where "seen" gets scoped to the
  // filtered deck — noted here so it isn't missed.
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
  // Ends of the deck: grey out (and disable) the button that has nowhere to go.
  document.getElementById('btn-prev').disabled = (state.position === 0);
  document.getElementById('btn-next').disabled =
    (state.position === state.order.length - 1);

  // Show which study mode is active.
  document.getElementById('mode-inorder')
    .classList.toggle('is-active', state.mode === 'inorder');
  document.getElementById('mode-shuffle')
    .classList.toggle('is-active', state.mode === 'shuffle');
}

/* ---------------------------------------------------------------- *
 * Events — connect the page to the actions, once, at start-up.
 * ---------------------------------------------------------------- */
function attachEvents() {
  document.getElementById('card').addEventListener('click', toggleReveal);
  document.getElementById('btn-prev').addEventListener('click', goPrev);
  document.getElementById('btn-next').addEventListener('click', goNext);
  document.getElementById('mode-inorder')
    .addEventListener('click', function () { setMode('inorder'); });
  document.getElementById('mode-shuffle')
    .addEventListener('click', function () { setMode('shuffle'); });

  // Desktop convenience: Left / Right arrows step the deck (spec §4.5).
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') goNext();
    else if (e.key === 'ArrowLeft') goPrev();
  });
}

/* If the data can't load, say so on screen instead of showing nothing. */
function showLoadError(err) {
  const box = document.getElementById('load-error');
  box.hidden = false;
  box.textContent =
    'Could not load the card data. If you just deployed, check that the ' +
    'JSON files sit in the data/ folder of your repo. (' + err.message + ')';
}

/* Run init once the page structure is ready. */
document.addEventListener('DOMContentLoaded', init);
