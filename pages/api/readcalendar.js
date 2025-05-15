import { google } from 'googleapis';

export default async function handler(req, res) {
  const { GOOGLE_CLIENT_SECRET_JSON, GOOGLE_TOKEN_JSON } = process.env;

  if (!GOOGLE_CLIENT_SECRET_JSON || !GOOGLE_TOKEN_JSON) {
    return res.status(500).json({
      error: 'Faltan las variables GOOGLE_CLIENT_SECRET_JSON o GOOGLE_TOKEN_JSON'
    });
  }

  const credentials = JSON.parse(GOOGLE_CLIENT_SECRET_JSON);
  const token = JSON.parse(GOOGLE_TOKEN_JSON);

  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;

  const auth = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  auth.setCredentials(token);

  const calendar = google.calendar({ version: 'v3', auth });

  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items;

    res.status(200).json({
      message: `Se encontraron ${events.length} eventos`,
      events
    });

  } catch (error) {
    console.error('Error al leer eventos del calendario:', error);
    res.status(500).json({
      message: 'Error al acceder al calendario',
      error: error.message
    });
  }
}
