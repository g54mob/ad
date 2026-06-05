// version: v1.0 //

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DELIMITER_PREFIX = '<!-- ==== FILE: ';
const DELIMITER_SUFFIX = ' ==== -->';
const BINARY_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.bmp','.webp','.ico','.tiff','.heic',
    '.dll','.exe','.so','.dylib','.pdb','.mdb',
    '.ogg','.mp3','.wav','.flac','.aac',
    '.mp4','.avi','.mov','.mkv',
    '.zip','.rar','.7z','.gz','.tar',
    '.ttf','.otf','.woff','.woff2',
    '.asset','.prefab','.unity',".unitypackage",'.meta','.mat','.shader','.fbx','.obj','.blend']);

function getAllFiles(dirPath, ignoreDirs) {
    let results = [];
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (ignoreDirs.has(entry.name.toLowerCase())) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) results = results.concat(getAllFiles(fullPath, ignoreDirs));
        else results.push(fullPath);
    }
    return results.sort();
}

const targetDir = process.argv[2];
if (!targetDir) { console.error('Usage: node pack.js <folder> ["*.md, node_modules/, ..."] [output-path]'); process.exit(1); }
if (!fs.existsSync(targetDir)) { console.error(`Folder not found: ${targetDir}`); process.exit(1); }

const ignoreExts = new Set();
const ignoreDirs = new Set();
if (process.argv[3]) {
    for (const pat of process.argv[3].split(',')) {
        const trimmed = pat.trim();
        if (!trimmed) continue;
        if (trimmed.endsWith('/')) ignoreDirs.add(trimmed.slice(0, -1).toLowerCase());
        else ignoreExts.add(trimmed.replace(/^\*/, '').toLowerCase());   // "*.md" -> ".md"
    }
}

const folderName = path.basename(targetDir);
const outputFile = process.argv[4] || (folderName + '.txt');
const files = getAllFiles(targetDir, ignoreDirs).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return !ignoreExts.has(ext) && !BINARY_EXTS.has(ext);
});
let packed = '';

for (const filePath of files) {
    const relativePath = folderName + '/' + path.relative(targetDir, filePath).replace(/\\/g, '/');
    const content = fs.readFileSync(filePath, 'utf8');
    packed += DELIMITER_PREFIX + relativePath + DELIMITER_SUFFIX + '\n' + content;
    if (!content.endsWith('\n')) packed += '\n';
    packed += '\n';
}

const sizeBytes = Buffer.byteLength(packed, 'utf8');
const sizeKB = sizeBytes / 1024;
const sizeMB = sizeKB / 1024;
const sizeLimit = 10;
const skipConfirm = process.argv.includes('--yes');

async function confirmAndWrite() {
    if (sizeMB > sizeLimit && !skipConfirm) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise(resolve => {
            rl.question(`Warning: output is ${sizeMB.toFixed(2)} MB (${files.length} files). Continue? [y/N] `, resolve);
        });
        rl.close();
        if (answer.toLowerCase() !== 'y') { console.log('Aborted.'); process.exit(0); }
    }
    fs.writeFileSync(outputFile, packed, 'utf8');
    console.log(`Packed ${files.length} files -> ${outputFile} (${sizeMB.toFixed(2)} MB)`);
    if (ignoreExts.size) console.log(`Ignored extensions: ${[...ignoreExts].join(', ')}`);
    if (ignoreDirs.size) console.log(`Ignored folders: ${[...ignoreDirs].join(', ')}`);
}

confirmAndWrite();
// used in terminal(powershell) after in the dir of pack.js as following command:
// node pack.js "learn/phase-b(New)"
// node pack.js "learn/phase-b(New)" "*.md, *.txt"
// node pack.js "learn/phase-b(New)" "*.md, node_modules/" "learn-md.txt"
// node pack.js "learn/phase-b(New)" "" "output/custom.txt"