using {
  Currency,
  managed,
  sap
} from '@sap/cds/common';

namespace sap.capire.bookshop;

entity Books : managed {
  key ID       : Integer;
      title    : localized String(111)  @mandatory;
      descr    : localized String(1111);
      author   : Association to Authors @mandatory;
      genre    : Association to Genres;
      stock    : Integer;
      price    : Decimal;
      currency : Currency;
}

@Core.Description: ''
@Core.LongDescription : ''
entity Authors : managed {
  key ID           : Integer;
      @PersonalData.IsPotentiallyPersonal
      name         : String(111) @mandatory;
      @PersonalData.IsPotentiallySensitive
      dateOfBirth  : Date;
      dateOfDeath  : Date;
      @PersonalData.IsPotentiallyPersonal
      placeOfBirth : String;
      @PersonalData.IsPotentiallyPersonal
      @Common.Masked: false
      placeOfDeath : String;
      contact      : Association to AuthorContacts;
      books        : Association to many Books
                       on books.author = $self;
}

/**
 * Contact details for an Author — used to provide a PII-bearing target
 * reachable via two-level expand (Books → author → contact).
 */
entity AuthorContacts {
  key author    : Association to Authors;
      @PersonalData.IsPotentiallyPersonal
      email     : String(255);
      @PersonalData.IsPotentiallyPersonal
      phone     : String(50);
}

/** Hierarchically organized Code List for Genres */
entity Genres : sap.common.CodeList {
  key ID       : Integer;
      parent   : Association to Genres;
      children : Composition of many Genres
                   on children.parent = $self;
}

/**
 * Customers with a numeric FK to Authors (favoriteAuthor_ID).
 * Used to test that numeric foreign-key properties are pseudonymized
 * (shouldHash returns true for Integer when key=true or @odata.foreignKey4).
 */
entity Customers {
  @PersonalData.IsPotentiallyPersonal
  key ID               : Integer;
      @PersonalData.IsPotentiallyPersonal
      name             : String(111);
      @PersonalData.IsPotentiallyPersonal
      favoriteAuthor   : Association to Authors;
}

/** Named structured type reused as an entity property (complexType within complexType). */
type Address {
  @PersonalData.IsPotentiallyPersonal
  street  : String;
  city    : String;
  geo     : {
    @PersonalData.IsPotentiallyPersonal
    lat : String;
    lng : String;
  };
  region  : Region;
}

/** Named type nested inside another named type (Address.region : Region). */
type Region {
  @PersonalData.IsPotentiallyPersonal
  district : String;
  code     : String;
}

/**
 * Profiles exercise query pseudonymization over complex/arrayed element types:
 *   - address       : named complex type (struct within struct)
 *   - nicknames     : many String  (arrayed scalar)
 *   - pastCities    : array of String (arrayed scalar)
 *   - contacts      : arrayed struct
 */
entity Profiles {
  key ID         : Integer;
      @PersonalData.IsPotentiallyPersonal
      name       : String(111);
      address    : Address;
      @PersonalData.IsPotentiallyPersonal
      nicknames  : many String;
      @PersonalData.IsPotentiallyPersonal
      pastCities : array of String;
      contacts   : array of {
        @PersonalData.IsPotentiallyPersonal
        email : String;
        label : String;
      };
}
