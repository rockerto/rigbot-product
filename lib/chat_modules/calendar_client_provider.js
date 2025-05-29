// /lib/chat_modules/calendar_client_provider.js
import { google } from 'googleapis';
import { getCalendarClient as getDefaultCalendarClient } from '@/lib/google';
import { db } from '@/lib/firebase-admin'; // Asegúrate que la ruta a firebase-admin es correcta

export async function getCalendarInstance(requestClientId, clientConfigDataFromValidator) {
  let calendar; 
  // Hacemos una copia de clientConfigDataFromValidator para no modificar el objeto original
  // ya que este módulo podría actualizar los tokens en esta copia.
  let currentClientConfig = JSON.parse(JSON.stringify(clientConfigDataFromValidator));

  if (currentClientConfig && currentClientConfig.googleCalendarConnected && currentClientConfig.googleCalendarTokens) {
    console.log(`INFO (calendar_client_provider): Cliente ${requestClientId} tiene Google Calendar conectado. Email: ${currentClientConfig.googleCalendarEmail || 'No disponible en config'}. Intentando usar sus tokens.`);
    try {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials(currentClientConfig.googleCalendarTokens);

      if (currentClientConfig.googleCalendarTokens.refresh_token &&
        currentClientConfig.googleCalendarTokens.expiry_date &&
        new Date().getTime() > (currentClientConfig.googleCalendarTokens.expiry_date - 5 * 60 * 1000)) { // Si expira en menos de 5 mins
        console.log(`INFO (calendar_client_provider): Access token para ${requestClientId} (Email: ${currentClientConfig.googleCalendarEmail}) expirado o por expirar. Intentando refrescar...`);
        try {
          const { credentials } = await oauth2Client.refreshAccessToken();
          oauth2Client.setCredentials(credentials); // Actualiza el cliente con los nuevos tokens
          
          // Actualizar tokens en Firestore
          await db.collection("clients").doc(requestClientId).set(
            { googleCalendarTokens: credentials, googleCalendarLastSync: new Date().toISOString(), googleCalendarError: null },
            { merge: true }
          );
          console.log(`INFO (calendar_client_provider): Access token refrescado y actualizado en Firestore para ${requestClientId}.`);
          currentClientConfig.googleCalendarTokens = credentials; // Actualiza la copia local para este request
        } catch (refreshError) {
          console.error(`ERROR (calendar_client_provider): No se pudo refrescar el access token para ${requestClientId} (Email: ${currentClientConfig.googleCalendarEmail}):`, refreshError.message);
          await db.collection("clients").doc(requestClientId).set(
            {
              googleCalendarConnected: false, 
              googleCalendarError: `Error al refrescar token: ${refreshError.message}. Por favor, reconecta tu calendario.`,
              googleCalendarTokens: null 
            },
            { merge: true }
          );
          console.warn(`WARN (calendar_client_provider): Calendario desconectado para ${requestClientId} debido a error al refrescar token. Usando calendario por defecto.`);
          calendar = await getDefaultCalendarClient();
        }
      }
      
      if (calendar === undefined) { // Si no se usó el default por error de refresh (o no hubo refresh)
        calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        console.log(`INFO (calendar_client_provider): Usando Google Calendar del cliente ${requestClientId} (Email: ${currentClientConfig.googleCalendarEmail || 'N/A'})`);
      }

    } catch (oauthError) {
      console.error(`ERROR (calendar_client_provider): No se pudo crear cliente OAuth2 para ${requestClientId} con sus tokens:`, oauthError.message);
      console.log(`INFO (calendar_client_provider): Volviendo al calendario por defecto para ${requestClientId}.`);
      calendar = await getDefaultCalendarClient();
    }
  } else {
    console.log(`INFO (calendar_client_provider): Cliente ${requestClientId} no tiene Google Calendar conectado o faltan tokens. Usando calendario por defecto.`);
    calendar = await getDefaultCalendarClient();
  }

  if (!calendar || typeof calendar.events?.list !== 'function') {
    console.error("ERROR (calendar_client_provider): Cliente de calendario (ya sea del usuario o default) no está disponible o es inválido para", requestClientId);
    return null; // El orquestador manejará este error y enviará una respuesta 503.
  }
  
  return calendar; // Devuelve la instancia de calendario lista para usar
}