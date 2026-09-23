'use strict';

/* ------------------------------------------------------------------ *
 * Nekudot — behaviour (Slice 6)
 *
 * Since the Slice 4 notes below: Slice 5 added the language toggle; Slice 6
 * adds the RARE BADGE (localized), fixes the ANSWER-LEAK to screen readers
 * (neutral pictogram alt + aria-hidden answer until reveal), makes the reveal
 * KEYBOARD-operable, and cache-busts the DATA files (CONFIG.dataVersion).
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
  defaultLang: 'en',
  // Cache-buster for the DATA files, the same idea as ?v=NN on style.css /
  // app.js — but the data had none, so a changed JSON could be served stale
  // from the CDN. Bump this whenever a JSON file's contents change.
  dataVersion: '20'
};

/* --- Where the last session is remembered ---
   localStorage is the browser's per-site key-value store; unlike the variables
   in `state` (wiped on unload — the reason the app forgot) it survives a close.
   We write the whole resumable session here after every change and read it back
   on startup.

   Two rules make it robust:
     • The key is namespaced ('nekudot:...') because every repo you publish under
       <you>.github.io shares ONE origin, so a bare key like 'state' could collide
       with another app's store.
     • STATE_SCHEMA versions the SHAPE we store. Bump it whenever that shape
       changes and older, incompatible saves are ignored instead of crashing the
       restore — which is exactly why it reads 2 now that the save grew from "just
       the settings" to "the entire session". */
const STORAGE_KEY = 'nekudot:state';
const STATE_SCHEMA = 2;

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
  order: [],                 // the current lap's card positions (reshuffled each new lap in shuffle mode)
  lapCursor: 0,              // frontier: how far into `order` we've dealt this lap
  trail: [],                 // the cards actually visited, in order — spans laps; Back/Next walk this
  trailPos: 0,               // which trail entry is on screen
  revealed: false,           // is the current card's answer showing?
  seen: new Set()            // ids of cards seen going forward in the CURRENT lap (drives the progress bar)
};

/* --- Start here --- */
async function init() {
  try {
    const v = '?v=' + CONFIG.dataVersion;   // same cache-buster the CSS/JS use
    const [cards, groups, uiStrings] = await Promise.all([
      loadJson(CONFIG.dataPath + 'cards.json' + v),
      loadJson(CONFIG.dataPath + 'groups.json' + v),
      loadJson(CONFIG.dataPath + 'ui-strings.json' + v)
    ]);

    state.cards = cards;
    state.groups = groups;
    state.uiStrings = uiStrings;

    // Restore last session: loadState() applies the saved settings (language,
    // mode, filters) and hands back the saved session object (or null).
    const saved = loadState();

    buildChips();          // one button per group, from the data
    buildLevelMenu();      // one line per level PRESENT in the data
    buildLanguageMenu();   // one line per language the app offers (Slice 5)

    // If the saved session rebuilds cleanly, resume it EXACTLY — same deck order,
    // same visited history, same position, same progress. restoreSession() returns
    // false on any integrity problem (a card id that no longer exists, a pointer
    // out of range), and only THEN do we deal a fresh deck for the restored
    // filters. That fallback is the safety net for a data change between sessions.
    if (!restoreSession(saved)) {
      buildOrder();        // fresh deck + first pass (the original startup path)
    }

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

/* ---------------------------------------------------------------- *
 * Session persistence — remember the whole session across a close
 * ---------------------------------------------------------------- */

/* A card's position (its index in state.cards) from its stable id, or -1.
   Positions are what the deck and trail run on, but a position only means
   something while the data is unchanged — so we STORE ids and rebuild the
   positions here on load. */
function positionOfCard(cardId) {
  return state.cards.findIndex(function (c) { return c.id === cardId; });
}

/* Save the ENTIRE resumable session. Two things can't go into JSON as-is: a
   Set (JSON has no Set type) and a card POSITION (an index that's only valid
   while the data is unchanged). So Sets become arrays, and every position — in
   the deck order and in the visited trail — is written as its card id. Wrapped
   in try/catch so a blocked or full store (e.g. private browsing) degrades to
   "runs without memory" instead of throwing. Called from render(), so the save
   is always current — the reliable choice on mobile, where a backgrounded tab
   can be killed without ever firing an "unload" we could catch. */
function saveState() {
  try {
    const idOf = function (pos) { const c = state.cards[pos]; return c ? c.id : null; };

    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: STATE_SCHEMA,
      // settings
      lang: state.lang,
      mode: state.mode,
      groups: Array.from(state.selectedGroups),
      levels: Array.from(state.selectedLevels),
      // the exact session
      order: state.order.map(idOf),          // the deck ordering (a shuffle permutation, or the in-order list) as ids
      lapCursor: state.lapCursor,            // how far into this lap we've dealt
      trail: state.trail.map(function (e) {  // the visited history, spanning laps, as {id, n, m}
        return { id: idOf(e.card), n: e.n, m: e.m };
      }),
      trailPos: state.trailPos,              // which visited card is on screen
      revealed: state.revealed,              // was the answer showing?
      seen: Array.from(state.seen)           // ids seen this lap → drives the progress bar
    }));
  } catch (e) {
    /* storage unavailable or full — carry on without persistence */
  }
}

