const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');

let mainWindow = null;
let watcher = null;
let watchedDir = null;

const BOUNDS_FILE = path.join(app.getPath('userData'), 'window-bounds.json');

function loadBounds() {
    try { return JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf-8')); }
    catch { return null; }
}

function saveBounds() {
    if (!mainWindow) return;
    const data = { bounds: mainWindow.getBounds(), isMaximized: mainWindow.isMaximized() };
    try { fs.writeFileSync(BOUNDS_FILE, JSON.stringify(data)); } catch {}
}

function createWindow() {
    const saved = loadBounds();

    mainWindow = new BrowserWindow({
        width:  saved?.bounds?.width  || 1400,
        height: saved?.bounds?.height || 900,
        x:      saved?.bounds?.x,
        y:      saved?.bounds?.y,
        minWidth: 700,
        minHeight: 500,
        title: 'Markdown.View',
        backgroundColor: '#0c0f17',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            nodeIntegration: true,
        },
    });

    if (saved?.isMaximized) mainWindow.maximize();

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('index.html');

    // Save window bounds on move/resize/close
    mainWindow.on('resize', saveBounds);
    mainWindow.on('move', saveBounds);
    mainWindow.on('close', saveBounds);

    // Intercept Ctrl+Tab/Ctrl+Shift+Tab/Ctrl+W at main process level
    // (Chromium swallows Ctrl+Tab before DOM keydown fires)
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if ((input.control || input.meta) && input.key === 'Tab') {
            event.preventDefault();
            mainWindow.webContents.send('switch-tab', input.shift ? -1 : 1);
        }
        if ((input.control || input.meta) && input.key === 'w') {
            event.preventDefault();
            mainWindow.webContents.send('close-tab');
        }
    });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* ══ IPC: Pick folder ════════════════════════════════════════ */
ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select a folder containing Markdown files',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
});

/* ══ IPC: Read a single file ════════════════════════════════ */
ipcMain.handle('read-file', async (_e, filePath) => {
    try { return fs.readFileSync(filePath, 'utf-8'); }
    catch { return null; }
});

/* ══ IPC: Save a file ═══════════════════════════════════════ */
ipcMain.handle('save-file', async (_e, filePath, content) => {
    try { fs.writeFileSync(filePath, content, 'utf-8'); return true; }
    catch { return false; }
});

/* ══ IPC: Save-as dialog ════════════════════════════════════ */
ipcMain.handle('save-file-as', async (_e, defaultName, content) => {
    const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultName,
        filters: [
            { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
            { name: 'Code Files', extensions: ['cs', 'js', 'ts', 'py', 'java', 'cpp', 'c', 'go', 'rs', 'rb', 'php', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'sql'] },
            { name: 'All Files', extensions: ['*'] },
        ],
    });
    if (result.canceled || !result.filePath) return null;
    try {
        fs.writeFileSync(result.filePath, content, 'utf-8');
        return result.filePath;
    } catch { return null; }
});

/* ══ Scan folder for files (recursive) ═════════════════════ */
function scanDir(dirPath, extensions) {
    const extPattern = extensions && extensions.length
        ? new RegExp('\\.(' + extensions.join('|') + ')$', 'i')
        : /\.(md|markdown|txt)$/i;
    const results = [];
    function walk(dir, rel) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (e.name === '.git' || e.name === 'node_modules') continue;
            const full = path.join(dir, e.name);
            const relPath = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) {
                walk(full, relPath);
            } else if (extPattern.test(e.name)) {
                let stat;
                try { stat = fs.statSync(full); } catch { continue; }
                results.push({
                    name: e.name,
                    path: full,
                    relPath,
                    dir: rel || '',
                    size: stat.size,
                    mtime: stat.mtimeMs,
                });
            }
        }
    }
    walk(dirPath, '');
    return results;
}

/* ══ IPC: Scan directory ════════════════════════════════════ */
ipcMain.handle('scan-dir', async (_e, dirPath, extensions) => {
    return scanDir(dirPath, extensions);
});

/* ══ IPC: Start watching a directory ════════════════════════ */
ipcMain.handle('watch-dir', async (_e, dirPath, extensions) => {
    if (watcher) { await watcher.close(); watcher = null; }
    watchedDir = dirPath;

    watcher = chokidar.watch(dirPath, {
        ignored: /([\/\\])(node_modules|\.git)([\/\\]|$)/,
        persistent: true,
        ignoreInitial: true,
        depth: 20,
    });

    const extPattern = extensions && extensions.length
        ? new RegExp('\\.(' + extensions.join('|') + ')$', 'i')
        : /\.(md|markdown|txt)$/i;
    const isMd = (p) => extPattern.test(p);

    watcher.on('add', (filePath) => {
        if (!isMd(filePath)) return;
        try {
            const relPath = path.relative(dirPath, filePath).replace(/\\/g, '/');
            const stat = fs.statSync(filePath);
            mainWindow?.webContents.send('fs-add', {
                name: path.basename(filePath),
                path: filePath,
                relPath,
                dir: path.dirname(relPath) === '.' ? '' : path.dirname(relPath),
                size: stat.size,
                mtime: stat.mtimeMs,
            });
        } catch { /* file may be locked or removed instantly */ }
    });

    watcher.on('change', (filePath) => {
        if (!isMd(filePath)) return;
        try {
            const relPath = path.relative(dirPath, filePath).replace(/\\/g, '/');
            const stat = fs.statSync(filePath);
            mainWindow?.webContents.send('fs-change', {
                path: filePath,
                relPath,
                size: stat.size,
                mtime: stat.mtimeMs,
            });
        } catch { /* file may be locked briefly */ }
    });

    watcher.on('unlink', (filePath) => {
        if (!isMd(filePath)) return;
        mainWindow?.webContents.send('fs-unlink', { path: filePath });
    });

    return true;
});

/* ══ IPC: Stop watching ═════════════════════════════════════ */
ipcMain.handle('stop-watch', async () => {
    if (watcher) { await watcher.close(); watcher = null; }
    watchedDir = null;
    return true;
});

/* ══ IPC: Show in Explorer ═══════════════════════════════ */
ipcMain.handle('show-in-explorer', async (_e, filePath) => {
    shell.showItemInFolder(filePath);
});

ipcMain.handle('open-folder-in-explorer', async (_e, folderPath) => {
    shell.openPath(folderPath);
});

/* ══ Cleanup on quit ════════════════════════════════════════ */
app.on('before-quit', () => {
    if (watcher) watcher.close();
});