const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/renderer/renderer_lazy_implemented.js', 'utf8');

// Remove the automatic Monaco initialization block
// It starts with "if (!window.__MONACO_BOOT__)" and ends with the corresponding "});"
const lines = content.split('\n');
const startIndex = lines.findIndex(line => line.includes('if (!window.__MONACO_BOOT__)'));
const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === '});');

if (startIndex === -1 || endIndex === -1) {
	console.error('Could not find Monaco boot block to remove');
	console.log('startIndex:', startIndex, 'endIndex:', endIndex);
	process.exit(1);
}

console.log(`Removing Monaco auto-initialization block from line ${startIndex + 1} to ${endIndex + 1}`);

// Remove the entire block
lines.splice(startIndex - 1, endIndex - startIndex + 2); // -1 for the comment line before, +2 to include both start and end lines

// Join the lines back together
content = lines.join('\n');

// Write the updated content
fs.writeFileSync('src/renderer/renderer_lazy_implemented.js', content);
console.log('Successfully removed automatic Monaco initialization block');
