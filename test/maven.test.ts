import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PomResolver, compareVersions, detectMavenClasspath, findLocalRepository, parseXml, settingsFromMavenConfig } from '../src/maven';
import { JavaClassProvider } from '../src/core/javaClassProvider';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-maven-'));
const repo = path.join(tmp, 'repo');
const ws = path.join(tmp, 'ws');

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function pom(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n<modelVersion>4.0.0</modelVersion>\n${body}\n</project>`;
}

function dep(g: string, a: string, v?: string, extra = ''): string {
  return `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId>${v ? `<version>${v}</version>` : ''}${extra}</dependency>`;
}

/** Installs an artifact (jar + pom) in the fake repository. */
function install(g: string, a: string, v: string, deps = '', extra = ''): void {
  const dir = path.join(repo, ...g.split('.'), a, v);
  write(path.join(dir, `${a}-${v}.pom`), pom(`<groupId>${g}</groupId><artifactId>${a}</artifactId><version>${v}</version>${extra}<dependencies>${deps}</dependencies>`));
  write(path.join(dir, `${a}-${v}.jar`), 'jar');
}

const jar = (g: string, a: string, v: string) => path.join(repo, ...g.split('.'), a, v, `${a}-${v}.jar`);

// --- fake repository ---------------------------------------------------------------------------------------------
install('org.lib', 'core', '1.0', dep('org.lib', 'transitive', '2.0') + dep('org.lib', 'opt', '1.0', '<optional>true</optional>') + dep('org.lib', 'testonly', '1.0', '<scope>test</scope>') + dep('org.bad', 'excluded', '1.0'));
install('org.lib', 'transitive', '2.0', dep('org.lib', 'deep', '3.0'));
install('org.lib', 'transitive', '2.5');
install('org.lib', 'deep', '3.0');
install('org.lib', 'opt', '1.0');
install('org.lib', 'testonly', '1.0');
install('org.bad', 'excluded', '1.0');
install('org.lib', 'ranged', '1.2');
install('org.lib', 'ranged', '1.9');
install('org.lib', 'ranged', '2.1');
install('org.lib', 'managed', '4.2');
install('org.lib', 'junit', '5.0');
// BOM with managed version
write(path.join(repo, 'org', 'lib', 'bom', '1.0', 'bom-1.0.pom'), pom(`<groupId>org.lib</groupId><artifactId>bom</artifactId><version>1.0</version><packaging>pom</packaging>
<dependencyManagement><dependencies>${dep('org.lib', 'managed', '4.2')}</dependencies></dependencyManagement>`));

// --- workspace: parent + 2 modules -------------------------------------------------------------------------------
write(path.join(ws, 'pom.xml'), pom(`<groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0-SNAPSHOT</version><packaging>pom</packaging>
<modules><module>app</module><module>util</module></modules>
<properties><core.version>1.0</core.version></properties>
<dependencyManagement><dependencies>
  ${dep('org.lib', 'core', '${core.version}')}
  ${dep('org.lib', 'transitive', '2.5')}
  ${dep('org.lib', 'bom', '1.0', '<type>pom</type><scope>import</scope>')}
</dependencies></dependencyManagement>
<dependencies>${dep('org.lib', 'junit', '5.0', '<scope>test</scope>')}</dependencies>`));
write(path.join(ws, 'util', 'pom.xml'), pom(`<parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0-SNAPSHOT</version></parent>
<artifactId>util</artifactId>
<dependencies>${dep('org.lib', 'ranged', '[1.0,2.0)')}</dependencies>`));
write(path.join(ws, 'app', 'pom.xml'), pom(`<parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0-SNAPSHOT</version></parent>
<artifactId>app</artifactId>
<dependencies>
  ${dep('org.lib', 'core', undefined, '<exclusions><exclusion><groupId>org.bad</groupId><artifactId>*</artifactId></exclusion></exclusions>')}
  ${dep('org.lib', 'managed')}
  ${dep('com.acme', 'util', '${project.version}')}
  ${dep('org.missing', 'gone', '9.9')}
</dependencies>`));
fs.mkdirSync(path.join(ws, 'util', 'target', 'classes'), { recursive: true });

test('xml parser handles comments, cdata, entities and namespaces', () => {
  const x = parseXml('<?xml version="1.0"?><!-- c --><a:p xmlns:a="x"><b>1 &amp; 2</b><c><![CDATA[<z>]]></c><d/></a:p>');
  const p = x.children[0];
  assert.equal(p.name, 'p');
  assert.equal(p.children[0].text, '1 & 2');
  assert.equal(p.children[1].text, '<z>');
  assert.equal(p.children[2].name, 'd');
});

test('version comparison', () => {
  assert.ok(compareVersions('1.10', '1.9') > 0);
  assert.ok(compareVersions('1.0-SNAPSHOT', '1.0') < 0);
  assert.ok(compareVersions('2.0.0-RC1', '2.0.0') < 0);
  assert.ok(compareVersions('5.10.2', '5.10.2') === 0);
});

test('effective pom: parent properties, managed versions and imported BOM', () => {
  const r = new PomResolver(repo);
  const app = r.effective(path.join(ws, 'app', 'pom.xml'))!;
  assert.equal(app.groupId, 'com.acme');
  assert.equal(app.version, '1.0-SNAPSHOT');
  const core = app.dependencies.find(d => d.artifactId === 'core')!;
  assert.equal(core.version, '1.0');
  assert.equal(app.dependencies.find(d => d.artifactId === 'managed')!.version, '4.2');
  assert.ok(app.dependencies.some(d => d.artifactId === 'junit' && d.scope === 'test'), 'inherited dependency');
});

test('transitive resolution: nearest wins, managed version, optional/test/exclusions, ranges, modules', () => {
  const r = new PomResolver(repo).resolve([path.join(ws, 'pom.xml'), path.join(ws, 'app', 'pom.xml'), path.join(ws, 'util', 'pom.xml')]);
  const cp = new Set(r.classpath);
  assert.ok(cp.has(jar('org.lib', 'core', '1.0')));
  assert.ok(cp.has(jar('org.lib', 'transitive', '2.5')), 'dependencyManagement overrides transitive version');
  assert.ok(!cp.has(jar('org.lib', 'transitive', '2.0')));
  assert.ok(cp.has(jar('org.lib', 'managed', '4.2')));
  assert.ok(cp.has(jar('org.lib', 'junit', '5.0')), 'direct test deps are included');
  assert.ok(!cp.has(jar('org.lib', 'opt', '1.0')), 'optional transitive excluded');
  assert.ok(!cp.has(jar('org.lib', 'testonly', '1.0')), 'test-scoped transitive excluded');
  assert.ok(!cp.has(jar('org.bad', 'excluded', '1.0')), 'exclusion honored');
  assert.ok(cp.has(jar('org.lib', 'ranged', '1.9')), 'highest version inside range');
  assert.ok(cp.has(path.join(ws, 'util', 'target', 'classes')), 'module dependency -> target/classes');
  assert.deepEqual(r.missing, ['org.missing:gone:9.9']);
});

test('detectMavenClasspath finds poms in workspace folders', async () => {
  const r = await detectMavenClasspath([ws], { mode: 'pom', localRepository: repo });
  assert.equal(r.poms.length, 3);
  assert.ok(r.classpath.length >= 6);
  const off = await detectMavenClasspath([ws], { mode: 'off', localRepository: repo });
  assert.equal(off.classpath.length, 0);
});

test('custom settings.xml: localRepository from the settings file and from .mvn/maven.config', async () => {
  const settings = path.join(tmp, 'conf dir', 'my-settings.xml');
  write(settings, `<settings><localRepository>${repo}</localRepository><mirrors/></settings>`);
  assert.equal(findLocalRepository(undefined, settings), repo);
  assert.equal(findLocalRepository('/explicit', settings), '/explicit');

  const r = await detectMavenClasspath([ws], { mode: 'pom', settingsFile: settings });
  assert.ok(r.classpath.includes(jar('org.lib', 'core', '1.0')), 'resolved against the repo of the settings file');

  // Project declaring the settings file in .mvn/maven.config (relative to the project root)
  const ws2 = path.join(tmp, 'ws2');
  write(path.join(ws2, 'pom.xml'), pom(`<groupId>x</groupId><artifactId>y</artifactId><version>1</version><dependencies>${dep('org.lib', 'deep', '3.0')}</dependencies>`));
  write(path.join(ws2, '.mvn', 'maven.config'), `-B
--settings "../conf dir/my-settings.xml"
-U`);
  assert.equal(settingsFromMavenConfig(ws2), settings);
  const r2 = await detectMavenClasspath([ws2], { mode: 'pom' });
  assert.deepEqual(r2.classpath, [jar('org.lib', 'deep', '3.0')]);

  write(path.join(ws2, '.mvn', 'maven.config'), `-s=ignored --settings=conf/s.xml`);
  assert.equal(settingsFromMavenConfig(ws2), path.resolve(ws2, 'conf/s.xml'));
});

test('long classpath goes through a pathing jar that javap understands', async () => {
  const real = path.join(os.homedir(), '.m2', 'repository', 'commons-codec', 'commons-codec', '1.16.1', 'commons-codec-1.16.1.jar');
  if (!fs.existsSync(real)) return;
  // 400 fake entries (with spaces) push the classpath far beyond the Windows command line limit.
  const fakes = Array.from({ length: 400 }, (_, i) => path.join(tmp, 'dir with spaces', `fake-library-number-${i}.jar`));
  const p = new JavaClassProvider({ classpath: [...fakes, real], cacheDir: path.join(tmp, 'cache') });
  await p.init();
  if (!p.available) return;
  const cls = await p.getClass('org.apache.commons.codec.binary.Base64');
  assert.ok(cls, 'class found through pathing jar');
  assert.ok(cls!.methods.some(m => m.name === 'encodeBase64String'));
  assert.ok(fs.readdirSync(path.join(tmp, 'cache')).some(f => /^classpath-.*\.jar$/.test(f)));
  p.dispose();
});
