// @ts-nocheck
require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');

const app = express();
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const PORT = process.env.PORT || 3000;

/* -------------------------------------------------------
 * Utility: robust Notion DB query that works across SDKs
 * ----------------------------------------------------- */
async function queryDatabaseSafe(notionClient, params) {
  const { database_id, ...rest } = params;
  const dbId = (database_id || '').trim();

  // 1) Prefer official helper if available
  if (notionClient.databases && typeof notionClient.databases.query === 'function') {
    return notionClient.databases.query({ database_id: dbId, ...rest });
  }

  // 2) Try request() without leading slash
  try {
    return await notionClient.request({
      path: `databases/${dbId}/query`,
      method: 'POST',
      body: rest
    });
  } catch (e) {
    if (e && e.code === 'invalid_request_url') {
      // 3) Try request() with /v1/ prefix
      try {
        return await notionClient.request({
          path: `/v1/databases/${dbId}/query`,
          method: 'POST',
          body: rest
        });
      } catch (e2) {
        if (e2 && e2.code === 'invalid_request_url') {
          // 4) Final fallback: direct fetch (Node 18+ has global fetch)
          const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
              'Notion-Version': '2022-06-28',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(rest)
          });
          const json = await r.json();
          if (!r.ok) {
            const err = new Error(json.message || 'Notion HTTP error');
            err.status = r.status;
            err.code = json.code;
            err.body = json;
            throw err;
          }
          return json;
        }
        throw e2;
      }
    }
    throw e;
  }
}

/* ----------------------------
 * Property extraction helpers
 * -------------------------- */
function extractHtml(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'rich_text':
      return prop.rich_text.map(rt => rt.plain_text).join('');
    case 'title':
      return prop.title.map(rt => rt.plain_text).join('');
    case 'formula':
      return prop.formula?.string || '';
    case 'plain_text':
      return prop.plain_text || '';
    default:
      return '';
  }
}

function extractText(prop) {
  if (!prop) return '';
  if (prop.type === 'title' && prop.title.length) return prop.title.map(t => t.plain_text).join('');
  if (prop.type === 'rich_text' && prop.rich_text.length) return prop.rich_text.map(t => t.plain_text).join('');
  if (prop.type === 'formula') {
    if (prop.formula.type === 'string' && prop.formula.string !== null) return prop.formula.string;
    if (prop.formula.type === 'number' && prop.formula.number !== null) return String(prop.formula.number);
  }
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'multi_select') return (prop.multi_select || []).map(o => o.name).join(', ');
  if (prop.type === 'status') return prop.status?.name || '';
  if (prop.type === 'number' && prop.number !== null) return String(prop.number);
  return '';
}

function sanitizeHtml(html) {
  if (!html) return '';
  return html
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '');
}

