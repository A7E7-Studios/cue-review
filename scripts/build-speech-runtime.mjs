import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const revision = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'; // whisper.cpp b5454
const source = join(root, '.local/whisper-source');
const build = join(root, '.local/whisper-build');
const destination = join(root, '.local/bundle-tools/tools/whisper-b5454');
let requireVulkan = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--require-vulkan') requireVulkan = true;
  else throw new Error(`Unknown argument: ${arg}`);
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result;
}
const pathKey = env => Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'Path';
const withPath = (env, dir) => ({ ...env, [pathKey(env)]: `${dir}${delimiter}${env[pathKey(env)] ?? ''}` });
function findOnPath(name, env) {
  return (env[pathKey(env)] ?? '').split(delimiter).filter(Boolean).map(dir => join(dir.replace(/^"|"$/g, ''), name)).find(existsSync);
}
// On Windows x64 a third build for graphics cards goes to the vulkan subfolder when the Vulkan SDK
// is installed: the avx2 flags plus GGML_VULKAN, only whisper-cli (the speech detector runs on the
// processor build). It imports vulkan-1.dll, so it starts only where a Vulkan loader is installed.
const vulkanSdk = process.env.VULKAN_SDK;
const vulkanWanted = process.platform === 'win32' && process.arch === 'x64';
const vulkanReady = vulkanWanted && Boolean(vulkanSdk) && existsSync(vulkanSdk);
if (vulkanWanted && requireVulkan && !vulkanReady) throw new Error(`--require-vulkan: no Vulkan SDK at VULKAN_SDK (${vulkanSdk || 'unset'}). Install it from https://vulkan.lunarg.com/sdk/home and set VULKAN_SDK to its folder.`);
// Ninja needs the Visual Studio C++ x64 environment; Ninja and CMake come from PATH, else from
// Visual Studio's own CMake tools.
function vulkanToolchain() {
  let env = { ...process.env };
  let studio = process.env.VSINSTALLDIR;
  if (process.env.VSCMD_ARG_TGT_ARCH !== 'x64') {
    const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
    if (!existsSync(vswhere)) throw new Error(`The Vulkan build needs Visual Studio with the C++ x64 tools; vswhere is missing: ${vswhere}`);
    studio = run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim().split(/\r?\n/)[0];
    const vcvars = studio && join(studio, 'VC/Auxiliary/Build/vcvars64.bat');
    if (!vcvars || !existsSync(vcvars)) throw new Error('The Vulkan build needs Visual Studio with the C++ x64 tools (vcvars64.bat).');
    // vcvars64.bat calls vswhere from PATH; cmd /u writes the environment as UTF-16, so non-ASCII paths survive.
    const listed = spawnSync('cmd.exe', ['/d', '/u', '/s', '/c', `"call "${vcvars}" >nul && set"`], { env: withPath(process.env, dirname(vswhere)), encoding: 'utf16le', windowsVerbatimArguments: true, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    if (listed.error) throw listed.error;
    if (listed.status !== 0) throw new Error(`${vcvars} exited with ${listed.status}`);
    env = Object.fromEntries(listed.stdout.split(/\r?\n/).map(line => line.match(/^([^=]+)=(.*)$/)).filter(Boolean).map(([, key, value]) => [key, value]));
  }
  if (!findOnPath('cl.exe', env)) throw new Error('The Visual Studio x64 environment has no cl.exe.');
  const bundled = name => [studio && join(studio, 'Common7/IDE/CommonExtensions/Microsoft/CMake', name)].find(path => path && existsSync(path));
  const cmake = findOnPath('cmake.exe', env) ?? bundled('CMake/bin/cmake.exe');
  const ninja = findOnPath('ninja.exe', env) ?? bundled('Ninja/ninja.exe');
  if (!cmake || !ninja) throw new Error(`The Vulkan build needs ${cmake ? 'Ninja' : 'CMake'} on PATH or Visual Studio's C++ CMake tools.`);
  // The shader generator's sub-build finds Ninja on PATH and, without CC and CXX, could pick another compiler.
  return { cmake, ninja, env: { ...withPath(env, dirname(ninja)), CC: 'cl', CXX: 'cl' } };
}
const toolchain = vulkanReady ? vulkanToolchain() : undefined;
mkdirSync(source, { recursive: true });
if (!existsSync(join(source, '.git'))) {
  run('git', ['init', source]);
  run('git', ['-C', source, 'fetch', '--depth=1', 'https://github.com/ggml-org/whisper.cpp.git', revision]);
  run('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD']);
}
const actual = run('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim();
if (actual !== revision) throw new Error(`Unexpected whisper source revision ${actual}. Use a clean .local/whisper-source directory.`);
// The plain build runs on any processor of the target; on x64 it needs only SSE4.2 (every x64
// processor since about 2011), because this script turns ggml's BMI2 default off. On Windows and Linux x64 a second build for AVX2, FMA, F16C and BMI2 goes to the avx2
// subfolder; the app runs it where the processor has all four (src-tauri/src/deps.rs), about eight
// times faster.
const plain = ['-DGGML_AVX=OFF', '-DGGML_AVX2=OFF', '-DGGML_FMA=OFF', '-DGGML_F16C=OFF', '-DGGML_SSE42=ON', '-DGGML_BMI2=OFF'];
const vector = ['-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON', '-DGGML_SSE42=ON', '-DGGML_BMI2=ON'];
const common = ['-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DGGML_METAL=OFF', '-DGGML_OPENMP=OFF'];
const tail = ['-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'];
const builds = [{ dir: build, flags: plain, out: destination, variant: 'plain' }];
if (process.arch === 'x64' && process.platform !== 'darwin') builds.push({ dir: `${build}-avx2`, flags: vector, out: join(destination, 'avx2'), variant: 'avx2' });
const suffix = process.platform === 'win32' ? '.exe' : '';
for (const { dir, flags, out } of builds) {
  run('cmake', ['-S', source, '-B', dir, ...common, ...flags, ...tail, ...(process.platform === 'darwin' ? ['-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0'] : [])]);
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
const vulkanOut = join(destination, 'vulkan');
rmSync(vulkanOut, { recursive: true, force: true });
if (toolchain) {
  // Outside the checkout and short: the shader generator's sub-build nests about 170 characters deep, past Windows' 260-character paths under a deep checkout.
  const dir = join(tmpdir(), `cuereview-vulkan-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`);
  if (dir.length > 80) throw new Error(`The Vulkan build folder ${dir} is too long for the shader sub-build's paths; point TEMP at a shorter folder.`);
  const options = { env: toolchain.env };
  run(toolchain.cmake, ['-S', source, '-B', dir, '-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${toolchain.ninja}`, ...common, ...vector, '-DGGML_VULKAN=ON', ...tail], options);
  run(toolchain.cmake, ['--build', dir, '--config', 'Release', '--parallel', '3', '--target', 'whisper-cli'], options);
  const path = join(dir, 'bin/whisper-cli.exe');
  if (!existsSync(path)) throw new Error(`Missing speech binary: ${path}`);
  if (existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/vulkan-1.dll'))) run(path, ['-h']);
  else console.log('No Vulkan loader (vulkan-1.dll) on this computer: the Vulkan whisper-cli was built but not started.');
  mkdirSync(vulkanOut, { recursive: true });
  copyFileSync(path, join(vulkanOut, 'whisper-cli.exe'));
  builds.push({ variant: 'vulkan' });
}
// whisper.cpp's own 11 s of speech; the app times it to choose the device that transcribes.
copyFileSync(join(source, 'samples/jfk.wav'), join(destination, 'jfk.wav'));
copyFileSync(join(source, 'LICENSE'), join(destination, 'LICENSE-whisper.txt'));
if (existsSync(join(source, 'ggml/LICENSE'))) copyFileSync(join(source, 'ggml/LICENSE'), join(destination, 'LICENSE-ggml.txt'));
const target = run('rustc', ['-vV'], { encoding: 'utf8', stdio: 'pipe' }).stdout.match(/^host: (.+)$/m)?.[1];
writeFileSync(join(destination, 'runtime.json'), JSON.stringify({ version: 'b5454', revision, target, variants: builds.map(({ variant }) => variant) }, null, 2));
