// Shared data model used by the parser, the Java class provider, the GDK table, the type system and the providers.
import { TypeRef } from './typeRef';

export type Origin = 'jdk' | 'classpath' | 'workspace' | 'gdk' | 'synthetic';

export interface SourceLocation {
  uri: string;
  line: number; // 0-based
  character: number; // 0-based
}

export interface ParamInfo {
  name: string;
  type: TypeRef;
  hasDefault?: boolean;
}

export interface MethodInfo {
  name: string;
  params: ParamInfo[];
  /** For constructors: the class type. */
  returnType: TypeRef;
  isStatic: boolean;
  isAbstract?: boolean;
  isConstructor?: boolean;
  /** Method-level type parameters (`<T> T foo()` -> ['T']). */
  typeParams?: string[];
  varargs?: boolean;
  doc?: string;
  /** Qualified name of the declaring type. For GDK methods: the receiver type they extend. */
  declaringType?: string;
  origin: Origin;
  location?: SourceLocation;
  /** Visibility, when known. */
  visibility?: 'public' | 'protected' | 'private' | 'package';
  /**
   * GDK hint: types of the parameters of the closure passed to this method, keyed by the number of parameters the
   * closure declares (use key 0 as default / implicit `it`). May use type variables T (element), K, V (map), Self (receiver).
   * Example for Map.each: { 0: [Map$Entry<K,V>], 1: [Map$Entry<K,V>], 2: [K, V] }.
   */
  closureParams?: Record<number, TypeRef[]>;
  /** GDK hint: the return type contains `R`, the result type of the closure argument. */
  usesClosureResult?: boolean;
}

export interface FieldInfo {
  name: string;
  type: TypeRef;
  isStatic: boolean;
  isFinal?: boolean;
  isEnumConstant?: boolean;
  /** Groovy property (field declared without visibility modifier) -> implicit getter/setter. */
  isProperty?: boolean;
  doc?: string;
  declaringType?: string;
  origin: Origin;
  location?: SourceLocation;
  visibility?: 'public' | 'protected' | 'private' | 'package';
}

export type ClassKind = 'class' | 'interface' | 'enum' | 'trait' | 'annotation' | 'record';

export interface ImportInfo {
  /** Qualified class name, or package name for star imports, or `Class.member` for static imports. */
  name: string;
  isStatic: boolean;
  isStar: boolean;
  alias?: string;
  /** Offsets in the source text of the whole import statement. */
  start: number;
  end: number;
}

export interface FileContext {
  uri: string;
  packageName: string;
  imports: ImportInfo[];
  /** Simple name -> qualified name for every class declared in the file (nested: Outer.Inner and Inner -> pkg.Outer$Inner). */
  declaredClasses: Map<string, string>;
}

export interface ClassInfo {
  /** Binary qualified name (pkg.Outer$Inner). */
  qualifiedName: string;
  simpleName: string;
  packageName: string;
  kind: ClassKind;
  typeParams: string[];
  /** Raw (unresolved for workspace sources, qualified for javap) supertypes. */
  superClass?: TypeRef;
  interfaces: TypeRef[];
  methods: MethodInfo[];
  fields: FieldInfo[];
  constructors: MethodInfo[];
  origin: Origin;
  isAbstract?: boolean;
  location?: SourceLocation;
  doc?: string;
  /** File context used to resolve simple type names in members (workspace sources only). */
  ctx?: FileContext;
  /** Qualified name of the enclosing class for nested classes. */
  outer?: string;
}

/** A local variable / parameter / binding seen in a source file. */
export interface LocalVar {
  name: string;
  /** Declared type (undefined for def/var/untyped). Unresolved simple names. */
  type?: TypeRef;
  kind: 'local' | 'param' | 'closureParam' | 'forVar' | 'catch' | 'assign' | 'binding';
  /** Offset of the name token. */
  declOffset: number;
  /** Visibility range [scopeStart, scopeEnd). */
  scopeStart: number;
  scopeEnd: number;
  /** Token index range [start, end) of the initializer expression (after `=`), when present. */
  init?: [number, number];
  /** For `for (x in expr)` / `for (T x : expr)`: token index range of the iterated expression. */
  iterSource?: [number, number];
  line: number;
  character: number;
}

export interface ClosureInfo {
  /** Token index of `{` and of the matching `}` (tokens.length if unterminated). */
  openIndex: number;
  closeIndex: number;
  start: number;
  end: number;
  /** Explicit parameter names (empty when implicit `it`). */
  params: { name: string; type?: TypeRef }[];
  explicitParams: boolean;
  /** Token index where the body starts (after `->` or after `{`). */
  bodyStartIndex: number;
  /** Token index of the method name identifier this closure is passed to (`list.each {`, `foo(x) {`, `foo({`), if any. */
  callNameIndex?: number;
  /** Position of the closure among the call arguments (0-based, counting the args inside parens first). */
  argIndex?: number;
}

export interface MemberRange {
  method: MethodInfo;
  /** Qualified name of the declaring class; undefined for script methods. */
  owner?: string;
  /** Offsets of the whole declaration and of the body `{ ... }`. */
  start: number;
  end: number;
  bodyStart: number;
}

export interface ClassRange {
  cls: ClassInfo;
  start: number;
  /** Offsets of the body braces. */
  bodyStart: number;
  end: number;
}
