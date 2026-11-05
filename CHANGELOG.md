# Changelog

## 0.1.1

- Nuevo ajuste `groovyIntellisense.maven.settingsFile` para usar un `settings.xml` propio (como `mvn -s`): se usa para el `<localRepository>` y, en el modo `mvn`, se pasa a Maven.
- Si no se configura, se respeta el `-s`/`--settings` declarado en `.mvn/maven.config` del proyecto.

## 0.1.0

- Primera versión.
- Completado de miembros con inferencia de tipos, genéricos e `it` en closures.
- Métodos GDK y clases del JDK/classpath vía `javap` (nombres de parámetros y Javadoc desde `src.zip`).
- Completado de clases con auto-import, referencias a métodos (`::`) y anotaciones.
- Ayuda de firmas, hover e ir a definición.
- Índice del workspace con actualización incremental.
- Comandos: reindexar workspace, limpiar caché de clases y mostrar estado.
