// Provides ClassInfo for JDK / classpath classes by running `javap`, enriched with parameter names and javadoc
// taken from src.zip (JDK) or `-sources.jar` files (classpath). Results are batched, cached in memory and persisted.
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ClassInfo, ClassKind, FieldInfo, MethodInfo, Origin, ParamInfo } from './model';
import { TypeRef, packageOf, parseType, splitTopLevel } from './typeRef';
import { ZipFile, pathingManifest, writeStoredZip } from './zip';
import * as os from 'os';

export interface JavaProviderOptions {
  javaHome?: string;
  classpath: string[];
  cacheDir?: string;
  log?: (msg: string) => void;
}

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const BATCH_DELAY_MS = 15;
const JAVAP_TIMEOUT_MS = 20000;
const MAX_CONCURRENT_JAVAP = 2;
const MAX_CMDLINE = 28000;
const PATHING_JAR_THRESHOLD = 6000;
const CACHE_VERSION = 1;
const JDK_PREFIXES = ['java.', 'javax.', 'jdk.', 'org.w3c.', 'org.xml.', 'sun.', 'com.sun.'];
const LIST_PREFIXES = ['java/', 'javax/', 'org/w3c/', 'org/xml/'];

// ---------------------------------------------------------------------------------------------------------------
// javap output parsing

const MODIFIERS = new Set([
  'public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'native', 'default', 'transient',
  'volatile', 'strictfp', 'sealed', 'non-sealed',
]);

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default',
  'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import',
  'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return',
  'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try',
  'void', 'volatile', 'while', 'true', 'false', 'null', 'in', 'as', 'def', 'trait',
]);

const PRIM_NAMES: Record<string, string> = {
  int: 'i', long: 'l', boolean: 'b', char: 'c', double: 'd', float: 'f', short: 'sh', byte: 'b',
  'java.lang.String': 's', 'java.lang.Object': 'o',
};

/** Default parameter name derived from the type (IntelliJ-like when no sources are available). */
export function defaultParamName(t: TypeRef): string {
  const simple = t.name.slice(t.name.lastIndexOf('.') + 1);
  const last = simple.slice(simple.lastIndexOf('$') + 1) || 'arg';
  const decap = /^[A-Z0-9_]+$/.test(last) && last.length > 1 ? last.toLowerCase() : last[0].toLowerCase() + last.slice(1);
  let base = t.dims > 0 ? decap + 's' : PRIM_NAMES[t.name] ?? decap;
  if (JAVA_KEYWORDS.has(base)) base = 'a' + base[0].toUpperCase() + base.slice(1);
  return base;
}

function dedupeNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map(n => {
    let r = n;
    for (let k = 1; used.has(r); k++) r = n + k;
    used.add(r);
    return r;
  });
}

/** `<K extends Comparable<? super K>, V>` -> ['K', 'V'] */
function typeParamNames(text: string): string[] {
  const inner = text.trim().replace(/^</, '').replace(/>$/, '');
  return splitTopLevel(inner, ',').map(p => p.split(/\s+/)[0]);
}

/** Splits `name<...>` into name and type parameter text. */
function splitGenericName(word: string): [string, string] {
  const lt = word.indexOf('<');
  return lt < 0 ? [word, ''] : [word.slice(0, lt), word.slice(lt)];
}

interface RawBlock {
  qname: string;
  text: string;
}

const HEADER_RE = /^(?:[\w-]+\s+)*(class|interface|enum|record|@interface)\s+(\S+)/;

/** Splits javap output into per-class text blocks (header line through closing brace). */
export function splitJavapBlocks(text: string): RawBlock[] {
  const out: RawBlock[] = [];
  const lines = text.split(/\r?\n/);
  let cur: string[] | undefined;
  let qname = '';
  for (const line of lines) {
    if (!cur) {
      if (line.startsWith('Compiled from') || line.startsWith(' ') || !line.trim().endsWith('{')) continue;
      const m = HEADER_RE.exec(line);
      if (!m) continue;
      qname = splitGenericName(m[2])[0];
      cur = [line];
    } else {
      cur.push(line);
      if (line.trim() === '}' && !line.startsWith(' ')) {
        out.push({ qname, text: cur.join('\n') });
        cur = undefined;
      }
    }
  }
  return out;
}

function parseHeader(line: string): Omit<ClassInfo, 'methods' | 'fields' | 'constructors' | 'origin'> | undefined {
  const words = splitTopLevel(line.trim().replace(/\{$/, ''), ' ');
  let i = 0;
  let isAbstract = false;
  for (; i < words.length && MODIFIERS.has(words[i]); i++) if (words[i] === 'abstract') isAbstract = true;
  const kw = words[i++];
  if (!kw || !/^(class|interface|enum|record|@interface)$/.test(kw)) return undefined;
  const [qname, tp] = splitGenericName(words[i++] ?? '');
  if (!qname) return undefined;
  const sections: Record<string, string> = {};
  let section = '';
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === 'extends' || w === 'implements' || w === 'permits') { section = w; sections[w] = ''; continue; }
    if (section) sections[section] += ' ' + w;
  }
  const list = (s?: string) => (s ? splitTopLevel(s, ',').map(parseType) : []);
  let kind: ClassKind = kw === '@interface' ? 'annotation' : (kw as ClassKind);
  const ext = list(sections.extends);
  const impl = list(sections.implements);
  let superClass: TypeRef | undefined;
  let interfaces: TypeRef[];
  if (kind === 'interface' || kind === 'annotation') {
    interfaces = ext;
    if (kind === 'interface' && ext.length === 1 && ext[0].name === 'java.lang.annotation.Annotation') kind = 'annotation';
  } else {
    interfaces = impl;
    superClass = ext[0];
    if (!superClass) {
      if (kind === 'enum') superClass = { name: 'java.lang.Enum', args: [{ name: qname, args: [], dims: 0 }], dims: 0 };
      else if (kind === 'record') superClass = { name: 'java.lang.Record', args: [], dims: 0 };
      else if (qname !== 'java.lang.Object') superClass = { name: 'java.lang.Object', args: [], dims: 0 };
    }
    if (kind === 'class' && superClass?.name === 'java.lang.Enum' && superClass.args[0]?.name === qname) kind = 'enum';
    if (kind === 'class' && superClass?.name === 'java.lang.Record') kind = 'record';
  }
  const dollar = qname.lastIndexOf('$');
  const simple = qname.slice(Math.max(qname.lastIndexOf('.'), dollar) + 1);
  return {
    qualifiedName: qname,
    simpleName: simple,
    packageName: packageOf(qname),
    kind,
    typeParams: tp ? typeParamNames(tp) : [],
    superClass,
    interfaces,
    isAbstract: isAbstract || kind === 'interface' || kind === 'annotation' || undefined,
    outer: dollar > 0 ? qname.slice(0, dollar) : undefined,
  };
}

