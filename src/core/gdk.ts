// Groovy Development Kit (GDK): methods that Groovy adds to JDK types (DefaultGroovyMethods, StringGroovyMethods,
// IOGroovyMethods, ResourceGroovyMethods, NioExtensions, DateGroovyMethods...) plus synthetic Groovy runtime classes
// used when the groovy jars are not on the classpath.
//
// Type variable conventions (substituted by the type system):
//   T = element type of the receiver (Iterable/Iterator type argument, array component type)
//   K, V = Map key / value types
//   Self = the receiver type itself
//   R = result type of the closure argument (MethodInfo.usesClosureResult = true)
import { ClassInfo, ClassKind, FieldInfo, MethodInfo, ParamInfo } from './model';
import { PRIMITIVES, TypeRef, parseType, splitTopLevel } from './typeRef';

// ---------------------------------------------------------------------------------------------------------------------
// Simple name -> qualified name table
// ---------------------------------------------------------------------------------------------------------------------

const QUALIFY: Record<string, string> = {
  Object: 'java.lang.Object',
  String: 'java.lang.String',
  CharSequence: 'java.lang.CharSequence',
  StringBuilder: 'java.lang.StringBuilder',
  StringBuffer: 'java.lang.StringBuffer',
  Integer: 'java.lang.Integer',
  Long: 'java.lang.Long',
  Short: 'java.lang.Short',
  Byte: 'java.lang.Byte',
  Float: 'java.lang.Float',
  Double: 'java.lang.Double',
  Number: 'java.lang.Number',
  Boolean: 'java.lang.Boolean',
  Character: 'java.lang.Character',
  Class: 'java.lang.Class',
  Comparable: 'java.lang.Comparable',
  Iterable: 'java.lang.Iterable',
  Runnable: 'java.lang.Runnable',
  Thread: 'java.lang.Thread',
  Process: 'java.lang.Process',
  Appendable: 'java.lang.Appendable',
  BigDecimal: 'java.math.BigDecimal',
  BigInteger: 'java.math.BigInteger',
  List: 'java.util.List',
  Map: 'java.util.Map',
  'Map.Entry': 'java.util.Map$Entry',
  Set: 'java.util.Set',
  Collection: 'java.util.Collection',
  Iterator: 'java.util.Iterator',
  ListIterator: 'java.util.ListIterator',
  Comparator: 'java.util.Comparator',
  Date: 'java.util.Date',
  Calendar: 'java.util.Calendar',
  TimeZone: 'java.util.TimeZone',
  Locale: 'java.util.Locale',
  SortedSet: 'java.util.SortedSet',
  SortedMap: 'java.util.SortedMap',
  Deque: 'java.util.Deque',
  Queue: 'java.util.Queue',
  Stack: 'java.util.Stack',
  Optional: 'java.util.Optional',
  Random: 'java.util.Random',
  Properties: 'java.util.Properties',
  Stream: 'java.util.stream.Stream',
  Pattern: 'java.util.regex.Pattern',
  Matcher: 'java.util.regex.Matcher',
  File: 'java.io.File',
  Writer: 'java.io.Writer',
  Reader: 'java.io.Reader',
  BufferedReader: 'java.io.BufferedReader',
  BufferedWriter: 'java.io.BufferedWriter',
  PrintWriter: 'java.io.PrintWriter',
  PrintStream: 'java.io.PrintStream',
  InputStream: 'java.io.InputStream',
  OutputStream: 'java.io.OutputStream',
  BufferedInputStream: 'java.io.BufferedInputStream',
  BufferedOutputStream: 'java.io.BufferedOutputStream',
  DataInputStream: 'java.io.DataInputStream',
  DataOutputStream: 'java.io.DataOutputStream',
  ObjectInputStream: 'java.io.ObjectInputStream',
  ObjectOutputStream: 'java.io.ObjectOutputStream',
  URL: 'java.net.URL',
  URI: 'java.net.URI',
  Path: 'java.nio.file.Path',
  Charset: 'java.nio.charset.Charset',
  Closure: 'groovy.lang.Closure',
  Range: 'groovy.lang.Range',
  IntRange: 'groovy.lang.IntRange',
  GString: 'groovy.lang.GString',
  Tuple2: 'groovy.lang.Tuple2',
  Writable: 'groovy.lang.Writable',
  MetaClass: 'groovy.lang.MetaClass',
  MetaProperty: 'groovy.lang.MetaProperty',
  MetaMethod: 'groovy.lang.MetaMethod',
  PropertyValue: 'groovy.lang.PropertyValue',
  Binding: 'groovy.lang.Binding',
  Script: 'groovy.lang.Script',
  FileType: 'groovy.io.FileType',
  GPathResult: 'groovy.xml.slurpersupport.GPathResult',
  Node: 'groovy.util.Node',
  NodeList: 'groovy.util.NodeList',
  SpreadMap: 'groovy.lang.SpreadMap',
};

/** Type variables allowed in GDK / synthetic signatures. */
export const GDK_TYPE_VARS = new Set(['T', 'K', 'V', 'R', 'Self', 'E', 'V1', 'V2']);

function qualifyRef(t: TypeRef): TypeRef {
  let name = t.name;
  if (!GDK_TYPE_VARS.has(name) && !PRIMITIVES.has(name) && QUALIFY[name]) name = QUALIFY[name];
  const out: TypeRef = { name, args: t.args.map(qualifyRef), dims: t.dims };
  if (t.wildcard) out.wildcard = t.wildcard;
  return out;
}

function ty(text: string): TypeRef {
  return qualifyRef(parseType(text));
}

function mentionsR(t: TypeRef): boolean {
  return t.name === 'R' || t.args.some(mentionsR);
}

type CP = Record<number, string[]>;
/** [signature, Spanish doc, closure params?] */
type Entry = [string, string, CP?];

/** Parses `'[static ]RetType name(Type a, Type... b)'` into a MethodInfo. */
function sig(declaringType: string, text: string, doc: string, cp: CP | undefined, origin: 'gdk' | 'synthetic'): MethodInfo {
  let s = text.trim();
  let isStatic = false;
  if (s.startsWith('static ')) { isStatic = true; s = s.slice(7).trim(); }
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  const head = s.slice(0, open).trim();
  const m = /^(.*?)\s*([A-Za-z_$][\w$]*)$/.exec(head);
  if (!m) throw new Error('Firma GDK inválida: ' + text);
  const retText = m[1].trim() || 'void';
  const name = m[2];
  const paramText = s.slice(open + 1, close);
  let varargs = false;
  const params: ParamInfo[] = splitTopLevel(paramText, ',').map((p, i, all) => {
    const pm = /^(.*?)\s+([A-Za-z_$][\w$]*)$/.exec(p.trim());
    const typeText = pm ? pm[1] : p;
    const pname = pm ? pm[2] : 'arg' + i;
    if (i === all.length - 1 && typeText.trim().endsWith('...')) varargs = true;
    return { name: pname, type: ty(typeText) };
  });
  const returnType = ty(retText);
  const mi: MethodInfo = { name, params, returnType, isStatic, doc, declaringType, origin, visibility: 'public' };
  if (varargs) mi.varargs = true;
  if (cp) {
    const out: Record<number, TypeRef[]> = {};
    for (const k of Object.keys(cp)) out[Number(k)] = cp[Number(k)].map(ty);
    mi.closureParams = out;
  }
  if (mentionsR(returnType)) mi.usesClosureResult = true;
  return mi;
}

// ---------------------------------------------------------------------------------------------------------------------
// Closure parameter shapes
// ---------------------------------------------------------------------------------------------------------------------

const T1: CP = { 0: ['T'], 1: ['T'] };
const T12: CP = { 0: ['T'], 1: ['T'], 2: ['T', 'T'] };
const TI: CP = { 0: ['T', 'Integer'], 2: ['T', 'Integer'] };
const INJ: CP = { 0: ['Object', 'T'], 2: ['Object', 'T'] };
const LT1: CP = { 0: ['List<T>'], 1: ['List<T>'] };
const ENTRY = 'Map.Entry<K,V>';
const ME: CP = { 0: [ENTRY], 1: [ENTRY], 2: ['K', 'V'] };
const ME12: CP = { 0: [ENTRY], 1: [ENTRY], 2: [ENTRY, ENTRY] };
const MEI: CP = { 0: [ENTRY, 'Integer'], 2: [ENTRY, 'Integer'], 3: ['K', 'V', 'Integer'] };
const MINJ: CP = { 0: ['Object', ENTRY], 2: ['Object', ENTRY], 3: ['Object', 'K', 'V'] };
const SELF: CP = { 0: ['Self'], 1: ['Self'] };
const O1: CP = { 0: ['Object'], 1: ['Object'] };
const OI: CP = { 0: ['Object', 'Integer'], 2: ['Object', 'Integer'] };
const OINJ: CP = { 0: ['Object', 'Object'], 2: ['Object', 'Object'] };
const S1: CP = { 0: ['String'], 1: ['String'] };
const SLINE: CP = { 0: ['String'], 1: ['String'], 2: ['String', 'Integer'] };
const SI: CP = { 0: ['String', 'Integer'], 2: ['String', 'Integer'] };
const SPLIT: CP = { 0: ['List<String>'], 1: ['List<String>'] };
const F1: CP = { 0: ['File'], 1: ['File'] };
const P1: CP = { 0: ['Path'], 1: ['Path'] };
const NONE: CP = { 0: [] };
const INT1: CP = { 0: ['Integer'], 1: ['Integer'] };
const N1: CP = { 0: ['Self'], 1: ['Self'] };
const BR: CP = { 0: ['BufferedReader'], 1: ['BufferedReader'] };
const BW: CP = { 0: ['BufferedWriter'], 1: ['BufferedWriter'] };
const PW: CP = { 0: ['PrintWriter'], 1: ['PrintWriter'] };
const IS: CP = { 0: ['InputStream'], 1: ['InputStream'] };
const OS: CP = { 0: ['OutputStream'], 1: ['OutputStream'] };
const DIS: CP = { 0: ['DataInputStream'], 1: ['DataInputStream'] };
const DOS: CP = { 0: ['DataOutputStream'], 1: ['DataOutputStream'] };
const OIS: CP = { 0: ['ObjectInputStream'], 1: ['ObjectInputStream'] };
const OOS: CP = { 0: ['ObjectOutputStream'], 1: ['ObjectOutputStream'] };
const OBJ_RD: CP = { 0: ['Object'], 1: ['Object'] };
const RD: CP = { 0: ['Reader'], 1: ['Reader'] };
const WR: CP = { 0: ['Writer'], 1: ['Writer'] };
const DATE1: CP = { 0: ['Date'], 1: ['Date'] };
const BYTES: CP = { 0: ['byte[]', 'Integer'], 2: ['byte[]', 'Integer'] };

const ex = (code: string) => '\n\n```groovy\n' + code + '\n```';

// ---------------------------------------------------------------------------------------------------------------------
// java.lang.Object
// ---------------------------------------------------------------------------------------------------------------------

const OBJECT: Entry[] = [
  ['void println()', 'Imprime un salto de línea en la salida estándar.'],
  ['void println(Object value)', 'Imprime el valor seguido de un salto de línea en la salida estándar.' + ex('println "Hola"')],
  ['void print(Object value)', 'Imprime el valor en la salida estándar sin salto de línea.'],
  ['void printf(String format, Object... values)', 'Imprime una cadena formateada (estilo printf) en la salida estándar.'],
  ['String sprintf(String format, Object... values)', 'Devuelve una cadena formateada (estilo printf).' + ex("sprintf('%05d', 42)")],
  ['void sleep(long milliseconds)', 'Duerme el hilo actual durante los milisegundos indicados.'],
  ['void sleep(long milliseconds, Closure onInterrupt)', 'Duerme el hilo actual; la closure decide qué hacer si se interrumpe.', O1],
  ['String dump()', 'Devuelve una representación detallada del objeto con sus campos.'],
  ['String inspect()', 'Devuelve una representación del objeto tal como se escribiría en código Groovy.'],
  ['R with(Closure<R> closure)', 'Ejecuta la closure con el objeto como delegate y devuelve el resultado de la closure.' + ex('def s = obj.with { name + age }'), SELF],
  ['R with(boolean returning, Closure<R> closure)', 'Ejecuta la closure con el objeto como delegate; devuelve el objeto o el resultado según el flag.', SELF],
  ['Self tap(Closure closure)', 'Ejecuta la closure con el objeto como delegate y devuelve el propio objeto.' + ex('new Persona().tap { nombre = "Ana" }'), SELF],
  ['R identity(Closure<R> closure)', 'Alias de with: ejecuta la closure con el objeto como delegate y devuelve su resultado.', SELF],
  ['boolean is(Object other)', 'Comprueba la identidad de referencia (equivalente a == en Java).'],
  ['boolean isCase(Object switchValue)', 'Implementa la semántica de los case del switch y de grep (por defecto, igualdad).'],
  ['boolean asBoolean()', 'Evalúa la verdad Groovy del objeto (false si es null).'],
  ['Object asType(Class type)', 'Convierte el objeto al tipo indicado (operador as).'],
  ['MetaClass getMetaClass()', 'Devuelve la MetaClass del objeto (metaprogramación).'],
  ['void setMetaClass(MetaClass metaClass)', 'Asigna una MetaClass al objeto.'],
  ['Map getProperties()', 'Devuelve un mapa con las propiedades del objeto y sus valores.'],
  ['List<PropertyValue> getMetaPropertyValues()', 'Devuelve la lista de propiedades del objeto con sus valores.'],
  ['MetaProperty hasProperty(String name)', 'Devuelve la MetaProperty si el objeto tiene la propiedad indicada, o null.'],
  ['List<MetaMethod> respondsTo(String name)', 'Devuelve los métodos con ese nombre a los que responde el objeto.'],
  ['List<MetaMethod> respondsTo(String name, Object[] argTypes)', 'Devuelve los métodos con ese nombre y tipos de argumento a los que responde el objeto.'],
  ['Object invokeMethod(String method, Object arguments)', 'Invoca dinámicamente un método por nombre.'],
  ['Object getAt(String property)', 'Obtiene el valor de una propiedad por nombre (operador de subíndice).'],
  ['void putAt(String property, Object newValue)', 'Asigna el valor de una propiedad por nombre (operador de subíndice).'],
  ['R use(Class categoryClass, Closure<R> closure)', 'Ejecuta la closure con la categoría indicada activa.', NONE],
  ['R use(List<Class> categoryClasses, Closure<R> closure)', 'Ejecuta la closure con las categorías indicadas activas.', NONE],
  ['void addShutdownHook(Closure closure)', 'Registra una closure que se ejecuta al apagar la JVM.', NONE],
  ['Iterator iterator()', 'Devuelve un iterador sobre el objeto (un único elemento si no es iterable).'],
  ['Self each(Closure closure)', 'Itera sobre el objeto (o sus elementos) pasando cada uno a la closure.', O1],
  ['Self eachWithIndex(Closure closure)', 'Itera sobre los elementos pasando el elemento y su índice a la closure.', OI],
  ['boolean every(Closure closure)', 'Devuelve true si todos los elementos cumplen la condición de la closure.', O1],
  ['boolean every()', 'Devuelve true si todos los elementos son verdaderos según Groovy.'],
  ['boolean any(Closure closure)', 'Devuelve true si algún elemento cumple la condición de la closure.', O1],
  ['boolean any()', 'Devuelve true si algún elemento es verdadero según Groovy.'],
  ['List<R> collect(Closure<R> transform)', 'Transforma cada elemento con la closure y devuelve la lista de resultados.', O1],
  ['List collect()', 'Devuelve los elementos del objeto como lista.'],
  ['Object find(Closure closure)', 'Devuelve el primer elemento que cumple la condición de la closure, o null.', O1],
  ['Object find()', 'Devuelve el primer elemento verdadero según Groovy, o null.'],
  ['Collection findAll(Closure closure)', 'Devuelve todos los elementos que cumplen la condición de la closure.', O1],
  ['Collection findAll()', 'Devuelve todos los elementos verdaderos según Groovy.'],
  ['int findIndexOf(Closure closure)', 'Devuelve el índice del primer elemento que cumple la condición, o -1.', O1],
  ['int findIndexOf(int startIndex, Closure closure)', 'Devuelve el índice del primer elemento que cumple la condición a partir de startIndex, o -1.', O1],
  ['int findLastIndexOf(Closure closure)', 'Devuelve el índice del último elemento que cumple la condición, o -1.', O1],
  ['List<Number> findIndexValues(Closure closure)', 'Devuelve los índices de todos los elementos que cumplen la condición.', O1],
  ['R findResult(Closure<R> closure)', 'Devuelve el primer resultado no nulo de la closure aplicada a los elementos.', O1],
  ['R findResult(Object defaultResult, Closure<R> closure)', 'Devuelve el primer resultado no nulo de la closure, o el valor por defecto.', O1],
  ['Collection grep(Object filter)', 'Devuelve los elementos que cumplen el filtro (isCase): clase, regex, rango, closure...'],
  ['Collection grep()', 'Devuelve los elementos verdaderos según Groovy.'],
  ['Object inject(Closure closure)', 'Acumula los elementos usando el primero como valor inicial.', OINJ],
  ['Object inject(Object initialValue, Closure closure)', 'Acumula los elementos a partir del valor inicial con la closure.', OINJ],
  ['Object sum()', 'Suma todos los elementos.'],
  ['Collection split(Closure closure)', 'Divide los elementos en dos colecciones: los que cumplen la condición y los que no.', O1],
  ['String toString()', 'Devuelve la representación en texto del objeto.'],
  ['Object getProperty(String name)', 'Obtiene dinámicamente el valor de una propiedad por nombre.'],
  ['void setProperty(String name, Object value)', 'Asigna dinámicamente el valor de una propiedad por nombre.'],
  ['Object metaClass(Closure closure)', 'Configura la MetaClass del objeto mediante una closure (ExpandoMetaClass).', NONE],
];

