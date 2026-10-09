/**
 * ChimneySpec: the normalized description of one chimney the engine plans.
 *
 * The questionnaire UI collects friendly answers ("8 ft ceilings, 6/12 roof, ridge is
 * about 8 ft away") and converts them to this shape. The engine only ever sees this.
 *
 * UNITS: every length is INCHES. Every elevation is measured from the FLOOR the
 * appliance stands on (elevation 0). Pitch is rise per 12 of run (6 means 6/12).
 *
 * @typedef {Object} ChimneySpec
 * @property {string}  line                 Product line code, e.g. 'DT'.
 * @property {number|string} [size]         Chimney size. Defaults to appliance.collarSizeIn; must match it.
 * @property {'SS'|'GA'} finish             Outer casing. 5" DuraTech is SS only.
 * @property {'DB'|'DVL'} connectorLine     Stovepipe below the chimney (sizes the cathedral support box).
 * @property {ApplianceManual} appliance    The stove or fireplace, as read from ITS manual.
 * @property {boolean} [highAltitude]       Site is at or above the high-altitude threshold (2,000 ft). Used when
 *                                          siteElevationFt is not given; the elevation decides when it is.
 * @property {number}  [siteElevationFt]    Elevation above sea level. Shown in the layout summary so the
 *                                          user can read the right row of their manual's height table.
 * @property {CeilingRoute|WallRoute|FireplaceRoute} route How the chimney leaves the room.
 * @property {Roof}    roof
 * @property {NearbyPoint[]} [nearbyWithin10ft]  Other parts of the building within 10 ft horizontally
 *                                          (dormers, an upper roof, a parapet...).
 * @property {Options} [options]
 *
 * @typedef {Object} ApplianceManual        What the user reads from their stove or fireplace manual.
 *   Only outletElevationIn and collarSizeIn are required. Leave anything else blank if the manual
 *   doesn't state it. Where the manual and the chimney maker overlap, the stricter value wins.
 * @property {'STOVE'|'FACTORY_FIREPLACE'} [type]  Default STOVE. FACTORY_FIREPLACE needs route FIREPLACE.
 * @property {string}  [label]              Free text for messages, e.g. 'Enviro Boston 1200'.
 * @property {number}  collarSizeIn         Flue collar diameter; sets the chimney size.
 * @property {number}  outletElevationIn    Top of the flue collar above the floor (stove height with legs
 *                                          or pedestal, or fireplace top).
 * @property {'USER_CONFIRMED'|'UL103HT'|'NAMES_THIS_PRODUCT'|'OTHER'|'NOT_STATED'} [acceptsChimney]
 *                                          What chimney the manual allows. The website sends USER_CONFIRMED:
 *                                          people planning a DuraTech chimney have already chosen it for
 *                                          their appliance. The other values remain for callers that ask.
 *                                          Fireplaces must not be NOT_STATED.
 * @property {number}  [minSystemHeightFt]  Minimum height from the top of the outlet to the top of the
 *                                          chimney for THIS layout (read it from the manual's table using
 *                                          result.layout). Blank = the chimney maker's guideline, upper end.
 * @property {number}  [maxSystemHeightFt]
 * @property {number}  [maxOffsets]
 * @property {number[]} [offsetAnglesDeg]   Elbow angles the manual allows, e.g. [15].
 * @property {number}  [minRiseBeforeHorizontalIn]  Wall route: vertical rise before turning horizontal.
 * @property {number}  [minHorizontalToCeilingIn]   Wall route: top of horizontal run to room ceiling.
 * @property {boolean} [requiresRoofRadiationShield]
 * @property {'ANCHOR_PLATE'|'ANCHOR_PLATE_DAMPER'|'DIRECT'} [connection]  Fireplaces: how the chimney attaches.
 *
 * @typedef {Object} CeilingRoute           Chimney starts at a ceiling support box above the stove.
 * @property {'CEILING'} type
 * @property {Ceiling} ceiling
 * @property {number[]} [floorPenetrationsIn]  Elevations of further floor/ceiling assemblies the
 *                                          chimney passes through above the support box (2nd story etc.).
 * @property {boolean} atticAbove            True if the chimney passes through an attic before the roof.
 * @property {boolean} [throughLivingSpace]  The chimney passes through an occupied room above the stove
 *                                          (e.g. a second floor); the plan asks for it to be enclosed there.
 * @property {string[]} [floorLabels]        Display names for floorPenetrationsIn (diagram labels).
 * @property {Offset[]} [offsets]            Offsets to dodge rafters/joists (max 2).
 *
 * @typedef {Object} Ceiling
 * @property {'FLAT'|'CATHEDRAL'} style
 * @property {number} elevationIn            Ceiling surface at the penetration.
 * @property {number} [pitch]                Ceiling pitch, required for CATHEDRAL.
 * @property {'SQUARE'|'SQUARE_COLLAR'|'ROUND'|'FLAT_UNPAINTED'} [support]  Default SQUARE.
 * @property {'SQUARE'|'ROUND'} [roundTrim]  Trim collar for a ROUND box. Default ROUND.
 * @property {boolean} [reducedClearance]    Joists 12" on-center (6" only).
 *
 * @typedef {Object} Offset
 * @property {number} horizontalIn           Sideways shift needed.
 * @property {number} [availableRiseIn]      Vertical room where the jog happens (e.g. top of the ceiling
 *                                          joists to the underside of the rafters). The planner uses 15°
 *                                          elbows when they fit, otherwise 30°.
 * @property {15|30|'AUTO'} [angle]         Force an elbow angle. Default automatic.
 *
 * @typedef {Object} WallRoute              Horizontal through the wall into a tee, then up the outside.
 * @property {'WALL'} type
 * @property {number} wallThicknessIn        Full assembly incl. siding/veneer and air gap.
 * @property {'VINYL'|'WOOD'|'FIBER_CEMENT'|'BRICK'|'STONE'|'STUCCO'} cladding
 * @property {'STANDARD'|'INSULATED'} [thimble]  Default STANDARD.
 * @property {number} thimbleCenterElevationIn
 * @property {number} [standoffIn]           Exterior wall to chimney clearance, 2-6. Default 2.
 * @property {number} wallTopElevationIn     Highest point on the wall a strap can attach (top plate/eave).
 * @property {'NONE'|'THROUGH_OVERHANG'} eave  NONE = gable end or chimney clears the eave.
 * @property {number} [collarToWallIn]       Horizontal distance from the flue collar to the interior wall
 *                                          surface (counts toward the horizontal run in the layout).
 * @property {number} [roomCeilingElevationIn]  Room ceiling, to check clearance above the horizontal run.
 *
 * @typedef {Object} FireplaceRoute         Factory-built fireplace; chimney sits on top of it.
 *                                          The fireplace itself is described in spec.appliance.
 * @property {'FIREPLACE'} type
 * @property {number[]} [floorPenetrationsIn]  Floor/ceiling levels the chimney passes in the chase or house.
 * @property {'FIRESTOP'|'PASS_THROUGH'} [penetrationShield]  Default FIRESTOP. PASS_THROUGH (6-8")
 *                                          also serves as the attic shield at the top level.
 * @property {boolean} [atticAbove]
 * @property {Offset[]} [offsets]
 * @property {{type:'CHASE', chaseTopElevationIn:number, airIntake?:boolean, shroud?:boolean}
 *          | {type:'ROOF'}} exit           CHASE = exits the top of a framed chase; ROOF = through a roof.
 *
 * @typedef {Object} Roof
 * @property {number} pitch
 * @property {'SHINGLE'|'METAL_CORRUGATED'|'TILE'} surface
 * @property {number} [penetrationElevationIn]  Roof surface at the chimney centerline where the chimney
 *                                          passes through the roof.
 * @property {number} [elevationAtChimneyIn]  Roof surface at the chimney's position when the chimney does
 *                                          NOT pass through it (beside a chase); used for the 2 ft / 10 ft rule.
 * @property {number} [horizontalToRidgeFt]   Level distance to the ridge, measured from the chimney's uphill side
 *                                          (its outer wall). Other positions are at the chimney's center.
 * @property {number} [deckUndersideElevationIn]  Measured underside of the roof deck at the chimney (from the
 *                                          attic). When given, it bounds the attic space offsets can use.
 *
 * @typedef {Object} NearbyPoint
 * @property {string} label
 * @property {number} elevationIn
 *
 * @typedef {Object} Options
 * @property {boolean} [sparkArrestor]
 * @property {boolean} [lockingBands]
 * @property {'STANDARD'|'DIKAPT'} [cap]
 */

