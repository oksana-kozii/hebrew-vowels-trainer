'use strict';

/* ------------------------------------------------------------------ *
 * Nekudot — behaviour (Slice 1)
 * Loads the data layer (cards, groups, ui-strings) and renders one
 * card: pictogram + "Card N / N". Reveal, filtering, and language
 * switching arrive in later slices.
 * ------------------------------------------------------------------ */

/* --- Configuration: the few things set once, in one place. --- */
const CONFIG = {
  dataPath: 'data/',    // where the JSON data files live
  imagePath: 'img/',    // where the pictograms live (the folder path lives here, once)
  defaultLang: 'en'     // default language: English (spec §4.1)
};

/* --- State: everything the running app holds in memory. --- */
const state = {
  cards: [],            // filled from cards.json
  groups: [],           // filled from groups.json (not shown until the filter slice)
  uiStrings: {},        // filled from ui-strings.json
  lang: CONFIG.defaultLang,
  index: 26             // TEMP for this check: array index 26 = card 027 (Shuruk,
                         // pic27.svg) -- a busier mark, to test the new zoom
                         // against something other than a single centered square.
                         // Revert to 0 once confirmed (or leave for Slice 2, which
                         // makes this a non-issue by adding real navigation).
};

/* --- Start here: load the data, then draw the first card. --- */
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

    applyStaticText();
    renderCard();
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

/* Fill in text that isn't tied to a specific card (just the title for now).
   Any element with a data-string="..." attribute gets that string. */
function applyStaticText() {
  document.querySelectorAll('[data-string]').forEach(function (el) {
    el.textContent = t(el.dataset.string);
  });
}

/* Draw the card at the current index. */
function renderCard() {
  const card = state.cards[state.index];
  if (!card) return;

  // Pictogram: the folder path + the card's bare filename, e.g. img/ + pic01.svg
  const pictogram = document.getElementById('pictogram');
  pictogram.src = CONFIG.imagePath + card.picture;
  pictogram.alt = card.name[state.lang];   // per-card alt text, in the current language

  // "Card {n} / {m}" — position in the current deck (all 29 cards in Slice 1).
  const position = t('card_position')
    .replace('{n}', String(state.index + 1))
    .replace('{m}', String(state.cards.length));
  document.getElementById('card-position').textContent = position;
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
