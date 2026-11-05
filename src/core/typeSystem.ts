// Type system: class lookup (workspace, synthetic Groovy classes, JDK/classpath via javap), simple-name resolution
// following Groovy import rules, and member collection across the hierarchy with generic substitution + GDK methods.
import { ClassInfo, FieldInfo, FileContext, MethodInfo } from './model';
import {
  TypeRef, ref, objectRef, boxed, substitute, unwildcard, typeKey, PRIMITIVES, OBJECT, componentType, packageOf,
} from './typeRef';
import { JavaClassProvider } from './javaClassProvider';
import { getGdkMethods, getSyntheticClass } from './gdk';

export const DEFAULT_PACKAGES = ['java.lang', 'java.util', 'java.io', 'java.net', 'groovy.lang', 'groovy.util'];
const DEFAULT_CLASSES: Record<string, string> = {
  BigDecimal: 'java.math.BigDecimal',
  BigInteger: 'java.math.BigInteger',
};

export interface ResolvedMethod {
  method: MethodInfo;
  params: TypeRef[];
  returnType: TypeRef;
  /** Resolved GDK closure parameter hints. */
  closureParams?: Record<number, TypeRef[]>;
  owner: string;
  /** 0 = the type itself, 1 = direct supertype... GDK methods use 50+, Object 90. */
  depth: number;
}

export interface ResolvedField {
  field: FieldInfo;
  type: TypeRef;
  owner: string;
  depth: number;
}

export interface MemberSet {
  type: TypeRef;
  cls?: ClassInfo;
  methods: ResolvedMethod[];
  fields: ResolvedField[];
  /** Every visited supertype (qualified name) with its substituted type arguments. */
  supertypes: Map<string, TypeRef[]>;
}

/** Index of classes declared in workspace source files. */
export class WorkspaceIndex {
  private byUri = new Map<string, ClassInfo[]>();
  private classes = new Map<string, ClassInfo>();
  private bySimple = new Map<string, Set<string>>();
  version = 0;

  update(uri: string, classes: ClassInfo[]): void {
    this.removeClasses(uri);
    this.byUri.set(uri, classes);
    for (const c of classes) {
      this.classes.set(c.qualifiedName, c);
      let s = this.bySimple.get(c.simpleName);
      if (!s) this.bySimple.set(c.simpleName, (s = new Set()));
      s.add(c.qualifiedName);
    }
    this.version++;
  }

  remove(uri: string): void {
    this.removeClasses(uri);
    this.byUri.delete(uri);
    this.version++;
  }

  private removeClasses(uri: string): void {
    for (const c of this.byUri.get(uri) ?? []) {
      if (this.classes.get(c.qualifiedName) === c) this.classes.delete(c.qualifiedName);
      this.bySimple.get(c.simpleName)?.delete(c.qualifiedName);
    }
  }

  get(qname: string): ClassInfo | undefined {
    return this.classes.get(qname);
  }

  bySimpleName(name: string): string[] {
    return [...(this.bySimple.get(name) ?? [])];
  }

  all(): IterableIterator<ClassInfo> {
    return this.classes.values();
  }

  fileCount(): number {
    return this.byUri.size;
  }
}

export class TypeSystem {
  private memberCache = new Map<string, Promise<MemberSet>>();
  private resolveCache = new Map<string, Promise<string | undefined>>();
  private classSetPromise?: Promise<Set<string>>;
  private wsVersion = -1;

  constructor(public readonly ws: WorkspaceIndex, public readonly java?: JavaClassProvider) {}

  /** Drops caches that depend on workspace sources (call after the index changed). */
  invalidate(): void {
    this.memberCache.clear();
    this.resolveCache.clear();
  }

  clearAll(): void {
    this.invalidate();
    this.classSetPromise = undefined;
  }

  private checkVersion(): void {
    if (this.wsVersion !== this.ws.version) {
      this.wsVersion = this.ws.version;
      this.invalidate();
    }
  }

  /** All JDK + classpath class names (top-level), loaded once. */
  classSet(): Promise<Set<string>> {
    if (!this.classSetPromise) {
      this.classSetPromise = (this.java?.available ? this.java.listClasses() : Promise.resolve([]))
        .then(list => new Set(list))
        .catch(() => new Set<string>());
    }
    return this.classSetPromise;
  }

  async getClass(qname: string): Promise<ClassInfo | undefined> {
    const w = this.ws.get(qname);
    if (w) return w;
    const s = getSyntheticClass(qname);
    if (s) return s;
    if (!this.java?.available || PRIMITIVES.has(qname) || !qname.includes('.')) return undefined;
    try {
      return await this.java.getClass(qname);
    } catch {
      return undefined;
    }
  }

