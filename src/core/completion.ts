// Completion engine: decides the completion context at the cursor and produces candidates.
import { CompletionCandidate, CompletionResult, TextEdit } from './api';
import { ClassInfo, LocalVar } from './model';
import { ParsedFile } from './sourceParser';
import { DOT_OPERATORS, Token, isOp, tokenIndexBefore } from './tokenizer';
import { TypeRef, formatType, ref, objectRef, packageOf, simpleName, OBJECT } from './typeRef';
import { MemberSet, ResolvedField, ResolvedMethod, TypeSystem, DEFAULT_PACKAGES } from './typeSystem';
import { Inferencer, Inferred } from './inference';

const MAX_CLASS_ITEMS = 150;

const GROOVY_KEYWORDS = [
  'def', 'var', 'class', 'interface', 'enum', 'trait', 'record', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'default', 'break', 'continue', 'return', 'try', 'catch', 'finally', 'throw', 'throws', 'new', 'this', 'super', 'null',
  'true', 'false', 'in', 'as', 'instanceof', 'import', 'package', 'static', 'final', 'abstract', 'private', 'protected',
  'public', 'synchronized', 'assert', 'void', 'boolean', 'int', 'long', 'double', 'float', 'char', 'byte', 'short',
  'extends', 'implements',
];

interface SnippetDef { label: string; body: string; detail: string }

const SNIPPETS: SnippetDef[] = [
  { label: 'for', body: 'for (${1:item} in ${2:items}) {\n\t$0\n}', detail: 'Bucle for-in' },
  { label: 'fori', body: 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}', detail: 'Bucle for con índice' },
  { label: 'each', body: '${1:items}.each { ${2:item} ->\n\t$0\n}', detail: 'Iterar con each' },
  { label: 'if', body: 'if (${1:condition}) {\n\t$0\n}', detail: 'Sentencia if' },
  { label: 'ife', body: 'if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}', detail: 'if / else' },
  { label: 'while', body: 'while (${1:condition}) {\n\t$0\n}', detail: 'Bucle while' },
  { label: 'try', body: 'try {\n\t$1\n} catch (${2:Exception} ${3:e}) {\n\t$0\n}', detail: 'try / catch' },
  { label: 'switch', body: 'switch (${1:value}) {\n\tcase ${2:x}:\n\t\t$0\n\t\tbreak\n\tdefault:\n\t\tbreak\n}', detail: 'Sentencia switch' },
  { label: 'class', body: 'class ${1:Name} {\n\t$0\n}', detail: 'Declaración de clase' },
  { label: 'interface', body: 'interface ${1:Name} {\n\t$0\n}', detail: 'Declaración de interfaz' },
  { label: 'enum', body: 'enum ${1:Name} {\n\t${2:A, B}\n}', detail: 'Declaración de enum' },
  { label: 'trait', body: 'trait ${1:Name} {\n\t$0\n}', detail: 'Declaración de trait' },
  { label: 'def', body: 'def ${1:name}(${2}) {\n\t$0\n}', detail: 'Declaración de método' },
  { label: 'main', body: 'static void main(String[] args) {\n\t$0\n}', detail: 'Método main' },
  { label: 'sout', body: 'println(${0})', detail: 'println' },
  { label: 'closure', body: '{ ${1:it} -> $0 }', detail: 'Closure' },
];

const COMMON_ANNOTATIONS = [
  'java.lang.Override', 'java.lang.Deprecated', 'java.lang.SuppressWarnings', 'java.lang.FunctionalInterface',
  'groovy.transform.CompileStatic', 'groovy.transform.TypeChecked', 'groovy.transform.CompileDynamic',
  'groovy.transform.ToString', 'groovy.transform.EqualsAndHashCode', 'groovy.transform.Canonical',
  'groovy.transform.Immutable', 'groovy.transform.TupleConstructor', 'groovy.transform.MapConstructor',
  'groovy.transform.Field', 'groovy.transform.Memoized', 'groovy.transform.Sortable', 'groovy.transform.AutoClone',
  'groovy.transform.builder.Builder', 'groovy.lang.Singleton', 'groovy.lang.Delegate', 'groovy.lang.Lazy',
  'groovy.lang.Newify', 'groovy.lang.Grab', 'groovy.util.logging.Slf4j', 'groovy.util.logging.Log',
  'groovy.transform.Synchronized', 'groovy.transform.NamedVariant', 'groovy.transform.NullCheck',
];

