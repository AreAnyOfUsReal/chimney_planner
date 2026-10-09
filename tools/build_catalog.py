"""
Validate the CSV catalog and compile it to JSON for the website.

    python tools/build_catalog.py            # validate + write dist/catalog/
    python tools/build_catalog.py --check    # validate only

Source of truth:  catalog/shared/*.csv  and  catalog/lines/<LINE>/*.csv
Output:           web/catalog/index.json   (lines, categories, rules, attribute defs, compatibility)
                  dist/catalog/<LINE>.json  (sizes, parts, lookup tables) - one per ACTIVE line

Errors stop the build and are reported as  file:row  so they can be fixed in Excel.
Warnings are printed but do not stop the build.
Standard library only.
"""
import csv, json, re, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAT = ROOT / "catalog"
OUT = ROOT / "web" / "catalog"

FINISHES = {"GA", "SS", "BLACK", "GALV", "ALUM", "EPDM", "UNPAINTED"}
ZONES = {"appliance", "pipe", "offset", "ceiling", "attic", "wall", "support", "roof", "termination", "chase", "hardware"}
FAMILIES = {"CHIMNEY", "CONNECTOR", "LINER", "DIRECT_VENT", "PELLET", "GAS_VENT"}
FUELS = {"WOOD", "COAL", "OIL", "GAS", "PELLET"}
AUTHORITIES = {"MANUFACTURER", "NFPA211", "IRC", "LOCAL", "INDUSTRY"}   # INDUSTRY: common trade practice
PIPE_CATEGORIES = {"CHIMNEY_PIPE"}          # get effective_length_in computed
RANGE_PAIRS = [("adjustable_min_in", "adjustable_max_in"), ("pitch_min", "pitch_max"),
               ("wall_min_in", "wall_max_in"), ("standoff_min_in", "standoff_max_in")]


class Problems:
    def __init__(self):
        self.errors, self.warnings = [], []

    def err(self, where, msg): self.errors.append(f"ERROR   {where}: {msg}")
    def warn(self, where, msg): self.warnings.append(f"WARNING {where}: {msg}")


P = Problems()


# ---------------------------------------------------------------- reading
def read(path, required, optional=()):
    """Read a CSV; return list of (where, row_dict). Header must match exactly (order free)."""
    rel = path.relative_to(ROOT)
    if not path.exists():
        P.err(rel, "file missing")
        return []
    with open(path, newline="", encoding="utf-8-sig") as f:   # utf-8-sig tolerates Excel's BOM
        r = csv.DictReader(f)
        cols = set(r.fieldnames or [])
        allowed = set(required) | set(optional)
        for c in set(required) - cols:
            P.err(rel, f"missing column '{c}'")
        for c in cols - allowed:
            P.err(rel, f"unknown column '{c}' (typo, or add it to the build script)")
        rows = []
        for i, row in enumerate(r, start=2):                     # row 1 is the header
            row = {k: (v or "").strip() for k, v in row.items() if k}
            if not any(row.values()):
                continue                                          # skip blank lines Excel leaves behind
            rows.append((f"{rel}:{i}", row))
        return rows


def num(where, row, col, required=False, integer=False):
    v = row.get(col, "")
    if v == "":
        if required:
            P.err(where, f"'{col}' is required")
        return None
    try:
        f = float(v)
    except ValueError:
        hint = " (Excel may have turned a fraction into a date)" if re.search(r"[A-Za-z]{3}|/|-\d", v) else ""
        P.err(where, f"'{col}' must be a number, got '{v}'{hint}")
        return None
    if integer and not f.is_integer():
        P.err(where, f"'{col}' must be a whole number, got '{v}'")
    return int(f) if f.is_integer() else f


def flag(where, row, col, default=0):
    v = row.get(col, "")
    if v == "":
        return bool(default)
    if v not in ("0", "1"):
        P.err(where, f"'{col}' must be 0 or 1, got '{v}'")
    return v == "1"


def enum(where, row, col, allowed, required=False):
    v = row.get(col, "")
    if v == "":
        if required:
            P.err(where, f"'{col}' is required")
        return None
    if v not in allowed:
        P.err(where, f"'{col}' = '{v}' is not one of {sorted(allowed)}")
    return v


