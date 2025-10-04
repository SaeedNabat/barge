// Ensure Monaco AMD config only runs once
function waitForAmdLoader() {
	return new Promise((resolve) => {
	  if (window.require && window.require.config) { resolve(); return; }
	  const tick = () => { if (window.require && window.require.config) resolve(); else setTimeout(tick, 20); };
	  tick();
	});
  }

if (!window.__MONACO_CONFIGURED__) {
	window.__MONACO_CONFIGURED__ = true;
	// Detect runtime env for asset bases
	const href = (typeof document !== 'undefined' ? (document.baseURI || window.location?.href || '') : '');
	const isViteDev = typeof window !== 'undefined' && (window.location?.port === '5173' || /localhost:5173$/.test(window.location?.host || ''));
	const isDist = /\/dist\//.test(href);
	const monacoBaseUrl = isViteDev
		? new URL('/monaco-editor/min/', window.location.origin).toString()
		: (isDist
			? new URL('./node_modules/monaco-editor/min/', document.baseURI).toString()
			: new URL('../../node_modules/monaco-editor/min/', document.baseURI).toString());
	if (window.require && window.require.config) {
		require.config({ paths: { vs: monacoBaseUrl + 'vs' } });
	}
	
	// Optimized worker environment - only create workers when needed
	window.MonacoEnvironment = {
		baseUrl: monacoBaseUrl,
		getWorkerUrl: function (_moduleId, _label) {
			// Use generic bootstrap that lets Monaco resolve specific workers internally.
			const abs = monacoBaseUrl;
			const code = `self.MonacoEnvironment = { baseUrl: '${abs}' };\nimportScripts('${abs}vs/base/worker/workerMain.js');`;
			const blob = new Blob([code], { type: 'text/javascript' });
			return URL.createObjectURL(blob);
		}
 	};
	
	// Language pack optimization - only register languages that are used
	window.__MONACO_LANGUAGES_LOADED__ = new Set();
	window.__MONACO_LANGUAGE_CACHE__ = new Map(); // Cache loaded language modules
	
	window.__loadMonacoLanguage = function(languageId) {
		if (window.__MONACO_LANGUAGES_LOADED__.has(languageId)) {
			return Promise.resolve();
		}
		
		// Check cache first
		if (window.__MONACO_LANGUAGE_CACHE__.has(languageId)) {
			window.__MONACO_LANGUAGES_LOADED__.add(languageId);
			return Promise.resolve();
		}
		
		// Expanded language map for better coverage
		const basicMap = {
			'javascript': 'javascript', 'typescript': 'typescript',
			'json': 'json',
			'html': 'html', 'xml': 'xml',
			'css': 'css', 'scss': 'scss', 'less': 'less',
			'python': 'python', 'markdown': 'markdown',
			'shell': 'shell', 'sql': 'sql', 'yaml': 'yaml',
			'cpp': 'cpp', 'c': 'cpp',
			'java': 'java', 'csharp': 'csharp', 'go': 'go',
			'rust': 'rust', 'ruby': 'ruby', 'php': 'php',
			'swift': 'swift', 'kotlin': 'kotlin', 'r': 'r',
			'dockerfile': 'dockerfile', 'graphql': 'graphql'
		};
		
		const entry = basicMap[languageId];
		if (!entry) {
			// Fallback: mark as loaded to avoid repeated attempts
			console.warn('Monaco: No basic language module for', languageId, '- using plaintext');
			window.__MONACO_LANGUAGES_LOADED__.add(languageId);
			return Promise.resolve();
		}
		
		// Load language module asynchronously
		return new Promise((resolve) => {
			const startTime = performance.now();
			try {
				require([`vs/basic-languages/${entry}/${entry}`], function(module) {
					window.__MONACO_LANGUAGES_LOADED__.add(languageId);
					window.__MONACO_LANGUAGE_CACHE__.set(languageId, module);
					const loadTime = (performance.now() - startTime).toFixed(2);
					console.log(`Monaco: Loaded ${languageId} in ${loadTime}ms`);
					resolve();
				}, function(err) {
					console.error('Monaco: Failed to load language', languageId, err);
					resolve();
				});
			} catch (err) {
				console.error('Monaco: Error loading language', languageId, err);
				resolve();
			}
		});
	};
}

// Ensure multi-terminal state is globally available
let terminals = window.terminals instanceof Map ? window.terminals : new Map(); // id -> { instance, viewEl, tabEl }
window.terminals = terminals;
let terminalOrder = Array.isArray(window.terminalOrder) ? window.terminalOrder : [];
window.terminalOrder = terminalOrder;
// termId is already declared above; ensure it's on window for other scopes
window.termId = typeof window.termId !== 'undefined' ? window.termId : null;

// Robust top-level helpers
function safeBind(el, type, handler) { if (el && !(el.dataset && el.dataset.bound === '1')) { el.addEventListener(type, handler); if (el.dataset) el.dataset.bound = '1'; } }
function hideAnyModal() { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); }
function closeCmdPalette() { const el = document.getElementById('cmdPalette'); if (!el) return; el.classList.add('hidden'); document.getElementById('cmdInput')?.blur(); }

