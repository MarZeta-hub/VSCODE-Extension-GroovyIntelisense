package model

/**
 * Persona de ejemplo con propiedades Groovy (getters/setters implícitos).
 */
class Person {
  String name
  int age
  Status status = Status.ACTIVE
  List<String> tags = []
  Address address

  enum Status {
    ACTIVE, INACTIVE, BANNED
  }

  /** Crea una persona adulta con el nombre indicado. */
  static Person adult(String name) {
    new Person(name: name, age: 18)
  }

  /** Devuelve el nombre en mayúsculas. */
  String displayName() {
    name.toUpperCase()
  }

  boolean isAdult() {
    age >= 18
  }

  void addTag(String tag) {
    tags << tag
  }
}

class Address {
  String street
  String city
}