function extractPageIdFromUrl(url) {
  if (!url) return null;
  const patterns = [
    /notion\.so\/[^\/]+\/([a-f0-9-]{32,36})/i,
    /notion\.so\/([a-f0-9-]{32,36})/i,
    /notion\.site\/[^\/]+\/([a-f0-9-]{32,36})/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/* --------------------------------
 * Pick tile/modal HTML off a page
 * ------------------------------ */
function getTileHtmlFromPage(page) {
  const candidates = [
    'Tile_Content',
    'Tile HTML',
    'TileContent',
    'Tile Content',
    'Tile Content 2',
    'Tile_Content_',
    'tileAutoHTML',
    'Tile',
    'HTML'
  ];
  for (const key of candidates) {
    if (page.properties[key]) {
      return sanitizeHtml(extractHtml(page.properties[key]));
    }
  }
  return '';
}

function getModalHtmlFromPage(page) {
  const candidates = [
    'Modal HTML',
    'Modal Live',
    'ModalContent',
    'Modal_Content',
    'Modal Content',
    'Modal'
  ];
  for (const key of candidates) {
    if (page.properties[key]) {
      return sanitizeHtml(extractHtml(page.properties[key]));
    }
  }
  return '';
}

/* -----------------
 * Express routes
 * --------------- */
app.get('/', (_req, res) => {
  res.send('tkAuto Embed App - Use /embed, /modal, or /playbook-rolodex.json');
});

/* -----------------------------------------------------
 * /playbook-rolodex.json
 * Returns a JSON feed for the PlaybookRolodex review tool.
 * For each Playbook tactic, follows the tk2Templates relation
 * and emits { tactic: {vars}, template: { name, fullHtml } }.
 * Framer code component fetches this and renders 3 intensities
 * side by side using {Variable} placeholder substitution.
 * --------------------------------------------------- */
const PLAYBOOK_DB_ID = '31853105e685819690a0e1478f019ed5';
const TEMPLATES_DB_ID = '31153105e68580e6abe6d7967e495886';
// Page ID of "tempA new variant" — used as the fallback template when a
// Playbook row has no tk2Templates relation set yet.
const DEFAULT_TEMPLATE_PAGE_ID = '35353105e68581c6b1d9d8ea5f0426a9';

function extractRelationIds(prop) {
  if (!prop || prop.type !== 'relation') return [];
  return (prop.relation || []).map(r => r.id);
}

function extractSelect(prop) {
  if (!prop) return '';
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'multi_select') return (prop.multi_select || []).map(o => o.name).join(', ');
  return '';
}

function extractNumber(prop) {
  if (!prop) return null;
  if (prop.type === 'number') return prop.number;
  if (prop.type === 'formula' && prop.formula.type === 'number') return prop.formula.number;
  return null;
}

function extractFile(prop) {
  if (!prop || prop.type !== 'files') return '';
  const f = (prop.files || [])[0];
  if (!f) return '';
  return f.external?.url || f.file?.url || '';
}

async function fetchAllPages(dbId) {
  const all = [];
  let cursor = undefined;
  do {
    const res = await queryDatabaseSafe(notion, {
      database_id: dbId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    });
    all.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return all;
}

function normalizePageId(id) {
  return (id || '').replace(/-/g, '');
}

// Map loose Template Set hints to the actual Notion template name. Used
// when a tactic row uses a shorthand (e.g. "two-stat") that doesn't match
// any template literally even after normalization. Add entries here when
// new shorthands appear.
const TEMPLATE_NAME_ALIASES = {
  'two-stat': 'tempE Revised',
};

// Normalize a template name string so loose hints in tactic.Template Set
// (e.g. "tempC-image", "test-balance-text") can match Notion template
// names (e.g. "tempC (image)", "test balance text") that use different
// punctuation conventions. Lowercase, strip parens, collapse hyphens
// and underscores to single spaces, trim.
function normalizeTemplateName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

app.get('/playbook-rolodex.json', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  // Edge cache for 10 min, stale-while-revalidate for 1 hour so users always
  // get a fast response while the next request silently refreshes the cache.
  res.set('Cache-Control', 'public, s-maxage=600, max-age=60, stale-while-revalidate=3600');
  try {
    if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN missing');

    const [tactics, templates] = await Promise.all([
      fetchAllPages(PLAYBOOK_DB_ID),
      fetchAllPages(TEMPLATES_DB_ID)
    ]);

    const templatesById = {};
    const templatesByNormName = {};
    for (const t of templates) {
      const fullHtml = extractText(t.properties['Full HTML']);
      const name = extractText(t.properties['Name']);
      const obj = { id: t.id, name, fullHtml };
      templatesById[normalizePageId(t.id)] = obj;
      const norm = normalizeTemplateName(name);
      if (norm) templatesByNormName[norm] = obj;
    }

    // Filter out tactic parent rows (one per tactic, e.g., "Same Day Trips",
    // "City Cap Guidance"). Those have a tactic_number but no Variant and no
    // Touchpoint - they're grouping pages, not variant cells. The rolodex
    // is a variant viewer, so parents have no place here.
    const variantCells = tactics.filter(p => {
      const props = p.properties;
      const variant = extractSelect(props['Variant']);
      const touchpoint = extractSelect(props['Touchpoint']);
      return Boolean(variant || touchpoint);
    });

    const items = variantCells.map(p => {
      const props = p.properties;
      const templateRelIds = extractRelationIds(props['tk2Templates']);
      let tpl = templateRelIds
        .map(rid => templatesById[normalizePageId(rid)])
        .find(Boolean) || null;
      if (!tpl) {
        const tsRaw = extractText(props['Template Set']);
        const ts = TEMPLATE_NAME_ALIASES[tsRaw] || tsRaw;
        const norm = normalizeTemplateName(ts);
        if (norm) tpl = templatesByNormName[norm] || null;
      }

      return {
        id: p.id,
        url: p.url,
        created_time: p.created_time,
        last_edited_time: p.last_edited_time,
        tactic: {
          name: extractText(props['Name']),
          variant: extractSelect(props['Variant']),
          touchpoint: extractSelect(props['Touchpoint']),
          tactic_number: extractText(props['Tactic #']) || extractNumber(props['Tactic #']),
          score_target: extractNumber(props['Score Target']) ?? extractText(props['Score Target']),
          template_set: extractText(props['Template Set']),
          directive: extractText(props['Directive']),
          detail1: extractText(props['Detail 1']),
          detail2: extractText(props['Detail 2']),
          detail3: extractText(props['Detail 3']),
          stat1: extractText(props['Stat 1 (Personal)']),
          stat2: extractText(props['Stat 2 (Peer/Company)']),
          stat3: extractText(props['Stat 3 (Other)']),
          cta: extractSelect(props['CTA']) || extractText(props['CTA']),
          tag: extractSelect(props['Tag']) || extractText(props['Tag']),
          image: extractText(props['Image (Path)']) || extractFile(props['Image (Path)'])
        },
        template: tpl ? { name: tpl.name, fullHtml: tpl.fullHtml } : null
      };
    });

    const defaultTpl = templatesById[normalizePageId(DEFAULT_TEMPLATE_PAGE_ID)] || null;
    // Expose the full template universe so consumers can see every template
    // available in Notion's tk2Templates DB, including the Email-type ones
    // not currently referenced by any tactic cell.
    const allTemplates = Object.values(templatesById)
      .filter(t => t.name)
      .map(t => ({ id: t.id, name: t.name, fullHtml: t.fullHtml }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      generated_at: new Date().toISOString(),
      count: items.length,
      defaultTemplate: defaultTpl ? { name: defaultTpl.name, fullHtml: defaultTpl.fullHtml } : null,
      templates: allTemplates,
      items
    });
  } catch (e) {
    console.error('Error in /playbook-rolodex.json:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * /embed
 * - If ?tkid= is provided, look up by TK id (or TK id Temp).
 * - Otherwise, fall back to the most recently edited page in the DB.
 */
app.get('/embed', async (req, res) => {
  let liveTile = '';
  let errorMsg = '';
  let client = 'Client';

  const referrer = req.get('Referrer') || req.get('Referer');
  const pageIdFromReferrer = extractPageIdFromUrl(referrer);
  const tkid = req.query.tkid;

  console.log('Embed request:', {
    referrer,
    pageIdFromReferrer,
    tkid: tkid || null,
    databaseIdExists: !!process.env.DATABASE_ID
  });

  try {
    if (!process.env.NOTION_TOKEN || !process.env.DATABASE_ID) {
      throw new Error(
        'Missing environment variables: ' +
        (!process.env.NOTION_TOKEN ? 'NOTION_TOKEN ' : '') +
        (!process.env.DATABASE_ID ? 'DATABASE_ID ' : '')
      );
    }

    let page = null;

    if (tkid) {
      // 1) Exact TK id match (rich_text)
      let r = await queryDatabaseSafe(notion, {
        database_id: process.env.DATABASE_ID,
        filter: {
          property: 'TK id',
          rich_text: { equals: tkid }
        },
        page_size: 1
      });
      if (r.results?.length) {
        page = r.results[0];
        console.log('Found page by TK id:', tkid);
      } else {
        // 2) Fallback to TK id Temp (formula.string)
        r = await queryDatabaseSafe(notion, {
          database_id: process.env.DATABASE_ID,
          filter: {
            property: 'TK id Temp',
            formula: { string: { equals: tkid } }
          },
          page_size: 1
        });
        if (r.results?.length) {
          page = r.results[0];
          console.log('Found page by TK id Temp:', tkid);
        } else {
          console.log('No page found for tkid:', tkid);
        }
      }
    }

    if (!page) {
      // 3) No tkid or not found → use the most recently edited page
      const db = await queryDatabaseSafe(notion, {
        database_id: process.env.DATABASE_ID,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
        page_size: 1
      });
      page = db.results?.[0] || null;
      console.log('Fallback to latest page:', page ? page.id : 'none');
    }

    if (page && page.properties) {
      const tkIdValue =
        extractText(page.properties['TK id']) ||
        extractText(page.properties['TK id Temp']) ||
        '';

      if (tkIdValue.includes('.')) {
        client = tkIdValue.split('.')[0];
      }

      liveTile = getTileHtmlFromPage(page);

      if (!liveTile) {
        errorMsg = 'Page found but no tile content. Available properties: ' + Object.keys(page.properties).join(', ');
        console.log(errorMsg);
      }
    } else {
      errorMsg = 'No page found in database';
      console.log(errorMsg);
    }
  } catch (e) {
    console.error('Error in /embed:', e);
    errorMsg = '<div style="color:#e03e3e; font-size:14px; padding:8px;">Error: ' + e.message + '</div>';
  }

  if (errorMsg) liveTile = errorMsg;
  if (!liveTile) liveTile = '<div style="color:#999; font-size:14px; padding:8px;">No tile content found</div>';

  res.send(generateEmbed(liveTile, client, false));
});

/**
 * /modal
 * - Mirrors /embed logic but returns Modal HTML fields.
 */
app.get('/modal', async (req, res) => {
  let liveModal = '';
  let errorMsg = '';
  let client = 'Client';

  const referrer = req.get('Referrer') || req.get('Referer');
  const pageIdFromReferrer = extractPageIdFromUrl(referrer);
  const tkid = req.query.tkid;

  console.log('Modal request:', {
    referrer,
    pageIdFromReferrer,
    tkid: tkid || null,
    databaseIdExists: !!process.env.DATABASE_ID
  });

  try {
    if (!process.env.NOTION_TOKEN || !process.env.DATABASE_ID) {
      throw new Error(
        'Missing environment variables: ' +
        (!process.env.NOTION_TOKEN ? 'NOTION_TOKEN ' : '') +
        (!process.env.DATABASE_ID ? 'DATABASE_ID ' : '')
      );
    }

    let page = null;

    if (tkid) {
      // 1) Exact TK id match (rich_text)
      let r = await queryDatabaseSafe(notion, {
        database_id: process.env.DATABASE_ID,
        filter: {
          property: 'TK id',
          rich_text: { equals: tkid }
        },
        page_size: 1
      });
      if (r.results?.length) {
        page = r.results[0];
        console.log('Found modal page by TK id:', tkid);
      } else {
        // 2) TK id Temp (formula.string)
        r = await queryDatabaseSafe(notion, {
          database_id: process.env.DATABASE_ID,
          filter: {
            property: 'TK id Temp',
            formula: { string: { equals: tkid } }
          },
          page_size: 1
        });
        if (r.results?.length) {
          page = r.results[0];
          console.log('Found modal page by TK id Temp:', tkid);
        } else {
          console.log('No modal page found for tkid:', tkid);
        }
      }
    }

    if (!page) {
      // 3) Fallback to latest page
      const db = await queryDatabaseSafe(notion, {
        database_id: process.env.DATABASE_ID,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
        page_size: 1
      });
      page = db.results?.[0] || null;
      console.log('Modal fallback to latest page:', page ? page.id : 'none');
    }

    if (page && page.properties) {
      const tkIdValue =
        extractText(page.properties['TK id']) ||
        extractText(page.properties['TK id Temp']) ||
        '';

      if (tkIdValue.includes('.')) {
        client = tkIdValue.split('.')[0];
      }

      liveModal = getModalHtmlFromPage(page);

      if (!liveModal) {
        errorMsg = 'Page found but no modal content. Available properties: ' + Object.keys(page.properties).join(', ');
        console.log(errorMsg);
      }
    } else {
      errorMsg = 'No page found in database';
      console.log(errorMsg);
    }
  } catch (e) {
    console.error('Error in /modal:', e);
    errorMsg = '<div style="color:#e03e3e; font-size:14px; padding:8px;">Error: ' + e.message + '</div>';
  }

  if (errorMsg) liveModal = errorMsg;
  if (!liveModal) liveModal = '<div style="color:#999; font-size:14px; padding:8px;">No modal content found</div>';

  res.send(generateEmbed(liveModal, client, true));
});

/* ---------------------------
 * HTML shell for the embed UI
 * - supports zoom via query OR hash:
 *   ?zoom=1.8, ?zoom=fit4col, ?z=1.6, #zoom=3, #z=fit5col
 * - explicit zoom disables auto-bump; no zoom -> auto-bump (for tight iframes)
 * - optional debug=1 to show computed scale badge
 * - DEBUG BADGE CLICK CYCLE:
 *   Normal → fit1col → fit2col → fit3col → 0.8 → 0.9 → 1 → 1.25 → 1.5 → Normal
 * ------------------------- */
function generateEmbed(liveTile, client, isModal = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>tkAuto Embed</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://info.tripkicks.com/hubfs/system/mockup/tk-css.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif;
      background: #fff;
      color: #37352f;
      line-height: 1.5;
      overflow-x: hidden;
      height: auto;
      min-height: 100%;
    }
    .embed-container {
      width: 100%;
      min-height: 400px;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      padding-bottom: 0;
      background: transparent;
    }
    .embed-container.modal-container {
      min-height: 1800px;
      height: 1800px;
      padding-bottom: 1000px;
    }
    .tile-section {
      width: 100%;
      box-sizing: border-box;
      margin-bottom: 0;
      overflow: visible;
      position: relative;
      min-height: 200px;
      /* CHANGED: bottom border only, no radius */
      border: 0;
      border-bottom: 1px solid #e9e9e7;
      border-radius: 0;
      background: #fff;
    }
    .modal-container .tile-section {
      min-height: 1600px;
      height: 1600px;
    }
    .tile-wrapper {
      width: 100%;
      margin: 0;
      /* CHANGED: remove padding */
      padding: 0;
      box-sizing: border-box;
      overflow: visible;
      position: relative;
    }
    .tile-block {
      transform-origin: top left;
      box-sizing: border-box;
      transition: transform 0.3s ease;
      transform: scale(1);
      width: 100%;
    }
    .tile-block > * {
      width: 100% !important;
      box-sizing: border-box !important;
    }
    @container (max-width: 400px) {
      .tile-block { transform: scale(1) !important; width: 100% !important; }
    }
    .divider { height: 1px; background: #e9e9e7; margin: 0 16px 20px 16px; width: calc(100% - 32px); }
    .controls {
      display: flex; gap: 8px; margin-top: 0; padding: 2px 2px; border-top: 1px solid #e9e9e7; flex-wrap: wrap;
    }
    .property-label {
      position: absolute; bottom: 4px; right: 8px; font-family: 'Monaco','Menlo','Ubuntu Mono',monospace;
      font-size: 10px; color: #ccc; background: rgba(255,255,255,0.8); padding: 2px 4px; border-radius: 2px; pointer-events: none;
    }
    /* CHANGED: make modal-section match (bottom border only, no padding) */
    .modal-section {
      margin-top: 20px;
      border: 0;
      border-bottom: 1px solid #e9e9e7;
      border-radius: 0;
      position: relative;
      background: #fff;
      min-height: 100px;
      padding: 0;
    }
    .btn {
      background: #fff; border: 1px solid #d9d9d6; border-radius: 3px; padding: 4px 8px; font-size: 9px; cursor: pointer;
      color: #555; display: flex; align-items: center; gap: 4px; transition: background 0.1s;
    }
    .btn:hover { background: #f7f6f3; }
    .btn svg { width: 10px; height: 10px; }
    .success {
      position: fixed; top: 16px; right: 16px; background: #2eaadc; color: white; padding: 8px 12px; border-radius: 3px;
      font-size: 12px; opacity: 0; transition: opacity 0.2s; z-index: 1000;
    }
    .success.show { opacity: 1; }
    .debug-badge {
      position: fixed; bottom: 10px; right: 10px; background: rgba(46,170,220,0.1); border: 1px solid #2eaadc;
      color: #2eaadc; font-size: 11px; padding: 4px 8px; border-radius: 4px; z-index: 1001; cursor: pointer;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      user-select: none;
    }
    @supports (container-type: inline-size) { .tile-wrapper { container-type: inline-size; } }
  </style>
</head>
<body>
  <div class="success" id="success">Copied!</div>

  <div class="embed-container${isModal ? ' modal-container' : ''}">
    <div class="tile-section">
      <div class="tile-wrapper">
        <div class="tile-block" id="tile">${liveTile}</div>
      </div>
    </div>

    <div class="controls">
      <button class="btn" id="refresh"><i data-lucide="refresh-cw"></i>Refresh</button>
      <button class="btn" id="copyTile"><i data-lucide="copy"></i>Copy Tile</button>
      <button class="btn" id="copyTileCode"><i data-lucide="clipboard-copy"></i>Copy Code</button>
    </div>
  </div>

  <div class="debug-badge" id="debugBadge" style="display:none" title="Click to toggle zoom modes"></div>

  <script>
    // --- Zoom helpers (query + hash; explicit zoom disables auto-bump) ---
    function getSearchParam(name) {
      try {
        const url = new URL(window.location.href);
        return url.searchParams.get(name);
      } catch (_) { return null; }
    }

    function getHashParam(name) {
      const hash = window.location.hash || '';
      if (!hash || hash.length < 2) return null;
      const q = new URLSearchParams(hash.slice(1));
      return q.get(name);
    }

    function readZoomParamAny() {
      // Priority: query.zoom -> query.z -> hash.zoom -> hash.z
      const qz = getSearchParam('zoom') || getSearchParam('z');
      if (qz) return { value: String(qz).trim(), source: 'query' };
      const hz = getHashParam('zoom') || getHashParam('z');
      if (hz) return { value: String(hz).trim(), source: 'hash' };
      return null;
    }

    function parseFitNcol(zoomStr) {
      const m = /^fit(\d+)col$/i.exec(zoomStr || '');
      return m ? Math.max(1, parseInt(m[1], 10)) : null;
    }

    function clamp(x, lo, hi) {
      return Math.min(Math.max(x, lo), hi);
    }

    // ----------------------------
    // Debug toggle override state
    // ----------------------------
    const DEBUG_SEQUENCE = [
      'auto',         // Normal (auto)
      'fit1col',
      'fit2col',
      'fit3col',
      'zoom:0.8',
      'zoom:0.9',
      'zoom:1',
      'zoom:1.25',
      'zoom:1.5'
    ];
    let debugOverride = null; // null = no override (respect URL or auto)
    let debugIndex = 0;

    function labelForState(state) {
      if (!state || state === 'auto') return 'Normal';
      if (state.startsWith('fit')) return state;
      if (state.startsWith('zoom:')) return state.replace('zoom:', 'zoom=');
      return state;
    }

    function computeScale(containerWidth) {
      // If debug override present, use it (ignores URL params)
      if (debugOverride) {
        if (debugOverride.startsWith('fit')) {
          const ncols = parseInt(debugOverride.replace(/[^\d]/g, ''), 10) || 1;
          const targetWidth = 1800 / ncols;
          const scale = targetWidth / Math.max(1, containerWidth);
          return { scale: clamp(scale, 1.0, 2.5), source: 'debug:' + debugOverride };
        }
        if (debugOverride.startsWith('zoom:')) {
          const val = parseFloat(debugOverride.split(':')[1]);
          const s = isNaN(val) ? 1 : val;
          return { scale: clamp(s, 0.6, 3.0), source: 'debug:zoom' };
        }
        // 'auto' → fall through
      }

      const z = readZoomParamAny();
      if (z && z.value) {
        // Explicit zoom provided -> honor it and skip auto-bump
        const numeric = parseFloat(z.value);
        if (!isNaN(numeric) && numeric > 0) {
          return { scale: clamp(numeric, 0.6, 3.0), source: z.source + ':numeric' };
        }
        const ncols = parseFitNcol(z.value);
        if (ncols) {
          const targetWidth = 1800 / ncols; // pretend wide canvas split in N columns
          const scale = targetWidth / Math.max(1, containerWidth);
          return { scale: clamp(scale, 1.0, 2.5), source: z.source + ':fitNcol(' + ncols + ')' };
        }
        // If malformed, fall through to default auto logic
      }

      // --- Auto-bump (only when no explicit zoom) ---
      let scale;
      if (containerWidth >= 1200) scale = 1.85;
      else if (containerWidth >= 900) scale = 1.5;
      else if (containerWidth >= 600) scale = 1.3;
      else if (containerWidth >= 480) scale = 1.1;
      else scale = 1.0;

      const isInIframe = window.self !== window.top;
      if (isInIframe && containerWidth < 640) {
        scale = Math.max(scale, 1.5); // helpful bump in Notion side peek
      }

      return { scale: clamp(scale, 0.6, 2.5), source: 'auto' };
    }

    function showDebug(scaleInfo) {
      const debug = getSearchParam('debug') || getHashParam('debug');
      const el = document.getElementById('debugBadge');
      if (!debug) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'block';
      const stateLabel = labelForState(debugOverride || 'auto');
      el.textContent = stateLabel + ' • scale=' + scaleInfo.scale.toFixed(3) + ' (' + scaleInfo.source + ')';
    }

    function sendHeightToParent() {
      const isModalContainer = document.querySelector('.modal-container');
      const minHeight = isModalContainer ? 1800 : 400;
      const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, minHeight);
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'resize', height, source: 'tkauto-embed' }, '*');
        window.parent.postMessage({ frameHeight: height, type: 'setHeight' }, '*');
        try { if (window.frameElement) window.frameElement.style.height = height + 'px'; } catch(e) {}
      }
    }

    function adjustTileHeight() {
      const tile = document.getElementById('tile');
      const tileSection = document.querySelector('.tile-section');
      const tileWrapper = document.querySelector('.tile-wrapper');
      const embedContainer = document.querySelector('.embed-container');

      tile.style.visibility = 'hidden';
      tile.style.display = 'block';

      const containerWidth = embedContainer.offsetWidth;
      const info = computeScale(containerWidth);
      showDebug(info);

      tile.style.transform = 'scale(' + info.scale + ')';
      tile.style.width = (100 / info.scale) + '%';

      // Force reflow
      void tile.offsetHeight;

      const actualHeight = tile.scrollHeight * info.scale;
      const wrapperPadding = parseInt(window.getComputedStyle(tileWrapper).paddingTop) +
                             parseInt(window.getComputedStyle(tileWrapper).paddingBottom);
      tileSection.style.height = (actualHeight + wrapperPadding + 30) + 'px';

      tile.style.visibility = 'visible';

      const totalHeight = embedContainer.scrollHeight;
      embedContainer.style.minHeight = totalHeight + 'px';

      sendHeightToParent();
    }

    let heightUpdateCount = 0;
    const maxHeightUpdates = 6;
    function finalizeHeight() {
      if (heightUpdateCount >= maxHeightUpdates) return;
      heightUpdateCount++;
      adjustTileHeight();
      sendHeightToParent();
    }

    window.addEventListener('load', () => {
      finalizeHeight();
      setTimeout(finalizeHeight, 100);
      setTimeout(finalizeHeight, 300);
      setTimeout(finalizeHeight, 500);
      setTimeout(finalizeHeight, 1000);
      setTimeout(finalizeHeight, 2000);
    });

    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (heightUpdateCount < maxHeightUpdates) finalizeHeight();
      }, 250);
    });

    if (document.fonts && heightUpdateCount < maxHeightUpdates) {
      document.fonts.ready.then(finalizeHeight);
    }

    function showSuccessToast() {
      const success = document.getElementById('success');
      success.classList.add('show');
      setTimeout(() => success.classList.remove('show'), 1500);
    }

    async function captureElement(selector) {
      const element = document.querySelector(selector);
      if (!element) throw new Error('Element not found: ' + selector);
      if (typeof html2canvas === 'undefined') throw new Error('html2canvas library not loaded');
      const canvas = await html2canvas(element, { useCORS: true, backgroundColor: '#fff', scale: 2, logging: false });
      return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    }

    async function copyImage(selector) {
      try {
        const blob = await captureElement(selector);
        if (!navigator.clipboard) throw new Error('Clipboard API not supported');
        await navigator.clipboard.write([ new ClipboardItem({ 'image/png': blob }) ]);
        showSuccessToast();
      } catch (err) {
        console.error('Copy image failed:', err);
        alert('Copy failed: ' + err.message);
      }
    }

    async function copyText(elementId) {
      try {
        const element = document.getElementById(elementId);
        if (!element) throw new Error('Element not found: ' + elementId);
        if (!navigator.clipboard) throw new Error('Clipboard API not supported');
        await navigator.clipboard.writeText(element.innerHTML);
        showSuccessToast();
      } catch (err) {
        console.error('Copy text failed:', err);
        alert('Copy failed: ' + err.message);
      }
    }

    document.getElementById('refresh').onclick = () => window.location.reload();
    document.getElementById('copyTile').onclick = () => copyImage('.tile-section');
    document.getElementById('copyTileCode').onclick = () => copyText('tile');

    // --- Debug badge toggle (only active when debug=1) ---
    (function initDebugToggle() {
      const hasDebug = getSearchParam('debug') || getHashParam('debug');
      const badge = document.getElementById('debugBadge');
      if (!hasDebug) return;

      // Click to advance through the sequence
      badge.addEventListener('click', () => {
        // Advance index
        debugIndex = (debugIndex + 1) % DEBUG_SEQUENCE.length;
        const next = DEBUG_SEQUENCE[debugIndex];

        // Set override (auto means clear override)
        debugOverride = (next === 'auto') ? null : next;

        // Recompute and redraw
        heightUpdateCount = 0; // allow a few more updates after toggle
        finalizeHeight();
      });
    })();

    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  </script>
</body>
</html>`;
}

/* ------------------------
 * Start the HTTP server
 * ---------------------- */
app.listen(PORT, () => {
  console.log('[tkAuto-Embed] Server on http://localhost:' + PORT);
});