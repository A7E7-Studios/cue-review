// The map's HTTP server: the page, its data, Refresh and the design boards, on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAt } from './sources.mjs';

export const PAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'page');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const VIEW = /^\/(?:$|waiting(?:\/|$)|explore(?:\/|$)|search(?:\/|$))/;
const BOARD = /^\/board\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(specs\/[a-z0-9/-]+\/looks\/[a-z0-9-]+\.html)$/;

/**
 * A board showing only its `<section id="<id>">`, or the whole board when no id is given; null when
 * the board holds no such section. Hidden is every section that is not the chosen one, not inside
 * it and not holding it, so a section's own nested sections still show.
 */
export function withSection(html, id) {
  if (!id) return html;
  if (!/^[A-Za-z][\w-]*$/.test(id) || !new RegExp(`<section\\b[^>]*\\sid=["']${id}["']`).test(html)) return null;
  const style = `<style>section:not(#${id}):not(#${id} section):not(:has(#${id})){display:none!important}</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${style}</head>`) : style + html;
}

/**
 * Whether a request's `Host` names this server: `127.0.0.1:<port>` or `localhost:<port>`. Another
 * name pointed at 127.0.0.1 (DNS rebinding) would otherwise make another site's page same-origin.
 */
export function hostAllowed(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}

/**
 * @param {object} o
 * @param {() => Promise<{ model, dirs, commits }>} o.build one build of the map
 * @param {string|null} [o.themeFile] the project's `kit-pages/theme.css`, served as `/theme.css` when it exists
 * @param {() => Promise<{ ok: boolean, error?: string }>} [o.review] opens CueReview
 * @returns {{ server: http.Server, refresh: () => Promise<object>, listen: (port: number) => Promise<number> }}
 */
export function createMapServer({ build, themeFile = null, review = async () => ({ ok: false, error: 'Start review is not set up here.' }) }) {
  let current = null;
  let pending = null;
  const refresh = () => {
    pending ??= build().then((b) => { current = b; return b; }).finally(() => { pending = null; });
    return pending;
  };
  const latest = async () => current || refresh();

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, server.address()?.port)) return send(res, 403, 'text/plain', 'this server answers only to 127.0.0.1 and localhost');
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = decodeURIComponent(url.pathname);
      if (req.method === 'GET' && p === '/api/map') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify((await latest()).model));
      if (req.method === 'POST') {
        // Only the map's own page sends this header; a page of another site cannot without the
        // browser asking this server first, which it never allows.
        if (req.headers['x-solution-map'] !== '1') return send(res, 403, 'text/plain', 'only the map’s page may ask this');
        if (p === '/api/refresh') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify((await refresh()).model));
        if (p === '/api/review') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await review()));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed');
      const b = BOARD.exec(p);
      if (b) {
        const { dirs, commits } = await latest();
        const body = dirs[b[1]] && commits[b[1]] ? await readAt(dirs[b[1]], commits[b[1]], b[2]) : null;
        if (!body) return send(res, 404, 'text/plain', 'no such board at the commit read');
        const html = withSection(String(body), url.searchParams.get('section'));
        if (html === null) return send(res, 404, 'text/plain', 'the board has no such section');
        return send(res, 200, TYPES['.html'], html, { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:" });
      }
      if (p === '/theme.css') {
        const css = themeFile && fs.existsSync(themeFile) ? fs.readFileSync(themeFile) : '';
        return send(res, 200, TYPES['.css'], css);
      }
      if (p.startsWith('/page/')) {
        const name = p.slice('/page/'.length);
        if (!/^[a-z-]+\.(css|mjs|svg)$/.test(name)) return send(res, 404, 'text/plain', 'not found');
        const file = path.join(PAGE_DIR, name);
        if (!fs.existsSync(file)) return send(res, 404, 'text/plain', 'not found');
        return send(res, 200, TYPES[path.extname(name)], fs.readFileSync(file));
      }
      if (VIEW.test(p)) return send(res, 200, TYPES['.html'], fs.readFileSync(path.join(PAGE_DIR, 'index.html')));
      return send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      return send(res, 500, 'text/plain', String(e.message || e));
    }
  });

  /** Listens on 127.0.0.1 at `port`, or the next free port of the 20 after it; resolves the port. */
  const listen = (port) => new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = (p) => {
      const onError = (e) => {
        server.off('listening', onListening);
        if (e.code === 'EADDRINUSE' && p !== 0 && ++tries <= 20) attempt(p + 1);
        else reject(e);
      };
      const onListening = () => { server.off('error', onError); resolve(server.address().port); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    };
    attempt(port);
  });

  return { server, refresh, listen };
}