  async exists(qname: string): Promise<boolean> {
    if (this.ws.get(qname) || getSyntheticClass(qname)) return true;
    if (!this.java?.available || !qname.includes('.')) return false;
    const set = await this.classSet();
    if (set.has(qname)) return true;
    if (set.size > 0 && !qname.includes('$')) return false;
    return !!(await this.getClass(qname));
  }

  /**
   * Resolves a type name as written in source (`List`, `Map.Entry`, `java.util.List`) to a binary qualified name.
   * `scopeClass` (qualified) enables lookup of nested classes of the enclosing class and its outers.
   */
  resolveName(name: string, ctx?: FileContext, scopeClass?: string): Promise<string | undefined> {
    this.checkVersion();
    if (PRIMITIVES.has(name)) return Promise.resolve(name);
    const key = `${ctx?.uri ?? ''}|${scopeClass ?? ''}|${name}`;
    let p = this.resolveCache.get(key);
    if (!p) {
      p = this.doResolveName(name, ctx, scopeClass);
      this.resolveCache.set(key, p);
    }
    return p;
  }

  private async doResolveName(name: string, ctx?: FileContext, scopeClass?: string): Promise<string | undefined> {
    if (name.includes('.')) {
      if (await this.exists(name)) return name;
      const parts = name.split('.');
      const outer = await this.resolveName(parts[0], ctx, scopeClass);
      if (outer) {
        const cand = outer + '$' + parts.slice(1).join('$');
        if (await this.exists(cand)) return cand;
      }
      for (let k = parts.length - 1; k >= 1; k--) {
        const cand = parts.slice(0, k).join('.') + '$' + parts.slice(k).join('$');
        if (await this.exists(cand)) return cand;
      }
      return undefined;
    }
    if (ctx) {
      const declared = ctx.declaredClasses.get(name);
      if (declared) return declared;
      // Nested classes of the enclosing classes (and their supertypes' nested classes are not handled).
      let scope = scopeClass;
      while (scope) {
        const cand = scope + '$' + name;
        if (await this.exists(cand)) return cand;
        scope = this.ws.get(scope)?.outer;
      }
      for (const imp of ctx.imports) {
        if (imp.isStar || imp.isStatic) continue;
        if (imp.alias === name || (!imp.alias && imp.name.endsWith('.' + name))) {
          return (await this.resolveName(imp.name)) ?? imp.name;
        }
      }
      const samePkg = ctx.packageName ? ctx.packageName + '.' + name : name;
      if (this.ws.get(samePkg)) return samePkg;
      for (const imp of ctx.imports) {
        if (!imp.isStar || imp.isStatic) continue;
        const cand = imp.name + '.' + name;
        if (await this.exists(cand)) return cand;
        const nested = imp.name + '$' + name;
        if (this.ws.get(nested) || (/[A-Z]/.test(imp.name[imp.name.lastIndexOf('.') + 1] ?? '') && (await this.exists(nested)))) return nested;
      }
      if (await this.exists(samePkg)) return samePkg;
    }
    if (DEFAULT_CLASSES[name]) return DEFAULT_CLASSES[name];
    for (const p of DEFAULT_PACKAGES) {
      const cand = p + '.' + name;
      if (await this.exists(cand)) return cand;
    }
    // Workspace class in the default package or uniquely named elsewhere (lenient, like scripts on a classpath).
    const ws = this.ws.bySimpleName(name);
    if (ws.length === 1 && !ctx) return ws[0];
    if (ws.length === 1 && !packageOf(ws[0])) return ws[0];
    return undefined;
  }

  /** Resolves every name of a source-level type reference. Type variables in `tvars` are kept. */
  async resolveRef(t: TypeRef, ctx: FileContext | undefined, tvars: Iterable<string> = [], scopeClass?: string): Promise<TypeRef> {
    if (!ctx) return t;
    const tv = tvars instanceof Set ? (tvars as Set<string>) : new Set(tvars);
    const rec = async (x: TypeRef): Promise<TypeRef> => {
      if (x.wildcard === 'any') return x;
      let name = x.name;
      if (!tv.has(name) && !PRIMITIVES.has(name)) {
        if (name === 'def' || name === 'var') name = OBJECT;
        else name = (await this.resolveName(name, ctx, scopeClass)) ?? name;
      }
      const args = x.args.length ? await Promise.all(x.args.map(rec)) : x.args;
      const r: TypeRef = { name, args, dims: x.dims };
      if (x.wildcard) r.wildcard = x.wildcard;
      return r;
    };
    return rec(t);
  }

  /** Members of a type, walking superclasses/interfaces with generic substitution and adding GDK methods. */
  members(type: TypeRef): Promise<MemberSet> {
    this.checkVersion();
    const t = boxed(unwildcard(type));
    const key = typeKey(t);
    let p = this.memberCache.get(key);
    if (!p) {
      p = this.computeMembers(t);
      this.memberCache.set(key, p);
    }
    return p;
  }

