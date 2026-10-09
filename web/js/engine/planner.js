/**
 * Chimney planner: ChimneySpec + catalog -> parts list, rule checks, warnings.
 *
 * Pure function, no DOM, no network. Duravent and code numbers come from the catalog
 * (rules.csv / parts.csv); the appliance's own limits come from spec.appliance, which the
 * user fills in from their stove or fireplace manual. Geometry is in geometry.js.
 * Where sources overlap, the strictest wins: highest minimum, lowest maximum.
 *
 * Scope: the CHIMNEY only - from the ceiling support box, wall thimble or fireplace
 * anchor plate up to the cap. The stovepipe connector is a later step.
 *
 * Routes:
 *   CEILING   stove below a ceiling support box, up through floors/attic/roof
 *   WALL      horizontal through a wall thimble into a tee, up the outside wall
 *   FIREPLACE factory-built fireplace, chimney sits on the fireplace (anchor plate),
 *             exits through a chase top or the roof
 */
import { attr } from './catalog.js';
import { pipeStock, selectPipe, terminationHeight, parseBetween, chooseOffset } from './geometry.js';

const ZONE_ORDER = ['appliance', 'wall', 'ceiling', 'support', 'pipe', 'offset', 'attic', 'roof', 'chase', 'termination', 'hardware'];
const ft = in_ => Math.round(in_ / 12 * 10) / 10;
/** Inches as a builder reads them: 140.5 -> 11' 8½" */
/** up=true rounds UP to the quarter inch: use it for minimums, so a shown requirement is never below the real one. */
const ftIn = (in_, up = false) => {
  const t = (up ? Math.ceil(in_ * 4 - 1e-9) : Math.round(in_ * 4)) / 4, f = Math.floor(t / 12), i = t - f * 12, w = Math.floor(i);
  return `${f}' ${w}${{ 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[i - w]}"`;
};
const inTxt = v => `${Math.round(v * 100) / 100}"`;
const ENTER_CHASE_TOP = 'Enter the height of the top of the chase in Chase Information (2b), measured from the floor the appliance stands on. The chimney has to reach a set height above the chase top, so the planner can\'t size it without this.';
const r2 = n => Math.round(n * 100) / 100;
const words = s => s.toLowerCase().replace(/_/g, ' ');

class Plan {
  constructor(cat) {
    this.cat = cat;
    this.items = new Map();
    this.errors = [];
    this.errorFields = [];
    this.warnings = [];
    this.notes = [];
    this.checks = [];
    this.geometry = {};
    this.blockers = [];          // STOP: may stop the installation as planned
    this.flags = new Map();      // order_number -> [{ level, text }] for the parts table
  }
  /**
   * Record a problem the user must act on.
   * STOP    = could block the installation as planned (shown with a stop sign)
   * CAUTION = needs attention or a different part (shown with a warning triangle)
   * Either can point at the part rows it concerns.
   */
  issue(level, text, orders = []) {
    (level === 'STOP' ? this.blockers : this.warnings).push(text);
    for (const o of orders) {
      if (!this.flags.has(o)) this.flags.set(o, []);
      this.flags.get(o).push({ level, text });
    }
  }
  add(part, qty, reason) {
    const cur = this.items.get(part.order_number);
    if (cur) { cur.qty += qty; cur.reasons.add(reason); }
    else this.items.set(part.order_number, { part, qty, reasons: new Set([reason]) });
  }
  /** An error that prevents a plan; `fields` names the form answers it concerns (see the page's field map). */
  fail(text, fields = []) {
    this.errors.push(text);
    this.errorFields.push({ text, fields });
  }
  check(rule, pass, detail, fields = []) {
    this.checks.push({ rule, status: pass ? 'PASS' : 'FAIL', detail });
    if (!pass) this.fail(detail, fields);
  }
  /** First part matching; records an error and returns null if none. */
  pick(category, size, pred, what) {
    const found = this.cat.parts(category, size).filter(pred);
    if (!found.length) { this.errors.push(`No ${what} available in size ${size}.`); return null; }
    return found[0];
  }
  result() {
    const zone = c => this.cat.categories.get(c)?.system_zone;
    const lines = [...this.items.values()]
      .map(({ part, qty, reasons }) => ({
        order_number: part.order_number, stock_number: part.stock_number ?? null,
        description: part.description, category: part.category, zone: zone(part.category),
        qty, reasons: [...reasons], optional: !!part.optional, catalog_page: part.source_page ?? null,
        catalog_note: part.note ?? null, non_catalog: !!part.nonCatalog, flags: this.flags.get(part.order_number) ?? [],
      }))
      .sort((a, b) => ZONE_ORDER.indexOf(a.zone) - ZONE_ORDER.indexOf(b.zone) || a.order_number.localeCompare(b.order_number));
    return { ok: this.errors.length === 0, errors: this.errors, warnings: this.warnings, notes: this.notes,
             blockers: this.errors.length ? [] : this.blockers, errorFields: this.errorFields,
             checks: this.checks, geometry: this.geometry, layout: this.layout ?? null,
             manualHeightApplied: this.manualHeightApplied ?? false, parts: this.errors.length ? [] : lines };
  }
}

export function planChimney(spec, cat) {
  const plan = new Plan(cat);
  const m = spec.appliance;
  if (!m || m.outletElevationIn == null) {
    plan.fail('Need the height of the top of the appliance flue outlet (collar) above the floor.', ['appliance.outlet']);
    return plan.result();
  }
  const isFireplace = (m.type || 'STOVE') === 'FACTORY_FIREPLACE';
  if (isFireplace !== (spec.route?.type === 'FIREPLACE')) {
    plan.fail(isFireplace ? 'A factory-built fireplace uses the fireplace installation type.' : 'The fireplace installation type is for factory-built fireplaces.', ['appliance.kind']);
    return plan.result();
  }
  if (spec.size == null && m.collarSizeIn == null) { plan.fail('Need the flue collar size from the appliance.', ['appliance.collar']); return plan.result(); }
  if (spec.size != null && m.collarSizeIn != null && Number(spec.size) !== Number(m.collarSizeIn)) {
    plan.fail(`A ${spec.size}" chimney doesn't match the ${m.collarSizeIn}" flue collar. ${cat.rule('dt.diameter_match_appliance').statement}`, ['appliance.collar']);
    return plan.result();
  }
  const size = String(spec.size ?? m.collarSizeIn);
  const sizeRow = cat.sizes.find(s => s.size === size);
  if (!sizeRow) {
    plan.fail(`${cat.line.name} is not made in a ${size}" size (available: ${cat.sizes.map(s => s.size).join(', ')}).`, ['appliance.collar']);
    return plan.result();
  }
  let finish = spec.finish || 'SS';
  if (!pipeStock(cat, size, finish).length) {
    plan.warnings.push(`${size}" ${cat.line.name} pipe is not offered in ${finish}; using SS instead.`);
    finish = 'SS';
  }
  const ctx = {
    spec, cat, plan, size, finish, outerIn: sizeRow.outer_in, stock: pipeStock(cat, size, finish),
    usesTee: false, offsets: 0, offsetRiseIn: 0,
    exit: null,                       // {elevationIn, pitch, label} where the chimney leaves the building
    maxOffsets: cat.rule('dt.max_offsets').value, offsetAngles: [15, 30],
    appliance: null,                  // stove or fireplace whose own manual adds limits
    offsetAnglesUsed: [], offsetsUsed: [], horizontalRunIn: 0,
    lateralSupportsIn: null,          // elevations that hold the chimney sideways (chase runs)
  };
  // high altitude: the elevation decides when it is given; otherwise the user's "high altitude" answer
  ctx.altitudeThresholdFt = cat.rule('draft.high_altitude_threshold_ft').value;
  ctx.highAltitude = spec.siteElevationFt != null ? spec.siteElevationFt >= ctx.altitudeThresholdFt : !!spec.highAltitude;
  if (spec.siteElevationFt != null && spec.highAltitude && !ctx.highAltitude) {
    plan.notes.push(`At ${spec.siteElevationFt} ft, the site is below ${ctx.altitudeThresholdFt.toLocaleString('en-US')} ft, so no high-altitude allowance is made.`);
  }

  plan.notes.push(`Maintain at least ${cat.rule('dt.clearance_to_combustibles_in').value}" air space to combustibles along the entire chimney.`);
  const route = spec.route?.type;
  if (!readManual(ctx)) return plan.result();
  const roofGiven = spec.roof?.penetrationElevationIn != null || spec.roof?.elevationAtChimneyIn != null;
  if ((roofGiven || route === 'CEILING') && spec.roof?.pitch == null) {
    plan.fail('Choose the roof pitch in Roof Information (4). The roof\'s slope sets how high the chimney must go, so it can\'t be guessed.', ['roof.pitch']);
    return plan.result();
  }
  if (route === 'CEILING') planCeilingRoute(ctx);
  else if (route === 'WALL') planWallRoute(ctx);
  else if (route === 'FIREPLACE') planFireplaceRoute(ctx);
  else plan.errors.push(`Unknown route type '${route}'.`);

  if (!plan.errors.length && ctx.appliance.requiresRoofRadiationShield) {
    const rrs = plan.pick('ROOF_RADIATION_SHIELD', size, () => true, 'roof radiation shield');
    if (rrs) plan.add(rrs, 1, `Required by the ${ctx.appliance.label} manual. ${cat.rule('dt.roof_radiation_shield_per_appliance').statement}`);
  }
  if (!plan.errors.length) termination(ctx);
  if (!plan.errors.length) draftCheck(ctx);
  plan.notes.push(cat.rule('dt.inspection_recommended').statement);
  return plan.result();
}

