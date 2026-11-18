"""Builds fake 'photos' of cards (name + effect text from the real card list) so the scanner can be tested with known answers."""
import os, random, sys, textwrap
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from carddb import CardDB

FONTS = [p for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf") if os.path.exists(p)]
REG = [p.replace("-Bold", "") for p in FONTS]


def card(name, desc, w=300, color=(196, 160, 110)):
    h = int(w * 86 / 59); im = Image.new("RGB", (w, h), color); d = ImageDraw.Draw(im)
    d.rectangle([4, 4, w - 5, h - 5], outline=(60, 40, 20), width=3)
    f = ImageFont.truetype(FONTS[0], 19); d.text((14, 12), name, font=f, fill=(10, 10, 10))
    d.rectangle([22, 48, w - 22, 48 + w - 44], fill=(70, 60, 110))                    # "artwork"
    for i in range(18):                                                                 # busy artwork (must be ignored)
        x, y = random.randint(30, w - 60), random.randint(60, w - 30); d.ellipse([x, y, x + 30, y + 22], fill=(random.randint(120, 255), random.randint(40, 200), 40))
    d.rectangle([14, h - 175, w - 14, h - 8], fill=(238, 230, 200)); ft = ImageFont.truetype(REG[0], 11)
    y = h - 170
    for ln in textwrap.wrap(desc.replace("\r", " ").replace("\n", " "), 44)[:12]:
        d.text((19, y), ln, font=ft, fill=(15, 15, 15)); y += 13
    return im


def photo(specs, cols=4, rot=0, noise=3, blur=0.6, seed=1):
    """specs: list of (shown_name, desc_text). Returns a PIL image of the cards on a dark table, optionally rotated."""
    random.seed(seed); cw, ch, gap = 300, int(300 * 86 / 59), 24
    rows = (len(specs) + cols - 1) // cols; W, H = cols * (cw + gap) + gap, rows * (ch + gap) + gap
    bg = Image.new("RGB", (W, H), (45, 45, 48)); colors = [(196, 160, 110), (120, 170, 150), (150, 110, 170), (110, 140, 200)]
    for i, (n, dsc) in enumerate(specs):
        bg.paste(card(n, dsc, cw, colors[i % 4]), (gap + (i % cols) * (cw + gap), gap + (i // cols) * (ch + gap)))
    a = np.array(bg).astype(np.float32) + np.random.RandomState(seed).normal(0, noise, (H, W, 3))
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))
    return im.rotate(rot, expand=True) if rot else im


def pick(db, n=8, seed=3, extra=False):
    rnd = random.Random(seed); pool = [c for c in db.cards.values() if len(c.desc) > 120 and c.extra == extra and 8 <= len(c.name) <= 28]
    return rnd.sample(pool, n)
