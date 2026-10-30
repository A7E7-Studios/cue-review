// Record more, end to end, in an owned and isolated desktop app (decision 10).
//
// The script starts two ffplay windows of its own (FFmpeg's testsrc2 pattern at 1280x720 and
// 960x540, with unique titles) and records only those: take 1 of the first window for about 4 s
// through the UI, then Record more of the second window, chosen in the review bar, for about
// 4 s. No microphone and no system audio are recorded, but the pointer position is
// (cursor.jsonl). Nothing leaves the machine.
//
// It then checks: one session with two takes, their offsets and take 2's source; each take's own
// video.mp4 lasting about its take (ffprobe), nothing joined, and session.videos placing them; the
// take 2 dock (its timer named "Take 2 elapsed time", no take label or caption) and the live
// divider while recording, the "Take 2 · m:ss" divider afterwards; the player loading take 2's
// video when the scrubber seeks into it and take 1's when it seeks back; `cue frame` in take 2 at
// take 2's size; the take divider in `cue transcript ID --segments`; and cursor.jsonl in both
// take folders. Recordings are stopped on failure. Prints a JSON summary, writes it to
// test-results/takes-verification.json and exits 1 on failure.
//
//   cargo build --release (the app and cue.exe in src-tauri/target/release), ffplay on PATH
//   node scripts/verify-takes.cjs [--keep-open]
//
// Controls are found by the accessible names in src/workspace/types.ts (NAMES) and its HOOKS.
'use strict';
const { chromium } = require('playwright');
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appData, whisperDir, withSpeechPath } = require('./test-env.cjs');

