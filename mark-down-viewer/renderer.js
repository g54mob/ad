/* ══════════════════════════════════════════════════════════════
   Markdown.View — Electron Renderer
   All markdown rendering, TOC, editor, tabs, file sidebar logic
   ══════════════════════════════════════════════════════════════ */

/* ══ Deps (bundled via node_modules, loaded via require) ═══ */
const marked   = require('marked');
const hljs     = require('highlight.js');
const LZString = require('lz-string');

/* ══ Utilities ═════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/* ══ Status-bar loader (Sublime-style ASCII spinner) ═══════ */
const _loaderFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let _loaderTimer = null;
let _loaderFrame = 0;
function showLoader(label) {
    const el = $('sb-loader');
    const spin = $('sb-loader-spin');
    if (!el || !spin) return;
    _loaderFrame = 0;
    spin.textContent = _loaderFrames[0] + ' ' + (label || 'loading…');
    el.classList.add('active');
    clearInterval(_loaderTimer);
    _loaderTimer = setInterval(() => {
        _loaderFrame = (_loaderFrame + 1) % _loaderFrames.length;
        spin.textContent = _loaderFrames[_loaderFrame] + ' ' + (label || 'loading…');
    }, 80);
}
function hideLoader() {
    clearInterval(_loaderTimer);
    _loaderTimer = null;
    const el = $('sb-loader');
    if (el) el.classList.remove('active');
}

/* ══ Code Preview Mode ════════════════════════════════════ */
const CODE_EXTENSIONS = {
    cs: 'csharp', js: 'javascript', ts: 'typescript', py: 'python',
    java: 'java', cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
    swift: 'swift', kt: 'kotlin', scala: 'scala',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    xml: 'xml', html: 'html', css: 'css', scss: 'scss',
    sql: 'sql', lua: 'lua', r: 'r', dart: 'dart',
};
const CODE_EXT_PATTERN = new RegExp('\\.(' + Object.keys(CODE_EXTENSIONS).join('|') + ')$', 'i');
const MD_EXTENSIONS = ['md', 'markdown', 'txt'];
let codePreviewEnabled = false;
// Tracks folders where code scanning is active (relative folder paths)
const codeScannedFolders = new Set();

function getActiveExtensions() {
    const exts = [...MD_EXTENSIONS];
    if (codePreviewEnabled) exts.push(...Object.keys(CODE_EXTENSIONS));
    return exts;
}

function isCodeFile(filePath) {
    if (!filePath) return false;
    const ext = filePath.split('.').pop().toLowerCase();
    return ext in CODE_EXTENSIONS;
}

function getCodeLang(filePath) {
    if (!filePath) return 'text';
    const ext = filePath.split('.').pop().toLowerCase();
    return CODE_EXTENSIONS[ext] || 'text';
}

async function toggleCodeScanForFolder(folderRelPath) {
    if (!watchedDir) return;
    const sep = watchedDir.includes('/') ? '/' : '\\';
    const absFolder = watchedDir + sep + folderRelPath.replace(/\//g, sep);
    if (codeScannedFolders.has(folderRelPath)) {
        // Remove code files from this folder
        codeScannedFolders.delete(folderRelPath);
        allFiles = allFiles.filter(f => {
            // Keep files not under this folder
            if (f.dir !== folderRelPath && !f.dir.startsWith(folderRelPath + '/')) return true;
            // Keep markdown files
            return /\.(md|markdown|txt)$/i.test(f.name);
        });
        renderFileList();
        toast('Code files hidden: ' + folderRelPath.split('/').pop());
    } else {
        // Scan this folder for code files and merge them in
        codeScannedFolders.add(folderRelPath);
        showLoader('scanning code...');
        const codeExts = Object.keys(CODE_EXTENSIONS);
        const codeFiles = await window.electronAPI.scanDir(absFolder, codeExts);
        // The scan returns paths relative to absFolder — remap to be relative to watchedDir
        for (const f of codeFiles) {
            // f.relPath from scanDir is relative to absFolder, prepend the folder's relative path
            f.relPath = folderRelPath + '/' + f.relPath;
            f.dir = f.dir ? (folderRelPath + '/' + f.dir) : folderRelPath;
            // Avoid duplicates
            if (!allFiles.find(ex => ex.path === f.path)) {
                allFiles.push(f);
            }
        }
        allFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));
        renderFileList();
        hideLoader();
        toast('Code files loaded: ' + folderRelPath.split('/').pop() + ' (' + codeFiles.length + ')');
    }
}

/* ══ State ═════════════════════════════════════════════════ */
let MD = '';
let curTab        = localStorage.getItem('mdv_tab') || 'raw';
let dark          = (localStorage.getItem('mdv_theme') || 'dark') === 'dark';
let fname         = 'untitled.md';
let currentFilePath = null;   // absolute path of currently open file
let watchedDir      = null;   // absolute path of watched directory
let allFiles        = [];     // array of file info objects
let renderPending   = false;
let tocObserver     = null;
let sidebarSearchQ  = '';
let isDirty         = false;
let autoSaveTimer   = null;

// File tabs
let openTabs = [];       // [{id, path, name, content, isDirty, scrollTop, viewTab}]
let activeTabId = null;
let tabIdCounter = 0;

// Persistent scroll memory: { filePath: { scrollTop, viewTab } }
const SCROLL_KEY = 'mdv_scroll_mem';
function loadScrollMem() { try { return JSON.parse(localStorage.getItem(SCROLL_KEY) || '{}'); } catch { return {}; } }
function saveScrollMem(mem) { localStorage.setItem(SCROLL_KEY, JSON.stringify(mem)); }
function saveFileScroll(filePath, scrollTop, viewTab) {
    if (!filePath) return;
    const mem = loadScrollMem();
    mem[filePath] = { scrollTop, viewTab };
    saveScrollMem(mem);
}
function getFileScroll(filePath) {
    if (!filePath) return null;
    return loadScrollMem()[filePath] || null;
}
function removeFileScroll(filePath) {
    const mem = loadScrollMem();
    delete mem[filePath];
    saveScrollMem(mem);
}
function pruneScrollMem(validPaths) {
    const mem = loadScrollMem();
    const validSet = new Set(validPaths);
    let changed = false;
    for (const k of Object.keys(mem)) {
        if (!validSet.has(k)) { delete mem[k]; changed = true; }
    }
    if (changed) saveScrollMem(mem);
}

// Apply persisted theme immediately
document.documentElement.dataset.theme = dark ? 'dark' : 'light';

/* ══ Refs ══════════════════════════════════════════════════ */
const landing      = $('landing');
const landCard     = $('land-card');
const landTA       = $('land-ta');
const workspace    = $('workspace');
const rawEditor    = $('raw-editor');
const splitEd      = $('split-editor');
const lnums        = $('lnums');
const splitLnums   = $('split-lnums');
const prevBody     = $('prev-body');
const splitPrev    = $('split-prev-body');
const tocEl        = $('toc');
const tocNav       = $('toc-nav');
const tabs         = $('tabs');
const pill         = $('tab-pill');
const fileSidebar  = $('file-sidebar');
const fileList     = $('file-list');
const fileTabsBar  = $('file-tabs-bar');

/* ══ marked.js renderer ════════════════════════════════════ */
const renderer = new marked.Renderer();

renderer.heading = function(text, level) {
    const slug = text
        .replace(/<[^>]+>/g, '')
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim();
    return `<h${level} id="${slug}">${text}<a class="h-link" href="#${slug}" aria-hidden="true">#</a></h${level}>\n`;
};

renderer.code = function(code, lang) {
    // Mermaid diagrams
    if (lang && lang.toLowerCase() === 'mermaid') {
        return `<div class="mermaid-wrap"><pre class="mermaid">${esc(code)}</pre></div>\n`;
    }
    const raw = code.replace(/\t/g, '    ');
    const vl = lang && hljs.getLanguage(lang) ? lang : null;
    let hl;
    try { hl = vl ? hljs.highlight(raw, { language: vl }).value : hljs.highlightAuto(raw).value; }
    catch(e) { hl = esc(raw); }
    const badge = vl || (lang ? esc(lang) : 'text');
    const enc = encodeURIComponent(code);
    return `<pre><div class="code-hdr"><span class="lang-badge">${badge}</span><button class="ccopy" onclick="copyCode(this,'${enc}')">\u2398 Copy</button></div><code class="hljs">${hl}</code></pre>\n`;
};

renderer.codespan = function(code) { return `<code>${code}</code>`; };

renderer.table = function(header, body) {
    return `<div class="tbl-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>\n`;
};

renderer.image = function(href, title, text) {
    // Resolve relative paths to file:// URLs based on current file's directory
    let src = href;
    if (currentFilePath && href && !href.startsWith('http') && !href.startsWith('data:') && !href.startsWith('file:')) {
        const dir = require('path').dirname(currentFilePath);
        src = 'file:///' + require('path').resolve(dir, href).replace(/\\/g, '/');
    }
    return `<img src="${esc(src)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''} loading="lazy" />\n`;
};

renderer.link = function(href, title, text) {
    if (!href) return text;
    const ext = !href.startsWith('#') && !href.startsWith('mailto:');
    return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
};

renderer.blockquote = function(quote) {
    const types = { NOTE:'\uD83D\uDCAC', TIP:'\uD83D\uDCA1', WARNING:'\u26A0\uFE0F', IMPORTANT:'\u2757', CAUTION:'\uD83D\uDD25' };
    const m = quote.match(/<p>\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\](.*?)<\/p>/is);
    if (m) {
        const type = m[1].toUpperCase();
        const rest = m[2].trim();
        const body = quote
            .replace(/<p>\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\].*?<\/p>/is, rest ? `<p>${rest}</p>` : '');
        return `<blockquote data-callout="${type}"><p><strong>${types[type] || '\uD83D\uDCCC'} ${type}</strong></p>${body}</blockquote>\n`;
    }
    return `<blockquote>${quote}</blockquote>\n`;
};

let mdvTaskIdx = 0;
renderer.listitem = function(text, task, checked) {
    if (task) {
        text = text.replace(/^<input[^>]*>/, '');
        const i = mdvTaskIdx++;
        return `<li class="task-item"><input type="checkbox" class="task-cb" data-task-index="${i}"${checked ? ' checked' : ''} style="cursor:pointer" />${text}</li>\n`;
    }
    return `<li>${text}</li>\n`;
};

marked.use({ renderer, gfm: true, breaks: false, pedantic: false });

