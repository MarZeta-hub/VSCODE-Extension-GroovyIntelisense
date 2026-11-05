import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JavaClassProvider, parseJavapOutput, scanJavaSource, javadocToMarkdown } from '../src/core/javaClassProvider';
import { ZipFile } from '../src/core/zip';
import { formatType } from '../src/core/typeRef';

const SAMPLE = `Compiled from "Sample.java"
public abstract class com.acme.Sample<K extends java.lang.Comparable<? super K>, V> extends com.acme.Base<K> implements java.util.Map$Entry<K, V>, java.io.Serializable {
  public static final int MAX;
  protected java.util.List<java.lang.String> names;
  public com.acme.Sample(int, java.lang.String...);
  public abstract V getValue();
  public static <T extends java.lang.Number> java.util.Map$Entry<T, java.util.List<T>> make(T[], int, int) throws java.io.IOException;
  static {};
}
Compiled from "Color.java"
public final class com.acme.Color extends java.lang.Enum<com.acme.Color> {
  public static final com.acme.Color RED;
  public static com.acme.Color[] values();
}
public interface com.acme.Fn<T, R> extends java.util.function.Function<T, R> {
  public abstract R apply(T);
  public default java.lang.String name();
}
`;

test('parseJavapOutput parses headers and members', () => {
  const [s, color, fn] = parseJavapOutput(SAMPLE);
  assert.equal(s.qualifiedName, 'com.acme.Sample');
  assert.equal(s.simpleName, 'Sample');
  assert.equal(s.packageName, 'com.acme');
  assert.deepEqual(s.typeParams, ['K', 'V']);
  assert.equal(s.isAbstract, true);
  assert.equal(formatType(s.superClass, true), 'com.acme.Base<K>');
  assert.deepEqual(s.interfaces.map(i => formatType(i, true)), ['java.util.Map.Entry<K, V>', 'java.io.Serializable']);
  assert.equal(s.fields.length, 2);
  assert.equal(s.fields[0].isStatic, true);
  assert.equal(s.fields[1].visibility, 'protected');
  assert.equal(s.constructors.length, 1);
  assert.equal(s.constructors[0].varargs, true);
  assert.deepEqual(s.constructors[0].params.map(p => p.name), ['i', 'strings']);
  const make = s.methods.find(m => m.name === 'make')!;
  assert.deepEqual(make.typeParams, ['T']);
  assert.equal(make.isStatic, true);
  assert.equal(formatType(make.returnType, true), 'java.util.Map.Entry<T, java.util.List<T>>');
  assert.deepEqual(make.params.map(p => p.name), ['ts', 'i', 'i1']);
  assert.equal(s.methods.find(m => m.name === 'getValue')!.isAbstract, true);
  assert.equal(color.kind, 'enum');
  assert.equal(color.fields[0].isEnumConstant, true);
  assert.equal(fn.kind, 'interface');
  assert.equal(fn.superClass, undefined);
  assert.equal(fn.interfaces[0].name, 'java.util.function.Function');
  assert.equal(fn.methods[0].isAbstract, true);
  assert.equal(fn.methods[1].isAbstract, undefined);
});

test('scanJavaSource extracts parameter names and docs', () => {
  const src = `package x;
/** The class. */
public class Foo<E> {
  /** A field. */
  public static final int MAX = compute(1, 2);
  /** Builds it. @param size the size */
  public Foo(@Deprecated final int size) { if (size > 0) { bar(size); } }
  /**
   * Gets the <code>element</code> at {@code index}. See {@link java.util.List#get(int)}.
   * <p>Second paragraph.
   * @param index the index
   * @return the element
   */
  @SuppressWarnings("unchecked")
  public E get(int index) { return null; }
  public <T> T[] toArray(T[] a, java.util.Map<String, ? extends E> m) throws Exception { return a; }
  enum Inner { /** first */ A(1), B { void f() {} }; void g(String s) {} }
}`;
  const info = scanJavaSource(src);
  const foo = info.get('Foo')!;
  assert.match(foo.doc!, /The class/);
  const get = foo.members.find(m => m.name === 'get')!;
  assert.deepEqual(get.params, [{ name: 'index', type: 'int' }]);
  const md = javadocToMarkdown(get.doc!);
  assert.match(md, /Gets the `element` at `index`/);
  assert.match(md, /`List.get\(\.\.\.\)`/);
  assert.match(md, /Second paragraph/);
  assert.match(md, /`index` — the index/);
  assert.match(md, /\*\*Returns:\*\* the element/);
  assert.deepEqual(foo.members.find(m => m.name === 'Foo')!.params, [{ name: 'size', type: 'int' }]);
  assert.deepEqual(foo.members.find(m => m.name === 'toArray')!.params!.map(p => p.type), ['T[]', 'Map']);
  assert.ok(foo.members.find(m => m.kind === 'field' && m.name === 'MAX')!.doc);
  assert.ok(!foo.members.some(m => m.name === 'bar' || m.name === 'compute'));
  const inner = info.get('Foo$Inner')!;
  assert.deepEqual(inner.members.filter(m => m.kind === 'enumConst').map(m => m.name), ['A', 'B']);
  assert.deepEqual(inner.members.filter(m => m.kind === 'method').map(m => m.name), ['g']);
});

let provider: JavaClassProvider;
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groovy-javap-test-'));
const timings: string[] = [];

before(async () => {
  provider = new JavaClassProvider({ classpath: [], cacheDir });
  await provider.init();
});

