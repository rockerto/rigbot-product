import { google } from 'googleapis';

export default async function handler(req, res) {
  const { code } = req.query;

  if (!code) {
    res.status(400).send('Missing OAuth code.');
    return;
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    res.status(500).json({
      error: 'Faltan las variables de entorno GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET'
    });
    return;
  }

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    'https://rig-calendar.vercel.app/api/oauth2callback'
  );

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // ⚠️ Opcional: imprimir los tokens en consola para copiar el refresh_token
    console.log('Tokens recibidos:', tokens);

    res.status(200).json({
      message: 'Token recibido exitosamente 🎉',
      refresh_token: tokens.refresh_token ? 'Guardado correctamente ✅' : 'No se recibió refresh_token ❌',
      note: 'Puedes copiarlo desde consola o desde esta respuesta temporal'
    });

  } catch (error) {
    console.error('Error al intercambiar el código:', error);
    res.status(500).json({
      message: 'Error al intercambiar el código',
      details: error.message,
      full: error.response?.data || 'No se pudo acceder al detalle del error.'
    });
  }
}
