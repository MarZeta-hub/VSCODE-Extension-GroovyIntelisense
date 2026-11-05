import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, offsetToPosition, findDocComment, ParsedFile } from '../src/core/sourceParser';

function initText(p: ParsedFile, name: string): string | undefined {
  const v = p.locals.find(l => l.name === name);
  assert.ok(v, 'local ' + name);
  if (!v.init) return undefined;
  return p.tokens.slice(v.init[0], v.init[1]).map(t => t.text).join(' ');
}

function local(p: ParsedFile, name: string) {
  const v = p.locals.find(l => l.name === name);
  assert.ok(v, 'local ' + name + ' not found; have ' + p.locals.map(l => l.name).join(','));
  return v;
}

test('package and imports', () => {
  const src = [
    'package a.b.c',
    'import java.util.List',
    'import java.io.*;',
    'import static java.lang.Math.max',
    'import static java.util.Collections.*',
    'import java.util.concurrent.ConcurrentHashMap as CHM',
    'class X {}',
  ].join('\n');
  const p = parseSource(src, 'file:///X.groovy');
  assert.equal(p.ctx.packageName, 'a.b.c');
  const imps = p.ctx.imports.map(i => [i.name, i.isStatic, i.isStar, i.alias ?? null]);
  assert.deepEqual(imps, [
    ['java.util.List', false, false, null],
    ['java.io', false, true, null],
    ['java.lang.Math.max', true, false, null],
    ['java.util.Collections', true, true, null],
    ['java.util.concurrent.ConcurrentHashMap', false, false, 'CHM'],
  ]);
  const first = p.ctx.imports[0];
  assert.equal(src.slice(first.start, first.end), 'import java.util.List');
  assert.equal(src.slice(p.ctx.imports[1].start, p.ctx.imports[1].end), 'import java.io.*;');
  assert.equal(p.classes[0].qualifiedName, 'a.b.c.X');
  assert.equal(p.ctx.declaredClasses.get('X'), 'a.b.c.X');
});