// Escape HTML for safe insertion into innerHTML
function escapeHtml(input) {
	if (input == null) return '';
	return String(input)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function openInTabSafe(filePath, content) {
	if (typeof window.bargeOpenFileInTab === 'function') {
		window.bargeOpenFileInTab(filePath, content);
		const modal = document.getElementById('emptyStateModal'); if (modal) modal.classList.add('hidden');
		return;
	}
	window.__PENDING_OPEN__ = { filePath, content };
}

let monacoRef = null; let editor = null;
// Use window.openTabs directly so context menu can access it
window.openTabs = window.openTabs || [];
let openTabs = window.openTabs; // Keep local reference for compatibility
let activeTabPath = null;
let editor2Instance = null; let activePane = 'left';
const modelsByPath = new Map(); const autosaveTimers = new Map();
let closedStack = [];
let currentWorkspaceRoot = null; let isOpeningFile = false; let isOpeningFolder = false;
let untitledCounter = 1; let termInstance = null; let selectedDirectoryPath = null; let refreshTimer = null;
let recentTabsHistory = []; // Track tab access order for Ctrl+Tab switching

function isUntitledPath(p) {
	if (!p) return true;
	// Treat tabs created via New File as untitled, typically start with 'Untitled-'
	return /^Untitled-\d+\./.test(p);
}

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

async function showInputModal({ title, label, placeholder, okText = 'OK', validate, onSubmit }) {
		const modal = document.getElementById('inputModal');
		const titleEl = document.getElementById('inputTitle');
		const labelEl = document.getElementById('inputLabel');
	const input = document.getElementById('inputField');
		const btnOk = document.getElementById('inputOk');
		const btnCancel = document.getElementById('inputCancel');
	const errEl = document.getElementById('inputError');
	
	return new Promise((resolve) => {
		titleEl.textContent = title || 'Input';
		labelEl.textContent = label || 'Value';
		input.value = '';
		input.placeholder = placeholder || '';
		errEl.style.display = 'none';
		errEl.textContent = '';
		btnOk.textContent = okText || 'OK';
		modal.classList.remove('hidden');
		setTimeout(() => input.focus(), 0);
		
		async function doSubmit() {
			const v = input.value;
			const msg = validate ? validate(v) : '';
			if (msg) { errEl.textContent = msg; errEl.style.display = 'block'; return; }
			if (onSubmit) {
				const err = await onSubmit(v);
				if (err) { errEl.textContent = err; errEl.style.display = 'block'; return; }
			}
			close(v);
		}
		function close(v) {
			modal.classList.add('hidden');
			titleEl.textContent = '';
			labelEl.textContent = '';
			btnOk.textContent = 'OK';
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
	// Create a new untitled file directly without any dialog
	if (monacoRef) {
		openFileInTab(name, '');
	} else {
		window.__PENDING_OPEN__ = { filePath: name, content: '' };
		window.dispatchEvent(new Event('barge:pending-open'));
	}
}

// Add working flows for context menu actions
async function renameFlow(oldPath) {
	const suggested = (oldPath || '').split('/').pop() || '';
	const val = await showInputModal({
		title: 'Rename',
		label: 'New name',
		placeholder: suggested,
		okText: 'Rename',
		validate: (v) => {
			if (!v) return 'Name is required';
			if (/[\\\/:*?"<>|]/.test(v)) return 'Invalid characters: \\/:*?"<>|';
			return '';
		},
		onSubmit: async (newName) => {
			const res = await window.bridge.renamePath({ oldPath, newName });
			if (!res?.ok) return res?.error || 'Rename failed';
			return '';
		}
	});
	if (!val) return;
	await refreshTree();
}

async function deleteFlow(targetPath) {
	const confirmed = await showInputModal({
		title: 'Delete',
		label: 'Type DELETE to confirm',
		okText: 'Delete',
		validate: (v) => v === 'DELETE' ? '' : 'Please type DELETE to confirm',
		onSubmit: async () => {
			// Try to animate the corresponding tree item before deletion
			try {
				const fileTreeEl = document.getElementById('fileTree');
				const item = fileTreeEl?.querySelector(`.item[data-path="${CSS.escape(targetPath)}"]`);
				if (item) {
					item.classList.add('deleting');
					await new Promise(r => setTimeout(r, 260));
				}
			} catch {}
			const res = await window.bridge.deletePath({ target: targetPath });
			if (!res?.ok) return res?.error || 'Delete failed';
			return '';
		}
	});
	if (!confirmed) return;
	await refreshTree();
}

// Expose flows globally for other handlers
window.renameFlow = renameFlow;
window.deleteFlow = deleteFlow;

const settings = {
	fontFamily: 'JetBrains Mono, Fira Code, Menlo, Consolas, "Liberation Mono", monospace',
	fontSize: 14,
	theme: 'dark', // dark | light | dracula | nord | monokai
	autoSave: 'off', // off | afterDelay | onFocusChange
	autoSaveDelay: 1000,
	formatOnSave: false, // Format document on save
	wordWrap: 'off', // off | on
	lineNumbers: 'on', // on | off
	renderWhitespace: 'none', // none | all | selection
	cursorBlinkMs: 1200,
	statusBarVisible: true,
	tabSize: 4, // Number of spaces per tab
	fontLigatures: true, // Enable font ligatures
	compactMode: false, // Compact UI for smaller screens
	minimapEnabled: true, // Show minimap in editor
	statusBarItems: {
		cursorPos: true,
		selection: true,
		language: true,
		encoding: true,
		eol: true,
		tabSize: true,
		gitBranch: true,
		problems: true,
		fileSize: true,
		readWriteMode: true
	}
};

function loadSettings() {
	try { const raw = localStorage.getItem('barge:settings'); if (raw) Object.assign(settings, JSON.parse(raw)); } catch {}
	// Apply theme class to body
	document.body.classList.remove('theme-light', 'theme-dark', 'theme-dracula', 'theme-nord', 'theme-monokai');
	document.body.classList.add(`theme-${settings.theme || 'dark'}`);
}

function saveSettings() { localStorage.setItem('barge:settings', JSON.stringify(settings)); }

// Session persistence
let sessionSaveTimer = null;
const sessionCursors = {}; // path -> { lineNumber, column }
function serializeSession() {
	return {
		workspaceRoot: currentWorkspaceRoot || null,
		openTabs: openTabs.map(t => ({ path: t.path, title: t.title })),
		activeTabPath: activeTabPath || null,
		split: { on: !!document.getElementById('editorSplit')?.classList.contains('split-on'), activePane },
		cursors: sessionCursors,
	};
}
function saveSession(immediate = false) {
	if (immediate) {
		try { localStorage.setItem('barge:session', JSON.stringify(serializeSession())); } catch {}
		return;
	}
	clearTimeout(sessionSaveTimer);
	sessionSaveTimer = setTimeout(() => {
		try { localStorage.setItem('barge:session', JSON.stringify(serializeSession())); } catch {}
	}, 150);
}
async function restoreSession() {
	let raw = null; try { raw = localStorage.getItem('barge:session'); } catch {}
	if (!raw) return;
	let data = null; try { data = JSON.parse(raw); } catch { return; }
	if (!data || typeof data !== 'object') return;
	if (data.cursors && typeof data.cursors === 'object') { Object.assign(sessionCursors, data.cursors); }
	// Restore workspace tree first
	if (!currentWorkspaceRoot && data.workspaceRoot) {
		try {
			const payload = await window.bridge.readFolderTree(data.workspaceRoot);
			if (payload?.ok) {
				currentWorkspaceRoot = payload.root;
				if (window.bargeRenderTree) window.bargeRenderTree(payload.root, payload.tree); else renderTree(payload.root, payload.tree, { expandedPaths: new Set(), selectedPath: null });
					try { updateEmptyState(); } catch {}
			}
		} catch {}
	}
	// Restore tabs
	if (Array.isArray(data.openTabs)) {
		for (const t of data.openTabs) {
			if (!t || !t.path) continue;
			try {
				const file = await window.bridge.readFileByPath(t.path);
				if (file && typeof file.content === 'string') {
					openInTabSafe(t.path, file.content);
				}
			} catch {}
		}
	}
	// After tabs created, activate and restore cursor
	await new Promise((resolve) => {
	if (data.activeTabPath) {
		setTimeout(() => {
			try {
					// Ensure the saved tab is activated (also updates status bar/lang)
					activateTab(data.activeTabPath);
				const pos = sessionCursors[data.activeTabPath];
				if (pos && editor && modelsByPath.has(data.activeTabPath)) {
					editor.revealPositionInCenter(pos);
					editor.setPosition(pos);
				}
			} catch {}
				resolve();
			}, 60);
		} else {
			resolve();
}
	});
	// Restore split state
	if (data.split && data.split.on) {
		try { splitEditor(); } catch {}
		if (data.split.activePane === 'right' && editor2Instance) { activePane = 'right'; }
	}
	// Notify others that session restore is done
	try { window.dispatchEvent(new Event('barge:session-restored')); } catch {}
}

function updateTabSizeDisplay() {
	const tabSizeEl = document.getElementById('tabSize');
	if (tabSizeEl) {
		tabSizeEl.textContent = `Spaces: ${settings.tabSize}`;
	}
}

function updateBreadcrumb(filePath) {
	const breadcrumbEl = document.getElementById('breadcrumb');
	if (!breadcrumbEl || !filePath) {
		if (breadcrumbEl) breadcrumbEl.innerHTML = '';
		return;
	}
	
	// Split path into parts
	const parts = filePath.split('/').filter(Boolean);
	breadcrumbEl.innerHTML = '';
	
	// Build breadcrumb items
	let currentPath = '';
	parts.forEach((part, index) => {
		currentPath += '/' + part;
		const isLast = index === parts.length - 1;
		
		// Create breadcrumb item
		const item = document.createElement('span');
		item.className = 'breadcrumb-item';
		item.textContent = part;
		item.dataset.path = currentPath;
		
		// Make clickable (except last item)
		if (!isLast) {
			item.addEventListener('click', () => {
				// Could open folder in file tree or show files in that directory
				console.log('Breadcrumb clicked:', currentPath);
			});
		}
		
		breadcrumbEl.appendChild(item);
		
		// Add separator (except after last item)
		if (!isLast) {
			const sep = document.createElement('span');
			sep.className = 'breadcrumb-separator';
			sep.textContent = '/';
			breadcrumbEl.appendChild(sep);
		}
	});
}

function applySettings() {
	// Apply UI settings that don't require Monaco editor
	// Apply theme class to body
	document.body.classList.remove('theme-light', 'theme-dark', 'theme-dracula', 'theme-nord', 'theme-monokai');
	document.body.classList.add(`theme-${settings.theme || 'dark'}`);
	document.body.classList.toggle('compact-mode', settings.compactMode);
	
	// Update tab size display in status bar
	updateTabSizeDisplay();
	
	// Apply cursor blink duration CSS variable (used by custom cursor animation)
	try { document.documentElement.style.setProperty('--cursor-blink-duration', `${Math.max(300, Math.min(3000, parseInt(settings.cursorBlinkMs || 1200, 10)))}ms`); } catch {}
	
	// Apply status bar visibility on app container
	try {
		const appEl = document.querySelector('.app');
		if (appEl) appEl.classList.toggle('statusbar-hidden', !settings.statusBarVisible);
	} catch {}
	
	// Update terminal theme if terminal exists
	updateTerminalTheme();
	
	// Apply statusbar items visibility
	applyStatusBarVisibility();
	
	// Reflect state in View menu
	updateViewMenuState?.();
	
	// If editor is not ready yet, skip editor-specific settings
	if (!editor || !monacoRef) return;
	
	// Get Monaco theme name
	const getMonacoTheme = (themeName) => {
		const themeMap = {
			'light': 'barge-light',
			'dark': 'barge-dark',
			'dracula': 'dracula',
			'nord': 'nord',
			'monokai': 'monokai'
		};
		return themeMap[themeName] || 'barge-dark';
	};
	
	editor.updateOptions({ 
		fontFamily: settings.fontFamily, 
		fontSize: settings.fontSize,
		fontLigatures: settings.fontLigatures,
		wordWrap: settings.wordWrap, 
		lineNumbers: settings.lineNumbers, 
		renderWhitespace: settings.renderWhitespace, 
		tabSize: settings.tabSize,
		minimap: { enabled: settings.minimapEnabled !== false }
	});
	monacoRef.editor.setTheme(getMonacoTheme(settings.theme));
	
	if (editor2Instance) {
		editor2Instance.updateOptions({ 
			fontFamily: settings.fontFamily, 
			fontSize: settings.fontSize, 
			fontLigatures: settings.fontLigatures,
			wordWrap: settings.wordWrap, 
			lineNumbers: settings.lineNumbers, 
			renderWhitespace: settings.renderWhitespace, 
			tabSize: settings.tabSize,
			minimap: { enabled: settings.minimapEnabled !== false }
		});
		monacoRef.editor.setTheme(getMonacoTheme(settings.theme));
	}
}

function getTerminalThemeForCurrentSettings() {
	const isLightTheme = settings.theme === 'light';
	if (isLightTheme) {
		return {
			background: 'rgba(245, 247, 251, 0.9)',
			foreground: '#0f172a',
			cursor: '#2563eb',
			selection: 'rgba(59, 130, 246, 0.3)',
			black: '#0f172a',
			red: '#dc2626',
			green: '#16a34a',
			yellow: '#ca8a04',
			blue: '#2563eb',
			magenta: '#9333ea',
			cyan: '#0891b2',
			white: '#f8fafc',
			brightBlack: '#475569',
			brightRed: '#ef4444',
			brightGreen: '#22c55e',
			brightYellow: '#eab308',
			brightBlue: '#3b82f6',
			brightMagenta: '#a855f7',
			brightCyan: '#06b6d4',
			brightWhite: '#ffffff'
		};
	}
	return {
		background: '#0b0d12',
		foreground: '#ffffff',
		cursor: '#ffffff',
		selection: '#264f78',
		black: '#000000',
		red: '#cd3131',
		green: '#0dbc79',
		yellow: '#e5e510',
		blue: '#2472c8',
		magenta: '#bc3fbc',
		cyan: '#11a8cd',
		white: '#e5e5e5',
		brightBlack: '#666666',
		brightRed: '#f14c4c',
		brightGreen: '#23d18b',
		brightYellow: '#f5f543',
		brightBlue: '#3b8eea',
		brightMagenta: '#d670d6',
		brightCyan: '#29b8db',
		brightWhite: '#ffffff'
	};
}

// Utility: Debounce function to limit how often a function is called
function debounce(func, wait) {
	let timeout;
	return function executedFunction(...args) {
		const later = () => {
			clearTimeout(timeout);
			func(...args);
		};
		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
	};
}

// Utility: Throttle function to limit how often a function is called
function throttle(func, limit) {
	let inThrottle;
	return function(...args) {
		if (!inThrottle) {
			func.apply(this, args);
			inThrottle = true;
			setTimeout(() => inThrottle = false, limit);
		}
	};
}

// Utility: Memoize function to cache expensive calculations
function memoize(func, maxCacheSize = 500) {
	const cache = new Map();
	return function(...args) {
		const key = JSON.stringify(args);
		if (cache.has(key)) {
			return cache.get(key);
		}
		const result = func.apply(this, args);
		// Prevent unlimited cache growth
		if (cache.size >= maxCacheSize) {
			const firstKey = cache.keys().next().value;
			cache.delete(firstKey);
		}
		cache.set(key, result);
		return result;
	};
}

// Memoized: Cache file size calculations
const formatFileSize = memoize(function(bytes) {
	if (!bytes || bytes === 0) return '';
	const units = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
	return `${size} ${units[i]}`;
});

function updateFileSize(content) {
	const fileSizeEl = document.getElementById('fileSize');
	if (!fileSizeEl) return;
	const bytes = new Blob([content || '']).size;
	fileSizeEl.textContent = formatFileSize(bytes);
}

// Debounced version for frequent updates (typing)
const updateFileSizeDebounced = debounce(updateFileSize, 500);

function applyStatusBarVisibility() {
	const items = settings.statusBarItems || {};
	const cursorPosEl = document.getElementById('cursorPos');
	const selectionEl = document.getElementById('selection');
	const langEl = document.getElementById('lang');
	const encodingEl = document.getElementById('encoding');
	const eolEl = document.getElementById('eol');
	const tabSizeEl = document.getElementById('tabSize');
	const gitBranchEl = document.getElementById('gitBranch');
	const problemsCountEl = document.getElementById('problemsCount');
	const fileSizeEl = document.getElementById('fileSize');
	const readWriteModeEl = document.getElementById('readWriteMode');
	
	if (cursorPosEl) cursorPosEl.style.display = items.cursorPos !== false ? '' : 'none';
	if (selectionEl) selectionEl.style.display = items.selection !== false ? '' : 'none';
	if (langEl) langEl.style.display = items.language !== false ? '' : 'none';
	if (encodingEl) encodingEl.style.display = items.encoding !== false ? '' : 'none';
	if (eolEl) eolEl.style.display = items.eol !== false ? '' : 'none';
	if (tabSizeEl) tabSizeEl.style.display = items.tabSize !== false ? '' : 'none';
	if (gitBranchEl) gitBranchEl.style.display = items.gitBranch !== false ? '' : 'none';
	if (problemsCountEl) problemsCountEl.style.display = items.problems !== false ? '' : 'none';
	if (fileSizeEl) fileSizeEl.style.display = items.fileSize !== false ? '' : 'none';
	if (readWriteModeEl) readWriteModeEl.style.display = items.readWriteMode !== false ? '' : 'none';
}

function updateTerminalTheme() {
	const theme = getTerminalThemeForCurrentSettings();
	if (typeof terminals === 'object' && terminals instanceof Map && terminals.size) {
		for (const rec of terminals.values()) {
			if (rec?.instance) rec.instance.options.theme = theme;
		}
		return;
	}
	if (typeof termInstance !== 'undefined' && termInstance) {
		termInstance.options.theme = theme;
	}
}

function updateEmptyState() {
	const modal = document.getElementById('emptyStateModal');
	const sidebarWelcome = document.getElementById('sidebarWelcome');
	const hasAny = openTabs.length > 0 || !!currentWorkspaceRoot;
	modal?.classList.add('hidden');
	
	// Show sidebar welcome buttons when no workspace is open
	if (sidebarWelcome) {
		if (currentWorkspaceRoot) {
			sidebarWelcome.classList.add('hidden');
		} else {
			sidebarWelcome.classList.remove('hidden');
		}
	}
	
	// Also update editor enabled state whenever empty state changes
	updateEditorEnabled();
	
	// Toggle file tree filter visibility based on folder presence
	const fileTreeFilterWrap = document.querySelector('.file-tree-filter');
	if (fileTreeFilterWrap) {
		if (currentWorkspaceRoot) {
			fileTreeFilterWrap.classList.remove('hidden');
		} else {
			fileTreeFilterWrap.classList.add('hidden');
			const inp = document.getElementById('fileTreeFilter');
			if (inp) inp.value = '';
			// Clear any filtering
			const fileTreeEl = document.getElementById('fileTree');
			fileTreeEl?.querySelectorAll('.filtered-out').forEach(n => n.classList.remove('filtered-out'));
		}
	}
}

// Disable editor when there is no active file/model
function updateEditorEnabled() {
	try {
		const hasActive = !!editor && openTabs.length > 0 && !!activeTabPath && !!modelsByPath.get(activeTabPath);
		editor?.updateOptions({ readOnly: !hasActive });
		const editorContainer = document.getElementById('editor');
		if (editorContainer) editorContainer.classList.toggle('disabled', !hasActive);
		// Show/hide FAB based on editor state
		const fab = document.getElementById('fabGoTop');
		if (fab) fab.classList.toggle('hidden', !hasActive);
		const editor2Container = document.getElementById('editor2');
		if (editor2Container) editor2Container.classList.toggle('disabled', !hasActive);
	} catch {}
}

// Early bootstrap to ensure clicks work even if Monaco hasn't finished loading
window.addEventListener('DOMContentLoaded', () => {
	// Swallow Monaco's expected cancellation rejections
	try { window.addEventListener('unhandledrejection', (e) => { const r = e?.reason; const msg = (r && (r.message || r.name)) ? (r.message || r.name) : String(r); if (msg && msg.toLowerCase().includes('canceled')) { e.preventDefault?.(); } }); } catch {}

	// Ensure app logo renders correctly across dev/prod by requesting a data URL from main
	(async () => {
		try {
			const res = await window.bridge?.getLogo?.();
			if (res && res.ok && res.dataUrl) {
				try { document.querySelectorAll('img.app-logo').forEach(img => { img.src = res.dataUrl; }); } catch {}
				try { document.querySelectorAll('img.about-logo').forEach(img => { img.src = res.dataUrl; }); } catch {}
			}
		} catch {}
	})();
	loadSettings();
	applySettings(); // Apply UI settings early (statusbar, theme, etc.)
	loadRecents();

	const menubar = document.getElementById('menubar');
	menubar?.addEventListener('click', (e) => {
		if (!(e.target instanceof Element)) return;
		const btn = e.target.closest('.menu-item');
		if (!btn) return;
		const id = btn.id;
		if (id === 'mFileOpenRecentFile' || id === 'mFileOpenRecentFolder') {
			return;
		}
		menubar.querySelectorAll('.menu.open').forEach(el => el.classList.remove('open'));
	});
	// Refresh View menu state when opening/hovering View menu
	const viewMenu = document.querySelector('.menu[data-menu="view"]');
	if (viewMenu) {
		const dd = viewMenu.querySelector('.dropdown');
		viewMenu.addEventListener('mouseenter', () => updateViewMenuState?.());
		viewMenu.addEventListener('focusin', () => updateViewMenuState?.());
		dd?.addEventListener('transitionend', () => updateViewMenuState?.());
	}

	async function openFileFlow() {
		if (isOpeningFile) return; isOpeningFile = true;
		try {
			hideAnyModal();
			const res = await window.bridge?.openFile?.();
			if (res && res.filePath) {
				addRecentFile(res.filePath);
				openInTabSafe(res.filePath, res.content);
			}
		} finally { isOpeningFile = false; }
	}

	async function openFolderFlow() {
		if (isOpeningFolder) return; isOpeningFolder = true;
		try {
			hideAnyModal();
				// Show file tree loading overlay
				try { document.getElementById('fileTree')?.classList?.add('loading'); } catch {}
			const payload = await window.bridge?.openFolder?.();
			if (payload && payload.root) {
				addRecentFolder(payload.root);
				if (window.bargeRenderTree) {
					currentWorkspaceRoot = payload.root;
					window.bargeRenderTree(payload.root, payload.tree);
					updateEmptyState();
				} else {
					window.__PENDING_FOLDER__ = payload;
					window.dispatchEvent(new Event('barge:pending-folder'));
				}
			}
			} finally {
				try { document.getElementById('fileTree')?.classList?.remove('loading'); } catch {}
				isOpeningFolder = false;
			}
}

	function closeFolderFlow() {
		if (!currentWorkspaceRoot) return;
		// Clear the workspace
		currentWorkspaceRoot = null;
		selectedDirectoryPath = null;
		// Clear the file tree
		const fileTreeEl = document.getElementById('fileTree');
		if (fileTreeEl) fileTreeEl.innerHTML = '';
		// Update UI
		updateEmptyState();
		saveSession();
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

	const mFileNewWindow = document.getElementById('mFileNewWindow');
	const mFileQuickOpen = document.getElementById('mFileQuickOpen');
	const mFileOpen = document.getElementById('mFileOpen');
	const mFileOpenFolder = document.getElementById('mFileOpenFolder');
	const mFileCloseFolder = document.getElementById('mFileCloseFolder');
	const mFileSave = document.getElementById('mFileSave');
	const mFileSaveAll = document.getElementById('mFileSaveAll');
	const mFileSaveAs = document.getElementById('mFileSaveAs');
	const mFileOpenRecentFile = document.getElementById('mFileOpenRecentFile');
	const mFileOpenRecentFolder = document.getElementById('mFileOpenRecentFolder');
	const mFileClearRecent = document.getElementById('mFileClearRecent');
	const mFileCloseAll = document.getElementById('mFileCloseAll');
	const mFileReopenClosed = document.getElementById('mFileReopenClosed');
	const mFileExit = document.getElementById('mFileExit');
	const mEditPreferences = document.getElementById('mEditPreferences');
	const mEditUndo = document.getElementById('mEditUndo');
	const mEditRedo = document.getElementById('mEditRedo');
const mViewToggleSidebar = document.getElementById('mViewToggleSidebar');
const mViewFullScreen = document.getElementById('mViewFullScreen');
const mViewZenMode = document.getElementById('mViewZenMode');
	const prefsModal = document.getElementById('prefsModal');
	const mViewToggleStatus = document.getElementById('mViewToggleStatus');
	const fabGoTop = document.getElementById('fabGoTop');
	const toggleMinimapBtn = document.getElementById('toggleMinimap');
	const mViewToggleWordWrap = document.getElementById('mViewToggleWordWrap');
	const mViewToggleLineNumbers = document.getElementById('mViewToggleLineNumbers');
	const prefTheme = document.getElementById('prefTheme');
	const prefFontFamily = document.getElementById('prefFontFamily');
	const prefFontSize = document.getElementById('prefFontSize');
	const prefTabSize = document.getElementById('prefTabSize');
	const prefTabSizeVal = document.getElementById('prefTabSizeVal');
	const prefAutoSave = document.getElementById('prefAutoSave');
	const prefAutoSaveDelay = document.getElementById('prefAutoSaveDelay');
	const autoSaveDelayField = document.getElementById('autoSaveDelayField');
	const prefsSave = document.getElementById('prefsSave');
	const prefsCancel = document.getElementById('prefsCancel');
	const prefCursorBlink = document.getElementById('prefCursorBlink');
	const prefCursorBlinkVal = document.getElementById('prefCursorBlinkVal');
	const prefFormatOnSave = document.getElementById('prefFormatOnSave');
	const prefFontLigatures = document.getElementById('prefFontLigatures');
	const prefCompactMode = document.getElementById('prefCompactMode');
	const prefMinimap = document.getElementById('prefMinimap');
	const fontPreview = document.getElementById('fontPreview');
	const prefStatusCursorPos = document.getElementById('prefStatusCursorPos');
	const prefStatusSelection = document.getElementById('prefStatusSelection');
	const prefStatusLanguage = document.getElementById('prefStatusLanguage');
	const prefStatusEncoding = document.getElementById('prefStatusEncoding');
	const prefStatusEol = document.getElementById('prefStatusEol');
	const prefStatusTabSize = document.getElementById('prefStatusTabSize');
	const prefStatusGitBranch = document.getElementById('prefStatusGitBranch');
	const prefStatusProblems = document.getElementById('prefStatusProblems');
	const prefStatusFileSize = document.getElementById('prefStatusFileSize');
	const prefStatusReadWriteMode = document.getElementById('prefStatusReadWriteMode');
	const themePreview = document.getElementById('themePreview');
	const importCustomTheme = document.getElementById('importCustomTheme');

	const mFileNew = document.getElementById('mFileNew');
	const newFileBtn = document.getElementById('sidebarNewFile');

	// Window control elements
	const winMin = document.getElementById('winMin');
	const winMax = document.getElementById('winMax');
	const winClose = document.getElementById('winClose');

	// About modal elements
	const mHelpAbout = document.getElementById('mHelpAbout');
	const aboutModal = document.getElementById('aboutModal');
	const aboutClose = document.getElementById('aboutClose');
	
	// Keyboard Shortcuts modal elements
	const mHelpKeyboardShortcuts = document.getElementById('mHelpKeyboardShortcuts');
	const shortcutsModal = document.getElementById('shortcutsModal');
	const shortcutsClose = document.getElementById('shortcutsClose');

	const mEditFind = document.getElementById('mEditFind');

	const cmdPalette = document.getElementById('cmdPalette');
	const cmdBackdrop = document.getElementById('cmdBackdrop');
	const cmdCard = document.getElementById('cmdCard');
	const cmdInput = document.getElementById('cmdInput');
	const cmdList = document.getElementById('cmdList');
	const cmdEmpty = document.getElementById('cmdEmpty');
	const quickOpen = document.getElementById('quickOpen');
	const qoInput = document.getElementById('qoInput');
	const qoList = document.getElementById('qoList');
	const qoEmpty = document.getElementById('qoEmpty');

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
	// Bind input events for live filtering and navigation
	cmdInput.addEventListener('input', () => filterCommands(cmdInput.value));
	cmdInput.addEventListener('keydown', (e) => {
		if (!cmdFiltered.length) return;
		switch (e.key) {
			case 'ArrowDown': e.preventDefault(); cmdSelected = Math.min(cmdFiltered.length - 1, cmdSelected + 1); renderCmdList(cmdFiltered); break;
			case 'ArrowUp': e.preventDefault(); cmdSelected = Math.max(0, cmdSelected - 1); renderCmdList(cmdFiltered); break;
			case 'Enter': e.preventDefault(); executeCmd(cmdFiltered[cmdSelected]); break;
			default: break;
		}
	});

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
			{ id: 'view:toggleSidebar', title: 'View: Toggle Sidebar', hint: 'Ctrl+B', run: () => mViewToggleSidebar?.click() },
			{ id: 'file:open', title: 'File: Open…', hint: 'Ctrl+O', run: () => mFileOpen?.click() },
			{ id: 'file:openFolder', title: 'File: Open Folder…', hint: 'Ctrl+K Ctrl+O', run: () => mFileOpenFolder?.click() },
			{ id: 'file:save', title: 'File: Save', hint: 'Ctrl+S', run: () => mFileSave?.click() },
			{ id: 'file:saveAll', title: 'File: Save All', run: () => mFileSaveAll?.click() },
			{ id: 'file:closeAll', title: 'File: Close All', run: () => mFileCloseAll?.click() },
			{ id: 'file:reopenClosed', title: 'File: Reopen Closed Tab', run: () => mFileReopenClosed?.click() },
			{ id: 'file:saveAs', title: 'File: Save As…', hint: 'Ctrl+Shift+S', run: () => mFileSaveAs?.click() },
			{ id: 'edit:find', title: 'Edit: Find', hint: 'Ctrl+F', run: () => mEditFind?.click() },
			{ id: 'edit:goToLine', title: 'Edit: Go to Line…', hint: 'Ctrl+G', run: () => mEditGoToLine?.click() },
			{ id: 'view:toggleStatusBar', title: 'View: Toggle Status Bar', run: () => mViewToggleStatus?.click() },
			{ id: 'view:toggleTheme', title: 'View: Toggle Theme (Dark/Light)', run: () => { settings.theme = settings.theme === 'light' ? 'dark' : 'light'; saveSettings(); applySettings(); } },
			{ id: 'view:toggleWordWrap', title: 'View: Toggle Word Wrap', hint: 'Alt+Z', run: () => mViewToggleWordWrap?.click() },
			{ id: 'view:toggleLineNumbers', title: 'View: Toggle Line Numbers', run: () => mViewToggleLineNumbers?.click() },
			{ id: 'view:toggleWhitespace', title: 'View: Toggle Render Whitespace', run: () => mViewToggleWhitespace?.click() },
			{ id: 'editor:toggleMinimap', title: 'Editor: Toggle Minimap', hint: 'Ctrl+M', run: () => { if (editor) { const opts = editor.getRawOptions(); const enabled = !opts.minimap?.enabled; settings.minimapEnabled = enabled; saveSettings(); editor.updateOptions({ minimap: { enabled } }); if (editor2Instance) editor2Instance.updateOptions({ minimap: { enabled } }); } } },
		];
	}
	buildCommands();
	loadCmdHistory();

	safeBind(mFileNewWindow, 'click', () => window.bridge?.window?.newWindow?.());
	safeBind(mFileOpen, 'click', openFileFlow);
	safeBind(mFileOpenFolder, 'click', openFolderFlow);
	safeBind(mFileCloseFolder, 'click', closeFolderFlow);
	safeBind(mFileSave, 'click', async () => { if (window.__saveActive) { await window.__saveActive(); } else { window.__PENDING_SAVE_ACTIVE__ = true; } });
	safeBind(mFileSaveAll, 'click', async () => { if (window.__saveAllTabs) { await window.__saveAllTabs(); } else { window.__PENDING_SAVE_ALL__ = true; } });
	safeBind(mFileCloseAll, 'click', () => { if (window.__closeAllTabs) { window.__closeAllTabs(); } else { window.__PENDING_CLOSE_ALL__ = true; } });
	safeBind(mFileReopenClosed, 'click', () => { if (window.__reopenClosedTab) { window.__reopenClosedTab(); } else { window.__PENDING_REOPEN_CLOSED__ = true; } });
safeBind(mFileSaveAs, 'click', async () => { if (!editor) return; const content = editor.getModel()?.getValue(); const res = await window.bridge.saveAs(content); if (res?.filePath) { const old = activeTabPath; activeTabPath = res.filePath; const model = modelsByPath.get(old); if (model) { modelsByPath.delete(old); const newModel = monacoRef.editor.createModel(content ?? '', guessLanguage(res.filePath), monacoRef.Uri.file(res.filePath)); modelsByPath.set(res.filePath, newModel); editor.setModel(newModel); } const tab = openTabs.find(t => t.path === old); if (tab) { tab.path = res.filePath; tab.title = basename(res.filePath); tab._titleEl.textContent = tab.title; } updateEmptyState(); } });
		// Make sure the New File binding is correct
		safeBind(mFileNew, 'click', () => { 
			hideAnyModal(); 
			createUntitled();
		});
safeBind(mFileExit, 'click', () => window.bridge?.window?.close?.());

// Window control bindings
safeBind(winMin, 'click', () => window.bridge?.window?.minimize?.());
safeBind(winMax, 'click', () => window.bridge?.window?.maximizeToggle?.());
safeBind(winClose, 'click', () => window.bridge?.window?.close?.());

// About modal bindings
safeBind(mHelpAbout, 'click', () => { aboutModal.classList.remove('hidden'); });
safeBind(aboutClose, 'click', () => { aboutModal.classList.add('hidden'); });

// Keyboard Shortcuts modal bindings
safeBind(mHelpKeyboardShortcuts, 'click', () => { shortcutsModal.classList.remove('hidden'); });
safeBind(shortcutsClose, 'click', () => { shortcutsModal.classList.add('hidden'); });
safeBind(shortcutsModal, 'click', (e) => {
	if (e.target === shortcutsModal || e.target.classList.contains('modal-backdrop')) {
		shortcutsModal.classList.add('hidden');
	}
});

	// Basic menu bindings
	safeBind(mEditUndo, 'click', () => { editor?.trigger('menu', 'undo', null); });
	safeBind(mEditRedo, 'click', () => { editor?.trigger('menu', 'redo', null); });
	safeBind(mEditPreferences, 'click', () => { if (typeof openPrefs === 'function') openPrefs(); else setTimeout(() => openPrefs?.(), 100); });
	safeBind(mViewToggleStatus, 'click', () => { settings.statusBarVisible = !settings.statusBarVisible; saveSettings(); applySettings(); });
 safeBind(mViewToggleSidebar, 'click', () => { document.querySelector('.app')?.classList.toggle('sidebar-hidden'); saveSettings(); requestAnimationFrame(() => window.forceEditorLayout?.()); setTimeout(() => window.forceEditorLayout?.(), 100); setTimeout(() => window.forceEditorLayout?.(), 250); });

	function openPrefs() {
		if (prefTheme) prefTheme.value = settings.theme || 'dark';
		prefFontFamily.value = settings.fontFamily;
		prefFontSize.value = settings.fontSize;
		if (prefTabSize) {
			prefTabSize.value = settings.tabSize;
			if (prefTabSizeVal) prefTabSizeVal.textContent = `${settings.tabSize} spaces`;
		}
		prefAutoSave.value = settings.autoSave;
		prefAutoSaveDelay.value = settings.autoSaveDelay;
		if (prefFormatOnSave) prefFormatOnSave.checked = settings.formatOnSave || false;
		if (prefFontLigatures) prefFontLigatures.checked = settings.fontLigatures !== false;
		if (prefCompactMode) prefCompactMode.checked = settings.compactMode || false;
		if (prefMinimap) prefMinimap.checked = settings.minimapEnabled !== false;
		if (prefCursorBlink) {
			const val = Math.max(300, Math.min(3000, parseInt(settings.cursorBlinkMs || 1200, 10)));
			prefCursorBlink.value = String(val);
			if (prefCursorBlinkVal) prefCursorBlinkVal.textContent = `${val} ms`;
		}
		// Load statusbar items visibility
		if (prefStatusCursorPos) prefStatusCursorPos.checked = settings.statusBarItems?.cursorPos !== false;
		if (prefStatusSelection) prefStatusSelection.checked = settings.statusBarItems?.selection !== false;
		if (prefStatusLanguage) prefStatusLanguage.checked = settings.statusBarItems?.language !== false;
		if (prefStatusEncoding) prefStatusEncoding.checked = settings.statusBarItems?.encoding !== false;
		if (prefStatusEol) prefStatusEol.checked = settings.statusBarItems?.eol !== false;
		if (prefStatusTabSize) prefStatusTabSize.checked = settings.statusBarItems?.tabSize !== false;
		if (prefStatusGitBranch) prefStatusGitBranch.checked = settings.statusBarItems?.gitBranch !== false;
		if (prefStatusProblems) prefStatusProblems.checked = settings.statusBarItems?.problems !== false;
		if (prefStatusFileSize) prefStatusFileSize.checked = settings.statusBarItems?.fileSize !== false;
		if (prefStatusReadWriteMode) prefStatusReadWriteMode.checked = settings.statusBarItems?.readWriteMode !== false;
		// Update font and theme previews
		updateFontPreview();
		updateThemePreview();
		autoSaveDelayField.style.display = settings.autoSave === 'afterDelay' ? 'grid' : 'none';
		prefsModal.classList.remove('hidden');
	}
	function closePrefs() { prefsModal.classList.add('hidden'); }
	
	function updateFontPreview() {
		if (!fontPreview) return;
		const family = prefFontFamily.value || settings.fontFamily;
		const size = prefFontSize.value || settings.fontSize;
		const ligatures = prefFontLigatures ? prefFontLigatures.checked : settings.fontLigatures;
		fontPreview.style.fontFamily = family;
		fontPreview.style.fontSize = `${size}px`;
		fontPreview.style.fontFeatureSettings = ligatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0';
		fontPreview.style.fontVariantLigatures = ligatures ? 'normal' : 'none';
	}
	
	function updateThemePreview() {
		if (!themePreview || !prefTheme) return;
		const theme = prefTheme.value;
		const themeColors = {
			dark: { bg: '#0f1419', secondary: '#1a1e2e', accent: '#6366f1', text: '#e0e7ff' },
			light: { bg: '#ffffff', secondary: '#f8fafc', accent: '#3b82f6', text: '#0f172a' },
			dracula: { bg: '#282a36', secondary: '#21222c', accent: '#bd93f9', text: '#f8f8f2' },
			nord: { bg: '#2e3440', secondary: '#3b4252', accent: '#88c0d0', text: '#d8dee9' },
			monokai: { bg: '#272822', secondary: '#1e1f1c', accent: '#a6e22e', text: '#f8f8f2' }
		};
		const colors = themeColors[theme] || themeColors.dark;
		themePreview.style.background = colors.bg;
		themePreview.style.color = colors.text;
	}

	safeBind(prefsCancel, 'click', closePrefs);
	// Close modal when clicking backdrop
	safeBind(prefsModal, 'click', (e) => {
		if (e.target === prefsModal || e.target.classList.contains('modal-backdrop')) {
			closePrefs();
		}
	});
	// Update font preview on changes
	safeBind(prefFontFamily, 'input', updateFontPreview);
	safeBind(prefFontSize, 'input', updateFontPreview);
	safeBind(prefFontLigatures, 'change', updateFontPreview);
	// Update theme preview on change
	safeBind(prefTheme, 'change', updateThemePreview);
	// Custom theme import
	safeBind(importCustomTheme, 'click', async () => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.onchange = async (e) => {
			const file = e.target.files[0];
			if (!file) return;
			try {
				const text = await file.text();
				const theme = JSON.parse(text);
				// Validate theme structure
				if (!theme.name || !theme.colors) {
					alert('Invalid theme file. Must contain "name" and "colors" properties.');
					return;
				}
				// Store custom theme
				localStorage.setItem('barge:customTheme', text);
				alert(`Custom theme "${theme.name}" imported successfully!\n\nNote: Custom theme support is experimental.`);
			} catch (err) {
				alert('Error importing theme: ' + err.message);
			}
		};
		input.click();
	});
	if (prefTabSize) {
		safeBind(prefTabSize, 'input', () => { if (prefTabSizeVal) prefTabSizeVal.textContent = `${prefTabSize.value} spaces`; });
	}
	if (prefCursorBlink) {
		safeBind(prefCursorBlink, 'input', () => { if (prefCursorBlinkVal) prefCursorBlinkVal.textContent = `${prefCursorBlink.value} ms`; });
	}
	safeBind(prefAutoSave, 'change', () => { autoSaveDelayField.style.display = prefAutoSave.value === 'afterDelay' ? 'grid' : 'none'; });
	safeBind(prefsSave, 'click', () => {
		if (prefTheme) settings.theme = prefTheme.value;
		settings.fontFamily = prefFontFamily.value || settings.fontFamily;
		settings.fontSize = Math.max(8, Math.min(48, parseInt(prefFontSize.value || settings.fontSize, 10)));
		if (prefTabSize && prefTabSize.value) settings.tabSize = Math.max(1, Math.min(16, parseInt(prefTabSize.value, 10)));
		settings.autoSave = prefAutoSave.value;
		settings.autoSaveDelay = Math.max(100, Math.min(10000, parseInt(prefAutoSaveDelay.value || settings.autoSaveDelay, 10)));
		if (prefFormatOnSave) settings.formatOnSave = prefFormatOnSave.checked;
		if (prefFontLigatures) settings.fontLigatures = prefFontLigatures.checked;
		if (prefCompactMode) settings.compactMode = prefCompactMode.checked;
		if (prefMinimap) settings.minimapEnabled = prefMinimap.checked;
		if (prefCursorBlink && prefCursorBlink.value) settings.cursorBlinkMs = Math.max(300, Math.min(3000, parseInt(prefCursorBlink.value, 10)));
		// Save statusbar items visibility
		if (!settings.statusBarItems) settings.statusBarItems = {};
		if (prefStatusCursorPos) settings.statusBarItems.cursorPos = prefStatusCursorPos.checked;
		if (prefStatusSelection) settings.statusBarItems.selection = prefStatusSelection.checked;
		if (prefStatusLanguage) settings.statusBarItems.language = prefStatusLanguage.checked;
		if (prefStatusEncoding) settings.statusBarItems.encoding = prefStatusEncoding.checked;
		if (prefStatusEol) settings.statusBarItems.eol = prefStatusEol.checked;
		if (prefStatusTabSize) settings.statusBarItems.tabSize = prefStatusTabSize.checked;
		if (prefStatusGitBranch) settings.statusBarItems.gitBranch = prefStatusGitBranch.checked;
		if (prefStatusProblems) settings.statusBarItems.problems = prefStatusProblems.checked;
		if (prefStatusFileSize) settings.statusBarItems.fileSize = prefStatusFileSize.checked;
		if (prefStatusReadWriteMode) settings.statusBarItems.readWriteMode = prefStatusReadWriteMode.checked;
		saveSettings();
		applySettings();
		applyStatusBarVisibility();
		closePrefs();
	});

	safeBind(mEditFind, 'click', () => { editor?.getAction('actions.find')?.run(); });

	safeBind(mEditGoToLine, 'click', async () => {
		if (!editor) return;
		const val = await showInputModal({ title: 'Go to Line', label: 'Line number', placeholder: 'e.g. 120 or 120:5', okText: 'Go', validate: (v) => { if (!v) return 'Enter a line'; const m = String(v).trim().match(/^\s*(\d+)(?::(\d+))?\s*$/); if (!m) return 'Use N or N:C'; return ''; } });
		if (!val) return;
		const m = String(val).trim().match(/^(\d+)(?::(\d+))?$/);
		const model = editor.getModel();
		if (!model) return;
		let line = parseInt(m[1], 10);
		let col = m[2] ? parseInt(m[2], 10) : 1;
		line = Math.max(1, Math.min(model.getLineCount(), line));
		const maxCol = Math.max(1, model.getLineMaxColumn(line));
		col = Math.max(1, Math.min(maxCol, col));
		editor.setSelection({ startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col });
		editor.revealLineInCenter(line);
		editor.focus();
	});

	safeBind(mViewToggleWordWrap, 'click', () => { settings.wordWrap = settings.wordWrap === 'off' ? 'on' : 'off'; saveSettings(); applySettings(); });
	// Animated toggle for line numbers
	safeBind(mViewToggleLineNumbers, 'click', () => {
		const editorEl = document.getElementById('editor');
		if (editorEl) {
			editorEl.classList.add('ln-anim');
			setTimeout(() => editorEl.classList.remove('ln-anim'), 320);
		}
		settings.lineNumbers = settings.lineNumbers === 'on' ? 'off' : 'on';
		saveSettings();
		applySettings();
	});
	safeBind(mViewToggleWhitespace, 'click', () => {
		// Toggle directly between none and all to avoid double clicks
		settings.renderWhitespace = settings.renderWhitespace === 'all' ? 'none' : 'all';
		saveSettings(); applySettings();
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !cmdPalette.classList.contains('hidden')) { e.preventDefault(); closeCmdPalette(); return; }
		if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); editor?.trigger('kb', 'undo', null); }
		if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); editor?.trigger('kb', 'redo', null); }
		if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); mFileSave?.click(); }
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); mFileSaveAs?.click(); }
		// Ctrl+Shift+F removed: Find in Files panel no longer exists
		if (e.ctrlKey && e.key.toLowerCase() === 'g') { e.preventDefault(); mEditGoToLine?.click(); }
		if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'z') { e.preventDefault(); mViewToggleWordWrap?.click(); }
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openCmdPalette(); }
		// Go to Symbol in File
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'o') { 
			e.preventDefault(); 
			editor?.getAction('editor.action.quickOutline')?.run(); 
		}
		// Go to Definition
		if (e.key === 'F12') {
			e.preventDefault();
			editor?.getAction('editor.action.revealDefinition')?.run();
		}
		// Ctrl+K, Z chord for Zen Mode
		if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
			// wait for next key
			e.preventDefault();
			let handled = false;
			function onKey(ev) {
				if (handled) return;
				handled = true;
				document.removeEventListener('keydown', onKey, true);
				if (ev.key.toLowerCase() === 'z') {
					ev.preventDefault();
					mViewZenMode?.click();
				}
			}
			document.addEventListener('keydown', onKey, true);
			setTimeout(() => { if (!handled) { document.removeEventListener('keydown', onKey, true); } }, 800);
		}
		if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); mFileNew?.click(); }
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); mFileNewWindow?.click(); }
	if (e.ctrlKey && e.key.toLowerCase() === 'b') { e.preventDefault(); mViewToggleSidebar?.click(); }
	if (e.ctrlKey && e.key.toLowerCase() === 'm') { e.preventDefault(); toggleMinimapBtn?.click(); }
});

	updateEmptyState();

	const sidebarNewFile = document.getElementById('sidebarNewFile');
	const sidebarNewFolder = document.getElementById('sidebarNewFolder');