export class CompletionEngine {
  constructor(private readonly ts: TypeSystem) {}

  async complete(parsed: ParsedFile, offset: number): Promise<CompletionResult> {
    const text = parsed.text;
    let prefixStart = offset;
    while (prefixStart > 0 && /[\w$À-￿]/.test(text[prefixStart - 1])) prefixStart--;
    const empty: CompletionResult = { items: [], isIncomplete: false, replaceStart: prefixStart, replaceEnd: offset };
    const prefix = text.slice(prefixStart, offset);
    if (/^\d/.test(prefix)) return empty;

    const inf = new Inferencer(this.ts, parsed);
    const toks = parsed.tokens;

    // import / package lines
    const lineStart = text.lastIndexOf('\n', prefixStart - 1) + 1;
    const lineBefore = text.slice(lineStart, prefixStart);
    const im = /^\s*import\s+(static\s+)?([\w$.]*)$/.exec(lineBefore);
    if (im) return { ...empty, items: await this.importItems(im[2], !!im[1]), isIncomplete: false };
    if (/^\s*package\s+[\w.]*$/.test(lineBefore)) return empty;

    const pi = tokenIndexBefore(toks, prefixStart);
    const prev = toks[pi];

    if (prev && prev.kind === 'op' && DOT_OPERATORS.has(prev.text) && prev.end <= prefixStart) {
      const items = await this.memberItems(inf, pi, prev.text, parsed);
      return { ...empty, items };
    }
    if (prev && prev.kind === 'op' && prev.text === '@' && prev.end === prefixStart) {
      return { ...empty, items: await this.classItems(parsed, prefix, 'annotation'), isIncomplete: true };
    }
    if (prev && prev.kind === 'keyword' && prev.text === 'new') {
      return { ...empty, items: await this.classItems(parsed, prefix, 'new'), isIncomplete: true };
    }
    if (prev && prev.kind === 'keyword' && ['extends', 'implements', 'as', 'instanceof', 'throws'].includes(prev.text)) {
      return { ...empty, items: await this.classItems(parsed, prefix, 'type'), isIncomplete: true };
    }
    // Variable name suggestion after a type: `List<String> |`
    const nameItems = this.variableNameItems(toks, pi, prefixStart, text);
    if (nameItems) return { ...empty, items: nameItems };

    const items = await this.generalItems(inf, parsed, offset, prefixStart, prefix);
    return { ...empty, items, isIncomplete: true };
  }

  // ------------------------------------------------------------------ members after a dot

  private async memberItems(inf: Inferencer, dotIdx: number, op: string, parsed: ParsedFile): Promise<CompletionCandidate[]> {
    const s = inf.chainStart(dotIdx);
    let recv: Inferred | undefined = s >= 0 ? await inf.inferChain(s, dotIdx) : undefined;
    if (!recv && s >= 0) {
      // Qualified package path: java.util.
      const path = parsed.tokens.slice(s, dotIdx).map(t => t.text).join('');
      if (/^[\w.]+$/.test(path)) {
        const items = await this.packageChildren(path, false);
        if (items.length) return items;
      }
    }
    if (!recv) recv = { type: objectRef() };
    if (op === '*.') recv = { type: (await this.ts.elementType(recv.type)) ?? objectRef() };
    const ms = await this.ts.members(recv.type);
    const enclosing = inf.enclosingClass(parsed.tokens[dotIdx].start);
    const sameClass = !!enclosing && (await this.ts.isSubtype(recv.type, enclosing.cls.qualifiedName) || enclosing.cls.qualifiedName === recv.type.name);
    const methodRef = op === '.&' || op === '::';
    const items = this.memberCandidates(ms, { isStatic: !!recv.isStatic, allowPrivate: sameClass || parsed.ctx.uri === ms.cls?.location?.uri, methodRef, fieldAccess: op === '.@' });
    if (recv.isStatic) {
      items.push({ label: 'class', kind: 'keyword', description: `Class<${formatType(recv.type)}>`, sortText: '0_class' });
      for (const c of this.ts.ws.all()) {
        if (c.outer === recv.type.name) items.push(this.classCandidate(c.qualifiedName, c, '0_'));
      }
      if (methodRef) items.push({ label: 'new', kind: 'constructor', sortText: '0_new' });
    }
    return items;
  }

