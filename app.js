// @ts-nocheck
require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const app = express();
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const PORT = process.env.PORT || 3000;

function extractHtml(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'rich_text':
      return prop.rich_text.map(rt => rt.plain_text).join('');
    case 'title':
      return prop.title.map(rt => rt.plain_text).join('');
    case 'formula':
      return prop.formula.string || '';
    case 'plain_text':
      return prop.plain_text || '';
    default:
      return '';
  }
}

function extractText(prop) {
  if (!prop) return '';
  if (prop.type === 'title' && prop.title.length)
    return prop.title.map(t => t.plain_text).join('');
  if (prop.type === 'rich_text' && prop.rich_text.length)
    return prop.rich_text.map(t => t.plain_text).join('');
  if (prop.type === 'formula') {
    if (prop.formula.type === 'string' && prop.formula.string !== null)
      return prop.formula.string;
    if (prop.formula.type === 'number' && prop.formula.number !== null)
      return String(prop.formula.number);
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
    /notion\.so\/[^\/]+\/([a-f0-9]{32})/i,
    /notion\.so\/([a-f0-9]{32})/i,
    /notion\.site\/[^\/]+\/([a-f0-9]{32})/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      const id = match[1];
      if (id.length === 32) {
        return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
      }
      return id;
    }
  }
  return null;
}

// Root route
app.get("/", (req, res) => {
  res.send("tkAuto Embed App - Use /embed or /embed-builder");
});

// Connections embed route
app.get('/embed', async (req, res) => {
  let liveTile = '', liveModal = '', errorMsg = '';
  let client = 'Client';
  const referrer = req.get('Referrer') || req.get('Referer');
  let pageId = extractPageIdFromUrl(referrer);
  if (!pageId && req.query.id) {
    pageId = req.query.id;
  }
  
  try {
    if (!process.env.NOTION_TOKEN || !process.env.DATABASE_ID) {
      throw new Error('Missing environment variables');
    }
    
    let page;
    if (pageId) {
      const searchResults = await notion.databases.query({
        database_id: process.env.DATABASE_ID,
        filter: {
          property: 'tkid1',
          formula: {
            string: {
              contains: pageId.slice(-8)
            }
          }
        }
      });
      if (searchResults.results.length > 0) {
        page = searchResults.results[0];
      }
    }
    
    if (!page) {
      const db = await notion.databases.query({
        database_id: process.env.DATABASE_ID,
        page_size: 1,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
      });
      if (db.results.length) {
        page = db.results[0];
      }
    }
    
    if (page) {
      const tkid1Value = extractText(page.properties['tkid1']) || '';
      if (tkid1Value && tkid1Value.includes('.')) {
        client = tkid1Value.split('.')[0];
      }
      liveTile = sanitizeHtml(extractHtml(page.properties['Tile HTML']));
      liveModal = sanitizeHtml(extractHtml(page.properties['Modal HTML']));
    }
  } catch (e) {
    console.error('Error:', e);
    errorMsg = `<div style="color:#e03e3e; font-size:14px; padding:8px;">Error: ${e.message}</div>`;
  }
  
  if (!liveTile) liveTile = `<div style="color:#999; font-size:14px; padding:8px;">No tile content found</div>`;
  if (!liveModal) liveModal = `<div style="color:#999; font-size:14px; padding:8px;">No modal content found</div>`;
  
  res.send(generateEmbed(liveTile, liveModal, client, false));
});

