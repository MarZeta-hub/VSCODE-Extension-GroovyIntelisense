// Maven support (vscode-independent): resolves the dependency classpath of the workspace pom.xml files.
// Two strategies:
//  - 'pom': reads pom.xml (+ parents, properties, dependencyManagement, imported BOMs) and resolves transitive
//    dependencies against the local repository (~/.m2/repository) with Maven's "nearest wins" rule. Offline and fast.
//  - 'mvn': runs `mvn dependency:build-classpath` (or ./mvnw) — exact, but slower; the result is cached by pom contents.
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------------------------------------------
// Minimal XML parser (enough for POM / settings.xml files).

export interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#root', children: [], text: '' };
  const stack: XmlNode[] = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[3]) {
      const name = m[3].replace(/^.*:/, '');
      if (m[2]) {
        // closing tag: pop up to the matching element (tolerant)
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].name === name) { stack.length = k; break; }
        }
      } else {
        const node: XmlNode = { name, children: [], text: '' };
        top.children.push(node);
        if (!m[5]) stack.push(node);
      }
    } else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
  }
  return root;
}

function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) => {
    switch (e.toLowerCase()) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function child(n: XmlNode | undefined, name: string): XmlNode | undefined {
  return n?.children.find(c => c.name === name);
}

function children(n: XmlNode | undefined, name: string): XmlNode[] {
  return n?.children.filter(c => c.name === name) ?? [];
}

function text(n: XmlNode | undefined, name: string): string | undefined {
  const t = child(n, name)?.text.trim();
  return t === undefined || t === '' ? undefined : t;
}

// ---------------------------------------------------------------------------------------------------------------
// POM model

export interface Dependency {
  groupId: string;
  artifactId: string;
  version?: string;
  scope?: string;
  type?: string;
  classifier?: string;
  optional?: boolean;
  systemPath?: string;
  /** `groupId:artifactId` patterns (may contain `*`). */
  exclusions: string[];
}

interface RawPom {
  groupId?: string;
  artifactId: string;
  version?: string;
  packaging: string;
  parent?: { groupId: string; artifactId: string; version: string; relativePath?: string };
  properties: Map<string, string>;
  dependencies: Dependency[];
  managed: Dependency[];
  modules: string[];
}

export interface EffectivePom {
  file: string;
  groupId: string;
  artifactId: string;
  version: string;
  packaging: string;
  properties: Map<string, string>;
  /** Interpolated, with versions/scopes from dependencyManagement applied. */
  dependencies: Dependency[];
  managed: Map<string, Dependency>;
  modules: string[];
}

const keyOf = (d: { groupId: string; artifactId: string }) => `${d.groupId}:${d.artifactId}`;

function readDependency(n: XmlNode): Dependency | undefined {
  const groupId = text(n, 'groupId');
  const artifactId = text(n, 'artifactId');
  if (!groupId || !artifactId) return undefined;
  return {
    groupId, artifactId,
    version: text(n, 'version'),
    scope: text(n, 'scope'),
    type: text(n, 'type'),
    classifier: text(n, 'classifier'),
    optional: text(n, 'optional') === 'true',
    systemPath: text(n, 'systemPath'),
    exclusions: children(child(n, 'exclusions'), 'exclusion').map(e => `${text(e, 'groupId') ?? '*'}:${text(e, 'artifactId') ?? '*'}`),
  };
}

function readRawPom(xml: string): RawPom | undefined {
  const project = child(parseXml(xml), 'project');
  if (!project) return undefined;
  const parentNode = child(project, 'parent');
  const parent = parentNode && text(parentNode, 'groupId') && text(parentNode, 'artifactId') && text(parentNode, 'version')
    ? { groupId: text(parentNode, 'groupId')!, artifactId: text(parentNode, 'artifactId')!, version: text(parentNode, 'version')!, relativePath: child(parentNode, 'relativePath')?.text.trim() }
    : undefined;
  const properties = new Map<string, string>();
  for (const p of child(project, 'properties')?.children ?? []) properties.set(p.name, p.text.trim());
  // Profiles active by default contribute properties and dependencies too.
  const profiles = children(child(project, 'profiles'), 'profile').filter(p => text(child(p, 'activation'), 'activeByDefault') === 'true');
  for (const prof of profiles) for (const p of child(prof, 'properties')?.children ?? []) properties.set(p.name, p.text.trim());
  const deps = (scope: XmlNode | undefined) => children(child(scope, 'dependencies'), 'dependency').map(readDependency).filter((d): d is Dependency => !!d);
  return {
    groupId: text(project, 'groupId'),
    artifactId: text(project, 'artifactId') ?? '',
    version: text(project, 'version'),
    packaging: text(project, 'packaging') ?? 'jar',
    parent,
    properties,
    dependencies: [...deps(project), ...profiles.flatMap(deps)],
    managed: [...deps(child(project, 'dependencyManagement')), ...profiles.flatMap(p => deps(child(p, 'dependencyManagement')))],
    modules: children(child(project, 'modules'), 'module').map(m => m.text.trim()).filter(Boolean),
  };
}

/** Compares Maven versions (numeric segments numerically, qualifiers < release). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => v.split(/[.\-_]/).map(s => (/^\d+$/.test(s) ? Number(s) : s.toLowerCase()));
  const qualifierRank = (s: string) => (['alpha', 'a', 'beta', 'b', 'milestone', 'm', 'rc', 'cr', 'snapshot'].indexOf(s.replace(/\d+$/, '')) + 1) || 10;
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return typeof y === 'number' ? -1 : 1;
    if (y === undefined) return typeof x === 'number' ? 1 : -1;
    if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x - y; continue; }
    if (typeof x === 'number') return 1;
    if (typeof y === 'number') return -1;
    if (x !== y) return qualifierRank(x) - qualifierRank(y) || x.localeCompare(y);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Resolver

export interface MavenResult {
  classpath: string[];
  /** Coordinates (g:a:v) of artifacts not found in the local repository. */
  missing: string[];
  /** pom.xml files used as roots. */
  poms: string[];
}