function parseMember(line: string, cls: ClassInfo, origin: Origin): void {
  let s = line.trim();
  if (!s.endsWith(';')) return;
  s = s.slice(0, -1).trim();
  const close = s.lastIndexOf(')');
  if (close >= 0) {
    const th = s.indexOf(' throws ', close);
    if (th >= 0) s = s.slice(0, th);
  }
  const words = splitTopLevel(s, ' ');
  let i = 0;
  let isStatic = false;
  let isAbstract = false;
  let isFinal = false;
  let visibility: 'public' | 'protected' | 'private' | 'package' = 'package';
  for (; i < words.length && MODIFIERS.has(words[i]); i++) {
    const w = words[i];
    if (w === 'static') isStatic = true;
    else if (w === 'abstract') isAbstract = true;
    else if (w === 'final') isFinal = true;
    else if (w === 'public' || w === 'protected' || w === 'private') visibility = w;
  }
  if (words.slice(i).some(w => w.startsWith('{'))) return; // static {}
  let typeParams: string[] | undefined;
  if (words[i]?.startsWith('<')) typeParams = typeParamNames(words[i++]);
  const rest = words.slice(i);
  const qname = cls.qualifiedName;
  const parseParams = (word: string): [ParamInfo[], boolean] => {
    const inner = word.slice(word.indexOf('(') + 1, word.lastIndexOf(')'));
    const parts = splitTopLevel(inner, ',');
    const types = parts.map(parseType);
    const names = dedupeNames(types.map(defaultParamName));
    return [types.map((type, k) => ({ name: names[k], type })), parts.length > 0 && parts[parts.length - 1].endsWith('...')];
  };
  if (rest.length === 1 && rest[0].includes('(')) {
    const [params, varargs] = parseParams(rest[0]);
    const ctor: MethodInfo = {
      name: cls.simpleName, params, returnType: { name: qname, args: cls.typeParams.map(t => ({ name: t, args: [], dims: 0 })), dims: 0 },
      isStatic: false, isConstructor: true, declaringType: qname, origin, visibility,
    };
    if (typeParams) ctor.typeParams = typeParams;
    if (varargs) ctor.varargs = true;
    cls.constructors.push(ctor);
  } else if (rest.length === 2 && rest[1].includes('(')) {
    const [params, varargs] = parseParams(rest[1]);
    const m: MethodInfo = {
      name: rest[1].slice(0, rest[1].indexOf('(')), params, returnType: parseType(rest[0]), isStatic, declaringType: qname,
      origin, visibility,
    };
    if (isAbstract) m.isAbstract = true;
    if (typeParams) m.typeParams = typeParams;
    if (varargs) m.varargs = true;
    cls.methods.push(m);
  } else if (rest.length === 2) {
    const type = parseType(rest[0]);
    const f: FieldInfo = { name: rest[1], type, isStatic, declaringType: qname, origin, visibility };
    if (isFinal) f.isFinal = true;
    if (cls.kind === 'enum' && isStatic && isFinal && type.name === qname && type.dims === 0) f.isEnumConstant = true;
    cls.fields.push(f);
  }
}

function parseBlock(text: string, origin: Origin): ClassInfo | undefined {
  const lines = text.split(/\r?\n/);
  const header = parseHeader(lines[0]);
  if (!header) return undefined;
  const cls: ClassInfo = { ...header, methods: [], fields: [], constructors: [], origin };
  if (cls.isAbstract === undefined) delete cls.isAbstract;
  if (cls.outer === undefined) delete cls.outer;
  for (let k = 1; k < lines.length; k++) {
    try { parseMember(lines[k], cls, origin); } catch { /* skip unparsable member */ }
  }
  return cls;
}

