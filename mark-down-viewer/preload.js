const { ipcRenderer } = require('electron');

window.electronAPI = {
    pickFolder:   ()                   => ipcRenderer.invoke('pick-folder'),
    readFile:     (p)                  => ipcRenderer.invoke('read-file', p),
    saveFile:     (p, c)               => ipcRenderer.invoke('save-file', p, c),
    saveFileAs:   (name, c)            => ipcRenderer.invoke('save-file-as', name, c),
    scanDir:      (p, exts)            => ipcRenderer.invoke('scan-dir', p, exts),
    watchDir:     (p, exts)            => ipcRenderer.invoke('watch-dir', p, exts),
    stopWatch:    ()                   => ipcRenderer.invoke('stop-watch'),
    showInExplorer:    (p)             => ipcRenderer.invoke('show-in-explorer', p),
    openFolderInExplorer: (p)          => ipcRenderer.invoke('open-folder-in-explorer', p),
    onFsAdd:      (cb) => ipcRenderer.on('fs-add',    (_e, data) => cb(data)),
    onFsChange:   (cb) => ipcRenderer.on('fs-change', (_e, data) => cb(data)),
    onFsUnlink:   (cb) => ipcRenderer.on('fs-unlink', (_e, data) => cb(data)),
    onSwitchTab:  (cb) => ipcRenderer.on('switch-tab', (_e, dir) => cb(dir)),
    onCloseTab:   (cb) => ipcRenderer.on('close-tab',  () => cb()),
};