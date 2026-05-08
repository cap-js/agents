@a2a
/**
* Travel planning agent that coordinates hotel bookings, flight reservations, and local activities across multiple destinations
*/
service TravelAgentService {

  // Only here because agent card generation is not automated from agent/ md files yet
  /**
    * Plan a trip - coordinates hotels, flights, and activities
  */
  action plan(
  /** Your travel request */ request: String) returns String;
}