test('groovy class with properties, methods, ctor, generics, nested class and enum', () => {
  const src = `package demo

/** A person. */
@groovy.transform.ToString(includeNames = true)
class Person<T extends Comparable<T>, U> extends Base<T> implements Serializable, Cloneable {
  String name = 'a'
  private int a, b
  static final List<String> NAMES = []
  def untyped
  /**
   * Greets.
   * @param who the one
   */
  String greet(String who, int times = 1) { return who * times }
  def foo(a, b) { a }
  public <R> R id(R r) throws IOException, RuntimeException { r }
  void rest(String... rest) {}
  Person(String name) { this.name = name }
  static class Inner {
    int x
  }
  enum Color { RED, GREEN('g') { String x() { 'y' } }, BLUE; String code }
}
interface Shape extends A, B {
  double area()
  default String label() { 'shape' }
}
`;
  const p = parseSource(src, 'file:///demo/Person.groovy');
  const names = p.classes.map(c => c.qualifiedName);
  assert.deepEqual(names, ['demo.Person', 'demo.Person$Inner', 'demo.Person$Color', 'demo.Shape']);
  const person = p.classes[0];
  assert.equal(person.doc, 'A person.');
  assert.deepEqual(person.typeParams, ['T', 'U']);
  assert.deepEqual(person.superClass, { name: 'Base', args: [{ name: 'T', args: [], dims: 0 }], dims: 0 });
  assert.deepEqual(person.interfaces.map(i => i.name), ['Serializable', 'Cloneable']);
  const f = (n: string) => person.fields.find(x => x.name === n)!;
  assert.equal(f('name').isProperty, true);
  assert.equal(f('name').type.name, 'String');
  assert.equal(f('a').isProperty, undefined);
  assert.equal(f('a').visibility, 'private');
  assert.equal(f('b').type.name, 'int');
  assert.equal(f('NAMES').isStatic, true);
  assert.equal(f('NAMES').isFinal, true);
  assert.equal(f('NAMES').type.args[0].name, 'String');
  assert.equal(f('untyped').type.name, 'java.lang.Object');
  assert.equal(f('untyped').isProperty, true);
  const m = (n: string) => person.methods.find(x => x.name === n)!;
  assert.equal(m('greet').returnType.name, 'String');
  assert.deepEqual(m('greet').params.map(x => [x.name, x.type.name, !!x.hasDefault]), [['who', 'String', false], ['times', 'int', true]]);
  assert.equal(m('greet').doc, 'Greets.\n@param who the one');
  assert.equal(m('greet').visibility, 'public');
  assert.equal(m('greet').declaringType, 'demo.Person');
  assert.equal(m('greet').location!.line, 13);
  assert.equal(m('foo').returnType.name, 'java.lang.Object');
  assert.equal(m('foo').params[0].type.name, 'java.lang.Object');
  assert.deepEqual(m('id').typeParams, ['R']);
  assert.equal(m('id').returnType.name, 'R');
  assert.equal(m('rest').varargs, true);
  assert.equal(m('rest').params[0].type.dims, 1);
  assert.equal(m('rest').returnType.name, 'void');
  assert.equal(person.constructors.length, 1);
  assert.equal(person.constructors[0].isConstructor, true);
  assert.equal(person.methods.find(x => x.name === 'Person'), undefined);
  assert.equal(p.classes[1].outer, 'demo.Person');
  assert.equal(p.classes[1].fields[0].name, 'x');
  assert.equal(p.ctx.declaredClasses.get('Person.Inner'), 'demo.Person$Inner');
  assert.equal(p.ctx.declaredClasses.get('Inner'), 'demo.Person$Inner');
  const color = p.classes[2];
  assert.equal(color.kind, 'enum');
  const consts = color.fields.filter(x => x.isEnumConstant);
  assert.deepEqual(consts.map(x => x.name), ['RED', 'GREEN', 'BLUE']);
  assert.equal(consts[0].type.name, 'demo.Person$Color');
  assert.equal(consts[0].isStatic, true);
  assert.ok(color.fields.find(x => x.name === 'code' && !x.isEnumConstant));
  assert.equal(color.methods.length, 0, 'methods of constant bodies do not leak');
  const shape = p.classes[3];
  assert.equal(shape.kind, 'interface');
  assert.deepEqual(shape.interfaces.map(i => i.name), ['A', 'B']);
  assert.equal(shape.superClass, undefined);
  assert.equal(shape.methods.find(x => x.name === 'area')!.isAbstract, true);
  assert.equal(shape.methods.find(x => x.name === 'label')!.isAbstract, undefined);
  // ranges
  const pr = p.classRanges.find(r => r.cls === person)!;
  assert.ok(src.slice(pr.start).startsWith('@groovy'));
  assert.equal(src[pr.bodyStart], '{');
  const greetRange = p.memberRanges.find(r => r.method.name === 'greet')!;
  assert.equal(greetRange.owner, 'demo.Person');
  assert.equal(src.slice(greetRange.start, greetRange.end), 'String greet(String who, int times = 1) { return who * times }');
  assert.equal(src[greetRange.bodyStart], '{');
  // params are locals scoped to the body
  const who = p.locals.find(l => l.name === 'who')!;
  assert.equal(who.kind, 'param');
  assert.equal(who.scopeEnd, greetRange.end);
});

