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
  if (prop.type === 'title' && prop.title.length) return prop.title[0].plain_text;
  if (prop.type === 'rich_text' && prop.rich_text.length) return prop.rich_text[0].plain_text;
  if (prop.type === 'formula') {
    if (prop.formula.type === 'string' && prop.formula.string !== null) return prop.formula.string;
    if (prop.formula.type === 'number' && prop.formula.number !== null) return String(prop.formula.number);
  }
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
  // Broadened candidates list
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
  // Broadened candidates list
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
  res.send('tkAuto Embed App - Use /embed or /modal');
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
        errorMsg = `Page found but no tile content. Available properties: ${Object.keys(page.properties).join(', ')}`;
        console.log(errorMsg);
      }
    } else {
      errorMsg = 'No page found in database';
      console.log(errorMsg);
    }
  } catch (e) {
    console.error('Error in /embed:', e);
    errorMsg = `<div style="color:#e03e3e; font-size:14px; padding:8px;">Error: ${e.message}</div>`;
  }

  if (errorMsg) liveTile = errorMsg;
  if (!liveTile) liveTile = `<div style="color:#999; font-size:14px; padding:8px;">No tile content found</div>`;

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
        errorMsg = `Page found but no modal content. Available properties: ${Object.keys(page.properties).join(', ')}`;
        console.log(errorMsg);
      }
    } else {
      errorMsg = 'No page found in database';
      console.log(errorMsg);
    }
  } catch (e) {
    console.error('Error in /modal:', e);
    errorMsg = `<div style="color:#e03e3e; font-size:14px; padding:8px;">Error: ${e.message}</div>`;
  }

  if (errorMsg) liveModal = errorMsg;
  if (!liveModal) liveModal = `<div style="color:#999; font-size:14px; padding:8px;">No modal content found</div>`;

  res.send(generateEmbed(liveModal, client, true));
});

/* ---------------------------
 * HTML shell for the embed UI
 * - now supports zoom via:
 *   ?zoom=1.8
 *   ?zoom=fit3col / fit4col / fit5col / fitNcol
 * - and auto-bump in iframe if not provided
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
      border: 1px solid #e9e9e7;
      border-radius: 3px;
      background: #fff;
    }
    .modal-container .tile-section {
      min-height: 1600px;
      height: 1600px;
    }
    .tile-wrapper {
      width: 100%;
      margin: 0;
      padding: 20px;
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
    .modal-section { margin-top: 20px; border: 1px solid #e9e9e7; border-radius: 3px; position: relative; background: #fff; min-height: 100px; padding: 16px; }
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

  <script>
    // --- Zoom helpers ---
    function readZoomParam() {
      try {
        const url = new URL(window.location.href);
        const z = url.searchParams.get('zoom') || url.searchParams.get('tkzoom');
        return z ? String(z).trim() : null;
      } catch (_) {
        return null;
      }
    }

    function parseFitNcol(zoomStr) {
      // matches fit3col, fit4col, fit10col, etc.
      const m = /^fit(\\d+)col$/i.exec(zoomStr || '');
      return m ? Math.max(1, parseInt(m[1], 10)) : null;
    }

    // Compute a scale value based on:
    //  - explicit numeric zoom (e.g., 1.6)
    //  - fitNcol keyword (simulate wide multi-column)
    //  - default rules with a bump for tight iframes
    function computeScale(containerWidth) {
      const zoomStr = readZoomParam();

      // 1) Explicit numeric zoom
      if (zoomStr) {
        const numeric = parseFloat(zoomStr);
        if (!isNaN(numeric) && numeric > 0) {
          return clamp(numeric, 0.6, 3.0);
        }
      }

      // 2) fitNcol mode: pretend we had wide columns
      const ncols = parseFitNcol(zoomStr);
      if (ncols) {
        // Assume a 1800px content area split into N columns
        const targetWidth = 1800 / ncols;
        const scale = targetWidth / Math.max(1, containerWidth);
        return clamp(scale, 1.0, 2.5);
      }

      // 3) Default responsive ladder
      let scale;
      if (containerWidth >= 1200) scale = 1.85;
      else if (containerWidth >= 900) scale = 1.5;
      else if (containerWidth >= 600) scale = 1.3;
      else if (containerWidth >= 480) scale = 1.1;
      else scale = 1.0;

      // If we're inside an iframe (e.g., Notion side peek), enforce a larger minimum
      const isInIframe = window.self !== window.top;
      if (isInIframe && containerWidth < 640) {
        scale = Math.max(scale, 1.5);
      }

      return clamp(scale, 0.6, 2.5);
    }

    function clamp(x, lo, hi) {
      return Math.min(Math.max(x, lo), hi);
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
      let scale = computeScale(containerWidth);

      // Optional: height guardrail for iframe
      const isInNotion = window.self !== window.top;
      if (isInNotion) {
        const availableHeight = window.innerHeight || 800;
        const modalSectionHeight = 300;
        const maxTileHeight = availableHeight - modalSectionHeight - 100;
        const potentialHeight = tile.scrollHeight * scale;
        if (potentialHeight > maxTileHeight) {
          scale = Math.min(scale, maxTileHeight / tile.scrollHeight);
          scale = Math.max(scale, 1.0); // keep reasonable minimum
        }
      }

      // Use classic strings (no backticks) to avoid template-escaping issues
      tile.style.transform = 'scale(' + scale + ')';
      tile.style.width = (100 / scale) + '%';

      // Force reflow
      void tile.offsetHeight;

      const actualHeight = tile.scrollHeight * scale;
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

    function showSuccess() {
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
        showSuccess();
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
        showSuccess();
      } catch (err) {
        console.error('Copy text failed:', err);
        alert('Copy failed: ' + err.message);
      }
    }

    document.getElementById('refresh').onclick = () => window.location.reload();
    document.getElementById('copyTile').onclick = () => copyImage('.tile-section');
    document.getElementById('copyTileCode').onclick = () => copyText('tile');

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
  console.log(`[tkAuto-Embed] Server on http://localhost:${PORT}`);
});