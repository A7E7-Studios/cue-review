// Verify the cue agent CLI (help, argument errors, segments, frames, rename, moments)
// against an isolated CUEREVIEW_DATA_DIR. Normal application data is never touched.
//
//   cargo build --bin cue            (from src-tauri; debug is the default)
//   node scripts/verify-cli.cjs [--release] [--keep]
//
// Sessions under test:
// - synthetic: FFmpeg lavfi video (3 s red, 3 s blue, 1280x720) plus a handwritten
//   two-take transcript.json, so every expected line and moment is exact;
// - pipeline (when present): a copy of the verify-pipeline.ps1 fixture, from
//   CUEREVIEW_TEST_FIXTURE or .local/pipeline-data named by test-results/pipeline-verification.json.
// The data folder lock is held by a separate process to prove that help and rename never take it.
// Prints a JSON summary, writes it to test-results/cli-verification.json, and exits 1 on failure.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const workspace = path.resolve(__dirname, '..');
const flags = process.argv.slice(2);
const profile = flags.includes('--release') ? 'release' : 'debug';
const executable = process.env.CUEREVIEW_CUE || path.join(workspace, 'src-tauri', 'target', profile, process.platform === 'win32' ? 'cue.exe' : 'cue');
const runId = crypto.randomUUID();
const dataRoot = path.join(workspace, '.local', 'cli-data', runId);
const result = { runId, executable, dataRoot, startedAt: new Date().toISOString(), sessions: {}, checks: {}, failures: [], passed: false };
const COMMANDS = ['projects', 'sessions', 'info', 'transcript', 'find', 'frame', 'frames', 'clip', 'rename', 'moments', 'transcribe', 'setup', 'sources', 'microphones', 'record'];

