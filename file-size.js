// version: v1.0 //

/**
 * file-size-analyser.js
 * ─────────────────────────────────────────────────────────────
 * Drop in any root folder and run:  node file-size-analyser.js
 *
 * - Scans every file in every sub-folder recursively
 * - Skips  .stub  files entirely
 * - Extension breakdown sorted by Unity 6000.3+ importance tier
 * - Shows highest size alongside average size everywhere
 * - Writes <root-folder-name>-report.md
 *
 * No external dependencies — Node.js built-ins only. Node 16+
 * ─────────────────────────────────────────────────────────────
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════
//  UNITY 6000.3+ EXTENSION IMPORTANCE REGISTRY
//  Lower tier  = more critical to the project.
//  Within a tier entries appear in the order written below.
//  Any extension NOT listed here lands in tier 99 "Unclassified".
// ══════════════════════════════════════════════════════════════
const UNITY_EXTENSIONS = [

  // ── Tier 1 · Project Integrity (GUID / reference system) ──
  { ext: '.meta',               tier: 1, label: 'Asset Meta',           desc: 'GUID & import settings — every asset depends on this' },
  { ext: '.unity',              tier: 1, label: 'Scene',                desc: 'Scene files — root of all gameplay content' },
  { ext: '.prefab',             tier: 1, label: 'Prefab',               desc: 'Reusable GameObject templates' },
  { ext: '.cs',                 tier: 1, label: 'C# Script',            desc: 'Game logic, MonoBehaviours, ScriptableObjects' },
  { ext: '.asset',              tier: 1, label: 'Asset (SO/Settings)',  desc: 'ScriptableObjects, project settings, baked data' },
  { ext: '.asmdef',             tier: 1, label: 'Assembly Definition',  desc: 'Compilation boundaries & package isolation' },
  { ext: '.asmref',             tier: 1, label: 'Assembly Reference',   desc: 'Cross-assembly references' },

  // ── Tier 2 · Rendering Pipeline (URP / HDRP / custom) ─────
  { ext: '.shader',             tier: 2, label: 'Legacy Shader',        desc: 'ShaderLab / CG shaders' },
  { ext: '.shadergraph',        tier: 2, label: 'Shader Graph',         desc: 'Node-based shader (Unity 6 primary workflow)' },
  { ext: '.shadersubgraph',     tier: 2, label: 'Shader Sub-graph',     desc: 'Reusable Shader Graph node groups' },
  { ext: '.compute',            tier: 2, label: 'Compute Shader',       desc: 'GPU compute passes' },
  { ext: '.cginc',              tier: 2, label: 'CG Include',           desc: 'Shared CG/HLSL utility code' },
  { ext: '.hlsl',               tier: 2, label: 'HLSL Include',         desc: 'Shared HLSL utility code' },
  { ext: '.glsl',               tier: 2, label: 'GLSL Include',         desc: 'OpenGL shader code' },
  { ext: '.mat',                tier: 2, label: 'Material',             desc: 'Shader + property bindings' },
  { ext: '.renderTexture',      tier: 2, label: 'Render Texture',       desc: 'GPU render target asset' },
  { ext: '.lighting',           tier: 2, label: 'Lighting Data',        desc: 'Baked GI, lightmaps, light probes' },
  { ext: '.lichtdata',          tier: 2, label: 'Lighting Data Alt',    desc: 'Alternate baked lighting format' },
  { ext: '.rendersettings',     tier: 2, label: 'Render Settings',      desc: 'Per-scene rendering config' },

  // ── Tier 3 · Animation & Character ────────────────────────
  { ext: '.anim',               tier: 3, label: 'Animation Clip',       desc: 'Keyframe animation data' },
  { ext: '.controller',         tier: 3, label: 'Animator Controller',  desc: 'State machine for animations' },
  { ext: '.overridecontroller', tier: 3, label: 'Override Controller',  desc: 'Swaps clips in a base controller' },
  { ext: '.mask',               tier: 3, label: 'Avatar Mask',          desc: 'Body-part animation masking' },
  { ext: '.avatar',             tier: 3, label: 'Avatar',               desc: 'Humanoid rig mapping' },

  // ── Tier 4 · Audio ────────────────────────────────────────
  { ext: '.mixer',              tier: 4, label: 'Audio Mixer',          desc: 'DSP graph & bus routing' },
  { ext: '.wav',                tier: 4, label: 'WAV Audio',            desc: 'Uncompressed PCM audio' },
  { ext: '.ogg',                tier: 4, label: 'OGG Audio',            desc: 'Compressed audio (common in Unity)' },
  { ext: '.mp3',                tier: 4, label: 'MP3 Audio',            desc: 'Compressed audio' },
  { ext: '.aiff',               tier: 4, label: 'AIFF Audio',           desc: 'Apple uncompressed audio' },
  { ext: '.aif',                tier: 4, label: 'AIF Audio',            desc: 'Apple uncompressed audio (short ext)' },
  { ext: '.flac',               tier: 4, label: 'FLAC Audio',           desc: 'Lossless compressed audio' },
  { ext: '.m4a',                tier: 4, label: 'M4A Audio',            desc: 'AAC audio container' },

  // ── Tier 5 · 3-D Models & Scenes ──────────────────────────
  { ext: '.fbx',                tier: 5, label: 'FBX Model',            desc: 'Industry-standard 3-D interchange format' },
  { ext: '.glb',                tier: 5, label: 'GLB (Binary GLTF)',    desc: 'Compact runtime 3-D format' },
  { ext: '.gltf',               tier: 5, label: 'GLTF Model',           desc: 'JSON-based 3-D scene format' },
  { ext: '.obj',                tier: 5, label: 'OBJ Model',            desc: 'Simple mesh format' },
  { ext: '.dae',                tier: 5, label: 'Collada Model',        desc: 'XML 3-D interchange' },
  { ext: '.blend',              tier: 5, label: 'Blender File',         desc: 'Blender native scene file' },
  { ext: '.3ds',                tier: 5, label: '3DS Max Model',        desc: '3DS Max legacy format' },
  { ext: '.stl',                tier: 5, label: 'STL Model',            desc: 'CAD / 3-D printing mesh' },
  { ext: '.ply',                tier: 5, label: 'PLY Point Cloud',      desc: 'Polygon mesh / point cloud' },

  // ── Tier 6 · Textures & Images ────────────────────────────
  { ext: '.png',                tier: 6, label: 'PNG Texture',          desc: 'Lossless texture (most common in Unity)' },
  { ext: '.tga',                tier: 6, label: 'TGA Texture',          desc: 'Lossless with alpha — preferred for normals' },
  { ext: '.exr',                tier: 6, label: 'EXR HDR Texture',      desc: 'High dynamic range — skyboxes, light cookies' },
  { ext: '.hdr',                tier: 6, label: 'HDR Texture',          desc: 'Radiance HDR environment map' },
  { ext: '.psd',                tier: 6, label: 'Photoshop Source',     desc: 'Layered source — Unity imports as flat' },
  { ext: '.jpg',                tier: 6, label: 'JPG Texture',          desc: 'Lossy texture — UI, backgrounds' },
  { ext: '.jpeg',               tier: 6, label: 'JPEG Texture',         desc: 'Lossy texture (alternate ext)' },
  { ext: '.tiff',               tier: 6, label: 'TIFF Texture',         desc: 'High-quality lossless texture' },
  { ext: '.tif',                tier: 6, label: 'TIF Texture',          desc: 'TIFF alternate extension' },
  { ext: '.dds',                tier: 6, label: 'DDS Texture',          desc: 'Pre-compressed GPU texture (DXT/BC)' },
  { ext: '.bmp',                tier: 6, label: 'BMP Image',            desc: 'Uncompressed bitmap' },
  { ext: '.gif',                tier: 6, label: 'GIF Image',            desc: 'Animated or indexed image' },
  { ext: '.webp',               tier: 6, label: 'WebP Image',           desc: 'Modern compressed image format' },
  { ext: '.svg',                tier: 6, label: 'SVG Vector',           desc: 'Scalable vector — Unity 6 UI Toolkit' },
  { ext: '.cubemap',            tier: 6, label: 'Cubemap',              desc: 'Pre-baked environment cubemap' },
  { ext: '.psb',                tier: 6, label: 'PSB (Large PSD)',      desc: 'Large Photoshop document' },

  // ── Tier 7 · Sprite & UI ──────────────────────────────────
  { ext: '.spriteatlas',        tier: 7, label: 'Sprite Atlas',         desc: 'Packed sprite sheet (SpriteAtlas v2 in U6)' },
  { ext: '.spriteatlasv2',      tier: 7, label: 'Sprite Atlas v2',      desc: 'Unity 6 sprite atlas format' },
  { ext: '.fontsettings',       tier: 7, label: 'Font Settings',        desc: 'Legacy bitmap font import settings' },
  { ext: '.ttf',                tier: 7, label: 'TrueType Font',        desc: 'Vector font for UI' },
  { ext: '.otf',                tier: 7, label: 'OpenType Font',        desc: 'Advanced vector font' },
  { ext: '.woff',               tier: 7, label: 'WOFF Font',            desc: 'Web font (UI Toolkit)' },
  { ext: '.woff2',              tier: 7, label: 'WOFF2 Font',           desc: 'Compressed web font (UI Toolkit)' },
  { ext: '.uss',                tier: 7, label: 'USS Stylesheet',       desc: 'Unity Style Sheet — UI Toolkit' },
  { ext: '.uxml',               tier: 7, label: 'UXML Layout',          desc: 'UI Toolkit markup layout' },
  { ext: '.tss',                tier: 7, label: 'Theme Style Sheet',    desc: 'UI Toolkit theme' },

  // ── Tier 8 · Physics & Terrain ────────────────────────────
  { ext: '.physicMaterial',     tier: 8, label: 'Physics Material 3D',  desc: 'Friction & bounciness for 3-D colliders' },
  { ext: '.physicsMaterial2D',  tier: 8, label: 'Physics Material 2D',  desc: 'Friction & bounciness for 2-D colliders' },
  { ext: '.terrainlayer',       tier: 8, label: 'Terrain Layer',        desc: 'Texture + normal layer for terrain painting' },
  { ext: '.brush',              tier: 8, label: 'Terrain Brush',        desc: 'Custom terrain sculpt brush' },
  { ext: '.terrain',            tier: 8, label: 'Terrain Data',         desc: 'Heightmap, splat maps, tree instances' },

  // ── Tier 9 · Timeline / Sequences ─────────────────────────
  { ext: '.playable',           tier: 9, label: 'Playable Asset',       desc: 'Timeline graph / custom playable' },
  { ext: '.signal',             tier: 9, label: 'Timeline Signal',      desc: 'Named event fired from Timeline' },
  { ext: '.signalasset',        tier: 9, label: 'Signal Asset',         desc: 'Signal definition asset' },

  // ── Tier 10 · Navigation & AI ─────────────────────────────
  { ext: '.nav',                tier: 10, label: 'NavMesh',             desc: 'Baked navigation mesh' },
  { ext: '.navmesh',            tier: 10, label: 'NavMesh Asset',       desc: 'NavMesh surface data' },

  // ── Tier 11 · Video ───────────────────────────────────────
  { ext: '.mp4',                tier: 11, label: 'MP4 Video',           desc: 'H.264 / H.265 video' },
  { ext: '.mov',                tier: 11, label: 'MOV Video',           desc: 'Apple QuickTime video' },
  { ext: '.avi',                tier: 11, label: 'AVI Video',           desc: 'Windows video container' },
  { ext: '.mkv',                tier: 11, label: 'MKV Video',           desc: 'Matroska video container' },
  { ext: '.webm',               tier: 11, label: 'WebM Video',          desc: 'VP8/VP9 web video' },

  // ── Tier 12 · Configuration & Data ───────────────────────
  { ext: '.json',               tier: 12, label: 'JSON',                desc: 'Config, save data, addressable manifests' },
  { ext: '.xml',                tier: 12, label: 'XML',                 desc: 'Structured config / serialised data' },
  { ext: '.yaml',               tier: 12, label: 'YAML',                desc: 'Human-readable config' },
  { ext: '.yml',                tier: 12, label: 'YML',                 desc: 'YAML alternate extension' },
  { ext: '.toml',               tier: 12, label: 'TOML',                desc: 'Package config' },
  { ext: '.ini',                tier: 12, label: 'INI',                 desc: 'Legacy config' },
  { ext: '.cfg',                tier: 12, label: 'CFG',                 desc: 'Generic config file' },
  { ext: '.csv',                tier: 12, label: 'CSV',                 desc: 'Tabular game data (localisation, items)' },
  { ext: '.tsv',                tier: 12, label: 'TSV',                 desc: 'Tab-separated game data' },

  // ── Tier 13 · Documentation ───────────────────────────────
  { ext: '.md',                 tier: 13, label: 'Markdown',            desc: 'README, changelogs, docs' },
  { ext: '.txt',                tier: 13, label: 'Text',                desc: 'Plain text, licences, notes' },
  { ext: '.pdf',                tier: 13, label: 'PDF',                 desc: 'Reference documentation' },
  { ext: '.html',               tier: 13, label: 'HTML',                desc: 'Web content / generated docs' },
  { ext: '.htm',                tier: 13, label: 'HTM',                 desc: 'HTML alternate extension' },
  { ext: '.css',                tier: 13, label: 'CSS',                 desc: 'Web stylesheet' },

  // ── Tier 14 · Build & Platform Config ─────────────────────
  { ext: '.csproj',             tier: 14, label: 'C# Project',          desc: 'MSBuild project — IDE integration' },
  { ext: '.sln',                tier: 14, label: 'Solution',            desc: 'Visual Studio / Rider solution file' },
  { ext: '.gradle',             tier: 14, label: 'Gradle Build',        desc: 'Android build script' },
  { ext: '.manifest',           tier: 14, label: 'Package Manifest',    desc: 'Unity package or Android manifest' },
  { ext: '.props',              tier: 14, label: 'MSBuild Props',       desc: 'Shared MSBuild properties' },
  { ext: '.targets',            tier: 14, label: 'MSBuild Targets',     desc: 'MSBuild custom build targets' },
  { ext: '.env',                tier: 14, label: 'Env File',            desc: 'Environment variables' },

  // ── Tier 15 · Native / Plugin Code ────────────────────────
  { ext: '.h',                  tier: 15, label: 'C/C++ Header',        desc: 'Native plugin header' },
  { ext: '.cpp',                tier: 15, label: 'C++ Source',          desc: 'Native plugin source' },
  { ext: '.c',                  tier: 15, label: 'C Source',            desc: 'Native C plugin' },
  { ext: '.proto',              tier: 15, label: 'Protobuf Schema',     desc: 'Network / data serialisation schema' },
  { ext: '.mm',                 tier: 15, label: 'Objective-C++',       desc: 'iOS native code' },
  { ext: '.swift',              tier: 15, label: 'Swift',               desc: 'iOS native code' },
  { ext: '.java',               tier: 15, label: 'Java',                desc: 'Android native code' },
  { ext: '.kt',                 tier: 15, label: 'Kotlin',              desc: 'Android native code' },
  { ext: '.py',                 tier: 15, label: 'Python',              desc: 'Editor tooling / pipeline scripts' },
  { ext: '.js',                 tier: 15, label: 'JavaScript',          desc: 'Build tooling / WebGL glue' },
  { ext: '.ts',                 tier: 15, label: 'TypeScript',          desc: 'Build tooling' },
  { ext: '.lua',                tier: 15, label: 'Lua',                 desc: 'Scripting (if used via plugin)' },

  // ── Tier 16 · Raw Binaries & Archives ─────────────────────
  { ext: '.bin',                tier: 16, label: 'Binary Data',         desc: 'Raw binary blob' },
  { ext: '.bytes',              tier: 16, label: 'Bytes Asset',         desc: 'Unity TextAsset binary' },
  { ext: '.data',               tier: 16, label: 'Data File',           desc: 'Generic binary data' },
  { ext: '.zip',                tier: 16, label: 'ZIP Archive',         desc: 'Compressed archive' },
  { ext: '.rar',                tier: 16, label: 'RAR Archive',         desc: 'Compressed archive' },
  { ext: '.7z',                 tier: 16, label: '7-Zip Archive',       desc: 'High-compression archive' },
  { ext: '.tar',                tier: 16, label: 'TAR Archive',         desc: 'Unix archive' },
  { ext: '.gz',                 tier: 16, label: 'GZip Archive',        desc: 'Compressed tar' },

  // ── Tier 17 · Other Unity-specific misc ───────────────────
  { ext: '.flare',              tier: 17, label: 'Lens Flare',          desc: 'Legacy lens flare asset' },
  { ext: '.guiskin',            tier: 17, label: 'GUI Skin',            desc: 'Legacy OnGUI skin' },
  { ext: '.preset',             tier: 17, label: 'Preset',              desc: 'Inspector preset for components' },
  { ext: '.collab',             tier: 17, label: 'Collab',              desc: 'Unity Collaborate metadata (deprecated)' },
  { ext: '.unitypackage',       tier: 17, label: 'Unity Package',       desc: 'Exported asset package' },
  { ext: '.log',                tier: 17, label: 'Log File',            desc: 'Editor / player log output' },
  { ext: '.tmp',                tier: 17, label: 'Temp File',           desc: 'Temporary file — safe to delete' },
  { ext: '.cache',              tier: 17, label: 'Cache File',          desc: 'Cached data — regeneratable' },
  { ext: '.db',                 tier: 17, label: 'Database',            desc: 'SQLite or other DB' },
];

// Build lookup maps from the registry
const EXT_META   = {};   // ext → { tier, label, desc }
const TIER_LABEL = {};   // tier → human-readable tier name

const TIER_NAMES = {
  1:  'Tier 1 — Project Integrity',
  2:  'Tier 2 — Rendering Pipeline',
  3:  'Tier 3 — Animation & Character',
  4:  'Tier 4 — Audio',
  5:  'Tier 5 — 3-D Models & Scenes',
  6:  'Tier 6 — Textures & Images',
  7:  'Tier 7 — Sprite, UI & Fonts',
  8:  'Tier 8 — Physics & Terrain',
  9:  'Tier 9 — Timeline & Sequences',
  10: 'Tier 10 — Navigation & AI',
  11: 'Tier 11 — Video',
  12: 'Tier 12 — Configuration & Data',
  13: 'Tier 13 — Documentation',
  14: 'Tier 14 — Build & Platform',
  15: 'Tier 15 — Native & Plugin Code',
  16: 'Tier 16 — Raw Binaries & Archives',
  17: 'Tier 17 — Miscellaneous',
  99: 'Tier 99 — Unclassified',
};

for (const row of UNITY_EXTENSIONS) {
  EXT_META[row.ext] = { tier: row.tier, label: row.label, desc: row.desc };
}

// ══════════════════════════════════════════════════════════════
//  GENERAL CONFIG
// ══════════════════════════════════════════════════════════════
const ROOT        = process.cwd();
const ROOT_NAME   = path.basename(ROOT);
const OUTPUT_FILE = path.join(ROOT, `${ROOT_NAME}-report.md`);
const SKIP_DIRS   = new Set(['.git', 'node_modules', '.svn', '.hg']);
const SCRIPT_NAME = path.basename(__filename);
const WARN_MB     = 100;
const CRITICAL_MB = 500;

// ── Helpers ───────────────────────────────────────────────────
const toMB = (b) => (b / 1024 / 1024).toFixed(2);
const toGB = (b) => (b / 1024 / 1024 / 1024).toFixed(3);
const toKB = (b) => (b / 1024).toFixed(1);

function humanSize(bytes) {
  if (bytes >= 1073741824) return `${toGB(bytes)} GB`;
  if (bytes >= 1048576)    return `${toMB(bytes)} MB`;
  if (bytes >= 1024)       return `${toKB(bytes)} KB`;
  return `${bytes} B`;
}

function sizeFlag(bytes) {
  const mb = bytes / 1024 / 1024;
  if (mb >= CRITICAL_MB) return ' 🔴';
  if (mb >= WARN_MB)     return ' 🟡';
  return '';
}

function getTier(ext) {
  return EXT_META[ext]?.tier ?? 99;
}

// ── Recursive walker ──────────────────────────────────────────
function walkDir(dir, fileList = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return fileList; }

  for (const entry of entries) {
    if (entry.name === SCRIPT_NAME                && dir === ROOT) continue;
    if (entry.name === path.basename(OUTPUT_FILE) && dir === ROOT) continue;
    if (entry.name.endsWith('.stub'))                              continue; // ← always skip

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkDir(fullPath, fileList);
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        const ext  = path.extname(entry.name).toLowerCase() || '(no ext)';
        fileList.push({
          relPath : path.relative(ROOT, fullPath),
          size    : stat.size,
          ext,
          tier    : getTier(ext),
          topDir  : (() => {
            const rel = path.relative(ROOT, dir);
            return rel ? rel.split(path.sep)[0] : '.';
          })(),
        });
      } catch { /* permission denied */ }
    }
  }
  return fileList;
}

