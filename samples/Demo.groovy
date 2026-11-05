// Demo de Groovy IntelliSense: coloca el cursor tras cada "." y pulsa Ctrl+Espacio.
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.stream.Collectors

// ---- Strings ----------------------------------------------------------------
def saludo = 'Hola, mundo'
// Escribe "saludo." aquí para ver los métodos de String (y los del GDK, como capitalize o tokenize)
println saludo.toUpperCase()
def nombre = "Groovy ${saludo.length()}"   // GString
println nombre.reverse()

// ---- Listas y closures con "it" -------------------------------------------------
def numeros = [5, 3, 8, 1]
// Dentro del closure "it" es un Integer: escribe "it." para verlo
def dobles = numeros.collect { it * 2 }
numeros.each { println it.toString().padLeft(4) }
def pares = numeros.findAll { it % 2 == 0 }.sort()
println numeros.sum() + pares.size()

// Cadena de llamadas: el tipo se infiere en cada paso (List<String> -> String)
def palabras = ['manzana', 'pera', 'kiwi']
def resumen = palabras.collect { it.toUpperCase() }.findAll { it.length() > 4 }.join(', ')
println resumen

// ---- Mapas ------------------------------------------------------------------------
def edades = [ana: 31, luis: 27]
// En Map.each con dos parámetros, k es String y v es Integer
edades.each { k, v -> println "${k.capitalize()} tiene ${v.intValue()} años" }
edades.entrySet().each { e -> println e.key }

// ---- java.time ----------------------------------------------------------------------
def hoy = LocalDate.now()
// Escribe "hoy." para ver plusDays, getDayOfWeek...
def manana = hoy.plusDays(1)
println manana.format(DateTimeFormatter.ISO_DATE)

// ---- Streams con closures ---------------------------------------------------------------
def largos = palabras.stream()
    .filter { it.length() > 4 }
    .map { it.toUpperCase() }
    .collect(Collectors.toList())
println largos

// ---- Ficheros ------------------------------------------------------------------------
def fichero = new File('notas.txt')
if (fichero.exists()) {
  // eachLine es un método del GDK sobre File; "linea" es un String
  fichero.eachLine { linea -> println linea.trim() }
  println fichero.text.readLines().size()
}

// ---- Ayuda de firmas --------------------------------------------------------------------
// Escribe "saludo.substring(" para ver las sobrecargas y sus parámetros
def parte = saludo.substring(0, 4)

// ---- Auto-import --------------------------------------------------------------------------
// Escribe "Concurrent" y elige ConcurrentHashMap: se añadirá el import automáticamente