def pipe_list(v):
    return [x.strip() for x in v.split("|") if x.strip()] if v else []


# ---------------------------------------------------------------- shared
def build_shared():
    mfrs = {r["code"]: r for _, r in read(CAT / "shared/manufacturers.csv", ["code", "name", "website"])}

    sources = {}
    for w, r in read(CAT / "shared/sources.csv", ["source_code", "manufacturer", "document_code", "title", "published"]):
        if r["manufacturer"] not in mfrs:
            P.err(w, f"unknown manufacturer '{r['manufacturer']}'")
        sources[r["source_code"]] = r

    lines = {}
    for w, r in read(CAT / "shared/product_lines.csv",
                     ["code", "name", "manufacturer", "family", "status", "fuels", "listing", "listing_file",
                      "clearance_to_combustibles_in", "joint_overlap_in", "wall_thickness_in",
                      "continuous_flue_temp_f", "default_source", "notes"]):
        if r["code"] in lines:
            P.err(w, f"duplicate product line '{r['code']}'")
        if r["manufacturer"] not in mfrs:
            P.err(w, f"unknown manufacturer '{r['manufacturer']}'")
        if r["default_source"] and r["default_source"] not in sources:
            P.err(w, f"unknown source '{r['default_source']}'")
        for fuel in pipe_list(r["fuels"]):
            if fuel not in FUELS:
                P.err(w, f"unknown fuel '{fuel}'")
        status = enum(w, r, "status", {"ACTIVE", "PLANNED", "RETIRED"}, required=True)
        lines[r["code"]] = {
            "code": r["code"], "name": r["name"], "manufacturer": r["manufacturer"],
            "family": enum(w, r, "family", FAMILIES, required=True), "status": status,
            "fuels": pipe_list(r["fuels"]), "listing": r["listing"] or None, "listing_file": r["listing_file"] or None,
            "clearance_to_combustibles_in": num(w, r, "clearance_to_combustibles_in", required=status == "ACTIVE"),
            "joint_overlap_in": num(w, r, "joint_overlap_in", required=status == "ACTIVE"),
            "wall_thickness_in": num(w, r, "wall_thickness_in"),
            "continuous_flue_temp_f": num(w, r, "continuous_flue_temp_f", integer=True),
            "default_source": r["default_source"] or None, "notes": r["notes"] or None,
        }

    categories = {}
    for w, r in read(CAT / "shared/categories.csv", ["code", "name", "system_zone", "description"]):
        if r["code"] in categories:
            P.err(w, f"duplicate category '{r['code']}'")
        enum(w, r, "system_zone", ZONES, required=True)
        categories[r["code"]] = {k: (v or None) for k, v in r.items()}

    attr_defs = {}
    for w, r in read(CAT / "shared/attribute_defs.csv", ["key", "type", "allowed_values", "unit", "categories", "description"]):
        enum(w, r, "type", {"bool", "number", "text", "enum", "list", "map"}, required=True)
        cats = pipe_list(r["categories"])
        for c in cats:
            if c not in categories:
                P.err(w, f"unknown category '{c}'")
        if r["type"] in ("enum", "list") and not r["allowed_values"]:
            P.err(w, "enum/list attributes need allowed_values")
        attr_defs[r["key"]] = {"key": r["key"], "type": r["type"], "allowed_values": pipe_list(r["allowed_values"]),
                               "unit": r["unit"] or None, "categories": cats, "description": r["description"]}

    rules = []
    seen = set()
    for w, r in read(CAT / "shared/rules.csv",
                     ["rule_key", "authority", "scope", "value", "value_max", "unit", "statement", "source_ref", "verified"]):
        if r["rule_key"] in seen:
            P.err(w, f"duplicate rule_key '{r['rule_key']}'")
        seen.add(r["rule_key"])
        enum(w, r, "authority", AUTHORITIES, required=True)
        if r["scope"] != "GLOBAL" and r["scope"] not in lines:
            P.err(w, f"scope must be GLOBAL or a product line code, got '{r['scope']}'")
        if not r["statement"]:
            P.err(w, "statement is required")
        v, vmax = num(w, r, "value"), num(w, r, "value_max")
        if v is not None and vmax is not None and v > vmax:
            P.err(w, f"value {v} > value_max {vmax}")
        rules.append({"key": r["rule_key"], "authority": r["authority"], "scope": r["scope"], "value": v,
                      "value_max": vmax, "unit": r["unit"] or None, "statement": r["statement"],
                      "source_ref": r["source_ref"] or None, "verified": flag(w, r, "verified")})
    unverified = sum(1 for x in rules if not x["verified"] and x["authority"] != "MANUFACTURER")
    if unverified:
        P.warn("catalog/shared/rules.csv", f"{unverified} code rules are not yet verified against the primary source")

    compat = []
    for w, r in read(CAT / "shared/line_compatibility.csv",
                     ["line", "other_line", "relationship", "via_categories", "note", "source_ref"]):
        for col in ("line", "other_line"):
            if r[col] not in lines:
                P.err(w, f"unknown product line '{r[col]}' in '{col}'")
        enum(w, r, "relationship", {"CONNECTOR_BELOW", "TRANSITION_FROM", "TRANSITION_TO"}, required=True)
        for c in pipe_list(r["via_categories"]):
            if c not in categories:
                P.err(w, f"unknown category '{c}'")
        compat.append({"line": r["line"], "other_line": r["other_line"], "relationship": r["relationship"],
                       "via_categories": pipe_list(r["via_categories"]), "note": r["note"] or None,
                       "source_ref": r["source_ref"] or None})

    return dict(manufacturers=mfrs, sources=sources, product_lines=lines, categories=categories,
                attribute_defs=attr_defs, rules=rules, line_compatibility=compat)


