// Reads the `groovyIntellisense.*` settings and expands classpath entries (globs) to absolute paths.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MavenMode, detectMavenClasspath } from './maven';

export const CONFIG_SECTION = 'groovyIntellisense';

export interface GroovyConfig {
  javaHome: string;
  classpath: string[];
  autoDetectGradleCache: boolean;
  mavenMode: MavenMode;
  mavenLocalRepository: string;
  mavenExecutable: string;
  mavenSettingsFile: string;
  indexInclude: string;
  indexExclude: string;
  maxIndexedFiles: number;
  autoImport: boolean;
  trace: boolean;
}

export const DEFAULT_INCLUDE = '**/*.{groovy,gvy,gy,gsh,java,gradle}';
export const DEFAULT_EXCLUDE = '**/{node_modules,build,out,target,.git,.gradle}/**';

export function readConfig(): GroovyConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    javaHome: (c.get<string>('javaHome') ?? '').trim(),
    classpath: (c.get<string[]>('classpath') ?? []).filter((s) => typeof s === 'string' && s.trim() !== ''),
    autoDetectGradleCache: c.get<boolean>('autoDetectGradleCache') ?? false,
    mavenMode: (['pom', 'mvn', 'off'] as const).find((m) => m === c.get<string>('maven.resolver')) ?? 'pom',
    mavenLocalRepository: (c.get<string>('maven.localRepository') ?? '').trim(),
    mavenExecutable: (c.get<string>('maven.executable') ?? '').trim(),
    mavenSettingsFile: (c.get<string>('maven.settingsFile') ?? '').trim(),
    indexInclude: c.get<string>('indexInclude') || DEFAULT_INCLUDE,
    indexExclude: c.get<string>('indexExclude') ?? DEFAULT_EXCLUDE,
    maxIndexedFiles: Math.max(1, c.get<number>('maxIndexedFiles') ?? 5000),
    autoImport: c.get<boolean>('autoImport') ?? true,
    trace: c.get<boolean>('trace') ?? false,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Glob helpers (supports `*`, `**`, `?`, `{a,b}` and `[...]`).

export function hasGlob(p: string): boolean {
  return /[*?{[]/.test(p);
}

/** Converts a glob (forward slashes) to an anchored RegExp. Case-insensitive on Windows. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches everything.
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      inGroup++;
      re += '(?:';
    } else if (ch === '}' && inGroup > 0) {
      inGroup--;
      re += ')';
    } else if (ch === ',' && inGroup > 0) {
      re += '|';
    } else if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close < 0) {
        re += '\\[';
      } else {
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls.replace(/\\/g, '\\\\') + ']';
        i = close;
      }
    } else if ('\\^$.|+()'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

/** Tests a path (any separators) against a glob; patterns without `/` match the base name anywhere. */
export function matchesGlob(filePath: string, glob: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  const re = globToRegExp(glob.replace(/\\/g, '/'));
  if (re.test(p)) return true;
  // Workspace globs like `**/x/**` are relative: also try every suffix of the path.
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (re.test(parts.slice(i).join('/'))) return true;
  }
  return false;
}

/** Expands an absolute glob pattern on disk. Matches files and directories. */
export function expandAbsoluteGlob(pattern: string, limit = 10000): string[] {
  const norm = pattern.replace(/\\/g, '/');
  const segments = norm.split('/');
  // Static prefix (segments without glob characters).
  let i = 0;
  while (i < segments.length && !hasGlob(segments[i])) i++;
  let base = segments.slice(0, i).join('/');
  if (base === '') base = '/';
  if (/^[A-Za-z]:$/.test(base)) base += '/';
  if (i === segments.length) return fs.existsSync(base) ? [path.normalize(base)] : [];
  const re = globToRegExp(norm);
  const out: string[] = [];
  const recursive = segments.slice(i).some((s) => s === '**');
  const maxDepth = recursive ? 40 : segments.length - i;
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = (dir.endsWith('/') ? dir : dir + '/') + e.name;
      if (re.test(full)) out.push(path.normalize(full));
      if (e.isDirectory() && !e.isSymbolicLink()) walk(full, depth + 1);
      if (out.length >= limit) return;
    }
  };
  walk(base, 1);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Classpath resolution.

