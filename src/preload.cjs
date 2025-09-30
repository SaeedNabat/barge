const { contextBridge, ipcRenderer } = require('electron');

let lastOpenedPayload = null;

const fileOpenedListeners = new Set();
const fileSavedListeners = new Set();
const folderOpenedListeners = new Set();

ipcRenderer.on('file-opened', (_event, payload) => {
	lastOpenedPayload = payload;
	for (const cb of fileOpenedListeners) cb(payload);
});

ipcRenderer.on('file-saved', (_event, payload) => {
	for (const cb of fileSavedListeners) cb(payload);
});

ipcRenderer.on('folder-opened', (_event, payload) => {
	for (const cb of folderOpenedListeners) cb(payload);
});

ipcRenderer.on('fs:changed', (_e, payload) => {
	for (const cb of (globalThis.__fsChangedListeners || [])) try { cb(payload); } catch {}
});

const commands = new Map();

contextBridge.exposeInMainWorld('bridge', {
	openFile: async () => ipcRenderer.invoke('dialog:openFile'),
	openFolder: async () => ipcRenderer.invoke('dialog:openFolder'),
	readFileByPath: async (p) => ipcRenderer.invoke('file:readByPath', p),
	writeFileByPath: async (payload) => ipcRenderer.invoke('file:writeByPath', payload),
	saveAs: async (content) => ipcRenderer.invoke('file:saveAs', content),
	searchInFolder: async (payload) => ipcRenderer.invoke('search:inFolder', payload),
	createFolder: async ({ root, name }) => ipcRenderer.invoke('fs:createFolder', { root, name }),
	createFile: async ({ dir, name }) => ipcRenderer.invoke('fs:createFile', { dir, name }),
	readFolderTree: async (root) => ipcRenderer.invoke('folder:readTree', { root }),
	readFolderChildren: async (dir) => ipcRenderer.invoke('folder:readChildren', { dir }),
	renamePath: async ({ oldPath, newName }) => ipcRenderer.invoke('fs:renamePath', { oldPath, newName }),
	deletePath: async ({ target }) => ipcRenderer.invoke('fs:deletePath', { target }),
	movePath: async ({ sourcePath, targetDir, newName }) => ipcRenderer.invoke('fs:movePath', { sourcePath, targetDir, newName }),
	revealInOS: async (targetPath) => ipcRenderer.invoke('os:reveal', targetPath),
	terminal: {
		create: async (cols, rows, cwd) => ipcRenderer.invoke('terminal:create', cols, rows, cwd),
		write: async (id, data) => ipcRenderer.invoke('terminal:write', { id, data }),
		resize: async (id, cols, rows) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
		dispose: async (id) => ipcRenderer.invoke('terminal:dispose', { id }),
		onData: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('terminal:data', l); return () => ipcRenderer.removeListener('terminal:data', l); },
		onExit: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('terminal:exit', l); return () => ipcRenderer.removeListener('terminal:exit', l); },
	},
	listExtensions: async () => ipcRenderer.invoke('extensions:list'),
	registerCommand: (id, fn) => { commands.set(id, fn); },
	executeCommand: async (id, ...args) => { const fn = commands.get(id); if (fn) return await fn(...args); },
	window: {
		minimize: () => ipcRenderer.invoke('window:minimize'),
		maximizeToggle: () => ipcRenderer.invoke('window:maximizeToggle'),
		close: () => ipcRenderer.invoke('window:close'),
		setOpacity: (value) => ipcRenderer.invoke('window:setOpacity', value),
		toggleFullScreen: () => ipcRenderer.invoke('window:toggleFullScreen'),
		newWindow: () => ipcRenderer.invoke('window:new'),
	},
	lint: {
		python: async ({ filePath, content }) => ipcRenderer.invoke('lint:python', { filePath, content }),
	},
	appReady: async () => ipcRenderer.invoke('app:renderer-ready'),
	onFileOpened: (callback) => { fileOpenedListeners.add(callback); return () => fileOpenedListeners.delete(callback); },
	onFileSaved: (callback) => { fileSavedListeners.add(callback); return () => fileSavedListeners.delete(callback); },
	onFolderOpened: (callback) => { folderOpenedListeners.add(callback); return () => folderOpenedListeners.delete(callback); },
	onFsChanged: (callback) => {
		if (!globalThis.__fsChangedListeners) globalThis.__fsChangedListeners = [];
		globalThis.__fsChangedListeners.push(callback);
		return () => {
			const arr = globalThis.__fsChangedListeners;
			if (!arr) return;
			const i = arr.indexOf(callback);
			if (i !== -1) arr.splice(i, 1);
		};
	},
	getLastOpened: () => lastOpenedPayload,
}); 