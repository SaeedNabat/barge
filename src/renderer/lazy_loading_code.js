
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
	
	// This function will be filled with the Monaco initialization code
	// that is currently in the require callback around line 2105
	console.log("Initializing Monaco editor...");
}