/* Read the saved blob back, schema-check it, and apply the SETTINGS (validated).
   Returns the whole saved object for restoreSession() to rebuild from, or null
   when there's nothing usable (first run, corrupt, or an older schema — a v1
   save lands here and is ignored). Runs after the JSON loads (it needs the real
   levels/groups to validate against) and before the deck is built (which must
   see the restored language, mode and filters). */
function loadState() {
  let data;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;                       // first run — nothing saved yet
    data = JSON.parse(raw);
  } catch (e) {
    return null;                                 // unreadable — use defaults
  }
  if (!data || data.v !== STATE_SCHEMA) return null;   // unknown/old shape — ignore

  const langs = LANGUAGES.map(function (l) { return l.code; });
  if (langs.indexOf(data.lang) !== -1) {
    state.lang = data.lang;
    document.documentElement.lang = data.lang;   // keep <html lang> + :lang() CSS honest from first paint
  }
  if (data.mode === 'inorder' || data.mode === 'shuffle') {
    state.mode = data.mode;
  }
  if (Array.isArray(data.levels)) {              // keep only levels that still exist
    const real = new Set(availableLevels());
    state.selectedLevels = new Set(data.levels.filter(function (n) { return real.has(n); }));
  }
  if (Array.isArray(data.groups)) {              // keep only group ids that still exist
    state.selectedGroups = new Set(data.groups.filter(function (id) { return groupById(id); }));
  }

  return data;   // hand the whole thing to restoreSession()
}

/* Rebuild the exact session — deck order, visited history, position, reveal,
   progress — from the saved ids. ALL-OR-NOTHING: if any id no longer exists or
   any pointer is out of range, it restores NOTHING and returns false, so the
   caller deals a clean fresh deck instead. A half-rebuilt session is worse than
   a fresh one, and this is the "never trust persisted data" guard doing the real
   work — it's what stops a data change between sessions from resurrecting a
   broken deck. */
