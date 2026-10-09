/** Pure geometry helpers: pipe-length selection, 3-2-10 termination, elbow offsets. */

/**
 * Chimney pipe the planner may use for a size and finish: one part per nominal length,
 * preferring the standard carton over the carton-filler (CF) variant, excluding
 * interior-only painted sections.
 */
export function pipeStock(cat, size, finish) {
  const best = new Map();
  for (const p of cat.parts('CHIMNEY_PIPE', size)) {
    if (p.finish !== finish || p.attributes?.interior_only) continue;
    const cur = best.get(p.nominal_length_in);
    if (!cur || (cur.carton_filler && !p.carton_filler)) best.set(p.nominal_length_in, p);
  }
  return [...best.values()].sort((a, b) => b.nominal_length_in - a.nominal_length_in);
}

/**
 * Choose pipe sections whose INSTALLED (effective) lengths add up to at least needIn.
 * Cost = overshoot inches + jointPenaltyIn per section, so it trades a little extra height
 * for fewer joints. Exact search over quarter inches (dynamic programming), not greedy.
 */
export function selectPipe(needIn, stock, { jointPenaltyIn = 3 } = {}) {
  if (needIn <= 0) return { pieces: [], installedIn: 0, overshootIn: 0 };
  if (!stock.length) return null;
  const Q = 4;
  const eff = stock.map(p => Math.round(p.effective_length_in * Q));
  const target = Math.ceil(needIn * Q - 1e-9);
  const limit = target + Math.max(...eff);
  const count = new Array(limit + 1).fill(Infinity);
  const from = new Array(limit + 1).fill(-1);
  count[0] = 0;
  for (let s = 1; s <= limit; s++) {
    for (let i = 0; i < eff.length; i++) {
      if (eff[i] <= s && count[s - eff[i]] + 1 < count[s]) {
        count[s] = count[s - eff[i]] + 1;
        from[s] = i;
      }
    }
  }
  let best = -1, bestCost = Infinity;
  for (let s = target; s <= limit; s++) {
    if (count[s] === Infinity) continue;
    const cost = (s - target) / Q + jointPenaltyIn * count[s];
    if (cost < bestCost) { bestCost = cost; best = s; }
  }
  const pieces = [];
  for (let s = best; s > 0; s -= eff[from[s]]) pieces.push(stock[from[s]]);
  pieces.sort((a, b) => b.nominal_length_in - a.nominal_length_in);
  const installedIn = pieces.reduce((t, p) => t + p.effective_length_in, 0);
  return { pieces, installedIn, overshootIn: installedIn - needIn };
}

/**
 * Minimum elevation for the top of the chimney pipe (the cap sits above this).
 * Applies the termination rules stored in the catalog:
 *   - N ft above where the chimney exits (roof penetration or chase top), at the high side
 *   - M ft above any part of the building within R ft horizontally
 * The roof surface within R ft is computed from pitch and the ridge distance, which is measured
 * level from the chimney's uphill side (outer wall), as installers measure it.
 *
 * @param exit  {elevationIn, pitch, label} where the chimney leaves the building, or null
 *              when it never passes through it (e.g. up a gable-end wall).
 *              A chase top exit carries aboveChecks [{label, aboveIn}] (the chosen chase-top rule and
 *              the cap clearance) in place of the 3 ft rule; and, for a chase built on the roof,
 *              {roofPenetration: {elevationIn, pitch}} where the chase passes through the roof.
 */
