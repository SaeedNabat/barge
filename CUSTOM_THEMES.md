# Custom Theme Guide for Barge Editor

## Overview

Barge Editor supports custom theme creation and import. You can create your own color schemes by defining a JSON theme file.

## How to Create a Custom Theme

### 1. Start with the Template

Use the `custom-theme-template.json` file in the project root as your starting point.

### 2. Theme Structure

```json
{
  "name": "Your Theme Name",
  "type": "dark",
  "colors": {
    "bg-primary": "#0f1419",
    "bg-secondary": "#1a1e2e",
    "bg-tertiary": "#13161f",
    "text-primary": "#e0e7ff",
    "text-secondary": "#9aa4b2",
    "accent-color": "#6366f1",
    "border-color": "rgba(255, 255, 255, 0.1)",
    "editor": { ... },
    "syntax": { ... }
  }
}
```

### 3. Color Properties

#### Main Colors
- **bg-primary**: Main background color (editor, main area)
- **bg-secondary**: Secondary background (sidebar, status bar)
- **bg-tertiary**: Tertiary background (darker panels)
- **text-primary**: Main text color
- **text-secondary**: Secondary text (labels, hints)
- **accent-color**: Accent color for highlights, buttons, selections
- **border-color**: Border color for UI elements

#### Editor Colors
- **background**: Editor background
- **foreground**: Editor text color
- **lineHighlight**: Current line highlight color
- **selection**: Text selection background
- **cursor**: Cursor color

#### Syntax Colors
- **keyword**: Keywords (function, const, let, etc.)
- **string**: String literals
- **comment**: Comments
- **function**: Function names
- **variable**: Variable names
- **number**: Number literals
- **operator**: Operators (+, -, *, etc.)

## How to Import a Custom Theme

### Method 1: Via Preferences
1. Open **Edit → Preferences**
2. Scroll to the bottom
3. Click **Import Custom Theme (JSON)**
4. Select your JSON theme file
5. The theme will be saved to localStorage

### Method 2: Via File
1. Place your theme JSON file in a known location
2. Follow Method 1 to import it

## Example Themes

### Cyberpunk Theme
```json
{
  "name": "Cyberpunk Neon",
  "type": "dark",
  "colors": {
    "bg-primary": "#0a0e27",
    "bg-secondary": "#16213e",
    "bg-tertiary": "#0f1624",
    "text-primary": "#00f5ff",
    "text-secondary": "#8892b0",
    "accent-color": "#ff006e",
    "border-color": "rgba(255, 0, 110, 0.2)",
    "editor": {
      "background": "#0a0e27",
      "foreground": "#00f5ff",
      "lineHighlight": "rgba(255, 0, 110, 0.1)",
      "selection": "rgba(0, 245, 255, 0.2)",
      "cursor": "#ff006e"
    },
    "syntax": {
      "keyword": "#ff006e",
      "string": "#00f5ff",
      "comment": "#4a5568",
      "function": "#ffbe0b",
      "variable": "#00f5ff",
      "number": "#8338ec",
      "operator": "#fb5607"
    }
  }
}
```

### Forest Theme
```json
{
  "name": "Forest Green",
  "type": "dark",
  "colors": {
    "bg-primary": "#1a2421",
    "bg-secondary": "#0d1b14",
    "bg-tertiary": "#0a140f",
    "text-primary": "#d4f1d4",
    "text-secondary": "#8fbc8f",
    "accent-color": "#52b788",
    "border-color": "rgba(82, 183, 136, 0.2)",
    "editor": {
      "background": "#1a2421",
      "foreground": "#d4f1d4",
      "lineHighlight": "rgba(82, 183, 136, 0.1)",
      "selection": "rgba(82, 183, 136, 0.2)",
      "cursor": "#74c69d"
    },
    "syntax": {
      "keyword": "#95d5b2",
      "string": "#b7e4c7",
      "comment": "#52796f",
      "function": "#52b788",
      "variable": "#d4f1d4",
      "number": "#74c69d",
      "operator": "#40916c"
    }
  }
}
```

## Tips

1. **Use Color Pickers**: Tools like [coolors.co](https://coolors.co) can help generate color palettes
2. **Test Contrast**: Ensure good contrast between background and text colors
3. **RGBA for Transparency**: Use `rgba()` format for semi-transparent colors
4. **Consistency**: Keep related colors in the same hue family
5. **Accessibility**: Aim for WCAG AA contrast ratios (4.5:1 for normal text)

## Limitations

- Custom theme support is **experimental**
- Currently stored in localStorage (limited to ~5MB)
- Theme switching requires manual implementation
- Some UI elements may not respect custom theme colors yet

## Future Enhancements

- Theme editor UI
- Multiple custom themes
- Theme export/share
- Monaco editor theme integration
- Terminal theme sync
- Live theme preview

## Troubleshooting

**Theme doesn't load:**
- Check JSON syntax (use [jsonlint.com](https://jsonlint.com))
- Ensure all required properties are present
- Check browser console for errors

**Colors don't apply:**
- Custom theme support is experimental
- Some areas may not be fully integrated yet
- Try refreshing the application

**Lost theme:**
- Custom themes are stored in localStorage
- Clearing browser data will remove them
- Keep backup JSON files

## Contributing

Found a bug or want to improve custom theme support? Contributions welcome!
