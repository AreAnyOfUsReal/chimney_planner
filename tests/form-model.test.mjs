import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeCatalog } from '../web/js/engine/catalog.js';
import { planChimney } from '../web/js/engine/planner.js';
import { EXAMPLE_RANCH } from '../web/js/engine/spec.js';
import { EXAMPLE_STATE, blankState, toSpec, toInches, fmtFtIn, passesThroughRoof } from '../web/js/ui/form-model.js';

const load = f => JSON.parse(readFileSync(new URL(`../web/catalog/${f}`, import.meta.url)));
const cat = makeCatalog(load('index.json'), load('DT.json'));
const clone = o => structuredClone(o);

test('feet + inches conversion and formatting', () => {
  assert.equal(toInches(8, 6), 102);
  assert.equal(toInches('', ''), null);
  assert.equal(toInches(null, 9), 9);
  assert.equal(fmtFtIn(206.25), `17' 2¼"`);
  assert.equal(fmtFtIn(144), `12' 0"`);
});

test('the example form produces the same plan as the engine example', () => {
  const a = planChimney(toSpec(EXAMPLE_STATE), cat);
  const b = planChimney(EXAMPLE_RANCH, cat);
  assert.ok(a.ok, a.errors.join('; '));
  assert.deepEqual(a.parts.map(p => [p.order_number, p.qty]), b.parts.map(p => [p.order_number, p.qty]));
  assert.equal(a.geometry.chimneyTopIn, b.geometry.chimneyTopIn);
});

test('wall route, gable end: roof height is the roof beside the chimney, not a penetration', () => {
  const s = clone(EXAMPLE_STATE);
  s.route = 'WALL';
  s.nearby = [{ label: 'gable roof edge', ft: 12, in: 6 }];
  const spec = toSpec(s);
  assert.equal(passesThroughRoof(s), false);
  assert.equal(spec.roof.penetrationElevationIn, undefined);
  assert.equal(spec.roof.elevationAtChimneyIn, 132);
  assert.equal(spec.route.thimbleCenterElevationIn, 60);
  assert.deepEqual(spec.nearbyWithin10ft, [{ label: 'gable roof edge', elevationIn: 150 }]);
  assert.ok(planChimney(spec, cat).ok);
});

test('fireplace answers map to a fireplace route and manual', () => {
  const s = clone(EXAMPLE_STATE);
  s.appliance = { ...s.appliance, kind: 'FIREPLACE', collar: '8', outletFt: 5, outletIn: 0,
                  minHeightFt: 14, maxOffsets: '1', only15: true, connection: 'DIRECT' };
  s.fireplace.floors = [{ ft: 9, in: 0 }];
  s.chase.topFt = 25;
  s.nearby = [{ label: 'main roof ridge', ft: 26, in: 8 }];
  const spec = toSpec(s);
  assert.equal(spec.route.type, 'FIREPLACE');
  assert.equal(spec.appliance.type, 'FACTORY_FIREPLACE');
  assert.deepEqual(spec.appliance.offsetAnglesDeg, [15]);
  assert.equal(spec.appliance.maxOffsets, 1);
  assert.deepEqual(spec.route.floorPenetrationsIn, [108]);
  assert.equal(spec.route.exit.chaseTopElevationIn, 300);
  const r = planChimney(spec, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.geometry.requiredTopIn, 344);
});

test('blank optional answers are left out rather than sent as zero', () => {
  const spec = toSpec(EXAMPLE_STATE);
  assert.equal(spec.appliance.minSystemHeightFt, undefined);
  assert.equal(spec.appliance.maxOffsets, undefined);
  assert.equal(spec.siteElevationFt, undefined);
  assert.equal(spec.highAltitude, undefined);
});

import { roofHeightIn } from '../web/js/ui/form-model.js';

test('roof height from the eave: eave + level distance x pitch', () => {
  assert.equal(roofHeightIn(EXAMPLE_STATE), 132);                       // 9 ft + 4 ft x 6/12 = 11 ft
  const s = clone(EXAMPLE_STATE);
  s.roof = { ...s.roof, pitch: 8, eaveFt: 10, eaveIn: 6, fromEaveFt: 3 };
  assert.equal(roofHeightIn(s), 126 + 24);                             // 10'6" + 3 ft x 8/12 = 12'6"
  s.roof.fromEaveFt = null;
  assert.equal(roofHeightIn(s), null);                                  // incomplete -> no guess
  assert.equal(toSpec(s).roof.penetrationElevationIn, undefined);
});

test('roof height entered directly', () => {
  const s = clone(EXAMPLE_STATE);
  s.roof = { ...s.roof, method: 'DIRECT', ft: 12, in: 3 };
  assert.equal(roofHeightIn(s), 147);
  assert.equal(toSpec(s).roof.penetrationElevationIn, 147);
});

