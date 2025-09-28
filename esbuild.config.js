import esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Create dist directory
const distDir = 'dist';
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

const isProduction = process.env.NODE_ENV === 'production';

// Build renderer bundle with optimizations
async function buildRenderer() {
  try {
    console.log(`🔨 Building renderer bundle (${isProduction ? 'production' : 'development'})...`);
    
    const result = await esbuild.build({
      entryPoints: ['src/renderer/renderer.js'],
      bundle: true,
      outfile: 'dist/renderer.bundle.js',
      format: 'iife',
      globalName: 'BargeRenderer',
      target: 'es2020',
      minify: isProduction,
      sourcemap: !isProduction,
      treeShaking: true,
      external: ['electron'],
      define: {
        'process.env.NODE_ENV': `"${process.env.NODE_ENV || 'development'}"`
      },
      plugins: [
        {
          name: 'external-deps',
          setup(build) {
            // Keep Monaco Editor completely external
            build.onResolve({ filter: /^monaco-editor/ }, args => ({
              path: args.path,
              external: true
            }));
            
            // Keep xterm external
            build.onResolve({ filter: /^xterm/ }, args => ({
              path: args.path,
              external: true
            }));
            
            // Handle dynamic requires for Monaco
            build.onResolve({ filter: /^vs\/editor\/editor\.main/ }, args => ({
              path: args.path,
              external: true
            }));
            
            // Handle all Monaco vs/* modules as external
            build.onResolve({ filter: /^vs\// }, args => ({
              path: args.path,
              external: true
            }));
          }
        }
      ]
    });
    
    const bundleSize = result.outputFiles?.[0]?.contents?.length || 0;
    const sizeKB = Math.round(bundleSize / 1024);
    console.log(`✅ Renderer bundle created successfully (${sizeKB}KB)`);
    return result;
  } catch (error) {
    console.error('❌ Renderer build failed:', error);
    throw error;
  }
}

// Recursive directory copy function
function copyDir(src, dest) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  const items = readdirSync(src);
  items.forEach(item => {
    const srcPath = join(src, item);
    const destPath = join(dest, item);
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  });
}

// Copy static files and dependencies
function copyStaticFiles() {
  console.log('📁 Copying static files and dependencies...');
  
  // Copy HTML file and update all paths
  const htmlContent = readFileSync('src/renderer/index.html', 'utf8');
  const updatedHtml = htmlContent
    .replace(/<script src="renderer\.js"><\/script>/g, '<script src="renderer.bundle.js"></script>')
    .replace(/href="\.\.\/\.\.\/node_modules\//g, 'href="./node_modules/')
    .replace(/src="\.\.\/\.\.\/node_modules\//g, 'src="./node_modules/')
    // Rewrite Vite dev paths for production bundle
    .replace(/src="\/monaco-editor\//g, 'src="./node_modules/monaco-editor/')
    .replace(/href="\/monaco-editor\//g, 'href="./node_modules/monaco-editor/')
    .replace(/href="\/xterm\//g, 'href="./node_modules/xterm/')
    .replace(/src="\/xterm\//g, 'src="./node_modules/xterm/')
    .replace(/src="\.\.\/\.\.\/src\/assets\//g, 'src="./src/assets/');
  
  writeFileSync(join(distDir, 'index.html'), updatedHtml);
  
  // Copy CSS file
  let cssContent = readFileSync('src/renderer/styles.css', 'utf8');
  
  // Basic CSS optimization for production
  if (isProduction) {
    // Remove comments and extra whitespace
    cssContent = cssContent
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove comments
      .replace(/\s+/g, ' ') // Collapse whitespace
      .replace(/;\s*}/g, '}') // Remove semicolons before closing braces
      .trim();
  }
  
  writeFileSync(join(distDir, 'styles.css'), cssContent);
  
  // Copy Monaco Editor files
  const monacoSrc = 'node_modules/monaco-editor/min';
  const monacoDest = join(distDir, 'node_modules/monaco-editor/min');
  
  if (existsSync(monacoSrc)) {
    console.log('📦 Copying Monaco Editor files...');
    copyDir(monacoSrc, monacoDest);
  }
  
  // Copy xterm files
  const xtermSrc = 'node_modules/xterm';
  const xtermDest = join(distDir, 'node_modules/xterm');
  
  if (existsSync(xtermSrc)) {
    console.log('📦 Copying xterm files...');
    copyDir(xtermSrc, xtermDest);
  }
  
  // Copy assets
  if (existsSync('src/assets')) {
    console.log('📦 Copying assets...');
    copyDir('src/assets', join(distDir, 'src/assets'));
  }
  
  const cssSize = Math.round(cssContent.length / 1024);
  console.log(`✅ Static files and dependencies copied (CSS: ${cssSize}KB)`);
}

// Main build function
async function build() {
  try {
    await buildRenderer();
    copyStaticFiles();
    
    console.log('🎉 Build completed successfully!');
    console.log(`📊 Bundle size: ${isProduction ? 'Minified' : 'Development'} mode`);
    console.log('🚀 Run "npm start" to test the bundled app');
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

// Run build
build();
