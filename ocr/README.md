# Photo → deck scanner

Turns a photo of **physical cards** into a `.ydk` you can play in YGO 2.0. It reads only the **printed text** (never the artwork).

```bash
npm run setup:ocr                       # pip install -r ocr/requirements.txt  (free, local, CPU only — no API keys)
python3 ocr/scan.py photo.jpg -o deck.ydk --annotate marked.jpg
python3 ocr/scan.py a.jpg b.jpg c.jpg -o deck.ydk      # several photos of one deck: counts add up
```
In the game: **My Decks → SCAN PHOTO OF CARDS**. You review every card (fix quantity, swap to an alternative, search for anything it missed), then create the deck.

## Python version
The OCR library (`rapidocr-onnxruntime`) only ships for **Python 3.9 – 3.12**. On a newer system Python (3.13+) `pip` says *"No matching distribution found"*. Check with `python3 --version`. Easiest fix, no sudo and no change to your system Python, using [uv](https://docs.astral.sh/uv/):
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh        # then open a new terminal
uv venv --python 3.12 ocr/.venv                          # downloads Python 3.12 for this folder only
uv pip install --python ocr/.venv/bin/python -r ocr/requirements.txt
npm start                                                # the server finds ocr/.venv by itself (or set PYTHON_BIN=/path/to/python)
```
Check: `ocr/.venv/bin/python -c "import rapidocr_onnxruntime, cv2, rapidfuzz, numpy, PIL; print('ok')"`.

## How it works
1. **Orientation** – test-reads a few tiles at 0/90/180/270°. Sideways photos are fine (your Salamangreat photo was taken sideways).
2. **OCR** – RapidOCR on overlapping, upscaled tiles. Small print is read with the spaces missing, so effect text is re-split into real words using the vocabulary of the card list itself.
3. **Name match** – each text line is fuzzy-matched against **every card name** (BabelCDB `cards.cdb`, or YGOPRODeck with `--api`). A misread like `SALAMANGBEAT PYRO PHOENX` still lands on the right card because the answer must be a real name.
4. **Effect-text check** – words read inside the same card are compared with the official effect. About 3 matching words (or most of the text explained) = **verified**. The effect text also chooses between look-alike names.
5. **Layout checks** – card width is measured from the grid; a card name quoted inside another card's effect is not counted as a card; gaps in the grid are flagged and re-read with a closer crop.

| status | meaning |
|---|---|
| `verified` | name matched **and** the effect text on the card matches the official text |
| `name_only` | name matched confidently, but the effect text was too small to read |
| `review` | uncertain (partial name, or the effect text disagrees) — check it |
| unreadable | a name was seen but not recognised — shown with a crop so you can search for it |

## Getting good results
* ~**8–12 cards per photo**, cards flat, even light, no glare, whole card in view. Effect-text verification needs the card to be about **300+ px tall** in the photo; a 50-card photo only gets names.
* Mixed orientations in one photo: scan them separately.
* English cards (the names must exist in the database). Other languages: `--api --lang fr|de|it|pt` (downloads YGOPRODeck data once and caches it in `ocr/.cache`).

## When it can't read everything
It says so plainly instead of pretending: **"Recognized 44 of about 52 cards (85%)"**, plus the grid position of every card it could not read (e.g. *row 2, column 4*, counted in the marked photo) and a crop of it. In the game you then either photograph **just those cards** again — closer and brighter — and choose **Scan the missing cards** (new photos are *added*), or find them with the search box. Tap ✓ on a crop once it is covered, and the percentage updates.

## Measured on a real photo
50-card photo of a sideways Salamangreat deck, 1200×1600 (WhatsApp-compressed), ~53 cards visible: **"Recognized 44 of about 52 cards (85%)"**: all names correct on a visual check of the ones I could judge, 0 verified by effect text (print too small — it says so), and the 8 missing cards listed by row/column with crops (I checked these positions against the photo: they were the Jack Jaguars, Gazelle, Molt, Parro, Spinny and Raccoon). Faint beige-on-beige names (Jack Jaguar) are the weak spot. Time: ~70 s on 1 CPU core.

## Tests
`npm run test:ocr` (12 tests; the photo tests generate fake photos from the real card list and take ~4 min; `OCR_FAST=1` skips them).

## Limits (honest)
* Not tested with the YGOPRODeck API source or non-English cards (no network in the dev sandbox).
* OCR errors still happen — the review screen exists for that. Always check `review` rows.
* Foil/holo glare and curved sleeves hurt accuracy.
