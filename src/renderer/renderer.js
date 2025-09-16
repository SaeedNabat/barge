require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });

let monacoRef = null;
let editor = null;
let openTabs = [];
let activeTabPath = null;

require(['vs/editor/editor.main'], function () {
	monacoRef = window.monaco;
	const editorContainer = document.getElementById('editor');
	const openBtn = document.getElementById('openBtn');
	const saveBtn = document.getElementById('saveBtn');
	const filenameEl = document.getElementById('filename');
	const openFolderBtn = document.getElementById('openFolderBtn');
	const fileTreeEl = document.getElementById('fileTree');
	const tabsEl = document.getElementById('tabs');
	const cursorPosEl = document.getElementById('cursorPos');
	const langEl = document.getElementById('lang');

	monacoRef.editor.defineTheme('barge-dark', {
		base: 'vs-dark',
		inherit: true,
		rules: [],
		colors: {
			'editor.background': '#0f1115',
			'editor.lineHighlightBackground': '#151a24',
			'editorLineNumber.foreground': '#3a4256',
			'editorCursor.foreground': '#9cdcfe',
			'editor.selectionBackground': '#264f78aa',
		},
	});

	editor = monacoRef.editor.create(editorContainer, {
		value: '// New file\n',
		language: 'javascript',
		theme: 'barge-dark',
		automaticLayout: true,
		minimap: { enabled: true },
	});

	window.__EDITOR_GET_VALUE__ = () => editor.getValue();

	editor.onDidChangeCursorPosition(() => updateStatus());
	editor.onDidChangeModelContent(() => markDirty(activeTabPath, true));

	openBtn.addEventListener('click', async () => {
		const result = await window.bridge?.openFile?.();
		if (!result) return;
		openFileInTab(result.filePath, result.content);
	});

	saveBtn.addEventListener('click', async () => {
		const content = editor.getValue();
		const result = await window.bridge?.saveAs?.(content);
		if (result?.filePath) filenameEl.textContent = result.filePath;
	});

	openFolderBtn.addEventListener('click', async () => {
		const payload = await window.bridge?.openFolder?.();
		if (payload) renderTree(payload.root, payload.tree);
	});

	window.bridge?.onFolderOpened?.((payload) => renderTree(payload.root, payload.tree));
	window.bridge?.onFileOpened?.((payload) => openFileInTab(payload.filePath, payload.content));

	const buffered = window.bridge?.getLastOpened?.();
	if (buffered) openFileInTab(buffered.filePath, buffered.content);

	loadExtensions();

	function renderTree(root, tree) {
		fileTreeEl.innerHTML = '';
		const rootEl = document.createElement('div');
		rootEl.className = 'item';
		rootEl.textContent = root;
		fileTreeEl.appendChild(rootEl);
		const children = document.createElement('div');
		children.className = 'children';
		fileTreeEl.appendChild(children);
		for (const node of tree) children.appendChild(renderNode(node));
	}

	function iconSvg(kind) {
		if (kind === 'dir') return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="#8aa2c4"/></svg>';
		return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="5" y="3" width="14" height="18" rx="2" ry="2" stroke="#9aa4b2"/><line x1="8" y1="8" x2="16" y2="8" stroke="#9aa4b2"/><line x1="8" y1="12" x2="16" y2="12" stroke="#9aa4b2"/></svg>';
	}

	function renderNode(node) {
		const el = document.createElement('div');
		el.className = 'item';
		el.innerHTML = `${iconSvg(node.type)} <span>${node.name}</span>`;
		if (node.type === 'file') {
			el.addEventListener('click', async () => {
				const res = await window.bridge.readFileByPath(node.path);
				openFileInTab(node.path, res?.content ?? '');
			});
		} else if (node.type === 'dir') {
			const children = document.createElement('div');
			children.className = 'children';
			let expanded = false;
			el.addEventListener('click', () => {
				expanded = !expanded;
				children.style.display = expanded ? 'block' : 'none';
			});
			for (const child of node.children) children.appendChild(renderNode(child));
			children.style.display = 'none';
			const wrap = document.createElement('div');
			wrap.appendChild(el);
			wrap.appendChild(children);
			return wrap;
		}
		return el;
	}

	function openFileInTab(filePath, content) {
		let tab = openTabs.find(t => t.path === filePath);
		if (!tab) {
			tab = { path: filePath, title: basename(filePath), dirty: false };
			openTabs.push(tab);
			const tabEl = document.createElement('div');
			tabEl.className = 'tab';
			const titleEl = document.createElement('div');
			titleEl.className = 'title';
			titleEl.textContent = tab.title;
			const closeEl = document.createElement('div');
			closeEl.className = 'close';
			closeEl.textContent = '×';
			closeEl.addEventListener('click', (e) => {
				e.stopPropagation();
				closeTab(filePath);
			});
			tabEl.appendChild(titleEl);
			tabEl.appendChild(closeEl);
			tabEl.addEventListener('click', () => activateTab(filePath));
			tab._el = tabEl;
			tab._titleEl = titleEl;
			tabsEl.appendChild(tabEl);
		}
		activateTab(filePath);
		editor.setValue(content);
		filenameEl.textContent = filePath;
		monacoRef.editor.setModelLanguage(editor.getModel(), guessLanguage(filePath));
		langEl.textContent = guessLanguage(filePath);
		markDirty(filePath, false);
		updateStatus();
	}

	function activateTab(filePath) {
		activeTabPath = filePath;
		for (const t of openTabs) t._el.classList.toggle('active', t.path === filePath);
	}

	function markDirty(filePath, isDirty) {
		if (!filePath) return;
		const tab = openTabs.find(t => t.path === filePath);
		if (!tab) return;
		tab.dirty = isDirty;
		tab._titleEl.textContent = tab.title + (isDirty ? ' •' : '');
	}

	function closeTab(filePath) {
		const idx = openTabs.findIndex(t => t.path === filePath);
		if (idx === -1) return;
		const tab = openTabs[idx];
		if (tab.dirty) {
			const ok = confirm(`${tab.title} has unsaved changes. Close anyway?`);
			if (!ok) return;
		}
		tab._el.remove();
		openTabs.splice(idx, 1);
		if (activeTabPath === filePath) {
			const next = openTabs[idx] || openTabs[idx - 1];
			if (next) {
				activateTab(next.path);
				window.bridge.readFileByPath(next.path).then((res) => {
					editor.setValue(res?.content ?? '');
					filenameEl.textContent = next.path;
					monacoRef.editor.setModelLanguage(editor.getModel(), guessLanguage(next.path));
					langEl.textContent = guessLanguage(next.path);
					markDirty(next.path, next.dirty);
					updateStatus();
				});
			} else {
				editor.setValue('');
				filenameEl.textContent = '';
				activeTabPath = null;
				updateStatus();
			}
		}
	}

	function updateStatus() {
		const pos = editor.getPosition();
		if (!pos) return;
		cursorPosEl.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
	}

	function guessLanguage(filePath) {
		const ext = (filePath.split('.').pop() || '').toLowerCase();
		const map = { js: 'javascript', ts: 'typescript', json: 'json', css: 'css', html: 'html', md: 'markdown', py: 'python', java: 'java', c: 'c', cpp: 'cpp', rs: 'rust', go: 'go', sh: 'shell', yml: 'yaml', yaml: 'yaml' };
		return map[ext] || 'plaintext';
	}

	function basename(p) { return p.split('/').pop(); }

	async function loadExtensions() {
		try {
			const list = await window.bridge.listExtensions();
			for (const ext of list) {
				try {
					const mod = await import(ext.mainUrl);
					await mod.activate?.({
						editor,
						monaco: monacoRef,
						commands: {
							register: window.bridge.registerCommand,
							execute: window.bridge.executeCommand,
						},
						api: {
							openFileInTab,
						},
					});
				} catch (e) {
					console.error('Extension failed', ext, e);
				}
			}
		} catch (e) {
			console.error('Extensions load failed', e);
		}
	}
}); 