after(() => {
  provider.dispose();
  if (timings.length) console.log('timings: ' + timings.join(', '));
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

function skip(t: { skip: (msg: string) => void }): boolean {
  if (!provider.available) { t.skip('no JDK'); return true; }
  return false;
}

test('ArrayList', async t => {
  if (skip(t)) return;
  let t0 = Date.now();
  const c = await provider.getClass('java.util.ArrayList');
  timings.push(`first getClass ${Date.now() - t0}ms`);
  assert.ok(c);
  assert.equal(c.origin, 'jdk');
  assert.equal(c.kind, 'class');
  assert.deepEqual(c.typeParams, ['E']);
  assert.equal(formatType(c.superClass, true), 'java.util.AbstractList<E>');
  assert.ok(c.interfaces.some(i => formatType(i, true) === 'java.util.List<E>'));
  const get = c.methods.find(m => m.name === 'get')!;
  assert.equal(get.returnType.name, 'E');
  assert.equal(get.params[0].name, 'index');
  assert.ok(get.doc && get.doc.length > 10, 'javadoc on get');
  const adds = c.methods.filter(m => m.name === 'add');
  assert.equal(adds.length, 2);
  assert.deepEqual(adds.find(m => m.params.length === 2)!.params.map(p => p.name), ['index', 'element']);
  assert.equal(adds.find(m => m.params.length === 1)!.params[0].name, 'e');
  assert.ok(c.constructors.some(k => k.params[0]?.name === 'initialCapacity'));
  assert.ok(c.doc);
  t0 = Date.now();
  assert.equal(await provider.getClass('java.util.ArrayList'), c);
  timings.push(`cached getClass ${Date.now() - t0}ms`);
});

test('Map$Entry and dotted nested lookup', async t => {
  if (skip(t)) return;
  const a = await provider.getClass('java.util.Map$Entry');
  const b = await provider.getClass('java.util.Map.Entry');
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(a.kind, 'interface');
  assert.equal(a.outer, 'java.util.Map');
  assert.deepEqual(a.typeParams, ['K', 'V']);
  assert.equal(a.methods.find(m => m.name === 'getKey')!.isAbstract, true);
});

test('interface abstract flags', async t => {
  if (skip(t)) return;
  const f = await provider.getClass('java.util.function.Function');
  assert.ok(f);
  assert.equal(f.methods.find(m => m.name === 'apply')!.isAbstract, true);
  assert.ok(!f.methods.find(m => m.name === 'andThen')!.isAbstract);
  assert.equal(f.methods.find(m => m.name === 'apply')!.params[0].name, 't');
});

test('enum constants', async t => {
  if (skip(t)) return;
  const e = await provider.getClass('java.util.concurrent.TimeUnit');
  assert.ok(e);
  assert.equal(e.kind, 'enum');
  assert.equal(e.superClass!.name, 'java.lang.Enum');
  const nanos = e.fields.find(f => f.name === 'NANOSECONDS')!;
  assert.equal(nanos.isEnumConstant, true);
  assert.ok(nanos.doc);
});

test('static methods', async t => {
  if (skip(t)) return;
  const l = await provider.getClass('java.util.List');
  assert.ok(l);
  const ofs = l.methods.filter(m => m.name === 'of');
  assert.ok(ofs.length > 5);
  assert.ok(ofs.every(m => m.isStatic));
  assert.ok(ofs.some(m => m.varargs));
});

test('missing class', async t => {
  if (skip(t)) return;
  assert.equal(await provider.getClass('com.nope.DoesNotExist'), undefined);
  assert.equal(await provider.hasClass('com.nope.DoesNotExist'), false);
});

test('concurrent getClass uses a single javap call', async t => {
  if (skip(t)) return;
  const p = new JavaClassProvider({ classpath: [] });
  await p.init();
  const names = ['java.util.HashMap', 'java.lang.String', 'java.time.LocalDate', 'java.util.Optional', 'java.io.File'];
  const t0 = Date.now();
  const res = await Promise.all(names.map(n => p.getClass(n)));
  timings.push(`5 classes batched ${Date.now() - t0}ms`);
  assert.equal(p.javapInvocations, 1);
  assert.ok(res.every(Boolean));
  p.dispose();
});

test('listClasses', async t => {
  if (skip(t)) return;
  const t0 = Date.now();
  const list = await provider.listClasses();
  timings.push(`listClasses ${list.length} in ${Date.now() - t0}ms`);
  const set = new Set(list);
  assert.ok(set.has('java.util.ArrayList'));
  assert.ok(set.has('java.time.LocalDate'));
  assert.ok(!list.some(n => n.includes('$')));
  assert.ok(!list.some(n => n.startsWith('sun.') || n.includes('.internal.')));
  assert.equal(await provider.hasClass('java.util.HashMap'), true);
});

test('ZipFile reads src.zip entry', t => {
  if (skip(t)) return;
  const zip = ZipFile.open(path.join(provider.javaHome!, 'lib', 'src.zip'));
  if (!zip) { t.skip('no src.zip'); return; }
  try {
    const name = zip.entryNames().find(n => n.endsWith('/java/util/ArrayList.java'))!;
    assert.ok(name);
    assert.ok(zip.has(name));
    const text = zip.read(name)!.toString('utf8');
    assert.match(text, /public class ArrayList<E>/);
    assert.equal(zip.read('does/not/exist'), undefined);
  } finally {
    zip.close();
  }
});

test('persistent cache avoids javap', async t => {
  if (skip(t)) return;
  await provider.getClass('java.util.ArrayList');
  provider.dispose(); // flush
  const p2 = new JavaClassProvider({ classpath: [], cacheDir });
  await p2.init();
  const t0 = Date.now();
  const c = await p2.getClass('java.util.ArrayList');
  timings.push(`from persistent cache ${Date.now() - t0}ms`);
  assert.ok(c);
  assert.equal(p2.javapInvocations, 0);
  assert.equal(c.methods.find(m => m.name === 'get')!.params[0].name, 'index');
  p2.dispose();
});
