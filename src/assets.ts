import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const configFiles = new Set(['lvgl-go.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'compile_commands.json', 'cmakepresets.json', 'cmakeuserpresets.json']);
const assetExtensions = new Set(['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.bin', '.json', '.ttf', '.otf', '.woff', '.woff2', '.ico', '.mp3', '.wav']);

/** Configuration and dependency trees are not browser output or preload assets. */
export function isPrivateFile(relative: string): boolean {
  return relative.replace(/\\/g, '/').split('/').some(part => part.startsWith('.') || part.toLowerCase() === 'node_modules' || configFiles.has(part.toLowerCase()));
}

/** Emscripten embeds the entire preload directory, bypassing HTTP file filters. */
export async function validateAssets(directory: string): Promise<void> {
  if (!(await lstat(directory)).isDirectory()) throw new Error('runtime.assetsDir must be a directory, not a symlink.');
  const visit = async (folder: string): Promise<void> => {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      const relative = path.relative(directory, file);
      if (isPrivateFile(relative) || item.isSymbolicLink() || (!item.isDirectory() && (!item.isFile() || !assetExtensions.has(path.extname(item.name).toLowerCase())))) {
        throw new Error(`runtime.assetsDir contains a private or unsupported file: ${relative}. Use a dedicated folder containing only public images, fonts, media and data assets.`);
      }
      if (item.isDirectory()) await visit(file);
    }
  };
  await visit(directory);
}
