using { travel.activities as db } from '../db/schema';

@a2a
@odata
@description: 'Hotel search and booking service — find hotels by city, price, or star rating and make reservations'
service HotelService {

  @description: 'Browse all hotels with their name, city, country, stars, price per night, available rooms, and amenities'
  @readonly entity Hotels as projection on db.Hotels;

  @description: 'Browse hotel bookings'
  @readonly entity Bookings as projection on db.HotelBookings;

  /** Book a hotel room for a guest */
  @description: 'Book a hotel room — returns the confirmed booking record'
  action bookHotel(
    @description: 'Hotel ID to book'                 hotelId  : UUID,
    @description: 'Guest full name'                  guest    : String,
    @description: 'Check-in date (YYYY-MM-DD)'       checkIn  : Date,
    @description: 'Check-out date (YYYY-MM-DD)'      checkOut : Date,
    @description: 'Number of rooms (default 1)'      rooms    : Integer
  ) returns Bookings;

  /** Cancel an existing hotel booking */
  @description: 'Cancel a hotel booking by booking ID'
  action cancelBooking(
    @description: 'Booking ID to cancel'             bookingId : UUID
  ) returns Bookings;
}
