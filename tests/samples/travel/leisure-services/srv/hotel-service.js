import cds from "@sap/cds"

export default class HotelService extends cds.ApplicationService {
  async init() {
    const { Hotels, Bookings } = this.entities

    this.on("bookHotel", async (req) => {
      const { hotelId, guest, checkIn, checkOut, rooms = 1 } = req.data

      if (!hotelId || !guest || !checkIn || !checkOut) {
        return req.reject(
          400,
          "Missing required fields: hotelId, guest, checkIn, and checkOut are all required.",
        )
      }

      const hotel = await SELECT.one.from(Hotels).where({ ID: hotelId })
      if (!hotel) return req.reject(404, `Hotel with ID "${hotelId}" not found.`)

      if (hotel.availableRooms < rooms) {
        return req.reject(
          409,
          `Sorry, ${hotel.name} only has ${hotel.availableRooms} rooms available. You requested ${rooms}.`,
        )
      }

      const checkInDate = new Date(checkIn)
      const checkOutDate = new Date(checkOut)
      const nights = Math.ceil((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24))

      if (nights <= 0) return req.reject(400, "Check-out date must be after check-in date.")

      const totalPrice = nights * hotel.pricePerNight * rooms

      const booking = {
        hotel_ID: hotel.ID,
        guest,
        checkIn,
        checkOut,
        rooms,
        status: "confirmed",
        totalPrice,
      }

      const [result] = await INSERT.into(Bookings).entries(booking)
      await UPDATE(Hotels)
        .set({ availableRooms: { "-=": rooms } })
        .where({ ID: hotel.ID })

      return SELECT.one.from(Bookings).where({ ID: result.ID })
    })

    this.on("cancelBooking", async (req) => {
      const { bookingId } = req.data
      if (!bookingId) return req.reject(400, "Please provide a booking ID to cancel.")

      const booking = await SELECT.one.from(Bookings).where({ ID: bookingId })
      if (!booking) return req.reject(404, `Booking with ID "${bookingId}" not found.`)
      if (booking.status === "cancelled")
        return req.reject(409, "This booking is already cancelled.")

      await UPDATE(Bookings).set({ status: "cancelled" }).where({ ID: bookingId })
      await UPDATE(Hotels)
        .set({ availableRooms: { "+=": booking.rooms } })
        .where({ ID: booking.hotel_ID })

      return SELECT.one.from(Bookings).where({ ID: bookingId })
    })

    await super.init()
  }
}
