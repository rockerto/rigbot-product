// rigbot-product/pages/api/auth/google/callback.js
import { google } from 'googleapis';
import { db } from '@/lib/firebase-admin'; // Importa tu instancia 'db' ya inicializada

export default async function handler(req, res) {
  const { code, state, error: googleErrorParam } = req.query; // Renombrado googleError para evitar conflicto con la variable Error

  // El 'state' es el userId de Rigbot que pasamos en initiate.js
  const userId = state ? decodeURIComponent(state) : null; // <--- CORRECCIÓN AQUÍ (quitado 'as string')
  
  const frontendCalendarIntegrationUrl = process.env.FRONTEND_APP_URL 
                                       ? `${process.env.FRONTEND_APP_URL}/client/calendar-integration`
                                       : 'https://rigsite-web.vercel.app/client/calendar-integration';

  if (googleErrorParam) {
    console.error(`Error desde Google en callback para userId ${userId || 'desconocido'}:`, googleErrorParam);
    return res.redirect(`${frontendCalendarIntegrationUrl}?error=google_denied_access&details=${encodeURIComponent(googleErrorParam)}`); // <--- CORRECCIÓN AQUÍ (quitado 'as string')
  }

  if (!code || !userId) {
    console.error("Error en callback de Google: Faltan parámetros 'code' o 'state' (userId).", { codeProvided: !!code, userIdProvided: !!userId });
    return res.redirect(`${frontendCalendarIntegrationUrl}?error=missing_params`);
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT_URI
    );

    console.log(`Intercambiando código por tokens para userId: ${userId}`);
    const { tokens } = await oauth2Client.getToken(code); // <--- CORRECCIÓN AQUÍ (quitado 'as string')
    console.log(`Tokens obtenidos para userId: ${userId}`, tokens ? 'Sí' : 'No');

    if (!tokens || !tokens.access_token) {
      console.error(`No se pudo obtener access_token de Google para userId: ${userId}`);
      return res.redirect(`${frontendCalendarIntegrationUrl}?error=token_exchange_failed`);
    }

    oauth2Client.setCredentials(tokens);

    let userEmail = null;
    let userName = null;
    try {
      const people = google.people({ version: 'v1', auth: oauth2Client });
      const person = await people.people.get({
        resourceName: 'people/me',
        personFields: 'emailAddresses,names',
      });
      
      if (person.data.emailAddresses && person.data.emailAddresses.length > 0) {
        userEmail = person.data.emailAddresses[0].value;
      }
      if (person.data.names && person.data.names.length > 0) {
        userName = person.data.names[0].displayName;
      }
      console.log(`Email de Google obtenido para userId ${userId}: ${userEmail}, Nombre: ${userName}`);
    } catch (userInfoError) {
      // En JavaScript, userInfoError ya es un objeto Error (o similar)
      console.error(`Error obteniendo información del usuario de Google para userId ${userId}:`, userInfoError);
    }

    const clientDocRef = db.collection("clients").doc(userId);
    await clientDocRef.set(
      {
        googleCalendarTokens: tokens,
        googleCalendarConnected: true,
        googleCalendarEmail: userEmail || null,
        googleCalendarLastSync: new Date().toISOString(),
      },
      { merge: true }
    );
    console.log(`Tokens y estado de Google Calendar guardados en Firestore para userId: ${userId}`);

    return res.redirect(`${frontendCalendarIntegrationUrl}?success=calendar_connected`);

  } catch (error) { // 'error' aquí ya es un objeto Error
    console.error(`Error catastrófico en Google OAuth callback para userId ${userId || 'desconocido'}:`, error);
    let errorQueryParam = "oauth_callback_error";
    if (error.message && error.message.includes("invalid_grant")) {
        errorQueryParam = "invalid_grant";
        console.warn("Posible error de 'invalid_grant', el código podría haber sido usado o es incorrecto.");
    } else if (error.response && error.response.data) {
        console.error("Detalles del error de googleapis:", error.response.data);
    }
    
    return res.redirect(`${frontendCalendarIntegrationUrl}?error=${errorQueryParam}`);
  }
}