/* ══ Footnote pre-processing ═══════════════════════════════ */
function processFootnotes(src) {
    const defs = {};
    const defRe = /^\[\^([^\]]+)\]:\s*(.+(?:\n(?!\s*\n).*)*)/gm;
    let m;
    while ((m = defRe.exec(src)) !== null) defs[m[1]] = m[2].trim();
    if (!Object.keys(defs).length) return src;

    const order = [];
    let out = src.replace(/\[\^([^\]]+)\](?!:)/g, (_, lbl) => {
        if (defs[lbl] === undefined) return `[^${lbl}]`;
        if (!order.includes(lbl)) order.push(lbl);
        const n = order.indexOf(lbl) + 1;
        return `<sup><a class="fn-ref" href="#fn-${lbl}" id="fnref-${lbl}">[${n}]</a></sup>`;
    });
    out = out.replace(/^\[\^[^\]]+\]:\s*.+$/gm, '');

    if (order.length) {
        let sec = '\n\n<div class="footnotes"><hr/><ol>';
        order.forEach(lbl => {
            sec += `<li class="fn-item" id="fn-${lbl}">${defs[lbl]} <a href="#fnref-${lbl}" class="fn-ref">\u21A9</a></li>`;
        });
        sec += '</ol></div>';
        out += sec;
    }
    return out;
}

/* ══ Math-ish pre-processing ═══════════════════════════════ */
function processMath(src) {
    src = src.replace(/\$\$([^$]+?)\$\$/gs, (_, inner) =>
        `<div class="math-block">${esc(inner.trim())}</div>`);
    src = src.replace(/\$([^$\n]+?)\$/g, (_, inner) =>
        `<span class="math-inline">${esc(inner.trim())}</span>`);
    return src;
}

/* ══ YAML frontmatter stripping ════════════════════════════ */
function stripFrontmatter(src) {
    // Match --- at very start, YAML block, closing ---
    const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { body: src, meta: null };
    let meta = null;
    try {
        // Parse simple key: value pairs from frontmatter
        const obj = {};
        m[1].split('\n').forEach(line => {
            const kv = line.match(/^(\w[\w-]*):\s*(.+)/);
            if (kv) obj[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
        });
        meta = obj;
    } catch { /* ignore parse errors */ }
    return { body: src.slice(m[0].length), meta };
}

/* ══ Main render ═══════════════════════════════════════════ */
function renderMD(src) {
    const { body, meta } = stripFrontmatter(src);
    let processed = processFootnotes(body);
    processed = processMath(processed);
    // Show frontmatter as a subtle info block if present
    let fmHtml = '';
    if (meta) {
        const entries = Object.entries(meta).map(([k,v]) => `<span class="fm-key">${esc(k)}:</span> ${esc(v)}`).join('<br>');
        fmHtml = `<div class="frontmatter-block">${entries}</div>\n`;
    }
    try { return fmHtml + marked.parse(processed); }
    catch(e) { return `<pre style="color:var(--red)">Parse error: ${esc(e.message)}</pre>`; }
}

// Initialize mermaid with custom theme matching app palette + DM Mono font
if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        securityLevel: 'loose',
        themeVariables: {
            // Fonts
            fontFamily: "'DM Mono', 'Consolas', monospace",
            fontSize: '13px',
            // Background
            darkMode: true,
            background: '#131720',
            mainBkg: '#1a1f2e',
            // Node colors (d3-inspired palette)
            primaryColor: '#1e3a5f',
            primaryTextColor: '#d4dce8',
            primaryBorderColor: '#34d399',
            secondaryColor: '#2d1b4e',
            secondaryTextColor: '#d4dce8',
            secondaryBorderColor: '#a78bfa',
            tertiaryColor: '#1b3b33',
            tertiaryTextColor: '#d4dce8',
            tertiaryBorderColor: '#34d399',
            // Lines and edges
            lineColor: '#4a5568',
            textColor: '#d4dce8',
            // Notes and labels
            noteBkgColor: '#1a1f2e',
            noteTextColor: '#8896b0',
            noteBorderColor: '#252c3d',
            // Actor/sequence
            actorBkg: '#1e3a5f',
            actorBorder: '#60a5fa',
            actorTextColor: '#d4dce8',
            actorLineColor: '#4a5568',
            signalColor: '#d4dce8',
            signalTextColor: '#d4dce8',
            // Pie
            pie1: '#34d399',
            pie2: '#60a5fa',
            pie3: '#f472b6',
            pie4: '#fbbf24',
            pie5: '#a78bfa',
            pie6: '#f87171',
            pie7: '#2dd4bf',
            pie8: '#818cf8',
            // Labels
            labelColor: '#d4dce8',
            labelTextColor: '#d4dce8',
            // Section
            sectionBkgColor: '#1a1f2e',
            sectionBkgColor2: '#131720',
            altSectionBkgColor: '#1e2435',
            // Task (gantt)
            taskBkgColor: '#1e3a5f',
            taskTextColor: '#d4dce8',
            taskBorderColor: '#34d399',
            activeTaskBkgColor: '#0a8f5f',
            activeTaskBorderColor: '#34d399',
            doneTaskBkgColor: '#2d1b4e',
            doneTaskBorderColor: '#a78bfa',
            // Cluster
            clusterBkg: '#131720',
            clusterBorder: '#252c3d',
            // Title
            titleColor: '#34d399',
        },
    });
}

function renderMermaidBlocks() {
    if (typeof mermaid === 'undefined') return;
    document.querySelectorAll('pre.mermaid').forEach((el, i) => {
        if (el.dataset.processed) return;
        el.dataset.processed = '1';
        const code = el.textContent;
        const id = 'mermaid-' + Date.now() + '-' + i;
        try {
            mermaid.render(id, code).then(({ svg }) => {
                el.innerHTML = svg;
                // Click to open fullscreen overlay
                const wrap = el.closest('.mermaid-wrap');
                if (wrap) wrap.addEventListener('click', () => openMermaidOverlay(svg));
            }).catch(() => {
                el.innerHTML = '<span style="color:var(--red)">Mermaid render error</span>';
            });
        } catch { /* mermaid not ready */ }
    });
}

/* ══ Mermaid fullscreen overlay (zoom + pan via SVG viewBox — crisp text) ═ */
const mermaidOverlay = $('mermaid-overlay');
const mermaidInner  = $('mermaid-overlay-inner');
const mermaidZoomEl = $('mermaid-overlay-zoom');
let mOverlayOpen = false, mPanning = false, mStartX = 0, mStartY = 0;
// viewBox state: vx,vy = top-left of visible area in SVG coords, vw,vh = visible size
let vx = 0, vy = 0, vw = 0, vh = 0, svgNatW = 0, svgNatH = 0;

function openMermaidOverlay(svgHtml) {
    mermaidInner.innerHTML = svgHtml;
    const svg = mermaidInner.querySelector('svg');
    if (!svg) return;
    mermaidOverlay.classList.add('show');
    mOverlayOpen = true;
    // Get native SVG size
    svgNatW = parseFloat(svg.getAttribute('width')) || svg.viewBox?.baseVal?.width || 800;
    svgNatH = parseFloat(svg.getAttribute('height')) || svg.viewBox?.baseVal?.height || 600;
    // Make SVG fill the overlay with no aspect ratio constraint
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.setAttribute('preserveAspectRatio', 'xMinYMin slice');
    // Match viewBox aspect ratio to screen so pan works in both directions
    const screenAR = mermaidOverlay.clientWidth / mermaidOverlay.clientHeight;
    const svgAR = svgNatW / svgNatH;
    if (screenAR > svgAR) {
        // Screen is wider — expand width to match
        vw = svgNatH * screenAR; vh = svgNatH;
        vx = -(vw - svgNatW) / 2; vy = 0;
    } else {
        // Screen is taller — expand height to match
        vw = svgNatW; vh = svgNatW / screenAR;
        vx = 0; vy = -(vh - svgNatH) / 2;
    }
    svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
    mermaidZoomEl.textContent = '100%';
}

function closeMermaidOverlay() {
    mermaidOverlay.classList.remove('show');
    mOverlayOpen = false;
    mermaidInner.innerHTML = '';
}

function applyViewBox() {
    const svg = mermaidInner.querySelector('svg');
    if (!svg) return;
    svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
    const zoom = Math.round((svgNatW / vw) * 100);
    mermaidZoomEl.textContent = zoom + '%';
}

// Scroll to zoom toward cursor
mermaidOverlay.addEventListener('wheel', e => {
    if (!mOverlayOpen) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 0.85 : 1.18;
    const clamp = Math.max(0.05, Math.min(20, (vw * factor) / svgNatW));
    const newW = svgNatW * clamp;
    const newH = vh * (newW / vw); // maintain current aspect ratio
    // Mouse position in SVG coords (the point under cursor)
    const rect = mermaidOverlay.getBoundingClientRect();
    const mx = vx + (e.clientX - rect.left) / rect.width * vw;
    const my = vy + (e.clientY - rect.top) / rect.height * vh;
    // After zoom, reposition so (mx,my) stays at the same screen pixel
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    vx = mx - fx * newW;
    vy = my - fy * newH;
    vw = newW;
    vh = newH;
    applyViewBox();
}, { passive: false });

// Pan via drag — pointerdown on overlay (inner SVG has pointer-events:none so events reach here)
mermaidOverlay.addEventListener('pointerdown', e => {
    if (!mOverlayOpen) return;
    if (e.target.closest('#mermaid-toolbar')) return;
    mPanning = true;
    mStartX = e.clientX;
    mStartY = e.clientY;
    mermaidOverlay.setPointerCapture(e.pointerId);
    mermaidOverlay.classList.add('panning');
});
mermaidOverlay.addEventListener('pointermove', e => {
    if (!mPanning) return;
    const rect = mermaidOverlay.getBoundingClientRect();
    const dx = (e.clientX - mStartX) * (vw / rect.width);
    const dy = (e.clientY - mStartY) * (vh / rect.height);
    vx -= dx;
    vy -= dy;
    mStartX = e.clientX;
    mStartY = e.clientY;
    applyViewBox();
});
mermaidOverlay.addEventListener('pointerup', e => {
    if (!mPanning) return;
    mPanning = false;
    mermaidOverlay.releasePointerCapture(e.pointerId);
    mermaidOverlay.classList.remove('panning');
});

// Toolbar buttons: zoom in, zoom out, reset, close
function mermaidZoomBy(factor) {
    const newW = Math.max(svgNatW * 0.05, Math.min(svgNatW * 20, vw * factor));
    const newH = Math.max(svgNatH * 0.05, Math.min(svgNatH * 20, vh * factor));
    // Zoom toward center
    vx = vx + (vw - newW) * 0.5;
    vy = vy + (vh - newH) * 0.5;
    vw = newW; vh = newH;
    applyViewBox();
}

