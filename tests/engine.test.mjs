// Run:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeCatalog } from '../web/js/engine/catalog.js';
import { planChimney } from '../web/js/engine/planner.js';
import { selectPipe, pipeStock, terminationHeight } from '../web/js/engine/geometry.js';
import { EXAMPLE_RANCH, EXAMPLE_THROUGH_WALL, EXAMPLE_CHASE_FIREPLACE } from '../web/js/engine/spec.js';
import { BOSTON_1200, BOSTON_HEIGHTS_FT } from './fixtures/boston-1200.mjs';

const load = f => JSON.parse(readFileSync(new URL(`../web/catalog/${f}`, import.meta.url)));
const cat = makeCatalog(load('index.json'), load('DT.json'));
const qty = (res, order) => res.parts.find(p => p.order_number === order)?.qty ?? 0;
const pipes = res => res.parts.filter(p => p.category === 'CHIMNEY_PIPE');
const clone = o => structuredClone(o);
/** Copy of a spec with manual values merged into its appliance. */
const withManual = (spec, manual) => { const s = clone(spec); s.appliance = { ...s.appliance, ...manual }; return s; };
/** Ranch with a 12 ft manual minimum, so the roof rules (not the default) set the height. */
const RANCH = withManual(EXAMPLE_RANCH, { minSystemHeightFt: 12 });

// ------------------------------------------------------------------ geometry
test('pipe selection uses installed length and never falls short', () => {
  const stock = pipeStock(cat, 6, 'SS');
  for (const need of [5, 30, 47, 100, 108, 238, 400]) {
    const s = selectPipe(need, stock);
    assert.ok(s.installedIn >= need, `need ${need}, got ${s.installedIn}`);
    assert.equal(s.installedIn, s.pieces.reduce((t, p) => t + p.nominal_length_in - 1.25, 0));
  }
});

test('termination: 2 ft above ridge within 10 ft governs on a 6/12 roof', () => {
  // pen 132; 3 ft rule: 132 + 4*6/12 + 36 = 170
  // 2-10 rule: ridge 8 ft from the chimney's uphill side = 100" from its center: 132 + 100*6/12 + 24 = 206
  const t = terminationHeight(EXAMPLE_RANCH, cat, 8, { elevationIn: 132, pitch: 6, label: 'roof penetration' });
  assert.equal(t.requiredTopIn, 206);
  assert.match(t.governing.label, /ridge/);
});

