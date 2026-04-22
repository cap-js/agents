using { travel.activities as db } from '../db/schema';

@a2a
@odata
@description: 'Local activities and experiences service — find tours, food experiences, adventures, and cultural activities in popular destinations'
service ActivityService {

  @description: 'Browse all activities with name, city, country, category, description, duration, price, and rating'
  @readonly entity Activities as projection on db.Activities;

  @description: 'Browse activity bookings'
  @readonly entity Bookings as projection on db.Bookings;

  /** Book an activity for one or more participants */
  @description: 'Book an activity — returns the confirmed booking record'
  action bookActivity(
    @description: 'Activity ID to book'              activityId  : UUID,
    @description: 'Guest full name'                  guest       : String,
    @description: 'Date of the activity (YYYY-MM-DD)'  date     : Date,
    @description: 'Number of participants (default 1)'  participants : Integer
  ) returns Bookings;
}
