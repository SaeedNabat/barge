import { contextBridge, ipcRenderer } from 'electron';

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
	saveAs: async (content) => ipcRenderer.invoke('file:saveAs', content),
	listExtensions: async () => ipcRenderer.invoke('extensions:list'),
	registerCommand: (id, fn) => { commands.set(id, fn); },
	executeCommand: async (id, ...args) => { const fn = commands.get(id); if (fn) return await fn(...args); },
	onFileOpened: (callback) => {
		fileOpenedListeners.add(callback);
		return () => fileOpenedListeners.delete(callback);
	},
	onFileSaved: (callback) => {
		fileSavedListeners.add(callback);
		return () => fileSavedListeners.delete(callback);
	},
	onFolderOpened: (callback) => {
		folderOpenedListeners.add(callback);
		return () => folderOpenedListeners.delete(callback);
	},
	getLastOpened: () => lastOpenedPayload,
}); 