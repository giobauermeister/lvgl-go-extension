import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export interface Command {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface Config {
  managedBuild: boolean;
  runtime: { lvglLibraryDir?: string; lvglSourceDir?: string; defaults?: string; initialScreen?: string; startScreen?: string; width?: number; height?: number; assetsDir?: string; assetPath?: string };
  projectDir: string;
  outputDir: string;
  entry: string;
  build: Command[];
  watch: boolean;
  debounceMs: number;
  appUrl: string;
  tunnel: { command?: string };
}

export function expand(value: string, variables: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const resolved = name.startsWith('env:') ? variables[name] ?? process.env[name.slice(4)] : variables[name];
    if (resolved === undefined) throw new Error(`Unresolved variable: ${name}`);
    return resolved;
  });
}

export async function readConfig(workspaceFolder: string, extensionDir: string, cacheDirectory?: string): Promise<Config> {
  const raw = await readFile(path.join(workspaceFolder, 'lvgl-go.json'), 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  const variables: Record<string, string> = { workspaceFolder, extensionDir };
  if (raw.generate !== undefined) throw new Error('Remove generate from lvgl-go.json. LVGL Pro maintains the C export; LVGL Go builds it.');
  if (raw.server !== undefined) throw new Error('Remove server from lvgl-go.json. LVGL Go manages the preview address, port and HTTPS tunnel automatically.');
  if (raw.tunnel?.enabled !== undefined) throw new Error('Remove tunnel.enabled from lvgl-go.json. LVGL Go manages its HTTPS tunnel automatically.');
  const resolve = (value: string) => path.resolve(workspaceFolder, expand(value, variables));
  variables.projectDir = resolve(raw.projectDir ?? '.');
  const managedBuild = raw.build === undefined;
  const buildRoot = path.join(cacheDirectory ?? path.join(workspaceFolder, '.lvgl-go'), 'build');
  // CMake caches the absolute -S directory. Hosts such as Theia install every
  // extension release into a different directory, so sharing one cache across
  // releases causes CMAKE_HOME_DIRECTORY mismatches. Retain incremental builds
  // within an installation and leave older caches/explicit adapters untouched.
  const runnerKey = createHash('sha256').update(path.resolve(extensionDir, 'runtime')).digest('hex').slice(0, 16);
  variables.buildDir = managedBuild ? path.join(buildRoot, runnerKey) : buildRoot;
  const runtime = raw.runtime ?? {};
  for (const key of ['lvglLibraryDir', 'lvglSourceDir', 'defaults', 'assetsDir']) {
    if (runtime[key] !== undefined) runtime[key] = resolve(runtime[key]);
  }
  const configureArgs = ['cmake', '-S', '${extensionDir}/runtime', '-B', '${buildDir}', '-DUI_DIR=${projectDir}', '-DCMAKE_BUILD_TYPE=Release'];
  for (const [option, key] of Object.entries({ lvglLibraryDir: 'LVGL_LIBRARY_DIR', lvglSourceDir: 'LVGL_SOURCE_DIR', defaults: 'LVGL_GO_DEFAULTS', initialScreen: 'UI_INITIAL_SCREEN', width: 'UI_WIDTH', height: 'UI_HEIGHT', assetsDir: 'UI_ASSETS_DIR', assetPath: 'UI_ASSET_PATH' })) {
    if (runtime[option] !== undefined) configureArgs.push(`-D${key}=${runtime[option]}`);
  }
  raw.build ??= [
    { command: 'emcmake', args: configureArgs },
    { command: 'cmake', args: ['--build', '${buildDir}', '--parallel', String(Math.min(8, os.availableParallelism()))] }
  ];
  if (!Array.isArray(raw.build) || !raw.build.length) throw new Error('build must contain at least one command.');
  for (const step of raw.build) {
    if (typeof step.command !== 'string' || !step.command || !Array.isArray(step.args) || !step.args.every((arg: unknown) => typeof arg === 'string')) {
      throw new Error('Commands must contain a command string and an args array of strings.');
    }
    if (step.cwd !== undefined && typeof step.cwd !== 'string') throw new Error('Command cwd must be a string.');
    if (step.env !== undefined && (typeof step.env !== 'object' || step.env === null || !Object.values(step.env).every(v => typeof v === 'string'))) throw new Error('Command env values must be strings.');
  }
  const entry = raw.entry ?? 'index.html';
  if (typeof entry !== 'string' || path.isAbsolute(entry) || entry.split(/[\\/]/).some(p => p === '..') || !entry.endsWith('.html')) throw new Error('entry must be a relative HTML path inside outputDir.');
  const debounceMs = raw.debounceMs ?? 900;
  if (!Number.isInteger(debounceMs) || debounceMs < 100 || debounceMs > 60000) throw new Error('debounceMs must be between 100 and 60000.');
  const appUrl = raw.appUrl ?? 'https://go.bauertronix.com.br/app/';
  if (typeof appUrl !== 'string') throw new Error('appUrl must be an HTTPS URL ending in /app/. Omit it to use the default hosted app.');
  const url = new URL(appUrl);
  if (url.protocol !== 'https:' || url.pathname !== '/app/' || url.search || url.hash || url.username || url.password) throw new Error('appUrl must be an HTTPS URL ending in /app/, without a query, fragment or credentials.');
  // Preserve command placeholders: secrets are expanded only at execution time.
  const expandStep = (step: Command): Command => ({ ...step,
    command: expandNonSecret(step.command, variables),
    args: step.args.map(arg => expandNonSecret(arg, variables)),
    cwd: resolve(step.cwd ?? '${workspaceFolder}'),
    env: Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, expandNonSecret(value, variables)]))
  });
  return {
    managedBuild, runtime,
    projectDir: variables.projectDir,
    outputDir: resolve(raw.outputDir ?? '${buildDir}/bin'),
    entry,
    build: raw.build.map(expandStep),
    watch: raw.watch !== false,
    debounceMs,
    appUrl,
    tunnel: { command: raw.tunnel?.command ? expand(raw.tunnel.command, variables) : undefined }
  };
}

function expandNonSecret(value: string, variables: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => name.startsWith('env:') ? match : expand(match, variables));
}

export function shouldWatch(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  if (parts.some(p => /^(\.git|\.lvgl-go|node_modules|preview-bin|preview-build|bin|_deps|CMakeFiles|\.emscripten-cache)$/.test(p) || /^build($|[-_])/.test(p))) return false;
  return /\.(c|h|cc|cpp|cxx|hpp|cmake|png|jpg|jpeg|webp|gif|bin|ttf|otf|svg|json|defaults)$/.test(parts.at(-1)!) || ['CMakeLists.txt', 'project.xml'].includes(parts.at(-1)!);
}
