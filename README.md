# Nekudot — Hebrew vowel-points trainer

A flashcard app for learning Hebrew *nikud* (also written *niqqud*), the vowel points. It has an English, Ukrainian and Russian interface and is designed to be easy to read on a phone, including for older, low-vision learners.

**[Open the app →](https://oksana-kozii.github.io/hebrew-vowels-trainer/)** · **[Read the case study →](https://oksana-kozii.github.io/work/nekudot-rebuild/)**

 [SCREENSHOT](https://oksana-kozii.github.io/assets/img/nekudot/Screenshot_20261122_102347_Firefox.jpg)

## Features

- **29 cards** in 6 vowel groups (A, E, I, O, U, Shva) and 2 difficulty levels
- **Three interface languages:** English, Ukrainian, Russian
- **Filters** by group and by level, which can be combined; rare forms are marked with a badge
- **Shuffle**, with Back and Next that follow the cards you've actually seen
- **Remembers your place:** deck order, history and filters survive closing the app
- **Accessible by design:** text contrast meets WCAG AA, touch targets are 46px, it works with a keyboard (`←` `→` to move, `Enter` or `Space` to reveal, `Esc` to close menus), and the answer stays hidden from screen readers until it's revealed

## How it's built

Plain HTML, CSS and JavaScript, with no frameworks and no build step. It's hosted on GitHub Pages.

The app is a fixed shell that reads all its content from JSON files when it starts, so cards can be added or changed without touching the code.

```
index.html          page structure
style.css           layout and colours
app.js              all behaviour
data/
  cards.json        one entry per card: picture, level, name and sound in each language
  groups.json       the vowel groups and which cards belong to each
  ui-strings.json   every piece of interface text, in all three languages
img/                the vowel-mark pictograms (SVG, hand-drawn)
archive/            the original app, kept for before/after comparison
SOURCES.md          where the vowel data comes from, and the two deliberate departures from it
```

Each fact is stored once. A card's picture and level live in one place, and the three languages hang off the same card ID, so the languages can't drift apart.

## Adding or editing a card

1. Add an entry to `data/cards.json`, following the existing ones (`id`, `picture`, `rare`, `level`, `name`, `sound`).
2. Add the card's `id` to its group's `cardIds` in `data/groups.json`.
3. Put its pictogram in `img/`.
4. Check the new mark, name and sound against the reference in `SOURCES.md` before committing.

## Running it locally

Because the app loads its data with `fetch`, opening `index.html` straight from your files won't work. Serve the folder instead:

```bash
python3 -m http.server
```

Then open `http://localhost:8000`.

## Sources

The vowel set follows the chart in the English Wikipedia article *Niqqud*. Every mark, name and sound was checked against it. See [`SOURCES.md`](SOURCES.md) for the two deliberate departures: simplified pronunciation notation, and one rare form kept from class.

## How it was made

I designed and tested the app; Claude, Anthropic's AI assistant, wrote most of the code to my direction. I kept a log of every significant decision and who drove it, and verified each change on two Android phones and a laptop. The [case study](https://oksana-kozii.github.io/work/nekudot-rebuild/) tells the full story.