// ---------------------------------------------------------------------------------------------------------------------
// java.lang.Iterable
// ---------------------------------------------------------------------------------------------------------------------

const ITERABLE: Entry[] = [
  ['Self each(Closure closure)', 'Itera sobre cada elemento pasando el elemento a la closure.' + ex('lista.each { println it }'), T1],
  ['Self eachWithIndex(Closure closure)', 'Itera sobre cada elemento pasando el elemento y su índice a la closure.' + ex('lista.eachWithIndex { e, i -> println "$i: $e" }'), TI],
  ['List<R> collect(Closure<R> transform)', 'Transforma cada elemento con la closure y devuelve una lista con los resultados.' + ex('[1, 2, 3].collect { it * 2 } // [2, 4, 6]'), T1],
  ['List<T> collect()', 'Devuelve una lista con los elementos.'],
  ['Collection collect(Collection collector, Closure transform)', 'Transforma cada elemento y añade los resultados a la colección indicada.', T1],
  ['List collectMany(Closure transform)', 'Transforma cada elemento en una colección y concatena todos los resultados.' + ex('[1, 2].collectMany { [it, it * 10] } // [1, 10, 2, 20]'), T1],
  ['Map collectEntries(Closure transform)', 'Construye un mapa a partir de las entradas (pares clave/valor) devueltas por la closure.' + ex("['a', 'b'].collectEntries { [it, it.toUpperCase()] }"), T1],
  ['Map collectEntries()', 'Construye un mapa a partir de elementos que son pares clave/valor o Map.Entry.'],
  ['Map collectEntries(Map collector, Closure transform)', 'Añade al mapa indicado las entradas devueltas por la closure.', T1],
  ['List collectNested(Closure transform)', 'Transforma recursivamente los elementos, incluidos los de colecciones anidadas.', O1],
  ['T find(Closure closure)', 'Devuelve el primer elemento que cumple la condición de la closure, o null.' + ex('lista.find { it > 2 }'), T1],
  ['T find()', 'Devuelve el primer elemento verdadero según Groovy, o null.'],
  ['List<T> findAll(Closure closure)', 'Devuelve todos los elementos que cumplen la condición de la closure.' + ex('[1, 2, 3, 4].findAll { it % 2 == 0 } // [2, 4]'), T1],
  ['List<T> findAll()', 'Devuelve los elementos verdaderos según Groovy (descarta null, vacíos, 0...).'],
  ['R findResult(Closure<R> closure)', 'Devuelve el primer resultado no nulo de aplicar la closure a los elementos.', T1],
  ['R findResult(Object defaultResult, Closure<R> closure)', 'Devuelve el primer resultado no nulo de la closure, o el valor por defecto.', T1],
  ['List<R> findResults(Closure<R> filteringTransform)', 'Aplica la closure a cada elemento y devuelve los resultados no nulos.', T1],
  ['int findIndexOf(Closure closure)', 'Devuelve el índice del primer elemento que cumple la condición, o -1.', T1],
  ['int findIndexOf(int startIndex, Closure closure)', 'Devuelve el índice del primer elemento que cumple la condición a partir de startIndex.', T1],
  ['int findLastIndexOf(Closure closure)', 'Devuelve el índice del último elemento que cumple la condición, o -1.', T1],
  ['int findLastIndexOf(int startIndex, Closure closure)', 'Devuelve el índice del último elemento que cumple la condición a partir de startIndex.', T1],
  ['List<Number> findIndexValues(Closure closure)', 'Devuelve los índices de todos los elementos que cumplen la condición.', T1],
  ['List<T> grep(Object filter)', 'Devuelve los elementos que cumplen el filtro (isCase): clase, regex, rango, closure...' + ex("['a', 1, 'b'].grep(String) // ['a', 'b']")],
  ['List<T> grep()', 'Devuelve los elementos verdaderos según Groovy.'],
  ['boolean any(Closure closure)', 'Devuelve true si algún elemento cumple la condición de la closure.', T1],
  ['boolean any()', 'Devuelve true si algún elemento es verdadero según Groovy.'],
  ['boolean every(Closure closure)', 'Devuelve true si todos los elementos cumplen la condición de la closure.', T1],
  ['boolean every()', 'Devuelve true si todos los elementos son verdaderos según Groovy.'],
  ['Number count(Object value)', 'Cuenta cuántos elementos son iguales al valor indicado.'],
  ['Number count(Closure closure)', 'Cuenta cuántos elementos cumplen la condición de la closure.', T1],
  ['Map<R,Integer> countBy(Closure<R> closure)', 'Agrupa los elementos por el resultado de la closure y cuenta cuántos hay en cada grupo.', T1],
  ['Map<R,List<T>> groupBy(Closure<R> closure)', 'Agrupa los elementos en un mapa según el resultado de la closure.' + ex("['ana', 'bea', 'al'].groupBy { it[0] }"), T1],
  ['Map groupBy(Object... closures)', 'Agrupa los elementos en mapas anidados según varias closures.'],
  ['Object inject(Closure closure)', 'Acumula los elementos usando el primero como valor inicial.', { 0: ['T', 'T'], 2: ['T', 'T'] }],
  ['Object inject(Object initialValue, Closure closure)', 'Acumula los elementos a partir del valor inicial con la closure.' + ex('[1, 2, 3].inject(0) { acc, e -> acc + e } // 6'), INJ],
  ['Object sum()', 'Suma todos los elementos (operador plus).'],
  ['Object sum(Object initialValue)', 'Suma todos los elementos partiendo del valor inicial.'],
  ['R sum(Closure<R> closure)', 'Suma los resultados de aplicar la closure a cada elemento.', T1],
  ['R sum(Object initialValue, Closure<R> closure)', 'Suma los resultados de la closure partiendo del valor inicial.', T1],
  ['Object average()', 'Calcula la media de los elementos.'],
  ['Object average(Closure closure)', 'Calcula la media de los resultados de aplicar la closure a cada elemento.', T1],
  ['T max()', 'Devuelve el elemento máximo según el orden natural.'],
  ['T max(Closure closure)', 'Devuelve el elemento máximo según la closure (clave de 1 parámetro o comparador de 2).', T12],
  ['T max(Comparator<T> comparator)', 'Devuelve el elemento máximo según el comparador.'],
  ['T min()', 'Devuelve el elemento mínimo según el orden natural.'],
  ['T min(Closure closure)', 'Devuelve el elemento mínimo según la closure (clave de 1 parámetro o comparador de 2).', T12],
  ['T min(Comparator<T> comparator)', 'Devuelve el elemento mínimo según el comparador.'],
  ['List<T> sort()', 'Ordena los elementos según el orden natural (modifica la colección si es una lista).'],
  ['List<T> sort(boolean mutate)', 'Ordena los elementos; si mutate es false devuelve una copia ordenada.'],
  ['List<T> sort(Closure closure)', 'Ordena según la closure (clave de 1 parámetro o comparador de 2).' + ex('personas.sort { it.edad }'), T12],
  ['List<T> sort(boolean mutate, Closure closure)', 'Ordena según la closure; si mutate es false devuelve una copia ordenada.', T12],
  ['List<T> sort(Comparator<T> comparator)', 'Ordena los elementos según el comparador.'],
  ['List<T> sort(boolean mutate, Comparator<T> comparator)', 'Ordena según el comparador; si mutate es false devuelve una copia.'],
  ['List<T> toSorted()', 'Devuelve una nueva lista ordenada según el orden natural (sin modificar el original).'],
  ['List<T> toSorted(Closure closure)', 'Devuelve una nueva lista ordenada según la closure.', T12],
  ['List<T> toSorted(Comparator<T> comparator)', 'Devuelve una nueva lista ordenada según el comparador.'],
  ['List<T> toUnique()', 'Devuelve una nueva lista sin elementos duplicados.'],
  ['List<T> toUnique(Closure closure)', 'Devuelve una nueva lista sin duplicados según la closure.', T12],
  ['List<T> toUnique(Comparator<T> comparator)', 'Devuelve una nueva lista sin duplicados según el comparador.'],
  ['T first()', 'Devuelve el primer elemento.'],
  ['List<T> first(int n)', 'Devuelve los primeros n elementos.'],
  ['T last()', 'Devuelve el último elemento.'],
  ['List<T> last(int n)', 'Devuelve los últimos n elementos.'],
  ['T head()', 'Devuelve el primer elemento.'],
  ['List<T> tail()', 'Devuelve todos los elementos excepto el primero.'],
  ['List<T> init()', 'Devuelve todos los elementos excepto el último.'],
  ['List<T> take(int num)', 'Devuelve los primeros num elementos.'],
  ['List<T> takeRight(int num)', 'Devuelve los últimos num elementos.'],
  ['List<T> drop(int num)', 'Devuelve los elementos tras descartar los primeros num.'],
  ['List<T> dropRight(int num)', 'Devuelve los elementos tras descartar los últimos num.'],
  ['List<T> takeWhile(Closure condition)', 'Devuelve los elementos iniciales mientras se cumpla la condición.', T1],
  ['List<T> dropWhile(Closure condition)', 'Descarta los elementos iniciales mientras se cumpla la condición y devuelve el resto.', T1],
  ['String join(String separator)', 'Concatena los elementos en una cadena con el separador indicado.' + ex("[1, 2, 3].join(', ') // '1, 2, 3'")],
  ['List flatten()', 'Aplana las colecciones anidadas en una única lista.'],
  ['List flatten(Closure flattenUsing)', 'Aplana las colecciones anidadas transformando los elementos hoja con la closure.', O1],
  ['List<List<T>> collate(int size)', 'Divide los elementos en sublistas del tamaño indicado.' + ex('(1..5).collate(2) // [[1, 2], [3, 4], [5]]')],
  ['List<List<T>> collate(int size, boolean keepRemainder)', 'Divide en sublistas del tamaño indicado, conservando o no el resto.'],
  ['List<List<T>> collate(int size, int step)', 'Divide en sublistas del tamaño indicado avanzando step posiciones (ventana deslizante).'],
  ['List<List<T>> collate(int size, int step, boolean keepRemainder)', 'Divide en sublistas con ventana deslizante, conservando o no el resto.'],
  ['List<List> combinations()', 'Devuelve todas las combinaciones de los elementos de las colecciones contenidas.'],
  ['Set<List<T>> permutations()', 'Devuelve todas las permutaciones de los elementos.'],
  ['List<R> permutations(Closure<R> function)', 'Aplica la closure a cada permutación y devuelve los resultados.', LT1],
  ['Iterator<List<T>> eachPermutation(Closure closure)', 'Itera sobre cada permutación de los elementos.', LT1],
  ['void eachCombination(Closure closure)', 'Itera sobre cada combinación de los elementos de las colecciones contenidas.', { 0: ['List'], 1: ['List'] }],
  ['Set<List<T>> subsequences()', 'Devuelve todas las subsecuencias no vacías de los elementos.'],
  ['List<List> transpose()', 'Transpone una lista de listas (como zip).'],
  ['List<Tuple2<T,Integer>> withIndex()', 'Devuelve una lista de tuplas (elemento, índice).'],
  ['List<Tuple2<T,Integer>> withIndex(int offset)', 'Devuelve una lista de tuplas (elemento, índice) empezando en offset.'],
  ['Map<Integer,T> indexed()', 'Devuelve un mapa índice -> elemento.'],
  ['Map<Integer,T> indexed(int offset)', 'Devuelve un mapa índice -> elemento empezando en offset.'],
  ['List<T> toList()', 'Convierte los elementos en una lista.'],
  ['Set<T> toSet()', 'Convierte los elementos en un conjunto (sin duplicados).'],
  ['Collection<T> asCollection()', 'Devuelve los elementos como colección.'],
  ['List<T> asList()', 'Devuelve los elementos como lista.'],
  ['Collection<Collection<T>> split(Closure closure)', 'Divide en dos colecciones: los elementos que cumplen la condición y los que no.', T1],
  ['List<List<T>> chop(int... chopSizes)', 'Trocea los elementos en sublistas de los tamaños indicados.'],
  ['boolean disjoint(Iterable right)', 'Devuelve true si no hay elementos en común con la otra colección.'],
  ['Collection<T> intersect(Iterable<T> right)', 'Devuelve los elementos comunes a ambas colecciones.'],
  ['Collection<T> intersect(Iterable<T> right, Comparator<T> comparator)', 'Devuelve los elementos comunes según el comparador.'],
  ['Collection<T> plus(Iterable<T> right)', 'Devuelve una nueva colección con los elementos de ambas.'],
  ['Collection<T> plus(T right)', 'Devuelve una nueva colección con el elemento añadido.'],
  ['List<T> multiply(Number factor)', 'Devuelve una lista con los elementos repetidos factor veces.'],
  ['int size()', 'Devuelve el número de elementos.'],
  ['boolean contains(Object item)', 'Comprueba si contiene el elemento indicado.'],
  ['boolean containsAll(Object[] items)', 'Comprueba si contiene todos los elementos indicados.'],
  ['boolean asBoolean()', 'Devuelve true si no está vacío (verdad Groovy).'],
  ['Object asType(Class type)', 'Convierte la colección al tipo indicado (operador as).'],
  ['Stream<T> stream()', 'Devuelve un Stream de los elementos.'],
];

// ---------------------------------------------------------------------------------------------------------------------
// java.util.Collection / List / Set / SortedSet / Deque / Queue / Stack
// ---------------------------------------------------------------------------------------------------------------------

const COLLECTION: Entry[] = [
  ['boolean addAll(T[] items)', 'Añade todos los elementos del array a la colección.'],
  ['boolean addAll(Iterator<T> items)', 'Añade todos los elementos del iterador a la colección.'],
  ['boolean addAll(Iterable<T> items)', 'Añade todos los elementos del iterable a la colección.'],
  ['boolean removeAll(Closure condition)', 'Elimina los elementos que cumplen la condición de la closure.', T1],
  ['boolean removeAll(Object[] items)', 'Elimina todos los elementos indicados.'],
  ['boolean retainAll(Closure condition)', 'Conserva solo los elementos que cumplen la condición de la closure.', T1],
  ['boolean retainAll(Object[] items)', 'Conserva solo los elementos indicados.'],
  ['Collection<T> asImmutable()', 'Devuelve una vista inmutable de la colección.'],
  ['Collection<T> asUnmodifiable()', 'Devuelve una vista no modificable de la colección.'],
  ['Collection<T> asSynchronized()', 'Devuelve una vista sincronizada de la colección.'],
  ['Self leftShift(T value)', 'Añade el elemento a la colección (operador <<) y la devuelve.' + ex('lista << 4')],
  ['Collection<T> minus(Object removeMe)', 'Devuelve una nueva colección sin el elemento indicado.'],
  ['Collection<T> minus(Iterable<T> removeMe)', 'Devuelve una nueva colección sin los elementos indicados.'],
  ['Collection<T> plus(Collection<T> right)', 'Devuelve una nueva colección con los elementos de ambas.'],
  ['Collection<T> unique()', 'Elimina los elementos duplicados (modifica la colección).'],
  ['Collection<T> unique(boolean mutate)', 'Elimina duplicados; si mutate es false devuelve una copia.'],
  ['Collection<T> unique(Closure closure)', 'Elimina duplicados según la closure (clave de 1 parámetro o comparador de 2).', T12],
  ['Collection<T> unique(boolean mutate, Closure closure)', 'Elimina duplicados según la closure; si mutate es false devuelve una copia.', T12],
  ['Collection<T> unique(Comparator<T> comparator)', 'Elimina duplicados según el comparador.'],
  ['boolean isCase(Object switchValue)', 'Devuelve true si la colección contiene el valor (semántica de switch/in).'],
  ['IntRange getIndices()', 'Devuelve el rango de índices válidos (0..size-1).'],
  ['String toListString()', 'Devuelve la representación en texto de la colección como lista.'],
  ['String toListString(int maxSize)', 'Devuelve la representación en texto de la colección truncada a maxSize caracteres.'],
  ['Collection<T> grep(Object filter)', 'Devuelve los elementos que cumplen el filtro (isCase).'],
  ['Collection<T> findAll(Closure closure)', 'Devuelve todos los elementos que cumplen la condición de la closure.', T1],
  ['boolean asBoolean()', 'Devuelve true si la colección no está vacía.'],
];