test('java class file', () => {
  const src = `package com.acme;

import java.util.*;

/**
 * Doc.
 */
public final class Util<K, V> extends AbstractMap<K, V> implements Map<K, V>, java.io.Serializable {
  private static final long serialVersionUID = 1L;
  int count;
  protected Map.Entry<K, V>[] entries;
  public Util() { super(); }
  @Override
  public Set<Map.Entry<K, V>> entrySet() { return null; }
  abstract void x();
  static <T extends Comparable<? super T>> void sort(List<T> list) {
    for (Map.Entry<String, Integer> e : map.entrySet()) { }
    for (int i = 0, j = 1; i < 10; i++) { }
    try (InputStream in = open()) { } catch (IOException | RuntimeException ex) { }
    Runnable r = new Runnable() { public void run() { int z = 1; } };
  }
  public @interface Ann { String value() default ""; int n() default 1; }
  record Point(int x, int y) { }
}
`;
  const p = parseSource(src, 'file:///Util.java');
  const util = p.classes[0];
  assert.equal(util.qualifiedName, 'com.acme.Util');
  assert.equal(util.doc, 'Doc.');
  assert.equal(util.superClass!.name, 'AbstractMap');
  assert.deepEqual(util.interfaces.map(i => i.name), ['Map', 'java.io.Serializable']);
  const count = util.fields.find(f => f.name === 'count')!;
  assert.equal(count.visibility, 'package');
  assert.equal(count.isProperty, undefined);
  const entries = util.fields.find(f => f.name === 'entries')!;
  assert.equal(entries.type.name, 'Map.Entry');
  assert.equal(entries.type.dims, 1);
  assert.equal(util.constructors.length, 1);
  const es = util.methods.find(m => m.name === 'entrySet')!;
  assert.equal(es.returnType.args[0].name, 'Map.Entry');
  assert.equal(util.methods.find(m => m.name === 'x')!.isAbstract, true);
  const sort = util.methods.find(m => m.name === 'sort')!;
  assert.equal(sort.isStatic, true);
  assert.deepEqual(sort.typeParams, ['T']);
  assert.equal(sort.visibility, 'package');
  const e = local(p, 'e');
  assert.equal(e.kind, 'forVar');
  assert.equal(e.type!.name, 'Map.Entry');
  assert.equal(p.tokens.slice(e.iterSource![0], e.iterSource![1]).map(t => t.text).join(''), 'map.entrySet()');
  assert.equal(local(p, 'i').kind, 'local');
  assert.equal(initText(p, 'i'), '0');
  assert.equal(initText(p, 'j'), '1');
  assert.equal(local(p, 'in').type!.name, 'InputStream');
  const ex = local(p, 'ex');
  assert.equal(ex.kind, 'catch');
  assert.equal(ex.type!.name, 'IOException');
  assert.equal(local(p, 'r').type!.name, 'Runnable');
  assert.equal(local(p, 'z').kind, 'local');
  assert.ok(!util.methods.find(m => m.name === 'run'), 'anonymous class methods not added');
  const ann = p.classes.find(c => c.simpleName === 'Ann')!;
  assert.equal(ann.kind, 'annotation');
  assert.deepEqual(ann.methods.map(m => m.name), ['value', 'n']);
  const point = p.classes.find(c => c.simpleName === 'Point')!;
  assert.equal(point.kind, 'record');
  assert.equal(point.qualifiedName, 'com.acme.Util$Point');
  assert.deepEqual(point.fields.map(f => f.name), ['x', 'y']);
  assert.deepEqual(point.methods.map(m => m.name + ':' + m.returnType.name), ['x:int', 'y:int']);
  assert.equal(p.scriptMethods.length, 0);
});

test('script methods and top-level locals', () => {
  const src = `def foo(x) { x + 1 }
String bar() { 'b' }
static void main(String[] args) { println args }
foo(1)
def a = foo(2)
println a
`;
  const p = parseSource(src, 'file:///script.groovy');
  assert.deepEqual(p.scriptMethods.map(m => m.name), ['foo', 'bar', 'main']);
  assert.equal(p.scriptMethods[0].declaringType, undefined);
  assert.equal(p.scriptMethods[1].returnType.name, 'String');
  assert.equal(p.scriptMethods[2].isStatic, true);
  assert.equal(p.scriptMethods[2].params[0].type.dims, 1);
  assert.equal(p.memberRanges.length, 3);
  assert.equal(p.memberRanges[0].owner, undefined);
  assert.equal(local(p, 'x').kind, 'param');
  const a = local(p, 'a');
  assert.equal(a.scopeEnd, src.length);
  assert.equal(initText(p, 'a'), 'foo ( 2 )');
  assert.equal(p.locals.filter(l => l.name === 'args').length, 1);
});

