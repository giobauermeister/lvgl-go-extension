import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config';
import { resolveLvglLibrary } from './lvgl';
import { validateAssets } from './assets';
import { prepareOverlays } from './overlays';

export async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

/** Locate the project owning an open XML/C file, including files outside a workspace root. */
export async function nearestProject(fileOrDirectory: string): Promise<string | undefined> {
  let directory = fileOrDirectory;
  for (;;) {
    if (await exists(path.join(directory, 'project.xml'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export interface ProjectInfo {
  directory: string;
  name: string;
  lvglVersion: string;
  width: number;
  height: number;
  initialScreen?: string;
  screens: string[];
  permanentScreens: string[];
}

export async function inspectProject(directory: string): Promise<ProjectInfo> {
  const xml = await readFile(path.join(directory, 'project.xml'), 'utf8');
  const project = xml.match(/<project\b[^>]*>/)?.[0] ?? '';
  const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`))?.[1];
  let name = (attribute(project, 'name') ?? path.basename(directory)).replace(/[^A-Za-z0-9_]/g, '_');
  if (!await exists(path.join(directory, `${name}_gen.c`))) {
    const candidates = (await readdir(directory)).filter(file => file.endsWith('_gen.c'));
    if (candidates.length === 1) name = candidates[0].slice(0, -6);
  }
  for (const file of ['CMakeLists.txt', 'file_list_gen.cmake', `${name}.h`, `${name}_gen.c`]) {
    if (!await exists(path.join(directory, file))) throw new Error(`Generate C in LVGL Pro first: ${file} is missing from ${directory}.`);
  }
  if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error('The exported UI prefix is not a valid C identifier.');
  const display = xml.match(/<display\b[^>]*>/)?.[0] ?? '';
  const generated = await readFile(path.join(directory, `${name}_gen.c`), 'utf8');
  // Editor exports allocate permanent screens as globals before their create calls.
  // Use the first as a fallback only if custom UI init leaves LVGL's default screen active.
  const permanentScreens = [...new Set([...generated.matchAll(/\b([A-Za-z_]\w*)\s*=\s*lv_obj_create\s*\(\s*NULL\s*\)/g)].map(match => match[1]))];
  const initialScreen = permanentScreens[0];
  // Only inspect exported screen translation units listed by the project.
  // Constructors for components/widgets require a parent and are not screens.
  const sources = await readFile(path.join(directory, 'file_list_gen.cmake'), 'utf8');
  const screenFiles = [...new Set([...sources.matchAll(/\$\{CMAKE_CURRENT_LIST_DIR\}\/([^\s;"()]+_gen\.c)/g)]
    .map(match => match[1]).filter(file => file.startsWith('screens/') && !file.split('/').includes('..')))];
  const screens = (await Promise.all(screenFiles.map(async file => {
    const source = await readFile(path.join(directory, file), 'utf8');
    const constructor = path.basename(file, '_gen.c') + '_create';
    if (!/^[A-Za-z_]\w*$/.test(constructor)) return undefined;
    return new RegExp(`\\blv_obj_t\\s*\\*\\s*${constructor}\\s*\\(\\s*(?:void\\s*)?\\)`).test(source)
      && /\blv_obj_create\s*\(\s*NULL\s*\)/.test(source) ? constructor : undefined;
  }))).filter((name): name is string => !!name).sort();
  return {
    directory, name, lvglVersion: (attribute(project, 'lvgl_version') ?? '9.5.0').replace(/^v/, ''),
    width: Number(attribute(display, 'width')) || 800,
    height: Number(attribute(display, 'height')) || 480,
    initialScreen, screens, permanentScreens
  };
}

async function writeScreenRegistry(project: ProjectInfo, file: string): Promise<void> {
  const entries = [
    ...project.permanentScreens.map(name => ({ name, create: '', global: name })),
    ...project.screens.map(create => ({ name: create.replace(/_create$/, ''), create, global: '' }))
  ].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const labels = entries.map(entry => entry.name);
  const content = [
    '/* LVGL Go build registry. Project exports remain unchanged. */',
    ...entries.map(entry => entry.create ? `extern lv_obj_t * ${entry.create}(void);` : `extern lv_obj_t * ${entry.global};`),
    'static lvgl_go_screen_entry_t lvgl_go_screen_entries[] = {',
    ...(entries.length ? entries.map(entry => `    { ${entry.create || 'NULL'}, ${entry.global ? '&' + entry.global : 'NULL'}, NULL },`) : ['    { NULL, NULL, NULL },']),
    '};',
    `static const int lvgl_go_screen_count = ${entries.length};`,
    `static const char lvgl_go_screen_labels[] = ${JSON.stringify(JSON.stringify(labels))};`,
    ...project.screens.flatMap(create => [
      `extern lv_obj_t * __real_${create}(void);`,
      `lv_obj_t * __wrap_${create}(void) {`,
      `    lv_obj_t * screen = __real_${create}();`,
      `    lvgl_go_observe_screen(screen, ${create});`,
      '    return screen;',
      '}'
    ]), ''
  ].join('\n');
  await mkdir(path.dirname(file), { recursive: true });
  if (await readFile(file, 'utf8').catch(() => '') !== content) await writeFile(file, content);
}

export async function prepareManagedBuild(config: Config): Promise<void> {
  if (!config.managedBuild) return;
  if (config.runtime.assetsDir) await validateAssets(config.runtime.assetsDir);
  const project = await inspectProject(config.projectDir);
  const values: Record<string, string> = {
    UI_NAME: project.name,
    UI_WIDTH: String(config.runtime.width ?? project.width),
    UI_HEIGHT: String(config.runtime.height ?? project.height),
    LVGL_VERSION: `v${project.lvglVersion}`,
    UI_INITIAL_SCREEN: config.runtime.initialScreen ?? project.initialScreen ?? '',
    UI_SCREEN_CONSTRUCTORS: project.screens.join(';'),
    UI_START_SCREEN: config.runtime.startScreen ?? (!project.initialScreen && project.screens.length === 1 ? project.screens[0] : '')
  };
  if (values.UI_START_SCREEN && !project.screens.includes(values.UI_START_SCREEN)) throw new Error('runtime.startScreen must name an exported screen constructor: ' + project.screens.join(', '));
  if (!config.runtime.lvglSourceDir) {
    if (config.runtime.defaults) throw new Error('runtime.defaults requires runtime.lvglSourceDir; precompiled LVGL uses its supplied lv_conf.h.');
    values.LVGL_LIBRARY_DIR = await resolveLvglLibrary(project.lvglVersion, config.runtime.lvglLibraryDir);
    // Clear a cached source override when switching to the precompiled library.
    values.LVGL_SOURCE_DIR = '';
  } else {
    values.LVGL_LIBRARY_DIR = '';
  }
  if (values.UI_INITIAL_SCREEN && !/^[A-Za-z_]\w*$/.test(values.UI_INITIAL_SCREEN)) throw new Error('runtime.initialScreen must be a generated screen variable name.');
  const configure = config.build[0].args;
  const registry = path.join(configure[configure.indexOf('-B') + 1], 'lvgl_go_screens.h');
  await writeScreenRegistry(project, registry);
  values.UI_SCREEN_REGISTRY = registry.replace(/\\/g, '/');
  const args = config.build[0].args.filter(arg => !Object.keys(values).some(key => arg.startsWith(`-D${key}=`)));
  config.build[0].args = [...args, ...Object.entries(values).map(([key, value]) => `-D${key}=${value}`)];
  await prepareOverlays(config.projectDir, config.outputDir, config.entry, { width: Number(values.UI_WIDTH), height: Number(values.UI_HEIGHT) });
}