// --------------------------------------------------------------------- ceiling route
function planCeilingRoute(ctx) {
  const { spec, cat, plan, size } = ctx;
  const { ceiling, atticAbove = false, floorPenetrationsIn = [], offsets = [] } = spec.route;
  const style = ceiling.style;
  let support;

  if (style === 'CATHEDRAL') {
    if (ceiling.pitch == null) { plan.fail('A cathedral ceiling needs its pitch.', ['ceiling.pitch']); return; }
    if (atticAbove) { plan.fail('A cathedral ceiling has no attic above it; check the ceiling style.', ['ceiling.style']); return; }
    if ((ceiling.support || 'SQUARE') !== 'SQUARE') plan.warnings.push('Cathedral ceilings use the square support box; ignoring the chosen support style.');
    const h = supportBoxHeight(ctx, Math.round(ceiling.pitch));
    if (h == null) return;
    support = plan.pick('CEILING_SUPPORT_SQUARE', size,
      p => p.height_in === h && !!attr(p, 'reduced_clearance') === !!ceiling.reducedClearance,
      `${h}" square ceiling support box${ceiling.reducedClearance ? ' (reduced clearance)' : ''}`);
    if (support) plan.add(support, 1, `Supports the chimney in a ${ceiling.pitch}/12 cathedral ceiling (box height set by ceiling pitch and ${spec.connectorLine} connector)`);
  } else if (style === 'FLAT') {
    const choice = ceiling.support || 'SQUARE';
    if (choice === 'SQUARE') {
      const h = supportBoxHeight(ctx, 0);
      if (h == null) return;
      support = plan.pick('CEILING_SUPPORT_SQUARE', size,
        p => p.height_in === h && !!attr(p, 'reduced_clearance') === !!ceiling.reducedClearance, `${h}" square ceiling support box`);
    } else if (choice === 'SQUARE_COLLAR') {
      support = cat.parts('CEILING_SUPPORT_SQUARE_COLLAR', size)
        .filter(p => !!attr(p, 'reduced_clearance') === !!ceiling.reducedClearance)
        .sort((a, b) => a.height_in - b.height_in)[0];
      if (!support) plan.fail(`The square support box with collar is not made for ${size}"${ceiling.reducedClearance ? ' in reduced clearance' : ''}; choose another support.`, ['ceiling.support', 'ceiling.reduced']);
    } else if (choice === 'ROUND') {
      support = plan.pick('CEILING_SUPPORT_ROUND', size, () => true, 'round ceiling support box');
      const wantRound = (ceiling.roundTrim || 'ROUND') === 'ROUND';
      const trim = plan.pick('TRIM_COLLAR_ROUND_BOX', size, p => /-TCR-/.test(p.order_number) === wantRound, 'trim collar for the round support box');
      if (trim) plan.add(trim, 1, 'Covers the gap between the round support box and the ceiling cut-out (sold separately)');
    } else if (choice === 'FLAT_UNPAINTED') {
      support = plan.pick('CEILING_SUPPORT_FLAT', size, () => true, 'unpainted flat ceiling support box');
    } else plan.fail(`Unknown ceiling support '${choice}'.`, ['ceiling.support']);
    if (support) plan.add(support, 1, 'Supports the chimney at the flat ceiling above the appliance');
  } else { plan.errors.push(`Unknown ceiling style '${style}'.`); return; }
  if (!support) return;
  ctx.support = support;
  ctx.startElevationIn = ceiling.elevationIn;
  plan.notes.push('Chimney length is measured from the ceiling plane at the support box. Confirm the starter-section position in the support box installation instructions.');

  const roofPen = spec.roof?.penetrationElevationIn;
  if (roofPen == null) { plan.fail('A through-the-ceiling chimney needs the roof elevation at the chimney.', ['roof.height']); return; }
  const deck = spec.roof?.deckUndersideElevationIn;
  if (deck != null && deck >= roofPen) {
    plan.fail(`The attic measurement puts the underside of the roof deck at ${ft(deck)} ft, at or above the roof height of ${ft(roofPen)} ft. Check the attic height and the roof height.`,
      ['attic.height', 'roof.height']);
    return;
  }
  if (roofPen <= ceiling.elevationIn) { plan.fail('The roof must be above the ceiling support box.', ['roof.height', 'ceiling.height']); return; }
  if (!floorShields(ctx, floorPenetrationsIn, roofPen, 'FIRESTOP')) return;
  if (spec.route.throughLivingSpace) {
    plan.issue('CAUTION', 'The chimney passes through a second-floor room. Enclose it there (a framed chase or boxed-in wall) with the 2" air space kept, so it is protected from contact and storage; check the DuraTech installation instructions and local code for the enclosure requirement.');
  }
  atticShield(ctx, atticAbove, attr(support, 'functions_as_attic_shield') && floorPenetrationsIn.length === 0, 'support box collar');
  // the support box sits above the ceiling, so open space starts at its top
  planOffsets(ctx, offsets, openSpaces(ceiling.elevationIn + (support.height_in ?? 0), floorPenetrationsIn, roofPen,
    spec.roof?.deckUndersideElevationIn));
  const exit = spec.route.exit || { type: 'ROOF' };
  if (exit.type === 'CHASE') {
    // a chase built on the roof: the roofer flashes the chase, the chimney exits its top
    if (exit.chaseTopElevationIn == null) { plan.fail(ENTER_CHASE_TOP, ['chase.top']); return; }
    if (exit.chaseTopElevationIn <= roofPen) {
      plan.fail(`The top of the chase (${ftIn(exit.chaseTopElevationIn)}) isn't higher than the roof where the chimney comes out (${ftIn(roofPen)}). ` +
        `This chase sits on the roof, so its top must be above the roof. Both heights are measured from the stove's floor: check the chase top in Chase Information (2b) and the roof height in Roof Information (4).`,
        ['chase.top', 'roof.height']);
      return;
    }
    plan.notes.push('The chimney passes the roof inside the chase, so no roof flashing is listed; the chase itself must be flashed and roofed.');
    ctx.chaseRoofPenetration = { elevationIn: roofPen, pitch: spec.roof?.pitch ?? 0 };
    chaseTop(ctx, exit);
  } else roofPenetration(ctx);
}

