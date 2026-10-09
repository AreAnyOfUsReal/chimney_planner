/**
 * Questionnaire page: binds the form to a plain state object, converts it with toSpec(),
 * runs the engine on every change, and renders the results sheet.
 */
import { loadCatalog } from './engine/catalog.js';
import { offsetChoices } from './engine/geometry.js';
import { planChimney } from './engine/planner.js';
import { EXAMPLE_STATE, blankState, toSpec, fmtFtIn, passesThroughRoof, roofHeightIn, atticMethodApplies,
         deckUndersideIn, topCeilingIn } from './ui/form-model.js';

const STORE_KEY = 'chimney-planner/answers/v1';
const $ = sel => document.querySelector(sel);
const form = $('#q');
const clone = o => structuredClone(o);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let catalog = null;
let state = loadState();
let lastResult = null;
let lastSpec = null;

// ------------------------------------------------------------------ state helpers
function merge(base, saved) {
  if (Array.isArray(base)) return Array.isArray(saved) ? saved : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    for (const k of Object.keys(base)) if (saved && k in saved) out[k] = merge(base[k], saved[k]);
    return out;
  }
  return saved === undefined ? base : saved;
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const merged = merge(clone(EXAMPLE_STATE), saved);
      // answers saved before the eave method existed carry a typed roof height: keep using it
      if (saved.roof && !('method' in saved.roof)) merged.roof.method = 'DIRECT';
      // answers saved before the "what's above this ceiling" question used an attic checkbox
      if (saved.ceiling && !('above' in saved.ceiling)) merged.ceiling.above = saved.ceiling.attic === false ? 'ROOF' : 'ATTIC';
      // answers saved before the shared chase section kept the chase on the fireplace
      if (saved.fireplace && 'chaseFt' in saved.fireplace && !saved.chase) {
        Object.assign(merged.chase, { topFt: saved.fireplace.chaseFt, topIn: saved.fireplace.chaseIn,
          airIntake: !!saved.fireplace.airIntake, shroud: !!saved.fireplace.shroud });
      }
      // answers saved before the attic section kept the attic measurement on the roof
      // (from the top of the joists; "framing" was joist + drywall)
      if (saved.roof && 'atticFt' in saved.roof && !saved.attic) {
        const framing = Number(saved.roof.joistIn);
        Object.assign(merged.attic, {
          from: 'JOISTS', ft: saved.roof.atticFt ?? null, in: saved.roof.atticIn ?? null,
          joistIn: Number.isFinite(framing) && framing > 0.5 ? framing - 0.5 : merged.attic.joistIn, drywallIn: 0.5,
          deckIn: saved.roof.deckIn ?? merged.attic.deckIn,
        });
      }
      // answers saved before the high-altitude checkbox: an elevation of 2,000 ft or more ticks it
      if (saved.chimney && !('highAltitude' in saved.chimney)) {
        const elev = saved.chimney.siteElevationFt;
        merged.chimney.highAltitude = elev != null && elev !== '' && Number(elev) >= 2000;
        if (!merged.chimney.highAltitude) merged.chimney.siteElevationFt = null;
      }
      // answers saved before the straight/offset question: offsets entered mean "needs an offset"
      for (const k of ['ceiling', 'fireplace']) {
        if (saved[k] && !('jog' in saved[k])) {
          const filled = (saved[k].offsets || []).some(o => Number(o.in) > 0);
          merged[k].jog = filled ? 'OFFSET' : 'STRAIGHT';
          if (!merged[k].offsets.length) merged[k].offsets = [{ in: null }];
        }
      }
      return merged;
    }
  } catch { /* storage unavailable: start from the example */ }
  return clone(EXAMPLE_STATE);
}
function saveState() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ } }
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

// ------------------------------------------------------------------ form <-> state
function fillPitchOptions() {
  for (const sel of form.querySelectorAll('select[data-options="pitch"]')) {
    sel.innerHTML = '<option value="" disabled>Choose…</option>' + Array.from({ length: 25 }, (_, i) => `<option value="${i}">${i === 0 ? 'Flat (0/12)' : `${i}/12`}</option>`).join('');
  }
}