const sidebarOpenFile = document.getElementById('sidebarOpenFile');
const sidebarOpenFolder = document.getElementById('sidebarOpenFolder');
			safeBind(sidebarNewFile, 'click', async () => { hideAnyModal(); if (!currentWorkspaceRoot) { alert('Open a folder first to create a file.'); return; } const base = selectedDirectoryPath || currentWorkspaceRoot; const name = await showInputModal({ title: 'New File', label: 'File name', placeholder: 'e.g. index.js', okText: 'Create File', validate: (v) => { if (!v) return 'Name is required'; if (/[\\/:*?"<>|]/.test(v)) return 'Invalid characters: \\/:*?"<>|'; return ''; }, onSubmit: async (val) => { const res = await window.bridge.createFile({ dir: base, name: val }); if (!res?.ok) return res?.error || 'Failed to create file'; return ''; } }); if (!name) return; const pathGuess = (selectedDirectoryPath || currentWorkspaceRoot) + '/' + name; const file = await window.bridge.readFileByPath(pathGuess); openInTabSafe(pathGuess, file?.content ?? ''); });
	safeBind(sidebarNewFolder, 'click', () => { window.createFolderFlow(); });
safeBind(sidebarOpenFile, 'click', openFileFlow);
safeBind(sidebarOpenFolder, 'click', openFolderFlow);

	document.addEventListener('click', (e) => { const t = e.target; if (t instanceof Element && t.id === 'sidebarNewFolder') { e.preventDefault(); window.createFolderFlow(); } }, true);

	const mViewToggleTerminal = document.getElementById('mViewToggleTerminal');
	const terminalPanel = document.getElementById('terminalPanel');
	const terminalTabs = document.getElementById('terminalTabs');
	const terminalViews = document.getElementById('terminalViews');
	const terminalNew = document.getElementById('terminalNew');
	const terminalClosePanel = document.getElementById('terminalClosePanel');

	// Multi-terminal state
	let terminals = new Map(); // id -> { instance, viewEl, tabEl }
	let terminalOrder = []; // ordered list of ids for tab order
	let terminalOnDataBound = false;

	function renderTerminalTabs() {
		if (!terminalTabs) return;
		terminalTabs.innerHTML = '';
		for (const id of terminalOrder) {
			const rec = terminals.get(id);
			if (!rec) continue;
			const tab = document.createElement('button');
			tab.className = 'terminal-tab' + (id === termId ? ' active' : '');
			tab.innerHTML = `<span>Terminal ${id}</span><span class="close" title="Close">✕</span>`;
			tab.addEventListener('click', (e) => {
				if ((e.target instanceof Element) && e.target.closest('.close')) {
					e.preventDefault(); e.stopPropagation(); closeTerminal(id);
					return;
				}
				switchTerminal(id);
			});
			rec.tabEl = tab;
			terminalTabs.appendChild(tab);
		}
	}
	window.renderTerminalTabs = renderTerminalTabs;

	function switchTerminal(id) {
		const rec = terminals.get(id);
		if (!rec) return;
		// Activate view
		for (const otherId of terminalOrder) {
			const r = terminals.get(otherId);
			if (!r) continue;
			r.viewEl.classList.toggle('active', otherId === id);
			r.tabEl?.classList.toggle('active', otherId === id);
		}
		termId = id;
		termInstance = rec.instance;
		// Focus and resize after view becomes visible
				setTimeout(() => {
			window.applyTerminalResizeFor?.(id);
			rec.instance.focus();
		}, 50);
	}
	window.switchTerminal = switchTerminal;
	function applyTerminalResizeFor(id) {
		const rec = terminals.get(id);
		if (!rec) return;
		const el = rec.viewEl.querySelector('.xterm');
		if (!el || !rec.instance) return;
		const cols = Math.max(20, Math.floor(el.clientWidth / 8.5));
		const rows = Math.max(5, Math.floor(el.clientHeight / 18));
		try {
			rec.instance.resize(cols, rows);
			if (window.bridge.terminal.resize && id) {
				window.bridge.terminal.resize(id, cols, rows);
			}
		} catch (err) {
			console.error('Resize failed:', err);
		}
	}
	window.applyTerminalResizeFor = applyTerminalResizeFor;

	// Debounced terminal resize scheduler (per-terminal)
	const __termResizeTimers = new Map();
	function scheduleTerminalResize(id, delay = 120) {
		try { const t = __termResizeTimers.get(id); if (t) clearTimeout(t); } catch {}
		const timer = setTimeout(() => { try { applyTerminalResizeFor(id); } catch {} }, delay);
		__termResizeTimers.set(id, timer);
	}
	function attachGlobalTerminalOnData() {
		if (terminalOnDataBound) return;
		terminalOnDataBound = true;
		window.bridge.terminal.onData((p) => {
			const rec = terminals.get(p.id);
			if (rec && rec.instance) {
				rec.instance.write(p.data);
			} else {
				console.log('No terminal record found for id:', p.id);
			}
		});
	}
	window.attachGlobalTerminalOnData = attachGlobalTerminalOnData;

	async function createTerminal() {
		// Ensure xterm
		const xtermLoaded = await ensureXtermLoadedWithFallback();
		if (!xtermLoaded) {
			console.error('✗ xterm failed to load completely');
			alert('Terminal library failed to load.');
			return;
		}
		window.attachGlobalTerminalOnData?.();
		console.log('=== TERMINAL CREATION DEBUG ===');
		console.log('window.bridge available:', !!window.bridge);
		console.log('window.bridge.terminal available:', !!(window.bridge && window.bridge.terminal));
		console.log('window.bridge.terminal.create available:', !!(window.bridge && window.bridge.terminal && window.bridge.terminal.create));
		// Create view container
		const view = document.createElement('div');
		view.className = 'terminal-view';
		const xtermHost = document.createElement('div');
		xtermHost.className = 'xterm';
		view.appendChild(xtermHost);
		terminalViews?.appendChild(view);

		// Create terminal instance
		let instance;
		try {
			instance = new window.Terminal({
				convertEol: true,
				cursorBlink: true,
				fontSize: 14,
				fontFamily: 'JetBrains Mono, Fira Code, Menlo, Consolas, monospace',
				scrollback: 1000,
				theme: getTerminalThemeForCurrentSettings()
			});
			instance.open(xtermHost);
			// Reset/clear the terminal viewport and scrollback so it starts clean
			try { instance.reset?.(); } catch {}
			try { instance.clear?.(); } catch {}
		} catch (error) {
			console.error('✗ Failed to create terminal instance:', error);
			view.remove();
			return;
		}

		// Create backend pty
// Create backend pty
		console.log('Creating backend pty with cwd:', currentWorkspaceRoot || 'undefined');
		const created = await window.bridge.terminal.create(80, 24, currentWorkspaceRoot || undefined);
		console.log('Backend pty creation result:', created);
		if (!created?.id) {
			console.error('✗ Terminal create failed:', created);
			instance.dispose?.();
			view.remove();
			return;
		}
		const id = created.id;

		// Wire input -> backend
		instance.onData((data) => {
			if (window.bridge.terminal.write) window.bridge.terminal.write(id, data);
			console.log('Terminal input data:', data);

		});

		// Track
		terminals.set(id, { instance, viewEl: view, tabEl: null });
		console.log('✓ Terminal stored in map with id:', id);
		console.log('terminals.size:', terminals.size);
		terminalOrder.push(id);
		window.renderTerminalTabs?.();
		// Observe resize on this view (debounced)
		const ro = new ResizeObserver(() => scheduleTerminalResize(id, 120));
		ro.observe(xtermHost);

		// Activate this terminal
		window.switchTerminal?.(id);
		console.log('Sending initial commands to terminal:', id);

		// Ensure dimensions are correct after mount, but do not print any banner
		setTimeout(() => {
			window.applyTerminalResizeFor?.(id);
		}, 120);

		return id;
	}
	window.createTerminal = createTerminal;

	async function closeTerminal(id) {
		const rec = terminals.get(id);
		if (!rec) return;
		try { await window.bridge.terminal.dispose?.(id); } catch {}
		try { rec.instance.dispose?.(); } catch {}
		rec.viewEl.remove();
		terminals.delete(id);
		terminalOrder = terminalOrder.filter(x => x !== id);
		window.renderTerminalTabs?.();
		if (termId === id) {
			const next = terminalOrder[terminalOrder.length - 1];
			if (next) switchTerminal(next);
			else { termId = null; termInstance = null; }
		}
		if (terminalOrder.length === 0) {
			terminalPanel?.classList.add('hidden');
		}
	}

	// New terminal button
	safeBind(terminalNew, 'click', async () => {
		terminalPanel?.classList.remove('hidden');
		await window.createTerminal?.();
	});

	// Close terminal panel button
	safeBind(terminalClosePanel, 'click', () => {
		terminalPanel?.classList.add('hidden');
		updateViewMenuState?.();
	});

	// Improved terminal loading using AMD loader
	async function ensureXtermLoaded() {
		console.log('=== XTERM LOADING START ===');
		console.log('window.Terminal available:', !!window.Terminal);
		
		// Check if Terminal is already available
		if (window.Terminal) {
			console.log('✓ Terminal already available');
			return true;
		}
		
		console.log('Terminal not available, trying AMD loader...');
		
		// Try to load xterm using the AMD loader
		try {
			// Configure AMD paths for xterm
			if (window.require && window.require.config) {
				require.config({
					paths: {
						'xterm': '/xterm/lib/xterm'
				}
			});
		}

			// Load xterm using AMD
			return new Promise((resolve) => {
				require(['xterm'], (xterm) => {
					console.log('✓ xterm loaded via AMD:', xterm);
					// Make Terminal available globally
					window.Terminal = xterm.Terminal;
					window.TerminalAddon = xterm.TerminalAddon;
					resolve(true);
				}, (error) => {
					console.error('✗ AMD xterm loading failed:', error);
					resolve(false);
				});
			});
		} catch (error) {
			console.error('✗ AMD loading attempt failed:', error);
			return false;
		}
	}

	// Simplified fallback - no CDN since CSP blocks it
	async function ensureXtermLoadedWithFallback() {
		console.log('=== XTERM LOADING WITH FALLBACK ===');
		
		// Just try the local loading since CDN is blocked by CSP
		const success = await ensureXtermLoaded();
		if (success) {
			return true;
		}
		
		console.error('✗ xterm failed to load - check if xterm is properly installed');
		console.error('Trying to manually check xterm script...');
		
		// Try to manually check if the script loaded
		const scripts = Array.from(document.scripts);
		const xtermScript = scripts.find(s => s.src.includes('xterm'));
		console.log('Xterm script found:', !!xtermScript);
		if (xtermScript) {
			console.log('Xterm script src:', xtermScript.src);
			console.log('Xterm script loaded:', xtermScript.readyState);
		}
		
		return false;
	}

	safeBind(mViewToggleTerminal, 'click', async () => {
		terminalPanel?.classList.toggle('hidden');
		const isVisible = !terminalPanel?.classList.contains('hidden');
		if (isVisible) {
			if (!terminalOrder.length) {
				await window.createTerminal?.();
			} else {
				const active = terminals.get(termId);
				active?.instance?.focus?.();
				scheduleTerminalResize(termId, 100);
			}
		}
		// Update status bar terminal button
		const termBtn = document.getElementById('statusbarTerminal');
		if (termBtn) {
			termBtn.classList.toggle('active', isVisible);
			termBtn.setAttribute('aria-checked', String(isVisible));
		}
		updateViewMenuState?.();
	});
		// Fixed terminal initialization with improved xterm loading
		async function ensureTerminal() {
			console.log('=== TERMINAL INITIALIZATION START ===');
			
			if (!termInstance) {
				// Step 1: Ensure xterm is loaded with fallback
				console.log('Step 1: Loading xterm...');
				const xtermLoaded = await ensureXtermLoadedWithFallback();
				
				if (!xtermLoaded) {
					console.error('✗ xterm failed to load completely');
					alert('Terminal library failed to load. Please check your internet connection and refresh the page.');
					return;
				}
				console.log('✓ xterm loaded successfully');
				
				// Step 2: Check terminal element
				console.log('Step 2: Checking terminal element...');
				const terminalEl = document.getElementById('terminal');
				if (!terminalEl) {
					console.error('✗ Terminal element not found');
					return;
				}
				console.log('✓ Terminal element found');
				
				// Step 3: Check terminal panel visibility
				console.log('Step 3: Checking terminal panel...');
				const terminalPanel = document.getElementById('terminalPanel');
				if (terminalPanel?.classList.contains('hidden')) {
					console.log('Making terminal panel visible...');
					terminalPanel.classList.remove('hidden');
				}
				console.log('✓ Terminal panel visible');
				
				// Step 4: Create terminal instance
				console.log('Step 4: Creating terminal instance...');
				try {
					termInstance = new window.Terminal({
						convertEol: true,
						cursorBlink: true,
						theme: {
							background: '#0b0d12',
							foreground: '#ffffff',
							cursor: '#ffffff',
							selection: '#264f78'
						},
						fontSize: 14,
						fontFamily: 'JetBrains Mono, Fira Code, Menlo, Consolas, monospace',
						rows: 24,
						cols: 80,
						scrollback: 1000
					});
					console.log('✓ Terminal instance created');
				} catch (error) {
					console.error('✗ Failed to create terminal instance:', error);
					alert('Failed to create terminal: ' + error.message);
					return;
				}
				
				// Step 5: Open terminal in DOM
				console.log('Step 5: Opening terminal in DOM...');
				try {
					termInstance.open(terminalEl);
					console.log('✓ Terminal opened in DOM');
				} catch (error) {
					console.error('✗ Failed to open terminal:', error);
					return;
				}
				
				// Step 6: Check bridge
				console.log('Step 6: Checking bridge...');
				if (!window.bridge || !window.bridge.terminal) {
					console.error('✗ Terminal bridge not available');
					termInstance.write('Terminal bridge not available.\r\n');
					return;
				}
				console.log('✓ Terminal bridge available');
				
				// Step 7: Create terminal process
				console.log('Step 7: Creating terminal process...');
				try {
					const created = await window.bridge.terminal.create(80, 24, currentWorkspaceRoot || undefined);
					console.log('Terminal create result:', created);
					
					if (!created || !created.id) {
						console.error('✗ Terminal create failed:', created);
						termInstance.write('Failed to create terminal process.\r\n');
						return;
					}
					
					termId = created.id;
					console.log('✓ Terminal process created with ID:', termId);
				} catch (error) {
					console.error('✗ Terminal process creation failed:', error);
					termInstance.write('Terminal process creation failed: ' + error.message + '\r\n');
					return;
				}
				
				// Step 8: Set up data handlers
				console.log('Step 8: Setting up data handlers...');
				window.bridge.terminal.onData((p) => {
					if (p.id === termId && termInstance) {
						termInstance.write(p.data);
					}
				});
				
				termInstance.onData((data) => {
					console.log('Terminal input data:', data);
					if (termId && window.bridge.terminal.write) {
						window.bridge.terminal.write(termId, data);
					}
				});
				console.log('✓ Data handlers set up');
				
				// Step 9: Set up resize handling
				console.log('Step 9: Setting up resize handling...');
				const applyResize = () => {
					const el = document.getElementById('terminal');
					if (!el || !termInstance) return;
					
					const cols = Math.max(20, Math.floor(el.clientWidth / 8.5));
					const rows = Math.max(5, Math.floor(el.clientHeight / 18));
					
					try {
						termInstance.resize(cols, rows);
						if (window.bridge.terminal.resize && termId) {
							window.bridge.terminal.resize(termId, cols, rows);
						}
					} catch (err) {
						console.error('Resize failed:', err);
					}
				};
				
				const resizeObserver = new ResizeObserver(() => {
					setTimeout(applyResize, 100);
				});
				resizeObserver.observe(terminalEl);
				console.log('✓ Resize handling set up');
				
				// Step 10: Initial setup
				console.log('Step 10: Initial setup...');
				setTimeout(() => {
					applyResize();
					termInstance.focus();
					
					// Send initial commands to ensure prompt appears
					if (window.bridge.terminal.write) {
						window.bridge.terminal.write(termId, 'clear\r');
						setTimeout(() => {
							window.bridge.terminal.write(termId, 'echo "Terminal ready!"\r');
						}, 100);
					}
				}, 300);
				
				console.log('✓ Terminal fully initialized');
				console.log('=== TERMINAL INIT COMPLETE ===');
				
			} else {
				console.log('Terminal already exists, focusing...');
				termInstance.focus();
		}
}

// Simple terminal test - add this to test basic functionality
function testTerminal() {
	console.log('=== TERMINAL TEST START ===');
	
	// Check if Terminal is available
	console.log('window.Terminal available:', !!window.Terminal);
	
	// Check terminal element
	const terminalEl = document.getElementById('terminal');
	console.log('Terminal element:', terminalEl);
	console.log('Terminal element dimensions:', terminalEl ? {
		width: terminalEl.clientWidth,
		height: terminalEl.clientHeight,
		offsetWidth: terminalEl.offsetWidth,
		offsetHeight: terminalEl.offsetHeight
	} : 'not found');
	
	// Check terminal panel
	const terminalPanel = document.getElementById('terminalPanel');
	console.log('Terminal panel:', terminalPanel);
	console.log('Terminal panel hidden:', terminalPanel?.classList.contains('hidden'));
	
	// Check bridge
	console.log('window.bridge available:', !!window.bridge);
	console.log('window.bridge.terminal available:', !!(window.bridge && window.bridge.terminal));
	
	console.log('=== TERMINAL TEST END ===');
}

// Make test function available globally
window.testTerminal = testTerminal;

// Add DOM ready handler to ensure proper initialization timing
document.addEventListener('DOMContentLoaded', () => {
	console.log('DOM Content Loaded - Terminal should be available now');
	
	// Check if Terminal is available
	if (window.Terminal) {
		console.log('✓ Terminal is available on DOM ready');
	} else {
		console.log('⚠ Terminal not yet available on DOM ready');
	}
	
	// Make terminal initialization available globally for testing
	window.initializeTerminal = async () => {
		console.log('Manual terminal initialization triggered');
		await ensureTerminal();
	};
});

		// Add missing functions for file tree and editor functionality
		function iconSvg(kind, filename = '') {
			// Modern folder icon - always visible
			if (kind === 'dir') {
				return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="#60a5fa"/><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" stroke="#3b82f6" stroke-width="1.5" fill="none"/></svg>';
			}
			
			// Get file extension for color coding
			const ext = filename.split('.').pop()?.toLowerCase();
			
			// Modern color palette for file icons
			const iconColors = {
				// Code files
				'js': '#f7df1e', 'jsx': '#61dafb', 'ts': '#3178c6', 'tsx': '#3b82f6',
				'py': '#3776ab', 'rb': '#cc342d', 'go': '#00add8', 'rs': '#ce422b',
				'java': '#ed8b00', 'cpp': '#00599c', 'c': '#a8b9cc', 'cs': '#239120',
				'php': '#777bb4', 'swift': '#fa7343', 'kt': '#7f52ff',
				
				// Web files
				'html': '#e34f26', 'htm': '#e34f26', 'xml': '#ff6600', 'svg': '#ff9800',
				'css': '#1572b6', 'scss': '#cf649a', 'sass': '#cf649a', 'less': '#1d365d',
				
				// Data files
				'json': '#fbbf24', 'yaml': '#cb171e', 'yml': '#cb171e', 'toml': '#9c4221',
				'md': '#519aba', 'markdown': '#519aba',
				
				// Scripts & configs
				'sql': '#336791', 'sh': '#4eaa25', 'bash': '#4eaa25',
				'dockerfile': '#2496ed', 'gitignore': '#f05032',
				
				// Other
				'log': '#9ca3af', 'txt': '#9ca3af'
			};
			
			const color = iconColors[ext] || '#94a3b8';
			
			// Modern file icon - always visible, no opacity attribute
			return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none">
				<path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6z" fill="${color}"/>
				<path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6z" stroke="${color}" stroke-width="1.5"/>
				<path d="M14 2v6h6" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
			</svg>`;
		}

		function renderNode(node) {
			const el = document.createElement('div');
			el.className = 'item';
			el.dataset.path = node.path || '';
			el.dataset.type = node.type || '';
			// Add file extension for CSS icon selection
			if (node.type === 'file') {
				const ext = node.name.split('.').pop()?.toLowerCase();
				if (ext) el.dataset.ext = ext;
			}
			
			// Add icon + label with proper visibility
			const icon = iconSvg(node.type, node.name);
			el.innerHTML = `${icon}<span class="label">${node.name}</span>`;
			el.draggable = true;
			
			if (node.type === 'dir') {
				// Check if folder has children
				const hasKids = (Array.isArray(node.children) && node.children.length > 0) || !!node.hasChildren;
				let caret = null;
				if (hasKids) {
					el.classList.add('has-children');
					el.classList.add('collapsed'); // Start collapsed
					// Add caret icon at the end (right side)
					caret = document.createElement('span');
					caret.className = 'caret'; // Start closed (no 'open' class)
					caret.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
					el.appendChild(caret);
				}
				const children = document.createElement('div');
				children.className = 'children';
				// Start collapsed (display: none) by default
				children.style.display = 'none';
				for (const child of node.children || []) {
					children.appendChild(renderNode(child));
				}
				// Toggle expand/collapse
				if (hasKids) {
					const onToggle = (e) => {
						e.preventDefault();
						e.stopPropagation();
						const collapsed = el.classList.toggle('collapsed');
						children.style.display = collapsed ? 'none' : 'block';
						// Toggle caret icon
						if (caret) {
							if (collapsed) {
								caret.classList.remove('open');
							} else {
								caret.classList.add('open');
							}
						}
						selectedDirectoryPath = node.path;
						highlightSelectedDir(el);
					};
					el.addEventListener('click', onToggle, false);
					if (caret) caret.addEventListener('click', onToggle, false);
				} else {
					el.addEventListener('click', () => {
						selectedDirectoryPath = node.path;
						highlightSelectedDir(el);
					});
				}
				const container = document.createElement('div');
				container.appendChild(el);
				container.appendChild(children);
				return container;
			} else {
				el.addEventListener('click', () => {
					highlightSelectedDir(el);
					if (monacoRef) {
						window.bridge.readFileByPath(node.path).then(file => {
							if (file && file.content !== undefined) openFileInTab(node.path, file.content);
						});
					} else {
						window.__PENDING_OPEN__ = { filePath: node.path, content: '' };
						window.dispatchEvent(new Event('barge:pending-open'));
					}
				});
			}
			
			return el;
		}

		// Virtual scrolling state
		let flattenedTree = [];
		let virtualScrollState = {
			itemHeight: 24, // Height of each item in pixels
			visibleCount: 50, // Number of items to render
			startIndex: 0,
			scrollTop: 0
		};

		// Initialize all folders to be collapsed by default
		function initializeTreeState(nodes) {
			for (const node of nodes) {
				if (node.type === 'dir') {
					// Set collapsed to true if not already set (folders start closed)
					if (node.collapsed === undefined) {
						node.collapsed = true;
					}
					// Recursively initialize children
					if (node.children && node.children.length > 0) {
						initializeTreeState(node.children);
					}
				}
			}
		}

		// Flatten tree structure for virtual scrolling
		function flattenTree(nodes, level = 0, result = [], parentExpanded = true) {
			for (const node of nodes) {
				result.push({ node, level, isVisible: parentExpanded });
				if (node.type === 'dir' && node.children && node.children.length > 0) {
					const isExpanded = !node.collapsed;
					flattenTree(node.children, level + 1, result, parentExpanded && isExpanded);
				}
			}
			return result;
		}

		function renderTree(root, tree) {
			const fileTreeEl = document.getElementById('fileTree');
			fileTreeEl.innerHTML = '';
			
			// Initialize tree state - collapse all folders by default
			initializeTreeState(tree);
			
			// Store tree globally for re-flattening
			window.__currentTree__ = tree;
			
			// Create wrapper for virtual scrolling
			const wrapper = document.createElement('div');
			wrapper.className = 'tree-scroll-wrapper';
			wrapper.style.position = 'relative';
			wrapper.style.overflow = 'auto';
			wrapper.style.height = '100%';
			
			// Create root element separately (not in virtual scroll)
			const rootEl = document.createElement('div'); 
			rootEl.className = 'item root-folder'; 
			rootEl.textContent = root; 
			rootEl.style.position = 'sticky';
			rootEl.style.top = '0';
			rootEl.style.zIndex = '10';
			rootEl.style.padding = '6px 12px';
			wrapper.appendChild(rootEl);
			rootEl.addEventListener('click', () => { 
				selectedDirectoryPath = root; 
				highlightSelectedDir(rootEl); 
			});
			
			// Create viewport container
			const viewport = document.createElement('div');
			viewport.className = 'tree-viewport';
			viewport.style.position = 'relative';
			
			// Flatten tree for virtual scrolling
			flattenedTree = flattenTree(tree);
			
			// Calculate total height
			const totalHeight = flattenedTree.filter(item => item.isVisible).length * virtualScrollState.itemHeight;
			viewport.style.height = `${totalHeight}px`;
			
			// Create container for visible items
			const container = document.createElement('div');
			container.className = 'tree-items-container';
			container.style.position = 'absolute';
			container.style.top = '0';
			container.style.left = '0';
			container.style.right = '0';
			
			viewport.appendChild(container);
			wrapper.appendChild(viewport);
			fileTreeEl.appendChild(wrapper);
			
			// Render initial visible items
			renderVisibleItems(container);
			
			// Handle scroll events (throttled for smooth performance)
			const handleScroll = throttle(() => {
				virtualScrollState.scrollTop = wrapper.scrollTop;
				renderVisibleItems(container);
			}, 16); // ~60fps
			
			wrapper.addEventListener('scroll', handleScroll, { passive: true });
			
			attachTreeContextMenu(fileTreeEl);
			enableTreeKeyboard(fileTreeEl);
			enableTreeDnD(fileTreeEl);
		}
		
		function renderVisibleItems(container) {
			const { itemHeight, visibleCount, scrollTop } = virtualScrollState;
			const visibleItems = flattenedTree.filter(item => item.isVisible);
			
			// Calculate which items should be visible
			const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - 5); // Add buffer
			const endIndex = Math.min(visibleItems.length, startIndex + visibleCount + 10); // Add buffer
			
			// Clear container
			container.innerHTML = '';
			container.style.transform = `translateY(${startIndex * itemHeight}px)`;
			
			// Render only visible items
			for (let i = startIndex; i < endIndex; i++) {
				const { node, level } = visibleItems[i];
				const nodeEl = renderNodeVirtual(node, level);
				container.appendChild(nodeEl);
			}
		}
		
		function renderNodeVirtual(node, level) {
			const container = document.createElement('div');
			container.style.paddingLeft = `${level * 16}px`;
			container.style.height = `${virtualScrollState.itemHeight}px`;
			
			const el = document.createElement('div');
			el.className = 'item';
			el.dataset.path = node.path || '';
			el.dataset.type = node.type || '';
			
			if (node.type === 'file') {
				const ext = node.name.split('.').pop()?.toLowerCase();
				if (ext) el.dataset.ext = ext;
			}
			
			// Add icon + label with proper visibility
			const icon = iconSvg(node.type, node.name);
			el.innerHTML = `${icon}<span class="label">${node.name}</span>`;
			
			if (node.type === 'dir') {
				const hasKids = (Array.isArray(node.children) && node.children.length > 0) || !!node.hasChildren;
				if (hasKids) {
					el.classList.add('has-children');
					// Add collapsed class only if explicitly collapsed
					if (node.collapsed === true) el.classList.add('collapsed');
					
					const caret = document.createElement('span');
					caret.className = 'caret';
					// Show caret as open by default (unless explicitly collapsed)
					if (node.collapsed !== true) caret.classList.add('open');
					caret.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
					el.appendChild(caret);
					
					el.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						node.collapsed = !node.collapsed;
						
						// Re-flatten tree with updated collapsed states
						const fileTreeEl = document.getElementById('fileTree');
						const rootTree = window.__currentTree__ || [];
						flattenedTree = flattenTree(rootTree);
						
						const wrapper = document.querySelector('.tree-scroll-wrapper');
						const viewport = wrapper.querySelector('.tree-viewport');
						const itemsContainer = wrapper.querySelector('.tree-items-container');
						
						// Update height
						const visibleItems = flattenedTree.filter(item => item.isVisible);
						viewport.style.height = `${visibleItems.length * virtualScrollState.itemHeight}px`;
						
						renderVisibleItems(itemsContainer);
						selectedDirectoryPath = node.path;
						highlightSelectedDir(el);
					});
				} else {
					el.addEventListener('click', () => {
						selectedDirectoryPath = node.path;
						highlightSelectedDir(el);
					});
				}
			} else {
				el.addEventListener('click', () => {
					highlightSelectedDir(el);
					if (monacoRef) {
						window.bridge.readFileByPath(node.path).then(file => {
							if (file && file.content !== undefined) openFileInTab(node.path, file.content);
						});
					}
				});
			}
			
			container.appendChild(el);
			return container;
		}

		function highlightSelectedDir(el) {
			document.querySelectorAll('.file-tree .item.selected').forEach(n => n.classList.remove('selected'));
			el.classList.add('selected');
		}

		function attachTreeContextMenu(container) {
			let menuEl = null;
			function destroyMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
			function showMenu(x, y, items) {
				destroyMenu();
				menuEl = document.createElement('div');
				menuEl.className = 'context-menu';
				for (const it of items) {
					const btn = document.createElement('button');
					btn.className = 'context-item';
					btn.textContent = it.label;
					btn.addEventListener('click', () => { destroyMenu(); it.action?.(); });
					menuEl.appendChild(btn);
				}
				menuEl.style.left = `${x}px`;
				menuEl.style.top = `${y}px`;
				document.body.appendChild(menuEl);
				requestAnimationFrame(() => menuEl.classList.add('show'));
				setTimeout(() => {
					const offClick = (e) => { if (!menuEl?.contains(e.target)) { destroyMenu(); document.removeEventListener('mousedown', offClick, true); } };
					document.addEventListener('mousedown', offClick, true);
				}, 0);
			}
			
// OLD MENU DISABLED: 			container.addEventListener('contextmenu', (e) => {
// OLD MENU DISABLED: 				e.preventDefault();
// OLD MENU DISABLED: 				const target = (e.target instanceof Element) ? e.target.closest('.item') : null;
// OLD MENU DISABLED: 				if (!target) return;
// OLD MENU DISABLED: 				highlightSelectedDir(target);
// OLD MENU DISABLED: 				const path = target.dataset.path || '';
// OLD MENU DISABLED: 				const kind = target.dataset.type || '';
// OLD MENU DISABLED: 				const isDir = kind === 'dir' || !!(target.nextSibling && target.nextSibling.classList && target.nextSibling.classList.contains('children'));
// OLD MENU DISABLED: 				const items = [];
// OLD MENU DISABLED: 				if (isDir) {
// OLD MENU DISABLED: 					items.push(
// OLD MENU DISABLED: 						{ label: 'New File', action: () => { selectedDirectoryPath = path; document.getElementById('sidebarNewFile')?.click(); } },
// OLD MENU DISABLED: 						{ label: 'New Folder', action: () => { selectedDirectoryPath = path; window.createFolderFlow?.(); } },
// OLD MENU DISABLED: 					);
// OLD MENU DISABLED: 				}
// OLD MENU DISABLED: 				if (!isDir) {
// OLD MENU DISABLED: 					items.push({ label: 'Open', action: async () => { const file = await window.bridge.readFileByPath(path); openInTabSafe(path, file?.content ?? ''); } });
// OLD MENU DISABLED: 				}
// OLD MENU DISABLED: 				// Common actions
// OLD MENU DISABLED: 				items.push(
// OLD MENU DISABLED: 					{ label: 'Rename', action: () => { if (typeof renameFlow === 'function') renameFlow(path); else if (window.renameFlow) window.renameFlow(path); else alert('Rename not available'); } },
// OLD MENU DISABLED: 					{ label: 'Duplicate', action: async () => { 
// OLD MENU DISABLED: 						const name = path.split('/').pop();
// OLD MENU DISABLED: 						const dir = path.substring(0, path.lastIndexOf('/'));
// OLD MENU DISABLED: 						const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
// OLD MENU DISABLED: 						const baseName = name.includes('.') ? name.substring(0, name.lastIndexOf('.')) : name;
// OLD MENU DISABLED: 						const newName = `${baseName}-copy${ext}`;
// OLD MENU DISABLED: 						if (isDir) {
// OLD MENU DISABLED: 							alert('Duplicate folder not yet implemented');
// OLD MENU DISABLED: 						} else {
// OLD MENU DISABLED: 							const file = await window.bridge.readFileByPath(path);
// OLD MENU DISABLED: 							if (file && file.content !== undefined) {
// OLD MENU DISABLED: 								const newPath = `${dir}/${newName}`;
// OLD MENU DISABLED: 								await window.bridge.writeFileByPath({ filePath: newPath, content: file.content });
// OLD MENU DISABLED: 								await refreshTree();
// OLD MENU DISABLED: 							}
// OLD MENU DISABLED: 						}
// OLD MENU DISABLED: 					} },
// OLD MENU DISABLED: 					{ label: 'Delete', action: () => { if (typeof deleteFlow === 'function') deleteFlow(path); else if (window.deleteFlow) window.deleteFlow(path); else alert('Delete not available'); } },
// OLD MENU DISABLED: 					{ label: 'Copy Path', action: () => { try { navigator.clipboard?.writeText(path); } catch {} } },
// OLD MENU DISABLED: 					{ label: 'Copy Relative Path', action: () => { 
// OLD MENU DISABLED: 						try {
// OLD MENU DISABLED: 							const relativePath = currentWorkspaceRoot ? path.replace(currentWorkspaceRoot + '/', '') : path;
// OLD MENU DISABLED: 							navigator.clipboard?.writeText(relativePath);
// OLD MENU DISABLED: 						} catch {}
// OLD MENU DISABLED: 					} },
// OLD MENU DISABLED: 					{ label: 'Reveal in OS', action: () => { if (window.bridge?.revealInOS) window.bridge.revealInOS(path); else alert('Reveal not available'); } },
// OLD MENU DISABLED: 					{ label: 'Reveal (Select)', action: () => { highlightSelectedDir(target); } }
// OLD MENU DISABLED: 				);
// OLD MENU DISABLED: 				showMenu(e.pageX, e.pageY, items);
// OLD MENU DISABLED: 			}, false);
		}

				function enableTreeKeyboard(container) {
			// Basic keyboard navigation and shortcuts can be added later
		}

		// React to FS changes from main to keep the tree in sync
		try {
			window.bridge.onFsChanged?.(async (evt) => {
				if (!currentWorkspaceRoot) return;
				await refreshTree();
			});
		} catch {}
 
 		function enableTreeDnD(container) {
			// Basic drag and drop
			container.addEventListener('dragover', (e) => {
				e.preventDefault();
			});
		}

		function getOrCreateModel(filePath, content) { 
			if (!monacoRef) {
				console.error('Monaco not available yet');
				return null;
			}
			// Normalize content to string (bridge may return Buffer/Uint8Array/Array)
			const toText = (c) => {
				try {
					if (typeof c === 'string') return c;
					if (c instanceof Uint8Array) return new TextDecoder('utf-8').decode(c);
					if (Array.isArray(c)) return new TextDecoder('utf-8').decode(new Uint8Array(c));
					if (c && typeof c === 'object' && 'data' in c && Array.isArray(c.data)) {
						return new TextDecoder('utf-8').decode(new Uint8Array(c.data));
					}
				} catch (e) { console.warn('Failed to decode content, falling back to String()', e); }
				return String(c ?? '');
			};
			const text = toText(content);
			try { console.log('[Model] toText length for', filePath, text?.length); } catch {}

			let model = modelsByPath.get(filePath); 
			if (!model) { 
				const uri = monacoRef.Uri.file(filePath); 
				const language = guessLanguage(filePath);
				// Load language pack if not already loaded
				if (window.__loadMonacoLanguage && language !== 'plaintext') {
					window.__loadMonacoLanguage(language).catch(err => {
						console.warn('Failed to load language pack for', language, err);
					});
				}
				model = monacoRef.editor.createModel(text, language, uri); 
				modelsByPath.set(filePath, model); 
			} else if (model.getValue() !== text) { 
				try { console.log('[Model] updating existing model for', filePath, 'new length=', text?.length); } catch {}
				model.setValue(text); 
			} 
			const language = guessLanguage(filePath);
			monacoRef.editor.setModelLanguage(model, language); 
			try { console.log('[Model] language set to', language, 'for', filePath); } catch {}
			return model; 
		}

		function openFileInTab(filePath, content) {
							// open file in tab
			try { console.log('[Open] openFileInTab', filePath, 'content type=', typeof content); } catch {}
			const model = getOrCreateModel(filePath, content);
			if (!model) {
				console.error('Cannot create model - Monaco not ready');
				return;
			}
			// Fallback: if model is empty and no content was provided, try re-reading from bridge
			try {
				const valLen = model?.getValue()?.length ?? 0;
				const noInput = (content === undefined || content === null || (typeof content === 'string' && content.length === 0));
				if (valLen === 0 && noInput && window.bridge?.readFileByPath) {
					console.log('[Open] Empty model, attempting fallback read for', filePath);
					window.bridge.readFileByPath(filePath).then((file) => {
						try {
							const c = file?.content ?? '';
							const dec = (typeof c === 'string') ? c : (Array.isArray(c) || c instanceof Uint8Array || (c && typeof c === 'object' && 'data' in c)) ? new TextDecoder('utf-8').decode(c instanceof Uint8Array ? c : Array.isArray(c) ? new Uint8Array(c) : new Uint8Array(c.data)) : String(c ?? '');
							if (dec && dec.length) {
								model.setValue(dec);
								activateTab(filePath);
								scheduleRelayout?.();
								console.log('[Open] Fallback read applied, length=', dec.length);
							}
						} catch (e) { console.warn('[Open] Fallback read failed to apply', e); }
					}).catch(err => console.warn('[Open] Fallback read failed', err));
				}
			} catch {}
			
			let tab = openTabs.find(t => t.path === filePath);
			if (!tab) { 
				// creating new tab
				tab = { path: filePath, title: basename(filePath), dirty: false, modelUri: model.uri.toString() }; 
				openTabs.push(tab); 
				const tabEl = document.createElement('div'); 
				tabEl.className = 'tab'; 
				tabEl.setAttribute('draggable', 'true');
				tabEl.dataset.path = filePath;
				const titleEl = document.createElement('div'); 
				titleEl.className = 'title'; 
				titleEl.textContent = tab.title; 
				const closeEl = document.createElement('div'); 
				closeEl.className = 'close'; 
				closeEl.textContent = '×'; 
				// No individual listeners - using event delegation
				tabEl.appendChild(titleEl); 
				tabEl.appendChild(closeEl); 
				tab._el = tabEl; 
				tab._titleEl = titleEl; 
				tabsEl.appendChild(tabEl); 
				attachTabDnD();
			}
			activateTab(filePath);
			try { console.log('[Open] activated tab for', filePath); } catch {}
			// Remove duplicate editor.setModel() call - it's already called in activateTab()
			// editor.setModel(model);
			// editor.focus();
			// Update status bar labels safely (elements may not exist in some layouts)
			const filenameEl = document.getElementById('filename');
			const langEl = document.getElementById('lang');
			if (filenameEl) filenameEl.textContent = filePath;
			if (langEl) langEl.textContent = guessLanguage(filePath);
			// Update file size and read/write mode
			updateFileSize(content || model?.getValue());
			const readWriteModeEl = document.getElementById('readWriteMode');
			if (readWriteModeEl) {
				readWriteModeEl.textContent = 'RW';
				readWriteModeEl.classList.remove('read-only');
			}
			try { console.log('[Open] model value length', model?.getValue()?.length); } catch {}
			markDirty(filePath, false); 
			updateStatus();
		}

		function activateTab(path) {
			try {
				const model = modelsByPath.get(path);
				if (!model) return;
				activeTabPath = path;
				
				// Track in recent history for Ctrl+Tab
				recentTabsHistory = recentTabsHistory.filter(p => p !== path);
				recentTabsHistory.unshift(path);
				if (recentTabsHistory.length > 20) recentTabsHistory = recentTabsHistory.slice(0, 20);
				
				if (activePane === 'right' && editor2Instance) {
					editor2Instance.setModel(model);
					editor2Instance.focus();
				} else {
					editor.setModel(model);
					editor.focus();
				}
				// Ensure editor renders the new model
				try { scheduleRelayout?.(); } catch {}
				try {
					const container = document.getElementById(activePane === 'right' ? 'editor2' : 'editor');
					if (container && editor?.layout) {
						editor.layout({ width: container.clientWidth, height: container.clientHeight });
					}
				} catch {}
				// Update active tab styling
				try {
					for (const t of openTabs) {
						if (t && t._el) t._el.classList.toggle('active', t.path === path);
					}
					// Apply a subtle activate animation to the active tab
					const activeTab = openTabs.find(t => t.path === path);
					if (activeTab && activeTab._el) {
						activeTab._el.classList.remove('just-activated');
						// Force reflow to restart animation if needed
						// eslint-disable-next-line no-unused-expressions
						activeTab._el.offsetWidth;
						activeTab._el.classList.add('just-activated');
						setTimeout(() => { try { activeTab._el.classList.remove('just-activated'); } catch {} }, 220);
					}
				} catch {}
				// Update filename and language in status bar
				try { filenameEl.textContent = path; langEl.textContent = guessLanguage(path); } catch {}
				// Update breadcrumb
				updateBreadcrumb(path);
				updateStatus();
				detectEOL();
				updateEditorEnabled();
				saveSession();
			} catch (e) { console.error('activateTab failed', e); }
		}

		// Expose activateTab globally for context menu access
		window.__activateTab = activateTab;

		function markDirty(filePath, isDirty) { 
			if (!filePath) return; 
			const tab = openTabs.find(t => t.path === filePath); 
			if (!tab) return; 
			tab.dirty = isDirty; 
			tab._titleEl.textContent = tab.title + (isDirty ? ' •' : ''); 
		}

		function closeTab(filePath) {
			console.log('closeTab called with:', filePath);
			console.log('Current openTabs before close:', openTabs.map(t => t.path));
			console.log('activeTabPath:', activeTabPath);
			console.log('editor available in closeTab:', !!editor);
			
			const tabIndex = openTabs.findIndex(t => t.path === filePath);
			if (tabIndex === -1) {
				console.log('Tab not found:', filePath);
				return;
			}
			const tab = openTabs[tabIndex];
			const model = modelsByPath.get(filePath);
			// Snapshot for reopen
			if (model) {
				closedStack.push({ path: filePath, content: model.getValue() });
			}
			// Animate close then remove DOM and state
			try { tab._el.classList.add('closing'); } catch {}
			const finalize = () => {
				try { tab._el.remove(); } catch {}
				openTabs.splice(tabIndex, 1);
				console.log('openTabs after close:', openTabs.map(t => t.path));
				if (model) { try { model.dispose(); } catch {}; modelsByPath.delete(filePath); }
				if (activeTabPath === filePath) {
					console.log('Closing active tab, switching to tab to the left or clearing editor');
					if (openTabs.length > 0) {
						let nextTabPath = null;
						if (tabIndex > 0) nextTabPath = openTabs[tabIndex - 1].path; else if (openTabs.length > 0) nextTabPath = openTabs[0].path;
						if (nextTabPath) activateTab(nextTabPath);
					} else { activeTabPath = null; updateEditorEnabled(); }
				}
				saveSession();
			};
			// Prefer animationend, fallback to timeout
			let done = false;
			const onEnd = () => { if (done) return; done = true; tab._el?.removeEventListener?.('animationend', onEnd); finalize(); };
			try { tab._el.addEventListener('animationend', onEnd, { once: true }); } catch {}
			setTimeout(onEnd, 150);
		}

		// Expose closeTab globally for context menu access
		window.__closeTab = closeTab;

		// Move clearEditor inside the require callback where editor is accessible
		function clearEditor() {
			console.log('clearEditor called');
			console.log('editor available:', !!editor);
			console.log('editor type:', typeof editor);
			if (editor) {
				console.log('Editor value before clear:', editor.getValue());
				editor.setValue('');
				editor.updateOptions({ language: 'plaintext' });
				console.log('Editor value after clear:', editor.getValue());
				console.log('Editor cleared');
			} else {
				console.log('Editor not available');
			}
			const filenameEl = document.getElementById('filename');
			if (filenameEl) {
				filenameEl.textContent = '';
				console.log('Filename cleared');
			}
		}

		// Make clearEditor available globally
		window.clearEditor = clearEditor;

		function closeAllTabs() {
			console.log('[closeAllTabs] Starting with', openTabs.length, 'tabs');
			// Create a snapshot to avoid mutation issues during iteration
			const tabsToClose = [...openTabs];
			console.log('[closeAllTabs] Snapshot created:', tabsToClose.length, 'tabs');
			
			// Close all tabs from the snapshot
			tabsToClose.forEach((tab, index) => {
				console.log('[closeAllTabs] Closing tab', index + 1, '/', tabsToClose.length, ':', tab.path);
				closeTab(tab.path);
			});
			
			// Clear any remaining tabs (safety check)
			openTabs.length = 0;
			
			// Clear the editor
			clearEditor();
			activeTabPath = null;
			updateEmptyState();
			console.log('[closeAllTabs] Complete');
		}

		// Make closeAllTabs available globally
		window.__closeAllTabs = closeAllTabs;

		async function saveActiveFile() {
			console.log('saveActiveFile called with activeTabPath:', activeTabPath);
			console.log('autoSave setting:', settings.autoSave);
			if (!activeTabPath || !editor) return;
			
			// Format on save if enabled
			if (settings.formatOnSave) {
				try {
					const formatAction = editor.getAction('editor.action.formatDocument');
					if (formatAction) {
						await formatAction.run();
					}
				} catch (err) {
					console.warn('Format on save failed:', err);
				}
			}
			
			const content = editor.getValue();
			if (isUntitledPath(activeTabPath)) {
				console.log('Saving untitled file, opening save dialog');
				// Handle untitled files - show save as dialog
				window.bridge.saveAs(content).then(res => {
					if (res?.filePath) {
						// Update the tab with the new file path
						const tab = openTabs.find(t => t.path === activeTabPath);
						if (tab) {
							const oldPath = tab.path;
							tab.path = res.filePath;
							tab.title = basename(res.filePath);
							tab._titleEl.textContent = tab.title;
							// Update dataset on DOM element for context menu/close operations
							if (tab._el) tab._el.dataset.path = res.filePath;
							activeTabPath = res.filePath;
							// Update the close button event handler to use the new path
							const closeEl = tab._el.querySelector('.close');
							if (closeEl) {
								// Remove old event listener and add new one with correct path
								closeEl.replaceWith(closeEl.cloneNode(true));
								const newCloseEl = tab._el.querySelector('.close');
								newCloseEl.addEventListener('click', (e) => { 
									e.stopPropagation(); 
									closeTab(res.filePath); 
									updateEmptyState(); 
								});
							}
						}
						markDirty(activeTabPath, false);
					}
				});
			} else {
				console.log('Saving existing file:', activeTabPath);
				// Save existing file using the correct bridge method
				window.bridge.writeFileByPath({ filePath: activeTabPath, content }).then(success => {
					if (success) {
						markDirty(activeTabPath, false);
						console.log('File saved successfully:', activeTabPath);
					} else {
						console.error('Failed to save file:', activeTabPath);
					}
				}).catch(error => {
					console.error('Error saving file:', error);
				});
			}
		}

		async function saveAllTabs() {
			// Save all dirty tabs
			const savePromises = [];
			
			for (const tab of openTabs) {
				if (tab.dirty) {
					const model = modelsByPath.get(tab.path);
					if (model) {
						const content = model.getValue();
						if (isUntitledPath(tab.path)) {
							// Handle untitled files - each needs to be saved individually
							const savePromise = window.bridge.saveAs(content).then(res => {
								if (res?.filePath) {
									tab.path = res.filePath;
									tab.title = basename(res.filePath);
									tab._titleEl.textContent = tab.title;
									markDirty(tab.path, false);
									console.log('Untitled file saved as:', res.filePath);
								}
							}).catch(error => {
								console.error('Error saving untitled file:', error);
							});
							savePromises.push(savePromise);
						} else {
							// Save existing file using the correct bridge method
							const savePromise = window.bridge.writeFileByPath({ filePath: tab.path, content }).then(success => {
								if (success) {
									markDirty(tab.path, false);
									console.log('File saved successfully:', tab.path);
								} else {
									console.error('Failed to save file:', tab.path);
								}
							}).catch(error => {
								console.error('Error saving file:', error);
							});
							savePromises.push(savePromise);
						}
					}
				}
			}
			
			// Wait for all saves to complete
			if (savePromises.length > 0) {
				try {
					await Promise.all(savePromises);
					console.log('All files saved successfully');
				} catch (error) {
					console.error('Some files failed to save:', error);
				}
			} else {
				console.log('No dirty files to save');
			}
		}

		function reopenClosedTab() {
			if (closedStack.length === 0) return;
			const last = closedStack.pop();
			openFileInTab(last.path, last.content ?? '');
			updateEmptyState();
		}

		// Make functions available globally
		window.__saveActive = saveActiveFile;
		window.__saveAllTabs = saveAllTabs;
		window.__reopenClosedTab = reopenClosedTab;

		function updateStatus() { 
			const pos = editor.getPosition(); 
			if (!pos) return; 
			cursorPosEl.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`; 
			
			// Update selection info
			const selection = editor.getSelection();
			if (selection && !selection.isEmpty()) {
				const model = editor.getModel();
				if (model) {
					const selectedText = model.getValueInRange(selection);
					const chars = selectedText.length;
					const lines = selectedText.split('\n').length;
					const words = selectedText.trim().split(/\s+/).filter(Boolean).length;
					
					if (lines > 1) {
						selectionEl.textContent = `${lines} lines, ${chars} chars`;
					} else {
						selectionEl.textContent = `${chars} chars, ${words} words`;
					}
				}
			} else {
				selectionEl.textContent = '';
			}
		}

		// Detect and display git branch
		async function updateGitBranch() {
			if (!currentWorkspaceRoot || !gitBranchEl) return;
			try {
				// Try to read .git/HEAD to get current branch
				const gitHeadPath = `${currentWorkspaceRoot}/.git/HEAD`;
				const result = await window.bridge.readFileByPath(gitHeadPath);
				if (result && result.content) {
					const match = result.content.match(/ref: refs\/heads\/(.+)/);
					if (match) {
						gitBranchEl.textContent = ` ${match[1].trim()}`;
					} else {
						gitBranchEl.textContent = '';
					}
				} else {
					gitBranchEl.textContent = '';
				}
			} catch {
				gitBranchEl.textContent = '';
			}
		}
		
		// Detect line ending type
		function detectEOL() {
			if (!editor || !eolEl) return;
			const model = editor.getModel();
			if (!model) return;
			const eol = model.getEOL();
			eolEl.textContent = eol === '\n' ? 'LF' : 'CRLF';
		}
		
		// Make tab size clickable to change it
		function setupTabSizeClick() {
			const tabSizeEl = document.getElementById('tabSize');
			if (tabSizeEl) {
				tabSizeEl.style.cursor = 'pointer';
				tabSizeEl.addEventListener('click', async () => {
					const val = await showInputModal({
						title: 'Tab Size',
						label: 'Number of spaces per tab',
						placeholder: String(settings.tabSize),
						okText: 'Apply',
						validate: (v) => {
							const num = parseInt(v, 10);
							if (isNaN(num) || num < 1 || num > 16) return 'Enter a number between 1 and 16';
							return '';
						}
					});
					if (val) {
						settings.tabSize = parseInt(val, 10);
						saveSettings();
						applySettings();
					}
				});
			}
			
			// Encoding click handler
			const encodingEl = document.getElementById('encoding');
			if (encodingEl) {
				encodingEl.style.cursor = 'pointer';
				encodingEl.addEventListener('click', () => {
					// For now, just show info - full implementation would require encoding conversion
					alert('Encoding: UTF-8\n\nNote: Encoding conversion is not yet implemented.');
				});
			}
			
			// EOL click handler
			const eolEl = document.getElementById('eol');
			if (eolEl) {
				eolEl.style.cursor = 'pointer';
				eolEl.addEventListener('click', () => {
					const current = eolEl.textContent;
					const newEol = current === 'LF' ? 'CRLF' : 'LF';
					eolEl.textContent = newEol;
					// Update editor content with new line endings if needed
					if (editor) {
						const model = editor.getModel();
						if (model) {
							model.setEOL(newEol === 'CRLF' ? 1 : 0); // 0 = LF, 1 = CRLF
						}
					}
				});
			}
		}

		// Memoized: Cache language detection results (called frequently)
		const guessLanguage = memoize(function(filePath) {
			const ext = filePath.split('.').pop()?.toLowerCase();
			const langMap = {
				'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
				'py': 'python', 'rb': 'ruby', 'go': 'go', 'rs': 'rust', 'java': 'java',
				'cpp': 'cpp', 'c': 'c', 'cs': 'csharp', 'php': 'php', 'swift': 'swift',
				'kt': 'kotlin', 'scala': 'scala', 'clj': 'clojure', 'hs': 'haskell',
				'html': 'html', 'htm': 'html', 'xml': 'xml', 'svg': 'xml',
				'css': 'css', 'scss': 'scss', 'sass': 'sass', 'less': 'less',
				'json': 'json', 'yaml': 'yaml', 'yml': 'yaml', 'toml': 'toml',
				'md': 'markdown', 'markdown': 'markdown', 'rst': 'restructuredtext',
				'sql': 'sql', 'sh': 'shell', 'bash': 'shell', 'zsh': 'shell', 'fish': 'shell',
				'dockerfile': 'dockerfile', 'makefile': 'makefile', 'cmake': 'cmake',
				'ini': 'ini', 'conf': 'ini', 'cfg': 'ini', 'properties': 'properties',
				'log': 'log', 'txt': 'plaintext', 'text': 'plaintext'
			};
			return langMap[ext] || 'plaintext';
		});

		function basename(p) { return p.split('/').pop(); }

		// Add missing event listeners
		window.addEventListener('barge:pending-open', async () => {
			const p = window.__PENDING_OPEN__;
			if (!p) return;
			if (monacoRef) { openFileInTab(p.filePath, p.content); window.__PENDING_OPEN__ = null; return; }
			if (!window.__MONACO_BOOT__) {
			  window.__MONACO_BOOT__ = true;
			  await waitForAmdLoader();
			  require(['vs/editor/editor.main'], function () {
				monacoRef = window.monaco;
				try {
				  monacoRef.editor.defineTheme('barge-light', { base: 'vs', inherit: true, rules: [], colors: {} });
				  monacoRef.editor.defineTheme('barge-dark', { base: 'vs-dark', inherit: true, rules: [], colors: {} });
				} catch {}
				const editorContainer = document.getElementById('editor');
				try {
				  editor = monacoRef.editor.create(editorContainer, {
					value: '',
					language: 'plaintext',
					automaticLayout: true,
					minimap: { enabled: true },
					theme: (settings?.theme === 'light') ? 'barge-light' : 'barge-dark',
				  });
				} catch (e) { console.error('Failed to create Monaco editor lazily', e); }
				try { window.dispatchEvent(new Event('barge:monaco-ready')); } catch {}
				if (window.__PENDING_OPEN__) {
				  const x = window.__PENDING_OPEN__;
				  openFileInTab(x.filePath, x.content);
				  window.__PENDING_OPEN__ = null;
				}
			  });
			  return;
			}
			const onReady = () => {
			  window.removeEventListener('barge:monaco-ready', onReady);
			  const x = window.__PENDING_OPEN__;
			  if (x) { openFileInTab(x.filePath, x.content); window.__PENDING_OPEN__ = null; }
			};
			window.addEventListener('barge:monaco-ready', onReady);
		  });
		// Monaco ready event listener
		window.addEventListener('barge:monaco-ready', () => {
			console.log('Monaco is ready, processing pending files...');
			// Process any pending files now that Monaco is ready
			if (window.__PENDING_OPEN__) {
				const p = window.__PENDING_OPEN__;
				// Get the actual file content
				window.bridge.readFileByPath(p.filePath).then(file => {
					if (file && file.content !== undefined) {
						openFileInTab(p.filePath, file.content);
					}
				});
				window.__PENDING_OPEN__ = null;
			}
		});

		// Drag and Drop support for opening files from OS
		document.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = 'copy';
		});
		
		document.addEventListener('drop', async (e) => {
			e.preventDefault();
			e.stopPropagation();
			
			const files = Array.from(e.dataTransfer.files);
			if (files.length === 0) return;
			
			// Open each dropped file
			for (const file of files) {
				try {
					const filePath = file.path; // Electron provides the full path
					if (filePath) {
						const content = await window.bridge.readFileByPath(filePath);
						if (content && content.content !== undefined) {
							openInTabSafe(filePath, content.content);
						}
					}
				} catch (err) {
					console.error('Failed to open dropped file:', err);
				}
			}
		});

		// Set up bridge event listeners
		window.bridge?.onFolderOpened?.((payload) => { 
			currentWorkspaceRoot = payload.root; 
			renderTree(payload.root, payload.tree); 
			clearEditor(); 
			updateEmptyState();
			updateGitBranch(); 
		});
		
		window.bridge?.onFileOpened?.((payload) => { 
			openFileInTab(payload.filePath, payload.content); 
			updateEmptyState(); 
			// Ensure opened file tab is active
			try { activateTab(payload.filePath); } catch {}
		});

		// Make functions available globally
		window.bargeRenderTree = renderTree;
		window.bargeOpenFileInTab = openFileInTab;

		// Add createUntitled function inside the require callback
		function createUntitled() {
			const name = `Untitled-${untitledCounter++}.txt`;
			// Create a new untitled file directly without any dialog
			if (monacoRef) {
				// Monaco is ready, open file directly
				openFileInTab(name, '');
			} else {
				// Monaco not ready, queue the file opening
				window.__PENDING_OPEN__ = { filePath: name, content: '' };
				window.dispatchEvent(new Event('barge:pending-open'));
			}
			updateEmptyState();
		}

		// Make createUntitled available globally
		window.createUntitled = createUntitled;

		// Get DOM elements that are needed by the functions
		const editorContainer = document.getElementById('editor');
		const filenameEl = document.getElementById('filename');
		const fileTreeEl = document.getElementById('fileTree');
		const tabsEl = document.getElementById('tabs');
		
		// Event delegation for tabs (better memory usage with many tabs)
		if (tabsEl) {
			tabsEl.addEventListener('click', (e) => {
				const closeBtn = e.target.closest('.close');
				const tab = e.target.closest('.tab');
				
				if (closeBtn && tab) {
					// Close button clicked
					e.preventDefault();
					e.stopPropagation();
					const filePath = tab.dataset.path;
					if (filePath) {
						console.log('Close button clicked for:', filePath);
						closeTab(filePath);
						updateEmptyState();
					}
				} else if (tab) {
					// Tab clicked
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
					const filePath = tab.dataset.path;
					if (filePath) {
						activateTab(filePath);
					}
				}
			});
		}
		
		const cursorPosEl = document.getElementById('cursorPos');
		const langEl = document.getElementById('lang');
		const gitBranchEl = document.getElementById('gitBranch');
		const selectionEl = document.getElementById('selection');
		const encodingEl = document.getElementById('encoding');
		const eolEl = document.getElementById('eol');
		// Fuzzy match function
		const fuzzyMatch = (str, pattern) => {
			const strLower = str.toLowerCase();
			const patternLower = pattern.toLowerCase();
			let patternIdx = 0;
			let strIdx = 0;
			while (strIdx < strLower.length && patternIdx < patternLower.length) {
				if (strLower[strIdx] === patternLower[patternIdx]) {
					patternIdx++;
				}
				strIdx++;
			}
			return patternIdx === patternLower.length;
		};

		const fileTreeFilter = document.getElementById('fileTreeFilter');
		if (fileTreeFilter) {
			const applyTreeFilter = () => {
				const fileTreeEl = document.getElementById('fileTree');
				if (!fileTreeEl) return;
				const inputEl = document.getElementById('fileTreeFilter');
				const q = (inputEl?.value || '').trim();
				// If query is empty, clear any previous filtering and show everything
				if (!q) {
					fileTreeEl.querySelectorAll('.filtered-out').forEach(n => n.classList.remove('filtered-out'));
					return;
				}
				const items = fileTreeEl.querySelectorAll('.item');
				items.forEach(it => {
					const type = it.dataset.type || '';
					const nameEl = it.querySelector('span');
					const name = (nameEl?.textContent || '');
					let match = false;
					if (type === 'file') {
						// Use fuzzy matching for files
						match = fuzzyMatch(name, q);
					} else {
						// For directories: keep visible if self name matches OR any descendant file matches
						match = fuzzyMatch(name, q);
						if (!match) {
							const container = it.nextSibling && it.nextSibling.classList && it.nextSibling.classList.contains('children') ? it.nextSibling : null;
							if (container) {
								const childFiles = container.querySelectorAll('.item[data-type="file"]');
								match = Array.from(childFiles).some(cf => fuzzyMatch(cf.querySelector('span')?.textContent || '', q));
							}
						}
					}
					// Toggle target element: files toggle themselves; directories toggle their container (item + children)
					const toggleEl = (type === 'dir') ? it.parentElement : it;
					if (match) toggleEl?.classList?.remove('filtered-out'); else toggleEl?.classList?.add('filtered-out');
				});
			};
			fileTreeFilter.addEventListener('input', applyTreeFilter);
		}

		// Initialize Monaco Editor
		if (!window.__MONACO_BOOT__) {
			window.__MONACO_BOOT__ = true;
			require(['vs/editor/editor.main'], function () {
				monacoRef = window.monaco;

				// Define custom themes that match our app
				monacoRef.editor.defineTheme('barge-light', {
					base: 'vs',
					inherit: true,
					rules: [
						{ token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
						{ token: 'keyword', foreground: '7c3aed', fontStyle: 'bold' },
						{ token: 'string', foreground: '059669' },
						{ token: 'number', foreground: 'dc2626' },
						{ token: 'regexp', foreground: 'ea580c' },
						{ token: 'type', foreground: '2563eb' },
						{ token: 'class', foreground: '7c3aed' },
						{ token: 'function', foreground: '0891b2' },
						{ token: 'variable', foreground: '374151' },
						{ token: 'constant', foreground: 'dc2626' },
						{ token: 'operator', foreground: '374151' },
						{ token: 'delimiter', foreground: '6b7280' },
						{ token: 'tag', foreground: 'dc2626' },
						{ token: 'attribute.name', foreground: '7c3aed' },
						{ token: 'attribute.value', foreground: '059669' }
					],
					colors: {
						'editor.background': '#f8fafc',
						'editor.foreground': '#0f172a',
						'editor.lineHighlightBackground': '#f1f5f9',
						'editor.selectionBackground': '#dbeafe',
						'editor.selectionHighlightBackground': '#e0e7ff',
						'editorCursor.foreground': '#6366f1',
						'editorWhitespace.foreground': '#cbd5e1',
						'editorIndentGuide.background': '#e2e8f0',
						'editorIndentGuide.activeBackground': '#cbd5e1',
						'editorLineNumber.foreground': '#94a3b8',
						'editorLineNumber.activeForeground': '#64748b',
						'editorBracketMatch.background': '#e0e7ff',
						'editorBracketMatch.border': '#3b82f6',
						'editorGutter.background': '#f8fafc',
						'editorWidget.background': '#ffffff',
						'editorWidget.border': '#e2e8f0',
						'editorSuggestWidget.background': '#ffffff',
						'editorSuggestWidget.border': '#e2e8f0',
						'editorSuggestWidget.selectedBackground': '#dbeafe',
						'editorHoverWidget.background': '#ffffff',
						'editorHoverWidget.border': '#e2e8f0',
						'scrollbarSlider.background': '#94a3b888',
						'scrollbarSlider.hoverBackground': '#64748b88',
						'scrollbarSlider.activeBackground': '#33415588'
					}
				});

				monacoRef.editor.defineTheme('barge-dark', {
					base: 'vs-dark',
					inherit: true,
					rules: [
						{ token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
						{ token: 'keyword', foreground: 'a78bfa', fontStyle: 'bold' },
						{ token: 'string', foreground: '10b981' },
						{ token: 'number', foreground: 'f87171' },
						{ token: 'regexp', foreground: 'fb923c' },
						{ token: 'type', foreground: '60a5fa' },
						{ token: 'class', foreground: 'a78bfa' },
						{ token: 'function', foreground: '22d3ee' },
						{ token: 'variable', foreground: 'e5e7eb' },
						{ token: 'constant', foreground: 'f87171' },
						{ token: 'operator', foreground: 'd1d5db' },
						{ token: 'delimiter', foreground: '9ca3af' },
						{ token: 'tag', foreground: 'f87171' },
						{ token: 'attribute.name', foreground: 'a78bfa' },
						{ token: 'attribute.value', foreground: '10b981' }
					],
					colors: {
						'editor.background': '#0b0d12',
						'editor.foreground': '#e5e7eb',
						'editor.lineHighlightBackground': '#0f1115',
						'editor.selectionBackground': '#1e3a8a',
						'editor.selectionHighlightBackground': '#1e40af',
						'editorCursor.foreground': '#6366f1',
						'editorWhitespace.foreground': '#374151',
						'editorIndentGuide.background': '#1f2937',
						'editorIndentGuide.activeBackground': '#374151',
						'editorLineNumber.foreground': '#6b7280',
						'editorLineNumber.activeForeground': '#9ca3af',
						'editorBracketMatch.background': '#1e40af',
						'editorBracketMatch.border': '#3b82f6',
						'editorGutter.background': '#0b0d12',
						'editorWidget.background': '#1f2937',
						'editorWidget.border': '#374151',
						'editorSuggestWidget.background': '#1f2937',
						'editorSuggestWidget.border': '#374151',
						'editorSuggestWidget.selectedBackground': '#1e40af',
						'editorHoverWidget.background': '#1f2937',
						'editorHoverWidget.border': '#374151',
						'scrollbarSlider.background': '#64748b88',
						'scrollbarSlider.hoverBackground': '#94a3b888',
						'scrollbarSlider.activeBackground': '#cbd5e188'
					}
				});

				// Dracula theme
				monacoRef.editor.defineTheme('dracula', {
					base: 'vs-dark',
					inherit: true,
					rules: [
						{ token: 'comment', foreground: '6272a4', fontStyle: 'italic' },
						{ token: 'keyword', foreground: 'ff79c6', fontStyle: 'bold' },
						{ token: 'string', foreground: 'f1fa8c' },
						{ token: 'number', foreground: 'bd93f9' },
						{ token: 'regexp', foreground: 'ffb86c' },
						{ token: 'type', foreground: '8be9fd' },
						{ token: 'class', foreground: '8be9fd' },
						{ token: 'function', foreground: '50fa7b' },
						{ token: 'variable', foreground: 'f8f8f2' },
						{ token: 'constant', foreground: 'bd93f9' },
						{ token: 'operator', foreground: 'ff79c6' },
						{ token: 'tag', foreground: 'ff79c6' },
					],
					colors: {
						'editor.background': '#282a36',
						'editor.foreground': '#f8f8f2',
						'editor.lineHighlightBackground': '#44475a',
						'editor.selectionBackground': '#44475a',
						'editorCursor.foreground': '#f8f8f0',
						'editorWhitespace.foreground': '#44475a',
						'editorLineNumber.foreground': '#6272a4',
					}
				});

				// Nord theme
				monacoRef.editor.defineTheme('nord', {
					base: 'vs-dark',
					inherit: true,
					rules: [
						{ token: 'comment', foreground: '616e88', fontStyle: 'italic' },
						{ token: 'keyword', foreground: '81a1c1', fontStyle: 'bold' },
						{ token: 'string', foreground: 'a3be8c' },
						{ token: 'number', foreground: 'b48ead' },
						{ token: 'regexp', foreground: 'ebcb8b' },
						{ token: 'type', foreground: '8fbcbb' },
						{ token: 'class', foreground: '8fbcbb' },
						{ token: 'function', foreground: '88c0d0' },
						{ token: 'variable', foreground: 'd8dee9' },
						{ token: 'constant', foreground: 'b48ead' },
						{ token: 'operator', foreground: '81a1c1' },
						{ token: 'tag', foreground: '81a1c1' },
					],
					colors: {
						'editor.background': '#2e3440',
						'editor.foreground': '#d8dee9',
						'editor.lineHighlightBackground': '#3b4252',
						'editor.selectionBackground': '#434c5e',
						'editorCursor.foreground': '#d8dee9',
						'editorWhitespace.foreground': '#434c5e',
						'editorLineNumber.foreground': '#4c566a',
					}
				});

				// Monokai theme
				monacoRef.editor.defineTheme('monokai', {
					base: 'vs-dark',
					inherit: true,
					rules: [
						{ token: 'comment', foreground: '75715e', fontStyle: 'italic' },
						{ token: 'keyword', foreground: 'f92672', fontStyle: 'bold' },
						{ token: 'string', foreground: 'e6db74' },
						{ token: 'number', foreground: 'ae81ff' },
						{ token: 'regexp', foreground: 'fd971f' },
						{ token: 'type', foreground: '66d9ef' },
						{ token: 'class', foreground: 'a6e22e' },
						{ token: 'function', foreground: 'a6e22e' },
						{ token: 'variable', foreground: 'f8f8f2' },
						{ token: 'constant', foreground: 'ae81ff' },
						{ token: 'operator', foreground: 'f92672' },
						{ token: 'tag', foreground: 'f92672' },
					],
					colors: {
						'editor.background': '#272822',
						'editor.foreground': '#f8f8f2',
						'editor.lineHighlightBackground': '#3e3d32',
						'editor.selectionBackground': '#49483e',
						'editorCursor.foreground': '#f8f8f0',
						'editorWhitespace.foreground': '#3b3a32',
						'editorLineNumber.foreground': '#90908a',
					}
				});

			// Create Monaco editor
			// Get theme name
			function getMonacoTheme(themeName) {
				const themeMap = {
					'light': 'barge-light',
					'dark': 'barge-dark',
					'dracula': 'dracula',
					'nord': 'nord',
					'monokai': 'monokai'
				};
				return themeMap[themeName] || 'barge-dark';
			}
			
			editor = monacoRef.editor.create(editorContainer, {
				value: '// Welcome to Barge Editor\n',
				language: 'javascript',
				theme: getMonacoTheme(settings.theme),
				automaticLayout: true,
				fontLigatures: settings.fontLigatures,
				cursorBlinking: "smooth",
				cursorSmoothCaretAnimation: "on",
				cursorStyle: "line",
				cursorWidth: 2,
				minimap: { enabled: true },
				fontFamily: settings.fontFamily,
				fontSize: settings.fontSize,
				autoClosingBrackets: 'languageDefined',
				autoClosingQuotes: 'languageDefined',
				autoClosingOvertype: 'always',
				autoSurround: 'languageDefined',
				cursorSurroundingLines: 3,
				cursorSurroundingLinesStyle: "default",
				smoothScrolling: true,
				bracketPairColorization: { enabled: true },
				matchBrackets: 'always',
				stickyScroll: { enabled: true },
				guides: {
					indentation: true,
					highlightActiveIndentation: true,
					bracketPairs: true
				},
				renderWhitespace: 'selection',
				trimAutoWhitespace: true,
				colorDecorators: true,
				scrollbar: { vertical: 'visible', horizontal: 'hidden', verticalScrollbarSize: 12, useShadows: false, alwaysConsumeMouseWheel: true }
			});

				// Set up editor event listeners
				editor.onDidChangeCursorPosition(() => updateStatus());
				editor.onDidChangeCursorPosition(() => {
					try {
						const path = activeTabPath;
						if (!path) return;
						const pos = editor.getPosition();
						if (pos) { sessionCursors[path] = { lineNumber: pos.lineNumber, column: pos.column }; saveSession(); }
					} catch {}
				});
				editor.onDidChangeModelContent(() => { 
					markDirty(activeTabPath, true);
					// Update file size on content change (debounced for performance)
					if (editor) {
						const content = editor.getValue();
						updateFileSizeDebounced(content);
					}
					// handleAutoSave(); 
				});

				// Dispatch Monaco ready event
				window.dispatchEvent(new Event('barge:monaco-ready'));
				console.log('Monaco editor initialized and ready');

				// Apply all settings now that Monaco is ready
				applySettings();
				// Ensure correct enabled/disabled state on startup
				updateEditorEnabled();
				// Setup tab size click handler
				setupTabSizeClick();
				// Initial tab size display
				updateTabSizeDisplay();

				// Robust relayout to keep scrollbars visible across resizes/maximize
				try {
					let relayoutPending = false;
					let relayoutTimer = 0;
					function doLayout() {
						try {
							const el = editorContainer;
							if (!el) return;
							const size = { width: Math.max(0, el.clientWidth), height: Math.max(0, el.clientHeight) };
							if (editor) editor.layout(size);
							if (editor2Instance) editor2Instance.layout(size);
						// Also resize active terminal if visible
						try {
							const termPanel = document.getElementById('terminalPanel');
							if (termPanel && !termPanel.classList.contains('hidden') && window.termId) {
								window.applyTerminalResizeFor?.(window.termId);
							}
						} catch {}
						} finally {
							relayoutPending = false;
						}
					}
					function scheduleRelayout() {
						if (relayoutPending) { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(() => requestAnimationFrame(doLayout), 16); return; }
						relayoutPending = true;
						relayoutTimer = setTimeout(() => requestAnimationFrame(doLayout), 16);
					}
 
 					// Observe container size changes
 					const ro = new ResizeObserver(() => scheduleRelayout());
 					ro.observe(editorContainer);
 					// Window resize fallback
 					window.addEventListener('resize', () => { scheduleRelayout(); requestAnimationFrame(() => doLayout()); });
 					// Initial post-init relayouts
 					scheduleRelayout();
 					setTimeout(scheduleRelayout, 120);
				// Expose global relayout function for external triggers
				window.forceEditorLayout = () => doLayout();
 				} catch {}

				// Process any pending files now that Monaco is ready
				const pendingOps = [];
				if (window.__PENDING_OPEN__) {
					const p = window.__PENDING_OPEN__;
					pendingOps.push((async () => {
						try {
							const file = await window.bridge.readFileByPath(p.filePath);
							if (file && file.content !== undefined) openFileInTab(p.filePath, file.content);
						} catch {}
					})());
					window.__PENDING_OPEN__ = null;
				}
				// Attempt session restore and wait for it
				pendingOps.push((async () => { try { await restoreSession(); } catch {} })());

				// After tabs/tree restored and layout stabilized, signal app ready
				(async () => {
					try {
						await Promise.all(pendingOps);
						await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
						window.bridge?.appReady?.();
					} catch {}
				})();

				// Python linting: debounce and set markers in Monaco
				try {
					let lintTimer = null;
					async function runPythonLint(model) {
						if (!model || !monacoRef) { console.debug('lint:skip no model/monaco'); return; }
						const uri = model.uri;
						const path = uri?.path || uri?.fsPath || null;
						const language = model.getLanguageId?.() || '';
						if (language !== 'python') { console.debug('lint:skip non-python', { language, path }); return; }
						const version = model.getVersionId?.();
						const content = model.getValue();
						console.debug('lint:start', { path, version, bytes: content?.length ?? 0 });
						let res = null; try { res = await window.bridge?.lint?.python?.({ filePath: path, content }); } catch (e) { console.error('lint:ipc error', e); return; }
						const currentModel = monacoRef.editor.getModel(uri);
						if (!currentModel || currentModel.isDisposed?.()) { console.debug('lint:skip disposed', { path }); return; }
						if (version != null && currentModel.getVersionId?.() !== version) { console.debug('lint:skip stale', { requested: version, current: currentModel.getVersionId?.() }); return; }
						if (!res || !res.ok) { try { monacoRef.editor.setModelMarkers(currentModel, 'barge-python', []); } catch {} console.warn('lint:no result', res); return; }
						console.debug('lint:result', { tool: res.tool, count: (res.diagnostics || []).length });
						const markers = (res.diagnostics || []).map(d => ({
							severity: d.severity === 'error' ? monacoRef.MarkerSeverity.Error : (d.severity === 'warning' ? monacoRef.MarkerSeverity.Warning : monacoRef.MarkerSeverity.Info),
							message: d.message || '',
							startLineNumber: d.line || d.startLine || 1,
							startColumn: d.column || d.startColumn || 1,
							endLineNumber: d.endLine || d.line || 1,
							endColumn: d.endColumn || (d.column ? d.column + 1 : 2),
							source: res.tool || 'python'
						}));
						try { monacoRef.editor.setModelMarkers(currentModel, 'barge-python', markers); console.debug('lint:set markers', { count: markers.length }); } catch (e) { console.error('lint:set markers failed', e); }
					}
					function scheduleLint() {
						clearTimeout(lintTimer);
						lintTimer = setTimeout(() => {
							try { const m = editor.getModel?.(); runPythonLint(m); } catch (e) { console.error('lint:schedule failed', e); }
						}, 300);
					}
					// expose for tab events
					window.__schedulePythonLint = scheduleLint;
					editor.onDidChangeModelContent(() => scheduleLint());
					editor.onDidChangeModel(() => scheduleLint());
					editor.onDidChangeModelLanguage?.(() => scheduleLint());
					editor.onDidFocusEditorText?.(() => scheduleLint());
					setTimeout(() => scheduleLint(), 200);
				} catch {}

				// Web Worker-based linting for JavaScript/JSON (non-blocking)
				try {
					let lintWorker = null;
					let workerLintTimer = null;
					
					function initLintWorker() {
						if (lintWorker) return lintWorker;
						
						try {
							lintWorker = new Worker('/src/renderer/lint.worker.js');
							
							lintWorker.addEventListener('message', (e) => {
								const { type, diagnostics, language } = e.data;
								
								if (type === 'LINT_COMPLETE') {
									const currentModel = editor?.getModel();
									if (!currentModel) return;
									
									const markers = diagnostics.map(d => ({
										severity: d.severity,
										startLineNumber: d.startLineNumber,
										startColumn: d.startColumn,
										endLineNumber: d.endLineNumber,
										endColumn: d.endColumn,
										message: d.message,
										source: 'barge-worker'
									}));
									
									try {
										monacoRef.editor.setModelMarkers(currentModel, 'barge-worker', markers);
										console.log(`Worker Lint: ${markers.length} issues in ${language}`);
									} catch (e) {
										console.error('Worker Lint: Failed to set markers', e);
									}
								} else if (type === 'WORKER_READY') {
									console.log('Lint Worker: Ready');
								}
							});
							
							lintWorker.addEventListener('error', (err) => {
								console.error('Lint Worker:', err);
							});
							
							console.log('Lint Worker: Initialized');
						} catch (err) {
							console.error('Lint Worker: Init failed', err);
						}
						
						return lintWorker;
					}
					
					function scheduleLintWorker() {
						clearTimeout(workerLintTimer);
						workerLintTimer = setTimeout(() => {
							const model = editor?.getModel();
							if (!model) return;
							
							const content = model.getValue();
							const uri = model.uri.toString();
							const language = model.getLanguageId();
							
							// Use worker for JS/TS/JSON (Python uses IPC)
							const supportedLanguages = ['javascript', 'typescript', 'json'];
							if (!supportedLanguages.includes(language)) return;
							
							const worker = initLintWorker();
							if (!worker) return;
							
							const lintType = language === 'json' ? 'LINT_JSON' : 'LINT_JAVASCRIPT';
							
							worker.postMessage({
								type: lintType,
								data: { content, filePath: uri, language }
							});
						}, 500);
					}
					
					window.__scheduleLintWorker = scheduleLintWorker;
					editor.onDidChangeModelContent(() => scheduleLintWorker());
					editor.onDidChangeModel(() => scheduleLintWorker());
					setTimeout(() => scheduleLintWorker(), 300);
				} catch {}

				// Problems panel wiring
				try {
					const problemsPanel = document.getElementById('problemsPanel');
					const problemsList = document.getElementById('problemsList');
					const problemsCount = document.getElementById('problemsCount');
					const problemsToggle = document.getElementById('problemsToggle');
					function renderProblems(markersByUri) {
						if (!problemsList || !problemsCount) return;
						problemsList.innerHTML = '';
						let total = 0; let totalErrors = 0;
						for (const [uri, markers] of markersByUri) {
							for (const m of markers) {
								total++;
								if (m.severity === monacoRef.MarkerSeverity.Error) totalErrors++;
								const row = document.createElement('div');
								const kind = m.severity === monacoRef.MarkerSeverity.Error ? 'error' : (m.severity === monacoRef.MarkerSeverity.Warning ? 'warning' : 'info');
								row.className = `problem-item ${kind}`;
								row.innerHTML = `<div class="kind"></div><div class="msg">${escapeHtml(m.message || '')}</div><div class="loc">${basename(uri.path)}:${m.startLineNumber}:${m.startColumn}</div>`;
								row.addEventListener('click', () => {
									try {
										const model = monacoRef.editor.getModel(uri);
										if (model) {
											if (activePane === 'right' && editor2Instance) editor2Instance.setModel(model); else editor.setModel(model);
											const pos = { lineNumber: m.startLineNumber, startColumn: m.startColumn };
											editor.revealPositionInCenter(pos);
											editor.setPosition(pos);
										}
									} catch {}
								});
								problemsList.appendChild(row);
							}
						}
						problemsCount.textContent = total ? `${totalErrors ? '' : ''}${total} problems` : '';
						problemsCount.classList.toggle('bad', totalErrors > 0);
					}
					function collectMarkersByUri() {
						const all = monacoRef.editor.getModels();
						const map = new Map();
						for (const model of all) {
							const arr = monacoRef.editor.getModelMarkers({ resource: model.uri });
							if (arr && arr.length) map.set(model.uri, arr);
						}
						return map;
					}
					function updateProblems() { try { renderProblems(collectMarkersByUri()); } catch {} }
					monacoRef.editor.onDidChangeMarkers(() => updateProblems());
					problemsToggle?.addEventListener('click', (e) => { e.preventDefault(); problemsPanel?.classList.toggle('hidden'); });
					// Initial
					updateProblems();
				} catch {}

					// Go to first line button
					safeBind(fabGoTop, 'click', () => {
						try {
							const m = editor?.getModel?.();
							if (!m) return;
							editor.revealLineInCenter(1);
							editor.setPosition({ lineNumber: 1, column: 1 });
							editor.focus();
						} catch {}
					});
					
					// Toggle minimap button
					safeBind(toggleMinimapBtn, 'click', () => {
						try {
							if (!editor) return;
							const opts = editor.getRawOptions();
							const enabled = !opts.minimap?.enabled;
							settings.minimapEnabled = enabled;
							saveSettings();
							editor.updateOptions({ minimap: { enabled } });
							if (editor2Instance) {
								editor2Instance.updateOptions({ minimap: { enabled } });
							}
							toggleMinimapBtn.classList.toggle('active', enabled);
						} catch {}
					});
				// Format and Problems toggles
									document.addEventListener('keydown', (e) => {
						if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
							e.preventDefault();
							try { const act = editor.getAction('editor.action.formatDocument'); if (act) act.run()?.catch?.(() => {}); } catch {}
						}
						if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
							e.preventDefault();
							const panel = document.getElementById('problemsPanel');
							panel?.classList.toggle('hidden');
						}
					}, true);

			});
		}

		let recentFiles = []; let recentFolders = [];
		function loadRecents() {
			try { const rf = JSON.parse(localStorage.getItem('barge:recentFiles') || '[]'); if (Array.isArray(rf)) recentFiles = rf.slice(0,5); } catch {}
			try { const rd = JSON.parse(localStorage.getItem('barge:recentFolders') || '[]'); if (Array.isArray(rd)) recentFolders = rd.slice(0,5); } catch {}
		}
		function saveRecents() {
			try { localStorage.setItem('barge:recentFiles', JSON.stringify(recentFiles.slice(0,5))); } catch {}
			try { localStorage.setItem('barge:recentFolders', JSON.stringify(recentFolders.slice(0,5))); } catch {}
		}
		function addRecentFile(p) {
			if (!p) return; const i = recentFiles.indexOf(p); if (i !== -1) recentFiles.splice(i,1); recentFiles.unshift(p); recentFiles = recentFiles.slice(0,5); saveRecents();
		}
		function addRecentFolder(p) {
			if (!p) return; const i = recentFolders.indexOf(p); if (i !== -1) recentFolders.splice(i,1); recentFolders.unshift(p); recentFolders = recentFolders.slice(0,5); saveRecents();
		}
		function clearRecentFiles() {
			recentFiles = [];
			recentFolders = [];
			saveRecents();
		}
		function openRecentFile(path) {
			return (async () => {
				try {
					const res = await window.bridge.readFileByPath(path);
					if (res && typeof res.content === 'string') {
						addRecentFile(path);
						openInTabSafe(path, res.content);
					}
				} catch {}
			})();
		}
		function openRecentFolder(path) {
			return (async () => {
				try {
					const payload = await window.bridge.readFolderTree(path);
					if (payload && payload.ok && payload.root) {
						addRecentFolder(path);
						currentWorkspaceRoot = payload.root;
						if (window.bargeRenderTree) window.bargeRenderTree(payload.root, payload.tree); else renderTree(payload.root, payload.tree, collectTreeState());
						updateEmptyState();
					}
				} catch {}
			})();
		}
		function createRecentPopover(items, onPick) {
			const wrap = document.createElement('div');
			wrap.className = 'recent-popover';
			if (!items || !items.length) {
				const empty = document.createElement('div'); empty.className = 'recent-item'; empty.textContent = 'No recent items'; wrap.appendChild(empty);
				return wrap;
			}
			for (const p of items) {
				const btn = document.createElement('button'); btn.className = 'recent-item';
				const name = (p.split('/').pop() || p);
				btn.innerHTML = `<div><div>${name}</div><div class="path">${p}</div></div>`;
				btn.addEventListener('click', (e) => {
					e.preventDefault(); e.stopPropagation(); onPick(p); hideRecentPopovers();
				});
				wrap.appendChild(btn);
			}
			return wrap;
		}
		function hideRecentPopovers() { document.querySelectorAll('.recent-popover').forEach(el => el.remove()); }
		function toggleRecentPopoverFor(anchorBtn, kind) {
	const dropdown = anchorBtn?.closest('.dropdown'); if (!dropdown) return;
	const existing = dropdown.querySelector('.recent-popover');
	if (existing) { existing.remove(); return; }
	hideRecentPopovers();
	const data = kind === 'file' ? recentFiles : recentFolders;
	const pop = createRecentPopover(data, (p) => kind === 'file' ? openRecentFile(p) : openRecentFolder(p));
	dropdown.style.position = 'relative';
	dropdown.appendChild(pop);
	requestAnimationFrame(() => pop.classList.add('show'));
	const close = (e) => { if (!dropdown.contains(e.target)) { hideRecentPopovers(); document.removeEventListener('click', close, true); } };
	setTimeout(() => document.addEventListener('click', close, true), 0);
}

		// Bind recent popovers and view actions inside scope
		safeBind(mFileOpenRecentFile, 'click', (e) => { e.preventDefault(); e.stopPropagation(); showRecentModal('file'); });
		safeBind(mFileOpenRecentFolder, 'click', (e) => { e.preventDefault(); e.stopPropagation(); showRecentModal('folder'); });
		safeBind(mFileClearRecent, 'click', (e) => { 
			e.preventDefault(); 
			e.stopPropagation(); 
			if (confirm('Clear all recent files and folders?')) {
				clearRecentFiles();
				alert('Recent files cleared!');
			}
		});
	
		safeBind(mViewFullScreen, 'click', (e) => { e.preventDefault(); e.stopPropagation(); window.bridge?.window?.toggleFullScreen?.(); });
		safeBind(mViewZenMode, 'click', (e) => { e.preventDefault(); e.stopPropagation(); document.body.classList.toggle('zen'); });

	function showRecentModal(kind) {
		const modal = document.getElementById('recentModal'); if (!modal) return;
		const list = document.getElementById('recentList');
		const title = document.getElementById('recentTitle');
		const btnFile = document.getElementById('recentSwitchFile');
		const btnFolder = document.getElementById('recentSwitchFolder');
		const cancel = document.getElementById('recentCancel');
		let current = kind === 'folder' ? 'folder' : 'file';
		function render() {
			title.textContent = current === 'file' ? 'Open Recent File' : 'Open Recent Folder';
			btnFile.classList.toggle('btn-primary', current === 'file');
			btnFolder.classList.toggle('btn-primary', current === 'folder');
			list.innerHTML = '';
			const data = current === 'file' ? recentFiles : recentFolders;
			if (!data || !data.length) {
				const empty = document.createElement('div'); empty.className = 'recent-row'; empty.textContent = 'No recent items'; list.appendChild(empty); return;
			}
			for (const p of data) {
				const row = document.createElement('button'); row.className = 'recent-row';
				const name = (p.split('/').pop() || p);
				row.innerHTML = `<div><div>${name}</div><div class="path">${p}</div></div>`;
				row.addEventListener('click', (e) => {
					e.preventDefault(); e.stopPropagation();
					if (current === 'file') openRecentFile(p); else openRecentFolder(p);
					hideRecentModal();
				});
				list.appendChild(row);
			}
		}
		function hideRecentModal() { modal.classList.add('hidden'); }
		modal.classList.remove('hidden');
		render();
		const onFile = () => { current = 'file'; render(); };
		const onFolder = () => { current = 'folder'; render(); };
		const onCancel = () => hideRecentModal();
		btnFile.addEventListener('click', onFile);
		btnFolder.addEventListener('click', onFolder);
		cancel.addEventListener('click', onCancel);
		const cleanup = () => {
			btnFile.removeEventListener('click', onFile);
			btnFolder.removeEventListener('click', onFolder);
			cancel.removeEventListener('click', onCancel);
			modal.removeEventListener('keydown', onKey);
		};
		function onKey(e) { if (e.key === 'Escape') { hideRecentModal(); cleanup(); } }
		modal.addEventListener('keydown', onKey);
	}

	function listAllFiles(rootEl) {
		const out = [];
		const walk = (el) => {
			if (!el) return;
			const items = el.children;
			for (const n of items) {
				if (!(n instanceof HTMLElement)) continue;
				if (n.classList.contains('children')) { walk(n); continue; }
				if (n.classList.contains('item')) {
					const type = n.dataset?.type;
					const path = n.dataset?.path;
					if (type === 'file' && path) out.push(path);
					const next = n.nextSibling;
					if (next && next instanceof HTMLElement && next.classList.contains('children')) walk(next);
				}
			}
		};
		walk(rootEl);
		return out;
	}
	function qoFuzzyScore(query, text) {
		query = (query || '').toLowerCase();
		text = (text || '').toLowerCase();
		let score = 0, last = -1;
		for (const ch of query) {
			const idx = text.indexOf(ch, last + 1);
			if (idx === -1) return -1;
			score += (idx - last) <= 2 ? 3 : 1; last = idx;
		}
		return score + Math.max(0, 20 - (text.length - query.length));
	}
	function openQuickOpen() {
		if (!quickOpen) return;
		qoInput.value = '';
		qoList.innerHTML = '';
		qoEmpty.classList.add('hidden');
		quickOpen.classList.remove('hidden');
		setTimeout(() => qoInput.focus(), 0);
		qoSelected = 0;
	}
	function closeQuickOpen() { quickOpen?.classList.add('hidden'); }
	let qoSelected = 0; let qoRows = [];
	function renderQuickOpen(query) {
		qoList.innerHTML = '';
		qoRows = [];
		const fileTreeEl = document.getElementById('fileTree');
		// De-duplicate files by path
		const files = Array.from(new Set(listAllFiles(fileTreeEl)));
		if (!query) {
			qoEmpty.classList.remove('hidden');
			return;
		}
		qoEmpty.classList.add('hidden');
		const scored = files.map(p => ({ p, s: qoFuzzyScore(query, p.split('/').pop() || p) })).filter(x => x.s >= 0).sort((a,b) => b.s - a.s).slice(0, 200);
		let idx = 0;
		for (const { p } of scored) {
			const row = document.createElement('div');
			row.className = 'cmd-item' + (idx === qoSelected ? ' selected' : '');
			const name = p.split('/').pop() || p;
			row.innerHTML = `<div>${name}</div><div class="hint">${p}</div>`;
			row.addEventListener('click', async () => {
				closeQuickOpen();
				const file = await window.bridge.readFileByPath(p);
				openInTabSafe(p, file?.content ?? '');
			});
			qoList.appendChild(row);
			qoRows.push({ el: row, path: p });
			idx++;
		}
	}
	function qoMove(selDelta) {
		if (!qoRows.length) return;
		qoSelected = Math.max(0, Math.min(qoRows.length - 1, qoSelected + selDelta));
		qoRows.forEach((r, i) => r.el.classList.toggle('selected', i === qoSelected));
		qoRows[qoSelected].el.scrollIntoView({ block: 'nearest' });
	}
	function qoOpenSelected() {
		if (!qoRows.length) return;
		const { path } = qoRows[qoSelected];
		closeQuickOpen();
		window.bridge.readFileByPath(path).then(file => openInTabSafe(path, file?.content ?? ''));
	}
	if (qoInput) {
		qoInput.addEventListener('input', () => { qoSelected = 0; renderQuickOpen(qoInput.value); });
		qoInput.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') { e.preventDefault(); closeQuickOpen(); return; }
			if (e.key === 'ArrowDown') { e.preventDefault(); qoMove(1); return; }
			if (e.key === 'ArrowUp') { e.preventDefault(); qoMove(-1); return; }
			if (e.key === 'Enter') { e.preventDefault(); qoOpenSelected(); return; }
		});
	}
	const editorSplit = document.getElementById('editorSplit');
	const editor2 = document.getElementById('editor2');
	const mViewSplit = document.getElementById('mViewSplit');
	const mViewUnsplit = document.getElementById('mViewUnsplit');
	function splitEditor() {
		if (!editorSplit || !editor2) return;
		editorSplit.classList.add('split-on');
		editor2.classList.remove('hidden');
		if (!editor2Instance && monacoRef) {
			const opts = editor.getRawOptions?.() || {};
			editor2Instance = monacoRef.editor.create(editor2, Object.assign({}, opts, {
				automaticLayout: true,
				theme: settings.theme === 'light' ? 'barge-light' : 'barge-dark'
			}));
			editor2Instance.onDidFocusEditorText?.(() => { activePane = 'right'; saveSession(); });
			// Mirror current model
			const current = editor.getModel?.();
			if (current) editor2Instance.setModel(current);
		}
		saveSession();
	}
	function unsplitEditor() {
		if (!editorSplit || !editor2) return;
		editorSplit.classList.remove('split-on');
		editor2.classList.add('hidden');
		if (editor2Instance) { try { editor2Instance.dispose(); } catch {} editor2Instance = null; }
		activePane = 'left';
		saveSession();
	}
	safeBind(mViewSplit, 'click', splitEditor);
	safeBind(mViewUnsplit, 'click', unsplitEditor);
	safeBind(mFileQuickOpen, 'click', openQuickOpen);
	// keyboard
	document.addEventListener('keydown', (e) => {
		if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openQuickOpen(); }
		
		// Ctrl+Tab: Switch to previous tab in history
		if (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) {
			e.preventDefault();
			if (recentTabsHistory.length > 1) {
				// Get the second most recent (first is current)
				const nextPath = recentTabsHistory[1];
				if (nextPath && openTabs.find(t => t.path === nextPath)) {
					activateTab(nextPath);
				}
			}
		}
		
		// Ctrl+Shift+Tab: Cycle forward through tabs
		if (e.ctrlKey && e.key === 'Tab' && e.shiftKey) {
			e.preventDefault();
			const currentIndex = openTabs.findIndex(t => t.path === activeTabPath);
			if (currentIndex !== -1 && openTabs.length > 1) {
				const nextIndex = (currentIndex + 1) % openTabs.length;
				activateTab(openTabs[nextIndex].path);
			}
		}
	}, true);

		// After creating initial tabs or editor, ensure DnD is enabled
		attachTabDnD();
});