/** Square support box height from the manufacturer's pitch table for the connector line below. */
function supportBoxHeight(ctx, pitch) {
  const { spec, cat, plan } = ctx;
  const rows = (cat.lookups.support_box_pitch || []).filter(r => r.connector_line === spec.connectorLine);
  if (!rows.length) { plan.fail(`No support-box sizing table for connector line '${spec.connectorLine}'.`, ['chimney.connector']); return null; }
  const row = rows.find(r => pitch >= r.pitch_min && pitch <= r.pitch_max);
  if (!row) {
    const max = Math.max(...rows.map(r => r.pitch_max));
    plan.fail(`A ${pitch}/12 ceiling is steeper than the ${max}/12 the support boxes cover with ${spec.connectorLine} connector pipe.`, ['ceiling.pitch', 'chimney.connector']);
    return null;
  }
  return row.box_height_in;
}

/**
 * One shield per floor/ceiling assembly the chimney passes through without a support box.
 * kind FIRESTOP = firestop radiation shield; PASS_THROUGH = pass-through radiation shield
 * (6-8" only; its top doubles as the attic shield). Returns false on error.
 */
function floorShields(ctx, elevations, topLimitIn, kind) {
  const { plan, size } = ctx;
  for (const e of elevations) {
    if (e <= ctx.startElevationIn || e >= topLimitIn) {
      const what = ctx.spec.route.floorLabels?.[elevations.indexOf(e)] || 'A floor or ceiling';
      plan.fail(e >= topLimitIn
        ? `${what} at ${ft(e)} ft is at or above where the chimney leaves the building (${ft(topLimitIn)} ft). Check the roof height and the floor heights.`
        : `${what} at ${ft(e)} ft is below where the chimney starts (${ft(ctx.startElevationIn)} ft). Check the ceiling and floor heights.`,
        ['floors', 'roof.height', 'chase.top']);
      return false;
    }
    const cat_ = kind === 'PASS_THROUGH' ? 'PASS_THROUGH_SHIELD' : 'FIRESTOP';
    const s = plan.pick(cat_, size, () => true, kind === 'PASS_THROUGH' ? 'pass-through radiation shield' : 'firestop radiation shield');
    if (!s) return false;
    plan.add(s, 1, `Floor/ceiling penetration at ${ft(e)} ft without a support box`);
    ctx.lastShield = s;
  }
  return true;
}

function atticShield(ctx, atticAbove, alreadyMet, byWhat) {
  const { cat, plan, size } = ctx;
  if (!atticAbove) return;
  if (alreadyMet) {
    plan.checks.push({ rule: 'dt.attic_shield_required', status: 'PASS', detail: `Attic shield requirement met by the ${byWhat}.` });
    return;
  }
  const s = plan.pick('ATTIC_SHIELD', size, () => true, 'attic insulation shield');
  if (s) {
    plan.add(s, 1, cat.rule('dt.attic_shield_required').statement);
    plan.checks.push({ rule: 'dt.attic_shield_required', status: 'PASS', detail: 'Attic insulation shield added.' });
  }
}

/** Framing depth assumed at each floor and at the roof when estimating open space for offsets. */
const FRAMING_ALLOWANCE_IN = 10;

/**
 * Vertical spaces an offset could sit in: from `bottom` (top of the support box or the appliance)
 * to the next floor, floor to floor, and the last floor to the roof or chase top, each less a
 * framing allowance. Estimates only; a measured "height available" always overrides them.
 */
function openSpaces(bottom, floors, topIn, deckUndersideIn = null) {
  const bounds = [...floors].filter(f => f > bottom && f < topIn).sort((a, b) => a - b);
  const spaces = [];
  let from = bottom;
  for (const to of [...bounds, topIn]) {
    const last = to === topIn;
    // a measured attic gives the real underside of the roof deck; otherwise allow for framing
    const ceilingOfSpace = last && deckUndersideIn != null ? deckUndersideIn : to - FRAMING_ALLOWANCE_IN;
    const label = last ? (deckUndersideIn != null ? 'in the attic (measured)' : spaces.length ? 'floor to roof' : 'ceiling to roof') : 'between floors';
    spaces.push({ from, heightIn: Math.max(0, ceilingOfSpace - from), used: 0, label });
    from = to;
  }
  return spaces;
}

/**
 * Offsets: each is { horizontalIn, availableRiseIn?, angle? (15 | 30, else automatic) }.
 * Automatic tries 15° first and uses 30° when 15° can't reach or doesn't fit the height.
 * Height comes from the user when given (a firm limit), otherwise from the open-space estimate
 * (advisory: a too-small estimate warns rather than blocks).
 */
