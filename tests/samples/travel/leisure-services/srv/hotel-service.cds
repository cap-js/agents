using { travel.leisure as db } from '../db/schema';

@agent.connect: 'auto'
@agent
@odata
/** Hotel search and booking service — find hotels by city, price, or star rating and make reservations */
service HotelService {

  /** Browse all hotels with their name, city, country, stars, price per night, available rooms, and amenities */
  @readonly entity Hotels as projection on db.Hotels;

  /** Browse hotel bookings */
  @readonly entity Bookings as projection on db.HotelBookings;

  /** Book a hotel room for a guest — returns the confirmed booking record */
  action bookHotel(
    /** Hotel ID to book */                 hotelId  : UUID,
    /** Guest full name */                  guest    : String,
    /** Check-in date (YYYY-MM-DD) */       checkIn  : Date,
    /** Check-out date (YYYY-MM-DD) */      checkOut : Date,
    /** Number of rooms (default 1) */      rooms    : Integer
  ) returns Bookings;

  /** Cancel a hotel booking by booking ID */
  action cancelBooking(
    /** Booking ID to cancel */             bookingId : UUID
  ) returns Bookings;
}
