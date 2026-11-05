// GroovyServices: the vscode-independent language engine (workspace index + type system + providers' logic).
import { CompletionResult, HoverResult, LanguageEngine, SignatureInfo, SignatureResult } from './api';
import { SourceLocation } from './model';
import { ParsedFile, parseSource, offsetToPosition } from './sourceParser';
import { DOT_OPERATORS, isOp, tokenIndexBefore } from './tokenizer';
import { formatType, simpleName } from './typeRef';
import { ResolvedMethod, TypeSystem, WorkspaceIndex } from './typeSystem';
import { JavaClassProvider } from './javaClassProvider';
import { CompletionEngine } from './completion';
import { Inferencer, Inferred } from './inference';

export interface ServicesOptions {
  javaHome?: string;
  classpath: string[];
  cacheDir?: string;
  log: (msg: string) => void;
}

const WARM_CLASSES = [
  'java.lang.Object', 'java.lang.String', 'java.lang.CharSequence', 'java.lang.Comparable', 'java.lang.Integer',
  'java.lang.Number', 'java.lang.Iterable', 'java.util.Collection', 'java.util.List', 'java.util.ArrayList',
  'java.util.AbstractList', 'java.util.AbstractCollection', 'java.util.SequencedCollection', 'java.util.Map',
  'java.util.HashMap', 'java.util.LinkedHashMap', 'java.util.AbstractMap', 'java.util.SequencedMap', 'java.util.Set',
  'java.util.Map$Entry', 'java.lang.Boolean', 'java.lang.Long', 'java.math.BigDecimal', 'java.lang.Class',
  'java.util.stream.Stream', 'java.util.stream.BaseStream', 'java.util.function.Function', 'java.util.function.Predicate',
  'java.util.function.Consumer', 'java.io.File', 'java.lang.Enum', 'java.util.Optional', 'java.lang.Character',
];

export class GroovyServices implements LanguageEngine {
  readonly ws = new WorkspaceIndex();
  readonly java: JavaClassProvider;
  readonly ts: TypeSystem;
  private readonly completion: CompletionEngine;
  /** Last parse per open document. */
  private parsedCache = new Map<string, ParsedFile>();
  /** Shape signature of the classes indexed per uri (to avoid invalidating caches on every keystroke). */
  private shapes = new Map<string, string>();
  private initialized = false;

  constructor(private readonly opts: ServicesOptions) {
    this.java = new JavaClassProvider({ javaHome: opts.javaHome, classpath: opts.classpath, cacheDir: opts.cacheDir, log: opts.log });
    this.ts = new TypeSystem(this.ws, this.java);
    this.completion = new CompletionEngine(this.ts);
  }

  async init(): Promise<void> {
    try {
      await this.java.init();
      if (this.java.available) {
        this.opts.log(`JDK: ${this.java.javaHome} (${this.java.javaVersion ?? '?'})`);
        this.java.prefetch(WARM_CLASSES);
        void this.ts.classSet().then(s => this.opts.log(`Clases JDK/classpath conocidas: ${s.size}`));
      } else {
        this.opts.log('No se encontró javap: solo estarán disponibles las clases del workspace y los métodos GDK. Configure groovyIntellisense.javaHome.');
      }
    } catch (e) {
      this.opts.log(`Error inicializando: ${e}`);
    }
    this.initialized = true;
  }

  dispose(): void {
    try {
      this.java.dispose();
    } catch {
      // ignore
    }
  }

  status(): string {
    const jdk = this.java.available ? `JDK ${this.java.javaVersion ?? ''}`.trim() : this.initialized ? 'sin JDK' : 'iniciando…';
    return `Groovy IntelliSense — ${jdk}, ${this.ws.fileCount()} archivos indexados`;
  }

  clearCaches(): void {
    this.ts.clearAll();
    this.parsedCache.clear();
  }

  updateFile(uri: string, text: string): void {
    this.indexParsed(parseSource(text, uri));
  }

  removeFile(uri: string): void {
    this.ws.remove(uri);
    this.shapes.delete(uri);
    this.parsedCache.delete(uri);
  }

  private indexParsed(p: ParsedFile): void {
    const shape = JSON.stringify(p.classes.map(c => [c.qualifiedName, c.kind, c.typeParams, c.superClass, c.interfaces,
      c.fields.map(f => [f.name, f.type, f.isStatic, f.location?.line]), c.methods.map(m => [m.name, m.params.map(x => x.type), m.returnType, m.isStatic, m.location?.line]),
      c.constructors.map(m => m.params.length)]));
    if (this.shapes.get(p.uri) === shape && this.ws.get(p.classes[0]?.qualifiedName ?? '\0')) return;
    this.shapes.set(p.uri, shape);
    this.ws.update(p.uri, p.classes);
  }