const LIST: Entry[] = [
  ['T getAt(int index)', 'Devuelve el elemento en el índice (admite índices negativos desde el final).' + ex('lista[-1]')],
  ['List<T> getAt(Range range)', 'Devuelve la sublista del rango indicado.' + ex('lista[1..2]')],
  ['List<T> getAt(Collection indices)', 'Devuelve los elementos en los índices indicados.'],
  ['void putAt(int index, T value)', 'Asigna el elemento en el índice (operador de subíndice), ampliando la lista si es necesario.'],
  ['void putAt(Range range, Object value)', 'Reemplaza el rango indicado por el valor o colección.'],
  ['List<T> reverse()', 'Devuelve una nueva lista con los elementos en orden inverso.'],
  ['List<T> reverse(boolean mutate)', 'Invierte la lista; si mutate es true modifica la original.'],
  ['List<T> reverseEach(Closure closure)', 'Itera sobre los elementos en orden inverso.', T1],
  ['T pop()', 'Elimina y devuelve el primer elemento de la lista.'],
  ['T removeLast()', 'Elimina y devuelve el último elemento de la lista.'],
  ['boolean push(T value)', 'Inserta el elemento al principio de la lista.'],
  ['T removeAt(int index)', 'Elimina y devuelve el elemento en el índice indicado.'],
  ['boolean removeElement(Object o)', 'Elimina la primera aparición del elemento indicado.'],
  ['List<T> swap(int i, int j)', 'Intercambia los elementos en las posiciones indicadas.'],
  ['void shuffle()', 'Mezcla aleatoriamente los elementos de la lista.'],
  ['void shuffle(Random rnd)', 'Mezcla aleatoriamente los elementos usando el generador indicado.'],
  ['List<T> shuffled()', 'Devuelve una copia de la lista mezclada aleatoriamente.'],
  ['List<T> shuffled(Random rnd)', 'Devuelve una copia mezclada usando el generador indicado.'],
  ['List<T> findAll(Closure closure)', 'Devuelve todos los elementos que cumplen la condición de la closure.', T1],
  ['List<T> grep(Object filter)', 'Devuelve los elementos que cumplen el filtro (isCase).'],
  ['List<T> unique()', 'Elimina los elementos duplicados (modifica la lista).'],
  ['List<T> unique(boolean mutate)', 'Elimina duplicados; si mutate es false devuelve una copia.'],
  ['List<T> unique(Closure closure)', 'Elimina duplicados según la closure (clave de 1 parámetro o comparador de 2).', T12],
  ['List<T> unique(boolean mutate, Closure closure)', 'Elimina duplicados según la closure; si mutate es false devuelve una copia.', T12],
  ['List<T> plus(Iterable<T> right)', 'Devuelve una nueva lista con los elementos de ambas.' + ex('[1, 2] + [3] // [1, 2, 3]')],
  ['List<T> plus(T right)', 'Devuelve una nueva lista con el elemento añadido.'],
  ['List<T> plus(int index, Iterable<T> additions)', 'Devuelve una nueva lista con los elementos insertados en el índice.'],
  ['List<T> plus(int index, T[] items)', 'Devuelve una nueva lista con los elementos del array insertados en el índice.'],
  ['List<T> minus(Object removeMe)', 'Devuelve una nueva lista sin el elemento indicado.'],
  ['List<T> minus(Iterable<T> removeMe)', 'Devuelve una nueva lista sin los elementos indicados.'],
  ['List<T> multiply(Number factor)', 'Devuelve una lista con los elementos repetidos factor veces.'],
  ['List<T> intersect(Iterable<T> right)', 'Devuelve los elementos comunes a ambas colecciones.'],
  ['List<T> asImmutable()', 'Devuelve una vista inmutable de la lista.'],
  ['List<T> asUnmodifiable()', 'Devuelve una vista no modificable de la lista.'],
  ['List<T> asSynchronized()', 'Devuelve una vista sincronizada de la lista.'],
  ['List<T> tail()', 'Devuelve todos los elementos excepto el primero.'],
  ['List<T> init()', 'Devuelve todos los elementos excepto el último.'],
  ['List<T> take(int num)', 'Devuelve los primeros num elementos.'],
  ['List<T> drop(int num)', 'Devuelve los elementos tras descartar los primeros num.'],
  ['List<T> takeWhile(Closure condition)', 'Devuelve los elementos iniciales mientras se cumpla la condición.', T1],
  ['List<T> dropWhile(Closure condition)', 'Descarta los elementos iniciales mientras se cumpla la condición.', T1],
  ['List<List<T>> split(Closure closure)', 'Divide en dos listas: los elementos que cumplen la condición y los que no.', T1],
  ['Set<List<T>> subsequences()', 'Devuelve todas las subsecuencias no vacías de la lista.'],
  ['SpreadMap toSpreadMap()', 'Convierte una lista de pares clave/valor alternos en un SpreadMap.'],
  ['List<T> each(Closure closure)', 'Itera sobre cada elemento pasando el elemento a la closure.', T1],
  ['List<T> eachWithIndex(Closure closure)', 'Itera sobre cada elemento pasando el elemento y su índice.', TI],
  ['boolean equals(List other)', 'Compara dos listas elemento a elemento con la semántica de igualdad de Groovy.'],
  ['ListIterator<T> listIterator()', 'Devuelve un ListIterator sobre los elementos.'],
];

const SET: Entry[] = [
  ['Set<T> findAll(Closure closure)', 'Devuelve el conjunto de elementos que cumplen la condición de la closure.', T1],
  ['Set<T> findAll()', 'Devuelve el conjunto de elementos verdaderos según Groovy.'],
  ['Set<T> grep(Object filter)', 'Devuelve el conjunto de elementos que cumplen el filtro (isCase).'],
  ['Set<T> plus(Iterable<T> right)', 'Devuelve un nuevo conjunto con los elementos de ambos.'],
  ['Set<T> plus(T right)', 'Devuelve un nuevo conjunto con el elemento añadido.'],
  ['Set<T> minus(Object removeMe)', 'Devuelve un nuevo conjunto sin el elemento indicado.'],
  ['Set<T> minus(Iterable<T> removeMe)', 'Devuelve un nuevo conjunto sin los elementos indicados.'],
  ['Set<T> intersect(Iterable<T> right)', 'Devuelve el conjunto de elementos comunes.'],
  ['Set<T> asImmutable()', 'Devuelve una vista inmutable del conjunto.'],
  ['Set<T> asUnmodifiable()', 'Devuelve una vista no modificable del conjunto.'],
  ['Set<T> asSynchronized()', 'Devuelve una vista sincronizada del conjunto.'],
  ['Set<T> each(Closure closure)', 'Itera sobre cada elemento pasando el elemento a la closure.', T1],
  ['Set<T> eachWithIndex(Closure closure)', 'Itera sobre cada elemento pasando el elemento y su índice.', TI],
  ['List<Set<T>> split(Closure closure)', 'Divide en dos conjuntos: los elementos que cumplen la condición y los que no.', T1],
  ['boolean equals(Set other)', 'Compara dos conjuntos con la semántica de igualdad de Groovy.'],
];

const SORTED_SET: Entry[] = [
  ['SortedSet<T> asImmutable()', 'Devuelve una vista inmutable del conjunto ordenado.'],
  ['SortedSet<T> asUnmodifiable()', 'Devuelve una vista no modificable del conjunto ordenado.'],
  ['SortedSet<T> asSynchronized()', 'Devuelve una vista sincronizada del conjunto ordenado.'],
  ['SortedSet<T> sort()', 'Devuelve el propio conjunto, que ya está ordenado.'],
  ['SortedSet<T> take(int num)', 'Devuelve los primeros num elementos.'],
  ['SortedSet<T> drop(int num)', 'Devuelve los elementos tras descartar los primeros num.'],
  ['SortedSet<T> tail()', 'Devuelve todos los elementos excepto el primero.'],
  ['SortedSet<T> init()', 'Devuelve todos los elementos excepto el último.'],
];

const DEQUE: Entry[] = [
  ['Self leftShift(T value)', 'Añade el elemento al final de la cola doble (operador <<).'],
  ['Self each(Closure closure)', 'Itera sobre cada elemento de la cola doble.', T1],
  ['Deque<T> asImmutable()', 'Devuelve una vista inmutable de la cola doble.'],
];

const QUEUE: Entry[] = [
  ['Self leftShift(T value)', 'Añade el elemento a la cola (operador <<).'],
];

const STACK: Entry[] = [
  ['T pop()', 'Elimina y devuelve el elemento de la cima de la pila.'],
  ['T push(T value)', 'Inserta el elemento en la cima de la pila.'],
];

// ---------------------------------------------------------------------------------------------------------------------
// java.util.Map
// ---------------------------------------------------------------------------------------------------------------------

const MAP: Entry[] = [
  ['Map<K,V> each(Closure closure)', 'Itera sobre cada entrada del mapa (entry, o clave y valor).' + ex('mapa.each { k, v -> println "$k = $v" }'), ME],
  ['Map<K,V> eachWithIndex(Closure closure)', 'Itera sobre cada entrada del mapa pasando también su índice.', MEI],
  ['Map<K,V> reverseEach(Closure closure)', 'Itera sobre las entradas del mapa en orden inverso.', ME],
  ['List<R> collect(Closure<R> transform)', 'Transforma cada entrada con la closure y devuelve la lista de resultados.' + ex('mapa.collect { k, v -> "$k=$v" }'), ME],
  ['Collection collect(Collection collector, Closure transform)', 'Transforma cada entrada y añade los resultados a la colección indicada.', ME],
  ['List collectMany(Closure transform)', 'Transforma cada entrada en una colección y concatena todos los resultados.', ME],
  ['Map collectEntries(Closure transform)', 'Construye un nuevo mapa con las entradas devueltas por la closure.' + ex('mapa.collectEntries { k, v -> [k, v * 2] }'), ME],
  ['Map collectEntries(Map collector, Closure transform)', 'Añade al mapa indicado las entradas devueltas por la closure.', ME],
  ['Map<K,V> findAll(Closure closure)', 'Devuelve un mapa con las entradas que cumplen la condición.' + ex('mapa.findAll { k, v -> v > 1 }'), ME],
  ['Map.Entry<K,V> find(Closure closure)', 'Devuelve la primera entrada que cumple la condición, o null.', ME],
  ['R findResult(Closure<R> closure)', 'Devuelve el primer resultado no nulo de aplicar la closure a las entradas.', ME],
  ['R findResult(Object defaultResult, Closure<R> closure)', 'Devuelve el primer resultado no nulo de la closure, o el valor por defecto.', ME],
  ['List<R> findResults(Closure<R> filteringTransform)', 'Aplica la closure a cada entrada y devuelve los resultados no nulos.', ME],
  ['boolean any(Closure closure)', 'Devuelve true si alguna entrada cumple la condición de la closure.', ME],
  ['boolean every(Closure closure)', 'Devuelve true si todas las entradas cumplen la condición de la closure.', ME],
  ['Number count(Closure closure)', 'Cuenta cuántas entradas cumplen la condición de la closure.', ME],
  ['Map<R,Integer> countBy(Closure<R> closure)', 'Agrupa las entradas por el resultado de la closure y cuenta cada grupo.', ME],
  ['Map<R,Map<K,V>> groupBy(Closure<R> closure)', 'Agrupa las entradas en submapas según el resultado de la closure.', ME],
  ['Map<R,List<Map.Entry<K,V>>> groupEntriesBy(Closure<R> closure)', 'Agrupa las entradas en listas según el resultado de la closure.', ME],
  ['Object inject(Object initialValue, Closure closure)', 'Acumula las entradas a partir del valor inicial con la closure.', MINJ],
  ['R sum(Closure<R> closure)', 'Suma los resultados de aplicar la closure a cada entrada.', ME],
  ['Map.Entry<K,V> max(Closure closure)', 'Devuelve la entrada máxima según la closure (clave de 1 parámetro o comparador de 2).', ME12],
  ['Map.Entry<K,V> min(Closure closure)', 'Devuelve la entrada mínima según la closure (clave de 1 parámetro o comparador de 2).', ME12],
  ['Map<K,V> sort()', 'Devuelve un nuevo mapa ordenado por clave.'],
  ['Map<K,V> sort(Closure closure)', 'Devuelve un nuevo mapa ordenado según la closure aplicada a las entradas.', ME12],
  ['Map<K,V> sort(Comparator<K> comparator)', 'Devuelve un nuevo mapa ordenado por clave según el comparador.'],
  ['Map<K,V> toSorted()', 'Devuelve un nuevo mapa ordenado por clave.'],
  ['Map<K,V> toSorted(Closure closure)', 'Devuelve un nuevo mapa ordenado según la closure.', ME12],
  ['Map<K,V> subMap(Collection<K> keys)', 'Devuelve un submapa con solo las claves indicadas.'],
  ['Map<K,V> subMap(K[] keys)', 'Devuelve un submapa con solo las claves indicadas.'],
  ['Map<K,V> withDefault(Closure closure)', 'Devuelve un mapa que crea valores por defecto con la closure para claves inexistentes.' + ex('def m = [:].withDefault { 0 }'), { 0: ['K'], 1: ['K'] }],
  ['Map<K,V> withDefault(boolean autoGrow, boolean autoShrink, Closure closure)', 'Devuelve un mapa con valores por defecto configurando crecimiento y reducción automáticos.', { 0: ['K'], 1: ['K'] }],
  ['V get(Object key, V defaultValue)', 'Devuelve el valor de la clave; si no existe, añade y devuelve el valor por defecto.'],
  ['V getAt(Object key)', 'Devuelve el valor asociado a la clave (operador de subíndice).'],
  ['V putAt(K key, V value)', 'Asigna el valor a la clave (operador de subíndice).'],
  ['Map<K,V> plus(Map<K,V> right)', 'Devuelve un nuevo mapa con las entradas de ambos mapas.' + ex("[a: 1] + [b: 2] // [a: 1, b: 2]")],
  ['Map<K,V> plus(Collection<Map.Entry<K,V>> entries)', 'Devuelve un nuevo mapa con las entradas añadidas.'],
  ['Map<K,V> minus(Map removeMe)', 'Devuelve un nuevo mapa sin las entradas indicadas.'],
  ['Map<K,V> leftShift(Map.Entry<K,V> entry)', 'Añade la entrada al mapa (operador <<).'],
  ['Map<K,V> leftShift(Map<K,V> other)', 'Añade todas las entradas del otro mapa (operador <<).'],
  ['Map<K,V> intersect(Map<K,V> right)', 'Devuelve las entradas comunes a ambos mapas.'],
  ['Map<K,V> drop(int num)', 'Devuelve un mapa sin las primeras num entradas.'],
  ['Map<K,V> take(int num)', 'Devuelve un mapa con las primeras num entradas.'],
  ['Map<K,V> takeWhile(Closure condition)', 'Devuelve las entradas iniciales mientras se cumpla la condición.', ME],
  ['Map<K,V> dropWhile(Closure condition)', 'Descarta las entradas iniciales mientras se cumpla la condición.', ME],
  ['Collection<Map<K,V>> split(Closure closure)', 'Divide en dos mapas: las entradas que cumplen la condición y las que no.', ME],
  ['Map<K,V> asImmutable()', 'Devuelve una vista inmutable del mapa.'],
  ['Map<K,V> asUnmodifiable()', 'Devuelve una vista no modificable del mapa.'],
  ['Map<K,V> asSynchronized()', 'Devuelve una vista sincronizada del mapa.'],
  ['Map<K,V> collectEntries()', 'Devuelve una copia del mapa.'],
  ['Map<V,K> inverse()', 'Devuelve un mapa con claves y valores intercambiados.'],
  ['boolean removeAll(Closure condition)', 'Elimina las entradas que cumplen la condición de la closure.', ME],
  ['boolean retainAll(Closure condition)', 'Conserva solo las entradas que cumplen la condición de la closure.', ME],
  ['boolean isCase(Object switchValue)', 'Devuelve true si el mapa contiene la clave y su valor es verdadero.'],
  ['boolean asBoolean()', 'Devuelve true si el mapa no está vacío.'],
  ['Object asType(Class type)', 'Convierte el mapa al tipo indicado (operador as), p. ej. a una interfaz.'],
  ['SpreadMap toSpreadMap()', 'Convierte el mapa en un SpreadMap.'],
  ['String toMapString()', 'Devuelve la representación en texto del mapa.'],
  ['String toMapString(int maxSize)', 'Devuelve la representación en texto del mapa truncada a maxSize caracteres.'],
  ['Map<K,V> findAll()', 'Devuelve las entradas cuyo valor es verdadero según Groovy.'],
  ['boolean any()', 'Devuelve true si alguna entrada tiene un valor verdadero.'],
  ['boolean every()', 'Devuelve true si todas las entradas tienen un valor verdadero.'],
  ['Iterator<Map.Entry<K,V>> iterator()', 'Devuelve un iterador sobre las entradas del mapa.'],
];

// ---------------------------------------------------------------------------------------------------------------------
// java.util.Iterator
// ---------------------------------------------------------------------------------------------------------------------

