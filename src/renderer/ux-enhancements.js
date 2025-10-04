// UX Enhancements for Barge Editor

(function() {
'use strict';

// Add ripple effect to buttons
function addRippleEffect() {
document.addEventListener('click', (e) => {
const btn = e.target.closest('button, .icon-btn');
if (!btn || btn.disabled) return;

const ripple = document.createElement('span');
const rect = btn.getBoundingClientRect();
const size = Math.max(rect.width, rect.height);
const x = e.clientX - rect.left - size / 2;
const y = e.clientY - rect.top - size / 2;

ripple.style.cssText = `
position: absolute;
width: ${size}px;
height: ${size}px;
left: ${x}px;
top: ${y}px;
background: radial-gradient(circle, rgba(255,255,255,0.4) 0%, transparent 70%);
border-radius: 50%;
pointer-events: none;
animation: ripple 0.6s ease-out;
`;

const style = document.createElement('style');
if (!document.querySelector('#ripple-keyframes')) {
style.id = 'ripple-keyframes';
style.textContent = `
@keyframes ripple {
to {
transform: scale(2);
opacity: 0;
}
}
`;
document.head.appendChild(style);
}

btn.style.position = 'relative';
btn.style.overflow = 'hidden';
btn.appendChild(ripple);

setTimeout(() => ripple.remove(), 600);
});
}

// Smooth scroll to active tab
function smoothScrollToActiveTab() {
const observer = new MutationObserver(() => {
const activeTab = document.querySelector('.tab.active');
if (activeTab) {
activeTab.scrollIntoView({
behavior: 'smooth',
block: 'nearest',
inline: 'center'
});
}
});

const tabsContainer = document.querySelector('.tabs');
if (tabsContainer) {
observer.observe(tabsContainer, {
attributes: true,
attributeFilter: ['class'],
subtree: true
});
}
}

// Add keyboard shortcuts hints
function addKeyboardHints() {
const shortcuts = {
'Ctrl+S': 'Save',
'Ctrl+O': 'Open File',
'Ctrl+N': 'New File',
'Ctrl+W': 'Close Tab',
'Ctrl+F': 'Find',
'Ctrl+Shift+P': 'Command Palette',
'F11': 'Fullscreen'
};

// Could be used to show hints in tooltips or help modal
window.__keyboardShortcuts = shortcuts;
}

// Better error handling UI
function showNotification(message, type = 'info', duration = 3000) {
const notification = document.createElement('div');
notification.className = `notification notification-${type}`;
notification.textContent = message;
notification.style.cssText = `
position: fixed;
top: 60px;
right: 20px;
background: ${type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#6366f1'};
color: white;
padding: 12px 20px;
border-radius: 8px;
box-shadow: 0 4px 12px rgba(0,0,0,0.3);
z-index: 10000;
animation: slideInRight 0.3s ease-out;
font-size: 14px;
max-width: 400px;
`;

const style = document.createElement('style');
if (!document.querySelector('#notification-keyframes')) {
style.id = 'notification-keyframes';
style.textContent = `
@keyframes slideInRight {
from {
transform: translateX(400px);
opacity: 0;
}
to {
transform: translateX(0);
opacity: 1;
}
}
@keyframes slideOutRight {
from {
transform: translateX(0);
opacity: 1;
}
to {
transform: translateX(400px);
opacity: 0;
}
}
`;
document.head.appendChild(style);
}

document.body.appendChild(notification);

setTimeout(() => {
notification.style.animation = 'slideOutRight 0.3s ease-in';
setTimeout(() => notification.remove(), 300);
}, duration);
}

// Expose notification function globally
window.showNotification = showNotification;

// Add loading indicator
function createLoadingIndicator() {
const loader = document.createElement('div');
loader.id = 'global-loader';
loader.style.cssText = `
position: fixed;
top: 0;
left: 0;
right: 0;
height: 3px;
background: linear-gradient(90deg, #6366f1, #8b5cf6, #6366f1);
background-size: 200% 100%;
animation: loading 1.5s ease-in-out infinite;
z-index: 10001;
display: none;
`;

const style = document.createElement('style');
if (!document.querySelector('#loading-keyframes')) {
style.id = 'loading-keyframes';
style.textContent = `
@keyframes loading {
0% { background-position: 200% 0; }
100% { background-position: -200% 0; }
}
`;
document.head.appendChild(style);
}

document.body.appendChild(loader);

window.showLoader = () => {
loader.style.display = 'block';
};

window.hideLoader = () => {
loader.style.display = 'none';
};
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', init);
} else {
init();
}

function init() {
addRippleEffect();
smoothScrollToActiveTab();
addKeyboardHints();
createLoadingIndicator();

console.log('✨ UX Enhancements loaded');
}
})();
