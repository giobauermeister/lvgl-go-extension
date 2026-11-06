import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** LVGL Pro installs a versioned WASM archive alongside its public LVGL headers. */
export function editorResourcesDirectory(platform = process.platform, home = os.homedir(), env = process.env): string {
  const config = platform === 'win32' ? env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(config, 'lvgl-editor', 'resources');
}

export async function resolveLvglLibrary(version: string, explicit?: string, resources = editorResourcesDirectory()): Promise<string> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unsupported LVGL version: ${version}`);
  const directory = explicit ?? path.join(resources, `v${version}`, 'libs');
  const headers = path.join(directory, 'include', 'lvgl');
  try {
    const header = await readFile(path.join(headers, 'lv_version.h'), 'utf8');
    const actual = ['MAJOR', 'MINOR', 'PATCH'].map(part => header.match(new RegExp(`#define\\s+LVGL_VERSION_${part}\\s+(\\d+)`))?.[1]).join('.');
    if (actual !== version) throw new Error(`Library version ${actual} does not match project version ${version}.`);
    await readFile(path.join(headers, 'lvgl.h'));
    // 9.6 moved the bundled configuration into the public config directory.
    await readFile(path.join(headers, 'config', 'lv_conf.h')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return readFile(path.join(headers, 'lv_conf.h'));
    });
    if (!await isWasmArchive(path.join(directory, 'lib', 'liblvgl.a'))) throw new Error('liblvgl.a is not a WebAssembly archive.');
  } catch (error) {
    throw new Error(`Cannot use LVGL Pro ${version} at ${directory}. Open the project in LVGL Pro to install its matching resources, or set runtime.lvglLibraryDir. ${String(error)}`);
  }
  return directory;
}

/** Read just archive/member headers, skipping the archive symbol/name tables. */
async function isWasmArchive(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(60);
    await handle.read(buffer, 0, 8, 0);
    if (buffer.toString('ascii', 0, 8) !== '!<arch>\n') return false;
    for (let offset = 8; offset + 60 <= size;) {
      if ((await handle.read(buffer, 0, 60, offset)).bytesRead !== 60 || buffer.toString('ascii', 58) !== '`\n') return false;
      const name = buffer.toString('ascii', 0, 16).trim();
      const length = Number(buffer.toString('ascii', 48, 58).trim());
      if (!Number.isSafeInteger(length) || length < 0 || offset + 60 + length > size) return false;
      if (name !== '/' && name !== '//' && name !== '/SYM64/' && !name.startsWith('__.SYMDEF')) {
        const nameSize = name.startsWith('#1/') ? Number(name.slice(3)) : 0;
        if (!Number.isSafeInteger(nameSize) || nameSize < 0 || nameSize + 4 > length) return false;
        await handle.read(buffer, 0, 4, offset + 60 + nameSize);
        return buffer.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])) || buffer.subarray(0, 4).equals(Buffer.from([66, 67, 192, 222]));
      }
      offset += 60 + length + length % 2;
    }
    return false;
  } finally { await handle.close(); }
}