// Block all events on toolbar from reaching the overlay
$('mermaid-toolbar').addEventListener('click', e => e.stopPropagation());
$('mermaid-toolbar').addEventListener('dblclick', e => e.stopPropagation());
$('mermaid-toolbar').addEventListener('pointerdown', e => e.stopPropagation());

$('mo-zoom-in').addEventListener('click', () => mermaidZoomBy(0.7));
$('mo-zoom-out').addEventListener('click', () => mermaidZoomBy(1.4));
$('mo-zoom-reset').addEventListener('click', () => {
    const screenAR = mermaidOverlay.clientWidth / mermaidOverlay.clientHeight;
    const svgAR = svgNatW / svgNatH;
    if (screenAR > svgAR) {
        vw = svgNatH * screenAR; vh = svgNatH;
        vx = -(vw - svgNatW) / 2; vy = 0;
    } else {
        vw = svgNatW; vh = svgNatW / screenAR;
        vx = 0; vy = -(vh - svgNatH) / 2;
    }
    applyViewBox();
});
$('mermaid-overlay-close').addEventListener('click', closeMermaidOverlay);

// Double-click on background to close (not on toolbar)
mermaidOverlay.addEventListener('dblclick', closeMermaidOverlay);
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && mOverlayOpen) { e.preventDefault(); closeMermaidOverlay(); }
});

/* ── Mermaid node tooltip (styled, instant) ──────────── */
const mermaidTip = $('mermaid-tooltip');

document.addEventListener('mouseover', e => {
    // Find closest node/element with a title inside a mermaid SVG
    const node = e.target.closest('[title]');
    if (!node) { mermaidTip.classList.remove('show'); return; }
    const inMermaid = node.closest('.mermaid-wrap') || node.closest('#mermaid-overlay-inner');
    if (!inMermaid) { mermaidTip.classList.remove('show'); return; }
    const text = node.getAttribute('title');
    if (!text) { mermaidTip.classList.remove('show'); return; }
    // Suppress browser native tooltip by temporarily removing title
    node.dataset.tipText = text;
    node.removeAttribute('title');
    mermaidTip.textContent = text;
    mermaidTip.classList.add('show');
});

document.addEventListener('mousemove', e => {
    if (!mermaidTip.classList.contains('show')) return;
    mermaidTip.style.left = (e.clientX + 12) + 'px';
    mermaidTip.style.top = (e.clientY + 12) + 'px';
});

document.addEventListener('mouseout', e => {
    const node = e.target.closest('[data-tip-text]');
    if (node) {
        // Restore title attribute
        node.setAttribute('title', node.dataset.tipText);
        delete node.dataset.tipText;
    }
    mermaidTip.classList.remove('show');
});

function renderCodePreview(src, filePath) {
    const lang = getCodeLang(filePath);
    const raw = src.replace(/\t/g, '    ');
    let hl;
    try {
        hl = hljs.getLanguage(lang)
            ? hljs.highlight(raw, { language: lang }).value
            : hljs.highlightAuto(raw).value;
    } catch { hl = esc(raw); }
    const badge = lang;
    const lineCount = raw.split('\n').length;
    return `<div class="code-preview-wrap"><div class="code-hdr"><span class="lang-badge">${badge}</span><span class="code-preview-info">${lineCount} lines</span></div><pre class="code-preview-block"><code class="hljs">${hl}</code></pre></div>`;
}

function render() {
    mdvTaskIdx = 0;
    // Clear find highlights before re-rendering (marks are in the DOM being replaced)
    findMatches = [];
    findMatchIndex = -1;
    const isCode = codePreviewEnabled && isCodeFile(currentFilePath);
    const html = isCode ? renderCodePreview(MD, currentFilePath) : renderMD(MD);
    prevBody.innerHTML = html;
    // Defer split preview to avoid double-blocking
    requestAnimationFrame(() => { splitPrev.innerHTML = html; });
    if (!isCode) buildTOC(html);
    else { tocEl.classList.remove('show'); }
    updateStats();
    if (!isCode) renderMermaidBlocks();
    // Re-apply find highlights if find bar is open
    if (findOpen && findInput.value) {
        setTimeout(() => _findHighlight(findInput.value), 50);
    }
    // Interactive task checkboxes
    [prevBody, splitPrev].forEach(container => {
        container.querySelectorAll('.task-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                const re = /- \[([ xX])\]/g;
                let idx = 0;
                MD = MD.replace(re, (m, ch) => {
                    if (idx++ === parseInt(cb.dataset.taskIndex)) {
                        return ch.trim() ? '- [ ]' : '- [x]';
                    }
                    return m;
                });
                rawEditor.value = MD;
                splitEd.value = MD;
                markDirty();
                [prevBody, splitPrev].forEach(c => {
                    if (c === container) return;
                    const other = c.querySelector(`.task-cb[data-task-index="${cb.dataset.taskIndex}"]`);
                    if (other) other.checked = cb.checked;
                });
            });
        });
    });
}

function schedRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; render(); });
}

/* ══ TOC ═══════════════════════════════════════════════════ */
function buildTOC(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const heads = tmp.querySelectorAll('h1[id],h2[id],h3[id],h4[id]');
    if (heads.length < 2) { tocEl.classList.remove('show'); return; }
    tocNav.innerHTML = '';
    heads.forEach(h => {
        const a = document.createElement('a');
        a.className = 'toc-a';
        a.dataset.id = h.id;
        a.dataset.lv = h.tagName[1];
        a.textContent = h.textContent.replace('#','').trim();
        a.addEventListener('click', e => {
            e.preventDefault();
            prevBody.parentElement.querySelector('#' + CSS.escape(h.id))?.scrollIntoView({ behavior:'smooth', block:'start' });
        });
        tocNav.appendChild(a);
    });
    if (!tocUserHidden) {
        tocEl.classList.add('show');
        $('btn-toc').style.color = 'var(--accent)';
        $('btn-toc').style.borderColor = 'var(--accent)';
    }
    setupTOCObserver();
}

function setupTOCObserver() {
    if (tocObserver) tocObserver.disconnect();
    const heads = prevBody.querySelectorAll('h1[id],h2[id],h3[id],h4[id]');
    if (!heads.length) return;
    tocObserver = new IntersectionObserver(entries => {
        entries.forEach(e => {
            if (e.isIntersecting)
                tocNav.querySelectorAll('.toc-a').forEach(a =>
                    a.classList.toggle('active', a.dataset.id === e.target.id));
        });
    }, { root: $('prev-scroll'), rootMargin: '-10% 0px -80% 0px', threshold: 0 });
    heads.forEach(h => tocObserver.observe(h));
}

/* ══ Line numbers ═════════════════════════════════════════ */
function setLnums(src, el, curLine) {
    const n = src.split('\n').length;
    // For large files, skip per-line spans — use a single block
    if (n > 3000) {
        const nums = [];
        for (let i = 1; i <= n; i++) nums.push(i);
        el.textContent = nums.join('\n');
        el.style.whiteSpace = 'pre';
        return;
    }
    el.style.whiteSpace = '';
    el.innerHTML = Array.from({ length: n }, (_, i) =>
        `<span class="ln${i + 1 === curLine ? ' cur' : ''}">${i + 1}</span>`
    ).join('');
}

function syncScroll(ta, nl) { nl.scrollTop = ta.scrollTop; }

/* ══ Stats ═════════════════════════════════════════════════ */
function updateStats() {
    const words = MD.trim() ? MD.trim().split(/\s+/).length : 0;
    const lines = MD.split('\n').length;
    const chars = MD.length;
    const mins  = Math.max(1, Math.round(words / 200));
    $('sb-w').textContent = words.toLocaleString();
    $('sb-l').textContent = lines.toLocaleString();
    $('sb-c').textContent = chars.toLocaleString();
    $('sb-r').textContent = `~${mins} min`;
}

/* ══ Dirty tracking + auto-save ═══════════════════════════ */
function markDirty() {
    isDirty = true;
    document.title = (fname ? fname : 'untitled.md') + ' * \u2014 Markdown.View';
    schedAutoSave();
    // Sync tab dirty state
    const tab = openTabs.find(t => t.id === activeTabId);
    if (tab) { tab.isDirty = true; renderFileTabs(); }
}

function markClean() {
    isDirty = false;
    document.title = (fname ? fname : 'untitled.md') + ' \u2014 Markdown.View';
    const tab = openTabs.find(t => t.id === activeTabId);
    if (tab) { tab.isDirty = false; renderFileTabs(); }
}

function schedAutoSave() {
    clearTimeout(autoSaveTimer);
    if (!currentFilePath) return;
    autoSaveTimer = setTimeout(async () => {
        if (isDirty && currentFilePath) {
            const ok = await window.electronAPI.saveFile(currentFilePath, MD);
            if (ok) { markClean(); toast('\u2713 Auto-saved'); }
        }
    }, 3000);
}

/* ══ Tab switching ═════════════════════════════════════════ */
function setTab(tab) {
    curTab = tab;
    localStorage.setItem('mdv_tab', tab);
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
    $('panel-' + tab).classList.add('on');
    document.querySelectorAll('.t-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $('sb-tab').textContent = tab;

    const btn = document.querySelector(`.t-btn[data-tab="${tab}"]`);
    if (btn) {
        const sr = tabs.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        pill.style.left  = (br.left - sr.left - 3) + 'px';
        pill.style.width = br.width + 'px';
    }

    if (tab !== 'raw') render();
    if (tab === 'split') {
        splitEd.value = MD;
        setLnums(MD, splitLnums);
    }

    // Re-sync side panel states after tab switch
    fileSidebar.classList.toggle('hidden', !sidebarVisible);
    if (tocUserHidden) tocEl.classList.remove('show');
    updateSidebarBtn();
    updateTocBtn();
}

tabs.addEventListener('click', e => {
    const btn = e.target.closest('.t-btn');
    if (btn) setTab(btn.dataset.tab);
});

/* ══ File tabs management ═════════════════════════════════ */
function saveActiveTabState() {
    if (!activeTabId) return;
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab) return;
    tab.content = MD;
    tab.isDirty = isDirty;
    tab.scrollTop = $('prev-scroll')?.scrollTop || 0;
    tab.viewTab = curTab;
    // Persist scroll to localStorage
    saveFileScroll(tab.path, tab.scrollTop, tab.viewTab);
}

let dragTabId = null;
const dropIndicator = $('tab-drop-indicator');
const tabCtxMenu = $('tab-ctx-menu');
let tabCtxTargetId = null;

