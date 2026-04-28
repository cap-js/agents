@a2a
/**
* Travel planning agent that coordinates hotel bookings, flight reservations, and local activities across multiple destinations
*/
service TravelAgentService {

  /**
    * Plan a trip - coordinates hotels, flights, and activities
  */
  action plan(
  /** Your travel request */ request: String) returns String;
}
