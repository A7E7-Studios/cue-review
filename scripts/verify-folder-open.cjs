// Verify the real button and Explorer destination, including packaged-launcher redirection.
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { fileURLToPath } = require('url');
const root = path.resolve(__dirname, '..');
const runId = crypto.randomUUID(), sessionId = crypto.randomUUID();
// Defaults under %LOCALAPPDATA% to exercise packaged-launcher redirection; set CUEREVIEW_FOLDER_OPEN_ROOT to keep the run elsewhere.
const dataRoot = path.join(process.env.CUEREVIEW_FOLDER_OPEN_ROOT || path.join(process.env.LOCALAPPDATA, 'CueReview', 'folder-open-tests'), runId, 'Storage with spaces');
const folder = path.join(dataRoot, 'sessions', sessionId);
const output = path.join(root, 'test-results', 'folder-open', runId);
const endpoint = 'http://127.0.0.1:9227';
const result = { runId, dataRoot, logicalFolder: folder, sessionId };
let child, browser, page, opened;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function windows() {
  const json = execFileSync('powershell.exe', ['-NoProfile', '-Command', '$s=New-Object -ComObject Shell.Application; @($s.Windows()) | ForEach-Object { [pscustomobject]@{hwnd=$_.HWND;url=$_.LocationURL} } | ConvertTo-Json -Compress'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  const value = json.trim() ? JSON.parse(json) : [];
  return Array.isArray(value) ? value : [value];
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'session.json'), JSON.stringify({ id: sessionId, projectId: null, name: 'Folder opening verification', autoTitle: false, createdAt: new Date().toISOString(), durationMs: 0, status: 'ready', folderPath: folder, sourceId: 'monitor:1', microphoneId: null, systemAudio: false }));
  result.physicalFolder = fs.realpathSync.native(folder);
  result.redirected = result.physicalFolder.toLowerCase() !== folder.toLowerCase();
  try {
    let occupied = false;
    try { await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) }); occupied = true; } catch {}
    if (occupied) throw Error('CDP9227 is occupied; refusing to attach to an unowned app.');
    const before = windows().map(item => item.hwnd);
    child = spawn(path.join(root, 'src-tauri', 'target', 'release', 'cuereview.exe'), [], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, CUEREVIEW_DATA_DIR: dataRoot, WEBVIEW2_USER_DATA_FOLDER: path.join(dataRoot, 'profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9227' } });
    result.ownedPid = child.pid;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
      await delay(250);
    }
    browser = await chromium.connectOverCDP(endpoint);
    page = browser.contexts()[0].pages()[0];
    await page.getByRole('complementary', { name: 'Recordings', exact: true }).getByRole('button', { name: 'Folder opening verification', exact: true }).click();
    await page.getByRole('button', { name: 'Open recording folder', exact: true }).click();
    for (let i = 0; i < 20; i++) {
      opened = windows().find(item => {
        try { return !before.includes(item.hwnd) && fileURLToPath(item.url).toLowerCase() === result.physicalFolder.toLowerCase(); } catch { return false; }
      });
      if (opened) break;
      await delay(250);
    }
    if (!opened) throw Error('The button did not open Explorer at the physical recording directory.');
    if (!fs.existsSync(path.join(fileURLToPath(opened.url), 'session.json'))) throw Error('Explorer opened a different directory.');
    result.explorer = opened;
    result.passed = true;
  } catch (error) { result.error = error.stack || String(error); process.exitCode = 1; }
  finally {
    if (opened) {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `$s=New-Object -ComObject Shell.Application; @($s.Windows()) | Where-Object { $_.HWND -eq ${opened.hwnd} -and $_.LocationURL -eq $env:CUEREVIEW_TEST_FOLDER_URL } | ForEach-Object { $_.Quit() }`], { windowsHide: true, env: { ...process.env, CUEREVIEW_TEST_FOLDER_URL: opened.url }, timeout: 5000 });
    }
    if (child && child.exitCode === null) {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`], { windowsHide: true, timeout: 5000 });
      for (let i = 0; i < 50 && child.exitCode === null; i++) await delay(100);
      result.cleanup = { appExited: child.exitCode === 0 };
      if (child.exitCode === null) { child.unref(); result.passed = false; process.exitCode = 1; }
    }
    if (browser) await browser.close();
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(root, 'test-results', 'folder-open-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
