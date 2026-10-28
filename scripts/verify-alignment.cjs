// Real local transcription and phrase-to-frame check across ten seconds of silence.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const workspace = path.resolve(__dirname, '..');
const runId = crypto.randomUUID();
const dataRoot = path.join(workspace, '.local', 'alignment-data', runId);
const output = path.join(workspace, 'test-results', 'alignment', runId);
const sessionId = crypto.randomUUID();
const sessionDir = path.join(dataRoot, 'sessions', sessionId);
const pipeline = JSON.parse(fs.readFileSync(path.join(workspace, 'test-results', 'pipeline-verification.json')));
const sourceAudio = path.join(workspace, '.local', 'pipeline-data', 'sessions', pipeline.sessionId, 'mic.wav');
const local = path.join(process.env.LOCALAPPDATA, 'CueReview');
const env = { ...process.env, CUEREVIEW_DATA_DIR: dataRoot, CUEREVIEW_MODEL: path.join(local, 'models', 'ggml-base.bin'), CUEREVIEW_VAD_MODEL: path.join(local, 'models', 'ggml-silero-v6.2.0.bin'), CUEREVIEW_DTW_MODEL: 'base', PATH: `${path.join(local, 'tools', 'whisper-b5454')};${process.env.PATH}` };
const cue = path.join(workspace, 'src-tauri', 'target', 'release', 'cue.exe');
const result = { runId, dataRoot, sessionId, sessionDir, startedAt: new Date().toISOString() };
const assert = (value, message) => { if (!value) throw Error(message); };
function run(tool, args, binary = false) {
  const child = spawnSync(tool, args, { env, encoding: binary ? undefined : 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw child.error || Error(`${tool} failed (${child.status}): ${child.stderr}`);
  return child.stdout;
}
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(sessionDir, { recursive: true });
fs.mkdirSync(path.join(dataRoot, 'projects'), { recursive: true });
try {
  const createdAt = new Date().toISOString();
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', sourceAudio, '-af', 'adelay=10000:all=1', '-ar', '16000', '-ac', '1', path.join(sessionDir, 'mic.wav')]);
  const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path.join(sessionDir, 'mic.wav')]));
  assert(duration > 10 && duration < 60, 'Unexpected fixture duration');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=10', '-f', 'lavfi', '-i', `color=c=blue:s=320x180:r=30:d=${duration - 10}`, '-i', path.join(sessionDir, 'mic.wav'), '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path.join(sessionDir, 'video.mp4')]);
  const session = { id: sessionId, projectId: null, name: 'New recording', autoTitle: true, createdAt, durationMs: Math.round(duration * 1000), status: 'error', error: 'Alignment fixture awaiting transcription', videoPath: path.join(sessionDir, 'video.mp4'), folderPath: sessionDir, sourceId: 'fixture:color-transition', microphoneId: 'fixture:synthesized-speech', systemAudio: false };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session));
  const transcript = JSON.parse(run(cue, ['transcribe', sessionId]));
  const renamed = JSON.parse(run(cue, ['info', sessionId]));
  assert(renamed.projectId === null && renamed.autoTitle && /library/i.test(renamed.name) && renamed.name.length <= 60, 'Projectless transcript-derived title was not saved.');
  assert(JSON.parse(run(cue, ['projects'])).length === 0, 'Transcription created an implicit project.');
  result.automaticTitle = renamed.name;
  const first = transcript.segments.flatMap(segment => segment.words)[0];
  assert(first && /when/i.test(first.text), 'Opening word was lost');
  assert(first.seekMs >= 10000 && first.seekMs <= 10500, `Opening word seek anchor is not at the spoken scene: ${JSON.stringify(first)}`);
  const matches = JSON.parse(run(cue, ['find', sessionId, '--phrase', 'When']));
  assert(matches[0].seekMs === first.seekMs, 'Phrase lookup lost the aligned anchor');
  const frame = JSON.parse(run(cue, ['frame', sessionId, '--phrase', 'When', '--occurrence', '1']));
  assert(frame.timeMs === first.seekMs, 'Phrase frame ignored the anchor');
  const pixel = [...run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', frame.path, '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], true)];
  assert(pixel[2] > 180 && pixel[0] < 40 && pixel[1] < 40, `Phrase frame came from the red silence scene: ${pixel}`);
  Object.assign(result, { passed: true, firstWord: first, phrase: matches[0], frame, pixel, fixture: 'Red video during ten seconds of silence, blue video during synthesized speech; real local DTW inference' });
} catch (error) {
  result.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(workspace, 'test-results', 'alignment-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
