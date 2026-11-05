/**
 * DeckInventory.js
 *
 * The single place that reads and writes deck_inventory/*.json.
 *
 * A deck file is { mainDeck, extraDeck, sideDeck } (what gimmeDeck.js
 * produces from a .ydk upload). This module also understands two
 * optional extra fields so decks get a proper display name:
 *
 *   name:      shown in the deck picker (falls back to a derived name)
 *   createdAt: ISO timestamp
 *
 * Old files without those fields keep working unchanged.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "deck_inventory");

const KNOWN_NAMES = { yugi: "Yugi's Deck", kaiba: "Kaiba's Deck" };

/**
 * Duelists. `portrait` lives in views/images (served at /images). A deck gets an owner either from an
 * explicit `owner` field in its json, from its file id (yugi.json ...), or - for decks that were
 * uploaded without a name - from signature cards. Custom decks can pick any owner in the builder.
 */
const OWNERS = {
    yugi:  { name: "Yugi",  portrait: "/images/YamiYugi-MDDG.png", sig: [/^Dark Magician$/, /^Gaia The Fierce Knight$/, /^Summoned Skull$/] },
    kaiba: { name: "Kaiba", portrait: "/images/Kaiba-MDDG.png",    sig: [/^Blue-Eyes White Dragon$/, /^Obelisk the Tormentor$/, /^Heart of the Underdog$/] },
    joey:  { name: "Joey",  portrait: "/images/Joey-MDDG.png",     sig: [/^Gilford the Lightning$/, /^Masaki the Legendary Swordsman$/, /^Flame Manipulator$/] },
    mai:   { name: "Mai",   portrait: "/images/Mai-MDDG.png",      sig: [/^Harpie Lady/, /^Harpie's Pet Dragon$/, /^Harpie Queen$/] },
    jesse: { name: "Jesse", portrait: "/images/Jesse-MDDG.png",    sig: [/^Rainbow Dragon$/, /^Rose Papillon$/, /^Crystal Beast /] },
    jaden: { name: "Jaden", portrait: "/images/Jaden-MDDG.png",    sig: [/^Elemental HERO /, /^Polymerization$/] }
};
const OWNER_IDS = Object.keys(OWNERS);

/** Every picture in views/images/avatar, as /images/avatar/<file> URLs (usable for decks and for your duelist). */
const AVATAR_DIR = path.join(__dirname, "views", "images", "avatar");
function avatars() {
    try {
        return fs.readdirSync(AVATAR_DIR).filter(f => /\.(png|gif|jpe?g|webp)$/i.test(f)).sort()
            .map(f => ({ file: f, url: "/images/avatar/" + encodeURIComponent(f), name: f.replace(/-DAR.*$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/#U00e9/g, "é") }));
    } catch (e) { return []; }
}
/** Icon frames (views/images/frames) that can surround a round avatar. */
const FRAME_DIR = path.join(__dirname, "views", "images", "frames");
function frames() { try { return fs.readdirSync(FRAME_DIR).filter(f => /\.png$/i.test(f)).sort(); } catch (e) { return []; } }
function cleanFrame(f) { return typeof f === "string" && frames().includes(f) ? f : null; }
/** The frame each duelist's deck wears by default (the user's own choice always wins). */
const OWNER_FRAMES = {
    yugi: "Dark_Magical_Circle-Icon_Frame-Master_Duel.png", kaiba: "Blue-Eyes_White_Dragon-Icon_Frame-Master_Duel.png",
    joey: "Link_Master_Frame-Icon_Frame-Master_Duel.png", mai: "Flock_Together-Icon_Frame-Master_Duel.png",
    jesse: "Frost_Frame-Icon_Frame-Master_Duel.png", jaden: "Neon_Sign-Icon_Frame-Master_Duel.png"
};
/** Accept only an avatar url that really exists in that folder (no path tricks). */
function cleanAvatar(u) {
    if (!u || typeof u !== "string") return null;
    const m = /^\/images\/avatar\/([^/]+)$/.exec(u); if (!m) return null;
    const f = decodeURIComponent(m[1]);
    return avatars().some(a => a.file === f) ? "/images/avatar/" + encodeURIComponent(f) : null;
}

/** Which duelist does this deck belong to? Returns an OWNERS key or null. */
function ownerOf(id, deck) {
    if (deck && OWNERS[deck.owner]) return deck.owner;
    if (OWNERS[id]) return id;
    const names = (deck.mainDeck || []).concat(deck.extraDeck || []).map(c => c.name);
    let best = null, bestN = 0;
    for (const [k, o] of Object.entries(OWNERS)) {
        const n = names.filter(nm => o.sig.some(re => re.test(nm))).length;
        if (n > bestN) { best = k; bestN = n; }
    }
    return bestN >= 4 ? best : null;
}
const GENERIC_WORDS = new Set([
    "the", "of", "and", "dragon", "dragons", "warrior", "knight", "monster", "card", "dark", "light",
    "magician", "beast", "with", "from", "swordsman", "lady", "girl", "king", "queen"
]);

function ensureDir() {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function safeId(id) {
    return /^[A-Za-z0-9_\-]+$/.test(String(id || "")) ? String(id) : null;
}

function fileFor(id) {
    const s = safeId(id);
    return s ? path.join(DIR, s + ".json") : null;
}

function isMonster(c) { return /Monster/.test(c.type || ""); }
function isSpell(c) { return /Spell/.test(c.type || ""); }
function isTrap(c) { return /Trap/.test(c.type || ""); }

/** Best-effort readable name for a deck that was never given one. */
function deriveName(id, deck) {
    if (KNOWN_NAMES[id]) return KNOWN_NAMES[id];
    const monsters = (deck.mainDeck || []).filter(isMonster);

    // 1. Most common archetype among the whole main deck.
    const arch = {};
    (deck.mainDeck || []).forEach(c => { if (c.archetype) arch[c.archetype] = (arch[c.archetype] || 0) + 1; });
    const topArch = Object.entries(arch).sort((a, b) => b[1] - a[1])[0];
    if (topArch && topArch[1] >= Math.max(5, (deck.mainDeck || []).length * 0.25)) return `${topArch[0]} Deck`;

    // 2. A distinctive shared word in monster names.
    const words = {};
    monsters.forEach(c => {
        new Set(c.name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !GENERIC_WORDS.has(w)))
            .forEach(w => { words[w] = (words[w] || 0) + 1; });
    });
    const topWord = Object.entries(words).sort((a, b) => b[1] - a[1])[0];
    if (topWord && topWord[1] >= Math.max(4, monsters.length * 0.3)) {
        return `${topWord[0][0].toUpperCase()}${topWord[0].slice(1)} Deck`;
    }

    // 3. Signature card: most copies, then highest level.
    const copies = {};
    monsters.forEach(c => { copies[c.name] = copies[c.name] || { n: 0, lv: c.level || 0 }; copies[c.name].n++; });
    const sig = Object.entries(copies).sort((a, b) => b[1].n - a[1].n || b[1].lv - a[1].lv)[0];
    return sig ? `${sig[0]} Deck` : `Deck ${id}`;
}

/** The card whose art best represents the deck (shown as the "deck case"). */
function pickCover(deck) {
    const all = [...(deck.mainDeck || []), ...(deck.extraDeck || [])];
    const rank = c => {
        if (!isMonster(c)) return -1;
        return (c.atk || 0) + (c.level || 0) * 100 + (/Fusion|Ritual/.test(c.type) ? 500 : 0);
    };
    const best = all.slice().sort((a, b) => rank(b) - rank(a))[0];
    const img = best && best.card_images && best.card_images[0];
    return img ? { name: best.name, image: img.image_url_cropped || img.image_url_small || img.image_url } : null;
}

function summarize(id, deck, extra = {}) {
    const main = deck.mainDeck || [];
    const extraDeck = deck.extraDeck || [];
    const side = deck.sideDeck || [];
    const warnings = [];
    if (main.length < 40) warnings.push(`Main Deck has ${main.length} cards (40–60 recommended)`);
    if (main.length > 60) warnings.push(`Main Deck has ${main.length} cards (max 60)`);
    if (extraDeck.length > 15) warnings.push(`Extra Deck has ${extraDeck.length} cards (max 15)`);
    const counts = {};
    main.forEach(c => { counts[c.name] = (counts[c.name] || 0) + 1; });
    const over = Object.entries(counts).filter(([, n]) => n > 3).map(([k]) => k);
    if (over.length) warnings.push(`More than 3 copies of: ${over.join(", ")}`);
    const owner = ownerOf(id, deck);
    return {
        id,
        owner,
        ownerName: owner ? OWNERS[owner].name : null,
        avatar: cleanAvatar(deck.avatar),
        portrait: cleanAvatar(deck.avatar) || (owner ? OWNERS[owner].portrait : null),
        frame: cleanFrame(deck.frame) || (owner ? OWNER_FRAMES[owner] : null) || null,
        builtin: !!OWNERS[id],
        custom: !!deck.custom,
        name: deck.name || deriveName(id, deck),
        customName: !!deck.name,
        createdAt: deck.createdAt || null,
        counts: {
            main: main.length, extra: extraDeck.length, side: side.length,
            monsters: main.filter(isMonster).length,
            spells: main.filter(isSpell).length,
            traps: main.filter(isTrap).length
        },
        cover: pickCover(deck),
        topCards: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => ({ name: n, copies: c })),
        warnings,
        ...extra
    };
}

function readDeck(id) {
    const file = fileFor(id);
    if (!file || !fs.existsSync(file)) return null;
    const deck = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(deck.mainDeck)) throw new Error(`Deck "${id}" has no mainDeck array`);
    deck.extraDeck = deck.extraDeck || [];
    deck.sideDeck = deck.sideDeck || [];
    return deck;
}

function list(decorate) {
    ensureDir();
    const out = [];
    for (const f of fs.readdirSync(DIR)) {
        if (!f.endsWith(".json") || f.startsWith("_")) continue;
        const id = f.slice(0, -5);
        try {
            const deck = readDeck(id);
            const mtime = fs.statSync(path.join(DIR, f)).mtimeMs;
            const s = summarize(id, deck, { mtime });
            if (decorate) Object.assign(s, decorate(deck, s));
            out.push(s);
        } catch (e) {
            out.push({ id, name: id, broken: true, error: e.message, counts: { main: 0, extra: 0, side: 0 }, warnings: [e.message] });
        }
    }
    // Built-in duelists first, then newest uploads first.
    return out.sort((a, b) => {
        const ab = OWNERS[a.id] ? 0 : 1, bb = OWNERS[b.id] ? 0 : 1;
        return ab - bb || (b.mtime || 0) - (a.mtime || 0);
    });
}

function save(deckJson, name) {
    ensureDir();
    const deck = cleanDeck(deckJson);
    if (name) deck.name = String(name).trim().slice(0, 60);
    deck.createdAt = deck.createdAt || new Date().toISOString();
    let id = `deck_${Date.now()}`;
    while (fs.existsSync(fileFor(id))) id += "x";
    fs.writeFileSync(fileFor(id), JSON.stringify(deck, null, 2), "utf8");
    return id;
}

/** Normalise what the builder / uploader hands us into a stored deck. */
function cleanDeck(d) {
    const keep = c => (c && typeof c === "object") ? c : null;
    const arr = a => (Array.isArray(a) ? a.map(keep).filter(Boolean) : []);
    const out = { mainDeck: arr(d.mainDeck), extraDeck: arr(d.extraDeck), sideDeck: arr(d.sideDeck) };
    if (d.name) out.name = String(d.name).trim().slice(0, 60);
    if (OWNERS[d.owner]) out.owner = d.owner;
    const av = cleanAvatar(d.avatar); if (av) out.avatar = av;
    const fr = cleanFrame(d.frame); if (fr) out.frame = fr;
    if (d.custom) out.custom = true;
    if (d.createdAt) out.createdAt = d.createdAt;
    return out;
}

/** Overwrite an existing deck (builder "Save"). Keeps createdAt, stamps updatedAt. */
function update(id, deckJson) {
    const old = readDeck(id);
    if (!old) return false;
    const deck = cleanDeck({ ...old, ...deckJson, createdAt: old.createdAt });
    deck.updatedAt = new Date().toISOString();
    fs.writeFileSync(fileFor(id), JSON.stringify(deck, null, 2), "utf8");
    return true;
}

function rename(id, name) {
    const deck = readDeck(id);
    if (!deck) return false;
    deck.name = String(name || "").trim().slice(0, 60) || undefined;
    fs.writeFileSync(fileFor(id), JSON.stringify(deck, null, 2), "utf8");
    return true;
}

function remove(id) {
    const file = fileFor(id);
    if (!file || !fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
}

module.exports = { frames, cleanFrame, OWNER_FRAMES, avatars, cleanAvatar, DIR, OWNERS, OWNER_IDS, ownerOf, list, readDeck, save, update, rename, remove, summarize, deriveName, safeId };
