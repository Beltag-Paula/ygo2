#!/usr/bin/env python3
"""scan.py — turn a photo of physical Yu-Gi-Oh! cards into a .ydk deck for YGO 2.0.

How it works (text only — the artwork is ignored):
  1. Orientation: cards photographed sideways/upside-down are detected by test-reading a few tiles at 0/90/180/270°.
  2. OCR: the photo is cut into overlapping tiles, each upscaled, and read with RapidOCR (free, local, CPU).
  3. Name match: every text line is fuzzy-matched against the full card list (YGOPRODeck / BabelCDB names). Because the
     answer must be a real card name, mis-read letters ("SALAMANGBEAT PYRO PHOENX") still land on the right card.
  4. Effect-text check: words OCR'd inside the same card (below its name) are compared with the official effect text.
     3+ matching words = "verified". The effect text also breaks ties between look-alike names.
  5. Output: one row per card with a status (verified / name_only / review), alternatives, and a ready .ydk.

    python ocr/scan.py photo.jpg -o deck.ydk --annotate marked.jpg
"""
from __future__ import annotations

import argparse, json, os, re, sys, time
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps
from rapidfuzz import fuzz, process

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carddb import CardDB, fold, tokens, STOP   # noqa: E402

ROT = {0: None, 90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}
CARD_W_PER_NAME_H = 13.0      # a card is ~13x as wide as its name text is tall (measured on real photos; override with --card-width)
RANK = {"review": 0, "name_only": 1, "verified": 2}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


@dataclass
class Line:
    text: str
    conf: float
    x0: float
    y0: float
    x1: float
    y1: float
    h: float          # text height (short side of the OCR box)

    @property
    def cx(self): return (self.x0 + self.x1) / 2
    @property
    def cy(self): return (self.y0 + self.y1) / 2
    @property
    def area(self): return max(1.0, (self.x1 - self.x0) * (self.y1 - self.y0))


def overlap(a: Line, b: Line) -> float:
    iw = min(a.x1, b.x1) - max(a.x0, b.x0); ih = min(a.y1, b.y1) - max(a.y0, b.y0)
    return 0.0 if iw <= 0 or ih <= 0 else iw * ih / min(a.area, b.area)


def load_image(path: str):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")     # phones store rotation in EXIF
    if max(im.size) > 6000:
        im.thumbnail((6000, 6000))
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)


def rotated(img, deg):
    return img if ROT[deg] is None else cv2.rotate(img, ROT[deg])


def cluster1d(vals, tol):
    """Group sorted numbers that are within `tol` of the previous one; returns the group means."""
    groups = []
    for v in sorted(vals):
        if groups and v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g) / len(g) for g in groups]


def grid_labels(points, targets, cw):
    """'row 2, column 4' for each target position, counted among all card-name positions in the (corrected) photo.
    None when the cards do not form a grid."""
    allp = list(points) + list(targets)
    if len(allp) < 4:
        return [None] * len(targets)
    cols = cluster1d([p[0] for p in allp], 0.35 * cw); rows = cluster1d([p[1] for p in allp], 0.30 * cw)
    if len(cols) < 2 and len(rows) < 2:
        return [None] * len(targets)
    near = lambda arr, v: min(range(len(arr)), key=lambda i: abs(arr[i] - v)) + 1
    return [f"row {near(rows, y)}, column {near(cols, x)}" for x, y in targets]