function updateViewMenuState() {
	try {
		const statusBtn = document.getElementById('mViewToggleStatus');
		const ww = document.getElementById('mViewToggleWordWrap');
		const ln = document.getElementById('mViewToggleLineNumbers');
		// Status bar
		const sbVisible = !!settings.statusBarVisible;
		statusBtn?.classList.toggle('active', sbVisible);
		statusBtn?.setAttribute('aria-checked', String(sbVisible));
		// Terminal
		const term = document.getElementById('terminalPanel') || document.querySelector('.terminal');
		const termBtn = document.getElementById('mViewToggleTerminal');
		const termVisible = !!term && !term.classList.contains('hidden');
		termBtn?.classList.toggle('active', termVisible);
		termBtn?.setAttribute('aria-checked', String(termVisible));
		// Word wrap
		const wwOn = settings.wordWrap === 'on';
		ww?.classList.toggle('active', wwOn);
		ww?.setAttribute('aria-checked', String(wwOn));
		// Line numbers
		const lnOn = settings.lineNumbers === 'on';
		ln?.classList.toggle('active', lnOn);
		ln?.setAttribute('aria-checked', String(lnOn));
	} catch {}
}

function attachTabDnD() {
	const tabsEl = document.getElementById('tabs');
	if (!tabsEl) return;
	let dragEl = null;
	let indicator = null;
	function ensureIndicator() {
		if (!indicator) { indicator = document.createElement('div'); indicator.className = 'tab-drop-indicator'; }
		return indicator;
	}
	tabsEl.addEventListener('dragstart', (e) => {
		const t = (e.target instanceof Element) ? e.target.closest('.tab') : null;
		if (!t) return;
		dragEl = t;
		t.dataset.dragging = '1';
		e.dataTransfer?.setData('text/plain', t.querySelector('.title')?.textContent || '');
	});
	tabsEl.addEventListener('dragend', () => { if (dragEl) { delete dragEl.dataset.dragging; dragEl = null; } if (indicator) { indicator.remove(); indicator = null; } });
	tabsEl.addEventListener('dragover', (e) => {
		e.preventDefault();
		if (!dragEl) return;
		const target = (e.target instanceof Element) ? e.target.closest('.tab') : null;
		if (!target || target === dragEl) { if (indicator) indicator.remove(); return; }
		const rect = target.getBoundingClientRect();
		const after = (e.clientX - rect.left) > rect.width / 2;
		const ind = ensureIndicator();
		ind.remove();
		if (after) target.after(ind); else target.before(ind);
	});
	tabsEl.addEventListener('drop', (e) => {
		e.preventDefault();
		if (!dragEl) return;
		const target = (e.target instanceof Element) ? e.target.closest('.tab') : null;
		if (!target || target === dragEl) return;
		const rect = target.getBoundingClientRect();
		const after = (e.clientX - rect.left) > rect.width / 2;
		if (after) target.after(dragEl); else target.before(dragEl);
		if (indicator) { indicator.remove(); indicator = null; }
		// Rebuild openTabs order
		const newOrder = Array.from(tabsEl.querySelectorAll('.tab')).map(el => {
			const title = el.querySelector('.title')?.textContent || '';
			return openTabs.find(t => t.title === title)?.path;
		}).filter(Boolean);
		const map = new Map(openTabs.map(t => [t.path, t]));
		openTabs = newOrder.map(p => map.get(p)).filter(Boolean);
		saveSession();
	});
}

