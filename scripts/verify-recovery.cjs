// Native recovery audit: copies only the named test fixture into a unique data root.
// The user's regular app/profile/data are never attached, changed, or closed.
// Controls are found by the accessible names in src/workspace/types.ts (NAMES) and its HOOKS.
const { chromium } = require('playwright');
const { withSpeechPath, whisperDir } = require('./test-env.cjs');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runId = crypto.randomUUID();
const workspace = path.resolve(__dirname, '..');
const dataRoot = path.join(workspace, '.local', 'recovery-data', runId);
const output = path.join(workspace, 'test-results', 'recovery', runId);
const fixture = process.env.CUEREVIEW_TEST_FIXTURE || path.join(workspace, '.local', 'pipeline-data', 'sessions', JSON.parse(fs.readFileSync(path.join(workspace, 'test-results', 'pipeline-verification.json'), 'utf8')).sessionId);
const executable = path.join(workspace, 'src-tauri', 'target', 'release', 'cuereview.exe');
const normalLocal = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local'), 'CueReview');
const sourceModel = process.env.CUEREVIEW_TEST_MODEL || path.join(normalLocal, 'models', 'ggml-base.bin');
const vadModel = process.env.CUEREVIEW_TEST_VAD_MODEL || path.join(normalLocal, 'models', 'ggml-silero-v6.2.0.bin');
const testModel = path.join(dataRoot, 'models', 'intentionally-missing.bin');
const sessionId = crypto.randomUUID(), projectId = crypto.randomUUID();
const sessionDir = path.join(dataRoot, 'sessions', sessionId);
const endpoint = 'http://127.0.0.1:9225';
const result = { runId, dataRoot, sourceFixture: fixture, executable, whisperDir: whisperDir(), startedAt: new Date().toISOString(), checks: {}, screenshots: [], ownedPids: [], pageErrors: [], cleanup: {} };
// Markers left the UI in v0.2.0 (decision 5); a legacy markers.json must stay readable through get_markers.
const legacyMarkers = [{ id: crypto.randomUUID(), timeMs: 1000, label: 'Legacy marker from v0.1' }];
let child, browser, page, childLog;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const shot = async name => { const target = path.join(output, `${name}.png`); await page.screenshot({ path: target }); result.screenshots.push(target); };
const mediaHashes = () => Object.fromEntries(['video.mp4', 'mic.wav'].map(name => [name, hash(path.join(sessionDir, name))]));
const assertMedia = before => { const after = mediaHashes(); if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Original recording media changed during recovery/retry'); return after; };
const sidebar = () => page.getByRole('complementary', { name: 'Recordings', exact: true });

async function closeOwned() {
  if (!child) return;
  const owned = child;
  // Use the standard native close message on our exact owned PID. The production
  // WebView deliberately has no permission to close arbitrary native windows.
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `$taskProcess = Get-Process -Id ${owned.pid}; $taskProcess.CloseMainWindow() | Out-Null`], { windowsHide: true, stdio: 'ignore' }); }
  catch (error) { result.cleanup.closeCommandError = String(error); }
  if (browser) await browser.close().catch(() => {});
  browser = page = undefined;
  for (let attempts = 0; attempts < 40 && owned.exitCode === null; attempts++) await delay(100);
  if (owned.exitCode === null) {
    // Only this script's exact child PID is eligible for fallback termination.
    result.cleanup.forcedOwnedPid = owned.pid;
    owned.kill();
    for (let attempts = 0; attempts < 20 && owned.exitCode === null; attempts++) await delay(100);
  }
  result.cleanup[`pid${owned.pid}`] = { exitCode: owned.exitCode, signalCode: owned.signalCode };
  child = undefined;
}
async function launchOwned() {
  try { const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(600) }); if (response.ok) throw Error('CDP9225 is already occupied; refusing to attach to an unowned app'); }
  catch (error) { if (error.message.includes('already occupied')) throw error; }
  const env = withSpeechPath({ ...process.env, CUEREVIEW_DATA_DIR: dataRoot, CUEREVIEW_MODEL: testModel, CUEREVIEW_VAD_MODEL: vadModel, CUEREVIEW_DTW_MODEL: process.env.CUEREVIEW_DTW_MODEL || 'base', WEBVIEW2_USER_DATA_FOLDER: path.join(dataRoot, 'webview-profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9225' });
  child = spawn(executable, [], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', childLog, childLog] });
  result.ownedPids.push(child.pid);
  let connected = false;
  for (let attempts = 0; attempts < 75; attempts++) {
    if (child.exitCode !== null) throw Error(`Owned app exited before CDP startup: ${child.exitCode}`);
    try { const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) }); if (response.ok) { connected = true; break; } } catch {}
    await delay(200);
  }
  if (!connected) throw Error('Owned recovery app CDP startup timed out after 15 seconds');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  await sidebar().getByRole('button', { name: 'Recovery audit fixture', exact: true }).click();
  await page.locator('video').waitFor();
  await page.waitForFunction(() => { const video = document.querySelector('video'); return video && video.readyState >= 2; });
}
async function retryThroughUi() {
  const prior = await invoke('get_session', { id: sessionId });
  await page.getByRole('button', { name: 'Retry transcription', exact: true }).click();
  for (let attempt = 0; attempt < 300; attempt++) {
    const session = await invoke('get_session', { id: sessionId });
    const status = await invoke('get_recording_status');
    if (status.state === 'idle' && (session.status === 'ready' || (session.status === 'error' && session.error !== prior.error))) return session;
    await delay(200);
  }
  throw Error('UI transcription retry did not finish within 60 seconds');
}
async function verifyWord(word, index, label) {
  const button = page.locator('.word').nth(index);
  await button.click();
  const actualSeconds = await page.locator('video').evaluate(video => video.currentTime);
  const expectedMs = word.seekMs ?? word.startMs;
  if (Math.abs(actualSeconds * 1000 - expectedMs) > 100) throw Error(`${label} word seek mismatch: ${actualSeconds}s vs ${expectedMs}ms`);
  return { text: word.text, expectedMs, originalStartMs: word.startMs, actualSeconds };
}
async function verifyNativeSourceControls() {
  await sidebar().getByRole('button', { name: 'New recording', exact: true }).click();
  await page.locator('.mic-trigger').click();
  await page.getByRole('group', { name: 'Microphone options', exact: true }).getByRole('button', { name: 'No microphone', exact: true }).click();
  await page.locator('.source-trigger').click();
  await page.getByRole('button', { name: 'Refresh capture devices', exact: true }).click();
  // Device enumeration is asynchronous; a second real invocation completes after
  // the UI request has been queued, and the bounded UI pause permits its render.
  const sources = await invoke('list_sources');
  await delay(600);
  await page.keyboard.press('Escape');
  await page.locator('.mic-trigger').click();
  const selectedMicrophone = await page.getByRole('group', { name: 'Microphone options', exact: true }).getByRole('button', { name: 'No microphone', exact: true }).getAttribute('aria-pressed');
  if (selectedMicrophone !== 'true') throw Error('Native source refresh re-enabled a microphone after No microphone was chosen');
  result.checks.noMicrophoneAfterNativeRefresh = { selectedMicrophone, status: (await invoke('get_recording_status')).state };
  await page.keyboard.press('Escape');
  await shot('native-no-microphone-after-refresh');
  const unavailable = sources.find(source => !source.available);
  if (unavailable) {
    await page.locator('.source-trigger').click();
    await page.getByRole('group', { name: 'Capture sources', exact: true }).getByRole('button', { name: `${unavailable.name} · unavailable`, exact: true }).click();
    await page.getByRole('heading', { name: 'Capture source unavailable', exact: true }).waitFor();
    if (!(await page.getByRole('button', { name: 'Record', exact: true }).isDisabled())) throw Error('Unavailable native source can start recording');
    await page.keyboard.press('Control+r');
    await page.getByRole('alert').waitFor();
    if ((await invoke('get_recording_status')).state !== 'idle') throw Error('Unavailable-source keyboard shortcut started capture');
    result.checks.nativeUnavailableSource = { id: unavailable.id, detail: unavailable.detail, keyboardStayedIdle: true };
    await shot('native-unavailable-source-guidance');
  } else result.checks.nativeUnavailableSource = { exercised: false, reason: 'No real disconnected source was enumerated; offline/disappeared selection and keyboard guards are covered by frontend integration tests. No synthetic source or hardware change was introduced.' };
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  let originalHashes;
  try {
    if (!fs.existsSync(sourceModel)) throw Error(`Known existing model is absent: ${sourceModel}`);
    if (!fs.existsSync(vadModel)) throw Error(`Known existing VAD model is absent: ${vadModel}`);
    result.vadModel = { path: vadModel, bytes: fs.statSync(vadModel).size, sha256: hash(vadModel), access: 'read-only test reference' };
    fs.mkdirSync(path.join(dataRoot, 'projects'), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.dirname(testModel), { recursive: true });
    const metadata = JSON.parse(fs.readFileSync(path.join(fixture, 'session.json')));
    for (const name of ['video.mp4', 'mic.wav']) fs.copyFileSync(path.join(fixture, name), path.join(sessionDir, name));
    originalHashes = mediaHashes();
    result.sourceMediaHashes = Object.fromEntries(['video.mp4', 'mic.wav'].map(name => [name, hash(path.join(fixture, name))]));
    if (JSON.stringify(originalHashes) !== JSON.stringify(result.sourceMediaHashes)) throw Error('Fixture copy failed checksum verification');
    const createdAt = new Date().toISOString();
    fs.writeFileSync(path.join(dataRoot, 'projects', `${projectId}.json`), JSON.stringify({ id: projectId, name: 'Isolated recovery verification', createdAt }));
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ ...metadata, id: sessionId, projectId, name: 'Recovery audit fixture', autoTitle: false, createdAt, status: 'processing', videoPath: null, folderPath: sessionDir, error: null }));
    fs.writeFileSync(path.join(sessionDir, 'markers.json'), JSON.stringify(legacyMarkers));
    result.sessionId = sessionId;
    result.initialFixtureStatus = 'processing';
    childLog = fs.openSync(path.join(output, 'owned-app.log'), 'a');
    await launchOwned();
    const recovered = await invoke('get_session', { id: sessionId });
    if (recovered.status !== 'error' || !recovered.videoPath || !/closed before|retained/i.test(recovered.error || '')) throw Error('Startup did not recover interrupted processing as an actionable retained-media error');
    result.checks.startupRecovery = recovered;
    result.checks.playableAfterRecovery = await page.locator('video').evaluate(video => ({ readyState: video.readyState, duration: video.duration, error: video.error?.message || null }));
    const markersAtStartup = await invoke('get_markers', { id: sessionId });
    if (JSON.stringify(markersAtStartup) !== JSON.stringify(legacyMarkers)) throw Error(`Legacy markers.json is no longer readable: ${JSON.stringify(markersAtStartup)}`);
    if (await page.getByRole('button', { name: 'Add marker', exact: true }).count()) throw Error('The retired Add marker control is still shown');
    result.checks.legacyMarkersReadable = { markers: markersAtStartup, markerUiAbsent: true };
    await shot('startup-recovered-playable');
    const failed = await retryThroughUi();
    result.checks.failedRetryObserved = failed;
    if (failed.status !== 'error' || !/speech model.*retry|install.*speech model/i.test(failed.error || '')) throw Error('Missing-model retry did not report an actionable saved-recording error');
    await page.getByText(failed.error, { exact: true }).last().waitFor();
    result.checks.missingModelRetry = { status: failed.status, error: failed.error, mediaHashes: assertMedia(originalHashes) };
    await shot('missing-model-retry-error');
    fs.copyFileSync(sourceModel, testModel);
    result.modelCopy = { source: sourceModel, target: testModel, bytes: fs.statSync(testModel).size, sha256: hash(testModel) };
    const ready = await retryThroughUi();
    if (ready.status !== 'ready') throw Error(`Retry with real model did not succeed: ${ready.error}`);
    const transcript = await invoke('get_transcript', { id: sessionId });
    const words = transcript.segments.flatMap(segment => segment.words);
    if (words.length < 6 || !transcript.segments.some(segment => /library|click|toolbar/i.test(segment.text))) throw Error('Real Whisper did not recover the expected known speech');
    await page.locator('.word').last().waitFor();
    result.checks.realWhisperRetry = { status: ready.status, transcriptStatus: transcript.status, wordCount: words.length, text: transcript.segments.map(segment => segment.text).join(' '), mediaHashes: assertMedia(originalHashes) };
    const earlyIndex = 0;
    const lateIndex = words.findLastIndex(word => (word.seekMs ?? word.startMs) < ready.durationMs - 200);
    result.checks.earlySeek = await verifyWord(words[earlyIndex], earlyIndex, 'Early');
    result.checks.lateSeek = await verifyWord(words[lateIndex], lateIndex, 'Late');
    await shot('retry-success-words');
    await closeOwned();
    await launchOwned();
    const reopened = await invoke('get_session', { id: sessionId });
    const reopenedTranscript = await invoke('get_transcript', { id: sessionId });
    const reopenedMarkers = await invoke('get_markers', { id: sessionId });
    if (reopened.status !== 'ready' || JSON.stringify(reopenedTranscript.segments) !== JSON.stringify(transcript.segments)) throw Error('Recovered session or transcript did not survive owned-app relaunch');
    if (JSON.stringify(reopenedMarkers) !== JSON.stringify(legacyMarkers)) throw Error('Legacy markers changed across relaunch');
    await page.locator('.word').last().waitFor();
    result.checks.relaunch = { status: reopened.status, segments: reopenedTranscript.segments.length, lateSeek: await verifyWord(words[lateIndex], lateIndex, 'Relaunched late'), legacyMarkers: reopenedMarkers.length, mediaHashes: assertMedia(originalHashes) };
    await shot('relaunch-persisted-transcript');
    await verifyNativeSourceControls();
    if (result.pageErrors.length) throw Error('Recovery WebView emitted script errors');
    result.passed = true;
  } catch (error) {
    result.passed = false;
    result.failure = error.stack || String(error);
    if (page) await shot('failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    await closeOwned();
    if (childLog !== undefined) fs.closeSync(childLog);
    // Delete only the exact model copy in this script's UUID root; retain all evidence.
    const modelRelative = path.relative(dataRoot, testModel);
    if (modelRelative.startsWith('..') || path.isAbsolute(modelRelative)) throw Error('Unsafe test-model cleanup path');
    if (fs.existsSync(testModel)) fs.unlinkSync(testModel);
    result.cleanup.testModelRemoved = !fs.existsSync(testModel);
    if (originalHashes) {
      try { result.cleanup.finalMediaHashes = assertMedia(originalHashes); }
      catch (error) { result.cleanup.mediaError = String(error); result.passed = false; process.exitCode = 1; }
    }
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(workspace, 'test-results', 'recovery', 'verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
})();
