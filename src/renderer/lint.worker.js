// Lint Worker - Runs syntax checking off the main thread
// This keeps the UI responsive while linting large files

self.addEventListener('message', (e) => {
	const { type, data } = e.data;
	
	switch (type) {
		case 'LINT_JAVASCRIPT':
			lintJavaScript(data);
			break;
		case 'LINT_PYTHON':
			lintPython(data);
			break;
		case 'LINT_JSON':
			lintJSON(data);
			break;
		default:
			self.postMessage({
				type: 'LINT_COMPLETE',
				diagnostics: [],
				language: data.language
			});
	}
});

function lintJavaScript({ content, filePath }) {
	const diagnostics = [];
	const lines = content.split('\n');
	
	// Basic JavaScript linting rules
	lines.forEach((line, index) => {
		const lineNumber = index + 1;
		
		// Check for console.log
		if (line.includes('console.log') && !line.trim().startsWith('//')) {
			diagnostics.push({
				severity: 2, // Warning
				startLineNumber: lineNumber,
				startColumn: line.indexOf('console.log') + 1,
				endLineNumber: lineNumber,
				endColumn: line.indexOf('console.log') + 'console.log'.length + 1,
				message: 'Unexpected console.log statement'
			});
		}
		
		// Check for var (suggest let/const)
		const varMatch = line.match(/\bvar\s+/);
		if (varMatch && !line.trim().startsWith('//')) {
			diagnostics.push({
				severity: 2, // Warning
				startLineNumber: lineNumber,
				startColumn: varMatch.index + 1,
				endLineNumber: lineNumber,
				endColumn: varMatch.index + 3 + 1,
				message: 'Use let or const instead of var'
			});
		}
		
		// Check for == (suggest ===)
		if (line.includes('==') && !line.includes('===') && !line.includes('!==') && !line.trim().startsWith('//')) {
			const eqIndex = line.indexOf('==');
			if (line[eqIndex + 2] !== '=') {
				diagnostics.push({
					severity: 2, // Warning
					startLineNumber: lineNumber,
					startColumn: eqIndex + 1,
					endLineNumber: lineNumber,
					endColumn: eqIndex + 3,
					message: 'Use === instead of =='
				});
			}
		}
	});
	
	self.postMessage({
		type: 'LINT_COMPLETE',
		diagnostics,
		language: 'javascript',
		filePath
	});
}

function lintPython({ content, filePath }) {
	const diagnostics = [];
	const lines = content.split('\n');
	
	lines.forEach((line, index) => {
		const lineNumber = index + 1;
		
		// Check for print statements (Python 2 style without parentheses is rare but check anyway)
		// More commonly check for debugging prints
		if (line.trim().startsWith('print(') && !line.trim().startsWith('#')) {
			diagnostics.push({
				severity: 1, // Info
				startLineNumber: lineNumber,
				startColumn: line.indexOf('print') + 1,
				endLineNumber: lineNumber,
				endColumn: line.indexOf('print') + 5 + 1,
				message: 'Consider using logging instead of print'
			});
		}
		
		// Check for missing spaces around operators
		const noSpaceOps = line.match(/\w+[+\-*\/]=\w+/);
		if (noSpaceOps && !line.trim().startsWith('#')) {
			diagnostics.push({
				severity: 2, // Warning
				startLineNumber: lineNumber,
				startColumn: noSpaceOps.index + 1,
				endLineNumber: lineNumber,
				endColumn: noSpaceOps.index + noSpaceOps[0].length + 1,
				message: 'PEP 8: Add spaces around operators'
			});
		}
	});
	
	self.postMessage({
		type: 'LINT_COMPLETE',
		diagnostics,
		language: 'python',
		filePath
	});
}

function lintJSON({ content, filePath }) {
	const diagnostics = [];
	
	try {
		JSON.parse(content);
		// Valid JSON, no errors
	} catch (err) {
		// Parse error message to get line/column if possible
		const match = err.message.match(/position (\d+)/);
		let line = 1, col = 1;
		
		if (match) {
			const position = parseInt(match[1]);
			const lines = content.substring(0, position).split('\n');
			line = lines.length;
			col = lines[lines.length - 1].length + 1;
		}
		
		diagnostics.push({
			severity: 8, // Error
			startLineNumber: line,
			startColumn: col,
			endLineNumber: line,
			endColumn: col + 1,
			message: `JSON Parse Error: ${err.message}`
		});
	}
	
	self.postMessage({
		type: 'LINT_COMPLETE',
		diagnostics,
		language: 'json',
		filePath
	});
}

// Notify that worker is ready
self.postMessage({ type: 'WORKER_READY' });