function restoreSession(data) {
  if (!data || !Array.isArray(data.order) || !Array.isArray(data.trail)) return false;
  if (data.order.length === 0 || data.trail.length === 0) return false;   // nothing to resume onto

  // deck order: ids -> positions (one missing id fails the whole restore)
  const order = [];
  for (let i = 0; i < data.order.length; i++) {
    const pos = positionOfCard(data.order[i]);
    if (pos === -1) return false;
    order.push(pos);
  }

  // visited history: {id,n,m} -> {card:position,n,m}
  const trail = [];
  for (let i = 0; i < data.trail.length; i++) {
    const e = data.trail[i];
    if (!e || typeof e.id !== 'string') return false;
    const pos = positionOfCard(e.id);
    if (pos === -1) return false;
    trail.push({ card: pos, n: e.n, m: e.m });
  }

  // pointers must land inside the lists we just rebuilt
  if (!Number.isInteger(data.lapCursor) || data.lapCursor < 0 || data.lapCursor >= order.length) return false;
  if (!Number.isInteger(data.trailPos) || data.trailPos < 0 || data.trailPos >= trail.length) return false;

  state.order = order;
  state.lapCursor = data.lapCursor;
  state.trail = trail;
  state.trailPos = data.trailPos;
  state.revealed = (data.revealed === true);

  const realIds = new Set(state.cards.map(function (c) { return c.id; }));
  state.seen = new Set(Array.isArray(data.seen)
    ? data.seen.filter(function (id) { return realIds.has(id); })
    : []);

  return true;
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
  state.lapCursor = 0;
  state.revealed = false;
  state.seen = new Set();     // per-lap reset — this is what makes the bar restart

  if (state.order.length === 0) {
    state.trail = [];
    state.trailPos = 0;
    return;
  }

  // The trail begins with the first card of the lap; n/m is its slot in the lap,
  // stored so the "Card N / M" line stays right even after you walk back.
  state.trail = [{ card: state.order[0], n: 1, m: state.order.length }];
  state.trailPos = 0;
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
  const entry = state.trail[state.trailPos];
  return entry ? state.cards[entry.card] : undefined;
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

  if (state.trailPos < state.trail.length - 1) {
    // Behind the frontier (we went Back earlier) — re-walk forward through the
    // cards already visited, in the same order, so Next exactly undoes a Back.
    state.trailPos += 1;
  } else {
    // At the frontier — deal the next NEW card. Advance within the lap; when the
    // lap is used up, start a fresh lap (reshuffled in shuffle mode) and restart
    // the progress bar. The old cards stay in the trail, so Back still reaches them.
    state.lapCursor += 1;
    if (state.lapCursor >= state.order.length) {
      if (state.mode === 'shuffle') {
        state.order = shuffle(activePositions());   // fresh random lap, same filters
      }
      state.lapCursor = 0;
      state.seen = new Set();                        // new lap → progress restarts
    }
    state.trail.push({
      card: state.order[state.lapCursor],
      n: state.lapCursor + 1,
      m: state.order.length
    });
    state.trailPos = state.trail.length - 1;
    markCurrentSeen();
  }

  state.revealed = false;
  render();
}

/* Previous: step back; off the first card, wrap to the last — same lap,
   so progress is not reset (going back is reviewing, not restarting). */
function goPrev() {
  if (state.order.length === 0) return;
  if (state.trailPos === 0) return;   // nothing before the first card of the pass — Back does nothing here

  state.trailPos -= 1;                 // step to the ACTUAL previous card, whatever the shuffle did
  state.revealed = false;
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

  saveState();   // persist the whole session after every change (see saveState)
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
  document.documentElement.lang = code;   // keep <html lang> honest + a CSS hook for :lang() rules
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
  // NEUTRAL alt — never localized(card.name). The name is the answer, and alt
  // is spoken before the user reveals; naming the mark here leaks it (Slice 6).
  pictogram.alt = t('card_alt');

  // Revealed text set every render, even while hidden, so it's in place
  // the instant the reveal fades it in.
  const nameEl = document.getElementById('card-name');
  const soundEl = document.getElementById('card-sound');
  nameEl.textContent = localized(card.name);
  soundEl.textContent = localized(card.sound);
  fitSound();   // shrink the sound letter if this string wraps to two lines

  // Rare badge: the boolean decides WHETHER it shows; the localized word (set
  // by applyStaticText from badge_rare) decides WHAT it says. Same on/off cue
  // for a screen reader as visually — a common card has no badge in either.
  document.getElementById('card-badge').hidden = !card.rare;

  const isRevealed = state.revealed;
  document.getElementById('card').classList.toggle('is-revealed', isRevealed);

  // Accessibility: match the a11y tree to what's visually shown. opacity:0
  // still leaves text readable by a screen reader, so we aria-hide the answer
  // until reveal; aria-expanded on the card mirrors the open/closed state.
  document.getElementById('card').setAttribute('aria-expanded', String(isRevealed));
  nameEl.setAttribute('aria-hidden', String(!isRevealed));
  soundEl.setAttribute('aria-hidden', String(!isRevealed));

  const entry = state.trail[state.trailPos];
  const position = t('card_position')
    .replace('{n}', String(entry.n))
    .replace('{m}', String(entry.m));
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

  // The card reveals on any pointer tap; make it keyboard/switch operable too.
  // Enter or Space toggles the reveal. Space is a page-scroll key by default
  // when an element is focused, so preventDefault stops the jump.
  document.getElementById('card').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      toggleReveal();
    }
  });
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