window.addEventListener('beforeunload', () => { try { saveSession(true); } catch {} });

// Context menu for tabs
function showTabContextMenu(x, y, tabPath) {
	let menuEl = null;
	function destroyMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
	const items = [];
	items.push(
		{ label: 'Close', action: () => { try { if (window.__forceClosePath) window.__forceClosePath(tabPath); else domClosePath(tabPath); } catch {} } },
		{ label: 'Close Others', action: () => { try { const toClose = Array.from(document.querySelectorAll('.tabs .tab')).map(el => el?.dataset?.path).filter(Boolean).filter(p => p !== tabPath); for (const p of toClose) { if (window.__forceClosePath) window.__forceClosePath(p); else domClosePath(p); } } catch {} } },
		{ label: 'Close All', action: () => { try { window.__closeAllTabs?.(); } catch {} } },
		{ label: 'Save', action: async () => { try { window.__activateTab?.(tabPath); await window.__saveActive?.(); } catch {} } },
		{ label: 'Reveal in OS', action: () => { try { window.bridge?.revealInOS?.(tabPath); } catch {} } },
		{ label: 'Copy Path', action: () => { try { navigator.clipboard?.writeText(tabPath); } catch {} } }
	);
	// Build and show
	destroyMenu();
	menuEl = document.createElement('div');
	menuEl.className = 'context-menu';
	for (const it of items) {
		const btn = document.createElement('button');
		btn.className = 'context-item';
		btn.textContent = it.label;
		btn.addEventListener('pointerdown', (ev) => { ev.preventDefault(); ev.stopPropagation(); it.action?.(); destroyMenu(); }, true);
		menuEl.appendChild(btn);
	}
	menuEl.style.left = `${x}px`;
	menuEl.style.top = `${y}px`;
	document.body.appendChild(menuEl);
	requestAnimationFrame(() => menuEl.classList.add('show'));
	setTimeout(() => {
		const offDown = (e) => { if (!menuEl?.contains(e.target)) { destroyMenu(); document.removeEventListener('pointerdown', offDown, true); } };
		document.addEventListener('pointerdown', offDown, true);
	}, 0);
}