function renderFileTabs() {
    // Remove old tab elements but keep the drop indicator
    fileTabsBar.querySelectorAll('.ftab').forEach(el => el.remove());
    if (!openTabs.length) { fileTabsBar.classList.remove('show'); return; }
    fileTabsBar.classList.add('show');

    openTabs.forEach(tab => {
        const el = document.createElement('div');
        el.className = 'ftab' + (tab.id === activeTabId ? ' active' : '') + (tab.isDirty ? ' dirty' : '') + (tab.pinned ? ' pinned' : '');
        el.dataset.tabId = tab.id;
        el.draggable = true;
        el.innerHTML = `${tab.pinned ? '<span class="ftab-pin-icon">\uD83D\uDCCC</span>' : ''}<span class="ftab-name">${esc(tab.name)}</span><button class="ftab-close">\u2715</button>`;

        // Click to switch
        el.addEventListener('click', e => {
            if (e.target.closest('.ftab-close')) return;
            switchToTab(tab.id);
        });
        // Middle-click to close
        el.addEventListener('mousedown', e => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } });
        el.querySelector('.ftab-close').addEventListener('click', e => { e.stopPropagation(); closeTab(tab.id); });

        // Right-click → context menu
        el.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            tabCtxTargetId = tab.id;
            $('tab-ctx-pin').textContent = (tab.pinned ? '\uD83D\uDCCC Unpin tab' : '\uD83D\uDCCC Pin tab');
            tabCtxMenu.style.left = e.clientX + 'px';
            tabCtxMenu.style.top = e.clientY + 'px';
            tabCtxMenu.classList.add('show');
        });

        // Drag to reorder
        el.addEventListener('dragstart', e => {
            dragTabId = tab.id;
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        el.addEventListener('dragend', () => {
            dragTabId = null;
            el.classList.remove('dragging');
            dropIndicator.classList.remove('show');
        });
        el.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragTabId === tab.id) { dropIndicator.classList.remove('show'); return; }
            const rect = el.getBoundingClientRect();
            const barRect = fileTabsBar.getBoundingClientRect();
            const mid = rect.left + rect.width / 2;
            const x = (e.clientX < mid ? rect.left : rect.right) - barRect.left + fileTabsBar.scrollLeft;
            dropIndicator.style.left = x + 'px';
            dropIndicator.classList.add('show');
        });
        el.addEventListener('dragleave', () => {});
        el.addEventListener('drop', e => {
            e.preventDefault();
            dropIndicator.classList.remove('show');
            if (!dragTabId || dragTabId === tab.id) return;
            const fromIdx = openTabs.findIndex(t => t.id === dragTabId);
            const toIdx = openTabs.findIndex(t => t.id === tab.id);
            if (fromIdx === -1 || toIdx === -1) return;
            const rect = el.getBoundingClientRect();
            const mid = rect.left + rect.width / 2;
            const insertBefore = e.clientX < mid;
            const [moved] = openTabs.splice(fromIdx, 1);
            let newIdx = openTabs.findIndex(t => t.id === tab.id);
            if (!insertBefore) newIdx++;
            openTabs.splice(newIdx, 0, moved);
            renderFileTabs();
        });

        fileTabsBar.appendChild(el);
    });
    // Scroll active tab into view
    const activeEl = fileTabsBar.querySelector('.ftab.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Tab context menu actions
document.addEventListener('click', () => tabCtxMenu.classList.remove('show'));
window.addEventListener('blur', () => tabCtxMenu.classList.remove('show'));

$('tab-ctx-pin').addEventListener('click', () => {
    tabCtxMenu.classList.remove('show');
    const tab = openTabs.find(t => t.id === tabCtxTargetId);
    if (tab) { tab.pinned = !tab.pinned; renderFileTabs(); }
});
$('tab-ctx-close').addEventListener('click', () => {
    tabCtxMenu.classList.remove('show');
    if (tabCtxTargetId) closeTab(tabCtxTargetId);
});
$('tab-ctx-close-others').addEventListener('click', () => {
    tabCtxMenu.classList.remove('show');
    const keep = openTabs.filter(t => t.id === tabCtxTargetId || t.pinned);
    openTabs.length = 0;
    openTabs.push(...keep);
    if (!openTabs.find(t => t.id === activeTabId) && openTabs.length) {
        activeTabId = openTabs[0].id;
        loadTabIntoEditor(openTabs[0]);
    }
    renderFileTabs();
    renderFileList();
});

function switchToTab(tabId) {
    if (tabId === activeTabId) return;
    saveActiveTabState();
    const tab = openTabs.find(t => t.id === tabId);
    if (!tab) return;
    activeTabId = tabId;
    loadTabIntoEditor(tab);
    renderFileTabs();
    renderFileList();
}

function loadTabIntoEditor(tab) {
    MD = tab.content;
    fname = tab.name;
    currentFilePath = tab.path;
    isDirty = tab.isDirty;
    $('fname-display').value = fname;
    rawEditor.value = MD;
    splitEd.value = MD;
    setLnums(MD, lnums);
    setLnums(MD, splitLnums);
    updateStats();
    if (tab.isDirty) markDirty(); else markClean();
    // Defer heavy render so UI / loader can paint first
    const isLarge = MD.length > 50000;
    if (isLarge) showLoader('rendering…');
    setTimeout(() => {
        setTab(tab.viewTab || curTab);
        if (isLarge) hideLoader();
        // Restore scroll position
        setTimeout(() => { if ($('prev-scroll')) $('prev-scroll').scrollTop = tab.scrollTop || 0; }, 50);
    }, isLarge ? 20 : 0);
}

function closeTab(tabId) {
    const idx = openTabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    openTabs.splice(idx, 1);
    if (tabId === activeTabId) {
        if (openTabs.length) {
            const newIdx = Math.min(idx, openTabs.length - 1);
            activeTabId = openTabs[newIdx].id;
            loadTabIntoEditor(openTabs[newIdx]);
        } else {
            activeTabId = null;
            currentFilePath = null;
            MD = '';
            fname = 'untitled.md';
            workspace.classList.remove('active');
            landing.classList.remove('hidden');
        }
    }
    renderFileTabs();
    renderFileList();
}

function openInTab(src, name, filePath) {
    // Check if already open
    if (filePath) {
        const existing = openTabs.find(t => t.path === filePath);
        if (existing) { switchToTab(existing.id); return; }
    }
    saveActiveTabState();
    const id = ++tabIdCounter;
    const saved = getFileScroll(filePath);
    const tab = { id, path: filePath, name: name || 'untitled.md', content: src, isDirty: false, scrollTop: saved?.scrollTop || 0, viewTab: saved?.viewTab || curTab };
    openTabs.push(tab);
    activeTabId = id;
    loadTabIntoEditor(tab);
    landing.classList.add('hidden');
    workspace.classList.add('active');
    renderFileTabs();
    renderFileList();
}

/* ══ Enter workspace (from file or paste) ═════════════════ */
function enter(src, name, filePath = null) {
    openInTab(src, name, filePath);
}

/* ══ Landing actions ══════════════════════════════════════ */
$('btn-go').addEventListener('click', () => {
    const src = landTA.value || '';
    const isLarge = src.length > 50000;
    if (isLarge) showLoader('rendering…');
    // Yield so loader paints before heavy work
    setTimeout(() => {
        enter(src, 'untitled.md');
        setTab('preview');
        if (isLarge) hideLoader();
    }, isLarge ? 20 : 0);
});

landTA.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('btn-go').click(); }
    if (e.key === 'Tab') {
        e.preventDefault();
        const s = landTA.selectionStart, f = landTA.selectionEnd;
        landTA.value = landTA.value.slice(0, s) + '    ' + landTA.value.slice(f);
        landTA.selectionStart = landTA.selectionEnd = s + 4;
    }
});

$('btn-open-folder').addEventListener('click', pickFolder);

/* ══ Landing drop-zone: drag & drop folder from Explorer ═ */
const dropZone = $('btn-open-folder');
dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    dropZone.classList.add('drag-active');
});
dropZone.addEventListener('dragleave', e => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-active');
});
dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-active');
    const files = e.dataTransfer.files;
    if (!files.length) return;
    // Use the first dropped item's path
    const droppedPath = files[0].path;
    if (!droppedPath) return;
    // Check if it's a directory by trying to scan it
    const results = await window.electronAPI.scanDir(droppedPath);
    if (results !== null) {
        await openFolderByPath(droppedPath);
    }
});

// Prevent stray drops from navigating the window
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

/* ══ Filename rename ═════════════════════════════════════ */
const fnameInput = $('fname-display');
fnameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); fnameInput.blur(); }
    if (e.key === 'Escape') { fnameInput.value = fname; fnameInput.blur(); }
});
fnameInput.addEventListener('blur', async () => {
    let newName = fnameInput.value.trim() || fname;
    if (!newName.match(/\.[a-zA-Z]+$/)) newName += '.md';
    if (newName === fname) { fnameInput.value = fname; return; }
    // If file exists on disk, rename via save-as
    if (currentFilePath) {
        const dir = currentFilePath.replace(/[\\/][^\\/]+$/, '');
        const newPath = dir + (dir.includes('/') ? '/' : '\\') + newName;
        const ok = await window.electronAPI.saveFile(newPath, MD);
        if (ok) {
            currentFilePath = newPath;
            fname = newName;
            fnameInput.value = fname;
            markClean();
            toast('\u2713 Renamed \u2192 ' + fname);
        }
    } else {
        fname = newName;
        fnameInput.value = fname;
    }
    document.title = fname + ' \u2014 Markdown.View';
});
fnameInput.addEventListener('click', e => e.stopPropagation());

/* ══ Logo → Home ═════════════════════════════════════════ */
$('logo').addEventListener('click', () => {
    clearTimeout(autoSaveTimer);
    saveActiveTabState();
    workspace.classList.remove('active');
    landing.classList.remove('hidden');
    fileTabsBar.classList.remove('show');
    // Collapse both side panels
    fileSidebar.classList.add('hidden');
    sidebarVisible = false;
    updateSidebarBtn();
    setTocHidden(true);
    renderRecentFolders();
});

/* ══ File sidebar ════════════════════════════════════════ */
let sidebarVisible = localStorage.getItem('mdv_sidebar') !== '0';
if (!sidebarVisible) fileSidebar.classList.add('hidden');

function updateSidebarBtn() {
    $('btn-sidebar').classList.toggle('active', sidebarVisible);
}
updateSidebarBtn();

$('btn-sidebar').addEventListener('click', () => {
    sidebarVisible = !sidebarVisible;
    fileSidebar.classList.toggle('hidden', !sidebarVisible);
    localStorage.setItem('mdv_sidebar', sidebarVisible ? '1' : '0');
    updateSidebarBtn();
});