export class PomResolver {
  private effectiveCache = new Map<string, EffectivePom | null>();
  /** Workspace modules by g:a -> pom file. */
  private modules = new Map<string, string>();

  constructor(private readonly localRepo: string, private readonly log: (msg: string) => void = () => undefined) {}

  repoFile(g: string, a: string, v: string, ext: string, classifier?: string): string {
    return path.join(this.localRepo, ...g.split('.'), a, v, `${a}-${v}${classifier ? '-' + classifier : ''}.${ext}`);
  }

  /** Concrete version: interpolation leftovers, ranges or missing versions pick the highest one installed locally. */
  private concreteVersion(g: string, a: string, v: string | undefined): string | undefined {
    if (v && !v.includes('${') && !/^[[(]/.test(v)) return v;
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(path.join(this.localRepo, ...g.split('.'), a)).filter(d => /^\d/.test(d));
    } catch {
      return undefined;
    }
    if (v && /^[[(]/.test(v)) {
      // [1.0,2.0) style range: keep versions inside the bounds
      const m = /^([[(])\s*([^,]*)\s*,?\s*([^\])]*)\s*([\])])$/.exec(v);
      if (m) {
        dirs = dirs.filter(d => {
          if (m[2] && (m[1] === '[' ? compareVersions(d, m[2]) < 0 : compareVersions(d, m[2]) <= 0)) return false;
          if (m[3] && (m[4] === ']' ? compareVersions(d, m[3]) > 0 : compareVersions(d, m[3]) >= 0)) return false;
          return true;
        });
      }
    }
    return dirs.sort(compareVersions).pop();
  }

  /** Effective POM of a file (parents merged, properties interpolated, dependencyManagement applied). */
  effective(file: string, depth = 0): EffectivePom | undefined {
    const norm = path.resolve(file);
    if (this.effectiveCache.has(norm)) return this.effectiveCache.get(norm) ?? undefined;
    this.effectiveCache.set(norm, null); // cycle guard
    let raw: RawPom | undefined;
    try {
      raw = readRawPom(fs.readFileSync(norm, 'utf8'));
    } catch {
      raw = undefined;
    }
    if (!raw || depth > 25) return undefined;

    let parent: EffectivePom | undefined;
    if (raw.parent) {
      const p = raw.parent;
      const rel = p.relativePath === undefined ? '../pom.xml' : p.relativePath;
      if (rel) {
        let candidate = path.resolve(path.dirname(norm), rel);
        if (fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) candidate = path.join(candidate, 'pom.xml');
        const eff = fs.existsSync(candidate) ? this.effective(candidate, depth + 1) : undefined;
        if (eff && eff.groupId === p.groupId && eff.artifactId === p.artifactId) parent = eff;
      }
      if (!parent) {
        const repoPom = this.repoFile(p.groupId, p.artifactId, p.version, 'pom');
        parent = fs.existsSync(repoPom) ? this.effective(repoPom, depth + 1) : undefined;
        if (!parent) this.log(`[maven] POM padre no encontrado: ${p.groupId}:${p.artifactId}:${p.version}`);
      }
    }

    const groupId = raw.groupId ?? raw.parent?.groupId ?? parent?.groupId ?? '';
    const version = raw.version ?? raw.parent?.version ?? parent?.version ?? '';
    const props = new Map(parent?.properties ?? []);
    for (const [k, v] of raw.properties) props.set(k, v);
    const builtins: Record<string, string> = {
      'project.groupId': groupId, 'pom.groupId': groupId, groupId,
      'project.artifactId': raw.artifactId, 'pom.artifactId': raw.artifactId, artifactId: raw.artifactId,
      'project.version': version, 'pom.version': version, version,
      'project.parent.version': raw.parent?.version ?? '', 'parent.version': raw.parent?.version ?? '',
      'project.parent.groupId': raw.parent?.groupId ?? '', 'parent.groupId': raw.parent?.groupId ?? '',
      'project.basedir': path.dirname(norm), basedir: path.dirname(norm), 'user.home': os.homedir(),
    };
    for (const [k, v] of Object.entries(builtins)) props.set(k, v);
    const interp = (s: string | undefined): string | undefined => {
      if (s === undefined) return undefined;
      let out = s;
      for (let i = 0; i < 10 && out.includes('${'); i++) {
        out = out.replace(/\$\{([^}]+)\}/g, (m, name: string) => props.get(name) ?? (name.startsWith('env.') ? process.env[name.slice(4)] : undefined) ?? m);
      }
      return out;
    };
    const interpDep = (d: Dependency): Dependency => ({
      ...d,
      groupId: interp(d.groupId)!, artifactId: interp(d.artifactId)!, version: interp(d.version),
      scope: interp(d.scope), type: interp(d.type), classifier: interp(d.classifier), systemPath: interp(d.systemPath),
    });

    // dependencyManagement: parent's, then imported BOMs, then own declarations (own wins).
    const managed = new Map(parent?.managed ?? []);
    const own = raw.managed.map(interpDep);
    for (const d of own) {
      if (d.scope === 'import' && (d.type ?? 'jar') === 'pom') {
        const v = this.concreteVersion(d.groupId, d.artifactId, d.version);
        const bom = v ? this.effective(this.repoFile(d.groupId, d.artifactId, v, 'pom'), depth + 1) : undefined;
        if (!bom) { this.log(`[maven] BOM no encontrado: ${d.groupId}:${d.artifactId}:${d.version}`); continue; }
        for (const [k, md] of bom.managed) if (!own.some(o => keyOf(o) === k && o.scope !== 'import')) managed.set(k, md);
      }
    }
    for (const d of own) if (d.scope !== 'import') managed.set(keyOf(d), d);

    const applyManaged = (d: Dependency): Dependency => {
      const md = managed.get(keyOf(d));
      if (!md) return d;
      return { ...d, version: d.version ?? md.version, scope: d.scope ?? md.scope, exclusions: [...d.exclusions, ...md.exclusions] };
    };
    const deps = new Map<string, Dependency>();
    for (const d of parent?.dependencies ?? []) deps.set(keyOf(d) + ':' + (d.classifier ?? ''), d);
    for (const d of raw.dependencies.map(interpDep).map(applyManaged)) deps.set(keyOf(d) + ':' + (d.classifier ?? ''), d);

    const eff: EffectivePom = {
      file: norm, groupId, artifactId: raw.artifactId, version, packaging: raw.packaging,
      properties: props, dependencies: [...deps.values()], managed, modules: raw.modules,
    };
    this.effectiveCache.set(norm, eff);
    return eff;
  }