test('locals of every kind', () => {
  const src = `def x = 1 + 2
var y = 'a'
final z = 3
final String s
String t = "x", u = 'y'
List<String> la, lb = []
int[] arr
def (d1, d2) = [1, 2]
Map<String, List<Integer>> m = [:]
java.util.List<String> q = null
w = 5
for (it2 in [1, 2]) { }
for (def k in list) { }
for (String v : names) {}
if (x) {
  def inner = 1
}
println x
x == 3
`;
  const p = parseSource(src, 'file:///s.groovy');
  assert.equal(initText(p, 'x'), '1 + 2');
  assert.equal(local(p, 'x').type, undefined);
  assert.equal(initText(p, 'y'), "'a'");
  assert.equal(initText(p, 'z'), '3');
  assert.equal(local(p, 's').type!.name, 'String');
  assert.equal(local(p, 's').init, undefined);
  assert.equal(initText(p, 't'), '"x"');
  assert.equal(initText(p, 'u'), "'y'");
  assert.equal(local(p, 'u').type!.name, 'String');
  assert.equal(local(p, 'la').type!.args[0].name, 'String');
  assert.equal(initText(p, 'lb'), '[ ]');
  assert.equal(local(p, 'arr').type!.dims, 1);
  assert.equal(local(p, 'd1').kind, 'local');
  assert.equal(local(p, 'd2').init, undefined);
  const mt = local(p, 'm').type!;
  assert.equal(mt.name, 'Map');
  assert.equal(mt.args[1].args[0].name, 'Integer');
  assert.equal(initText(p, 'm'), '[ : ]');
  assert.equal(local(p, 'q').type!.name, 'java.util.List');
  assert.equal(local(p, 'w').kind, 'assign');
  assert.equal(initText(p, 'w'), '5');
  const it2 = local(p, 'it2');
  assert.equal(it2.kind, 'forVar');
  assert.equal(p.tokens.slice(it2.iterSource![0], it2.iterSource![1]).map(t => t.text).join(' '), '[ 1 , 2 ]');
  assert.equal(local(p, 'k').kind, 'forVar');
  assert.equal(local(p, 'v').type!.name, 'String');
  const inner = local(p, 'inner');
  assert.equal(src.slice(inner.scopeEnd - 1, inner.scopeEnd), '}');
  assert.equal(inner.scopeStart, src.indexOf('inner ='));
  assert.equal(local(p, 'x').scopeEnd, src.length);
  const pos = offsetToPosition(p.lineStarts, src.indexOf('inner ='));
  assert.equal(inner.line, pos.line);
  assert.equal(inner.character, 6);
  // println x and x == 3 are not declarations
  assert.equal(p.locals.filter(l => l.name === 'x').length, 1);
  assert.ok(!p.locals.find(l => l.name === 'println'));
});

test('multi-line chained init', () => {
  const src = `def s = foo
  .bar()
  ?.baz()
def t = 1 +
  2
def u = 3
next()
`;
  const p = parseSource(src, 'file:///s.groovy');
  assert.equal(initText(p, 's'), 'foo . bar ( ) ?. baz ( )');
  assert.equal(initText(p, 't'), '1 + 2');
  assert.equal(initText(p, 'u'), '3');
});