/* ── Sidebar resize drag ─────────────────────── */
(function() {
    const handle = $('sidebar-resize');
    let dragging = false;
    handle.addEventListener('mousedown', e => {
        e.preventDefault();
        dragging = true;
        handle.classList.add('drag');
        document.body.style.cssText += 'cursor:col-resize;user-select:none';
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        const newW = Math.max(180, Math.min(500, e.clientX));
        fileSidebar.style.width = newW + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('drag');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('mdv_sidebar_w', fileSidebar.offsetWidth);
    });
    // Restore saved width
    const savedW = localStorage.getItem('mdv_sidebar_w');
    if (savedW) fileSidebar.style.width = savedW + 'px';
})();

$('btn-change-dir').addEventListener('click', pickFolder);

// Allow pasting/typing a path and pressing Enter to open it
$('sidebar-dir').addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const dir = $('sidebar-dir').value.trim();
        if (dir) await openFolderByPath(dir);
        $('sidebar-dir').blur();
    }
    if (e.key === 'Escape') { $('sidebar-dir').value = watchedDir || ''; $('sidebar-dir').blur(); }
});

$('sidebar-search').addEventListener('input', e => {
    sidebarSearchQ = e.target.value;
    renderFileList();
});

async function pickFolder() {
    const dir = await window.electronAPI.pickFolder();
    if (!dir) return;
    await openFolderByPath(dir);
}

async function openFolderByPath(dir) {
    watchedDir = dir;
    $('sidebar-dir').value = dir;
    $('sidebar-dir').title = dir;
    $('sb-watch').textContent = 'on';
    localStorage.setItem('mdv_last_dir', dir);
    addRecentFolder(dir);

    // Show sidebar if hidden
    if (!sidebarVisible) {
        sidebarVisible = true;
        fileSidebar.classList.remove('hidden');
        localStorage.setItem('mdv_sidebar', '1');
        updateSidebarBtn();
    }

    // Hide landing, show workspace + restore tab bar
    landing.classList.add('hidden');
    workspace.classList.add('active');
    if (openTabs.length) renderFileTabs();

    // Show loader while scanning
    showLoader('scanning…');

    // Scan (yield to let spinner paint)
    await new Promise(r => setTimeout(r, 0));
    allFiles = await window.electronAPI.scanDir(dir, MD_EXTENSIONS);
    allFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

    showLoader('indexing ' + allFiles.length + ' files…');
    await new Promise(r => setTimeout(r, 0));

    // Default: start with all folders collapsed
    collapseAllFolders();
    renderFileList();

    // Prune scroll memory for files that no longer exist
    pruneScrollMem(allFiles.map(f => f.path));

    // Auto-open first file if nothing is open
    if (!currentFilePath && allFiles.length) {
        showLoader('opening…');
        await openFile(allFiles[0]);
    }

    // Watch
    await window.electronAPI.watchDir(dir, MD_EXTENSIONS);
    hideLoader();
    codeScannedFolders.clear();
    toast('✓ Watching ' + dir.split(/[\\/]/).pop());
}

/* ══ Recent folders history ══════════════════════════════ */
const RF_KEY = 'mdv_recent_folders';
const RF_MAX = 10;

function loadRecentFolders() {
    try { return JSON.parse(localStorage.getItem(RF_KEY) || '[]'); }
    catch { return []; }
}

function saveRecentFolders(arr) {
    localStorage.setItem(RF_KEY, JSON.stringify(arr.slice(0, RF_MAX)));
}

function addRecentFolder(dirPath) {
    const arr = loadRecentFolders().filter(f => f.path !== dirPath);
    const name = dirPath.split(/[\\/]/).pop();
    arr.unshift({ path: dirPath, name, ts: Date.now() });
    saveRecentFolders(arr);
    renderRecentFolders();
}

function formatRelTime(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return d + 'd ago';
    if (h > 0) return h + 'h ago';
    if (m > 0) return m + 'm ago';
    return 'just now';
}

function renderRecentFolders() {
    const sec  = $('recent-folders');
    const list = $('recent-folders-list');
    const arr  = loadRecentFolders();
    if (!arr.length) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    list.innerHTML = '';

    arr.forEach(item => {
        const card = document.createElement('div');
        card.className = 'rf-card';
        card.innerHTML = `<span class="rf-icon">\uD83D\uDCC1</span><div class="rf-info"><div class="rf-name">${esc(item.name)}</div><div class="rf-path">${esc(item.path)}</div></div><div class="rf-meta">${formatRelTime(item.ts)}</div><button class="rf-del" title="Remove">\u2715</button>`;

        card.addEventListener('click', async e => {
            if (e.target.closest('.rf-del')) return;
            await openFolderByPath(item.path);
        });

        card.querySelector('.rf-del').addEventListener('click', e => {
            e.stopPropagation();
            const updated = loadRecentFolders().filter(f => f.path !== item.path);
            saveRecentFolders(updated);
            renderRecentFolders();
        });

        list.appendChild(card);
    });
}

$('recent-folders-clear').addEventListener('click', () => {
    localStorage.removeItem(RF_KEY);
    renderRecentFolders();
});

// Render on page load
renderRecentFolders();

// Track which folders are collapsed (persisted per session)
const collapsedFolders = new Set(
    JSON.parse(localStorage.getItem('mdv_collapsed') || '[]')
);
function saveCollapsed() {
    localStorage.setItem('mdv_collapsed', JSON.stringify([...collapsedFolders]));
}

// Recursively collapse or expand a folder DOM element and all its descendant folders
function toggleSubtree(folderEl, folderPath, treeNode, collapse) {
    if (collapse) {
        folderEl.classList.add('collapsed');
        collapsedFolders.add(folderPath);
    } else {
        folderEl.classList.remove('collapsed');
        collapsedFolders.delete(folderPath);
    }
    // Find child .tree-folder elements and recurse
    const childFolders = folderEl.querySelectorAll(':scope > .tree-children > .tree-folder');
    const subKeys = Object.keys(treeNode).filter(k => k !== '_files').sort();
    childFolders.forEach((childEl, i) => {
        const key = subKeys[i];
        if (!key) return;
        const childPath = folderPath ? folderPath + '/' + key : key;
        toggleSubtree(childEl, childPath, treeNode[key], collapse);
    });
}

// Collapse/expand all helpers
let allCollapsed = true;

function collapseAllFolders() {
    allFiles.forEach(f => {
        if (f.dir) {
            const parts = f.dir.split('/');
            let p = '';
            parts.forEach(seg => { p = p ? p + '/' + seg : seg; collapsedFolders.add(p); });
        }
    });
    allCollapsed = true;
    saveCollapsed();
    syncCollapseBtn();
    // Update DOM if already rendered
    fileList.querySelectorAll('.tree-folder').forEach(el => el.classList.add('collapsed'));
}

function expandAllFolders() {
    collapsedFolders.clear();
    allCollapsed = false;
    saveCollapsed();
    syncCollapseBtn();
    fileList.querySelectorAll('.tree-folder').forEach(el => el.classList.remove('collapsed'));
}

function syncCollapseBtn() {
    $('btn-collapse-all').textContent = allCollapsed ? '\u25B6' : '\u25BC';
    $('btn-collapse-all').title = allCollapsed ? 'Expand all folders' : 'Collapse all folders';
}
syncCollapseBtn();

$('btn-collapse-all').addEventListener('click', () => {
    if (allCollapsed) expandAllFolders();
    else collapseAllFolders();
});

function renderFileList() {
    const q = sidebarSearchQ.toLowerCase().trim();
    const filtered = q
        ? allFiles.filter(f => f.relPath.toLowerCase().includes(q))
        : allFiles;

    $('sidebar-count').textContent = filtered.length + ' file' + (filtered.length !== 1 ? 's' : '');

    // Build tree into a DocumentFragment off-DOM, then swap in one shot
    const frag = document.createDocumentFragment();

    // Build tree structure: { _files: [], subfolder: { _files: [], ... } }
    const tree = { _files: [] };
    filtered.forEach(f => {
        const parts = f.dir ? f.dir.split('/') : [];
        let node = tree;
        for (const p of parts) {
            if (!node[p]) node[p] = { _files: [] };
            node = node[p];
        }
        node._files.push(f);
    });

    // Recursively render tree into DOM
    function renderNode(node, parentEl, pathPrefix, depth) {
        // Collect all children (files + subfolders) to determine last item for └ vs ├
        const subKeys = Object.keys(node).filter(k => k !== '_files').sort();
        const allChildren = [];
        node._files.forEach(f => allChildren.push({ type: 'file', data: f }));
        subKeys.forEach(k => allChildren.push({ type: 'folder', key: k }));

        allChildren.forEach((child, idx) => {
            const isLast = idx === allChildren.length - 1;
            const branch = depth > 0 ? (isLast ? '\u2514' : '\u251C') : '';

            if (child.type === 'file') {
                const f = child.data;
                const el = document.createElement('div');
                el.className = 'file-item' + (f.path === currentFilePath ? ' active' : '');
                el.dataset.path = f.path;
                el.style.paddingLeft = (depth > 0 ? 12 : 8) + 'px';
                const sizeStr = f.size < 1024 ? f.size + 'B' : (f.size / 1024).toFixed(1) + 'KB';
                el.innerHTML = `${branch ? `<span class="tree-branch">${branch}</span>` : ''}<svg class="fi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span class="fi-name">${esc(f.name)}</span><span class="fi-size">${sizeStr}</span><span class="fi-dot" id="dot-${btoa(f.path).replace(/[^a-zA-Z0-9]/g,'')}"></span>`;
                el.addEventListener('click', () => openFile(f));
                el.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e, f.path, false); });
                parentEl.appendChild(el);
            } else {
                const key = child.key;
                const folderPath = pathPrefix ? pathPrefix + '/' + key : key;
                const subNode = node[key];
                const fileCount = countFiles(subNode);

                const folder = document.createElement('div');
                folder.className = 'tree-folder';
                if (collapsedFolders.has(folderPath)) folder.classList.add('collapsed');

                // Header
                const hdr = document.createElement('div');
                hdr.className = 'tree-folder-hdr';
                hdr.style.paddingLeft = (depth > 0 ? 4 : 4) + 'px';
                const isScanned = codeScannedFolders.has(folderPath);
                hdr.innerHTML = `${branch ? `<span class="tree-branch">${branch}</span>` : ''}<span class="tree-chevron">\u25BC</span><span class="tree-folder-icon">\uD83D\uDCC1</span><span class="tree-folder-name">${esc(key)}</span><span class="tree-folder-count">${fileCount}</span><button class="folder-code-btn${isScanned ? ' active' : ''}" title="${isScanned ? 'Hide code files' : 'Scan code files (.cs, .js, .py, ...)'}">{&nbsp;}</button>`;
                hdr.addEventListener('click', (e) => {
                    if (e.target.closest('.folder-code-btn')) return;
                    if (e.altKey) {
                        // Alt+click: toggle entire subtree recursively
                        const shouldCollapse = !folder.classList.contains('collapsed');
                        toggleSubtree(folder, folderPath, subNode, shouldCollapse);
                        saveCollapsed();
                    } else {
                        folder.classList.toggle('collapsed');
                        if (folder.classList.contains('collapsed')) collapsedFolders.add(folderPath);
                        else collapsedFolders.delete(folderPath);
                        saveCollapsed();
                    }
                });
                // Code scan toggle on the folder
                hdr.querySelector('.folder-code-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleCodeScanForFolder(folderPath);
                });
                const absFolderPath = watchedDir + (watchedDir.includes('/') ? '/' : '\\') + folderPath.replace(/\//g, watchedDir.includes('/') ? '/' : '\\');
                hdr.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); showCtxMenu(e, absFolderPath, true); });
                folder.appendChild(hdr);

                // Children container
                const children = document.createElement('div');
                children.className = 'tree-children';
                renderNode(subNode, children, folderPath, depth + 1);
                folder.appendChild(children);

                parentEl.appendChild(folder);
            }
        });
    }

    function countFiles(node) {
        let c = node._files.length;
        for (const k of Object.keys(node)) {
            if (k !== '_files') c += countFiles(node[k]);
        }
        return c;
    }

    renderNode(tree, frag, '', 0);
    fileList.innerHTML = '';
    fileList.appendChild(frag);
}