# ---------------------------------------------------------------- one product line
PART_COLS = ["order_number", "stock_number", "category", "description", "sizes", "finish", "carton_filler",
             "nominal_length_in", "adjustable_min_in", "adjustable_max_in", "elbow_angle_deg",
             "pitch_min", "pitch_max", "pitch_applies_to", "height_in", "max_supported_ft",
             "max_supported_with_straps_ft", "wall_min_in", "wall_max_in", "wall_max_extended_in",
             "standoff_min_in", "standoff_max_in", "optional", "active", "source_page", "note"]
NUM_COLS = [c for c in PART_COLS if c.endswith(("_in", "_ft", "_deg")) or c in ("pitch_min", "pitch_max")]


def build_line(code, line, shared):
    d = CAT / "lines" / code
    if not d.exists():
        P.err(f"catalog/lines/{code}", "folder missing for ACTIVE product line")
        return None

    sizes = {}
    for w, r in read(d / "sizes.csv", ["size", "flue_in", "outer_in"]):
        if r["size"] in sizes:
            P.err(w, f"duplicate size '{r['size']}'")
        sizes[r["size"]] = {"size": r["size"], "flue_in": num(w, r, "flue_in", required=True),
                            "outer_in": num(w, r, "outer_in")}

    parts, by_order = [], {}
    for w, r in read(d / "parts.csv", PART_COLS):
        o = r["order_number"]
        if not o:
            P.err(w, "order_number is required")
            continue
        if o in by_order:
            P.err(w, f"duplicate order_number '{o}'")
            continue
        if r["category"] not in shared["categories"]:
            P.err(w, f"unknown category '{r['category']}'")
        if not r["description"]:
            P.err(w, "description is required")
        part_sizes = pipe_list(r["sizes"])
        if not part_sizes:
            P.err(w, f"'{o}' has no sizes")
        for s in part_sizes:
            if s not in sizes:
                P.err(w, f"size '{s}' not in {code}/sizes.csv")
        p = {"order_number": o, "stock_number": r["stock_number"] or None, "category": r["category"],
             "description": r["description"], "sizes": part_sizes,
             "finish": enum(w, r, "finish", FINISHES), "carton_filler": flag(w, r, "carton_filler"),
             "pitch_applies_to": enum(w, r, "pitch_applies_to", {"roof", "ceiling"}),
             "optional": flag(w, r, "optional"), "active": flag(w, r, "active", default=1),
             "source_page": num(w, r, "source_page", integer=True), "note": r["note"] or None}
        for c in NUM_COLS:
            p[c] = num(w, r, c)
        for lo, hi in RANGE_PAIRS:
            if p[lo] is not None and p[hi] is not None and p[lo] > p[hi]:
                P.err(w, f"{lo} ({p[lo]}) > {hi} ({p[hi]})")
        if (r["pitch_min"] != "") != (p["pitch_applies_to"] is not None):
            P.err(w, "pitch_min/pitch_max and pitch_applies_to must be set together")
        if r["category"] in PIPE_CATEGORIES:
            if p["nominal_length_in"] is None:
                P.err(w, f"pipe '{o}' needs nominal_length_in")
            else:
                p["effective_length_in"] = p["nominal_length_in"] - line["joint_overlap_in"]
        p.update(dimensions={}, adjustability={}, attributes={})
        parts.append(p)
        by_order[o] = (w, p)

    stocks = {}
    for o, (w, p) in by_order.items():
        if p["stock_number"]:
            if p["stock_number"] in stocks:
                P.warn(w, f"stock_number {p['stock_number']} also used by {stocks[p['stock_number']]}")
            stocks.setdefault(p["stock_number"], o)

    def owner(w, r):
        o = r["order_number"]
        if o not in by_order:
            P.err(w, f"order_number '{o}' not in {code}/parts.csv")
            return None
        return by_order[o][1]

    for w, r in read(d / "dimensions.csv", ["order_number", "label", "value_in", "value_text", "meaning"]):
        p = owner(w, r)
        if not p:
            continue
        if r["label"] in p["dimensions"]:
            P.err(w, f"duplicate dimension '{r['label']}' for {r['order_number']}")
        v = num(w, r, "value_in")
        if v is None and not r["value_text"]:
            P.err(w, "dimension needs value_in or value_text")
        p["dimensions"][r["label"]] = {"value_in": v, "text": r["value_text"] or None, "meaning": r["meaning"] or None}

    for w, r in read(d / "adjustability.csv", ["order_number", "size", "min_in", "max_in"]):
        p = owner(w, r)
        if not p:
            continue
        if r["size"] not in p["sizes"]:
            P.err(w, f"size '{r['size']}' is not one of {r['order_number']}'s sizes {p['sizes']}")
        mn, mx = num(w, r, "min_in", required=True), num(w, r, "max_in", required=True)
        if mn is not None and mx is not None and mn > mx:
            P.err(w, f"min_in {mn} > max_in {mx}")
        p["adjustability"][r["size"]] = {"min_in": mn, "max_in": mx}

    defs = shared["attribute_defs"]
    for w, r in read(d / "attributes.csv", ["order_number", "attribute", "value"]):
        p = owner(w, r)
        if not p:
            continue
        k, v = r["attribute"], r["value"]
        if k not in defs:
            P.err(w, f"attribute '{k}' not defined in shared/attribute_defs.csv")
            continue
        ad = defs[k]
        if ad["categories"] and p["category"] not in ad["categories"]:
            P.err(w, f"attribute '{k}' does not apply to category {p['category']}")
        t = ad["type"]
        if t == "bool":
            if v not in ("0", "1"):
                P.err(w, f"'{k}' must be 0 or 1")
            val = v == "1"
        elif t == "number":
            val = num(w, r, "value")
        elif t == "enum":
            val = v
            if v not in ad["allowed_values"]:
                P.err(w, f"'{k}' = '{v}' not in {ad['allowed_values']}")
        elif t == "list":
            val = pipe_list(v)
            for x in val:
                if x not in ad["allowed_values"]:
                    P.err(w, f"'{k}' item '{x}' not in {ad['allowed_values']}")
        elif t == "map":
            val = {}
            for pair in pipe_list(v):
                key, _, mv = pair.partition(":")
                try:
                    val[key] = float(mv) if not float(mv).is_integer() else int(float(mv))
                except ValueError:
                    P.err(w, f"'{k}' entry '{pair}' must look like size:number")
                if key not in p["sizes"]:
                    P.err(w, f"'{k}' key '{key}' is not one of the part's sizes")
        else:
            val = v
        p["attributes"][k] = val

    lookups = {}
    elbows = []
    for w, r in read(d / "elbow_offsets.csv", ["angle_deg", "between_desc", "between_nominal_in", "offset_in", "rise_in"],
                     ) if (d / "elbow_offsets.csv").exists() else []:
        elbows.append({"angle_deg": num(w, r, "angle_deg", required=True), "between_desc": r["between_desc"],
                       "between_nominal_in": num(w, r, "between_nominal_in", required=True),
                       "offset_in": num(w, r, "offset_in", required=True), "rise_in": num(w, r, "rise_in", required=True)})
    if elbows:
        for ang in {e["angle_deg"] for e in elbows}:
            seq = sorted((e for e in elbows if e["angle_deg"] == ang), key=lambda e: e["between_nominal_in"] or 0)
            for a, b in zip(seq, seq[1:]):
                if b["offset_in"] <= a["offset_in"] or b["rise_in"] <= a["rise_in"]:
                    P.err(f"{code}/elbow_offsets.csv", f"{ang}° offset/rise not increasing at {b['between_desc']}")
        lookups["elbow_offsets"] = elbows

    sbp = []
    if (d / "support_box_pitch.csv").exists():
        for w, r in read(d / "support_box_pitch.csv", ["connector_line", "pitch_min", "pitch_max", "box_height_in"]):
            if r["connector_line"] not in shared["product_lines"]:
                P.err(w, f"unknown product line '{r['connector_line']}'")
            row = {"connector_line": r["connector_line"], "pitch_min": num(w, r, "pitch_min", required=True),
                   "pitch_max": num(w, r, "pitch_max", required=True),
                   "box_height_in": num(w, r, "box_height_in", required=True)}
            if None not in (row["pitch_min"], row["pitch_max"]) and row["pitch_min"] > row["pitch_max"]:
                P.err(w, "pitch_min > pitch_max")
            sbp.append(row)
        heights = {p["height_in"] for p in parts if p["category"].startswith("CEILING_SUPPORT_SQUARE")}
        for row in sbp:
            if row["box_height_in"] not in heights:
                P.err(f"{code}/support_box_pitch.csv", f"no square support box {row['box_height_in']}in tall in parts.csv")
        lookups["support_box_pitch"] = sbp

    noted = sum(1 for p in parts if p["note"])
    if noted:
        P.warn(f"catalog/lines/{code}/parts.csv", f"{noted} parts carry data-quality notes to resolve with the manufacturer")
    return {"line": line, "sizes": list(sizes.values()), "parts": parts, "lookups": lookups,
            "rules": [r for r in shared["rules"] if r["scope"] == code]}


