// Ensure Monaco AMD config only runs once
if (!window.__MONACO_CONFIGURED__) {
	window.__MONACO_CONFIGURED__ = true;
	if (window.require && window.require.config) {
		const monacoBase = new URL('../../node_modules/monaco-editor/min/', document.baseURI).toString();
		require.config({ 
			paths: { vs: monacoBase + 'vs' },
			// Optimize worker loading - only load necessary workers
			'vs/editor/editor.worker': monacoBase + 'vs/editor/editor.worker.js',
			'vs/language/json/json.worker': monacoBase + 'vs/language/json/json.worker.js',
			'vs/language/css/css.worker': monacoBase + 'vs/language/css/css.worker.js',
			'vs/language/html/html.worker': monacoBase + 'vs/language/html/html.worker.js',
			'vs/language/typescript/ts.worker': monacoBase + 'vs/language/typescript/ts.worker.js'
		});
	}
	
	// Optimized worker environment - only create workers when needed
	window.MonacoEnvironment = {
		baseUrl: new URL('../../node_modules/monaco-editor/min/', document.baseURI).toString(),
		getWorkerUrl: function (moduleId, label) {
			// Only load workers for languages that are actually used
			const usedWorkers = {
				'editorWorkerService': 'vs/editor/editor.worker.js',
				'json': 'vs/language/json/json.worker.js',
				'css': 'vs/language/css/css.worker.js',
				'html': 'vs/language/html/html.worker.js',
				'typescript': 'vs/language/typescript/ts.worker.js',
				'javascript': 'vs/language/typescript/ts.worker.js' // JS uses TS worker
			};
			
			const workerPath = usedWorkers[label] || usedWorkers[moduleId];
			if (!workerPath) {
				console.warn('Monaco: Worker not found for', moduleId, label);
				return null; // Don't create unnecessary workers
			}
			
			const abs = new URL('../../node_modules/monaco-editor/min/', document.baseURI).toString();
			const code = `self.MonacoEnvironment = { baseUrl: '${abs}' }; importScripts('${abs}${workerPath}');`;
			const blob = new Blob([code], { type: 'text/javascript' });
			return URL.createObjectURL(blob);
		}
	};
	
	// Language pack optimization - only register languages that are used
	window.__MONACO_LANGUAGES_LOADED__ = new Set();
	window.__loadMonacoLanguage = function(languageId) {
		if (window.__MONACO_LANGUAGES_LOADED__.has(languageId)) {
			return Promise.resolve();
		}
		
		return new Promise((resolve, reject) => {
			const languageMap = {
				'javascript': 'vs/language/typescript/typescript',
				'typescript': 'vs/language/typescript/typescript',
				'json': 'vs/language/json/json',
				'html': 'vs/language/html/html',
				'css': 'vs/language/css/css',
				'python': 'vs/language/python/python',
				'java': 'vs/language/java/java',
				'csharp': 'vs/language/csharp/csharp',
				'cpp': 'vs/language/cpp/cpp',
				'c': 'vs/language/cpp/cpp',
				'go': 'vs/language/go/go',
				'rust': 'vs/language/rust/rust',
				'php': 'vs/language/php/php',
				'ruby': 'vs/language/ruby/ruby',
				'swift': 'vs/language/swift/swift',
				'kotlin': 'vs/language/kotlin/kotlin',
				'scala': 'vs/language/scala/scala',
				'xml': 'vs/language/xml/xml',
				'yaml': 'vs/language/yaml/yaml',
				'markdown': 'vs/language/markdown/markdown',
				'sql': 'vs/language/sql/sql',
				'shell': 'vs/language/shell/shell',
				'powershell': 'vs/language/powershell/powershell',
				'dockerfile': 'vs/language/dockerfile/dockerfile'
			};
			
			const modulePath = languageMap[languageId];
			if (!modulePath) {
				console.warn('Monaco: Language not supported:', languageId);
				resolve();
				return;
			}
			
			require([modulePath], function() {
				window.__MONACO_LANGUAGES_LOADED__.add(languageId);
				console.log('Monaco: Loaded language pack for', languageId);
				resolve();
			}, reject);
		});
	};
}

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

let monacoRef = null; let editor = null; let openTabs = []; let activeTabPath = null;
let editor2Instance = null; let activePane = 'left';
const modelsByPath = new Map(); const autosaveTimers = new Map();
let closedStack = [];
let currentWorkspaceRoot = null; let isOpeningFile = false; let isOpeningFolder = false;
let untitledCounter = 1; let termInstance = null; let termId = null; let selectedDirectoryPath = null; let refreshTimer = null;