function planOffsets(ctx, offsets, spaces = []) {
  const { cat, plan, size, finish } = ctx;
  if (!offsets.length) return;
  if (offsets.length > ctx.maxOffsets) {
    plan.fail(`${offsets.length} offsets requested; at most ${ctx.maxOffsets} allowed${ctx.maxOffsetsSource ? ` (${ctx.maxOffsetsSource})` : ' (four elbows)'}.`, ['offsets', 'appliance.maxOffsets']);
    return;
  }
  const chart = cat.lookups.elbow_offsets || [];
  const inch = v => `${Math.round(v * 100) / 100}"`;
  const roomiest = () => spaces.reduce((a, b) => (b.heightIn - b.used > (a ? a.heightIn - a.used : -1) ? b : a), null);

  offsets.forEach((o, i) => {
    const n = i + 1;
    const forced = [15, 30].includes(Number(o.angle)) ? Number(o.angle) : null;
    if (forced && !ctx.offsetAngles.includes(forced)) {
      plan.fail(`Offset ${n}: ${forced}° elbows aren't allowed${ctx.appliance ? ` by the ${ctx.appliance.label} manual` : ''}; use ${ctx.offsetAngles.join('° or ')}°.`, [`offset.${n}`, 'appliance.only15']);
      return;
    }
    const angles = forced ? [forced] : ctx.offsetAngles;
    if (!(o.horizontalIn > 0)) { plan.fail(`Offset ${n}: choose the sideways shift.`, [`offset.${n}`]); return; }
    const smallest = Math.min(...chart.filter(r => angles.includes(r.angle_deg)).map(r => r.offset_in));
    if (o.horizontalIn < smallest - 1e-9) {
      plan.fail(`Offset ${n}: a ${inch(o.horizontalIn)} shift can't be built. The smallest offset ${angles.join('° or ')}° elbows make is ${inch(smallest)} (two elbows with no pipe between). ` +
        'Move the chimney\'s position to avoid the framing, or use the smallest offset.', [`offset.${n}`]);
      return;
    }
    const measured = o.availableRiseIn > 0 ? o.availableRiseIn : null;
    const space = roomiest();
    const estimated = measured == null && space ? space.heightIn - space.used : null;
    const room = measured ?? estimated;

    let pick = chooseOffset(o.horizontalIn, chart, angles, room);
    let tooTight = false;
    if (!pick.row && pick.reason === 'RISE' && measured == null) {
      // the estimate says nothing fits: take the shortest option and warn instead of blocking
      tooTight = true;
      const reach = chart.filter(r => angles.includes(r.angle_deg) && r.offset_in >= o.horizontalIn - 1e-9);
      pick = { row: reach.reduce((a, b) => (b.rise_in < a.rise_in ? b : a)) };   // the shortest that reaches
    }
    if (!pick.row) {
      if (pick.reason === 'RISE') {
        plan.fail(`Offset ${n}: shifting ${inch(o.horizontalIn)} with ${pick.angle}° elbows needs at least ${inch(pick.needRiseIn)} of height, but only ${inch(room)} is available. ` +
          (forced ? 'Try the other angle, or find more room.' : 'Find more room, or reduce the shift.'), [`offset.${n}`]);
      } else {
        const reach = Math.max(...chart.filter(r => angles.includes(r.angle_deg)).map(r => r.offset_in));
        plan.fail(`Offset ${n}: ${inch(o.horizontalIn)} is more than the ${inch(reach)} reachable with ${angles.join('°/')}° elbows.`, [`offset.${n}`]);
      }
      return;
    }
    const row = pick.row;
    const kitFinish = cat.parts('ELBOW_KIT', size).some(p => p.finish === finish) ? finish : 'SS';
    const kit = plan.pick('ELBOW_KIT', size, p => p.elbow_angle_deg === row.angle_deg && p.finish === kitFinish, `${row.angle_deg}° elbow kit`);
    if (kit) plan.add(kit, 1, `Offset ${n}: ${row.angle_deg}° elbows shift the chimney ${inch(row.offset_in)} sideways over ${inch(row.rise_in)} of height (kit includes the required elbow strap)`);
    for (const len of parseBetween(row.between_desc)) {
      const p = ctx.stock.find(s => s.nominal_length_in === len);
      if (!p) { plan.errors.push(`No ${len}" pipe in ${finish} for the offset.`); return; }
      plan.add(p, 1, `Pipe between the elbows of offset ${n}`);
    }
    const atIn = space ? space.from + space.used : null;
    if (space) space.used += row.rise_in;
    ctx.offsetRiseIn += row.rise_in;
    ctx.offsets += 1;
    ctx.offsetAnglesUsed.push(row.angle_deg);
    ctx.offsetsUsed.push({ n, angleDeg: row.angle_deg, requestedIn: o.horizontalIn, offsetIn: row.offset_in, riseIn: row.rise_in,
                           betweenDesc: row.between_desc, availableRiseIn: measured, estimatedRoomIn: estimated,
                           chosen: forced ? 'FORCED' : 'AUTO', atIn });

    // explain the choice
    const roomText = measured != null ? `the ${inch(measured)} available` : `the about ${inch(estimated)} open ${space.label}`;
    if (!forced && row.angle_deg === 30 && ctx.offsetAngles.includes(15) && !tooTight) {
      const alt = chooseOffset(o.horizontalIn, chart, [15]);
      plan.notes.push(alt.row
        ? `Offset ${n}: 15° elbows would need ${inch(alt.row.rise_in)} of height; 30° elbows fit in ${roomText}.`
        : `Offset ${n}: 15° elbows can't shift ${inch(o.horizontalIn)}, so 30° elbows are used.`);
    }
    if (tooTight) {
      plan.issue('STOP', `Offset ${n} needs ${inch(row.rise_in)} of height even with ${row.angle_deg}° elbows, but the open space ${space.label} at the chimney looks like only about ${inch(estimated)} ` +
        `(estimated with a ${FRAMING_ALLOWANCE_IN}" framing allowance). It may not fit. Measure the space and enter it as the height available, or reduce the shift.`,
        [kit?.order_number, ...parseBetween(row.between_desc).map(len => ctx.stock.find(p => p.nominal_length_in === len)?.order_number)].filter(Boolean));
    } else if (measured != null) {
      plan.checks.push({ rule: 'offset.height', status: 'PASS', detail: `Offset ${n}: ${row.angle_deg}° elbows use ${inch(row.rise_in)} of the ${inch(measured)} available.` });
    } else if (estimated != null) {
      plan.checks.push({ rule: 'offset.height', status: 'INFO', detail: `Offset ${n}: ${row.angle_deg}° elbows use ${inch(row.rise_in)} of about ${inch(estimated)} open ${space.label} (estimated).` });
      plan.notes.push(`Offset ${n}: the open space ${space.label} was estimated from your heights, less the support box and a ${FRAMING_ALLOWANCE_IN}" framing allowance. Enter the measured height available to confirm the angle.`);
    } else {
      plan.warnings.push(`Offset ${n} needs ${inch(row.rise_in)} of vertical room with ${row.angle_deg}° elbows. Check it fits where the jog happens, or enter the height available so the planner can check.`);
    }
    if (row.offset_in > o.horizontalIn + 1e-9) {
      plan.issue('CAUTION', `Offset ${n}: Duravent's elbow chart has no ${inch(o.horizontalIn)} shift; the nearest larger one, ${inch(row.offset_in)}, is used. ` +
        `Lay out the roof opening for a ${inch(row.offset_in)} shift.`, [kit?.order_number].filter(Boolean));
    }
  });
  plan.warnings.push('Offsets reduce draft and collect creosote; use a straight run if the framing allows.');
}