const ITERATOR: Entry[] = [
  ['Iterator<T> each(Closure closure)', 'Itera sobre los elementos restantes del iterador.', T1],
  ['Iterator<T> eachWithIndex(Closure closure)', 'Itera sobre los elementos restantes pasando el elemento y su índice.', TI],
  ['List<R> collect(Closure<R> transform)', 'Transforma cada elemento con la closure y devuelve la lista de resultados.', T1],
  ['T find(Closure closure)', 'Devuelve el primer elemento que cumple la condición, o null.', T1],
  ['List<T> findAll(Closure closure)', 'Devuelve todos los elementos que cumplen la condición.', T1],
  ['boolean any(Closure closure)', 'Devuelve true si algún elemento cumple la condición.', T1],
  ['boolean every(Closure closure)', 'Devuelve true si todos los elementos cumplen la condición.', T1],
  ['Number count(Closure closure)', 'Cuenta cuántos elementos cumplen la condición.', T1],
  ['Object inject(Object initialValue, Closure closure)', 'Acumula los elementos a partir del valor inicial con la closure.', INJ],
  ['Object sum()', 'Suma todos los elementos restantes.'],
  ['T max()', 'Devuelve el elemento máximo.'],
  ['T min()', 'Devuelve el elemento mínimo.'],
  ['List<T> sort()', 'Devuelve una lista ordenada de los elementos restantes.'],
  ['List<T> toSorted(Closure closure)', 'Devuelve una lista ordenada según la closure.', T12],
  ['Iterator<T> take(int num)', 'Devuelve un iterador con los primeros num elementos.'],
  ['Iterator<T> drop(int num)', 'Devuelve un iterador que descarta los primeros num elementos.'],
  ['Iterator<T> takeWhile(Closure condition)', 'Devuelve un iterador sobre los elementos mientras se cumpla la condición.', T1],
  ['Iterator<T> dropWhile(Closure condition)', 'Devuelve un iterador que descarta elementos mientras se cumpla la condición.', T1],
  ['Iterator<T> unique()', 'Devuelve un iterador sin elementos duplicados.'],
  ['Iterator<T> unique(Closure closure)', 'Devuelve un iterador sin duplicados según la closure.', T12],
  ['Iterator<Tuple2<T,Integer>> withIndex()', 'Devuelve un iterador de tuplas (elemento, índice).'],
  ['Iterator<T> reverse()', 'Devuelve un iterador con los elementos en orden inverso.'],
  ['String join(String separator)', 'Concatena los elementos restantes con el separador.'],
  ['List<T> toList()', 'Consume el iterador y devuelve sus elementos como lista.'],
  ['Set<T> toSet()', 'Consume el iterador y devuelve sus elementos como conjunto.'],
  ['int size()', 'Cuenta (consumiendo) los elementos restantes del iterador.'],
  ['T getAt(int index)', 'Devuelve el elemento en la posición indicada (consumiendo el iterador).'],
  ['Map<R,List<T>> groupBy(Closure<R> closure)', 'Agrupa los elementos según el resultado de la closure.', T1],
  ['Iterator<T> iterator()', 'Devuelve el propio iterador.'],
  ['boolean asBoolean()', 'Devuelve true si quedan elementos (hasNext).'],
];

// ---------------------------------------------------------------------------------------------------------------------
// Arrays ('[]')
// ---------------------------------------------------------------------------------------------------------------------

const ARRAY: Entry[] = [
  ['Self each(Closure closure)', 'Itera sobre cada elemento del array.', T1],
  ['Self eachWithIndex(Closure closure)', 'Itera sobre cada elemento pasando el elemento y su índice.', TI],
  ['Self reverseEach(Closure closure)', 'Itera sobre los elementos del array en orden inverso.', T1],
  ['List<R> collect(Closure<R> transform)', 'Transforma cada elemento con la closure y devuelve la lista de resultados.', T1],
  ['List collectMany(Closure transform)', 'Transforma cada elemento en una colección y concatena los resultados.', T1],
  ['Map collectEntries(Closure transform)', 'Construye un mapa a partir de los pares clave/valor devueltos por la closure.', T1],
  ['T find(Closure closure)', 'Devuelve el primer elemento que cumple la condición, o null.', T1],
  ['List<T> findAll(Closure closure)', 'Devuelve todos los elementos que cumplen la condición.', T1],
  ['List<T> findAll()', 'Devuelve los elementos verdaderos según Groovy.'],
  ['R findResult(Closure<R> closure)', 'Devuelve el primer resultado no nulo de la closure.', T1],
  ['List<R> findResults(Closure<R> filteringTransform)', 'Aplica la closure y devuelve los resultados no nulos.', T1],
  ['int findIndexOf(Closure closure)', 'Devuelve el índice del primer elemento que cumple la condición, o -1.', T1],
  ['int findLastIndexOf(Closure closure)', 'Devuelve el índice del último elemento que cumple la condición, o -1.', T1],
  ['List<Number> findIndexValues(Closure closure)', 'Devuelve los índices de los elementos que cumplen la condición.', T1],
  ['List<T> grep(Object filter)', 'Devuelve los elementos que cumplen el filtro (isCase).'],
  ['boolean any(Closure closure)', 'Devuelve true si algún elemento cumple la condición.', T1],
  ['boolean every(Closure closure)', 'Devuelve true si todos los elementos cumplen la condición.', T1],
  ['Number count(Object value)', 'Cuenta cuántos elementos son iguales al valor.'],
  ['Number count(Closure closure)', 'Cuenta cuántos elementos cumplen la condición.', T1],
  ['Map<R,Integer> countBy(Closure<R> closure)', 'Agrupa por el resultado de la closure y cuenta cada grupo.', T1],
  ['Map<R,List<T>> groupBy(Closure<R> closure)', 'Agrupa los elementos según el resultado de la closure.', T1],
  ['Object inject(Object initialValue, Closure closure)', 'Acumula los elementos a partir del valor inicial con la closure.', INJ],
  ['Object sum()', 'Suma todos los elementos.'],
  ['R sum(Closure<R> closure)', 'Suma los resultados de aplicar la closure a cada elemento.', T1],
  ['Object average()', 'Calcula la media de los elementos.'],
  ['T max()', 'Devuelve el elemento máximo.'],
  ['T max(Closure closure)', 'Devuelve el elemento máximo según la closure.', T12],
  ['T min()', 'Devuelve el elemento mínimo.'],
  ['T min(Closure closure)', 'Devuelve el elemento mínimo según la closure.', T12],
  ['Self sort()', 'Ordena el array según el orden natural (lo modifica).'],
  ['Self sort(Closure closure)', 'Ordena el array según la closure.', T12],
  ['Self sort(Comparator<T> comparator)', 'Ordena el array según el comparador.'],
  ['Self toSorted()', 'Devuelve una copia ordenada del array.'],
  ['Self toSorted(Closure closure)', 'Devuelve una copia del array ordenada según la closure.', T12],
  ['Self toUnique()', 'Devuelve una copia del array sin duplicados.'],
  ['Self reverse()', 'Devuelve una copia del array en orden inverso.'],
  ['String join(String separator)', 'Concatena los elementos en una cadena con el separador.'],
  ['List<T> toList()', 'Convierte el array en una lista.'],
  ['Set<T> toSet()', 'Convierte el array en un conjunto.'],
  ['List<T> asList()', 'Devuelve una vista de lista del array.'],
  ['boolean contains(Object value)', 'Comprueba si el array contiene el valor.'],
  ['T getAt(int index)', 'Devuelve el elemento en el índice (admite negativos).'],
  ['List<T> getAt(Range range)', 'Devuelve los elementos del rango indicado.'],
  ['List<T> getAt(Collection indices)', 'Devuelve los elementos en los índices indicados.'],
  ['T first()', 'Devuelve el primer elemento.'],
  ['T last()', 'Devuelve el último elemento.'],
  ['T head()', 'Devuelve el primer elemento.'],
  ['Self tail()', 'Devuelve todos los elementos excepto el primero.'],
  ['Self init()', 'Devuelve todos los elementos excepto el último.'],
  ['Self take(int num)', 'Devuelve los primeros num elementos.'],
  ['Self takeRight(int num)', 'Devuelve los últimos num elementos.'],
  ['Self drop(int num)', 'Devuelve los elementos tras descartar los primeros num.'],
  ['Self dropRight(int num)', 'Devuelve los elementos tras descartar los últimos num.'],
  ['Self takeWhile(Closure condition)', 'Devuelve los elementos iniciales mientras se cumpla la condición.', T1],
  ['Self dropWhile(Closure condition)', 'Descarta los elementos iniciales mientras se cumpla la condición.', T1],
  ['Self plus(Object right)', 'Devuelve un nuevo array con el elemento o elementos añadidos.'],
  ['Self minus(Object removeMe)', 'Devuelve un nuevo array sin el elemento o elementos indicados.'],
  ['Self swap(int i, int j)', 'Intercambia los elementos en las posiciones indicadas.'],
  ['List<List<T>> collate(int size)', 'Divide el array en sublistas del tamaño indicado.'],
  ['Collection flatten()', 'Aplana los arrays y colecciones anidadas en una lista.'],
  ['List<List<T>> split(Closure closure)', 'Divide en dos listas: los que cumplen la condición y los que no.', T1],
  ['List<Tuple2<T,Integer>> withIndex()', 'Devuelve una lista de tuplas (elemento, índice).'],
  ['Map<Integer,T> indexed()', 'Devuelve un mapa índice -> elemento.'],
  ['IntRange getIndices()', 'Devuelve el rango de índices válidos del array.'],
  ['int size()', 'Devuelve la longitud del array.'],
  ['Stream<T> stream()', 'Devuelve un Stream de los elementos del array.'],
  ['Iterator<T> iterator()', 'Devuelve un iterador sobre los elementos del array.'],
  ['boolean asBoolean()', 'Devuelve true si el array no está vacío.'],
  ['boolean isCase(Object switchValue)', 'Devuelve true si el array contiene el valor (semántica de switch/in).'],
  ['Object asType(Class type)', 'Convierte el array al tipo indicado (operador as).'],
];

// ---------------------------------------------------------------------------------------------------------------------
// CharSequence / String
// ---------------------------------------------------------------------------------------------------------------------

const CHAR_SEQUENCE: Entry[] = [
  ['String padLeft(Number numberOfChars)', 'Rellena por la izquierda con espacios hasta la longitud indicada.' + ex("'7'.padLeft(3) // '  7'")],
  ['String padLeft(Number numberOfChars, String padding)', 'Rellena por la izquierda con el relleno indicado hasta la longitud dada.' + ex("'7'.padLeft(3, '0') // '007'")],
  ['String padRight(Number numberOfChars)', 'Rellena por la derecha con espacios hasta la longitud indicada.'],
  ['String padRight(Number numberOfChars, String padding)', 'Rellena por la derecha con el relleno indicado hasta la longitud dada.'],
  ['String center(Number numberOfChars)', 'Centra el texto rellenando con espacios hasta la longitud indicada.'],
  ['String center(Number numberOfChars, String padding)', 'Centra el texto rellenando con el relleno indicado.'],
  ['String capitalize()', 'Convierte la primera letra a mayúscula.' + ex("'groovy'.capitalize() // 'Groovy'")],
  ['String uncapitalize()', 'Convierte la primera letra a minúscula.'],
  ['Integer toInteger()', 'Convierte el texto a Integer.' + ex("'42'.toInteger()")],
  ['Long toLong()', 'Convierte el texto a Long.'],
  ['Short toShort()', 'Convierte el texto a Short.'],
  ['Double toDouble()', 'Convierte el texto a Double.'],
  ['Float toFloat()', 'Convierte el texto a Float.'],
  ['BigDecimal toBigDecimal()', 'Convierte el texto a BigDecimal.'],
  ['BigInteger toBigInteger()', 'Convierte el texto a BigInteger.'],
  ['Boolean toBoolean()', "Convierte el texto a Boolean ('true', 'y', '1' son verdaderos)."],
  ['Character toCharacter()', 'Devuelve el primer carácter como Character.'],
  ['boolean isNumber()', 'Comprueba si el texto representa un número.'],
  ['boolean isInteger()', 'Comprueba si el texto representa un Integer.'],
  ['boolean isLong()', 'Comprueba si el texto representa un Long.'],
  ['boolean isDouble()', 'Comprueba si el texto representa un Double.'],
  ['boolean isFloat()', 'Comprueba si el texto representa un Float.'],
  ['boolean isBigDecimal()', 'Comprueba si el texto representa un BigDecimal.'],
  ['boolean isBigInteger()', 'Comprueba si el texto representa un BigInteger.'],
  ['boolean isAllWhitespace()', 'Comprueba si el texto está formado solo por espacios en blanco.'],
  ['boolean isCase(Object switchValue)', 'Compara el texto con el valor (semántica de switch).'],
  ['String reverse()', 'Devuelve el texto invertido.'],
  ['List<String> toList()', 'Devuelve la lista de caracteres del texto como cadenas.'],
  ['Set<String> toSet()', 'Devuelve el conjunto de caracteres del texto como cadenas.'],
  ['URL toURL()', 'Convierte el texto en una URL.'],
  ['URI toURI()', 'Convierte el texto en una URI.'],
  ['int size()', 'Devuelve la longitud del texto.'],
  ['String getAt(int index)', 'Devuelve el carácter en el índice como cadena (admite negativos).' + ex("'hola'[-1] // 'a'")],
  ['String getAt(Range range)', 'Devuelve la subcadena del rango indicado.' + ex("'groovy'[0..2] // 'gro'")],
  ['String getAt(Collection indices)', 'Devuelve los caracteres en los índices indicados.'],
  ['String minus(Object target)', 'Elimina la primera aparición del texto o patrón indicado.'],
  ['String plus(Object value)', 'Concatena el valor al texto.'],
  ['String multiply(Number factor)', 'Repite el texto factor veces.' + ex("'ab' * 3 // 'ababab'")],
  ['String next()', 'Devuelve el texto con el último carácter incrementado (operador ++).'],
  ['String previous()', 'Devuelve el texto con el último carácter decrementado (operador --).'],
  ['String stripIndent()', 'Elimina la indentación común de todas las líneas.'],
  ['String stripIndent(int numChars)', 'Elimina numChars caracteres de indentación de cada línea.'],
  ['String stripMargin()', "Elimina el margen hasta el carácter '|' en cada línea."],
  ['String stripMargin(String marginChar)', 'Elimina el margen hasta el carácter indicado en cada línea.'],
  ['String normalize()', 'Normaliza los saltos de línea a \\n.'],
  ['String denormalize()', 'Convierte los saltos de línea al separador de la plataforma.'],
  ['String expand()', 'Expande los tabuladores a espacios (tabulación de 8).'],
  ['String expand(int tabStop)', 'Expande los tabuladores a espacios con la tabulación indicada.'],
  ['String unexpand()', 'Convierte secuencias de espacios en tabuladores.'],
  ['String unexpand(int tabStop)', 'Convierte espacios en tabuladores con la tabulación indicada.'],
  ['R eachLine(Closure<R> closure)', 'Itera sobre cada línea del texto (opcionalmente con su número de línea).', SLINE],
  ['R eachLine(int firstLine, Closure<R> closure)', 'Itera sobre cada línea numerándolas desde firstLine.', SLINE],
  ['List<String> readLines()', 'Devuelve las líneas del texto como lista.'],
  ['String splitEachLine(String regex, Closure closure)', 'Divide cada línea por el separador y pasa la lista de campos a la closure.', SPLIT],
  ['List<String> tokenize()', 'Divide el texto en tokens separados por espacios en blanco.'],
  ['List<String> tokenize(String delimiters)', 'Divide el texto en tokens usando los delimitadores indicados.' + ex("'a,b;c'.tokenize(',;') // ['a', 'b', 'c']")],
  ['List<String> tokenize(Character delimiter)', 'Divide el texto en tokens usando el carácter delimitador.'],
  ['String[] split()', 'Divide el texto por espacios en blanco.'],
  ['String each(Closure closure)', 'Itera sobre cada carácter del texto (como cadena).', S1],
  ['String eachWithIndex(Closure closure)', 'Itera sobre cada carácter pasando el carácter y su índice.', SI],
  ['List<R> collect(Closure<R> transform)', 'Transforma cada carácter con la closure y devuelve la lista de resultados.', S1],
  ['String find(Closure closure)', 'Devuelve el primer carácter que cumple la condición.', S1],
  ['String findAll(Closure closure)', 'Devuelve los caracteres que cumplen la condición.', S1],
  ['boolean any(Closure closure)', 'Devuelve true si algún carácter cumple la condición.', S1],
  ['boolean every(Closure closure)', 'Devuelve true si todos los caracteres cumplen la condición.', S1],
  ['String takeWhile(Closure condition)', 'Devuelve los caracteres iniciales mientras se cumpla la condición.', S1],
  ['String dropWhile(Closure condition)', 'Descarta los caracteres iniciales mientras se cumpla la condición.', S1],
  ['String take(int num)', 'Devuelve los primeros num caracteres.'],
  ['String takeRight(int num)', 'Devuelve los últimos num caracteres.'],
  ['String drop(int num)', 'Devuelve el texto sin los primeros num caracteres.'],
  ['String dropRight(int num)', 'Devuelve el texto sin los últimos num caracteres.'],
  ['String takeAfter(CharSequence searchString)', 'Devuelve el texto que sigue a la primera aparición de la cadena buscada.'],
  ['String takeBefore(CharSequence searchString)', 'Devuelve el texto anterior a la primera aparición de la cadena buscada.'],
  ['String takeBetween(CharSequence from, CharSequence to)', 'Devuelve el texto entre las dos cadenas indicadas.'],
  ['int count(CharSequence text)', 'Cuenta las apariciones de la subcadena indicada.'],
  ['boolean contains(CharSequence text)', 'Comprueba si contiene la subcadena indicada.'],
  ['boolean containsIgnoreCase(CharSequence searchString)', 'Comprueba si contiene la subcadena ignorando mayúsculas/minúsculas.'],
  ['boolean startsWithAny(CharSequence... prefixes)', 'Comprueba si empieza por alguno de los prefijos indicados.'],
  ['boolean endsWithAny(CharSequence... suffixes)', 'Comprueba si termina por alguno de los sufijos indicados.'],
  ['boolean startsWithIgnoreCase(CharSequence prefix)', 'Comprueba si empieza por el prefijo ignorando mayúsculas/minúsculas.'],
  ['boolean endsWithIgnoreCase(CharSequence suffix)', 'Comprueba si termina por el sufijo ignorando mayúsculas/minúsculas.'],
  ['boolean equalsIgnoreZeroSign(Object other)', 'Compara ignorando el signo de cero.'],
  ['String eachMatch(CharSequence regex, Closure closure)', 'Itera sobre cada coincidencia de la expresión regular.', S1],
  ['String eachMatch(Pattern pattern, Closure closure)', 'Itera sobre cada coincidencia del patrón.', S1],
  ['String find(CharSequence regex)', 'Devuelve la primera coincidencia de la expresión regular, o null.'],
  ['String find(Pattern pattern)', 'Devuelve la primera coincidencia del patrón, o null.'],
  ['String find(CharSequence regex, Closure closure)', 'Aplica la closure a la primera coincidencia de la expresión regular.', S1],
  ['String find(Pattern pattern, Closure closure)', 'Aplica la closure a la primera coincidencia del patrón.', S1],
  ['List<String> findAll(CharSequence regex)', 'Devuelve todas las coincidencias de la expresión regular.' + ex("'a1b22'.findAll(/\\d+/) // ['1', '22']")],
  ['List<String> findAll(Pattern pattern)', 'Devuelve todas las coincidencias del patrón.'],
  ['List<R> findAll(CharSequence regex, Closure<R> closure)', 'Aplica la closure a cada coincidencia y devuelve los resultados.', S1],
  ['List<R> findAll(Pattern pattern, Closure<R> closure)', 'Aplica la closure a cada coincidencia del patrón y devuelve los resultados.', S1],
  ['boolean matches(Pattern pattern)', 'Comprueba si todo el texto coincide con el patrón.'],
  ['String replaceAll(CharSequence regex, Closure closure)', 'Reemplaza cada coincidencia por el resultado de la closure.' + ex("'a1b2'.replaceAll(/\\d/) { (it as int) * 2 }"), S1],
  ['String replaceAll(Pattern pattern, Closure closure)', 'Reemplaza cada coincidencia del patrón por el resultado de la closure.', S1],
  ['String replaceAll(Pattern pattern, CharSequence replacement)', 'Reemplaza cada coincidencia del patrón por el texto indicado.'],
  ['String replaceFirst(CharSequence regex, Closure closure)', 'Reemplaza la primera coincidencia por el resultado de la closure.', S1],
  ['String replaceFirst(Pattern pattern, CharSequence replacement)', 'Reemplaza la primera coincidencia del patrón.'],
  ['String replace(Map replacements)', 'Reemplaza cada clave del mapa por su valor.'],
  ['String tr(String sourceSet, String replacementSet)', 'Traduce caracteres del conjunto origen al conjunto destino (como tr de Unix).'],
  ['Pattern bitwiseNegate()', 'Compila el texto como expresión regular (operador ~).'],
  ['Object asType(Class type)', 'Convierte el texto al tipo indicado (operador as).'],
  ['boolean asBoolean()', 'Devuelve true si el texto no está vacío.'],
  ['String toLowerCase()', 'Convierte el texto a minúsculas.'],
  ['String toUpperCase()', 'Convierte el texto a mayúsculas.'],
  ['boolean isBlank()', 'Comprueba si el texto está vacío o solo tiene espacios en blanco.'],
];