// Resilient closer for tab path (used by context menus)
function forceClosePath(targetPath) {
	try {
		if (typeof closeTab === 'function') { closeTab(targetPath); return; }
		if (typeof window.__closeTab === 'function') { window.__closeTab(targetPath); return; }
	} catch {}
	// Manual fallback if above are unavailable
	try {
		const idx = openTabs.findIndex(t => t.path === targetPath);
		if (idx === -1) return;
		const tab = openTabs[idx];
		
		// Add to closed stack for reopening
		const model = modelsByPath.get(targetPath);
		if (model) {
			closedStack.push({
				path: targetPath,
				content: model.getValue()
			});
		}
		
		tab._el.remove();
		openTabs.splice(idx, 1);
		console.log('openTabs after close:', openTabs.map(t => t.path));
		
		if (model) {
			model.dispose();
			modelsByPath.delete(targetPath);
		}
		if (activeTabPath === targetPath) {
			console.log('Closing active tab, switching to tab to the left or clearing editor');
			if (openTabs.length > 0) {
				// Find the tab to the left of the closed tab
				let nextTabPath = null;
				if (idx > 0) {
					// Activate the tab to the left
					nextTabPath = openTabs[idx - 1].path;
				} else if (openTabs.length > 0) {
					// If we closed the first tab, activate the new first tab
					nextTabPath = openTabs[0].path;
				}
				if (nextTabPath) { try { activateTab(nextTabPath); } catch {} }
			} else {
				activeTabPath = null;
				updateEditorEnabled();
			}
		}
		updateEmptyState();
		saveSession();
	} catch {}
}
// Expose fallback as well
window.__forceClosePath = forceClosePath;

