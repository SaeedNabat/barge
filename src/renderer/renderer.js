// Ensure Monaco AMD config only runs once
if (!window.__MONACO_CONFIGURED__) {
	window.__MONACO_CONFIGURED__ = true;
	if (window.require && window.require.config) {
		const monacoBase = new URL('../../node_modules/monaco-editor/min/', document.baseURI).toString();
		require.config({ paths: { vs: monacoBase + 'vs' } });
	}
	// Fix worker loading under file:// with CSP via blob and correct baseUrl
	window.MonacoEnvironment = {
		baseUrl: new URL('../../node_modules/monaco-editor/min/', document.baseURI).toString(),
		getWorkerUrl: function (_moduleId, _label) {
			const abs = new URL('../../node_modules/monaco-editor/min/', document.baseURI).toString();
			const code = `self.MonacoEnvironment = { baseUrl: '${abs}' }; importScripts('${abs}vs/base/worker/workerMain.js');`;
			const blob = new Blob([code], { type: 'text/javascript' });
			return URL.createObjectURL(blob);
		}
	};
}

// Robust top-level helpers
function safeBind(el, type, handler) { if (el && !(el.dataset && el.dataset.bound === '1')) { el.addEventListener(type, handler); if (el.dataset) el.dataset.bound = '1'; } }
function hideAnyModal() { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); }
function closeCmdPalette() { const el = document.getElementById('cmdPalette'); if (!el) return; el.classList.add('hidden'); document.getElementById('cmdInput')?.blur(); }

function openInTabSafe(filePath, content) {
	if (typeof window.bargeOpenFileInTab === 'function') {
		window.bargeOpenFileInTab(filePath, content);
		const modal = document.getElementById('emptyStateModal'); if (modal) modal.classList.add('hidden');
		return;
	}
	window.__PENDING_OPEN__ = { filePath, content };
}

let monacoRef = null; let editor = null; let openTabs = []; let activeTabPath = null;
const modelsByPath = new Map(); const autosaveTimers = new Map();
let currentWorkspaceRoot = null; let isOpeningFile = false; let isOpeningFolder = false;
let untitledCounter = 1; let termInstance = null; let termId = null; let selectedDirectoryPath = null; let refreshTimer = null;

