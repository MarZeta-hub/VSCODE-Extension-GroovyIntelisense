import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { GroovyServices } from '../src/core/services';

let svc: GroovyServices;

before(async () => {
  svc = new GroovyServices({ classpath: [], cacheDir: path.join(os.tmpdir(), 'groovy-intellisense-test-cache'), log: () => undefined });
  await svc.init();
  svc.updateFile('file:///ws/model/Person.groovy', `package model

/** Una persona. */
class Person {
  String name
  int age
  List<Address> addresses = []
  Status status
  private String secret

  String greet(String other) { "Hola $other, soy $name" }
  static Person of(String n) { new Person(name: n) }
}

class Address {
  String street
  String city
}

enum Status { ACTIVE, INACTIVE }
`);
});

after(() => svc.dispose());

/** Completes at the `|` marker. */
async function labels(src: string, uri = 'file:///ws/Script.groovy'): Promise<string[]> {
  const offset = src.indexOf('|');
  const text = src.slice(0, offset) + src.slice(offset + 1);
  const r = await svc.complete(uri, text, offset);
  return r.items.map(i => i.label);
}

async function hoverAt(src: string): Promise<string | undefined> {
  const offset = src.indexOf('|');
  const text = src.slice(0, offset) + src.slice(offset + 1);
  return (await svc.hover('file:///ws/Script.groovy', text, offset))?.contents;
}

test('String members after literal and typed variable', async () => {
  assert.ok((await labels('"abc".|')).includes('substring'));
  const l = await labels('String s = foo()\ns.|');
  assert.ok(l.includes('toUpperCase'));
  assert.ok(l.includes('padLeft'), 'GDK String method');
});

test('list literal + GDK + closure it', async () => {
  const l = await labels('def nums = [1, 2, 3]\nnums.|');
  assert.ok(l.includes('add') && l.includes('each') && l.includes('collect'));
  const it = await labels('def nums = [1, 2, 3]\nnums.each { it.| }');
  assert.ok(it.includes('intValue'), 'it is Integer: ' + it.slice(0, 20).join(','));
});

test('generic declared types and chains', async () => {
  const l = await labels('List<String> names = []\nnames.get(0).|');
  assert.ok(l.includes('toLowerCase'));
  const m = await labels('Map<String, List<Integer>> m = [:]\nm.get("a").first().|');
  assert.ok(m.includes('intValue'), m.slice(0, 10).join(','));
});

test('map each with two params and entry', async () => {
  const kv = await labels('def m = [a: 1, b: 2]\nm.each { k, v -> v.| }');
  assert.ok(kv.includes('intValue'));
  const e = await labels('def m = [a: 1, b: 2]\nm.each { it.| }');
  assert.ok(e.includes('getKey') || e.includes('key'), e.slice(0, 10).join(','));
});

test('stream map closure result (SAM + method type var)', async () => {
  const l = await labels('def names = ["a", "b"]\nnames.stream().map { it.length() }.|');
  assert.ok(l.includes('collect') || l.includes('toList'));
  const x = await labels('def names = ["a", "b"]\nnames.stream().filter { it.| }');
  assert.ok(x.includes('isEmpty'), 'Predicate param is String');
  const c = await labels('def names = ["a", "b"]\ndef lens = names.collect { it.length() }\nlens.first().|');
  assert.ok(c.includes('intValue'), 'collect -> List<Integer>');
});

test('workspace class properties, methods and static access', async () => {
  const src = 'import model.Person\ndef p = new Person(name: "Ana")\np.|';
  const l = await labels(src);
  assert.ok(l.includes('name') && l.includes('greet') && l.includes('getName'));
  assert.ok(!l.includes('secret'), 'private hidden outside class');
  const s = await labels('import model.Person\nPerson.|');
  assert.ok(s.includes('of'));
  const chain = await labels('import model.Person\nPerson.of("x").addresses.first().|');
  assert.ok(chain.includes('city'), chain.slice(0, 10).join(','));
  const en = await labels('import model.Status\nStatus.|');
  assert.ok(en.includes('ACTIVE') && en.includes('values'));
});

test('named arguments in constructor', async () => {
  const l = await labels('import model.Person\nnew Person(|)');
  assert.ok(l.includes('name:') && l.includes('age:'));
});

test('JDK static access and class completion with auto-import', async () => {
  assert.ok((await labels('Math.|')).includes('max'));
  const r = await svc.complete('file:///ws/Script.groovy', 'LocalDa', 7);
  const item = r.items.find(i => i.label === 'LocalDate');
  assert.ok(item, 'LocalDate suggested');
  assert.equal(item!.additionalEdits?.[0].newText.trim(), 'import java.time.LocalDate');
  const ld = await labels('import java.time.LocalDate\nLocalDate.now().|');
  assert.ok(ld.includes('plusDays'));
});

test('import completion', async () => {
  const l = await labels('import java.ut|');
  assert.ok(l.includes('util'));
  const c = await labels('import java.util.|');
  assert.ok(c.includes('ArrayList') && c.includes('concurrent'));
});

test('inside class: implicit this members and fields', async () => {
  const src = `class Foo {
  String title
  List<String> tags
  void run() {
    tags.|
  }
}`;
  assert.ok((await labels(src, 'file:///ws/Foo.groovy')).includes('add'));
  const src2 = `class Foo {
  String title
  void run() {
    ti|
  }
}`;
  assert.ok((await labels(src2, 'file:///ws/Foo.groovy')).includes('title'));
});

test('gstring interpolation', async () => {
  const l = await labels('def s = "x"\nprintln "valor: ${s.|}"');
  assert.ok(l.includes('toUpperCase'));
});

test('for loop variable and spread', async () => {
  assert.ok((await labels('List<String> xs = []\nfor (x in xs) {\n  x.|\n}')).includes('trim'));
  assert.ok((await labels('def xs = ["a"]\nxs*.length().|')).includes('sum'));
});

test('signature help', async () => {
  const src = '"abc".substring(1, ';
  const r = await svc.signatureHelp('file:///ws/Script.groovy', src, src.length);
  assert.ok(r);
  assert.equal(r!.activeParameter, 1);
  assert.ok(r!.signatures[r!.activeSignature].label.startsWith('substring('));
});

test('hover', async () => {
  const h = await hoverAt('def nums = [1, 2]\nnu|ms.size()');
  assert.ok(h?.includes('ArrayList<Integer>'), h);
  const h2 = await hoverAt('"x".toUpper|Case()');
  assert.ok(h2?.includes('String toUpperCase'), h2);
});

test('definition of workspace members and locals', async () => {
  const src = 'import model.Person\ndef p = new Person()\np.gre|et("x")';
  const offset = src.indexOf('|');
  const text = src.replace('|', '');
  const locs = await svc.definition('file:///ws/Script.groovy', text, offset);
  assert.equal(locs[0]?.uri, 'file:///ws/model/Person.groovy');
  const src2 = 'def total = 1\nprintln(to|tal)';
  const l2 = await svc.definition('file:///ws/Script.groovy', src2.replace('|', ''), src2.indexOf('|'));
  assert.equal(l2[0]?.line, 0);
});
