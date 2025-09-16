require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });

let monacoRef = null;
let editor = null;
let openTabs = [];
let activeTabPath = null;
const modelsByPath = new Map();
const autosaveTimers = new Map();
let currentWorkspaceRoot = null;

const settings = {
	fontFamily: 'JetBrains Mono, Fira Code, Menlo, Consolas, "Liberation Mono", monospace',
	fontSize: 14,
	theme: 'dark',
	autoSave: 'off', // off | afterDelay | onFocusChange
	autoSaveDelay: 1000,
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
}

// Early bootstrap to ensure clicks work even if Monaco hasn't finished loading
window.addEventListener('DOMContentLoaded', () => {
	loadSettings();
	const safeBind = (el, type, handler) => { if (el && !(el.dataset && el.dataset.bound === '1')) { el.addEventListener(type, handler); if (el.dataset) el.dataset.bound = '1'; } };

	const mFileOpen = document.getElementById('mFileOpen');
	const mFileOpenFolder = document.getElementById('mFileOpenFolder');
	const mFileSave = document.getElementById('mFileSave');
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
	function closeCmdPalette() {
		cmdPalette.classList.add('hidden');
		cmdInput.blur();
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
			// Show history first, then common items
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
				score += (idx - lastIndex) <= 2 ? 3 : 1; // simple proximity bonus
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
			{ id: 'edit:find', title: 'Edit: Find', hint: 'Ctrl+F', run: () => mEditFind?.click() },
			{ id: 'edit:findInFiles', title: 'Edit: Find in Files', hint: 'Ctrl+Shift+F', run: () => mEditFindInFiles?.click() },
			{ id: 'view:toggleStatusBar', title: 'View: Toggle Status Bar', run: () => { const sb = document.querySelector('.statusbar'); if (sb) sb.style.display = (sb.style.display === 'none' ? '' : 'none'); } },
			{ id: 'view:toggleTheme', title: 'View: Toggle Theme (Dark/Light)', run: () => { settings.theme = settings.theme === 'light' ? 'dark' : 'light'; saveSettings(); applySettings(); } },
			{ id: 'editor:toggleMinimap', title: 'Editor: Toggle Minimap', run: () => { if (editor) { const opts = editor.getRawOptions(); editor.updateOptions({ minimap: { enabled: !opts.minimap?.enabled } }); } } },
		];
	}
	buildCommands();
	loadCmdHistory();

	safeBind(mFileOpen, 'click', async () => { const res = await window.bridge?.openFile?.(); if (res) { window.__PENDING_OPEN__ = res; window.dispatchEvent(new Event('barge:pending-open')); } });
	safeBind(mFileOpenFolder, 'click', async () => { const payload = await window.bridge?.openFolder?.(); if (payload) { window.__PENDING_FOLDER__ = payload; window.dispatchEvent(new Event('barge:pending-folder')); } });
	safeBind(mFileSave, 'click', async () => { if (editor) await saveActiveFile(); });
	safeBind(mFileExit, 'click', () => window.bridge?.window?.close?.());

	function openPrefs() { prefFontFamily.value = settings.fontFamily; prefFontSize.value = settings.fontSize; prefAutoSave.value = settings.autoSave; prefAutoSaveDelay.value = settings.autoSaveDelay; autoSaveDelayField.style.display = settings.autoSave === 'afterDelay' ? 'grid' : 'none'; prefsModal.classList.remove('hidden'); }
	function closePrefs() { prefsModal.classList.add('hidden'); }

	safeBind(mEditPreferences, 'click', openPrefs);
	safeBind(prefsCancel, 'click', closePrefs);
	safeBind(prefAutoSave, 'change', () => { autoSaveDelayField.style.display = prefAutoSave.value === 'afterDelay' ? 'grid' : 'none'; });
	safeBind(prefsSave, 'click', () => { settings.fontFamily = prefFontFamily.value || settings.fontFamily; settings.fontSize = Math.max(8, Math.min(48, parseInt(prefFontSize.value || settings.fontSize, 10))); settings.autoSave = prefAutoSave.value; settings.autoSaveDelay = Math.max(100, Math.min(10000, parseInt(prefAutoSaveDelay.value || settings.autoSaveDelay, 10))); saveSettings(); applySettings(); closePrefs(); });

	safeBind(mThemeDark, 'click', () => { settings.theme = 'dark'; saveSettings(); applySettings(); });
	safeBind(mThemeLight, 'click', () => { settings.theme = 'light'; saveSettings(); applySettings(); });

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
			item.addEventListener('click', async () => { const file = await window.bridge.readFileByPath(r.filePath); openFileInTab(r.filePath, file?.content ?? ''); if (editor) { const model = editor.getModel(); if (model) { const line = r.line; const col = (r.matches[0]?.start || 0) + 1; editor.revealPositionInCenter({ lineNumber: line, column: col }); editor.setPosition({ lineNumber: line, column: col }); } } });
			const fileEl = document.createElement('div'); fileEl.className = 'result-file'; fileEl.textContent = `${r.filePath}:${r.line}`;
			const lineEl = document.createElement('div'); lineEl.className = 'result-line';
			lineEl.innerHTML = highlightPreview(r.preview, r.matches);
			item.appendChild(fileEl); item.appendChild(lineEl);
			searchResults.appendChild(item);
		}
	});

	document.addEventListener('keydown', (e) => {
		// Global ESC: close command palette if open
		if (e.key === 'Escape' && !cmdPalette.classList.contains('hidden')) { e.preventDefault(); closeCmdPalette(); return; }
		if (e.ctrlKey && e.key === ',') { e.preventDefault(); openPrefs(); }
		if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); editor?.trigger('kb', 'undo', null); }
		if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); editor?.trigger('kb', 'redo', null); }
		if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); mFileSave?.click(); }
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); mEditFindInFiles?.click(); }
		// Fallback: Ctrl+Shift+P opens command palette (VS Code style)
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openCmdPalette(); }
	});

	// Robust Double-Shift detection to open command palette
	let shiftTapCount = 0; let shiftTapTimer = null;
	function registerShiftTap() {
		const now = Date.now();
		if (shiftTapCount === 0) { lastShiftTime = now; shiftTapCount = 1; clearTimeout(shiftTapTimer); shiftTapTimer = setTimeout(() => { shiftTapCount = 0; }, 2000); return; }
		if (now - lastShiftTime <= 2000) { shiftTapCount = 0; clearTimeout(shiftTapTimer); toggleCmdPalette(); }
	}
	const onShiftKey = (e) => {
		if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) { e.preventDefault(); registerShiftTap(); }
	};
	window.addEventListener('keydown', onShiftKey, true);
	window.addEventListener('keyup', onShiftKey, true);
});

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

	window.__EDITOR_GET_VALUE__ = () => editor.getValue();

	editor.onDidChangeCursorPosition(() => updateStatus());
	editor.onDidChangeModelContent(() => { markDirty(activeTabPath, true); handleAutoSave(); });
	window.addEventListener('blur', () => { if (settings.autoSave === 'onFocusChange') saveActiveFile(); });

	window.bridge?.onFolderOpened?.((payload) => { currentWorkspaceRoot = payload.root; renderTree(payload.root, payload.tree); });
	window.bridge?.onFileOpened?.((payload) => openFileInTab(payload.filePath, payload.content));

	window.addEventListener('barge:pending-open', () => { const p = window.__PENDING_OPEN__; if (p) { openFileInTab(p.filePath, p.content); window.__PENDING_OPEN__ = null; } });
	window.addEventListener('barge:pending-folder', () => { const f = window.__PENDING_FOLDER__; if (f) { currentWorkspaceRoot = f.root; renderTree(f.root, f.tree); window.__PENDING_FOLDER__ = null; } });

	const buffered = window.bridge?.getLastOpened?.();
	if (buffered) openFileInTab(buffered.filePath, buffered.content);
	if (window.__PENDING_OPEN__) { const p = window.__PENDING_OPEN__; openFileInTab(p.filePath, p.content); window.__PENDING_OPEN__ = null; }
	if (window.__PENDING_FOLDER__) { const f = window.__PENDING_FOLDER__; currentWorkspaceRoot = f.root; renderTree(f.root, f.tree); window.__PENDING_FOLDER__ = null; }

	loadExtensions();

	function renderTree(root, tree) {
		fileTreeEl.innerHTML = '';
		const rootEl = document.createElement('div'); rootEl.className = 'item'; rootEl.textContent = root; fileTreeEl.appendChild(rootEl);
		const children = document.createElement('div'); children.className = 'children'; fileTreeEl.appendChild(children);
		for (const node of tree) children.appendChild(renderNode(node));
	}

	function iconSvg(kind) { if (kind === 'dir') return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="#8aa2c4"/></svg>'; return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="5" y="3" width="14" height="18" rx="2" ry="2" stroke="#9aa2b2"/></svg>'; }

	function renderNode(node) {
		const el = document.createElement('div'); el.className = 'item'; el.innerHTML = `${iconSvg(node.type)} <span>${node.name}</span>`;
		if (node.type === 'file') { el.addEventListener('click', async () => { const res = await window.bridge.readFileByPath(node.path); openFileInTab(node.path, res?.content ?? ''); }); }
		else if (node.type === 'dir') {
			const children = document.createElement('div'); children.className = 'children'; let expanded = false;
			el.addEventListener('click', () => { expanded = !expanded; children.style.display = expanded ? 'block' : 'none'; });
			for (const child of node.children) children.appendChild(renderNode(child)); children.style.display = 'none'; const wrap = document.createElement('div'); wrap.appendChild(el); wrap.appendChild(children); return wrap;
		}
		return el;
	}

	function getOrCreateModel(filePath, content) { let model = modelsByPath.get(filePath); if (!model) { const uri = monacoRef.Uri.file(filePath); model = monacoRef.editor.createModel(content ?? '', guessLanguage(filePath), uri); modelsByPath.set(filePath, model); } else if (typeof content === 'string' && model.getValue() !== content) { model.setValue(content); } monacoRef.editor.setModelLanguage(model, guessLanguage(filePath)); return model; }

	function openFileInTab(filePath, content) {
		let tab = openTabs.find(t => t.path === filePath);
		const model = getOrCreateModel(filePath, content);
		if (!tab) { tab = { path: filePath, title: basename(filePath), dirty: false, modelUri: model.uri.toString() }; openTabs.push(tab); const tabEl = document.createElement('div'); tabEl.className = 'tab'; const titleEl = document.createElement('div'); titleEl.className = 'title'; titleEl.textContent = tab.title; const closeEl = document.createElement('div'); closeEl.className = 'close'; closeEl.textContent = '×'; closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(filePath); }); tabEl.appendChild(titleEl); tabEl.appendChild(closeEl); tabEl.addEventListener('click', () => activateTab(filePath)); tab._el = tabEl; tab._titleEl = titleEl; tabsEl.appendChild(tabEl); }
		activateTab(filePath); editor.setModel(model); filenameEl.textContent = filePath; langEl.textContent = guessLanguage(filePath); markDirty(filePath, false); updateStatus();
	}

	function activateTab(filePath) { activeTabPath = filePath; for (const t of openTabs) t._el.classList.toggle('active', t.path === filePath); const model = modelsByPath.get(filePath); if (model) editor.setModel(model); if (settings.autoSave === 'onFocusChange') saveActiveFile(); }

	function markDirty(filePath, isDirty) { if (!filePath) return; const tab = openTabs.find(t => t.path === filePath); if (!tab) return; tab.dirty = isDirty; tab._titleEl.textContent = tab.title + (isDirty ? ' •' : ''); }

	async function saveActiveFile() {
		if (!activeTabPath) return;
		const model = modelsByPath.get(activeTabPath);
		if (!model) return;
		const content = model.getValue();
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
		tab._el.remove(); openTabs.splice(idx, 1);
		const stillUsed = openTabs.some(t => t.path === filePath);
		if (!stillUsed) { const model = modelsByPath.get(filePath); if (model) { model.dispose(); modelsByPath.delete(filePath); } }
		if (activeTabPath === filePath) { const next = openTabs[idx] || openTabs[idx - 1]; if (next) { activateTab(next.path); } else { editor.setValue(''); filenameEl.textContent = ''; activeTabPath = null; updateStatus(); } }
	}

	function updateStatus() { const pos = editor.getPosition(); if (!pos) return; cursorPosEl.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`; }

	function guessLanguage(filePath) { const ext = (filePath.split('/').pop() || '').toLowerCase(); const map = { js: 'javascript', ts: 'typescript', json: 'json', css: 'css', html: 'html', md: 'markdown', py: 'python', java: 'java', c: 'c', cpp: 'cpp', rs: 'rust', go: 'go', sh: 'shell', yml: 'yaml', yaml: 'yaml' }; return map[ext] || 'plaintext'; }

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