test('the website does not ask about chimney approval: the user has chosen DuraTech', () => {
  assert.equal(toSpec(EXAMPLE_STATE).appliance.acceptsChimney, 'USER_CONFIRMED');
  const r = planChimney(toSpec(EXAMPLE_STATE), cat);
  assert.ok(!r.warnings.some(w => /Confirm the .* manual accepts/.test(w)));
  const fp = clone(EXAMPLE_STATE);
  fp.appliance = { ...fp.appliance, kind: 'FIREPLACE', collar: '8' };
  fp.nearby = [{ label: 'ridge', ft: 26, in: 0 }];
  assert.ok(planChimney(toSpec(fp), cat).ok);          // fireplaces no longer stopped for a missing answer
});

test('offsets are sent only when the user says the chimney needs one', () => {
  const s = clone(EXAMPLE_STATE);
  s.ceiling.offsets = [{ in: 10 }];
  assert.deepEqual(toSpec(s).route.offsets, []);                       // still "Straight up"
  s.ceiling.jog = 'OFFSET';
  assert.deepEqual(toSpec(s).route.offsets, [{ horizontalIn: 10 }]);
  s.ceiling.offsets.push({ in: null });                                 // blank row kept: the planner asks for it
  assert.deepEqual(toSpec(s).route.offsets, [{ horizontalIn: 10 }, { horizontalIn: null }]);
});

test('offset rows carry height available and a forced angle when given', () => {
  const s = clone(EXAMPLE_STATE);
  s.ceiling.jog = 'OFFSET';
  s.ceiling.offsets = [{ in: 10, room: 40, angle: 'AUTO' }, { in: 6, room: null, angle: '30' }];
  assert.deepEqual(toSpec(s).route.offsets, [{ horizontalIn: 10, availableRiseIn: 40 }, { horizontalIn: 6, angle: 30 }]);
});

import { usesChase } from '../web/js/ui/form-model.js';

test('chase answers are shared by every route that ends in a chase', () => {
  const s = clone(EXAMPLE_STATE);
  s.chase = { topFt: 15, topIn: 6, widthIn: 24, depthIn: 30, airIntake: true, shroud: false, topRule: 'CODE', aboveIn: 6 };
  assert.equal(usesChase(s), false);
  s.ceiling.exit = 'CHASE';
  assert.equal(usesChase(s), true);
  assert.deepEqual(toSpec(s).route.exit, { type: 'CHASE', chaseTopElevationIn: 186, chaseWidthIn: 24, chaseDepthIn: 30, airIntake: true, shroud: false,
                                               topRule: 'CODE', aboveChaseIn: undefined });
  assert.equal(toSpec(s).roof.penetrationElevationIn, 132);           // still passes the roof deck inside the chase
  s.route = 'WALL'; s.wall.eave = 'CHASE';
  const w = toSpec(s).route;
  assert.equal(w.eave, 'NONE');
  assert.equal(w.exit.chaseTopElevationIn, 186);
});

test('two-story: second floor then attic -> firestop at the second-floor ceiling, attic shield, enclosure caution', () => {
  const s = clone(EXAMPLE_STATE);
  s.ceiling = { ...s.ceiling, above: 'STORY_ATTIC', storyFt: 8, storyIn: 0, floorThickIn: 12 };
  s.roof = { ...s.roof, method: 'DIRECT', ft: 20, in: 0 };        // roof at the chimney 20 ft above the stove floor
  const spec = toSpec(s);
  assert.deepEqual(spec.route.floorPenetrationsIn, [96 + 12 + 96]);
  assert.equal(spec.route.atticAbove, true);
  const r = planChimney(spec, cat);
  assert.ok(r.ok, r.errors.join('; '));
  const has = pn => r.parts.some(p => p.order_number === pn);
  assert.ok(has('6DT-CS11-2') && has('6DT-FRS') && has('6DT-IS'));
  assert.ok(r.warnings.some(w => /passes through a second-floor room/.test(w)));
});

