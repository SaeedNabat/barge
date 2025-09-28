const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/renderer/renderer_with_lazy_applied.js', 'utf8');

// Update the first createUntitled function (line 281) to be async and trigger Monaco loading
const oldCreateUntitled = `function createUntitled() {
	const name = \`Untitled-\${untitledCounter++}.txt\`;
	// Create a new untitled file directly without any dialog
	if (monacoRef) {
		openFileInTab(name, '');
	} else {
		window.__PENDING_OPEN__ = { filePath: name, content: '' };
		window.dispatchEvent(new Event('barge:pending-open'));
	}
}`;

const newCreateUntitled = `async function createUntitled() {
	const name = \`Untitled-\${untitledCounter++}.txt\`;
	// Create a new untitled file directly without any dialog
	// This will trigger Monaco loading if not already loaded
	await openFileInTab(name, '');
	updateEmptyState();
}`;

content = content.replace(oldCreateUntitled, newCreateUntitled);

// Write the updated content
fs.writeFileSync('src/renderer/renderer_with_lazy_applied.js', content);
console.log('Updated createUntitled function to be async and trigger Monaco loading');
