// Attended: records an authorized Android or Quest device in an owned, isolated desktop app while a
// person pulls its USB cable and plugs it back in. Records the device and the default microphone,
// and plays the app's drop and return sounds through the PC's speakers.
// CUEREVIEW_TEST_DEVICE=<adb serial> node scripts/verify-device-reconnect.cjs [--manual]
// Controls are found by the accessible names in src/workspace/types.ts (NAMES).
const { chromium } = require('playwright');
const { appData, withSpeechPath } = require('./test-env.cjs');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const workspace = path.resolve(__dirname, '..');
const serial = process.env.CUEREVIEW_TEST_DEVICE;
if (!serial) throw Error('Set CUEREVIEW_TEST_DEVICE to an authorized ADB serial.');
const runId = crypto.randomUUID();
const dataRoot = path.join(workspace, '.local', 'device-reconnect-data', runId);
const output = path.join(workspace, 'test-results', 'device-reconnect', runId);
const endpoint = 'http://127.0.0.1:9227';
/** How long the person has to pull the cable, and to plug it back in. */
const WAIT_MS = 180000;
/** --manual: the person starts and stops the take; the app stays open afterwards. */
const MANUAL = process.argv.includes('--manual');
const MANUAL_MS = 30 * 60000;
const result = { runId, dataRoot, serial, timeline: [], checks: {}, pageErrors: [] };
let child, browser, page, ownsRecording = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const assert = (value, message) => { if (!value) throw Error(message); };
const say = text => console.log(`[${new Date().toLocaleTimeString()}] ${text}`);

/** A mono WAV's samples as floats, from 16-bit PCM or 32-bit float. */
function readWav(file) {
  const bytes = fs.readFileSync(file);
  let at = 12, format, channels, rate, bits, data;
  while (at < bytes.length - 8) {
    const id = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') { format = bytes.readUInt16LE(at + 8); channels = bytes.readUInt16LE(at + 10); rate = bytes.readUInt32LE(at + 12); bits = bytes.readUInt16LE(at + 22); }
    if (id === 'data') { data = bytes.subarray(at + 8, at + 8 + Math.min(size, bytes.length - at - 8)); break; }
    at += 8 + size + (size % 2);
  }
  const width = bits / 8, frames = Math.floor(data.length / width / channels), samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const offset = i * width * channels;
    samples[i] = format === 3 ? data.readFloatLE(offset) : data.readInt16LE(offset) / 32768;
  }
  return { samples, rate };
}
/** Power at `frequency` in `samples[from, to)` (Goertzel). */
function power(samples, rate, from, to, frequency) {
  const k = 2 * Math.cos(2 * Math.PI * frequency / rate);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) { const s = samples[i] + k * s1 - s2; s2 = s1; s1 = s; }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / Math.max(1, to - from);
}
/**
 * How strongly the two tones of a sound stand out of the microphone track in the 2 s after `ms`:
 * the best 150 ms window's power at each tone over the power at nearby frequencies.
 */
