'use strict';

/* ------------------------------------------------------------------ *
 * Nekudot — behaviour (Slice 4)
 *
 * Slice 2 built the study loop. Slice 3 added the GROUP FILTER. Slice 4
 * adds the DIFFICULTY FILTER, and it is deliberately the group filter's
 * TWIN, not a new mechanism:
 *   • Difficulty is a second FACET. Levels are OR-ed with each other,
 *     groups are OR-ed with each other, and the two results are AND-ed —
 *     the standard "(Level 1 OR Level 2) AND (group A OR group B)" model.
 *   • The deck is the UNION of the chosen levels, kept in deck (card-ID)
 *     order, exactly as the group union already was.
 *   • ONE place the two facets diverge, on purpose: an empty GROUP
 *     selection means "all groups", but an empty LEVEL selection falls to
 *     {Level 1} — a real filter, not "all". Levels are ordinal (there is a
 *     floor to stand on); groups are nominal (no natural first one). So a
 *     fresh app opens on Level 1, and turning off your last level lands you
 *     back on Level 1, never on an empty deck.
 *   • The Level menu is DATA-DRIVEN: its lines are the distinct level
 *     values present in the cards, sorted — never a hard-coded {1,2,3}.
 *     Add a card that carries level 3 and a "Level 3" line appears on its
 *     own.
 *   • The menu's checked state is DERIVED from the effective level set,
 *     never stored — the same trick the "All" chip uses. That is why
 *     Level 1 shows checked whenever nothing is selected: the deck on
 *     screen *is* level-1-only, so the menu must say so.
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
   Slice 3 added selectedGroups; Slice 4 adds selectedLevels — the two
   inputs the filter reads. */
