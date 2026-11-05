# YGO 2.0

Master Duel-style Yu-Gi-Oh! duel simulator. Combines the two earlier repos:

* **YGO-WASM** → the rules engine (EDOPro `ygopro-core` as WebAssembly + community Lua card scripts), the duel screen and the Master Duel arena theme.
* **YGO 0.0** → the deck builder, `.ydk` upload, duelist decks/avatars/frames, and the **classic card pool** (TCG 2002-03 … 2008-07, 2,884 cards → `data/classic_pool.json`).

## Run
Needs Node 22.13+ (built-in `node:sqlite`, nothing native to compile).

    npm install
    npm run setup     # clones ProjectIgnis/CardScripts + BabelCDB (engine data)
    npm start         # http://localhost:3000
    npm test          # boots a temp server and runs the end-to-end test


## Features
* **Accounts** – sign up / log in. New accounts get five ready Classic decks.
* **Avatar + frame** – chosen on `/profile`, shown to the opponent in duels.
* **Decks** – upload `.ydk` from ygoprodeck.com (auto-detects Classic/Modern, or force one), export, rename, delete. Stored per user in SQLite.
* **Deck builder** – Classic or Modern pool, 40–60 main / 15 extra / 15 side, 3 copies; incomplete decks save as drafts but can't duel.
* **Modes** – *Classic*: classic card pool only, traditional board (no Extra Monster Zones). *Modern*: every card, Extra Monster Zones, Link/Pendulum.
* **Duel** – vs the computer (five duelist decks), quick match, online-player list with invites, invite by username (waits 24 h), or copy-link invites.
* Results and win/loss stats are stored (`matches` table).

## The bots
Six duelists, each with a play style (`PERSONAS` in `bot.js`): **Yugi** (patient, trap-minded, hides sets until Main 2), **Kaiba** (all-out aggression, tributes freely, fuses Blue-Eyes), **Joey** (dice/coin cards first, risky attacks, fights harder when behind), **Mai** (Harpie swarm, Feather Duster/Egotist/Hysteric Party, trap-heavy), **Jesse** (calm Crystal Beast builder, protects Rainbow Dragon), **Jaden** (Fusion first, Elemental HERO aggression; his deck is assembled by card name because the old repos had none).
Shared brain: effect-aware targeting (removal / revival / equip / cost / search), lethal check, trap timing, flip monsters, position management, and in-character lines in the duel log.
`node tools/arena.mjs 3` runs every duelist against every other, headless, and prints a win table (90 games ≈ 3 min).

## Layout
`server.js` routes · `db.js` schema · `auth.js` · `cards.js` card index/pools · `decks.js` ydk/validation/storage · `lobby.js` presence, queue, invites, running duels · `bot.js` computer player · `match.js`/`engine.js`/`prompts.js` engine host (from YGO-WASM) · `views/`, `public/` front end.

## Known limits
* Duels live in memory: a server restart ends running duels (accounts/decks/stats persist).
* Presence/invites use 3-second polling, not WebSockets.
* The bot is heuristic (summon/set/attack/chain), not a search AI; it can lose track in rare prompts and then falls back to passing.
* "Classic" is a card pool + board layout, not a banlist/format (e.g. Goat). `BabelCDB/goat-entries.cdb` could drive that later.

## Disclaimer
YGO 2.0 is an unofficial, non-commercial fan project. It is not affiliated with or endorsed by Konami. Yu-Gi-Oh! and all card names and artwork are property of Konami Digital Entertainment. Card images are fetched at runtime from ygoprodeck.com and are not stored in this repository. 
The project is free and will stay free.