function domClosePath(targetPath) {
	try {
		const tabEl = document.querySelector(`.tabs .tab[data-path="${CSS.escape(targetPath)}"]`);
		const btn = tabEl?.querySelector('.close');
		if (btn) { (btn).dispatchEvent(new MouseEvent('click', { bubbles: true })); return; }
	} catch {}
	try { window.__forceClosePath?.(targetPath); } catch {}
}

// Ensure xterm CSS is loaded only when needed
let __xtermCssInjected = false;
async function ensureXtermCssLoaded() {
	if (__xtermCssInjected) return true;
	try {
		const existing = document.querySelector('link[data-xterm-css="1"]');
		if (existing) { __xtermCssInjected = true; return true; }
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		// Vite dev uses /xterm, dist uses ./node_modules, raw source uses ../../node_modules
		const href = (typeof document !== 'undefined' ? (document.baseURI || window.location?.href || '') : '');
		const isViteDev = typeof window !== 'undefined' && (window.location?.port === '5173' || /localhost:5173$/.test(window.location?.host || ''));
		const isDist = /\/dist\//.test(href);
		link.href = isViteDev ? '/xterm/css/xterm.css' : (isDist ? './node_modules/xterm/css/xterm.css' : '../../node_modules/xterm/css/xterm.css');
		link.dataset.xtermCss = '1';
		return await new Promise((resolve) => {
			link.onload = () => { __xtermCssInjected = true; resolve(true); };
			link.onerror = () => { console.error('Failed to load xterm.css'); resolve(false); };
			document.head.appendChild(link);
		});
	} catch (e) {
		console.error('xterm css inject failed', e);
		return false;
	}
}



async function ensureXtermLoaded() {
	console.log('=== XTERM LOADING START ===');
	console.log('window.Terminal available:', !!window.Terminal);
	
	// Check if Terminal is already available
	if (window.Terminal) {
		console.log('✓ Terminal already available');
		return true;
	}
	
	console.log('Terminal not available, trying AMD loader...');
	
	// Try to load xterm using the AMD loader
	try {
		// Configure AMD paths for xterm
		if (window.require && window.require.config) {
			require.config({
				paths: {
					'xterm': '/xterm/lib/xterm'
			}
		});
	}

			// Load xterm using AMD
			return new Promise((resolve) => {
				require(['xterm'], (xterm) => {
					console.log('✓ xterm loaded via AMD:', xterm);
					// Make Terminal available globally
					window.Terminal = xterm.Terminal;
					window.TerminalAddon = xterm.TerminalAddon;
					resolve(true);
				}, (error) => {
					console.error('✗ AMD xterm loading failed:', error);
					resolve(false);
				});
			});
		} catch (error) {
			console.error('✗ AMD loading attempt failed:', error);
			return false;
		}
	}

	// Simplified fallback - no CDN since CSP blocks it
	async function ensureXtermLoadedWithFallback() {
		console.log('=== XTERM LOADING WITH FALLBACK ===');
		
		// Just try the local loading since CDN is blocked by CSP
		const success = await ensureXtermLoaded();
		if (success) {
			return true;
		}
		
		console.error('✗ xterm failed to load - check if xterm is properly installed');
		console.error('Trying to manually check xterm script...');
		
		// Try to manually check if the script loaded
		const scripts = Array.from(document.scripts);
		const xtermScript = scripts.find(s => s.src.includes('xterm'));
		console.log('Xterm script found:', !!xtermScript);
		if (xtermScript) {
			console.log('Xterm script src:', xtermScript.src);
			console.log('Xterm script loaded:', xtermScript.readyState);
		}
		
		return false;
	}

		// Fixed terminal initialization with improved xterm loading
		async function ensureTerminal() {
			console.log('=== TERMINAL INITIALIZATION START ===');
			
			if (!termInstance) {
				// Step 1: Ensure xterm is loaded with fallback
				console.log('Step 1: Loading xterm...');
				const xtermLoaded = await ensureXtermLoadedWithFallback();
				
				if (!xtermLoaded) {
					console.error('✗ xterm failed to load completely');
					alert('Terminal library failed to load. Please check your internet connection and refresh the page.');
					return;
				}
				console.log('✓ xterm loaded successfully');
				
				// Step 2: Check terminal element
				console.log('Step 2: Checking terminal element...');
				const terminalEl = document.getElementById('terminal');
				if (!terminalEl) {
					console.error('✗ Terminal element not found');
					return;
				}
				console.log('✓ Terminal element found');
				
				// Step 3: Check terminal panel visibility
				console.log('Step 3: Checking terminal panel...');
				const terminalPanel = document.getElementById('terminalPanel');
				if (terminalPanel?.classList.contains('hidden')) {
					console.log('Making terminal panel visible...');
					terminalPanel.classList.remove('hidden');
				}
				console.log('✓ Terminal panel visible');
				
				// Step 4: Create terminal instance
				console.log('Step 4: Creating terminal instance...');
				try {
					termInstance = new window.Terminal({
						convertEol: true,
						cursorBlink: true,
						theme: {
							background: '#0b0d12',
							foreground: '#ffffff',
							cursor: '#ffffff',
							selection: '#264f78'
						},
						fontSize: 14,
						fontFamily: 'JetBrains Mono, Fira Code, Menlo, Consolas, monospace',
						rows: 24,
						cols: 80,
						scrollback: 1000
					});
					console.log('✓ Terminal instance created');
				} catch (error) {
					console.error('✗ Failed to create terminal instance:', error);
					alert('Failed to create terminal: ' + error.message);
					return;
				}
				
				// Step 5: Open terminal in DOM
				console.log('Step 5: Opening terminal in DOM...');
				try {
					termInstance.open(terminalEl);
					console.log('✓ Terminal opened in DOM');
				} catch (error) {
					console.error('✗ Failed to open terminal:', error);
					return;
				}
				
				// Step 6: Check bridge
				console.log('Step 6: Checking bridge...');
				if (!window.bridge || !window.bridge.terminal) {
					console.error('✗ Terminal bridge not available');
					termInstance.write('Terminal bridge not available.\r\n');
					return;
				}
				console.log('✓ Terminal bridge available');
				
				// Step 7: Create terminal process
				console.log('Step 7: Creating terminal process...');
				try {
					const created = await window.bridge.terminal.create(80, 24, currentWorkspaceRoot || undefined);
					console.log('Terminal create result:', created);
					
					if (!created || !created.id) {
						console.error('✗ Terminal create failed:', created);
						termInstance.write('Failed to create terminal process.\r\n');
						return;
					}
					
					termId = created.id;
					console.log('✓ Terminal process created with ID:', termId);
				} catch (error) {
					console.error('✗ Terminal process creation failed:', error);
					termInstance.write('Terminal process creation failed: ' + error.message + '\r\n');
					return;
				}
				
				// Step 8: Set up data handlers
				console.log('Step 8: Setting up data handlers...');
				window.bridge.terminal.onData((p) => {
					if (p.id === termId && termInstance) {
						termInstance.write(p.data);
					}
				});
				
				termInstance.onData((data) => {
					if (termId && window.bridge.terminal.write) {
						window.bridge.terminal.write(termId, data);
					}
				});
				console.log('✓ Data handlers set up');
				
				// Step 9: Set up resize handling
				console.log('Step 9: Setting up resize handling...');
				const applyResize = () => {
					const el = document.getElementById('terminal');
					if (!el || !termInstance) return;
					
					const cols = Math.max(20, Math.floor(el.clientWidth / 9));
					const rows = Math.max(5, Math.floor(el.clientHeight / 18));
					
					try {
						termInstance.resize(cols, rows);
						if (window.bridge.terminal.resize && termId) {
							window.bridge.terminal.resize(termId, cols, rows);
						}
					} catch (err) {
						console.error('Resize failed:', err);
					}
				};
				
				const resizeObserver = new ResizeObserver(() => {
					setTimeout(applyResize, 100);
				});
				resizeObserver.observe(terminalEl);
				console.log('✓ Resize handling set up');
				
				// Step 10: Initial setup
				console.log('Step 10: Initial setup...');
				setTimeout(() => {
					applyResize();
					termInstance.focus();
					
					// Send initial commands to ensure prompt appears
					if (window.bridge.terminal.write) {
						window.bridge.terminal.write(termId, 'clear\r');
						setTimeout(() => {
							window.bridge.terminal.write(termId, 'echo "Terminal ready!"\r');
						}, 100);
					}
				}, 300);
				
				console.log('✓ Terminal fully initialized');
				console.log('=== TERMINAL INIT COMPLETE ===');
				
			} else {
				console.log('Terminal already exists, focusing...');
				termInstance.focus();
		}
}


// ===== TAB ENHANCEMENTS =====
if (typeof window.enhanceTabRendering === 'undefined') {
	window.enhanceTabRendering = function() {
		const tabs = document.querySelectorAll('.tab');
		tabs.forEach(tab => {
			const path = tab.dataset.path;
			if (!path) return;
			const ext = path.split('.').pop().toLowerCase();
			const langMap = {
				'js': 'javascript', 'ts': 'typescript', 'py': 'python',
				'html': 'html', 'css': 'css', 'json': 'json', 'md': 'markdown'
			};
			tab.dataset.language = langMap[ext] || 'plaintext';
			if (!tab.classList.contains('rendered')) {
				tab.classList.add('new-tab', 'rendered');
				setTimeout(() => tab.classList.remove('new-tab'), 600);
			}
		});
	};
	const tabsContainer = document.getElementById('tabs');
	if (tabsContainer) {
		const observer = new MutationObserver(() => window.enhanceTabRendering?.());
		observer.observe(tabsContainer, { childList: true, subtree: true });
	}
}
window.scrollToActiveTab = function() {
	const activeTab = document.querySelector('.tab.active');
	if (activeTab) activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
};
console.log('✨ Tab enhancements loaded');

// end of renderer.js


// ===== ENHANCED COMMAND PALETTE =====
(function() {
	let recentCommands = [];
	const MAX_RECENT = 10;

	// Load recent commands from localStorage
	function loadRecentCommands() {
		try {
			const stored = localStorage.getItem('barge:recentCommands');
			if (stored) recentCommands = JSON.parse(stored);
		} catch {}
	}

	// Save recent commands to localStorage
	function saveRecentCommands() {
		try {
			localStorage.setItem('barge:recentCommands', JSON.stringify(recentCommands.slice(0, MAX_RECENT)));
		} catch {}
	}

	// Add command to recent list
	function addToRecent(commandId) {
		recentCommands = recentCommands.filter(id => id !== commandId);
		recentCommands.unshift(commandId);
		saveRecentCommands();
	}

	// Fuzzy search algorithm
	function fuzzyMatch(pattern, str) {
		pattern = pattern.toLowerCase();
		str = str.toLowerCase();
		
		let patternIdx = 0;
		let strIdx = 0;
		let score = 0;
		let consecutiveMatches = 0;
		const matches = [];
		
		while (patternIdx < pattern.length && strIdx < str.length) {
			if (pattern[patternIdx] === str[strIdx]) {
				matches.push(strIdx);
				consecutiveMatches++;
				score += 1 + consecutiveMatches * 0.5;
				patternIdx++;
			} else {
				consecutiveMatches = 0;
			}
			strIdx++;
		}
		
		if (patternIdx !== pattern.length) return null;
		if (matches[0] === 0) score += 10;
		
		for (let i = 1; i < matches.length; i++) {
			const gap = matches[i] - matches[i - 1] - 1;
			score -= gap * 0.1;
		}
		
		return { score, matches };
	}

	window.recentCommands = recentCommands;
	window.fuzzyFilterCommands = function(commands, query) {
		if (!query) {
			const recentIds = new Set(recentCommands);
			const recent = commands.filter(cmd => recentIds.has(cmd.id));
			const others = commands.filter(cmd => !recentIds.has(cmd.id));
			return [...recent, ...others];
		}
		
		const results = [];
		for (const cmd of commands) {
			const titleMatch = fuzzyMatch(query, cmd.title);
			const idMatch = fuzzyMatch(query, cmd.id);
			const hintMatch = cmd.hint ? fuzzyMatch(query, cmd.hint) : null;
			const match = titleMatch || idMatch || hintMatch;
			if (match) {
				results.push({ ...cmd, score: match.score, matches: titleMatch?.matches || [] });
			}
		}
		results.sort((a, b) => b.score - a.score);
		return results;
	};

	window.highlightMatches = function(text, matches) {
		if (!matches || matches.length === 0) return text;
		let result = '';
		let lastIdx = 0;
		for (const idx of matches) {
			result += text.slice(lastIdx, idx);
			result += `<span class="cmd-match">${text[idx]}</span>`;
			lastIdx = idx + 1;
		}
		result += text.slice(lastIdx);
		return result;
	};

	const originalExecuteCmd = window.executeCmd;
	if (originalExecuteCmd) {
		window.executeCmd = function(cmd) {
			if (cmd && cmd.id) addToRecent(cmd.id);
			return originalExecuteCmd(cmd);
		};
	}

	loadRecentCommands();
	console.log('✨ Enhanced Command Palette loaded');
})();