const state = {
  cards: [],
  groups: [],
  uiStrings: {},
  lang: CONFIG.defaultLang,

  mode: 'inorder',           // 'inorder' | 'shuffle'
  selectedGroups: new Set(), // group ids; EMPTY = no filter = every group
  selectedLevels: new Set(), // level numbers; EMPTY = {Level 1}, NOT "all"
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
    buildLevelMenu();      // one line per level PRESENT in the data
    buildLanguageMenu();   // one line per language the app offers (Slice 5)
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
 * The group filter (facet 1)
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

/* ---------------------------------------------------------------- *
 * The difficulty filter (facet 2) — the twin of the group facet
 * ---------------------------------------------------------------- */

/* The distinct levels present in the cards, sorted ascending. This is what
   the Level menu is built from — never a hard-coded list — so the set of
   lines always matches the data. A card carrying a brand-new level makes a
   brand-new line appear with no code change. */
function availableLevels() {
  const set = new Set();
  state.cards.forEach(function (card) { set.add(card.level); });
  return Array.from(set).sort(function (a, b) { return a - b; });
}

/* The level set the filter actually uses right now.
   The one divergence from groups: an empty selection is NOT "allow all" —
   it falls to {Level 1}. Everything reads from THIS set: the filter below,
   and the menu's checked state. Because the menu reads the effective set
   (not the raw selection), Level 1 shows checked whenever nothing is
   chosen — the display can't drift from what's on screen. */
function effectiveLevels() {
  return state.selectedLevels.size > 0 ? state.selectedLevels : new Set([1]);
}

/* ---------------------------------------------------------------- *
 * Combining the two facets
 * ---------------------------------------------------------------- */

/* Positions of the cards that pass BOTH facets, in DECK order.
   Walking cards.json and testing each card — rather than walking the
   selected groups/levels and collecting their cards — is what keeps the
   deck in card-ID order no matter which chip or level was tapped first. It
   also means a group pointing at a card ID that doesn't exist simply
   matches nothing, instead of crashing.
   The two tests are the same shape (set membership), pointed at different
   fields, and both must pass — OR within each facet, AND across them. */
function activePositions() {
  const allowed = allowedCardIds();   // group facet: null = "all groups"
  const levels  = effectiveLevels();  // level facet: never "all"; empty -> {1}

  const positions = [];
  state.cards.forEach(function (card, i) {
    const inGroups = (allowed === null) || allowed.has(card.id); // OR within groups
    const inLevels = levels.has(card.level);                     // OR within levels
    if (inGroups && inLevels) positions.push(i);                 // AND across facets
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

/* Tap a level line: turn that level on or off, then re-deal.
   There is no "All levels" clear button and none is needed — the empty =
   {Level 1} rule IS the reset. Turn off your last level and you land on
   Level 1, never on nothing. Selecting every level is how you get "all". */
function toggleLevel(level) {
  if (state.selectedLevels.has(level)) {
    state.selectedLevels.delete(level);
  } else {
    state.selectedLevels.add(level);
  }
  buildOrder();
  render();
}

/* ---------------------------------------------------------------- *
 * The deck order and the "pass"
 * ---------------------------------------------------------------- */

/* Build the order for the current filters + mode, then start a fresh pass.
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
   The reshuffle re-deals activePositions(), so it respects BOTH facets on
   its own — nothing here had to change for Slice 4. */
function goNext() {
  if (state.order.length === 0) return;

  if (state.position < state.order.length - 1) {
    state.position += 1;
    state.revealed = false;
    markCurrentSeen();
  } else {
    if (state.mode === 'shuffle') {
      state.order = shuffle(activePositions());   // fresh random lap, same filters
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
  // With two facets live, a filter CAN now select nothing — e.g. the Shva
  // group (one level-1 card) with only Level 2 chosen. The app shows the
  // empty-state message instead of a broken card and a "Card 1 / 0".
  const isEmpty = state.order.length === 0;
  document.getElementById('app').classList.toggle('is-empty', isEmpty);
  document.getElementById('empty-state').hidden = !isEmpty;

  renderChips();
  renderLevelMenu();        // both facets' controls stay reachable, empty or not
  renderLanguageMenu();     // the switcher's check follows state.lang (Slice 5)
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

/* Build one line per level PRESENT in the data (availableLevels), each a
   toggle. Built once — the levels in the data don't change while the app is
   open. Labels + checks are written on every render (renderLevelMenu), the
   same derive-the-display pattern the chips use, so Slice 5's language
   toggle relabels them for free. Each line carries a check that reserves
   its slot even when hidden, so toggling never reflows the row. */
function buildLevelMenu() {
  const panel = document.getElementById('level-panel');
  panel.innerHTML = '';

  availableLevels().forEach(function (level) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'level-opt';
    opt.dataset.level = String(level);
    opt.setAttribute('aria-pressed', 'false');

    const label = document.createElement('span');
    label.className = 'level-opt-label';   // filled (localized) on render

    const check = document.createElement('span');
    check.className = 'level-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
      'stroke="currentColor" stroke-width="3" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';

    opt.appendChild(label);
    opt.appendChild(check);
    opt.addEventListener('click', function () { toggleLevel(level); });
    panel.appendChild(opt);
  });
}

/* Label + checked state for every level line, read from the EFFECTIVE set.
   Reading the effective set (not the raw selection) is what makes Level 1
   show checked when nothing is selected: the deck is level-1-only, so the
   menu says so. Same reason the "All" chip lights with nothing selected. */
function renderLevelMenu() {
  const effective = effectiveLevels();
  document.querySelectorAll('#level-panel .level-opt').forEach(function (opt) {
    const level = Number(opt.dataset.level);
    opt.querySelector('.level-opt-label').textContent =
      t('level_n').replace('{n}', String(level));

    const isOn = effective.has(level);
    opt.classList.toggle('is-selected', isOn);
    opt.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  });
}

/* Open / close the Level fold-out. aria-expanded tells a screen reader
   whether the panel is showing; the caret rotation is the visual echo. */
function toggleLevelMenu() {
  closeLanguageMenu();       // only one corner menu open at a time
  const menu = document.getElementById('level-menu');
  const isOpen = menu.classList.toggle('is-open');
  document.getElementById('level-menu-btn')
    .setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function closeLevelMenu() {
  const menu = document.getElementById('level-menu');
  if (!menu.classList.contains('is-open')) return;
  menu.classList.remove('is-open');
  document.getElementById('level-menu-btn').setAttribute('aria-expanded', 'false');
}

/* ---------------------------------------------------------------- *
 * The language menu (Slice 5) — the mirror of the Level menu, in the
 * title row's right cell. SINGLE-select, not multi: exactly one language
 * is active, so tapping a line SETS the language rather than toggling it.
 * The checked state is DERIVED from state.lang — the same trick the chips
 * and levels use, so the check can't drift from the language on screen.
 * ---------------------------------------------------------------- */

/* The languages the app offers, in display order. Each line's label is the
   language's OWN name (its autonym) — English, Українська, Русский — which
   reads the same whatever the current UI language is. So, unlike the level
   lines, these labels are set once (below), not re-written on every render. */
const LANGUAGES = [
  { code: 'en', labelId: 'lang_option_en' },
  { code: 'uk', labelId: 'lang_option_uk' },
  { code: 'ru', labelId: 'lang_option_ru' }
];

/* Build one line per language. Built once — the list never changes while the
   app is open. Labels are the autonyms (identical across UI languages), so
   they are written here; only the CHECK moves when you switch language. */
function buildLanguageMenu() {
  const panel = document.getElementById('lang-panel');
  panel.innerHTML = '';

  LANGUAGES.forEach(function (language) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'lang-opt';
    opt.dataset.lang = language.code;
    opt.setAttribute('aria-pressed', 'false');

    const label = document.createElement('span');
    label.className = 'lang-opt-label';
    label.textContent = t(language.labelId);   // the autonym — language-independent

    const check = document.createElement('span');
    check.className = 'lang-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
      'stroke="currentColor" stroke-width="3" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';

    opt.appendChild(check);   // check BEFORE the label — mirrors the Level menu
    opt.appendChild(label);   // (space-between then pushes the label to the right)
    opt.addEventListener('click', function () { setLang(language.code); });
    panel.appendChild(opt);
  });
}

/* Checked state for every language line, derived from state.lang. */
function renderLanguageMenu() {
  document.querySelectorAll('#lang-panel .lang-opt').forEach(function (opt) {
    const isOn = (opt.dataset.lang === state.lang);
    opt.classList.toggle('is-selected', isOn);
    opt.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  });
}

/* Switch the whole app's language. Single-select: set, don't toggle.
   Most of the app already relabels itself on every render (chips, card text,
   the level lines all read state.lang through localized() / t()), so render()
   sweeps them up for free. The exception is the FIXED text written once at
   startup — the title, tap-hint, Prev/Next, the mode words, the empty-state,
   and the two menu buttons — so applyStaticText() has to run again here. Every
   string still lives in exactly one place; this re-reads them, never copies. */
function setLang(code) {
  if (code === state.lang) { closeLanguageMenu(); return; }
  state.lang = code;
  applyStaticText();     // the fixed labels that don't redraw on their own
  closeLanguageMenu();
  render();              // everything derived (chips, card, level lines) follows
}

function toggleLanguageMenu() {
  closeLevelMenu();          // only one corner menu open at a time
  const menu = document.getElementById('lang-menu');
  const isOpen = menu.classList.toggle('is-open');
  document.getElementById('lang-menu-btn')
    .setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function closeLanguageMenu() {
  const menu = document.getElementById('lang-menu');
  if (!menu || !menu.classList.contains('is-open')) return;
  menu.classList.remove('is-open');
  document.getElementById('lang-menu-btn').setAttribute('aria-expanded', 'false');
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
  // itself the moment the filters started shaping that list.
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

  // The Level menu button toggles the fold-out. stopPropagation keeps this
  // click from immediately reaching the document handler below (which would
  // otherwise close what we just opened).
  document.getElementById('level-menu-btn')
    .addEventListener('click', function (e) {
      e.stopPropagation();
      toggleLevelMenu();
    });

  // The language button mirrors the level button. stopPropagation keeps this
  // click from reaching the document handler that would close what we opened.
  document.getElementById('lang-menu-btn')
    .addEventListener('click', function (e) {
      e.stopPropagation();
      toggleLanguageMenu();
    });

  // A click anywhere outside a menu closes THAT menu — the expected behaviour
  // for a pop-out. A click INSIDE a panel (on a line) is left to bubble, so you
  // can read the options without the menu snapping shut. Both corner menus are
  // checked, each closing only when the click lands outside itself.
  document.addEventListener('click', function (e) {
    const levelMenu = document.getElementById('level-menu');
    if (levelMenu && !levelMenu.contains(e.target)) closeLevelMenu();
    const langMenu = document.getElementById('lang-menu');
    if (langMenu && !langMenu.contains(e.target)) closeLanguageMenu();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') goNext();
    else if (e.key === 'ArrowLeft') goPrev();
    else if (e.key === 'Escape') { closeLevelMenu(); closeLanguageMenu(); }
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