/** Parses the (possibly multi-class) output of `javap -public`. */
export function parseJavapOutput(text: string, origin: Origin = 'jdk'): ClassInfo[] {
  const out: ClassInfo[] = [];
  for (const b of splitJavapBlocks(text)) {
    const c = parseBlock(b.text, origin);
    if (c) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Lightweight Java source scanner: parameter names + javadoc per member

interface SrcParam { name: string; type: string } // type = erased simple name with [] dims
interface SrcMember { kind: 'method' | 'field' | 'enumConst'; name: string; params?: SrcParam[]; doc?: string }
interface SrcClass { doc?: string; members: SrcMember[] }
type SrcInfo = Map<string, SrcClass>; // key: nested path `Map$Entry`

interface Tok { t: string; pos: number }
interface Javadoc { start: number; end: number; text: string }

function lexJava(src: string): { toks: Tok[]; docs: Javadoc[] } {
  const toks: Tok[] = [];
  const docs: Javadoc[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      if (src[i + 2] === '*' && src[i + 3] !== '/') docs.push({ start: i, end, text: src.slice(i, end) });
      i = end;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const e = src.indexOf('"""', i + 3);
        i = e < 0 ? n : e + 3;
      } else {
        i++;
        while (i < n && src[i] !== '"' && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
        i++;
      }
      toks.push({ t: '"', pos: i });
      continue;
    }
    if (c === '\'') {
      i++;
      while (i < n && src[i] !== '\'' && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      toks.push({ t: '\'', pos: i });
      continue;
    }
    if (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127) {
      const s = i;
      while (i < n && (/[\w$]/.test(src[i]) || src.charCodeAt(i) > 127)) i++;
      toks.push({ t: src.slice(s, i), pos: s });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const s = i;
      while (i < n && /[\w.]/.test(src[i])) i++;
      toks.push({ t: '0', pos: s });
      continue;
    }
    toks.push({ t: c, pos: i });
    i++;
  }
  return { toks, docs };
}

const SRC_MODIFIERS = new Set([...MODIFIERS, 'non', '-']);
const IDENT_RE = /^[A-Za-z_$\u0080-￿][\w$\u0080-￿]*$/;

function eraseSimpleType(tokens: string[]): string {
  let s = tokens.join('');
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(/<[^<>]*>/g, ''); }
  s = s.replace(/\.\.\./g, '[]');
  const dims = (s.match(/\[\]/g) || []).length;
  s = s.replace(/\[\]/g, '');
  return s.slice(s.lastIndexOf('.') + 1) + '[]'.repeat(dims);
}

function parseSrcParams(toks: Tok[], from: number, to: number): SrcParam[] {
  const out: SrcParam[] = [];
  let cur: string[] = [];
  let depth = 0;
  const flush = () => {
    // drop annotations and `final`
    const t: string[] = [];
    for (let k = 0; k < cur.length; k++) {
      if (cur[k] === '@' && IDENT_RE.test(cur[k + 1] ?? '')) {
        k++;
        while (cur[k + 1] === '.' && IDENT_RE.test(cur[k + 2] ?? '')) k += 2;
        if (cur[k + 1] === '(') {
          let d = 0;
          for (k++; k < cur.length; k++) {
            if (cur[k] === '(') d++;
            else if (cur[k] === ')' && --d === 0) break;
          }
        }
        continue;
      }
      if (cur[k] === 'final') continue;
      t.push(cur[k]);
    }
    if (t.length >= 2) out.push({ name: t[t.length - 1], type: eraseSimpleType(t.slice(0, -1)) });
    cur = [];
  };
  for (let k = from; k < to; k++) {
    const t = toks[k].t;
    if (t === '<' || t === '(') depth++;
    else if (t === '>' || t === ')') depth--;
    if (t === ',' && depth === 0) { flush(); continue; }
    cur.push(t);
  }
  if (cur.length) flush();
  return out;
}

function matchBalanced(toks: Tok[], i: number, open: string, close: string): number {
  let d = 0;
  for (let k = i; k < toks.length; k++) {
    if (toks[k].t === open) d++;
    else if (toks[k].t === close && --d === 0) return k;
  }
  return toks.length - 1;
}

type Scope = { kind: 'block' } | { kind: 'class'; path: string; simple: string; info: SrcClass; isEnum: boolean; inConstants: boolean };

/** Scans Java source and returns per-class members with parameter names and raw javadoc. */
export function scanJavaSource(src: string): SrcInfo {
  const { toks, docs } = lexJava(src);
  const result: SrcInfo = new Map();
  const stack: Scope[] = [];
  let segStart = 0; // char offset where the current member declaration started
  let seg: string[] = [];
  let inInit = false;
  let pending: { name: string; isEnum: boolean; doc?: string } | undefined;
  let docIdx = 0;
  const findDoc = (from: number, to: number): string | undefined => {
    // last javadoc entirely inside [from, to)
    while (docIdx > 0 && docs[docIdx - 1].start >= from) docIdx--;
    let found: Javadoc | undefined;
    for (let k = docIdx; k < docs.length && docs[k].end <= to; k++) if (docs[k].start >= from) found = docs[k];
    return found?.text;
  };
  const reset = (pos: number) => { segStart = pos; seg = []; inInit = false; };
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const t = tok.t;
    const top = stack[stack.length - 1];
    if (top && top.kind === 'block') {
      if (t === '{') stack.push({ kind: 'block' });
      else if (t === '}') {
        stack.pop();
        const nt = stack[stack.length - 1];
        if (nt?.kind === 'class' && !inInit) reset(tok.pos + 1);
      }
      continue;
    }
    // annotations
    if (t === '@' && toks[i + 1] && toks[i + 1].t !== 'interface' && IDENT_RE.test(toks[i + 1].t)) {
      i++;
      while (toks[i + 1]?.t === '.' && IDENT_RE.test(toks[i + 2]?.t ?? '')) i += 2;
      if (toks[i + 1]?.t === '(') i = matchBalanced(toks, i + 1, '(', ')');
      continue;
    }
    const cls = top?.kind === 'class' ? top : undefined;
    // enum constants section
    if (cls && cls.isEnum && cls.inConstants) {
      if (IDENT_RE.test(t) && seg.length === 0) {
        seg.push(t);
        cls.info.members.push({ kind: 'enumConst', name: t, doc: findDoc(segStart, tok.pos) });
      } else if (t === '(') i = matchBalanced(toks, i, '(', ')');
      else if (t === '{') stack.push({ kind: 'block' });
      else if (t === ',') reset(tok.pos + 1);
      else if (t === ';') { cls.inConstants = false; reset(tok.pos + 1); }
      else if (t === '}') { stack.pop(); reset(tok.pos + 1); }
      continue;
    }
    if ((t === 'class' || t === 'interface' || t === 'enum' || t === 'record') && toks[i - 1]?.t !== '.'
      && IDENT_RE.test(toks[i + 1]?.t ?? '') && !inInit) {
      pending = { name: toks[i + 1].t, isEnum: t === 'enum', doc: findDoc(segStart, tok.pos) };
      i++;
      continue;
    }
    if (t === '{') {
      if (pending) {
        const path = cls ? cls.path + '$' + pending.name : pending.name;
        const info: SrcClass = result.get(path) ?? { doc: pending.doc, members: [] };
        result.set(path, info);
        stack.push({ kind: 'class', path, simple: pending.name, info, isEnum: pending.isEnum, inConstants: pending.isEnum });
        pending = undefined;
        reset(tok.pos + 1);
      } else stack.push({ kind: 'block' });
      continue;
    }
    if (t === '}') {
      stack.pop();
      reset(tok.pos + 1);
      continue;
    }
    if (!cls) continue;
    if (t === '(') {
      const j = matchBalanced(toks, i, '(', ')');
      if (pending || inInit) { i = j; continue; }
      const name = toks[i - 1]?.t ?? '';
      const after = toks[j + 1]?.t;
      const before = seg.slice(0, -1).filter(w => !SRC_MODIFIERS.has(w));
      const isCtor = name === cls.simple;
      if (IDENT_RE.test(name) && (after === '{' || after === ';' || after === 'throws' || after === 'default')
        && (isCtor || before.length > 0)) {
        cls.info.members.push({ kind: 'method', name, params: parseSrcParams(toks, i + 1, j), doc: findDoc(segStart, toks[i - 1].pos) });
        if (after === 'default') inInit = true;
      }
      i = j;
      seg.push('()');
      continue;
    }
    if (t === '=' && !inInit) {
      const name = seg[seg.length - 1];
      if (seg.length >= 2 && IDENT_RE.test(name)) {
        cls.info.members.push({ kind: 'field', name, doc: findDoc(segStart, toks[i - 1].pos) });
      }
      inInit = true;
      continue;
    }
    if (t === ';') {
      if (!inInit && seg.length >= 2 && IDENT_RE.test(seg[seg.length - 1]) && !seg.includes('()')) {
        cls.info.members.push({ kind: 'field', name: seg[seg.length - 1], doc: findDoc(segStart, toks[i - 1].pos) });
      }
      reset(tok.pos + 1);
      continue;
    }
    seg.push(t);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Javadoc -> markdown

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
    .replace(/&#64;/g, '@').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** Replaces `{@tag body}` inline tags (balanced braces). `protect` shields text from later HTML processing. */
function replaceInlineTags(s: string, protect: (text: string) => string = t => t): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const k = s.indexOf('{@', i);
    if (k < 0) { out += s.slice(i); break; }
    out += s.slice(i, k);
    let d = 0;
    let e = k;
    for (; e < s.length; e++) {
      if (s[e] === '{') d++;
      else if (s[e] === '}' && --d === 0) break;
    }
    const body = s.slice(k + 2, e).trim();
    const sp = body.search(/\s/);
    const tag = sp < 0 ? body : body.slice(0, sp);
    const arg = sp < 0 ? '' : body.slice(sp + 1).trim();
    if (tag === 'code') out += protect('`' + decodeEntities(arg).replace(/\s+/g, ' ') + '`');
    else if (tag === 'literal') out += protect(decodeEntities(arg));
    else if (tag === 'link' || tag === 'linkplain') {
      const m = /^(\S+)(?:\s+([\s\S]+))?$/.exec(arg);
      if (m) {
        if (m[2]) out += m[2];
        else {
          let ref = m[1].replace(/^#/, '').replace(/^(?:[a-z_]\w*\.)+(?=[A-Z])/, '').replace('#', '.');
          ref = ref.replace(/\(.*\)$/, x => (x === '()' ? '()' : '(...)'));
          out += protect('`' + ref + '`');
        }
      }
    } else if (tag === 'inheritDoc') out += '';
    else if (tag === 'value' || tag === 'index' || tag === 'systemProperty') {
      out += arg ? protect('`' + arg.split(/\s+/)[0].replace('#', '.') + '`') : '';
    } else out += arg;
    i = e + 1;
  }
  return out;
}

function htmlToMd(s: string): string {
  const prot: string[] = [];
  const protect = (t: string) => { prot.push(t); return `\u0000${prot.length - 1}\u0000`; };
  // <pre> blocks -> fenced code
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    let code = inner.trim();
    if (code.startsWith('{@code') && code.endsWith('}')) code = code.slice(6, -1);
    else code = replaceInlineTags(code.replace(/<[^>]+>/g, ''));
    const lines = code.replace(/^\s*\n/, '').trimEnd().split('\n');
    const indent = Math.min(...lines.filter(l => l.trim()).map(l => /^ */.exec(l)![0].length));
    code = lines.map(l => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
    return '\n\n' + protect('```java\n' + decodeEntities(code) + '\n```') + '\n\n';
  });
  s = replaceInlineTags(s, protect);
  s = s.replace(/<(code|tt|var|samp|kbd)>([\s\S]*?)<\/\1>/gi, (_, _t: string, c: string) =>
    protect('`' + decodeEntities(c.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').replace(/`/g, '') + '`'));
  s = s.replace(/<\/?(b|strong)>/gi, '**').replace(/<\/?(i|em|cite|dfn)>/gi, '*');
  s = s.replace(/<p\b[^>]*>|<\/p>|<br\s*\/?>|<\/?(ul|ol|dl|table|blockquote|h\d)\b[^>]*>/gi, '\n\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<dt\b[^>]*>/gi, '\n- ').replace(/<dd\b[^>]*>/gi, ': ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // collapse whitespace inside paragraphs
  s = s.split(/\n\s*\n/).map(p => p.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean)
    .map(l => (l.startsWith('- ') ? '\n' + l : ' ' + l)).join('').trim()).filter(Boolean).join('\n\n');
  for (let k = 0; k < 3 && s.includes('\u0000'); k++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => prot[+n]);
  return s.replace(/(^|[^`])``(?!`)/g, '$1').trim();
}

/** Converts a raw `/** ... *\/` javadoc comment to concise markdown. */
export function javadocToMarkdown(raw: string, maxLen = 1500): string {
  const body = raw.replace(/^\/\*\*/, '').replace(/\*\/$/, '').split(/\r?\n/)
    .map(l => l.replace(/^\s*\*( ?)/, '')).join('\n');
  // split description / block tags (tags start a line with @)
  const parts = body.split(/\n(?=\s*@\w)/);
  let desc = parts[0];
  const tags = parts.slice(1).map(p => p.trim());
  if (/^\s*@/.test(desc)) { tags.unshift(desc.trim()); desc = ''; }
  let md = htmlToMd(desc);
  // keep the first paragraphs only
  if (md.length > 900) {
    const paras = md.split('\n\n');
    let acc = '';
    for (const p of paras) {
      if (acc && acc.length + p.length > 900) break;
      acc += (acc ? '\n\n' : '') + p;
    }
    md = acc;
  }
  const params: string[] = [];
  let ret = '';
  const throwsList: string[] = [];
  for (const tag of tags) {
    const m = /^@(\w+)\s*([\s\S]*)$/.exec(tag);
    if (!m) continue;
    const text = htmlToMd(m[2]).replace(/\s+/g, ' ').trim();
    if (m[1] === 'param') {
      const tv = /^\s*<(\w+)>/.exec(m[2]);
      const pm = tv ? [tv[0], '<' + tv[1] + '>', htmlToMd(m[2].replace(/^\s*<\w+>/, '')).replace(/\s+/g, ' ').trim()]
        : /^(\S+)\s*([\s\S]*)$/.exec(text);
      if (pm) params.push(`- \`${pm[1].replace(/`/g, '')}\` — ${pm[2]}`.replace(/ — $/, ''));
    } else if (m[1] === 'return') ret = text;
    else if (m[1] === 'throws' || m[1] === 'exception') {
      const pm = /^(\S+)\s*([\s\S]*)$/.exec(text);
      if (pm) throwsList.push(`- \`${pm[1].replace(/`/g, '')}\` — ${pm[2]}`.replace(/ — $/, ''));
    }
  }
  const out: string[] = [];
  if (md) out.push(md);
  if (params.length) out.push('**Params:**\n' + params.join('\n'));
  if (ret) out.push('**Returns:** ' + ret);
  if (throwsList.length) out.push('**Throws:**\n' + throwsList.join('\n'));
  let res = out.join('\n\n');
  if (res.length > maxLen) {
    res = res.slice(0, maxLen);
    if ((res.match(/```/g) || []).length % 2 === 1) res += '\n```';
    res += ' …';
  }
  return res;
}

function typeSimpleForMatch(t: TypeRef): string {
  const n = t.name.slice(Math.max(t.name.lastIndexOf('.'), t.name.lastIndexOf('$')) + 1);
  return n + '[]'.repeat(t.dims);
}

/** Applies scanned source info (param names + docs) to a parsed class. */
export function enrichClass(cls: ClassInfo, info: SrcInfo): void {
  const pkg = cls.packageName;
  const pathKey = pkg ? cls.qualifiedName.slice(pkg.length + 1) : cls.qualifiedName;
  const sc = info.get(pathKey);
  if (!sc) return;
  if (sc.doc && !cls.doc) cls.doc = javadocToMarkdown(sc.doc);
  const byName = new Map<string, SrcMember[]>();
  for (const m of sc.members) {
    const arr = byName.get(m.name);
    if (arr) arr.push(m); else byName.set(m.name, [m]);
  }
  const apply = (m: MethodInfo, srcName: string) => {
    const cands = (byName.get(srcName) ?? []).filter(s => s.kind === 'method' && s.params!.length === m.params.length);
    if (!cands.length) return;
    let best = cands[0];
    if (cands.length > 1) {
      const sig = m.params.map(p => typeSimpleForMatch(p.type)).join(',');
      best = cands.find(c => c.params!.map(p => p.type).join(',') === sig) ?? best;
    }
    m.params.forEach((p, k) => { if (IDENT_RE.test(best.params![k].name)) p.name = best.params![k].name; });
    if (best.doc && !m.doc) {
      const md = javadocToMarkdown(best.doc);
      if (md) m.doc = md;
    }
  };
  for (const m of cls.methods) apply(m, m.name);
  for (const c of cls.constructors) apply(c, cls.simpleName);
  for (const f of cls.fields) {
    const s = (byName.get(f.name) ?? []).find(x => x.kind !== 'method');
    if (s?.doc && !f.doc) {
      const md = javadocToMarkdown(s.doc);
      if (md) f.doc = md;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fallback class list (used when neither jimage nor rt.jar is available)

const FALLBACK_CLASSES: Record<string, string> = {
  'java.lang': 'Object String StringBuilder StringBuffer Integer Long Short Byte Double Float Boolean Character Number Math '
    + 'StrictMath System Thread Runnable Exception RuntimeException Error Throwable IllegalArgumentException '
    + 'IllegalStateException NullPointerException UnsupportedOperationException IndexOutOfBoundsException '
    + 'ArithmeticException ClassCastException NumberFormatException InterruptedException CloneNotSupportedException '
    + 'Class ClassLoader Enum Iterable Comparable CharSequence AutoCloseable Cloneable Process ProcessBuilder Runtime '
    + 'Void Record Override Deprecated SuppressWarnings FunctionalInterface SafeVarargs ThreadLocal StackTraceElement',
  'java.util': 'List ArrayList LinkedList Map HashMap LinkedHashMap TreeMap Set HashSet LinkedHashSet TreeSet Collection '
    + 'Collections Arrays Iterator ListIterator Optional OptionalInt OptionalLong OptionalDouble Objects Date Calendar '
    + 'GregorianCalendar UUID Random Scanner Properties Queue Deque ArrayDeque PriorityQueue Stack Vector Hashtable '
    + 'Comparator Locale TimeZone StringJoiner Base64 BitSet EnumMap EnumSet IdentityHashMap WeakHashMap SortedMap '
    + 'SortedSet NavigableMap NavigableSet Spliterator NoSuchElementException ConcurrentModificationException Timer '
    + 'TimerTask Currency Formatter StringTokenizer AbstractList AbstractMap AbstractSet AbstractCollection',
  'java.util.concurrent': 'ConcurrentHashMap ConcurrentMap CopyOnWriteArrayList ExecutorService Executors Future '
    + 'CompletableFuture Callable TimeUnit CountDownLatch Semaphore BlockingQueue LinkedBlockingQueue ArrayBlockingQueue '
    + 'ThreadPoolExecutor ScheduledExecutorService ExecutionException TimeoutException ForkJoinPool',
  'java.util.concurrent.atomic': 'AtomicInteger AtomicLong AtomicBoolean AtomicReference',
  'java.util.function': 'Function BiFunction Consumer BiConsumer Supplier Predicate BiPredicate UnaryOperator BinaryOperator',
  'java.util.regex': 'Pattern Matcher',
  'java.util.stream': 'Stream IntStream LongStream DoubleStream Collectors Collector',
  'java.io': 'File InputStream OutputStream Reader Writer BufferedReader BufferedWriter FileReader FileWriter '
    + 'FileInputStream FileOutputStream InputStreamReader OutputStreamWriter PrintStream PrintWriter IOException '
    + 'FileNotFoundException Serializable Closeable StringReader StringWriter ByteArrayInputStream ByteArrayOutputStream',
  'java.nio.file': 'Path Paths Files StandardOpenOption StandardCopyOption',
  'java.nio.charset': 'Charset StandardCharsets',
  'java.net': 'URL URI URLEncoder URLDecoder HttpURLConnection Socket InetAddress',
  'java.math': 'BigDecimal BigInteger RoundingMode MathContext',
  'java.text': 'SimpleDateFormat DateFormat DecimalFormat NumberFormat MessageFormat ParseException',
  'java.time': 'LocalDate LocalDateTime LocalTime Instant Duration Period ZonedDateTime ZoneId ZoneOffset OffsetDateTime '
    + 'DayOfWeek Month Year YearMonth Clock',
  'java.time.format': 'DateTimeFormatter DateTimeParseException',
  'java.time.temporal': 'ChronoUnit ChronoField TemporalAdjusters',
  'java.sql': 'Connection DriverManager PreparedStatement ResultSet Statement SQLException Timestamp',
};

// ---------------------------------------------------------------------------------------------------------------
// Provider

interface PendingReq {
  resolve: (c: ClassInfo | undefined) => void;
}

interface CacheFile {
  version: number;
  classes: Record<string, string>;
}

function dotted(name: string): string {
  return name.replace(/\$/g, '.');
}

function isJdkName(name: string): boolean {
  return JDK_PREFIXES.some(p => name.startsWith(p));
}

function execFileP(file: string, args: string[], timeout = JAVAP_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; error?: Error }> {
  return new Promise(resolve => {
    try {
      cp.execFile(file, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', error: error ?? undefined });
      });
    } catch (e) {
      resolve({ stdout: '', stderr: '', error: e as Error });
    }
  });
}

function hasJavap(home: string | undefined): boolean {
  return !!home && fs.existsSync(path.join(home, 'bin', 'javap' + EXE));
}

export class JavaClassProvider {
  private opts: JavaProviderOptions;
  private _available = false;
  private _javaHome?: string;
  private _javaVersion?: string;
  private initPromise?: Promise<void>;
  private _javapInvocations = 0;

  private classes = new Map<string, ClassInfo>(); // key: dotted name
  private missing = new Set<string>(); // dotted names
  private inflight = new Map<string, Promise<ClassInfo | undefined>>();
  private queue = new Map<string, PendingReq[]>(); // requested name -> waiters
  private timer?: NodeJS.Timeout;
  private running = 0;

  private raw = new Map<string, string>(); // binary qname -> javap block (persistent)
  private rawDotted = new Map<string, string>(); // dotted -> binary qname
  private cacheFile?: string;
  private dirty = false;
  private saveTimer?: NodeJS.Timeout;

  private listPromise?: Promise<string[]>;
  private cpIndex?: Map<string, string>; // binary class name -> container (jar or directory)
  private srcZip?: ZipFile | null;
  private srcZipIndex?: Map<string, string>; // 'java/util/ArrayList.java' -> 'java.base/java/util/ArrayList.java'
  private sourceJars = new Map<string, ZipFile | null>();
  private srcCache = new Map<string, SrcInfo | null>();

  constructor(opts: JavaProviderOptions) {
    this.opts = { ...opts, classpath: opts.classpath ?? [] };
  }

  get available(): boolean { return this._available; }
  get javaHome(): string | undefined { return this._javaHome; }
  get javaVersion(): string | undefined { return this._javaVersion; }
  /** Number of javap processes started (for tests / diagnostics). */
  get javapInvocations(): number { return this._javapInvocations; }

  private log(msg: string): void {
    try { this.opts.log?.(msg); } catch { /* ignore */ }
  }

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit().catch(e => { this._available = false; this.log(`java provider init failed: ${e}`); });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    let home = this.opts.javaHome || process.env.JAVA_HOME;
    let props = '';
    if (!hasJavap(home)) {
      const r = await execFileP('java', ['-XshowSettings:properties', '-version'], 15000);
      props = r.stderr + r.stdout;
      const m = /^\s*java\.home = (.+)$/m.exec(props);
      home = m?.[1].trim();
      // java.home of a JDK 8 points to the jre subdirectory
      if (home && !hasJavap(home) && hasJavap(path.dirname(home))) home = path.dirname(home);
    }
    if (!hasJavap(home)) {
      this.log('javap not found: Java class information unavailable');
      return;
    }
    this._javaHome = home;
    this._javaVersion = this.detectVersion(home!, props);
    this._available = true;
    this.log(`Using JDK ${this._javaHome} (${this._javaVersion ?? 'unknown version'})`);
    this.loadCache();
  }

  private detectVersion(home: string, props: string): string | undefined {
    try {
      const rel = fs.readFileSync(path.join(home, 'release'), 'utf8');
      const m = /^JAVA_VERSION="?([^"\r\n]+)"?/m.exec(rel);
      if (m) return m[1];
    } catch { /* ignore */ }
    const m = /^\s*java\.version = (.+)$/m.exec(props);
    return m?.[1].trim();
  }

  // ---- persistent cache

  private cacheHash(): string {
    const h = crypto.createHash('sha1');
    h.update(String(CACHE_VERSION) + '\0' + this._javaHome + '\0' + this._javaVersion + '\0');
    for (const e of this.opts.classpath) {
      h.update(e + '\0');
      try { h.update(String(fs.statSync(e).mtimeMs) + '\0'); } catch { h.update('missing\0'); }
    }
    return h.digest('hex').slice(0, 16);
  }

  private loadCache(): void {
    if (!this.opts.cacheDir) return;
    try {
      fs.mkdirSync(this.opts.cacheDir, { recursive: true });
      this.cacheFile = path.join(this.opts.cacheDir, `javap-${this.cacheHash()}.json`);
      if (!fs.existsSync(this.cacheFile)) return;
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as CacheFile;
      if (data.version !== CACHE_VERSION || !data.classes) return;
      for (const [q, text] of Object.entries(data.classes)) {
        this.raw.set(q, text);
        this.rawDotted.set(dotted(q), q);
      }
      this.log(`Loaded ${this.raw.size} cached classes from ${this.cacheFile}`);
    } catch (e) {
      this.log(`Failed to load javap cache: ${e}`);
    }
  }

  private scheduleSave(): void {
    if (!this.cacheFile) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.saveCache(); }, 3000);
    this.saveTimer.unref?.();
  }

  private saveCache(): void {
    if (!this.cacheFile || !this.dirty) return;
    try {
      const data: CacheFile = { version: CACHE_VERSION, classes: Object.fromEntries(this.raw) };
      const tmp = this.cacheFile + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.cacheFile);
      this.dirty = false;
    } catch (e) {
      this.log(`Failed to save javap cache: ${e}`);
    }
  }

  dispose(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.saveCache();
    this.srcZip?.close();
    for (const z of this.sourceJars.values()) z?.close();
    this.sourceJars.clear();
  }

  // ---- class lookup

  async getClass(qname: string): Promise<ClassInfo | undefined> {
    await this.init();
    if (!this._available || !qname) return undefined;
    qname = qname.trim();
    const r = await this.lookup(qname);
    if (r) return r;
    // dotted nested form: com.foo.Outer.Inner -> com.foo.Outer$Inner
    const alt = qname.replace(/\.([A-Z][\w$]*)/g, (m, seg: string, off: number, s: string) => {
      const before = s.slice(0, off);
      return /(^|\.)[A-Z][\w$]*$/.test(before) ? '$' + seg : m;
    });
    if (alt !== qname) return this.lookup(alt);
    return undefined;
  }

  private lookup(qname: string): Promise<ClassInfo | undefined> {
    const key = dotted(qname);
    const hit = this.classes.get(key);
    if (hit) return Promise.resolve(hit);
    if (this.missing.has(key)) return Promise.resolve(undefined);
    const bin = this.rawDotted.get(key);
    if (bin) {
      const c = this.fromRaw(bin, this.raw.get(bin)!);
      if (c) return Promise.resolve(c);
    }
    const inf = this.inflight.get(key);
    if (inf) return inf;
    const p = new Promise<ClassInfo | undefined>(resolve => {
      const waiters = this.queue.get(qname);
      if (waiters) waiters.push({ resolve }); else this.queue.set(qname, [{ resolve }]);
      this.scheduleFlush();
    });
    this.inflight.set(key, p);
    return p;
  }

  private fromRaw(bin: string, text: string): ClassInfo | undefined {
    const origin = this.originOf(bin);
    const c = parseBlock(text, origin);
    if (!c) return undefined;
    try { this.enrich(c); } catch (e) { this.log(`enrich ${bin} failed: ${e}`); }
    this.classes.set(dotted(c.qualifiedName), c);
    return c;
  }

  prefetch(qnames: string[]): void {
    for (const q of qnames) {
      if (!q) continue;
      const key = dotted(q);
      if (this.classes.has(key) || this.missing.has(key) || this.inflight.has(key) || this.rawDotted.has(key)) continue;
      this.getClass(q).catch(() => undefined);
    }
  }

  async hasClass(qname: string): Promise<boolean> {
    await this.listClasses();
    if (this.listSet?.has(qname)) return true;
    return (await this.getClass(qname)) !== undefined;
  }

  private cpArgsCache?: string[];

  /** `-cp` arguments; long classpaths (Maven projects) go through a pathing jar to avoid the command line limit. */
  private classpathArgs(): string[] {
    if (this.cpArgsCache) return this.cpArgsCache;
    const list = this.opts.classpath;
    let args = list.length ? ['-cp', list.join(path.delimiter)] : [];
    if (list.join(path.delimiter).length > PATHING_JAR_THRESHOLD) {
      try {
        const dir = this.opts.cacheDir ?? os.tmpdir();
        fs.mkdirSync(dir, { recursive: true });
        const hash = crypto.createHash('sha1').update(list.join('\n')).digest('hex').slice(0, 12);
        const jar = path.join(dir, `classpath-${hash}.jar`);
        if (!fs.existsSync(jar)) writeStoredZip(jar, [{ name: 'META-INF/MANIFEST.MF', data: Buffer.from(pathingManifest(list), 'utf8') }]);
        args = ['-cp', jar];
        this.log(`classpath largo (${list.length} entradas): usando pathing jar ${jar}`);
      } catch (e) {
        this.log(`no se pudo crear el pathing jar: ${e}`);
      }
    }
    this.cpArgsCache = args;
    return args;
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, BATCH_DELAY_MS);
  }

  private flush(): void {
    while (this.queue.size > 0 && this.running < MAX_CONCURRENT_JAVAP) {
      const cpArgs = this.classpathArgs();
      let len = cpArgs.join(' ').length + 200;
      const batch = new Map<string, PendingReq[]>();
      for (const [name, waiters] of this.queue) {
        if (batch.size > 0 && len + name.length + 1 > MAX_CMDLINE) break;
        batch.set(name, waiters);
        len += name.length + 1;
      }
      for (const name of batch.keys()) this.queue.delete(name);
      this.running++;
      this.runJavap(cpArgs, batch).finally(() => {
        this.running--;
        if (this.queue.size > 0) this.scheduleFlush();
      });
    }
  }

  private async runJavap(cpArgs: string[], batch: Map<string, PendingReq[]>): Promise<void> {
    const names = [...batch.keys()];
    const javap = path.join(this._javaHome!, 'bin', 'javap' + EXE);
    const args = ['-J-Xshare:auto', '-J-XX:TieredStopAtLevel=1', '-J-Dstdout.encoding=UTF-8', '-public', ...cpArgs, ...names];
    this._javapInvocations++;
    const t0 = Date.now();
    const r = await execFileP(javap, args);
    this.log(`javap ${names.length} class(es) in ${Date.now() - t0} ms`);
    const found = new Map<string, ClassInfo>();
    const supers = new Set<string>();
    for (const b of splitJavapBlocks(r.stdout)) {
      this.raw.set(b.qname, b.text);
      this.rawDotted.set(dotted(b.qname), b.qname);
      try {
        const c = this.fromRaw(b.qname, b.text);
        if (!c) continue;
        found.set(dotted(c.qualifiedName), c);
        if (c.superClass) supers.add(c.superClass.name);
        for (const i of c.interfaces) supers.add(i.name);
      } catch (e) {
        this.log(`parse ${b.qname} failed: ${e}`);
      }
    }
    if (found.size) this.scheduleSave();
    for (const [name, waiters] of batch) {
      const key = dotted(name);
      const c = found.get(key);
      if (!c) this.missing.add(key);
      this.inflight.delete(key);
      for (const w of waiters) w.resolve(c);
    }
    if (r.error && found.size === 0 && !/class not found/.test(r.stderr)) this.log(`javap failed: ${r.error.message} ${r.stderr.slice(0, 300)}`);
    // resolve supertype chains in one go
    this.prefetch([...supers].filter(s => s.includes('.')));
  }

  // ---- origin & sources

  private originOf(bin: string): Origin {
    if (isJdkName(bin) || this.opts.classpath.length === 0) return 'jdk';
    return this.classpathIndex().has(bin.split('$')[0]) ? 'classpath' : 'jdk';
  }

  /** Map of top-level binary class names found on the classpath -> container path. */
  private classpathIndex(): Map<string, string> {
    if (this.cpIndex) return this.cpIndex;
    const idx = new Map<string, string>();
    const addEntry = (entry: string, container: string) => {
      if (!entry.endsWith('.class') || entry.startsWith('META-INF/')) return;
      const n = entry.slice(0, -6);
      if (n.includes('$') || n.endsWith('module-info') || n.endsWith('package-info')) return;
      const q = n.replace(/[/\\]/g, '.');
      if (!idx.has(q)) idx.set(q, container);
    };
    for (const e of this.opts.classpath) {
      try {
        const st = fs.statSync(e);
        if (st.isDirectory()) {
          const walk = (dir: string, rel: string) => {
            for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
              const r = rel ? rel + '/' + d.name : d.name;
              if (d.isDirectory()) walk(path.join(dir, d.name), r);
              else if (d.isFile()) addEntry(r, e);
            }
          };
          walk(e, '');
        } else {
          const z = ZipFile.open(e);
          if (!z) continue;
          for (const n of z.entryNames()) addEntry(n, e);
          z.close();
        }
      } catch { /* ignore missing entries */ }
    }
    this.cpIndex = idx;
    return idx;
  }

  private enrich(c: ClassInfo): void {
    const top = c.qualifiedName.split('$')[0];
    const rel = top.replace(/\./g, '/') + '.java';
    const info = this.sourceInfo(top, rel, c.origin);
    if (info) enrichClass(c, info);
  }

  private sourceInfo(top: string, rel: string, origin: Origin): SrcInfo | undefined {
    const cached = this.srcCache.get(top);
    if (cached !== undefined) return cached ?? undefined;
    let text: string | undefined;
    try {
      if (origin === 'jdk') {
        const zip = this.jdkSrcZip();
        const entry = zip && this.srcZipIndex!.get(rel);
        if (zip && entry) text = zip.read(entry)?.toString('utf8');
      } else {
        const container = this.classpathIndex().get(top);
        if (container && /\.jar$/i.test(container)) {
          const sj = container.replace(/\.jar$/i, '-sources.jar');
          let z = this.sourceJars.get(sj);
          if (z === undefined) {
            z = fs.existsSync(sj) ? ZipFile.open(sj) ?? null : null;
            this.sourceJars.set(sj, z);
          }
          text = z?.read(rel)?.toString('utf8');
        }
      }
    } catch (e) {
      this.log(`reading sources of ${top} failed: ${e}`);
    }
    let info: SrcInfo | null = null;
    if (text) {
      try { info = scanJavaSource(text); } catch (e) { this.log(`scanning sources of ${top} failed: ${e}`); }
    }
    if (this.srcCache.size > 300) this.srcCache.delete(this.srcCache.keys().next().value!);
    this.srcCache.set(top, info);
    return info ?? undefined;
  }

  private jdkSrcZip(): ZipFile | undefined {
    if (this.srcZip === undefined) {
      this.srcZip = null;
      const candidates = [path.join(this._javaHome!, 'lib', 'src.zip'), path.join(this._javaHome!, 'src.zip')];
      for (const c of candidates) {
        if (!fs.existsSync(c)) continue;
        const z = ZipFile.open(c);
        if (!z) continue;
        this.srcZip = z;
        this.srcZipIndex = new Map();
        for (const n of z.entryNames()) {
          if (!n.endsWith('.java')) continue;
          // JDK 9+: <module>/java/util/ArrayList.java ; JDK 8: java/util/ArrayList.java
          const slash = n.indexOf('/');
          const first = n.slice(0, slash);
          const rel = slash > 0 && first.includes('.') ? n.slice(slash + 1) : n;
          if (!this.srcZipIndex.has(rel)) this.srcZipIndex.set(rel, n);
        }
        break;
      }
    }
    return this.srcZip ?? undefined;
  }

  // ---- class listing

  private listSet?: Set<string>;

  listClasses(): Promise<string[]> {
    if (!this.listPromise) {
      this.listPromise = this.computeList().then(l => { this.listSet = new Set(l); return l; }, () => []);
    }
    return this.listPromise;
  }

  private async computeList(): Promise<string[]> {
    await this.init();
    const out = new Set<string>();
    if (this._available) {
      for (const n of await this.listJdk()) out.add(n);
    }
    for (const n of this.classpathIndex().keys()) out.add(n);
    return [...out].sort();
  }

  private async listJdk(): Promise<string[]> {
    const home = this._javaHome!;
    const res: string[] = [];
    const accept = (entry: string) => {
      if (!entry.endsWith('.class') || entry.includes('$')) return;
      if (!LIST_PREFIXES.some(p => entry.startsWith(p))) return;
      const n = entry.slice(0, -6);
      if (n.endsWith('module-info') || n.endsWith('package-info') || n.includes('/internal/') || n.includes('/sun/')) return;
      res.push(n.replace(/\//g, '.'));
    };
    const jimage = path.join(home, 'bin', 'jimage' + EXE);
    const modules = path.join(home, 'lib', 'modules');
    if (fs.existsSync(jimage) && fs.existsSync(modules)) {
      const r = await execFileP(jimage, ['list', modules], 30000);
      for (const line of r.stdout.split(/\r?\n/)) {
        if (line.startsWith(' ') || line.startsWith('\t')) accept(line.trim());
      }
      if (res.length) return res;
    }
    for (const rt of [path.join(home, 'jre', 'lib', 'rt.jar'), path.join(home, 'lib', 'rt.jar')]) {
      const z = fs.existsSync(rt) ? ZipFile.open(rt) : undefined;
      if (!z) continue;
      for (const n of z.entryNames()) accept(n);
      z.close();
      if (res.length) return res;
    }
    for (const [pkg, names] of Object.entries(FALLBACK_CLASSES)) {
      for (const n of names.split(' ')) res.push(pkg + '.' + n);
    }
    return res;
  }
}
