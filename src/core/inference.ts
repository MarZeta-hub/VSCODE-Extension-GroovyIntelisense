// Expression type inference over the token stream of a parsed file.
import { ClassRange, ClosureInfo, LocalVar, MemberRange } from './model';
import { ParsedFile } from './sourceParser';
import { Token, DOT_OPERATORS, isIdentLike, isOp, matchBackward, matchForward } from './tokenizer';
import {
  TypeRef, ref, objectRef, boxed, parseType, substitute, unwildcard, OBJECT, PRIMITIVES, isPrimitive,
} from './typeRef';
import { MemberSet, ResolvedField, ResolvedMethod, TypeSystem } from './typeSystem';

export interface Inferred {
  type: TypeRef;
  /** True when the expression denotes a class (static access: `Math.`, `TimeUnit.`). */
  isStatic?: boolean;
}

const STRING = 'java.lang.String';
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'synchronized', 'return', 'throw', 'assert', 'in', 'case', 'else', 'do', 'try', 'finally']);
const BOOLEAN_OPS = new Set(['==', '!=', '<', '>', '<=', '>=', '===', '!==', '&&', '||', 'instanceof', 'in', '==~']);
const ARITH_OPS = new Set(['+', '-', '*', '/', '%', '**', '<<', '&', '|', '^']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '&=', '|=', '^=']);
/** Binary operators after which an expression continues on the next line. */
const CONTINUATION_OPS = new Set([...BOOLEAN_OPS, ...ARITH_OPS, ...ASSIGN_OPS, '?', ':', '?:', ',', '.', '?.', '*.', '->', '=~', '..', '..<', '<=>']);

export class Inferencer {
  readonly tokens: Token[];
  private chainCache = new Map<string, Promise<Inferred | undefined>>();
  private closureParamCache = new Map<number, Promise<TypeRef[]>>();
  private closureByOpen = new Map<number, ClosureInfo>();
  private visitingLocals = new Set<LocalVar>();
  private depth = 0;

  constructor(readonly ts: TypeSystem, readonly parsed: ParsedFile) {
    this.tokens = parsed.tokens;
    for (const c of parsed.closures) this.closureByOpen.set(c.openIndex, c);
  }

  // ---------------------------------------------------------------- scopes

  enclosingClass(offset: number): ClassRange | undefined {
    let best: ClassRange | undefined;
    for (const r of this.parsed.classRanges) {
      if (r.bodyStart < offset && offset <= r.end && (!best || r.bodyStart > best.bodyStart)) best = r;
    }
    return best;
  }

  enclosingMember(offset: number): MemberRange | undefined {
    let best: MemberRange | undefined;
    for (const r of this.parsed.memberRanges) {
      if (r.bodyStart < offset && offset <= r.end && (!best || r.bodyStart > best.bodyStart)) best = r;
    }
    return best;
  }

  /** Closures containing the offset, innermost first. */
  enclosingClosures(offset: number): ClosureInfo[] {
    return this.parsed.closures.filter(c => c.start < offset && offset < c.end).sort((a, b) => b.start - a.start);
  }

  typeVarsAt(offset: number): string[] {
    const out: string[] = [];
    const cr = this.enclosingClass(offset);
    if (cr) out.push(...cr.cls.typeParams);
    const mr = this.enclosingMember(offset);
    if (mr?.method.typeParams) out.push(...mr.method.typeParams);
    return out;
  }

  /** Resolves a source-level type written at `offset`. */
  resolveSourceType(t: TypeRef, offset: number): Promise<TypeRef> {
    const cr = this.enclosingClass(offset);
    return this.ts.resolveRef(t, this.parsed.ctx, this.typeVarsAt(offset), cr?.cls.qualifiedName);
  }

  /** Type of `this` at offset: enclosing class, or groovy.lang.Script in scripts. */
  thisType(offset: number): TypeRef {
    const cr = this.enclosingClass(offset);
    if (cr) return ref(cr.cls.qualifiedName, cr.cls.typeParams.map(tp => ref(tp)));
    return ref('groovy.lang.Script');
  }

  /** Locals visible at offset, nearest declaration first, one per name. */
  visibleLocals(offset: number): LocalVar[] {
    const seen = new Set<string>();
    const out: LocalVar[] = [];
    const list = this.parsed.locals
      .filter(l => l.declOffset < offset && l.scopeStart <= offset && offset <= l.scopeEnd && l.kind !== 'closureParam')
      .sort((a, b) => b.declOffset - a.declOffset);
    for (const l of list) {
      if (seen.has(l.name)) continue;
      seen.add(l.name);
      out.push(l);
    }
    return out;
  }

  // ---------------------------------------------------------------- variables