// --------------------------------------------------------------------- wall route
function planWallRoute(ctx) {
  const { spec, cat, plan, size, finish } = ctx;
  const w = spec.route;
  const standoff = w.standoffIn ?? 2;

  const cat_ = (w.thimble || 'STANDARD') === 'INSULATED' ? 'WALL_THIMBLE_INSULATED' : 'WALL_THIMBLE';
  const thimble = plan.pick(cat_, size, () => true, 'wall thimble');
  if (!thimble) return;
  if (w.wallThicknessIn < thimble.wall_min_in) {
    plan.notes.push(`Wall is thinner than the thimble's ${thimble.wall_min_in}" minimum; the thimble telescopes but check the instructions for thin walls.`);
  } else if (w.wallThicknessIn > thimble.wall_max_extended_in) {
    plan.fail(`A ${w.wallThicknessIn}" wall exceeds the thimble's ${thimble.wall_max_extended_in}" maximum even with a field-fabricated extension.`, ['wall.thickness']);
    return;
  } else if (w.wallThicknessIn > thimble.wall_max_in) {
    plan.issue('CAUTION', `A ${w.wallThicknessIn}" wall is beyond the thimble's ${thimble.wall_max_in}" standard range: a field-fabricated extension is needed between the telescoping halves (up to ${thimble.wall_max_extended_in}").`, [thimble.order_number]);
  }
  plan.add(thimble, 1, `Horizontal pass-through of a ${w.wallThicknessIn}" ${words(w.cladding)} wall`);
  if (['BRICK', 'STONE'].includes(w.cladding)) plan.notes.push('Measure masonry veneer walls through the veneer, air gap and framing; the thimble spans the full assembly.');
  const trim = cat.parts('WALL_THIMBLE_TRIM', size)[0];
  if (trim && w.cladding === 'VINYL') plan.add(trim, 1, 'Optional stainless exterior trim; finishes the opening on siding');

  const projection = cat.rule('dt.wall_thimble_interior_projection_in').value;
  const horizNeed = projection + w.wallThicknessIn + standoff;
  ctx.horizontalRunIn = (w.collarToWallIn ?? projection) + w.wallThicknessIn + standoff;
  wallApplianceChecks(ctx);
  const horiz = selectPipe(horizNeed, ctx.stock, { jointPenaltyIn: 12 });
  horiz.pieces.forEach(p => plan.add(p, 1, `Horizontal run: ${projection}" into the room + ${w.wallThicknessIn}" wall + ${standoff}" standoff`));
  plan.notes.push(`Horizontal pipe extends ${projection}" into the room past the interior wall; the stovepipe connects there.`);

  if (standoff < 2 || standoff > 6) { plan.fail(`Standoff of ${standoff}" is outside the 2"-6" the tee support and wall straps provide; extended supports are not yet handled.`, ['wall.standoff']); return; }
  const teeFinish = cat.parts('TEE', size).some(p => p.finish === finish) ? finish : 'SS';
  const tee = plan.pick('TEE', size, p => p.finish === teeFinish, 'tee with cap');
  const ts = plan.pick('TEE_SUPPORT', size, p => p.finish === teeFinish, 'tee support bracket');
  if (!tee || !ts) return;
  plan.add(tee, 1, 'Turns the horizontal run vertical outside the wall; removable cap for cleaning');
  plan.add(ts, 1, `Carries the vertical chimney at the tee (up to ${ts.max_supported_ft} ft, ${ts.max_supported_with_straps_ft} ft with wall straps)`);
  ctx.usesTee = true;
  ctx.support = ts;
  ctx.startElevationIn = w.thimbleCenterElevationIn + (tee.dimensions?.E?.value_in ?? 0) / 2;
  plan.notes.push('Vertical pipe is measured from the top of the tee (assumed centred on the thimble); confirm with the tee installation instructions.');
  plan.warnings.push(cat.rule('dt.interior_preferred').statement);

  if (w.exit?.type === 'CHASE') {
    if (w.exit.chaseTopElevationIn == null) { plan.fail(ENTER_CHASE_TOP, ['chase.top']); return; }
    if (w.exit.chaseTopElevationIn <= ctx.startElevationIn) {
      plan.fail(`The top of the chase (${ftIn(w.exit.chaseTopElevationIn)}) isn't higher than the tee on the outside wall (${ftIn(ctx.startElevationIn)}), where the chimney turns up. ` +
        `The chase encloses the chimney above the tee, so its top must be higher. Check the chase top in Chase Information (2b).`, ['chase.top']);
      return;
    }
    plan.notes.push('The outside run is enclosed in a chase; wall straps fasten to the chase framing.');
    chaseTop(ctx, w.exit);
  } else if (w.eave === 'THROUGH_OVERHANG') {
    if (spec.roof?.penetrationElevationIn == null) { plan.fail('Going through the overhang needs the roof elevation at the chimney.', ['roof.height']); return; }
    roofPenetration(ctx);
    plan.warnings.push('Passing through an eave overhang also penetrates the soffit; confirm firestop and clearance details in the installation manual.');
  } else if (w.eave !== 'NONE') plan.errors.push(`Eave handling '${w.eave}' is not supported yet (offsetting around an overhang is a later step).`);
}

// --------------------------------------------------------------------- factory-built fireplace route
function planFireplaceRoute(ctx) {
  const { spec, cat, plan, size } = ctx;
  const r = spec.route;
  const fp = ctx.appliance;

  // connection at the fireplace
  if (r.fireplace) plan.warnings.push('route.fireplace is no longer used; put the fireplace details in spec.appliance.');
  if (fp.connection === 'DIRECT') {
    plan.notes.push(`Per the ${fp.label} manual, the chimney twists directly onto the fireplace collar (no anchor plate).`);
  } else {
    const ap = plan.pick('ANCHOR_PLATE', size, () => true, 'anchor plate');
    if (!ap) return;
    plan.add(ap, 1, `Attaches the chimney to the top of the ${fp.label}`);
    if (fp.connection === 'ANCHOR_PLATE_DAMPER') {
      plan.issue('CAUTION', 'The fireplace calls for an anchor plate with damper, which is not in this catalog; the standard anchor plate is listed as a placeholder. Order the damper version from Duravent.', [ap.order_number]);
    }
  }
  ctx.startElevationIn = fp.outletIn;
  ctx.support = { order_number: fp.label, max_supported_ft: null, fireplace: true };
  plan.notes.push(`The chimney weight bears on the ${fp.label}; its installation manual sets the maximum chimney height it can carry.`);

  // passes through floors / attic
  const exit = r.exit || { type: 'CHASE' };
  const exitElev = exit.type === 'CHASE' ? exit.chaseTopElevationIn : spec.roof?.penetrationElevationIn;
  if (exitElev == null) {
    if (exit.type === 'CHASE') plan.fail(ENTER_CHASE_TOP, ['chase.top']);
    else plan.fail('Enter the height of the roof where the chimney comes out, in Roof Information (4). The chimney has to reach a set height above the roof, so the planner can\'t size it without this.', ['roof.height']);
    return;
  }
  if (exitElev <= ctx.startElevationIn) {
    plan.fail(`The ${exit.type === 'CHASE' ? 'top of the chase' : 'roof where the chimney comes out'} (${ftIn(exitElev)}) isn't higher than the top of the fireplace (${ftIn(ctx.startElevationIn)}). ` +
      `Check ${exit.type === 'CHASE' ? 'the chase top in Chase Information (2b)' : 'the roof height in Roof Information (4)'} and the flue collar height in Appliance Information (1).`,
      [exit.type === 'CHASE' ? 'chase.top' : 'roof.height', 'appliance.outlet']);
    return;
  }
  const shieldKind = r.penetrationShield || 'FIRESTOP';
  if (shieldKind === 'PASS_THROUGH' && !cat.parts('PASS_THROUGH_SHIELD', size).length) {
    plan.fail(`The pass-through radiation shield is not made for ${size}"; use firestops instead.`, ['fireplace.shield', 'appliance.collar']);
    return;
  }
  const floors = r.floorPenetrationsIn || [];
  if (!floorShields(ctx, floors, exitElev, shieldKind)) return;
  if (shieldKind === 'PASS_THROUGH' && floors.length) plan.notes.push(cat.rule('dt.pass_through_shield_above_fireplace').statement);
  atticShield(ctx, !!r.atticAbove, floors.length > 0 && !!attr(ctx.lastShield, 'functions_as_attic_shield'), 'pass-through shield top');
  if (r.atticAbove && !floors.length) plan.warnings.push('An attic above the fireplace implies at least one ceiling penetration; add its elevation so a shield is included.');

  planOffsets(ctx, r.offsets || [], openSpaces(ctx.startElevationIn, floors, exitElev));

  // lateral support: fireplace, each floor, and the exit hold the chimney sideways
  ctx.lateralSupportsIn = [ctx.startElevationIn, ...floors, exitElev].sort((a, b) => a - b);

  // exit
  if (exit.type === 'CHASE') {
    chaseTop(ctx, exit);
  } else if (exit.type === 'ROOF') {
    roofPenetration(ctx);
  } else { plan.errors.push(`Unknown fireplace exit '${exit.type}'.`); return; }

}

// --------------------------------------------------------------------- appliance manual
const UL103HT = 'UL 103 Type HT';

/**
 * Apply what the user read from their appliance manual (spec.appliance). Every limit is
 * optional; a blank means "not stated". Returns false if the manual rules this chimney out.
 */