  memberCandidates(ms: MemberSet, opts: { isStatic: boolean; allowPrivate: boolean; methodRef?: boolean; fieldAccess?: boolean; implicit?: boolean }): CompletionCandidate[] {
    const items: CompletionCandidate[] = [];
    const seen = new Set<string>();
    const fieldNames = new Set<string>();
    const visible = (vis: string | undefined) => opts.allowPrivate || vis !== 'private';

    if (!opts.methodRef) {
      for (const f of ms.fields) {
        if (opts.isStatic && !f.field.isStatic) continue;
        if (!opts.isStatic && !opts.implicit && f.field.isStatic && !f.field.isEnumConstant && f.field.origin !== 'workspace') continue;
        if (!visible(f.field.visibility)) continue;
        fieldNames.add(f.field.name);
        items.push(this.fieldCandidate(f));
      }
      if (!opts.isStatic && !opts.fieldAccess) {
        // Groovy properties from getters: getName() -> name
        for (const m of ms.methods) {
          const mm = /^(get|is)([A-Z]\w*)$/.exec(m.method.name);
          if (!mm || m.params.length || m.method.isStatic || m.method.origin === 'gdk' || !visible(m.method.visibility)) continue;
          if (mm[1] === 'is' && !['boolean', 'java.lang.Boolean'].includes(m.returnType.name)) continue;
          const prop = mm[2].length > 1 && mm[2][1] === mm[2][1].toUpperCase() && /[A-Z]/.test(mm[2][1]) ? mm[2] : mm[2][0].toLowerCase() + mm[2].slice(1);
          if (fieldNames.has(prop)) continue;
          fieldNames.add(prop);
          items.push({
            label: prop, kind: 'property', description: formatType(m.returnType),
            detail: `${formatType(m.returnType)} ${prop}  (${m.method.name}())`,
            documentation: m.method.doc, sortText: this.sortKey(m.depth, 0, prop, m.owner),
          });
        }
      }
    }
    if (opts.fieldAccess) return items;
    for (const m of ms.methods) {
      if (m.method.isConstructor) continue;
      if (opts.isStatic && !m.method.isStatic) continue;
      if (!opts.isStatic && !opts.implicit && m.method.isStatic && m.method.origin !== 'workspace') continue;
      if (!visible(m.method.visibility)) continue;
      const key = m.method.name + '(' + m.params.map(p => formatType(p)).join(',') + ')';
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(this.methodCandidate(m, opts.methodRef));
    }
    return items;
  }

  private sortKey(depth: number, kindRank: number, name: string, owner: string): string {
    const d = owner === OBJECT ? 95 : Math.min(depth, 99);
    return `${String(d).padStart(2, '0')}${kindRank}_${name}`;
  }

  fieldCandidate(f: ResolvedField): CompletionCandidate {
    const kind = f.field.isEnumConstant ? 'enumMember' : f.field.isProperty ? 'property' : f.field.isStatic && f.field.isFinal ? 'constant' : 'field';
    return {
      label: f.field.name, kind, description: formatType(f.type),
      detail: `${f.field.isStatic ? 'static ' : ''}${formatType(f.type)} ${f.field.name} — ${simpleName(f.owner)}`,
      documentation: f.field.doc, sortText: this.sortKey(f.depth, 0, f.field.name, f.owner),
    };
  }

