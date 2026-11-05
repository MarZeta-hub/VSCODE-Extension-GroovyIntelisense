// Tolerant structural parser for Groovy/Java sources: package, imports, classes, members, locals and closures.
// It works on the tokens of `tokenize()` and never throws on incomplete code.
import { Comment, Token, tokenize, isOp, DOT_OPERATORS } from './tokenizer';
import {
  ClassInfo, ClassKind, ClassRange, ClosureInfo, FieldInfo, FileContext, ImportInfo, LocalVar, MemberRange, MethodInfo,
  ParamInfo, SourceLocation,
} from './model';
import { PRIMITIVES, TypeRef, parseType, ref, OBJECT } from './typeRef';

export interface ParsedFile {
  text: string;
  uri: string;
  tokens: Token[];
  comments: Comment[];
  lineStarts: number[];
  ctx: FileContext;
  classes: ClassInfo[];
  scriptMethods: MethodInfo[];
  locals: LocalVar[];
  closures: ClosureInfo[];
  classRanges: ClassRange[];
  memberRanges: MemberRange[];
}

const OPENERS = new Set(['(', '[', '{', '?[']);
const CLOSER_TO_OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const MODIFIERS = new Set([
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native', 'transient', 'volatile',
  'strictfp', 'default', 'sealed', 'def', 'var',
]);
/** Keywords of the tokenizer that may still be used as names. */
const SOFT_KEYWORDS = new Set(['record', 'sealed', 'permits', 'yield', 'trait']);
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized']);
const BLOCK_KEYWORDS = new Set(['else', 'try', 'finally', 'do', 'static']);
const NON_BINARY_OPS = new Set([')', ']', '}', '++', '--', ';']);
const BINARY_KEYWORDS = new Set(['instanceof', 'in', 'as', 'new']);
const CLASS_KEYWORDS: Record<string, ClassKind> = {
  class: 'class', interface: 'interface', enum: 'enum', trait: 'trait', record: 'record',
};

interface TypeAt {
  ref: TypeRef;
  end: number;
  varargs: boolean;
  /** Has generics or array suffix. */
  suffix: boolean;
  /** Last name segment starts with an uppercase letter. */
  upper: boolean;
  primitive: boolean;
}

interface ParamDecl {
  name: string;
  nameIdx: number;
  type?: TypeRef;
  hasDefault: boolean;
  varargs: boolean;
}

export function parseSource(text: string, uri: string): ParsedFile {
  return new Parser(text, uri).run();
}

export function offsetToPosition(lineStarts: number[], offset: number): { line: number; character: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo, character: offset - lineStarts[lo] };
}

export function findDocComment(parsed: ParsedFile, tokenIndex: number): string | undefined {
  return docBefore(parsed.tokens, parsed.comments, tokenIndex);
}

function docBefore(tokens: Token[], comments: Comment[], idx: number): string | undefined {
  const tok = tokens[idx];
  if (!tok || comments.length === 0) return undefined;
  const prevEnd = idx > 0 ? tokens[idx - 1].end : 0;
  // last comment ending before the token
  let lo = 0;
  let hi = comments.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (comments[mid].end <= tok.start) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return undefined;
  const c = comments[ans];
  if (!c.block || c.start < prevEnd || !c.text.startsWith('/**') || c.text === '/**/') return undefined;
  return cleanDoc(c.text);
}