const STRING: Entry[] = [
  ['Process execute()', 'Ejecuta el texto como comando del sistema y devuelve el Process.' + ex("'ls -la'.execute().text")],
  ['Process execute(String[] envp, File dir)', 'Ejecuta el comando con las variables de entorno y el directorio indicados.'],
  ['Process execute(List envp, File dir)', 'Ejecuta el comando con las variables de entorno y el directorio indicados.'],
  ['String plus(Object value)', 'Concatena el valor al texto (operador +).'],
  ['String plus(CharSequence value)', 'Concatena el texto indicado (operador +).'],
  ['String minus(Object target)', 'Elimina la primera aparición del texto o patrón (operador -).'],
  ['String negate()', 'Devuelve el texto invertido (operador - unario).'],
  ['String next()', 'Incrementa el último carácter (operador ++).'],
  ['String previous()', 'Decrementa el último carácter (operador --).'],
  ['String getAt(int index)', 'Devuelve el carácter en el índice como cadena.'],
  ['String getAt(Range range)', 'Devuelve la subcadena del rango indicado.'],
  ['StringBuffer leftShift(Object value)', 'Crea un StringBuffer con el texto y añade el valor (operador <<).'],
  ['String[] split()', 'Divide el texto por espacios en blanco.'],
  ['Object asType(Class type)', 'Convierte el texto al tipo indicado (operador as).'],
  ['byte[] decodeBase64()', 'Decodifica el texto en Base64 a un array de bytes.'],
  ['byte[] decodeHex()', 'Decodifica el texto hexadecimal a un array de bytes.'],
  ['String toString()', 'Devuelve el propio texto.'],
];

const STRING_BUILDER: Entry[] = [
  ['StringBuilder leftShift(Object value)', 'Añade el valor al final (operador <<).'],
  ['String plus(String value)', 'Concatena el valor y devuelve un String.'],
  ['void putAt(IntRange range, Object value)', 'Reemplaza el rango de caracteres por el valor.'],
  ['int size()', 'Devuelve la longitud del contenido.'],
];

const CHARACTER: Entry[] = [
  ['boolean isLetter()', 'Comprueba si el carácter es una letra.'],
  ['boolean isDigit()', 'Comprueba si el carácter es un dígito.'],
  ['boolean isLetterOrDigit()', 'Comprueba si el carácter es una letra o un dígito.'],
  ['boolean isWhitespace()', 'Comprueba si el carácter es un espacio en blanco.'],
  ['boolean isUpperCase()', 'Comprueba si el carácter está en mayúscula.'],
  ['boolean isLowerCase()', 'Comprueba si el carácter está en minúscula.'],
  ['char toUpperCase()', 'Convierte el carácter a mayúscula.'],
  ['char toLowerCase()', 'Convierte el carácter a minúscula.'],
  ['Character next()', 'Devuelve el carácter siguiente (operador ++).'],
  ['Character previous()', 'Devuelve el carácter anterior (operador --).'],
  ['boolean asBoolean()', 'Devuelve true si el carácter no es el carácter nulo.'],
  ['Number plus(Number right)', 'Suma el valor numérico del carácter y el número.'],
  ['Number minus(Number right)', 'Resta el número al valor numérico del carácter.'],
];

// ---------------------------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------------------------

const NUMBER: Entry[] = [
  ['void times(Closure closure)', 'Ejecuta la closure n veces pasando el índice (de 0 a n-1).' + ex('3.times { println it }'), INT1],
  ['void upto(Number to, Closure closure)', 'Itera desde este número hasta el indicado (incluido), de uno en uno.' + ex('1.upto(5) { println it }'), N1],
  ['void downto(Number to, Closure closure)', 'Itera desde este número hacia abajo hasta el indicado (incluido).', N1],
  ['void step(Number to, Number stepNumber, Closure closure)', 'Itera desde este número hasta el indicado con el paso dado.', N1],
  ['Number abs()', 'Devuelve el valor absoluto.'],
  ['Number plus(Number right)', 'Suma dos números (operador +).'],
  ['String plus(String right)', 'Concatena el número con el texto.'],
  ['Number minus(Number right)', 'Resta dos números (operador -).'],
  ['Number multiply(Number right)', 'Multiplica dos números (operador *).'],
  ['Number div(Number right)', 'Divide dos números (operador /); con enteros devuelve BigDecimal.'],
  ['Number intdiv(Number divisor)', 'División entera.' + ex('7.intdiv(2) // 3')],
  ['Number mod(Number divisor)', 'Resto de la división (operador %).'],
  ['Number power(Number exponent)', 'Eleva el número a la potencia indicada (operador **).'],
  ['Number negative()', 'Cambia el signo (operador - unario).'],
  ['Number positive()', 'Devuelve el propio número (operador + unario).'],
  ['Number bitwiseNegate()', 'Negación bit a bit (operador ~).'],
  ['Number and(Number right)', 'AND bit a bit (operador &).'],
  ['Number or(Number right)', 'OR bit a bit (operador |).'],
  ['Number xor(Number right)', 'XOR bit a bit (operador ^).'],
  ['Number leftShift(Number operand)', 'Desplazamiento de bits a la izquierda (operador <<).'],
  ['Number rightShift(Number operand)', 'Desplazamiento de bits a la derecha (operador >>).'],
  ['Number rightShiftUnsigned(Number operand)', 'Desplazamiento de bits a la derecha sin signo (operador >>>).'],
  ['Number next()', 'Devuelve el número incrementado en uno (operador ++).'],
  ['Number previous()', 'Devuelve el número decrementado en uno (operador --).'],
  ['Integer toInteger()', 'Convierte el número a Integer.'],
  ['Long toLong()', 'Convierte el número a Long.'],
  ['Double toDouble()', 'Convierte el número a Double.'],
  ['Float toFloat()', 'Convierte el número a Float.'],
  ['BigDecimal toBigDecimal()', 'Convierte el número a BigDecimal.'],
  ['BigInteger toBigInteger()', 'Convierte el número a BigInteger.'],
  ['int compareTo(Character right)', 'Compara el número con el valor numérico de un carácter.'],
  ['boolean asBoolean()', 'Devuelve true si el número es distinto de cero.'],
  ['Object asType(Class type)', 'Convierte el número al tipo indicado (operador as).'],
  ['boolean isCase(Number switchValue)', 'Compara numéricamente con el valor (semántica de switch).'],
];

const INTEGER: Entry[] = [
  ['IntRange rangeTo(int to)', 'Crea un rango de enteros desde este número hasta el indicado.'],
  ['Integer abs()', 'Devuelve el valor absoluto.'],
  ['Integer next()', 'Devuelve el entero siguiente (operador ++).'],
  ['Integer previous()', 'Devuelve el entero anterior (operador --).'],
];

const FLOATING: Entry[] = [
  ['long round()', 'Redondea al entero más cercano.'],
  ['Self round(int precision)', 'Redondea al número de decimales indicado.' + ex('3.14159.round(2) // 3.14')],
  ['Self trunc()', 'Trunca la parte decimal.'],
  ['Self trunc(int precision)', 'Trunca al número de decimales indicado.'],
  ['boolean isNaN()', 'Comprueba si el valor es NaN.'],
  ['boolean isInfinite()', 'Comprueba si el valor es infinito.'],
];

const BIG_DECIMAL: Entry[] = [
  ['BigDecimal round(int precision)', 'Redondea al número de decimales indicado.'],
  ['BigDecimal trunc(int precision)', 'Trunca al número de decimales indicado.'],
  ['boolean isCase(Number switchValue)', 'Compara numéricamente con el valor (semántica de switch).'],
];

const BOOLEAN: Entry[] = [
  ['Boolean and(Boolean right)', 'AND lógico (operador &).'],
  ['Boolean or(Boolean right)', 'OR lógico (operador |).'],
  ['Boolean xor(Boolean right)', 'XOR lógico (operador ^).'],
  ['Boolean implies(Boolean right)', 'Implicación lógica (operador ==>).'],
  ['boolean asBoolean()', 'Devuelve el valor booleano.'],
];

// ---------------------------------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------------------------------

const FILE: Entry[] = [
  ['String getText()', 'Lee todo el contenido del fichero como texto.' + ex("new File('a.txt').text")],
  ['String getText(String charset)', 'Lee todo el contenido del fichero con la codificación indicada.'],
  ['void setText(String text)', 'Escribe el texto en el fichero, reemplazando su contenido.'],
  ['void setText(String text, String charset)', 'Escribe el texto en el fichero con la codificación indicada.'],
  ['byte[] getBytes()', 'Lee todo el contenido del fichero como bytes.'],
  ['void setBytes(byte[] bytes)', 'Escribe los bytes en el fichero, reemplazando su contenido.'],
  ['byte[] readBytes()', 'Lee todo el contenido del fichero como bytes.'],
  ['List<String> readLines()', 'Lee todas las líneas del fichero.'],
  ['List<String> readLines(String charset)', 'Lee todas las líneas del fichero con la codificación indicada.'],
  ['void write(String text)', 'Escribe el texto en el fichero, reemplazando su contenido.'],
  ['void write(String text, String charset)', 'Escribe el texto en el fichero con la codificación indicada.'],
  ['void append(Object text)', 'Añade el texto al final del fichero.'],
  ['void append(Object text, String charset)', 'Añade el texto al final del fichero con la codificación indicada.'],
  ['void append(byte[] bytes)', 'Añade los bytes al final del fichero.'],
  ['File leftShift(Object text)', 'Añade el texto al final del fichero (operador <<).'],
  ['File leftShift(byte[] bytes)', 'Añade los bytes al final del fichero (operador <<).'],
  ['R eachLine(Closure<R> closure)', 'Itera sobre cada línea del fichero (opcionalmente con su número de línea).' + ex("file.eachLine { line, n -> println \"$n: $line\" }"), SLINE],
  ['R eachLine(String charset, Closure<R> closure)', 'Itera sobre cada línea del fichero con la codificación indicada.', SLINE],
  ['R eachLine(int firstLine, Closure<R> closure)', 'Itera sobre cada línea numerándolas desde firstLine.', SLINE],
  ['Object splitEachLine(String regex, Closure closure)', 'Divide cada línea por el separador y pasa la lista de campos a la closure.', SPLIT],
  ['Writable filterLine(Closure closure)', 'Devuelve un Writable con las líneas que cumplen la condición.', S1],
  ['void filterLine(Writer writer, Closure closure)', 'Escribe en el writer las líneas que cumplen la condición.', S1],
  ['R withReader(Closure<R> closure)', 'Abre un BufferedReader, lo pasa a la closure y lo cierra al terminar.', BR],
  ['R withReader(String charset, Closure<R> closure)', 'Abre un BufferedReader con la codificación indicada y lo cierra al terminar.', BR],
  ['R withWriter(Closure<R> closure)', 'Abre un BufferedWriter, lo pasa a la closure y lo cierra al terminar.' + ex("file.withWriter { w -> w << 'hola' }"), BW],
  ['R withWriter(String charset, Closure<R> closure)', 'Abre un BufferedWriter con la codificación indicada y lo cierra al terminar.', BW],
  ['R withWriterAppend(Closure<R> closure)', 'Abre un BufferedWriter en modo añadir y lo cierra al terminar.', BW],
  ['R withPrintWriter(Closure<R> closure)', 'Abre un PrintWriter, lo pasa a la closure y lo cierra al terminar.', PW],
  ['R withInputStream(Closure<R> closure)', 'Abre un InputStream, lo pasa a la closure y lo cierra al terminar.', IS],
  ['R withOutputStream(Closure<R> closure)', 'Abre un OutputStream, lo pasa a la closure y lo cierra al terminar.', OS],
  ['R withDataInputStream(Closure<R> closure)', 'Abre un DataInputStream, lo pasa a la closure y lo cierra al terminar.', DIS],
  ['R withDataOutputStream(Closure<R> closure)', 'Abre un DataOutputStream, lo pasa a la closure y lo cierra al terminar.', DOS],
  ['R withObjectInputStream(Closure<R> closure)', 'Abre un ObjectInputStream, lo pasa a la closure y lo cierra al terminar.', OIS],
  ['R withObjectOutputStream(Closure<R> closure)', 'Abre un ObjectOutputStream, lo pasa a la closure y lo cierra al terminar.', OOS],
  ['void eachObject(Closure closure)', 'Itera sobre cada objeto serializado del fichero.', OBJ_RD],
  ['void eachByte(Closure closure)', 'Itera sobre cada byte del fichero.', { 0: ['Byte'], 1: ['Byte'] }],
  ['void eachByte(int bufferLen, Closure closure)', 'Itera sobre bloques de bytes del fichero.', BYTES],
  ['BufferedReader newReader()', 'Crea un BufferedReader para leer el fichero.'],
  ['BufferedReader newReader(String charset)', 'Crea un BufferedReader con la codificación indicada.'],
  ['BufferedWriter newWriter()', 'Crea un BufferedWriter para escribir en el fichero.'],
  ['BufferedWriter newWriter(boolean append)', 'Crea un BufferedWriter, opcionalmente en modo añadir.'],
  ['BufferedWriter newWriter(String charset)', 'Crea un BufferedWriter con la codificación indicada.'],
  ['BufferedWriter newWriter(String charset, boolean append)', 'Crea un BufferedWriter con la codificación indicada, opcionalmente en modo añadir.'],
  ['PrintWriter newPrintWriter()', 'Crea un PrintWriter para escribir en el fichero.'],
  ['BufferedInputStream newInputStream()', 'Crea un BufferedInputStream para leer el fichero.'],
  ['BufferedOutputStream newOutputStream()', 'Crea un BufferedOutputStream para escribir en el fichero.'],
  ['DataInputStream newDataInputStream()', 'Crea un DataInputStream para leer el fichero.'],
  ['DataOutputStream newDataOutputStream()', 'Crea un DataOutputStream para escribir en el fichero.'],
  ['ObjectInputStream newObjectInputStream()', 'Crea un ObjectInputStream para leer el fichero.'],
  ['ObjectOutputStream newObjectOutputStream()', 'Crea un ObjectOutputStream para escribir en el fichero.'],
  ['void eachFile(Closure closure)', 'Itera sobre cada fichero y directorio contenido en este directorio.', F1],
  ['void eachFile(FileType fileType, Closure closure)', 'Itera sobre los ficheros del tipo indicado (FILES, DIRECTORIES, ANY).', F1],
  ['void eachFileRecurse(Closure closure)', 'Itera recursivamente sobre todos los ficheros y directorios.', F1],
  ['void eachFileRecurse(FileType fileType, Closure closure)', 'Itera recursivamente sobre los ficheros del tipo indicado.', F1],
  ['void eachDir(Closure closure)', 'Itera sobre cada subdirectorio de este directorio.', F1],
  ['void eachDirRecurse(Closure closure)', 'Itera recursivamente sobre todos los subdirectorios.', F1],
  ['void eachFileMatch(Object nameFilter, Closure closure)', 'Itera sobre los ficheros cuyo nombre cumple el filtro (isCase).' + ex('dir.eachFileMatch(~/.*\\.groovy/) { println it.name }'), F1],
  ['void eachFileMatch(FileType fileType, Object nameFilter, Closure closure)', 'Itera sobre los ficheros del tipo indicado cuyo nombre cumple el filtro.', F1],
  ['void eachDirMatch(Object nameFilter, Closure closure)', 'Itera sobre los subdirectorios cuyo nombre cumple el filtro.', F1],
  ['void traverse(Closure closure)', 'Recorre recursivamente el árbol de directorios.', F1],
  ['void traverse(Map options, Closure closure)', 'Recorre el árbol de directorios con opciones (type, maxDepth, nameFilter...).', F1],
  ['long directorySize()', 'Calcula el tamaño total en bytes del directorio.'],
  ['long size()', 'Devuelve el tamaño del fichero en bytes.'],
  ['boolean deleteDir()', 'Borra el directorio de forma recursiva.'],
  ['boolean renameTo(String newPathName)', 'Renombra el fichero a la ruta indicada.'],
  ['File asWritable()', 'Convierte el fichero en un Writable.'],
  ['File asWritable(String encoding)', 'Convierte el fichero en un Writable con la codificación indicada.'],
  ['Object asType(Class type)', 'Convierte el fichero al tipo indicado (operador as).'],
  ['String getBaseName()', 'Devuelve el nombre del fichero sin extensión.'],
  ['String getExtension()', 'Devuelve la extensión del fichero.'],
  ['Iterator<String> iterator()', 'Devuelve un iterador sobre las líneas del fichero.'],
];

