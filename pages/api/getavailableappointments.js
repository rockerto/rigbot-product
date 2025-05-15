import { getCalendarClient } from '@/lib/google';

const WORKING_HOURS = [
  '10:00', '10:30', '11:00', '11:30',
  '12:00', '12:30', '13:00', '13:30',
  '14:00', '14:30', '15:00', '15:30',
  '16:00', '16:30', '17:00', '17:30',
  '18:00', '18:30', '19:00', '19:30'
];

function generateTimeBlocks(dateStr) {
  return WORKING_HOURS.map(time => {
    const [hour, minute] = time.split(':');
    const start = new Date(`${dateStr}T${time}:00`);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    return { start, end };
  });
}

function isSlotAvailable(slot, busySlots) {
  return !busySlots.some(busy => {
    const busyStart = new Date(busy.start);
    const busyEnd = new Date(busy.end);
    return slot.start < busyEnd && slot.end > busyStart;
  });
}

function formatTime(date) {
  return date.toTimeString().substring(0, 5);
}

function findNearbySlots(desiredTime, available) {
  const desired = new Date(`1970-01-01T${desiredTime}:00Z`);
  return available.filter(time => {
    const actual = new Date(`1970-01-01T${time}:00Z`);
    const diff = Math.abs(actual.getTime() - desired.getTime());
    return diff <= 30 * 60 * 1000;
  });
}

function findNextMatchingSlot(desiredTime, available) {
  const target = new Date(`1970-01-01T${desiredTime}:00Z`).getTime();
  return available.find(time => {
    const actual = new Date(`1970-01-01T${time}:00Z`).getTime();
    return actual === target;
  });
}

export default async function handler(req, res) {
  // 🔐 CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // 🛡️ Manejo de preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { start_date, end_date, preferred_time } = req.body;

  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'Faltan start_date o end_date' });
  }

  try {
    const calendar = await getCalendarClient();
    const startTime = new Date(`${start_date}T00:00:00`);
    const endTime = new Date(`${end_date}T23:59:59`);

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    // Solo usar eventos que tienen hora definida (ignorar all-day)
    const busySlots = response.data.items
      .filter(event => event.start.dateTime && event.end.dateTime)
      .map(event => ({
        start: event.start.dateTime,
        end: event.end.dateTime
      }));

    console.log('EVENTOS OCUPADOS:', busySlots); // Puedes borrar esto luego

    const blocks = generateTimeBlocks(start_date);
    const available = blocks.filter(block => isSlotAvailable(block, busySlots));
    const availableFormatted = available.map(block => formatTime(block.start));

    if (preferred_time) {
      const exactMatch = findNextMatchingSlot(preferred_time, availableFormatted);
      const nearby = findNearbySlots(preferred_time, availableFormatted);
      return res.status(200).json({
        exact: exactMatch || null,
        nearby: exactMatch ? [] : nearby
      });
    }

    const suggested = [availableFormatted[0], availableFormatted[3], availableFormatted[6]].filter(Boolean);
    return res.status(200).json({ suggested });

  } catch (error) {
    console.error('Error consultando Google Calendar:', error);
    return res.status(500).json({ error: 'Error consultando Google Calendar' });
  }
}