  methodCandidate(m: ResolvedMethod, methodRef = false): CompletionCandidate {
    const name = m.method.name;
    const params = m.params.map((p, i) => `${formatType(p)}${m.method.varargs && i === m.params.length - 1 ? '' : ''} ${m.method.params[i]?.name ?? 'arg' + i}`);
    const sig = `(${params.join(', ')})`;
    const isGdk = m.method.origin === 'gdk';
    const esc = name.replace(/\$/g, '\\$');
    let insertText = esc;
    let triggerSignatureHelp = false;
    if (!methodRef) {
      const last = m.params[m.params.length - 1];
      const lastIsClosure = !!last && (last.name === 'groovy.lang.Closure' || !!m.closureParams);
      if (m.params.length === 0) insertText = `${esc}()`;
      else if (lastIsClosure && m.params.length === 1) insertText = `${esc} { $0 }`;
      else if (lastIsClosure) { insertText = `${esc}($1) { $0 }`; triggerSignatureHelp = true; }
      else { insertText = `${esc}($0)`; triggerSignatureHelp = true; }
    }
    const docParts: string[] = [];
    if (m.method.doc) docParts.push(m.method.doc);
    if (isGdk) docParts.push('_Método GDK de Groovy_');
    return {
      label: name, kind: 'method', labelDetail: sig, description: formatType(m.returnType),
      detail: `${m.method.isStatic ? 'static ' : ''}${formatType(m.returnType)} ${name}${sig} — ${m.owner ? simpleName(m.owner === '[]' ? 'array' : m.owner) : 'script'}`,
      documentation: docParts.join('\n\n') || undefined,
      insertText, isSnippet: !methodRef, triggerSignatureHelp,
      sortText: this.sortKey(m.depth, 1, name, m.owner), filterText: name,
    };
  }

  // ------------------------------------------------------------------ general (identifier) completion

  private async generalItems(inf: Inferencer, parsed: ParsedFile, offset: number, prefixStart: number, prefix: string): Promise<CompletionCandidate[]> {
    const items: CompletionCandidate[] = [];
    const names = new Set<string>();
    const push = (c: CompletionCandidate) => {
      const k = c.kind + ':' + c.label + (c.labelDetail ?? '');
      if (names.has(k)) return;
      names.add(k);
      items.push(c);
    };

    // Named arguments: new Person(name: ..., |
    for (const c of await this.namedArgItems(inf, parsed, prefixStart)) push(c);

    // Closure params / it
    for (const c of inf.enclosingClosures(offset)) {
      if (c.explicitParams) {
        if (offset < (parsed.tokens[c.bodyStartIndex]?.start ?? 0)) continue;
        const types = await inf.closureParamTypes(c);
        c.params.forEach((p, i) => push({ label: p.name, kind: 'variable', description: formatType(types[i] ?? objectRef()), detail: 'Parámetro de closure', sortText: '00_' + p.name }));
      } else {
        const types = await inf.closureParamTypes(c);
        push({ label: 'it', kind: 'variable', description: formatType(types[0] ?? objectRef()), detail: 'Parámetro implícito de la closure', sortText: '00_it' });
        break;
      }
    }

    // Locals
    const locals = inf.visibleLocals(prefixStart).filter(l => l.declOffset + l.name.length < prefixStart || l.declOffset > offset);
    let inferredCount = 0;
    for (const l of locals) {
      let type: TypeRef | undefined;
      if (inferredCount++ < 40) type = (await inf.lookupVariable(l.name, prefixStart))?.type;
      push({ label: l.name, kind: 'variable', description: type ? formatType(type) : undefined, detail: localDetail(l), sortText: '01_' + l.name });
    }

    // Members of enclosing classes (implicit this) and script methods
    const cr = inf.enclosingClass(offset);
    if (cr) {
      const ms = await this.ts.members(inf.thisType(offset));
      const inStatic = !!inf.enclosingMember(offset)?.method.isStatic;
      for (const c of this.memberCandidates(ms, { isStatic: inStatic, allowPrivate: true, implicit: true })) {
        c.sortText = '02' + (c.sortText ?? '');
        push(c);
      }
    }
    for (const rm of await inf.implicitMethods(undefined, offset)) {
      if (cr && rm.owner && rm.owner !== '' && rm.method.origin !== 'gdk') continue; // already added
      if (rm.method.origin === 'gdk' && !/^(println|print|printf|sprintf|sleep|with|tap|use|addShutdownHook|evaluate|run)$/.test(rm.method.name)) continue;
      const c = this.methodCandidate(rm);
      c.sortText = (rm.method.origin === 'gdk' || rm.owner === 'groovy.lang.Script' ? '06' : '02') + c.sortText;
      push(c);
    }

    // Keywords & snippets
    for (const k of GROOVY_KEYWORDS) push({ label: k, kind: 'keyword', sortText: '08_' + k });
    for (const s of SNIPPETS) push({ label: s.label, kind: 'snippet', insertText: s.body, isSnippet: true, detail: s.detail, sortText: '09_' + s.label });

    // Classes (with auto-import)
    if (prefix.length > 0 && /^[A-Za-z_$]/.test(prefix)) {
      for (const c of await this.classItems(parsed, prefix, 'expr')) push(c);
    }
    return items;
  }

