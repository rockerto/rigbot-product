
import { google } from 'googleapis';

export async function logRigEvent(entry) {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );

  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const range = 'interacciones!A1';

  const row = [
    new Date().toISOString(),
    entry.tipo || '',
    entry.mensaje || '',
    entry.resultado || '',
    entry.paciente || '',
    entry.telefono || '',
    entry.hora_solicitada || '',
    entry.observaciones || ''
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [row]
      }
    });
    console.log('✅ Evento registrado en Google Sheets');
  } catch (error) {
    console.error('❌ Error al registrar en Google Sheets:', error);
  }
}
