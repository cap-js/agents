using { Currency, Country, cuid, managed, sap.common.CodeList } from '@sap/cds/common';

namespace sap.capire.flights;

/**
 * A scheduled flight on a specific date with a specific aircraft and price.
 */
entity Flights : managed {
  key flight     : Association to FlightConnections;
  key date       : Date;
  aircraft       : String;
  price          : Decimal(9,4);
  currency       : Currency;
  maximum_seats  : Integer;
  occupied_seats : Integer; // partly transactional
  free_seats     : Integer = maximum_seats - occupied_seats; 
}

/**
 * A flight connection between two airports operated by an airline.
 */
entity FlightConnections {
  key ID      : String(11); // e.g. LH4711
  airline     : Association to Airlines;
  origin      : Association to Airports;
  destination : Association to Airports;
  departure   : Time;
  arrival     : Time;
  distance    : Integer; // in kilometers
}

entity Airlines : cuid, managed {
  name     : String;
  icon     : String;
  currency : Currency;
  flights  : Association to many FlightConnections on flights.airline = $self;
}

entity Airports : cuid, managed {
  name    : String;
  city    : String;
  country : Country;
  arrivals : Association to many FlightConnections on arrivals.destination = $self;
  departures : Association to many FlightConnections on departures.origin = $self;
}

entity Supplements : cuid, managed {
  type     : Association to SupplementTypes;
  descr    : localized String(1111);
  price    : Decimal(9,4);
  currency : Currency;
}

entity SupplementTypes : CodeList {
  key code : String(2) enum {
    Beverage = 'BV';
    Meal = 'ML';
    Luggage = 'LU';
    Extra = 'EX';
  }
}

/**
 * A flight booking for a passenger on a specific flight and date.
 */
entity FlightBookings : cuid, managed {
  @description: 'Reference to the booked flight connection'
  flight          : Association to FlightConnections;

  @description: 'Date of the flight (YYYY-MM-DD)'
  date            : Date;

  @description: 'Passenger name'
  passenger       : String(200);

  @description: 'Number of seats booked'
  seats           : Integer default 1;

  @description: 'Booking status'
  status          : String enum { confirmed; cancelled } default 'confirmed';

  @description: 'Total price for the booking'
  totalPrice      : Decimal(9,4);

  @description: 'Currency code'
  currency        : Currency;
}