function writeControls() {
  for (const el of form.querySelectorAll('[name]')) {
    const v = getPath(state, el.name);
    if (el.type === 'radio') el.checked = String(v) === el.value;
    else if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
  for (const box of form.querySelectorAll('[data-list]')) renderList(box);
}

function readControl(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return el.value === '' ? null : Number(el.value);
  return el.value;
}

const ROW = {
  height: (path, i, r) => `
    <div class="row">
      <div class="ftin">
        <input type="number" id="${path}-${i}-ft" aria-label="Feet" min="0" step="1" data-path="${path}" data-i="${i}" data-f="ft" value="${esc(r.ft ?? '')}"><span>ft</span>
        <input type="number" id="${path}-${i}-in" aria-label="Inches" min="0" step="0.25" data-path="${path}" data-i="${i}" data-f="in" value="${esc(r.in ?? '')}"><span>in</span>
      </div>
      <button type="button" class="icon-btn" data-remove="${path}" data-i="${i}" aria-label="Remove">✕</button>
    </div>`,
  offset: (path, i, r) => `
    <div class="row offset">
      <span class="offset-n">Offset ${i + 1}</span>
      <label class="mini"><span>Elbows</span>
        <select id="${path}-${i}-angle" data-path="${path}" data-i="${i}" data-f="angle">
          ${[['AUTO', 'Auto'], ...allowedAngles().map(a => [String(a), `${a}°`])].map(([v, t]) => `<option value="${v}"${String(r.angle ?? 'AUTO') === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select></label>
      <label class="mini"><span>Sideways shift</span>
        <select id="${path}-${i}-in" data-path="${path}" data-i="${i}" data-f="in" data-num>${shiftOptions(r)}</select></label>
      <label class="mini"><span>Height available</span>
        <span class="withunit"><input type="number" id="${path}-${i}-room" min="0" step="0.5" placeholder="optional" data-path="${path}" data-i="${i}" data-f="room" value="${esc(r.room ?? '')}"><span class="unit">in</span></span></label>
      <button type="button" class="icon-btn" data-remove="${path}" data-i="${i}" aria-label="Remove offset ${i + 1}">✕</button>
      <p class="offset-calc" data-calc="${path}-${i}"></p>
    </div>`,
  nearby: (path, i, r) => `
    <div class="row nearby">
      <input type="text" id="${path}-${i}-label" aria-label="What it is" placeholder="e.g. dormer roof" data-path="${path}" data-i="${i}" data-f="label" value="${esc(r.label ?? '')}">
      <div class="ftin">
        <input type="number" id="${path}-${i}-ft" aria-label="Height, feet" min="0" step="1" data-path="${path}" data-i="${i}" data-f="ft" value="${esc(r.ft ?? '')}"><span>ft</span>
        <input type="number" id="${path}-${i}-in" aria-label="Height, inches" min="0" step="0.25" data-path="${path}" data-i="${i}" data-f="in" value="${esc(r.in ?? '')}"><span>in</span>
      </div>
      <button type="button" class="icon-btn" data-remove="${path}" data-i="${i}" aria-label="Remove">✕</button>
    </div>`,
};
// ------------------------------------------------------------------ offsets: only shifts the elbow chart can make
const chart = () => catalog?.lookups?.elbow_offsets || [];
const allowedAngles = () => (state.appliance.only15 ? [15] : [15, 30]);
const rowAngles = r => (['15', '30'].includes(String(r.angle)) ? [Number(r.angle)] : allowedAngles())
  .filter(a => allowedAngles().includes(a));
/** Fractions builders read: 24.125 -> 24⅛" */
function inFrac(v) {
  const t = Math.round(v * 8) / 8, w = Math.floor(t);
  return `${w || (t - w ? '' : 0)}${{ 0: '', 0.125: '⅛', 0.25: '¼', 0.375: '⅜', 0.5: '½', 0.625: '⅝', 0.75: '¾', 0.875: '⅞' }[t - w]}"`;
}
function shiftOptions(r) {
  if (!chart().length) return `<option value="${esc(r.in ?? '')}" selected>${r.in != null ? inFrac(r.in) : 'Loading…'}</option>`;
  const angles = rowAngles(r);
  const opts = offsetChoices(chart(), angles).map(({ offsetIn, rows }) => {
    const how = rows.length === 1 || angles.length === 1
      ? `${rows[0].angle_deg}°, ${rows[0].between_nominal_in ? `${rows[0].between_desc} pipe between` : 'elbows only'}, ${inFrac(rows[0].rise_in)} tall`
      : rows.map(x => `${x.angle_deg}°: ${inFrac(x.rise_in)} tall`).join(' / ');
    return `<option value="${offsetIn}"${Number(r.in) === offsetIn ? ' selected' : ''}>${inFrac(offsetIn)} (${how})</option>`;
  });
  return `<option value=""${r.in == null ? ' selected' : ''} disabled>Choose…</option>` + opts.join('');
}
/** Saved or typed shifts that aren't on the chart move to the next one up (never smaller). */
function snapOffsets() {
  if (!chart().length) return;
  for (const k of ['ceiling', 'fireplace']) {
    for (const r of state[k].offsets || []) {
      if (!rowAngles(r).length) r.angle = 'AUTO';    // e.g. 30° chosen, then the manual allows only 15°
      if (r.in == null) continue;
      const next = offsetChoices(chart(), rowAngles(r)).find(c => c.offsetIn >= Number(r.in) - 1e-9);
      r.in = next ? next.offsetIn : null;
    }
  }
}
/** The worked numbers under each offset row: chart shift and rise, and how the rise fits the height. */
function renderOffsetCalcs(r) {
  const used = r?.geometry?.offsets || [];
  for (const el of form.querySelectorAll('[data-calc]')) {
    const [path, i] = [el.dataset.calc.replace(/-\d+$/, ''), Number(el.dataset.calc.match(/(\d+)$/)[1])];
    const row = getPath(state, path)?.[i];
    if (!row || row.in == null) { el.innerHTML = 'Choose a shift to see its height.'; continue; }
    const o = r?.ok ? used.find(u => u.n === i + 1) : null;
    const candidates = chart().filter(c => c.offset_in === Number(row.in) && rowAngles(row).includes(c.angle_deg));
    const pick = o ? chart().find(c => c.angle_deg === o.angleDeg && c.offset_in === o.offsetIn && c.rise_in === o.riseIn) : candidates[0];
    if (!pick) { el.innerHTML = ''; continue; }
    const pipe = pick.between_nominal_in ? `two ${pick.angle_deg}° elbows + ${pick.between_desc} pipe between` : `two ${pick.angle_deg}° elbows, no pipe between`;
    let fit = '';
    const room = o?.availableRiseIn ?? (Number(row.room) > 0 ? Number(row.room) : null);
    if (room != null) {
      const spare = room - pick.rise_in;
      fit = spare >= 0 ? ` Height: ${inFrac(room)} available − ${inFrac(pick.rise_in)} = <b>${inFrac(spare)} to spare</b>.`
                       : ` Height: needs ${inFrac(pick.rise_in)}, only ${inFrac(room)} available: <b class="short">${inFrac(-spare)} short</b>.`;
    } else if (o?.estimatedRoomIn != null) {
      const spare = o.estimatedRoomIn - pick.rise_in;
      fit = ` Height: about ${inFrac(o.estimatedRoomIn)} open (estimated) − ${inFrac(pick.rise_in)} = ${spare >= 0 ? `${inFrac(spare)} to spare` : `<b class="short">${inFrac(-spare)} short</b>`}.`;
    }
    const other = !o && candidates.length > 1 ? ` Or ${candidates.slice(1).map(c => `${c.angle_deg}° elbows: ${inFrac(c.rise_in)} tall`).join(', ')}; Auto picks the one that fits.` : '';
    el.innerHTML = `${pipe} → <b>${inFrac(pick.offset_in)}</b> sideways over <b>${inFrac(pick.rise_in)}</b> of height (Duravent elbow chart).${fit}${other}`;
  }
}

const NEW_ROW = { height: { ft: null, in: 0 }, offset: { in: null, room: null, angle: 'AUTO' }, nearby: { label: '', ft: null, in: 0 } };

function renderList(box) {
  const path = box.dataset.list;
  box.innerHTML = (getPath(state, path) || []).map((r, i) => ROW[box.dataset.kind](path, i, r)).join('');
  const add = form.querySelector(`[data-add="${path}"]`);
  if (add && path.endsWith('offsets')) add.hidden = (getPath(state, path) || []).length >= 2;
  if (path.endsWith('offsets')) {   // a single offset can't be removed: switch to "Straight up" instead
    const only = (getPath(state, path) || []).length <= 1;
    box.querySelectorAll('[data-remove]').forEach(b => { b.hidden = only; });
  }
}

// ------------------------------------------------------------------ conditional fields
/** data-when: "a=X;b=Y|Z" means a is X and b is Y or Z; "||" separates alternatives. */
function holds(cond) {
  return cond.split('||').some(group => group.split(';').every(part => {
    const [path, values] = part.split('=');
    return values.split('|').includes(String(getPath(state, path.trim())));
  }));
}
function applyVisibility() {
  if (state.roof.method === 'ATTIC' && !atticMethodApplies(state)) {
    state.roof.method = 'EAVE';
    $('#roof-method-eave').checked = true;
  }
  // toggleAttribute, not .hidden: the attic sketch's SVG groups have no .hidden property
  for (const el of form.querySelectorAll('[data-when]')) el.toggleAttribute('hidden', !holds(el.dataset.when));
  renderAtticReadout();
  syncManualBox();
  const through = passesThroughRoof(state);
  $('#roofHeightLabel').textContent = through ? 'Height of the roof where the chimney comes out' : 'Height of the roof beside the chimney (optional)';
  $('#roofHeightHint').textContent = through
    ? 'The chimney\'s height is measured from this spot, so the planner needs to know how high it is.'
    : 'The chimney doesn\'t pass through the roof here. Give the roof height level with the chimney so it can clear the roof within 10 ft; leave it blank if no roof is that close.';
  const roofIn = roofHeightIn(state);
  const rc = $('#roofComputed');
  rc.classList.toggle('missing', roofIn == null);
  rc.innerHTML = roofIn == null
    ? ({ EAVE: 'Enter A and B to work out the roof height.', ATTIC: 'Enter the attic height (C) in section 3 to work out the roof height.' }[state.roof.method] ?? '')
    : `Roof height at the chimney: <b>${fmtFtIn(roofIn)}</b> above the stove's floor.`;
  $('#exampleNote').hidden = JSON.stringify(state) !== JSON.stringify(EXAMPLE_STATE);
}

/** Attic section: says where the measurement starts and what it adds up to. */
function renderAtticReadout() {
  if (!atticMethodApplies(state)) return;
  const a = state.attic;
  const fromJoists = a.from !== 'DRYWALL';
  $('#atticHint').textContent = `From the ${fromJoists ? 'top of a ceiling joist' : 'top of the drywall between two joists'} straight up to the underside of the roof boards (sheathing), not to the bottom of a rafter.`;
  const below = state.ceiling.above === 'STORY_ATTIC' ? 'second-floor ceiling height' : 'ceiling height';
  $('#atticCaption').textContent = fromJoists
    ? `Underside of the roof boards = ${below} + D + J + C.`
    : `Underside of the roof boards = ${below} + D + C.`;
  const under = deckUndersideIn(state);
  const top = topCeilingIn(state);
  const out = $('#atticComputed');
  out.classList.toggle('missing', under == null);
  if (under == null) { out.innerHTML = 'Enter C to work out the attic space.'; return; }
  const joistTop = top + (Number(a.drywallIn) || 0) + (Number(a.joistIn) || 0);
  out.innerHTML = `Underside of the roof boards: <b>${fmtFtIn(under)}</b> above the stove's floor.`
    + (fromJoists ? ` Open space above the joists: ${fmtFtIn(under - joistTop)}.` : '');
}

// ------------------------------------------------------------------ events
form.addEventListener('input', onEdit);
form.addEventListener('change', onEdit);
function onEdit(e) {
  const el = e.target;
  if (el.name) {
    setPath(state, el.name, readControl(el));
    if (el.name === 'appliance.only15') {
      snapOffsets();
      for (const box of form.querySelectorAll('[data-kind="offset"]')) renderList(box);
    }
    if (el.name.endsWith('.jog') && el.value === 'OFFSET') {   // make sure there's a row to fill in
      const listPath = el.name.replace(/jog$/, 'offsets');
      const list = getPath(state, listPath);
      if (!list.length) list.push(clone(NEW_ROW.offset));
      renderList(form.querySelector(`[data-list="${listPath}"]`));
      form.querySelector(`[data-list="${listPath}"] input`)?.focus();
    }
  }
  else if (el.dataset.path) {
    const row = getPath(state, el.dataset.path)[Number(el.dataset.i)];
    row[el.dataset.f] = el.type === 'number' || 'num' in el.dataset ? (el.value === '' ? null : Number(el.value)) : el.value;
    // a new elbow angle changes which shifts exist: keep the shift, or move to the next one up
    if (el.dataset.f === 'angle' && e.type === 'change') {
      snapOffsets();
      renderList(form.querySelector(`[data-list="${el.dataset.path}"]`));
      form.querySelector(`[id="${el.dataset.path}-${el.dataset.i}-angle"]`)?.focus();
    }
  }
  else return;
  update();
}
form.addEventListener('click', e => {
  const add = e.target.closest('[data-add]');
  const rm = e.target.closest('[data-remove]');
  if (!add && !rm) return;
  const path = (add || rm).dataset.add || rm.dataset.remove;
  const list = getPath(state, path);
  const box = form.querySelector(`[data-list="${path}"]`);
  if (add) list.push(clone(NEW_ROW[box.dataset.kind]));
  else list.splice(Number(rm.dataset.i), 1);
  renderList(box);
  update();
  if (add) box.querySelector('.row:last-child input')?.focus();
});
form.addEventListener('submit', e => e.preventDefault());
$('#reset').addEventListener('click', () => { state = clone(EXAMPLE_STATE); writeControls(); syncManualBox(true); update(); });
// Light by default; the choice is remembered on this device
const THEME_KEY = 'chimney-planner/theme';
function showTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const b = $('#themeToggle');
  b.textContent = dark ? 'Light mode' : 'Dark mode';
  b.setAttribute('aria-pressed', String(dark));
}
$('#themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  if (dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* not saved */ }
  showTheme();
});
showTheme();

