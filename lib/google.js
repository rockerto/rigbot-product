import { google } from 'googleapis';

let cachedClient = null;

export async function getCalendarClient() {
  if (cachedClient) return cachedClient;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  cachedClient = google.calendar({ version: 'v3', auth: oauth2Client });
  return cachedClient;
}
