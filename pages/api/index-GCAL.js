import { google } from "googleapis";

const handler = async function (req, res) {
  const path = req.url || "";
  const method = req.method;

  if (path === "/create" && method === "POST") {
    return createAppointment(req, res);
  }

  if (method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  return getAvailableAppointments(req, res);
};

async function getAvailableAppointments(req, res) {
  const { start_date, end_date } = req.body;

  try {
    const credentials = JSON.parse(process.env.GOOGLE_CLIENT_SECRET_JSON);
    const token = JSON.parse(process.env.GOOGLE_TOKEN_JSON);

    const auth = new google.auth.OAuth2(
      credentials.web.client_id,
      credentials.web.client_secret,
      credentials.web.redirect_uris[0]
    );

    auth.setCredentials(token);
    const calendar = google.calendar({ version: "v3", auth });

    const start = new Date(start_date);
    const end = new Date(end_date);
    end.setDate(end.getDate() + 1); // Agrega un día para incluir ese día completo

    const events = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: "America/Santiago",
        items: [{ id: "primary" }],
      },
    });

    const busyTimes = events.data.calendars["primary"].busy;
    const appointmentTimes = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30"];
    const availableAppointments = [];

    for (let day = new Date(start); day < end; day.setDate(day.getDate() + 1)) {
      const dateStr = day.toISOString().split("T")[0];

      for (let time of appointmentTimes) {
        const [hour, minute] = time.split(":");
        const startDateTime = new Date(day);
        startDateTime.setHours(parseInt(hour), parseInt(minute), 0, 0);

        const endDateTime = new Date(startDateTime);
        endDateTime.setMinutes(endDateTime.getMinutes() + 30);

        const overlap = busyTimes.some(
          (busy) =>
            new Date(busy.start) < endDateTime &&
            new Date(busy.end) > startDateTime
        );

        if (!overlap) {
          availableAppointments.push({ date: dateStr, time });
        }
      }
    }

    res.status(200).json({ success: true, availableAppointments });
  } catch (error) {
    console.error("Error consultando Google Calendar:", error);
    res.status(500).json({ error: "Error consultando Google Calendar" });
  }
}

async function createAppointment(req, res) {
  try {
    const { date, time, summary, description } = req.body;

    const credentials = JSON.parse(process.env.GOOGLE_CLIENT_SECRET_JSON);
    const token = JSON.parse(process.env.GOOGLE_TOKEN_JSON);

    const auth = new google.auth.OAuth2(
      credentials.web.client_id,
      credentials.web.client_secret,
      credentials.web.redirect_uris[0]
    );

    auth.setCredentials(token);
    const calendar = google.calendar({ version: "v3", auth });

    const [hour, minute] = time.split(":");
    const startDateTime = new Date(`${date}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00-04:00`);
    const endDateTime = new Date(startDateTime);
    endDateTime.setMinutes(endDateTime.getMinutes() + 30);

    const event = {
      summary: summary || "Sesión con paciente",
      description: description || "Agendada automáticamente desde RIGbot",
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: "America/Santiago",
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: "America/Santiago",
      },
    };

    await calendar.events.insert({
      calendarId: "primary",
      resource: event,
    });

    res.status(200).json({ success: true, message: "Evento creado correctamente" });
  } catch (error) {
    console.error("Error creando evento:", error);
    res.status(500).json({ error: "Error creando evento en Google Calendar" });
  }
}

export default handler;
