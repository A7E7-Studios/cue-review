// Exercise actual CLI dependency/process failures against copies of a known fixture.
// No system tools, installed models, or normal application data are modified.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const workspace = path.resolve(__dirname, '..');
const runId = crypto.randomUUID();
const output = path.join(workspace, 'test-results', 'failures', runId);
const dataRoot = path.join(workspace, '.local', 'failure-data', runId);
const executable = path.join(workspace, 'src-tauri', 'target', 'release', 'cue.exe');
const pipeline = JSON.parse(fs.readFileSync(path.join(workspace, 'test-results', 'pipeline-verification.json')));
const fixture = process.env.CUEREVIEW_TEST_FIXTURE || path.join(workspace, '.local', 'pipeline-data', 'sessions', pipeline.sessionId);
const { appData: local, whisperDir, withSpeechPath } = require('./test-env.cjs');
const env = withSpeechPath({ ...process.env, CUEREVIEW_DATA_DIR: dataRoot, CUEREVIEW_MODEL: path.join(local, 'models', 'ggml-base.bin'), CUEREVIEW_VAD_MODEL: path.join(local, 'models', 'ggml-silero-v6.2.0.bin') });
const result = { runId, dataRoot, executable, whisperDir: whisperDir(), startedAt: new Date().toISOString(), checks: {} };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file));
const assert = (condition, message) => { if (!condition) throw Error(message); };
function run(args, overrides = {}) {
  const process = spawnSync(executable, args, { env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (process.error) throw process.error;
  return { status: process.status, stdout: process.stdout, stderr: process.stderr };
}
function copyFixture(name) {
  const id = crypto.randomUUID(), folder = path.join(dataRoot, 'sessions', id);
  fs.mkdirSync(folder, { recursive: true });
  for (const file of ['video.mp4', 'mic.wav']) fs.copyFileSync(path.join(fixture, file), path.join(folder, file));
  const session = { ...read(path.join(fixture, 'session.json')), id, name, folderPath: folder, videoPath: path.join(folder, 'video.mp4'), status: 'error', error: 'Verification fixture awaiting retry' };
  fs.writeFileSync(path.join(folder, 'session.json'), JSON.stringify(session));
  return { id, folder, videoHash: hash(path.join(folder, 'video.mp4')) };
}
function assertFailure(name, fixture, outcome, pattern, persisted = false) {
  assert(outcome.status !== 0, `${name} returned success`);
  assert(pattern.test(outcome.stderr), `${name} returned no actionable expected error: ${outcome.stderr}`);
  assert(!outcome.stdout.trim(), `${name} emitted success JSON`);
  assert(!fs.existsSync(path.join(fixture.folder, 'transcript.json')), `${name} fabricated a transcript`);
  assert(hash(path.join(fixture.folder, 'video.mp4')) === fixture.videoHash, `${name} changed original video`);
  const session = read(path.join(fixture.folder, 'session.json'));
  assert(session.status !== 'processing' && session.status !== 'recording', `${name} left a stuck job`);
  if (persisted) assert(session.status === 'error' && pattern.test(session.error), `${name} failed to persist its error`);
  result.checks[name] = { ...outcome, sessionStatus: session.status, sessionError: session.error, videoUnchanged: true, transcriptAbsent: true };
}
fs.mkdirSync(output, { recursive: true });
try {
  for (const dir of ['projects', 'sessions', 'models', 'tools']) fs.mkdirSync(path.join(dataRoot, dir), { recursive: true });
  const missingSetup = run(['setup'], { PATH: '' });
  assert(missingSetup.status === 0, 'Setup inspection failed instead of reporting state');
  const setup = JSON.parse(missingSetup.stdout);
  assert(!setup.ready && setup.dependencies.every(dependency => !dependency.available), 'Missing dependencies were reported ready');
  result.checks.missingSetup = setup;

  const missing = copyFixture('Missing dependencies');
  assertFailure('missingProbe', missing, run(['transcribe', missing.id], { PATH: '' }), /ffprobe is not installed/);
  const frame = run(['frame', missing.id, '--at-ms', '100'], { PATH: '' });
  assertFailure('missingEncoder', missing, frame, /ffmpeg is not installed/);

  const badAudio = copyFixture('Invalid audio');
  fs.writeFileSync(path.join(badAudio.folder, 'mic.wav'), 'Deliberately invalid test audio');
  const audioHash = hash(path.join(badAudio.folder, 'mic.wav'));
  assertFailure('encoderExit', badAudio, run(['transcribe', badAudio.id]), /Processing failed.*Invalid data|Processing failed.*Error opening/is, true);
  assert(hash(path.join(badAudio.folder, 'mic.wav')) === audioHash, 'Failed conversion changed input audio');

  const invalidVad = path.join(dataRoot, 'models', 'invalid-vad.bin');
  fs.writeFileSync(invalidVad, Buffer.alloc(120000));
  const badVad = copyFixture('Invalid detection model');
  assertFailure('detectorExit', badVad, run(['transcribe', badVad.id], { CUEREVIEW_VAD_MODEL: invalidVad }), /Local speech processing failed.*vad\.log/is, true);

  const invalidSpeech = path.join(dataRoot, 'models', 'invalid-speech.bin');
  fs.writeFileSync(invalidSpeech, Buffer.alloc(1100000));
  const badSpeech = copyFixture('Invalid speech model');
  assertFailure('recognizerExit', badSpeech, run(['transcribe', badSpeech.id], { CUEREVIEW_MODEL: invalidSpeech }), /Processing failed.*failed to (load|initialize)/is, true);
  result.passed = true;
} catch (error) {
  result.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(workspace, 'test-results', 'failure-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