// ── Aggregate stats ───────────────────────────────────────────
function calcStats(files) {
  if (!files.length) return { total: 0, sorted: [], over100: [], over1GB: [], avg: 0, max: 0, byExt: [], byDir: [] };

  const total   = files.reduce((s, f) => s + f.size, 0);
  const sorted  = [...files].sort((a, b) => b.size - a.size);
  const max     = sorted[0].size;
  const avg     = total / files.length;
  const over100 = files.filter(f => f.size >= WARN_MB * 1024 * 1024);
  const over1GB = files.filter(f => f.size >= 1073741824);

  // group by extension, then sort by Unity tier → total size
  const extMap = {};
  for (const f of files) {
    if (!extMap[f.ext]) extMap[f.ext] = { count: 0, total: 0, max: 0, tier: f.tier };
    extMap[f.ext].count++;
    extMap[f.ext].total += f.size;
    if (f.size > extMap[f.ext].max) extMap[f.ext].max = f.size;
  }
  const byExt = Object.entries(extMap)
    .sort((a, b) => a[1].tier - b[1].tier || b[1].total - a[1].total);

  // group by top-level directory
  const dirMap = {};
  for (const f of files) {
    if (!dirMap[f.topDir]) dirMap[f.topDir] = { count: 0, total: 0, max: 0 };
    dirMap[f.topDir].count++;
    dirMap[f.topDir].total += f.size;
    if (f.size > dirMap[f.topDir].max) dirMap[f.topDir].max = f.size;
  }
  const byDir = Object.entries(dirMap).sort((a, b) => b[1].total - a[1].total);

  return { total, sorted, over100, over1GB, avg, max, byExt, byDir };
}