// Clear the form: a second click within a few seconds confirms (no browser dialog)
let clearArmed = null;
$('#clearForm').addEventListener('click', e => {
  const btn = e.currentTarget;
  if (!clearArmed) {
    btn.textContent = 'Click again to clear everything';
    btn.classList.add('armed');
    clearArmed = setTimeout(() => { clearArmed = null; btn.textContent = 'Clear the form'; btn.classList.remove('armed'); }, 4000);
    return;
  }
  clearTimeout(clearArmed); clearArmed = null;
  btn.textContent = 'Clear the form'; btn.classList.remove('armed');
  state = blankState();
  writeControls();
  syncManualBox(true);
  update();
  window.scrollTo({ top: 0 });
  $('#appliance-outletFt')?.focus({ preventScroll: true });
});

/** The manual box is optional: show how many answers it holds, and open it on load when it has any. */
const MANUAL_KEYS = ['minHeightFt', 'maxHeightFt', 'maxOffsets', 'minRiseIn', 'minCeilingIn', 'only15', 'roofShield'];
function syncManualBox(setOpen = false) {
  const a = state.appliance;
  const filled = MANUAL_KEYS.filter(k => a[k] !== null && a[k] !== '' && a[k] !== false).length;
  $('#manualCount').textContent = filled ? `${filled} answer${filled > 1 ? 's' : ''} entered` : 'Not entered: Duravent\'s guideline is used';
  if (setOpen) $('#manualBox').open = filled > 0;
}

