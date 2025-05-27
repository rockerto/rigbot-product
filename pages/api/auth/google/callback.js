// rigbot-product/pages/api/auth/google/callback.js
import { google } from 'googleapis';
import { db } from '@/lib/firebase-admin'; // Importa tu instancia 'db' ya inicializada

// No necesitas inicializar admin aquí si ya lo haces en firebase-admin.js
// if (!admin.apps.length) {
//   admin.initializeApp({ ... });
// }
// const db = getFirestore(); // Esto ya viene de la importación

export default async function handler(req, res) {
  const { code, state, error: googleError } = req.query;

  // El 'state' es el userId de Rigbot que pasamos en initiate.js
  const userId = state ? decodeURIComponent(state as string) : null;
  
  // URL base de tu frontend para la redirección (configura esta variable en Vercel para rigbot-product)
  const frontendCalendarIntegrationUrl = process.env.FRONTEND_APP_URL 
                                       ? `${process.env.FRONTEND_APP_URL}/client/calendar-integration`
                                       : 'https://rigsite-web.vercel.app/client/calendar-integration'; // Fallback, ajusta si es necesario

  if (googleError) {
    console.error(`Error desde Google en callback para userId ${userId || 'desconocido'}:`, googleError);
    return res.redirect(`${frontendCalendarIntegrationUrl}?error=google_denied_access&details=${encodeURIComponent(googleError as string)}`);
  }

  if (!code || !userId) {
    console.error("Error en callback de Google: Faltan parámetros 'code' o 'state' (userId).", { codeProvided: !!code, userIdProvided: !!userId });
    return res.redirect(`${frontendCalendarIntegrationUrl}?error=missing_params`);
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT_URI // Esta es la URL de este mismo endpoint
    );

    console.log(`Intercambiando código por tokens para userId: ${userId}`);
    const { tokens } = await oauth2Client.getToken(code as string);
    console.log(`Tokens obtenidos para userId: ${userId}`, tokens ? 'Sí' : 'No');


    if (!tokens || !tokens.access_token) {
      console.error(`No se pudo obtener access_token de Google para userId: ${userId}`);
      return res.redirect(`${frontendCalendarIntegrationUrl}?error=token_exchange_failed`);
    }

    // Establecer las credenciales en el cliente OAuth2 para hacer llamadas API
    oauth2Client.setCredentials(tokens);

    // Obtener información del usuario (email) para confirmar la cuenta conectada
    let userEmail = null;
    let userName = null; // Opcional: Nombre del perfil de Google
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
      console.error(`Error obteniendo información del usuario de Google para userId ${userId}:`, userInfoError);
      // No es un error fatal, podemos continuar sin el email si falla, pero es bueno saberlo.
    }

    // Guardar tokens y estado en Firestore
    // ¡IMPORTANTE! El refresh_token es muy sensible. Considera encriptarlo en una fase posterior.
    const clientDocRef = db.collection("clients").doc(userId);
    await clientDocRef.set(
      {
        googleCalendarTokens: tokens, // Contiene access_token, refresh_token, expiry_date, etc.
        googleCalendarConnected: true,
        googleCalendarEmail: userEmail || null, // Guardar el email de la cuenta conectada
        // googleCalendarUserName: userName || null, // Opcional
        googleCalendarLastSync: new Date().toISOString(), // Opcional: para saber cuándo fue la última conexión/actualización exitosa
      },
      { merge: true }
    );
    console.log(`Tokens y estado de Google Calendar guardados en Firestore para userId: ${userId}`);

    return res.redirect(`${frontendCalendarIntegrationUrl}?success=calendar_connected`);

  } catch (error) {
    console.error(`Error catastrófico en Google OAuth callback para userId ${userId || 'desconocido'}:`, error);
    // Evitar exponer detalles del error al cliente en la URL si es sensible
    let errorQueryParam = "oauth_callback_error";
    if (error.message && error.message.includes("invalid_grant")) {
        errorQueryParam = "invalid_grant"; // El código ya fue usado o es inválido
        console.warn("Posible error de 'invalid_grant', el código podría haber sido usado o es incorrecto.");
    } else if (error.response && error.response.data) { // Errores de la librería googleapis
        console.error("Detalles del error de googleapis:", error.response.data);
    }
    
    return res.redirect(`${frontendCalendarIntegrationUrl}?error=${errorQueryParam}`);
  }
}