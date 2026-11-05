import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { GDK_RECEIVERS, SYNTHETIC_CLASSES, getGdkMethods, getSyntheticClass } from '../src/core/gdk';
import { MethodInfo } from '../src/core/model';
import { PRIMITIVES, TypeRef } from '../src/core/typeRef';

const TVARS = new Set(['T', 'K', 'V', 'R', 'Self', 'E', 'V1', 'V2']);

function find(list: MethodInfo[], name: string, paramCount?: number): MethodInfo {
  const m = list.find(x => x.name === name && (paramCount === undefined || x.params.length === paramCount));
  assert.ok(m, `falta ${name}/${paramCount}`);
  return m;
}

function checkRef(t: TypeRef, where: string, errors: string[]): void {
  const ok = t.name.includes('.') || PRIMITIVES.has(t.name) || TVARS.has(t.name);
  if (!ok) errors.push(`${where}: ${t.name}`);
  for (const a of t.args) checkRef(a, where, errors);
}

function checkMethod(m: MethodInfo, where: string, errors: string[]): void {
  const w = `${where}.${m.name}`;
  checkRef(m.returnType, w + ' (retorno)', errors);
  for (const p of m.params) checkRef(p.type, `${w}(${p.name})`, errors);
  for (const types of Object.values(m.closureParams ?? {})) for (const t of types) checkRef(t, w + ' (closure)', errors);
  if (!m.doc || !m.doc.trim()) errors.push(`${w}: sin doc`);
}

test('Iterable: each/collect/findAll', () => {
  const ms = getGdkMethods('java.lang.Iterable');
  const each = find(ms, 'each', 1);
  assert.equal(each.returnType.name, 'Self');
  assert.equal(each.params[0].type.name, 'groovy.lang.Closure');
  assert.deepEqual(each.closureParams?.[0].map(t => t.name), ['T']);
  const collect = find(ms, 'collect', 1);
  assert.deepEqual(collect.returnType, { name: 'java.util.List', args: [{ name: 'R', args: [], dims: 0 }], dims: 0 });
  assert.equal(collect.usesClosureResult, true);
  const findAll = find(ms, 'findAll', 1);
  assert.equal(findAll.returnType.name, 'java.util.List');
  assert.equal(findAll.returnType.args[0].name, 'T');
  assert.ok(!findAll.usesClosureResult);
  const ewi = find(ms, 'eachWithIndex', 1);
  assert.deepEqual(ewi.closureParams?.[2].map(t => t.name), ['T', 'java.lang.Integer']);
  for (const m of ms) assert.equal(m.origin, 'gdk');
  for (const m of ms) assert.equal(m.declaringType, 'java.lang.Iterable');
});

test('Map: closureParams de each', () => {
  const each = find(getGdkMethods('java.util.Map'), 'each', 1);
  assert.deepEqual(each.closureParams?.[2].map(t => t.name), ['K', 'V']);
  assert.equal(each.closureParams?.[1][0].name, 'java.util.Map$Entry');
  assert.deepEqual(each.closureParams?.[1][0].args.map(t => t.name), ['K', 'V']);
  const fa = find(getGdkMethods('java.util.Map'), 'findAll', 1);
  assert.equal(fa.returnType.name, 'java.util.Map');
});

test('String / CharSequence', () => {
  const cs = getGdkMethods('java.lang.CharSequence');
  const pad = find(cs, 'padLeft', 2);
  assert.equal(pad.returnType.name, 'java.lang.String');
  assert.equal(pad.params[0].type.name, 'java.lang.Number');
  assert.equal(pad.params[0].name, 'numberOfChars');
  const el = find(cs, 'eachLine', 1);
  assert.deepEqual(el.closureParams?.[2].map(t => t.name), ['java.lang.String', 'java.lang.Integer']);
  find(getGdkMethods('java.lang.String'), 'execute', 0);
});

test('varargs y otros receptores', () => {
  const printf = find(getGdkMethods('java.lang.Object'), 'printf');
  assert.equal(printf.varargs, true);
  assert.equal(printf.params[1].type.dims, 1);
  const times = find(getGdkMethods('java.lang.Number'), 'times');
  assert.deepEqual(times.closureParams?.[0].map(t => t.name), ['java.lang.Integer']);
  assert.ok(getGdkMethods('[]').length > 20);
  assert.ok(getGdkMethods('java.io.File').some(m => m.name === 'eachFileRecurse'));
  assert.deepEqual(getGdkMethods('no.existe'), []);
});

test('todas las referencias de tipo están cualificadas y documentadas', () => {
  const errors: string[] = [];
  for (const r of GDK_RECEIVERS) {
    const ms = getGdkMethods(r);
    assert.ok(ms.length > 0, r);
    for (const m of ms) {
      checkMethod(m, r, errors);
      assert.equal(m.declaringType, r);
    }
  }
  for (const c of SYNTHETIC_CLASSES) {
    if (c.superClass) checkRef(c.superClass, c.qualifiedName + ' super', errors);
    for (const i of c.interfaces) checkRef(i, c.qualifiedName + ' impl', errors);
    for (const m of [...c.methods, ...c.constructors]) checkMethod(m, c.qualifiedName, errors);
    for (const f of c.fields) checkRef(f.type, `${c.qualifiedName}.${f.name}`, errors);
    assert.ok(c.doc);
  }
  assert.deepEqual(errors, []);
});

test('clases sintéticas', () => {
  const cl = getSyntheticClass('groovy.lang.Closure');
  assert.ok(cl);
  assert.deepEqual(cl.typeParams, ['V']);
  for (const n of ['call', 'curry', 'memoize', 'rcurry', 'trampoline', 'dehydrate', 'rehydrate']) assert.ok(cl.methods.some(m => m.name === n), n);
  assert.equal(find(cl.methods, 'call', 0).returnType.name, 'V');
  const df = cl.fields.find(f => f.name === 'DELEGATE_FIRST');
  assert.ok(df && df.isStatic);
  const ir = getSyntheticClass('groovy.lang.IntRange');
  assert.ok(ir?.interfaces.some(i => i.name === 'java.util.List' && i.args[0].name === 'java.lang.Integer'));
  assert.equal(find(getSyntheticClass('groovy.json.JsonSlurper')!.methods, 'parseText').returnType.name, 'java.lang.Object');
  assert.equal(find(getSyntheticClass('groovy.xml.XmlSlurper')!.methods, 'parseText').returnType.name, 'groovy.xml.slurpersupport.GPathResult');
  assert.ok(find(getSyntheticClass('groovy.json.JsonOutput')!.methods, 'toJson', 1).isStatic);
  assert.ok(getSyntheticClass('groovy.lang.GString')?.interfaces.some(i => i.name === 'java.lang.CharSequence'));
  assert.equal(getSyntheticClass('nada'), undefined);
});
