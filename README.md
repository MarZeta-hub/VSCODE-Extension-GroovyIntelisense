# Groovy IntelliSense

Autocompletado inteligente para **Groovy** en VS Code, al estilo de IntelliJ IDEA: inferencia de tipos, miembros del
JDK y del classpath, métodos GDK, auto-import, ayuda de firmas, hover e ir a definición. Sin servidor de lenguaje
externo ni dependencias de npm: solo necesita un JDK.

## Características

- **Completado de miembros tras `.`** con inferencia de tipos: variables `def`, asignaciones, valores de retorno,
  cadenas de llamadas (`lista.collect { ... }.findAll { ... }.`), operador safe-navigation `?.` y spread `*.`.
- **Genéricos**: `List<String>`, `Map<String, Integer>`, `Optional<T>`, streams...; los tipos se propagan por los
  métodos (`map.entrySet().first().key`).
- **`it` y parámetros de closures** tipados: `lista.each { it. }`, `mapa.each { k, v -> }`, `stream().map { it. }`.
- **Métodos GDK** (`each`, `collect`, `findAll`, `inject`, `groupBy`, `eachLine`, `text`...) junto a los de Java.
- **Clases del JDK y del classpath** leídas con `javap`, con **nombres de parámetros y Javadoc** extraídos de
  `src.zip` del JDK cuando está disponible.
- **Completado de clases con auto-import**: al aceptar una clase no importada se añade su `import`.
- **Referencias a métodos** con `::`, anotaciones tras `@`.
- **Ayuda de firmas** (`(` y `,`) con sobrecargas y parámetro activo.
- **Hover** con el tipo inferido y la documentación.
- **Ir a definición** (F12 / Ctrl+clic) para clases, métodos, propiedades y variables del workspace.
- **Índice del workspace**: clases Groovy y Java de tus proyectos, actualizado al editar y al cambiar ficheros en disco.
- Funciona en `.groovy`, `.gvy`, `.gy`, `.gsh`, scripts de Gradle y `Jenkinsfile`.

## Requisitos

- **JDK 8 o superior** con `javap` (un JRE no basta). Se recomienda **JDK 11+** (incluye `src.zip` con el Javadoc).
- El JDK se busca en `groovyIntellisense.javaHome`, después en `JAVA_HOME` y por último en el `PATH`.

## Proyectos Maven

Si el workspace contiene `pom.xml`, las librerías del proyecto se añaden solas al autocompletado; no hace falta
configurar el classpath. Hay dos modos (`groovyIntellisense.maven.resolver`):

- **`pom`** (por defecto): lee los `pom.xml` (proyectos multimódulo, POM padre, `<properties>`,
  `<dependencyManagement>`, BOMs con `scope=import`, perfiles `activeByDefault`). Después resuelve las dependencias
  transitivas contra el repositorio local (`~/.m2/repository` o el `<localRepository>` de `settings.xml`) con las reglas de
  Maven: gana la más cercana, se ignoran las `optional` y las `test`/`provided` transitivas, se respetan `<exclusions>` y los
  rangos de versión. No necesita Maven instalado, pero sí que los jars estén descargados: compila el proyecto una vez
  (`mvn dependency:resolve`, o desde IntelliJ). Los artefactos que falten se listan en el canal de salida.
- **`mvn`**: ejecuta `mvn dependency:build-classpath` (usa `./mvnw` si existe, o `groovyIntellisense.maven.executable`). Es
  exacto e incluye todo lo que Maven calcularía. Es más lento la primera vez y el resultado se cachea según el contenido de
  los `pom.xml`. Si falla, se pasa al modo `pom`.

Las dependencias se recalculan solas al guardar un `pom.xml`, o con el comando **Recargar dependencias**. Los jars
`-sources.jar` descargados en `~/.m2` (por ejemplo con `mvn dependency:sources`) aportan nombres de parámetros y Javadoc
reales.

## Configuración

