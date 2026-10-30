import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const revision = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'; // whisper.cpp b5454
const source = join(root, '.local/whisper-source');
const build = join(root, '.local/whisper-build');
const destination = join(root, '.local/bundle-tools/tools/whisper-b5454');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result;
}
mkdirSync(source, { recursive: true });
if (!existsSync(join(source, '.git'))) {
  run('git', ['init', source]);
  run('git', ['-C', source, 'fetch', '--depth=1', 'https://github.com/ggml-org/whisper.cpp.git', revision]);
  run('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD']);
}
const actual = run('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim();
if (actual !== revision) throw new Error(`Unexpected whisper source revision ${actual}. Use a clean .local/whisper-source directory.`);
// The plain build runs on any processor of the target; on x64 it needs only SSE4.2 (every x64
// processor since about 2011), as ggml's BMI2 default is off too. On Windows and Linux x64 a second build for AVX2, FMA, F16C and BMI2 goes to the avx2
// subfolder; the app runs it where the processor has all four (src-tauri/src/deps.rs), about eight
// times faster.
const plain = ['-DGGML_AVX=OFF', '-DGGML_AVX2=OFF', '-DGGML_FMA=OFF', '-DGGML_F16C=OFF', '-DGGML_SSE42=ON', '-DGGML_BMI2=OFF'];
const vector = ['-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON', '-DGGML_SSE42=ON', '-DGGML_BMI2=ON'];
const builds = [{ dir: build, flags: plain, out: destination }];
if (process.arch === 'x64' && process.platform !== 'darwin') builds.push({ dir: `${build}-avx2`, flags: vector, out: join(destination, 'avx2') });
const suffix = process.platform === 'win32' ? '.exe' : '';
for (const { dir, flags, out } of builds) {
  run('cmake', ['-S', source, '-B', dir, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DGGML_METAL=OFF', '-DGGML_OPENMP=OFF', ...flags, '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', ...(process.platform === 'darwin' ? ['-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0'] : [])]);
  run('cmake', ['--build', dir, '--config', 'Release', '--parallel', '3', '--target', 'whisper-cli', 'whisper-vad-speech-segments']);
  mkdirSync(out, { recursive: true });
  for (const name of ['whisper-cli', 'whisper-vad-speech-segments']) {
    const binary = name + suffix;
    const candidates = [join(dir, 'bin', binary), join(dir, 'bin/Release', binary)];
    const path = candidates.find(existsSync);
    if (!path) throw new Error(`Missing speech binary: ${binary}`);
    run(path, ['-h']);
    copyFileSync(path, join(out, binary));
  }
}
copyFileSync(join(source, 'LICENSE'), join(destination, 'LICENSE-whisper.txt'));
if (existsSync(join(source, 'ggml/LICENSE'))) copyFileSync(join(source, 'ggml/LICENSE'), join(destination, 'LICENSE-ggml.txt'));
const target = run('rustc', ['-vV'], { encoding: 'utf8', stdio: 'pipe' }).stdout.match(/^host: (.+)$/m)?.[1];
writeFileSync(join(destination, 'runtime.json'), JSON.stringify({ version: 'b5454', revision, target }, null, 2));