function readManual(ctx) {
  const { spec, cat, plan } = ctx;
  const m = spec.appliance;
  const isFp = (m.type || 'STOVE') === 'FACTORY_FIREPLACE';
  const label = m.label?.trim() || (isFp ? 'fireplace' : 'stove');
  const ap = { connection: isFp ? 'ANCHOR_PLATE' : 'CONNECTOR', ...m, label, outletIn: m.outletElevationIn };
  const listings = (cat.line.listing || '').split(';').map(x => x.trim().toLowerCase());

  switch (m.acceptsChimney) {
    case 'UL103HT':
      if (!listings.includes(UL103HT.toLowerCase())) {
        plan.errors.push(`The manual calls for a ${UL103HT} listed chimney; ${cat.line.name} is not listed to it.`);
        return false;
      }
      plan.notes.push(`The ${label} manual accepts any ${UL103HT} listed chimney; ${cat.line.name} is listed to ${UL103HT}${cat.line.listing_file ? ` (file ${cat.line.listing_file})` : ''}.`);
      break;
    case 'USER_CONFIRMED':
      // the user has chosen this chimney for their appliance; the page doesn't ask again
      break;
    case 'NAMES_THIS_PRODUCT':
      plan.notes.push(`The ${label} manual names ${cat.line.name} as an approved chimney.`);
      break;
    case 'OTHER':
      plan.errors.push(`The ${label} manual calls for a different chimney, so ${cat.line.name} can't be used with it.`);
      return false;
    default:
      if (isFp) {
        plan.errors.push(`Factory-built fireplaces are listed with specific chimneys. Check that the fireplace manual allows ${cat.line.name} (or any ${UL103HT} chimney) before planning.`);
        return false;
      }
      plan.warnings.push(`Confirm the ${label} manual accepts a ${UL103HT} listed chimney such as ${cat.line.name}. ${cat.rule('dt.appliance_must_approve_chimney').statement}`);
  }
  if (m.maxOffsets != null && m.maxOffsets < ctx.maxOffsets) { ctx.maxOffsets = m.maxOffsets; ctx.maxOffsetsSource = `${label} manual`; }
  if (m.offsetAnglesDeg?.length) ctx.offsetAngles = [15, 30].filter(a => m.offsetAnglesDeg.includes(a));
  if (m.minSystemHeightFt != null && m.maxSystemHeightFt != null && m.minSystemHeightFt > m.maxSystemHeightFt) {
    plan.fail(`The manual minimum height (${m.minSystemHeightFt} ft) is above its maximum (${m.maxSystemHeightFt} ft); recheck the values entered.`, ['appliance.minHeight', 'appliance.maxHeight']);
    return false;
  }
  ctx.appliance = ap;
  return true;
}

/** Wall-route limits from the stove manual: vertical rise before the horizontal run, room-ceiling clearance. */
function wallApplianceChecks(ctx) {
  const { spec, plan } = ctx;
  const ap = ctx.appliance;
  const w = spec.route;
  if (ap.minRiseBeforeHorizontalIn != null) {
    const rise = w.thimbleCenterElevationIn - ap.outletIn;
    plan.check('appliance.min_rise_before_horizontal', rise >= ap.minRiseBeforeHorizontalIn,
      `${r2(rise)}" of vertical rise from the ${ap.label} collar to the horizontal run (manual requires ${ap.minRiseBeforeHorizontalIn}").`, ['wall.center', 'appliance.minRise']);
  }
  if (ap.minHorizontalToCeilingIn != null) {
    if (w.roomCeilingElevationIn == null) {
      plan.notes.push(`Keep the top of the horizontal run at least ${ap.minHorizontalToCeilingIn}" below the room ceiling, per the ${ap.label} manual (enter the ceiling height to check).`);
    } else {
      const gap = w.roomCeilingElevationIn - (w.thimbleCenterElevationIn + ctx.outerIn / 2);
      plan.check('appliance.min_horizontal_to_ceiling', gap >= ap.minHorizontalToCeilingIn,
        `${r2(gap)}" from the top of the horizontal run to the ceiling (the ${ap.label} manual requires ${ap.minHorizontalToCeilingIn}").`, ['wall.center', 'wall.roomCeiling', 'appliance.minCeiling']);
    }
  }
  if (w.collarToWallIn == null) plan.notes.push('Horizontal run is counted from 6" inside the wall; enter the collar-to-wall distance for an exact figure.');
}

/**
 * Minimum system height (feet above the appliance outlet). The manual's figure when entered;
 * otherwise the upper end of the chimney maker's draft guideline, raised for a tee or elbows,
 * so a blank manual errs tall.
 */
function minimumSystemHeight(ctx) {
  const { cat, plan } = ctx;
  const ap = ctx.appliance;
  if (ap.minSystemHeightFt != null) {
    plan.manualHeightApplied = true;
    if (ctx.highAltitude) plan.notes.push(`High-altitude site: make sure the ${ap.minSystemHeightFt} ft you entered is the ${ap.label} manual's figure for ${ctx.spec.siteElevationFt != null ? `${ctx.spec.siteElevationFt} ft` : 'your elevation'}. Many manuals ask for a taller chimney above ${ctx.altitudeThresholdFt.toLocaleString('en-US')} ft.`);
    return { ft: ap.minSystemHeightFt, label: `the ${ap.label} manual minimum of ${ap.minSystemHeightFt} ft` };
  }
  const r = cat.rule('draft.min_vertical_ft');
  const f = cat.rule('draft.elbow_or_altitude_factor');
  const base = r.value_max ?? r.value;
  // the catalog: elbows, a tee OR higher elevation need ~30-60% more height. One reason: the low end;
  // both: the high end.
  const bends = ctx.offsets || ctx.usesTee;
  const high = ctx.highAltitude;
  const factor = bends && high ? (f.value_max ?? f.value) : bends || high ? f.value : 1;
  const reasons = [bends && (ctx.usesTee ? 'the tee' : 'elbows'), high && 'high altitude'].filter(Boolean).join(' and ');
  const why = factor > 1 ? ` × ${factor} for ${reasons}` : '';
  const ftNeed = Math.round(base * factor * 100) / 100;
  plan.warnings.unshift(`The ${ap.label} manual's minimum chimney height was not entered, so its own requirements are not applied. ` +
    (factor > 1 ? `Using ${ftNeed} ft (${base} ft, the upper end of ${cat.line.name}'s draft guideline${why}). `
                : `Using ${ftNeed} ft, the upper end of ${cat.line.name}'s draft guideline. `) +
    `Look up your manual's minimum height for the layout shown and enter it.`);
  return { ft: ftNeed, label: `${cat.line.name} draft guideline, upper end (${base} ft${why})` };
}

/** What the user needs to look up the minimum height in their manual's table. */
function describeLayout(ctx) {
  const { spec } = ctx;
  const elbows = {};
  ctx.offsetAnglesUsed.forEach(a => { elbows[a] = (elbows[a] || 0) + 2; });
  const elbowList = Object.entries(elbows).map(([a, n]) => ({ angleDeg: Number(a), count: n }));
  const horizontalRunFt = r2(ctx.horizontalRunIn / 12);
  const bits = [
    ctx.usesTee ? '1 tee' : 'no tee',
    elbowList.length ? elbowList.map(e => `${e.count} × ${e.angleDeg}° elbows`).join(', ') : 'no elbows',
    horizontalRunFt ? `${horizontalRunFt} ft of horizontal run` : 'no horizontal run',
    !ctx.highAltitude ? `below ${ctx.altitudeThresholdFt.toLocaleString('en-US')} ft elevation`
      : spec.siteElevationFt != null ? `site elevation ${spec.siteElevationFt.toLocaleString('en-US')} ft`
      : `above ${ctx.altitudeThresholdFt.toLocaleString('en-US')} ft elevation (exact elevation not entered)`,
  ];
  return { tee: ctx.usesTee, elbows: elbowList, horizontalRunFt, siteElevationFt: spec.siteElevationFt ?? null,
           highAltitude: ctx.highAltitude,
           measuredFrom: 'top of the appliance flue outlet', summary: bits.join(', ') };
}

