# Chimney Planner — Catalog

The CSV files in `catalog/` are the **source of truth**. The website never reads them
directly; it reads the JSON that `tools/build_catalog.py` generates in `web/catalog/`.

```
edit CSVs (Excel is fine)  →  python tools/build_catalog.py  →  commit CSVs + web/catalog/
```

If the build reports an error, nothing is written. Fix the `file:row` it names and rerun.
Use `--check` to validate without writing.

## Layout

```
catalog/
  shared/                      used by every product line
    manufacturers.csv
    sources.csv                one row per catalog / install manual
    product_lines.csv          DT, DB, DVL ... status ACTIVE | PLANNED | RETIRED
    categories.csv             functional part types, shared across lines
    attribute_defs.csv         line-specific extra attributes and their types
    rules.csv                  manufacturer, code and industry-practice (INDUSTRY) rules; scope = GLOBAL or a line code
    line_compatibility.csv     which lines connect to which, and through which categories
  lines/<LINE>/                one folder per product line
    sizes.csv                  sizes the line comes in (size key, flue, outer diameter)
    parts.csv                  one row per orderable SKU
    dimensions.csv             lettered drawing dimensions (A, B, C ...)
    adjustability.csv          per-size min/max for universal straps and supports
    attributes.csv             values for attribute_defs keys
    elbow_offsets.csv          optional lookup table
    support_box_pitch.csv      optional lookup table
```

## Adding a new product line

1. Add a row to `shared/product_lines.csv` with status `PLANNED`.
2. Create `lines/<CODE>/` with at least `sizes.csv` and `parts.csv` (copy the DT headers).
3. Reuse existing categories where the part does the same job; add new ones to `categories.csv`
   only for genuinely new functions.
4. Anything that doesn't fit a `parts.csv` column becomes an attribute: define it once in
   `attribute_defs.csv`, then set values in the line's `attributes.csv`.
5. Record how it connects to other lines in `line_compatibility.csv`.
6. Flip status to `ACTIVE`. Only active lines are compiled and validated as complete.

## Editing conventions

- **Multiple values in one cell** use `|`: `sizes` = `5|7`, `accepts_connector` = `SINGLE_WALL|DOUBLE_WALL`.
- **Flags** are `0` or `1`. Blank `active` means 1.
- **Pitch** is two plain numbers (`pitch_min`, `pitch_max`) as rise per 12. Never type `7/12`;
  Excel turns it into a date.
- **Effective pipe length is not stored**; the build computes it from the line's `joint_overlap_in`.
- **Size keys are text** so coaxial lines can use keys like `4x6-5/8` later.
- Put anything odd about the manufacturer's own data in the `note` column; the build counts them.
- Save as **CSV UTF-8** from Excel.
- **Rule values are limits, never targets.** A minimum (clearance, height, air space) may be exceeded but
  never undercut: the planner rounds pipe up, compares without rounding, and shows minimums rounded up.

## Appliances are not in the catalog

The catalog holds only chimney-maker data (parts and rules). Stove and fireplace requirements
come from the user, who enters them from their own appliance manual (see `spec.appliance` in
`web/js/engine/spec.js`). There are too many appliances on the market for a maintained list to
be meaningful.
