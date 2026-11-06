import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// This parser reads the project's declarative metadata only. It has no Editor dependency.
const sax = require('sax') as { parser(strict: boolean): {
  onopentag?: (node: { name: string; attributes: Record<string, string> }) => void;
  onclosetag?: () => void; oncomment?: (text: string) => void; ondoctype?: () => void;
  write(text: string): { close(): void };
} };

interface Element { name: string; attributes: Record<string, string>; children: Element[]; fallback?: Element[] }
export interface HardwareButton { x: number; y: number; width: number; height: number; key: string; name: string; help: string; color: string }
export interface DisplayTarget {
  name: string; width: number; height: number; radius: number;
  overlay?: { image: string; x: number; y: number; hidden: boolean; buttons: HardwareButton[] };
}

function parse(xml: string, comments = true): Element {
  const root: Element = { name: '', attributes: {}, children: [] }, stack = [root];
  const parser = sax.parser(true);
  parser.onopentag = node => {
    const child: Element = { ...node, children: [] };
    stack.at(-1)!.children.push(child); stack.push(child);
  };
  parser.onclosetag = () => { stack.pop(); };
  parser.ondoctype = () => { throw new Error('Project metadata must not contain a DOCTYPE.'); };
  parser.oncomment = text => {
    // Only a standalone overlay declaration in a display comment is a fallback.
    if (!comments || stack.at(-1)?.name !== 'display' || !/^\s*<overlay\b/.test(text)) return;
    const fallback = parse('<fallback>' + text + '</fallback>', false).children[0].children;
    if (fallback.length !== 1 || fallback[0].name !== 'overlay') return;
    (stack.at(-1)!.fallback ??= []).push(fallback[0]);
  };
  parser.write(xml).close();
  return root;
}

const keyNames: Record<string, string> = { arrow_up: 'ArrowUp', arrow_down: 'ArrowDown', arrow_left: 'ArrowLeft', arrow_right: 'ArrowRight',
  enter: 'Enter', esc: 'Escape', escape: 'Escape', backspace: 'Backspace', delete: 'Delete', tab: 'Tab',
  page_up: 'PageUp', page_down: 'PageDown', home: 'Home', end: 'End', space: ' ' };
function number(value: string | undefined, label: string, minimum = 0): number {
  const n = value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < minimum || n > 8192) throw new Error('Invalid overlay/display ' + label + '.');
  return n;
}

/** Parse active targets, retaining commented overlay declarations as compatibility fallbacks. */
export function readDisplayTargets(xml: string): DisplayTarget[] {
  const project = parse(xml).children.find(node => node.name === 'project');
  const targets = project?.children.find(node => node.name === 'targets')?.children.filter(node => node.name === 'target') ?? [];
  // Older/simple exports have a display directly under the project.
  const owners = targets.length ? targets : project ? [project] : [];
  return owners.flatMap((target, index) => {
    const display = target.children.find(node => node.name === 'display');
    if (!display) return [];
    const width = number(display.attributes.width ?? '800', 'width', 1), height = number(display.attributes.height ?? '480', 'height', 1);
    if (width * height > 16 * 1024 * 1024) throw new Error('Display target is too large.');
    const radius = number(display.attributes.radius ?? '0', 'radius');
    const result: DisplayTarget = { name: target.attributes.name || 'display_' + (index + 1), width, height, radius };
    const overlay = display.children.find(node => node.name === 'overlay') ?? display.fallback?.[0];
    if (overlay) {
      if (!overlay.attributes.image_src_path) throw new Error('Overlay image_src_path is missing.');
      const buttons = overlay.children.filter(node => node.name === 'button_overlay').map(node => {
        const a = node.attributes, key = keyNames[a.key] ?? a.key;
        if (!key || (!Object.values(keyNames).includes(key) && !/^[\x20-\x7e]$/.test(key))) throw new Error('Unsupported overlay button key: ' + a.key);
        const color = a.color ? a.color.replace(/^0x/i, '#') : '#a5edbd';
        if (!/^#[\da-f]{6}$/i.test(color)) throw new Error('Invalid overlay button color.');
        return { x: number(a.x ?? '0', 'button x'), y: number(a.y ?? '0', 'button y'), width: number(a.w, 'button width', 1), height: number(a.h, 'button height', 1),
          key, name: a.name || key, help: a.help || a.name || key, color };
      });
      result.overlay = { image: overlay.attributes.image_src_path, x: number(overlay.attributes.viewport_x ?? '0', 'viewport_x'),
        y: number(overlay.attributes.viewport_y ?? '0', 'viewport_y'), hidden: overlay.attributes.hidden === 'true', buttons };
    }
    return [result];
  });
}

/** Publish only referenced frame images and normalized public metadata. */
export async function prepareOverlays(projectDir: string, outputDir: string, entry: string, display?: { width: number; height: number }): Promise<void> {
  const targets = readDisplayTargets(await readFile(path.join(projectDir, 'project.xml'), 'utf8'));
  const output = path.join(outputDir, path.dirname(entry), 'lvgl-go-overlay');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const [index, target] of targets.entries()) {
    if (!target.overlay) continue;
    const relative = target.overlay.image.replace(/\\/g, '/').replace(/^\.\//, '');
    if (path.posix.isAbsolute(relative) || relative.includes(':') || relative.split('/').some(part => part === '..' || part.startsWith('.'))) {
      throw new Error('Overlay image must be a relative file inside the project.');
    }
    const extension = path.extname(relative).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(extension)) throw new Error('Unsupported hardware frame image format.');
    let source = projectDir;
    for (const part of relative.split('/')) {
      source = path.join(source, part);
      if ((await lstat(source)).isSymbolicLink()) throw new Error('Overlay image paths must not contain symlinks.');
    }
    if (!(await lstat(source)).isFile()) throw new Error('Overlay image is not a file.');
    const name = 'frame-' + index + extension;
    await copyFile(source, path.join(output, name));
    target.overlay.image = name;
  }
  const initial = display ? targets.findIndex(target => target.width === display.width && target.height === display.height) : targets.length ? 0 : -1;
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ version: 1, initial, targets }));
}
