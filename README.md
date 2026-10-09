# DuraTech Chimney Planner

Enter details about a home and a wood stove or factory-built fireplace, and get a complete Duravent
DuraTech (5"–8") chimney parts list that follows Duravent's instructions and NFPA 211.

Everything runs in the browser: plain HTML and JavaScript plus the catalog as JSON. No server or database.

## Folders

| Folder | What it holds |
|---|---|
| `catalog/` | The editable source: Duravent catalog data and rules as CSV files. See `catalog/README.md`. |
| `tools/build_catalog.py` | Checks the CSVs and builds `web/catalog/*.json`. Python 3, standard library only. |
| `web/` | The website itself. This folder is what gets hosted. |
| `tests/` | Automated tests for the planner and the form. |

## Common tasks

```sh
npm run build:catalog   # after editing any CSV in catalog/
npm test                # run the tests (Node 20+)
cd web && python3 -m http.server 8000   # try it at http://localhost:8000
```

Opening `web/index.html` by double-clicking won't work: the browser blocks it from loading its own files from disk.

## Hosting

The `web/` folder is a static site and works on any static host (GitHub Pages, Netlify, Cloudflare Pages).

**GitHub Pages:** in this repository go to **Settings → Pages → Build and deployment** and set **Source** to
**GitHub Actions**. Every push to `main` then rebuilds the catalog, runs the tests, and publishes `web/`.
Pages on a private repository needs a paid GitHub plan; on a free plan, make the repository public or use Netlify.

**Google Sites:** host the site first, then in Google Sites use **Insert → Embed → By URL** with the site's address.
