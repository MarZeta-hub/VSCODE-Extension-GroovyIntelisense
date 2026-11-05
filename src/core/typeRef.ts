// Representation of (possibly generic) type references and helpers to parse, format and substitute them.

export interface TypeRef {
  /** Fully qualified binary name (java.util.Map$Entry), a type variable (E), a primitive (int) or an unresolved simple name. */
  name: string;
  args: TypeRef[];
  /** Array dimensions. */
  dims: number;
  /** Wildcard: `?` (any), `? extends X` (extends, name = X), `? super X` (super, name = X). */
  wildcard?: 'any' | 'extends' | 'super';
}

export const PRIMITIVES = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'void']);

const BOXES: Record<string, string> = {
  boolean: 'java.lang.Boolean',
  byte: 'java.lang.Byte',
  char: 'java.lang.Character',
  short: 'java.lang.Short',
  int: 'java.lang.Integer',
  long: 'java.lang.Long',
  float: 'java.lang.Float',
  double: 'java.lang.Double',
  void: 'java.lang.Void',
};

export const OBJECT = 'java.lang.Object';

export function ref(name: string, args: TypeRef[] = [], dims = 0): TypeRef {
  return { name, args, dims };
}

export function objectRef(): TypeRef {
  return ref(OBJECT);
}

export function isPrimitive(t: TypeRef): boolean {
  return t.dims === 0 && PRIMITIVES.has(t.name);
}

/** Boxes primitive types (int -> java.lang.Integer). Arrays and other types are returned unchanged. */
export function boxed(t: TypeRef): TypeRef {
  if (t.dims === 0 && BOXES[t.name]) return ref(BOXES[t.name]);
  return t;
}

/** Strips a wildcard: `? extends X` / `? super X` -> X, `?` -> Object. */
export function unwildcard(t: TypeRef): TypeRef {
  if (!t.wildcard) return t;
  if (t.wildcard === 'any') return objectRef();
  return { name: t.name, args: t.args, dims: t.dims };
}

/** Splits `s` on `sep` occurrences that are not nested inside <>, (), [] or {}. */
export function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth--;
    if (depth === 0 && s.startsWith(sep, i)) {
      out.push(cur);
      cur = '';
      i += sep.length - 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(x => x.length > 0);
}

/**
 * Parses a textual type: `java.util.Map$Entry<K, V>`, `List<? extends Number>[]`, `String...` (varargs -> one extra dim),
 * `int`, `? super T`. Whitespace is tolerated.
 */
export function parseType(text: string): TypeRef {
  let s = text.trim();
  if (s.startsWith('?')) {
    const rest = s.slice(1).trim();
    if (rest.startsWith('extends ')) return { ...parseType(rest.slice(8)), wildcard: 'extends' };
    if (rest.startsWith('super ')) return { ...parseType(rest.slice(6)), wildcard: 'super' };
    return { name: OBJECT, args: [], dims: 0, wildcard: 'any' };
  }
  let dims = 0;
  for (;;) {
    if (s.endsWith('...')) { dims++; s = s.slice(0, -3).trim(); continue; }
    if (s.endsWith('[]')) { dims++; s = s.slice(0, -2).trim(); continue; }
    break;
  }
  const lt = s.indexOf('<');
  if (lt < 0) return { name: s.replace(/\s+/g, ''), args: [], dims };
  const name = s.slice(0, lt).trim();
  const gt = s.lastIndexOf('>');
  const inner = s.slice(lt + 1, gt < 0 ? s.length : gt);
  const args = inner.trim() === '' ? [] : splitTopLevel(inner, ',').map(parseType);
  return { name, args, dims };
}

/** Simple (display) name of a qualified/binary name: java.util.Map$Entry -> Map.Entry */
export function simpleName(qname: string): string {
  const lastDot = qname.lastIndexOf('.');
  return qname.slice(lastDot + 1).replace(/\$/g, '.');
}

export function packageOf(qname: string): string {
  const lastDot = qname.lastIndexOf('.');
  return lastDot < 0 ? '' : qname.slice(0, lastDot);
}

/** Formats a type for display. `qualified=false` prints simple names (IntelliJ style). */
export function formatType(t: TypeRef | undefined, qualified = false): string {
  if (!t) return 'Object';
  let base = qualified ? t.name.replace(/\$/g, '.') : simpleName(t.name);
  if (t.args.length) base += '<' + t.args.map(a => formatType(a, qualified)).join(', ') + '>';
  base += '[]'.repeat(t.dims);
  if (t.wildcard === 'any') return '?';
  if (t.wildcard === 'extends') return '? extends ' + base;
  if (t.wildcard === 'super') return '? super ' + base;
  return base;
}

/** Stable key including generics, used for caching. */
export function typeKey(t: TypeRef): string {
  return formatType(t, true);
}

/** Replaces type variables using `map`. Type variables are identified by name only. */
export function substitute(t: TypeRef, map: Map<string, TypeRef>): TypeRef {
  if (map.size === 0) return t;
  const repl = t.args.length === 0 ? map.get(t.name) : undefined;
  if (repl) {
    const r: TypeRef = { name: repl.name, args: repl.args, dims: repl.dims + t.dims };
    if (t.wildcard && t.wildcard !== 'any') r.wildcard = t.wildcard;
    else if (repl.wildcard) r.wildcard = repl.wildcard;
    return r;
  }
  if (t.args.length === 0) return t;
  return { ...t, args: t.args.map(a => substitute(a, map)) };
}

/** Element type of arrays (String[] -> String). */
export function componentType(t: TypeRef): TypeRef | undefined {
  if (t.dims === 0) return undefined;
  return { name: t.name, args: t.args, dims: t.dims - 1 };
}

/** True when the name looks like a type variable of the given list (or a single uppercase letter when list omitted). */
export function isTypeVar(name: string, tvars?: Iterable<string>): boolean {
  if (tvars) {
    for (const v of tvars) if (v === name) return true;
    return false;
  }
  return /^[A-Z][A-Z0-9]?$/.test(name);
}
