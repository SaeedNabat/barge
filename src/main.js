import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import pty from 'node-pty-prebuilt-multiarch';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

// GPU control for weaker hardware: allow opting in via CLI or env
const shouldDisableGpu = process.argv.includes('--disable-gpu') || process.env.BARGE_DISABLE_GPU === '1';
if (shouldDisableGpu) {
	try {
		app.commandLine.appendSwitch('disable-gpu');
		app.commandLine.appendSwitch('disable-gpu-compositing');
		// Optional: reduce raster threads
		app.commandLine.appendSwitch('num-raster-threads', '1');
		// Optional: disable accelerated 2d canvas
		app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
		console.log('[Barge] GPU disabled via flag/env for weaker hardware');
	} catch {}
}

let mainWindow = null;
let splashWindow = null;
let showMainFallbackTimer = null;
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

function fadeIn(win, durationMs = 220, target = 1) {
	return new Promise((resolve) => {
		if (!win || win.isDestroyed?.()) { resolve(); return; }
		try { win.setOpacity(0); } catch {}
		try { if (!win.isVisible?.()) win.show(); } catch {}
		const start = Date.now();
		const tick = () => {
			const t = Math.min(1, (Date.now() - start) / Math.max(1, durationMs));
			const eased = 1 - Math.pow(1 - t, 3);
			try { win.setOpacity(0 + (target - 0) * eased); } catch {}
			if (t < 1 && !win.isDestroyed?.()) setTimeout(tick, 16); else resolve();
		};
		tick();
	});
}

function fadeOut(win, durationMs = 180, from = null) {
	return new Promise((resolve) => {
		if (!win || win.isDestroyed?.()) { resolve(); return; }
		if (from != null) { try { win.setOpacity(from); } catch {} }
		const start = Date.now();
		const tick = () => {
			const t = Math.min(1, (Date.now() - start) / Math.max(1, durationMs));
			const eased = Math.pow(1 - t, 3);
			try { win.setOpacity(eased); } catch {}
			if (t < 1 && !win.isDestroyed?.()) setTimeout(tick, 16); else resolve();
		};
		tick();
	});
}