const assert = (condition, message) => { if (!condition) throw Error(message); };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function run(args, env = {}) {
  const child = spawnSync(executable, args, { env: { ...process.env, CUEREVIEW_DATA_DIR: dataRoot, ...env }, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (child.error) throw child.error;
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}
function ok(args, env) {
  const out = run(args, env);
  assert(out.status === 0, `cue ${args.join(' ')} exited ${out.status}: ${out.stderr.trim()}`);
  return out.stdout;
}
const json = (args, env) => JSON.parse(ok(args, env));
function fails(args, pattern, env) {
  const out = run(args, env);
  assert(out.status !== 0, `cue ${args.join(' ')} should fail`);
  assert(!out.stdout.trim(), `cue ${args.join(' ')} printed output while failing: ${out.stdout}`);
  assert(pattern.test(out.stderr), `cue ${args.join(' ')}: unexpected error ${JSON.stringify(out.stderr)}`);
  return out.stderr.trim();
}
function pngSize(file) {
  const bytes = fs.readFileSync(file);
  assert(bytes.subarray(1, 4).toString('latin1') === 'PNG', `${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
function tool(name, args) {
  const child = spawnSync(name, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert(!child.error && child.status === 0, `${name} failed: ${child.error || child.stderr}`);
  return child.stdout;
}
const probeMs = video => Math.round(Number(tool('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', video])) * 1000);
const segmentSeek = segment => typeof segment.words[0]?.seekMs === 'number' ? segment.words[0].seekMs : segment.startMs;
const exportsOf = id => { const dir = path.join(dataRoot, 'sessions', id, 'exports'); return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0; };

function writeSession(id, fields) {
  const folder = path.join(dataRoot, 'sessions', id);
  fs.mkdirSync(folder, { recursive: true });
  const session = { id, projectId: null, name: 'CLI verification', autoTitle: false, createdAt: new Date().toISOString(), durationMs: 0, status: 'ready', videoPath: path.join(folder, 'video.mp4'), folderPath: folder, error: null, sourceId: 'fixture:cli', microphoneId: null, systemAudio: false, ...fields };
  fs.writeFileSync(path.join(folder, 'session.json'), JSON.stringify(session, null, 2));
  return folder;
}
const word = (text, startMs, seekMs) => ({ text, startMs, endMs: startMs + 180, ...(seekMs === undefined ? {} : { seekMs }) });
function segment(id, words) {
  return { id, startMs: words[0].startMs, endMs: words[words.length - 1].endMs, text: ` ${words.map(w => w.text).join(' ')}`, words };
}
function syntheticSession() {
  const id = crypto.randomUUID();
  const folder = writeSession(id, { name: 'Synthetic two-take session' });
  const video = path.join(folder, 'video.mp4');
  tool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=10:d=3[a];color=c=blue:s=1280x720:r=10:d=3[b];[a][b]concat=n=2:v=1:a=0', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const durationMs = probeMs(video);
  const transcript = {
    segments: [
      segment('segment-0', [word('Open', 500), word('the', 700), word('library', 900, 1000), word('here.', 1500)]),
      segment('segment-1', [word('I', 2100), word('think', 2250), word('that', 2400), word('it', 2550), word('works.', 2700)]),
      segment('t2-segment-0', [word('Now', 3300, 3350), word('look', 3600), word('at', 3800), word('this', 4000), word('button,', 4200), word('over', 4400), word('there.', 4600)]),
      segment('t2-segment-1', [word('There', 5000), word('is', 5150), word('a', 5300), word('delay', 5400), word('this', 5600), word('time.', 5700)]),
    ],
    language: 'en', status: 'complete', error: null,
    takes: [{ index: 1, startMs: 0 }, { index: 2, startMs: 3000 }],
  };
  fs.writeFileSync(path.join(folder, 'transcript.json'), JSON.stringify(transcript, null, 2));
  writeSession(id, {
    name: 'Synthetic two-take session', durationMs,
    takes: [{ index: 1, offsetMs: 0, durationMs: 3000, status: 'ready', folder: '.', systemAudio: false }, { index: 2, offsetMs: 3000, durationMs: durationMs - 3000, status: 'ready', folder: 'takes/2', systemAudio: false }],
  });
  return { id, folder, durationMs, transcript };
}
function pipelineSession() {
  let fixture = process.env.CUEREVIEW_TEST_FIXTURE;
  if (!fixture) {
    const record = path.join(workspace, 'test-results', 'pipeline-verification.json');
    if (!fs.existsSync(record)) return null;
    fixture = path.join(workspace, '.local', 'pipeline-data', 'sessions', read(record).sessionId);
  }
  if (!['video.mp4', 'transcript.json', 'session.json'].every(file => fs.existsSync(path.join(fixture, file)))) return null;
  const id = crypto.randomUUID();
  const folder = writeSession(id, {});
  for (const file of ['video.mp4', 'transcript.json']) fs.copyFileSync(path.join(fixture, file), path.join(folder, file));
  const original = read(path.join(fixture, 'session.json'));
  writeSession(id, { ...original, id, projectId: null, name: 'Pipeline fixture copy', status: 'ready', error: null, folderPath: folder, videoPath: path.join(folder, 'video.mp4') });
  return { id, folder, source: fixture, durationMs: original.durationMs, transcript: read(path.join(folder, 'transcript.json')) };
}

// Holds <root>/.instance.lock the way another CueReview process would, until released.
function holdLock(root) {
  const file = path.join(root, '.instance.lock');
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f=[IO.File]::Open('${file.replace(/'/g, "''")}','OpenOrCreate','ReadWrite','ReadWrite'); $f.Lock(0,1); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Unlock(0,1); $f.Close()`], { windowsHide: true })
    : spawn('python3', ['-c', 'import fcntl,sys\nf=open(sys.argv[1],"a+")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\nsys.stdin.readline()', file]);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('The lock holder did not start')); }, 30000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`The lock holder exited early (${code}): ${output}`)); });
    child.stdout.on('data', data => {
      output += data;
      if (!output.includes('locked')) return;
      clearTimeout(timer);
      resolve(() => new Promise(done => {
        child.removeAllListeners('exit');
        child.on('exit', done);
        child.stdin.end();
        setTimeout(() => child.kill(), 5000).unref();
      }));
    });
  });
}

async function check(name, body) {
  try {
    result.checks[name] = (await body()) ?? true;
  } catch (error) {
    result.checks[name] = { failed: error.message };
    result.failures.push(name);
  }
}