  private async computeMembers(t: TypeRef): Promise<MemberSet> {
    const result: MemberSet = { type: t, methods: [], fields: [], supertypes: new Map() };
    const methodKeys = new Set<string>();
    const fieldNames = new Set<string>();
    const depths = new Map<string, number>();

    const addMethod = (rm: ResolvedMethod) => {
      const k = rm.method.name + '(' + rm.params.map(p => p.name.replace(/.*[.$]/, '') + '[]'.repeat(p.dims)).join(',') + ')' + (rm.method.isStatic ? 's' : '');
      if (methodKeys.has(k)) return;
      methodKeys.add(k);
      result.methods.push(rm);
    };

    const visit = async (qname: string, args: TypeRef[], depth: number): Promise<void> => {
      if (depth < (depths.get(qname) ?? Infinity)) depths.set(qname, depth);
      if (result.supertypes.has(qname) || depth > 30) return;
      const cls = await this.getClass(qname);
      result.supertypes.set(qname, args);
      if (!cls) return;
      if (depth === 0) result.cls = cls;
      const subst = new Map<string, TypeRef>();
      cls.typeParams.forEach((tp, i) => subst.set(tp, args[i] ? unwildcard(args[i]) : objectRef()));
      const classTvars = new Set(cls.typeParams);
      const scope = cls.qualifiedName;

      // Prefetch supertypes so javap can batch them.
      if (this.java?.available && cls.origin !== 'workspace') {
        const sup = [cls.superClass, ...cls.interfaces].filter((x): x is TypeRef => !!x).map(x => x.name);
        if (sup.length) this.java.prefetch(sup);
      }

      for (const m of cls.methods) {
        const tvars = new Set([...classTvars, ...(m.typeParams ?? [])]);
        const local = new Map(subst);
        for (const tp of m.typeParams ?? []) local.delete(tp);
        const params = await Promise.all(m.params.map(async p => substitute(await this.resolveRef(p.type, cls.ctx, tvars, scope), local)));
        const ret = substitute(await this.resolveRef(m.returnType, cls.ctx, tvars, scope), local);
        addMethod({ method: m, params, returnType: ret, owner: qname, depth: qname === OBJECT ? 90 : depth });
      }
      for (const f of cls.fields) {
        if (fieldNames.has(f.name)) continue;
        fieldNames.add(f.name);
        const ft = substitute(await this.resolveRef(f.type, cls.ctx, classTvars, scope), subst);
        result.fields.push({ field: f, type: ft, owner: qname, depth });
        // Groovy properties have implicit accessors.
        if (f.isProperty && !f.isStatic) {
          const cap = f.name[0].toUpperCase() + f.name.slice(1);
          const isBool = ft.name === 'boolean' && ft.dims === 0;
          const getter: MethodInfo = {
            name: (isBool ? 'is' : 'get') + cap, params: [], returnType: f.type, isStatic: false,
            declaringType: qname, origin: f.origin, doc: f.doc, location: f.location,
          };
          addMethod({ method: getter, params: [], returnType: ft, owner: qname, depth });
          if (!f.isFinal) {
            const setter: MethodInfo = {
              name: 'set' + cap, params: [{ name: f.name, type: f.type }], returnType: ref('void'), isStatic: false,
              declaringType: qname, origin: f.origin, doc: f.doc, location: f.location,
            };
            addMethod({ method: setter, params: [ft], returnType: ref('void'), owner: qname, depth });
          }
        }
      }
      if (cls.kind === 'enum' && cls.origin === 'workspace') {
        const self = ref(qname);
        addMethod({ method: { name: 'values', params: [], returnType: ref(qname, [], 1), isStatic: true, declaringType: qname, origin: 'workspace' }, params: [], returnType: ref(qname, [], 1), owner: qname, depth });
        addMethod({ method: { name: 'valueOf', params: [{ name: 'name', type: ref('java.lang.String') }], returnType: self, isStatic: true, declaringType: qname, origin: 'workspace' }, params: [ref('java.lang.String')], returnType: self, owner: qname, depth });
      }

      const supers: TypeRef[] = [];
      if (cls.superClass) supers.push(cls.superClass);
      else if (cls.kind === 'enum' && cls.origin === 'workspace') supers.push(ref('java.lang.Enum', [ref(qname)]));
      supers.push(...cls.interfaces);
      for (const s of supers) {
        const r = substitute(await this.resolveRef(s, cls.ctx, classTvars, cls.outer ?? scope), subst);
        await visit(r.name, r.args, depth + 1);
      }
    };

    if (t.dims > 0) {
      const comp = componentType(t)!;
      result.supertypes.set('[]', [comp]);
      result.fields.push({
        field: { name: 'length', type: ref('int'), isStatic: false, isFinal: true, origin: 'synthetic', declaringType: '[]', doc: 'Longitud del array.' },
        type: ref('int'), owner: '[]', depth: 0,
      });
    } else if (!PRIMITIVES.has(t.name)) {
      await visit(t.name, t.args, 0);
    }
    if (!result.supertypes.has(OBJECT)) await visit(OBJECT, [], 90);

    // GDK methods
    const gdkVars = new Map<string, TypeRef>();
    gdkVars.set('Self', t);
    const elem = this.elementTypeFrom(t, result.supertypes);
    gdkVars.set('T', elem ?? objectRef());
    const mapArgs = result.supertypes.get('java.util.Map');
    gdkVars.set('K', mapArgs?.[0] ? unwildcard(mapArgs[0]) : objectRef());
    gdkVars.set('V', mapArgs?.[1] ? unwildcard(mapArgs[1]) : objectRef());

    const receivers = [...result.supertypes.keys()];
    // Closest receivers first so that narrower GDK overloads (List.findAll -> List<T>) win over Iterable's.
    const rank = (q: string) => (q === OBJECT ? 1000 : depths.get(q) ?? 500);
    receivers.sort((a, b) => rank(a) - rank(b));
    for (const recv of receivers) {
      for (const m of getGdkMethods(recv)) {
        const local = new Map(gdkVars);
        for (const tp of m.typeParams ?? []) local.delete(tp);
        const params = m.params.map(p => substitute(p.type, local));
        const rm: ResolvedMethod = {
          method: m, params, returnType: substitute(m.returnType, local), owner: recv, depth: recv === OBJECT ? 95 : 50 + Math.min(rank(recv), 40),
        };
        if (m.closureParams) {
          rm.closureParams = {};
          for (const [k, v] of Object.entries(m.closureParams)) rm.closureParams[Number(k)] = v.map(x => substitute(x, local));
        }
        addMethod(rm);
      }
    }
    return result;
  }

