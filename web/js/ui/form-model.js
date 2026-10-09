/**
 * Form model for the questionnaire: friendly answers (feet + inches, plain choices) in,
 * engine ChimneySpec out. Pure functions, no DOM, so they can be tested in Node.
 */

/** Example answers the page opens with: a one-story ranch. Clearly labelled as an example in the UI. */
export const EXAMPLE_STATE = {
  appliance: {
    kind: 'STOVE', label: '', collar: '6', outletFt: 2, outletIn: 6,
    minHeightFt: null, maxHeightFt: null, maxOffsets: '', only15: false,
    minRiseIn: null, minCeilingIn: null, roofShield: false, connection: 'ANCHOR_PLATE',
  },
  route: 'CEILING',
  ceiling: { style: 'FLAT', ft: 8, in: 0, pitch: 6, support: 'SQUARE', roundTrim: 'ROUND', reduced: false,
             above: 'ATTIC', storyFt: 8, storyIn: 0, floorThickIn: 12,
             exit: 'ROOF', jog: 'STRAIGHT', floors: [], offsets: [{ in: null, room: null, angle: 'AUTO' }] },
  wall: { thickness: 6, cladding: 'VINYL', thimble: 'STANDARD', centerFt: 5, centerIn: 0, standoff: 2,
          collarToWall: null, roomCeilingFt: 8, roomCeilingIn: 0, topFt: 9, topIn: 0, eave: 'NONE' },
  fireplace: { exit: 'CHASE', shield: 'FIRESTOP', attic: false,
               jog: 'STRAIGHT', floors: [], offsets: [{ in: null, room: null, angle: 'AUTO' }] },
  /** The framed chase the chimney exits, when any route uses one. Sizes are the chase's outside top. */
  chase: { topFt: 15, topIn: 0, widthIn: null, depthIn: null, airIntake: false, shroud: false,
           /** How high the chimney goes above the chase top: CODE = 3-2-10 rule at the chase top,
            *  TWO_FT = 2 ft above it, SET = aboveIn (6" minimum, Duravent's cap clearance). */
           topRule: 'CODE', aboveIn: 6 },
  /**
   * Attic measured directly above the chimney's center. `from` says where the tape starts:
   * JOISTS = top of the ceiling joists, DRYWALL = top of the ceiling drywall between the joists.
   */
  attic: { from: 'JOISTS', ft: null, in: null, joistIn: 7.25, drywallIn: 0.5, deckIn: 1 },
  roof: { pitch: 6, surface: 'SHINGLE', method: 'EAVE', eaveFt: 9, eaveIn: 0, fromEaveFt: 4, ft: 11, in: 0, ridgeFt: 8 },
  nearby: [],
  chimney: { finish: 'SS', connector: 'DB', highAltitude: false, siteElevationFt: null, cap: 'STANDARD', sparkArrestor: false, lockingBands: false },
};

/**
 * A cleared form: every measurement and manual answer blank, plain choices back to their first option.
 * Standard material thicknesses (joist, drywall, roof deck, floor framing) and the wall standoff keep
 * their usual values; each has its own box to change.
 */
export function blankState() {
  const s = structuredClone(EXAMPLE_STATE);
  Object.assign(s.appliance, { label: '', collar: '', outletFt: null, outletIn: null, minHeightFt: null, maxHeightFt: null,
    maxOffsets: '', only15: false, minRiseIn: null, minCeilingIn: null, roofShield: false });
  Object.assign(s.ceiling, { ft: null, in: null, pitch: '', storyFt: null, storyIn: null, jog: 'STRAIGHT',
    floors: [], offsets: [{ in: null, room: null, angle: 'AUTO' }] });
  Object.assign(s.wall, { thickness: null, centerFt: null, centerIn: null, collarToWall: null,
    roomCeilingFt: null, roomCeilingIn: null, topFt: null, topIn: null });
  Object.assign(s.fireplace, { jog: 'STRAIGHT', floors: [], offsets: [{ in: null, room: null, angle: 'AUTO' }] });
  Object.assign(s.chase, { topFt: null, topIn: null, widthIn: null, depthIn: null, airIntake: false, shroud: false, aboveIn: 6 });
  Object.assign(s.attic, { ft: null, in: null });
  Object.assign(s.roof, { pitch: '', eaveFt: null, eaveIn: null, fromEaveFt: null, ft: null, in: null, ridgeFt: null });
  s.nearby = [];
  Object.assign(s.chimney, { highAltitude: false, siteElevationFt: null, sparkArrestor: false, lockingBands: false });
  return s;
}

const n = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
/** Feet + inches to inches; null when both are blank. */
export const toInches = (ft, inch) => (n(ft) == null && n(inch) == null ? null : (n(ft) ?? 0) * 12 + (n(inch) ?? 0));