function cleanDoc(raw: string): string {
  let s = raw.slice(3);
  if (s.endsWith('*/')) s = s.slice(0, -2);
  const lines = s.split(/\r?\n/).map(l => l.replace(/^\s*\*? ?/, '').replace(/\s+$/, ''));
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function isKw(t: Token | undefined, text: string): boolean {
  return !!t && t.kind === 'keyword' && t.text === text;
}

/** Groovy-only keywords that are plain identifiers in Java sources. */
const JAVA_NAMES = new Set(['in', 'as', 'def', 'trait']);

function startsUpper(s: string): boolean {
  const c = s.charAt(0);
  return c >= 'A' && c <= 'Z';
}

class Parser {
  private readonly tokens: Token[];
  private readonly comments: Comment[];
  private readonly n: number;
  private readonly closeOf: Int32Array;
  private readonly closedOk: Uint8Array;
  private readonly openOf: Int32Array;
  private readonly parentOf: Int32Array;
  private readonly lineStarts: number[];
  private readonly isJava: boolean;
  private readonly ctx: FileContext;
  private readonly classes: ClassInfo[] = [];
  private readonly scriptMethods: MethodInfo[] = [];
  private readonly locals: LocalVar[] = [];
  private readonly closures: ClosureInfo[] = [];
  private readonly classRanges: ClassRange[] = [];
  private readonly memberRanges: MemberRange[] = [];
  private anonCounter = 0;

  constructor(private readonly text: string, private readonly uri: string) {
    const { tokens, comments } = tokenize(text);
    this.tokens = tokens;
    this.comments = comments;
    this.n = tokens.length;
    this.lineStarts = computeLineStarts(text);
    this.isJava = /\.java$/i.test(uri);
    this.ctx = { uri, packageName: '', imports: [], declaredClasses: new Map() };
    this.closeOf = new Int32Array(this.n).fill(-1);
    this.closedOk = new Uint8Array(this.n);
    this.openOf = new Int32Array(this.n).fill(-1);
    this.parentOf = new Int32Array(this.n).fill(-1);
    this.matchBrackets();
  }

  run(): ParsedFile {
    this.parseCode(0, this.n, this.text.length, 'script', undefined);
    this.closures.sort((a, b) => a.openIndex - b.openIndex);
    this.locals.sort((a, b) => a.declOffset - b.declOffset);
    return {
      text: this.text, uri: this.uri, tokens: this.tokens, comments: this.comments, lineStarts: this.lineStarts,
      ctx: this.ctx, classes: this.classes, scriptMethods: this.scriptMethods, locals: this.locals,
      closures: this.closures, classRanges: this.classRanges, memberRanges: this.memberRanges,
    };
  }

  // ---------------------------------------------------------------- brackets

  /** Tolerant bracket matching: a closer pops unclosed inner openers (force-closed at that closer). */
  private matchBrackets(): void {
    const stack: number[] = [];
    const toks = this.tokens;
    for (let i = 0; i < this.n; i++) {
      const t = toks[i];
      if (t.kind !== 'op') continue;
      if (OPENERS.has(t.text)) {
        this.parentOf[i] = stack.length ? stack[stack.length - 1] : -1;
        stack.push(i);
        continue;
      }
      const want = CLOSER_TO_OPENER[t.text];
      if (!want) continue;
      let m = stack.length - 1;
      while (m >= 0) {
        const o = toks[stack[m]].text;
        if (o === want || (want === '[' && o === '?[')) break;
        m--;
      }
      if (m < 0) continue; // stray closer
      while (stack.length - 1 > m) this.closeOf[stack.pop()!] = i;
      const o = stack.pop()!;
      this.closeOf[o] = i;
      this.closedOk[o] = 1;
      this.openOf[i] = o;
    }
    for (const o of stack) this.closeOf[o] = this.n;
  }

  /** Index right after the group opened at `i`. */
  private after(i: number): number {
    return this.closedOk[i] ? this.closeOf[i] + 1 : this.closeOf[i];
  }

  /** End offset of the group opened at `i` (after the closer, or start of the boundary token / text end). */
  private endOffset(i: number): number {
    const c = this.closeOf[i];
    if (this.closedOk[i]) return this.tokens[c].end;
    return c < this.n ? this.tokens[c].start : this.text.length;
  }

  private isOpener(t: Token | undefined): boolean {
    return !!t && t.kind === 'op' && OPENERS.has(t.text);
  }

  // ---------------------------------------------------------------- helpers

  private isName(t: Token | undefined): boolean {
    if (!t) return false;
    if (t.kind === 'ident') return true;
    return t.kind === 'keyword' && (SOFT_KEYWORDS.has(t.text) || (this.isJava && JAVA_NAMES.has(t.text)));
  }

  /** Type and declared name must be on the same line in Groovy. */
  private nameAfterType(ty: TypeAt, to: number): boolean {
    const t = this.tokens[ty.end];
    return ty.end < to && this.isName(t) && (this.isJava || !t.nl);
  }

  private loc(idx: number): SourceLocation {
    const p = offsetToPosition(this.lineStarts, this.tokens[idx].start);
    return { uri: this.uri, line: p.line, character: p.character };
  }

  private doc(idx: number): string | undefined {
    return docBefore(this.tokens, this.comments, idx);
  }

  private addLocal(
    nameIdx: number, kind: LocalVar['kind'], type: TypeRef | undefined, scopeEnd: number,
    init?: [number, number], iterSource?: [number, number],
  ): void {
    const t = this.tokens[nameIdx];
    const p = offsetToPosition(this.lineStarts, t.start);
    const v: LocalVar = {
      name: t.text, kind, declOffset: t.start, scopeStart: t.start, scopeEnd, line: p.line, character: p.character,
    };
    if (type) v.type = type;
    if (init) v.init = init;
    if (iterSource) v.iterSource = iterSource;
    this.locals.push(v);
  }

  /** Skips annotations and modifiers starting at k; collects modifier keywords. */
  private skipMods(k: number, to: number, mods: Set<string>, classBody: boolean): number {
    const toks = this.tokens;
    while (k < to) {
      const t = toks[k];
      if (isOp(t, '@')) {
        if (isKw(toks[k + 1], 'interface')) break;
        k = this.skipAnnotation(k, to);
        continue;
      }
      if (t.kind === 'keyword' && MODIFIERS.has(t.text)) {
        const nx = toks[k + 1];
        if (t.text === 'default' && (!classBody || isOp(nx, ':') || isOp(nx, '->'))) break;
        if (t.text === 'synchronized' && isOp(nx, '(')) break;
        mods.add(t.text);
        k++;
        continue;
      }
      if (t.kind === 'ident' && t.text === 'non' && isOp(toks[k + 1], '-') && isKw(toks[k + 2], 'sealed')) {
        k += 3;
        continue;
      }
      break;
    }
    return k;
  }

  private skipAnnotation(k: number, to: number): number {
    const toks = this.tokens;
    k++;
    if (k < to && this.isName(toks[k])) {
      k++;
      while (k + 1 < to && isOp(toks[k], '.') && this.isName(toks[k + 1])) k += 2;
    }
    if (k < to && isOp(toks[k], '(')) k = this.after(k);
    return k;
  }

  /** Parses a type reference at k: `a.b.C<X, ? extends Y>[]...`. */
  private parseTypeAt(k: number, to: number): TypeAt | undefined {
    const toks = this.tokens;
    const start = k;
    const t = toks[k];
    if (!t || k >= to) return undefined;
    let primitive = false;
    let last = t.text;
    if (t.kind === 'keyword' && PRIMITIVES.has(t.text)) {
      primitive = true;
      k++;
    } else if (this.isName(t)) {
      k++;
      while (k + 1 < to && isOp(toks[k], '.') && !toks[k].nl && this.isName(toks[k + 1]) && !toks[k + 1].nl) {
        last = toks[k + 1].text;
        k += 2;
      }
    } else return undefined;
    let suffix = false;
    if (k < to && isOp(toks[k], '<') && !toks[k].nl && !primitive) {
      const e = this.scanAngles(k, to);
      if (e > 0) { k = e; suffix = true; }
    }
    while (k + 1 < to && isOp(toks[k], '[') && isOp(toks[k + 1], ']')) { k += 2; suffix = true; }
    let varargs = false;
    if (k + 1 < to && isOp(toks[k], '..') && isOp(toks[k + 1], '.') && toks[k].end === toks[k + 1].start) {
      k += 2;
      varargs = true;
      suffix = true;
    }
    return { ref: parseType(this.typeText(start, k)), end: k, varargs, suffix, upper: startsUpper(last), primitive };
  }

  /** Scans a generic argument list starting at `<`; returns the index after the matching `>` or -1. */
  private scanAngles(k: number, to: number): number {
    const toks = this.tokens;
    let depth = 0;
    const limit = Math.min(to, k + 200);
    for (let m = k; m < limit; m++) {
      const t = toks[m];
      if (t.kind === 'op') {
        if (t.text === '<') depth++;
        else if (t.text === '>') { depth--; if (depth === 0) return m + 1; }
        else if (!(t.text === ',' || t.text === '.' || t.text === '?' || t.text === '[' || t.text === ']' ||
          t.text === '&' || t.text === '@')) return -1;
      } else if (t.kind === 'keyword') {
        if (!(t.text === 'extends' || t.text === 'super' || PRIMITIVES.has(t.text) || SOFT_KEYWORDS.has(t.text))) return -1;
      } else if (t.kind !== 'ident') return -1;
    }
    return -1;
  }

  private typeText(from: number, to: number): string {
    let s = '';
    for (let k = from; k < to; k++) {
      const x = this.tokens[k].text;
      if (x === 'extends' || x === 'super' || x === '&') s += ' ' + x + ' ';
      else s += x;
    }
    return s;
  }

  /** Parses `<T extends X, U>`; returns names and index after `>`. */
  private parseTypeParams(k: number, to: number): { names: string[]; end: number } {
    const toks = this.tokens;
    const names: string[] = [];
    let depth = 0;
    let m = k;
    for (; m < to; m++) {
      const t = toks[m];
      if (isOp(t, '<')) {
        depth++;
        if (depth === 1 && this.isName(toks[m + 1])) names.push(toks[m + 1].text);
      } else if (isOp(t, '>')) {
        depth--;
        if (depth === 0) return { names, end: m + 1 };
      } else if (isOp(t, ',') && depth === 1) {
        let q = m + 1;
        while (isOp(toks[q], '@')) q = this.skipAnnotation(q, to);
        if (this.isName(toks[q])) names.push(toks[q].text);
      } else if (isOp(t, '{') || isOp(t, ';') || isOp(t, '(')) break;
    }
    return { names, end: m };
  }

  private parseTypeList(k: number, to: number): { types: TypeRef[]; end: number } {
    const types: TypeRef[] = [];
    for (;;) {
      while (isOp(this.tokens[k], '@')) k = this.skipAnnotation(k, to);
      const ty = this.parseTypeAt(k, to);
      if (!ty) break;
      types.push(ty.ref);
      k = ty.end;
      if (k < to && isOp(this.tokens[k], ',')) { k++; continue; }
      break;
    }
    return { types, end: k };
  }

  private typeLike(ty: TypeAt): boolean {
    return ty.primitive || ty.upper || ty.suffix;
  }

  /** Token after a declared name: `=`, `;`, `,`, `)`, `:`, `in`, `}`, newline or end. */
  private declFollower(j: number, to: number): boolean {
    if (j >= to) return true;
    const t = this.tokens[j];
    if (t.nl) return true;
    if (t.kind === 'op') return t.text === '=' || t.text === ';' || t.text === ',' || t.text === ')' || t.text === ':' || t.text === '}';
    return !this.isJava && isKw(t, 'in');
  }

  /** End (exclusive token index) of an initializer expression starting at `from`. */
  private initEnd(from: number, to: number): number {
    const toks = this.tokens;
    let j = from;
    while (j < to) {
      const t = toks[j];
      if (j > from && t.nl && !this.continues(j)) break;
      if (t.kind === 'op') {
        if (t.text === ';' || t.text === ',') break;
        if (CLOSER_TO_OPENER[t.text]) break;
        if (OPENERS.has(t.text)) { j = this.after(j); continue; }
      }
      j++;
    }
    return Math.min(j, to);
  }

  /** True when the expression continues on the line of token j. */
  private continues(j: number): boolean {
    const t = this.tokens[j];
    if (t.kind === 'op' && (DOT_OPERATORS.has(t.text) || t.text === '?:')) return true;
    const p = this.tokens[j - 1];
    if (!p) return false;
    if (p.kind === 'op') return !NON_BINARY_OPS.has(p.text) && !OPENERS.has(p.text) && p.text !== ',';
    return p.kind === 'keyword' && BINARY_KEYWORDS.has(p.text);
  }

  /** Splits a parameter list (tokens [from, to)) into declarations. */
  private parseParams(from: number, to: number): ParamDecl[] {
    const toks = this.tokens;
    const parts: [number, number][] = [];
    let s = from;
    let angle = 0;
    let inDefault = false;
    for (let k = from; k < to;) {
      const t = toks[k];
      if (this.isOpener(t)) { k = this.after(k); continue; }
      if (t.kind === 'op') {
        if (!inDefault && t.text === '<') angle++;
        else if (!inDefault && t.text === '>') angle = Math.max(0, angle - 1);
        else if (t.text === '=' && angle === 0) inDefault = true;
        else if (t.text === ',' && (angle === 0 || inDefault)) {
          parts.push([s, k]);
          s = k + 1;
          inDefault = false;
          angle = 0;
        }
      }
      k++;
    }
    if (s < to) parts.push([s, to]);
    const out: ParamDecl[] = [];
    for (const [ps, pe] of parts) {
      let declEnd = pe;
      for (let k = ps; k < pe;) {
        if (this.isOpener(toks[k])) { k = this.after(k); continue; }
        if (isOp(toks[k], '=')) { declEnd = k; break; }
        k++;
      }
      let k = ps;
      const mods = new Set<string>();
      k = this.skipMods(k, declEnd, mods, false);
      const nameIdx = declEnd - 1;
      if (nameIdx < k || !this.isName(toks[nameIdx])) continue;
      const p: ParamDecl = { name: toks[nameIdx].text, nameIdx, hasDefault: declEnd < pe, varargs: false };
      if (k < nameIdx) {
        const ty = this.parseTypeAt(k, nameIdx);
        if (ty) {
          p.type = ty.ref;
          p.varargs = ty.varargs;
        }
      }
      out.push(p);
    }
    return out;
  }

  // ---------------------------------------------------------------- code blocks

  private isStmtStart(i: number, from: number): boolean {
    if (i === from) return true;
    const t = this.tokens[i];
    if (t.nl) return true;
    const p = this.tokens[i - 1];
    if (p.kind === 'op') {
      if (p.text === ';' || p.text === '{' || p.text === '}' || p.text === '->') return true;
      if (p.text === ')') {
        const o = this.openOf[i - 1];
        const b = o > 0 ? this.tokens[o - 1] : undefined;
        return !!b && b.kind === 'keyword' && (b.text === 'if' || b.text === 'while' || b.text === 'for');
      }
      return false;
    }
    return isKw(p, 'else');
  }

  /** Parses statements in [from, to). */
  private parseCode(from: number, to: number, scopeEnd: number, mode: 'script' | 'body', owner: ClassInfo | undefined): void {
    const toks = this.tokens;
    let i = from;
    while (i < to) {
      if (this.isStmtStart(i, from)) {
        const r = this.parseStatement(i, to, scopeEnd, mode, owner);
        if (r > i) { i = r; continue; }
      }
      const t = toks[i];
      if (t.kind === 'keyword' && isOp(toks[i + 1], '(')) {
        if (t.text === 'for') { i = this.parseFor(i, to, scopeEnd, owner); continue; }
        if (t.text === 'catch') { i = this.parseCatch(i, to, scopeEnd, owner); continue; }
        if (t.text === 'try') {
          const p = i + 1;
          this.parseCode(p + 1, this.closeOf[p], this.followingBlockEnd(p, scopeEnd), 'body', owner);
          i = this.after(p);
          continue;
        }
      }
      if (t.kind === 'op') {
        if (t.text === '{') { i = this.handleBrace(i, owner); continue; }
        if (OPENERS.has(t.text)) {
          this.scanExpr(i + 1, this.closeOf[i], owner);
          i = this.after(i);
          continue;
        }
      }
      i++;
    }
  }

  /** Walks an expression range only looking for closures / blocks. */
  private scanExpr(from: number, to: number, owner: ClassInfo | undefined): void {
    let i = from;
    while (i < to) {
      if (isOp(this.tokens[i], '{')) i = this.handleBrace(i, owner);
      else i++;
    }
  }

  /** End offset of the block following the group opened at p (`for (...) {`), or the fallback. */
  private followingBlockEnd(p: number, fallback: number): number {
    const b = this.after(p);
    return b < this.n && isOp(this.tokens[b], '{') && this.closedOk[p] ? this.endOffset(b) : fallback;
  }

  private parseStatement(i: number, to: number, scopeEnd: number, mode: 'script' | 'body', owner: ClassInfo | undefined): number {
    const toks = this.tokens;
    const t0 = toks[i];
    if (mode === 'script') {
      if (isKw(t0, 'package')) {
        const r = this.parseQualified(i + 1, to);
        this.ctx.packageName = r.name;
        return r.end < to && isOp(toks[r.end], ';') ? r.end + 1 : Math.max(r.end, i + 1);
      }
      if (isKw(t0, 'import')) return this.parseImport(i, to);
    }
    const mods = new Set<string>();
    let k = this.skipMods(i, to, mods, false);
    if (k >= to) return k;
    const t = toks[k];
    if (this.isClassStart(k, to)) return this.parseClassDecl(k, i, owner, mods, to);

    const untyped = mods.size > 0;
    // def (a, b) = ...
    if (untyped && isOp(t, '(')) {
      for (const p of this.parseParams(k + 1, this.closeOf[k])) this.addLocal(p.nameIdx, 'local', p.type, scopeEnd);
      return this.after(k);
    }

    // script methods
    if (mode === 'script' && !this.isJava) {
      let tp: string[] | undefined;
      let m = k;
      if (untyped && isOp(toks[m], '<')) {
        const r = this.parseTypeParams(m, to);
        tp = r.names;
        m = r.end;
      }
      let nameIdx = -1;
      let ret: TypeRef | undefined;
      if ((untyped || tp) && this.isName(toks[m]) && isOp(toks[m + 1], '(')) {
        nameIdx = m;
        ret = ref(OBJECT);
      } else {
        const ty = this.parseTypeAt(m, to);
        if (ty && this.nameAfterType(ty, to) && isOp(toks[ty.end + 1], '(') && (untyped || this.typeLike(ty))) {
          nameIdx = ty.end;
          ret = ty.ref;
        }
      }
      if (nameIdx >= 0 && ret && this.hasBodyAfter(nameIdx + 1, to)) {
        return this.parseMethod(i, nameIdx, ret, tp, mods, undefined, false, true, to);
      }
    }

    // local declarations
    const ty = this.parseTypeAt(k, to);
    if (ty && this.nameAfterType(ty, to) && (untyped || this.typeLike(ty)) && this.declFollower(ty.end + 1, to)) {
      return this.parseDeclarators(ty.end, ty.ref, scopeEnd, to);
    }
    if (untyped && this.isName(t) && this.declFollower(k + 1, to)) return this.parseDeclarators(k, undefined, scopeEnd, to);

    // assignment
    if (k === i && this.isName(t) && k + 1 < to && isOp(toks[k + 1], '=')) {
      const e = this.initEnd(k + 2, to);
      this.addLocal(k, 'assign', undefined, scopeEnd, [k + 2, e]);
      return k + 2;
    }
    return k;
  }

  private parseDeclarators(nameIdx: number, type: TypeRef | undefined, scopeEnd: number, to: number): number {
    const toks = this.tokens;
    let j = nameIdx;
    for (;;) {
      let k = j + 1;
      let t = type;
      while (k + 1 < to && isOp(toks[k], '[') && isOp(toks[k + 1], ']')) {
        if (t) t = { ...t, dims: t.dims + 1 };
        k += 2;
      }
      let init: [number, number] | undefined;
      if (k < to && isOp(toks[k], '=')) {
        const e = this.initEnd(k + 1, to);
        init = [k + 1, e];
        k = e;
      }
      this.addLocal(j, 'local', t, scopeEnd, init);
      if (k < to && isOp(toks[k], ',') && this.isName(toks[k + 1]) && this.declFollower(k + 2, to)) {
        j = k + 1;
        continue;
      }
      break;
    }
    // continue walking right after the first name so initializers get scanned for closures
    return nameIdx + 1;
  }

  private parseQualified(k: number, to: number): { name: string; end: number } {
    const toks = this.tokens;
    const parts: string[] = [];
    while (k < to) {
      const t = toks[k];
      if (t.nl && parts.length > 0) break;
      if (!(t.kind === 'ident' || t.kind === 'keyword')) break;
      parts.push(t.text);
      k++;
      if (k < to && isOp(toks[k], '.') && !toks[k].nl && k + 1 < to && !toks[k + 1].nl &&
        (toks[k + 1].kind === 'ident' || toks[k + 1].kind === 'keyword')) {
        k++;
        continue;
      }
      break;
    }
    return { name: parts.join('.'), end: k };
  }

  private parseImport(i: number, to: number): number {
    const toks = this.tokens;
    let k = i + 1;
    let isStatic = false;
    if (k < to && isKw(toks[k], 'static') && !toks[k].nl) { isStatic = true; k++; }
    const parts: string[] = [];
    let isStar = false;
    while (k < to) {
      const t = toks[k];
      if (t.nl || !(t.kind === 'ident' || t.kind === 'keyword')) break;
      parts.push(t.text);
      k++;
      if (k < to && isOp(toks[k], '.') && !toks[k].nl) {
        k++;
        if (k < to && isOp(toks[k], '*') && !toks[k].nl) { isStar = true; k++; break; }
        continue;
      }
      break;
    }
    let alias: string | undefined;
    if (k + 1 < to && isKw(toks[k], 'as') && !toks[k].nl && this.isName(toks[k + 1])) {
      alias = toks[k + 1].text;
      k += 2;
    }
    if (k < to && isOp(toks[k], ';')) k++;
    k = Math.max(k, i + 1);
    const imp: ImportInfo = { name: parts.join('.'), isStatic, isStar, start: toks[i].start, end: toks[k - 1].end };
    if (alias) imp.alias = alias;
    this.ctx.imports.push(imp);
    return k;
  }

  private hasBodyAfter(p: number, to: number): boolean {
    let k = this.after(p);
    if (isKw(this.tokens[k], 'throws')) k = this.parseTypeList(k + 1, to).end;
    return k < to && isOp(this.tokens[k], '{');
  }

  // ---------------------------------------------------------------- for / catch / braces

  private parseFor(i: number, to: number, scopeEnd: number, owner: ClassInfo | undefined): number {
    const toks = this.tokens;
    const p = i + 1;
    const close = this.closeOf[p];
    const loopEnd = this.followingBlockEnd(p, scopeEnd);
    // find top-level `;` or `in` / `:`
    let semi = -1;
    let sep = -1;
    for (let k = p + 1; k < close;) {
      const t = toks[k];
      if (this.isOpener(t)) { k = this.after(k); continue; }
      if (isOp(t, ';')) { semi = k; break; }
      if (sep < 0 && ((!this.isJava && isKw(t, 'in')) || isOp(t, ':'))) sep = k;
      k++;
    }
    if (semi >= 0 || sep < 0) {
      this.parseCode(p + 1, close, loopEnd, 'body', owner);
    } else {
      const nameIdx = sep - 1;
      if (nameIdx > p && this.isName(toks[nameIdx])) {
        const mods = new Set<string>();
        const k = this.skipMods(p + 1, nameIdx, mods, false);
        const ty = k < nameIdx ? this.parseTypeAt(k, nameIdx) : undefined;
        this.addLocal(nameIdx, 'forVar', ty?.ref, loopEnd, undefined, [sep + 1, Math.min(close, this.n)]);
      }
      this.scanExpr(sep + 1, close, owner);
    }
    return this.after(p);
  }

  private parseCatch(i: number, to: number, scopeEnd: number, owner: ClassInfo | undefined): number {
    const toks = this.tokens;
    const p = i + 1;
    const close = this.closeOf[p];
    const nameIdx = close - 1;
    if (nameIdx > p && this.isName(toks[nameIdx])) {
      const mods = new Set<string>();
      const k = this.skipMods(p + 1, nameIdx, mods, false);
      const ty = k < nameIdx ? this.parseTypeAt(k, nameIdx) : undefined;
      this.addLocal(nameIdx, 'catch', ty ? ty.ref : ref('java.lang.Exception'), this.followingBlockEnd(p, scopeEnd));
    }
    this.scanExpr(p + 1, close, owner);
    return this.after(p);
  }

  private classifyBrace(i: number): 'closure' | 'block' | 'anon' {
    const toks = this.tokens;
    const p = toks[i - 1];
    if (!p) return this.isJava ? 'block' : 'closure';
    if (p.kind === 'keyword') {
      if (BLOCK_KEYWORDS.has(p.text)) return 'block';
      if (p.text === 'synchronized') return 'block';
      return 'closure';
    }
    if (p.kind === 'op') {
      if (p.text === '->') return 'block';
      if (p.text === ')') {
        const o = this.openOf[i - 1];
        const b = o > 0 ? toks[o - 1] : undefined;
        if (b && b.kind === 'keyword' && CONTROL_KEYWORDS.has(b.text)) return 'block';
        if (o > 0 && this.precededByNew(o - 1)) return 'anon';
        return 'closure';
      }
      if (this.isJava && (p.text === ';' || p.text === '{' || p.text === '}')) return 'block';
    }
    return 'closure';
  }

  /** True when the type ending at index k (inclusive) is preceded by `new`. */
  private precededByNew(k: number): boolean {
    const toks = this.tokens;
    let depth = 0;
    for (let m = k, steps = 0; m >= 0 && steps < 40; m--, steps++) {
      const t = toks[m];
      if (isKw(t, 'new')) return depth === 0;
      if (t.kind === 'ident') continue;
      if (t.kind === 'op') {
        if (t.text === '>') { depth++; continue; }
        if (t.text === '<') { depth--; continue; }
        if (t.text === '.' || t.text === ',' || t.text === '?') continue;
      }
      if (t.kind === 'keyword' && (t.text === 'extends' || t.text === 'super')) continue;
      return false;
    }
    return false;
  }

  private handleBrace(i: number, owner: ClassInfo | undefined): number {
    const kind = this.classifyBrace(i);
    const close = this.closeOf[i];
    const endOff = this.endOffset(i);
    if (kind === 'block') {
      this.parseCode(i + 1, close, endOff, 'body', owner);
      return this.after(i);
    }
    if (kind === 'anon') {
      const anon = this.makeAnon(owner);
      this.parseClassBody(i + 1, close, anon, false);
      return this.after(i);
    }
    const toks = this.tokens;
    const arrow = this.findArrow(i, close);
    const info: ClosureInfo = {
      openIndex: i, closeIndex: close, start: toks[i].start, end: endOff, params: [], explicitParams: arrow >= 0,
      bodyStartIndex: arrow >= 0 ? arrow + 1 : i + 1,
    };
    // call target
    const p = toks[i - 1];
    if (p && p.kind === 'ident') {
      info.callNameIndex = i - 1;
      info.argIndex = 0;
    } else if (isOp(p, ')')) {
      const o = this.openOf[i - 1];
      if (o > 0 && toks[o - 1].kind === 'ident') {
        info.callNameIndex = o - 1;
        info.argIndex = this.countArgs(o + 1, i - 1, true);
      }
    } else {
      const par = this.parentOf[i];
      if (par > 0 && isOp(toks[par], '(') && toks[par - 1].kind === 'ident') {
        info.callNameIndex = par - 1;
        info.argIndex = this.countArgs(par + 1, i, false);
      }
    }
    if (arrow >= 0) {
      for (const pd of this.parseParams(i + 1, arrow)) {
        const cp: { name: string; type?: TypeRef } = { name: pd.name };
        if (pd.type) cp.type = pd.type;
        info.params.push(cp);
        this.addLocal(pd.nameIdx, 'closureParam', pd.type, endOff);
      }
    }
    this.closures.push(info);
    this.parseCode(info.bodyStartIndex, close, endOff, 'body', owner);
    return this.after(i);
  }

  /** Counts top-level commas in [from, to); `total` returns the number of arguments instead. */
  private countArgs(from: number, to: number, total: boolean): number {
    let commas = 0;
    for (let k = from; k < to;) {
      const t = this.tokens[k];
      if (this.isOpener(t)) { k = this.after(k); continue; }
      if (isOp(t, ',')) commas++;
      k++;
    }
    if (!total) return commas;
    return from < to ? commas + 1 : 0;
  }

  /** Finds the `->` of explicit closure params, or -1. */
  private findArrow(open: number, close: number): number {
    const toks = this.tokens;
    const limit = Math.min(close, open + 300);
    for (let k = open + 1; k < limit;) {
      const t = toks[k];
      if (k > open + 1 && t.nl && !isOp(toks[k - 1], ',')) return -1;
      if (t.kind === 'op') {
        if (t.text === '->') return k;
        if (t.text === '=') {
          // default value: skip to `,` or `->`
          k++;
          while (k < limit) {
            const d = toks[k];
            if (d.nl) return -1;
            if (isOp(d, ',') || isOp(d, '->')) break;
            if (this.isOpener(d)) { k = this.after(k); continue; }
            if (isOp(d, ';') || isOp(d, '}')) return -1;
            k++;
          }
          continue;
        }
        if (t.text === '@') { k = this.skipAnnotation(k, limit); continue; }
        if (t.text === ',' || t.text === '.' || t.text === '<' || t.text === '>' || t.text === '[' || t.text === ']' ||
          t.text === '?' || t.text === '&' || t.text === '..') { k++; continue; }
        return -1;
      }
      if (t.kind === 'ident' || (t.kind === 'keyword' && (PRIMITIVES.has(t.text) || t.text === 'def' ||
        t.text === 'final' || t.text === 'var' || t.text === 'extends' || t.text === 'super' || SOFT_KEYWORDS.has(t.text)))) {
        k++;
        continue;
      }
      return -1;
    }
    return -1;
  }

  private makeAnon(owner: ClassInfo | undefined): ClassInfo {
    const base = owner ? owner.qualifiedName : (this.ctx.packageName ? this.ctx.packageName + '.' : '') + 'script';
    const name = String(++this.anonCounter);
    return {
      qualifiedName: base + '$' + name, simpleName: name, packageName: this.ctx.packageName, kind: 'class',
      typeParams: [], interfaces: [], methods: [], fields: [], constructors: [], origin: 'workspace', ctx: this.ctx,
      outer: owner?.qualifiedName,
    };
  }

  // ---------------------------------------------------------------- classes

  private isClassStart(k: number, to: number): boolean {
    const toks = this.tokens;
    const t = toks[k];
    if (!t || k >= to) return false;
    if (isOp(t, '@')) return isKw(toks[k + 1], 'interface') && this.isName(toks[k + 2]);
    if (t.kind !== 'keyword' || !CLASS_KEYWORDS[t.text]) return false;
    if (!this.isName(toks[k + 1])) return false;
    if (t.text === 'record') return isOp(toks[k + 2], '(') || isOp(toks[k + 2], '<');
    return true;
  }

  private parseClassDecl(kw: number, declStart: number, outer: ClassInfo | undefined, mods: Set<string>, to: number): number {
    const toks = this.tokens;
    let k = kw;
    let kind: ClassKind;
    if (isOp(toks[k], '@')) { kind = 'annotation'; k += 2; } else { kind = CLASS_KEYWORDS[toks[k].text]; k++; }
    const nameIdx = k;
    const simple = toks[nameIdx].text;
    k++;
    const pkg = this.ctx.packageName;
    const qname = outer ? outer.qualifiedName + '$' + simple : (pkg ? pkg + '.' : '') + simple;
    const cls: ClassInfo = {
      qualifiedName: qname, simpleName: simple, packageName: pkg, kind, typeParams: [], interfaces: [], methods: [],
      fields: [], constructors: [], origin: 'workspace', location: this.loc(nameIdx), ctx: this.ctx,
    };
    if (outer) cls.outer = outer.qualifiedName;
    if (mods.has('abstract') || kind === 'interface' || kind === 'annotation') cls.isAbstract = true;
    const doc = this.doc(declStart);
    if (doc) cls.doc = doc;
    this.registerClassName(cls, outer);
    this.classes.push(cls);

    if (k < to && isOp(toks[k], '<')) {
      const r = this.parseTypeParams(k, to);
      cls.typeParams = r.names;
      k = r.end;
    }
    let components: ParamDecl[] = [];
    if (kind === 'record' && k < to && isOp(toks[k], '(')) {
      components = this.parseParams(k + 1, this.closeOf[k]);
      k = this.after(k);
    }
    while (k < to) {
      const t = toks[k];
      if (isKw(t, 'extends')) {
        const r = this.parseTypeList(k + 1, to);
        if (kind === 'interface' || kind === 'annotation') cls.interfaces.push(...r.types);
        else if (r.types.length) cls.superClass = r.types[0];
        k = Math.max(r.end, k + 1);
      } else if (isKw(t, 'implements')) {
        const r = this.parseTypeList(k + 1, to);
        cls.interfaces.push(...r.types);
        k = Math.max(r.end, k + 1);
      } else if (isKw(t, 'permits')) {
        k = Math.max(this.parseTypeList(k + 1, to).end, k + 1);
      } else break;
    }

    for (const c of components) {
      const type = c.type ?? ref(OBJECT);
      const location = this.loc(c.nameIdx);
      cls.fields.push({
        name: c.name, type, isStatic: false, isFinal: true, declaringType: qname, origin: 'workspace', location,
        visibility: 'private',
      });
      cls.methods.push({
        name: c.name, params: [], returnType: type, isStatic: false, declaringType: qname, origin: 'workspace', location,
        visibility: 'public',
      });
    }
    if (components.length) {
      cls.constructors.push({
        name: simple, params: components.map(c => ({ name: c.name, type: c.type ?? ref(OBJECT) })), returnType: ref(qname),
        isStatic: false, isConstructor: true, declaringType: qname, origin: 'workspace', location: cls.location,
        visibility: 'public',
      });
    }

    const range: ClassRange = { cls, start: toks[declStart].start, bodyStart: toks[k - 1].end, end: toks[k - 1].end };
    this.classRanges.push(range);
    if (k < to && isOp(toks[k], '{')) {
      range.bodyStart = toks[k].start;
      range.end = this.endOffset(k);
      this.parseClassBody(k + 1, this.closeOf[k], cls, true);
      return this.after(k);
    }
    return k;
  }

  private registerClassName(cls: ClassInfo, outer: ClassInfo | undefined): void {
    const map = this.ctx.declaredClasses;
    if (!outer) {
      map.set(cls.simpleName, cls.qualifiedName);
      return;
    }
    // dotted path from the outermost class
    const pkgPrefix = cls.packageName ? cls.packageName.length + 1 : 0;
    const dotted = cls.qualifiedName.slice(pkgPrefix).replace(/\$/g, '.');
    map.set(dotted, cls.qualifiedName);
    if (!map.has(cls.simpleName)) map.set(cls.simpleName, cls.qualifiedName);
  }

  private parseClassBody(from: number, to: number, cls: ClassInfo, register: boolean): void {
    const toks = this.tokens;
    let j = from;
    if (cls.kind === 'enum') j = this.parseEnumConstants(from, to, cls);
    while (j < to) {
      const start = j;
      const t0 = toks[j];
      if (isOp(t0, ';') || isOp(t0, ',')) { j++; continue; }
      const mods = new Set<string>();
      let k = this.skipMods(j, to, mods, true);
      if (k >= to) break;
      const t = toks[k];
      if (this.isClassStart(k, to)) { j = this.parseClassDecl(k, start, cls, mods, to); continue; }
      if (isOp(t, '{')) {
        // initializer block
        this.parseCode(k + 1, this.closeOf[k], this.endOffset(k), 'body', cls);
        j = this.after(k);
        continue;
      }
      let tp: string[] | undefined;
      if (isOp(t, '<')) {
        const r = this.parseTypeParams(k, to);
        tp = r.names;
        k = r.end;
      }
      const tk = toks[k];
      if (this.isName(tk) && isOp(toks[k + 1], '(')) {
        const ctor = tk.text === cls.simpleName;
        j = this.parseMethod(start, k, ctor ? ref(cls.qualifiedName) : ref(OBJECT), tp, mods, cls, ctor, register, to);
        continue;
      }
      const ty = this.parseTypeAt(k, to);
      if (ty && this.nameAfterType(ty, to)) {
        if (isOp(toks[ty.end + 1], '(')) {
          j = this.parseMethod(start, ty.end, ty.ref, tp, mods, cls, false, register, to);
        } else {
          j = this.parseFields(start, ty.end, ty.ref, mods, cls, to);
        }
        continue;
      }
      if (mods.size > 0 && this.isName(tk)) {
        j = this.parseFields(start, k, ref(OBJECT), mods, cls, to);
        continue;
      }
      // unparseable: skip a token (whole group for brackets)
      j = k > start ? k : this.isOpener(t) ? this.after(k) : k + 1;
    }
  }

  private visibility(mods: Set<string>, cls: ClassInfo | undefined): MethodInfo['visibility'] {
    if (mods.has('public')) return 'public';
    if (mods.has('private')) return 'private';
    if (mods.has('protected')) return 'protected';
    if (cls && (cls.kind === 'interface' || cls.kind === 'annotation')) return 'public';
    return this.isJava ? 'package' : 'public';
  }

  private parseEnumConstants(from: number, to: number, cls: ClassInfo): number {
    const toks = this.tokens;
    let j = from;
    while (j < to) {
      const start = j;
      while (j < to && isOp(toks[j], '@')) j = this.skipAnnotation(j, to);
      if (j >= to) return j;
      const t = toks[j];
      if (isOp(t, ';')) return j + 1;
      if (t.kind !== 'ident') return j;
      const nx = toks[j + 1];
      if (!(j + 1 >= to || nx.nl || isOp(nx, ',') || isOp(nx, ';') || isOp(nx, '(') || isOp(nx, '{'))) return start;
      const f: FieldInfo = {
        name: t.text, type: ref(cls.qualifiedName), isStatic: true, isFinal: true, isEnumConstant: true,
        declaringType: cls.qualifiedName, origin: 'workspace', location: this.loc(j), visibility: 'public',
      };
      const doc = this.doc(start);
      if (doc) f.doc = doc;
      cls.fields.push(f);
      let k = j + 1;
      if (k < to && isOp(toks[k], '(')) {
        this.scanExpr(k + 1, this.closeOf[k], cls);
        k = this.after(k);
      }
      if (k < to && isOp(toks[k], '{')) {
        this.parseClassBody(k + 1, this.closeOf[k], this.makeAnon(cls), false);
        k = this.after(k);
      }
      if (k < to && isOp(toks[k], ',')) { j = k + 1; continue; }
      if (k < to && isOp(toks[k], ';')) return k + 1;
      return k;
    }
    return j;
  }

  private parseFields(start: number, nameIdx: number, type: TypeRef, mods: Set<string>, cls: ClassInfo, to: number): number {
    const toks = this.tokens;
    const iface = cls.kind === 'interface' || cls.kind === 'annotation';
    const hasVis = mods.has('public') || mods.has('private') || mods.has('protected');
    const doc = this.doc(start);
    let j = nameIdx;
    for (;;) {
      let k = j + 1;
      let t = type;
      while (k + 1 < to && isOp(toks[k], '[') && isOp(toks[k + 1], ']')) { t = { ...t, dims: t.dims + 1 }; k += 2; }
      const f: FieldInfo = {
        name: toks[j].text, type: t, isStatic: mods.has('static') || iface, declaringType: cls.qualifiedName,
        origin: 'workspace', location: this.loc(j), visibility: this.visibility(mods, cls),
      };
      if (mods.has('final') || iface) f.isFinal = true;
      if (!this.isJava && !hasVis && !iface) f.isProperty = true;
      if (doc) f.doc = doc;
      cls.fields.push(f);
      if (k < to && isOp(toks[k], '=')) {
        const e = this.initEnd(k + 1, to);
        this.scanExpr(k + 1, e, cls);
        k = e;
      }
      if (k < to && isOp(toks[k], ',') && this.isName(toks[k + 1])) { j = k + 1; continue; }
      if (k < to && isOp(toks[k], ';')) k++;
      return Math.max(k, nameIdx + 1);
    }
  }

  private parseMethod(
    start: number, nameIdx: number, ret: TypeRef, tp: string[] | undefined, mods: Set<string>, cls: ClassInfo | undefined,
    ctor: boolean, register: boolean, to: number,
  ): number {
    const toks = this.tokens;
    const p = nameIdx + 1;
    const params = this.parseParams(p + 1, this.closeOf[p]);
    let k = this.after(p);
    while (k + 1 < to && isOp(toks[k], '[') && isOp(toks[k + 1], ']')) { ret = { ...ret, dims: ret.dims + 1 }; k += 2; }
    if (k < to && isKw(toks[k], 'throws')) k = Math.max(this.parseTypeList(k + 1, to).end, k + 1);
    if (k < to && isKw(toks[k], 'default') && (cls?.kind === 'annotation' || !toks[k].nl)) k = this.initEnd(k + 1, to);
    const hasBody = k < to && isOp(toks[k], '{');
    const iface = !!cls && (cls.kind === 'interface' || cls.kind === 'annotation');
    const m: MethodInfo = {
      name: toks[nameIdx].text,
      params: params.map(pd => {
        const pi: ParamInfo = { name: pd.name, type: pd.type ?? ref(OBJECT) };
        if (pd.hasDefault) pi.hasDefault = true;
        return pi;
      }),
      returnType: ret, isStatic: mods.has('static'), origin: 'workspace', location: this.loc(nameIdx),
      visibility: this.visibility(mods, cls),
    };
    if (ctor) m.isConstructor = true;
    if (mods.has('abstract') || (iface && !hasBody && !mods.has('static') && !mods.has('default') && !mods.has('private'))) {
      m.isAbstract = true;
    }
    if (tp && tp.length) m.typeParams = tp;
    if (params.length && params[params.length - 1].varargs) m.varargs = true;
    const doc = this.doc(start);
    if (doc) m.doc = doc;
    if (cls) {
      m.declaringType = cls.qualifiedName;
      (ctor ? cls.constructors : cls.methods).push(m);
    } else this.scriptMethods.push(m);

    let end: number;
    let bodyStart: number;
    let next: number;
    if (hasBody) {
      bodyStart = toks[k].start;
      end = this.endOffset(k);
      for (const pd of params) this.addLocal(pd.nameIdx, 'param', pd.type, end);
      this.parseCode(k + 1, this.closeOf[k], end, 'body', cls);
      next = this.after(k);
    } else {
      if (k < to && isOp(toks[k], ';')) k++;
      next = Math.max(k, nameIdx + 2);
      end = toks[Math.min(next, this.n) - 1].end;
      bodyStart = end;
      for (const pd of params) this.addLocal(pd.nameIdx, 'param', pd.type, end);
    }
    if (register) {
      const mr: MemberRange = { method: m, start: toks[start].start, end, bodyStart };
      if (cls) mr.owner = cls.qualifiedName;
      this.memberRanges.push(mr);
    }
    return next;
  }
}
