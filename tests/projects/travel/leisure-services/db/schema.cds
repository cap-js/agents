namespace travel.leisure;

using { cuid, managed } from '@sap/cds/common';

// ── Hotels ───────────────────────────────────────────────────────────

/** Hotels available for booking */
entity Hotels : cuid {
  /** Hotel name */
  name            : String(200);

  /** City where the hotel is located */
  city            : String(100);

  /** Country where the hotel is located */
  country         : String(100);

  /** Star rating (1-5) */
  stars           : Integer;

  /** Price per night in USD */
  pricePerNight   : Decimal(10,2);

  /** Number of rooms currently available */
  availableRooms  : Integer;

  /** Comma-separated list of amenities */
  amenities       : String(500);
}

/** Hotel booking records */
entity HotelBookings : cuid, managed {
  /** Reference to the booked hotel */
  hotel           : Association to Hotels;

  /** Guest name */
  guest           : String(200);

  /** Check-in date */
  checkIn         : Date;

  /** Check-out date */
  checkOut        : Date;

  /** Number of rooms booked */
  rooms           : Integer default 1;

  /** Booking status */
  status          : String enum { confirmed; cancelled } default 'confirmed';

  /** Total price for the stay */
  totalPrice      : Decimal(10,2);
}

// ── Activities ───────────────────────────────────────────────────────

/** Local tours, attractions, and experiences */
entity Activities : cuid {
  /** Activity name */
  name            : String(200);

  /** City where the activity takes place */
  city            : String(100);

  /** Country where the activity takes place */
  country         : String(100);

  /** Category such as tour, food, adventure, culture, or nature */
  category        : String(50);

  /** Detailed description of the activity */
  description     : String(1000);

  /** Duration in hours */
  duration        : Decimal(4,1);

  /** Price per person in USD */
  price           : Decimal(10,2);

  /** Average rating out of 5 */
  rating          : Decimal(2,1);
}

/** Activity booking records */
entity Bookings : cuid, managed {
  /** Reference to the booked activity */
  activity        : Association to Activities;

  /** Guest name */
  guest           : String(200);

  /** Date of the activity (YYYY-MM-DD) */
  date            : Date;

  /** Number of participants */
  participants    : Integer default 1;

  /** Booking status */
  status          : String enum { confirmed; cancelled } default 'confirmed';

  /** Total price for the booking */
  totalPrice      : Decimal(10,2);
}