/** Can the roof height be measured from inside the attic? (Ceiling route, flat ceiling, attic above.) */
export function atticMethodApplies(state) {
  return state.appliance.kind === 'STOVE' && state.route === 'CEILING' && state.ceiling.style === 'FLAT'
    && ['ATTIC', 'STORY_ATTIC'].includes(state.ceiling.above);
}

/** Height of the top ceiling below the attic (stove room, or second floor), inches above the stove's floor. */
export function topCeilingIn(state) {
  const ce = state.ceiling;
  const base = toInches(ce.ft, ce.in);
  if (base == null) return null;
  if (ce.above !== 'STORY_ATTIC') return base;
  const story = toInches(ce.storyFt, ce.storyIn);
  return story == null ? null : base + (n(ce.floorThickIn) ?? 0) + story;
}

/**
 * Underside of the roof deck at the chimney's center, from the attic measurement:
 * top ceiling + drywall (+ joist depth when measured from the top of the joists) + attic height.
 * Null when the attic doesn't apply or wasn't measured.
 */
export function deckUndersideIn(state) {
  if (!atticMethodApplies(state)) return null;
  const a = state.attic;
  const top = topCeilingIn(state);
  const attic = toInches(a.ft, a.in);
  if (top == null || attic == null) return null;
  return top + (n(a.drywallIn) ?? 0) + (a.from === 'DRYWALL' ? 0 : (n(a.joistIn) ?? 0)) + attic;
}

/**
 * Roof height (inches above the stove's floor) at the chimney's spot.
 * EAVE: eave height + level distance from the eave edge x pitch/12 (all measurable from outside).
 * ATTIC: top ceiling + ceiling framing + attic height to the underside of the deck + deck thickness.
 * DIRECT: the height as entered. Null when incomplete.
 */
export function roofHeightIn(state) {
  const r = state.roof;
  if (r.method === 'DIRECT') return toInches(r.ft, r.in);
  if (r.method === 'ATTIC' && atticMethodApplies(state)) {
    const under = deckUndersideIn(state);
    return under == null ? null : under + (n(state.attic.deckIn) ?? 0);
  }
  const eave = toInches(r.eaveFt, r.eaveIn);
  const dist = n(r.fromEaveFt);
  if (eave == null || dist == null || n(r.pitch) == null) return null;
  return eave + dist * 12 * n(r.pitch) / 12;
}

/** Does the chimney exit through the top of a framed chase? */
export function usesChase(state) {
  if (state.appliance.kind === 'FIREPLACE') return state.fireplace.exit === 'CHASE';
  if (state.route === 'WALL') return state.wall.eave === 'CHASE';
  return state.ceiling.exit === 'CHASE';
}

/**
 * Does the chimney pass through the roof deck (vs. a gable end or a chase beside the house)?
 * A ceiling-route chimney always does, even inside a chase built on the roof.
 */
export function passesThroughRoof(state) {
  if (state.appliance.kind === 'FIREPLACE') return state.fireplace.exit === 'ROOF';
  if (state.route === 'WALL') return state.wall.eave === 'THROUGH_OVERHANG';
  return true;
}