test('two-story with a vaulted second floor: no attic, no firestop, enclosure caution', () => {
  const s = clone(EXAMPLE_STATE);
  s.ceiling = { ...s.ceiling, above: 'STORY_ROOF' };
  s.roof = { ...s.roof, method: 'DIRECT', ft: 18, in: 0 };
  const spec = toSpec(s);
  assert.deepEqual(spec.route.floorPenetrationsIn, []);
  assert.equal(spec.route.atticAbove, false);
  const r = planChimney(spec, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.ok(!r.parts.some(p => /FRS|-IS$/.test(p.order_number)));
  assert.ok(r.warnings.some(w => /second-floor room/.test(w)));
});

import { deckUndersideIn, atticMethodApplies } from '../web/js/ui/form-model.js';

test('attic measured from the top of the joists: ceiling + drywall + joists + attic + deck', () => {
  const s = clone(EXAMPLE_STATE);
  s.attic = { from: 'JOISTS', ft: 3, in: 0, joistIn: 7.25, drywallIn: 0.5, deckIn: 1 };
  s.roof.method = 'ATTIC';
  assert.equal(atticMethodApplies(s), true);
  assert.equal(deckUndersideIn(s), 96 + 0.5 + 7.25 + 36);              // 139.75"
  assert.equal(roofHeightIn(s), 140.75);
  const spec = toSpec(s);
  assert.equal(spec.roof.penetrationElevationIn, 140.75);
  assert.equal(spec.roof.deckUndersideElevationIn, 139.75);
  // two-story: from the second-floor ceiling
  s.ceiling = { ...s.ceiling, above: 'STORY_ATTIC', storyFt: 8, storyIn: 0, floorThickIn: 12 };
  assert.equal(roofHeightIn(s), 204 + 0.5 + 7.25 + 36 + 1);
  // not applicable on a wall route: falls back to the eave method
  s.route = 'WALL';
  assert.equal(atticMethodApplies(s), false);
  assert.equal(roofHeightIn(s), 132);
});

test('attic measured from the top of the drywall: joist depth is not added', () => {
  const s = clone(EXAMPLE_STATE);
  s.attic = { from: 'DRYWALL', ft: 3, in: 7.25, joistIn: 7.25, drywallIn: 0.5, deckIn: 1 };
  s.roof.method = 'ATTIC';
  assert.equal(deckUndersideIn(s), 96 + 0.5 + 43.25);                  // same deck as above, measured lower
});

test('attic measurement feeds offsets even when the roof height comes from the eave', () => {
  const s = clone(EXAMPLE_STATE);                                      // roof 132" by the eave method
  s.roof.ridgeFt = 20;
  s.attic = { from: 'JOISTS', ft: 2, in: 0, joistIn: 7.25, drywallIn: 0.5, deckIn: 1 };   // deck underside 127.75"
  s.ceiling.jog = 'OFFSET';
  s.ceiling.offsets = [{ in: 6, room: null, angle: 'AUTO' }];
  const r = planChimney(toSpec(s), cat);
  assert.equal(r.geometry.offsets[0].estimatedRoomIn, 127.75 - (96 + 11));   // 20.75" measured
});

test('attic measurement above the roof is caught and points at both answers', () => {
  const s = clone(EXAMPLE_STATE);
  s.attic = { from: 'JOISTS', ft: 4, in: 0, joistIn: 7.25, drywallIn: 0.5, deckIn: 1 };   // 151.75" > roof 132"
  const r = planChimney(toSpec(s), cat);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errorFields[0].fields, ['attic.height', 'roof.height']);
});

test('errors name the form answers they concern', () => {
  const s = clone(EXAMPLE_STATE);
  s.ceiling = { ...s.ceiling, above: 'STORY_ATTIC', storyFt: 8, storyIn: 0, floorThickIn: 12 };   // attic floor at 204"
  const r = planChimney(toSpec(s), cat);                                // roof still 132": below the second floor
  assert.equal(r.ok, false);
  const e = r.errorFields.find(x => /Second-floor ceiling at 17 ft is at or above where the chimney leaves the building \(11 ft\)/.test(x.text));
  assert.deepEqual(e.fields, ['floors', 'roof.height', 'chase.top']);
});

test('site elevation is sent only when the high-altitude box is ticked', () => {
  const s = structuredClone(EXAMPLE_STATE);
  s.chimney.siteElevationFt = 5000;
  assert.equal(toSpec(s).siteElevationFt, undefined);
  s.chimney.highAltitude = true;
  const spec = toSpec(s);
  assert.equal(spec.highAltitude, true);
  assert.equal(spec.siteElevationFt, 5000);
});

test('chase-top rule: a set height is sent only with the SET rule', () => {
  const s = structuredClone(EXAMPLE_STATE);
  s.ceiling.exit = 'CHASE';
  s.chase.aboveIn = 10;
  assert.equal(toSpec(s).route.exit.aboveChaseIn, undefined);
  s.chase.topRule = 'SET';
  assert.equal(toSpec(s).route.exit.aboveChaseIn, 10);
});

test('minimums display rounded up, never down', () => {
  assert.equal(fmtFtIn(206.1), `17' 2"`);
  assert.equal(fmtFtIn(206.1, true), `17' 2¼"`);
  assert.equal(fmtFtIn(206, true), `17' 2"`);
});

test('cleared form: nothing guessed, the planner asks for the first missing answer', () => {
  const s = blankState();
  assert.equal(toSpec(s).appliance.collarSizeIn, null);
  assert.equal(toSpec(s).roof.pitch, null);
  assert.equal(roofHeightIn(s), null);
  const r = planChimney(toSpec(s), cat);
  assert.equal(r.ok, false);
  // fill the stove and ceiling, leave the pitch blank: refused, not treated as flat
  Object.assign(s.appliance, { collar: '6', outletFt: 2, outletIn: 6 });
  Object.assign(s.ceiling, { ft: 8, in: 0 });
  Object.assign(s.roof, { method: 'DIRECT', ft: 11, in: 0 });
  const r2 = planChimney(toSpec(s), cat);
  assert.deepEqual(r2.errorFields[0].fields, ['roof.pitch']);
  s.roof.pitch = 6;
  assert.ok(planChimney(toSpec(s), cat).ok);
});