const PATH: Entry[] = [
  ['String getText()', 'Lee todo el contenido del fichero como texto.'],
  ['String getText(String charset)', 'Lee todo el contenido con la codificación indicada.'],
  ['void setText(String text)', 'Escribe el texto en el fichero, reemplazando su contenido.'],
  ['byte[] getBytes()', 'Lee todo el contenido como bytes.'],
  ['void setBytes(byte[] bytes)', 'Escribe los bytes en el fichero.'],
  ['byte[] readBytes()', 'Lee todo el contenido como bytes.'],
  ['List<String> readLines()', 'Lee todas las líneas del fichero.'],
  ['void write(String text)', 'Escribe el texto en el fichero, reemplazando su contenido.'],
  ['void write(String text, String charset)', 'Escribe el texto con la codificación indicada.'],
  ['void append(Object text)', 'Añade el texto al final del fichero.'],
  ['Path leftShift(Object text)', 'Añade el texto al final del fichero (operador <<).'],
  ['R eachLine(Closure<R> closure)', 'Itera sobre cada línea del fichero.', SLINE],
  ['Object splitEachLine(String regex, Closure closure)', 'Divide cada línea por el separador y pasa los campos a la closure.', SPLIT],
  ['Writable filterLine(Closure closure)', 'Devuelve un Writable con las líneas que cumplen la condición.', S1],
  ['R withReader(Closure<R> closure)', 'Abre un BufferedReader, lo pasa a la closure y lo cierra al terminar.', BR],
  ['R withWriter(Closure<R> closure)', 'Abre un BufferedWriter, lo pasa a la closure y lo cierra al terminar.', BW],
  ['R withWriterAppend(Closure<R> closure)', 'Abre un BufferedWriter en modo añadir y lo cierra al terminar.', BW],
  ['R withPrintWriter(Closure<R> closure)', 'Abre un PrintWriter, lo pasa a la closure y lo cierra al terminar.', PW],
  ['R withInputStream(Closure<R> closure)', 'Abre un InputStream, lo pasa a la closure y lo cierra al terminar.', IS],
  ['R withOutputStream(Closure<R> closure)', 'Abre un OutputStream, lo pasa a la closure y lo cierra al terminar.', OS],
  ['BufferedReader newReader()', 'Crea un BufferedReader para leer el fichero.'],
  ['BufferedWriter newWriter()', 'Crea un BufferedWriter para escribir en el fichero.'],
  ['BufferedWriter newWriter(boolean append)', 'Crea un BufferedWriter, opcionalmente en modo añadir.'],
  ['PrintWriter newPrintWriter()', 'Crea un PrintWriter para escribir en el fichero.'],
  ['BufferedInputStream newInputStream()', 'Crea un BufferedInputStream para leer el fichero.'],
  ['BufferedOutputStream newOutputStream()', 'Crea un BufferedOutputStream para escribir en el fichero.'],
  ['void eachFile(Closure closure)', 'Itera sobre cada entrada de este directorio.', P1],
  ['void eachFile(FileType fileType, Closure closure)', 'Itera sobre las entradas del tipo indicado.', P1],
  ['void eachFileRecurse(Closure closure)', 'Itera recursivamente sobre todas las entradas.', P1],
  ['void eachDir(Closure closure)', 'Itera sobre cada subdirectorio.', P1],
  ['void eachDirRecurse(Closure closure)', 'Itera recursivamente sobre todos los subdirectorios.', P1],
  ['void eachFileMatch(Object nameFilter, Closure closure)', 'Itera sobre las entradas cuyo nombre cumple el filtro.', P1],
  ['void traverse(Closure closure)', 'Recorre recursivamente el árbol de directorios.', P1],
  ['void traverse(Map options, Closure closure)', 'Recorre el árbol de directorios con opciones.', P1],
  ['long size()', 'Devuelve el tamaño del fichero en bytes.'],
  ['boolean deleteDir()', 'Borra el directorio de forma recursiva.'],
  ['Path asWritable()', 'Convierte la ruta en un Writable.'],
  ['Object asType(Class type)', 'Convierte la ruta al tipo indicado (operador as).'],
  ['String getBaseName()', 'Devuelve el nombre del fichero sin extensión.'],
  ['String getExtension()', 'Devuelve la extensión del fichero.'],
];

const INPUT_STREAM: Entry[] = [
  ['String getText()', 'Lee todo el contenido del flujo como texto.'],
  ['String getText(String charset)', 'Lee todo el contenido del flujo con la codificación indicada.'],
  ['byte[] getBytes()', 'Lee todo el contenido del flujo como bytes.'],
  ['List<String> readLines()', 'Lee todas las líneas del flujo.'],
  ['R eachLine(Closure<R> closure)', 'Itera sobre cada línea del flujo.', SLINE],
  ['R eachLine(String charset, Closure<R> closure)', 'Itera sobre cada línea con la codificación indicada.', SLINE],
  ['Object splitEachLine(String regex, Closure closure)', 'Divide cada línea por el separador y pasa los campos a la closure.', SPLIT],
  ['Writable filterLine(Closure closure)', 'Devuelve un Writable con las líneas que cumplen la condición.', S1],
  ['void eachByte(Closure closure)', 'Itera sobre cada byte del flujo.', { 0: ['Byte'], 1: ['Byte'] }],
  ['void eachByte(int bufferLen, Closure closure)', 'Itera sobre bloques de bytes del flujo.', BYTES],
  ['R withReader(Closure<R> closure)', 'Crea un Reader sobre el flujo, lo pasa a la closure y lo cierra.', RD],
  ['R withStream(Closure<R> closure)', 'Pasa el flujo a la closure y lo cierra al terminar.', { 0: ['Self'], 1: ['Self'] }],
  ['BufferedReader newReader()', 'Crea un BufferedReader sobre el flujo.'],
  ['BufferedReader newReader(String charset)', 'Crea un BufferedReader con la codificación indicada.'],
  ['ObjectInputStream newObjectInputStream()', 'Crea un ObjectInputStream sobre el flujo.'],
  ['Iterator<Byte> iterator()', 'Devuelve un iterador sobre los bytes del flujo.'],
  ['void transferTo(OutputStream out)', 'Copia todo el contenido del flujo al OutputStream.'],
];

const OUTPUT_STREAM: Entry[] = [
  ['OutputStream leftShift(byte[] value)', 'Escribe los bytes en el flujo (operador <<).'],
  ['Writer leftShift(Object value)', 'Escribe el valor como texto en el flujo (operador <<).'],
  ['OutputStream leftShift(InputStream in)', 'Copia el InputStream en este flujo (operador <<).'],
  ['R withStream(Closure<R> closure)', 'Pasa el flujo a la closure y lo cierra al terminar.', { 0: ['Self'], 1: ['Self'] }],
  ['R withWriter(Closure<R> closure)', 'Crea un Writer sobre el flujo, lo pasa a la closure y lo cierra.', WR],
  ['R withPrintWriter(Closure<R> closure)', 'Crea un PrintWriter sobre el flujo, lo pasa a la closure y lo cierra.', PW],
  ['R withObjectOutputStream(Closure<R> closure)', 'Crea un ObjectOutputStream sobre el flujo, lo pasa a la closure y lo cierra.', OOS],
  ['PrintWriter newPrintWriter()', 'Crea un PrintWriter sobre el flujo.'],
  ['Writer newWriter()', 'Crea un Writer sobre el flujo.'],
  ['Writer newWriter(String charset)', 'Crea un Writer con la codificación indicada.'],
  ['ObjectOutputStream newObjectOutputStream()', 'Crea un ObjectOutputStream sobre el flujo.'],
  ['void setBytes(byte[] bytes)', 'Escribe los bytes en el flujo.'],
];

const READER: Entry[] = [
  ['String getText()', 'Lee todo el contenido del Reader como texto.'],
  ['List<String> readLines()', 'Lee todas las líneas del Reader.'],
  ['String readLine()', 'Lee una línea del Reader.'],
  ['R eachLine(Closure<R> closure)', 'Itera sobre cada línea del Reader.', SLINE],
  ['R eachLine(int firstLine, Closure<R> closure)', 'Itera sobre cada línea numerándolas desde firstLine.', SLINE],
  ['Object splitEachLine(String regex, Closure closure)', 'Divide cada línea por el separador y pasa los campos a la closure.', SPLIT],
  ['Writable filterLine(Closure closure)', 'Devuelve un Writable con las líneas que cumplen la condición.', S1],
  ['void filterLine(Writer writer, Closure closure)', 'Escribe en el writer las líneas que cumplen la condición.', S1],
  ['R withReader(Closure<R> closure)', 'Pasa el Reader a la closure y lo cierra al terminar.', { 0: ['Self'], 1: ['Self'] }],
  ['void transformChar(Writer writer, Closure closure)', 'Transforma cada carácter con la closure y lo escribe en el writer.', S1],
  ['void transformLine(Writer writer, Closure closure)', 'Transforma cada línea con la closure y la escribe en el writer.', S1],
  ['Iterator<String> iterator()', 'Devuelve un iterador sobre las líneas del Reader.'],
];

const WRITER: Entry[] = [
  ['Writer leftShift(Object value)', 'Escribe el valor en el Writer (operador <<).' + ex("writer << 'hola' << '\\n'")],
  ['R withWriter(Closure<R> closure)', 'Pasa el Writer a la closure y lo cierra al terminar.', { 0: ['Self'], 1: ['Self'] }],
  ['R withPrintWriter(Closure<R> closure)', 'Crea un PrintWriter sobre el Writer, lo pasa a la closure y lo cierra.', PW],
  ['PrintWriter newPrintWriter()', 'Crea un PrintWriter sobre el Writer.'],
  ['void write(Writable writable)', 'Escribe el contenido del Writable.'],
];

const URL_: Entry[] = [
  ['String getText()', 'Descarga el contenido de la URL como texto.' + ex("new URL('https://example.com').text")],
  ['String getText(String charset)', 'Descarga el contenido de la URL con la codificación indicada.'],
  ['String getText(Map parameters)', 'Descarga el contenido con parámetros (connectTimeout, readTimeout, requestProperties...).'],
  ['byte[] getBytes()', 'Descarga el contenido de la URL como bytes.'],
  ['byte[] getBytes(Map parameters)', 'Descarga el contenido como bytes con parámetros de conexión.'],
  ['List<String> readLines()', 'Descarga el contenido y lo devuelve como lista de líneas.'],
  ['R eachLine(Closure<R> closure)', 'Itera sobre cada línea del contenido de la URL.', SLINE],
  ['Object splitEachLine(String regex, Closure closure)', 'Divide cada línea por el separador y pasa los campos a la closure.', SPLIT],
  ['Writable filterLine(Closure closure)', 'Devuelve un Writable con las líneas que cumplen la condición.', S1],
  ['R withReader(Closure<R> closure)', 'Abre un Reader sobre la URL, lo pasa a la closure y lo cierra.', RD],
  ['R withInputStream(Closure<R> closure)', 'Abre un InputStream sobre la URL, lo pasa a la closure y lo cierra.', IS],
  ['BufferedReader newReader()', 'Crea un BufferedReader sobre el contenido de la URL.'],
  ['BufferedReader newReader(String charset)', 'Crea un BufferedReader con la codificación indicada.'],
  ['BufferedInputStream newInputStream()', 'Crea un BufferedInputStream sobre el contenido de la URL.'],
  ['void eachByte(Closure closure)', 'Itera sobre cada byte del contenido de la URL.', { 0: ['Byte'], 1: ['Byte'] }],
];

const PROCESS: Entry[] = [
  ['String getText()', 'Espera a que termine el proceso y devuelve su salida estándar como texto.' + ex("'ls'.execute().text")],
  ['InputStream getIn()', 'Devuelve la salida estándar del proceso como InputStream.'],
  ['InputStream getErr()', 'Devuelve la salida de error del proceso como InputStream.'],
  ['OutputStream getOut()', 'Devuelve la entrada estándar del proceso como OutputStream.'],
  ['void waitForProcessOutput()', 'Espera a que termine el proceso consumiendo su salida.'],
  ['void waitForProcessOutput(Appendable output, Appendable error)', 'Espera a que termine el proceso guardando su salida y errores.'],
  ['void waitForProcessOutput(OutputStream output, OutputStream error)', 'Espera a que termine el proceso volcando su salida y errores.'],
  ['void consumeProcessOutput()', 'Consume en segundo plano la salida y los errores del proceso.'],
  ['void consumeProcessOutput(Appendable output, Appendable error)', 'Consume en segundo plano la salida y los errores en los destinos indicados.'],
  ['void consumeProcessOutput(OutputStream output, OutputStream error)', 'Consume en segundo plano la salida y los errores en los flujos indicados.'],
  ['Thread consumeProcessErrorStream(Appendable error)', 'Consume en segundo plano la salida de error del proceso.'],
  ['void waitForOrKill(long numberOfMillis)', 'Espera a que termine el proceso o lo mata tras el tiempo indicado.'],
  ['Writer leftShift(Object value)', 'Escribe el valor en la entrada estándar del proceso (operador <<).'],
  ['OutputStream leftShift(byte[] value)', 'Escribe los bytes en la entrada estándar del proceso.'],
  ['Process pipeTo(Process right)', 'Encadena la salida de este proceso a la entrada del otro (operador |).'],
  ['Process or(Process right)', 'Encadena la salida de este proceso a la entrada del otro (operador |).'],
  ['void withWriter(Closure closure)', 'Pasa un Writer sobre la entrada del proceso a la closure.', WR],
  ['void withOutputStream(Closure closure)', 'Pasa la entrada del proceso como OutputStream a la closure.', OS],
  ['void closeStreams()', 'Cierra todos los flujos del proceso.'],
];

const DATE: Entry[] = [
  ['String format(String format)', 'Formatea la fecha con el patrón indicado (SimpleDateFormat).' + ex("new Date().format('yyyy-MM-dd')")],
  ['String format(String format, TimeZone tz)', 'Formatea la fecha con el patrón y la zona horaria indicados.'],
  ['String getDateString()', 'Devuelve la fecha en formato corto según la configuración regional.'],
  ['String getTimeString()', 'Devuelve la hora en formato medio según la configuración regional.'],
  ['String getDateTimeString()', 'Devuelve fecha y hora según la configuración regional.'],
  ['Date plus(int days)', 'Devuelve una nueva fecha sumando los días indicados (operador +).'],
  ['Date minus(int days)', 'Devuelve una nueva fecha restando los días indicados (operador -).'],
  ['int minus(Date then)', 'Devuelve el número de días entre las dos fechas.'],
  ['Date next()', 'Devuelve el día siguiente (operador ++).'],
  ['Date previous()', 'Devuelve el día anterior (operador --).'],
  ['int getAt(int field)', 'Devuelve el valor del campo de Calendar indicado.'],
  ['void putAt(int field, int value)', 'Asigna el valor del campo de Calendar indicado.'],
  ['Date clearTime()', 'Pone a cero la parte horaria de la fecha.'],
  ['Calendar toCalendar()', 'Convierte la fecha en un Calendar.'],
  ['void upto(Date to, Closure closure)', 'Itera día a día desde esta fecha hasta la indicada.', DATE1],
  ['void downto(Date to, Closure closure)', 'Itera día a día hacia atrás hasta la fecha indicada.', DATE1],
  ['Date copyWith(Map updates)', 'Devuelve una copia de la fecha con los campos indicados modificados.'],
  ['void set(Map updates)', 'Modifica los campos de la fecha indicados en el mapa.'],
];

