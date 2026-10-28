// Loaded by index.html ahead of the app, so `:root[data-platform]` tokens (src/ui/tokens.css)
// apply from the first paint. The CSP blocks inline scripts, so this is a module of its own.
import { platform } from './windowApi';

document.documentElement.dataset.platform = platform();
