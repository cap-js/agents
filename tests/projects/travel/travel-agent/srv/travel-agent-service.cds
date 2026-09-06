/**
 * Travel planning agent that coordinates hotel bookings, flight reservations,
 * and local activities across multiple destinations.
 */
@agent.connect: 'auto'
@agent.quota: { maxLLMInvocationsPerTask: 50 }
@agent.fileIO: { defaultInputModes: ['text/csv'], defaultOutputModes: ['text/plain', 'text/markdown'] }
@agent service TravelAgentService {}