// ------------------------------------------------------------------ ceiling route
test('ranch, flat ceiling, attic, shingle 6/12 (manual minimum 12 ft)', () => {
  const r = planChimney(RANCH, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6DT-CS11-2'), 1);   // 0/12 + DuraBlack -> 11" box
  assert.equal(qty(r, '6DT-IS'), 1);       // attic shield
  assert.equal(qty(r, '6DT-F6'), 1);       // 0-6/12 flashing
  assert.equal(qty(r, '5DT-SC'), 1);       // storm collar fits 5 & 6
  assert.equal(qty(r, '6DT-VC'), 1);
  assert.equal(qty(r, '6DT-XRS'), 1);      // 74.25" above roof >= 60"
  // need 204 - 96 = 108" -> best is 3 sections totalling 110.25" installed
  assert.equal(pipes(r).reduce((t, p) => t + p.qty, 0), 3);
  assert.equal(r.geometry.chimneyTopIn, 206.25);
  assert.equal(r.geometry.aboveExitIn, 74.25);
  assert.equal(r.manualHeightApplied, true);
  // only warning: the catalog gives no load rating for the plain square box
  assert.deepEqual(r.warnings.map(w => /maximum supported height/.test(w)), [true]);
});

test('blank manual height: upper end of the draft guideline governs, with a leading warning', () => {
  const r = planChimney(EXAMPLE_RANCH, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.manualHeightApplied, false);
  assert.equal(r.geometry.minSystemHeightFt, 15);
  assert.equal(r.geometry.requiredTopIn, 30 + 15 * 12);     // 210 beats the ridge rule's 204
  assert.match(r.geometry.governingRule, /draft guideline, upper end/);
  assert.match(r.warnings[0], /minimum chimney height was not entered/);
});

test('cathedral 8/12 with DuraBlack uses the 24" box and no attic shield', () => {
  const s = clone(RANCH);
  s.route = { type: 'CEILING', ceiling: { style: 'CATHEDRAL', elevationIn: 120, pitch: 8 }, atticAbove: false };
  s.roof = { pitch: 8, surface: 'SHINGLE', penetrationElevationIn: 130, horizontalToRidgeFt: 6 };
  const r = planChimney(s, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6DT-CS24-2'), 1);
  assert.equal(qty(r, '6DT-IS'), 0);
  assert.equal(qty(r, '6DT-F12'), 1);
  assert.equal(r.geometry.requiredTopIn, 204.67);   // 130 + (72 + 4)*8/12 + 24
});

test('same cathedral with DVL connector drops to the 11" box', () => {
  const s = clone(RANCH);
  s.connectorLine = 'DVL';
  s.route = { type: 'CEILING', ceiling: { style: 'CATHEDRAL', elevationIn: 120, pitch: 6 }, atticAbove: false };
  s.roof = { pitch: 6, surface: 'SHINGLE', penetrationElevationIn: 130, horizontalToRidgeFt: 6 };
  assert.equal(qty(planChimney(s, cat), '6DT-CS11-2'), 1);   // DVL 0-6/12 -> 11"
});

test('two-story: firestop at attic floor, collar box no longer counts as attic shield', () => {
  const s = clone(RANCH);
  s.route = { type: 'CEILING', ceiling: { style: 'FLAT', elevationIn: 96, support: 'SQUARE_COLLAR' },
              floorPenetrationsIn: [204], atticAbove: true };
  s.roof = { pitch: 6, surface: 'SHINGLE', penetrationElevationIn: 250, horizontalToRidgeFt: 20 };
  const r = planChimney(s, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6DT-CS24IS-2'), 1);
  assert.equal(qty(r, '6DT-FRS'), 1);
  assert.equal(qty(r, '6DT-IS'), 1);
  assert.equal(r.geometry.requiredTopIn, 336);   // ridge 20 ft away -> 10 ft zone: 250 + (120 + 4)*6/12 + 24
});

test('single story with collar box: collar satisfies the attic shield', () => {
  const s = clone(RANCH);
  s.route.ceiling.support = 'SQUARE_COLLAR';
  assert.equal(qty(planChimney(s, cat), '6DT-IS'), 0);
});

test('one 10" offset picks the 15° kit with 36" between elbows', () => {
  const s = clone(RANCH);
  s.route.offsets = [{ horizontalIn: 10, availableRiseIn: 60 }];   // measured: 15° fits
  const r = planChimney(s, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6DT-E15KSS'), 1);
  assert.ok(qty(r, '6DT-36SS') >= 1);
  assert.equal(r.geometry.offsetRiseIn, 50.25);
  assert.deepEqual(r.layout.elbows, [{ angleDeg: 15, count: 2 }]);
});

test('metal roof gets the rubber boot kit and no separate storm collar', () => {
  const s = clone(RANCH);
  s.roof.surface = 'METAL_CORRUGATED';
  const r = planChimney(s, cat);
  assert.equal(qty(r, 'URBAK'), 1);
  assert.equal(qty(r, '5DT-SC'), 0);
});

// ------------------------------------------------------------------ wall route
test('through-the-wall, brick veneer 10.5", manual height blank', () => {
  const r = planChimney(EXAMPLE_THROUGH_WALL, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6DT-WT'), 1);
  assert.equal(qty(r, '6DT-STSS'), 1);
  assert.equal(qty(r, '6DT-TSBSS'), 1);
  assert.equal(qty(r, '6DT-AWS-SS'), 1);          // ~41" of wall run -> 1 strap
  assert.equal(qty(r, '6DT-F6'), 0);               // gable end: no roof penetration
  assert.ok(r.warnings.some(w => /field-fabricated extension/.test(w)));
  // blank manual: 15 ft x 1.3 for the tee = 19.5 ft above the 30" outlet
  assert.equal(r.geometry.requiredTopIn, 30 + 19.5 * 12);
  assert.equal(qty(r, '6DT-XRS'), 2);              // ~13 ft free-standing above the wall top
});

// ------------------------------------------------------------------ input checks
test('rejections', () => {
  const three = clone(RANCH);
  three.route.offsets = [{ horizontalIn: 4 }, { horizontalIn: 4 }, { horizontalIn: 4 }];
  assert.match(planChimney(three, cat).errors.join(), /at most 2/);

  const thick = clone(EXAMPLE_THROUGH_WALL);
  thick.route.wallThicknessIn = 17;
  assert.match(planChimney(thick, cat).errors.join(), /exceeds/);

  const steep = clone(RANCH);
  steep.route = { type: 'CEILING', ceiling: { style: 'CATHEDRAL', elevationIn: 120, pitch: 16 }, atticAbove: false };
  steep.roof.penetrationElevationIn = 130;
  assert.match(planChimney(steep, cat).errors.join(), /steeper/);

  assert.match(planChimney(withManual(RANCH, { collarSizeIn: 10 }), cat).errors.join(), /not made/);

  const tile5 = withManual(RANCH, { collarSizeIn: 5 });
  tile5.roof.surface = 'TILE';
  assert.match(planChimney(tile5, cat).errors.join(), /flashing/);

  const mismatch = clone(RANCH); mismatch.size = 8;
  assert.match(planChimney(mismatch, cat).errors.join(), /doesn't match the 6" flue collar/);

  const noOutlet = clone(RANCH); delete noOutlet.appliance.outletElevationIn;
  assert.match(planChimney(noOutlet, cat).errors.join(), /top of the appliance flue outlet/);

  const other = withManual(RANCH, { acceptsChimney: 'OTHER' });
  assert.match(planChimney(other, cat).errors.join(), /different chimney/);

  const fpOnCeiling = withManual(RANCH, { type: 'FACTORY_FIREPLACE' });
  assert.match(planChimney(fpOnCeiling, cat).errors.join(), /fireplace installation type/);
});

test('user-confirmed chimney: no approval warning or error, stove or fireplace', () => {
  const r = planChimney(withManual(RANCH, { acceptsChimney: 'USER_CONFIRMED' }), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.ok(!r.warnings.some(w => /accepts a UL 103/.test(w)));
  assert.ok(planChimney(fpRoof({}, { acceptsChimney: 'USER_CONFIRMED' }), cat).ok);
});

test('stove manual silent on accepted chimney: warn, still plan', () => {
  const r = planChimney(withManual(RANCH, { acceptsChimney: undefined }), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.ok(r.warnings.some(w => /Confirm the stove manual accepts a UL 103 Type HT/.test(w)));
});

test('5" in galvalume falls back to stainless with a warning', () => {
  const s = withManual(RANCH, { collarSizeIn: 5 });
  s.finish = 'GA';
  const r = planChimney(s, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.ok(r.warnings.some(w => /using SS/.test(w)));
  assert.ok(pipes(r).every(p => /SS(CF)?$/.test(p.order_number)));
});

// ------------------------------------------------------------------ factory-built fireplace
const TESTCO = {   // made-up fireplace exercising every manual field
  type: 'FACTORY_FIREPLACE', label: 'Testco TF-36', collarSizeIn: 6, outletElevationIn: 40,
  acceptsChimney: 'NAMES_THIS_PRODUCT', connection: 'ANCHOR_PLATE_DAMPER',
  minSystemHeightFt: 15, maxSystemHeightFt: 40, maxOffsets: 1, offsetAnglesDeg: [15],
  requiresRoofRadiationShield: true,
};
const fpRoof = (route = {}, manual = {}) => ({
  line: 'DT', finish: 'SS', connectorLine: 'DB',
  appliance: { ...TESTCO, ...manual },
  route: { type: 'FIREPLACE', exit: { type: 'ROOF' }, ...route },
  roof: { pitch: 6, surface: 'SHINGLE', penetrationElevationIn: 200, horizontalToRidgeFt: 3 },
});

test('fireplace in an exterior chase', () => {
  const r = planChimney(EXAMPLE_CHASE_FIREPLACE, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '8DT-AP'), 1);
  assert.equal(qty(r, '8DT-FRS'), 1);                 // floor level inside the chase
  assert.equal(qty(r, '8DT-CTF'), 1);                 // chase top flashing
  assert.equal(qty(r, '7DT-SC'), 1);                  // storm collar for 7 & 8
  assert.equal(qty(r, '8DT-VC'), 1);
  assert.equal(qty(r, '6DT-AWS'), 1);                 // 108 -> 300 = 16 ft span -> 1 strap (6&8 GA strap)
  assert.equal(qty(r, '8DT-F6'), 0);                  // no roof flashing
  assert.equal(r.geometry.requiredTopIn, 344);        // ridge 320 + 24 beats chase top 300 + 36
  assert.equal(r.geometry.exit, 'chase top');
  assert.ok(r.notes.some(n => /names DuraTech/.test(n)));
});

test('fireplace manual: damper plate, roof shield, height limits', () => {
  const r = planChimney(fpRoof(), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6DT-AP'), 1);
  assert.equal(qty(r, '6DT-RRS'), 1);
  assert.equal(qty(r, '6DT-F6'), 1);
  assert.equal(r.geometry.requiredTopIn, 244);        // ridge 3 ft away: 200 + (36 + 4)*6/12 + 24; min height 40+180=220
  assert.ok(r.warnings.some(w => /damper/.test(w)));
});

test('fireplace minimum system height can govern', () => {
  const r = planChimney(fpRoof({}, { minSystemHeightFt: 25 }), cat);
  assert.equal(r.geometry.requiredTopIn, 340);        // 40 + 25 ft
  assert.match(r.geometry.governingRule, /Testco TF-36 manual minimum/);
});

test('fireplace manual limits: max offsets, 15° only, max height, chimney approval', () => {
  assert.match(planChimney(fpRoof({ offsets: [{ horizontalIn: 3 }, { horizontalIn: 3 }] }), cat).errors.join(), /at most 1 allowed \(Testco TF-36 manual\)/);
  assert.match(planChimney(fpRoof({ offsets: [{ horizontalIn: 25 }] }), cat).errors.join(), /15° elbows/);   // 30° would reach it
  assert.match(planChimney(fpRoof({}, { minSystemHeightFt: null, maxSystemHeightFt: 10 }), cat).errors.join(), /maximum of 10 ft/);
  assert.match(planChimney(fpRoof({}, { minSystemHeightFt: 20, maxSystemHeightFt: 10 }), cat).errors.join(), /above its maximum/);
  assert.match(planChimney(fpRoof({}, { acceptsChimney: 'NOT_STATED' }), cat).errors.join(), /listed with specific chimneys/);
  const ul = planChimney(fpRoof({}, { acceptsChimney: 'UL103HT' }), cat);
  assert.ok(ul.ok, ul.errors.join('; '));
});

test('pass-through shield at the attic floor replaces firestop + attic shield', () => {
  const r = planChimney(fpRoof({ floorPenetrationsIn: [100], atticAbove: true, penetrationShield: 'PASS_THROUGH' }), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6DT-SRSE'), 1);
  assert.equal(qty(r, '6DT-FRS'), 0);
  assert.equal(qty(r, '6DT-IS'), 0);

  const five = withManual(EXAMPLE_CHASE_FIREPLACE, { collarSizeIn: 5 });
  five.route.penetrationShield = 'PASS_THROUGH';
  assert.match(planChimney(five, cat).errors.join(), /pass-through radiation shield is not made for 5"/);
});

// ------------------------------------------------------------------ Boston 1200 (hand-checked manual)
const bostonWall = (manual = {}, route = {}) => {
  const s = clone(EXAMPLE_THROUGH_WALL);
  s.appliance = { ...BOSTON_1200, ...manual };
  s.siteElevationFt = 750;
  s.route = { ...s.route, wallThicknessIn: 10, collarToWallIn: 6, ...route };   // 6 + 10 + 2 = 18" horizontal
  return s;
};

test('Boston 1200 in the ranch: 12 ft straight-up minimum; the ridge rule still governs', () => {
  const s = withManual(EXAMPLE_RANCH, { ...BOSTON_1200, minSystemHeightFt: BOSTON_HEIGHTS_FT.straight });
  const r = planChimney(s, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.geometry.requiredTopIn, 206);           // 31.75 + 144 = 175.75 < ridge 206
  assert.ok(r.notes.some(n => /accepts any UL 103 Type HT/.test(n)));
  assert.ok(!r.warnings.some(w => /not entered/.test(w)));
});

test('layout summary gives the user what their manual table needs', () => {
  const r = planChimney(bostonWall(), cat);              // height not entered yet
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.layout.tee, true);
  assert.equal(r.layout.horizontalRunFt, 1.5);
  assert.equal(r.layout.summary, '1 tee, no elbows, 1.5 ft of horizontal run, below 2,000 ft elevation');
  assert.equal(r.layout.highAltitude, false);
});

test('high altitude: the elevation, or the checkbox when it is blank, adds the catalog allowance', () => {
  const ranch = extra => ({ ...withManual(EXAMPLE_RANCH, { outletElevationIn: 30 }), ...extra });
  // straight up, blank manual: 15 ft x 1.3 for high altitude
  let r = planChimney(ranch({ highAltitude: true, siteElevationFt: 5280 }), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.geometry.requiredTopIn, 30 + 19.5 * 12);
  assert.match(r.warnings[0], /× 1\.3 for high altitude/);
  assert.equal(r.layout.summary, 'no tee, no elbows, no horizontal run, site elevation 5,280 ft');
  // ticked but no number
  r = planChimney(ranch({ highAltitude: true }), cat);
  assert.match(r.layout.summary, /above 2,000 ft elevation \(exact elevation not entered\)/);
  assert.equal(r.geometry.requiredTopIn, 30 + 19.5 * 12);
  // an elevation below the threshold wins over the checkbox
  r = planChimney(ranch({ highAltitude: true, siteElevationFt: 1500 }), cat);
  assert.equal(r.layout.highAltitude, false);
  assert.ok(r.notes.some(n => /below 2,000 ft, so no high-altitude allowance/.test(n)));
  // tee and high altitude: upper end of the 30-60% range
  const wall = { ...clone(EXAMPLE_THROUGH_WALL), highAltitude: true, siteElevationFt: 6000 };
  r = planChimney(wall, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.match(r.warnings[0], /× 1\.6 for the tee and high altitude/);
  // manual height entered: no factor, but a reminder to use the manual's high-altitude figure
  r = planChimney(ranch({ highAltitude: true, siteElevationFt: 5280, appliance: { ...BOSTON_1200, minSystemHeightFt: 14 } }), cat);
  assert.ok(r.notes.some(n => /High-altitude site: make sure the 14 ft/.test(n)));
});

test('Boston wall install with the manual height entered (Table 7: 12 + 3 tee + 3 horizontal = 18 ft)', () => {
  const r = planChimney(bostonWall({ minSystemHeightFt: BOSTON_HEIGHTS_FT.teePlus18inHorizontal }), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.manualHeightApplied, true);
  assert.equal(r.geometry.requiredTopIn, 31.75 + 18 * 12);
  assert.match(r.geometry.governingRule, /Enviro Boston 1200 FS manual minimum of 18 ft/);
});

test('Boston wall-route limits: 24" rise and 18" below the ceiling', () => {
  assert.match(planChimney(bostonWall({}, { thimbleCenterElevationIn: 50 }), cat).errors.join(), /requires 24"/);
  const ok = planChimney(bostonWall({}, { roomCeilingElevationIn: 84 }), cat);   // 84 - (60 + 4) = 20
  assert.ok(ok.ok, ok.errors.join('; '));
  assert.match(planChimney(bostonWall({}, { roomCeilingElevationIn: 80 }), cat).errors.join(), /requires 18"/);
});

// ------------------------------------------------------------------ offset angle by available height
const withOffsets = offsets => { const s = clone(RANCH); s.route.offsets = offsets; return s; };
const kit = r => r.parts.filter(p => p.category === 'ELBOW_KIT').map(p => p.order_number).join(',');

test('no height given, tall attic: open space is estimated and 15° fits', () => {
  const s = withOffsets([{ horizontalIn: 10 }]);
  s.roof.penetrationElevationIn = 200;          // open space: 200 - 10 framing - (96 + 11" box) = 83"
  const r = planChimney(s, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(kit(r), '6DT-E15KSS');
  assert.deepEqual(r.geometry.offsets[0], { n: 1, angleDeg: 15, requestedIn: 10, offsetIn: 11, riseIn: 50.25,
    betweenDesc: '36"', availableRiseIn: null, estimatedRoomIn: 83, chosen: 'AUTO', atIn: 107 });
  assert.ok(r.checks.some(c => /of about 83" open ceiling to roof \(estimated\)/.test(c.detail)));
});

test('no height given, short attic: 30° used and a warning that it may not fit', () => {
  const r = planChimney(withOffsets([{ horizontalIn: 10 }]), cat);   // ranch: 132 - 10 - 107 = 15"
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(kit(r), '6DT-E30KSS');
  assert.equal(r.geometry.offsets[0].estimatedRoomIn, 15);
  assert.ok(r.blockers.some(w => /needs 30.25" of height even with 30° elbows.*about 15"/.test(w)));
  const kitRow = r.parts.find(p => p.order_number === '6DT-E30KSS');
  assert.equal(kitRow.flags[0].level, 'STOP');           // the stop sign sits on the offset's parts
  assert.ok(r.parts.find(p => p.order_number === '6DT-18SS').flags.some(f => f.level === 'STOP'));
});

test('offset shifts: never below the chart minimum, never quietly different from what was asked', () => {
  let r = planChimney(withOffsets([{ horizontalIn: 1.5, availableRiseIn: 60 }]), cat);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /a 1.5" shift can't be built. The smallest offset 15° or 30° elbows make is 2"/);
  assert.deepEqual(r.errorFields[0].fields, ['offset.1']);
  r = planChimney(withOffsets([{ horizontalIn: 3, angle: 30, availableRiseIn: 60 }]), cat);
  assert.match(r.errors[0], /smallest offset 30° elbows make is 4"/);
  // off the chart: the next larger shift, flagged
  r = planChimney(withOffsets([{ horizontalIn: 5, availableRiseIn: 60 }]), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.geometry.offsets[0].offsetIn, 6.25);
  assert.ok(r.warnings.some(w => /no 5" shift; the nearest larger one, 6.25", is used/.test(w)));
  // on the chart: closest shift wins, so 9.25" uses 30° elbows rather than an 11" 15° offset
  r = planChimney(withOffsets([{ horizontalIn: 9.25, availableRiseIn: 60 }]), cat);
  assert.equal(r.geometry.offsets[0].offsetIn, 9.25);
  assert.equal(r.geometry.offsets[0].angleDeg, 30);
  // blank shift on an offset row: asked for
  r = planChimney(withOffsets([{ horizontalIn: null }]), cat);
  assert.match(r.errors[0], /Offset 1: choose the sideways shift/);
});

test('two offsets share the open space', () => {
  const s = withOffsets([{ horizontalIn: 10 }, { horizontalIn: 6 }]);
  s.roof.penetrationElevationIn = 200;          // 83" open: first 15° uses 50.25, leaving 32.75"
  const r = planChimney(s, cat);
  const [a, b] = r.geometry.offsets;
  assert.equal(a.angleDeg, 15);
  assert.equal(b.estimatedRoomIn, 32.75);
  assert.equal(b.atIn, 107 + 50.25);            // drawn above the first
  assert.ok(b.riseIn <= 32.75);
});

test('offset with 40" of height: 15° needs 50¼", so 30° is used (18" between, 12¼" shift, 30¼" rise)', () => {
  const r = planChimney(withOffsets([{ horizontalIn: 10, availableRiseIn: 40 }]), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(kit(r), '6DT-E30KSS');
  assert.equal(qty(r, '6DT-18SS') >= 1, true);
  assert.equal(r.geometry.offsets[0].riseIn, 30.25);
  assert.ok(r.notes.some(n => /15° elbows would need 50.25"/.test(n)));
  assert.ok(r.checks.some(c => /elbows use 30.25" of the 40" available/.test(c.detail)));
});

test('offset that fits neither angle in the height available', () => {
  const r = planChimney(withOffsets([{ horizontalIn: 10, availableRiseIn: 20 }]), cat);
  assert.match(r.errors.join(), /needs at least 30.25" of height, but only 20" is available/);
});

test('forced angles, and a manual that allows only 15°', () => {
  assert.equal(kit(planChimney(withOffsets([{ horizontalIn: 10, angle: 30 }]), cat)), '6DT-E30KSS');
  assert.match(planChimney(withOffsets([{ horizontalIn: 10, angle: 15, availableRiseIn: 40 }]), cat).errors.join(), /15° elbows needs at least 50.25"/);
  const only15 = withManual(withOffsets([{ horizontalIn: 10, angle: 30 }]), { offsetAnglesDeg: [15] });
  assert.match(planChimney(only15, cat).errors.join(), /30° elbows aren't allowed by the stove manual/);
});

// ------------------------------------------------------------------ chase exits and chase cover size
const chase = (top, w, d) => ({ type: 'CHASE', chaseTopElevationIn: top, chaseWidthIn: w, chaseDepthIn: d });

test('ceiling route into a chase on the roof: chase top flashing, no roof flashing', () => {
  const s = clone(RANCH);
  s.route.exit = chase(180, 18, 18);                  // 15 ft chase top, 18" square: 6DT-CTF covers 19.75"
  const r = planChimney(s, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6DT-CTF'), 1);
  assert.equal(qty(r, '5DT-SC'), 1);
  assert.equal(qty(r, '6DT-F6'), 0);
  assert.equal(r.geometry.exit, 'chase top');
  // default rule: 3-2-10 at the chase top; the 6" cap clearance and the roof the chase passes through still checked
  const checks = r.checks.filter(c => c.rule === 'termination' && c.status === 'INFO').map(c => c.detail);
  assert.ok(checks.some(c => /^6" from the chase top flashing to the bottom of the cap/.test(c)), checks.join(' | '));
  assert.ok(checks.some(c => /^3 ft above the chase top \(3-2-10 rule at the chase\): top at least 18' 0"/.test(c)), checks.join(' | '));
  assert.ok(checks.some(c => /^3 ft above the roof where the chase passes through it/.test(c)), checks.join(' | '));
  assert.ok(r.geometry.requiredTopIn >= 216);
  assert.ok(r.notes.some(n => /no roof flashing is listed/.test(n)));
});

test('chase-top rule options: 3-2-10, 2 ft, or a set height that is never under 6"', () => {
  const base = rule => {
    const s = withManual(EXAMPLE_CHASE_FIREPLACE, { minSystemHeightFt: 10 });
    s.nearbyWithin10ft = [];
    s.roof = { pitch: 6, surface: 'SHINGLE', elevationAtChimneyIn: 200 };   // roof beside the chase, well below its 300" top
    Object.assign(s.route.exit, rule);
    return s;
  };
  let r = planChimney(base({}), cat);                                 // default: 3-2-10
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.geometry.requiredTopIn, 336);
  r = planChimney(base({ topRule: 'TWO_FT' }), cat);
  assert.equal(r.geometry.requiredTopIn, 324);
  r = planChimney(base({ topRule: 'SET', aboveChaseIn: 6 }), cat);
  assert.equal(r.geometry.requiredTopIn, 306);
  assert.ok(r.geometry.chimneyTopIn >= 306);                          // pipe lengths round up, never down
  assert.match(r.geometry.governingRule, /6" from the chase top flashing/);
  r = planChimney(base({ topRule: 'SET', aboveChaseIn: 10 }), cat);
  assert.equal(r.geometry.requiredTopIn, 310);
  // less than 6": refused, tied to the field
  r = planChimney(base({ topRule: 'SET', aboveChaseIn: 5.5 }), cat);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /less than Duravent's minimum of 6"/);
  assert.deepEqual(r.errorFields[0].fields, ['chase.above']);
  r = planChimney(base({ topRule: 'SET' }), cat);
  assert.deepEqual(r.errorFields[0].fields, ['chase.above']);
  // the roof still governs when it is higher than the chase setting
  const s = base({ topRule: 'SET', aboveChaseIn: 6 });
  s.nearbyWithin10ft = [{ label: 'upper roof', elevationIn: 320 }];
  assert.equal(planChimney(s, cat).geometry.requiredTopIn, 344);
});

test('chase top larger than 6DT-CTF: custom cover listed with a caution', () => {
  const s = clone(RANCH);
  s.route.exit = chase(180, 24, 30);
  const r = planChimney(s, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6DT-CTF'), 0);
  const cover = r.parts.find(p => p.order_number === 'CUSTOM-CHASE-COVER');
  assert.equal(cover.non_catalog, true);
  assert.match(cover.description, /24" × 30", 11" chimney hole/);
  assert.equal(cover.flags[0].level, 'CAUTION');
  assert.ok(r.warnings.some(w => /larger than the 19.75" × 19.75" that 6DT-CTF covers/.test(w)));
  assert.equal(r.blockers.length, 0);
});

test('chase size not given: flashing listed with a note to check the size', () => {
  const s = clone(RANCH);
  s.route.exit = chase(180);
  const r = planChimney(s, cat);
  assert.equal(qty(r, '6DT-CTF'), 1);
  assert.ok(r.notes.some(n => /covers a chase top up to 19.75" × 19.75"/.test(n)));
});

test('chase top must be above the roof', () => {
  const s = clone(RANCH);
  s.route.exit = chase(120, 18, 18);
  const r = planChimney(s, cat);
  assert.match(r.errors.join(), /The top of the chase \(10' 0"\) isn't higher than the roof where the chimney comes out \(11' 0"\)/);
  assert.deepEqual(r.errorFields[0].fields, ['chase.top', 'roof.height']);
  s.route.exit = chase(null);
  const blank = planChimney(s, cat);
  assert.match(blank.errors.join(), /^Enter the height of the top of the chase in Chase Information \(2b\)/);
  assert.deepEqual(blank.errorFields[0].fields, ['chase.top']);
});

test('wall route enclosed in a chase: chase top exit, straps to the chase framing', () => {
  const s = clone(EXAMPLE_THROUGH_WALL);
  s.route.exit = chase(170, 30, 30);
  const r = planChimney(s, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, 'CUSTOM-CHASE-COVER'), 1);
  assert.equal(qty(r, '6DT-AWS-SS'), 1);
  assert.equal(r.geometry.exit, 'chase top');
});

test('thimble needing an extension carries a caution on its row', () => {
  const r = planChimney(EXAMPLE_THROUGH_WALL, cat);
  assert.equal(r.parts.find(p => p.order_number === '6DT-WT').flags[0].level, 'CAUTION');
});