async function createWindow() {
	// Create splash window first
	splashWindow = new BrowserWindow({
		width: 380,
		height: 200,
		frame: false,
		resizable: false,
		transparent: false,
		alwaysOnTop: false,
		show: true,
		backgroundColor: '#0f1115',
		webPreferences: { sandbox: true }
	});
	try {
		// Embed real logo bytes (fallback to file URL if embedding fails)
		const logoPath = path.join(process.cwd(), 'src', 'assets', 'barge.png');
		let logoSrc = pathToFileURL(logoPath).toString();
		try {
			const buf = await fs.readFile(logoPath);
			logoSrc = `data:image/png;base64,${buf.toString('base64')}`;
		} catch {}
		const splashHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset=\"utf-8\"><title>Loading…</title><style>html,body{margin:0;height:100%;background:#0f1115;color:#e5e7eb;font-family:system-ui,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',sans-serif} .wrap{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px} .logo{width:48px;height:48px;opacity:.98;image-rendering:auto} .spinner{width:28px;height:28px;border:3px solid #1f2937;border-top-color:#22c55e;border-right-color:#06b6d4;border-radius:50%;animation:spin .8s linear infinite;margin-top:6px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class=\"wrap\"><img class=\"logo\" alt=\"Barge\" src=\"${logoSrc}\"/><div>Loading Barge…</div><div class=\"spinner\"></div></div></body></html>`)} `;
		await splashWindow.loadURL(splashHtml);
		try { splashWindow.setOpacity(0); } catch {}
		await fadeIn(splashWindow, 220, 1);
	} catch {}

	// Prepare main window hidden
	mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 1100,
		minHeight: 720,
		resizable: true,
		frame: false,
		titleBarStyle: 'hidden',
		backgroundColor: '#0f1115',
		show: false,
		webPreferences: {
			preload: path.join(process.cwd(), 'src', 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});
	try { mainWindow.setMinimumSize(1100, 720); } catch {}

	// Load renderer: support Vite dev server if provided
	const devServerUrl = process.env.VITE_DEV_SERVER_URL;
	if (devServerUrl) {
		await mainWindow.loadURL(devServerUrl.endsWith('/') ? devServerUrl : devServerUrl + '/');
	} else {
		await (async () => {
			try {
				if (process.env.NODE_ENV === 'production') {
					const distIndex = path.join(process.cwd(), 'dist', 'index.html');
					await fs.access(distIndex);
					await mainWindow.loadFile(distIndex);
					return;
				}
			} catch {}
			await mainWindow.loadFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'));
		})();
	}

	// Fallback: if renderer never signals readiness within 10s, show main anyway
	clearTimeout(showMainFallbackTimer);
	showMainFallbackTimer = setTimeout(async () => {
		try {
			try { mainWindow?.setOpacity?.(0); } catch {}
			mainWindow?.show();
			await fadeIn(mainWindow, 240, 1);
		} catch {}
		try { await fadeOut(splashWindow, 180); } catch {}
		try { splashWindow?.close(); } catch {}
		splashWindow = null;
	}, 10000);

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

// Renderer signals it's fully ready to be shown
ipcMain.handle('app:renderer-ready', async () => {
	try { clearTimeout(showMainFallbackTimer); } catch {}
	try {
		try { mainWindow?.setOpacity?.(0); } catch {}
		mainWindow?.show();
		await fadeIn(mainWindow, 240, 1);
	} catch {}
	try { await fadeOut(splashWindow, 180); } catch {}
	try { splashWindow?.close(); } catch {}
	splashWindow = null;
	return { ok: true };
});

ipcMain.handle('window:minimize', () => { mainWindow?.minimize(); });
ipcMain.handle('window:maximizeToggle', () => {
	if (!mainWindow) return;
	if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.handle('window:close', () => { mainWindow?.close(); });
ipcMain.handle('window:new', async () => { try { await createWindow(); } catch (e) { console.error('new window failed', e); } });

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
							let pos = 0; let idx;
							while ((idx = hay.indexOf(needle, pos)) !== -1 && results.length < maxResults) {
								idxs.push({ start: idx, end: idx + needle.length }); pos = idx + needle.length;
							}
						}
						if (idxs.length) results.push({ file: full, line: i + 1, matches: idxs });
						if (results.length >= maxResults) return;
					}
				} catch {}
			}
		}
	}
	await walk(root);
	return { ok: true, results };
});