function expandVars(entry: string, folder?: vscode.WorkspaceFolder): string {
  let e = entry.trim();
  if (e.startsWith('~')) e = path.join(os.homedir(), e.slice(1));
  if (folder) e = e.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
  e = e.replace(/\$\{env:([^}]+)\}/g, (_m, name: string) => process.env[name] ?? '');
  return e;
}

/** `maven.settingsFile`: expands `~`, `${workspaceFolder}`, `${env:X}`; relative paths are relative to the first workspace folder. */
function resolveSettingsFile(raw: string, folder?: vscode.WorkspaceFolder): string | undefined {
  if (!raw) return undefined;
  const e = expandVars(raw, folder);
  return path.isAbsolute(e) ? path.normalize(e) : folder ? path.join(folder.uri.fsPath, e) : path.resolve(e);
}

/** Resolves the `classpath` setting (+ Maven dependencies and optional Gradle cache detection) to unique absolute paths. */
export async function resolveClasspath(cfg: GroovyConfig, log: (msg: string) => void, cacheDir?: string): Promise<string[]> {
  const result = new Set<string>();
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const raw of cfg.classpath) {
    const absolute = path.isAbsolute(expandVars(raw));
    const bases: (vscode.WorkspaceFolder | undefined)[] = absolute || folders.length === 0 ? [undefined] : [...folders];
    let found = 0;
    for (const folder of bases) {
      const entry = expandVars(raw, folder);
      const full = path.isAbsolute(entry) ? entry : folder ? path.join(folder.uri.fsPath, entry) : path.resolve(entry);
      const matches = hasGlob(full) ? expandAbsoluteGlob(full) : fs.existsSync(full) ? [path.normalize(full)] : [];
      for (const m of matches) {
        if (fs.statSync(m, { throwIfNoEntry: false })?.isDirectory() || /\.(jar|zip)$/i.test(m)) {
          result.add(m);
          found++;
        }
      }
    }
    if (found === 0) log(`[classpath] sin coincidencias para "${raw}"`);
  }
  if (cfg.mavenMode !== 'off') {
    try {
      const maven = await detectMavenClasspath(folders.map((f) => f.uri.fsPath), {
        mode: cfg.mavenMode,
        localRepository: cfg.mavenLocalRepository ? expandVars(cfg.mavenLocalRepository) : undefined,
        executable: cfg.mavenExecutable || undefined,
        settingsFile: resolveSettingsFile(cfg.mavenSettingsFile, folders[0]),
        cacheDir,
        log,
      });
      for (const e of maven.classpath) result.add(path.normalize(e));
    } catch (e) {
      log(`[maven] error resolviendo dependencias: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (cfg.autoDetectGradleCache) {
    for (const jar of await detectGradleCacheJars(log)) result.add(jar);
  }
  return [...result];
}

/**
 * Minimal Gradle support: reads `group:name:version` coordinates from build.gradle files of the workspace folders and
 * looks for the matching jars in ~/.gradle/caches/modules-2/files-2.1. No transitive dependencies.
 */
async function detectGradleCacheJars(log: (msg: string) => void): Promise<string[]> {
  const gradleHome = process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
  const cache = path.join(gradleHome, 'caches', 'modules-2', 'files-2.1');
  if (!fs.existsSync(cache)) {
    log(`[gradle] caché no encontrada: ${cache}`);
    return [];
  }
  const out: string[] = [];
  const buildFiles = await vscode.workspace.findFiles('**/build.gradle{,.kts}', '**/{node_modules,build,.gradle}/**', 50);
  const coord = /['"]([\w.\-]+):([\w.\-]+):([\w.\-+]+)(?::[\w.\-]+)?['"]/g;
  for (const uri of buildFiles) {
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(coord)) {
      const [, group, name, version] = m;
      const dir = path.join(cache, group, name, version);
      let hashes: string[] = [];
      try {
        hashes = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const h of hashes) {
        const jar = path.join(dir, h, `${name}-${version}.jar`);
        if (fs.existsSync(jar)) {
          out.push(jar);
          break;
        }
      }
    }
  }
  log(`[gradle] ${out.length} jar(s) detectados en la caché de Gradle`);
  return out;
}
