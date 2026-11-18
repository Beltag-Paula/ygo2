"""carddb.py — the card list the scanner matches against (names + effect text + Extra Deck flag).

Two sources, same interface:
  * CardDB.from_cdb(path)   BabelCDB/cards.cdb that the YGO 2.0 game engine already uses (offline, instant, English).
  * CardDB.from_api(cache)  https://db.ygoprodeck.com/api/v7/cardinfo.php, cached on disk (any language YGOPRODeck supports).
Passcodes are identical in both, so a scanned deck imports straight into the game.
"""
from __future__ import annotations
import json, os, re, sqlite3, time, unicodedata, urllib.request
from dataclasses import dataclass

EXTRA_BITS = 0x40 | 0x2000 | 0x800000 | 0x4000000          # Fusion | Synchro | Xyz | Link (cdb type flags)
_CONFUSABLE = str.maketrans({"0": "O", "1": "I", "L": "I", "5": "S", "8": "B", "2": "Z"})   # things OCR mixes up
STOP = set("""this that your with from have each when than then only also once turn cards card there their they them will
that's into onto other another during after before while until where which would could should these those whose being
been does done more most such both either neither same least next every""".split())


def fold(s: str) -> str:
    """Case/punctuation/accent-insensitive key, with look-alike characters merged (0/O, 1/I/L, 5/S, 8/B, 2/Z)."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().upper()
    return re.sub(r"[^A-Z0-9]", "", s).translate(_CONFUSABLE)


def tokens(s: str) -> set[str]:
    """Distinctive lowercase words (4+ letters, no filler) used to compare effect text."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return {w for w in re.findall(r"[a-z]{4,}", s) if w not in STOP}


@dataclass
class Card:
    id: int
    name: str
    desc: str
    extra: bool


class CardDB:
    def __init__(self, cards: list[Card], source: str = ""):
        self.source = source
        self.cards: dict[int, Card] = {c.id: c for c in cards}
        self.by_key: dict[str, list[int]] = {}
        for c in cards:
            k = fold(c.name)
            if k:
                self.by_key.setdefault(k, []).append(c.id)
        self.keys = list(self.by_key)
        self._tok: dict[int, set[str]] = {}
        df: dict[str, int] = {}                      # in how many cards' effect text does each word appear?
        for c in cards:
            t = self._tok[c.id] = tokens(c.desc)
            for w in t:
                df[w] = df.get(w, 0) + 1
        self.df, self.n = df, max(1, len(cards))

    def __len__(self):
        return len(self.cards)

    def desc_tokens(self, cid: int) -> set[str]:
        return self._tok[cid]

    # ------------------------------------------------------------------ word segmentation (OCR often drops spaces in small print)
    def _vocab(self):
        if getattr(self, "_wcost", None) is None:
            import math, collections
            cnt = collections.Counter(w for c in self.cards.values() for w in re.findall(r"[a-z]+", c.desc.lower()))
            tot = sum(cnt.values()); self._wcost = {w: -math.log(n / tot) for w, n in cnt.items()}
            self._wmax = 24
        return self._wcost

    def segment(self, text: str) -> list[str]:
        """'effect.Shuffleeitheryouroryour' -> ['effect','shuffle','either','your','or','your'] using the words found on real cards."""
        cost = self._vocab(); out = []
        for chunk in re.findall(r"[a-z]+", unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()):
            n = len(chunk); best = [0.0] + [1e9] * n; back = [0] * (n + 1)
            for i in range(1, n + 1):
                for k in range(max(0, i - self._wmax), i):
                    w = chunk[k:i]; c = best[k] + cost.get(w, 14 + 5 * len(w))
                    if c < best[i]:
                        best[i], back[i] = c, k
            i = n; seg = []
            while i > 0:
                seg.append(chunk[back[i]:i]); i = back[i]
            out += seg[::-1]
        return out

    def letters(self, cid: int) -> str:
        if not hasattr(self, "_let"):
            self._let = {}
        if cid not in self._let:
            self._let[cid] = re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", self.cards[cid].desc).encode("ascii", "ignore").decode().lower())
        return self._let[cid]

    def distinctive(self, words) -> set[str]:
        """Words that identify a card. 'monster', 'graveyard', 'destroy'... appear on most cards and prove nothing, so only words
        found in under 4% of all cards count (unknown/garbled words are kept: they may be rare names OCR split apart)."""
        return {w for w in words if self.df.get(w, 0) <= 0.04 * self.n}

    # ------------------------------------------------------------------ loaders
    @classmethod
    def from_cdb(cls, path: str) -> "CardDB":
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        rows = con.execute("""SELECT d.id, d.alias, d.type, t.name, t.desc FROM datas d JOIN texts t ON t.id = d.id
                              WHERE (d.type & 0x4000) = 0 AND t.name IS NOT NULL AND t.name != ''""").fetchall()
        con.close()
        cards = [Card(i, n, d or "", bool(t & EXTRA_BITS)) for i, a, t, n, d in rows if not (a and abs(a - i) < 10)]   # skip alt-art copies
        return cls(cards, f"cdb:{os.path.basename(path)}")

    @classmethod
    def from_api(cls, cache_path: str, lang: str = "en", max_age_days: float = 7) -> "CardDB":
        """YGOPRODeck asks apps to cache: one download per week by default."""
        if not (os.path.exists(cache_path) and time.time() - os.path.getmtime(cache_path) < max_age_days * 86400):
            url = "https://db.ygoprodeck.com/api/v7/cardinfo.php" + (f"?language={lang}" if lang != "en" else "")
            req = urllib.request.Request(url, headers={"User-Agent": "ygo2-scanner/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
            os.makedirs(os.path.dirname(os.path.abspath(cache_path)), exist_ok=True)
            with open(cache_path, "wb") as f:
                f.write(raw)
        data = json.load(open(cache_path, encoding="utf-8"))["data"]
        cards = []
        for it in data:
            t = it.get("type", "")
            if "Token" in t or "Skill" in t:
                continue
            cards.append(Card(int(it["id"]), it["name"], it.get("desc", ""), any(k in t for k in ("Fusion", "Synchro", "XYZ", "Link"))))
        return cls(cards, f"ygoprodeck:{lang}")
