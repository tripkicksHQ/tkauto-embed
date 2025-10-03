// @ts-nocheck
require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');

const app = express();
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: '2025-09-03' // Using the future-proof API version
});

// The fix: This line now removes all hyphens to ensure the ID is always correctly formatted.
const DATABASE_ID = (process.env.DATABASE_ID || "").replace(/-/g, "").trim();
const PORT = process.env.PORT || 3000;

/* ---------------------------
   Small helpers
---------------------------- */
function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function extractHtml(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'rich_text':
      return prop.rich_text.map(rt => rt.plain_text).join('');
    case 'title':
      return prop.title.map(rt => rt.plain_text).join('');
    case 'formula':
      return prop.formula.string || '';
    default:
      return prop.plain_text || '';
  }
}

function extractText(prop) {
  if (!prop) return '';
  if (prop.type === 'title' && prop.title.length > 0) return prop.title[0].plain_text;
  if (prop.type === 'rich_text' && prop.rich_text.length > 0) return prop.rich_text[0].plain_text;
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

/* ---------------------------
   General Page Fetcher
---------------------------- */
const requiredProperties = [
    'TK id', 'TK id Temp', 'Tile_Content', 'Tile HTML', 
    'TileContent', 'Tile Content', 'Tile', 'HTML', 
    'Modal HTML', 'ModalContent', 'Modal_Content', 'Modal Content', 'Modal'
];

async function findNotionPageByTkId(tkid) {
  const response = await withTimeout(
    notion.databases.query({
      database_id: DATABASE_ID,
      properties: requiredProperties,
      filter: {
        or: [{
          property: 'TK id',
          rich_text: {
            equals: tkid
          },
        }, {
          property: 'TK id Temp',
          formula: {
            string: {
              equals: tkid
            }
          },
        }, ],
      },
    }),
    8000,
    'Notion query by TK id'
  );

  if (response.results.length > 0) {
    console.log(`Found page matching tkid: '${tkid}'`);
    return response.results[0];
  }

  console.log(`No page found matching tkid: '${tkid}'`);
  return null;
}

/* ---------------------------
   Routes
---------------------------- */
app.get('/', (req, res) => {
  res.send('tkAuto Embed App - Use /embed or /modal');
});

app.get('/embed', async (req, res) => {
  let liveTile = '', errorMsg = '';
  let client = 'Client';

  try {
    if (!process.env.NOTION_TOKEN || !DATABASE_ID) {
      throw new Error('Missing NOTION_TOKEN or DATABASE_ID in environment variables.');
    }
    const targetTkid = req.query.tkid;
    if (!targetTkid) {
      throw new Error('Missing tkid parameter. Please use a URL like /embed?tkid=YOUR_ID');
    }
    
    console.log(`Embed request for tkid: '${targetTkid}'`);
    const page = await findNotionPageByTkId(targetTkid);

    if (page && page.properties) {
      const tkIdValue = extractText(page.properties['TK id']) || extractText(page.properties['TK id Temp']) || '';
      if (tkIdValue && tkIdValue.includes('.')) {
        client = tkIdValue.split('.')[0];
      }
      const possibleTileProps = ['Tile_Content', 'Tile HTML', 'TileContent', 'Tile Content', 'Tile', 'HTML'];
      for (const propName of possibleTileProps) {
        if (page.properties[propName]) {
          liveTile = sanitizeHtml(extractHtml(page.properties[propName]));
          console.log(`Found content in property '${propName}', length: ${liveTile.length}`);
          break;
        }
      }
      if (!liveTile) {
        errorMsg = `Page found for tkid '${targetTkid}' but no tile content property was found.`;
        console.log(errorMsg);
      }
    } else {
      errorMsg = `No page found in database for tkid '${targetTkid}'.`;
      console.log(errorMsg);
    }
  } catch (e) {
    console.error('Error in /embed route:', e);
    errorMsg = `<div style="color:#e03e3e; font-size:14px; padding:8px;">Error: ${e.message}</div>`;
  }

  if (errorMsg && !liveTile) liveTile = errorMsg;
  if (!liveTile) liveTile = '<div style="color:#999; font-size:14px; padding:8px;">No tile content found</div>';
  res.set('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  res.send(generateEmbed(liveTile, client, false));
});

app.get('/modal', async (req, res) => {
  let liveModal = '', errorMsg = '';
  let client = 'Client';

  try {
    if (!process.env.NOTION_TOKEN || !DATABASE_ID) {
      throw new Error('Missing NOTION_TOKEN or DATABASE_ID in environment variables.');
    }
    const targetTkid = req.query.tkid;
    if (!targetTkid) {
      throw new Error('Missing tkid parameter. Please use a URL like /modal?tkid=YOUR_ID');
    }
    
    console.log(`Modal request for tkid: '${targetTkid}'`);
    const page = await findNotionPageByTkId(targetTkid);

    if (page && page.properties) {
      const tkIdValue = extractText(page.properties['TK id']) || extractText(page.properties['TK id Temp']) || '';
      if (tkIdValue && tkIdValue.includes('.')) {
        client = tkIdValue.split('.')[0];
      }
      const possibleModalProps = ['Modal HTML', 'ModalContent', 'Modal_Content', 'Modal Content', 'Modal'];
      for (const propName of possibleModalProps) {
        if (page.properties[propName]) {
          liveModal = sanitizeHtml(extractHtml(page.properties[propName]));
          console.log(`Found modal content in property '${propName}', length: ${liveModal.length}`);
          break;
        }
      }
      if (!liveModal) {
        errorMsg = `Page found for tkid '${targetTkid}' but no modal content property was found.`;
        console.log(errorMsg);
      }
    } else {
      errorMsg = `No page found in database for tkid '${targetTkid}'.`;
      console.log(errorMsg);
    }
  } catch (e) {
    console.error('Error in /modal route:', e);
    errorMsg = `<div style="color:#e03e3e; font-size:14px; padding:8px;">Error: ${e.message}</div>`;
  }

  if (errorMsg && !liveModal) liveModal = errorMsg;
  if (!liveModal) liveModal = '<div style="color:#999; font-size:14px; padding:8px;">No modal content found</div>';
  res.set('Cache-control', 's-maxage=60, stale-while-revalidate=300');
  res.send(generateEmbed(liveModal, client, true));
});

/* ---------------------------
   HTML generator
---------------------------- */
function generateEmbed(liveContent, client, isModal = false) {
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
    html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif; background: #fff; color: #37352f; line-height: 1.5; overflow-x: hidden; height: auto; min-height: 100%; }
    .embed-container { width: 100%; min-height: 400px; display: flex; flex-direction: column; box-sizing: border-box; padding-bottom: 0; background: transparent; }
    .embed-container.modal-container { min-height: 1800px; height: 1800px; padding-bottom: 1000px; }
    .tile-section { width: 100%; box-sizing: border-box; margin-bottom: 0; overflow: visible; position: relative; min-height: 200px; border: 1px solid #e9e9e7; border-radius: 3px; background: #fff; }
    .modal-container .tile-section { min-height: 1600px; height: 1600px; }
    .tile-wrapper { width: 100%; margin: 0; padding: 20px; box-sizing: border-box; overflow: visible; position: relative; }
    .tile-block { transform-origin: top left; box-sizing: border-box; transition: transform 0.3s ease; transform: scale(1); width: 100%; }
    .tile-block > * { width: 100% !important; box-sizing: border-box !important; }
    .controls { display: flex; gap: 8px; margin-top: 0; padding: 2px 2px; border-top: 1px solid #e9e9e7; flex-wrap: wrap; }
    .btn { background: #fff; border: 1px solid #d9d9d6; border-radius: 3px; padding: 4px 8px; font-size: 9px; cursor: pointer; color: #37352f; display: flex; align-items: center; gap: 4px; transition: background 0.1s; }
    .btn:hover { background: #f7f6f3; }
    .btn svg { width: 10px; height: 10px; }
    .success { position: fixed; top: 16px; right: 16px; background: #2eaadc; color: white; padding: 8px 12px; border-radius: 3px; font-size: 12px; opacity: 0; transition: opacity 0.2s; z-index: 1000; }
    .success.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="success" id="success">Copied!</div>
  <div class="embed-container${isModal ? ' modal-container' : ''}">
    <div class="tile-section">
      <div class="tile-wrapper">
        <div class="tile-block" id="tile">${liveContent}</div>
      </div>
    </div>
    <div class="controls">
      <button class="btn" id="refresh"><i data-lucide="refresh-cw"></i> Refresh</button>
      <button class="btn" id="copyTile"><i data-lucide="copy"></i> Copy Tile</button>
      <button class="btn" id="copyTileCode"><i data-lucide="clipboard-copy"></i> Copy Code</button>
      <button class="btn" id="downloadTile"><i data-lucide="download"></i> Download PNG</button>
    </div>
  </div>
  <script>
    function sendHeightToParent() {
      var height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 400);
      try {
        if (window.parent !== window) {
          window.parent.postMessage({ type: 'resize', height: height, source: 'tkauto-embed' }, '*');
        }
      } catch (e) {}
    }
    window.addEventListener('load', sendHeightToParent);
    window.addEventListener('resize', sendHeightToParent);
    function showSuccess() {
      var s = document.getElementById('success');
      s.classList.add('show');
      setTimeout(function () { s.classList.remove('show'); }, 1500);
    }
    function captureElement(selector) {
      var el = document.querySelector(selector);
      if (!el || typeof html2canvas === 'undefined') return Promise.reject(new Error('Element or html2canvas not found'));
      return html2canvas(el, { useCORS: true, backgroundColor: '#fff', scale: 2 });
    }
    function downloadCanvasPNG(canvas, filename) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
          if (!blob) return reject(new Error('Canvas toBlob failed'));
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = filename || 'tile.png';
          document.body.appendChild(a); a.click(); a.remove();
          URL.revokeObjectURL(url); resolve();
        }, 'image/png');
      });
    }
    function copyCanvasToClipboard(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
          if (!blob) return reject(new Error('Canvas toBlob failed'));
          if (!navigator.clipboard) return reject(new Error('Clipboard API not available'));
          navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(resolve).catch(reject);
        }, 'image/png');
      });
    }
    function copyTextFromEl(id) {
      var el = document.getElementById(id);
      if (el && navigator.clipboard) navigator.clipboard.writeText(el.innerHTML).then(showSuccess).catch(console.error);
    }
    document.getElementById('refresh').addEventListener('click', () => window.location.reload());
    document.getElementById('copyTile').addEventListener('click', () => captureElement('.tile-section').then(copyCanvasToClipboard).then(showSuccess).catch(err => { console.error('Copy failed, falling back to download', err); captureElement('.tile-section').then(c => downloadCanvasPNG(c, 'tile.png')).then(showSuccess).catch(console.error); }));
    document.getElementById('copyTileCode').addEventListener('click', () => copyTextFromEl('tile'));
    document.getElementById('downloadTile').addEventListener('click', () => captureElement('.tile-section').then(c => downloadCanvasPNG(c, 'tile.png')).then(showSuccess).catch(console.error));
    if (typeof lucide !== 'undefined') lucide.createIcons();
  </script>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`Embed app running: http://localhost:${PORT}`);
});