// --------------------------------------------------------------------- shared steps
/**
 * Chimney exits the top of a framed chase: chase top flashing (or a custom cover when the chase
 * is bigger than the flashing) plus a storm collar. No roof flashing; the chase is flashed by
 * the roofer. exit: { chaseTopElevationIn, chaseWidthIn?, chaseDepthIn?, airIntake?, shroud? }
 */
function chaseTop(ctx, exit) {
  const { spec, cat, plan, size } = ctx;
  const ctf = plan.pick('CHASE_TOP_FLASHING', size, () => true, 'chase top flashing');
  const sc = plan.pick('STORM_COLLAR', size, () => true, 'storm collar');
  if (!ctf || !sc) return;
  const covers = ctf.dimensions?.B?.value_in;
  const hole = ctf.dimensions?.A?.value_in;
  const w = exit.chaseWidthIn > 0 ? exit.chaseWidthIn : null;
  const d = exit.chaseDepthIn > 0 ? exit.chaseDepthIn : null;
  const fmt = v => `${Math.round(v * 100) / 100}"`;
  if (w && d && covers && (w > covers || d > covers)) {
    const custom = {
      order_number: 'CUSTOM-CHASE-COVER', stock_number: null, category: 'CHASE_TOP_FLASHING', nonCatalog: true,
      description: `Custom chase cover, ${fmt(w)} × ${fmt(d)}, ${fmt(hole)} chimney hole (not a Duravent part)`,
    };
    plan.add(custom, 1, 'Closes the top of the chase; made by a sheet-metal shop to the chase size');
    plan.issue('CAUTION',
      `The chase top is ${fmt(w)} × ${fmt(d)}, larger than the ${fmt(covers)} × ${fmt(covers)} that ${ctf.order_number} covers. ` +
      `Have a sheet-metal shop make a chase cover to fit, with a ${fmt(hole)} hole for the chimney, a drip edge, and a vent gap like the ` +
      `${ctf.order_number} spacer clips so the chase can breathe. Check it against the installation manual.`, [custom.order_number]);
  } else {
    plan.add(ctf, 1, 'Closes the top of the chase around the chimney; spacer clips vent the chase');
    if (!w || !d) plan.notes.push(`${ctf.order_number} covers a chase top up to ${fmt(covers)} × ${fmt(covers)}. Enter the chase size to check yours.`);
  }
  plan.add(sc, 1, cat.rule('dt.chase_top_needs_storm_collar').statement + ' Seal with 500°F non-hardening sealant.');
  if (exit.airIntake) {
    const ai = plan.pick('CHASE_AIR_INTAKE', size, () => true, 'chase air intake');
    if (ai) plan.add(ai, 1, 'Requested: lets ventilation air into the chase; screen keeps rodents out');
  } else plan.notes.push('If the appliance or local code requires chase ventilation air, add the chase air intake (6DT-CAI).');
  if (exit.shroud) plan.issue('CAUTION', cat.rule('dt.shroud_spec_l157').statement);
  if (spec.roof?.penetrationElevationIn == null && spec.roof?.elevationAtChimneyIn == null && !(spec.nearbyWithin10ft || []).length) {
    plan.issue('CAUTION', 'No roof height or nearby structure was given, so the 2 ft / 10 ft rule could not be checked; the height only clears the chase top. Enter the roof height beside the chase in Roof Information (4).');
  }
  ctx.exit = { elevationIn: exit.chaseTopElevationIn, pitch: 0, label: 'chase top',
               aboveChecks: chaseTopRule(ctx, exit),
               ...(ctx.chaseRoofPenetration ? { roofPenetration: ctx.chaseRoofPenetration } : {}) };
}

/**
 * How far the chimney must rise above the chase top. The user picks the rule; Duravent's 6"
 * from the chase top flashing to the bottom of the cap applies under every rule and is never undercut.
 *   CODE   - the chase top is treated as the roof: 3 ft above it (3-2-10).
 *   TWO_FT - the chase is part of the building within 10 ft: 2 ft above it.
 *   SET    - a height the user gives (inspector or plans), at least the 6" minimum.
 * The roof the chase passes through and anything within 10 ft are checked separately, under every rule.
 */
function chaseTopRule(ctx, exit) {
  const { cat, plan } = ctx;
  const capIn = cat.rule('dt.chase_top_min_cap_clearance_in').value;
  const capCheck = { label: `${capIn}" from the chase top flashing to the bottom of the cap (Duravent minimum)`, aboveIn: capIn };
  const rule = exit.topRule || 'CODE';
  if (rule === 'SET') {
    const v = exit.aboveChaseIn;
    if (v == null) {
      plan.fail(`Enter how far the chimney goes above the chase top in Chase Information (2b), at least ${capIn}".`, ['chase.above']);
      return [capCheck];
    }
    if (v < capIn) {
      plan.fail(`${inTxt(v)} above the chase top is less than Duravent's minimum of ${capIn}" from the chase top flashing to the bottom of the cap. ` +
        `Enter ${capIn}" or more in Chase Information (2b).`, ['chase.above']);
      return [capCheck];
    }
    plan.notes.push(`Chimney height above the chase top set to ${inTxt(v)}, as you entered (the cap sits on top of the last section). Your roof and anything within 10 ft are still checked.`);
    return [capCheck, { label: `${inTxt(v)} above the chase top (your setting)`, aboveIn: v }];
  }
  const ftAbove = rule === 'TWO_FT' ? cat.rule('term.min_above_within_horizontal_ft').value : cat.rule('term.min_above_penetration_ft').value;
  return [capCheck, {
    label: rule === 'TWO_FT' ? `${ftAbove} ft above the chase top (chase counted as part of the building)` : `${ftAbove} ft above the chase top (3-2-10 rule at the chase)`,
    aboveIn: ftAbove * 12,
  }];
}

function roofPenetration(ctx) {
  const { spec, cat, plan, size } = ctx;
  const { pitch, surface = 'SHINGLE' } = spec.roof;
  if (!Number.isInteger(pitch)) plan.warnings.push(`Roof pitch ${pitch}/12 rounded to ${Math.round(pitch)}/12 to select flashing.`);
  const p12 = Math.round(pitch);
  const fits = p => p.pitch_applies_to === 'roof' && p12 >= p.pitch_min && p12 <= p.pitch_max &&
    (attr(p, 'max_pitch_by_size')?.[size] == null || p12 <= attr(p, 'max_pitch_by_size')[size]);
  const flashings = cat.parts('ROOF_FLASHING', size).filter(fits);
  let flashing;
  if (surface === 'SHINGLE') flashing = flashings.find(p => !p.optional && !attr(p, 'roof_surface'));
  else if (surface === 'METAL_CORRUGATED') flashing = flashings.find(p => attr(p, 'roof_surface') === 'METAL_CORRUGATED') || flashings.find(p => attr(p, 'roof_surface') === 'METAL_OR_TILE');
  else if (surface === 'TILE') flashing = flashings.find(p => attr(p, 'roof_surface') === 'METAL_OR_TILE');
  if (!flashing) { plan.fail(`No ${size}" flashing for a ${p12}/12 ${words(surface)} roof.`, ['roof.pitch', 'roof.surface']); return; }
  plan.add(flashing, 1, `Weatherproofs the ${p12}/12 ${words(surface)} roof penetration`);
  if (flashing.order_number !== 'URBAK') {   // rubber boot kit includes its own storm collar
    const sc = plan.pick('STORM_COLLAR', size, () => true, 'storm collar');
    if (sc) plan.add(sc, 1, cat.rule('dt.storm_collar_with_flashing').statement + ' Seal with 500°F non-hardening sealant.');
  }
  ctx.exit = { elevationIn: spec.roof.penetrationElevationIn, pitch, label: 'roof penetration' };
}