const MATCHER: Entry[] = [
  ['Matcher each(Closure closure)', 'Itera sobre cada coincidencia (cadena o lista de grupos).', S1],
  ['Object getAt(int index)', 'Devuelve la coincidencia en el índice (cadena o lista de grupos).'],
  ['List getAt(Collection indices)', 'Devuelve las coincidencias en los índices indicados.'],
  ['String group(String name)', 'Devuelve el grupo con nombre de la coincidencia actual.'],
  ['int getCount()', 'Devuelve el número de coincidencias.'],
  ['boolean hasGroup()', 'Comprueba si el patrón tiene grupos de captura.'],
  ['Iterator iterator()', 'Devuelve un iterador sobre las coincidencias.'],
  ['long size()', 'Devuelve el número de coincidencias.'],
  ['boolean asBoolean()', 'Devuelve true si hay alguna coincidencia.'],
  ['static Matcher getLastMatcher()', 'Devuelve el último Matcher usado en el hilo actual.'],
];

const PATTERN: Entry[] = [
  ['boolean isCase(Object switchValue)', 'Comprueba si el valor coincide completamente con el patrón (semántica de switch/grep).'],
  ['Pattern bitwiseNegate()', 'Devuelve el propio patrón.'],
];

const CLASS: Entry[] = [
  ['Object newInstance()', 'Crea una nueva instancia de la clase con el constructor sin argumentos.'],
  ['Object newInstance(Object[] args)', 'Crea una nueva instancia de la clase con los argumentos indicados.'],
  ['MetaClass getMetaClass()', 'Devuelve la MetaClass de la clase.'],
  ['boolean isCase(Object switchValue)', 'Comprueba si el valor es instancia de la clase (semántica de switch/grep).'],
  ['Object mixin(Class categoryClass)', 'Añade los métodos de la clase indicada como mixin.'],
  ['Object asType(Class type)', 'Convierte la clase al tipo indicado (operador as).'],
  ['Object getLocation()', 'Devuelve la ubicación (URL) desde la que se cargó la clase.'],
];

const OPTIONAL: Entry[] = [
  ['boolean asBoolean()', 'Devuelve true si el Optional tiene valor.'],
  ['Object get()', 'Devuelve el valor contenido.'],
];

const ENUM_: Entry[] = [
  ['Self next()', 'Devuelve la siguiente constante del enum (operador ++).'],
  ['Self previous()', 'Devuelve la constante anterior del enum (operador --).'],
];

const ENTRY_: Entry[] = [
  ['boolean asBoolean()', 'Devuelve true si el valor de la entrada es verdadero según Groovy.'],
];

const RAW: Record<string, Entry[]> = {
  'java.lang.Object': OBJECT,
  'java.lang.Iterable': ITERABLE,
  'java.util.Collection': COLLECTION,
  'java.util.List': LIST,
  'java.util.Set': SET,
  'java.util.SortedSet': SORTED_SET,
  'java.util.Deque': DEQUE,
  'java.util.Queue': QUEUE,
  'java.util.Stack': STACK,
  'java.util.Map': MAP,
  'java.util.Map$Entry': ENTRY_,
  'java.util.Iterator': ITERATOR,
  '[]': ARRAY,
  'java.lang.CharSequence': CHAR_SEQUENCE,
  'java.lang.String': STRING,
  'java.lang.StringBuilder': STRING_BUILDER,
  'java.lang.Character': CHARACTER,
  'java.lang.Number': NUMBER,
  'java.lang.Integer': INTEGER,
  'java.lang.Double': FLOATING,
  'java.lang.Float': FLOATING,
  'java.math.BigDecimal': BIG_DECIMAL,
  'java.lang.Boolean': BOOLEAN,
  'java.io.File': FILE,
  'java.nio.file.Path': PATH,
  'java.io.InputStream': INPUT_STREAM,
  'java.io.OutputStream': OUTPUT_STREAM,
  'java.io.Reader': READER,
  'java.io.Writer': WRITER,
  'java.net.URL': URL_,
  'java.lang.Process': PROCESS,
  'java.util.Date': DATE,
  'java.util.regex.Matcher': MATCHER,
  'java.util.regex.Pattern': PATTERN,
  'java.lang.Class': CLASS,
  'java.util.Optional': OPTIONAL,
  'java.lang.Enum': ENUM_,
};

export const GDK_RECEIVERS: string[] = Object.keys(RAW);

const cache = new Map<string, MethodInfo[]>();

/** GDK methods declared for that exact receiver (not inherited — the type system walks the hierarchy). */
export function getGdkMethods(receiver: string): MethodInfo[] {
  let res = cache.get(receiver);
  if (res) return res;
  const raw = RAW[receiver];
  if (!raw) return [];
  res = raw.map(([s, doc, cp]) => sig(receiver, s, doc, cp, 'gdk'));
  cache.set(receiver, res);
  return res;
}

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic Groovy runtime classes
// ---------------------------------------------------------------------------------------------------------------------

interface ClassSpec {
  name: string;
  kind?: ClassKind;
  typeParams?: string[];
  superClass?: string;
  interfaces?: string[];
  doc: string;
  isAbstract?: boolean;
  /** Constructor parameter lists, e.g. '' or 'String text'. */
  ctors?: [string, string][];
  methods: Entry[];
  /** [type name, doc, static?] */
  fields?: [string, string, boolean?][];
}

function buildClass(spec: ClassSpec): ClassInfo {
  const q = spec.name;
  const dot = q.lastIndexOf('.');
  const simple = q.slice(dot + 1).replace(/\$/g, '.');
  const methods = spec.methods.map(([s, doc, cp]) => sig(q, s, doc, cp, 'synthetic'));
  const constructors = (spec.ctors ?? []).map(([params, doc]) => {
    const m = sig(q, `void ${simple.split('.').pop()}(${params})`, doc, undefined, 'synthetic');
    m.isConstructor = true;
    m.returnType = { name: q, args: (spec.typeParams ?? []).map(t => ({ name: t, args: [], dims: 0 })), dims: 0 };
    return m;
  });
  const fields: FieldInfo[] = (spec.fields ?? []).map(([text, doc, isStatic]) => {
    const fm = /^(.*)\s+([A-Za-z_$][\w$]*)$/.exec(text.trim())!;
    return {
      name: fm[2], type: ty(fm[1]), isStatic: !!isStatic, isFinal: !!isStatic, doc, declaringType: q, origin: 'synthetic',
      visibility: 'public',
    };
  });
  const kind = spec.kind ?? 'class';
  return {
    qualifiedName: q,
    simpleName: simple,
    packageName: dot < 0 ? '' : q.slice(0, dot),
    kind,
    typeParams: spec.typeParams ?? [],
    superClass: kind === 'interface' ? undefined : ty(spec.superClass ?? 'Object'),
    interfaces: (spec.interfaces ?? []).map(ty),
    methods,
    fields,
    constructors,
    origin: 'synthetic',
    isAbstract: spec.isAbstract,
    doc: spec.doc,
  };
}

