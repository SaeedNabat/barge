const fs = require('fs');

// Read the file with lazy loading code added
let content = fs.readFileSync('src/renderer/renderer_with_lazy_applied.js', 'utf8');

// Replace the openFileInTab function to make it async and call loadMonacoEditor
const oldOpenFileInTab = `function openFileInTab(filePath, content) {
		// open file in tab
	const model = getOrCreateModel(filePath, content);`;

const newOpenFileInTab = `async function openFileInTab(filePath, content) {
		// Ensure Monaco is loaded before opening file
		if (!monacoLoaded) {
			await loadMonacoEditor();
			if (!monacoLoaded) {
				console.error("Failed to load Monaco editor");
				return;
			}
		}
		// open file in tab
	const model = getOrCreateModel(filePath, content);`;

content = content.replace(oldOpenFileInTab, newOpenFileInTab);

// Write the updated content
fs.writeFileSync('src/renderer/renderer_with_lazy_applied.js', content);
console.log('Updated openFileInTab function to be async and load Monaco');