  /** Type of a simple name used at `offset`: closure params / it, locals, fields of enclosing classes. */
  async lookupVariable(name: string, offset: number): Promise<Inferred | undefined> {
    for (const c of this.enclosingClosures(offset)) {
      if (offset < this.tokens[c.bodyStartIndex]?.start && c.explicitParams) continue; // inside the param list
      if (c.explicitParams) {
        const idx = c.params.findIndex(p => p.name === name);
        if (idx >= 0) {
          const p = c.params[idx];
          if (p.type) return { type: await this.resolveSourceType(p.type, offset) };
          const types = await this.closureParamTypes(c);
          return { type: types[idx] ?? objectRef() };
        }
      } else if (name === 'it') {
        const types = await this.closureParamTypes(c);
        return { type: types[0] ?? objectRef() };
      }
    }

    const candidates = this.parsed.locals
      .filter(l => l.name === name && l.kind !== 'closureParam' && l.declOffset < offset && l.scopeStart <= offset && offset <= l.scopeEnd)
      .sort((a, b) => b.declOffset - a.declOffset);
    for (const l of candidates) {
      if (l.type) return { type: await this.resolveSourceType(l.type, l.declOffset) };
      if (this.visitingLocals.has(l)) continue;
      this.visitingLocals.add(l);
      try {
        if (l.init) {
          const r = await this.inferRange(l.init[0], l.init[1]);
          if (r) return { type: r.isStatic ? ref('java.lang.Class', [r.type]) : r.type };
        }
        if (l.iterSource) {
          const r = await this.inferRange(l.iterSource[0], l.iterSource[1]);
          if (r) {
            const el = await this.ts.elementType(r.type);
            if (el) return { type: el };
          }
        }
      } finally {
        this.visitingLocals.delete(l);
      }
      if (l.kind !== 'assign') return { type: objectRef() };
    }

    // Fields / properties of the enclosing classes (inner to outer).
    let cr = this.enclosingClass(offset);
    while (cr) {
      const ms = await this.ts.members(this.thisType(cr.bodyStart + 1));
      const f = this.findField(ms, name, false) ?? this.findPropertyGetter(ms, name);
      if (f) return { type: f };
      const outer = cr.cls.outer;
      cr = outer ? this.parsed.classRanges.find(r => r.cls.qualifiedName === outer) : undefined;
    }
    // Static imports of fields: import static java.lang.Math.PI
    for (const imp of this.parsed.ctx.imports) {
      if (!imp.isStatic) continue;
      const dot = imp.name.lastIndexOf('.');
      const member = imp.name.slice(dot + 1);
      if (!imp.isStar && member !== name && imp.alias !== name) continue;
      const q = await this.ts.resolveName(imp.isStar ? imp.name : imp.name.slice(0, dot));
      if (!q) continue;
      const f = this.findField(await this.ts.members(ref(q)), imp.isStar ? name : member, true);
      if (f) return { type: f };
    }
    return undefined;
  }

  private findField(ms: MemberSet, name: string, staticOnly: boolean): TypeRef | undefined {
    const f = ms.fields.find(x => x.field.name === name && (!staticOnly || x.field.isStatic));
    if (!f) return undefined;
    return f.field.isEnumConstant ? ref(f.owner) : f.type;
  }

  private findPropertyGetter(ms: MemberSet, name: string, staticOnly = false): TypeRef | undefined {
    if (!name) return undefined;
    const cap = name[0].toUpperCase() + name.slice(1);
    const g = ms.methods.find(m => (m.method.name === 'get' + cap || m.method.name === 'is' + cap) && m.params.length === 0 && (!staticOnly || m.method.isStatic) && m.method.origin !== 'gdk');
    return g?.returnType;
  }

  // ---------------------------------------------------------------- closures

  private closureFor(openIndex: number): ClosureInfo | undefined {
    return this.closureByOpen.get(openIndex);
  }

  /** Types of the parameters of a closure, derived from the method it is passed to. */
  closureParamTypes(c: ClosureInfo): Promise<TypeRef[]> {
    let p = this.closureParamCache.get(c.openIndex);
    if (!p) {
      p = this.computeClosureParamTypes(c).catch(() => []);
      this.closureParamCache.set(c.openIndex, p);
    }
    return p;
  }

  private async computeClosureParamTypes(c: ClosureInfo): Promise<TypeRef[]> {
    const nameIdx = c.callNameIndex;
    if (nameIdx === undefined) return [];
    const call = await this.resolveCallAt(nameIdx);
    if (!call) return [];
    const { methods, argCount } = call;
    const declared = c.explicitParams ? c.params.length : 0;
    const argIndex = c.argIndex ?? 0;
    const chosen = this.chooseOverload(methods, argCount, argIndex);
    if (!chosen) return [];
    if (chosen.closureParams) {
      return (chosen.closureParams[declared] ?? chosen.closureParams[0] ?? chosen.closureParams[1] ?? []).map(t => boxed(unwildcard(t)));
    }
    const pt = chosen.params[Math.min(argIndex, chosen.params.length - 1)];
    if (!pt) return [];
    const sam = await this.samOf(pt);
    return sam ? sam.params.map(t => boxed(unwildcard(t))) : [];
  }

  /** Single abstract method of a functional interface type, with the interface type arguments substituted. */
  async samOf(t: TypeRef): Promise<{ params: TypeRef[]; returnType: TypeRef } | undefined> {
    const iface = unwildcard(t);
    if (iface.dims > 0 || PRIMITIVES.has(iface.name) || iface.name === 'groovy.lang.Closure') return undefined;
    const cls = await this.ts.getClass(iface.name);
    if (!cls || cls.kind !== 'interface') return undefined;
    const ms = await this.ts.members(iface);
    const abstract = ms.methods.filter(m => m.method.isAbstract && m.owner !== OBJECT && !['equals', 'hashCode', 'toString'].includes(m.method.name));
    if (abstract.length !== 1) return undefined;
    return { params: abstract[0].params, returnType: abstract[0].returnType };
  }