def card_crop(img, x, y, cw):
    """JPEG data-URL of the card whose name starts at (x, y): lets the user see what could not be read."""
    import base64
    x0, y0 = int(max(0, x - 0.1 * cw)), int(max(0, y - 0.12 * cw)); x1, y1 = int(min(img.shape[1], x0 + 1.05 * cw)), int(min(img.shape[0], y0 + 1.5 * cw))
    c = img[y0:y1, x0:x1]
    if c.size == 0:
        return None
    s = min(3.0, 260 / c.shape[0]); c = cv2.resize(c, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    return "data:image/jpeg;base64," + base64.b64encode(cv2.imencode(".jpg", c, [cv2.IMWRITE_JPEG_QUALITY, 72])[1].tobytes()).decode()


def missing_cells(img, points, cw):
    """Photos of decks are usually laid out in a grid. Where the grid has a hole, a card was probably there but its
    title was unreadable (glare, faint print). Only reported when the grid is clearly regular (>=60% of cells read)."""
    if len(points) < 8:
        return []
    cols = cluster1d([p[0] for p in points], 0.35 * cw); rows = cluster1d([p[1] for p in points], 0.30 * cw)
    if len(cols) < 3 or len(rows) < 2 or len(points) / (len(cols) * len(rows)) < 0.6:
        return []
    out = []
    for cy in rows:
        in_row = [px for px, py in points if abs(py - cy) < 0.5 * cw]
        last_row = cy == rows[-1]
        for cx in cols:
            if last_row and in_row and cx > max(in_row) + 0.5 * cw:
                continue                                    # an unfinished last row is normal, not a hole
            if not any(abs(px - cx) < 0.5 * cw and abs(py - cy) < 0.5 * cw for px, py in points):
                near = sorted(((px, py) for px, py in points if abs(py - cy) < 0.5 * cw), key=lambda q: abs(q[0] - cx))[:2]
                ycell = cy
                if len(near) == 2 and abs(near[1][0] - near[0][0]) > 0.5 * cw:      # row may tilt: follow the two nearest names in it
                    (x1, y1), (x2, y2) = near; ycell = y1 + (y2 - y1) * (cx - x1) / (x2 - x1)
                elif near:
                    ycell = near[0][1]
                out.append({"x": int(cx), "y": int(ycell), "crop": card_crop(img, cx, ycell, cw)})
    return out


class Scanner:
    def __init__(self, db: CardDB, min_score: float = 80, card_width: float | None = None, verbose: bool = True):
        self.db, self.min_score, self.card_width, self.verbose = db, min_score, card_width, verbose
        self._ocr = None

    def say(self, *a):
        if self.verbose:
            log(*a)

    @property
    def ocr(self):
        if self._ocr is None:
            from rapidocr_onnxruntime import RapidOCR
            self._ocr = RapidOCR()
        return self._ocr

    # ------------------------------------------------------------------ OCR
    @staticmethod
    def _scale(img):          # small photos are upscaled more than big ones: text should be ~30px tall for the OCR
        return float(np.clip(4800 / max(img.shape[:2]), 1.0, 3.0))

    @staticmethod
    def _windows(w, h, tile):
        stride = int(tile * 0.75)
        xs = list(range(0, max(1, w - tile) + 1, stride)); ys = list(range(0, max(1, h - tile) + 1, stride))
        if xs[-1] + tile < w: xs.append(max(0, w - tile))
        if ys[-1] + tile < h: ys.append(max(0, h - tile))
        return [(x, y) for y in ys for x in xs]

    def _read(self, img, x0, y0, tile, scale, cls=True):
        crop = img[y0:y0 + tile, x0:x0 + tile]
        up = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        res, _ = self.ocr(up, use_cls=cls)
        out = []
        for box, txt, conf in (res or []):
            p = np.array(box, float) / scale + [x0, y0]
            side1, side2 = np.linalg.norm(p[1] - p[0]), np.linalg.norm(p[2] - p[1])
            out.append(Line(txt, float(conf), p[:, 0].min(), p[:, 1].min(), p[:, 0].max(), p[:, 1].max(), min(side1, side2)))
        return out

    def read_image(self, img):
        scale = self._scale(img); tile = int(2000 / scale); wins = self._windows(img.shape[1], img.shape[0], tile)
        lines = []
        for i, (x, y) in enumerate(wins, 1):
            self.say(f"  OCR tile {i}/{len(wins)}")
            lines += self._read(img, x, y, tile, scale)
        return lines

    # ------------------------------------------------------------------ matching
    def candidates(self, text, limit=6):
        q = fold(text)
        if len(q) < 4:
            return []
        out = []
        for key, score, _ in process.extract(q, self.db.keys, scorer=fuzz.ratio, limit=limit, score_cutoff=65):
            out += [(cid, float(score)) for cid in self.db.by_key[key][:2]]
        return out[:limit + 2]

    def pick_rotation(self, img):
        """Read the two most text-rich tiles at each rotation; the right one makes real card names."""
        scores = {}
        for deg in ROT:
            r = rotated(img, deg); scale = self._scale(r); tile = int(2000 / scale)
            wins = self._windows(r.shape[1], r.shape[0], tile)
            gray = cv2.cvtColor(r, cv2.COLOR_BGR2GRAY)
            energy = lambda xy: float(np.abs(cv2.Sobel(gray[xy[1]:xy[1] + tile:2, xy[0]:xy[0] + tile:2], cv2.CV_32F, 1, 1)).mean())
            sel = sorted(wins, key=energy, reverse=True)[:2]
            names, small_lines = [], []
            for x, y in sel:
                # no 180° "fix-up": upside-down text must come out as gibberish here, that is the signal
                for ln in self._read(r, x, y, tile, scale, cls=False):
                    c = self.candidates(ln.text, 1)
                    horizontal = (ln.x1 - ln.x0) > 1.5 * (ln.y1 - ln.y0)
                    if ln.conf >= 0.6 and c and c[0][1] >= 88:
                        if horizontal:          # card names always run along the card's top edge: they must be horizontal
                            names.append(ln)
                    elif ln.conf >= 0.5 and len(fold(ln.text)) >= 4 and horizontal:
                        small_lines.append(ln)
            nh = float(np.median([n.h for n in names])) if names else 0
            small = sum(1 for l in small_lines if nh and l.h < 0.85 * nh)
            scores[deg] = len(names) + 0.5 * small
            self.say(f"  orientation {deg:3d}°: {len(names)} horizontal card names + {small} small text lines")
        best = max(scores, key=scores.get)
        return best, scores

    def upright_score(self, lines):
        """Names read + small effect-text lines read: both are only legible when the card is the right way up."""
        names = []
        for ln, c in self._hits(lines):
            if c[0][1] >= 95 and ln.conf >= 0.8 and not any(overlap(ln, n) > 0.5 for n in names):
                names.append(ln)
        if not names:
            return 0.0
        nh = float(np.median([n.h for n in names]))
        small = sum(1 for l in lines if l.conf >= 0.4 and l.h < 0.85 * nh and len(fold(l.text)) >= 4 and not any(overlap(l, n) > 0.5 for n in names))
        return len(names) + 0.5 * small

    def _hits(self, lines):
        """Single lines plus 'merged' neighbours (OCR sometimes splits a name in two)."""
        pool = list(lines); lines_sorted = sorted(lines, key=lambda l: l.cy)
        for i, a in enumerate(lines_sorted):
            for b in lines_sorted[i + 1:]:
                if b.cy - a.cy > a.h: break
                lo, hi = (a, b) if a.x0 <= b.x0 else (b, a)
                gap = hi.x0 - lo.x1
                if abs(a.cy - b.cy) < 0.45 * min(a.h, b.h) and -2 <= gap < 2.5 * max(a.h, b.h):
                    pool.append(Line(lo.text + " " + hi.text, min(a.conf, b.conf), lo.x0, min(a.y0, b.y0), hi.x1, max(a.y1, b.y1), max(a.h, b.h)))
        hits = []
        for ln in pool:
            if ln.conf < 0.35:
                continue
            txt = re.sub(r"[^A-Za-z0-9 .,'&!:\-]", "", ln.text)
            cands = self.candidates(txt)
            if cands:
                hits.append((ln, cands))
        hits.sort(key=lambda t: (-t[1][0][1], -t[0].conf, -t[0].area))
        return hits

    # ------------------------------------------------------------------ second look at spots where a card name must be
    def retry_band(self, img, cx, cy, cw):
        """Crop just the name strip of the card whose name should start at (cx, cy), enlarge + sharpen it, read it again."""
        H, W = img.shape[:2]
        x0, x1 = int(max(0, cx - 0.10 * cw)), int(min(W, cx + 0.98 * cw)); y0, y1 = int(max(0, cy - 0.10 * cw)), int(min(H, cy + 0.20 * cw))
        band = img[y0:y1, x0:x1]
        if band.size == 0:
            return None
        sc = max(4.0, 110.0 / band.shape[0])
        gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
        variants = [band, cv2.cvtColor(cv2.createCLAHE(3.0, (4, 4)).apply(gray), cv2.COLOR_GRAY2BGR), cv2.cvtColor(255 - gray, cv2.COLOR_GRAY2BGR)]
        best = None
        for v in variants:
            up = cv2.copyMakeBorder(cv2.resize(v, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC), 24, 24, 24, 24, cv2.BORDER_REPLICATE)
            res, _ = self.ocr(up, use_cls=False)
            parts = sorted([(float(np.array(b)[:, 0].min()), t, float(c)) for b, t, c in (res or [])])
            texts = [(t, c) for _, t, c in parts] + ([(" ".join(t for _, t, _ in parts), min(c for _, _, c in parts))] if len(parts) > 1 else [])
            for t, c in texts:
                cands = self.candidates(re.sub(r"[^A-Za-z0-9 .,'&!:\-]", "", t))
                if cands and c >= 0.4 and (len(fold(self.db.cards[cands[0][0]].name)) >= 7 or cands[0][1] >= 97) and (best is None or cands[0][1] * c > best[1] * best[2]):
                    best = (cands[0], cands[0][1], c, t)
        if best and best[1] >= max(self.min_score, 82):
            (cid, score), _, conf, text = best
            return {"id": cid, "score": score, "conf": conf, "text": text, "box": [x0, y0, x1, y1]}
        return None

    def recover(self, img, found, unmatched, missing, cw):
        got = 0; keep_u, keep_m = [], []
        for kind, items in (("u", unmatched), ("m", missing)):
            for it in items:
                r = self.retry_band(img, it["x"], it["y"], cw)
                if r and not any(overlap(Line("", 0, *r["box"], 0), Line("", 0, *f["box"], 0)) > 0.3 for f in found):
                    c = self.db.cards[r["id"]]; sure = r["score"] >= 95 and r["conf"] >= 0.8
                    found.append({"id": c.id, "name": c.name, "extra": c.extra, "status": "name_only" if sure else "review", "confidence": round(r["score"] / 100 * (0.6 + 0.4 * min(1, r["conf"])) - 0.05, 2),
                                  "ocr_text": r["text"], "name_score": round(r["score"]), "desc_words_read": 0, "desc_words_matched": 0, "alternatives": [], "box": r["box"], "recovered": True})
                    got += 1
                else:
                    (keep_u if kind == "u" else keep_m).append(it)
        return found, keep_u, keep_m, got

    # ------------------------------------------------------------------ one corrected image -> detections
    @staticmethod
    def estimate_card_width(reps, ref_h, fallback):
        """Card width from the spacing of the grid (names sit at the same offset in every card), else from text height."""
        dx, dy = [], []
        for a in reps:
            right = [r.x0 - a.x0 for r in reps if r is not a and abs(r.cy - a.cy) < 2 * ref_h and r.x0 - a.x0 > 8 * ref_h]
            below = [r.y0 - a.y0 for r in reps if r is not a and abs(r.x0 - a.x0) < 2 * ref_h and r.y0 - a.y0 > 8 * ref_h]
            if right: dx.append(min(right))
            if below: dy.append(min(below))
        est = []
        if len(dx) >= 2: est.append(float(np.median(dx)) * 0.94)             # pitch = card width + a small gap
        if len(dy) >= 2: est.append(float(np.median(dy)) / 1.46 / 1.04)      # pitch = card height (1.46 x width) + a small gap
        return (float(np.mean(est)), True) if est else (fallback, False)

    def analyse(self, img, lines):
        warnings = []
        hits = self._hits(lines)
        clusters = []                      # [(rep_line, cands)]  — best-scoring reading of each physical text line
        for ln, cands in hits:
            if cands[0][1] < 65:
                continue
            if not any(overlap(ln, rep) > 0.5 for rep, _ in clusters):
                clusters.append((ln, cands))

        strong = [c for c in clusters if c[1][0][1] >= 95 and c[0].conf >= 0.8] or [c for c in clusters if c[1][0][1] >= 85]
        if not strong:
            return [], [], ["No card names could be read. Try a sharper, closer photo (see tips)."], 0.0
        ref_h = float(np.median([c[0].h for c in strong]))
        ratio_cw = float(np.clip(CARD_W_PER_NAME_H * ref_h, 60, img.shape[1] / 2))
        if self.card_width:
            cw, measured = self.card_width, True
        else:
            cw, measured = self.estimate_card_width([c[0] for c in strong if c[0].h >= 0.7 * ref_h], ref_h, ratio_cw)

        def in_text_area(ln):
            """A real card name is never inside ANOTHER card's effect-text area: that is a name quoted in an effect."""
            lo, hi = (0.8, 1.40) if measured else (0.95, 1.30)
            return any(a is not ln and a.h >= 0.7 * ref_h and cands_a[0][1] >= 85 and a.x0 - 0.1 * cw <= ln.x0 <= a.x0 + 0.9 * cw and a.y0 + lo * cw <= ln.y0 <= a.y0 + hi * cw
                       for a, cands_a in clusters)

        names = [(rep, c) for rep, c in clusters if rep.h >= 0.7 * ref_h and not in_text_area(rep)]     # smaller print / quoted names are not card names
        found, unmatched = [], []
        for rep, cands in names:
            name_score = cands[0][1]
            if name_score < self.min_score or rep.conf < 0.5:
                if rep.h >= 0.85 * ref_h and len(fold(rep.text)) >= 5:
                    unmatched.append({"text": rep.text, "x": int(rep.x0), "y": int(rep.y0), "w": int(rep.x1 - rep.x0), "h": int(rep.y1 - rep.y0),
                                      "guess": self.db.cards[cands[0][0]].name, "score": round(name_score)})
                continue
            found.append(self._verify(rep, cands, lines, ref_h, cw, [r for r, c in names if c[0][1] >= self.min_score]))

        taken = [rep for rep, _ in clusters]               # tall, unmatched, non-overlapping lines the matcher never scored
        for ln in lines:
            if ln.h >= 0.85 * ref_h and ln.conf >= 0.6 and len(fold(ln.text)) >= 6 and not any(overlap(ln, r) > 0.5 for r in taken) \
                    and not any(overlap(ln, Line("", 0, u["x"], u["y"], u["x"] + u["w"], u["y"] + u["h"], 0)) > 0.5 for u in unmatched) and not in_text_area(ln):
                if not self.candidates(ln.text, 1):
                    unmatched.append({"text": ln.text, "x": int(ln.x0), "y": int(ln.y0), "w": int(ln.x1 - ln.x0), "h": int(ln.y1 - ln.y0), "guess": None, "score": 0})
        return found, unmatched, warnings, cw

    def _verify(self, rep, cands, lines, ref_h, cw, others=()):
        """Compare words read inside this card with the official effect text of the name candidates."""
        x0, x1 = rep.x0 - 0.12 * cw, rep.x0 + 0.95 * cw; y0, y1 = rep.y0 - 0.1 * rep.h, rep.y0 + 1.42 * cw
        for o in others:                                   # never read into the neighbouring card
            if o is rep:
                continue
            if abs(o.cy - rep.cy) < 0.3 * cw and o.x0 > rep.x0 + 0.5 * cw:
                x1 = min(x1, o.x0 - 0.1 * cw)
            if abs(o.x0 - rep.x0) < 0.5 * cw and o.y0 > rep.y0 + 0.6 * cw:
                y1 = min(y1, o.y0 - 0.03 * cw)
        win = [ln for ln in lines if x0 <= ln.cx <= x1 and y0 <= ln.cy <= y1 and ln.h <= 0.85 * ref_h and overlap(ln, rep) < 0.3 and ln.conf >= 0.4]
        words = set()
        for ln in win:                                      # OCR drops spaces in small print: re-split into real words first
            words |= {w for w in self.db.segment(ln.text) if len(w) >= 4 and w not in STOP}
        words = self.db.distinctive(words)
        flat = [re.sub(r"[^a-z]", "", ln.text.lower()) for ln in win]; flat = [f for f in flat if len(f) >= 10]
        read_chars = sum(len(f) for f in flat)
        best_name = cands[0][1]; scored = []
        for cid, ns in cands[:6]:
            if ns < best_name - 12:
                continue
            ct = self.db.desc_tokens(cid); ctl = list(ct); official = self.db.letters(cid)
            m = sum(1 for w in words if w in ct or (len(w) >= 5 and ctl and process.extractOne(w, ctl, scorer=fuzz.ratio, score_cutoff=86)))
            explained = sum(len(f) for f in flat if official and fuzz.partial_ratio(f, official) >= 85)      # text read that appears in this card's effect
            frac = explained / read_chars if read_chars else 0.0
            scored.append((ns + 4 * min(m, 6) + 6 * frac - (4 if read_chars >= 100 and frac < 0.15 and m == 0 else 0), cid, ns, m, explained, frac))
        scored.sort(reverse=True)
        _, cid, ns, matched, explained, frac = scored[0]
        contradicted = read_chars >= 100 and frac < 0.15 and matched == 0     # a lot of text was read and none of it is this card's
        short = len(fold(self.db.cards[cid].name)) < 6 and ns < 95
        need = 2 if len(self.db.desc_tokens(cid)) <= 15 else 3             # vanilla monsters have very little text to match
        if (matched >= need or (explained >= 50 and frac >= 0.6)) and not contradicted:
            status = "verified"
        elif contradicted or ns < 90 or short or (rep.conf < 0.6 and ns < 97):
            status = "review"
        else:
            status = "name_only"
        conf = ns / 100 * (0.6 + 0.4 * min(1.0, rep.conf))
        conf = min(1.0, conf + 0.08) if status == "verified" else conf - (0.2 if contradicted else 0)
        alts = [{"id": c, "name": self.db.cards[c].name, "score": round(sc)} for _, c, sc, *_ in scored[1:4]]
        return {"id": cid, "name": self.db.cards[cid].name, "extra": self.db.cards[cid].extra, "status": status, "confidence": round(max(0.0, conf), 2),
                "ocr_text": rep.text, "name_score": round(ns), "desc_words_read": max(len(words), read_chars // 6), "desc_words_matched": max(matched, explained // 6), "alternatives": alts,
                "box": [int(rep.x0), int(rep.y0), int(rep.x1), int(rep.y1)]}

    # ------------------------------------------------------------------ public API
    def scan(self, path, rotate="auto", annotate=None):
        t0 = time.time(); img = load_image(path); warnings = []
        h, w = img.shape[:2]
        if rotate == "auto":
            self.say("Detecting orientation…"); deg, scores = self.pick_rotation(img)
            if scores[deg] == 0:
                warnings.append("No card names recognised in any orientation — the photo may be too small or blurry.")
            elif sorted(scores.values())[-2] * 1.5 > scores[deg]:
                warnings.append("Orientation was ambiguous; cards may be photographed in mixed directions. Scan those separately.")
        else:
            deg = int(rotate)
        base = img
        img = rotated(base, deg)
        self.say(f"Reading text at {deg}° …"); lines = self.read_image(img)
        if rotate == "auto":
            opp = (deg + 180) % 360
            if scores.get(opp, 0) >= 0.75 * scores.get(deg, 0) > 0:          # sideways/upside-down look alike to the OCR: compare both fully
                self.say(f"Orientation close call ({deg}° vs {opp}°) — reading both…")
                img2 = rotated(base, opp); lines2 = self.read_image(img2)
                a, b = self.upright_score(lines), self.upright_score(lines2)
                self.say(f"  {deg}°: {a:.0f}   {opp}°: {b:.0f}")
                if b > a:
                    deg, img, lines = opp, img2, lines2
        found, unmatched, warn, cw = self.analyse(img, lines); warnings += warn
        for u in unmatched:
            u["crop"] = card_crop(img, u["x"], u["y"], cw)
        pts = [(f["box"][0], f["box"][1]) for f in found] + [(u["x"], u["y"]) for u in unmatched]
        missing = missing_cells(img, pts, cw) if found else []
        recovered = 0
        if (unmatched or missing) and found:
            self.say(f"Taking a closer look at {len(unmatched) + len(missing)} spot(s) where a name was expected…")
            found, unmatched, missing, recovered = self.recover(img, found, unmatched, missing, cw)
            if recovered:
                warnings.append(f"{recovered} more card(s) were recovered by a second, closer look — they are marked 'review'; please check them.")
        unresolved = unmatched + missing                    # card positions where a name was expected but could not be read
        for u, where in zip(unresolved, grid_labels([(f["box"][0], f["box"][1]) for f in found], [(u["x"], u["y"]) for u in unresolved], cw)):
            u["where"] = where
            if not u.get("crop"):
                u["crop"] = card_crop(img, u["x"], u["y"], cw)
        rec, exp = len(found), len(found) + len(unresolved)
        pct = round(100 * rec / exp) if exp else 100
        coverage = {"recognized": rec, "expected": exp, "percent": pct, "level": "complete" if not unresolved else "partial" if pct >= 70 else "poor"}
        if unresolved:
            warnings.insert(0, f"Recognized {rec} of about {exp} cards ({pct}%). For the other {len(unresolved)}, take a closer, brighter photo of just those cards "
                               f"(see \"Couldn't read\") and scan it as another photo — new photos are added to the deck.")
        if found and cw and max(img.shape[:2]) < 1000:
            warnings.append("Low-resolution photo: effect text can't be verified. Take the photo closer (≈8 cards per photo).")
        if found and not any(f["status"] == "verified" for f in found):
            warnings.append("Effect text was too small to read, so cards are matched by name only (status 'name_only').")
        if annotate:
            self._annotate(img, found, unmatched, annotate, missing, cw)
        cards = self._group(found)
        out = {"ok": True, "image": {"w": w, "h": h, "rotation": deg}, "coverage": coverage, "cards": cards, "unmatched": unmatched, "missing": missing, "warnings": warnings,
               "stats": {"detections": len(found), "unique": len(cards), "verified": sum(1 for f in found if f["status"] == "verified"),
                         "name_only": sum(1 for f in found if f["status"] == "name_only"), "review": sum(1 for f in found if f["status"] == "review"),
                         "unmatched": len(unmatched), "missing": len(missing), "recovered": recovered, "seconds": round(time.time() - t0, 1), "db": self.db.source}}
        return out

    @staticmethod
    def _group(found):
        g = {}
        for f in found:
            e = g.setdefault(f["id"], {"id": f["id"], "name": f["name"], "extra": f["extra"], "count": 0, "status": f["status"], "confidence": [], "alternatives": f["alternatives"], "ocr_text": []})
            e["count"] += 1; e["confidence"].append(f["confidence"]); e["ocr_text"].append(f["ocr_text"])
            if RANK[f["status"]] < RANK[e["status"]]:
                e["status"] = f["status"]
        for e in g.values():
            e["confidence"] = round(sum(e["confidence"]) / len(e["confidence"]), 2)
        return sorted(g.values(), key=lambda e: (e["extra"], e["name"]))

    @staticmethod
    def _annotate(img, found, unmatched, path, missing=(), cw=0):
        vis = img.copy(); col = {"verified": (60, 190, 60), "name_only": (230, 150, 40), "review": (30, 140, 255)}
        for f in found:
            x0, y0, x1, y1 = f["box"]; c = col[f["status"]]
            cv2.rectangle(vis, (x0 - 3, y0 - 3), (x1 + 3, y1 + 3), c, 2)
        for u in unmatched:
            cv2.rectangle(vis, (u["x"] - 3, u["y"] - 3), (u["x"] + u["w"] + 3, u["y"] + u["h"] + 3), (40, 40, 230), 2)
        for m in missing:
            cv2.rectangle(vis, (int(m['x'] - 0.1 * cw), int(m['y'] - 0.12 * cw)), (int(m['x'] + 0.95 * cw), int(m['y'] + 1.4 * cw)), (200, 60, 200), 2)
        s = min(1.0, 1600 / max(vis.shape[:2])); vis = cv2.resize(vis, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else vis
        cv2.imwrite(path, vis, [cv2.IMWRITE_JPEG_QUALITY, 75])


def merge(results):
    """Several photos of one deck -> one result (counts add up)."""
    if len(results) == 1:
        return results[0]
    g = {}
    for r in results:
        for c in r["cards"]:
            e = g.setdefault(c["id"], {**c, "count": 0, "confidence": 0.0, "_n": 0, "ocr_text": []})
            e["count"] += c["count"]; e["confidence"] += c["confidence"] * c["count"]; e["_n"] += c["count"]; e["ocr_text"] += c["ocr_text"]
            if RANK[c["status"]] < RANK[e["status"]]:
                e["status"] = c["status"]
    cards = []
    for e in g.values():
        e["confidence"] = round(e["confidence"] / max(1, e.pop("_n")), 2); cards.append(e)
    cards.sort(key=lambda e: (e["extra"], e["name"]))
    stats = {k: sum(r["stats"][k] for r in results) for k in ("detections", "verified", "name_only", "review", "unmatched", "missing", "seconds")}
    stats.update(unique=len(cards), db=results[0]["stats"]["db"])
    rec, exp = sum(r["coverage"]["recognized"] for r in results), sum(r["coverage"]["expected"] for r in results)
    cov = {"recognized": rec, "expected": exp, "percent": round(100 * rec / exp) if exp else 100, "level": "complete" if rec == exp else "partial"}
    return {"ok": True, "images": len(results), "coverage": cov, "cards": cards, "unmatched": [u for r in results for u in r["unmatched"]], "missing": [m for r in results for m in r.get("missing", [])],
            "warnings": [w for r in results for w in r["warnings"]], "stats": stats}


def to_ydk(cards, strict=False):
    main, extra = [], []
    for c in cards:
        if strict and c["status"] == "review":
            continue
        (extra if c["extra"] else main).extend([str(c["id"])] * c["count"])
    return "#created by YGO 2.0 scanner\n#main\n" + "\n".join(main) + "\n#extra\n" + "\n".join(extra) + "\n!side\n"


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Photo of physical cards -> .ydk (reads card names + effect text, ignores artwork)")
    ap.add_argument("images", nargs="+")
    ap.add_argument("-o", "--ydk", help="write the deck here")
    ap.add_argument("--json", help="write the full report here")
    ap.add_argument("--stdout-json", action="store_true", help="print only the JSON report on stdout (used by the Node server)")
    ap.add_argument("--annotate", help="save the photo with boxes: green verified, blue name only, orange review, red unreadable")
    ap.add_argument("--db", default=os.path.join(here, "..", "BabelCDB", "cards.cdb"), help="card database (cards.cdb)")
    ap.add_argument("--api", action="store_true", help="use the YGOPRODeck API instead of cards.cdb (cached in ocr/.cache)")
    ap.add_argument("--lang", default="en", help="YGOPRODeck language for --api (en, fr, de, it, pt)")
    ap.add_argument("--rotate", default="auto", choices=["auto", "0", "90", "180", "270"])
    ap.add_argument("--min-score", type=float, default=80)
    ap.add_argument("--card-width", type=float, help="card width in photo pixels (if the automatic estimate is off)")
    ap.add_argument("--strict", action="store_true", help="leave 'review' cards out of the .ydk")
    a = ap.parse_args()
    try:
        db = CardDB.from_api(os.path.join(here, ".cache", f"cardinfo-{a.lang}.json"), a.lang) if a.api else CardDB.from_cdb(a.db)
    except Exception as e:                                           # noqa: BLE001
        msg = f"Could not load the card database: {e}"
        print(json.dumps({"ok": False, "error": msg}) if a.stdout_json else msg, file=sys.stdout if a.stdout_json else sys.stderr); sys.exit(2)
    sc = Scanner(db, a.min_score, a.card_width, verbose=not a.stdout_json)
    res = []
    for i, p in enumerate(a.images):
        sc.say(f"[{i + 1}/{len(a.images)}] {p}")
        ann = a.annotate if len(a.images) == 1 or not a.annotate else re.sub(r"(\.\w+)$", f"-{i + 1}\\1", a.annotate)
        res.append(sc.scan(p, a.rotate, ann))
    out = merge(res); out["ydk"] = to_ydk(out["cards"], a.strict)
    if a.ydk:
        open(a.ydk, "w").write(out["ydk"])
    if a.json:
        json.dump(out, open(a.json, "w"), indent=1)
    if a.stdout_json:
        print(json.dumps(out))
        return
    st = out["stats"]
    cv = out["coverage"]
    print(f"\nRecognized {cv['recognized']} of about {cv['expected']} cards ({cv['percent']}%)" + ("" if cv["level"] == "complete" else
          " — for the rest, take a closer, brighter photo of just those cards and scan it as another photo (results are added together)."))
    print(f"Found {sum(c['count'] for c in out['cards'])} cards ({st['unique']} different) in {st['seconds']}s — "
          f"{st['verified']} verified by effect text, {st['name_only']} by name only, {st['review']} to review, {st['unmatched']} unreadable names\n")
    sym = {"verified": "✔", "name_only": "·", "review": "?"}
    for c in out["cards"]:
        print(f" {sym[c['status']]} {c['count']}x {c['name']:<40} {c['status']:<10} {int(c['confidence'] * 100)}%{'  [Extra]' if c['extra'] else ''}")
    for u in out["unmatched"]:
        print(f" ✘ not recognized: {u.get('where') or 'x=%d y=%d' % (u['x'], u['y'])}" + (f"  read as \"{u['text']}\"" if u.get("text") else "") + (f" (closest: {u['guess']} {u['score']}%)" if u.get("guess") else ""))
    for u in out.get("missing", []):
        print(f" ◻ not recognized: {u.get('where') or 'x=%d y=%d' % (u['x'], u['y'])}")
    for m in out.get("missing", []):
        print(f" ◻ probably an unread card near x={m['x']} y={m['y']}")
    for w in out["warnings"]:
        print("!", w)


if __name__ == "__main__":
    main()
