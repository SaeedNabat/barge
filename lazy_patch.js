// Patch for openFileInTab function
		async function openFileInTab(filePath, content) {
			// Ensure Monaco is loaded before opening file
			if (!monacoLoaded) {
				await loadMonacoEditor();
				if (!monacoLoaded) {
					console.error("Failed to load Monaco editor");
					return;
				}
			}
							// open file in tab