  /** Type of the last expression of the closure body. */
  async closureResultType(c: ClosureInfo): Promise<TypeRef | undefined> {
    const toks = this.tokens;
    const end = Math.min(c.closeIndex, toks.length);
    let start = c.bodyStartIndex;
    let depth = 0;
    let lastStart = start;
    for (let j = start; j < end; j++) {
      const t = toks[j];
      if (t.kind === 'op') {
        if (t.text === '(' || t.text === '[' || t.text === '{' || t.text === '?[') depth++;
        else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
      }
      if (depth !== 0) continue;
      if (isOp(t, ';')) { lastStart = j + 1; continue; }
      if (j > start && t.nl && !(t.kind === 'op' && DOT_OPERATORS.has(t.text)) && !(toks[j - 1].kind === 'op' && CONTINUATION_OPS.has(toks[j - 1].text))) {
        lastStart = j;
      }
    }
    if (lastStart >= end) return undefined;
    if (toks[lastStart].kind === 'keyword' && toks[lastStart].text === 'return') lastStart++;
    if (lastStart >= end) return undefined;
    const r = await this.inferRange(lastStart, end);
    return r ? boxed(r.type) : undefined;
  }

  // ---------------------------------------------------------------- calls

  /**
   * Resolves the candidate methods for the call whose name token is at `nameIdx` (`recv.name(...)`, `name(...)`,
   * `name { }`, `new Name(...)`). Returns the candidates and the number of arguments.
   */
  async resolveCallAt(nameIdx: number): Promise<{ methods: ResolvedMethod[]; argCount: number; receiver?: Inferred; isConstructor?: boolean } | undefined> {
    const toks = this.tokens;
    const nameTok = toks[nameIdx];
    if (!nameTok) return undefined;
    const name = nameTok.text;
    const args = this.callArgs(nameIdx);
    const argCount = args.ranges.length + args.closures.length;
    const prev = toks[nameIdx - 1];

    // Constructor call: new a.b.Name(...)
    let k = nameIdx;
    while (isOp(toks[k - 1], '.') && toks[k - 2]?.kind === 'ident') k -= 2;
    if (toks[k - 1]?.kind === 'keyword' && toks[k - 1].text === 'new') {
      const typeText = toks.slice(k, nameIdx + 1).map(t => t.text).join('');
      const q = await this.ts.resolveName(typeText, this.parsed.ctx, this.enclosingClass(nameTok.start)?.cls.qualifiedName);
      if (!q) return undefined;
      return { methods: await this.ts.constructors(q), argCount, isConstructor: true };
    }

    if (prev && prev.kind === 'op' && DOT_OPERATORS.has(prev.text)) {
      const s = this.chainStart(nameIdx - 1);
      if (s < 0) return undefined;
      let recv = await this.inferChain(s, nameIdx - 1);
      if (!recv) return undefined;
      if (prev.text === '*.') {
        const el = await this.ts.elementType(recv.type);
        recv = { type: el ?? objectRef() };
      }
      const ms = await this.ts.members(recv.type);
      let methods = ms.methods.filter(m => m.method.name === name);
      if (recv.isStatic) {
        const st = methods.filter(m => m.method.isStatic);
        if (st.length) methods = st;
        else methods = (await this.ts.members(ref('java.lang.Class', [recv.type]))).methods.filter(m => m.method.name === name);
      }
      return { methods, argCount, receiver: recv };
    }
    return { methods: await this.implicitMethods(name, nameTok.start), argCount };
  }

  /** Methods callable without receiver at offset: enclosing classes, script methods, static imports, GDK Object. */
  async implicitMethods(name: string | undefined, offset: number): Promise<ResolvedMethod[]> {
    const out: ResolvedMethod[] = [];
    const match = (n: string) => name === undefined || n === name;
    let cr = this.enclosingClass(offset);
    while (cr) {
      const ms = await this.ts.members(this.thisType(cr.bodyStart + 1));
      out.push(...ms.methods.filter(m => match(m.method.name)));
      const outer = cr.cls.outer;
      cr = outer ? this.parsed.classRanges.find(r => r.cls.qualifiedName === outer) : undefined;
    }
    for (const m of this.parsed.scriptMethods) {
      if (!match(m.name)) continue;
      const params = await Promise.all(m.params.map(p => this.resolveSourceType(p.type, offset)));
      const ret = await this.resolveSourceType(m.returnType, offset);
      out.push({ method: m, params, returnType: ret, owner: '', depth: 0 });
    }
    for (const imp of this.parsed.ctx.imports) {
      if (!imp.isStatic) continue;
      const dot = imp.name.lastIndexOf('.');
      const member = imp.name.slice(dot + 1);
      if (!imp.isStar && !match(member) && !(imp.alias && match(imp.alias))) continue;
      const q = await this.ts.resolveName(imp.isStar ? imp.name : imp.name.slice(0, dot));
      if (!q) continue;
      const ms = await this.ts.members(ref(q));
      out.push(...ms.methods.filter(m => m.method.isStatic && (imp.isStar ? match(m.method.name) : m.method.name === member)));
    }
    if (!this.enclosingClass(offset)) {
      const ms = await this.ts.members(ref('groovy.lang.Script'));
      out.push(...ms.methods.filter(m => match(m.method.name)));
    } else {
      const ms = await this.ts.members(objectRef());
      out.push(...ms.methods.filter(m => match(m.method.name) && m.method.origin === 'gdk'));
    }
    return out;
  }