  /** Registers workspace modules so that inter-module dependencies resolve to their sources/targets. */
  registerModules(poms: string[]): void {
    for (const p of poms) {
      const eff = this.effective(p);
      if (eff) this.modules.set(keyOf(eff), eff.file);
    }
  }

  /** Resolves the classpath of the given root poms (all scopes of direct deps, compile/runtime of transitive ones). */
  resolve(rootPoms: string[]): MavenResult {
    this.registerModules(rootPoms);
    const classpath = new Set<string>();
    const missing = new Set<string>();
    for (const rootFile of rootPoms) {
      const root = this.effective(rootFile);
      if (!root) continue;
      const resolved = new Set<string>([keyOf(root)]);
      const queue: { dep: Dependency; depth: number; exclusions: string[] }[] =
        root.dependencies.map(d => ({ dep: d, depth: 0, exclusions: d.exclusions }));
      while (queue.length) {
        const { dep, depth, exclusions } = queue.shift()!;
        const key = keyOf(dep) + (dep.classifier ? ':' + dep.classifier : '');
        if (resolved.has(key)) continue;
        resolved.add(key);
        const managedVersion = depth > 0 ? root.managed.get(keyOf(dep))?.version : undefined;
        const version = this.concreteVersion(dep.groupId, dep.artifactId, managedVersion ?? dep.version);
        const coord = `${dep.groupId}:${dep.artifactId}:${version ?? dep.version ?? '?'}`;
        const modulePom = this.modules.get(keyOf(dep));
        let pomFile: string | undefined;

        if (dep.scope === 'system') {
          if (dep.systemPath && fs.existsSync(dep.systemPath)) classpath.add(path.normalize(dep.systemPath));
          continue;
        }
        if (modulePom) {
          // Sources are indexed from the workspace; compiled classes help for Java modules.
          const target = path.join(path.dirname(modulePom), 'target', 'classes');
          if (fs.existsSync(target)) classpath.add(target);
          pomFile = modulePom;
        } else if (version) {
          const type = dep.type ?? 'jar';
          if (type !== 'pom') {
            const classifier = dep.classifier ?? (type === 'test-jar' ? 'tests' : undefined);
            const jar = this.repoFile(dep.groupId, dep.artifactId, version, 'jar', classifier);
            if (fs.existsSync(jar)) classpath.add(jar);
            else missing.add(coord);
          }
          const pf = this.repoFile(dep.groupId, dep.artifactId, version, 'pom');
          if (fs.existsSync(pf)) pomFile = pf;
        } else {
          missing.add(coord);
        }
        if (!pomFile || depth >= 20) continue;
        const eff = this.effective(pomFile);
        for (const c of eff?.dependencies ?? []) {
          const scope = c.scope ?? 'compile';
          if (c.optional || scope === 'test' || scope === 'provided' || scope === 'system' || scope === 'import') continue;
          if (isExcluded(c, exclusions)) continue;
          queue.push({ dep: c, depth: depth + 1, exclusions: [...exclusions, ...c.exclusions] });
        }
      }
    }
    return { classpath: [...classpath], missing: [...missing], poms: rootPoms };
  }
}

