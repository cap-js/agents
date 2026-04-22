using sap.capire.flights as x from '../db/schema';

/**
 * Master data service providing flight-related data, e.g. Flights, Airlines,
 * Airports, and Supplements (e.g. extra luggage, meals, etc.). 
 * Served as SAP data product, and protocols supported by CAP. 
 */
@data.product @hcql @rest @odata @graphql @mcp
service sap.capire.flights.data {

  // Serve Flights data via denormalized view with flattened FlightConnections
  @readonly entity Flights as select from x.Flights left join x.FlightConnections on ID = flight.ID {
    key ID, key date, *
  } excluding { flight, createdAt, createdBy, modifiedBy } // as flight details are flattened

  // Serve Airlines with redirected association to Flights view
  @readonly entity Airlines as projection on x.Airlines { *,
    flights : redirected to Flights
  } excluding { createdAt, createdBy, modifiedBy };

  // Serve Airports with redirected associations to Flights view
  @readonly entity Airports as projection on x.Airports { *,
    departures : redirected to Flights,
    arrivals   : redirected to Flights
  } excluding { createdAt, createdBy, modifiedBy };

  // Serve Supplements data as is
  @readonly entity Supplements as projection on x.Supplements
  excluding { createdAt, createdBy, modifiedBy };

  // Custom actions and events to sync with consumers about flight seat availability
  action BookingCreated ( flight: Flights:ID, date: Flights:date, seats: array of Integer);
  action BookingDeleted ( flight: Flights:ID, date: Flights:date, seats: array of Integer);
  event FlightsUpdated  { flight: Flights:ID; date: Flights:date; free_seats: Integer; }

  // Flight bookings — records of booked flights
  entity FlightBookings as projection on x.FlightBookings
  excluding { createdAt, createdBy, modifiedBy };

  /** Book a flight for a passenger on a specific date */
  @description: 'Book a flight for a passenger'
  action bookFlight(
    @description: 'Flight connection ID (e.g. SW0001)' flight : String,
    @description: 'Flight date (YYYY-MM-DD)' date : Date,
    @description: 'Passenger name' passenger : String,
    @description: 'Number of seats to book' seats : Integer
  ) returns FlightBookings;

  /** Cancel a flight booking */
  @description: 'Cancel a flight booking'
  action cancelFlight(
    @description: 'Booking ID to cancel' bookingId : UUID
  ) returns FlightBookings;
}





//////////////////////////////////////////////////////////////////////////////////////////////////
//
//  Workarounds for @cds.autoexpose kicking in too eagerly ...
//
//  - cds.autoexpose should only apply to UI/Fiori backend services, not API services
//  - cds.autoexpose should be supported on individual assocs, not only targets
//  - associations to stay in models for non-exposed targets -> currently skipped by 4odata
//
    annotate sap.common.Currencies with @cds.autoexpose:false;
    annotate sap.common.Countries with @cds.autoexpose:false;
    annotate sap.common.Languages with @cds.autoexpose:false;
//
//////////////////////////////////////////////////////////////////////////////////////////////////