// Builder embed route
app.get('/embed-builder', async (req, res) => {
  let liveTile = '', liveModal = '', errorMsg = '';
  let client = 'Client';
  const referrer = req.get('Referrer') || req.get('Referer');
  let pageId = extractPageIdFromUrl(referrer);
  if (!pageId && req.query.id) {
    pageId = req.query.id;
  }
  
  try {
    if (!process.env.NOTION_TOKEN || !process.env.TKBUILDER_DATABASE_ID) {
      throw new Error('Missing environment variables');
    }
    
    let page;
    if (pageId) {
      const searchResults = await notion.databases.query({
        database_id: process.env.TKBUILDER_DATABASE_ID,
        filter: {
          property: 'bldrID',
          formula: {
            string: {
              contains: pageId.slice(-8)
            }
          }
        }
      });
      if (searchResults.results.length > 0) {
        page = searchResults.results[0];
      }
    }
    
    if (!page) {
      const db = await notion.databases.query({
        database_id: process.env.TKBUILDER_DATABASE_ID,
        page_size: 1,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
      });
      if (db.results.length) {
        page = db.results[0];
      }
    }
    
    if (page) {
      const bldrIDValue = extractText(page.properties['bldrID']) || '';
      if (bldrIDValue && bldrIDValue.includes('.')) {
        client = bldrIDValue.split('.')[0];
      }
      liveTile = sanitizeHtml(extractHtml(page.properties['TileContent']));
      liveModal = sanitizeHtml(extractHtml(page.properties['ModalContent']));
    }
  } catch (e) {
    console.error('Error:', e);
    errorMsg = `<div style="color:#e03e3e; font-size:14px; padding:8px;">Error: ${e.message}</div>`;
  }
  
  if (!liveTile) liveTile = `<div style="color:#999; font-size:14px; padding:8px;">No tile content found</div>`;
  if (!liveModal) liveModal = `<div style="color:#999; font-size:14px; padding:8px;">No modal content found</div>`;
  
  res.send(generateEmbed(liveTile, liveModal, client, true));
});

function generateEmbed(liveTile, liveModal, client, isBuilder) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>tkAuto Embed</title>
  <!-- Bootstrap CSS -->
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <!-- TripKicks CSS -->
  <link href="https://info.tripkicks.com/hubfs/system/mockup/tk-css.css" rel="stylesheet">
  <!-- Scripts -->
  <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif;
      background: #fff;
      color: #37352f;
      line-height: 1.5;
      overflow-y: auto;
    }
    
    .embed-container {
      width: 100%;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 0;
      box-sizing: border-box;
    }
    
    /* Tile section wrapper */
.tile-section {
  width: 100%;
  position: relative;
  flex-shrink: 0;
  display: block;
  margin-bottom: 20px;
  clear: both;
  overflow: visible;
  min-height: 200px;
}

/* The tile wrapper for proper scaling */
.tile-wrapper {
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 10px;
}

/* The tile content with MUCH larger scaling */
.tile-block {
  transform: scale(4);
  transform-origin: top left;
  width: 25%; /* 100 / 4 = 25% to compensate for scale */
  margin-bottom: 2rem;
  box-sizing: border-box;
  display: block;
}