function toneScore(track, ms, tones) {
  const { samples, rate } = track;
  const window = Math.round(rate * 0.15), step = Math.round(rate * 0.025);
  return tones.map(tone => {
    let best = 0;
    for (let from = Math.round(rate * ms / 1000); from + window < Math.min(samples.length, Math.round(rate * (ms + 2000) / 1000)); from += step) {
      const signal = power(samples, rate, from, from + window, tone);
      const noise = (power(samples, rate, from, from + window, tone * 1.19) + power(samples, rate, from, from + window, tone * 0.84)) / 2;
      best = Math.max(best, signal / Math.max(noise, 1e-12));
    }
    return Math.round(best * 10) / 10;
  });
}
/** The brightest of 32×32 averaged pixels of `video` at `seconds`, 0 to 255. */
function brightest(video, seconds) {
  const ffmpeg = process.env.CUEREVIEW_FFMPEG || 'ffmpeg';
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-ss', seconds.toFixed(3), '-i', video, '-frames:v', '1', '-vf', 'scale=32:32', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 20 });
  return Math.max(...raw);
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  try {
    let occupied = false;
    try { await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) }); occupied = true; } catch {}
    assert(!occupied, 'CDP 9227 is occupied; refusing to attach to an unowned app.');
    const env = withSpeechPath({ ...process.env, CUEREVIEW_DATA_DIR: dataRoot, CUEREVIEW_MODEL: path.join(appData, 'models', 'ggml-base.bin'), CUEREVIEW_VAD_MODEL: path.join(appData, 'models', 'ggml-silero-v6.2.0.bin'), CUEREVIEW_DTW_MODEL: 'base', WEBVIEW2_USER_DATA_FOLDER: path.join(dataRoot, 'profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9227' });
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
    const record = page.getByRole('button', { name: 'Record', exact: true });
    await record.waitFor();
    for (let i = 0; i < 100 && !await record.isEnabled(); i++) await delay(100);
    const source = (await invoke('list_sources')).find(item => item.id === `android:${serial}`);
    assert(source?.available, 'The device is not authorized in the application.');
    await page.locator('.source-trigger').click();
    await page.getByRole('group', { name: 'Capture sources', exact: true }).getByRole('button', { name: source.name, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.preview-image')?.naturalWidth > 100, null, { timeout: 30000 });
    const dock = page.getByRole('group', { name: 'Recording controls', exact: true });
    if (MANUAL) {
      say('READY. Click Record in the test app, pull the cable, plug it back in, then click Stop.');
      const began = Date.now();
      while ((await invoke('get_recording_status')).state !== 'recording') {
        assert(Date.now() - began < MANUAL_MS, 'Nothing was recorded within 30 minutes.');
        await delay(250);
      }
    } else {
      ownsRecording = true;
      await record.click();
      await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 30000 });
    }
    result.sessionId = (await invoke('get_recording_status')).sessionId;
    say(MANUAL ? 'Recording started.' : 'RECORDING. Pull the device\'s USB cable now.');
    // Follows the device until the take stops (manual) or until it has dropped and come back.
    let last = 'connected', shotWhileGone = false;
    const began = Date.now();
    while (true) {
      const status = await invoke('get_recording_status');
      if (status.state !== 'recording') break;
      if (status.device !== last) {
        result.timeline.push({ device: status.device, elapsedMs: status.elapsedMs });
        say(`device: ${status.device} at ${(status.elapsedMs / 1000).toFixed(1)} s`);
        last = status.device;
        if (last === 'reconnecting' && !shotWhileGone) {
          shotWhileGone = true;
          await delay(1000);
          result.checks.dockWhileGone = (await dock.innerText()).replace(/\s+/g, ' ');
          await page.screenshot({ path: path.join(output, 'reconnecting.png') });
        }
        if (last === 'connected') {
          // The preview's stream ended with the device and starts again with it.
          const back = await page.waitForFunction(() => document.querySelector('.preview-image')?.naturalWidth > 100, null, { timeout: 20000 }).then(() => true, () => false);
          (result.checks.previewAfterReturn ??= []).push(back);
          say(back ? 'Preview is live again.' : 'Preview did not come back within 20 s.');
          await page.screenshot({ path: path.join(output, 'reconnected.png') });
        }
      }
      if (status.error) result.timeline.push({ error: status.error, elapsedMs: status.elapsedMs });
      if (!MANUAL && result.timeline.some(item => item.device === 'connected')) {
        say('Device recorded again. Recording 10 s more, then Stop.');
        await delay(10000);
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        break;
      }
      assert(Date.now() - began < (MANUAL ? MANUAL_MS : WAIT_MS * 2), 'The take ran out of time.');
      await delay(100);
    }
    say('Stopped. Finishing the recording.');
    const stopped = Date.now();
    let session;
    for (let i = 0; i < 7200; i++) {
      const status = await invoke('get_recording_status');
      session = await invoke('get_session', { id: result.sessionId });
      if (status.state === 'idle' && ['ready', 'error'].includes(session.status)) break;
      await delay(250);
    }
    ownsRecording = false;
    result.checks.stopSeconds = (Date.now() - stopped) / 1000;
    result.checks.session = { status: session.status, error: session.error, durationMs: session.durationMs, deviceGaps: session.deviceGaps };
    say(`Session ${session.status} after ${result.checks.stopSeconds.toFixed(1)} s; gaps ${JSON.stringify(session.deviceGaps ?? [])}`);
    assert(session.status === 'ready', `The session is not ready: ${session.status} ${session.error ?? ''}`);
    const drops = result.timeline.filter(item => item.device === 'reconnecting').length;
    assert((session.deviceGaps?.length ?? 0) === drops, `Expected ${drops} gap(s): ${JSON.stringify(session.deviceGaps)}`);
    const timing = JSON.parse(fs.readFileSync(path.join(session.folderPath, 'capture-timing.json'), 'utf8'));
    result.checks.timing = timing;
    const video = session.videoPath;
    result.checks.brightness = (session.deviceGaps ?? []).map(gap => ({
      gap,
      beforeGap: brightest(video, Math.max(0.5, gap.startMs / 1000 - 2)),
      gapMiddle: brightest(video, (gap.startMs + gap.endMs) / 2000),
      afterGap: gap.endMs + 3000 < session.durationMs ? brightest(video, gap.endMs / 1000 + 3) : null,
    }));
    for (const item of result.checks.brightness) assert(item.gapMiddle <= 20, `A gap is not black: ${JSON.stringify(item)}`);
    const leftovers = fs.readdirSync(session.folderPath).filter(name => /^native-video\./.test(name));
    result.checks.leftovers = leftovers;
    assert(!leftovers.length, `Native intermediates remain: ${leftovers}`);
    const mic = path.join(session.folderPath, 'mic.wav');
    if (fs.existsSync(mic)) {
      const track = readWav(mic);
      // A score well above 1 means the tone stands out of its neighbours in the microphone.
      result.checks.sounds = {
        changes: result.timeline.filter(item => item.device).map(item => ({
          device: item.device,
          elapsedMs: item.elapsedMs,
          score: toneScore(track, item.elapsedMs - 500, item.device === 'reconnecting' ? [659.25, 440] : [523.25, 783.99]),
        })),
        note: 'Heard only through speakers the microphone picks up; scores near 1 are inconclusive, not a failure.',
      };
    }
    // In review; with --manual the person may already be playing it, or in another menu.
    if (!MANUAL) await page.getByRole('button', { name: 'Play', exact: true }).or(page.getByRole('button', { name: 'Pause', exact: true })).waitFor();
    await page.screenshot({ path: path.join(output, 'review.png') });
    result.checks.header = (await page.locator('.cr-session-header').innerText()).replace(/\s+/g, ' ');
    assert((result.checks.previewAfterReturn ?? []).every(Boolean), 'The preview did not start again after the device returned.');
    assert(!result.pageErrors.length, 'Desktop page errors occurred.');
    result.passed = true;
  } catch (error) {
    result.error = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    if (page && ownsRecording) await invoke('get_recording_status').then(status => status.state === 'recording' ? invoke('stop_recording') : undefined).catch(error => { result.cleanupError = String(error); });
    if (MANUAL && child) child.unref();
    else if (child && child.exitCode === null) {
      try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`], { windowsHide: true, stdio: 'ignore' }); } catch {}
      for (let i = 0; i < 300 && child.exitCode === null; i++) await delay(100);
      result.cleanup = { exitCode: child.exitCode, stillRunning: child.exitCode === null };
      if (child.exitCode === null) { result.passed = false; process.exitCode = 1; child.unref(); }
    }
    if (browser) await browser.close().catch(() => {});
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