async function openFile(fileInfo) {
    showLoader('opening…');
    const content = await window.electronAPI.readFile(fileInfo.path);
    if (content === null) { hideLoader(); toast('\u26A0 Could not read file'); return; }
    // Auto-enable code preview rendering when opening a code file
    if (isCodeFile(fileInfo.path) && !codePreviewEnabled) {
        codePreviewEnabled = true;
        syncCodePreviewBtn();
    }
    enter(content, fileInfo.name, fileInfo.path);
    hideLoader();
}

/* ══ File system events (chokidar) ═══════════════════════ */
window.electronAPI.onFsAdd(data => {
    // Avoid dupes
    if (allFiles.find(f => f.path === data.path)) return;
    allFiles.push(data);
    allFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));
    renderFileList();
    toast('\u2795 ' + data.name);
});

window.electronAPI.onFsChange(async data => {
    // Update metadata
    const idx = allFiles.findIndex(f => f.path === data.path);
    if (idx !== -1) { allFiles[idx].size = data.size; allFiles[idx].mtime = data.mtime; }

    // Check if this file is open in any tab
    const tab = openTabs.find(t => t.path === data.path);
    if (tab && !tab.isDirty) {
        const content = await window.electronAPI.readFile(data.path);
        if (content !== null && content !== tab.content) {
            tab.content = content;
            // If it's the active tab, reload the editor
            if (tab.id === activeTabId) {
                MD = content;
                rawEditor.value = MD;
                splitEd.value = MD;
                setLnums(MD, lnums);
                setLnums(MD, splitLnums);
                updateStats();
                if (curTab !== 'raw') render();
                toast('\u21BB ' + fname + ' reloaded');
            }
        }
    }
    renderFileList();
});

window.electronAPI.onFsUnlink(data => {
    allFiles = allFiles.filter(f => f.path !== data.path);
    removeFileScroll(data.path);
    renderFileList();
    if (data.path === currentFilePath) {
        toast('\u26A0 ' + fname + ' was deleted externally');
        currentFilePath = null;
    }
    toast('\u2796 ' + data.path.split(/[\\/]/).pop());
});

/* ══ Raw editor ════════════════════════════════════════════ */
rawEditor.addEventListener('input', () => {
    MD = rawEditor.value;
    const cur = rawEditor.value.slice(0, rawEditor.selectionStart).split('\n').length;
    setLnums(MD, lnums, cur);
    schedRender();
    updateStats();
    markDirty();
});
rawEditor.addEventListener('scroll', () => {
    syncScroll(rawEditor, lnums);
    _syncBackdrop(rawEditor, $('raw-backdrop'));
});
rawEditor.addEventListener('keydown', editorKeys);
rawEditor.addEventListener('click', () => {
    const cur = rawEditor.value.slice(0, rawEditor.selectionStart).split('\n').length;
    setLnums(MD, lnums, cur);
});
rawEditor.addEventListener('keyup', () => {
    const cur = rawEditor.value.slice(0, rawEditor.selectionStart).split('\n').length;
    setLnums(MD, lnums, cur);
});

splitEd.addEventListener('input', () => {
    MD = splitEd.value;
    rawEditor.value = MD;
    setLnums(MD, splitLnums);
    schedRender();
    markDirty();
});
splitEd.addEventListener('scroll', () => {
    syncScroll(splitEd, splitLnums);
    _syncBackdrop(splitEd, $('split-backdrop'));
});
splitEd.addEventListener('keydown', editorKeys);

function editorKeys(e) {
    const ta = e.target;
    // Tab → 4 spaces
    if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, f = ta.selectionEnd;
        if (s === f) {
            ta.value = ta.value.slice(0,s) + '    ' + ta.value.slice(f);
            ta.selectionStart = ta.selectionEnd = s + 4;
        } else {
            const lines = ta.value.split('\n');
            let cs = 0;
            const sel = { s, f };
            const out = lines.map(line => {
                const ls = cs, le = cs + line.length;
                cs = le + 1;
                if (ls <= sel.f && le >= sel.s) return '    ' + line;
                return line;
            });
            ta.value = out.join('\n');
        }
        MD = ta.value;
        rawEditor.value = MD; splitEd.value = MD;
        setLnums(MD, ta === rawEditor ? lnums : splitLnums);
        schedRender();
        markDirty();
    }
    // Ctrl+Enter → preview
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); setTab('preview'); }
    // Ctrl+S → save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentFile(); }
    // Auto-pairs
    const pairs = { '(':')', '[':']', '{':'}', '"':'"', "'":"'", '`':'`' };
    if (pairs[e.key]) {
        const s = ta.selectionStart, f = ta.selectionEnd;
        if (s !== f) {
            e.preventDefault();
            const sel = ta.value.slice(s, f);
            ta.value = ta.value.slice(0,s) + e.key + sel + pairs[e.key] + ta.value.slice(f);
            ta.selectionStart = s + 1; ta.selectionEnd = f + 1;
            MD = ta.value; rawEditor.value = MD; splitEd.value = MD;
            schedRender();
            markDirty();
        }
    }
    // Enter in list item → continue list
    if (e.key === 'Enter') {
        const s = ta.selectionStart;
        const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
        const line = ta.value.slice(lineStart, s);
        const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s/);
        if (listMatch) {
            e.preventDefault();
            const prefix = listMatch[1] + listMatch[2] + ' ';
            ta.value = ta.value.slice(0, s) + '\n' + prefix + ta.value.slice(s);
            ta.selectionStart = ta.selectionEnd = s + 1 + prefix.length;
            MD = ta.value; rawEditor.value = MD; splitEd.value = MD;
            setLnums(MD, ta === rawEditor ? lnums : splitLnums);
            schedRender();
            markDirty();
        }
    }
}

/* ══ Tab shortcuts: Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+W ═════ */
// Handled via IPC from main process (Chromium swallows Ctrl+Tab before DOM keydown)
window.electronAPI.onSwitchTab(dir => {
    if (openTabs.length < 2) return;
    const curIdx = openTabs.findIndex(t => t.id === activeTabId);
    const next = (curIdx + dir + openTabs.length) % openTabs.length;
    switchToTab(openTabs[next].id);
});
window.electronAPI.onCloseTab(() => {
    if (activeTabId) closeTab(activeTabId);
});

/* ══ Global Ctrl+S ═════════════════════════════════════════ */
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveCurrentFile();
    }
});

/* ══ Context menu ═════════════════════════════════════════ */
const ctxMenu = $('ctx-menu');
let ctxTargetPath = '';
let ctxIsFolder = false;

function showCtxMenu(e, targetPath, isFolder) {
    ctxTargetPath = targetPath;
    ctxIsFolder = isFolder;
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top = e.clientY + 'px';
    // Show/hide folder-specific item
    $('ctx-open-folder').style.display = isFolder ? '' : 'none';
    ctxMenu.classList.add('show');
    // Reposition if off-screen
    requestAnimationFrame(() => {
        const r = ctxMenu.getBoundingClientRect();
        if (r.right > window.innerWidth) ctxMenu.style.left = (window.innerWidth - r.width - 4) + 'px';
        if (r.bottom > window.innerHeight) ctxMenu.style.top = (window.innerHeight - r.height - 4) + 'px';
    });
}

function hideCtxMenu() { ctxMenu.classList.remove('show'); }

document.addEventListener('click', hideCtxMenu);
document.addEventListener('contextmenu', e => {
    if (!e.target.closest('#file-list') && !e.target.closest('#ctx-menu')) hideCtxMenu();
});
window.addEventListener('blur', hideCtxMenu);

$('ctx-open-explorer').addEventListener('click', () => {
    hideCtxMenu();
    if (ctxTargetPath) window.electronAPI.showInExplorer(ctxTargetPath);
});

$('ctx-open-folder').addEventListener('click', () => {
    hideCtxMenu();
    if (ctxTargetPath) window.electronAPI.openFolderInExplorer(ctxTargetPath);
});

$('ctx-copy-path').addEventListener('click', async () => {
    hideCtxMenu();
    if (ctxTargetPath) { await doCopy(ctxTargetPath); toast('\u2713 Path copied'); }
});

/* ══ Save ══════════════════════════════════════════════════ */
async function saveCurrentFile() {
    if (currentFilePath) {
        const ok = await window.electronAPI.saveFile(currentFilePath, MD);
        if (ok) { markClean(); toast('\u2713 Saved ' + fname); }
        else toast('\u26A0 Save failed');
    } else {
        const saved = await window.electronAPI.saveFileAs(fname, MD);
        if (saved) {
            currentFilePath = saved;
            fname = saved.split(/[\\/]/).pop();
            $('fname-display').value = fname;
            markClean();
            toast('\u2713 Saved ' + fname);
        }
    }
}

$('btn-save').addEventListener('click', saveCurrentFile);

