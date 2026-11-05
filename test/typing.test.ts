import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroovyServices } from '../src/core/services';

// Code being typed: unclosed closures/parens before the cursor, more members after it.
test('completion while typing inside unclosed closure in a class', async () => {
  const svc = new GroovyServices({ classpath: [], log: () => undefined });
  await svc.init();
  const before = `class Shop {
  List<String> items = []
  void run() {
    items.each { it.`;
  const after = `
  }
  int count() { items.size() }
}`;
  const r = await svc.complete('file:///ws/Shop.groovy', before + after, before.length);
  const labels = r.items.map(i => i.label);
  assert.ok(labels.includes('toUpperCase'), labels.slice(0, 15).join(','));
  const before2 = `class Shop {
  List<String> items = []
  void run() {
    println(items.first().`;
  const r2 = await svc.complete('file:///ws/Shop.groovy', before2 + after, before2.length);
  assert.ok(r2.items.some(i => i.label === 'trim'));
  svc.dispose();
});
