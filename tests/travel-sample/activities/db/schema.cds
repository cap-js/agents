namespace travel.activities;

using { cuid, managed } from '@sap/cds/common';

// ── Hotels ───────────────────────────────────────────────────────────

/** Hotels available for booking */
entity Hotels : cuid {
  @description: 'Hotel name'
  name            : String(200);

  @description: 'City where the hotel is located'
  city            : String(100);

  @description: 'Country where the hotel is located'
  country         : String(100);

  @description: 'Star rating (1-5)'
  stars           : Integer;

  @description: 'Price per night in USD'
  pricePerNight   : Decimal(10,2);

  @description: 'Number of rooms currently available'
  availableRooms  : Integer;

  @description: 'Comma-separated list of amenities'
  amenities       : String(500);
}

/** Hotel booking records */
entity HotelBookings : cuid, managed {
  @description: 'Reference to the booked hotel'
  hotel           : Association to Hotels;

  @description: 'Guest name'
  guest           : String(200);

  @description: 'Check-in date'
  checkIn         : Date;

  @description: 'Check-out date'
  checkOut        : Date;

  @description: 'Number of rooms booked'
  rooms           : Integer default 1;

  @description: 'Booking status'
  status          : String enum { confirmed; cancelled } default 'confirmed';

  @description: 'Total price for the stay'
  totalPrice      : Decimal(10,2);
}

// ── Activities ───────────────────────────────────────────────────────

/** Local tours, attractions, and experiences */
entity Activities : cuid {
  @description: 'Activity name'
  name            : String(200);

  @description: 'City where the activity takes place'
  city            : String(100);

  @description: 'Country where the activity takes place'
  country         : String(100);

  @description: 'Category such as tour, food, adventure, culture, or nature'
  category        : String(50);

  @description: 'Detailed description of the activity'
  description     : String(1000);

  @description: 'Duration in hours'
  duration        : Decimal(4,1);

  @description: 'Price per person in USD'
  price           : Decimal(10,2);

  @description: 'Average rating out of 5'
  rating          : Decimal(2,1);
}

/** Activity booking records */
entity Bookings : cuid, managed {
  @description: 'Reference to the booked activity'
  activity        : Association to Activities;

  @description: 'Guest name'
  guest           : String(200);

  @description: 'Date of the activity (YYYY-MM-DD)'
  date            : Date;

  @description: 'Number of participants'
  participants    : Integer default 1;

  @description: 'Booking status'
  status          : String enum { confirmed; cancelled } default 'confirmed';

  @description: 'Total price for the booking'
  totalPrice      : Decimal(10,2);
}