// Python linting IPC: tries pyright (JSON), then flake8/pyflakes (text)
ipcMain.handle('lint:python', async (_evt, { filePath, content }) => {
	const tmpBase = tmpdir();
	let tmpPath = null;
	const cwd = filePath ? path.dirname(filePath) : process.cwd();
	try {
		if (!filePath) {
			tmpPath = path.join(tmpBase, `barge_lint_${Date.now()}.py`);
			await fs.writeFile(tmpPath, content ?? '', 'utf8');
		} else {
			tmpPath = filePath;
		}
		// Try ruff JSON
		try {
			const { stdout } = await execFileAsync('ruff', ['check', '--output-format', 'json', tmpPath], { windowsHide: true, maxBuffer: 5 * 1024 * 1024, cwd });
			const arr = JSON.parse(stdout || '[]');
			const diags = arr.map(d => ({
				message: d.message || '',
				severity: (d.kind === 'error' || String(d.code || '').startsWith('E')) ? 'error' : 'warning',
				line: (d.location?.row ?? 1), column: (d.location?.column ?? 1),
				endLine: (d.end_location?.row ?? d.location?.row ?? 1), endColumn: (d.end_location?.column ?? (d.location?.column ?? 1) + 1),
				code: d.code || ''
			}));
			return { ok: true, tool: 'ruff', diagnostics: diags };
		} catch {}
		// Try pyright JSON
		try {
			const { stdout } = await execFileAsync('pyright', ['--outputjson', tmpPath], { windowsHide: true, maxBuffer: 5 * 1024 * 1024, cwd });
			const json = JSON.parse(stdout);
			const diags = [];
			for (const f of (json.diagnostics || [])) {
				const d = f;
				diags.push({
					message: d.message || '',
					severity: (d.severity === 'error') ? 'error' : (d.severity === 'warning' ? 'warning' : 'info'),
					line: (d.range?.start?.line ?? d.range?.start?.lineNumber ?? d.range?.start ?? 0) + 1,
					column: (d.range?.start?.character ?? d.range?.start?.column ?? 0) + 1,
					endLine: (d.range?.end?.line ?? d.range?.end?.lineNumber ?? d.range?.end ?? 0) + 1,
					endColumn: (d.range?.end?.character ?? d.range?.end?.column ?? 0) + 1,
					code: d.rule || d.ruleId || d.code || ''
				});
			}
			return { ok: true, tool: 'pyright', diagnostics: diags };
		} catch {}
		// Try flake8
		try {
			const { stdout } = await execFileAsync('flake8', ['--format=%(path)s:%(row)d:%(col)d: %(code)s %(text)s', tmpPath], { windowsHide: true, maxBuffer: 5 * 1024 * 1024, cwd });
			const diags = (stdout || '').split('\n').filter(Boolean).map(line => {
				const m = line.match(/^(.*):(\d+):(\d+):\s+([A-Z]\d+)\s+(.*)$/);
				if (!m) return null;
				return { message: m[5], severity: m[4].startsWith('E') ? 'error' : 'warning', line: Number(m[2]), column: Number(m[3]), endLine: Number(m[2]), endColumn: Number(m[3]) + 1, code: m[4] };
			}).filter(Boolean);
			return { ok: true, tool: 'flake8', diagnostics: diags };
		} catch {}
		// Try python -m flake8
		try {
			const { stdout } = await execFileAsync('python3', ['-m', 'flake8', '--format=%(path)s:%(row)d:%(col)d: %(code)s %(text)s', tmpPath], { windowsHide: true, maxBuffer: 5 * 1024 * 1024, cwd });
			const diags = (stdout || '').split('\n').filter(Boolean).map(line => {
				const m = line.match(/^(.*):(\d+):(\d+):\s+([A-Z]\d+)\s+(.*)$/);
				if (!m) return null;
				return { message: m[5], severity: m[4].startsWith('E') ? 'error' : 'warning', line: Number(m[2]), column: Number(m[3]), endLine: Number(m[2]), endColumn: Number(m[3]) + 1, code: m[4] };
			}).filter(Boolean);
			return { ok: true, tool: 'flake8', diagnostics: diags };
		} catch {}
		// Try pyflakes
		try {
			const { stdout } = await execFileAsync('pyflakes', [tmpPath], { windowsHide: true, maxBuffer: 5 * 1024 * 1024, cwd });
			const diags = (stdout || '').split('\n').filter(Boolean).map(line => {
				const m = line.match(/^(.*):(\d+):(\d+):\s*(.*)$/);
				if (!m) return null;
				return { message: m[4], severity: 'warning', line: Number(m[2]), column: Number(m[3]), endLine: Number(m[2]), endColumn: Number(m[3]) + 1, code: '' };
			}).filter(Boolean);
			return { ok: true, tool: 'pyflakes', diagnostics: diags };
		} catch {}
		// Try python -m pyflakes
		try {
			const { stdout } = await execFileAsync('python3', ['-m', 'pyflakes', tmpPath], { windowsHide: true, maxBuffer: 5 * 1024 * 1024, cwd });
			const diags = (stdout || '').split('\n').filter(Boolean).map(line => {
				const m = line.match(/^(.*):(\d+):(\d+):\s*(.*)$/);
				if (!m) return null;
				return { message: m[4], severity: 'warning', line: Number(m[2]), column: Number(m[3]), endLine: Number(m[2]), endColumn: Number(m[3]) + 1, code: '' };
			}).filter(Boolean);
			return { ok: true, tool: 'pyflakes', diagnostics: diags };
		} catch {}
		return { ok: true, tool: null, diagnostics: [] };
	} catch (e) {
		return { ok: false, error: String(e), diagnostics: [] };
	} finally {
		// optional temp cleanup could be added
	}
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