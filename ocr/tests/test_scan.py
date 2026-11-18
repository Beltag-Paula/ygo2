"""python -m unittest ocr/tests/test_scan.py   (the photo tests take ~1 min; set OCR_FAST=1 to run only the quick ones)"""
import os, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, "..")); sys.path.insert(0, HERE)
from carddb import CardDB, fold, tokens
from scan import Scanner, to_ydk
import make_synthetic as syn

CDB = os.path.join(HERE, "..", "..", "BabelCDB", "cards.cdb")
DB = CardDB.from_cdb(CDB)


class Quick(unittest.TestCase):
    def test_fold_ignores_case_punctuation_lookalikes(self):
        self.assertEqual(fold("Dark Magician"), fold("DARK-MAGICIAN!"))
        self.assertEqual(fold("Blue-Eyes White Dragon"), fold("BLUE EYES WH1TE DRAG0N"))

    def test_fuzzy_name_with_ocr_errors(self):
        sc = Scanner(DB, verbose=False)
        for noisy, real in [("SALAMANGBEAT PYRO PHOENX", "Salamangreat Pyro Phoenix"), ("DARK MAGICAN", "Dark Magician"), ("BLUE-EYES WHITE DRAGOM", "Blue-Eyes White Dragon")]:
            cid, score = sc.candidates(noisy)[0]
            self.assertEqual(DB.cards[cid].name, real); self.assertGreaterEqual(score, 85)

    def test_gibberish_is_not_a_card(self):
        self.assertTrue(all(s < 80 for _, s in Scanner(DB, verbose=False).candidates("QWXZVBNMKJH LPOIUY")))

    def test_ydk_splits_main_and_extra(self):
        ex = next(c for c in DB.cards.values() if c.extra); mn = next(c for c in DB.cards.values() if not c.extra)
        y = to_ydk([{"id": mn.id, "count": 3, "extra": False, "status": "verified"}, {"id": ex.id, "count": 1, "extra": True, "status": "review"}])
        self.assertIn(f"#main\n{mn.id}\n{mn.id}\n{mn.id}\n#extra\n{ex.id}\n", y)
        self.assertNotIn(str(ex.id), to_ydk([{"id": ex.id, "count": 1, "extra": True, "status": "review"}], strict=True))

    def test_segments_words_that_ocr_glued_together(self):
        self.assertEqual(DB.segment("effect.Shuffleeitheryouroryour")[:3], ["effect", "shuffle", "either"])

    def test_unfinished_last_row_is_not_reported_as_missing(self):
        from scan import missing_cells
        import numpy as np
        cw = 100; pts = [(x * 110, y * 160) for y in range(3) for x in range(5)]
        pts = [p for p in pts if not (p[1] == 320 and p[0] >= 330)]          # last row only has 3 of 5 cards
        self.assertEqual(missing_cells(np.zeros((600, 700, 3), np.uint8), pts, cw), [])
        gap = [p for p in pts if p != (220, 160)]                              # a real hole in the middle IS reported
        self.assertEqual([(m["x"], round(m["y"], -1)) for m in missing_cells(np.zeros((600, 700, 3), np.uint8), gap, cw)], [(220, 160)])

    def test_unrecognized_cards_get_a_row_and_column(self):
        from scan import grid_labels
        cw = 100; pts = [(x * 110, y * 160) for y in range(3) for x in range(5) if (x, y) not in {(3, 1), (0, 2)}]
        self.assertEqual(grid_labels(pts, [(330, 160), (0, 320)], cw), ["row 2, column 4", "row 3, column 1"])
        self.assertEqual(grid_labels([(0, 0)], [(5, 5)], cw), [None])           # no grid: say nothing rather than guess

    def test_card_width_is_measured_from_grid_spacing(self):
        from scan import Line
        reps = [Line("x", 1, x * 324 + 20, y * 461 + 10, x * 324 + 120, y * 461 + 28, 17.8) for y in range(2) for x in range(4)]
        cw, measured = Scanner.estimate_card_width(reps, 17.8, 50)
        self.assertTrue(measured and abs(cw - 300) < 12, cw)


@unittest.skipIf(os.environ.get("OCR_FAST"), "slow")
class Photos(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sc = Scanner(DB, verbose=False)

    def run_photo(self, specs, **kw):
        f = tempfile.NamedTemporaryFile(suffix=".png", delete=False); f.close(); syn.photo(specs, **kw).save(f.name)
        try:
            return self.sc.scan(f.name)
        finally:
            os.unlink(f.name)

    def test_upright_photo_is_read_and_verified_by_effect_text(self):
        cs = syn.pick(DB, 8); r = self.run_photo([(c.name, c.desc) for c in cs])
        got = {c["id"]: c for c in r["cards"]}
        self.assertGreaterEqual(sum(1 for c in cs if c.id in got), 7, r["warnings"])
        self.assertGreaterEqual(sum(1 for c in cs if c.id in got and got[c.id]["status"] == "verified"), 5, [(c["name"], c["status"]) for c in r["cards"]])

    def test_sideways_photo_is_rotated_automatically(self):
        cs = syn.pick(DB, 6, seed=5); r = self.run_photo([(c.name, c.desc) for c in cs], rot=90, cols=3)
        self.assertIn(r["image"]["rotation"], (90, 270)); self.assertGreaterEqual(sum(1 for c in cs if c.id in {x["id"] for x in r["cards"]}), 5)

    def test_duplicates_are_counted(self):
        cs = syn.pick(DB, 3, seed=9); specs = [(c.name, c.desc) for c in cs for _ in range(2)]; r = self.run_photo(specs, cols=3)
        self.assertGreaterEqual(sum(1 for c in r["cards"] if c["count"] == 2), 2)

    def test_effect_text_that_belongs_to_another_card_is_flagged(self):
        a, b = syn.pick(DB, 2, seed=11); r = self.run_photo([(a.name, b.desc)] + [(c.name, c.desc) for c in syn.pick(DB, 4, seed=12)], cols=5)
        row = next((c for c in r["cards"] if c["id"] == a.id), None)
        self.assertTrue(row is not None and row["status"] == "review", row)

    def test_text_in_artwork_and_effect_text_mentions_are_not_counted_as_cards(self):
        cs = syn.pick(DB, 4, seed=21); other = syn.pick(DB, 1, seed=22)[0]
        specs = [(c.name, c.desc + " If " + other.name + " is on the field, draw 1 card.") for c in cs]; r = self.run_photo(specs, cols=4)
        self.assertNotIn(other.id, {c["id"] for c in r["cards"]})


if __name__ == "__main__":
    unittest.main()