  private elementTypeFrom(t: TypeRef, supertypes: Map<string, TypeRef[]>): TypeRef | undefined {
    if (t.dims > 0) return componentType(t);
    for (const q of ['java.lang.Iterable', 'java.util.Iterator', 'java.util.stream.BaseStream', 'java.util.Optional']) {
      const a = supertypes.get(q);
      if (a?.[0]) return boxed(unwildcard(a[0]));
      if (a) return objectRef();
    }
    const map = supertypes.get('java.util.Map');
    if (map) return ref('java.util.Map$Entry', [map[0] ? unwildcard(map[0]) : objectRef(), map[1] ? unwildcard(map[1]) : objectRef()]);
    if (supertypes.has('java.lang.CharSequence')) return ref('java.lang.String');
    return undefined;
  }

  /** Type of the elements produced when iterating `t` (for loops, closure `it` in each/collect...). */
  async elementType(t: TypeRef): Promise<TypeRef | undefined> {
    const ms = await this.members(t);
    return this.elementTypeFrom(boxed(t), ms.supertypes);
  }

  async isSubtype(t: TypeRef, qname: string): Promise<boolean> {
    if (t.name === qname) return true;
    return (await this.members(t)).supertypes.has(qname);
  }

  /** Resolved constructors of a class (Groovy classes without explicit constructors get the default + named-args map constructor). */
  async constructors(qname: string): Promise<ResolvedMethod[]> {
    const cls = await this.getClass(qname);
    if (!cls) return [];
    const tvars = new Set(cls.typeParams);
    const out: ResolvedMethod[] = [];
    for (const c of cls.constructors) {
      const params = await Promise.all(c.params.map(p => this.resolveRef(p.type, cls.ctx, tvars, qname)));
      out.push({ method: c, params, returnType: ref(qname), owner: qname, depth: 0 });
    }
    if (out.length === 0 && cls.kind === 'class') {
      out.push({ method: { name: cls.simpleName, params: [], returnType: ref(qname), isStatic: false, isConstructor: true, declaringType: qname, origin: cls.origin }, params: [], returnType: ref(qname), owner: qname, depth: 0 });
      if (cls.origin === 'workspace') {
        const mapT = ref('java.util.Map', [ref('java.lang.String'), objectRef()]);
        out.push({ method: { name: cls.simpleName, params: [{ name: 'properties', type: mapT }], returnType: ref(qname), isStatic: false, isConstructor: true, declaringType: qname, origin: cls.origin, doc: 'Constructor con argumentos con nombre (propiedades).' }, params: [mapT], returnType: ref(qname), owner: qname, depth: 0 });
      }
    }
    return out;
  }

  /** Every known class name: workspace + JDK + classpath (binary names). */
  async allClassNames(): Promise<string[]> {
    const set = await this.classSet();
    const out = [...set];
    for (const c of this.ws.all()) if (!set.has(c.qualifiedName)) out.push(c.qualifiedName);
    return out;
  }
}