/* ══ Paste detection (landing) ═════════════════════════════ */
document.addEventListener('paste', e => {
    if (workspace.classList.contains('active')) return;
    if (document.activeElement === landTA) return;
    const t = e.clipboardData.getData('text/plain');
    if (t && t.trim()) { landTA.value = t; enter(t, 'pasted.md'); setTab('preview'); }
});

/* ══ Copy & Download ══════════════════════════════════════ */
async function doCopy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
        const ta = Object.assign(document.createElement('textarea'), { value: text });
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
    }
}

$('btn-copy-md').addEventListener('click', async () => { await doCopy(MD); toast('\u2713 Markdown copied'); });
$('btn-copy-html').addEventListener('click', async () => {
    await doCopy(renderMD(MD)); toast('\u2713 HTML copied');
});
$('btn-dl').addEventListener('click', async () => {
    const saved = await window.electronAPI.saveFileAs(fname, MD);
    if (saved) toast('\u2713 Downloaded');
});

// Code block copy button (called from inline HTML)
window.copyCode = async function(btn, enc) {
    await doCopy(decodeURIComponent(enc));
    btn.textContent = '\u2713 Copied'; btn.classList.add('ok');
    setTimeout(() => { btn.textContent = '\u2398 Copy'; btn.classList.remove('ok'); }, 1500);
};

/* ══ TOC toggle ════════════════════════════════════════════ */
let tocUserHidden = localStorage.getItem('mdv_toc_hidden') === '1';

function setTocHidden(hide) {
    tocUserHidden = hide;
    localStorage.setItem('mdv_toc_hidden', hide ? '1' : '0');
    if (hide) {
        tocEl.classList.remove('show');
        tocEl.style.minWidth = '';
    } else {
        // Restore saved width if any
        const savedW = localStorage.getItem('mdv_toc_w');
        if (savedW) { tocEl.style.width = savedW + 'px'; tocEl.style.minWidth = savedW + 'px'; }
    }
    updateTocBtn();
}

function updateTocBtn() {
    $('btn-toc').classList.toggle('active', tocEl.classList.contains('show'));
}

$('btn-toc').addEventListener('click', () => {
    if (tocEl.classList.contains('show')) {
        setTocHidden(true);
    } else {
        tocUserHidden = false;
        localStorage.setItem('mdv_toc_hidden', '0');
        tocEl.classList.add('show');
    }
    updateTocBtn();
});
$('toc-close').addEventListener('click', () => setTocHidden(true));

/* ── TOC resize drag ────────────────────────── */
(function() {
    const handle = $('toc-resize');
    if (!handle) return;
    let dragging = false;
    handle.addEventListener('mousedown', e => {
        e.preventDefault();
        dragging = true;
        handle.classList.add('drag');
        document.body.style.cssText += 'cursor:col-resize;user-select:none';
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        const tocRect = tocEl.parentElement.getBoundingClientRect();
        const newW = Math.max(160, Math.min(400, e.clientX - tocRect.left));
        tocEl.style.width = newW + 'px';
        tocEl.style.minWidth = newW + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('drag');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('mdv_toc_w', tocEl.offsetWidth);
    });
    const savedW = localStorage.getItem('mdv_toc_w');
    if (savedW) { tocEl.style.width = savedW + 'px'; tocEl.style.minWidth = savedW + 'px'; }
})();

/* ══ Preview width slider ═════════════════════════════════ */
const widthSlider = $('prev-width-slider');
const widthVal    = $('width-val');

function applyPreviewWidth(val) {
    const pct = val + '%';
    prevBody.style.maxWidth = pct;
    $('split-prev-body').style.maxWidth = pct;
    widthVal.textContent = val + '%';
}

(function() {
    const v = parseInt(localStorage.getItem('mdv_prev_width') || '72');
    widthSlider.value = v;
    applyPreviewWidth(v);
})();

widthSlider.addEventListener('input', () => {
    applyPreviewWidth(parseInt(widthSlider.value));
    localStorage.setItem('mdv_prev_width', widthSlider.value);
});

/* ══ Font size slider ═════════════════════════════════════ */
const fontSlider  = $('font-size-slider');
const fontSizeVal = $('font-size-val');

function applyFontSize(val) {
    document.documentElement.style.setProperty('--md-font-size', val + 'px');
    fontSizeVal.textContent = val + 'px';
}

(function() {
    const v = parseInt(localStorage.getItem('mdv_font_size') || '16');
    fontSlider.value = v;
    applyFontSize(v);
})();

fontSlider.addEventListener('input', () => {
    applyFontSize(parseInt(fontSlider.value));
    localStorage.setItem('mdv_font_size', fontSlider.value);
});

/* ══ Ctrl+/- and Ctrl+scroll = page zoom ═══════════════════ */
const webFrame = require('electron').webFrame;
let zoomLevel = parseFloat(localStorage.getItem('mdv_zoom') || '0');
webFrame.setZoomLevel(zoomLevel);

function updateZoomDisplay() {
    const pct = Math.round(Math.pow(1.2, zoomLevel) * 100);
    $('sb-zoom').textContent = pct + '%';
}
updateZoomDisplay();

function applyZoom(delta) {
    zoomLevel = Math.max(-5, Math.min(5, zoomLevel + delta));
    webFrame.setZoomLevel(zoomLevel);
    localStorage.setItem('mdv_zoom', zoomLevel);
    updateZoomDisplay();
}

function resetZoom() {
    zoomLevel = 0;
    webFrame.setZoomLevel(0);
    localStorage.setItem('mdv_zoom', '0');
    updateZoomDisplay();
}

document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(0.5); }
    else if (e.key === '-') { e.preventDefault(); applyZoom(-0.5); }
    else if (e.key === '0') { e.preventDefault(); resetZoom(); }
});

document.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    applyZoom(e.deltaY < 0 ? 0.5 : -0.5);
}, { passive: false });

$('sb-zoom-wrap').addEventListener('click', resetZoom);

/* ══ Theme toggle ═════════════════════════════════════════ */
$('btn-theme').addEventListener('click', () => {
    dark = !dark;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('btn-theme').textContent = dark ? '\uD83C\uDF19' : '\u2600\uFE0F';
    localStorage.setItem('mdv_theme', dark ? 'dark' : 'light');
});
$('btn-theme').textContent = dark ? '\uD83C\uDF19' : '\u2600\uFE0F';

/* ══ Code preview toggle (global — controls rendering of code files) ═ */
function syncCodePreviewBtn() {
    $('btn-code-preview').classList.toggle('active', codePreviewEnabled);
}
syncCodePreviewBtn();

$('btn-code-preview').addEventListener('click', () => {
    codePreviewEnabled = !codePreviewEnabled;
    syncCodePreviewBtn();
    toast(codePreviewEnabled ? '✓ Code preview ON' : '✓ Code preview OFF');
    // Re-render current file if it's a code file
    if (curTab !== 'raw') render();
});

/* ══ Find in page (Ctrl+F) — custom highlight + scroll ═══ */
const findBar   = $('find-bar');
const findInput = $('find-input');
const findCount = $('find-count');
let findOpen = false;
let findMatchIndex = -1;
let findMatches = [];          // array of <mark> elements
let findLastQuery = '';
let findDebounce = null;

function _findGetTarget() {
    if (curTab === 'preview') return { mode: 'dom', roots: [{ root: prevBody, scroll: $('prev-scroll') }] };
    if (curTab === 'raw')     return { mode: 'ta',  editors: [{ ta: rawEditor, backdrop: $('raw-backdrop') }] };
    // Split: both textarea AND preview
    return {
        mode: 'both',
        editors: [{ ta: splitEd, backdrop: $('split-backdrop') }],
        roots:   [{ root: $('split-prev-body'), scroll: $('split-prev-scroll') }],
    };
}

function _findClear() {
    // Remove <mark> highlights from preview DOM nodes
    document.querySelectorAll('#prev-body .find-hl, #split-prev-body .find-hl').forEach(m => {
        const parent = m.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
    });
    // Remove any lingering active highlight class
    document.querySelectorAll('.find-hl-active').forEach(el => el.classList.remove('find-hl-active'));
    findMatches = [];
    findMatchIndex = -1;
    // Clear backdrops
    const rb = $('raw-backdrop');
    const sb = $('split-backdrop');
    if (rb) rb.textContent = '';
    if (sb) sb.textContent = '';
    // Clear line number highlights
    document.querySelectorAll('.ln.find-ln, .ln.find-active').forEach(el => {
        el.classList.remove('find-ln', 'find-active');
    });
}

/* ── Backdrop sync: keep backdrop scroll in sync with textarea ── */
function _syncBackdrop(ta, backdrop) {
    if (!ta || !backdrop) return;
    backdrop.scrollTop = ta.scrollTop;
    backdrop.scrollLeft = ta.scrollLeft;
}

/* ── Measure monospace character width using canvas ── */
let _cachedCharWidths = new WeakMap();
function _measureCharWidth(ta) {
    if (_cachedCharWidths.has(ta)) return _cachedCharWidths.get(ta);
    const style = window.getComputedStyle(ta);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const w = ctx.measureText('0000000000').width / 10;
    _cachedCharWidths.set(ta, w);
    return w;
}

/* ── Calculate visual column accounting for tab stops ── */
function _getVisualCol(lineText, tabSize) {
    let col = 0;
    for (let i = 0; i < lineText.length; i++) {
        if (lineText[i] === '\t') col += tabSize - (col % tabSize);
        else col++;
    }
    return col;
}

/* ── Build backdrop highlights using calculated positions ── */
function _buildAndRenderBackdrop(ta, backdrop, query) {
    if (!ta || !backdrop) return [];
    const text = ta.value;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');
    const indices = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        indices.push({ index: m.index, len: m[0].length });
    }
    backdrop.innerHTML = '';
    if (!indices.length) return [];

    // Measure metrics from the textarea itself
    const style = window.getComputedStyle(ta);
    const lineH = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.65;
    const charW = _measureCharWidth(ta);
    const tabSize = parseInt(style.tabSize) || 4;
    const totalLines = text.split('\n').length;

    // Spacer provides correct scrollHeight to match textarea
    const spacer = document.createElement('div');
    spacer.style.cssText = `position:relative;height:${totalLines * lineH}px;width:${ta.scrollWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px;pointer-events:none;`;
    backdrop.appendChild(spacer);

    // Position each highlight mark at calculated coordinates
    for (let i = 0; i < indices.length; i++) {
        const { index, len } = indices[i];
        const before = text.slice(0, index);
        const lineNum = before.split('\n').length - 1;
        const lastNL = before.lastIndexOf('\n');
        const lineTextBefore = text.slice(lastNL + 1, index);
        const col = _getVisualCol(lineTextBefore, tabSize);

        const mark = document.createElement('mark');
        mark.className = 'find-hl';
        mark.dataset.findIdx = String(i);
        mark.textContent = text.slice(index, index + len);
        mark.style.cssText = `position:absolute;top:${lineNum * lineH}px;left:${col * charW}px;height:${lineH}px;line-height:${lineH}px;font-size:${style.fontSize};font-family:${style.fontFamily};`;
        spacer.appendChild(mark);
    }

    _syncBackdrop(ta, backdrop);
    return indices;
}