const SPECS: ClassSpec[] = [
  {
    name: 'groovy.lang.Closure',
    typeParams: ['V'],
    interfaces: ['Runnable'],
    isAbstract: true,
    doc: 'Bloque de código Groovy reutilizable que puede recibir parámetros y devolver un valor de tipo V.',
    ctors: [['Object owner', 'Crea una closure con el propietario indicado.'], ['Object owner, Object thisObject', 'Crea una closure con propietario y this.']],
    methods: [
      ['V call()', 'Invoca la closure sin argumentos.'],
      ['V call(Object... args)', 'Invoca la closure con los argumentos indicados.' + ex('def suma = { a, b -> a + b }\nsuma.call(1, 2)')],
      ['V call(Object arguments)', 'Invoca la closure con un argumento.'],
      ['Closure<V> curry(Object... arguments)', 'Fija los primeros parámetros y devuelve una nueva closure con los restantes.' + ex('def doble = mult.curry(2)')],
      ['Closure<V> rcurry(Object... arguments)', 'Fija los últimos parámetros y devuelve una nueva closure.'],
      ['Closure<V> ncurry(int n, Object... arguments)', 'Fija los parámetros a partir de la posición n y devuelve una nueva closure.'],
      ['Closure<V> memoize()', 'Devuelve una closure que cachea los resultados según los argumentos.'],
      ['Closure<V> memoizeAtMost(int maxCacheSize)', 'Devuelve una closure con caché de resultados de tamaño máximo limitado.'],
      ['Closure<V> memoizeAtLeast(int protectedCacheSize)', 'Devuelve una closure con caché que protege al menos ese número de resultados.'],
      ['Closure<V> memoizeBetween(int protectedCacheSize, int maxCacheSize)', 'Devuelve una closure con caché acotada por ambos límites.'],
      ['Closure<V> trampoline(Object... args)', 'Devuelve una versión trampolín de la closure para recursión sin desbordar la pila.'],
      ['Closure<V> trampoline()', 'Devuelve una versión trampolín de la closure.'],
      ['int getMaximumNumberOfParameters()', 'Devuelve el número máximo de parámetros que acepta la closure.'],
      ['Class[] getParameterTypes()', 'Devuelve los tipos de los parámetros de la closure.'],
      ['Object getDelegate()', 'Devuelve el delegate de la closure.'],
      ['void setDelegate(Object delegate)', 'Asigna el delegate usado para resolver propiedades y métodos.'],
      ['Object getOwner()', 'Devuelve el objeto propietario (donde se definió la closure).'],
      ['Object getThisObject()', 'Devuelve el objeto this del contexto donde se definió la closure.'],
      ['int getResolveStrategy()', 'Devuelve la estrategia de resolución (OWNER_FIRST, DELEGATE_FIRST...).'],
      ['void setResolveStrategy(int resolveStrategy)', 'Asigna la estrategia de resolución (OWNER_FIRST, DELEGATE_FIRST...).'],
      ['int getDirective()', 'Devuelve la directiva actual de la closure.'],
      ['void setDirective(int directive)', 'Asigna la directiva de la closure.'],
      ['Closure rightShift(Closure other)', 'Composición: ejecuta esta closure y pasa el resultado a la otra (operador >>).'],
      ['Closure<V> leftShift(Closure other)', 'Composición: ejecuta la otra closure y pasa el resultado a esta (operador <<).'],
      ['V leftShift(Object arg)', 'Invoca la closure con el argumento (operador <<).'],
      ['Closure<V> dehydrate()', 'Devuelve una copia sin owner, delegate ni this (serializable).'],
      ['Closure<V> rehydrate(Object delegate, Object owner, Object thisObject)', 'Devuelve una copia con el delegate, owner y this indicados.'],
      ['Closure<V> asWritable()', 'Devuelve la closure como Writable.'],
      ['boolean isCase(Object candidate)', 'Invoca la closure con el valor y evalúa el resultado (semántica de switch/grep).'],
      ['Object clone()', 'Devuelve una copia de la closure.'],
      ['void run()', 'Ejecuta la closure (implementación de Runnable).'],
      ['Object getProperty(String property)', 'Obtiene una propiedad resolviéndola según la estrategia.'],
      ['void setProperty(String property, Object newValue)', 'Asigna una propiedad resolviéndola según la estrategia.'],
    ],
    fields: [
      ['int OWNER_FIRST', 'Estrategia: resuelve primero en el owner y después en el delegate (por defecto).', true],
      ['int DELEGATE_FIRST', 'Estrategia: resuelve primero en el delegate y después en el owner.', true],
      ['int OWNER_ONLY', 'Estrategia: resuelve solo en el owner.', true],
      ['int DELEGATE_ONLY', 'Estrategia: resuelve solo en el delegate.', true],
      ['int TO_SELF', 'Estrategia: resuelve solo en la propia closure.', true],
      ['int DONE', 'Directiva: detener la iteración.', true],
      ['int SKIP', 'Directiva: saltar el elemento actual.', true],
      ['Closure IDENTITY', 'Closure identidad que devuelve su argumento.', true],
    ],
  },
  {
    name: 'groovy.lang.GString',
    interfaces: ['CharSequence', 'Comparable', 'Writable'],
    isAbstract: true,
    doc: 'Cadena Groovy con interpolación de expresiones ("Hola ${nombre}").',
    methods: [
      ['Object[] getValues()', 'Devuelve los valores interpolados.'],
      ['String[] getStrings()', 'Devuelve los fragmentos de texto fijos.'],
      ['Object getValue(int idx)', 'Devuelve el valor interpolado en la posición indicada.'],
      ['int getValueCount()', 'Devuelve el número de valores interpolados.'],
      ['GString plus(GString that)', 'Concatena con otro GString (operador +).'],
      ['GString plus(String that)', 'Concatena con un String (operador +).'],
      ['String toString()', 'Evalúa el GString y devuelve el String resultante.'],
      ['Writer writeTo(Writer out)', 'Escribe el texto evaluado en el Writer.'],
      ['byte[] getBytes()', 'Devuelve los bytes del texto evaluado.'],
      ['byte[] getBytes(String charset)', 'Devuelve los bytes del texto evaluado con la codificación indicada.'],
      ['int length()', 'Devuelve la longitud del texto evaluado.'],
      ['char charAt(int index)', 'Devuelve el carácter en la posición indicada.'],
      ['CharSequence subSequence(int start, int end)', 'Devuelve la subsecuencia indicada.'],
      ['int compareTo(Object other)', 'Compara el texto evaluado con otro objeto.'],
      ['Pattern negate()', 'Compila el texto como expresión regular.'],
    ],
    fields: [['GString EMPTY', 'GString vacío.', true]],
  },
  {
    name: 'groovy.lang.Range',
    kind: 'interface',
    typeParams: ['T'],
    interfaces: ['List<T>'],
    doc: 'Rango de valores (1..10, \'a\'..\'z\') que se comporta como una lista.',
    methods: [
      ['T getFrom()', 'Devuelve el límite inferior del rango.'],
      ['T getTo()', 'Devuelve el límite superior del rango.'],
      ['boolean isReverse()', 'Indica si el rango es descendente.'],
      ['boolean containsWithinBounds(Object o)', 'Comprueba si el valor está dentro de los límites del rango.'],
      ['void step(int step, Closure closure)', 'Itera sobre el rango con el paso indicado.', T1],
      ['List<T> step(int step)', 'Devuelve los elementos del rango con el paso indicado.'],
      ['String inspect()', 'Devuelve la representación del rango como código Groovy.'],
    ],
  },
  {
    name: 'groovy.lang.IntRange',
    superClass: 'java.util.AbstractList<java.lang.Integer>',
    interfaces: ['Range<Integer>', 'List<Integer>'],
    doc: 'Rango de enteros (1..10, 0..<n).',
    ctors: [['int from, int to', 'Crea un rango de enteros inclusivo.'], ['boolean inclusive, int from, int to', 'Crea un rango de enteros, inclusivo o exclusivo.']],
    methods: [
      ['Integer getFrom()', 'Devuelve el límite inferior del rango.'],
      ['Integer getTo()', 'Devuelve el límite superior del rango.'],
      ['int getFromInt()', 'Devuelve el límite inferior como int.'],
      ['int getToInt()', 'Devuelve el límite superior como int.'],
      ['boolean isReverse()', 'Indica si el rango es descendente.'],
      ['Boolean getInclusive()', 'Indica si el límite superior está incluido.'],
      ['void step(int step, Closure closure)', 'Itera sobre el rango con el paso indicado.', INT1],
      ['List<Integer> step(int step)', 'Devuelve los enteros del rango con el paso indicado.'],
      ['IntRange by(int stepSize)', 'Devuelve un rango con el paso indicado.' + ex('(0..10).by(2)')],
      ['boolean containsWithinBounds(Object o)', 'Comprueba si el valor está dentro de los límites del rango.'],
      ['Integer get(int index)', 'Devuelve el entero en la posición indicada.'],
      ['int size()', 'Devuelve el número de elementos del rango.'],
      ['List<Integer> subList(int fromIndex, int toIndex)', 'Devuelve el subrango indicado.'],
      ['Iterator<Integer> iterator()', 'Devuelve un iterador sobre los enteros del rango.'],
      ['String inspect()', 'Devuelve la representación del rango como código Groovy.'],
    ],
  },
  {
    name: 'groovy.lang.Tuple2',
    typeParams: ['V1', 'V2'],
    interfaces: ['List<Object>'],
    doc: 'Tupla inmutable de dos elementos.',
    ctors: [['V1 v1, V2 v2', 'Crea una tupla con los dos valores.']],
    methods: [
      ['V1 getV1()', 'Devuelve el primer elemento.'],
      ['V2 getV2()', 'Devuelve el segundo elemento.'],
      ['V1 getFirst()', 'Devuelve el primer elemento.'],
      ['V2 getSecond()', 'Devuelve el segundo elemento.'],
      ['Tuple2<V2,V1> swap()', 'Devuelve una tupla con los elementos intercambiados.'],
      ['Object get(int index)', 'Devuelve el elemento en la posición indicada.'],
      ['int size()', 'Devuelve el número de elementos (2).'],
      ['static Tuple2 tuple(Object v1, Object v2)', 'Crea una tupla de dos elementos.'],
    ],
  },
  {
    name: 'groovy.json.JsonSlurper',
    doc: 'Analizador de JSON que convierte texto JSON en mapas y listas.',
    ctors: [['', 'Crea un analizador de JSON.']],
    methods: [
      ['Object parseText(String text)', 'Analiza el texto JSON y devuelve mapas/listas.' + ex("def data = new JsonSlurper().parseText('{\"a\": 1}')")],
      ['Object parse(File file)', 'Analiza el fichero JSON.'],
      ['Object parse(File file, String charset)', 'Analiza el fichero JSON con la codificación indicada.'],
      ['Object parse(Reader reader)', 'Analiza el JSON leído del Reader.'],
      ['Object parse(InputStream inputStream)', 'Analiza el JSON leído del InputStream.'],
      ['Object parse(URL url)', 'Descarga y analiza el JSON de la URL.'],
      ['Object parse(Path path)', 'Analiza el fichero JSON de la ruta.'],
      ['Object parse(char[] text)', 'Analiza el JSON contenido en el array de caracteres.'],
      ['Object parse(byte[] bytes)', 'Analiza el JSON contenido en el array de bytes.'],
      ['groovy.json.JsonParserType getType()', 'Devuelve el tipo de analizador usado.'],
      ['groovy.json.JsonSlurper setType(groovy.json.JsonParserType type)', 'Configura el tipo de analizador (INDEX_OVERLAY, LAX, CHAR_BUFFER...).'],
      ['boolean isLazyChop()', 'Indica si se usa troceado perezoso.'],
      ['groovy.json.JsonSlurper setLazyChop(boolean lazyChop)', 'Configura el troceado perezoso.'],
    ],
  },
  {
    name: 'groovy.json.JsonOutput',
    doc: 'Utilidades estáticas para generar JSON.',
    methods: [
      ['static String toJson(Object object)', 'Serializa el objeto (mapas, listas, beans...) a JSON.' + ex('JsonOutput.toJson([a: 1])')],
      ['static String toJson(String s)', 'Serializa la cadena a JSON.'],
      ['static String toJson(Map m)', 'Serializa el mapa a JSON.'],
      ['static String toJson(Number n)', 'Serializa el número a JSON.'],
      ['static String toJson(Boolean b)', 'Serializa el booleano a JSON.'],
      ['static String toJson(Date date)', 'Serializa la fecha a JSON.'],
      ['static String toJson(Closure closure)', 'Serializa la closure (estilo builder) a JSON.'],
      ['static String prettyPrint(String jsonPayload)', 'Formatea el JSON con sangría para facilitar su lectura.'],
      ['static String prettyPrint(String jsonPayload, boolean disableUnicodeEscaping)', 'Formatea el JSON con sangría, opcionalmente sin escapar Unicode.'],
      ['static groovy.json.JsonOutput$JsonUnescaped unescaped(CharSequence text)', 'Marca el texto para incluirlo sin escapar.'],
    ],
  },
  {
    name: 'groovy.json.JsonBuilder',
    interfaces: ['Writable'],
    doc: 'Constructor de JSON mediante una DSL de closures y mapas.',
    ctors: [['', 'Crea un JsonBuilder vacío.'], ['Object content', 'Crea un JsonBuilder con el contenido inicial.']],
    methods: [
      ['Object call(Map m)', 'Construye un objeto JSON a partir del mapa.'],
      ['Object call(List l)', 'Construye un array JSON a partir de la lista.'],
      ['Object call(Object... args)', 'Construye un array JSON a partir de los argumentos.'],
      ['Object call(Closure c)', 'Construye el JSON usando la closure como DSL.', NONE],
      ['Object call(Iterable coll, Closure c)', 'Construye un array JSON aplicando la closure a cada elemento.', O1],
      ['Object getContent()', 'Devuelve el contenido construido (mapas/listas).'],
      ['String toPrettyString()', 'Devuelve el JSON formateado con sangría.'],
      ['String toString()', 'Devuelve el JSON generado.'],
      ['Writer writeTo(Writer out)', 'Escribe el JSON en el Writer.'],
      ['Object invokeMethod(String name, Object args)', 'Crea un nodo JSON con el nombre del método (DSL).'],
    ],
  },
  {
    name: 'groovy.xml.XmlSlurper',
    doc: 'Analizador de XML que devuelve un GPathResult navegable con notación de puntos.',
    ctors: [['', 'Crea un XmlSlurper.'], ['boolean validating, boolean namespaceAware', 'Crea un XmlSlurper configurando validación y espacios de nombres.']],
    methods: [
      ['GPathResult parseText(String text)', 'Analiza el texto XML.' + ex("def xml = new XmlSlurper().parseText('<a><b>1</b></a>')\nxml.b.text()")],
      ['GPathResult parse(File file)', 'Analiza el fichero XML.'],
      ['GPathResult parse(Reader reader)', 'Analiza el XML leído del Reader.'],
      ['GPathResult parse(InputStream input)', 'Analiza el XML leído del InputStream.'],
      ['GPathResult parse(String uri)', 'Analiza el XML de la URI indicada.'],
      ['GPathResult parse(Path path)', 'Analiza el fichero XML de la ruta.'],
      ['void setKeepIgnorableWhitespace(boolean keep)', 'Configura si se conservan los espacios ignorables.'],
      ['void setFeature(String uri, boolean value)', 'Configura una característica del analizador SAX.'],
    ],
  },
  {
    name: 'groovy.xml.XmlParser',
    doc: 'Analizador de XML que devuelve un árbol de nodos Node modificable.',
    ctors: [['', 'Crea un XmlParser.'], ['boolean validating, boolean namespaceAware', 'Crea un XmlParser configurando validación y espacios de nombres.']],
    methods: [
      ['Node parseText(String text)', 'Analiza el texto XML.'],
      ['Node parse(File file)', 'Analiza el fichero XML.'],
      ['Node parse(Reader reader)', 'Analiza el XML leído del Reader.'],
      ['Node parse(InputStream input)', 'Analiza el XML leído del InputStream.'],
      ['Node parse(String uri)', 'Analiza el XML de la URI indicada.'],
      ['void setTrimWhitespace(boolean trim)', 'Configura si se recortan los espacios del texto.'],
    ],
  },
  {
    name: 'groovy.xml.slurpersupport.GPathResult',
    interfaces: ['Writable', 'Iterable<Object>'],
    isAbstract: true,
    doc: 'Resultado navegable de XmlSlurper (expresiones GPath).',
    methods: [
      ['String text()', 'Devuelve el texto contenido en los nodos.'],
      ['String name()', 'Devuelve el nombre del nodo.'],
      ['GPathResult children()', 'Devuelve los hijos del nodo.'],
      ['GPathResult parent()', 'Devuelve el nodo padre.'],
      ['GPathResult attributes()', 'Devuelve los atributos del nodo.'],
      ['Object getAt(int index)', 'Devuelve el nodo en la posición indicada.'],
      ['int size()', 'Devuelve el número de nodos.'],
      ['boolean isEmpty()', 'Indica si el resultado no contiene nodos.'],
      ['GPathResult find(Closure closure)', 'Devuelve el primer nodo que cumple la condición.', { 0: ['GPathResult'], 1: ['GPathResult'] }],
      ['GPathResult findAll(Closure closure)', 'Devuelve los nodos que cumplen la condición.', { 0: ['GPathResult'], 1: ['GPathResult'] }],
      ['Iterator depthFirst()', 'Recorre los nodos en profundidad.'],
      ['Iterator breadthFirst()', 'Recorre los nodos en anchura.'],
      ['Iterator iterator()', 'Devuelve un iterador sobre los nodos.'],
      ['List<Object> list()', 'Devuelve los nodos como lista.'],
      ['Integer toInteger()', 'Convierte el texto del nodo a Integer.'],
      ['Long toLong()', 'Convierte el texto del nodo a Long.'],
      ['Double toDouble()', 'Convierte el texto del nodo a Double.'],
      ['BigDecimal toBigDecimal()', 'Convierte el texto del nodo a BigDecimal.'],
      ['Boolean toBoolean()', 'Convierte el texto del nodo a Boolean.'],
      ['Object getProperty(String property)', 'Navega al hijo o atributo (@nombre) indicado.'],
      ['GPathResult declareNamespace(Map newNamespaceMapping)', 'Declara prefijos de espacios de nombres.'],
    ],
  },
  {
    name: 'groovy.util.Node',
    doc: 'Nodo de un árbol genérico (resultado de XmlParser).',
    ctors: [['Node parent, Object name', 'Crea un nodo hijo con el nombre indicado.']],
    methods: [
      ['Object name()', 'Devuelve el nombre del nodo.'],
      ['String text()', 'Devuelve el texto contenido en el nodo.'],
      ['Node parent()', 'Devuelve el nodo padre.'],
      ['List children()', 'Devuelve los hijos del nodo.'],
      ['Map attributes()', 'Devuelve los atributos del nodo.'],
      ['Object attribute(Object key)', 'Devuelve el valor del atributo indicado.'],
      ['Object value()', 'Devuelve el valor del nodo.'],
      ['void setValue(Object value)', 'Asigna el valor del nodo.'],
      ['Node appendNode(Object name)', 'Añade un nodo hijo con el nombre indicado.'],
      ['Node appendNode(Object name, Map attributes)', 'Añade un nodo hijo con nombre y atributos.'],
      ['Node appendNode(Object name, Object value)', 'Añade un nodo hijo con nombre y valor.'],
      ['boolean remove(Node child)', 'Elimina el nodo hijo indicado.'],
      ['Object replaceNode(Closure c)', 'Reemplaza este nodo por los construidos en la closure.', NONE],
      ['NodeList depthFirst()', 'Devuelve los nodos en recorrido en profundidad.'],
      ['List breadthFirst()', 'Devuelve los nodos en recorrido en anchura.'],
      ['Object get(String key)', 'Devuelve los hijos con el nombre indicado.'],
      ['Iterator iterator()', 'Devuelve un iterador sobre los hijos.'],
    ],
  },
  {
    name: 'groovy.util.NodeList',
    superClass: 'java.util.ArrayList<java.lang.Object>',
    doc: 'Lista de nodos Node con navegación GPath.',
    methods: [
      ['String text()', 'Devuelve el texto concatenado de todos los nodos.'],
      ['Object getAt(String name)', 'Devuelve los hijos con el nombre indicado.'],
    ],
  },
  {
    name: 'groovy.lang.Script',
    isAbstract: true,
    doc: 'Clase base de los scripts Groovy.',
    methods: [
      ['Object run()', 'Ejecuta el cuerpo del script.'],
      ['Binding getBinding()', 'Devuelve el Binding con las variables del script.'],
      ['void setBinding(Binding binding)', 'Asigna el Binding del script.'],
      ['void println()', 'Imprime un salto de línea.'],
      ['void println(Object value)', 'Imprime el valor seguido de un salto de línea.'],
      ['void print(Object value)', 'Imprime el valor sin salto de línea.'],
      ['void printf(String format, Object... values)', 'Imprime una cadena formateada.'],
      ['Object evaluate(String expression)', 'Evalúa la expresión Groovy indicada.'],
      ['Object evaluate(File file)', 'Evalúa el script Groovy del fichero.'],
      ['void run(File file, String[] arguments)', 'Ejecuta el script del fichero con los argumentos indicados.'],
      ['Object getProperty(String property)', 'Obtiene una variable del binding o una propiedad.'],
      ['void setProperty(String property, Object newValue)', 'Asigna una variable del binding o una propiedad.'],
      ['Object invokeMethod(String name, Object args)', 'Invoca un método o una closure del binding.'],
    ],
  },
  {
    name: 'groovy.lang.Binding',
    doc: 'Conjunto de variables compartidas con un script.',
    ctors: [['', 'Crea un Binding vacío.'], ['Map variables', 'Crea un Binding con las variables indicadas.'], ['String[] args', 'Crea un Binding con los argumentos del script.']],
    methods: [
      ['Object getVariable(String name)', 'Devuelve el valor de la variable indicada.'],
      ['void setVariable(String name, Object value)', 'Asigna el valor de la variable indicada.'],
      ['boolean hasVariable(String name)', 'Comprueba si existe la variable indicada.'],
      ['void removeVariable(String name)', 'Elimina la variable indicada.'],
      ['Map getVariables()', 'Devuelve el mapa con todas las variables.'],
      ['Object getProperty(String property)', 'Obtiene la variable indicada.'],
      ['void setProperty(String property, Object newValue)', 'Asigna la variable indicada.'],
    ],
  },
  {
    name: 'groovy.lang.MetaClass',
    kind: 'interface',
    doc: 'Metaclase de Groovy: describe y permite modificar el comportamiento dinámico de una clase.',
    methods: [
      ['Object invokeMethod(Object object, String methodName, Object[] arguments)', 'Invoca dinámicamente un método sobre el objeto.'],
      ['Object getProperty(Object object, String property)', 'Obtiene dinámicamente una propiedad del objeto.'],
      ['void setProperty(Object object, String property, Object newValue)', 'Asigna dinámicamente una propiedad del objeto.'],
      ['List<MetaMethod> respondsTo(Object obj, String name)', 'Devuelve los métodos con ese nombre a los que responde el objeto.'],
      ['MetaProperty hasProperty(Object obj, String name)', 'Devuelve la propiedad indicada si existe.'],
      ['List<MetaMethod> getMethods()', 'Devuelve los métodos de la clase.'],
      ['List<MetaMethod> getMetaMethods()', 'Devuelve los metamétodos añadidos (GDK, categorías...).'],
      ['List<MetaProperty> getProperties()', 'Devuelve las propiedades de la clase.'],
      ['MetaMethod getMetaMethod(String name, Object[] args)', 'Busca el método con el nombre y argumentos indicados.'],
      ['MetaProperty getMetaProperty(String name)', 'Devuelve la propiedad con el nombre indicado.'],
      ['Class getTheClass()', 'Devuelve la clase descrita por esta metaclase.'],
      ['void initialize()', 'Inicializa la metaclase.'],
    ],
  },
  {
    name: 'groovy.lang.Writable',
    kind: 'interface',
    doc: 'Objeto que sabe escribirse en un Writer.',
    methods: [['Writer writeTo(Writer out)', 'Escribe el contenido en el Writer.']],
  },
  {
    name: 'groovy.lang.MetaProperty',
    isAbstract: true,
    doc: 'Descripción de una propiedad en el sistema de metaprogramación.',
    methods: [
      ['String getName()', 'Devuelve el nombre de la propiedad.'],
      ['Class getType()', 'Devuelve el tipo de la propiedad.'],
      ['Object getProperty(Object object)', 'Obtiene el valor de la propiedad en el objeto.'],
      ['void setProperty(Object object, Object newValue)', 'Asigna el valor de la propiedad en el objeto.'],
    ],
  },
  {
    name: 'groovy.lang.MetaMethod',
    isAbstract: true,
    doc: 'Descripción de un método en el sistema de metaprogramación.',
    methods: [
      ['String getName()', 'Devuelve el nombre del método.'],
      ['Class getReturnType()', 'Devuelve el tipo de retorno del método.'],
      ['Object invoke(Object object, Object[] arguments)', 'Invoca el método sobre el objeto.'],
      ['boolean isStatic()', 'Indica si el método es estático.'],
    ],
  },
  {
    name: 'groovy.lang.PropertyValue',
    doc: 'Par propiedad/valor devuelto por getMetaPropertyValues().',
    methods: [
      ['String getName()', 'Devuelve el nombre de la propiedad.'],
      ['Class getType()', 'Devuelve el tipo de la propiedad.'],
      ['Object getValue()', 'Devuelve el valor de la propiedad.'],
      ['void setValue(Object value)', 'Asigna el valor de la propiedad.'],
    ],
  },
  {
    name: 'groovy.lang.SpreadMap',
    superClass: 'java.util.HashMap',
    doc: 'Mapa que puede expandirse como argumentos con nombre (*:mapa).',
    methods: [['boolean equals(SpreadMap that)', 'Compara dos SpreadMap.']],
  },
  {
    name: 'groovy.io.FileType',
    kind: 'enum',
    superClass: 'java.lang.Enum<groovy.io.FileType>',
    doc: 'Tipo de entrada del sistema de ficheros para eachFile/traverse.',
    methods: [],
    fields: [
      ['groovy.io.FileType FILES', 'Solo ficheros.', true],
      ['groovy.io.FileType DIRECTORIES', 'Solo directorios.', true],
      ['groovy.io.FileType ANY', 'Ficheros y directorios.', true],
    ],
  },
];

export const SYNTHETIC_CLASSES: ClassInfo[] = SPECS.map(buildClass);
for (const c of SYNTHETIC_CLASSES) {
  if (c.kind === 'enum') for (const f of c.fields) f.isEnumConstant = true;
}

const SYNTH_BY_NAME = new Map(SYNTHETIC_CLASSES.map(c => [c.qualifiedName, c]));

export function getSyntheticClass(qname: string): ClassInfo | undefined {
  return SYNTH_BY_NAME.get(qname);
}