  /** Parses the document (cached by text) and refreshes its classes in the index. */
  private parse(uri: string, text: string): ParsedFile {
    const cached = this.parsedCache.get(uri);
    if (cached && cached.text === text) return cached;
    const p = parseSource(text, uri);
    this.parsedCache.set(uri, p);
    if (this.parsedCache.size > 20) this.parsedCache.delete(this.parsedCache.keys().next().value!);
    this.indexParsed(p);
    return p;
  }

  // ---------------------------------------------------------------- completion

  async complete(uri: string, text: string, offset: number): Promise<CompletionResult> {
    let parsed = this.parse(uri, text);
    const empty: CompletionResult = { items: [], isIncomplete: false, replaceStart: offset, replaceEnd: offset };
    if (parsed.comments.some(c => c.start < offset && (c.block ? offset < c.end : offset <= c.end))) return empty;
    const ti = tokenIndexBefore(parsed.tokens, offset);
    const tok = parsed.tokens[ti];
    if (tok && (tok.kind === 'string' || tok.kind === 'gstring' || tok.kind === 'regex') && (offset < tok.end || !tok.terminated)) {
      const exprStart = tok.kind === 'gstring' ? interpolationStart(text, tok.start, offset) : -1;
      if (exprStart < 0) return empty;
      // Blank out the string except the interpolated code before the cursor, keeping offsets.
      const blank = (s: string) => s.replace(/[^\n]/g, ' ');
      const virtual = text.slice(0, tok.start) + blank(text.slice(tok.start, exprStart)) + text.slice(exprStart, offset) + blank(text.slice(offset, tok.end)) + text.slice(tok.end);
      parsed = parseSource(virtual, uri);
    }
    return this.completion.complete(parsed, offset);
  }

  // ---------------------------------------------------------------- signature help

  async signatureHelp(uri: string, text: string, offset: number): Promise<SignatureResult | undefined> {
    const parsed = this.parse(uri, text);
    const toks = parsed.tokens;
    let j = tokenIndexBefore(toks, offset);
    let depth = 0;
    let commas = 0;
    for (; j >= 0; j--) {
      const t = toks[j];
      if (t.kind !== 'op') continue;
      if (t.text === ')' || t.text === ']' || t.text === '}') depth++;
      else if (t.text === '(' || t.text === '[' || t.text === '{' || t.text === '?[') {
        if (depth === 0) {
          if (t.text === '(') break;
          return undefined;
        }
        depth--;
      } else if (t.text === ',' && depth === 0) commas++;
      else if (t.text === ';' && depth === 0) return undefined;
    }
    if (j < 1 || toks[j - 1].kind !== 'ident') return undefined;
    const inf = new Inferencer(this.ts, parsed);
    const call = await inf.resolveCallAt(j - 1);
    if (!call || !call.methods.length) return undefined;
    const sigs = dedupe(call.methods);
    const signatures: SignatureInfo[] = sigs.map(m => {
      const params = m.params.map((p, i) => `${formatType(p)} ${m.method.params[i]?.name ?? 'arg' + i}`);
      const label = `${m.method.isConstructor ? simpleName(m.returnType.name) : m.method.name}(${params.join(', ')})${m.method.isConstructor ? '' : ': ' + formatType(m.returnType)}`;
      return { label, documentation: m.method.doc, params: params.map(p => ({ label: p, documentation: paramDoc(m.method.doc, p.split(' ').pop()!) })) };
    });
    let active = sigs.findIndex(m => m.params.length > commas || (m.method.varargs && m.params.length > 0));
    if (active < 0) active = 0;
    // Prefer the overload whose arity matches the arguments already typed.
    const exact = sigs.findIndex(m => m.params.length === commas + 1);
    if (exact >= 0 && commas > 0) active = exact;
    const activeParameter = Math.min(commas, Math.max(0, sigs[active].params.length - 1));
    return { signatures, activeSignature: active, activeParameter };
  }

  // ---------------------------------------------------------------- hover & definition

