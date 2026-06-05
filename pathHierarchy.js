// version: v1.0 //

/**
 * pathHierarchy.js
 * ─────────────────────────────────────────────────────────────
 * Scans a given subfolder recursively and writes every file
 * (relative path from root + size) into a .stub file at the
 * root folder, named after the scanned folder.
 *
 *   node pathHierarchy.js "Scripts/"
 *   → writes  entire-Scripts.stub  in the root folder
 *
 *   node pathHierarchy.js "Assets/Audio"
 *   → writes  entire-Audio.stub  in the root folder
 *
 *   node pathHierarchy.js -scan
 *   → scans every top-level folder in cwd (except .git),
 *     writes entire-<FolderName>.stub for each,
 *     skips any whose stub already exists.
 *
 * No external dependencies — Node.js built-ins only.
 * ─────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────
const SCRIPT_NAME  = path.basename(__filename);
const ROOT         = process.cwd();
const SKIP_FOLDERS = new Set(['.git']);

// ── Helpers ───────────────────────────────────────────────────
const toRelPath = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function humanSize(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(3)} GB`;
  if (bytes >= 1048576)    return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024)       return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ── Walk ──────────────────────────────────────────────────────
function walkDir(dir, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, results);
    } else if (entry.isFile()) {
      try {
        const { size } = fs.statSync(full);
        results.push({ full, size });
      } catch { /* permission denied — skip */ }
    }
  }

  return results;
}

// ── Scan one folder ───────────────────────────────────────────
/**
 * @param {string} targetFull  Absolute path to the folder to scan.
 * @param {object} [opts]
 * @param {boolean} [opts.skipIfExists=false]  Skip silently if stub already exists.
 * @returns {{ skipped: boolean }}
 */
function scanFolder(targetFull, { skipIfExists = false } = {}) {
  const folderName = path.basename(targetFull);
  const outPath    = path.join(ROOT, `entire-${folderName}.stub`);
  const divider    = '─'.repeat(65);

  if (skipIfExists && fs.existsSync(outPath)) {
    console.log(`    ⏭️  Skipped  → entire-${folderName}.stub (already exists)`);
    return { skipped: true };
  }

  console.log(`\n📂  Scanning: ${toRelPath(targetFull)}/`);

  const files      = walkDir(targetFull);
  const rows       = files.map(f => ({ rel: toRelPath(f.full), human: humanSize(f.size), size: f.size }));
  const maxLen     = rows.length ? Math.max(...rows.map(r => r.rel.length)) : 0;
  const totalBytes = rows.reduce((s, r) => s + r.size, 0);

  const lines = [];
  lines.push(divider);
  lines.push(`Folder : ${toRelPath(targetFull)}/`);
  lines.push(`Files  : ${rows.length}`);
  lines.push(`Total  : ${humanSize(totalBytes)}`);
  lines.push(divider);
  lines.push('');

  if (rows.length === 0) {
    lines.push('(no files found)');
  } else {
    for (const row of rows) {
      lines.push(`${row.rel.padEnd(maxLen + 2)}${row.human}`);
    }
  }

  lines.push('');

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  console.log(`    ✅ Written  → entire-${folderName}.stub`);
  console.log(`    Files : ${rows.length}`);
  console.log(`    Total : ${humanSize(totalBytes)}`);

  return { skipped: false };
}

// ── Scan-all mode ─────────────────────────────────────────────
function scanAll() {
  console.log(`\n🔍  pathHierarchy.js  —  -scan mode`);
  console.log(`    Root: ${ROOT}\n`);

  let entries;
  try { entries = fs.readdirSync(ROOT, { withFileTypes: true }); }
  catch (e) {
    console.error(`\n❌  Cannot read root directory: ${e.message}\n`);
    process.exit(1);
  }

  const folders = entries.filter(e =>
    e.isDirectory() && !SKIP_FOLDERS.has(e.name)
  );

  if (folders.length === 0) {
    console.log('    (no subfolders found)\n');
    return;
  }

  let written = 0;
  let skipped = 0;

  for (const entry of folders) {
    const result = scanFolder(path.join(ROOT, entry.name), { skipIfExists: true });
    result.skipped ? skipped++ : written++;
  }

  const divider = '─'.repeat(65);
  console.log(`\n${divider}`);
  console.log(`  ✅ Done — ${written} written, ${skipped} skipped`);
  console.log(`${divider}\n`);
}

// ── Single-folder mode ────────────────────────────────────────
function scanSingle(targetArg) {
  const targetFull = path.resolve(ROOT, targetArg);

  if (!fs.existsSync(targetFull)) {
    console.error(`\n❌  Folder not found: "${targetArg}"`);
    console.error(`    Resolved to: ${targetFull}\n`);
    process.exit(1);
  }

  if (!fs.statSync(targetFull).isDirectory()) {
    console.error(`\n❌  "${targetArg}" is a file, not a folder.\n`);
    process.exit(1);
  }

  console.log(`\n📂  pathHierarchy.js`);
  scanFolder(targetFull);
  console.log('');
}

// ── Entry point ───────────────────────────────────────────────
const TARGET_ARG = process.argv[2];

if (!TARGET_ARG) {
  console.error(`\n❌  No argument specified.\n`);
  console.error(`    Usage:`);
  console.error(`      node ${SCRIPT_NAME} "Scripts/"   — scan a specific folder`);
  console.error(`      node ${SCRIPT_NAME} -scan         — scan all top-level folders\n`);
  process.exit(1);
}

if (TARGET_ARG === '-scan') {
  scanAll();
} else {
  scanSingle(TARGET_ARG);
}