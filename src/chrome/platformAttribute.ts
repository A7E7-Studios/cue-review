// Loaded by index.html ahead of the app, so `:root[data-platform]` and `:root[data-theme]` tokens
// (src/ui/tokens.css) apply from the first paint and a dark window does not flash light while React
// loads. The CSP blocks inline scripts, so this is a module of its own.
import { storedTheme } from './storedTheme';
import { platform } from './windowApi';

export function applyRootAttributes(root: HTMLElement = document.documentElement) {
  root.dataset.platform = platform();
  root.dataset.theme = storedTheme();
}

applyRootAttributes();