  private async namedArgItems(inf: Inferencer, parsed: ParsedFile, prefixStart: number): Promise<CompletionCandidate[]> {
    const toks = parsed.tokens;
    let j = tokenIndexBefore(toks, prefixStart);
    const prev = toks[j];
    if (!prev || !(isOp(prev, '(') || isOp(prev, ','))) return [];
    let depth = 0;
    for (; j >= 0; j--) {
      const t = toks[j];
      if (isOp(t, ')') || isOp(t, ']') || isOp(t, '}')) depth++;
      else if (isOp(t, '(') || isOp(t, '[') || isOp(t, '{')) {
        if (depth === 0) break;
        depth--;
      }
    }
    if (j < 1 || !isOp(toks[j], '(') || toks[j - 1].kind !== 'ident') return [];
    const call = await inf.resolveCallAt(j - 1);
    if (!call?.isConstructor || !call.methods.length) return [];
    const type = call.methods[0].returnType;
    const ms = await this.ts.members(type);
    const out: CompletionCandidate[] = [];
    const seen = new Set<string>();
    for (const f of ms.fields) {
      if (f.field.isStatic || !(f.field.isProperty || f.field.origin !== 'workspace' && f.field.visibility === 'public')) continue;
      seen.add(f.field.name);
      out.push({ label: f.field.name + ':', kind: 'property', description: formatType(f.type), insertText: f.field.name + ': ', filterText: f.field.name, detail: 'Argumento con nombre', sortText: '00_' + f.field.name });
    }
    for (const m of ms.methods) {
      const mm = /^set([A-Z]\w*)$/.exec(m.method.name);
      if (!mm || m.params.length !== 1 || m.method.isStatic) continue;
      const prop = mm[1][0].toLowerCase() + mm[1].slice(1);
      if (seen.has(prop)) continue;
      seen.add(prop);
      out.push({ label: prop + ':', kind: 'property', description: formatType(m.params[0]), insertText: prop + ': ', filterText: prop, detail: 'Argumento con nombre', sortText: '00_' + prop });
    }
    return out;
  }

  private variableNameItems(toks: Token[], pi: number, prefixStart: number, text: string): CompletionCandidate[] | undefined {
    const prev = toks[pi];
    if (!prev || prev.end > prefixStart) return undefined;
    // `Type |` or `Type<...> |` at statement start
    let j = pi;
    if (isOp(prev, '>')) {
      let d = 0;
      for (; j >= 0; j--) {
        if (isOp(toks[j], '>')) d++;
        else if (isOp(toks[j], '<')) { d--; if (d === 0) break; }
      }
      j--;
    }
    const typeTok = toks[j];
    if (!typeTok || typeTok.kind !== 'ident' || !/^[A-Z]/.test(typeTok.text)) return undefined;
    const before = toks[j - 1];
    const atStmt = !before || typeTok.nl || isOp(before, ';') || isOp(before, '{') || isOp(before, '}') || isOp(before, '(') || isOp(before, ',') ||
      (before.kind === 'keyword' && ['final', 'private', 'protected', 'public', 'static'].includes(before.text));
    if (!atStmt || /\n/.test(text.slice(prev.end, prefixStart))) return undefined;
    if (before && (isOp(before, '(') || isOp(before, ',')) && !/^[A-Z]/.test(typeTok.text)) return undefined;
    const words = typeTok.text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ');
    const out: CompletionCandidate[] = [];
    for (let k = 0; k < words.length; k++) {
      const n = words.slice(k).join('');
      out.push({ label: n[0].toLowerCase() + n.slice(1), kind: 'variable', detail: 'Nombre sugerido', sortText: '0' + k });
    }
    return out;
  }