function termination(ctx) {
  const { spec, cat, plan, size } = ctx;
  const t = terminationHeight(spec, cat, ctx.outerIn, ctx.exit);
  if (!t) { plan.fail('Need either the roof elevation at the chimney or the elevation of nearby roof/structure to set the chimney height.', ['roof.height', 'nearby']); return; }
  for (const c of t.checks) plan.checks.push({ rule: 'termination', status: 'INFO', detail: `${c.label}: top at least ${ftIn(c.topIn, true)}` });

  let requiredTopIn = t.requiredTopIn;
  let governing = t.governing.label;
  const need = minimumSystemHeight(ctx);
  const minTop = ctx.appliance.outletIn + need.ft * 12;
  plan.checks.push({ rule: 'min_system_height', status: 'INFO', detail: `Minimum system height from ${need.label}: top at least ${ftIn(minTop, true)}` });
  plan.geometry.minSystemHeightFt = need.ft;
  if (minTop > requiredTopIn) { requiredTopIn = minTop; governing = `${need.label}, measured from the top of the flue outlet`; }
  const straightNeed = requiredTopIn - ctx.startElevationIn - ctx.offsetRiseIn;
  const sel = selectPipe(straightNeed, ctx.stock);
  sel.pieces.forEach(p => plan.add(p, 1, 'Straight chimney run'));
  const topIn = ctx.startElevationIn + ctx.offsetRiseIn + sel.installedIn;
  const chimneyLenIn = topIn - ctx.startElevationIn;
  plan.check('termination', topIn >= requiredTopIn - 1e-6, `Chimney top at ${ftIn(topIn)} meets the governing requirement: ${governing} (at least ${ftIn(requiredTopIn, true)}).`);
  if (ctx.appliance.maxSystemHeightFt != null) {
    plan.check('appliance.max_system_height', topIn <= ctx.appliance.outletIn + ctx.appliance.maxSystemHeightFt * 12,
      `System height ${ft(topIn - ctx.appliance.outletIn)} ft vs. the ${ctx.appliance.label} manual maximum of ${ctx.appliance.maxSystemHeightFt} ft.`, ['appliance.maxHeight']);
  }

  // support capacity
  if (!ctx.support.fireplace) {
    const cap = ctx.support.max_supported_with_straps_ft ?? ctx.support.max_supported_ft;
    if (cap == null) plan.issue('CAUTION', `The catalog does not state a maximum supported height for ${ctx.support.order_number}; confirm the ${ft(chimneyLenIn)} ft chimney is within it.`, [ctx.support.order_number]);
    else plan.check('support_capacity', chimneyLenIn <= cap * 12 + 1e-6, `${ft(chimneyLenIn)} ft of chimney on ${ctx.support.order_number} (rated ${cap} ft).`, ['ceiling.support']);
  }

  // lateral support: wall straps
  const strapIntervalIn = cat.rule('dt.wall_strap_interval_ft').value * 12;
  const strapFinish = cat.parts('WALL_STRAP_ADJ', size).some(p => p.finish === ctx.finish) ? ctx.finish : 'SS';
  const addStraps = (n, why) => {
    if (n <= 0) return;
    const strap = plan.pick('WALL_STRAP_ADJ', size, p => p.finish === strapFinish, 'adjustable wall strap');
    if (strap) plan.add(strap, n, why);
  };
  let braceFromIn = ctx.exit?.elevationIn;
  if (spec.route.type === 'WALL') {
    const wallTop = Math.min(spec.route.wallTopElevationIn, ctx.exit?.elevationIn ?? Infinity, topIn);
    const run = wallTop - ctx.startElevationIn;
    if (run > 0) addStraps(Math.ceil(run / strapIntervalIn), `${cat.rule('dt.wall_strap_interval_ft').statement} (${ft(run)} ft of wall run)`);
    braceFromIn = ctx.exit?.elevationIn ?? wallTop;
  } else if (ctx.lateralSupportsIn) {
    const s = ctx.lateralSupportsIn;
    let n = 0;
    for (let i = 1; i < s.length; i++) n += Math.max(0, Math.ceil((s[i] - s[i - 1]) / strapIntervalIn) - 1);
    addStraps(n, `Keeps unsupported spans inside the chase to ${cat.rule('dt.wall_strap_interval_ft').value} ft or less; fasten to chase framing`);
  }

  // above-roof bracing
  const freeIn = topIn - braceFromIn;
  const threshold = cat.rule('dt.roof_bracket_threshold_ft').value * 12;
  const interval = cat.rule('dt.roof_bracket_interval_ft').value * 12;
  if (freeIn >= threshold) {
    const n = 1 + Math.floor((freeIn - threshold) / interval);
    const br = plan.pick('EXT_ROOF_BRACKET', size, () => true, 'extended roof bracket');
    if (br) plan.add(br, n, `${ft(freeIn)} ft of chimney stands above its last roof, chase or wall support. ${cat.rule('dt.roof_bracket_threshold_ft').statement}`);
  }

  // cap and options
  const o = spec.options || {};
  const capPart = plan.pick('CAP', size, p => (o.cap === 'DIKAPT') === /DIKAPT/.test(p.description), 'chimney cap');
  if (capPart) plan.add(capPart, 1, 'Keeps precipitation out; removable for inspection');
  if (o.sparkArrestor) { const sa = plan.pick('SPARK_ARRESTOR', size, () => true, 'spark arrestor'); if (sa) plan.add(sa, 1, 'Requested: keeps embers in and animals out'); }
  if (o.lockingBands) {
    const lb = plan.pick('LOCKING_BAND', size, () => true, 'locking band');
    const joints = [...plan.items.values()]
      .filter(i => ['CHIMNEY_PIPE', 'ELBOW_KIT', 'TEE'].includes(i.part.category))
      .reduce((t, i) => t + i.qty * (i.part.category === 'ELBOW_KIT' ? 2 : 1), 0);
    if (lb && joints) plan.add(lb, joints, 'Requested: optional extra security at each joint');
  }

  Object.assign(plan.geometry, {
    startElevationIn: r2(ctx.startElevationIn), requiredTopIn: r2(requiredTopIn), chimneyTopIn: r2(topIn),
    chimneyLengthIn: r2(chimneyLenIn), overshootIn: r2(sel.overshootIn), offsetRiseIn: r2(ctx.offsetRiseIn),
    exit: ctx.exit?.label ?? null, aboveExitIn: ctx.exit ? r2(topIn - ctx.exit.elevationIn) : null,
    governingRule: governing,
    offsets: ctx.offsetsUsed,
  });
}

function draftCheck(ctx) {
  const { cat, plan } = ctx;
  plan.geometry.systemHeightIn = r2(plan.geometry.chimneyTopIn - ctx.appliance.outletIn);
  plan.layout = describeLayout(ctx);
  plan.notes.push(`${cat.rule('draft.elbow_or_altitude_factor').statement} Your appliance manual's own table, if it has one, takes priority.`);
}
