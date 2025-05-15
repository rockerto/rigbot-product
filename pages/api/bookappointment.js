import { getCalendarClient } from '../../lib/google';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { nombre, fecha } = req.body;

    if (!nombre || !fecha) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const calendar = await getCalendarClient();

    const event = {
      summary: `Cita con ${nombre}`,
      start: { dateTime: fecha },
      end: { dateTime: new Date(new Date(fecha).getTime() + 30 * 60000).toISOString() },
    };

    await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });

    res.status(200).json({ message: 'Cita agendada exitosamente' });
  } catch (error) {
    console.error('Error agendando cita:', error);
    res.status(500).json({ error: 'Error al agendar la cita' });
  }
}