function isExcluded(d: Dependency, exclusions: string[]): boolean {
  return exclusions.some(e => {
    const [g, a] = e.split(':');
    return (g === '*' || g === d.groupId) && (a === '*' || a === d.artifactId);
  });
}

/**
 * Local repository: explicit setting, else <localRepository> of the given settings file, ~/.m2/settings.xml
 * (or $MAVEN_HOME/conf), else ~/.m2/repository.
 */
export function findLocalRepository(explicit?: string, settingsFile?: string): string {
  if (explicit) return explicit;
  const candidates = [path.join(os.homedir(), '.m2', 'settings.xml')];
  if (settingsFile) candidates.unshift(settingsFile);
  for (const home of [process.env.MAVEN_HOME, process.env.M2_HOME]) if (home) candidates.push(path.join(home, 'conf', 'settings.xml'));
  for (const f of candidates) {
    try {
      const repo = text(child(parseXml(fs.readFileSync(f, 'utf8')), 'settings'), 'localRepository');
      if (repo) return repo.replace(/\$\{user\.home\}/g, os.homedir()).replace(/\$\{env\.([^}]+)\}/g, (_m, n: string) => process.env[n] ?? '');
    } catch {
      // not found
    }
  }
  return path.join(os.homedir(), '.m2', 'repository');
}

