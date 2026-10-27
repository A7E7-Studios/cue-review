// Uses an explicitly selected authorized device and an owned, isolated desktop app.
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const workspace = path.resolve(__dirname, '..');
const serial = process.env.CUEREVIEW_TEST_DEVICE;
if (!serial) throw Error('Set CUEREVIEW_TEST_DEVICE to an authorized ADB serial.');
const runId = crypto.randomUUID();
const dataRoot = path.join(workspace, '.local', 'device-ui-data', runId);
const output = path.join(workspace, 'test-results', 'device-ui', runId);
const local = path.join(process.env.LOCALAPPDATA, 'CueReview');
const endpoint = 'http://127.0.0.1:9226';
const result = { runId, dataRoot, serial, adbServer: process.env.ADB_SERVER_SOCKET || 'default', checks: {}, pageErrors: [] };
let child, browser, page, ownsRecording = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const assert = (value, message) => { if (!value) throw Error(message); };
(async () => {
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  try {
    let occupied = false;
    try { await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) }); occupied = true; } catch {}
    assert(!occupied, 'CDP9226 is occupied; refusing to attach to an unowned app.');
    const env = { ...process.env, CUEREVIEW_DATA_DIR: dataRoot, CUEREVIEW_MODEL: path.join(local, 'models', 'ggml-base.bin'), CUEREVIEW_VAD_MODEL: path.join(local, 'models', 'ggml-silero-v6.2.0.bin'), CUEREVIEW_DTW_MODEL: 'base', WEBVIEW2_USER_DATA_FOLDER: path.join(dataRoot, 'profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9226', PATH: `${path.join(local, 'tools', 'whisper-b5454')};${process.env.PATH}` };
    child = spawn(path.join(workspace, 'src-tauri', 'target', 'release', 'cuereview.exe'), [], { cwd: workspace, env, windowsHide: true, stdio: 'ignore' });
    result.ownedPid = child.pid;
    let connected = false;
    for (let i = 0; i < 75; i++) {
      assert(child.exitCode === null, 'Owned app exited before startup.');
      try { if ((await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) })).ok) { connected = true; break; } } catch {}
      await delay(200);
    }
    assert(connected, 'Owned desktop app did not start within 15 seconds.');
    browser = await chromium.connectOverCDP(endpoint);
    page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => result.pageErrors.push(error.message));
    await page.getByRole('heading', { name: 'New recording', exact: true }).waitFor();
    await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Record'); return button && !button.disabled; });
    assert((await invoke('list_projects')).length === 0, 'Fresh app created an implicit project.');
    assert((await page.getByRole('dialog').count()) === 0, 'Fresh app requires a naming dialog.');
    result.checks.readyWithoutProject = true;
    const sources = await invoke('list_sources');
    const source = sources.find(item => item.id === `android:${serial}`);
    assert(source?.available, 'Selected device is not authorized in the application.');
    result.checks.enumeration = source;
    await page.locator('.source-trigger').click();
    await page.getByRole('group', { name: 'Capture sources', exact: true }).getByRole('button', { name: source.name, exact: true }).click();
    await page.locator('.mic-trigger').click();
    await page.getByRole('group', { name: 'Microphone options', exact: true }).getByRole('button', { name: 'No microphone', exact: true }).click();
    result.checks.directDeviceMenus = true;
    await page.waitForFunction(() => { const image = document.querySelector('.preview-image'); return image?.complete && image.naturalWidth > 100; });
    result.checks.preview = await page.locator('.preview-image').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
    await page.screenshot({ path: path.join(output, 'device-preview.png') });
    ownsRecording = true;
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    const status = await invoke('get_recording_status');
    result.sessionId = status.sessionId;
    await delay(2200);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    let completed = false;
    for (let i = 0; i < 360; i++) {
      const status = await invoke('get_recording_status');
      const session = await invoke('get_session', { id: result.sessionId });
      if (status.state === 'idle' && ['ready', 'error'].includes(session.status)) { completed = true; break; }
      await delay(250);
    }
    assert(completed, 'Recording did not finish within 90 seconds.');
    ownsRecording = false;
    const session = await invoke('get_session', { id: result.sessionId });
    result.checks.session = session;
    assert(session.status === 'ready' && session.videoPath, `Recording failed: ${JSON.stringify(session)}`);
    assert(session.projectId === null && session.autoTitle && session.name === 'Recording', 'Projectless unnamed recording did not finish correctly.');
    result.checks.session = session;
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0);
    result.checks.playback = await page.locator('video').evaluate(video => ({ duration: video.duration, width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime, readyState: video.readyState, error: video.error?.message }));
    await page.screenshot({ path: path.join(output, 'device-review.png') });
    const videoHash = crypto.createHash('sha256').update(fs.readFileSync(session.videoPath)).digest('hex');
    if (await page.getByRole('button', { name: 'Pause', exact: true }).count()) await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Optional Quest group');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Project: No project', exact: true }).click();
    await page.getByRole('group', { name: 'Project options', exact: true }).getByRole('button', { name: 'Optional Quest group', exact: true }).click();
    await page.getByRole('button', { name: 'Project: Optional Quest group', exact: true }).waitFor();
    const grouped = await invoke('get_session', { id: result.sessionId });
    assert(grouped.projectId, 'Optional grouping failed.');
    await page.getByRole('button', { name: 'Project: Optional Quest group', exact: true }).click();
    await page.getByRole('group', { name: 'Project options', exact: true }).getByRole('button', { name: 'No project', exact: true }).click();
    await page.getByRole('button', { name: 'Project: No project', exact: true }).waitFor();
    const ungrouped = await invoke('get_session', { id: result.sessionId });
    assert(ungrouped.projectId === null && crypto.createHash('sha256').update(fs.readFileSync(session.videoPath)).digest('hex') === videoHash, 'Grouping changed media or failed to unassign.');
    await page.getByRole('button', { name: 'Recents', exact: true }).click();
    await page.locator('.session').filter({ hasText: 'Recording' }).waitFor();
    result.checks.optionalGrouping = { assigned: grouped.projectId, unassigned: true, mediaUnchanged: true };
    assert(!result.pageErrors.length, 'Desktop page errors occurred.');
    result.passed = true;
  } catch (error) {
    result.error = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    if (page && ownsRecording) await invoke('get_recording_status').then(status => status.state === 'recording' ? invoke('stop_recording') : undefined).catch(error => { result.cleanupError = String(error); });
    if (child && child.exitCode === null) {
      try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`], { windowsHide: true, stdio: 'ignore' }); } catch {}
      for (let i = 0; i < 300 && child.exitCode === null; i++) await delay(100);
      result.cleanup = { exitCode: child.exitCode, stillRunning: child.exitCode === null };
      if (child.exitCode === null) { result.passed = false; process.exitCode = 1; child.unref(); }
    }
    if (browser) await browser.close().catch(() => {});
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(workspace, 'test-results', 'device-ui-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