  /** Argument token ranges inside parentheses and trailing closures of the call whose name is at nameIdx. */
  callArgs(nameIdx: number): { ranges: [number, number][]; closures: ClosureInfo[]; end: number } {
    const toks = this.tokens;
    const ranges: [number, number][] = [];
    const closures: ClosureInfo[] = [];
    let j = nameIdx + 1;
    if (isOp(toks[j], '<')) {
      // explicit generic call: Collections.<String>emptyList()
      let d = 0;
      for (; j < toks.length; j++) {
        if (isOp(toks[j], '<')) d++;
        else if (isOp(toks[j], '>')) { d--; if (d === 0) { j++; break; } }
      }
    }
    if (isOp(toks[j], '(')) {
      const close = matchForward(toks, j);
      let s = j + 1;
      let depth = 0;
      for (let q = j + 1; q < close; q++) {
        const t = toks[q];
        if (t.kind === 'op') {
          if (t.text === '(' || t.text === '[' || t.text === '{' || t.text === '?[') depth++;
          else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
          else if (t.text === ',' && depth === 0) { if (q > s) ranges.push([s, q]); s = q + 1; }
        }
      }
      if (close > s) ranges.push([s, close]);
      j = close + 1;
    }
    while (isOp(toks[j], '{')) {
      const c = this.closureFor(j);
      if (!c) break;
      closures.push(c);
      j = c.closeIndex + 1;
    }
    return { ranges, closures, end: j };
  }

  chooseOverload(methods: ResolvedMethod[], argCount: number, closureArgIndex?: number): ResolvedMethod | undefined {
    if (methods.length <= 1) return methods[0];
    const exact = methods.filter(m => m.params.length === argCount);
    const varargs = methods.filter(m => m.method.varargs && argCount >= m.params.length - 1);
    let pool = exact.length ? exact : varargs.length ? varargs : methods;
    if (closureArgIndex !== undefined && pool.length > 1) {
      const withClosure = pool.filter(m => {
        const p = m.params[Math.min(closureArgIndex, m.params.length - 1)];
        return p && (p.name === 'groovy.lang.Closure' || m.closureParams);
      });
      if (withClosure.length) pool = withClosure;
    }
    return pool[0];
  }