  private async symbolAt(uri: string, text: string, offset: number) {
    const parsed = this.parse(uri, text);
    const toks = parsed.tokens;
    let i = tokenIndexBefore(toks, offset + 1);
    const t = toks[i];
    if (!t || offset < t.start || offset > t.end || !(t.kind === 'ident' || (t.kind === 'keyword' && (t.text === 'this' || t.text === 'super')))) return undefined;
    const inf = new Inferencer(this.ts, parsed);
    const prev = toks[i - 1];
    const next = toks[i + 1];
    const isCall = !!next && (isOp(next, '(') || (isOp(next, '{') && parsed.closures.some(c => c.openIndex === i + 1 && c.callNameIndex === i)));
    return { parsed, inf, i, t, prev, next, isCall };
  }

  async hover(uri: string, text: string, offset: number): Promise<HoverResult | undefined> {
    const sym = await this.symbolAt(uri, text, offset);
    if (!sym) return undefined;
    const { inf, i, t, prev, isCall, parsed } = sym;
    const range = { start: t.start, end: t.end };
    const code = (s: string) => '```groovy\n' + s + '\n```';

    if (prev && prev.kind === 'op' && DOT_OPERATORS.has(prev.text)) {
      if (isCall) {
        const call = await inf.resolveCallAt(i);
        const m = call && inf.chooseOverload(call.methods, inf.callArgs(i).ranges.length + inf.callArgs(i).closures.length);
        if (m) return { ...range, contents: methodHover(m) };
      }
      const s = inf.chainStart(i - 1);
      const recv = s >= 0 ? await inf.inferChain(s, i - 1) : undefined;
      if (!recv) return undefined;
      const { field, methods } = await inf.findMember(recv, t.text);
      if (field) return { ...range, contents: code(`${field.field.isStatic ? 'static ' : ''}${formatType(field.type)} ${field.field.name}`) + `\n\n${simpleName(field.owner)}` + (field.field.doc ? '\n\n' + field.field.doc : '') };
      if (methods.length) return { ...range, contents: methodHover(methods[0]) };
      const p = await inf.propertyType(recv, t.text);
      if (p) return { ...range, contents: code(`${formatType(p.type)} ${t.text}`) };
      return undefined;
    }
    if (isCall) {
      const call = await inf.resolveCallAt(i);
      const m = call && inf.chooseOverload(call.methods, inf.callArgs(i).ranges.length + inf.callArgs(i).closures.length);
      if (m) return { ...range, contents: methodHover(m) };
    }
    const v = await inf.lookupVariable(t.text, t.start + (parsed.locals.some(l => l.declOffset === t.start) ? 1 : 0));
    if (v) {
      const local = parsed.locals.find(l => l.name === t.text && l.declOffset <= t.start && l.scopeStart <= t.start && t.start <= l.scopeEnd);
      const kind = local?.kind === 'param' ? 'parámetro' : local ? 'variable local' : t.text === 'it' ? 'parámetro implícito' : 'campo';
      return { ...range, contents: code(`${formatType(v.type)} ${t.text}`) + `\n\n_${kind}_ — \`${formatType(v.type, true)}\`` };
    }
    const r = await inf.inferChain(i, i + 1);
    if (r?.isStatic) {
      const cls = await this.ts.getClass(r.type.name);
      const kind = cls?.kind ?? 'class';
      const ext = cls?.superClass && cls.superClass.name !== 'java.lang.Object' ? ` extends ${formatType(cls.superClass)}` : '';
      return { ...range, contents: code(`${kind} ${r.type.name.replace(/\$/g, '.')}${cls?.typeParams.length ? '<' + cls.typeParams.join(', ') + '>' : ''}${ext}`) + (cls?.doc ? '\n\n' + cls.doc : '') };
    }
    if (r) return { ...range, contents: code(`${formatType(r.type)} ${t.text}`) };
    return undefined;
  }

