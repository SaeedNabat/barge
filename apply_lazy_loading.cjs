const fs = require('fs');

// Read the original renderer.js
let content = fs.readFileSync('src/renderer/renderer.js', 'utf8');

// Add lazy loading variables and functions after line 125
const lazyLoadingCode = `
// Lazy loading variables and functions for Monaco Editor
let monacoLoading = false;
let monacoLoaded = false;

async function loadMonacoEditor() {
	if (monacoLoaded || monacoLoading) return;
	monacoLoading = true;
	console.log("Loading Monaco editor...");
	
	// Show loading indicator
	const editorContainer = document.getElementById("editor");
	if (editorContainer) {
		editorContainer.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted, #666);">Loading editor...</div>';
	}
	
	try {
		await new Promise((resolve, reject) => {
			require(["vs/editor/editor.main"], resolve, reject);
		});
		
		monacoRef = window.monaco;
		monacoLoaded = true;
		monacoLoading = false;
		console.log("Monaco editor loaded successfully");
		
		// Initialize editor after Monaco is loaded
		await initializeMonacoEditor();
		
		// Dispatch Monaco ready event
		window.dispatchEvent(new Event('barge:monaco-ready'));
	} catch (error) {
		console.error("Failed to load Monaco editor:", error);
		monacoLoading = false;
		if (editorContainer) {
			editorContainer.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--error-color, #dc2626);">Failed to load editor</div>';
		}
	}
}

async function initializeMonacoEditor() {
	if (!monacoRef) return;
	console.log("Initializing Monaco editor...");
	
	// Move the Monaco initialization code here from the original require callback
	// This will be populated with the actual initialization code
}
`;

// Insert the lazy loading code after line 125 (the variable declarations)
const lines = content.split('\n');
const variableDeclarationLineIndex = lines.findIndex(line => 
	line.includes('let untitledCounter = 1; let termInstance = null;')
);

if (variableDeclarationLineIndex !== -1) {
	// Insert lazy loading code after the variable declaration line
	lines.splice(variableDeclarationLineIndex + 1, 0, lazyLoadingCode);
	console.log('Added lazy loading code after variable declarations');
} else {
	console.error('Could not find variable declaration line');
	process.exit(1);
}

// Write the modified content back to file
fs.writeFileSync('src/renderer/renderer_with_lazy_applied.js', lines.join('\n'));
console.log('Created renderer_with_lazy_applied.js with lazy loading code');