  /** Infers the return type of a call, binding method type variables from arguments and closure results. */
  private async callReturnType(rm: ResolvedMethod, nameIdx: number): Promise<TypeRef> {
    const args = this.callArgs(nameIdx);
    const tvars = new Set(rm.method.typeParams ?? []);
    if (rm.method.usesClosureResult) tvars.add('R');
    if (tvars.size === 0) return rm.returnType;
    const binds = new Map<string, TypeRef>();
    const all: ({ range: [number, number] } | { closure: ClosureInfo })[] = [
      ...args.ranges.map(r => ({ range: r })),
      ...args.closures.map(c => ({ closure: c })),
    ];
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      let closure: ClosureInfo | undefined;
      if ('closure' in a) closure = a.closure;
      else if (isOp(this.tokens[a.range[0]], '{') && this.closureFor(a.range[0])?.closeIndex === a.range[1] - 1) closure = this.closureFor(a.range[0]);
      const pt = rm.params[Math.min(i, rm.params.length - 1)];
      if (closure) {
        const res = await this.closureResultType(closure);
        if (!res) continue;
        if (rm.method.usesClosureResult && !binds.has('R')) binds.set('R', res);
        if (pt) {
          const sam = await this.samOf(pt);
          if (sam) this.bindTypeVars(unwildcard(sam.returnType), res, tvars, binds);
        }
      } else if (pt && 'range' in a && this.mentions(pt, tvars)) {
        const r = await this.inferRange(a.range[0], a.range[1]);
        if (r) {
          const pattern = rm.method.varargs && i >= rm.params.length - 1 && pt.dims > 0 && r.type.dims < pt.dims ? { ...pt, dims: pt.dims - 1 } : pt;
          this.bindTypeVars(pattern, boxed(r.type), tvars, binds);
        }
      }
    }
    for (const v of tvars) if (!binds.has(v)) binds.set(v, objectRef());
    return substitute(rm.returnType, binds);
  }

  private mentions(t: TypeRef, tvars: Set<string>): boolean {
    return tvars.has(t.name) || t.args.some(a => this.mentions(a, tvars));
  }

  private bindTypeVars(pattern: TypeRef, actual: TypeRef, tvars: Set<string>, binds: Map<string, TypeRef>): void {
    const p = unwildcard(pattern);
    if (tvars.has(p.name) && p.args.length === 0) {
      if (!binds.has(p.name)) {
        const dims = actual.dims - p.dims;
        if (dims >= 0) binds.set(p.name, boxed({ name: actual.name, args: actual.args, dims }));
      }
      return;
    }
    if (p.name === actual.name && p.args.length === actual.args.length) {
      p.args.forEach((a, i) => this.bindTypeVars(a, unwildcard(actual.args[i]), tvars, binds));
    }
  }

  // ---------------------------------------------------------------- expressions

  /**
   * Start index of the postfix expression (primary + selectors) that ends right before `end` (exclusive), e.g. for
   * `foo(a).bar[0].` with end at the last `.` returns the index of `foo`. -1 if there is no expression.
   */
  chainStart(end: number): number {
    const toks = this.tokens;
    let j = end - 1;
    while (j >= 0) {
      const t = toks[j];
      if (t.kind === 'op' && (t.text === ')' || t.text === ']' || t.text === '}')) {
        const o = matchBackward(toks, j);
        if (o < 0) return -1;
        const p = toks[o - 1];
        if (p && this.canPrecedeGroup(p, toks[o].text)) {
          if (isOp(p, '>')) {
            // new ArrayList<String>()
            let d = 0;
            let q = o - 1;
            for (; q >= 0; q--) {
              if (isOp(toks[q], '>')) d++;
              else if (isOp(toks[q], '<')) { d--; if (d === 0) break; }
            }
            j = q - 1;
            continue;
          }
          j = o - 1;
          continue;
        }
        return o;
      }
      if (isIdentLike(t) || t.kind === 'string' || t.kind === 'gstring' || t.kind === 'number' || t.kind === 'regex' ||
        (t.kind === 'keyword' && (t.text === 'true' || t.text === 'false' || t.text === 'null'))) {
        const p = toks[j - 1];
        if (p && p.kind === 'op' && DOT_OPERATORS.has(p.text)) { j -= 2; continue; }
        if (p && p.kind === 'keyword' && p.text === 'new') return j - 1;
        if (p && isOp(p, '~') && t.kind === 'regex') return j - 1;
        return j;
      }
      return -1;
    }
    return -1;
  }

  private canPrecedeGroup(p: Token, open: string): boolean {
    if (p.kind === 'keyword') return (p.text === 'this' || p.text === 'super') && open !== '{';
    if (p.kind === 'ident' || p.kind === 'string' || p.kind === 'gstring') return true;
    if (p.kind === 'op') return p.text === ')' || p.text === ']' || (p.text === '}' && open !== '{') || (p.text === '>' && open === '(');
    return false;
  }

  /** Infers a postfix chain [s, e). Cached per range. */
  inferChain(s: number, e: number): Promise<Inferred | undefined> {
    const key = s + ':' + e;
    let p = this.chainCache.get(key);
    if (!p) {
      p = this.guard(() => this.evalChain(s, e));
      this.chainCache.set(key, p);
    }
    return p;
  }

  private async guard<T>(f: () => Promise<T | undefined>): Promise<T | undefined> {
    if (this.depth > 40) return undefined;
    this.depth++;
    try {
      return await f();
    } catch {
      return undefined;
    } finally {
      this.depth--;
    }
  }

  /** Infers an arbitrary expression [s, e) with operators. */
  inferRange(s: number, e: number): Promise<Inferred | undefined> {
    return this.guard(() => this.evalRange(s, e));
  }

  private async evalRange(s: number, e: number): Promise<Inferred | undefined> {
    const toks = this.tokens;
    while (s < e && isOp(toks[s], '(') && matchForward(toks, s) === e - 1 && !this.looksLikeCast(s, e)) { s++; e--; }
    if (s >= e) return undefined;

    // Collect top-level operators.
    const ops: number[] = [];
    let depth = 0;
    for (let j = s; j < e; j++) {
      const t = toks[j];
      if (t.kind === 'keyword' && t.text === 'new') {
        // skip generic arguments of the instantiated type
        let q = j + 1;
        while (q < e && (toks[q].kind === 'ident' || isOp(toks[q], '.'))) q++;
        if (isOp(toks[q], '<')) {
          let d = 0;
          for (; q < e; q++) {
            if (isOp(toks[q], '<')) d++;
            else if (isOp(toks[q], '>')) { d--; if (d === 0) break; }
          }
          j = q;
        }
        continue;
      }
      if (t.kind === 'op') {
        if (t.text === '(' || t.text === '[' || t.text === '{' || t.text === '?[') { depth++; continue; }
        if (t.text === ')' || t.text === ']' || t.text === '}') { depth--; continue; }
      }
      if (depth !== 0) continue;
      if ((t.kind === 'op' && !DOT_OPERATORS.has(t.text) && t.text !== '@') || (t.kind === 'keyword' && (t.text === 'as' || t.text === 'instanceof' || t.text === 'in'))) ops.push(j);
    }
    if (ops.length === 0) return this.inferChain(s, e);

    const has = (pred: (t: Token) => boolean) => ops.find(j => pred(toks[j]));
    // assignment: x = expr
    const asg = has(t => t.kind === 'op' && ASSIGN_OPS.has(t.text));
    if (asg !== undefined && asg > s) return this.inferRange(asg + 1, e);
    // ternary / elvis
    const q = has(t => isOp(t, '?'));
    if (q !== undefined) {
      const colon = ops.find(j => j > q && isOp(toks[j], ':'));
      return this.inferRange(q + 1, colon ?? e);
    }
    const elvis = has(t => isOp(t, '?:'));
    if (elvis !== undefined) return (await this.inferRange(s, elvis)) ?? this.inferRange(elvis + 1, e);
    // cast with as
    const asIdx = [...ops].reverse().find(j => toks[j].kind === 'keyword' && toks[j].text === 'as');
    if (asIdx !== undefined) {
      const typeText = toks.slice(asIdx + 1, e).map(t => t.text).join('');
      return { type: await this.resolveSourceType(parseType(typeText), toks[asIdx].start) };
    }
    if (ops.some(j => BOOLEAN_OPS.has(toks[j].text) && toks[j].text !== '<' && toks[j].text !== '>') || has(t => isOp(t, '<') || isOp(t, '>')) !== undefined) {
      return { type: ref('java.lang.Boolean') };
    }
    if (has(t => isOp(t, '<=>')) !== undefined) return { type: ref('java.lang.Integer') };
    if (has(t => isOp(t, '=~')) !== undefined) return { type: ref('java.util.regex.Matcher') };
    const range = has(t => isOp(t, '..') || isOp(t, '..<'));
    if (range !== undefined) {
      const left = await this.inferRange(s, range);
      if (!left || ['java.lang.Integer', 'int'].includes(left.type.name)) return { type: ref('groovy.lang.IntRange') };
      return { type: ref('groovy.lang.Range', [boxed(left.type)]) };
    }
    // prefix operators
    if (ops[0] === s) {
      const t = toks[s];
      if (t.text === '!') return { type: ref('java.lang.Boolean') };
      if (t.text === '~' && toks[s + 1]?.kind !== 'number') return { type: ref('java.util.regex.Pattern') };
      if (t.text === '-' || t.text === '+' || t.text === '++' || t.text === '--' || t.text === '~') {
        const rest = ops.find(j => j > s && ARITH_OPS.has(toks[j].text));
        if (rest === undefined) return this.inferRange(s + 1, e);
      }
    }
    const arith = ops.find(j => j > s && ARITH_OPS.has(toks[j].text));
    if (arith !== undefined) {
      const op = toks[arith].text;
      const left = await this.inferRange(s, arith);
      if (op === '+') {
        if (left?.type.name === STRING) return left;
        const right = await this.inferRange(arith + 1, e);
        if (right?.type.name === STRING) return right;
      }
      if (left && op === '/' && ['java.lang.Integer', 'java.lang.Long', 'int', 'long'].includes(left.type.name)) return { type: ref('java.math.BigDecimal') };
      if (left && op === '**') return { type: ref('java.lang.Number') };
      return left;
    }
    // postfix ++ / --
    const post = ops.find(j => isOp(toks[j], '++') || isOp(toks[j], '--'));
    if (post !== undefined) return this.inferRange(s, post);
    return this.inferChain(s, e);
  }

  private looksLikeCast(s: number, e: number): boolean {
    // `(Type) expr` — a parenthesized type followed by an operand
    const close = matchForward(this.tokens, s);
    return close < e - 1;
  }

  private async evalChain(s: number, e: number): Promise<Inferred | undefined> {
    const prim = await this.primary(s, e);
    if (!prim) return undefined;
    let [cur, i] = prim;
    const toks = this.tokens;
    while (i < e && cur) {
      const t = toks[i];
      if (t.kind === 'op' && DOT_OPERATORS.has(t.text)) {
        const nameTok = toks[i + 1];
        if (!nameTok || i + 1 >= e) return cur;
        const name = nameTok.kind === 'string' || nameTok.kind === 'gstring' ? nameTok.text.replace(/^['"]+|['"]+$/g, '') : nameTok.text;
        const nameIdx = i + 1;
        const op = t.text;
        if (op === '.&' || op === '::') {
          cur = { type: ref('groovy.lang.Closure') };
          i = nameIdx + 1;
          continue;
        }
        let recv = cur;
        if (op === '*.') recv = { type: (await this.ts.elementType(cur.type)) ?? objectRef() };
        let next: Inferred | undefined;
        let j = nameIdx + 1;
        if (j < e && (isOp(toks[j], '(') || isOp(toks[j], '{') || (isOp(toks[j], '<') && nameTok.kind === 'ident' && toks[j].start === nameTok.end))) {
          const call = await this.resolveCallAt(nameIdx);
          const args = this.callArgs(nameIdx);
          j = Math.min(args.end, e);
          const rm = call ? this.chooseOverload(call.methods, args.ranges.length + args.closures.length, args.closures.length ? args.ranges.length : undefined) : undefined;
          if (rm) next = { type: await this.callReturnType(rm, nameIdx) };
          else if (recv.type.name === 'groovy.lang.Closure' && name === 'call') next = { type: recv.type.args[0] ?? objectRef() };
        } else {
          next = await this.propertyType(recv, name, op === '.@');
        }
        if (op === '*.' && next) next = { type: ref('java.util.List', [boxed(next.type)]) };
        cur = next ?? { type: objectRef() };
        if (!next) return undefined;
        i = j;
        continue;
      }
      if (isOp(t, '[') || isOp(t, '?[')) {
        const close = matchForward(toks, i);
        cur = await this.indexType(cur, i + 1, close);
        i = close + 1;
        continue;
      }
      if (isOp(t, '(')) {
        // calling a closure / callable value
        const close = matchForward(toks, i);
        cur = { type: cur.type.name === 'groovy.lang.Closure' ? (cur.type.args[0] ?? objectRef()) : objectRef() };
        i = close + 1;
        continue;
      }
      if (isOp(t, '{')) {
        const c = this.closureFor(i);
        i = c ? c.closeIndex + 1 : e;
        continue;
      }
      break;
    }
    return cur;
  }

  /** Type of `recv.name` property access. */
  async propertyType(recv: Inferred, name: string, fieldOnly = false): Promise<Inferred | undefined> {
    const ms = await this.ts.members(recv.type);
    if (recv.isStatic) {
      const f = ms.fields.find(x => x.field.name === name && x.field.isStatic);
      if (f) return { type: f.field.isEnumConstant ? ref(f.owner) : f.type };
      if (name === 'class') return { type: ref('java.lang.Class', [recv.type]) };
      const nested = recv.type.name + '$' + name;
      if (await this.ts.exists(nested)) return { type: ref(nested), isStatic: true };
      const g = this.findPropertyGetter(ms, name, true);
      if (g) return { type: g };
      const classMs = await this.ts.members(ref('java.lang.Class', [recv.type]));
      const cg = this.findPropertyGetter(classMs, name);
      return cg ? { type: cg } : undefined;
    }
    const f = ms.fields.find(x => x.field.name === name);
    if (f && (fieldOnly || f.field.isProperty || f.field.visibility !== 'private' || f.field.origin === 'workspace')) return { type: f.field.isEnumConstant ? ref(f.owner) : f.type };
    if (name === 'class') return { type: ref('java.lang.Class', [recv.type]) };
    const g = this.findPropertyGetter(ms, name);
    if (g) return { type: g };
    if (ms.supertypes.has('java.util.Map')) {
      const v = ms.supertypes.get('java.util.Map')![1];
      return { type: v ? boxed(unwildcard(v)) : objectRef() };
    }
    // GDK getters (e.g. text -> getText())
    const cap = name[0].toUpperCase() + name.slice(1);
    const gg = ms.methods.find(m => m.method.name === 'get' + cap && m.params.length === 0);
    if (gg) return { type: gg.returnType };
    return undefined;
  }

  private async indexType(cur: Inferred, s: number, e: number): Promise<Inferred> {
    const t = cur.type;
    if (t.dims > 0) return { type: { name: t.name, args: t.args, dims: t.dims - 1 } };
    const ms = await this.ts.members(t);
    const isRange = this.tokens.slice(s, e).some(x => isOp(x, '..') || isOp(x, '..<'));
    if (t.name === STRING) return { type: ref(STRING) };
    if (ms.supertypes.has('java.util.Map')) {
      const v = ms.supertypes.get('java.util.Map')![1];
      return { type: v ? boxed(unwildcard(v)) : objectRef() };
    }
    if (ms.supertypes.has('java.util.List')) {
      const el = (await this.ts.elementType(t)) ?? objectRef();
      return { type: isRange ? ref('java.util.List', [el]) : el };
    }
    const getAt = ms.methods.find(m => m.method.name === 'getAt' && m.params.length === 1);
    return { type: getAt?.returnType ?? objectRef() };
  }

  /** Parses the primary expression at s; returns its type and the index after it. */
  private async primary(s: number, e: number): Promise<[Inferred, number] | undefined> {
    const toks = this.tokens;
    const t = toks[s];
    if (!t) return undefined;
    switch (t.kind) {
      case 'string':
      case 'gstring':
        return [{ type: ref(STRING) }, s + 1];
      case 'regex':
        return [{ type: ref(STRING) }, s + 1];
      case 'number':
        return [{ type: numberType(t.text) }, s + 1];
    }
    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'true':
        case 'false':
          return [{ type: ref('java.lang.Boolean') }, s + 1];
        case 'null':
          return [{ type: objectRef() }, s + 1];
        case 'this':
          return [{ type: this.thisType(t.start) }, s + 1];
        case 'super': {
          const cr = this.enclosingClass(t.start);
          const sup = cr?.cls.superClass ? await this.resolveSourceType(cr.cls.superClass, t.start) : objectRef();
          return [{ type: sup }, s + 1];
        }
        case 'new':
          return this.newExpression(s, e);
      }
      if (PRIMITIVES.has(t.text)) return [{ type: ref(t.text), isStatic: true }, s + 1];
      return undefined;
    }
    if (t.kind === 'op') {
      if (t.text === '[') {
        const close = matchForward(toks, s);
        return [await this.literalType(s + 1, close), close + 1];
      }
      if (t.text === '(') {
        const close = matchForward(toks, s);
        if (close < e - 1 && this.isTypeTokens(s + 1, close) && !(toks[close + 1].kind === 'op' && !['(', '['].includes(toks[close + 1].text))) {
          const typeText = toks.slice(s + 1, close).map(x => x.text).join('');
          return [{ type: await this.resolveSourceType(parseType(typeText), t.start) }, e];
        }
        const inner = await this.inferRange(s + 1, close);
        return inner ? [inner, close + 1] : undefined;
      }
      if (t.text === '{') {
        const c = this.closureFor(s);
        return [{ type: ref('groovy.lang.Closure') }, c ? c.closeIndex + 1 : e];
      }
      if (t.text === '~' && toks[s + 1]?.kind === 'regex') return [{ type: ref('java.util.regex.Pattern') }, s + 2];
      if (t.text === '!') return [{ type: ref('java.lang.Boolean') }, e];
      if (t.text === '-' || t.text === '+') return this.primary(s + 1, e);
      return undefined;
    }
    if (t.kind !== 'ident') return undefined;

    const name = t.text;
    const nxt = toks[s + 1];
    // implicit-receiver method call: foo(...) / foo { }
    if (s + 1 < e && (isOp(nxt, '(') && nxt.start === t.end || (isOp(nxt, '{') && this.closureFor(s + 1)?.callNameIndex === s))) {
      const call = await this.resolveCallAt(s);
      const args = this.callArgs(s);
      const rm = call ? this.chooseOverload(call.methods, args.ranges.length + args.closures.length, args.closures.length ? args.ranges.length : undefined) : undefined;
      const end = Math.min(args.end, e);
      if (!rm) return [{ type: objectRef() }, end];
      return [{ type: await this.callReturnType(rm, s) }, end];
    }
    const v = await this.lookupVariable(name, t.start);
    if (v) return [v, s + 1];

    // Class reference (possibly qualified: java.util.List, Map.Entry)
    const scope = this.enclosingClass(t.start)?.cls.qualifiedName;
    let j = s;
    let path = name;
    let found: [Inferred, number] | undefined;
    for (;;) {
      const q = /^[A-Z]/.test(path.slice(path.lastIndexOf('.') + 1)) || path.includes('.') ? await this.ts.resolveName(path, this.parsed.ctx, scope) : undefined;
      if (q) found = [{ type: ref(q), isStatic: true }, j + 1];
      if (found && !(j + 2 < e && isOp(toks[j + 1], '.') && toks[j + 2]?.kind === 'ident' && /^[A-Z]/.test(toks[j + 2].text))) break;
      if (!(j + 2 < e && isOp(toks[j + 1], '.') && toks[j + 2]?.kind === 'ident' && !isOp(toks[j + 3], '('))) break;
      path += '.' + toks[j + 2].text;
      j += 2;
    }
    if (found) return found;
    return undefined;
  }

  private isTypeTokens(s: number, e: number): boolean {
    if (s >= e) return false;
    const first = this.tokens[s];
    if (!(first.kind === 'ident' || (first.kind === 'keyword' && PRIMITIVES.has(first.text)))) return false;
    if (first.kind === 'ident' && !/^[A-Z]/.test(first.text) && !isOp(this.tokens[s + 1], '.')) return false;
    for (let j = s; j < e; j++) {
      const x = this.tokens[j];
      if (!(x.kind === 'ident' || x.kind === 'keyword' && PRIMITIVES.has(x.text) || (x.kind === 'op' && ['.', '<', '>', ',', '[', ']', '?'].includes(x.text)) || (x.kind === 'keyword' && ['extends', 'super'].includes(x.text)))) return false;
    }
    return true;
  }

  private async newExpression(s: number, e: number): Promise<[Inferred, number] | undefined> {
    const toks = this.tokens;
    let j = s + 1;
    const parts: string[] = [];
    while (j < e && (toks[j].kind === 'ident' || (toks[j].kind === 'keyword' && PRIMITIVES.has(toks[j].text)) || isOp(toks[j], '.'))) parts.push(toks[j++].text);
    if (isOp(toks[j], '<')) {
      let d = 0;
      for (; j < e; j++) {
        parts.push(toks[j].text);
        if (isOp(toks[j], '<')) d++;
        else if (isOp(toks[j], '>')) { d--; if (d === 0) { j++; break; } }
      }
    }
    if (!parts.length) return undefined;
    let type = await this.resolveSourceType(parseType(parts.join('')), toks[s].start);
    if (isOp(toks[j], '[')) {
      let dims = 0;
      while (isOp(toks[j], '[')) { dims++; j = matchForward(toks, j) + 1; }
      if (isOp(toks[j], '{')) j = matchForward(toks, j) + 1;
      return [{ type: { ...type, dims } }, j];
    }
    if (isOp(toks[j], '(')) j = matchForward(toks, j) + 1;
    if (isOp(toks[j], '{')) j = matchForward(toks, j) + 1; // anonymous class body
    // Diamond: new ArrayList<>() keeps raw type
    if (type.args.length === 0) {
      const cls = await this.ts.getClass(type.name);
      if (cls?.typeParams.length) type = { ...type, args: cls.typeParams.map(() => objectRef()) };
    }
    return [{ type }, j];
  }

  /** List or map literal between brackets [s, e). */
  private async literalType(s: number, e: number): Promise<Inferred> {
    const toks = this.tokens;
    if (s >= e) return { type: ref('java.util.ArrayList', [objectRef()]) };
    if (e - s === 1 && isOp(toks[s], ':')) return { type: ref('java.util.LinkedHashMap', [objectRef(), objectRef()]) };
    // first element range
    let depth = 0;
    let colon = -1;
    let comma = e;
    for (let j = s; j < e; j++) {
      const t = toks[j];
      if (t.kind === 'op') {
        if (t.text === '(' || t.text === '[' || t.text === '{' || t.text === '?[') depth++;
        else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
        else if (depth === 0 && t.text === ':' && colon < 0) colon = j;
        else if (depth === 0 && t.text === ',') { comma = j; break; }
      }
    }
    if (colon >= 0) {
      const keyTok = toks[s];
      let key: TypeRef = ref(STRING);
      if (!(colon === s + 1 && (keyTok.kind === 'ident' || keyTok.kind === 'string' || keyTok.kind === 'keyword'))) {
        const k = isOp(keyTok, '(') ? await this.inferRange(s, colon) : await this.inferRange(s, colon);
        key = k ? boxed(k.type) : objectRef();
      }
      const v = await this.inferRange(colon + 1, comma);
      return { type: ref('java.util.LinkedHashMap', [key, v ? boxed(v.type) : objectRef()]) };
    }
    const el = await this.inferRange(s, comma);
    return { type: ref('java.util.ArrayList', [el && !isPrimitive(el.type) ? boxed(el.type) : el ? boxed(el.type) : objectRef()]) };
  }

  // ---------------------------------------------------------------- helpers for providers

  /** Resolved field matching `name` on recv (non-static unless static access). */
  async findMember(recv: Inferred, name: string): Promise<{ field?: ResolvedField; methods: ResolvedMethod[] }> {
    const ms = await this.ts.members(recv.type);
    const field = ms.fields.find(f => f.field.name === name && (!recv.isStatic || f.field.isStatic));
    let methods = ms.methods.filter(m => m.method.name === name && (!recv.isStatic || m.method.isStatic));
    if (!field && !methods.length && name) {
      const cap = name[0].toUpperCase() + name.slice(1);
      methods = ms.methods.filter(m => (m.method.name === 'get' + cap || m.method.name === 'is' + cap) && m.params.length === 0);
    }
    return { field, methods };
  }
}

export function numberType(text: string): TypeRef {
  const t = text.toLowerCase();
  const last = t[t.length - 1];
  const isHex = t.startsWith('0x');
  if (last === 'g') return ref(t.includes('.') ? 'java.math.BigDecimal' : 'java.math.BigInteger');
  if (last === 'l') return ref('java.lang.Long');
  if (last === 'i') return ref('java.lang.Integer');
  if (!isHex && last === 'd') return ref('java.lang.Double');
  if (!isHex && last === 'f') return ref('java.lang.Float');
  if (!isHex && (t.includes('.') || t.includes('e'))) return ref('java.math.BigDecimal');
  return ref('java.lang.Integer');
}

export { CONTROL_KEYWORDS };
