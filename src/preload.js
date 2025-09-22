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

const commands = new Map();

contextBridge.exposeInMainWorld('bridge', {
	openFile: async () => ipcRenderer.invoke('dialog:openFile'),
	openFolder: async () => ipcRenderer.invoke('dialog:openFolder'),
	readFileByPath: async (p) => ipcRenderer.invoke('file:readByPath', p),
	writeFileByPath: async (payload) => ipcRenderer.invoke('file:writeByPath', payload),
	saveAs: async (content) => ipcRenderer.invoke('file:saveAs', content),
	searchInFolder: async (payload) => ipcRenderer.invoke('search:inFolder', payload),
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
	},
	onFileOpened: (callback) => { fileOpenedListeners.add(callback); return () => fileOpenedListeners.delete(callback); },
	onFileSaved: (callback) => { fileSavedListeners.add(callback); return () => fileSavedListeners.delete(callback); },
	onFolderOpened: (callback) => { folderOpenedListeners.add(callback); return () => folderOpenedListeners.delete(callback); },
	// File system operations
	createFolder: async (payload) => ipcRenderer.invoke('fs:createFolder', payload),
	readFolderTree: async (root) => ipcRenderer.invoke('folder:readTree', { root }),
	createFile: async (payload) => ipcRenderer.invoke('fs:createFile', payload),
	renamePath: async (payload) => ipcRenderer.invoke('fs:renamePath', payload),
	movePath: async (payload) => ipcRenderer.invoke('fs:movePath', payload),
	deletePath: async (payload) => ipcRenderer.invoke('fs:deletePath', payload),
	revealInOS: async (targetPath) => ipcRenderer.invoke('os:reveal', targetPath),
	onFsChanged: (callback) => {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on('fs:changed', listener);
		return () => ipcRenderer.removeListener('fs:changed', listener);
	},
	getLastOpened: () => lastOpenedPayload,
}); 