import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';

let mainWindow = null;

async function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		webPreferences: {
			preload: path.join(process.cwd(), 'src', 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	await mainWindow.loadFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'));

	const template = [
		{
			label: 'File',
			submenu: [
				{ label: 'Open...', accelerator: 'CmdOrCtrl+O', click: () => openFile() },
				{ label: 'Open Folder...', accelerator: 'CmdOrCtrl+K CmdOrCtrl+O', click: () => openFolder() },
				{ label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => saveFile() },
				{ type: 'separator' },
				{ role: 'quit' },
			],
		},
		{ role: 'viewMenu' },
	];
	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

async function openFile() {
	const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
		title: 'Open File',
		properties: ['openFile'],
		filters: [
			{ name: 'All Files', extensions: ['*'] },
		],
	});
	if (canceled || filePaths.length === 0) return;
	const filePath = filePaths[0];
	const content = await fs.readFile(filePath, 'utf8');
	console.log('[main] sending file-opened', filePath);
	mainWindow.webContents.send('file-opened', { filePath, content });
}

async function openFolder() {
	const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
		title: 'Open Folder',
		properties: ['openDirectory'],
	});
	if (canceled || filePaths.length === 0) return;
	const root = filePaths[0];
	const tree = await readDirTree(root);
	console.log('[main] sending folder-opened', root);
	mainWindow.webContents.send('folder-opened', { root, tree });
}

async function readDirTree(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const items = await Promise.all(entries.map(async (ent) => {
		const fullPath = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			return { type: 'dir', name: ent.name, path: fullPath, children: await readDirTree(fullPath) };
		} else if (ent.isFile()) {
			return { type: 'file', name: ent.name, path: fullPath };
		} else {
			return null;
		}
	}));
	return items.filter(Boolean).sort((a, b) => {
		if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

async function saveFile() {
	const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
		title: 'Save File',
		filters: [
			{ name: 'All Files', extensions: ['*'] },
		],
	});
	if (canceled || !filePath) return;
	const content = await mainWindow.webContents.executeJavaScript('window.__EDITOR_GET_VALUE__()');
	await fs.writeFile(filePath, content, 'utf8');
	console.log('[main] sending file-saved', filePath);
	mainWindow.webContents.send('file-saved', { filePath });
}

ipcMain.handle('dialog:openFile', async () => {
	const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'] });
	if (canceled || filePaths.length === 0) return null;
	const filePath = filePaths[0];
	const content = await fs.readFile(filePath, 'utf8');
	return { filePath, content };
});

ipcMain.handle('dialog:openFolder', async () => {
	const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
	if (canceled || filePaths.length === 0) return null;
	const root = filePaths[0];
	const tree = await readDirTree(root);
	return { root, tree };
});

ipcMain.handle('file:readByPath', async (_evt, filePath) => {
	try {
		const content = await fs.readFile(filePath, 'utf8');
		return { filePath, content };
	} catch (e) {
		console.error('readByPath failed', e);
		return { filePath, content: '' };
	}
});

ipcMain.handle('extensions:list', async () => {
	const root = path.join(homedir(), '.barge', 'extensions');
	try {
		const dirs = await fs.readdir(root, { withFileTypes: true });
		const exts = [];
		for (const d of dirs) {
			if (!d.isDirectory()) continue;
			const extDir = path.join(root, d.name);
			try {
				const manifestPath = path.join(extDir, 'manifest.json');
				const manifestRaw = await fs.readFile(manifestPath, 'utf8');
				const manifest = JSON.parse(manifestRaw);
				const mainPath = path.join(extDir, manifest.main || 'index.js');
				exts.push({ id: manifest.id || d.name, name: manifest.name || d.name, version: manifest.version || '0.0.0', mainUrl: pathToFileURL(mainPath).toString() });
			} catch {}
		}
		return exts;
	} catch {
		return [];
	}
});

import { pathToFileURL } from 'node:url';

ipcMain.handle('file:saveAs', async (_evt, content) => {
	const { canceled, filePath } = await dialog.showSaveDialog({});
	if (canceled || !filePath) return null;
	await fs.writeFile(filePath, content, 'utf8');
	return { filePath };
}); 