async function main() {
  assert(fs.existsSync(executable), `Build the CLI first (cargo build --bin cue${profile === 'release' ? ' --release' : ''}): ${executable} is missing`);
  fs.mkdirSync(path.join(dataRoot, 'sessions'), { recursive: true });
  const synthetic = syntheticSession();
  const pipeline = pipelineSession();
  result.sessions = { synthetic: { id: synthetic.id, durationMs: synthetic.durationMs }, pipeline: pipeline ? { id: pipeline.id, source: pipeline.source } : 'not available; synthetic session only' };
  const sid = synthetic.id;

  await check('helpExitsZeroBeforeOpeningTheStore', () => {
    const untouched = path.join(dataRoot, 'never-created');
    const env = { CUEREVIEW_DATA_DIR: untouched };
    const overview = ok(['--help'], env);
    for (const args of [[], ['-h'], ['help'], ['help', '--help']]) assert(ok(args, env) === overview, `cue ${args.join(' ')} differs from cue --help`);
    for (const command of COMMANDS) assert(overview.includes(`cue ${command}`), `cue --help lacks ${command}`);
    for (const command of COMMANDS) {
      const help = ok([command, '--help'], env);
      assert(help.startsWith(`Usage: cue ${command}`), `cue ${command} --help: ${help.slice(0, 80)}`);
      assert(ok(['help', command], env) === help && ok([command, '-h'], env) === help, `${command} help forms differ`);
    }
    // Help wins even when the other arguments are missing or invalid.
    for (const args of [['frame', '--help'], ['frame', sid, '--bogus', '--help'], ['frames', sid, '--at-ms', '--help'], ['record', '--help'], ['rename', '--help']]) ok(args, env);
    fails(['frame', sid, '--bogus'], /Unknown option --bogus/, env);
    assert(!fs.existsSync(untouched), 'help or an argument error opened the store');
    const created = path.join(dataRoot, 'created-by-store');
    ok(['projects'], { CUEREVIEW_DATA_DIR: created });
    assert(fs.existsSync(path.join(created, 'sessions')), 'control: cue projects should open the store');
    return { commands: COMMANDS.length, helpForms: COMMANDS.length * 3 + 4 };
  });

  await check('helpAndRenameWithoutTheLock', async () => {
    const probe = crypto.randomUUID();
    writeSession(probe, { name: 'Lock probe', videoPath: null });
    const release = await holdLock(dataRoot);
    try {
      for (const args of [['record', '--help'], ['transcribe', '--help'], ['setup', '--install', '--help'], ['help', 'record']]) ok(args);
      // The lock is genuinely held: a locking command is refused before it touches the session.
      const refused = fails(['transcribe', probe], /already using this data folder|lock/i);
      assert(read(path.join(dataRoot, 'sessions', probe, 'session.json')).status === 'ready', 'refused transcribe changed the session');
      const renamed = json(['rename', sid, 'Renamed while the app holds the lock']);
      assert(renamed.name === 'Renamed while the app holds the lock' && renamed.autoTitle === false, 'rename did not apply under the lock');
      assert(json(['info', sid]).name === renamed.name, 'info does not show the new name');
      return { refused };
    } finally {
      await release();
    }
  });

  await check('unknownFlagsAndMissingValuesFail', () => {
    const before = exportsOf(sid);
    const errors = [
      fails(['frame', sid, '--at-ms', '0', '--bogus'], /Unknown option --bogus.*--help/),
      fails(['transcript', sid, '--segmnts'], /Unknown option --segmnts.*--help/),
      fails(['frames', sid, '--per-segment', '--max-wdth', '100'], /Unknown option --max-wdth/),
      fails(['projects', '--json'], /Unknown option --json/),
      fails(['frame', sid, '--at-ms'], /--at-ms needs a value.*--help/),
      fails(['frame', sid, '--output', '--at-ms', '5'], /--output needs a value/),
      fails(['frame', sid, '--at-ms', '1.5'], /non-negative integer/),
      fails(['frames', sid], /Missing --at-ms or --per-segment/),
      fails(['frames', sid, '--at-ms', '1', '--per-segment'], /not both/),
      fails(['moments', sid, '--max-width', '100'], /need --frames/),
      fails(['rename', sid], /Missing NAME/),
      fails(['rename', sid, 'two', 'words'], /Unexpected argument words/),
      fails(['nonsense'], /Unknown command nonsense/),
    ];
    assert(exportsOf(sid) === before, 'a rejected command wrote an export');
    return { rejected: errors.length };
  });

  await check('existingCommandsKeepTheirOutput', () => {
    assert(Array.isArray(json(['projects'])), 'projects is not an array');
    assert(json(['sessions']).some(s => s.id === sid), 'sessions lacks the synthetic session');
    const info = json(['info', sid]);
    assert(info.id === sid && info.takes.length === 2, 'info lost fields');
    const text = ok(['transcript', sid]).trimEnd().split(/\r?\n/);
    assert(JSON.stringify(text) === JSON.stringify(synthetic.transcript.segments.map(s => s.text)), 'plain transcript changed');
    const file = fs.readFileSync(path.join(synthetic.folder, 'transcript.json'), 'utf8');
    assert(JSON.stringify(json(['transcript', sid, '--json'])) === JSON.stringify(JSON.parse(file)), 'transcript --json changed without a cursor track');
    const found = json(['find', sid, '--phrase', 'look at']);
    assert(found.length === 1 && found[0].occurrence === 1 && found[0].startMs === 3600 && found[0].text === 'look at' && !('cursor' in found[0]), `find: ${JSON.stringify(found)}`);
    const frame = json(['frame', sid, '--phrase', 'look at', '--occurrence', '1']);
    assert(frame.timeMs === 3600 && fs.existsSync(frame.path), 'frame --phrase failed');
    assert(frame.width === 1280 && frame.height === 720 && frame.cursor === null && 'cursor' in frame, `frame lacks new fields: ${JSON.stringify(frame)}`);
    const clip = json(['clip', sid, '--start-ms', '0', '--end-ms', '1000']);
    assert(fs.existsSync(clip.path), 'clip failed');
    return { frame: Object.keys(frame) };
  });

  await check('segmentsFormat', () => {
    const expected = [
      '── Take 1 · 0:00 ──',
      '[00:00 | 500] Open the library here.',
      '[00:02 | 2100] I think that it works.',
      '── Take 2 · 0:03 ──',
      '[00:03 | 3350] Now look at this button, over there.',
      '[00:05 | 5000] There is a delay this time.',
    ];
    const lines = ok(['transcript', sid, '--segments']).trimEnd().split(/\r?\n/);
    assert(JSON.stringify(lines) === JSON.stringify(expected), `segments:\n${lines.join('\n')}`);
    if (!pipeline) return { synthetic: lines.length };
    const real = ok(['transcript', pipeline.id, '--segments']).trimEnd().split(/\r?\n/);
    assert(real.length === pipeline.transcript.segments.length, 'pipeline segments count');
    real.forEach((line, i) => {
      const seek = segmentSeek(pipeline.transcript.segments[i]);
      assert(new RegExp(`^\\[\\d{2}:\\d{2} \\| ${seek}\\] \\S`).test(line), `pipeline line ${i}: ${line}`);
    });
    return { synthetic: lines.length, pipeline: real };
  });

  await check('framesBatchWithMaxWidth', () => {
    const batch = json(['frames', sid, '--at-ms', '0,1500,3500,5900', '--max-width', '320']);
    assert(JSON.stringify(batch.map(f => f.timeMs)) === '[0,1500,3500,5900]', 'frames times');
    for (const frame of batch) {
      assert(JSON.stringify(Object.keys(frame)) === '["path","timeMs","width","height","cursor"]', `frames keys: ${Object.keys(frame)}`);
      assert(frame.width === 320 && frame.height === 180 && frame.cursor === null, `frames size: ${JSON.stringify(frame)}`);
      const size = pngSize(frame.path);
      assert(size.width === frame.width && size.height === frame.height, 'reported size differs from the PNG');
      assert(frame.path.startsWith(path.join(synthetic.folder, 'exports')), 'default frames folder');
    }
    const dir = path.join(dataRoot, 'frames out');
    const perSegment = json(['frames', sid, '--per-segment', '--max-width', '640', '--mark-cursor', '--output-dir', dir]);
    const expected = synthetic.transcript.segments.map(s => [s.id, segmentSeek(s)]);
    assert(JSON.stringify(perSegment.map(f => [f.segmentId, f.timeMs])) === JSON.stringify(expected), `per-segment: ${JSON.stringify(perSegment.map(f => [f.segmentId, f.timeMs]))}`);
    assert(perSegment.every(f => path.dirname(f.path) === dir && pngSize(f.path).width === 640 && f.height === 360), 'per-segment output');
    const narrow = json(['frame', sid, '--at-ms', '500', '--max-width', '200', '--mark-cursor']);
    assert(narrow.width === 200 && narrow.height % 2 === 0 && Math.abs(narrow.height - 112.5) <= 2, `frame --max-width: ${narrow.width}x${narrow.height}`);
    const wide = json(['frame', sid, '--at-ms', '500', '--max-width', '4000']);
    assert(wide.width === 1280 && wide.height === 720, 'max-width must never upscale');
    fails(['frames', sid, '--at-ms', `0,${synthetic.durationMs}`, '--output-dir', path.join(dataRoot, 'never')], /within the recording/);
    assert(!fs.existsSync(path.join(dataRoot, 'never')), 'an invalid batch wrote files');
    const detail = { batch: batch.length, perSegment: perSegment.length, narrow: `${narrow.width}x${narrow.height}` };
    if (pipeline) {
      const real = json(['frames', pipeline.id, '--per-segment', '--max-width', '640', '--mark-cursor']);
      assert(real.length === pipeline.transcript.segments.length, 'pipeline per-segment count');
      assert(real.every(f => f.width <= 640 && pngSize(f.path).height === f.height), 'pipeline per-segment size');
      detail.pipeline = real.map(f => `${f.timeMs}:${f.width}x${f.height}`);
    }
    return detail;
  });

  await check('exportsNeverOverwrite', () => {
    const taken = path.join(dataRoot, 'taken.png');
    fs.writeFileSync(taken, 'keep');
    fails(['frame', sid, '--at-ms', '1000', '--output', taken], /Output exists/);
    const takenClip = path.join(dataRoot, 'taken.mp4');
    fs.writeFileSync(takenClip, 'keep');
    fails(['clip', sid, '--start-ms', '0', '--end-ms', '1000', '--output', takenClip], /Output exists/);
    assert(fs.readFileSync(taken, 'utf8') === 'keep' && fs.readFileSync(takenClip, 'utf8') === 'keep', 'an existing file was changed');
    const dir = path.join(dataRoot, 'repeat');
    const args = ['frames', sid, '--at-ms', '1000,1000,4000', '--output-dir', dir];
    const first = json(args);
    const hashes = first.map(f => hash(f.path));
    const second = json(args);
    assert(new Set([...first, ...second].map(f => f.path)).size === 6, 'repeated exports reused a path');
    assert(first.every((f, i) => hash(f.path) === hashes[i]), 'a second batch changed an earlier frame');
    assert(fs.readdirSync(dir).length === 6, 'unexpected files in the output folder');
    return { files: 6 };
  });

  await check('rename', () => {
    const dashed = json(['rename', sid, '--', '-draft-']);
    assert(dashed.name === '-draft-', 'rename after -- failed');
    fails(['rename', sid, ' '], /between 1 and 120 characters/);
    const final = json(['rename', sid, 'Synthetic two-take session (renamed)']);
    assert(final.name === 'Synthetic two-take session (renamed)' && json(['sessions']).find(s => s.id === sid).name === final.name, 'rename not persisted');
    return { name: final.name };
  });

  await check('moments', () => {
    const moments = json(['moments', sid]);
    const summary = moments.map(m => [m.segmentId, m.term, m.seekMs]);
    const expected = [['segment-0', 'here', 1500], ['t2-segment-0', 'look at this', 3600], ['t2-segment-0', 'over there', 4400]];
    assert(JSON.stringify(summary) === JSON.stringify(expected), `moments: ${JSON.stringify(summary)}`);
    for (const m of moments) {
      const text = synthetic.transcript.segments.find(s => s.id === m.segmentId).text.trim();
      assert(m.text === text && m.cursor === null && Array.isArray(m.clicks) && m.clicks.length === 0 && !('frame' in m), `moment fields: ${JSON.stringify(m)}`);
    }
    const framed = json(['moments', sid, '--frames', '--max-width', '320', '--mark-cursor']);
    assert(framed.length === 3 && framed.every(m => fs.existsSync(m.frame) && pngSize(m.frame).width === 320), 'moments --frames');
    const detail = { synthetic: summary };
    if (pipeline) {
      const terms = json(['moments', pipeline.id]).map(m => m.term);
      assert(terms.includes('here') && terms.includes('this'), `pipeline moments: ${terms}`);
      detail.pipeline = terms;
    }
    return detail;
  });

  result.passed = result.failures.length === 0;
}

main()
  .catch(error => { result.failures.push('setup'); result.error = error.stack || error.message; })
  .finally(() => {
    result.finishedAt = new Date().toISOString();
    if (result.passed && !flags.includes('--keep')) {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      result.dataRoot = `${dataRoot} (removed)`;
    }
    const summary = JSON.stringify(result, null, 2);
    fs.mkdirSync(path.join(workspace, 'test-results'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'test-results', 'cli-verification.json'), summary);
    console.log(summary);
    process.exitCode = result.passed ? 0 : 1;
  });
