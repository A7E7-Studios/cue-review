// Shared environment for scripts/verify-*.cjs: where the local speech runtime lives.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
/** The app's default data root. Settings → Install transcription puts its models and tools here. */
const appData = path.join(localAppData, 'CueReview');
const RUNTIME = 'whisper-b5454';
const exe = name => process.platform === 'win32' ? `${name}.exe` : name;

/**
 * The whisper.cpp runtime folder: CUEREVIEW_WHISPER_DIR when set (it must contain
 * whisper-cli), else the first folder with whisper-cli of the runtime the app downloads
 * (%LOCALAPPDATA%\CueReview\tools\whisper-b5454) and the runtime the installer bundles
 * (%LOCALAPPDATA%\Programs\CueReview\tools\whisper-b5454). Null when there is none.
 */
function whisperDir() {
  const override = process.env.CUEREVIEW_WHISPER_DIR;
  if (override) {
    if (!fs.existsSync(path.join(override, exe('whisper-cli')))) throw Error(`CUEREVIEW_WHISPER_DIR has no ${exe('whisper-cli')}: ${override}`);
    return override;
  }
  return [path.join(appData, 'tools', RUNTIME), path.join(localAppData, 'Programs', 'CueReview', 'tools', RUNTIME)]
    .find(dir => fs.existsSync(path.join(dir, exe('whisper-cli')))) ?? null;
}

/**
 * A copy of `env` with the speech runtime first on PATH. Windows environments may spell
 * the key `Path`; the copy keeps exactly one key, so a child never sees two PATH values.
 */
function withSpeechPath(env = process.env) {
  const copy = { ...env };
  const key = Object.keys(copy).find(name => name.toUpperCase() === 'PATH');
  const current = key ? copy[key] : '';
  if (key) delete copy[key];
  const dir = whisperDir();
  copy.PATH = [dir, current].filter(Boolean).join(path.delimiter);
  return copy;
}

module.exports = { localAppData, appData, whisperDir, withSpeechPath };