/** Example: single-story ranch, stove in the living room, attic above, shingle roof. Manual not entered. */
export const EXAMPLE_RANCH = {
  line: 'DT', finish: 'SS', connectorLine: 'DB',
  appliance: { type: 'STOVE', collarSizeIn: 6, outletElevationIn: 30, acceptsChimney: 'UL103HT' },
  route: { type: 'CEILING', ceiling: { style: 'FLAT', elevationIn: 96 }, atticAbove: true },
  roof: { pitch: 6, surface: 'SHINGLE', penetrationElevationIn: 132, horizontalToRidgeFt: 8 },
};

/** Example: stove against an exterior brick wall, chimney runs up the gable end. */
export const EXAMPLE_THROUGH_WALL = {
  line: 'DT', finish: 'SS', connectorLine: 'DB',
  appliance: { type: 'STOVE', collarSizeIn: 6, outletElevationIn: 30, acceptsChimney: 'UL103HT' },
  route: { type: 'WALL', wallThicknessIn: 10.5, cladding: 'BRICK', thimbleCenterElevationIn: 60,
           standoffIn: 2, wallTopElevationIn: 108, eave: 'NONE' },
  roof: { pitch: 6, surface: 'SHINGLE' },
  nearbyWithin10ft: [{ label: 'gable roof edge', elevationIn: 150 }],
};

/** Example: two-story house, factory-built fireplace in an exterior framed chase. */
export const EXAMPLE_CHASE_FIREPLACE = {
  line: 'DT', finish: 'GA', connectorLine: 'DB',
  appliance: { type: 'FACTORY_FIREPLACE', label: 'Example FP-42', collarSizeIn: 8, outletElevationIn: 60,
               acceptsChimney: 'NAMES_THIS_PRODUCT', connection: 'ANCHOR_PLATE', minSystemHeightFt: 14 },
  route: {
    type: 'FIREPLACE',
    floorPenetrationsIn: [108],
    exit: { type: 'CHASE', chaseTopElevationIn: 300 },
  },
  roof: { pitch: 6, surface: 'SHINGLE' },
  nearbyWithin10ft: [{ label: 'main roof ridge', elevationIn: 320 }],
};