export function toSpec(state) {
  const a = state.appliance;
  const isFp = a.kind === 'FIREPLACE';
  const c = state.chimney;
  const spec = {
    line: 'DT',
    finish: c.finish,
    connectorLine: c.connector,
    // elevation only matters at high altitude: asked for only when the user ticks the box
    highAltitude: c.highAltitude ? true : undefined,
    siteElevationFt: c.highAltitude ? n(c.siteElevationFt) ?? undefined : undefined,
    appliance: {
      type: isFp ? 'FACTORY_FIREPLACE' : 'STOVE',
      label: a.label?.trim() || undefined,
      collarSizeIn: n(a.collar),
      outletElevationIn: toInches(a.outletFt, a.outletIn),
      acceptsChimney: 'USER_CONFIRMED',   // the user has chosen DuraTech for this appliance
      minSystemHeightFt: n(a.minHeightFt) ?? undefined,
      maxSystemHeightFt: n(a.maxHeightFt) ?? undefined,
      maxOffsets: n(a.maxOffsets) ?? undefined,
      offsetAnglesDeg: a.only15 ? [15] : undefined,
      minRiseBeforeHorizontalIn: isFp ? undefined : n(a.minRiseIn) ?? undefined,
      minHorizontalToCeilingIn: isFp ? undefined : n(a.minCeilingIn) ?? undefined,
      requiresRoofRadiationShield: !!a.roofShield,
      connection: isFp ? a.connection : undefined,
    },
    roof: { pitch: n(state.roof.pitch), surface: state.roof.surface, horizontalToRidgeFt: n(state.roof.ridgeFt) ?? undefined },
    nearbyWithin10ft: (state.nearby || [])
      .map(p => ({ label: p.label?.trim() || 'nearby structure', elevationIn: toInches(p.ft, p.in) }))
      .filter(p => p.elevationIn != null),
    options: { cap: c.cap, sparkArrestor: !!c.sparkArrestor, lockingBands: !!c.lockingBands },
  };

  const roofIn = roofHeightIn(state);
  const under = deckUndersideIn(state);
  if (under != null) spec.roof.deckUndersideElevationIn = under;   // measured attic: real open space for offsets,
                                                                     // used with any roof-height method
  if (passesThroughRoof(state)) spec.roof.penetrationElevationIn = roofIn ?? undefined;
  else spec.roof.elevationAtChimneyIn = roofIn ?? undefined;

  const ch = state.chase;
  const chaseExit = { type: 'CHASE', chaseTopElevationIn: toInches(ch.topFt, ch.topIn),
                      chaseWidthIn: n(ch.widthIn) ?? undefined, chaseDepthIn: n(ch.depthIn) ?? undefined,
                      airIntake: !!ch.airIntake, shroud: !!ch.shroud,
                      topRule: ch.topRule || 'CODE', aboveChaseIn: ch.topRule === 'SET' ? n(ch.aboveIn) : undefined };
  const floors = list => (list || []).map(f => toInches(f.ft, f.in)).filter(v => v != null);
  // offsets count only when the user said the chimney needs one; a row without a shift is kept so the
  // planner can ask for it instead of quietly planning a straight chimney
  const offsets = (jog, list) => jog !== 'OFFSET' ? []
    : (list || [])
        .map(o => {
          const off = { horizontalIn: n(o.in) };
          if (n(o.room) > 0) off.availableRiseIn = n(o.room);                       // blank: not stated
          if (['15', '30'].includes(String(o.angle))) off.angle = Number(o.angle);  // blank/AUTO: planner picks
          return off;
        })
        ;

  if (isFp) {
    const f = state.fireplace;
    spec.route = {
      type: 'FIREPLACE', floorPenetrationsIn: floors(f.floors), penetrationShield: f.shield, atticAbove: !!f.attic,
      offsets: offsets(f.jog, f.offsets),
      exit: f.exit === 'CHASE' ? chaseExit : { type: 'ROOF' },
    };
  } else if (state.route === 'WALL') {
    const w = state.wall;
    spec.route = {
      type: 'WALL', wallThicknessIn: n(w.thickness), cladding: w.cladding, thimble: w.thimble,
      thimbleCenterElevationIn: toInches(w.centerFt, w.centerIn), standoffIn: n(w.standoff) ?? 2,
      wallTopElevationIn: toInches(w.topFt, w.topIn), eave: w.eave === 'CHASE' ? 'NONE' : w.eave,
      ...(w.eave === 'CHASE' ? { exit: chaseExit } : {}),
      collarToWallIn: n(w.collarToWall) ?? undefined,
      roomCeilingElevationIn: toInches(w.roomCeilingFt, w.roomCeilingIn) ?? undefined,
    };
  } else {
    const ce = state.ceiling;
    // what the chimney passes above the stove room's ceiling
    const above = ce.style === 'CATHEDRAL' ? 'ROOF' : ce.above;
    const ceilingIn = toInches(ce.ft, ce.in);
    const upper = [];
    if (above === 'STORY_ATTIC' && ceilingIn != null) {
      const story = toInches(ce.storyFt, ce.storyIn);
      if (story != null) upper.push(ceilingIn + (n(ce.floorThickIn) ?? 0) + story);   // second-floor ceiling = attic floor
    }
    spec.route = {
      type: 'CEILING',
      ceiling: { style: ce.style, elevationIn: toInches(ce.ft, ce.in), pitch: ce.style === 'CATHEDRAL' ? n(ce.pitch) : undefined,
                 support: ce.style === 'CATHEDRAL' ? 'SQUARE' : ce.support, roundTrim: ce.roundTrim, reducedClearance: !!ce.reduced },
      floorPenetrationsIn: upper, floorLabels: upper.map(() => 'Second-floor ceiling'),
      atticAbove: above === 'ATTIC' || above === 'STORY_ATTIC',
      throughLivingSpace: above === 'STORY_ATTIC' || above === 'STORY_ROOF',
      offsets: offsets(ce.jog, ce.offsets),
      exit: ce.exit === 'CHASE' ? chaseExit : { type: 'ROOF' },
    };
  }
  return spec;
}

/** Inches to a builder's figure: 206.25 -> 17' 2¼". up=true rounds UP to the quarter inch (for minimums). */
export function fmtFtIn(inches, up = false) {
  if (inches == null || !Number.isFinite(inches)) return '–';
  const neg = inches < 0;
  let t = (up && !neg ? Math.ceil(Math.abs(inches) * 4 - 1e-9) : Math.round(Math.abs(inches) * 4)) / 4;
  let f = Math.floor(t / 12);
  let i = t - f * 12;
  const whole = Math.floor(i);
  const frac = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[i - whole];
  return `${neg ? '−' : ''}${f}' ${whole}${frac}"`;
}