test('closures', () => {
  const src = `list.each { println it }
map.each { k, v -> println k }
foo(1, 2) { String s -> s }
bar(x, { a -> a })
names.collect { Map.Entry<String, Integer> e -> e.key }.findAll { it }
def c = { int a, b = 2 -> a + b }
def nested = list.collect { x ->
  def y = x * 2
  y.with { z -> z }
}
`;
  const p = parseSource(src, 'file:///c.groovy');
  const cs = p.closures;
  const name = (i: number | undefined) => (i === undefined ? undefined : p.tokens[i].text);
  assert.equal(cs.length, 9);
  assert.equal(cs[0].explicitParams, false);
  assert.deepEqual(cs[0].params, []);
  assert.equal(name(cs[0].callNameIndex), 'each');
  assert.equal(cs[0].argIndex, 0);
  assert.equal(cs[0].bodyStartIndex, cs[0].openIndex + 1);
  assert.deepEqual(cs[1].params.map(x => x.name), ['k', 'v']);
  assert.equal(cs[1].explicitParams, true);
  assert.equal(p.tokens[cs[1].bodyStartIndex].text, 'println');
  assert.equal(name(cs[2].callNameIndex), 'foo');
  assert.equal(cs[2].argIndex, 2);
  assert.equal(cs[2].params[0].type!.name, 'String');
  assert.equal(name(cs[3].callNameIndex), 'bar');
  assert.equal(cs[3].argIndex, 1);
  assert.equal(cs[4].params[0].type!.name, 'Map.Entry');
  assert.equal(name(cs[4].callNameIndex), 'collect');
  assert.equal(name(cs[5].callNameIndex), 'findAll');
  assert.equal(cs[6].callNameIndex, undefined);
  assert.deepEqual(cs[6].params.map(x => x.name + ':' + (x.type?.name ?? '')), ['a:int', 'b:']);
  const kp = local(p, 'k');
  assert.equal(kp.kind, 'closureParam');
  assert.equal(kp.scopeEnd, cs[1].end);
  assert.equal(src[cs[1].end - 1], '}');
  assert.equal(local(p, 'y').scopeEnd, cs[7].end);
  assert.equal(local(p, 'z').kind, 'closureParam');
  assert.equal(name(cs[8].callNameIndex), 'with');
  // closure inside init still registered, init covers it
  assert.equal(initText(p, 'c'), '{ int a , b = 2 -> a + b }');
});

test('control blocks are not closures', () => {
  const src = `if (a) { x() } else { y() }
while (b) { }
try { } catch (e) { } finally { }
switch (v) { case 1: break }
synchronized (lock) { }
`;
  const p = parseSource(src, 'file:///c.groovy');
  assert.equal(p.closures.length, 0);
  assert.equal(local(p, 'e').kind, 'catch');
});

test('broken / incomplete code does not throw', () => {
  const samples = [
    'class A {\n  def foo() {\n    list.each { x ->\n',
    'def x = \n',
    'import ',
    'import java.util.',
    'class',
    'class B extends',
    'def foo(a, b',
    'list.collect { a, b',
    'for (x in ',
    'catch (',
    '}}}) ] def y = 1',
    'enum E { A, B(',
    'String s = "unterminated',
    'interface I { void x( }',
    '@',
    'def (a, ',
    'Map<String, List<',
    'new Runnable() {',
  ];
  for (const s of samples) {
    const p = parseSource(s, 'file:///b.groovy');
    assert.ok(p);
    parseSource(s, 'file:///b.java');
  }
  const p = parseSource('class A {\n  def foo() {\n    def v = 1\n', 'file:///b.groovy');
  assert.equal(p.classRanges[0].end, p.text.length);
  assert.equal(p.memberRanges[0].end, p.text.length);
  assert.equal(local(p, 'v').scopeEnd, p.text.length);
});

test('doc comments', () => {
  const src = `/** Hello
 * world */
def foo() {}
/* not doc */
def bar() {}
`;
  const p = parseSource(src, 'file:///d.groovy');
  assert.equal(p.scriptMethods[0].doc, 'Hello\nworld');
  assert.equal(p.scriptMethods[1].doc, undefined);
  assert.equal(findDocComment(p, 0), 'Hello\nworld');
});

test('performance on a large file', () => {
  const parts: string[] = ['package perf'];
  for (let i = 0; i < 250; i++) {
    parts.push(`class C${i} {`, `  String name${i} = 'x'`, `  def m${i}(a, b) {`, `    def r = a.collect { it * 2 }`,
      `    for (x in r) { println x }`, `    return r`, `  }`, '}', '', `def v${i} = new C${i}()`, `v${i}.m${i}(1, 2)`,
      `list.each { a, b -> a + b }`, `String s${i} = "a" +`, `  "b"`, `if (s${i}) {`, `  println s${i}`, '}', '', '', '');
  }
  const src = parts.join('\n');
  const t0 = Date.now();
  const p = parseSource(src, 'file:///perf.groovy');
  const dt = Date.now() - t0;
  assert.equal(p.classes.length, 250);
  assert.ok(dt < 300, 'took ' + dt + 'ms');
});
