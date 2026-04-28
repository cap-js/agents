const cds = require("@sap/cds")

module.exports = class ActivityService extends cds.ApplicationService {
  async init() {
    const { Activities, Bookings } = this.entities

    this.on("bookActivity", async (req) => {
      const { activityId, guest, date, participants = 1 } = req.data

      if (!activityId || !guest || !date) {
        return req.reject(
          400,
          "Missing required fields: activityId, guest, and date are all required.",
        )
      }

      const activity = await SELECT.one.from(Activities).where({ ID: activityId })
      if (!activity) return req.reject(404, `Activity with ID "${activityId}" not found.`)

      const totalPrice = activity.price * participants

      const booking = {
        activity_ID: activity.ID,
        guest,
        date,
        participants,
        status: "confirmed",
        totalPrice,
      }

      const [result] = await INSERT.into(Bookings).entries(booking)

      return SELECT.one.from(Bookings).where({ ID: result.ID })
    })

    await super.init()
  }
}