export function terminationHeight(spec, cat, outerDiameterIn, exit) {
  const aboveFt = cat.rule('term.min_above_penetration_ft').value;
  const clearFt = cat.rule('term.min_above_within_horizontal_ft').value;
  const radiusFt = cat.rule('term.horizontal_check_distance_ft').value;
  const checks = [];
  const roof = spec.roof || {};

  const highSide = e => e.elevationIn + (outerDiameterIn / 2) * (e.pitch ?? 0) / 12;
  if (exit?.aboveChecks) {
    // e.g. a chase top: the planner says what the chimney must clear it by
    for (const a of exit.aboveChecks) checks.push({ label: a.label, topIn: exit.elevationIn + a.aboveIn });
  } else if (exit) {
    checks.push({ label: `${aboveFt} ft above the ${exit.label} (high side)`, topIn: highSide(exit) + aboveFt * 12 });
  }
  if (exit?.roofPenetration) {
    checks.push({ label: `${aboveFt} ft above the roof where the chase passes through it (high side)`,
                  topIn: highSide(exit.roofPenetration) + aboveFt * 12 });
  }
  // Sloped roof beside or around the chimney: the roof surface rises toward the ridge.
  const roofAt = roof.penetrationElevationIn ?? roof.elevationAtChimneyIn;
  if (roofAt != null) {
    const pitch = roof.pitch ?? 0;
    // ridge distance and the 10 ft zone are measured level from the chimney's UPHILL side (its outer
    // wall); roofAt is at the chimney's center, so add the radius to reach the roof height there
    const toRidge = roof.horizontalToRidgeFt ?? Infinity;
    const runIn = Math.min(toRidge, radiusFt) * 12 + outerDiameterIn / 2;
    const where = toRidge <= radiusFt ? 'the ridge' : `the roof ${radiusFt} ft upslope`;
    checks.push({ label: `${clearFt} ft above ${where}`, topIn: roofAt + runIn * pitch / 12 + clearFt * 12 });
  }
  for (const n of spec.nearbyWithin10ft || []) {
    checks.push({ label: `${clearFt} ft above ${n.label}`, topIn: n.elevationIn + clearFt * 12 });
  }
  if (!checks.length) return null;
  const governing = checks.reduce((a, b) => (b.topIn > a.topIn ? b : a));
  return { requiredTopIn: governing.topIn, governing, checks };
}

/** Parse the elbow chart's "between" text ('48" + 6"', '0"') into nominal pipe lengths. */
export function parseBetween(desc) {
  return (desc.match(/\d+(\.\d+)?/g) || []).map(Number).filter(n => n > 0);
}

/**
 * Pick an elbow-chart entry for an offset.
 * The shift must be one the chart can make: no entry shifts less than horizontalIn, so the chimney
 * always clears what it is dodging. Among entries that fit maxRiseIn (when given), the one closest
 * to the asked shift wins; on a tie, the earlier angle in `angles` (15° first: gentler on draft).
 * Returns { row } or, when nothing works, { reason: 'REACH' } (chart can't shift that far) or
 * { reason: 'RISE', needRiseIn, angle } (it can, but needs more height than is available).
 */
export function chooseOffset(horizontalIn, chart, angles = [15, 30], maxRiseIn = null) {
  const reach = chart
    .filter(r => angles.includes(r.angle_deg) && r.offset_in >= horizontalIn - 1e-9)
    .sort((a, b) => a.offset_in - b.offset_in || angles.indexOf(a.angle_deg) - angles.indexOf(b.angle_deg));
  if (!reach.length) return { reason: 'REACH' };
  const fits = reach.find(r => maxRiseIn == null || r.rise_in <= maxRiseIn);
  if (fits) return { row: fits };
  const tightest = reach.reduce((a, b) => (b.rise_in < a.rise_in ? b : a));
  return { reason: 'RISE', needRiseIn: tightest.rise_in, angle: tightest.angle_deg };
}

/** Shifts the chart can make with the given angles, smallest first: [{offsetIn, rows}] */
export function offsetChoices(chart, angles = [15, 30]) {
  const by = new Map();
  for (const r of chart.filter(r => angles.includes(r.angle_deg)).sort((a, b) => a.offset_in - b.offset_in)) {
    if (!by.has(r.offset_in)) by.set(r.offset_in, []);
    by.get(r.offset_in).push(r);
  }
  return [...by].map(([offsetIn, rows]) => ({ offsetIn, rows }));
}