// ── Markdown builder ──────────────────────────────────────────
function buildMarkdown(files, stats) {
  const now   = new Date().toLocaleString();
  const lines = [];
  const h  = (n, t) => lines.push(`${'#'.repeat(n)} ${t}`);
  const ln = ()     => lines.push('');
  const p  = (t)    => lines.push(t);
  const hr = ()     => { p(''); p('---'); p(''); };

  // ── Title
  h(1, `📁 File Size Report — \`${ROOT_NAME}\``);
  ln();
  p(`> **Generated:** ${now}  `);
  p(`> **Root path:** \`${ROOT}\`  `);
  p(`> **Script:** \`${SCRIPT_NAME}\`  `);
  p(`> **Engine:** Unity 6000.3+  `);
  p(`> **.stub files:** excluded from all counts`);
  ln();

  // ── Summary
  h(2, '📊 Overall Summary');
  ln();
  p('| Metric | Value |');
  p('|---|---|');
  p(`| Total files scanned | **${files.length.toLocaleString()}** |`);
  p(`| Total size on disk | **${humanSize(stats.total)}** |`);
  p(`| Highest single file | **${humanSize(stats.max)}** |`);
  p(`| Average file size | ${humanSize(stats.avg)} |`);
  p(`| Files ≥ ${WARN_MB} MB 🟡 | **${stats.over100.length}** |`);
  p(`| Files ≥ 1 GB 🔴 | **${stats.over1GB.length}** |`);
  p(`| Unique extensions found | ${stats.byExt.length} |`);
  p(`| Top-level directories | ${stats.byDir.length} |`);
  ln();

  // ── Top 10 largest
  h(2, '🏆 Top 10 Largest Files');
  ln();
  p('| # | File Path | Ext | Tier | Size |');
  p('|---|---|---|---|---|');
  stats.sorted.slice(0, 10).forEach((f, i) => {
    const meta = EXT_META[f.ext];
    const tier = meta ? `T${meta.tier}` : 'T99';
    p(`| ${i + 1} | \`${f.relPath}\` | \`${f.ext}\` | ${tier} | ${humanSize(f.size)}${sizeFlag(f.size)} |`);
  });
  ln();

  // ── Over 100 MB
  if (stats.over100.length) {
    h(2, `⚠️ Files ≥ ${WARN_MB} MB — Git Exclusion Candidates`);
    ln();
    p('> These files will be rejected by GitHub without Git LFS. Consider `.gitignore` or LFS.');
    ln();
    p('| File Path | Ext | Size | Severity |');
    p('|---|---|---|---|');
    [...stats.over100].sort((a, b) => b.size - a.size).forEach(f => {
      const sev = f.size >= CRITICAL_MB * 1024 * 1024 ? '🔴 Critical' : '🟡 Warning';
      p(`| \`${f.relPath}\` | \`${f.ext}\` | ${humanSize(f.size)} | ${sev} |`);
    });
    ln();
  }

  // ── By extension (sorted Unity tier → size)
  h(2, '🗂️ All Extensions — Sorted by Unity 6000.3+ Importance');
  ln();
  p('> **Tier 1** = most critical to project integrity · **Tier 99** = unclassified');
  ln();
  p('| Tier | Extension | Role | Files | Total Size | Highest | Avg Size |');
  p('|---|---|---|---|---|---|---|');

  let lastTier = null;
  for (const [ext, d] of stats.byExt) {
    const meta  = EXT_META[ext];
    const tier  = d.tier;
    const label = meta?.label ?? 'Unknown';
    const desc  = meta?.desc  ?? '—';

    if (tier !== lastTier) {
      // Tier separator row
      const tierName = TIER_NAMES[tier] ?? `Tier ${tier}`;
      p(`| | **${tierName}** | | | | | |`);
      lastTier = tier;
    }

    p(`| T${tier} | \`${ext}\` | ${label} — *${desc}* | ${d.count} | ${humanSize(d.total)} | ${humanSize(d.max)} | ${humanSize(d.total / d.count)} |`);
  }
  ln();

  // ── By directory
  h(2, '📂 Breakdown by Top-Level Directory');
  ln();
  p('| Directory | Files | Total Size | Highest File | Avg Size |');
  p('|---|---|---|---|---|');
  stats.byDir.forEach(([dir, d]) => {
    p(`| \`${dir}/\` | ${d.count} | ${humanSize(d.total)} | ${humanSize(d.max)} | ${humanSize(d.total / d.count)} |`);
  });
  ln();

  // ── Size distribution
  h(2, '📈 Size Distribution');
  ln();
  const buckets = [
    ['< 1 KB',         f => f.size < 1024],
    ['1 KB – 1 MB',    f => f.size >= 1024        && f.size < 1048576],
    ['1 MB – 10 MB',   f => f.size >= 1048576      && f.size < 10485760],
    ['10 MB – 100 MB', f => f.size >= 10485760     && f.size < 104857600],
    ['100 MB – 1 GB',  f => f.size >= 104857600    && f.size < 1073741824],
    ['> 1 GB',         f => f.size >= 1073741824],
  ];
  p('| Size Range | Files | % of Total |');
  p('|---|---|---|');
  buckets.forEach(([label, pred]) => {
    const count = files.filter(pred).length;
    const pct   = files.length ? ((count / files.length) * 100).toFixed(1) : '0.0';
    p(`| ${label} | ${count} | ${pct}% |`);
  });
  ln();

  // ── Full listing
  h(2, '📋 All Files — Descending by Size');
  ln();
  p('> 🟡 = ≥ 100 MB &nbsp;&nbsp; 🔴 = ≥ 500 MB');
  ln();
  p('| # | File Path | Tier | Size |');
  p('|---|---|---|---|');
  stats.sorted.forEach((f, i) => {
    const tier = f.tier === 99 ? 'T??' : `T${f.tier}`;
    p(`| ${i + 1} | \`${f.relPath}\` | ${tier} | ${humanSize(f.size)}${sizeFlag(f.size)} |`);
  });
  ln();

  hr();
  p(`*Report generated by \`${SCRIPT_NAME}\` · Unity 6000.3+ extension registry · ${now}*`);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────
function main() {
  console.log(`\n🔍  Scanning: ${ROOT}`);
  console.log(`    Skipping  : ${[...SKIP_DIRS].join(', ')}, *.stub`);
  console.log(`    Registry  : ${UNITY_EXTENSIONS.length} known extensions across 17 Unity tiers\n`);

  const files = walkDir(ROOT);

  if (!files.length) {
    console.log('⚠️  No files found.');
    process.exit(0);
  }

  const stats = calcStats(files);

  console.log(`✅  ${files.length} file(s) found`);
  console.log(`    Total size   : ${humanSize(stats.total)}`);
  console.log(`    Highest file : ${humanSize(stats.max)}`);
  console.log(`    Average size : ${humanSize(stats.avg)}`);
  console.log(`    ≥ 100 MB     : ${stats.over100.length}`);
  console.log(`    ≥ 1 GB       : ${stats.over1GB.length}`);
  console.log(`\n    Building report...`);

  const content = buildMarkdown(files, stats);
  fs.writeFileSync(OUTPUT_FILE, content, 'utf8');

  console.log(`\n📄  Report → ${OUTPUT_FILE}\n`);
}

main();