/** Splits a maven.config line into arguments (whitespace separated, single/double quotes allowed). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** `-s`/`--settings` declared in `<dir>/.mvn/maven.config` (resolved against `dir`), if any. */
export function settingsFromMavenConfig(dir: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(path.join(dir, '.mvn', 'maven.config'), 'utf8');
  } catch {
    return undefined;
  }
  const args = splitArgs(content);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let value: string | undefined;
    if ((a === '-s' || a === '--settings') && i + 1 < args.length) value = args[i + 1];
    else if (a.startsWith('--settings=')) value = a.slice('--settings='.length);
    if (value) return path.resolve(dir, value);
  }
  return undefined;
}

/** Finds pom.xml files below `dir` (skips target/node_modules/hidden folders). */
export function findPoms(dir: string, maxDepth = 6, limit = 200): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (out.length >= limit || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some(e => e.isFile() && e.name === 'pom.xml')) out.push(path.join(d, 'pom.xml'));
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !['target', 'node_modules', 'build', 'out', 'src'].includes(e.name)) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// `mvn dependency:build-classpath` strategy

export interface MvnOptions {
  /** Maven executable; empty -> ./mvnw (if present) or `mvn`. */
  executable?: string;
  /** User settings file passed as `-s` (repositories, mirrors, credentials, localRepository). */
  settingsFile?: string;
  cacheDir?: string;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

const CP_FILE = path.join('target', 'groovy-intellisense.classpath');

/** Runs Maven in the folder of `rootPom` and returns the union of every module's classpath. Cached by pom contents. */
export async function mvnClasspath(rootPom: string, poms: string[], opts: MvnOptions = {}): Promise<string[] | undefined> {
  const log = opts.log ?? (() => undefined);
  const dir = path.dirname(rootPom);
  const hash = crypto.createHash('sha1');
  if (opts.settingsFile) {
    hash.update(opts.settingsFile);
    try { hash.update(fs.readFileSync(opts.settingsFile)); } catch { /* ignore */ }
  }
  for (const p of [...poms].sort()) {
    try { hash.update(p).update(fs.readFileSync(p)); } catch { /* ignore */ }
  }
  const key = hash.digest('hex').slice(0, 16);
  const cacheFile = opts.cacheDir ? path.join(opts.cacheDir, `maven-${key}.json`) : undefined;
  if (cacheFile) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as string[];
      if (cached.every(f => fs.existsSync(f))) { log('[maven] classpath de mvn tomado de la caché'); return cached; }
    } catch {
      // no cache
    }
  }
  const isWin = process.platform === 'win32';
  let exe = opts.executable;
  if (!exe) {
    const wrapper = path.join(dir, isWin ? 'mvnw.cmd' : 'mvnw');
    exe = fs.existsSync(wrapper) ? wrapper : 'mvn';
  }
  const args = ['-q', '-B', 'dependency:build-classpath', `-Dmdep.outputFile=${CP_FILE}`, '-Dmdep.includeScope=test'];
  if (opts.settingsFile) args.unshift('-s', opts.settingsFile);
  log(`[maven] ejecutando ${exe} ${args.join(' ')} en ${dir}`);
  const t0 = Date.now();
  const ok = await new Promise<boolean>(resolve => {
    // .cmd/.bat files need a shell on Windows
    const quote = (s: string) => (isWin && /\s/.test(s) ? `"${s}"` : s);
    cp.execFile(isWin ? quote(exe!) : exe!, isWin ? args.map(quote) : args, { cwd: dir, timeout: opts.timeoutMs ?? 300_000, shell: isWin, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        log(`[maven] mvn falló (${err.message.split('\n')[0]}): ${(stdout + stderr).trim().split('\n').slice(-5).join(' | ')}`);
        resolve(false);
      } else resolve(true);
    });
  });
  if (!ok) return undefined;
  const result = new Set<string>();
  for (const p of poms) {
    try {
      const content = fs.readFileSync(path.join(path.dirname(p), CP_FILE), 'utf8').trim();
      for (const e of content.split(path.delimiter)) if (e.trim()) result.add(e.trim());
    } catch {
      // module without output (e.g. pom packaging)
    }
  }
  log(`[maven] mvn terminó en ${Date.now() - t0}ms: ${result.size} entrada(s)`);
  const list = [...result];
  if (cacheFile) {
    try { fs.writeFileSync(cacheFile, JSON.stringify(list)); } catch { /* ignore */ }
  }
  return list;
}

