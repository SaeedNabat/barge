const fs = require('fs');

// Read the file with lazy loading code added
let content = fs.readFileSync('src/renderer/renderer_with_lazy_applied.js', 'utf8');

// Replace the openFileInTab function to make it async and call loadMonacoEditor
const oldPattern = /function openFileInTab\(filePath, content\) \{(\s*)\/\/ open file in tab(\s*)const model = getOrCreateModel\(filePath, content\);/;

const newReplacement = `async function openFileInTab(filePath, content) {
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

if (oldPattern.test(content)) {
	content = content.replace(oldPattern, newReplacement);
	console.log('Successfully updated openFileInTab function to be async and load Monaco');
} else {
	console.log('Pattern not found, checking exact format...');
	// Let's find the function and see its exact format
	const lines = content.split('\n');
	const functionLineIndex = lines.findIndex(line => line.includes('function openFileInTab(filePath, content)'));
	if (functionLineIndex !== -1) {
		console.log('Found function at line:', functionLineIndex + 1);
		console.log('Context:');
		for (let i = Math.max(0, functionLineIndex - 2); i < Math.min(lines.length, functionLineIndex + 5); i++) {
			console.log(`${i + 1}: ${lines[i]}`);
		}
	}
}

// Write the updated content
fs.writeFileSync('src/renderer/renderer_with_lazy_applied.js', content);
