// Real WebView2 mouse dragging and persistence in an owned, isolated desktop app.
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(__dirname, '..'), runId = crypto.randomUUID();
const dataRoot = path.join(root, '.local', 'sidebar-data', runId);
const output = path.join(root, 'test-results', 'sidebar', runId);
const endpoint = 'http://127.0.0.1:9228';
const result = { runId, dataRoot, checks: {}, pageErrors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let child, browser, page;
const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
(async () => {
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'projects'), { recursive: true });
  const sections = ['Propex Explorer', 'PlayalongXR'].map(name => ({ id: crypto.randomUUID(), name, createdAt: new Date().toISOString() }));
  sections.forEach(section => fs.writeFileSync(path.join(dataRoot, 'projects', `${section.id}.json`), JSON.stringify(section)));
  const fixture = path.join(dataRoot, 'fixture.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=30', '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture], { windowsHide: true, timeout: 15000 });
  const sessions = ['Library UI review', 'Workspace issues', 'Quest performance', 'Boxing gameplay', 'Main menu review'].map((name, index) => {
    const id = crypto.randomUUID(), folder = path.join(dataRoot, 'sessions', id);
    fs.mkdirSync(folder, { recursive: true });
    const videoPath = path.join(folder, 'video.mp4'); fs.copyFileSync(fixture, videoPath);
    const session = { id, name, projectId: index === 0 ? sections[0].id : index > 2 ? sections[1].id : null, autoTitle: false, status: 'ready', createdAt: new Date(Date.now() - index * 86400000).toISOString(), durationMs: 5000, folderPath: folder, videoPath, sourceId: 'monitor:1', systemAudio: false };
    fs.writeFileSync(path.join(folder, 'session.json'), JSON.stringify(session));
    fs.writeFileSync(path.join(folder, 'transcript.json'), JSON.stringify({ segments: [{ id: 'review', startMs: 2000, endMs: 4000, text: 'Review this moment.', words: [{ text: 'Review', startMs: 2000, endMs: 2600 }, { text: 'this', startMs: 2600, endMs: 3000 }, { text: 'moment.', startMs: 3000, endMs: 4000 }] }] }));
    return session;
  });
  const hashes = sessions.map(item => hash(item.videoPath));
  try {
    let occupied = false;
    try { await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) }); occupied = true; } catch {}
    assert(!occupied, 'CDP9228 is occupied; refusing to attach to an unowned app.');
    const local = path.join(process.env.LOCALAPPDATA, 'CueReview');
    child = spawn(path.join(root, 'src-tauri', 'target', 'release', 'cuereview.exe'), [], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, CUEREVIEW_DATA_DIR: dataRoot, CUEREVIEW_MODEL: path.join(local, 'models', 'ggml-base.bin'), CUEREVIEW_VAD_MODEL: path.join(local, 'models', 'ggml-silero-v6.2.0.bin'), PATH: `${path.join(local, 'tools', 'whisper-b5454')};${process.env.PATH}`, WEBVIEW2_USER_DATA_FOLDER: path.join(dataRoot, 'profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9228' } });
    result.ownedPid = child.pid;
    for (let i = 0; i < 75; i++) {
      assert(child.exitCode === null, 'Owned app exited before startup.');
      try { if ((await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
      await delay(200);
    }
    browser = await chromium.connectOverCDP(endpoint); page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(12000);
    page.on('pageerror', error => result.pageErrors.push(error.message));
    const sidebar = page.getByRole('complementary', { name: 'Recordings', exact: true });
    await sidebar.getByRole('button', { name: 'Library UI review', exact: true }).click();
    await page.getByRole('button', { name: 'Seek to Review at 0:02', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    await page.evaluate(() => { window.__sidebarVideo = document.querySelector('video'); window.__sidebarDragEvents = []; for (const type of ['dragstart', 'drop']) document.addEventListener(type, event => window.__sidebarDragEvents.push({ type, trusted: event.isTrusted })); });
    assert(await sidebar.locator('.session').count() === 5 && !await page.locator('.library-tabs').count(), 'Sidebar duplicated rows or retained project tabs.');
    await sidebar.getByRole('button', { name: 'Propex Explorer', exact: true }).click();
    const destination = page.getByRole('region', { name: 'Section: Propex Explorer', exact: true });
    await sidebar.getByRole('button', { name: 'Workspace issues', exact: true }).dragTo(destination.getByRole('button', { name: 'Propex Explorer', exact: true }));
    await destination.getByRole('button', { name: 'Workspace issues', exact: true }).waitFor();
    assert((await invoke('get_session', { id: sessions[1].id })).projectId === sections[0].id, 'Mouse drag did not persist its section.');
    assert(await destination.getByRole('button', { name: 'Propex Explorer', exact: true }).getAttribute('aria-expanded') === 'true', 'Drop did not expand the destination.');
    const recents = page.getByRole('region', { name: 'Recents', exact: true });
    await destination.getByRole('button', { name: 'Workspace issues', exact: true }).dragTo(recents.locator('.recents-heading'));
    await recents.getByRole('button', { name: 'Workspace issues', exact: true }).waitFor();
    assert((await invoke('get_session', { id: sessions[1].id })).projectId === null, 'Dragging back to Recents did not ungroup.');
    result.checks.nativeDragEvents = await page.evaluate(() => window.__sidebarDragEvents);
    assert(result.checks.nativeDragEvents.filter(item => item.type === 'drop' && item.trusted).length === 2, 'Drag verification did not use trusted native mouse events.');
    result.checks.reviewPreserved = await page.evaluate(() => window.__sidebarVideo === document.querySelector('video') && Math.abs(document.querySelector('video').currentTime - 2) < .1);
    assert(result.checks.reviewPreserved, 'Moving another recording reset playback.');
    // Right-click an inactive recording, create a section from the move menu, and rename it.
    await recents.getByRole('button', { name: 'Workspace issues', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to section', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'move-menu.png') });
    await page.getByRole('menuitem', { name: 'New section', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Design feedback');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('region', { name: 'Section: Design feedback', exact: true }).getByRole('button', { name: 'Workspace issues', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Rename section Design feedback', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Design');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Rename section Design', exact: true }).waitFor();
    await page.getByRole('button', { name: 'PlayalongXR', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'light-sidebar.png') });
    await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.session')).color === 'rgb(228, 230, 236)');
    await page.screenshot({ path: path.join(output, 'dark-sidebar.png') });
    await page.reload();
    await page.getByRole('region', { name: 'Section: Design', exact: true }).getByRole('button', { name: 'Workspace issues', exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'PlayalongXR', exact: true }).getAttribute('aria-expanded') === 'false', 'Collapsed section did not persist.');
    result.checks.persistence = true;
    result.checks.mediaUnchanged = sessions.every((item, index) => hash(item.videoPath) === hashes[index]);
    assert(result.checks.mediaUnchanged, 'Moving a recording changed media.');
    assert(result.pageErrors.length === 0, 'WebView errors occurred.');
    result.passed = true;
  } catch (error) { result.error = error.stack || String(error); result.passed = false; process.exitCode = 1; if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); result.alerts = await page.getByRole('alert').allTextContents().catch(() => []); } }
  finally {
    if (child && child.exitCode === null) {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`], { windowsHide: true, timeout: 5000 });
      for (let i = 0; i < 50 && child.exitCode === null; i++) await delay(100);
      result.cleanup = { appExited: child.exitCode === 0 };
      if (child.exitCode === null) { child.unref(); result.passed = false; process.exitCode = 1; }
    }
    if (browser) await browser.close();
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(root, 'test-results', 'sidebar-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