/* Override any max-width constraints */
.tile-block > * {
  width: 100% !important;
  max-width: none !important;
  box-sizing: border-box !important;
}
    
    .divider {
      height: 1px;
      background: #e9e9e7;
      margin: 12px 16px 20px 16px;
      flex-shrink: 0;
      flex-grow: 0;
      clear: both;
      width: calc(100% - 32px);
    }
    
    /* Modal section */
    .modal-section {
      flex: 1;
      min-height: 300px;
      display: flex;
      flex-direction: column;
      padding: 0 16px 16px 16px;
      width: 100%;
      clear: both;
    }
    
    .modal-block {
      border: 1px solid #e9e9e7;
      border-radius: 3px;
      padding: 16px;
      flex: 1;
      overflow: auto;
      background: #fff;
      min-height: 250px;
    }
    
    .controls {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid #e9e9e7;
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    
    .btn {
      background: #fff;
      border: 1px solid #d9d9d6;
      border-radius: 3px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      color: #37352f;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: background 0.1s;
    }
    
    .btn:hover {
      background: #f7f6f3;
    }
    
    .btn svg {
      width: 14px;
      height: 14px;
    }
    
    .success {
      position: fixed;
      top: 16px;
      right: 16px;
      background: #2eaadc;
      color: white;
      padding: 8px 12px;
      border-radius: 3px;
      font-size: 12px;
      opacity: 0;
      transition: opacity 0.2s;
      z-index: 1000;
    }
    
    .success.show {
      opacity: 1;
    }
    
    /* Media queries for responsive scaling */
    @media (max-width: 768px) {
      .tile-wrapper {
        width: 90%;
      }
      
      .tile-block {
        transform: scale(1.5);
        width: 66.67%; /* 100 / 1.5 */
      }
    }
    
    @media (max-width: 480px) {
      .tile-wrapper {
        width: 95%;
      }
      
      .tile-block {
        transform: scale(1.2);
        width: 83.33%; /* 100 / 1.2 */
      }
    }
    
    /* For very narrow views like Notion side peek */
    @media (max-width: 380px) {
      .tile-wrapper {
        width: 100%;
        padding: 10px;
      }
      
      .tile-block {
        transform: scale(1);
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="success" id="success">Copied!</div>
  
  <div class="embed-container">
    <div class="tile-section">
      <div class="tile-wrapper">
        <div class="tile-block" id="tile">${liveTile}</div>
      </div>
    </div>
    
    <div class="divider"></div>
    
    <div class="modal-section">
      <div class="modal-block" id="modal">${liveModal}</div>
      <div class="controls">
        <button class="btn" id="refresh">
          <i data-lucide="refresh-cw"></i>
          Refresh
        </button>
        <button class="btn" id="copyTile">
          <i data-lucide="copy"></i>
          Copy Tile
        </button>
        <button class="btn" id="copyModal">
          <i data-lucide="copy"></i>
          Copy Modal
        </button>
        <button class="btn" id="copyBoth">
          <i data-lucide="camera"></i>
          Copy Both
        </button>
        <button class="btn" id="exportHtml">
          <i data-lucide="file-code"></i>
          Export HTML
        </button>
        <button class="btn" id="saveTileHtml">
          <i data-lucide="code"></i>
          Save Tile
        </button>
        <button class="btn" id="saveModalHtml">
          <i data-lucide="code-2"></i>
          Save Modal
        </button>
        <button class="btn" id="copyTileCode">
          <i data-lucide="clipboard-copy"></i>
          Copy Tile Code
        </button>
        <button class="btn" id="copyModalCode">
          <i data-lucide="clipboard-check"></i>
          Copy Modal Code
        </button>
      </div>
    </div>
  </div>
  
  <script>
    // Dynamically adjust tile section height based on scaled content
    function adjustTileScaling() {
      const tile = document.getElementById('tile');
      const tileSection = document.querySelector('.tile-section');
      const tileWrapper = document.querySelector('.tile-wrapper');
      
      // Get the current scale from computed styles
      const transform = window.getComputedStyle(tile).transform;
      let scale = 4; // default
      
      if (transform && transform !== 'none') {
        const matrix = transform.match(/matrix\\(([^)]+)\\)/);
        if (matrix) {
          const values = matrix[1].split(',');
          scale = parseFloat(values[0]);
        }
      }
      
      // Calculate the actual height needed after scaling
      const actualHeight = tile.scrollHeight * scale;
      const wrapperPadding = parseInt(window.getComputedStyle(tileWrapper).paddingTop) + 
                            parseInt(window.getComputedStyle(tileWrapper).paddingBottom);
      
      // Set the section height to accommodate scaled content
      tileSection.style.height = (actualHeight + wrapperPadding) + 'px';
      
      // Ensure tile content is visible
      tile.style.visibility = 'visible';
    }
    
    // Run scaling adjustment on load
    window.addEventListener('load', () => {
      adjustTileScaling();
      // Run again after a short delay to ensure all styles are applied
      setTimeout(adjustTileScaling, 100);
    });
    
    // Also run on resize
    window.addEventListener('resize', adjustTileScaling);
    
    // Run when fonts load
    if (document.fonts) {
      document.fonts.ready.then(adjustTileScaling);
    }
    
    function showSuccess() {
      const success = document.getElementById('success');
      success.classList.add('show');
      setTimeout(() => success.classList.remove('show'), 1500);
    }
    
    async function captureElement(selector) {
      const element = document.querySelector(selector);
      if (!element) throw new Error('Element not found');
      
      const canvas = await html2canvas(element, {
        useCORS: true,
        backgroundColor: '#fff',
        scale: 2,
        logging: false
      });
      
      return new Promise(resolve => {
        canvas.toBlob(resolve, 'image/png');
      });
    }
    
    async function copyImage(selector) {
      try {
        const blob = await captureElement(selector);
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        showSuccess();
      } catch (err) {
        console.error('Copy failed:', err);
        alert('Copy failed. Please try again.');
      }
    }
    
    async function copyText(elementId) {
      try {
        const element = document.getElementById(elementId);
        if (!element) throw new Error('Element not found');
        await navigator.clipboard.writeText(element.innerHTML);
        showSuccess();
      } catch (err) {
        console.error('Copy failed:', err);
        alert('Copy failed. Please try again.');
      }
    }
    
    function saveHtml(elementId, filename) {
      try {
        const element = document.getElementById(elementId);
        if (!element) throw new Error('Element not found');
        
        const html = \`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>\${filename}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://info.tripkicks.com/hubfs/system/mockup/tk-css.css" rel="stylesheet">
  <style>
    body { margin: 0; padding: 20px; font-family: system-ui; }
    .content {
      \${elementId === 'tile' ? 
        'background: #156eff; color: #fff; padding: 0.5em; border-radius: 4px;' : 
        'background: #fff; border: 1px solid #ddd; padding: 1em; border-radius: 4px;'}
    }
  </style>
</head>
<body>
  <div class="content">\${element.innerHTML}</div>
</body>
</html>\`;
        
        const blob = new Blob([html], { type: 'text/html' });
        const link = document.createElement('a');
        link.download = filename + '.html';
        link.href = URL.createObjectURL(blob);
        link.click();
        URL.revokeObjectURL(link.href);
      } catch (err) {
        console.error('Save failed:', err);
        alert('Save failed. Please try again.');
      }
    }
    
    function exportFullHtml() {
      const tileContent = document.getElementById('tile').innerHTML;
      const modalContent = document.getElementById('modal').innerHTML;
      
      const html = \`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${client}_${isBuilder ? 'Builder' : 'Live'}_Export</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://info.tripkicks.com/hubfs/system/mockup/tk-css.css" rel="stylesheet">
  <style>
    body { margin: 0; padding: 20px; font-family: system-ui; background: #fff; }
    .container { max-width: 800px; margin: 0 auto; }
    .tile { margin-bottom: 20px; }
    .divider { height: 1px; background: #ddd; margin: 20px 0; }
    .modal { border: 1px solid #ddd; padding: 20px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="tile">\${tileContent}</div>
    <div class="divider"></div>
    <div class="modal">\${modalContent}</div>
  </div>
</body>
</html>\`;
      
      const blob = new Blob([html], { type: 'text/html' });
      const link = document.createElement('a');
      link.download = '${client}_${isBuilder ? 'Builder' : 'Live'}_Export.html';
      link.href = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);
    }
    
    // Event listeners
    document.getElementById('refresh').onclick = () => window.location.reload();
    document.getElementById('copyTile').onclick = () => copyImage('.tile-wrapper');
    document.getElementById('copyModal').onclick = () => copyImage('#modal');
    document.getElementById('copyBoth').onclick = () => copyImage('.embed-container');
    document.getElementById('exportHtml').onclick = exportFullHtml;
    document.getElementById('saveTileHtml').onclick = () => saveHtml('tile', '${client}_tile');
    document.getElementById('saveModalHtml').onclick = () => saveHtml('modal', '${client}_modal');
    document.getElementById('copyTileCode').onclick = () => copyText('tile');
    document.getElementById('copyModalCode').onclick = () => copyText('modal');
    
    // Initialize icons
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  </script>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`Embed app running: http://localhost:${PORT}`);
});