$('#copy').addEventListener('click', async () => {
  if (!lastResult?.parts.length) return;
  const text = ['Qty\tPart #\tStock #\tDescription',
    ...lastResult.parts.map(p => `${p.qty}\t${p.order_number}\t${p.stock_number ?? ''}\t${p.description}`)].join('\n');
  const btn = $('#copy');
  const box = $('#copyFallback');
  try {
    await navigator.clipboard.writeText(text);
    box.hidden = true;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy list'; }, 1600);
  } catch {
    box.value = text;
    box.hidden = false;
    box.focus();
    box.select();
    btn.textContent = 'Select and copy below';
  }
});

// ------------------------------------------------------------------ CSV download
const csvBtn = $('#csv');
let downloads = null;
if (window.claude?.use) {
  // published page: the viewer's downloads permission saves the file after a confirmation
  csvBtn.hidden = true;
  window.claude.use('downloads').then(d => { downloads = d; csvBtn.hidden = !d; }).catch(() => { csvBtn.hidden = true; });
}

function csvCell(v) {
  const t = String(v ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
function partsCsv(r, spec) {
  const head = ['Qty', 'Part number', 'Stock number', 'Description', 'Section', 'Optional', 'Not a Duravent part', 'Flag', 'Why'];
  const rows = r.parts.map(p => [
    p.qty, p.order_number, p.stock_number, p.description, ZONE_NAMES[p.zone] || p.zone || '',
    p.optional ? 'yes' : '', p.non_catalog ? 'yes' : '',
    (p.flags || []).map(f => `${f.level}: ${f.text}`).join(' | '), p.reasons.join(' '),
  ]);
  const label = spec.appliance.label ? ` for ${spec.appliance.label}` : '';
  const title = [`DuraTech ${spec.appliance.collarSizeIn}" chimney${label}`, `Chimney top ${fmtFtIn(r.geometry.chimneyTopIn)} above the floor`];
  // BOM so Excel reads ° and × correctly
  return '\ufeff' + [title.map(csvCell).join(','), '', head.join(','), ...rows.map(row => row.map(csvCell).join(','))].join('\r\n') + '\r\n';
}
csvBtn.addEventListener('click', async () => {
  if (!lastResult?.ok) return;
  const slug = (lastSpec.appliance.label || 'chimney').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const filename = `duratech-${lastSpec.appliance.collarSizeIn}in-${slug}-parts.csv`;
  const data = partsCsv(lastResult, lastSpec);
  if (downloads) {
    try {
      await downloads.save({ filename, data });
      csvBtn.textContent = 'Saved';
    } catch (e) {
      if (['unavailable', 'not_granted', 'capability_disabled', 'capability_removed'].includes(e?.code)) csvBtn.hidden = true;
      else if (e?.code !== 'declined') csvBtn.textContent = 'Try again';
    }
    setTimeout(() => { csvBtn.textContent = 'Download CSV'; }, 1800);
  } else if (!window.claude) {
    // the planner hosted as its own website: an ordinary download
    const url = URL.createObjectURL(new Blob([data], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
});

// ------------------------------------------------------------------ planning + rendering
function update() {
  saveState();
  applyVisibility();
  if (!catalog) return;
  const spec = toSpec(state);
  let result;
  try { result = planChimney(spec, catalog); }
  catch (err) { result = { ok: false, errors: [`The planner hit an unexpected problem: ${err.message}`], warnings: [], notes: [], checks: [], parts: [], geometry: {} }; }
  lastResult = result;
  lastSpec = spec;
  render(result, spec);
}

const ICON = {
  STOP: '<svg class="ic ic-stop" viewBox="0 0 20 20" aria-label="Stop"><path class="ic-shape" d="M6.2 1h7.6L19 6.2v7.6L13.8 19H6.2L1 13.8V6.2z"/><path class="ic-mark" d="M10 5.2v6M10 14.4v.4"/></svg>',
  CAUTION: '<svg class="ic ic-caution" viewBox="0 0 20 20" aria-label="Caution"><path class="ic-shape" d="M10 1.6 19.2 18H.8z"/><path class="ic-mark" d="M10 7.6v4.8M10 15v.4"/></svg>',
};

// ------------------------------------------------------------------ errors on the form
/** Where each planner field key lives on the form, for the current answers. */
function fieldTargets(key) {
  const route = state.appliance.kind === 'FIREPLACE' ? 'fireplace' : 'ceiling';
  const simple = {
    'appliance.outlet': '#appliance-outletFt', 'appliance.kind': '#kind-stove', 'appliance.collar': '#appliance-collar',
    'appliance.minHeight': '#appliance-minHeightFt', 'appliance.maxHeight': '#appliance-maxHeightFt',
    'appliance.maxOffsets': '#appliance-maxOffsets', 'appliance.only15': '#appliance-only15',
    'appliance.minRise': '#appliance-minRiseIn', 'appliance.minCeiling': '#appliance-minCeilingIn',
    'ceiling.height': '#ceiling-ft', 'ceiling.style': '#ceiling-flat', 'ceiling.pitch': '#ceiling-pitch',
    'ceiling.support': '#ceiling-support', 'ceiling.reduced': '#ceiling-reduced',
    'roof.pitch': '#roof-pitch', 'roof.surface': '#roof-surface', 'chase.top': '#chase-topFt',
    'wall.thickness': '#wall-thickness', 'wall.standoff': '#wall-standoff', 'wall.center': '#wall-centerFt',
    'wall.roomCeiling': '#wall-roomCeilingFt', 'fireplace.shield': '#fireplace-shield',
    'chimney.connector': '#chimney-connector', 'nearby': '[data-list="nearby"]',
    'attic.height': '#attic-ft', 'chase.above': '#chase-aboveIn',
  };
  let sel = simple[key];
  if (key === 'roof.height') sel = { EAVE: '#roof-eaveFt, #roof-fromEaveFt', ATTIC: '#attic-ft, #attic-deckIn', DIRECT: '#roof-ft' }[state.roof.method];
  if (key === 'floors') sel = route === 'fireplace' ? '[data-list="fireplace.floors"]' : '#ceiling-storyFt, #ceiling-above';
  if (key === 'offsets') sel = `[data-list="${route}.offsets"]`;
  const m = key.match(/^offset\.(\d+)$/);
  if (m) sel = `[id="${route}.offsets-${Number(m[1]) - 1}-in"]`;
  if (!sel) return [];
  const visible = el => { for (let e = el; e; e = e.parentElement) if (e.hidden) return false; return true; };
  return [...form.querySelectorAll(sel)].filter(visible);
}

function clearFieldErrors() {
  form.querySelectorAll('.field-error').forEach(e => e.remove());
  form.querySelectorAll('.has-error').forEach(e => e.classList.remove('has-error'));
  form.querySelectorAll('.section-error').forEach(e => e.classList.remove('section-error'));
}

/** Outline each field an error concerns, put the message under it, and mark its section. Returns targets per error. */
function markFieldErrors(errorFields) {
  clearFieldErrors();
  return errorFields.map(({ text, fields }) => {
    const targets = fields.flatMap(fieldTargets);
    for (const t of targets) { const box = t.closest('details'); if (box) box.open = true; }
    const anchors = new Set();
    for (const el of targets) {
      const anchor = el.closest('.row') || el.closest('.field') || el.closest('.check') || el.closest('.seg') || el;
      if (anchors.has(anchor)) continue;
      anchors.add(anchor);
      anchor.classList.add('has-error');
      el.closest('fieldset.section')?.classList.add('section-error');
      const msg = document.createElement('p');
      msg.className = 'field-error';
      msg.innerHTML = `${ICON.STOP}<span>${esc(text)}</span>`;
      if (anchor.classList.contains('field')) anchor.append(msg); else anchor.after(msg);
    }
    return targets;
  });
}

function showField(targets) {
  const el = targets[0];
  if (!el) return;
  const box = el.closest('details');
  if (box) box.open = true;
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  (el.matches('input, select') ? el : el.querySelector('input, select'))?.focus({ preventScroll: true });
}

const ZONE_NAMES = { appliance: 'At the appliance', wall: 'Through the wall', ceiling: 'At the ceiling', support: 'Supports',
  pipe: 'Chimney pipe', offset: 'Offsets', attic: 'Attic', roof: 'Roof', chase: 'Chase', termination: 'Top of the chimney', hardware: 'Hardware' };

function render(r, spec) {
  renderOffsetCalcs(r);
  const status = $('#status');
  const manualWarn = r.ok && r.manualHeightApplied === false ? r.warnings[0] : null;
  const otherWarnings = manualWarn ? r.warnings.slice(1) : r.warnings;
  const blockers = r.blockers || [];
  const located = markFieldErrors(r.errorFields || []);
  if (!r.ok) {
    const byText = new Map((r.errorFields || []).map((e, i) => [e.text, located[i]]));
    status.innerHTML = `<div class="banner crit"><p class="bhead">${ICON.STOP}<strong>No parts list yet.</strong> Fix ${r.errors.length > 1 ? 'these' : 'this'} first:</p>
      <ul>${r.errors.map((e, i) => `<li>${esc(e)}${byText.get(e)?.length ? ` <button type="button" class="goto" data-goto="${i}">Show me</button>` : ''}</li>`).join('')}</ul></div>`;
    status.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => showField(byText.get(r.errors[Number(b.dataset.goto)]))));
  } else if (blockers.length) {
    status.innerHTML = `<div class="banner crit"><p class="bhead">${ICON.STOP}<strong>Check before you buy.</strong> ${blockers.length > 1 ? `${blockers.length} problems` : 'One problem'} could stop this installation as planned:</p>
      <ul>${blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>` +
      (manualWarn ? `<div class="banner warn" style="margin-top:8px"><p class="bhead">${ICON.CAUTION}<strong>Your appliance manual's height isn't applied yet.</strong></p></div>` : '');
  } else if (manualWarn) {
    status.innerHTML = `<div class="banner warn"><p class="bhead">${ICON.CAUTION}<strong>Your appliance manual's height isn't applied yet.</strong> ${esc(manualWarn.replace(/^The .*? manual's minimum chimney height was not entered, so its own requirements are not applied\. /, ''))} <button type="button" class="goto" data-open-manual>Enter it</button></p></div>`;
    status.querySelector('[data-open-manual]')?.addEventListener('click', () => showField([$('#appliance-minHeightFt')]));
  } else {
    status.innerHTML = `<div class="banner ok"><p><strong>Plan complete.</strong> Uses the stricter of Duravent's rules, the 3-2-10 roof rule and your manual's limits.</p></div>`;
  }

  // layout prompt next to the manual height field
  $('#layoutText').textContent = r.layout ? `${r.layout.summary}.` : 'Complete the installation details to see it.';

  $('#summary').hidden = !r.ok;
  $('#partsArea').hidden = !r.ok;
  if (r.ok) {
    const g = r.geometry;
    const exitName = g.exit === 'chase top' ? 'Above the chase' : g.exit ? 'Above the roof' : 'Above the wall top';
    const aboveIn = g.aboveExitIn ?? (spec.route.type === 'WALL' && spec.route.wallTopElevationIn != null
      ? g.chimneyTopIn - spec.route.wallTopElevationIn : null);
    const figs = [
      ['Chimney top', fmtFtIn(g.chimneyTopIn)],
      [exitName, aboveIn != null ? fmtFtIn(aboveIn) : '–'],
      ['Chimney length', fmtFtIn(g.chimneyLengthIn)],
      ['Collar to top', fmtFtIn(g.systemHeightIn)],
    ];
    $('#figures').innerHTML = figs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    $('#governing').innerHTML = `Height set by <b>${esc(g.governingRule)}</b>: at least ${fmtFtIn(g.requiredTopIn, true)} above the floor.`;
    const offs = g.offsets || [];
    $('#offsetInfo').hidden = !offs.length;
    $('#offsetInfo').innerHTML = offs.map(o => `<li><b>Offset ${o.n}</b> · ${o.angleDeg}° elbows · ${fmtIn(o.offsetIn)} sideways` +
      ` · uses ${fmtFtIn(o.riseIn)} of height${o.availableRiseIn ? ` of ${fmtFtIn(o.availableRiseIn)} available` : ''}` +
      `${o.chosen === 'FORCED' ? ' · angle chosen by you' : ''}</li>`).join('');
    renderParts(r.parts);
    $('#diagram').innerHTML = diagram(r, spec);
  }

  $('#warnBlock').hidden = !(r.ok && otherWarnings.length);
  $('#warnings').innerHTML = otherWarnings.map(w => `<li>${ICON.CAUTION}<span>${esc(w)}</span></li>`).join('');
  $('#noteBlock').hidden = !(r.ok && r.notes.length);
  $('#notes').innerHTML = r.notes.map(n => `<li>${esc(n)}</li>`).join('');
  $('#checkBlock').hidden = !r.checks.length;
  $('#checks').innerHTML = r.checks.map(c => `<li><span class="tag ${c.status}">${c.status}</span><span>${esc(c.detail)}</span></li>`).join('');
}

function renderParts(parts) {
  const count = parts.reduce((t, p) => t + p.qty, 0);
  $('#partsCount').textContent = `${count} pieces, ${parts.length} part numbers`;
  let zone = null;
  const rows = [];
  for (const p of parts) {
    if (p.zone !== zone) { zone = p.zone; rows.push(`<tr class="zone"><td colspan="3">${esc(ZONE_NAMES[zone] || zone)}</td></tr>`); }
    rows.push(`<tr${(p.flags || []).some(f => f.level === 'STOP') ? ' class="row-stop"' : ''}>
      <td class="qty">${p.qty}</td>
      <td class="pn">${esc(p.order_number)}${p.stock_number ? `<small>${esc(p.stock_number)}</small>` : ''}</td>
      <td>${(p.flags || []).map(f => ICON[f.level]).join('')}${esc(p.description)}${p.optional ? '<span class="chip">optional</span>' : ''}${p.non_catalog ? '<span class="chip">not a Duravent part</span>' : ''}
        <span class="why">${esc(p.reasons.join(' '))}</span>
        ${(p.flags || []).map(f => `<span class="flag ${f.level.toLowerCase()}">${esc(f.text)}</span>`).join('')}</td></tr>`);
  }
  $('#parts').innerHTML = `<thead><tr><th>Qty</th><th>Part</th><th>Description</th></tr></thead><tbody>${rows.join('')}</tbody>`;
  $('#copyFallback').hidden = true;
}

/**
 * Side view, to scale (horizontal and vertical): floor, appliance, levels, chimney with any
 * offsets, cap, and the required top. Offsets sit where the planner placed them: at the bottom of
 * the open space it assigned (e.g. just above the support box in the attic).
 */
function diagram(r, spec) {
  const g = r.geometry;
  const H = 360, padT = 14, padB = 18;
  const outlet = spec.appliance.outletElevationIn;
  const capH = 7;
  const topIn = Math.max(g.chimneyTopIn + capH, g.requiredTopIn) + 12;
  const pxPerIn = (H - padT - padB) / topIn;
  const y = inches => padT + (H - padT - padB) * (1 - inches / topIn);
  const offs = g.offsets || [];
  const shiftPx = offs.reduce((t, o) => t + o.offsetIn * pxPerIn, 0);
  const W = 170 + Math.ceil(shiftPx);
  const cx = 104, pw = 12;
  const parts = [];

  // axis ticks every 5 ft
  for (let f = 0; f * 12 <= topIn; f += 5) {
    parts.push(`<line class="axis" x1="22" x2="26" y1="${y(f * 12)}" y2="${y(f * 12)}"/><text x="19" y="${y(f * 12) + 3}" text-anchor="end">${f}'</text>`);
  }
  parts.push(`<line class="axis" x1="26" x2="26" y1="${y(0)}" y2="${y(topIn)}"/>`);

  // levels the chimney passes
  const levels = [];
  const rt = spec.route;
  if (rt.type === 'CEILING') {
    levels.push({ at: rt.ceiling.elevationIn, label: 'Ceiling' });
    (rt.floorPenetrationsIn || []).forEach((e, i) => levels.push({ at: e, label: rt.floorLabels?.[i] || 'Floor' }));
  }
  if (rt.type === 'FIREPLACE') (rt.floorPenetrationsIn || []).forEach(e => levels.push({ at: e, label: 'Floor' }));
  if (rt.exit?.type === 'CHASE' && rt.exit.chaseTopElevationIn != null) levels.push({ at: rt.exit.chaseTopElevationIn, label: 'Chase top', roof: true });
  if (spec.roof.penetrationElevationIn != null) levels.push({ at: spec.roof.penetrationElevationIn, label: 'Roof', roof: true });
  else if (spec.roof.elevationAtChimneyIn != null) levels.push({ at: spec.roof.elevationAtChimneyIn, label: 'Roof', roof: true });
  if (rt.type === 'WALL' && rt.wallTopElevationIn != null) levels.push({ at: rt.wallTopElevationIn, label: 'Wall top' });
  let lastLabelY = Infinity;
  for (const l of levels.sort((a, b) => a.at - b.at)) {
    const yy = y(l.at);
    parts.push(`<line class="${l.roof ? 'lvl-roof' : 'lvl'}" x1="28" x2="${W - 4}" y1="${yy}" y2="${yy}"/>`);
    const ly = Math.min(yy - 3, lastLabelY - 11);
    parts.push(`<text x="30" y="${ly}">${l.label}</text>`);
    lastLabelY = ly;
  }

  // wall for the wall route
  if (rt.type === 'WALL') {
    const wx = cx - pw / 2 - (rt.standoffIn ?? 2) * 0.6 - 6;
    parts.push(`<rect class="wall" x="${wx}" y="${y(rt.wallTopElevationIn)}" width="6" height="${y(0) - y(rt.wallTopElevationIn)}"/>`);
  }

  // appliance + connector
  const ax = rt.type === 'WALL' ? 34 : cx - 22;
  parts.push(`<rect class="unit" x="${ax}" y="${y(outlet)}" width="44" height="${y(0) - y(outlet)}" rx="2"/>`);
  const ox = ax + 22;
  if (rt.type === 'WALL') {
    const ty = y(rt.thimbleCenterElevationIn);
    parts.push(`<polyline class="conn" points="${ox},${y(outlet)} ${ox},${ty} ${cx},${ty}"/>`);
  } else if (g.startElevationIn > outlet + 1) {
    parts.push(`<line class="conn" x1="${ox}" x2="${ox}" y1="${y(outlet)}" y2="${y(g.startElevationIn)}"/>`);
  }

  // chimney centerline: each offset is drawn where the planner placed it (offset.atIn)
  let x = cx;
  const pts = [[x, g.startElevationIn]];
  const tags = [];
  let at = g.startElevationIn;
  for (const o of offs) {
    at = Math.max(at, o.atIn ?? at);
    pts.push([x, at]);
    const x2 = x + o.offsetIn * pxPerIn;
    pts.push([x2, at + o.riseIn]);
    tags.push({ x: x2, at: at + o.riseIn / 2, text: `${o.angleDeg}° · ${fmtIn(o.offsetIn)}` });
    x = x2;
    at += o.riseIn;
  }
  pts.push([x, g.chimneyTopIn]);
  const line = pts.map(([px, e]) => `${px.toFixed(1)},${y(e).toFixed(1)}`).join(' ');
  parts.push(`<polyline class="pipe-edge" points="${line}" stroke-width="${pw + 2}"/>`);
  parts.push(`<polyline class="pipe-core" points="${line}" stroke-width="${pw}"/>`);
  for (const t of tags) parts.push(`<text class="jog-t" x="${(t.x + pw / 2 + 4).toFixed(1)}" y="${(y(t.at) + 3).toFixed(1)}">${t.text}</text>`);
  parts.push(`<rect class="cap" x="${x - pw / 2 - 4}" y="${y(g.chimneyTopIn + capH)}" width="${pw + 8}" height="${y(g.chimneyTopIn) - y(g.chimneyTopIn + capH)}" rx="1"/>`);

  // required top
  const ry = y(g.requiredTopIn);
  parts.push(`<line class="req" x1="28" x2="${W - 4}" y1="${ry}" y2="${ry}"/>`);
  parts.push(`<text class="req-t" x="${W - 4}" y="${Math.max(ry - 4, 10)}" text-anchor="end">min ${fmtFtIn(g.requiredTopIn, true)}</text>`);
  parts.push(`<line class="axis" x1="26" x2="${W - 4}" y1="${y(0)}" y2="${y(0)}"/>`);

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Side view of the chimney${offs.length ? ` with ${offs.length} offset${offs.length > 1 ? 's' : ''}` : ''}, to scale">${parts.join('')}</svg>`;
}

/** 11 -> 11", 12.25 -> 12¼" */
function fmtIn(v) {
  const q = Math.round(v * 4) / 4;
  const w = Math.floor(q);
  return `${w}${{ 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[q - w]}"`;
}

// ------------------------------------------------------------------ boot
fillPitchOptions();
writeControls();
syncManualBox(true);
applyVisibility();
loadCatalog('catalog', 'DT')
  .then(c => {
    catalog = c;
    snapOffsets();
    for (const box of form.querySelectorAll('[data-kind="offset"]')) renderList(box);
    update();
  })
  .catch(err => {
    $('#status').innerHTML = `<div class="banner crit"><p><strong>The parts catalog didn't load.</strong> ${esc(err.message)}. Reload the page to try again.</p></div>`;
  });
