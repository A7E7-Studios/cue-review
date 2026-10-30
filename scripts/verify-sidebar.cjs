// Real WebView2 mouse dragging and persistence in an owned, isolated desktop app.
// Controls are found by the accessible names in src/workspace/types.ts (NAMES) and its HOOKS.
const { chromium } = require('playwright');
const { withSpeechPath } = require('./test-env.cjs');
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
// The theme lives in Settings → Appearance, opened from the title bar (decision 14).
async function setTheme(theme) {
  await page.locator('[aria-label="Title bar"]').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByLabel('Appearance', { exact: true }).selectOption(theme);
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
// An inactive row's text color and the --color-row-text token it should resolve to in the current theme.
const rowText = () => page.evaluate(() => {
  const row = document.querySelector('.session:not([aria-current])');
  const probe = document.createElement('span');
  probe.style.color = 'var(--color-row-text)';
  row.parentElement.append(probe);
  const expected = getComputedStyle(probe).color;
  probe.remove();
  return { actual: getComputedStyle(row).color, expected };
});
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
    child = spawn(path.join(root, 'src-tauri', 'target', 'release', 'cuereview.exe'), [], { cwd: root, windowsHide: true, stdio: 'ignore', env: withSpeechPath({ ...process.env, CUEREVIEW_DATA_DIR: dataRoot, CUEREVIEW_MODEL: path.join(local, 'models', 'ggml-base.bin'), CUEREVIEW_VAD_MODEL: path.join(local, 'models', 'ggml-silero-v6.2.0.bin'), WEBVIEW2_USER_DATA_FOLDER: path.join(dataRoot, 'profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9228' }) });
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
    // Right-click an inactive recording, point at Move to section (a submenu opens beside the menu),
    // create a section from it, and rename it.
    await recents.getByRole('button', { name: 'Workspace issues', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to section', exact: true }).hover();
    const moveMenu = page.getByRole('menu', { name: 'Move to section', exact: true });
    await moveMenu.waitFor();
    const [actions, submenu] = await Promise.all([page.getByRole('menu', { name: 'Recording actions', exact: true }).boundingBox(), moveMenu.boundingBox()]);
    assert(actions && submenu && Math.abs(submenu.x - (actions.x + actions.width)) <= 8, `Move to section did not open beside the menu: ${JSON.stringify({ actions, submenu })}`);
    result.checks.moveSubmenu = { actions, submenu };
    await page.screenshot({ path: path.join(output, 'move-menu.png') });
    await moveMenu.getByRole('menuitem', { name: 'New section…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Design feedback');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('region', { name: 'Section: Design feedback', exact: true }).getByRole('button', { name: 'Workspace issues', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Section options for Design feedback', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Design');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Section options for Design', exact: true }).waitFor();
    await page.getByRole('button', { name: 'PlayalongXR', exact: true }).click();
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== 'light') await setTheme('light');
    const light = await rowText();
    assert(light.actual === light.expected, `Light sidebar rows are ${light.actual}, not --color-row-text ${light.expected}.`);
    await page.screenshot({ path: path.join(output, 'light-sidebar.png') });
    await setTheme('dark');
    // Rows follow the theme once any color transition settles.
    for (let i = 0; i < 50; i++) { const dark = await rowText(); if (dark.actual === dark.expected) break; await delay(100); }
    const dark = await rowText();
    assert(dark.actual === dark.expected && dark.actual !== light.actual, `Dark sidebar rows are ${dark.actual}, not --color-row-text ${dark.expected} (light ${light.actual}).`);
    result.checks.themeRows = { light: light.actual, dark: dark.actual };
    await page.screenshot({ path: path.join(output, 'dark-sidebar.png') });
    await page.reload();
    await page.getByRole('region', { name: 'Section: Design', exact: true }).getByRole('button', { name: 'Workspace issues', exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'PlayalongXR', exact: true }).getAttribute('aria-expanded') === 'false', 'Collapsed section did not persist.');
    result.checks.persistence = true;
    result.checks.mediaUnchanged = sessions.every((item, index) => hash(item.videoPath) === hashes[index]);
    assert(result.checks.mediaUnchanged, 'Moving a recording changed media.');
    // Drag a whole section below the others, then prove its order survives reload.
    const initialOrder = await invoke('list_projects');
    const first = initialOrder[0];
    await page.getByRole('region', { name: `Section: ${first.name}`, exact: true }).locator('.section-toggle').dragTo(recents.locator('.recents-heading'));
    const reorderedIds = [...initialOrder.slice(1).map(item => item.id), first.id];
    await page.waitForFunction(ids => [...document.querySelectorAll('[data-section-id]')].map(item => item.dataset.sectionId).join() === ids.join(), reorderedIds);
    assert((await invoke('list_projects')).map(item => item.id).join() === reorderedIds.join(), 'Section drag did not persist.');
    await page.reload();
    await page.waitForFunction(ids => [...document.querySelectorAll('[data-section-id]')].map(item => item.dataset.sectionId).join() === ids.join(), reorderedIds);
    result.checks.sectionOrder = reorderedIds;
    // Delete a populated section without changing its recordings or current playback.
    const gameSection = page.getByRole('region', { name: 'Section: PlayalongXR', exact: true });
    if (await gameSection.locator('.section-toggle').getAttribute('aria-expanded') === 'false') await gameSection.locator('.section-toggle').click();
    await gameSection.getByRole('button', { name: 'Boxing gameplay', exact: true }).click();
    await page.getByRole('button', { name: 'Seek to Review at 0:02', exact: true }).click();
    await page.evaluate(() => { window.__sectionDeleteVideo = document.querySelector('video'); });
    await page.getByRole('button', { name: 'Section options for PlayalongXR', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Delete section/ }).click();
    await recents.getByRole('button', { name: 'Boxing gameplay', exact: true }).waitFor();
    await recents.getByRole('button', { name: 'Main menu review', exact: true }).waitFor();
    assert(!await gameSection.count(), 'Deleted section still appears.');
    assert((await invoke('get_session', { id: sessions[3].id })).projectId === null && (await invoke('get_session', { id: sessions[4].id })).projectId === null, 'Section deletion did not clear every assignment.');
    assert(sessions.every((item, index) => hash(item.videoPath) === hashes[index]), 'Section deletion changed media.');
    assert(await page.evaluate(() => window.__sectionDeleteVideo === document.querySelector('video') && Math.abs(document.querySelector('video').currentTime - 2) < .1), 'Section deletion reset playback.');
    result.checks.deleteSectionPreservesRecordings = true;
    // Cancel does nothing; confirmation deletes the selected recording's actual folder.
    const deleteTarget = page.locator(`[data-session-id="${sessions[3].id}"]`);
    await deleteTarget.getByRole('button', { name: 'Recording options', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Delete recording/ }).click();
    const confirmation = page.getByRole('alertdialog', { name: 'Delete recording?' });
    assert((await confirmation.innerText()).includes('Boxing gameplay'), 'Delete confirmation does not identify its recording.');
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert(fs.existsSync(sessions[3].folderPath), 'Cancel deleted recording files.');
    await deleteTarget.getByRole('button', { name: 'Recording options', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Delete recording/ }).click();
    await page.screenshot({ path: path.join(output, 'delete-confirmation.png') });
    await confirmation.getByRole('button', { name: 'Delete recording', exact: true }).click();
    await page.getByRole('heading', { name: 'New recording', exact: true }).waitFor();
    await deleteTarget.waitFor({ state: 'detached' });
    assert(!fs.existsSync(sessions[3].folderPath), 'Confirmed deletion left recording files on disk.');
    assert(sessions.every((item, index) => index === 3 || hash(item.videoPath) === hashes[index]), 'Deletion changed another recording.');
    await page.reload();
    await page.getByRole('button', { name: 'Section options for Design', exact: true }).waitFor();
    assert((await invoke('list_sessions', { projectId: null })).length === 4, 'Deleted recording returned after reload.');
    assert(!(await invoke('list_projects')).some(item => item.id === sections[1].id), 'Deleted section returned after reload.');
    result.checks.deleteRecordingFiles = true;
    // Ctrl+K focuses the title bar search, which filters by session name only (decision 11).
    const rows = () => sidebar.locator('.session').count();
    const allRows = await rows();
    await page.keyboard.press('Control+k');
    const search = page.getByRole('searchbox', { name: 'Search recordings', exact: true });
    assert(await search.evaluate(input => input === document.activeElement), 'Ctrl+K did not focus Search recordings.');
    await search.fill('quest');
    await sidebar.getByRole('button', { name: 'Quest performance', exact: true }).waitFor();
    assert(await rows() === 1, 'Search did not narrow the sidebar to the matching session.');
    await search.fill('moment');
    await sidebar.getByRole('status').filter({ hasText: 'No matches' }).waitFor();
    assert(await rows() === 0, 'Search matched transcript text instead of session names only.');
    await page.screenshot({ path: path.join(output, 'search-no-matches.png') });
    await search.fill('');
    for (let i = 0; i < 50 && await rows() !== allRows; i++) await delay(100);
    assert(await rows() === allRows, 'Clearing the search did not restore every session.');
    result.checks.search = { rows: allRows, quest: 1, transcriptOnlyTerm: 0 };
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
