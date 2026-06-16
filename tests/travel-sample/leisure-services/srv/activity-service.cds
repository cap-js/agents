using { travel.leisure as db } from '../db/schema';

@agent
@odata
/** Local activities and experiences service — find tours, food experiences, adventures, and cultural activities in popular destinations */
service ActivityService {

  /** Browse all activities with name, city, country, category, description, duration, price, and rating */
  @readonly entity Activities as projection on db.Activities;

  /** Browse activity bookings */
  @readonly entity Bookings as projection on db.Bookings;

  /** Book an activity for one or more participants — returns the confirmed booking record */
  action bookActivity(
    /** Activity ID to book */                activityId    : UUID,
    /** Guest full name */                    guest         : String,
    /** Date of the activity (YYYY-MM-DD) */  date          : Date,
    /** Number of participants (default 1) */ participants  : Integer
  ) returns Bookings;
}