// Ensure createFolderFlow is globally available before any bindings
window.createFolderFlow = async function createFolderFlow() {
	if (!currentWorkspaceRoot) { alert('Open a folder first to create a subfolder.'); return; }
	const base = selectedDirectoryPath || currentWorkspaceRoot;
	const name = await showInputModal({ title: 'New Folder', label: 'Folder name', placeholder: 'e.g. src', okText: 'Create Folder', validate: (v) => {
		if (!v) return 'Name is required';
		if (/[\\/:*?"<>|]/.test(v)) return 'Invalid characters: \\/:*?"<>|';
		return '';
	}, onSubmit: async (val) => {
		const res = await window.bridge.createFolder({ root: base, name: val });
		if (!res?.ok) return res?.error || 'Failed to create folder';
		return '';
	}});
	if (!name) return;
	/* incremental update handled by fs:changed */
};

async function showInputModal({ title, label, placeholder, okText = 'Create', validate, onSubmit }) {
	return new Promise((resolve) => {
		const modal = document.getElementById('inputModal');
		const input = document.getElementById('inputField');
		const titleEl = document.getElementById('inputTitle');
		const labelEl = document.getElementById('inputLabel');
		const errorEl = document.getElementById('inputError');
		const btnOk = document.getElementById('inputOk');
		const btnCancel = document.getElementById('inputCancel');
		titleEl.textContent = title || 'Enter Name';
		labelEl.textContent = label || 'Name';
		btnOk.textContent = okText;
		input.value = '';
		input.placeholder = placeholder || '';
		errorEl.style.display = 'none';
		errorEl.textContent = '';
		modal.classList.remove('hidden');
		setTimeout(() => input.focus(), 0);
		let submitting = false;
		async function doSubmit() {
			if (submitting) return;
			submitting = true;
			const val = input.value.trim();
			if (validate) {
				const msg = validate(val);
				if (msg) { errorEl.textContent = msg; errorEl.style.display = 'block'; submitting = false; return; }
			}
			if (onSubmit) {
				try {
					const err = await onSubmit(val);
					if (err) { errorEl.textContent = err; errorEl.style.display = 'block'; submitting = false; return; }
				} catch (e) {
					errorEl.textContent = String(e);
					errorEl.style.display = 'block';
					submitting = false;
					return;
				}
			}
			close(val || null);
		}
		function close(v) {
			modal.classList.add('hidden');
			btnOk.removeEventListener('click', onOk);
			btnCancel.removeEventListener('click', onCancel);
			input.removeEventListener('keydown', onKey);
			resolve(v);
		}
		function onOk() { doSubmit(); }
		function onCancel() { close(null); }
		function onKey(e) { if (e.key === 'Enter') doSubmit(); if (e.key === 'Escape') onCancel(); }
		btnOk.addEventListener('click', onOk);
		btnCancel.addEventListener('click', onCancel);
		input.addEventListener('keydown', onKey);
	});
}

async function refreshTree() {
	// Capture current tree state (expanded dirs and selection)
	const state = collectTreeState();
	const updated = await window.bridge.readFolderTree(currentWorkspaceRoot);
	if (updated?.ok) {
		currentWorkspaceRoot = updated.root;
		if (window.bargeRenderTree) window.bargeRenderTree(updated.root, updated.tree);
		else renderTree(updated.root, updated.tree, state);
		updateEmptyState();
	}
}

function scheduleRefreshTree() {
	clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => { /* no-op: incremental updates now handle changes */ }, 100);
}

function collectTreeState() {
	const fileTreeEl = document.getElementById('fileTree');
	const expandedPaths = new Set();
	let selectedPath = null;
	if (fileTreeEl) {
		fileTreeEl.querySelectorAll('.item').forEach((item) => {
			const path = item.dataset?.path;
			const children = item.nextSibling;
			if (path && children && children.classList && children.classList.contains('children') && children.style.display === 'block') {
				expandedPaths.add(path);
			}
			if (item.classList.contains('selected')) selectedPath = path || selectedPath;
		});
	}
	return { expandedPaths, selectedPath };
}

function createUntitled() {
	const name = `Untitled-${untitledCounter++}.txt`;
	if (typeof window.bargeOpenFileInTab === 'function') {
		window.bargeOpenFileInTab(name, '');
		updateEmptyState();
	} else {
		window.__PENDING_OPEN__ = { filePath: name, content: '' };
		window.dispatchEvent(new Event('barge:pending-open'));
	}
}

function isUntitledPath(p) {
	return p && p.startsWith('Untitled-');
}

const settings = {
	fontFamily: 'JetBrains Mono, Fira Code, Menlo, Consolas, "Liberation Mono", monospace',
	fontSize: 14,
	theme: 'dark',
	autoSave: 'off', // off | afterDelay | onFocusChange
	autoSaveDelay: 1000,
	wordWrap: 'off', // off | on
	lineNumbers: 'on', // on | off
	renderWhitespace: 'none', // none | all | selection
};

function loadSettings() {
	try { const raw = localStorage.getItem('barge:settings'); if (raw) Object.assign(settings, JSON.parse(raw)); } catch {}
	document.body.classList.toggle('theme-light', settings.theme === 'light');
}

function saveSettings() { localStorage.setItem('barge:settings', JSON.stringify(settings)); }

function applySettings() {
	if (!editor || !monacoRef) return;
	editor.updateOptions({ fontFamily: settings.fontFamily, fontSize: settings.fontSize });
	monacoRef.editor.setTheme(settings.theme === 'light' ? 'vs' : 'barge-dark');
	document.body.classList.toggle('theme-light', settings.theme === 'light');
	editor.updateOptions({ wordWrap: settings.wordWrap, lineNumbers: settings.lineNumbers, renderWhitespace: settings.renderWhitespace });
}

function updateEmptyState() {
	const modal = document.getElementById('emptyStateModal');
	const hasAny = openTabs.length > 0 || !!currentWorkspaceRoot;
	modal?.classList.toggle('hidden', hasAny);
}

function clearEditor() {
	if (editor) {
		editor.setValue('');
		editor.updateOptions({ language: 'plaintext' });
	}
	const filenameEl = document.getElementById('filename');
	if (filenameEl) filenameEl.textContent = '';
}

// Early bootstrap to ensure clicks work even if Monaco hasn't finished loading
window.addEventListener('DOMContentLoaded', () => {
	loadSettings();

	const menubar = document.getElementById('menubar');
	menubar?.addEventListener('click', (e) => {
		if ((e.target instanceof Element) && e.target.closest('.menu-item')) {
			menubar.querySelectorAll('.menu.open').forEach(el => el.classList.remove('open'));
		}
	});

	async function openFileFlow() {
		if (isOpeningFile) return; isOpeningFile = true;
		try {
			hideAnyModal();
			const res = await window.bridge?.openFile?.();
			if (res && res.filePath) {
				openInTabSafe(res.filePath, res.content);
			}
		} finally { isOpeningFile = false; }
	}

	async function openFolderFlow() {
		if (isOpeningFolder) return; isOpeningFolder = true;
		try {
			hideAnyModal();
			const payload = await window.bridge?.openFolder?.();
			if (payload && payload.root) {
				if (window.bargeRenderTree) {
					currentWorkspaceRoot = payload.root;
					window.bargeRenderTree(payload.root, payload.tree);
					updateEmptyState();
				} else {
					window.__PENDING_FOLDER__ = payload;
					window.dispatchEvent(new Event('barge:pending-folder'));
				}
			}
		} finally { isOpeningFolder = false; }
	}

	document.addEventListener('click', async (e) => {
		const target = e.target;
		if (!(target instanceof Element)) return;
		if (target.id === 'emptyOpenFile') {
			e.preventDefault(); hideAnyModal();
			openFileFlow();
		}
		if (target.id === 'emptyOpenFolder') {
			e.preventDefault(); hideAnyModal();
			openFolderFlow();
		}
		if (target.id === 'emptyClose') {
			e.preventDefault(); hideAnyModal();
		}
	}, true);

	const mFileOpen = document.getElementById('mFileOpen');
	const mFileOpenFolder = document.getElementById('mFileOpenFolder');
	const mFileSave = document.getElementById('mFileSave');
	const mFileSaveAs = document.getElementById('mFileSaveAs');
	const mFileExit = document.getElementById('mFileExit');
	const mEditPreferences = document.getElementById('mEditPreferences');
	const mThemeDark = document.getElementById('mThemeDark');
	const mThemeLight = document.getElementById('mThemeLight');
	const prefsModal = document.getElementById('prefsModal');
	const prefFontFamily = document.getElementById('prefFontFamily');
	const prefFontSize = document.getElementById('prefFontSize');
	const prefAutoSave = document.getElementById('prefAutoSave');
	const prefAutoSaveDelay = document.getElementById('prefAutoSaveDelay');
	const autoSaveDelayField = document.getElementById('autoSaveDelayField');
	const prefsSave = document.getElementById('prefsSave');
	const prefsCancel = document.getElementById('prefsCancel');

	const mFileNew = document.getElementById('mFileNew');
	const newFileBtn = document.getElementById('sidebarNewFile');

	const mEditFind = document.getElementById('mEditFind');
	const mEditFindInFiles = document.getElementById('mEditFindInFiles');
	const searchPanel = document.getElementById('searchPanel');
	const searchRun = document.getElementById('searchRun');
	const searchQuery = document.getElementById('searchQuery');
	const searchCase = document.getElementById('searchCase');
	const searchRegex = document.getElementById('searchRegex');
	const searchResults = document.getElementById('searchResults');
	const searchClear = document.getElementById('searchClear');

	const cmdPalette = document.getElementById('cmdPalette');
	const cmdBackdrop = document.getElementById('cmdBackdrop');
	const cmdCard = document.getElementById('cmdCard');
	const cmdInput = document.getElementById('cmdInput');
	const cmdList = document.getElementById('cmdList');
	const cmdEmpty = document.getElementById('cmdEmpty');

	// Command palette state
	let cmdItems = [];
	let cmdFiltered = [];
	let cmdSelected = 0;
	let lastShiftTime = 0;
	let cmdHistory = [];

	function loadCmdHistory() {
		try { const raw = localStorage.getItem('barge:cmdHistory'); if (raw) cmdHistory = JSON.parse(raw) || []; } catch {}
	}
	function saveCmdHistory() { try { localStorage.setItem('barge:cmdHistory', JSON.stringify(cmdHistory.slice(0, 50))); } catch {} }

	function pushHistory(id) {
		const idx = cmdHistory.indexOf(id);
		if (idx !== -1) cmdHistory.splice(idx, 1);
		cmdHistory.unshift(id);
		saveCmdHistory();
	}

	function openCmdPalette() {
		loadCmdHistory();
		cmdInput.value = '';
		filterCommands('');
		cmdPalette.classList.remove('hidden');
		setTimeout(() => cmdInput.focus(), 0);
	}
	function toggleCmdPalette() { if (cmdPalette.classList.contains('hidden')) openCmdPalette(); else closeCmdPalette(); }

	function renderCmdList(list) {
		cmdList.innerHTML = '';
		if (!list.length) { cmdEmpty.classList.remove('hidden'); return; }
		cmdEmpty.classList.add('hidden');
		list.forEach((item, i) => {
			const el = document.createElement('div');
			el.className = 'cmd-item' + (i === cmdSelected ? ' selected' : '');
			el.innerHTML = `<div>${item.title}</div><div class="hint">${item.hint || ''}</div>`;
			el.addEventListener('click', () => executeCmd(item));
			cmdList.appendChild(el);
		});
	}

	function filterCommands(q) {
		const query = (q || '').trim().toLowerCase();
		if (!query) {
			const byId = new Map(cmdItems.map(c => [c.id, c]));
			const hist = cmdHistory.map(id => byId.get(id)).filter(Boolean);
			const rest = cmdItems.filter(c => !cmdHistory.includes(c.id));
			cmdFiltered = [...hist, ...rest].slice(0, 100);
			cmdSelected = 0;
			renderCmdList(cmdFiltered);
			return;
		}
		const scored = [];
		for (const c of cmdItems) {
			const text = `${c.title}\n${c.id}`.toLowerCase();
			let score = 0;
			let lastIndex = -1;
			for (const ch of query) {
				const idx = text.indexOf(ch, lastIndex + 1);
				if (idx === -1) { score = -1; break; }
				score += (idx - lastIndex) <= 2 ? 3 : 1;
				lastIndex = idx;
			}
			if (score >= 0) scored.push({ c, score });
		}
		scored.sort((a,b) => b.score - a.score);
		cmdFiltered = scored.map(s => s.c).slice(0, 100);
		cmdSelected = 0;
		renderCmdList(cmdFiltered);
	}

	function executeCmd(item) {
		if (!item) return;
		pushHistory(item.id);
		closeCmdPalette();
		setTimeout(() => item.run?.(), 0);
	}

	function buildCommands() {
		cmdItems = [
			{ id: 'file:open', title: 'File: Open…', hint: 'Ctrl+O', run: () => mFileOpen?.click() },
			{ id: 'file:openFolder', title: 'File: Open Folder…', hint: 'Ctrl+K Ctrl+O', run: () => mFileOpenFolder?.click() },
			{ id: 'file:save', title: 'File: Save', hint: 'Ctrl+S', run: () => mFileSave?.click() },
			{ id: 'file:saveAll', title: 'File: Save All', run: () => mFileSaveAll?.click() },
			{ id: 'file:closeAll', title: 'File: Close All', run: () => mFileCloseAll?.click() },
			{ id: 'file:reopenClosed', title: 'File: Reopen Closed Tab', run: () => mFileReopenClosed?.click() },
			{ id: 'file:saveAs', title: 'File: Save As…', hint: 'Ctrl+Shift+S', run: () => mFileSaveAs?.click() },
			{ id: 'edit:find', title: 'Edit: Find', hint: 'Ctrl+F', run: () => mEditFind?.click() },
			{ id: 'edit:findInFiles', title: 'Edit: Find in Files', hint: 'Ctrl+Shift+F', run: () => mEditFindInFiles?.click() },
			{ id: 'edit:goToLine', title: 'Edit: Go to Line…', hint: 'Ctrl+G', run: () => mEditGoToLine?.click() },
			{ id: 'view:toggleStatusBar', title: 'View: Toggle Status Bar', run: () => { const sb = document.querySelector('.statusbar'); if (sb) sb.style.display = (sb.style.display === 'none' ? '' : 'none'); } },
			{ id: 'view:toggleTheme', title: 'View: Toggle Theme (Dark/Light)', run: () => { settings.theme = settings.theme === 'light' ? 'dark' : 'light'; saveSettings(); applySettings(); } },
			{ id: 'view:toggleWordWrap', title: 'View: Toggle Word Wrap', hint: 'Alt+Z', run: () => mViewToggleWordWrap?.click() },
			{ id: 'view:toggleLineNumbers', title: 'View: Toggle Line Numbers', run: () => mViewToggleLineNumbers?.click() },
			{ id: 'view:toggleWhitespace', title: 'View: Toggle Render Whitespace', run: () => mViewToggleWhitespace?.click() },
			{ id: 'editor:toggleMinimap', title: 'Editor: Toggle Minimap', run: () => { if (editor) { const opts = editor.getRawOptions(); editor.updateOptions({ minimap: { enabled: !opts.minimap?.enabled } }); } } },
		];
	}
	buildCommands();
	loadCmdHistory();

	safeBind(mFileOpen, 'click', openFileFlow);
	safeBind(mFileOpenFolder, 'click', openFolderFlow);
safeBind(mFileSave, 'click', async () => { if (editor) await saveActiveFile(); });
safeBind(mFileSaveAs, 'click', async () => { if (!editor) return; const content = editor.getModel()?.getValue(); const res = await window.bridge.saveAs(content); if (res?.filePath) { const old = activeTabPath; activeTabPath = res.filePath; const model = modelsByPath.get(old); if (model) { modelsByPath.delete(old); const newModel = monacoRef.editor.createModel(content ?? '', guessLanguage(res.filePath), monacoRef.Uri.file(res.filePath)); modelsByPath.set(res.filePath, newModel); editor.setModel(newModel); } const tab = openTabs.find(t => t.path === old); if (tab) { tab.path = res.filePath; tab.title = basename(res.filePath); tab._titleEl.textContent = tab.title; } updateEmptyState(); } });
safeBind(mFileNew, 'click', () => { hideAnyModal(); if (monacoRef) createUntitled(); else { window.addEventListener('barge:monaco-ready', () => createUntitled(), { once: true }); } });
// removed early newFileBtn binding to allow folder-aware handler later
safeBind(mFileExit, 'click', () => window.bridge?.window?.close?.());

	// Basic menu bindings
	safeBind(mEditPreferences, 'click', () => { if (typeof openPrefs === 'function') openPrefs(); else setTimeout(() => openPrefs?.(), 100); });
	safeBind(mThemeDark, 'click', () => { settings.theme = 'dark'; saveSettings(); applySettings(); });
	safeBind(mThemeLight, 'click', () => { settings.theme = 'light'; saveSettings(); applySettings(); });

	function openPrefs() { prefFontFamily.value = settings.fontFamily; prefFontSize.value = settings.fontSize; prefAutoSave.value = settings.autoSave; prefAutoSaveDelay.value = settings.autoSaveDelay; autoSaveDelayField.style.display = settings.autoSave === 'afterDelay' ? 'grid' : 'none'; prefsModal.classList.remove('hidden'); }
	function closePrefs() { prefsModal.classList.add('hidden'); }

	safeBind(prefsCancel, 'click', closePrefs);
	safeBind(prefAutoSave, 'change', () => { autoSaveDelayField.style.display = prefAutoSave.value === 'afterDelay' ? 'grid' : 'none'; });
	safeBind(prefsSave, 'click', () => { settings.fontFamily = prefFontFamily.value || settings.fontFamily; settings.fontSize = Math.max(8, Math.min(48, parseInt(prefFontSize.value || settings.fontSize, 10))); settings.autoSave = prefAutoSave.value; settings.autoSaveDelay = Math.max(100, Math.min(10000, parseInt(prefAutoSaveDelay.value || settings.autoSaveDelay, 10))); saveSettings(); applySettings(); closePrefs(); });

	safeBind(mEditFind, 'click', () => { editor?.getAction('actions.find')?.run(); });
	safeBind(mEditFindInFiles, 'click', () => { searchPanel.classList.toggle('hidden'); searchQuery.focus(); });

	safeBind(searchRun, 'click', async () => {
		if (!currentWorkspaceRoot) return;
		searchResults.innerHTML = '';
		const q = searchQuery.value;
		if (!q) return;
		const res = await window.bridge.searchInFolder({ root: currentWorkspaceRoot, query: q, caseSensitive: searchCase.checked, isRegex: searchRegex.checked });
		for (const r of res) {
			const item = document.createElement('div'); item.className = 'result-item';
			item.addEventListener('click', async () => { const file = await window.bridge.readFileByPath(r.filePath); openInTabSafe(r.filePath, file?.content ?? ''); if (editor) { const model = editor.getModel(); if (model) { const line = r.line; const col = (r.matches[0]?.start || 0) + 1; editor.revealPositionInCenter({ lineNumber: line, column: col }); editor.setPosition({ lineNumber: line, column: col }); } } });
			const fileEl = document.createElement('div'); fileEl.className = 'result-file'; fileEl.textContent = `${r.filePath}:${r.line}`;
			const lineEl = document.createElement('div'); lineEl.className = 'result-line';
			lineEl.innerHTML = highlightPreview(r.preview, r.matches);
			item.appendChild(fileEl); item.appendChild(lineEl);
			searchResults.appendChild(item);
		}
	});

	safeBind(mEditGoToLine, 'click', async () => {
		if (!editor) return;
		const val = await showInputModal({ title: 'Go to Line', label: 'Line number', placeholder: 'e.g. 120', okText: 'Go', validate: (v) => { if (!v || isNaN(Number(v))) return 'Enter a valid number'; return ''; } });
		if (!val) return; const line = Math.max(1, parseInt(val, 10)); editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); editor.focus();
	});

	safeBind(mViewToggleWordWrap, 'click', () => { settings.wordWrap = settings.wordWrap === 'off' ? 'on' : 'off'; saveSettings(); applySettings(); });
	safeBind(mViewToggleLineNumbers, 'click', () => { settings.lineNumbers = settings.lineNumbers === 'on' ? 'off' : 'on'; saveSettings(); applySettings(); });
	safeBind(mViewToggleWhitespace, 'click', () => {
		const order = ['none', 'selection', 'all'];
		const idx = order.indexOf(settings.renderWhitespace);
		settings.renderWhitespace = order[(idx + 1) % order.length];
		saveSettings(); applySettings();
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !cmdPalette.classList.contains('hidden')) { e.preventDefault(); closeCmdPalette(); return; }
		if (e.ctrlKey && e.key === ',') { e.preventDefault(); openPrefs(); }
		if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); editor?.trigger('kb', 'undo', null); }
		if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); editor?.trigger('kb', 'redo', null); }
		if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); mFileSave?.click(); }
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); mFileSaveAs?.click(); }
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); mEditFindInFiles?.click(); }
		if (e.ctrlKey && e.key.toLowerCase() === 'g') { e.preventDefault(); mEditGoToLine?.click(); }
		if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'z') { e.preventDefault(); mViewToggleWordWrap?.click(); }
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openCmdPalette(); }
		if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); mFileNew?.click(); }
	});

	let shiftTapCount = 0; let shiftTapTimer = null;
	function registerShiftTap() {
		const now = Date.now();
		if (shiftTapCount === 0) { lastShiftTime = now; shiftTapCount = 1; clearTimeout(shiftTapTimer); shiftTapTimer = setTimeout(() => { shiftTapCount = 0; }, 2000); return; }
		if (now - lastShiftTime <= 2000) { shiftTapCount = 0; clearTimeout(shiftTapTimer); toggleCmdPalette(); }
	}
	const onShiftKey = (e) => { if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) { e.preventDefault(); registerShiftTap(); } };
	window.addEventListener('keydown', onShiftKey, true);
	window.addEventListener('keyup', onShiftKey, true);

	updateEmptyState();

	const sidebarNewFile = document.getElementById('sidebarNewFile');
	const sidebarNewFolder = document.getElementById('sidebarNewFolder');
			safeBind(sidebarNewFile, 'click', async () => { hideAnyModal(); if (!currentWorkspaceRoot) { alert('Open a folder first to create a file.'); return; } const base = selectedDirectoryPath || currentWorkspaceRoot; const name = await showInputModal({ title: 'New File', label: 'File name', placeholder: 'e.g. index.js', okText: 'Create File', validate: (v) => { if (!v) return 'Name is required'; if (/[\\/:*?"<>|]/.test(v)) return 'Invalid characters: \\/:*?"<>|'; return ''; }, onSubmit: async (val) => { const res = await window.bridge.createFile({ dir: base, name: val }); if (!res?.ok) return res?.error || 'Failed to create file'; return ''; } }); if (!name) return; const pathGuess = (selectedDirectoryPath || currentWorkspaceRoot) + '/' + name; const file = await window.bridge.readFileByPath(pathGuess); openInTabSafe(pathGuess, file?.content ?? ''); });
	safeBind(sidebarNewFolder, 'click', () => { window.createFolderFlow(); });

	document.addEventListener('click', (e) => { const t = e.target; if (t instanceof Element && t.id === 'sidebarNewFolder') { e.preventDefault(); window.createFolderFlow(); } }, true);

	const mViewToggleTerminal = document.getElementById('mViewToggleTerminal');
	const terminalPanel = document.getElementById('terminalPanel');
	const terminalEl = document.getElementById('terminal');

	async function ensureXtermLoaded() {
		if (window.Terminal) return true;
		// Try to load xterm dynamically if not present
		return await new Promise((resolve) => {
			const script = document.createElement('script');
			script.src = new URL('../../node_modules/xterm/lib/xterm.js', document.baseURI).toString();
			script.onload = () => resolve(true);
			script.onerror = () => resolve(false);
			document.head.appendChild(script);
		});
	}

	safeBind(mViewToggleTerminal, 'click', async () => {
		terminalPanel?.classList.toggle('hidden');
		if (!terminalPanel?.classList.contains('hidden')) {
			const ok = await ensureXtermLoaded();
			if (ok) await ensureTerminal();
			termInstance?.focus();
		}
	});

	document.addEventListener('click', (e) => {
		const t = e.target;
		if (t instanceof Element && t.id === 'sidebarNewFile') {
			e.preventDefault(); hideAnyModal(); if (monacoRef) createUntitled();
		}
	}, true);
});

if (!window.__MONACO_BOOT__) {
	window.__MONACO_BOOT__ = true;
	require(['vs/editor/editor.main'], function () {
		monacoRef = window.monaco;
		const editorContainer = document.getElementById('editor');
		const filenameEl = document.getElementById('filename');
		const fileTreeEl = document.getElementById('fileTree');
		const tabsEl = document.getElementById('tabs');
		const cursorPosEl = document.getElementById('cursorPos');
		const langEl = document.getElementById('lang');
		const winMin = document.getElementById('winMin');
		const winMax = document.getElementById('winMax');
		const winClose = document.getElementById('winClose');

		// Configurable menubar hover delays (ms)
		const MENU_HOVER_OPEN_DELAY = 150;
		const MENU_HOVER_CLOSE_DELAY = 150;
		const MENU_OPEN_MODE = 'hover';

		// Menubar open/close behavior with delay to prevent accidental close
		const menubar = document.getElementById('menubar');
		let closeTimeout = null;
		function closeAllMenus() { menubar?.querySelectorAll('.menu.open').forEach(el => el.classList.remove('open')); }
		function openMenu(menuEl) {
			if (!menuEl) return;
			menubar?.querySelectorAll('.menu.open').forEach((m) => { if (m !== menuEl) m.classList.remove('open'); });
			menuEl.classList.add('open');
			try { const idx = indexOfMenu(menuEl); localStorage.setItem('barge:lastMenu', String(idx)); } catch {}
		}
		function getMenuLabel(menuEl) { return menuEl?.querySelector?.('.menu-label'); }
		function getMenuItems(menuEl) { return Array.from(menuEl?.querySelectorAll?.('.dropdown .menu-item') || []); }

		menubar?.querySelectorAll('.menu').forEach((menuEl) => {
			let openTimer = null; let hideTimer = null;
			const label = getMenuLabel(menuEl);
			const dropdown = menuEl.querySelector('.dropdown');

			if (MENU_OPEN_MODE === 'hover') {
				menuEl.addEventListener('mouseenter', () => {
					clearTimeout(hideTimer); clearTimeout(openTimer);
					openTimer = setTimeout(() => { openMenu(menuEl); }, MENU_HOVER_OPEN_DELAY);
				});
				menuEl.addEventListener('mouseleave', () => {
					clearTimeout(openTimer); clearTimeout(hideTimer);
					hideTimer = setTimeout(() => { menuEl.classList.remove('open'); }, MENU_HOVER_CLOSE_DELAY);
				});
				if (dropdown) {
					dropdown.addEventListener('mouseenter', () => { clearTimeout(hideTimer); openMenu(menuEl); });
					dropdown.addEventListener('mouseleave', () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { menuEl.classList.remove('open'); }, MENU_HOVER_CLOSE_DELAY); });
				}
			}

			label?.addEventListener('pointerdown', (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				const isOpen = menuEl.classList.contains('open');
				if (!isOpen) { openMenu(menuEl); } else { menuEl.classList.remove('open'); }
				label.focus();
			});
		});

		menubar?.addEventListener('focusin', (e) => {
			if (!menubar.contains(document.activeElement)) return;
			try {
				const stored = parseInt(localStorage.getItem('barge:lastMenu') || '-1', 10);
				const menus = Array.from(menubar.querySelectorAll('.menu'));
				if (stored >= 0 && stored < menus.length) {
					openMenu(menus[stored]);
				}
			} catch {}
		});

		winMin?.addEventListener('click', () => window.bridge?.window?.minimize?.());
		winMax?.addEventListener('click', () => window.bridge?.window?.maximizeToggle?.());
		winClose?.addEventListener('click', () => window.bridge?.window?.close?.());

		monacoRef.editor.defineTheme('barge-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#0f1115', 'editor.lineHighlightBackground': '#151a24', 'editorLineNumber.foreground': '#3a4256', 'editorCursor.foreground': '#9cdcfe', 'editor.selectionBackground': '#264f78aa' }, });

		editor = monacoRef.editor.create(editorContainer, { value: '// New file\n', language: 'javascript', theme: settings.theme === 'light' ? 'vs' : 'barge-dark', automaticLayout: true, minimap: { enabled: true }, fontFamily: settings.fontFamily, fontSize: settings.fontSize, autoClosingBrackets: 'languageDefined', autoClosingQuotes: 'languageDefined', bracketPairColorization: { enabled: true }, matchBrackets: 'always', });
		// announce monaco readiness for any deferred actions
		window.dispatchEvent(new Event('barge:monaco-ready'));

		window.__EDITOR_GET_VALUE__ = () => editor.getValue();

		editor.onDidChangeCursorPosition(() => updateStatus());
		editor.onDidChangeModelContent(() => { markDirty(activeTabPath, true); handleAutoSave(); });
		window.addEventListener('blur', () => { if (settings.autoSave === 'onFocusChange') saveActiveFile(); });

		window.bridge?.onFolderOpened?.((payload) => { currentWorkspaceRoot = payload.root; renderTree(payload.root, payload.tree); clearEditor(); updateEmptyState(); });
		window.bridge?.onFileOpened?.((payload) => { openInTabSafe(payload.filePath, payload.content); updateEmptyState(); });
		window.bridge?.onFsChanged?.((_payload) => {
			handleFsChanged(_payload);
		});

		window.addEventListener('barge:pending-open', () => {
			if (window.__PENDING_OPEN__) {
				const p = window.__PENDING_OPEN__;
				openInTabSafe(p.filePath, p.content);
				window.__PENDING_OPEN__ = null;
			}
		});
		window.addEventListener('barge:pending-folder', () => {
			if (window.__PENDING_FOLDER__) {
				const f = window.__PENDING_FOLDER__;
				currentWorkspaceRoot = f.root;
				renderTree(f.root, f.tree);
				clearEditor();
				window.__PENDING_FOLDER__ = null;
			}
		});

		const buffered = window.bridge?.getLastOpened?.();
		if (buffered) openInTabSafe(buffered.filePath, buffered.content);
		if (window.__PENDING_OPEN__) { const p = window.__PENDING_OPEN__; openInTabSafe(p.filePath, p.content); window.__PENDING_OPEN__ = null; }
		if (window.__PENDING_FOLDER__) { const f = window.__PENDING_FOLDER__; currentWorkspaceRoot = f.root; renderTree(f.root, f.tree); clearEditor(); window.__PENDING_FOLDER__ = null; updateEmptyState(); }

		loadExtensions();

		function renderTree(root, tree, state) {
			const fileTreeEl = document.getElementById('fileTree');
			fileTreeEl.innerHTML = '';
			const rootEl = document.createElement('div'); rootEl.className = 'item'; rootEl.textContent = root; fileTreeEl.appendChild(rootEl);
			rootEl.addEventListener('click', () => { selectedDirectoryPath = root; highlightSelectedDir(rootEl); });
			const children = document.createElement('div'); children.className = 'children'; fileTreeEl.appendChild(children);
			for (const node of tree) children.appendChild(renderNode(node, state));
			// Expand root if previously expanded or by default when no state
			const shouldExpandRoot = !state || !state.expandedPaths || state.expandedPaths.has(root) || state.expandedPaths.size === 0;
			children.style.display = shouldExpandRoot ? 'block' : 'none';
			// Restore selection if available, otherwise select root
			selectedDirectoryPath = state?.selectedPath || root;
			highlightSelectedDir(state?.selectedPath ? fileTreeEl.querySelector(`.item[data-path="${CSS.escape(state.selectedPath)}"]`) || rootEl : rootEl);
			attachTreeContextMenu(fileTreeEl);
			enableTreeKeyboard(fileTreeEl);
			enableTreeDnD(fileTreeEl);
		}
		// Expose renderer functions for early callers
		window.bargeRenderTree = renderTree;

		// Incremental file tree update helpers
		function cssEscapeSafe(s) { try { return CSS.escape(s); } catch { return (s || '').replace(/[^a-zA-Z0-9_-]/g, '_'); } }

		function getChildrenContainerForDir(dirPath) {
			const tree = document.getElementById('fileTree');
			if (!tree) return null;
			if (dirPath === currentWorkspaceRoot) return tree.querySelector(':scope > .children');
			const dirItem = tree.querySelector(`.item[data-path="${cssEscapeSafe(dirPath)}"]`);
			if (!dirItem) return null;
			const sib = dirItem.nextSibling;
			return (sib && sib.classList && sib.classList.contains('children')) ? sib : null;
		}

		function compareNodePlacement(existingEl, newType, newName) {
			let existingType = 'file';
			let existingName = '';
			const item = existingEl.classList.contains('item') ? existingEl : existingEl.querySelector(':scope > .item');
			if (item) {
				existingName = (item.querySelector('span')?.textContent || '').trim();
				const children = item.nextSibling;
				existingType = (children && children.classList && children.classList.contains('children')) ? 'dir' : 'file';
			}
			if (existingType !== newType) return existingType === 'dir' ? -1 : 1;
			return existingName.localeCompare(newName);
		}

		function insertSorted(container, element, type, name) {
			const kids = Array.from(container.children);
			for (let i = 0; i < kids.length; i++) {
				const cmp = compareNodePlacement(kids[i], type, name);
				if (cmp > 0) { container.insertBefore(element, kids[i]); return; }
			}
			container.appendChild(element);
		}

		function createNodeElement(node) {
			const el = document.createElement('div'); el.className = 'item'; el.innerHTML = `${iconSvg(node.type)} <span>${node.name}</span>`; el.dataset.path = node.path || ''; el.draggable = true;
			if (node.type === 'file') {
				el.addEventListener('click', async () => { const res = await window.bridge.readFileByPath(node.path); openInTabSafe(node.path, res?.content ?? ''); updateEmptyState(); });
				return el;
			} else {
				const children = document.createElement('div'); children.className = 'children'; children.style.display = 'none';
				let expanded = false;
				el.addEventListener('click', () => { expanded = !expanded; children.style.display = expanded ? 'block' : 'none'; selectedDirectoryPath = node.path; highlightSelectedDir(el); });
				const wrap = document.createElement('div'); wrap.appendChild(el); wrap.appendChild(children); return wrap;
			}
		}

		function removePathFromTree(targetPath) {
			const tree = document.getElementById('fileTree'); if (!tree) return;
			const item = tree.querySelector(`.item[data-path="${cssEscapeSafe(targetPath)}"]`);
			if (!item) return;
			const maybeWrap = item.parentElement;
			if (maybeWrap && maybeWrap.firstChild === item && maybeWrap.children.length === 2 && maybeWrap.lastChild.classList.contains('children')) {
				maybeWrap.remove();
			} else {
				item.remove();
			}
		}

		function updatePathDatasetRecursive(rootEl, oldPrefix, newPrefix) {
			if (!rootEl) return;
			const items = rootEl.querySelectorAll('.item');
			items.forEach((it) => {
				const p = it.dataset.path;
				if (p && p.startsWith(oldPrefix)) {
					const rest = p.slice(oldPrefix.length);
					it.dataset.path = newPrefix + rest;
					const span = it.querySelector('span');
					if (span && span.textContent && span.textContent === (oldPrefix + rest).split('/').pop()) {
						span.textContent = (newPrefix + rest).split('/').pop();
					}
				}
			});
		}

		function renamePathInTree(oldPath, newPath) {
			const tree = document.getElementById('fileTree'); if (!tree) return;
			const item = tree.querySelector(`.item[data-path="${cssEscapeSafe(oldPath)}"]`);
			if (!item) return;
			const newName = newPath.split('/').pop();
			item.dataset.path = newPath;
			const span = item.querySelector('span'); if (span) span.textContent = newName;
			const sibling = item.nextSibling;
			if (sibling && sibling.classList.contains('children')) {
				updatePathDatasetRecursive(sibling, oldPath + '/', newPath + '/');
			}
			// Re-sort within parent container
			const parentContainer = item.parentElement && item.parentElement.classList.contains('children') ? item.parentElement : (item.parentElement?.parentElement?.classList.contains('children') ? item.parentElement.parentElement : null);
			if (parentContainer) {
				const wrap = (sibling && sibling.classList.contains('children')) ? item.parentElement : item;
				wrap.remove();
				insertSorted(parentContainer, wrap, (sibling ? 'dir' : 'file'), newName);
			}
		}

		function movePathInTree(oldPath, newPath) {
			const tree = document.getElementById('fileTree'); if (!tree) return;
			const item = tree.querySelector(`.item[data-path="${cssEscapeSafe(oldPath)}"]`);
			if (!item) return;
			const isDir = !!(item.nextSibling && item.nextSibling.classList && item.nextSibling.classList.contains('children'));
			const newParentDir = newPath.split('/').slice(0, -1).join('/');
			const container = getChildrenContainerForDir(newParentDir);
			if (!container) { refreshTree(); return; }
			const wrap = (isDir && item.parentElement && item.parentElement.firstChild === item) ? item.parentElement : item;
			const newName = newPath.split('/').pop();
			item.dataset.path = newPath;
			const span = item.querySelector('span'); if (span) span.textContent = newName;
			if (isDir) updatePathDatasetRecursive(item.nextSibling, oldPath + '/', newPath + '/');
			wrap.remove();
			insertSorted(container, wrap, isDir ? 'dir' : 'file', newName);
			container.style.display = 'block';
		}

		function createPathInTree(targetPath, type) {
			const parentDir = targetPath.split('/').slice(0, -1).join('/');
			const container = getChildrenContainerForDir(parentDir);
			if (!container) { refreshTree(); return; }
			const node = { type, name: targetPath.split('/').pop(), path: targetPath };
			const el = createNodeElement(node);
			insertSorted(container, el, type, node.name);
			container.style.display = 'block';
		}

		function handleFsChanged(payload) {
			if (!payload) return;
			switch (payload.kind) {
				case 'mkdir': createPathInTree(payload.path, 'dir'); break;
				case 'create': createPathInTree(payload.path, 'file'); break;
				case 'rename': renamePathInTree(payload.oldPath, payload.path); break;
				case 'move': movePathInTree(payload.oldPath, payload.path); break;
				case 'delete': removePathFromTree(payload.path); break;
			}
		}

		function enableTreeKeyboard(container) {
			container.tabIndex = 0;
			container.addEventListener('keydown', async (e) => {
				if (e.key === 'F2') {
					e.preventDefault();
					const sel = container.querySelector('.item.selected');
					if (sel) renameFlow(computePathFromItem(sel));
				}
				if (e.key === 'Delete') {
					e.preventDefault();
					const sel = container.querySelector('.item.selected');
					if (sel) deleteFlow(computePathFromItem(sel));
				}
				if (e.ctrlKey && e.key.toLowerCase() === 'n') {
					e.preventDefault();
					if (e.shiftKey) window.createFolderFlow(); else sidebarNewFile.click();
				}
			});
		}

		function enableTreeDnD(container) {
			container.addEventListener('dragstart', (e) => {
				const item = e.target.closest('.item');
				if (!item) return; e.dataTransfer.setData('text/barge-path', computePathFromItem(item));
			});
			container.addEventListener('dragover', (e) => {
				e.preventDefault();
			});
			container.addEventListener('drop', async (e) => {
				e.preventDefault();
				const src = e.dataTransfer.getData('text/barge-path');
				const targetItem = e.target.closest('.item');
				if (!src || !targetItem) return;
				const targetPath = computePathFromItem(targetItem);
				const targetDir = targetItem.classList.contains('item') && targetItem.nextSibling?.classList?.contains('children') ? targetPath : pathDirname(targetPath);
				if (!targetDir) return;
				const res = await window.bridge.movePath({ sourcePath: src, targetDir });
				if (!res?.ok) { console.error('Move failed', res?.error); return; }
				await refreshTree();
			});
		}

		function pathDirname(p) { return p.split('/').slice(0, -1).join('/'); }

		function attachTreeContextMenu(container) {
			container.addEventListener('contextmenu', (e) => {
				e.preventDefault();
				const target = e.target.closest('.item');
				if (!target) return;
				const itemPath = computePathFromItem(target);
				const isDir = !!(target.nextSibling && target.nextSibling.classList && target.nextSibling.classList.contains('children'));
				const items = [];
				if (isDir) {
					items.push(
						{ label: 'Open', action: async () => {
							// toggle expand like click handler
							const children = target.nextSibling; if (children) { const expanded = children.style.display === 'block'; children.style.display = expanded ? 'none' : 'block'; selectedDirectoryPath = itemPath; highlightSelectedDir(target); }
						}},
						{ label: 'New File', action: async () => {
							hideAnyModal();
							const name = await showInputModal({ title: 'New File', label: 'File name', placeholder: 'e.g. index.js', okText: 'Create File', validate: (v) => { if (!v) return 'Name is required'; if (/[\\/:*?"<>|]/.test(v)) return 'Invalid characters: \\/:*?"<>|'; return ''; }, onSubmit: async (val) => { const res = await window.bridge.createFile({ dir: itemPath, name: val }); if (!res?.ok) return res?.error || 'Failed to create file'; return ''; } });
							if (!name) return; await refreshTree(); const created = itemPath + '/' + name; const file = await window.bridge.readFileByPath(created); openInTabSafe(created, file?.content ?? '');
						}},
						{ label: 'New Folder', action: async () => {
							hideAnyModal();
							const name = await showInputModal({ title: 'New Folder', label: 'Folder name', placeholder: 'e.g. src', okText: 'Create Folder', validate: (v) => { if (!v) return 'Name is required'; if (/[\\/:*?"<>|]/.test(v)) return 'Invalid characters: \\/:*?"<>|'; return ''; }, onSubmit: async (val) => { const res = await window.bridge.createFolder({ root: itemPath, name: val }); if (!res?.ok) return res?.error || 'Failed to create folder'; return ''; } });
							if (!name) return; /* incremental update handled by fs:changed */
						}}
					);
				} else {
					items.push({ label: 'Open', action: async () => { const res = await window.bridge.readFileByPath(itemPath); openInTabSafe(itemPath, res?.content ?? ''); }});
				}
				items.push({ label: 'Rename', action: () => renameFlow(itemPath) });
				items.push({ label: 'Delete', action: () => deleteFlow(itemPath) });
				showContextMenu(e.pageX, e.pageY, items);
			}, false);
		}

		function computePathFromItem(itemEl) {
			// Walk up from itemEl to reconstruct path text from labels
			// We already render nodes with their full paths in event handlers; for reliability,
			// embed data-path on elements when creating them
			return itemEl.dataset?.path || (itemEl.textContent || '').trim();
		}

		function showContextMenu(x, y, items) {
			let menu = document.getElementById('treeContext');
			if (!menu) {
				menu = document.createElement('div');
				menu.id = 'treeContext';
				menu.style.position = 'fixed';
				menu.style.zIndex = '20000';
				menu.style.minWidth = '160px';
				menu.style.background = 'rgba(17,21,30,0.98)';
				menu.style.border = '1px solid rgba(153,174,206,0.35)';
				menu.style.borderRadius = '10px';
				menu.style.boxShadow = '0 18px 60px rgba(3,8,20,0.5)';
				document.body.appendChild(menu);
			}
			menu.innerHTML = '';
			items.forEach(it => {
				const btn = document.createElement('button');
				btn.className = 'menu-item';
				btn.style.width = '100%';
				btn.textContent = it.label;
				btn.addEventListener('click', () => { hideMenu(); it.action(); });
				menu.appendChild(btn);
			});
			menu.style.left = x + 'px';
			menu.style.top = y + 'px';
			menu.style.display = 'block';
			function hideMenu() { if (menu) menu.style.display = 'none'; document.removeEventListener('click', hideOnClick); }
			function hideOnClick(ev) { if (!menu.contains(ev.target)) hideMenu(); }
			document.addEventListener('click', hideOnClick, { once: true });
		}

		async function renameFlow(oldPath) {
			const baseLabel = (oldPath.split('/').pop() || '').trim();
			const newName = await showInputModal({ title: 'Rename', label: 'New name', placeholder: baseLabel, okText: 'Rename', validate: (v) => {
				if (!v) return 'Name is required';
				if (/[\\/:*?"<>|]/.test(v)) return 'Invalid characters: \\/:*?"<>|';
				return '';
			}, onSubmit: async (val) => {
				const res = await window.bridge.renamePath({ oldPath, newName: val });
				if (!res?.ok) return res?.error || 'Failed to rename';
				return '';
			}});
			if (!newName) return;
			/* incremental update handled by fs:changed */
		}

		async function deleteFlow(targetPath) {
			const confirmed = await showInputModal({ title: 'Delete', label: 'Type DELETE to confirm', okText: 'Delete', validate: (v) => {
				if (v !== 'DELETE') return 'Please type DELETE to confirm';
				return '';
			}, onSubmit: async () => {
				const res = await window.bridge.deletePath({ target: targetPath });
				if (!res?.ok) return res?.error || 'Failed to delete';
				return '';
			}});
			if (!confirmed) return;
			/* incremental update handled by fs:changed */
		}

		function iconSvg(kind) { if (kind === 'dir') return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="#8aa2c4"/></svg>'; return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="5" y="3" width="14" height="18" rx="2" ry="2" stroke="#9aa2b2"/></svg>'; }

		function renderNode(node, state) {
			const el = document.createElement('div'); el.className = 'item'; el.innerHTML = `${iconSvg(node.type)} <span>${node.name}</span>`; el.dataset.path = node.path || ''; el.draggable = true;
			if (node.type === 'file') { el.addEventListener('click', async () => { const res = await window.bridge.readFileByPath(node.path); openInTabSafe(node.path, res?.content ?? ''); updateEmptyState(); }); }
			else if (node.type === 'dir') {
				const children = document.createElement('div'); children.className = 'children';
				let expanded = !!(state && state.expandedPaths && state.expandedPaths.has(node.path));
				el.addEventListener('click', () => { expanded = !expanded; children.style.display = expanded ? 'block' : 'none'; selectedDirectoryPath = node.path; highlightSelectedDir(el); });
				for (const child of node.children) children.appendChild(renderNode(child, state)); children.style.display = expanded ? 'block' : 'none'; const wrap = document.createElement('div'); wrap.appendChild(el); wrap.appendChild(children); return wrap;
			}
			return el;
		}
		function highlightSelectedDir(el) {
			document.querySelectorAll('.file-tree .item.selected').forEach(n => n.classList.remove('selected'));
			el.classList.add('selected');
		}

		function getOrCreateModel(filePath, content) { 
			let model = modelsByPath.get(filePath); 
			if (!model) { 
				const uri = monacoRef.Uri.file(filePath); 
				const language = guessLanguage(filePath);
				model = monacoRef.editor.createModel(content ?? '', language, uri); 
				modelsByPath.set(filePath, model); 
			} else if (typeof content === 'string' && model.getValue() !== content) { 
				model.setValue(content); 
			} 
			const language = guessLanguage(filePath);
			monacoRef.editor.setModelLanguage(model, language); 
			return model; 
		}

		function openFileInTab(filePath, content) {
			let tab = openTabs.find(t => t.path === filePath);
			const model = getOrCreateModel(filePath, content);
			if (!tab) { tab = { path: filePath, title: basename(filePath), dirty: false, modelUri: model.uri.toString() }; openTabs.push(tab); const tabEl = document.createElement('div'); tabEl.className = 'tab'; const titleEl = document.createElement('div'); titleEl.className = 'title'; titleEl.textContent = tab.title; const closeEl = document.createElement('div'); closeEl.className = 'close'; closeEl.textContent = '×'; closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(filePath); updateEmptyState(); }); tabEl.appendChild(titleEl); tabEl.appendChild(closeEl); tabEl.addEventListener('click', () => { activateTab(filePath); }); tab._el = tabEl; tab._titleEl = titleEl; tabsEl.appendChild(tabEl); }
			activateTab(filePath);
			editor.setModel(model);
			editor.focus();
			filenameEl.textContent = filePath; langEl.textContent = guessLanguage(filePath); markDirty(filePath, false); updateStatus();
		}
		// Expose tab open API for code that runs before Monaco is ready
		window.bargeOpenFileInTab = openFileInTab;

		function activateTab(filePath) { activeTabPath = filePath; for (const t of openTabs) t._el.classList.toggle('active', t.path === filePath); const model = modelsByPath.get(filePath); if (model) { editor.setModel(model); editor.focus(); } if (settings.autoSave === 'onFocusChange') saveActiveFile(); }

		function markDirty(filePath, isDirty) { if (!filePath) return; const tab = openTabs.find(t => t.path === filePath); if (!tab) return; tab.dirty = isDirty; tab._titleEl.textContent = tab.title + (isDirty ? ' •' : ''); }

		async function saveActiveFile() {
			if (!activeTabPath) return;
			const model = modelsByPath.get(activeTabPath);
			if (!model) return;
			const content = model.getValue();
			if (isUntitledPath(activeTabPath)) {
				const res = await window.bridge.saveAs(content);
				if (res?.filePath) {
					const newPath = res.filePath;
					modelsByPath.delete(activeTabPath);
					const newModel = monacoRef.editor.createModel(content ?? '', guessLanguage(newPath), monacoRef.Uri.file(newPath));
					modelsByPath.set(newPath, newModel);
					editor.setModel(newModel);
					const tab = openTabs.find(t => t.path === activeTabPath);
					if (tab) { tab.path = newPath; tab.title = basename(newPath); tab._titleEl.textContent = tab.title; }
					activeTabPath = newPath;
					markDirty(activeTabPath, false);
					updateEmptyState();
				}
				return;
			}
			await window.bridge.writeFileByPath({ filePath: activeTabPath, content });
			markDirty(activeTabPath, false);
		}

		function handleAutoSave() {
			if (settings.autoSave === 'afterDelay') {
				if (!activeTabPath) return;
				const existing = autosaveTimers.get(activeTabPath);
				if (existing) clearTimeout(existing);
				const t = setTimeout(() => { saveActiveFile(); autosaveTimers.delete(activeTabPath); }, settings.autoSaveDelay);
				autosaveTimers.set(activeTabPath, t);
			}
		}

		function closeTab(filePath) {
			const idx = openTabs.findIndex(t => t.path === filePath);
			if (idx === -1) return;
			const tab = openTabs[idx];
			if (tab.dirty) { const ok = confirm(`${tab.title} has unsaved changes. Close anyway?`); if (!ok) return; }
			try { const model = modelsByPath.get(filePath); const content = model?.getValue(); closedStack.push({ path: filePath, content }); } catch {}
			tab._el.remove(); openTabs.splice(idx, 1);
			const stillUsed = openTabs.some(t => t.path === filePath);
			if (!stillUsed) { const model = modelsByPath.get(filePath); if (model) { model.dispose(); modelsByPath.delete(filePath); } }
			if (activeTabPath === filePath) { const next = openTabs[idx] || openTabs[idx - 1]; if (next) { activateTab(next.path); } else { editor.setValue(''); filenameEl.textContent = ''; activeTabPath = null; updateStatus(); } }
			updateEmptyState();
		}

		function updateStatus() { const pos = editor.getPosition(); if (!pos) return; cursorPosEl.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`; }

		function guessLanguage(filePath) { 
			const name = (filePath.split('/').pop() || '').toLowerCase(); 
			const ext = name.includes('.') ? name.split('.').pop() : ''; 
			const map = { 
				js: 'javascript', 
				jsx: 'javascript',
				ts: 'typescript', 
				tsx: 'typescript',
				json: 'json', 
				css: 'css', 
				scss: 'scss',
				sass: 'scss',
				less: 'less',
				html: 'html', 
				htm: 'html',
				xml: 'xml',
				md: 'markdown', 
				markdown: 'markdown',
				py: 'python', 
				java: 'java', 
				c: 'c', 
				cpp: 'cpp', 
				cxx: 'cpp',
				cc: 'cpp',
				h: 'c',
				hpp: 'cpp',
				rs: 'rust', 
				go: 'go', 
				sh: 'shell',
				bash: 'shell',
				zsh: 'shell',
				fish: 'shell', 
				yml: 'yaml', 
				yaml: 'yaml',
				php: 'php',
				rb: 'ruby',
				swift: 'swift',
				kt: 'kotlin',
				scala: 'scala',
				r: 'r',
				sql: 'sql',
				dockerfile: 'dockerfile'
			}; 
			return map[ext] || 'plaintext'; 
		}

		function basename(p) { return p.split('/').pop(); }

		async function loadExtensions() { try { const list = await window.bridge.listExtensions(); for (const ext of list) { try { const mod = await import(ext.mainUrl); await mod.activate?.({ editor, monaco: monacoRef, commands: { register: window.bridge.registerCommand, execute: window.bridge.executeCommand, }, api: { openFileInTab, }, }); } catch (e) { console.error('Extension failed', ext, e); } } } catch (e) { console.error('Extensions load failed', e); } }

		function highlightPreview(line, matches) { if (!matches?.length) return line; let html = ''; let last = 0; for (const m of matches) { html += escapeHtml(line.slice(last, m.start)); html += `<span class=\"result-highlight\">${escapeHtml(line.slice(m.start, m.end))}</span>`; last = m.end; } html += escapeHtml(line.slice(last)); return html; }
		function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

		safeBind(cmdBackdrop, 'click', closeCmdPalette);
		safeBind(cmdInput, 'input', () => filterCommands(cmdInput.value));
		safeBind(cmdInput, 'keydown', (e) => {
			if (e.key === 'Escape') { e.preventDefault(); closeCmdPalette(); return; }
			if (e.key === 'ArrowDown') { e.preventDefault(); if (cmdFiltered.length) { cmdSelected = Math.min(cmdSelected + 1, cmdFiltered.length - 1); renderCmdList(cmdFiltered); } return; }
			if (e.key === 'ArrowUp') { e.preventDefault(); if (cmdFiltered.length) { cmdSelected = Math.max(cmdSelected - 1, 0); renderCmdList(cmdFiltered); } return; }
			if (e.key === 'Enter') { e.preventDefault(); executeCmd(cmdFiltered[cmdSelected]); return; }
		});

		menubar?.addEventListener('keydown', (e) => {
			const target = e.target;
			const inLabel = target?.classList?.contains('menu-label');
			const inItem = target?.classList?.contains('menu-item');
			if (!inLabel && !inItem) return;
			const currentMenu = target.closest('.menu');
			const menus = Array.from(menubar.querySelectorAll('.menu'));
			const items = getMenuItems(currentMenu);
			const currentIndex = indexOfMenu(currentMenu);

			if (e.key === 'Escape') {
				e.preventDefault();
				closeAllMenus();
				getMenuLabel(currentMenu)?.focus();
				return;
			}

			if (inLabel) {
				switch (e.key) {
					case 'ArrowRight': e.preventDefault(); focusMenuByIndex(currentIndex + 1); break;
					case 'ArrowLeft': e.preventDefault(); focusMenuByIndex(currentIndex - 1); break;
					case 'Home': e.preventDefault(); focusMenuByIndex(0); break;
					case 'End': e.preventDefault(); focusMenuByIndex(menus.length - 1); break;
					case 'ArrowDown':
					case 'Enter':
					case ' ': {
						e.preventDefault();
						openMenu(currentMenu);
						const first = items[0];
						first?.focus();
						break;
					}
				}
				return;
			}

			if (inItem) {
				const idx = items.indexOf(target);
				switch (e.key) {
					case 'ArrowDown': e.preventDefault(); (items[idx + 1] || items[0])?.focus(); break;
					case 'ArrowUp': e.preventDefault(); (items[idx - 1] || items[items.length - 1])?.focus(); break;
					case 'Home': e.preventDefault(); items[0]?.focus(); break;
					case 'End': e.preventDefault(); items[items.length - 1]?.focus(); break;
					case 'ArrowRight': e.preventDefault(); focusMenuByIndex(currentIndex + 1); break;
					case 'ArrowLeft': e.preventDefault(); focusMenuByIndex(currentIndex - 1); break;
					case 'Enter':
					case ' ': e.preventDefault(); target.click(); break;
					case 'Tab': {
						e.preventDefault();
						if (e.shiftKey) { (items[idx - 1] || items[items.length - 1] || getMenuLabel(currentMenu))?.focus(); }
						else { (items[idx + 1] || items[0] || getMenuLabel(currentMenu))?.focus(); }
						break;
					}
				}
			}
		});
	});
}

async function ensureTerminal() {
	if (!termInstance) {
		// Make sure xterm is available
		if (!window.Terminal && typeof ensureXtermLoaded === 'function') {
			const ok = await ensureXtermLoaded();
			if (!ok) { console.error('xterm failed to load'); return; }
		}
		const TerminalCtor = window.Terminal;
		if (!TerminalCtor) { console.error('Terminal is not defined'); return; }
		termInstance = new TerminalCtor({ convertEol: true, cursorBlink: true, theme: { background: '#0b0d12' } });
		termInstance.open(document.getElementById('terminal'));
		const created = await window.bridge.terminal.create(80, 24, currentWorkspaceRoot || undefined);
		if (!created || !created.id) { console.error('Terminal create failed', created); return; }
		termId = created.id;
		window.bridge.terminal.onData((p) => { if (p.id === termId) termInstance.write(p.data); });
		termInstance.onData((data) => { if (termId) window.bridge.terminal.write(termId, data); });
		const applyResize = () => {
			const el = document.getElementById('terminal');
			if (!el || !termInstance) return;
			const dims = termInstance._core?._renderService?._renderer?._charSizeService;
			const cellW = (dims && dims.width) ? dims.width : 9;
			const cellH = (dims && dims.height) ? dims.height : 18;
			const cols = Math.max(20, Math.floor(el.clientWidth / cellW));
			const rows = Math.max(5, Math.floor(el.clientHeight / cellH));
			// Resize both frontend (xterm) and backend (pty)
			try { termInstance.resize(cols, rows); } catch {}
			window.bridge.terminal.resize(termId, cols, rows);
		};
		new ResizeObserver(() => { applyResize(); }).observe(document.getElementById('terminal'));
		// Force an initial resize and prompt redraw
		setTimeout(() => { applyResize(); termInstance.focus(); window.bridge.terminal.write(termId, '\r'); }, 0);
	}
}