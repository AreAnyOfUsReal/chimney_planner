/** Catalog access for the engine. Works in the browser (fetch) and in Node tests (plain objects). */

export function makeCatalog(index, lineData) {
  const rules = new Map();
  for (const r of [...(index.rules || []), ...(lineData.rules || [])]) rules.set(r.key, r);
  const byCategory = new Map();
  for (const p of lineData.parts) {
    if (p.active === false) continue;
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category).push(p);
  }
  return {
    line: lineData.line,
    sizes: lineData.sizes,
    lookups: lineData.lookups || {},
    categories: new Map((index.categories || []).map(c => [c.code, c])),
    /** Rule row by key; throws so a missing rule is a loud bug, never a silent default. */
    rule(key) {
      const r = rules.get(key);
      if (!r) throw new Error(`Catalog is missing rule '${key}'`);
      return r;
    },
    /** Active parts in a category, optionally only those that fit a size. */
    parts(category, size) {
      const list = byCategory.get(category) || [];
      return size == null ? list : list.filter(p => p.sizes.includes(String(size)));
    },
  };
}

export const attr = (part, key) => part.attributes?.[key];

export async function loadCatalog(base = 'catalog', lineCode = 'DT') {
  const index = await (await fetch(`${base}/index.json`)).json();
  const file = index.line_files?.[lineCode];
  if (!file) throw new Error(`Product line '${lineCode}' is not in the catalog build`);
  const line = await (await fetch(`${base}/${file}`)).json();
  return makeCatalog(index, line);
}
