const fs = require('fs');

// Read the complete implementation from renderer_lazy_temp.js
const tempContent = fs.readFileSync('src/renderer/renderer_lazy_temp.js', 'utf8');

// Extract the complete initializeMonacoEditor function
const tempLines = tempContent.split('\n');
const initStartIndex = tempLines.findIndex(line => line.includes('async function initializeMonacoEditor()'));
const initEndIndex = tempLines.findIndex((line, index) => index > initStartIndex && line.trim() === '}');

if (initStartIndex === -1 || initEndIndex === -1) {
	console.error('Could not find complete initializeMonacoEditor function');
	process.exit(1);
}

const completeInitFunction = tempLines.slice(initStartIndex, initEndIndex + 1).join('\n');

// Read the implementation file
let content = fs.readFileSync('src/renderer/renderer_lazy_implemented.js', 'utf8');

// Replace the incomplete initializeMonacoEditor function
const oldInitPattern = /async function initializeMonacoEditor\(\) \{[\s\S]*?\/\/ that is currently in the require callback around line 2105[\s\S]*?console\.log\("Initializing Monaco editor\.\.\."\);[\s\S]*?\}/;

if (oldInitPattern.test(content)) {
	content = content.replace(oldInitPattern, completeInitFunction);
	console.log('Successfully replaced initializeMonacoEditor function with complete implementation');
} else {
	console.log('Pattern not found, trying simpler approach...');
	// Try a simpler replacement
	const simplePattern = /async function initializeMonacoEditor\(\) \{[\s\S]*?\n\}/;
	if (simplePattern.test(content)) {
		content = content.replace(simplePattern, completeInitFunction);
		console.log('Successfully replaced initializeMonacoEditor function (simple pattern)');
	} else {
		console.error('Could not find initializeMonacoEditor function to replace');
		process.exit(1);
	}
}

// Write the updated content
fs.writeFileSync('src/renderer/renderer_lazy_implemented.js', content);
console.log('Updated renderer_lazy_implemented.js with complete Monaco initialization');