  // ------------------------------------------------------------------ classes

  async classItems(parsed: ParsedFile, prefix: string, mode: 'expr' | 'new' | 'type' | 'annotation'): Promise<CompletionCandidate[]> {
    const lower = prefix.toLowerCase();
    const matches = (simple: string) => !prefix || simple.toLowerCase().startsWith(lower) || camelMatch(prefix, simple);
    const out: CompletionCandidate[] = [];
    const seen = new Set<string>();
    const add = async (q: string, cls?: ClassInfo, rank = '5') => {
      if (seen.has(q) || out.length >= MAX_CLASS_ITEMS) return;
      const simple = simpleName(q);
      if (!matches(simple.slice(simple.lastIndexOf('.') + 1))) return;
      seen.add(q);
      const c = this.classCandidate(q, cls, rank);
      if (mode === 'new') {
        c.insertText = `${simple}($0)`;
        c.isSnippet = true;
        c.triggerSignatureHelp = true;
      }
      const edit = await this.importEdit(parsed, q);
      if (edit) c.additionalEdits = [edit];
      out.push(c);
    };
    if (mode === 'annotation') for (const a of COMMON_ANNOTATIONS) await add(a, undefined, '3');
    // declared in file, imported, same package
    for (const q of parsed.ctx.declaredClasses.values()) await add(q, this.ts.ws.get(q), '3');
    for (const imp of parsed.ctx.imports) if (!imp.isStar && !imp.isStatic) await add((await this.ts.resolveName(imp.name)) ?? imp.name, undefined, '3');
    for (const c of this.ts.ws.all()) await add(c.qualifiedName, c, packageOf(c.qualifiedName) === parsed.ctx.packageName ? '4' : '5');
    if (!prefix) return out;
    const all = await this.ts.allClassNames();
    const defaults = new Set(DEFAULT_PACKAGES);
    const ranked = all.filter(q => {
      const s = q.slice(q.lastIndexOf('.') + 1);
      return !q.includes('$') && (s.toLowerCase().startsWith(lower) || camelMatch(prefix, s));
    });
    ranked.sort((a, b) => {
      const pa = defaults.has(packageOf(a)) ? 0 : a.startsWith('java.') ? 1 : 2;
      const pb = defaults.has(packageOf(b)) ? 0 : b.startsWith('java.') ? 1 : 2;
      return pa - pb || a.length - b.length || a.localeCompare(b);
    });
    for (const q of ranked) {
      if (out.length >= MAX_CLASS_ITEMS) break;
      await add(q, undefined, defaults.has(packageOf(q)) ? '5' : '6');
    }
    return out;
  }

  classCandidate(q: string, cls: ClassInfo | undefined, rank: string): CompletionCandidate {
    const simple = simpleName(q);
    const kind = cls?.kind === 'interface' || cls?.kind === 'trait' ? 'interface' : cls?.kind === 'enum' ? 'enum' : 'class';
    return {
      label: simple, kind, description: packageOf(q.replace(/\$.*/, '')) || '(default)',
      detail: q.replace(/\$/g, '.'), documentation: cls?.doc, sortText: `0${rank}_${simple}`, filterText: simple,
    };
  }

  /** Import edit needed to use `q` by simple name, or undefined if already visible. */
  async importEdit(parsed: ParsedFile, q: string): Promise<TextEdit | undefined> {
    const simple = simpleName(q);
    if (q.includes('$')) return undefined;
    const pkg = packageOf(q);
    if (!pkg || pkg === parsed.ctx.packageName || DEFAULT_PACKAGES.includes(pkg) || q === 'java.math.BigDecimal' || q === 'java.math.BigInteger') return undefined;
    const ctx = parsed.ctx;
    if (ctx.imports.some(i => !i.isStatic && (i.name === q || (i.isStar && i.name === pkg)))) return undefined;
    if (ctx.declaredClasses.has(simple)) return undefined;
    return importInsertion(parsed, q);
  }

  // ------------------------------------------------------------------ imports