# ---------------------------------------------------------------- main
def main():
    check_only = "--check" in sys.argv
    shared = build_shared()
    built = {}
    for code, line in shared["product_lines"].items():
        if line["status"] == "ACTIVE":
            built[code] = build_line(code, line, shared)

    for m in P.warnings:
        print(m)
    for m in P.errors:
        print(m)
    if P.errors:
        print(f"\nBuild FAILED: {len(P.errors)} error(s). Nothing written.")
        return 1

    summary = {c: len(b["parts"]) for c, b in built.items()}
    if check_only:
        print(f"\nCatalog valid. Parts per active line: {summary}")
        return 0

    def prune(x):
        """Drop null/empty fields: the site treats a missing key as 'not applicable'."""
        if isinstance(x, dict):
            return {k: prune(v) for k, v in x.items() if v not in (None, {}, [], "")}
        if isinstance(x, list):
            return [prune(v) for v in x]
        return x

    def dump(path, obj):
        path.write_text(json.dumps(prune(obj), separators=(",", ":")), encoding="utf-8")

    OUT.mkdir(parents=True, exist_ok=True)
    index = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": list(shared["sources"].values()),
        "manufacturers": list(shared["manufacturers"].values()),
        "product_lines": list(shared["product_lines"].values()),
        "categories": list(shared["categories"].values()),
        "attribute_defs": list(shared["attribute_defs"].values()),
        "rules": [r for r in shared["rules"] if r["scope"] == "GLOBAL"],
        "line_compatibility": shared["line_compatibility"],
        "line_files": {c: f"{c}.json" for c in built},
    }
    dump(OUT / "index.json", index)
    for c, b in built.items():
        dump(OUT / f"{c}.json", b)
    print(f"\nBuild OK -> {OUT.relative_to(ROOT)}/  parts per line: {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