| Ajuste | Por defecto | Descripción |
| --- | --- | --- |
| `groovyIntellisense.javaHome` | `""` | Ruta del JDK. Vacío: `JAVA_HOME` / `PATH`. |
| `groovyIntellisense.classpath` | `[]` | Jars o directorios extra; rutas absolutas o relativas a cada carpeta del workspace, con globs (`lib/*.jar`, `libs/**/*.jar`, `build/classes/groovy/main`). Admite `${workspaceFolder}`, `${env:VAR}` y `~`. |
| `groovyIntellisense.autoDetectGradleCache` | `false` | Experimental: añade los jars de la caché de Gradle para las dependencias `grupo:nombre:versión` de `build.gradle` (sin transitivas). |
| `groovyIntellisense.maven.resolver` | `pom` | `pom` (lee pom.xml + `~/.m2`), `mvn` (ejecuta Maven) u `off`. |
| `groovyIntellisense.maven.localRepository` | `""` | Repositorio local de Maven. Vacío: `settings.xml` o `~/.m2/repository`. |
| `groovyIntellisense.maven.settingsFile` | `""` | `settings.xml` propio (como `mvn -s`). Vacío: el `-s` de `.mvn/maven.config` o `~/.m2/settings.xml`. |
| `groovyIntellisense.maven.executable` | `""` | Maven para el modo `mvn`. Vacío: `./mvnw` o `mvn` del `PATH`. |
| `groovyIntellisense.indexInclude` | `**/*.{groovy,gvy,gy,gsh,java,gradle}` | Archivos del workspace que se indexan. |
| `groovyIntellisense.indexExclude` | `**/{node_modules,build,out,target,.git,.gradle}/**` | Archivos excluidos del índice. |
| `groovyIntellisense.maxIndexedFiles` | `5000` | Máximo de archivos indexados. |
| `groovyIntellisense.autoImport` | `true` | Añadir `import` automáticamente al completar clases. |
| `groovyIntellisense.trace` | `false` | Registro detallado en el canal de salida *Groovy IntelliSense*. |

Al cambiar cualquier ajuste el motor se reinicia y el workspace se reindexa.

## Comandos

- **Groovy IntelliSense: Reindexar workspace** (`groovyIntellisense.reindex`)
- **Groovy IntelliSense: Limpiar caché de clases** (`groovyIntellisense.clearCache`)
- **Groovy IntelliSense: Recargar dependencias (Maven/classpath)** (`groovyIntellisense.reloadDependencies`)
- **Groovy IntelliSense: Mostrar estado** (`groovyIntellisense.showStatus`) — también al hacer clic en el elemento
  `Groovy` de la barra de estado.

## Desarrollo

```bash
npm install
npm run compile      # o: npm run watch
```

Pulsa **F5** (configuración *Run Extension*): se abre una ventana de VS Code con la carpeta `samples/`, que contiene
ejemplos (`Demo.groovy`, `UsePerson.groovy`, `model/Person.groovy`) con comentarios sobre qué probar.

Tests del motor: `npm test`.

## Empaquetar e instalar

```bash
npx @vscode/vsce package
code --install-extension groovy-intellisense-0.1.0.vsix
```

O desde VS Code: *Extensiones → ... → Instalar desde VSIX*.

## Arquitectura

El motor (`src/core`) no depende de `vscode` y se puede probar con `node --test`:

| Módulo | Función |
| --- | --- |
| `core/api.ts`, `core/model.ts` | API pública del motor (`LanguageEngine`) y modelo de datos compartido. |
| `core/tokenizer.ts` | Tokenizador tolerante de Groovy (GStrings, slashy strings, comentarios). |
| `core/sourceParser.ts` | Parser ligero: paquete, imports, clases, miembros, variables locales y closures. |
| `core/javaClassProvider.ts` | Clases del JDK/classpath vía `javap`, nombres de parámetros y Javadoc desde `src.zip`, caché en disco. |
| `core/gdk.ts` | Tabla de métodos GDK con los tipos de los parámetros de los closures. |
| `core/typeSystem.ts` | Resolución de tipos, jerarquías, sustitución de genéricos y miembros. |
| `core/inference.ts` | Inferencia de tipos de expresiones, variables y `it`. |
| `core/completion.ts` | Generación de candidatos, firmas, hover y definiciones. |
| `core/services.ts` | `GroovyServices`: fachada que implementa `LanguageEngine` e índice del workspace. |

La capa de VS Code está en `src/extension.ts` (ciclo de vida, índice, watchers, barra de estado, comandos),
`src/config.ts` (ajustes y expansión del classpath), `src/maven.ts` (resolución de dependencias Maven) y `src/providers/` (completado, firmas, hover, definición).

## Limitaciones

- No es un compilador: la inferencia es heurística y puede fallar con código muy dinámico (metaprogramación,
  `methodMissing`, DSLs con delegados no estándar, categorías).
- No hay diagnósticos (errores de compilación), refactorizaciones ni búsqueda de referencias.
- Las dependencias de Gradle no se resuelven automáticamente: añádelas en `groovyIntellisense.classpath`
  (la detección de la caché de Gradle es experimental y no incluye dependencias transitivas). Maven sí está soportado.
- En modo `pom`, los perfiles activados por propiedades, sistema operativo o JDK no se evalúan; para esos casos usa el
  modo `mvn`.
- Ir a definición solo funciona para código fuente del workspace (no para clases de jars).
- La primera consulta de una clase del JDK ejecuta `javap` y puede tardar un poco; después se cachea en disco.