  async definition(uri: string, text: string, offset: number): Promise<SourceLocation[]> {
    const sym = await this.symbolAt(uri, text, offset);
    if (!sym) return [];
    const { inf, i, t, prev, isCall, parsed } = sym;
    const toLoc = (l?: SourceLocation) => (l ? [l] : []);

    if (prev && prev.kind === 'op' && DOT_OPERATORS.has(prev.text)) {
      const s = inf.chainStart(i - 1);
      const recv: Inferred | undefined = s >= 0 ? await inf.inferChain(s, i - 1) : undefined;
      if (!recv) return [];
      const { field, methods } = await inf.findMember(recv, t.text);
      if (isCall && methods.length) return methods.flatMap(m => toLoc(m.method.location)).slice(0, 5);
      if (field?.field.location) return [field.field.location];
      if (methods[0]?.method.location) return [methods[0].method.location];
      if (recv.isStatic) {
        const nested = await this.ts.getClass(recv.type.name + '$' + t.text);
        return toLoc(nested?.location);
      }
      return [];
    }
    if (isCall) {
      const call = await inf.resolveCallAt(i);
      if (call?.isConstructor) {
        const locs = call.methods.flatMap(m => toLoc(m.method.location));
        if (locs.length) return locs;
        return toLoc((await this.ts.getClass(call.methods[0]?.returnType.name ?? ''))?.location);
      }
      const locs = (call?.methods ?? []).flatMap(m => toLoc(m.method.location));
      if (locs.length) return locs.slice(0, 5);
    }
    // local variable / parameter
    const local = parsed.locals
      .filter(l => l.name === t.text && l.declOffset <= t.start && l.scopeStart <= t.start && t.start <= l.scopeEnd && l.kind !== 'assign')
      .sort((a, b) => b.declOffset - a.declOffset)[0];
    if (local) {
      return [{ uri, line: local.line, character: local.character }];
    }
    for (const c of inf.enclosingClosures(t.start)) {
      const p = c.params.find(x => x.name === t.text);
      if (p) {
        const tok = parsed.tokens.slice(c.openIndex, c.bodyStartIndex).find(x => x.text === p.name);
        if (tok) return [{ uri, ...offsetToPosition(parsed.lineStarts, tok.start) }];
      }
    }
    const assign = parsed.locals.filter(l => l.name === t.text && l.declOffset <= t.start).sort((a, b) => a.declOffset - b.declOffset)[0];
    if (assign) return [{ uri, line: assign.line, character: assign.character }];
    // field of enclosing class
    const cr = inf.enclosingClass(t.start);
    if (cr) {
      const { field, methods } = await inf.findMember({ type: inf.thisType(t.start) }, t.text);
      if (field?.field.location) return [field.field.location];
      if (methods[0]?.method.location) return [methods[0].method.location];
    }
    // class
    const r = await inf.inferChain(i, i + 1);
    if (r?.isStatic) return toLoc((await this.ts.getClass(r.type.name))?.location);
    return [];
  }
}

function methodHover(m: ResolvedMethod): string {
  const params = m.params.map((p, i) => `${formatType(p)} ${m.method.params[i]?.name ?? 'arg' + i}`).join(', ');
  const head = m.method.isConstructor
    ? `${simpleName(m.returnType.name)}(${params})`
    : `${m.method.isStatic ? 'static ' : ''}${m.method.typeParams?.length ? '<' + m.method.typeParams.join(', ') + '> ' : ''}${formatType(m.returnType)} ${m.method.name}(${params})`;
  const owner = m.owner ? (m.method.origin === 'gdk' ? `GDK · ${simpleName(m.owner === '[]' ? 'array' : m.owner)}` : m.owner.replace(/\$/g, '.')) : 'script';
  return '```groovy\n' + head + '\n```\n\n_' + owner + '_' + (m.method.doc ? '\n\n' + m.method.doc : '');
}

function dedupe(methods: ResolvedMethod[]): ResolvedMethod[] {
  const seen = new Set<string>();
  return methods.filter(m => {
    const k = m.method.name + '(' + m.params.map(p => formatType(p)).join(',') + ')';
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function paramDoc(doc: string | undefined, name: string): string | undefined {
  if (!doc) return undefined;
  const m = new RegExp(`(?:@param|\\*\\*?)\\s*\`?${name.replace(/[$]/g, '\\$')}\`?\\*?\\*?\\s*[:—-]?\\s*([^\\n]+)`).exec(doc);
  return m?.[1]?.trim();
}

/** Start offset of the interpolated expression containing the cursor in a GString, or -1. */
function interpolationStart(text: string, tokStart: number, offset: number): number {
  const s = text.slice(tokStart, offset);
  // ${ ... unclosed
  let depth = 0;
  let start = -1;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === '$' && s[k + 1] === '{' && depth === 0) { start = k + 2; depth = 1; k++; continue; }
    if (depth > 0) {
      if (s[k] === '{') depth++;
      else if (s[k] === '}') { depth--; if (depth === 0) start = -1; }
    }
  }
  if (start >= 0) return tokStart + start;
  const m = /\$([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*\.?[\w]*)$/.exec(s);
  if (m) return offset - m[1].length;
  return -1;
}