/* ── Highlight text nodes inside a DOM preview root ── */
function _highlightDomRoot(root, query, scrollEl) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    const marks = [];
    for (const tn of textNodes) {
        const text = tn.nodeValue;
        if (!re.test(text)) continue;
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        let match;
        while ((match = re.exec(text)) !== null) {
            if (match.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
            const mark = document.createElement('mark');
            mark.className = 'find-hl';
            mark.textContent = match[0];
            mark._scroll = scrollEl;
            frag.appendChild(mark);
            marks.push(mark);
            lastIdx = re.lastIndex;
        }
        if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        tn.parentNode.replaceChild(frag, tn);
    }
    return marks;
}

function _findHighlight(query) {
    _findClear();
    if (!query) { findCount.textContent = ''; return; }
    findLastQuery = query;

    const target = _findGetTarget();

    // ── Raw mode: textarea only ──
    if (target.mode === 'ta') {
        const { ta, backdrop } = target.editors[0];
        const indices = _buildAndRenderBackdrop(ta, backdrop, query);
        findMatches = indices.map(mi => ({
            _taIndex: mi.index, _taLen: mi.len, _ta: ta, _backdrop: backdrop, _type: 'ta'
        }));
    }

    // ── Preview mode: DOM only ──
    else if (target.mode === 'dom') {
        const { root, scroll } = target.roots[0];
        const marks = _highlightDomRoot(root, query, scroll);
        findMatches = marks.map(mark => { mark._type = 'dom'; return mark; });
    }

    // ── Split mode: both textarea + preview ──
    else if (target.mode === 'both') {
        const { ta, backdrop } = target.editors[0];
        const { root, scroll } = target.roots[0];

        // Textarea side
        const indices = _buildAndRenderBackdrop(ta, backdrop, query);
        const taMatches = indices.map(mi => ({
            _taIndex: mi.index, _taLen: mi.len, _ta: ta, _backdrop: backdrop, _type: 'ta'
        }));

        // Preview side
        const domMarks = _highlightDomRoot(root, query, scroll);

        // Pair: each entry scrolls both sides
        findMatches = taMatches.map((tm, i) => {
            tm._pairedDom = domMarks[i] || null;
            return tm;
        });
    }

    // Highlight all matching line numbers
    if (findMatches.length) {
        const lnEl = (target.mode === 'ta') ? lnums : (target.mode === 'both') ? splitLnums : null;
        if (lnEl && lnEl.children.length) {
            const matchedLines = new Set();
            for (const m of findMatches) {
                if (m._taIndex !== undefined && m._ta) {
                    matchedLines.add(m._ta.value.slice(0, m._taIndex).split('\n').length);
                }
            }
            for (const ln of matchedLines) {
                const span = lnEl.children[ln - 1];
                if (span) span.classList.add('find-ln');
            }
        }
        findMatchIndex = 0;
        _findSetActive(0);
        findCount.textContent = '1/' + findMatches.length;
    } else {
        findMatchIndex = -1;
        findCount.textContent = '0/0';
    }
}

function _findSetActive(idx) {
    document.querySelectorAll('.find-hl-active').forEach(el => el.classList.remove('find-hl-active'));
    document.querySelectorAll('.ln.find-active').forEach(el => el.classList.remove('find-active'));
    if (idx < 0 || idx >= findMatches.length) return;
    const match = findMatches[idx];
    // DOM mark
    if (match instanceof HTMLElement) match.classList.add('find-hl-active');
    // Textarea backdrop mark
    if (match._backdrop) {
        const mark = match._backdrop.querySelector(`[data-find-idx="${idx}"]`);
        if (mark) mark.classList.add('find-hl-active');
    }
    // Paired DOM mark (split mode)
    if (match._pairedDom instanceof HTMLElement) match._pairedDom.classList.add('find-hl-active');
    // Highlight active line number
    if (match._taIndex !== undefined && match._ta) {
        const lineNum = match._ta.value.slice(0, match._taIndex).split('\n').length;
        const lnEl = match._ta === rawEditor ? lnums : splitLnums;
        const span = lnEl.children[lineNum - 1];
        if (span) span.classList.add('find-active');
    }
    _findScrollToMatch();
}

function _findScrollToMatch() {
    if (findMatchIndex < 0 || findMatchIndex >= findMatches.length) return;
    const match = findMatches[findMatchIndex];

    // Scroll textarea side
    if (match._taIndex !== undefined && match._ta) {
        const ta = match._ta;
        const backdrop = match._backdrop;
        const style = window.getComputedStyle(ta);
        const lineH = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.65;
        const textBefore = ta.value.slice(0, match._taIndex);
        const linesBefore = textBefore.split('\n').length - 1;
        ta.scrollTop = Math.max(0, linesBefore * lineH - ta.clientHeight / 3);
        if (backdrop) _syncBackdrop(ta, backdrop);
    }

    // Scroll DOM/preview side
    const domEl = (match._type === 'dom') ? match : match._pairedDom;
    if (domEl instanceof HTMLElement && domEl._scroll) {
        const scrollEl = domEl._scroll;
        const markRect = domEl.getBoundingClientRect();
        const scrollRect = scrollEl.getBoundingClientRect();
        const offset = markRect.top - scrollRect.top + scrollEl.scrollTop - scrollEl.clientHeight / 3;
        scrollEl.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
    }
}

function _findNavigate(backwards) {
    if (!findMatches.length) return;
    if (backwards) {
        findMatchIndex = findMatchIndex <= 0 ? findMatches.length - 1 : findMatchIndex - 1;
    } else {
        findMatchIndex = findMatchIndex >= findMatches.length - 1 ? 0 : findMatchIndex + 1;
    }
    _findSetActive(findMatchIndex);
    findCount.textContent = (findMatchIndex + 1) + '/' + findMatches.length;
}

function openFind() {
    findOpen = true;
    findBar.classList.add('show');
    setTimeout(() => { findInput.focus(); findInput.select(); }, 0);
    // If there's already a query, re-run highlighting
    if (findInput.value) _findHighlight(findInput.value);
}

function closeFind() {
    findOpen = false;
    findBar.classList.remove('show');
    _findClear();
    findCount.textContent = '';
    findInput.value = '';
    findLastQuery = '';

    // Return focus to editor
    if (curTab === 'raw') rawEditor.focus();
    else if (curTab === 'split') splitEd.focus();
}

// Typing → debounced search
findInput.addEventListener('input', () => {
    clearTimeout(findDebounce);
    findDebounce = setTimeout(() => {
        const q = findInput.value;
        if (q === findLastQuery) return;
        findLastQuery = q;
        _findHighlight(q);
    }, 150);
});

// Keyboard in find input
findInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); _findNavigate(e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); findInput.select(); }
});
// Prevent focus loss on mousedown inside find bar
findBar.addEventListener('mousedown', e => {
    if (e.target !== findInput) { e.preventDefault(); findInput.focus(); }
});

$('find-next').addEventListener('click', () => _findNavigate(false));
$('find-prev').addEventListener('click', () => _findNavigate(true));
$('find-close').addEventListener('click', closeFind);

document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        if (findOpen) { findInput.focus(); findInput.select(); }
        else openFind();
        return;
    }
    if (e.key === 'Escape' && findOpen) { e.preventDefault(); closeFind(); return; }
});

/* ══ Toast ════════════════════════════════════════════════ */
function toast(msg, dur = 1800) {
    const t = $('toast'); t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), dur);
}

/* ══ Split divider drag ══════════════════════════════════ */
(function() {
    const div = $('vdivider'), sr = $('split-raw'), sp = $('split-prev-scroll');
    let drag = false;
    const savedSplit = parseInt(localStorage.getItem('mdv_split_pct') || '50');
    sr.style.flex = `0 0 ${savedSplit}%`;
    sp.style.flex = `0 0 ${100 - savedSplit}%`;

    div.addEventListener('mousedown', () => {
        drag = true; div.classList.add('drag');
        document.body.style.cssText += 'cursor:col-resize;user-select:none';
    });
    document.addEventListener('mousemove', e => {
        if (!drag) return;
        const p = div.parentElement.getBoundingClientRect();
        const pct = Math.max(20, Math.min(80, (e.clientX - p.left) / p.width * 100));
        sr.style.flex = `0 0 ${pct}%`;
        sp.style.flex = `0 0 ${100 - pct}%`;
    });
    document.addEventListener('mouseup', () => {
        if (!drag) return;
        drag = false; div.classList.remove('drag');
        document.body.style.cursor = ''; document.body.style.userSelect = '';
        const curPct = parseFloat(sr.style.flex.match(/[\d.]+/)?.[0] || 50);
        localStorage.setItem('mdv_split_pct', Math.round(curPct));
    });
})();

/* ══ Drag & drop files ═══════════════════════════════════ */
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files.length) return;
    const file = files[0];
    const _dropExts = getActiveExtensions();
    const _dropPattern = new RegExp('\\.(' + _dropExts.join('|') + ')$', 'i');
    if (!_dropPattern.test(file.name)) { toast('\u26A0 Unsupported file type'); return; }
    // Use the path property from Electron
    if (file.path) {
        const content = await window.electronAPI.readFile(file.path);
        if (content !== null) {
            enter(content, file.name, file.path);
            setTab('preview');
        }
    } else {
        const reader = new FileReader();
        reader.onload = ev => { enter(ev.target.result, file.name); setTab('preview'); };
        reader.readAsText(file);
    }
});

/* ══ Pill init + restore last dir ════════════════════════ */
window.addEventListener('load', async () => {
    hljs.configure({ tabReplace: '    ' });
    document.querySelectorAll('.t-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === curTab));
    const b = document.querySelector('.t-btn.on');
    if (b) {
        const sr = tabs.getBoundingClientRect(), br = b.getBoundingClientRect();
        pill.style.left = (br.left - sr.left - 3) + 'px';
        pill.style.width = br.width + 'px';
    }

    // Restore last watched dir
    const lastDir = localStorage.getItem('mdv_last_dir');
    if (lastDir) {
        await openFolderByPath(lastDir);
    }
    renderRecentFolders();
});