const workspace = path.resolve(__dirname, '..');
const runId = crypto.randomUUID();
const dataRoot = path.join(workspace, '.local', 'takes-data', runId);
const output = path.join(workspace, 'test-results', 'takes', runId);
const release = path.join(workspace, 'src-tauri', 'target', 'release');
const executable = process.env.CUEREVIEW_APP || path.join(release, 'cuereview.exe');
const cue = process.env.CUEREVIEW_CUE || path.join(release, 'cue.exe');
const endpoint = 'http://127.0.0.1:9229';
const windowTitle = `CueReview takes fixture ${runId.slice(0, 8)}`;
const secondTitle = `CueReview takes fixture 2 ${runId.slice(0, 8)}`;
const TAKE_MS = 4000;
const result = { runId, dataRoot, executable, cue, windowTitle, whisperDir: whisperDir(), startedAt: new Date().toISOString(), checks: {}, observations: {}, screenshots: [], pageErrors: [], cleanup: {}, passed: false };
let app, player, secondPlayer, browser, page, appLog, sessionId, recording = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw Error(message); };
const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const shot = async name => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file }); result.screenshots.push(file); };
const clock = ms => { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
const sidebar = () => page.getByRole('complementary', { name: 'Recordings', exact: true });
const transcriptPane = () => page.getByRole('region', { name: 'Transcript', exact: true });
async function until(condition, timeoutMs, message, everyMs = 200) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > end) throw Error(message);
    await delay(everyMs);
  }
}
function probeSize(file) {
  const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert(!out.error && out.status === 0, `ffprobe failed on ${file}: ${out.error || out.stderr}`);
  const [width, height] = out.stdout.trim().split(',').map(Number);
  return { width, height };
}
function probeMs(file) {
  const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert(!out.error && out.status === 0, `ffprobe failed on ${file}: ${out.error || out.stderr}`);
  return Math.round(Number(out.stdout) * 1000);
}
function runCue(args) {
  const out = spawnSync(cue, args, { env: { ...process.env, CUEREVIEW_DATA_DIR: dataRoot }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert(!out.error && out.status === 0, `cue ${args.join(' ')} failed: ${out.error || out.stderr}`);
  return out.stdout;
}
function cursorTrack(folder) {
  const file = path.join(folder, 'cursor.jsonl');
  assert(fs.existsSync(file), `cursor.jsonl is missing in ${folder}`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = JSON.parse(lines[0] || '{}');
  assert(header.format === 'cuereview-cursor' && header.version === 1 && header.source === 'window', `Unexpected cursor.jsonl header in ${folder}: ${lines[0]}`);
  assert(lines.length >= 2, `cursor.jsonl in ${folder} has no samples`);
  return { file, header, samples: lines.length - 1 };
}
async function waitForIdleSession(timeoutMs = 180000) {
  return until(async () => {
    const status = await invoke('get_recording_status');
    const session = await invoke('get_session', { id: sessionId });
    const busy = (session.takes || []).some(take => ['recording', 'finalizing', 'transcribing'].includes(take.status));
    return status.state === 'idle' && ['ready', 'error'].includes(session.status) && !busy && session;
  }, timeoutMs, 'Processing did not finish within the time limit', 250);
}
// One take through the UI: start with `button`, hold about TAKE_MS, check the dock, then Stop.
async function recordTake(take, button) {
  recording = true;
  await button.click();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  const started = Date.now();
  const status = await until(async () => { const s = await invoke('get_recording_status'); return s.state === 'recording' && s; }, 10000, `Take ${take} did not start`);
  sessionId ??= status.sessionId;
  assert(status.sessionId === sessionId, `Take ${take} recorded into another session (${status.sessionId})`);
  const dock = page.getByRole('group', { name: 'Recording controls', exact: true });
  await dock.getByRole('timer', { name: `Take ${take} elapsed time`, exact: true }).waitFor();
  const dockText = (await dock.innerText()).replace(/\s+/g, ' ').trim();
  const observed = { takeIndex: status.takeIndex ?? null, takeOffsetMs: status.takeOffsetMs ?? null, dockText };
  if (take >= 2) {
    assert(status.takeIndex === take, `Recording status reports take ${status.takeIndex}, not ${take}`);
    assert(!/Take \d|Adding to this session/.test(dockText), `The dock repeats the take: ${dockText}`);
    assert(await page.getByText(/Adding to this session/).count() === 0, 'A caption under the dock repeats the take');
    observed.liveDivider = await transcriptPane().getByText(`Take ${take} · recording`, { exact: true }).count() > 0;
    observed.copyForAgentDisabled = await page.getByRole('button', { name: 'Copy for agent', exact: true }).evaluateAll(buttons => buttons.every(button => button.disabled));
  }
  await delay(Math.max(0, TAKE_MS - (Date.now() - started)));
  await shot(`recording-take-${take}`);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const session = await waitForIdleSession();
  recording = false;
  assert(session.status === 'ready', `Take ${take} finished as ${session.status}: ${session.error}`);
  return { status: observed, session };
}

async function launch() {
  for (const tool of ['ffplay', 'ffprobe']) {
    const out = spawnSync(tool, ['-version'], { windowsHide: true });
    assert(!out.error && out.status === 0, `${tool} is not on PATH; install FFmpeg (full build) first.`);
  }
  for (const file of [executable, cue]) assert(fs.existsSync(file), `Build the release app and CLI first: ${file} is missing`);
  let occupied = false;
  try { await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) }); occupied = true; } catch {}
  assert(!occupied, 'CDP 9229 is occupied; refusing to attach to an app this script does not own.');
  fs.mkdirSync(path.join(dataRoot, 'projects'), { recursive: true });
  // The source window: a moving test pattern this script owns, closed in cleanup.
  player = spawn('ffplay', ['-hide_banner', '-loglevel', 'error', '-an', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-window_title', windowTitle, '-x', '1280', '-y', '720'], { windowsHide: false, stdio: 'ignore' });
  result.ownedPlayerPid = player.pid;
  secondPlayer = spawn('ffplay', ['-hide_banner', '-loglevel', 'error', '-an', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=30', '-window_title', secondTitle, '-x', '960', '-y', '540'], { windowsHide: false, stdio: 'ignore' });
  result.ownedSecondPlayerPid = secondPlayer.pid;
  appLog = fs.openSync(path.join(output, 'owned-app.log'), 'a');
  const env = withSpeechPath({ ...process.env, CUEREVIEW_DATA_DIR: dataRoot, CUEREVIEW_MODEL: path.join(appData, 'models', 'ggml-base.bin'), CUEREVIEW_VAD_MODEL: path.join(appData, 'models', 'ggml-silero-v6.2.0.bin'), WEBVIEW2_USER_DATA_FOLDER: path.join(dataRoot, 'profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9229' });
  app = spawn(executable, [], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', appLog, appLog] });
  result.ownedAppPid = app.pid;
  await until(async () => {
    assert(app.exitCode === null, `The owned app exited during startup (${app.exitCode})`);
    try { return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  }, 20000, 'The owned app did not open its CDP port within 20 seconds');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
}
// Chooses the ffplay window titled `title` in the recording bar, without system audio, and, the
// first time, with no microphone.
async function chooseSource(title, first) {
  const source = await until(async () => {
    assert(player.exitCode === null && secondPlayer.exitCode === null, 'An ffplay window exited');
    return (await invoke('list_sources')).find(item => item.kind === 'window' && item.name === title);
  }, 20000, `The ffplay window "${title}" never appeared as a capture source`, 500);
  (result.sources ??= []).push(source);
  if (first) await page.getByRole('heading', { level: 1, name: 'New recording', exact: true }).waitFor();
  const sources = page.getByRole('group', { name: 'Capture sources', exact: true });
  const option = sources.getByRole('button', { name: title, exact: true });
  await page.locator('.source-trigger').click();
  await sources.waitFor();
  if (!await option.count()) {
    await page.getByRole('button', { name: 'Refresh capture devices', exact: true }).click();
    await option.waitFor();
  }
  await option.click();
  await until(async () => await page.locator('.source-trigger').getAttribute('title') === title, 5000, `The source picker did not select "${title}"`);
  await page.locator('.source-trigger').click();
  const systemAudio = page.getByLabel('Include system audio', { exact: true });
  if (await systemAudio.isChecked()) await systemAudio.uncheck();
  await page.keyboard.press('Escape');
  if (!first) return source;
  await page.locator('.mic-trigger').click();
  await page.getByRole('group', { name: 'Microphone options', exact: true }).getByRole('button', { name: 'No microphone', exact: true }).click();
  result.observations.previewFrame = await until(() => page.evaluate(() => document.querySelector('.preview-image')?.naturalWidth || 0), 10000, 'no preview').catch(() => 0);
  return source;
}
// The review video's file and length, or null without one.
const loadedVideo = () => page.evaluate(() => {
  const video = document.querySelector('video');
  return video ? { src: decodeURIComponent(video.currentSrc || video.src || ''), durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0 } : null;
});
const TAKE_2_VIDEO = /[\\/]takes[\\/]2[\\/]video\.mp4/;

async function main() {
  fs.mkdirSync(output, { recursive: true });
  console.error(`verify-takes records the windows "${windowTitle}" and "${secondTitle}" for about ${TAKE_MS / 1000} s each (no microphone, no system audio). Nothing leaves this machine.`);
  await launch();
  await chooseSource(windowTitle, true);

  const first = await recordTake(1, page.getByRole('button', { name: 'Record', exact: true }));
  result.observations.take1 = first.status;
  const recordMore = page.getByRole('button', { name: 'Record more', exact: true });
  await recordMore.waitFor();
  await until(() => recordMore.isEnabled(), 20000, 'Record more did not become available after take 1');
  const baseMs = first.session.durationMs;
  // Take 2 records another window, chosen in the review bar.
  const secondSource = await chooseSource(secondTitle, false);
  const second = await recordTake(2, recordMore);
  result.checks.dockShowedTake2 = second.status;
  assert(Math.abs(second.status.takeOffsetMs - baseMs) <= 50, `Take 2 started at ${second.status.takeOffsetMs} ms instead of the ${baseMs} ms recorded before it`);

  // One session, two takes, offsets from the validated base duration.
  const sessions = await invoke('list_sessions', { projectId: null });
  assert(sessions.length === 1 && sessions[0].id === sessionId, `Record more created ${sessions.length} sessions`);
  const session = await invoke('get_session', { id: sessionId });
  const takes = session.takes || [];
  assert(takes.length === 2 && takes[0].index === 1 && takes[1].index === 2, `Session takes: ${JSON.stringify(takes)}`);
  assert(takes.every(take => take.status === 'ready'), `Takes are not ready: ${JSON.stringify(takes.map(take => take.status))}`);
  assert(takes[0].offsetMs === 0 && takes[0].folder === '.' && takes[1].folder === 'takes/2', `Take folders or first offset: ${JSON.stringify(takes)}`);
  assert(Math.abs(takes[1].offsetMs - (takes[0].offsetMs + takes[0].durationMs)) <= 50, `Take 2 offset ${takes[1].offsetMs} does not follow take 1 (${takes[0].durationMs} ms)`);
  for (const take of takes) assert(take.durationMs >= TAKE_MS - 1500 && take.durationMs <= TAKE_MS + 4000, `Take ${take.index} lasts ${take.durationMs} ms, not about ${TAKE_MS} ms`);
  result.checks.takes = takes.map(({ index, offsetMs, durationMs, status, folder }) => ({ index, offsetMs, durationMs, status, folder }));

  assert(takes[1].sourceId === secondSource.id, `Take 2 recorded ${takes[1].sourceId}, not ${secondSource.id}`);

  // Each take keeps its own video; nothing is joined.
  const sessionDir = path.join(dataRoot, 'sessions', sessionId);
  const files = [path.join(sessionDir, 'video.mp4'), path.join(sessionDir, 'takes', '2', 'video.mp4')];
  const ownMs = files.map(probeMs);
  takes.forEach((take, index) => assert(Math.abs(ownMs[index] - take.durationMs) <= 250, `Take ${take.index}'s video lasts ${ownMs[index]} ms, not its ${take.durationMs} ms`));
  const sizes = files.map(probeSize);
  assert(sizes[0].width !== sizes[1].width, `The two windows recorded at one size: ${JSON.stringify(sizes)}`);
  const videos = session.videos || [];
  assert(session.formatVersion === 2 && videos.length === 2 && videos[0].take === 1 && videos[0].startMs === 0 && videos[1].take === 2 && videos[1].startMs === takes[1].offsetMs, `Session videos: ${JSON.stringify(videos)}`);
  assert(Math.abs(session.durationMs - (takes[1].offsetMs + ownMs[1])) <= 250, `The session lasts ${session.durationMs} ms, not both takes`);
  result.checks.takeVideos = { probedMs: ownMs, sizes, videos, sessionMs: session.durationMs };
  result.observations.take2Folder = fs.readdirSync(path.join(sessionDir, 'takes', '2')).sort();
  result.observations.strayTemporaryFiles = fs.readdirSync(sessionDir).filter(name => /^video\..*\.tmp\.mp4$/.test(name));

  // The saved transcript marks both takes, and the review shows the Take 2 divider.
  const transcript = await invoke('get_transcript', { id: sessionId });
  assert(JSON.stringify(transcript.takes) === JSON.stringify([{ index: 1, startMs: 0 }, { index: 2, startMs: takes[1].offsetMs }]), `Transcript takes: ${JSON.stringify(transcript.takes)}`);
  const divider = `Take 2 · ${clock(takes[1].offsetMs)}`;
  await transcriptPane().getByText(divider, { exact: true }).waitFor();
  // The player opens on take 1's video; seeking into take 2 loads take 2's, and back again.
  const take1Video = await until(async () => { const video = await loadedVideo(); return video?.durationMs && video; }, 20000, 'The review video did not load');
  assert(!TAKE_2_VIDEO.test(take1Video.src) && Math.abs(take1Video.durationMs - ownMs[0]) <= 250, `The review opened ${JSON.stringify(take1Video)}, not take 1's video`);
  await page.getByRole('slider', { name: 'Playback position', exact: true }).focus();
  await page.keyboard.press('End');
  const take2Video = await until(async () => { const video = await loadedVideo(); return video && TAKE_2_VIDEO.test(video.src) && video.durationMs && video; }, 20000, "Seeking to the end did not load take 2's video");
  assert(Math.abs(take2Video.durationMs - ownMs[1]) <= 250, `Take 2's video in the player lasts ${take2Video.durationMs} ms`);
  await page.keyboard.press('Home');
  await until(async () => { const video = await loadedVideo(); return video && !TAKE_2_VIDEO.test(video.src); }, 20000, "Seeking back did not load take 1's video");
  await shot('review-two-takes');
  result.checks.reviewUi = { divider, take1Video, take2Video };

  // A frame in take 2 comes from take 2's video, at its size.
  const frame = JSON.parse(runCue(['frame', sessionId, '--at-ms', String(takes[1].offsetMs + 1000)]));
  assert(frame.width === sizes[1].width && frame.height === sizes[1].height, `cue frame in take 2 is ${frame.width}x${frame.height}, not take 2's ${sizes[1].width}x${sizes[1].height}`);
  result.checks.take2Frame = frame;

  // The CLI view of the same session.
  const lines = runCue(['transcript', sessionId, '--segments']).split(/\r?\n/).filter(Boolean);
  const dividers = [`── Take 1 · 0:00 ──`, `── Take 2 · ${clock(takes[1].offsetMs)} ──`];
  assert(dividers.every(line => lines.includes(line)), `cue transcript --segments lacks the take dividers:\n${lines.join('\n')}`);
  const info = JSON.parse(runCue(['info', sessionId]));
  assert(info.takes?.length === 2, 'cue info does not list both takes');
  result.checks.cliSegments = lines;

  // A cursor track per take.
  result.checks.cursor = [cursorTrack(sessionDir), cursorTrack(path.join(sessionDir, 'takes', '2'))];

  assert(!result.pageErrors.length, `WebView errors: ${result.pageErrors.join('; ')}`);
  result.passed = true;
}

async function cleanup() {
  if (page && (recording || sessionId)) {
    try {
      const status = await invoke('get_recording_status');
      if (status.state === 'recording' && (!sessionId || status.sessionId === sessionId)) {
        await invoke('stop_recording');
        result.cleanup.stoppedRecording = true;
      }
      // Closing is blocked while recording or processing, so let the stopped take finish first.
      await until(async () => (await invoke('get_recording_status')).state === 'idle', 120000, 'not idle').catch(error => { result.cleanup.idleError = error.message; });
    } catch (error) { result.cleanup.stopError = String(error); }
  }
  if (browser) await browser.close().catch(() => {});
  if (app && app.exitCode === null && !process.argv.includes('--keep-open')) {
    try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${app.pid}).CloseMainWindow() | Out-Null`], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch (error) { result.cleanup.closeError = String(error); }
    for (let i = 0; i < 100 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) { result.cleanup.forcedOwnedAppPid = app.pid; app.kill(); }
    result.cleanup.appExitCode = app.exitCode;
  } else if (app && app.exitCode === null) app.unref();
  for (const [name, owned] of [['playerClosed', player], ['secondPlayerClosed', secondPlayer]]) {
    if (!owned || owned.exitCode !== null) continue;
    owned.kill();
    for (let i = 0; i < 30 && owned.exitCode === null; i++) await delay(100);
    result.cleanup[name] = owned.exitCode !== null;
  }
  if (appLog !== undefined) fs.closeSync(appLog);
}

main()
  .catch(error => { result.passed = false; result.failure = error.stack || String(error); return page ? shot('failure').catch(() => {}) : undefined; })
  .finally(async () => {
    await cleanup();
    if (result.cleanup.stopError || result.cleanup.forcedOwnedAppPid) result.passed = false;
    result.sessionId = sessionId;
    result.finishedAt = new Date().toISOString();
    const summary = JSON.stringify(result, null, 2);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'verification.json'), summary);
    fs.writeFileSync(path.join(workspace, 'test-results', 'takes-verification.json'), summary);
    console.log(summary);
    process.exitCode = result.passed ? 0 : 1;
  });
