import cds from "@sap/cds"
class DataService extends cds.ApplicationService {
  init() {
    const { Flights, FlightBookings } = this.entities

    this.on("BookingCreated", async (req) => {
      const { flight, date, seats = [null] } = req.data
      await UPDATE(Flights, { flight_ID: flight, date })
        .set`occupied_seats = occupied_seats + ${seats.length}`
    })

    this.on("BookingDeleted", async (req) => {
      const { flight, date, seats = [null] } = req.data
      await UPDATE(Flights, { flight_ID: flight, date })
        .set`occupied_seats = occupied_seats - ${seats.length}`
    })

    // ── Unbound action: bookFlight ──────────────────────────────────────
    this.on("bookFlight", async (req) => {
      const { flight: flightId, date, passenger, seats = 1 } = req.data

      if (!passenger) return req.reject(400, "Passenger name is required.")
      if (!flightId || !date) return req.reject(400, "Flight ID and date are required.")

      // Look up the flight
      const flight = await SELECT.one.from(Flights).where({ flight_ID: flightId, date })
      if (!flight) return req.reject(404, `Flight ${flightId} on ${date} not found.`)

      // Check availability
      const free = flight.maximum_seats - flight.occupied_seats
      if (free < seats) {
        return req.reject(
          409,
          `Only ${free} seats available on flight ${flightId} on ${date}. You requested ${seats}.`,
        )
      }

      // Calculate total price
      const totalPrice = flight.price * seats

      // Create booking
      const booking = {
        flight_ID: flightId,
        date,
        passenger,
        seats,
        status: "confirmed",
        totalPrice,
        currency_code: flight.currency_code,
      }
      const [result] = await INSERT.into(FlightBookings).entries(booking)

      // Update occupied seats on the flight
      await UPDATE(Flights, { flight_ID: flightId, date })
        .set`occupied_seats = occupied_seats + ${seats}`

      return SELECT.one.from(FlightBookings).where({ ID: result.ID })
    })

    // ── Unbound action: cancelFlight ───────────────────────────────────
    this.on("cancelFlight", async (req) => {
      const { bookingId } = req.data
      if (!bookingId) return req.reject(400, "Booking ID is required.")

      const booking = await SELECT.one.from(FlightBookings).where({ ID: bookingId })
      if (!booking) return req.reject(404, `Booking ${bookingId} not found.`)
      if (booking.status === "cancelled")
        return req.reject(409, "This booking is already cancelled.")

      // Restore seats on the flight
      await UPDATE(Flights, { flight_ID: booking.flight_ID, date: booking.date })
        .set`occupied_seats = occupied_seats - ${booking.seats}`

      // Mark booking as cancelled
      await UPDATE(FlightBookings).set({ status: "cancelled" }).where({ ID: bookingId })

      return SELECT.one.from(FlightBookings).where({ ID: bookingId })
    })

    return super.init()
  }
}
export default DataService