window.getCmdIcon = function(commandId) {
	const iconMap = {
		'view:': '👁️', 'file:': '📄', 'edit:': '✏️', 'help:': '❓',
		'window:': '🪟', 'terminal:': '⌨️', 'git:': '🔀', 'search:': '🔍'
	};
	for (const [prefix, icon] of Object.entries(iconMap)) {
		if (commandId.startsWith(prefix)) return icon;
	}
	return '⚡';
};

// ===== TAB CONTEXT MENU IMPLEMENTATION =====
(function() {
	let contextMenu = null;
	let contextMenuTarget = null;

	function createContextMenu() {
		if (contextMenu) return contextMenu;
		
		contextMenu = document.createElement('div');
		contextMenu.className = 'tab-context-menu';
		contextMenu.innerHTML = `
			<div class="tab-context-item" data-action="close">
				<span class="icon">✕</span>
				<span>Close Tab</span>
			</div>
			<div class="tab-context-item" data-action="close-others">
				<span class="icon">⊗</span>
				<span>Close Other Tabs</span>
			</div>
			<div class="tab-context-item" data-action="close-right">
				<span class="icon">→</span>
				<span>Close Tabs to the Right</span>
			</div>
			<div class="tab-context-separator"></div>
			<div class="tab-context-item" data-action="copy-path">
				<span class="icon">📋</span>
				<span>Copy Path</span>
			</div>
			<div class="tab-context-item" data-action="reveal">
				<span class="icon">📂</span>
				<span>Reveal in File Tree</span>
			</div>
			<div class="tab-context-separator"></div>
			<div class="tab-context-item danger" data-action="close-all">
				<span class="icon">🗑️</span>
				<span>Close All Tabs</span>
			</div>
		`;
		
		document.body.appendChild(contextMenu);
		
		contextMenu.addEventListener('click', (e) => {
			const item = e.target.closest('.tab-context-item');
			if (!item || !contextMenuTarget) return;
			
			const action = item.dataset.action;
			const tabPath = contextMenuTarget.dataset.path;
			
			handleContextAction(action, tabPath);
			hideContextMenu();
		});
		
		document.addEventListener('click', (e) => {
			if (!contextMenu.contains(e.target) && !e.target.closest('.tab')) {
				hideContextMenu();
			}
		});
		
		return contextMenu;
	}

	function showContextMenu(e, tab) {
		e.preventDefault();
		
		const menu = createContextMenu();
		contextMenuTarget = tab;
		
		const x = Math.min(e.clientX, window.innerWidth - 240);
		const y = Math.min(e.clientY, window.innerHeight - 300);
		
		menu.style.left = x + 'px';
		menu.style.top = y + 'px';
		menu.classList.add('visible');
	}

	function hideContextMenu() {
		if (contextMenu) {
			contextMenu.classList.remove('visible');
		}
		contextMenuTarget = null;
	}

	function handleContextAction(action, tabPath) {
		// Create a snapshot to avoid mutation issues
		const openTabs = window.openTabs ? [...window.openTabs] : [];
		console.log('[Context Menu] Action:', action, 'TabPath:', tabPath, 'OpenTabs:', openTabs.length);
		console.log('[Context Menu] window.__closeTab available?', !!window.__closeTab);
		console.log('[Context Menu] window.__closeAllTabs available?', !!window.__closeAllTabs);
		
		switch (action) {
			case 'close':
				console.log('[Context Menu] Closing single tab:', tabPath);
				if (window.__closeTab) {
					window.__closeTab(tabPath);
				} else {
					console.error('[Context Menu] window.__closeTab not found!');
				}
				break;
				
			case 'close-others':
				const othersToClose = openTabs.filter(tab => tab.path !== tabPath);
				console.log('[Context Menu] Close others - found', othersToClose.length, 'tabs');
				if (othersToClose.length > 0 && confirm(`Close ${othersToClose.length} other tabs?`)) {
					console.log('[Context Menu] User confirmed, closing...');
					othersToClose.forEach(tab => {
						console.log('[Context Menu] Closing tab:', tab.path);
						if (window.__closeTab) {
							window.__closeTab(tab.path);
						}
					});
					console.log('[Context Menu] Close others complete');
				}
				break;
				
			case 'close-right':
				const idx = openTabs.findIndex(t => t.path === tabPath);
				console.log('[Context Menu] Current tab index:', idx, 'of', openTabs.length);
				if (idx >= 0 && idx < openTabs.length - 1) {
					const rightTabs = openTabs.slice(idx + 1);
					console.log('[Context Menu] Tabs to right:', rightTabs.length);
					if (confirm(`Close ${rightTabs.length} tabs to the right?`)) {
						console.log('[Context Menu] User confirmed, closing right tabs...');
						rightTabs.forEach(tab => {
							console.log('[Context Menu] Closing tab:', tab.path);
							if (window.__closeTab) {
								window.__closeTab(tab.path);
							}
						});
						console.log('[Context Menu] Close right complete');
					}
				}
				break;
				
			case 'close-all':
				console.log('[Context Menu] Close all -', openTabs.length, 'tabs');
				if (openTabs.length > 0 && confirm(`Close all ${openTabs.length} tabs? Any unsaved changes will be lost.`)) {
					console.log('[Context Menu] User confirmed close all');
					if (window.__closeAllTabs) {
						console.log('[Context Menu] Using __closeAllTabs function');
						window.__closeAllTabs();
					} else {
						console.log('[Context Menu] Using fallback individual close');
						openTabs.forEach(tab => {
							console.log('[Context Menu] Closing tab:', tab.path);
							if (window.__closeTab) {
								window.__closeTab(tab.path);
							}
						});
					}
					console.log('[Context Menu] Close all complete');
				}
				break;
				
			case 'copy-path':
				if (navigator.clipboard) {
					navigator.clipboard.writeText(tabPath).then(() => {
						console.log('Path copied:', tabPath);
					}).catch(err => {
						console.error('Failed to copy path:', err);
					});
				}
				break;
				
			case 'reveal':
				const treeItem = document.querySelector(`.file-tree .item[data-path="${tabPath}"]`);
				if (treeItem) {
					treeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
					treeItem.classList.add('selected');
					setTimeout(() => {
						treeItem.style.animation = 'none';
						setTimeout(() => {
							treeItem.style.animation = 'pulse 0.5s ease-in-out 2';
						}, 10);
					}, 100);
				}
				break;
		}
	}

	// Attach context menu to tabs on load
	document.addEventListener('DOMContentLoaded', () => {
		setTimeout(() => {
			const tabsContainer = document.getElementById('tabs');
			if (tabsContainer) {
				tabsContainer.addEventListener('contextmenu', (e) => {
					const tab = e.target.closest('.tab');
					if (tab) {
						showContextMenu(e, tab);
					}
				});
			}
		}, 1000);
	});

	// Also try after Monaco is ready
	window.addEventListener('barge:monaco-ready', () => {
		const tabsContainer = document.getElementById('tabs');
		if (tabsContainer) {
			tabsContainer.addEventListener('contextmenu', (e) => {
				const tab = e.target.closest('.tab');
				if (tab) {
					showContextMenu(e, tab);
				}
			});
		}
	});

	window.showTabContextMenu = showContextMenu;
	window.hideTabContextMenu = hideContextMenu;
	
	console.log('✨ Tab Context Menu loaded');
})();

// Fix: Use document-level delegation for tab context menu

// Document-level event delegation for tab context menu (works with dynamic tabs)
document.addEventListener('contextmenu', (e) => {
	const tab = e.target.closest('.tab');
	if (tab && window.showTabContextMenu) {
		e.preventDefault();
		window.showTabContextMenu(e, tab);
	}
}, true);

console.log('✨ Tab context menu document delegation enabled');

// ===== FILE TREE CONTEXT MENU =====
(function() {
	let fileTreeContextMenu = null;
	let fileTreeContextTarget = null;

	function createFileTreeContextMenu() {
		if (fileTreeContextMenu) return fileTreeContextMenu;
		
		fileTreeContextMenu = document.createElement('div');
		fileTreeContextMenu.className = 'file-tree-context-menu';
		fileTreeContextMenu.innerHTML = `
			<div class="file-context-item" data-action="open">
				<span class="icon">📂</span>
				<span>Open</span>
			</div>
			<div class="file-context-item" data-action="rename">
				<span class="icon">✏️</span>
				<span>Rename</span>
			</div>
			<div class="file-context-item" data-action="duplicate">
				<span class="icon">📋</span>
				<span>Duplicate</span>
			</div>
			<div class="file-context-separator"></div>
			<div class="file-context-item" data-action="copy-path">
				<span class="icon">📄</span>
				<span>Copy Path</span>
			</div>
			<div class="file-context-item" data-action="copy-relative-path">
				<span class="icon">📝</span>
				<span>Copy Relative Path</span>
			</div>
			<div class="file-context-separator"></div>
			<div class="file-context-item" data-action="new-file">
				<span class="icon">➕</span>
				<span>New File</span>
			</div>
			<div class="file-context-item" data-action="new-folder">
				<span class="icon">📁</span>
				<span>New Folder</span>
			</div>
			<div class="file-context-separator"></div>
			<div class="file-context-item" data-action="reveal-in-os">
				<span class="icon">🗂️</span>
				<span>Reveal in File Manager</span>
			</div>
			<div class="file-context-separator"></div>
			<div class="file-context-item danger" data-action="delete">
				<span class="icon">🗑️</span>
				<span>Delete</span>
			</div>
		`;
		
		document.body.appendChild(fileTreeContextMenu);
		
		fileTreeContextMenu.addEventListener('click', (e) => {
			const item = e.target.closest('.file-context-item');
			if (!item || !fileTreeContextTarget) return;
			
			const action = item.dataset.action;
			const itemPath = fileTreeContextTarget.dataset.path;
			const itemType = fileTreeContextTarget.dataset.type;
			
			handleFileTreeContextAction(action, itemPath, itemType);
			hideFileTreeContextMenu();
		});
		
		document.addEventListener('click', (e) => {
			if (!fileTreeContextMenu.contains(e.target) && !e.target.closest('.file-tree .item')) {
				hideFileTreeContextMenu();
			}
		});
		
		return fileTreeContextMenu;
	}

	function showFileTreeContextMenu(e, item) {
		e.preventDefault();
		
		const menu = createFileTreeContextMenu();
		fileTreeContextTarget = item;
		
		// Adjust menu items based on file type
		const isDirectory = item.dataset.type === 'dir';
		const openItem = menu.querySelector('[data-action="open"]');
		if (openItem) {
			openItem.innerHTML = isDirectory 
				? '<span class="icon">📂</span><span>Expand/Collapse</span>'
				: '<span class="icon">📄</span><span>Open</span>';
		}
		
		const x = Math.min(e.clientX, window.innerWidth - 240);
		const y = Math.min(e.clientY, window.innerHeight - 450);
		
		menu.style.left = x + 'px';
		menu.style.top = y + 'px';
		menu.classList.add('visible');
	}

	function hideFileTreeContextMenu() {
		if (fileTreeContextMenu) {
			fileTreeContextMenu.classList.remove('visible');
		}
		fileTreeContextTarget = null;
	}

	function handleFileTreeContextAction(action, itemPath, itemType) {
		console.log('[File Tree Context] Action:', action, 'Path:', itemPath, 'Type:', itemType);
		
		switch (action) {
			case 'open':
				console.log('[File Tree Context] Opening:', itemPath);
				if (itemType === 'file') {
					// Open file in editor
					if (window.bridge && window.bridge.readFileByPath) {
						window.bridge.readFileByPath(itemPath).then(file => {
							if (file && file.content !== undefined && window.bargeOpenFileInTab) {
								window.bargeOpenFileInTab(itemPath, file.content);
							}
						});
					}
				} else {
					// Toggle folder
					fileTreeContextTarget?.click();
				}
				break;
				
			case 'rename':
				console.log('[File Tree Context] Rename:', itemPath);
				const currentName = itemPath.split('/').pop();
				showPromptDialog('Enter new name:', currentName).then(newName => {
					if (newName && newName !== currentName && window.bridge && window.bridge.renamePath) {
						window.bridge.renamePath({ oldPath: itemPath, newName }).then(() => {
							console.log('Renamed to:', newName);
						}).catch(err => {
							console.error('Rename failed:', err);
							alert('Failed to rename: ' + err.message);
						});
					}
				});
				break;
				
			case 'duplicate':
				console.log('[File Tree Context] Duplicate:', itemPath);
				const baseName = itemPath.split('/').pop();
				const dirPath = itemPath.substring(0, itemPath.lastIndexOf('/'));
				const ext = baseName.includes('.') ? baseName.substring(baseName.lastIndexOf('.')) : '';
				const nameWithoutExt = baseName.includes('.') ? baseName.substring(0, baseName.lastIndexOf('.')) : baseName;
				showPromptDialog('Enter name for duplicate:', nameWithoutExt + '_copy' + ext).then(copyName => {
					if (copyName && window.bridge) {
						// Read original file and write to new location
						window.bridge.readFileByPath(itemPath).then(file => {
							if (file && file.content !== undefined) {
								return window.bridge.writeFileByPath({ 
									filePath: dirPath + '/' + copyName, 
									content: file.content 
								});
							}
						}).then(() => {
							console.log('Duplicated to:', dirPath + '/' + copyName);
						}).catch(err => {
							console.error('Duplicate failed:', err);
							alert('Failed to duplicate: ' + err.message);
						});
					}
				});
				break;
				
			case 'copy-path':
				console.log('[File Tree Context] Copy path:', itemPath);
				if (navigator.clipboard) {
					navigator.clipboard.writeText(itemPath).then(() => {
						console.log('Path copied successfully');
					}).catch(err => {
						console.error('Failed to copy path:', err);
					});
				}
				break;
				
			case 'copy-relative-path':
				console.log('[File Tree Context] Copy relative path:', itemPath);
				const workspaceRoot = window.currentWorkspaceRoot || '';
				const relativePath = itemPath.replace(workspaceRoot + '/', '');
				if (navigator.clipboard) {
					navigator.clipboard.writeText(relativePath).then(() => {
						console.log('Relative path copied:', relativePath);
					}).catch(err => {
						console.error('Failed to copy relative path:', err);
					});
				}
				break;
				
			case 'new-file':
				console.log('[File Tree Context] New file in:', itemPath);
				const isDir = itemType === 'dir';
				const targetDir = isDir ? itemPath : itemPath.substring(0, itemPath.lastIndexOf('/'));
				if (window.createFileFlow) {
					window.createFileFlow(targetDir);
				} else if (document.getElementById('sidebarNewFile')) {
					document.getElementById('sidebarNewFile').click();
				}
				break;
				
			case 'new-folder':
				console.log('[File Tree Context] New folder in:', itemPath);
				if (window.createFolderFlow) {
					window.createFolderFlow();
				}
				break;
				
			case 'reveal-in-os':
				console.log('[File Tree Context] Reveal in OS:', itemPath);
				if (window.bridge && window.bridge.revealInOS) {
					window.bridge.revealInOS(itemPath);
				}
				break;
				
			case 'delete':
				console.log('[File Tree Context] Delete:', itemPath);
				const fileName = itemPath.split('/').pop();
				showConfirmDialog(`Delete "${fileName}"? This action cannot be undone.`).then(confirmed => {
					if (confirmed && window.bridge && window.bridge.deletePath) {
						window.bridge.deletePath({ target: itemPath }).then(() => {
							console.log('Deleted:', itemPath);
						}).catch(err => {
							console.error('Delete failed:', err);
							alert('Failed to delete: ' + err.message);
						});
					}
				});
				break;
				
			default:
				console.warn('[File Tree Context] Unknown action:', action);
		}
	}

	// Document-level event delegation for file tree context menu
	document.addEventListener('contextmenu', (e) => {
		const treeItem = e.target.closest('.file-tree .item');
		if (treeItem && treeItem.dataset.path) {
			e.preventDefault();
			showFileTreeContextMenu(e, treeItem);
		}
	}, true);

	window.showFileTreeContextMenu = showFileTreeContextMenu;
	window.hideFileTreeContextMenu = hideFileTreeContextMenu;
	
	console.log('✨ File Tree Context Menu loaded');
})();

// ===== MULTI-FILE SEARCH =====
(function() {
	let searchPanel = null;
	let searchResults = [];
	
	function createSearchPanel() {
		if (searchPanel) return;
		
		searchPanel = document.createElement('div');
		searchPanel.id = 'searchPanel';
		searchPanel.className = 'modal hidden';
		searchPanel.setAttribute('role', 'dialog');
		searchPanel.setAttribute('aria-modal', 'true');
		searchPanel.innerHTML = `
			<div class="modal-backdrop"></div>
			<div class="modal-card">
				<div class="modal-header"><h3>Search in Files</h3></div>
				<div class="modal-body">
					<div class="search-panel">
						<div class="search-header">
							<input type="text" id="searchQuery" placeholder="Search in files..." />
							<label><input type="checkbox" id="searchRegex" /> Regex</label>
							<label><input type="checkbox" id="searchCase" /> Match Case</label>
							<button id="searchClose" title="Close">✕</button>
						</div>
						<div class="search-results" id="searchResults"></div>
					</div>
				</div>
			</div>
		`;
		document.body.appendChild(searchPanel);

		// Wire up events
		const queryEl = searchPanel.querySelector('#searchQuery');
		const closeEl = searchPanel.querySelector('#searchClose');
		// Use debounced search for better performance
		const debouncedSearch = debounce(() => {
			if (window.performSearch) window.performSearch();
		}, 300);
		if (queryEl) queryEl.addEventListener('input', debouncedSearch);
		if (closeEl) closeEl.addEventListener('click', hideSearch);
	}
	
	
	async function performSearch() {
		const query = document.getElementById('searchQuery').value;
		if (!query) return;
		
		const isRegex = document.getElementById('searchRegex').checked;
		const caseSensitive = document.getElementById('searchCase').checked;
		
		// Search implementation
		console.log('Searching:', query, { isRegex, caseSensitive });
	}
	
	function showSearch() {
		createSearchPanel();
		searchPanel.classList.remove('hidden');
		try { searchPanel.querySelector('#searchQuery')?.focus(); } catch {}
	}
	
	function hideSearch() {
		if (searchPanel) searchPanel.classList.add('hidden');
	}
	
	window.showSearch = showSearch;
	window.hideSearch = hideSearch;
})();

// ===== ZEN MODE & FOCUS MODE =====
(function() {
	let zenMode = false;
	let focusMode = false;
	
	function toggleZenMode() {
		zenMode = !zenMode;
		document.body.classList.toggle('zen-mode', zenMode);
		console.log('Zen mode:', zenMode);
	}
	
	function toggleFocusMode() {
		focusMode = !focusMode;
		document.body.classList.toggle('focus-mode', focusMode);
		console.log('Focus mode:', focusMode);
	}
	
	// Keyboard shortcuts
	document.addEventListener('keydown', (e) => {
		if (e.ctrlKey && e.shiftKey && e.key === 'F') {
			e.preventDefault();
			showSearch();
		}
		if (e.ctrlKey && e.key === 'k' && e.shiftKey) {
			e.preventDefault();
			toggleZenMode();
		}
	});
	
	window.toggleZenMode = toggleZenMode;
	window.toggleFocusMode = toggleFocusMode;
	
	console.log('✨ Search, Zen, Focus modes loaded');
})();

// Enhanced Multi-File Search with real functionality
window.performSearch = async function() {
	const query = document.getElementById('searchQuery')?.value;
	const resultsDiv = document.getElementById('searchResults');
	if (!query || !resultsDiv) return;
	resultsDiv.innerHTML = '<div class="search-empty">🔍 Searching...</div>';
	const isRegex = document.getElementById('searchRegex')?.checked;
	const caseSensitive = document.getElementById('searchCase')?.checked;
	try {
		const tabs = window.openTabs || [];
		const results = [];
		for (const tab of tabs) {
			if (!tab.path) continue;
			const file = await window.bridge?.readFileByPath(tab.path);
			if (!file || !file.content) continue;
			const lines = file.content.split('\n');
			lines.forEach((line, index) => {
				const matches = caseSensitive ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase());
				if (matches) {
					results.push({ file: tab.path, fileName: tab.path.split('/').pop(), line: index + 1, content: line.trim().substring(0, 100) });
				}
			});
		}
		if (results.length === 0) {
			resultsDiv.innerHTML = '<div class="search-empty">❌ No results found</div>';
		} else {
			resultsDiv.innerHTML = results.map(r => `<div class="search-result-item" data-file="${r.file}" data-line="${r.line}"><div class="search-result-file">📄 ${r.fileName}</div><div class="search-result-line">Line ${r.line}: ${r.content}</div></div>`).join('');
			document.querySelectorAll('.search-result-item').forEach(el => {
				el.addEventListener('click', async function() {
					const file = await window.bridge?.readFileByPath(this.dataset.file);
					if (file && window.bargeOpenFileInTab) {
						window.bargeOpenFileInTab(this.dataset.file, file.content);
						setTimeout(() => {
							if (window.editor) {
								const line = parseInt(this.dataset.line);
								window.editor.revealLineInCenter(line);
								window.editor.setPosition({ lineNumber: line, column: 1 });
							}
						}, 100);
					}
					window.hideSearch?.();
				});
			});
		}
	} catch (err) {
		console.error('Search error:', err);
		resultsDiv.innerHTML = '<div class="search-empty">⚠️ Error searching files</div>';
	}
};
console.log('✨ Multi-file search ready');

// Custom prompt dialog for Electron
function showPromptDialog(message, defaultValue = '') {
	return new Promise((resolve) => {
		const overlay = document.createElement('div');
		overlay.className = 'prompt-overlay';
		overlay.innerHTML = `
			<div class="prompt-dialog">
				<div class="prompt-message">${message}</div>
				<input type="text" class="prompt-input" value="${defaultValue}" />
				<div class="prompt-buttons">
					<button class="prompt-cancel">Cancel</button>
					<button class="prompt-ok">OK</button>
				</div>
			</div>
		`;
		document.body.appendChild(overlay);
		
		const input = overlay.querySelector('.prompt-input');
		const okBtn = overlay.querySelector('.prompt-ok');
		const cancelBtn = overlay.querySelector('.prompt-cancel');
		
		input.focus();
		input.select();
		
		const cleanup = (value) => {
			document.body.removeChild(overlay);
			resolve(value);
		};
		
		okBtn.onclick = () => cleanup(input.value);
		cancelBtn.onclick = () => cleanup(null);
		input.onkeydown = (e) => {
			if (e.key === 'Enter') cleanup(input.value);
			if (e.key === 'Escape') cleanup(null);
		};
	});
}

window.showPromptDialog = showPromptDialog;


// Custom confirm dialog for Electron  
function showConfirmDialog(message) {
	return new Promise((resolve) => {
		const overlay = document.createElement('div');
		overlay.className = 'prompt-overlay';
		overlay.innerHTML = `
			<div class="prompt-dialog">
				<div class="prompt-message">${message}</div>
				<div class="prompt-buttons">
					<button class="prompt-cancel">Cancel</button>
					<button class="prompt-ok danger">Delete</button>
				</div>
			</div>
		`;
		document.body.appendChild(overlay);
		
		const okBtn = overlay.querySelector('.prompt-ok');
		const cancelBtn = overlay.querySelector('.prompt-cancel');
		
		const cleanup = (value) => {
			document.body.removeChild(overlay);
			resolve(value);
		};
		
		okBtn.onclick = () => cleanup(true);
		cancelBtn.onclick = () => cleanup(false);
		overlay.onkeydown = (e) => {
			if (e.key === 'Escape') cleanup(false);
		};
		
		cancelBtn.focus();
	});
}

window.showConfirmDialog = showConfirmDialog;
