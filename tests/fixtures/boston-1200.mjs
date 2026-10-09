/**
 * Enviro Boston 1200 FS, as a user would enter it from its manual.
 * Source: Enviro owner's manual C-14623 / 50-2439 (Sherwood Industries, 2015-10-28).
 * Kept as a hand-checked test case; it is NOT a product list the website offers.
 *
 *   collar size 6"                       p.22 ("we recommend the use of a 6 in flue pipe")
 *   outlet top 31.75" above floor         p.12 (height with legs), p.16 drawing
 *   any UL 103 HT listed chimney          p.15
 *   max 2 offsets (4 elbows)              p.22 Table 6 note
 *   24" vertical rise before horizontal   p.14 clearance table, "top vent out back wall" column
 *   18" from horizontal run to ceiling    p.25
 *   minimum height: 12 ft at sea level straight up, plus Table 6/7 additions - the user reads
 *   the number for their own layout, so each test sets minSystemHeightFt.
 */
export const BOSTON_1200 = Object.freeze({
  type: 'STOVE',
  label: 'Enviro Boston 1200 FS',
  collarSizeIn: 6,
  outletElevationIn: 31.75,
  acceptsChimney: 'UL103HT',
  maxOffsets: 2,
  minRiseBeforeHorizontalIn: 24,
  minHorizontalToCeilingIn: 18,
});

/**
 * Boston manual heights for specific layouts (Tables 6-8, p.22):
 *   straight up, sea level ................ 12.0 ft
 *   tee + 1.5 ft horizontal, sea level .... 12 + 3 + 3 = 18.0 ft
 *   2 x 30° elbows at 9,000-10,000 ft ..... 18.1 ft; 4 x 30° elbows: 20.0 ft
 */
export const BOSTON_HEIGHTS_FT = Object.freeze({ straight: 12, teePlus18inHorizontal: 18, fourElbows30At9500ft: 20.0 });
