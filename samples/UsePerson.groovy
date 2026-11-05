import model.Person

def p = new Person(name: 'Ana')
// Escribe "p." aquí para ver las propiedades (name, age, status...) y los métodos
println p.displayName()

// Las propiedades encadenadas también se infieren: "p.address." muestra street y city
println p.address?.city

// Método estático de fábrica: escribe "Person." para verlo
def adulto = Person.adult('Luis')
println adulto.isAdult()

// Enum anidado: escribe "Person.Status." para ver sus constantes
if (adulto.status == Person.Status.ACTIVE) {
  adulto.addTag('vip')
}

// Closures sobre List<String>: "it" es un String
adulto.tags.each { println it.toUpperCase() }

// Lista de personas: en el closure, "it" es un Person
def personas = [p, adulto]
def nombres = personas.collect { it.name }
println nombres.join(', ')

// Ctrl+clic sobre "Person" o "displayName" para ir a la definición