  private async importItems(path: string, isStatic: boolean): Promise<CompletionCandidate[]> {
    const lastDot = path.lastIndexOf('.');
    const parent = lastDot < 0 ? '' : path.slice(0, lastDot);
    if (isStatic && parent) {
      const q = await this.ts.resolveName(parent);
      if (q) {
        const ms = await this.ts.members(ref(q));
        const items = this.memberCandidates(ms, { isStatic: true, allowPrivate: false, methodRef: false });
        for (const it of items) { it.insertText = it.label; it.isSnippet = false; it.triggerSignatureHelp = false; }
        items.push({ label: '*', kind: 'keyword', sortText: '00' });
        return items;
      }
    }
    return this.packageChildren(parent, true);
  }

  private packageTree?: { version: number; size: number; children: Map<string, Set<string>>; classes: Map<string, string[]> };

  private async packageChildren(parent: string, includeStar: boolean): Promise<CompletionCandidate[]> {
    const all = await this.ts.allClassNames();
    if (!this.packageTree || this.packageTree.version !== this.ts.ws.version || this.packageTree.size !== all.length) {
      const children = new Map<string, Set<string>>();
      const classes = new Map<string, string[]>();
      for (const q of all) {
        if (q.includes('$')) continue;
        const pkg = packageOf(q);
        let list = classes.get(pkg);
        if (!list) classes.set(pkg, (list = []));
        list.push(q);
        const parts = pkg ? pkg.split('.') : [];
        for (let k = 0; k < parts.length; k++) {
          const par = parts.slice(0, k).join('.');
          let s = children.get(par);
          if (!s) children.set(par, (s = new Set()));
          s.add(parts[k]);
        }
      }
      this.packageTree = { version: this.ts.ws.version, size: all.length, children, classes };
    }
    const items: CompletionCandidate[] = [];
    for (const seg of this.packageTree.children.get(parent) ?? []) {
      items.push({ label: seg, kind: 'module', detail: parent ? `${parent}.${seg}` : seg, sortText: '1_' + seg });
    }
    if (parent) {
      for (const q of this.packageTree.classes.get(parent) ?? []) {
        const c = this.classCandidate(q, this.ts.ws.get(q), '0');
        items.push(c);
      }
      if (includeStar && items.length) items.push({ label: '*', kind: 'keyword', detail: `Todas las clases de ${parent}`, sortText: '2' });
    }
    return items;
  }
}

function localDetail(l: LocalVar): string {
  switch (l.kind) {
    case 'param': return 'Parámetro';
    case 'forVar': return 'Variable de bucle';
    case 'catch': return 'Excepción capturada';
    case 'assign':
    case 'binding': return 'Variable del script';
    default: return 'Variable local';
  }
}

/** IntelliJ-like camel hump matching: "AL" matches ArrayList, "LiHaMa" matches LinkedHashMap. */
export function camelMatch(pattern: string, name: string): boolean {
  if (!/[A-Z]/.test(pattern)) return false;
  const humps = name.match(/[A-Z][a-z0-9_$]*|[a-z0-9_$]+/g) ?? [];
  const parts = pattern.match(/[A-Z][a-z0-9_$]*|[a-z0-9_$]+/g) ?? [];
  let h = 0;
  for (const p of parts) {
    while (h < humps.length && !humps[h].toLowerCase().startsWith(p.toLowerCase())) h++;
    if (h >= humps.length) return false;
    h++;
  }
  return true;
}

/** Where and how to insert `import q`. */
export function importInsertion(parsed: ParsedFile, q: string): TextEdit {
  const imports = parsed.ctx.imports;
  if (imports.length) {
    const last = imports.reduce((a, b) => (b.end > a.end ? b : a));
    return { start: last.end, end: last.end, newText: `\nimport ${q}` };
  }
  const toks = parsed.tokens;
  const pk = toks.findIndex(t => t.kind === 'keyword' && t.text === 'package');
  if (pk >= 0) {
    let j = pk + 1;
    while (j < toks.length && !toks[j].nl && !isOp(toks[j], ';')) j++;
    const end = isOp(toks[j], ';') ? toks[j].end : toks[j - 1].end;
    return { start: end, end, newText: `\n\nimport ${q}` };
  }
  const text = parsed.text;
  const at = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
  return { start: at, end: at, newText: `import ${q}\n\n` };
}

