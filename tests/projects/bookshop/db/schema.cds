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
      books        : Association to many Books
                       on books.author = $self;
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
