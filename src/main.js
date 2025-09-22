import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import pty from 'node-pty-prebuilt-multiarch';

let mainWindow = null;
const terminals = new Map();
let nextTermId = 1;

async function safeReadText(filePath) {
	try {
		// Try UTF-8 first
		return await fs.readFile(filePath, 'utf8');
	} catch (e) {
		try {
			// Fallback to latin1 for files not encoded in UTF-8
			const buf = await fs.readFile(filePath);
			return buf.toString('latin1');
		} catch (e2) {
			throw e2;
		}
	}
}

async function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		frame: false,
		titleBarStyle: 'hidden',
		backgroundColor: '#0f1115',
		webPreferences: {
			preload: path.join(process.cwd(), 'src', 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	await mainWindow.loadFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'));

	const template = [
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

ipcMain.handle('window:minimize', () => { mainWindow?.minimize(); });
ipcMain.handle('window:maximizeToggle', () => {
	if (!mainWindow) return;
	if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.handle('window:close', () => { mainWindow?.close(); });

ipcMain.handle('window:setOpacity', (_evt, value) => {
	try { const v = Math.max(0.6, Math.min(1, Number(value) || 1)); mainWindow?.setOpacity(v); } catch {}
	return { ok: true };
});

ipcMain.handle('window:toggleFullScreen', () => {
	if (!mainWindow) return { ok: false };
	const next = !mainWindow.isFullScreen();
	mainWindow.setFullScreen(next);
	return { ok: true, fullScreen: next };
});

async function openFile() {
	const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
		title: 'Open File',
		properties: ['openFile'],
		filters: [ { name: 'All Files', extensions: ['*'] } ],
	});
	if (canceled || filePaths.length === 0) return;
	const filePath = filePaths[0];
	const content = await safeReadText(filePath);
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
	mainWindow.webContents.send('folder-opened', { root, tree });
}

async function readDirTree(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const items = await Promise.all(entries.map(async (ent) => {
		const fullPath = path.join(dir, ent.name);
		if (ent.isDirectory()) return { type: 'dir', name: ent.name, path: fullPath, children: await readDirTree(fullPath) };
		if (ent.isFile()) return { type: 'file', name: ent.name, path: fullPath };
		return null;
	}));
	return items.filter(Boolean).sort((a, b) => {
		if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

ipcMain.handle('dialog:openFile', async () => {
	try {
		const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
		if (canceled || filePaths.length === 0) return null;
		const filePath = filePaths[0];
		const content = await safeReadText(filePath);
		return { filePath, content };
	} catch (e) {
		dialog.showErrorBox('Open File Failed', String(e));
		return null;
	}
});

ipcMain.handle('dialog:openFolder', async () => {
	try {
		const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
		if (canceled || filePaths.length === 0) return null;
		const root = filePaths[0];
		const tree = await readDirTree(root);
		return { root, tree };
	} catch (e) {
		dialog.showErrorBox('Open Folder Failed', String(e));
		return null;
	}
});

ipcMain.handle('file:readByPath', async (_evt, filePath) => {
	try {
		const content = await safeReadText(filePath);
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

ipcMain.handle('file:saveAs', async (_evt, content) => {
	const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {});
	if (canceled || !filePath) return null;
	await fs.writeFile(filePath, content, 'utf8');
	return { filePath };
});

ipcMain.handle('file:writeByPath', async (_evt, { filePath, content }) => {
	try {
		await fs.writeFile(filePath, content, 'utf8');
		return { ok: true };
	} catch (e) {
		console.error('writeByPath failed', e);
		return { ok: false, error: String(e) };
	}
});

ipcMain.handle('search:inFolder', async (_evt, { root, query, caseSensitive = false, isRegex = false, maxResults = 500 }) => {
	const results = [];
	const re = isRegex ? new RegExp(query, caseSensitive ? 'g' : 'gi') : null;
	async function walk(dir) {
		let entries;
		try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				if (ent.name === 'node_modules' || ent.name === '.git' || ent.name.startsWith('.')) continue;
				await walk(full);
			} else if (ent.isFile()) {
				try {
					const content = await fs.readFile(full, 'utf8');
					const lines = content.split('\n');
					for (let i = 0; i < lines.length; i++) {
						let idxs = [];
						if (isRegex) {
							re.lastIndex = 0;
							let m;
							while ((m = re.exec(lines[i])) && results.length < maxResults) {
								idxs.push({ start: m.index, end: m.index + m[0].length });
								if (!re.global) break;
							}
						} else {
							const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
							const needle = caseSensitive ? query : query.toLowerCase();
							let pos = -1, offset = 0;
							while ((pos = hay.indexOf(needle, offset)) !== -1 && results.length < maxResults) {
								idxs.push({ start: pos, end: pos + needle.length });
								offset = pos + needle.length;
							}
						}
						if (idxs.length) {
							results.push({ filePath: full, line: i + 1, matches: idxs, preview: lines[i] });
							if (results.length >= maxResults) return;
						}
					}
				} catch {}
			}
		}
	}
	await walk(root);
	return results;
});

ipcMain.handle('terminal:create', (_evt, cols, rows, cwd) => {
	const shell = process.env.SHELL || '/bin/bash';
	const shellName = shell.split('/').pop() || 'sh';
	const args = (shellName === 'bash' || shellName === 'zsh') ? ['-l', '-i'] : [];
	const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
	const term = pty.spawn(shell, args, {
		name: 'xterm-color',
		cols: cols || 80,
		rows: rows || 24,
		cwd: cwd || process.cwd(),
		env,
	});
	const id = String(nextTermId++);
	terminals.set(id, term);
	term.onData(data => {
		mainWindow?.webContents.send('terminal:data', { id, data });
	});
	term.onExit(() => {
		terminals.delete(id);
		mainWindow?.webContents.send('terminal:exit', { id });
	});
	return { id };
});

ipcMain.handle('terminal:write', (_evt, { id, data }) => {
	const term = terminals.get(id);
	if (term) term.write(data);
});

ipcMain.handle('terminal:resize', (_evt, { id, cols, rows }) => {
	const term = terminals.get(id);
	if (term) term.resize(cols, rows);
});

ipcMain.handle('terminal:dispose', (_evt, { id }) => {
	const term = terminals.get(id);
	if (term) try { term.kill(); } catch {}
	terminals.delete(id);
});

ipcMain.handle('os:reveal', async (_evt, targetPath) => {
	try { if (targetPath) shell.showItemInFolder(targetPath); } catch {}
	return { ok: true };
});

ipcMain.handle('fs:createFolder', async (_evt, { root, name }) => {
	try {
		if (!root || !name) return { ok: false, error: 'Missing root or name' };
		const sanitized = String(name).trim();
		if (!sanitized) return { ok: false, error: 'Empty name' };
		if (/[\\/:*?"<>|]/.test(sanitized)) return { ok: false, error: 'Invalid characters in name' };
		const newPath = path.join(root, sanitized);
		try {
			const st = await fs.stat(newPath);
			if (st && st.isDirectory()) return { ok: false, error: 'Folder already exists' };
			return { ok: false, error: 'A file with that name already exists' };
		} catch {}
		await fs.mkdir(newPath, { recursive: false });
		mainWindow?.webContents.send('fs:changed', { kind: 'mkdir', path: newPath });
		return { ok: true, path: newPath };
	} catch (e) {
		return { ok: false, error: String(e) };
	}
});

ipcMain.handle('folder:readTree', async (_evt, { root }) => {
	try {
		if (!root) return { ok: false, error: 'Missing root' };
		const tree = await readDirTree(root);
		return { ok: true, root, tree };
	} catch (e) {
		return { ok: false, error: String(e) };
	}
});

ipcMain.handle('fs:createFile', async (_evt, { dir, name }) => {
	try {
		if (!dir || !name) return { ok: false, error: 'Missing dir or name' };
		const filePath = path.join(dir, name);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(filePath, '', { flag: 'wx' });
		mainWindow?.webContents.send('fs:changed', { kind: 'create', path: filePath });
		return { ok: true, path: filePath };
	} catch (e) {
		return { ok: false, error: String(e) };
	}
});

ipcMain.handle('fs:renamePath', async (_evt, { oldPath, newName }) => {
	try {
		if (!oldPath || !newName) return { ok: false, error: 'Missing oldPath or newName' };
		const dir = path.dirname(oldPath);
		const sanitized = String(newName).trim();
		if (!sanitized) return { ok: false, error: 'Empty name' };
		if (/[\\/:*?"<>|]/.test(sanitized)) return { ok: false, error: 'Invalid characters in name' };
		const newPath = path.join(dir, sanitized);
		if (newPath === oldPath) return { ok: true, path: newPath };
		try {
			await fs.access(newPath);
			return { ok: false, error: 'Target already exists' };
		} catch {}
		await fs.rename(oldPath, newPath);
		mainWindow?.webContents.send('fs:changed', { kind: 'rename', path: newPath, oldPath });
		return { ok: true, path: newPath };
	} catch (e) {
		return { ok: false, error: String(e) };
	}
});

ipcMain.handle('fs:movePath', async (_evt, { sourcePath, targetDir, newName }) => {
	try {
		if (!sourcePath || !targetDir) return { ok: false, error: 'Missing sourcePath or targetDir' };
		const baseName = newName && String(newName).trim() ? newName.trim() : path.basename(sourcePath);
		if (/[\\/:*?"<>|]/.test(baseName)) return { ok: false, error: 'Invalid characters in name' };
		await fs.mkdir(targetDir, { recursive: true });
		const destPath = path.join(targetDir, baseName);
		if (destPath === sourcePath) return { ok: true, path: destPath };
		try { await fs.access(destPath); return { ok: false, error: 'Target already exists' }; } catch {}
		await fs.rename(sourcePath, destPath);
		mainWindow?.webContents.send('fs:changed', { kind: 'move', path: destPath, oldPath: sourcePath });
		return { ok: true, path: destPath };
	} catch (e) {
		return { ok: false, error: String(e) };
	}
});

async function rmrf(target) {
	try {
		const stat = await fs.lstat(target);
		if (stat.isDirectory()) {
			const entries = await fs.readdir(target);
			for (const ent of entries) await rmrf(path.join(target, ent));
			await fs.rmdir(target);
		} else {
			await fs.unlink(target);
		}
	} catch (e) {
		throw e;
	}
}

ipcMain.handle('fs:deletePath', async (_evt, { target }) => {
	try {
		if (!target) return { ok: false, error: 'Missing target' };
		await rmrf(target);
		mainWindow?.webContents.send('fs:changed', { kind: 'delete', path: target });
		return { ok: true };
	} catch (e) {
		return { ok: false, error: String(e) };
	}
}); 