export type MavenMode = 'pom' | 'mvn' | 'off';

export interface MavenDetectOptions {
  mode: MavenMode;
  localRepository?: string;
  executable?: string;
  /** Explicit settings.xml; when absent, `-s`/`--settings` of `.mvn/maven.config` is honoured. */
  settingsFile?: string;
  cacheDir?: string;
  log?: (msg: string) => void;
}

/** Resolves the Maven classpath of every Maven project found under the given folders. */
export async function detectMavenClasspath(folders: string[], opts: MavenDetectOptions): Promise<MavenResult> {
  const log = opts.log ?? (() => undefined);
  const result: MavenResult = { classpath: [], missing: [], poms: [] };
  if (opts.mode === 'off') return result;
  const poms = folders.flatMap(f => findPoms(f));
  if (!poms.length) return result;
  result.poms = poms;
  // One Maven run per top-level project (poms that are not inside another pom's folder).
  const roots = poms.filter(p => !poms.some(q => q !== p && p.startsWith(path.dirname(q) + path.sep)));

  let settingsFile = opts.settingsFile;
  if (settingsFile) {
    if (!fs.existsSync(settingsFile)) log(`[maven] settings.xml no encontrado: ${settingsFile}`);
    else log(`[maven] usando settings.xml: ${settingsFile}`);
  } else {
    // mvn reads .mvn/maven.config by itself, so it is only needed here for the local repository.
    for (const dir of [...folders, ...roots.map(r => path.dirname(r))]) {
      settingsFile = settingsFromMavenConfig(dir);
      if (settingsFile) { log(`[maven] usando settings.xml de ${path.join(dir, '.mvn', 'maven.config')}: ${settingsFile}`); break; }
    }
  }
  const repo = findLocalRepository(opts.localRepository, settingsFile);
  const t0 = Date.now();
  const all = new Set<string>();

  if (opts.mode === 'mvn') {
    let failed = false;
    for (const root of roots) {
      const sub = poms.filter(p => p === root || p.startsWith(path.dirname(root) + path.sep));
      const list = await mvnClasspath(root, sub, { executable: opts.executable, settingsFile: opts.settingsFile, cacheDir: opts.cacheDir, log });
      if (!list) { failed = true; break; }
      list.forEach(e => all.add(e));
    }
    if (!failed) {
      result.classpath = [...all];
      return result;
    }
    log('[maven] se usará la resolución a partir de pom.xml');
    all.clear();
  }

  const resolver = new PomResolver(repo, log);
  const r = resolver.resolve(poms);
  r.classpath.forEach(e => all.add(e));
  result.classpath = [...all];
  result.missing = r.missing;
  log(`[maven] ${poms.length} pom.xml, repositorio ${repo}: ${result.classpath.length} jar(s) en ${Date.now() - t0}ms`);
  if (r.missing.length) {
    log(`[maven] ${r.missing.length} artefacto(s) no descargados en el repositorio local (ejecute "mvn dependency:resolve"): ${r.missing.slice(0, 15).join(', ')}${r.missing.length > 15 ? '…' : ''}`);
  }
  return result;
}
